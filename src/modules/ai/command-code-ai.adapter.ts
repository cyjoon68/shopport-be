import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EventType,
  RUN_CANCEL_REASON,
  chat,
  maxIterations,
  toolDefinition,
} from '@tanstack/ai';
import type {
  AnyServerTool,
  ChatMiddleware,
  ContentPart,
  ModelMessage,
  StreamChunk,
} from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import type { Environment } from '../../config/environment.js';
import { toAiProductResult } from './ai-tool-result.js';
import type {
  AiStreamAdapter,
  AiStreamInput,
  AiStreamLifecycle,
  AiStreamResult,
} from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';

export const COMMAND_CODE_FETCH = Symbol('COMMAND_CODE_FETCH');

const commandCodeBaseUrl = 'https://api.commandcode.ai/provider/v1';
const overallTimeoutMilliseconds = 55_000;
const providerTimeoutMilliseconds = 45_000;
const timeoutReason = 'shopport:ai-timeout';
const streamClosedReason = 'shopport:stream-closed';
const cancellationCheckFailedReason = 'shopport:cancellation-check-failed';

const searchProductsDefinition = toolDefinition({
  name: 'searchProducts',
  description:
    '다이소 또는 올리브영에서 최대 3개 상품을 검색합니다. 판매처를 말하지 않으면 daiso를 사용하고, 위치가 있으면 매장 재고도 확인합니다.',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(200),
    providerId: z.enum(['daiso', 'oliveyoung']).default('daiso'),
    budgetMax: z.number().int().positive().optional(),
    location: z.string().trim().min(1).max(100).optional(),
  }),
});

const getProductDefinition = toolDefinition({
  name: 'getProduct',
  description: '상품 ID로 승인된 provider의 최신 상품 카드를 조회합니다.',
  inputSchema: z.object({ id: z.uuid() }),
});

const harnessPath = fileURLToPath(
  new URL('./shopping-ai-harness.md', import.meta.url),
);
const systemPrompt = readFileSync(harnessPath, 'utf8');

type TerminalStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

type TerminalState = Readonly<{
  status: () => TerminalStatus;
  complete: (result: AiStreamResult) => Promise<void>;
  fail: () => Promise<void>;
  cancel: () => void;
}>;

const createTerminalState = (lifecycle: AiStreamLifecycle): TerminalState => {
  let status: TerminalStatus = 'pending';
  return {
    status: () => status,
    complete: async (result): Promise<void> => {
      if (status !== 'pending') return;
      try {
        await lifecycle.onComplete(result);
        status = 'succeeded';
      } catch (error) {
        status = 'failed';
        await lifecycle.onFailure();
        throw error;
      }
    },
    fail: async (): Promise<void> => {
      if (status !== 'pending') return;
      status = 'failed';
      await lifecycle.onFailure();
    },
    cancel: (): void => {
      if (status === 'pending') status = 'cancelled';
    },
  };
};

const createLifecycleMiddleware = (
  abortController: AbortController,
  lifecycle: AiStreamLifecycle,
  terminal: TerminalState,
  productIds: ReadonlySet<string>,
  assistantMessageId: string,
): ChatMiddleware => {
  let cancellationInterval: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let pollPending = false;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (cancellationInterval) clearInterval(cancellationInterval);
    if (timeout) clearTimeout(timeout);
  };
  const pollCancellation = (): void => {
    if (pollPending || stopped || abortController.signal.aborted) return;
    pollPending = true;
    void lifecycle
      .isCancelled()
      .then((cancelled) => {
        if (cancelled && !stopped && !abortController.signal.aborted) {
          abortController.abort(RUN_CANCEL_REASON);
        }
      })
      .catch(() => {
        if (!stopped && !abortController.signal.aborted) {
          abortController.abort(cancellationCheckFailedReason);
        }
      })
      .finally(() => {
        pollPending = false;
      });
  };
  return {
    name: 'shopport-ai-lifecycle',
    setup: (): void => {
      cancellationInterval = setInterval(pollCancellation, 250);
      cancellationInterval.unref();
      timeout = setTimeout(() => {
        if (!abortController.signal.aborted) {
          abortController.abort(timeoutReason);
        }
      }, overallTimeoutMilliseconds);
      timeout.unref();
      pollCancellation();
    },
    onFinish: async (_context, info): Promise<void> => {
      stop();
      const text = info.content.trim();
      if (info.finishReason !== 'stop' || text.length === 0) {
        await terminal.fail();
        throw new Error('Command Code returned an incomplete response');
      }
      await terminal.complete({
        messageId: assistantMessageId,
        text,
        productIds: [...productIds],
        askUser: null,
      });
    },
    onAbort: async (_context, info): Promise<void> => {
      stop();
      if (info.cancelRequested) {
        terminal.cancel();
        return;
      }
      await terminal.fail();
    },
    onError: async (): Promise<void> => {
      stop();
      await terminal.fail();
    },
  };
};

const isVisibleChunk = (chunk: StreamChunk): boolean =>
  chunk.type === EventType.RUN_STARTED ||
  chunk.type === EventType.TOOL_CALL_START ||
  chunk.type === EventType.TOOL_CALL_ARGS ||
  chunk.type === EventType.TOOL_CALL_END ||
  chunk.type === EventType.TOOL_CALL_RESULT ||
  chunk.type === EventType.TEXT_MESSAGE_START ||
  chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
  chunk.type === EventType.TEXT_MESSAGE_END;

const terminalChunk = (
  input: AiStreamInput,
  terminal: TerminalState,
): StreamChunk | null => {
  if (terminal.status() === 'succeeded') {
    return {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: { type: 'success' },
      finishReason: 'stop',
    };
  }
  if (terminal.status() === 'failed') {
    return {
      type: EventType.RUN_ERROR,
      threadId: input.threadId,
      runId: input.runId,
      message: 'AI provider request failed',
      code: 'AI_PROVIDER_ERROR',
    };
  }
  return null;
};

const createPublicStream = (
  source: AsyncIterable<StreamChunk>,
  input: AiStreamInput,
  abortController: AbortController,
  terminal: TerminalState,
  assistantMessageId: string,
): AsyncIterable<StreamChunk> => {
  const iterator = source[Symbol.asyncIterator]();
  let sourceDone = false;
  let terminalYielded = false;
  let runStarted = false;
  const nextTerminal = (): IteratorResult<StreamChunk> => {
    if (terminalYielded) return { done: true, value: undefined };
    terminalYielded = true;
    const chunk = terminalChunk(input, terminal);
    return chunk
      ? { done: false, value: chunk }
      : { done: true, value: undefined };
  };
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamChunk>> => {
        if (sourceDone) return nextTerminal();
        for (;;) {
          let result: IteratorResult<StreamChunk>;
          try {
            result = await iterator.next();
          } catch {
            sourceDone = true;
            await terminal.fail().catch(() => undefined);
            return nextTerminal();
          }
          if (result.done) {
            sourceDone = true;
            if (terminal.status() === 'pending') {
              await terminal.fail().catch(() => undefined);
            }
            return nextTerminal();
          }
          const chunk = result.value;
          if (
            chunk.type === EventType.RUN_FINISHED ||
            chunk.type === EventType.RUN_ERROR
          ) {
            continue;
          }
          if (chunk.type === EventType.RUN_STARTED) {
            if (runStarted) continue;
            runStarted = true;
          }
          if (isVisibleChunk(chunk)) {
            if (
              chunk.type === EventType.TEXT_MESSAGE_START ||
              chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
              chunk.type === EventType.TEXT_MESSAGE_END
            ) {
              return {
                done: false,
                value: { ...chunk, messageId: assistantMessageId },
              };
            }
            if (chunk.type === EventType.TOOL_CALL_START) {
              return {
                done: false,
                value: { ...chunk, parentMessageId: assistantMessageId },
              };
            }
            return { done: false, value: chunk };
          }
        }
      },
      return: async (): Promise<IteratorResult<StreamChunk>> => {
        if (!sourceDone) {
          abortController.abort(streamClosedReason);
          await iterator.return?.();
          sourceDone = true;
          if (terminal.status() === 'pending') {
            await terminal.fail().catch(() => undefined);
          }
        }
        terminalYielded = true;
        return { done: true, value: undefined };
      },
    }),
  };
};

@Injectable()
export class CommandCodeAiStreamAdapter implements AiStreamAdapter {
  public readonly requiresImageData = true;

  readonly #apiKey: string | undefined;
  readonly #model: string;
  readonly #maxOutputTokens: number;

  public constructor(
    config: ConfigService<Environment, true>,
    @Inject(COMMAND_CODE_FETCH) private readonly providerFetch: typeof fetch,
  ) {
    this.#apiKey = config.get('COMMAND_CODE_API_KEY', { infer: true });
    this.#model = config.get('COMMAND_CODE_MODEL', { infer: true });
    this.#maxOutputTokens = config.get('COMMAND_CODE_MAX_OUTPUT_TOKENS', {
      infer: true,
    });
  }

  public createStream = (
    input: AiStreamInput,
    tools: AiToolSession,
    lifecycle: AiStreamLifecycle,
  ): AsyncIterable<StreamChunk> => {
    if (!this.#apiKey) {
      throw new Error('COMMAND_CODE_API_KEY is required');
    }
    const productIds = new Set<string>();
    const abortController = new AbortController();
    const assistantMessageId = uuidv7();
    const commandCodeTools = this.createTools(tools, productIds);
    const terminal = createTerminalState(lifecycle);
    const adapter = openaiCompatibleText(this.#model, {
      name: 'commandcode',
      apiKey: this.#apiKey,
      baseURL: commandCodeBaseUrl,
      defaultHeaders: { 'x-cmd-zdr': '1' },
      fetch: this.providerFetch,
      maxRetries: 1,
      timeout: providerTimeoutMilliseconds,
    });
    const source = chat({
      adapter,
      messages: this.modelMessages(input),
      systemPrompts: [systemPrompt],
      tools: commandCodeTools,
      modelOptions: {
        max_completion_tokens: this.#maxOutputTokens,
      },
      abortController,
      agentLoopStrategy: maxIterations(4),
      threadId: input.threadId,
      runId: input.runId,
      middleware: [
        createLifecycleMiddleware(
          abortController,
          lifecycle,
          terminal,
          productIds,
          assistantMessageId,
        ),
      ],
      debug: false,
    });
    return createPublicStream(
      source,
      input,
      abortController,
      terminal,
      assistantMessageId,
    );
  };

  private readonly modelMessages = (input: AiStreamInput): ModelMessage[] => {
    const history = (input.history ?? []).map(
      ({ role, text }): ModelMessage => ({ role, content: text }),
    );
    const prompt = input.text || '첨부 이미지를 설명해 주세요.';
    if (!input.image) {
      return history.length > 0 ? history : [{ role: 'user', content: prompt }];
    }
    const content: Array<ContentPart> = [
      { type: 'text', content: prompt },
      {
        type: 'image',
        source: {
          type: 'data',
          value: input.image.base64,
          mimeType: input.image.mimeType,
        },
        metadata: { detail: 'low' },
      },
    ];
    if (history.at(-1)?.role === 'user') history.pop();
    return [...history, { role: 'user', content }];
  };

  private readonly createTools = (
    session: AiToolSession,
    productIds: Set<string>,
  ): ReadonlyArray<AnyServerTool> => [
    searchProductsDefinition.server(
      async ({ query, providerId, budgetMax, location }) => {
        const result = await session.searchProducts({
          query,
          providerId: providerId ?? 'daiso',
          ...(budgetMax === undefined ? {} : { budgetMax }),
          ...(location === undefined ? {} : { location }),
        });
        result.items.forEach(({ id }) => productIds.add(id));
        return toAiProductResult(result.items);
      },
    ),
    getProductDefinition.server(async ({ id }) => {
      const product = await session.getProduct(id);
      if (product) productIds.add(product.id);
      return toAiProductResult(product ? [product] : []);
    }),
  ];
}
