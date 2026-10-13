import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { postgresLoginStore } from '../src/login-store.js';
import { KakaoError, type KakaoProvider } from '../src/kakao.js';

const schema = 'kakao_test_' + randomBytes(8).toString('hex');
const admin = new pg.Pool({ connectionString: readConfig().databaseUrl });
const pool = new pg.Pool({ connectionString: readConfig().databaseUrl, options: `-c search_path=${schema}`, max: 5 });
const provider: KakaoProvider = {
  authorizationUrl: state => 'https://kauth.kakao.com/oauth/authorize?state=' + state,
  exchange: async code => ({ subject: code === 'repeat' ? '1001' : '1002', email: 'fixture@example.test' }),
  verify: async token => {
    if (token === 'invalid') throw new KakaoError('invalid_token');
    return { subject: token === 'fixture-client' ? '2001' : '1001', email: token === 'no-email' ? null : 'fixture@example.test' };
  },
};
const app = buildApp({ checkDatabase: async () => { await pool.query('SELECT 1'); }, kakao: provider, naver: provider, loginStore: postgresLoginStore(pool), sessionRotationKey: 'a'.repeat(64) });
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(value => value.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const native = await app.inject({ method: 'POST', url: '/v1/auth/kakao/native', payload: { providerAccessToken: 'fixture-native' } });
  assert.equal(native.statusCode, 200);
  const first = native.json();
  assert.equal(first.accessToken.length, 43);
  assert.equal(first.refreshToken.length, 43);
  assert.equal(first.token, undefined, 'Game API must use accessToken');
  assert.equal(first.expires_in, 900);
  assert.ok(Math.abs(Date.parse(first.refresh_expires_at) - Date.now() - 30 * 86400000) < 5000);
  assert.equal(first.status, 'success');
  assert.equal(first.email, undefined);
  assert.equal(first.is_new, undefined);
  const repeat = await app.inject({ method: 'POST', url: '/v1/auth/kakao/native', payload: { providerAccessToken: 'fixture-native' } });
  assert.equal(repeat.json().player.id, first.player.id);
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url: '/v1/auth/kakao/native', payload: { providerAccessToken: 'no-email' } })));
  assert.ok(concurrent.every(value => value.json().player.id === first.player.id));
  assert.equal((await pool.query('SELECT count(*) FROM players')).rows[0].count, '1');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/native', payload: { providerAccessToken: 'invalid' } })).statusCode, 401);
  assert.equal((await app.inject('/v1/auth/me')).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + first.accessToken } })).statusCode, 200);
  await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: 'Bearer ' + first.accessToken } });
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + first.accessToken } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: first.refreshToken, request_id: randomUUID() } })).statusCode, 401, 'Bearer logout must revoke its mobile family');

  const started = (await app.inject({ method: 'POST', url: '/v1/auth/kakao/start' })).json();
  const state = new URL(started.authorization_url).searchParams.get('state')!;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: '-'.repeat(36), proof: started.proof } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: started.request_id, proof: started.proof } })).statusCode, 202);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: started.request_id, proof: 'x'.repeat(43) } })).statusCode, 410);
  assert.equal((await app.inject('/v1/auth/kakao/callback?state=' + 'x'.repeat(43) + '&code=repeat')).statusCode, 400);
  const callback = await app.inject('/v1/auth/kakao/callback?state=' + state + '&code=repeat');
  assert.equal(callback.statusCode, 200);
  assert.equal(callback.body.includes(first.player.id), false);
  assert.equal((await app.inject('/v1/auth/kakao/callback?state=' + state + '&code=repeat')).statusCode, 400);
  const result = await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: started.request_id, proof: started.proof } });
  assert.equal(result.json().player.id, first.player.id);
  assert.equal(result.json().accessToken.length, 43);
  assert.equal(result.json().refreshToken.length, 43, 'Desktop web sign-in must issue renewal credentials too');
  assert.equal(result.json().provider, 'kakao');
  assert.ok(result.json().expires_in >= 898 && result.json().expires_in <= 900);
  const retriedWeb = await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: started.request_id, proof: started.proof } });
  assert.equal(retriedWeb.statusCode, 200);
  assert.equal(retriedWeb.json().accessToken, result.json().accessToken, 'Lost result responses must retry without consuming another session');
  assert.equal(retriedWeb.json().refreshToken, result.json().refreshToken);
  const webRenewed = await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: result.json().refreshToken, request_id: randomUUID() } });
  assert.equal(webRenewed.statusCode, 200, 'PC must renew through the same session endpoint');
  assert.equal(webRenewed.json().player.id, first.player.id);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: started.request_id, proof: started.proof } })).statusCode, 410, 'A proof must not recover a consumed refreshToken');
  const another = (await app.inject({ method: 'POST', url: '/v1/auth/kakao/start' })).json();
  await app.inject('/v1/auth/kakao/callback?state=' + new URL(another.authorization_url).searchParams.get('state') + '&code=another');
  const anotherResult = (await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: another.request_id, proof: another.proof } })).json();
  assert.notEqual(anotherResult.player.id, first.player.id, 'Same email must not silently merge unrelated identities');
  const cancelled = (await app.inject({ method: 'POST', url: '/v1/auth/kakao/start' })).json();
  await app.inject('/v1/auth/kakao/callback?state=' + new URL(cancelled.authorization_url).searchParams.get('state') + '&error=access_denied');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: cancelled.request_id, proof: cancelled.proof } })).json().error, 'cancelled');
  const expired = (await app.inject({ method: 'POST', url: '/v1/auth/kakao/start' })).json();
  await pool.query("UPDATE login_attempts SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.request_id]);
  assert.equal((await app.inject('/v1/auth/kakao/callback?state=' + new URL(expired.authorization_url).searchParams.get('state') + '&code=repeat')).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: expired.request_id, proof: expired.proof } })).statusCode, 410);
  const hashes = (await pool.query('SELECT token_hash FROM auth_sessions')).rows;
  assert.ok(hashes.every(row => /^[a-f0-9]{64}$/.test(row.token_hash)));
  assert.equal(hashes.some(row => row.token_hash === first.accessToken), false);

  const naverNative = (await app.inject({ method: 'POST', url: '/v1/auth/naver/native', payload: { providerAccessToken: 'fixture-native', providerRefreshToken: 'fixture-refresh' } })).json();
  assert.notEqual(naverNative.player.id, first.player.id, 'Different providers must not share an account based on the same subject/email');
  const naverRepeat = (await app.inject({ method: 'POST', url: '/v1/auth/naver/native', payload: { providerAccessToken: 'fixture-native', providerRefreshToken: 'fixture-refresh' } })).json();
  assert.equal(naverRepeat.player.id, naverNative.player.id);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/naver/native', payload: { providerAccessToken: 'fixture-native' } })).statusCode, 400);
  const naverFlow = (await app.inject({ method: 'POST', url: '/v1/auth/naver/start' })).json();
  const naverState = new URL(naverFlow.authorization_url).searchParams.get('state')!;
  assert.equal((await app.inject('/v1/auth/kakao/callback?state=' + naverState + '&code=repeat')).statusCode, 400);
  assert.equal((await app.inject('/v1/auth/naver/callback?state=' + naverState + '&code=repeat')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/kakao/result', payload: { request_id: naverFlow.request_id, proof: naverFlow.proof } })).statusCode, 410);
  const naverWeb = (await app.inject({ method: 'POST', url: '/v1/auth/naver/result', payload: { request_id: naverFlow.request_id, proof: naverFlow.proof } })).json();
  assert.equal(naverWeb.player.id, naverNative.player.id);
  assert.equal(naverWeb.refreshToken.length, 43);
  assert.equal((await app.inject('/v1/auth/providers')).json().protocol_version, 2);

  // Exercise real PostgreSQL locks, retries, inactivity and revocation, without any provider network calls.
  const family = (await pool.query('SELECT mobile_family_id FROM auth_sessions WHERE token_hash=$1', [tokenHash(naverNative.accessToken)])).rows[0].mobile_family_id;
  await pool.query("UPDATE mobile_session_families SET idle_expires_at=now()+interval '1 day' WHERE id=$1", [family]);
  const operation = randomUUID();
  const refreshPayload = { refreshToken: naverNative.refreshToken, request_id: operation };
  const rotatedResponse = await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: refreshPayload });
  assert.equal(rotatedResponse.statusCode, 200);
  const rotated = rotatedResponse.json();
  assert.notEqual(rotated.accessToken, naverNative.accessToken);
  assert.notEqual(rotated.refreshToken, naverNative.refreshToken);
  assert.equal(rotated.player.id, naverNative.player.id);
  assert.equal(rotated.provider, 'naver');
  assert.ok(rotated.expires_in >= 898 && rotated.expires_in <= 900);
  assert.ok(Math.abs(Date.parse(rotated.refresh_expires_at) - Date.now() - 30 * 86400000) < 5000, 'Successful renewal slides inactivity expiry forward');

  const restarted = buildApp({ checkDatabase: async () => {}, naver: provider, loginStore: postgresLoginStore(pool), sessionRotationKey: 'a'.repeat(64) });
  try {
    const retry = await restarted.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: refreshPayload });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().refreshToken, rotated.refreshToken, 'Lost response retry survives server restart');
    assert.equal(retry.json().accessToken, rotated.accessToken);
    assert.equal(retry.json().refresh_expires_at, rotated.refresh_expires_at, 'A retry must not extend lifetime again');
  } finally { await restarted.close(); }
  assert.equal((await pool.query('SELECT count(*) FROM mobile_refresh_tokens WHERE family_id=$1', [family])).rows[0].count, '2', 'Exact retries must not create another rotation');
  const replay = await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { ...refreshPayload, request_id: randomUUID() } });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error, 'session_revoked');
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + rotated.accessToken } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: rotated.refreshToken, request_id: randomUUID() } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + naverRepeat.accessToken } })).statusCode, 200, 'A replay must not revoke another device family');

  // Duplicate concurrent refreshes share one rotation; a subsequent current token rotates normally.
  const duplicatePayload = { refreshToken: naverRepeat.refreshToken, request_id: randomUUID() };
  const duplicates = await Promise.all(Array.from({ length: 2 }, () => app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: duplicatePayload })));
  assert.ok(duplicates.every(response => response.statusCode === 200));
  assert.equal(duplicates[0]!.json().refreshToken, duplicates[1]!.json().refreshToken);
  const next = (await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: duplicates[0]!.json().refreshToken, request_id: randomUUID() } })).json();
  assert.equal(next.status, 'success');
  assert.notEqual(next.refreshToken, duplicates[0]!.json().refreshToken);
  await pool.query('UPDATE auth_sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1', [tokenHash(next.accessToken)]);
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + next.accessToken } })).statusCode, 401);
  const renewed = (await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: next.refreshToken, request_id: randomUUID() } })).json();
  assert.equal(renewed.status, 'success', 'Expired accessToken must not expire a live refreshToken');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refreshToken: naverRepeat.refreshToken } })).statusCode, 204, 'Offline logout can revoke with an older token from its family');
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + renewed.accessToken } })).statusCode, 401);

  const idle = (await app.inject({ method: 'POST', url: '/v1/auth/kakao/native', payload: { providerAccessToken: 'fixture-native' } })).json();
  await pool.query("UPDATE mobile_session_families SET idle_expires_at=now()-interval '1 second' WHERE current_token_hash=$1", [tokenHash(idle.refreshToken)]);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: idle.refreshToken, request_id: randomUUID() } })).json().error, 'session_expired');
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + idle.accessToken } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: randomBytes(32).toString('base64url'), request_id: randomUUID() } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: 'short', request_id: operation } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: { refreshToken: idle.refreshToken, request_id: '-'.repeat(36) } })).statusCode, 400);

  const storedTokens = (await pool.query('SELECT token_hash FROM mobile_refresh_tokens')).rows;
  assert.ok(storedTokens.every(row => /^[a-f0-9]{64}$/.test(row.token_hash)));
  assert.equal(storedTokens.some(row => row.token_hash === rotated.refreshToken), false);

  const retryExpired = (await app.inject({ method: 'POST', url: '/v1/auth/kakao/native', payload: { providerAccessToken: 'fixture-native' } })).json();
  const expiredRetryPayload = { refreshToken: retryExpired.refreshToken, request_id: randomUUID() };
  const retryGrant = (await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: expiredRetryPayload })).json();
  assert.equal(retryGrant.status, 'success');
  await pool.query("UPDATE mobile_refresh_tokens SET retry_until=now()-interval '1 second' WHERE token_hash=$1", [tokenHash(retryExpired.refreshToken)]);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/session/refresh', payload: expiredRetryPayload })).json().error, 'session_revoked', 'Identical retries outside the bounded window must not bypass replay protection');
  assert.equal((await app.inject({ url: '/v1/auth/me', headers: { authorization: 'Bearer ' + retryGrant.accessToken } })).statusCode, 401);

  if (process.env.DOTHANJAN_GODOT_EXE && process.env.DOTHANJAN_CLIENT_PATH) {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.env.DOTHANJAN_GODOT_EXE!, ['--headless', '--path', process.env.DOTHANJAN_CLIENT_PATH!, '--script', 'res://tests/auth_smoke.gd', '--', '--auth-fixture'], {
        env: { ...process.env, DOTHANJAN_API_URL: address }, stdio: 'inherit', windowsHide: true,
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error('Godot authentication smoke failed')));
    });
  }
  console.log('Isolated PostgreSQL OAuth/SDK tests passed: auto signup, returning sign-in, provider isolation, concurrency, email fallback, state/proof, replay/expiry/cancel, session/revocation.');
} finally {
  await app.close();
  await pool.end();
  // Only the unique test schema created by this script is removed; application data is untouched.
  assert.match(schema, /^kakao_test_[a-f0-9]{16}$/);
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
