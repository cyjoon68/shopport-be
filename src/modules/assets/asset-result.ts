import { z } from 'zod';

export const assetResultSchema = z.object({
  assetId: z.uuid(),
  normalizedKey: z.string().min(1).nullable(),
  status: z.enum(['ready', 'rejected']),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export type AssetResult = z.infer<typeof assetResultSchema>;
