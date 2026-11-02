import pg, { type PoolClient } from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://sale:sale@localhost:5435/sale',
  max: Number(process.env.PG_POOL_SIZE ?? 20),
});

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
