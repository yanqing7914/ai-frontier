import { Global, Module } from '@nestjs/common';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

export const DRIZZLE_DATABASE = 'DRIZZLE_DATABASE';
export type PostgresJsDatabase = ReturnType<typeof drizzle>;

function createDatabase(): PostgresJsDatabase {
  const url = process.env.DATABASE_URL || process.env.SUDA_DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required to start AI Frontier');
  }
  return drizzle(postgres(url, { max: Number(process.env.DB_POOL_MAX || 10) }));
}

@Global()
@Module({
  providers: [{ provide: DRIZZLE_DATABASE, useFactory: createDatabase }],
  exports: [DRIZZLE_DATABASE],
})
export class DatabaseModule {}
