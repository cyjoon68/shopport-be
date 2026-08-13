import { z } from 'zod';

const environmentSchema = z
  .object({
    APP_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    DATABASE_URL: z
      .string()
      .default('postgresql://shopport:shopport@localhost:5432/shopport'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    AWS_REGION: z.string().default('ap-northeast-2'),
    AWS_ENDPOINT_URL: z.url().optional(),
    ASSET_BUCKET: z.string().default('shopport-assets'),
    ASSET_CDN_HOST: z.string().default('localhost'),
    CLOUDFRONT_KEY_PAIR_ID: z.string().optional(),
    CLOUDFRONT_PRIVATE_KEY: z.string().optional(),
    SQS_ASSET_RESULT_URL: z.string().default('shopport-asset-results'),
    JWT_SECRET: z.string().min(32).default('local-development-secret-32-bytes'),
    JWT_ISSUER: z.string().default('shopport'),
    JWT_AUDIENCE: z.string().default('shopport-mobile'),
    APPLE_CLIENT_ID: z.string().default('com.shopport.mobile'),
    APPLE_AUDIENCES: z.string().default(''),
    KAKAO_NATIVE_APP_KEY: z.string().default('local-kakao-key'),
    REVENUECAT_WEBHOOK_SECRET: z.string().default('local-revenuecat-secret'),
    AI_MODE: z.enum(['fake', 'approved']).default('fake'),
    CATALOG_MODE: z.enum(['fake', 'approved']).default('fake'),
    ALLOW_DEMO_AUTH: z.stringbool().default(true),
    PERSISTED_OPERATION_MANIFEST: z.string().default(''),
  })
  .superRefine((environment, context) => {
    const production = environment.APP_ENV === 'prod';
    if (production && environment.CATALOG_MODE === 'fake') {
      context.addIssue({
        code: 'custom',
        message: 'Production requires at least one approved catalog provider',
        path: ['CATALOG_MODE'],
      });
    }
    if (production && environment.AI_MODE === 'fake') {
      context.addIssue({
        code: 'custom',
        message: 'Production requires an approved AI provider',
        path: ['AI_MODE'],
      });
    }
    if (production && environment.ALLOW_DEMO_AUTH) {
      context.addIssue({
        code: 'custom',
        message: 'Demo authentication must be disabled in production',
        path: ['ALLOW_DEMO_AUTH'],
      });
    }
    if (
      production &&
      environment.PERSISTED_OPERATION_MANIFEST.trim().length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production requires a persisted GraphQL operation allowlist',
        path: ['PERSISTED_OPERATION_MANIFEST'],
      });
    }
    if (environment.PERSISTED_OPERATION_MANIFEST.trim().length > 0) {
      try {
        const manifest: unknown = JSON.parse(
          environment.PERSISTED_OPERATION_MANIFEST,
        );
        const valid =
          typeof manifest === 'object' &&
          manifest !== null &&
          !Array.isArray(manifest) &&
          Object.values(manifest).every(
            (hash) => typeof hash === 'string' && /^[a-f\d]{64}$/u.test(hash),
          );
        if (!valid || (production && Object.keys(manifest).length === 0)) {
          throw new Error('Invalid manifest');
        }
      } catch {
        context.addIssue({
          code: 'custom',
          message:
            'Persisted operation manifest must map IDs to SHA-256 hashes',
          path: ['PERSISTED_OPERATION_MANIFEST'],
        });
      }
    }
    if (
      production &&
      (!environment.CLOUDFRONT_KEY_PAIR_ID ||
        !environment.CLOUDFRONT_PRIVATE_KEY)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production requires CloudFront signing credentials',
        path: ['CLOUDFRONT_KEY_PAIR_ID'],
      });
    }
    if (production && environment.APPLE_AUDIENCES.trim().length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Production requires Apple audiences',
        path: ['APPLE_AUDIENCES'],
      });
    }
    const unsafeSecrets = [
      ['JWT_SECRET', environment.JWT_SECRET],
      ['KAKAO_NATIVE_APP_KEY', environment.KAKAO_NATIVE_APP_KEY],
      ['REVENUECAT_WEBHOOK_SECRET', environment.REVENUECAT_WEBHOOK_SECRET],
    ] as const;
    for (const [path, value] of unsafeSecrets) {
      if (
        production &&
        /(?:local|development|replace|example|changeme)/iu.test(value)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Production secrets must not use local placeholder values',
          path: [path],
        });
      }
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export const validateEnvironment = (
  values: Record<string, unknown>,
): Environment => environmentSchema.parse(values);
