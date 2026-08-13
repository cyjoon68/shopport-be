import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');

const section = (start, end) => {
  const startIndex = workflow.indexOf(start);
  const endIndex = workflow.indexOf(end, startIndex + start.length);

  assert.notEqual(startIndex, -1, `Missing workflow section: ${start}`);
  assert.notEqual(endIndex, -1, `Missing workflow section: ${end}`);

  return workflow.slice(startIndex, endIndex);
};

const mainBuild = section(
  'name: Build and push main runtime artifact',
  'name: Verify main runtime digests',
);
const lambdaBuild = section(
  'name: Build and push image processor artifact',
  'name: Verify image processor manifest',
);
const lambdaVerify = section(
  'name: Verify image processor manifest',
  'name: Generate image processor SBOM artifact',
);
const lambdaSbom = section(
  'name: Generate image processor SBOM artifact',
  'name: Scan image processor artifact',
);
const lambdaScan = workflow.slice(
  workflow.indexOf('name: Scan image processor artifact'),
);

assert.match(mainBuild, /platforms: linux\/arm64/);
assert.match(mainBuild, /provenance: mode=max/);
assert.match(mainBuild, /sbom: true/);
assert.match(lambdaBuild, /platforms: linux\/arm64/);
assert.match(lambdaBuild, /provenance: false/);
assert.match(lambdaBuild, /sbom: false/);
assert.doesNotMatch(lambdaBuild, /provenance: mode=max/);
assert.match(lambdaVerify, /aws ecr batch-get-image/);
assert.match(lambdaVerify, /application\/vnd\.oci\.image\.manifest\.v1\+json/);
assert.match(
  lambdaVerify,
  /application\/vnd\.docker\.distribution\.manifest\.v2\+json/,
);
assert.match(lambdaVerify, /imageManifestMediaType/);
assert.match(lambdaVerify, /docker pull --platform linux\/arm64 "\$image"/);
assert.match(lambdaVerify, /test "\$architecture" = "arm64"/);
assert.match(lambdaVerify, /image_processor_digest=\$digest/);
assert.match(lambdaSbom, /uses: anchore\/sbom-action@v0/);
assert.match(
  lambdaSbom,
  /image: \$\{\{ steps\.verify_lambda\.outputs\.image_processor_image \}\}/,
);
assert.match(lambdaSbom, /format: spdx-json/);
assert.match(
  lambdaSbom,
  /artifact-name: image-processor-sbom-\$\{\{ github\.sha \}\}\.spdx\.json/,
);
assert.match(lambdaSbom, /upload-artifact: true/);
assert.match(
  lambdaScan,
  /image-ref: \$\{\{ steps\.verify_lambda\.outputs\.image_processor_image \}\}/,
);
