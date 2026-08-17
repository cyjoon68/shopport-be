import { createHash } from 'node:crypto';
import { stripIgnoredCharacters } from 'graphql';
import { validateEnvironment } from './environment.js';

const persistedDocument = 'query Viewer { viewer { id } }';
const persistedDocumentHash = createHash('sha256')
  .update(stripIgnoredCharacters(persistedDocument))
  .digest('hex');

const productionEnvironment = {
  APP_ENV: 'prod',
  NODE_ENV: 'production',
  JWT_SECRET: 'a-secure-production-jwt-secret-value',
  KAKAO_NATIVE_APP_KEY: 'secure-kakao-native-key',
  REVENUECAT_WEBHOOK_SECRET: 'secure-revenuecat-webhook-secret',
  COMMAND_CODE_API_KEY: 'command-code-production-api-key',
  COMMAND_CODE_MODEL: 'gpt-5.4-mini',
  RAW_ASSET_BUCKET: 'shopport-production-raw',
  NORMALIZED_ASSET_BUCKET: 'shopport-production-normalized',
  ARCHIVE_BUCKET: 'shopport-production-archive',
  PERSISTED_OPERATION_MANIFEST: JSON.stringify({
    [persistedDocumentHash]: persistedDocument,
  }),
  CLOUDFRONT_KEY_PAIR_ID: 'K123',
  CLOUDFRONT_PRIVATE_KEY: 'secure-private-key',
};

describe('validateEnvironment', () => {
  it('requires a Command Code key', () => {
    expect(() => validateEnvironment({})).toThrow();
  });

  it('accepts a hardened production environment', () => {
    expect(validateEnvironment(productionEnvironment).APP_ENV).toBe('prod');
  });

  it.each([
    [
      'a tampered document',
      JSON.stringify({
        [persistedDocumentHash]: 'query Viewer { viewer { displayName } }',
      }),
    ],
    [
      'a tampered hash key',
      JSON.stringify({ ['a'.repeat(64)]: persistedDocument }),
    ],
    [
      'a legacy ID-to-hash manifest',
      JSON.stringify({ Viewer: persistedDocumentHash }),
    ],
  ])('rejects %s in the persisted manifest', (_scenario, manifest) => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        PERSISTED_OPERATION_MANIFEST: manifest,
      }),
    ).toThrow();
  });

  it.each([
    ['COMMAND_CODE_API_KEY', ''],
    ['JWT_SECRET', 'local-development-secret-32-bytes'],
    ['PERSISTED_OPERATION_MANIFEST', ''],
    ['CLOUDFRONT_PRIVATE_KEY', ''],
    ['RAW_ASSET_BUCKET', ''],
    ['NORMALIZED_ASSET_BUCKET', ''],
    ['ARCHIVE_BUCKET', ''],
  ])('rejects unsafe production %s', (key, value) => {
    expect(() =>
      validateEnvironment({ ...productionEnvironment, [key]: value }),
    ).toThrow();
  });

  it('rejects Claude models on the chat completions adapter', () => {
    expect(() =>
      validateEnvironment({
        COMMAND_CODE_API_KEY: 'command-code-api-key',
        COMMAND_CODE_MODEL: 'claude-sonnet-5',
      }),
    ).toThrow();
  });
});
