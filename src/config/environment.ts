import { z } from 'zod';
import { parsePersistedOperationManifest } from '../graphql/persisted-operation-manifest.js';

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
    RAW_ASSET_BUCKET: z.string().optional(),
    NORMALIZED_ASSET_BUCKET: z.string().optional(),
    ARCHIVE_BUCKET: z.string().optional(),
    ASSET_CDN_HOST: z.string().default('localhost'),
    CLOUDFRONT_KEY_PAIR_ID: z.string().optional(),
    CLOUDFRONT_PRIVATE_KEY: z.string().optional(),
    SQS_ASSET_RESULT_URL: z.string().default('shopport-asset-results'),
    JWT_SECRET: z.string().min(32).default('local-development-secret-32-bytes'),
    JWT_ISSUER: z.string().default('shopport'),
    JWT_AUDIENCE: z.string().default('shopport-mobile'),
    KAKAO_NATIVE_APP_KEY: z.string().default('local-kakao-key'),
    REVENUECAT_WEBHOOK_SECRET: z.string().default('local-revenuecat-secret'),
    COMMAND_CODE_API_KEY: z.string().trim().min(1),
    COMMAND_CODE_MODEL: z.string().trim().min(1).default('gpt-5.4-mini'),
    COMMAND_CODE_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(128)
      .max(2_048)
      .default(512),
    PERSISTED_OPERATION_MANIFEST: z.string().default(''),
  })
  .superRefine((environment, context) => {
    const production = environment.APP_ENV === 'prod';
    if (/^claude-/iu.test(environment.COMMAND_CODE_MODEL)) {
      context.addIssue({
        code: 'custom',
        message:
          'Command Code Claude models require the Anthropic Messages endpoint',
        path: ['COMMAND_CODE_MODEL'],
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
        const manifest = parsePersistedOperationManifest(
          environment.PERSISTED_OPERATION_MANIFEST,
        );
        if (production && manifest.size === 0) {
          throw new Error('Invalid manifest');
        }
      } catch {
        context.addIssue({
          code: 'custom',
          message:
            'Persisted operation manifest must map normalized document SHA-256 hashes to matching documents',
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
    for (const bucket of [
      'RAW_ASSET_BUCKET',
      'NORMALIZED_ASSET_BUCKET',
      'ARCHIVE_BUCKET',
    ] as const) {
      if (production && !environment[bucket]?.trim()) {
        context.addIssue({
          code: 'custom',
          message: 'Production requires split storage buckets',
          path: [bucket],
        });
      }
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
    if (
      production &&
      environment.COMMAND_CODE_API_KEY &&
      /(?:local|development|replace|example|changeme)/iu.test(
        environment.COMMAND_CODE_API_KEY,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production secrets must not use local placeholder values',
        path: ['COMMAND_CODE_API_KEY'],
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export const validateEnvironment = (
  values: Record<string, unknown>,
): Environment => environmentSchema.parse(values);
