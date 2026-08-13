import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { EventType } from '@tanstack/ai';
import type { Environment } from '../../config/environment.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import type { AiStreamAdapter } from './ai-stream.adapter.js';
import { FakeAiStreamAdapter } from './fake-ai.adapter.js';
import { aiStreamAdapterProvider } from './ai.module.js';

const compileAdapter = (mode: 'fake' | 'approved'): Promise<TestingModule> =>
  Test.createTestingModule({
    providers: [
      FakeAiStreamAdapter,
      aiStreamAdapterProvider,
      {
        provide: ConfigService,
        useValue: new ConfigService<Environment, true>({ AI_MODE: mode }),
      },
    ],
  }).compile();

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
        messageId: 'message',
        message: 'answer',
        products: [],
      },
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

  it('fails startup when approved mode has no registered adapter', async () => {
    await expect(compileAdapter('approved')).rejects.toThrow(
      'Approved AI provider adapter is not configured',
    );
  });
});
