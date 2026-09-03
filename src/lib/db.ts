import { Pool } from 'pg';

const globalForDb = globalThis as unknown as { dbPool: Pool | undefined };

export const db = globalForDb.dbPool ?? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

if (process.env.NODE_ENV !== 'production') {
  globalForDb.dbPool = db;
}
