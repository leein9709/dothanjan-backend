import assert from 'node:assert/strict';
import pg from 'pg';
import { readConfig } from '../src/config.js';
const config = readConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000 });
try {
  const version = await pool.query('SHOW server_version');
  const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(tables.rows.some(row => row.tablename === 'social_identities'));
  const base = `http://127.0.0.1:${config.port}`;
  for (const path of ['/health/live', '/health/ready', '/v1/auth/providers']) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, path);
  }
  console.log(`Database ${version.rows[0].server_version}; migrations and live HTTP checks passed.`);
} finally { await pool.end(); }
