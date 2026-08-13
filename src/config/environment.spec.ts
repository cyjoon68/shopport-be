import { validateEnvironment } from './environment.js';

const productionEnvironment = {
  APP_ENV: 'prod',
  NODE_ENV: 'production',
  JWT_SECRET: 'a-secure-production-jwt-secret-value',
  KAKAO_NATIVE_APP_KEY: 'secure-kakao-native-key',
  REVENUECAT_WEBHOOK_SECRET: 'secure-revenuecat-webhook-secret',
  APPLE_AUDIENCES: 'com.shopport.mobile,com.shopport.web',
  AI_MODE: 'approved',
  CATALOG_MODE: 'approved',
  ALLOW_DEMO_AUTH: 'false',
  PERSISTED_OPERATION_MANIFEST: JSON.stringify({
    Viewer: 'a'.repeat(64),
  }),
  CLOUDFRONT_KEY_PAIR_ID: 'K123',
  CLOUDFRONT_PRIVATE_KEY: 'secure-private-key',
};

describe('validateEnvironment', () => {
  it('accepts a hardened production environment', () => {
    expect(validateEnvironment(productionEnvironment).APP_ENV).toBe('prod');
  });

  it.each([
    ['ALLOW_DEMO_AUTH', 'true'],
    ['AI_MODE', 'fake'],
    ['CATALOG_MODE', 'fake'],
    ['JWT_SECRET', 'local-development-secret-32-bytes'],
    ['PERSISTED_OPERATION_MANIFEST', ''],
    ['CLOUDFRONT_PRIVATE_KEY', ''],
  ])('rejects unsafe production %s', (key, value) => {
    expect(() =>
      validateEnvironment({ ...productionEnvironment, [key]: value }),
    ).toThrow();
  });
});
