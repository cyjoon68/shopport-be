import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Environment } from '../config/environment.js';
import {
  hashGraphqlDocument,
  parsePersistedOperationManifest,
} from './persisted-operation-manifest.js';

@Injectable()
export class PersistedOperationsMiddleware implements NestMiddleware {
  readonly #manifest: ReadonlyMap<string, string>;
  readonly #production: boolean;

  public constructor(config: ConfigService<Environment, true>) {
    this.#production = config.get('APP_ENV', { infer: true }) === 'prod';
    this.#manifest = parsePersistedOperationManifest(
      config.get('PERSISTED_OPERATION_MANIFEST', { infer: true }),
    );
  }

  public use(request: Request, response: Response, next: NextFunction): void {
    if (!this.#production) {
      next();
      return;
    }
    const operationHash = request.header('x-shopport-operation-id');
    const body: unknown = request.body;
    const query =
      typeof body === 'object' &&
      body !== null &&
      'query' in body &&
      typeof body.query === 'string'
        ? body.query
        : null;
    let matches = false;
    if (operationHash && this.#manifest.has(operationHash) && query) {
      try {
        matches = hashGraphqlDocument(query) === operationHash;
      } catch {
        matches = false;
      }
    }
    if (!matches) {
      response
        .status(403)
        .json({ code: 'FORBIDDEN', message: 'Persisted operation required' });
      return;
    }
    next();
  }
}
