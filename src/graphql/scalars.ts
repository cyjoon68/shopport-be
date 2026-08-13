import { GraphQLError, GraphQLScalarType, Kind } from 'graphql';
import type { ValueNode } from 'graphql';

const stringValue = (value: unknown, scalar: string): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  throw new GraphQLError(`${scalar} must be serialized as a string`);
};

const parseStringLiteral = (value: ValueNode, scalar: string): string => {
  if (value.kind === Kind.STRING || value.kind === Kind.INT) {
    return value.value;
  }
  throw new GraphQLError(`${scalar} must be a string literal`);
};

const parseDateTime = (value: unknown): Date => {
  const date = new Date(stringValue(value, 'DateTime'));
  if (Number.isNaN(date.getTime())) throw new GraphQLError('Invalid DateTime');
  return date;
};

const parseUuid = (value: unknown): string => {
  const id = stringValue(value, 'UUID');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
  ) {
    throw new GraphQLError('Invalid UUID');
  }
  return id;
};

const parseUrl = (value: unknown): string => {
  const url = new URL(stringValue(value, 'URL'));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new GraphQLError('URL must use HTTP or HTTPS');
  }
  return url.toString();
};

const parseBigInt = (value: unknown): string => {
  const number = stringValue(value, 'BigInt');
  if (!/^-?\d+$/u.test(number)) throw new GraphQLError('Invalid BigInt');
  return number;
};

export const dateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  serialize: (value): string => parseDateTime(value).toISOString(),
  parseValue: parseDateTime,
  parseLiteral: (value): Date =>
    parseDateTime(parseStringLiteral(value, 'DateTime')),
});

export const uuidScalar = new GraphQLScalarType({
  name: 'UUID',
  serialize: parseUuid,
  parseValue: parseUuid,
  parseLiteral: (value): string => parseUuid(parseStringLiteral(value, 'UUID')),
});

export const urlScalar = new GraphQLScalarType({
  name: 'URL',
  serialize: parseUrl,
  parseValue: parseUrl,
  parseLiteral: (value): string => parseUrl(parseStringLiteral(value, 'URL')),
});

export const bigIntScalar = new GraphQLScalarType({
  name: 'BigInt',
  serialize: parseBigInt,
  parseValue: parseBigInt,
  parseLiteral: (value): string =>
    parseBigInt(parseStringLiteral(value, 'BigInt')),
});
