import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const configureRuntimeRole = async (
  pool: Pool,
  password: string,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('select set_config($1, $2, false)', [
      'shopport.app_password',
      password,
    ]);
    await client.query(`
      DO $$
      DECLARE
        app_password text := current_setting('shopport.app_password');
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shopport_app') THEN
          EXECUTE format(
            'ALTER ROLE shopport_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',
            app_password
          );
        ELSE
          EXECUTE format(
            'CREATE ROLE shopport_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',
            app_password
          );
        END IF;
      END
      $$;
      REVOKE ALL ON DATABASE shopport FROM PUBLIC;
      GRANT CONNECT ON DATABASE shopport TO shopport_app;
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rdsproxyadmin') THEN
          EXECUTE 'GRANT CONNECT ON DATABASE shopport TO rdsproxyadmin';
        END IF;
      END
      $$;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO shopport_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shopport_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shopport_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shopport_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO shopport_app;
    `);
  } finally {
    try {
      await client.query('reset shopport.app_password');
    } finally {
      client.release();
    }
  }
};

const run = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const runtimePassword = process.env.DATABASE_APP_PASSWORD;
  if (runtimePassword?.length === 0)
    throw new Error('DATABASE_APP_PASSWORD must not be empty');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    if (runtimePassword) await configureRuntimeRole(pool, runtimePassword);
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
