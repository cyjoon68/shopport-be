import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { EventType } from '@tanstack/ai';
import type { Environment } from '../../config/environment.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import type { AiStreamAdapter } from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';
import {
  COMMAND_CODE_FETCH,
  CommandCodeAiStreamAdapter,
} from './command-code-ai.adapter.js';
import { FakeAiStreamAdapter } from './fake-ai.adapter.js';
import { aiStreamAdapterProvider } from './ai.module.js';

const compileAdapter = (mode: 'fake' | 'commandcode'): Promise<TestingModule> =>
  Test.createTestingModule({
    providers: [
      FakeAiStreamAdapter,
      CommandCodeAiStreamAdapter,
      { provide: COMMAND_CODE_FETCH, useValue: globalThis.fetch },
      aiStreamAdapterProvider,
      {
        provide: ConfigService,
        useValue: new ConfigService<Environment, true>({
          AI_MODE: mode,
          COMMAND_CODE_API_KEY: 'test-command-code-key',
          COMMAND_CODE_MODEL: 'gpt-5.4-mini',
          COMMAND_CODE_MAX_OUTPUT_TOKENS: 512,
        }),
      },
    ],
  }).compile();

const tools: AiToolSession = {
  searchProducts: () =>
    Promise.resolve({ items: [], endCursor: null, hasNextPage: false }),
  getProduct: () => Promise.resolve(null),
  compareProducts: () => Promise.resolve([]),
};

describe('AiModule adapter selection', () => {
  it('connects fake mode to the fake stream adapter', async () => {
    const module = await compileAdapter('fake');
    const adapter = module.get<AiStreamAdapter>(AI_STREAM_ADAPTER);
    let completeCalls = 0;
    const eventTypes: Array<string> = [];

    expect(adapter).toBeInstanceOf(FakeAiStreamAdapter);
    for await (const event of adapter.createStream(
      {
        threadId: 'thread',
        runId: 'run',
        text: 'answer',
        image: null,
      },
      tools,
      {
        onComplete: (): Promise<void> => {
          completeCalls += 1;
          return Promise.resolve();
        },
        onFailure: (): Promise<void> => Promise.resolve(),
        isCancelled: (): Promise<boolean> => Promise.resolve(false),
      },
    )) {
      eventTypes.push(event.type);
    }
    expect(eventTypes).toContain(EventType.RUN_STARTED);
    expect(eventTypes).toContain(EventType.RUN_FINISHED);
    expect(completeCalls).toBe(1);

    await module.close();
  });

  it('connects Command Code mode to the Command Code adapter', async () => {
    const module = await compileAdapter('commandcode');
    expect(module.get(AI_STREAM_ADAPTER)).toBeInstanceOf(
      CommandCodeAiStreamAdapter,
    );
    await module.close();
  });
});
