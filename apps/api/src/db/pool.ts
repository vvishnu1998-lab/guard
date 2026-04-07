import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // rejectUnauthorized: false allows Railway's proxy SSL cert to work correctly.
  // Railway's internal proxy uses a self-signed cert that fails strict verification.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  // Increased from 2000ms — Railway proxy latency can exceed 2s on cold start
  connectionTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Log but do NOT exit — a single dropped idle connection should not kill the server
  console.error('Unexpected error on idle client', err);
});
