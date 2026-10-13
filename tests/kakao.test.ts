import test from 'node:test';
import assert from 'node:assert/strict';
import { kakaoProvider } from '../src/kakao.js';
import { readConfig } from '../src/config.js';

const config = { restKey: 'fixture-rest-key', clientSecret: 'fixture-secret', appId: '123', redirectUri: 'http://127.0.0.1:3000/v1/auth/kakao/callback' };

test('Kakao token validation checks app and identity, preserves 64-bit subject and verified email', async () => {
  const provider = kakaoProvider(config, async input => new Response(String(input).includes('access_token_info')
    ? '{"id":9007199254740993,"app_id":123,"expires_in":7200}'
    : '{"id":9007199254740993,"kakao_account":{"email":"USER@example.com","is_email_valid":true,"is_email_verified":true}}'));
  assert.deepEqual(await provider.verify('fixture-token'), { subject: '9007199254740993', email: 'user@example.com' });
});

test('Kakao tokens for another app or subject cannot sign in', async () => {
  const wrongApp = kakaoProvider(config, async () => new Response('{"id":1,"app_id":999,"expires_in":10}'));
  await assert.rejects(wrongApp.verify('fixture-token'), /invalid_token/);
  const wrongSubject = kakaoProvider(config, async input => new Response(String(input).includes('access_token_info')
    ? '{"id":1,"app_id":123,"expires_in":10}' : '{"id":2}'));
  await assert.rejects(wrongSubject.verify('fixture-token'), /invalid_token/);
});

test('email absence or unverified email does not prevent identity-based sign-in', async () => {
  for (const account of [{}, { email: 'test@example.com', is_email_valid: true, is_email_verified: false }]) {
    const provider = kakaoProvider(config, async input => new Response(JSON.stringify(String(input).includes('access_token_info')
      ? { id: 1, app_id: 123, expires_in: 10 } : { id: 1, kakao_account: account })));
    assert.deepEqual(await provider.verify('fixture-token'), { subject: '1', email: null });
  }
});

test('authorization contains state but no secret; token exchange includes secret only in POST body', async () => {
  let exchangeSeen = false;
  const provider = kakaoProvider(config, async (input, init) => {
    if (String(input).includes('/oauth/token')) {
      exchangeSeen = true;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_secret'), config.clientSecret);
      assert.equal(body.get('redirect_uri'), config.redirectUri);
      return new Response('{"access_token":"fixture-token"}');
    }
    return new Response(JSON.stringify(String(input).includes('access_token_info') ? { id: 1, app_id: 123, expires_in: 10 } : { id: 1 }));
  });
  const url = new URL(provider.authorizationUrl('fixture-state'));
  assert.equal(url.searchParams.get('state'), 'fixture-state');
  assert.equal(url.href.includes(config.clientSecret), false);
  await provider.exchange('fixture-code');
  assert.equal(exchangeSeen, true);
});

test('partial credentials and production HTTP callback are rejected without echoing secrets', () => {
  assert.throws(() => readConfig({ DATABASE_URL: 'postgres://localhost/test', KAKAO_REST_API_KEY: 'fixture' }), /Incomplete Kakao/);
  assert.throws(() => readConfig({ DATABASE_URL: 'postgres://localhost/test', NODE_ENV: 'production', KAKAO_REST_API_KEY: 'fixture', KAKAO_CLIENT_SECRET: 'fixture-secret', KAKAO_APP_ID: '123', KAKAO_REDIRECT_URI: config.redirectUri }), /HTTPS/);
});
