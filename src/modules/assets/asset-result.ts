import { z } from 'zod';

export const assetResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      assetId: z.uuid(),
      normalizedKey: z.string().min(1),
      status: z.literal('ready'),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      assetId: z.uuid(),
      normalizedKey: z.null(),
      status: z.literal('rejected'),
      width: z.null(),
      height: z.null(),
    })
    .strict(),
]);

export type AssetResult = z.infer<typeof assetResultSchema>;
