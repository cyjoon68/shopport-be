import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use((request: Request, response: Response, next: NextFunction): void => {
    const requestId = request.header('x-request-id') ?? randomUUID();
    response.setHeader('x-request-id', requestId);
    next();
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
};

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Startup failed'}\n`,
  );
  process.exitCode = 1;
});
