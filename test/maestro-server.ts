import 'reflect-metadata';

import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type {
  AuthProvider,
  VerifiedIdentity,
} from '../src/modules/auth/auth.types.js';
import {
  createMaestroAiStream,
  maestroCatalogProvider,
} from './maestro-fixtures.js';

const configureEnvironment = (): void => {
  process.env.NODE_ENV ??= 'test';
  process.env.APP_ENV ??= 'dev';
  process.env.JWT_SECRET ??= 'maestro-test-secret-at-least-32-bytes';
  process.env.KAKAO_NATIVE_APP_KEY ??= 'maestro-kakao-key';
  process.env.PROVIDER_API_KEY ??= 'maestro-provider-key';
  process.env.PERSISTED_OPERATION_MANIFEST ??= '';
};

const createApplication = async (): Promise<INestApplication> => {
  configureEnvironment();
  const [
    { AppModule },
    { AI_STREAM_ADAPTER },
    { ProviderTokenVerifier },
    { CATALOG_PROVIDER },
  ] = await Promise.all([
    import('../src/app.module.js'),
    import('../src/modules/ai/ai-stream.adapter.js'),
    import('../src/modules/auth/provider-token-verifier.js'),
    import('../src/modules/catalog/catalog.tokens.js'),
  ]);
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ProviderTokenVerifier)
    .useValue({
      verify: (
        provider: AuthProvider,
        identityToken: string,
        nonce: string,
      ): Promise<VerifiedIdentity> => {
        if (
          identityToken !== 'maestro-identity-token' ||
          nonce !== 'maestro-identity-nonce'
        ) {
          throw new UnauthorizedException('Invalid Maestro identity');
        }
        return Promise.resolve({
          provider,
          subject: 'maestro-user',
          displayName: 'Maestro 사용자',
          profileImageUrl: null,
        });
      },
    })
    .overrideProvider(CATALOG_PROVIDER)
    .useValue(maestroCatalogProvider)
    .overrideProvider(AI_STREAM_ADAPTER)
    .useValue(createMaestroAiStream(4_000))
    .compile();
  return module.createNestApplication();
};

let application: INestApplication | undefined;

const shutdown = async (): Promise<void> => {
  await application?.close();
};

const start = async (): Promise<void> => {
  application = await createApplication();
  application.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 4000);
  await application.listen(port, '0.0.0.0');
  process.stdout.write(`Maestro API listening on ${String(port)}\n`);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
void start().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Maestro API startup failed'}\n`,
  );
  process.exitCode = 1;
});
