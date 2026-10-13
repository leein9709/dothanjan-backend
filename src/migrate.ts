import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { readConfig } from './config.js';

const pool = new pg.Pool({ connectionString: readConfig().databaseUrl, connectionTimeoutMillis: 3000 });
const connection = await pool.connect();
try {
  await connection.query('BEGIN');
  await connection.query('SELECT pg_advisory_xact_lock(847201)');
  await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of (await readdir(folder)).filter(name => name.endsWith('.sql')).sort()) {
    const result = await connection.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (result.rowCount) continue;
    await connection.query(await readFile(`${folder}/${name}`, 'utf8'));
    await connection.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    console.log(`Applied ${name}`);
  }
  await connection.query('COMMIT');
} catch (error) {
  await connection.query('ROLLBACK');
  throw error;
} finally {
  connection.release();
  await pool.end();
}
