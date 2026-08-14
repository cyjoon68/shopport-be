import { EventType } from '@tanstack/ai';
import type { StreamChunk } from '@tanstack/ai';
import { jest } from '@jest/globals';
import { FakeCatalogProvider } from '../catalog/fake-catalog.provider.js';
import type { AiStreamInput, AiStreamResult } from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';
import { createFakeAiStream } from './fake-ai.stream.js';

const input = (
  text: string,
  history: NonNullable<AiStreamInput['history']>,
): AiStreamInput => ({
  threadId: '0198a122-0c00-7000-8000-000000000100',
  runId: '0198a122-0c00-7000-8000-000000000101',
  text,
  history,
  image: null,
});

describe('fake AI clarification flow', () => {
  it('asks about vague earbuds use and searches after the selected answer', async () => {
    const catalog = new FakeCatalogProvider();
    const searchProducts = jest.fn((query: string) =>
      catalog.search({ query, first: 4, after: null }),
    );
    const tools: AiToolSession = {
      searchProducts,
      getProduct: (id) => catalog.getProduct(id),
      compareProducts: async (ids) => {
        const products = await Promise.all(
          ids.map((id) => catalog.getProduct(id)),
        );
        return products.filter((product) => product !== null);
      },
    };
    const completions: Array<AiStreamResult> = [];
    const lifecycle = {
      isCancelled: (): Promise<boolean> => Promise.resolve(false),
      onComplete: (result: AiStreamResult): Promise<void> => {
        completions.push(result);
        return Promise.resolve();
      },
      onFailure: (): Promise<void> => Promise.resolve(),
    };

    const questionEvents: Array<StreamChunk> = [];
    for await (const event of createFakeAiStream(
      input('무선 이어폰 찾아줘', [
        { role: 'user', text: '무선 이어폰 찾아줘' },
      ]),
      tools,
      lifecycle,
    )) {
      questionEvents.push(event);
    }
    expect(searchProducts).not.toHaveBeenCalled();
    expect(
      questionEvents.some(
        (event) =>
          event.type === EventType.TOOL_CALL_START &&
          event.toolCallName === 'askUser',
      ),
    ).toBe(true);
    expect(completions[0]?.askUser).toMatchObject({
      question: '어디에서 주로 사용할 건가요?',
      allowFreeText: false,
    });

    const answerEvents: Array<StreamChunk> = [];
    for await (const event of createFakeAiStream(
      input('출퇴근', [
        { role: 'user', text: '무선 이어폰 찾아줘' },
        {
          role: 'assistant',
          text: '어디에서 주로 사용할 건가요? 선택지: 출퇴근, 운동, 통화',
        },
        { role: 'user', text: '출퇴근' },
      ]),
      tools,
      lifecycle,
    )) {
      answerEvents.push(event);
    }
    expect(answerEvents.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(searchProducts).toHaveBeenCalledWith('이어폰');
    expect(completions[1]?.productIds).toContain(
      '0198a122-0c00-7000-8000-000000000005',
    );
  });
});
