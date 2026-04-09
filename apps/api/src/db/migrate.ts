import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './pool';

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
    const files = ['schema.sql', 'schema_auth.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql', 'schema_v6.sql'];
    for (const file of files) {
      const sql = readFileSync(join(__dirname, file), 'utf8');
      console.log(`  → ${file}`);
      await client.query(sql);
    }
    console.log('All migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
