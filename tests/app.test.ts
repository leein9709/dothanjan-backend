import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

test('liveness succeeds while failed database readiness is reported as 503', async () => {
  const app = buildApp({ checkDatabase: async () => { throw new Error('secret connection string'); } });
  try {
    assert.equal((await app.inject('/health/live')).statusCode, 200);
    const response = await app.inject('/health/ready');
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes('secret'), false);
  } finally { await app.close(); }
});
test('connected database readiness and unconfigured social providers', async () => {
  const app = buildApp({ checkDatabase: async () => {} });
  try {
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    const auth = (await app.inject('/v1/auth/providers')).json();
    assert.equal(auth.mode, 'not_configured');
    assert.equal(auth.providers.length, 3);
    assert.ok(auth.providers.every((provider: { enabled: boolean }) => !provider.enabled));
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: 'test' } })).statusCode, 404);
  } finally { await app.close(); }
});
test('reject invalid environment configuration', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL/);
  assert.throws(() => readConfig({ PORT: 'invalid', DATABASE_URL: 'postgres://localhost/test' }), /PORT/);
  assert.throws(() => readConfig({ DATABASE_URL: 'https://example.com' }), /PostgreSQL/);
});
