import { ConfigService } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import type { Environment } from '../../config/environment.js';
import { aiStreamAdapterProvider } from './ai.module.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import {
  AI_PROVIDER_FETCH,
  OpenAiCompatibleAiStreamAdapter,
} from './openai-compatible-ai.adapter.js';

const compileAdapter = (): Promise<TestingModule> =>
  Test.createTestingModule({
    providers: [
      OpenAiCompatibleAiStreamAdapter,
      { provide: AI_PROVIDER_FETCH, useValue: globalThis.fetch },
      aiStreamAdapterProvider,
      {
        provide: ConfigService,
        useValue: new ConfigService<Environment, true>({
          PROVIDER_API_KEY: 'test-provider-key',
          PROVIDER_MODEL: 'gpt-5.4-mini',
          PROVIDER_MAX_OUTPUT_TOKENS: 512,
        }),
      },
    ],
  }).compile();

describe('AiModule adapter selection', () => {
  it('connects the OpenAI-compatible adapter', async () => {
    const module = await compileAdapter();
    expect(module.get(AI_STREAM_ADAPTER)).toBeInstanceOf(
      OpenAiCompatibleAiStreamAdapter,
    );
    await module.close();
  });
});
