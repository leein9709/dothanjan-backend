import pg from 'pg';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { kakaoProvider } from './kakao.js';
import { naverProvider } from './naver.js';
import { postgresLoginStore } from './login-store.js';

const config = readConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 3000, query_timeout: 3000 });
pool.on('error', () => app.log.error('Idle database connection failed'));
const app = buildApp({ logger: true, kakao: config.kakao ? kakaoProvider(config.kakao) : undefined, naver: config.naver ? naverProvider(config.naver) : undefined, loginStore: config.kakao || config.naver ? postgresLoginStore(pool) : undefined, sessionRotationKey: config.sessionRotationKey, checkDatabase: async () => { await pool.query('SELECT 1'); } });
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
