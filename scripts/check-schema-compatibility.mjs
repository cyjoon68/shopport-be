import { readFile } from 'node:fs/promises';
import { buildSchema, findBreakingChanges } from 'graphql';

const [baselinePath, currentPath = 'schema.graphql'] = process.argv.slice(2);
if (!baselinePath) {
  throw new Error(
    'Usage: node scripts/check-schema-compatibility.mjs <baseline.graphql> [current.graphql]',
  );
}

const [baseline, current] = await Promise.all([
  readFile(baselinePath, 'utf8'),
  readFile(currentPath, 'utf8'),
]);
const changes = findBreakingChanges(
  buildSchema(baseline),
  buildSchema(current),
);
if (changes.length > 0) {
  throw new Error(
    `Breaking GraphQL changes:\n${changes
      .map(({ type, description }) => `- ${type}: ${description}`)
      .join('\n')}`,
  );
}
process.stdout.write('GraphQL schema is backward compatible\n');
