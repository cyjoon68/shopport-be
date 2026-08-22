import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { Environment } from '../../config/environment.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import {
  AI_PROVIDER_FETCH,
  OpenAiCompatibleAiStreamAdapter,
} from './openai-compatible-ai.adapter.js';
import { aiStreamAdapterProvider } from './ai.module.js';

const compileAdapter = (): Promise<TestingModule> =>
  Test.createTestingModule({
    providers: [
      OpenAiCompatibleAiStreamAdapter,
      { provide: AI_PROVIDER_FETCH, useValue: globalThis.fetch },
      aiStreamAdapterProvider,
      {
        provide: ConfigService,
        useValue: new ConfigService<Environment, true>({
          COMMAND_CODE_API_KEY: 'test-command-code-key',
          COMMAND_CODE_MODEL: 'gpt-5.4-mini',
          COMMAND_CODE_MAX_OUTPUT_TOKENS: 512,
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
