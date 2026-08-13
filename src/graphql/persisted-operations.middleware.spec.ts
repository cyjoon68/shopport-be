import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { stripIgnoredCharacters } from 'graphql';
import type { Environment } from '../config/environment.js';
import { PersistedOperationsMiddleware } from './persisted-operations.middleware.js';

const query = 'query Viewer { viewer { id } }';
const hash = createHash('sha256')
  .update(stripIgnoredCharacters(query))
  .digest('hex');

type MinimalResponse = {
  status: (code: number) => MinimalResponse;
  json: (body: unknown) => MinimalResponse;
};

const createResponse = (): Readonly<{
  response: Response;
  statusCodes: Array<number>;
}> => {
  const statusCodes: Array<number> = [];
  const response: MinimalResponse = {
    status: (code: number): MinimalResponse => {
      statusCodes.push(code);
      return response;
    },
    json: (body: unknown): MinimalResponse => {
      void body;
      return response;
    },
  };
  return { response: response as unknown as Response, statusCodes };
};

const createMiddleware = (): PersistedOperationsMiddleware =>
  new PersistedOperationsMiddleware(
    new ConfigService<Environment, true>({
      APP_ENV: 'prod',
      PERSISTED_OPERATION_MANIFEST: JSON.stringify({ Viewer: hash }),
    }),
  );

describe('PersistedOperationsMiddleware', () => {
  it('accepts an allowed ID bound to the normalized document hash', () => {
    const middleware = createMiddleware();
    let nextCalls = 0;
    const next = (() => {
      nextCalls += 1;
    }) as NextFunction;
    const request = {
      body: { query: '\n query Viewer { viewer { id } }\n' },
      header: (): string => 'Viewer',
    } as unknown as Request;

    middleware.use(request, createResponse().response, next);

    expect(nextCalls).toBe(1);
  });

  it.each([
    ['Unknown', query],
    ['Viewer', 'query Viewer { viewer { displayName } }'],
  ])('rejects unknown IDs and document mismatches', (operationId, document) => {
    const middleware = createMiddleware();
    const { response, statusCodes } = createResponse();
    const request = {
      body: { query: document },
      header: (): string => operationId,
    } as unknown as Request;

    middleware.use(request, response, (() => undefined) as NextFunction);

    expect(statusCodes).toEqual([403]);
  });
});
