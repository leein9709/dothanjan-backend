import test from 'node:test';
import assert from 'node:assert/strict';
import { naverProvider } from '../src/naver.js';
import { readConfig } from '../src/config.js';

const config = { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret', redirectUri: 'http://127.0.0.1:3000/v1/auth/naver/callback' };
const tokenResponse = () => new Response(JSON.stringify({ access_token: 'new-server-token', expires_in: '3600', token_type: 'bearer' }));

test('Naver authorization binds client, callback and state without exposing secret', () => {
  const url = new URL(naverProvider(config).authorizationUrl('fixture-state'));
  assert.equal(url.origin, 'https://nid.naver.com');
  assert.equal(url.searchParams.get('client_id'), config.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('state'), 'fixture-state');
  assert.equal(url.href.includes(config.clientSecret), false);
});

test('Naver code exchange sends the validated state and credentials in a POST body', async () => {
  const provider = naverProvider(config, async (input, init) => {
    if (String(input).includes('/oauth2.0/token')) {
      assert.equal(init?.method, 'POST');
      assert.equal(String(input).includes(config.clientSecret), false);
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_secret'), config.clientSecret);
      assert.equal(body.get('state'), 'fixture-state');
      assert.equal(body.get('code'), 'fixture-code');
      return tokenResponse();
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer new-server-token');
    return new Response(JSON.stringify({ resultcode: '00', response: { id: 'Naver_Subject==', email: 'USER@example.com' } }));
  });
  await assert.rejects(provider.exchange('fixture-code'), /invalid_token/);
  assert.deepEqual(await provider.exchange('fixture-code', 'fixture-state'), { subject: 'Naver_Subject==', email: 'user@example.com' });
});

test('Naver SDK sign-in verifies refresh-token ownership with our client and ignores untrusted access-token profiles', async () => {
  const provider = naverProvider(config, async (input, init) => {
    if (String(input).includes('/oauth2.0/token')) {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('client_id'), config.clientId);
      assert.equal(body.get('client_secret'), config.clientSecret);
      assert.equal(body.get('refresh_token'), 'sdk-refresh');
      return tokenResponse();
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer new-server-token');
    return new Response('{"resultcode":"00","response":{"id":"our-app-user"}}');
  });
  await assert.rejects(provider.verify('untrusted-access'), /invalid_token/);
  assert.deepEqual(await provider.verify('untrusted-access', 'sdk-refresh'), { subject: 'our-app-user', email: null });
  const rejected = naverProvider(config, async () => new Response('{"error":"invalid_grant"}'));
  await assert.rejects(rejected.verify('untrusted-access', 'foreign-app-refresh'), /invalid_token/);
});

test('Naver rejects expired tokens, missing subjects and distinguishes temporary provider failures', async () => {
  const expired = naverProvider(config, async () => new Response('{"access_token":"token","expires_in":"0","token_type":"bearer"}'));
  await assert.rejects(expired.verify('sdk-access', 'sdk-refresh'), /invalid_token/);
  const noUser = naverProvider(config, async input => String(input).includes('/token') ? tokenResponse() : new Response('{"resultcode":"00","response":{}}'));
  await assert.rejects(noUser.verify('sdk-access', 'sdk-refresh'), /invalid_token/);
  const unavailable = naverProvider(config, async () => new Response('{"error":"temporarily_unavailable"}'));
  await assert.rejects(unavailable.verify('sdk-access', 'sdk-refresh'), /provider_unavailable/);
});

test('Naver profile email is optional, syntactically checked and never used to merge providers', async () => {
  for (const email of [undefined, 'invalid-email']) {
    const provider = naverProvider(config, async input => String(input).includes('/token') ? tokenResponse()
      : new Response(JSON.stringify({ resultcode: '00', response: { id: 'user', email } })));
    assert.deepEqual(await provider.verify('sdk-access', 'sdk-refresh'), { subject: 'user', email: null });
  }
});

test('Naver configuration is independent of Kakao and requires complete values and HTTPS in production', () => {
  const values = { DATABASE_URL: 'postgres://localhost/test', NAVER_CLIENT_ID: config.clientId, NAVER_CLIENT_SECRET: config.clientSecret, NAVER_REDIRECT_URI: config.redirectUri, SESSION_ROTATION_KEY: 'a'.repeat(64) };
  assert.equal(readConfig(values).kakao, undefined);
  assert.equal(readConfig(values).naver?.clientId, config.clientId);
  assert.equal(readConfig(values).sessionRotationKey, values.SESSION_ROTATION_KEY);
  for (const key of [undefined, '', 'a'.repeat(63), 'z'.repeat(64)]) {
    assert.throws(() => readConfig({ ...values, SESSION_ROTATION_KEY: key }), /SESSION_ROTATION_KEY/);
  }
  assert.throws(() => readConfig({ DATABASE_URL: values.DATABASE_URL, NAVER_CLIENT_ID: config.clientId }), /Incomplete Naver/);
  assert.throws(() => readConfig({ ...values, NODE_ENV: 'production' }), /HTTPS/);
});
