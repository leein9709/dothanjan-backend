import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { validateCafeName } from '../src/cafe-name.js';
import { hashSecret, registerAuthRoutes } from '../src/login-routes.js';
import type { LoginStore } from '../src/login-store.js';

test('cafe names accept only Hangul, ASCII letters and digits with NFC and length validation', () => {
  assert.deepEqual(validateCafeName('한잔'.normalize('NFD')), { ok: true, name: '한잔' });
  for (const name of ['도트한잔', 'DotTea123', '찻집ABCabc09', 'ㄱㅏㅎ', '가'.repeat(64)]) {
    assert.deepEqual(validateCafeName(name), { ok: true, name });
  }
  assert.deepEqual(validateCafeName('가'.repeat(65)), { ok: false, reason: 'too_long' });
  for (const value of [undefined, {}, '']) assert.deepEqual(validateCafeName(value), { ok: false, reason: 'empty' });
  for (const value of ['도트 한잔', ' 도트한잔', '도트한잔 ', ' \t\n', '\ufeff', '\u00a0한잔\u3000',
    '🍵', '찻집_1', '찻집-1', '찻집!', 'é', '茶', '１２', '도트\n한잔', '도트한잔\n', '도트\u0000', '\ud800']) {
    assert.deepEqual(validateCafeName(value), { ok: false, reason: 'invalid_characters' }, JSON.stringify(value));
  }
});

test('availability is authenticated, read-only and returns no other player information', async () => {
  const token = 'a'.repeat(43);
  const playerId = '11111111-1111-4111-8111-111111111111';
  const queried: string[] = [];
  const store = {
    me: async (hash: string) => hash === hashSecret(token) ? { id: playerId } : undefined,
    isCafeNameAvailable: async (name: string, id: string) => {
      assert.equal(id, playerId);
      queried.push(name);
      return name !== '이미있는찻집';
    },
  } as LoginStore;
  const app = Fastify();
  registerAuthRoutes(app, store, 'b'.repeat(64));
  const headers = { authorization: 'Bearer ' + token };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/cafe-name/check', payload: { cafe_name: '도트한잔' } })).statusCode, 401);
    assert.deepEqual(queried, []);
    const available = await app.inject({ method: 'POST', url: '/v1/auth/cafe-name/check', headers, payload: { cafe_name: '도트한잔' } });
    assert.equal(available.statusCode, 200);
    assert.deepEqual(available.json(), { cafe_name: '도트한잔', available: true });
    const taken = await app.inject({ method: 'POST', url: '/v1/auth/cafe-name/check', headers, payload: { cafe_name: '이미있는찻집' } });
    assert.deepEqual(taken.json(), { cafe_name: '이미있는찻집', available: false });
    const invalid = await app.inject({ method: 'POST', url: '/v1/auth/cafe-name/check', headers, payload: { cafe_name: ' ' } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { error: 'invalid_cafe_name', reason: 'invalid_characters' });
    const special = await app.inject({ method: 'POST', url: '/v1/auth/cafe-name/check', headers, payload: { cafe_name: '찻집🍵' } });
    assert.equal(special.statusCode, 400);
    assert.deepEqual(queried, ['도트한잔', '이미있는찻집']);
    store.isCafeNameAvailable = async () => { throw new Error('private database detail'); };
    const failed = await app.inject({ method: 'POST', url: '/v1/auth/cafe-name/check', headers, payload: { cafe_name: '다른찻집' } });
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { error: 'server_unavailable' });
  } finally { await app.close(); }
});
