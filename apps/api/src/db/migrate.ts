import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from './pool';

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');
    const files = ['schema.sql', 'schema_auth.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql', 'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql', 'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql', 'schema_v14.sql', 'schema_v15.sql', 'schema_v16.sql', 'schema_v17.sql', 'schema_v18.sql', 'schema_v19.sql', 'schema_v20.sql', 'schema_v21.sql', 'schema_v22.sql', 'schema_v23.sql', 'schema_v24.sql', 'schema_v25.sql', 'schema_v26.sql', 'schema_v27.sql', 'schema_v28.sql', 'schema_v29.sql', 'schema_v30.sql', 'schema_v31.sql', 'schema_v32.sql', 'schema_v33.sql', 'schema_v34.sql'];
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
