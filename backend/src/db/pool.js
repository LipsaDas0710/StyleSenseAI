import pg from 'pg';
import { env } from '../config/env.js';

// Return BIGINT/NUMERIC counts as numbers rather than strings.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

if (!env.DATABASE_URL) {
  throw new Error(
    process.env.VITEST
      ? 'TEST_DATABASE_URL is not set (see backend/.env.example)'
      : 'DATABASE_URL is not set (see backend/.env.example)',
  );
}

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

/**
 * Runs fn(client) inside BEGIN/COMMIT, rolling back on error. Functions that take a `db` argument
 * accept either this client or the pool itself.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
