import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { validateEnvironment } from '../src/config/environment.js';

const run = async (): Promise<void> => {
  const environment = validateEnvironment(process.env);
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
  } finally {
    await pool.end();
  }
};

run().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Migration failed'}\n`,
  );
  process.exitCode = 1;
});
