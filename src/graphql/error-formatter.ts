import { HttpException } from '@nestjs/common';
import type { GraphQLFormattedError } from 'graphql';
import { GraphQLError } from 'graphql';
import { ZodError } from 'zod';

const codeForStatus = (status: number): string => {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VALIDATION_FAILED';
  return 'INTERNAL';
};

export const formatGraphqlError = (
  formatted: GraphQLFormattedError,
  error: unknown,
): GraphQLFormattedError => {
  const original: unknown =
    error instanceof GraphQLError ? Reflect.get(error, 'originalError') : null;
  const code =
    original instanceof HttpException
      ? codeForStatus(original.getStatus())
      : original instanceof ZodError ||
          formatted.extensions?.code === 'GRAPHQL_VALIDATION_FAILED'
        ? 'VALIDATION_FAILED'
        : 'INTERNAL';
  return {
    message:
      code === 'INTERNAL' ? '요청을 처리하지 못했습니다.' : formatted.message,
    ...(formatted.locations ? { locations: formatted.locations } : {}),
    ...(formatted.path ? { path: formatted.path } : {}),
    extensions: { code },
  };
};
