import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const paths = [
  'src/modules/assets/assets.service.ts',
  'src/storage/object-store.ts',
  'src/image-processor.ts',
];

const sources = paths.map((path) => [path, readFileSync(path, 'utf8')]);

for (const [path, source] of sources) {
  assert.match(source, /new PutObjectCommand\(/u, `Missing S3 write: ${path}`);
  assert.doesNotMatch(
    source,
    /ServerSideEncryption|SSEKMSKeyId|BucketKeyEnabled/u,
    `S3 write overrides bucket encryption: ${path}`,
  );
}

const uploadSource = readFileSync(
  'src/modules/assets/assets.service.ts',
  'utf8',
);
assert.doesNotMatch(uploadSource, /x-amz-server-side-encryption/iu);
