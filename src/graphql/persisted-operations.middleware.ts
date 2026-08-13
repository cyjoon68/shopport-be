import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Environment } from '../config/environment.js';

@Injectable()
export class PersistedOperationsMiddleware implements NestMiddleware {
  readonly #allowed: ReadonlySet<string>;
  readonly #production: boolean;

  public constructor(config: ConfigService<Environment, true>) {
    this.#production = config.get('NODE_ENV', { infer: true }) === 'production';
    this.#allowed = new Set(
      config
        .get('PERSISTED_OPERATION_HASHES', { infer: true })
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
  }

  public use(request: Request, response: Response, next: NextFunction): void {
    if (!this.#production) {
      next();
      return;
    }
    const operationHash = request.header('x-shopport-operation-id');
    if (!operationHash || !this.#allowed.has(operationHash)) {
      response
        .status(403)
        .json({ code: 'FORBIDDEN', message: 'Persisted operation required' });
      return;
    }
    next();
  }
}
