import sharp from 'sharp';

export type NormalizedImage = Readonly<{
  data: Buffer;
  width: number;
  height: number;
}>;

export const normalizeImage = async (
  source: Buffer,
): Promise<NormalizedImage> => {
  const image = sharp(source, {
    failOn: 'warning',
    limitInputPixels: 20_000_000,
  });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height)
    throw new Error('Missing dimensions');
  if (metadata.width * metadata.height > 20_000_000) {
    throw new Error('Image exceeds 20 megapixels');
  }
  if (!['jpeg', 'png', 'heif'].includes(metadata.format)) {
    throw new Error('Unsupported decoded image format');
  }
  const normalized = await image
    .rotate()
    .resize({
      width: 2048,
      height: 2048,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88, progressive: true })
    .toBuffer({ resolveWithObject: true });
  return {
    data: normalized.data,
    width: normalized.info.width,
    height: normalized.info.height,
  };
};
