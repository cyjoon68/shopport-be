import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import type { Environment } from '../config/environment.js';

export const DATABASE = Symbol('DATABASE');
export const DATABASE_POOL = Symbol('DATABASE_POOL');
export type Database = NodePgDatabase<typeof schema>;

const poolProvider = {
  provide: DATABASE_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Environment, true>): Pool =>
    new Pool({
      connectionString: config.get('DATABASE_URL', { infer: true }),
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    }),
};

const databaseProvider = {
  provide: DATABASE,
  inject: [DATABASE_POOL],
  useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
};

class DatabaseLifecycle implements OnApplicationShutdown {
  public constructor(private readonly pool: Pool) {}

  public onApplicationShutdown(): Promise<void> {
    return this.pool.end();
  }
}

const lifecycleProvider = {
  provide: DatabaseLifecycle,
  inject: [DATABASE_POOL],
  useFactory: (pool: Pool): DatabaseLifecycle => new DatabaseLifecycle(pool),
};

@Global()
@Module({
  providers: [poolProvider, databaseProvider, lifecycleProvider],
  exports: [DATABASE, DATABASE_POOL],
})
export class DatabaseModule {}
