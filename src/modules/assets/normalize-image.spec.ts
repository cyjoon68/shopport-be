import sharp from 'sharp';
import { normalizeImage } from './normalize-image.js';

describe('image normalization', () => {
  it('resizes, rotates, and strips metadata', async () => {
    const source = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: '#ff5500' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const normalized = await normalizeImage(source);
    const metadata = await sharp(normalized.data).metadata();
    expect(Math.max(normalized.width, normalized.height)).toBeLessThanOrEqual(
      2048,
    );
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.format).toBe('jpeg');
  });

  it('rejects malformed image data', async () => {
    await expect(normalizeImage(Buffer.from('not-an-image'))).rejects.toThrow();
  });
});
