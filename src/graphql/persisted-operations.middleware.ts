import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { stripIgnoredCharacters } from 'graphql';
import type { Environment } from '../config/environment.js';

const documentHash = (query: string): string =>
  createHash('sha256').update(stripIgnoredCharacters(query)).digest('hex');

@Injectable()
export class PersistedOperationsMiddleware implements NestMiddleware {
  readonly #manifest: ReadonlyMap<string, string>;
  readonly #production: boolean;

  public constructor(config: ConfigService<Environment, true>) {
    this.#production = config.get('APP_ENV', { infer: true }) === 'prod';
    this.#manifest = new Map(
      Object.entries(
        JSON.parse(
          config.get('PERSISTED_OPERATION_MANIFEST', { infer: true }) || '{}',
        ) as Record<string, string>,
      ),
    );
  }

  public use(request: Request, response: Response, next: NextFunction): void {
    if (!this.#production) {
      next();
      return;
    }
    const operationId = request.header('x-shopport-operation-id');
    const expectedHash = operationId
      ? this.#manifest.get(operationId)
      : undefined;
    const body: unknown = request.body;
    const query =
      typeof body === 'object' &&
      body !== null &&
      'query' in body &&
      typeof body.query === 'string'
        ? body.query
        : null;
    let matches = false;
    if (expectedHash && query) {
      try {
        matches = documentHash(query) === expectedHash;
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
