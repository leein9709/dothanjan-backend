import pg from 'pg';
import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 3000, query_timeout: 3000 });
pool.on('error', () => app.log.error('Idle database connection failed'));
const app = buildApp({ logger: true, checkDatabase: async () => { await pool.query('SELECT 1'); } });
app.addHook('onClose', async () => { await pool.end(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
