import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginError, type LoginProvider, type ProviderId } from './login-provider.js';
import type { LoginStore } from './login-store.js';
import { ACCESS_SECONDS, REFRESH_IDLE_SECONDS, expiryAfter, rotatedToken } from './session-tokens.js';
import { validateCafeName } from './cafe-name.js';

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const validProof = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const bearer = (request: FastifyRequest) => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
const owners = new Set(['human-male', 'human-female', 'cat-ginger', 'cat-black', 'cat-white-gray',
  'fox-orange', 'fox-white', 'rabbit-white', 'rabbit-light-brown']);

export function registerAuthRoutes(app: FastifyInstance, store: LoginStore, rotationSecret: string) {
  const buckets = new Map<string, { count: number; expires: number }>();
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/auth/')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const path = request.url.split('?')[0]!;
    const now = Date.now();
    for (const [key, value] of buckets) if (value.expires <= now) buckets.delete(key);
    const id = request.ip + ':' + path;
    if (!buckets.has(id)) {
      if (buckets.size >= 4096) return reply.code(429).send({ error: 'too_many_attempts' });
      buckets.set(id, { count: 0, expires: now + 60000 });
    }
    const limit = path.endsWith('/result') ? 180 : 20;
    if (++buckets.get(id)!.count > limit) return reply.code(429).header('Retry-After', '60').send({ error: 'too_many_attempts' });
  });
  app.get('/v1/auth/me', async (request, reply) => {
    const token = bearer(request);
    if (!token) return reply.code(401).send({ error: 'session_expired' });
    try {
      const player = await store.me(hashSecret(token));
      return player ? { player } : reply.code(401).send({ error: 'session_expired' });
    } catch { return reply.code(503).send({ error: 'server_unavailable' }); }
  });
  app.post<{ Body: { cafe_name?: unknown } }>('/v1/auth/cafe-name/check', { bodyLimit: 4096 }, async (request, reply) => {
    const token = bearer(request);
    if (!token) return reply.code(401).send({ error: 'session_expired' });
    try {
      const player = await store.me(hashSecret(token));
      if (!player) return reply.code(401).send({ error: 'session_expired' });
      const candidate = validateCafeName(request.body?.cafe_name);
      if (!candidate.ok) return reply.code(400).send({ error: 'invalid_cafe_name', reason: candidate.reason });
      const available = await store.isCafeNameAvailable(candidate.name, player.id);
      // Availability is advisory, not a reservation. Saving must handle UNIQUE conflicts.
      return { cafe_name: candidate.name, available };
    } catch { return reply.code(503).send({ error: 'server_unavailable' }); }
  });
  app.post<{ Body: { owner_character_id?: unknown; cafe_name?: unknown } }>('/v1/auth/cafe/setup', { bodyLimit: 4096 }, async (request, reply) => {
    const token = bearer(request);
    if (!token) return reply.code(401).send({ error: 'session_expired' });
    const owner = request.body?.owner_character_id;
    const candidate = validateCafeName(request.body?.cafe_name);
    if (typeof owner !== 'string' || !owners.has(owner)) return reply.code(400).send({ error: 'invalid_owner' });
    if (!candidate.ok) return reply.code(400).send({ error: 'invalid_cafe_name', reason: candidate.reason });
    try {
      const result = await store.setupCafe(hashSecret(token), owner, candidate.name);
      if ('error' in result) return reply.code(result.error === 'session_expired' ? 401 : 409).send(result);
      return result;
    } catch { return reply.code(503).send({ error: 'server_unavailable' }); }
  });
  app.post<{ Body: { refreshToken?: string; request_id?: string } }>('/v1/auth/session/refresh', { bodyLimit: 4096 }, async (request, reply) => {
    const refreshToken = request.body?.refreshToken, requestId = request.body?.request_id;
    if (!validProof(refreshToken) || !validId(requestId)) return reply.code(400).send({ error: 'invalid_request' });
    const accessToken = rotatedToken(rotationSecret, refreshToken, requestId, 'access');
    const nextRefreshToken = rotatedToken(rotationSecret, refreshToken, requestId, 'refresh');
    try {
      const result = await store.refresh(hashSecret(refreshToken), requestId, { refreshHash: hashSecret(nextRefreshToken), accessHash: hashSecret(accessToken),
        accessExpires: expiryAfter(ACCESS_SECONDS), idleExpires: expiryAfter(REFRESH_IDLE_SECONDS) });
      if (result.status !== 'success') return reply.code(401).send({ error: result.status === 'revoked' ? 'session_revoked' : 'session_expired' });
      return { status: 'success', accessToken, refreshToken: nextRefreshToken, provider: result.provider,
        expires_in: Math.max(0, Math.floor((result.accessExpires.getTime() - Date.now()) / 1000)),
        expires_at: result.accessExpires.toISOString(), refresh_expires_at: result.idleExpires.toISOString(), player: result.player };
    } catch { return reply.code(503).send({ error: 'server_unavailable' }); }
  });
  app.post<{ Body: { refreshToken?: string } }>('/v1/auth/logout', { bodyLimit: 4096 }, async (request, reply) => {
    const accessToken = bearer(request);
    const refreshToken = request.body?.refreshToken;
    if (refreshToken !== undefined && !validProof(refreshToken)) return reply.code(400).send({ error: 'invalid_request' });
    if (!accessToken && !refreshToken) return reply.code(401).send({ error: 'session_expired' });
    try {
      if (refreshToken) await store.revokeRefresh(hashSecret(refreshToken));
      if (accessToken) await store.revoke(hashSecret(accessToken));
      return reply.code(204).send();
    } catch { return reply.code(503).send({ error: 'server_unavailable' }); }
  });
}

export function registerLoginRoutes(app: FastifyInstance, provider: LoginProvider, store: LoginStore, rotationSecret: string, providerId: ProviderId = 'kakao') {
  const base = '/v1/auth/' + providerId;
  let verifying = 0;
  async function verify<T>(action: () => Promise<T>): Promise<T> {
    if (verifying >= 8) throw new LoginError('provider_unavailable');
    verifying++;
    try { return await action(); } finally { verifying--; }
  }
  const errorCode = (error: unknown) => error instanceof LoginError ? error.kind : 'server_unavailable';
  app.post(base + '/start', async (_request, reply) => {
    try {
      const id = randomUUID(), state = opaque(), proof = opaque();
      await store.start(id, hashSecret(state), hashSecret(proof), new Date(Date.now() + 600000), providerId);
      return { request_id: id, proof, authorization_url: provider.authorizationUrl(state), expires_in: 600 };
    } catch { return reply.code(503).send({ error: 'server_unavailable' }); }
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(base + '/callback', { logLevel: 'silent' }, async (request, reply) => {
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const message = (success: boolean) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>도트한잔</title>
<style>
@font-face{font-family:Dongle;src:url('/assets/fonts/Dongle-Regular.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16281e;color:#fff0c9;font-family:Dongle,sans-serif;font-size:34px;font-weight:400;font-synthesis:none;line-height:1.2}
main{margin:24px;padding:32px;background:rgba(14,31,23,.93);border:2px solid rgba(224,204,145,.5);border-radius:20px;text-align:center}
h2{margin:0;font-size:48px;font-weight:400;line-height:1.2}p{margin:12px 0 0;color:#ced5b6}
</style></head><body><main><h2>${success ? '로그인을 확인했어요' : '로그인을 마치지 못했어요'}</h2><p>도트한잔으로 돌아가 주세요.</p></main></body></html>`;
    if (!validProof(request.query.state)) return reply.code(400).type('text/html').send(message(false));
    let flowId: string | undefined;
    let success = false;
    try {
      flowId = await store.beginCallback(hashSecret(request.query.state), providerId);
      if (!flowId) return reply.code(400).type('text/html').send(message(false));
      if (request.query.error || typeof request.query.code !== 'string' || request.query.code.length > 2048 || !request.query.code) {
        await store.fail(flowId, request.query.error === 'access_denied' ? 'cancelled' : 'provider_error');
      } else {
        const identity = await verify(() => provider.exchange(request.query.code!, request.query.state));
        success = await store.complete(flowId, identity, providerId);
      }
    } catch (error) {
      if (flowId) { try { await store.fail(flowId, errorCode(error)); } catch { /* Poll request reports backend connectivity failure. */ } }
    }
    return reply.type('text/html').send(message(success));
  });
  app.post<{ Body: { request_id?: string; proof?: string } }>(base + '/result', { bodyLimit: 4096 }, async (request, reply) => {
    if (!validId(request.body?.request_id) || !validProof(request.body?.proof)) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const accessToken = rotatedToken(rotationSecret, request.body.proof, request.body.request_id, 'access');
      const refreshToken = rotatedToken(rotationSecret, request.body.proof, request.body.request_id, 'refresh');
      const result = await store.claim(request.body.request_id, hashSecret(request.body.proof), hashSecret(accessToken), expiryAfter(ACCESS_SECONDS), providerId,
        { familyId: randomUUID(), refreshHash: hashSecret(refreshToken), idleExpires: expiryAfter(REFRESH_IDLE_SECONDS) });
      if (!result || result.status === 'claimed') return reply.code(410).send({ error: 'login_expired' });
      if (result.status === 'pending' || result.status === 'processing') return reply.code(202).send({ status: 'pending' });
      if (result.status === 'failed') return reply.code(401).send({ error: result.error_code ?? 'login_failed' });
      if (!result.player_id || !result.accessExpires || !result.idleExpires) return reply.code(503).send({ error: 'server_unavailable' });
      return { status: 'success', accessToken, refreshToken, provider: providerId,
        expires_in: Math.max(0, Math.floor((result.accessExpires.getTime() - Date.now()) / 1000)),
        expires_at: result.accessExpires.toISOString(), refresh_expires_at: result.idleExpires.toISOString(), player: { id: result.player_id } };
    } catch { return reply.code(503).send({ error: 'server_unavailable' }); }
  });
  app.post<{ Body: { providerAccessToken?: string; providerRefreshToken?: string } }>(base + '/native', { bodyLimit: 16384 }, async (request, reply) => {
    const providerAccessToken = request.body?.providerAccessToken;
    if (typeof providerAccessToken !== 'string' || !providerAccessToken || providerAccessToken.length > 4096 || /\s/.test(providerAccessToken)) return reply.code(400).send({ error: 'invalid_request' });
    const providerRefreshToken = request.body?.providerRefreshToken;
    if (providerId === 'naver' && (typeof providerRefreshToken !== 'string' || !providerRefreshToken || providerRefreshToken.length > 4096 || /\s/.test(providerRefreshToken))) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const identity = await verify(() => provider.verify(providerAccessToken, providerRefreshToken));
      const accessToken = opaque(), refreshToken = opaque(), expires = expiryAfter(ACCESS_SECONDS), idleExpires = expiryAfter(REFRESH_IDLE_SECONDS);
      const player = await store.native(identity, hashSecret(accessToken), expires, providerId, { familyId: randomUUID(), refreshHash: hashSecret(refreshToken), idleExpires });
      return { status: 'success', accessToken, refreshToken, provider: providerId, expires_in: ACCESS_SECONDS,
        expires_at: expires.toISOString(), refresh_expires_at: idleExpires.toISOString(), player };
    } catch (error) { return reply.code(error instanceof LoginError && error.kind === 'invalid_token' ? 401 : 503).send({ error: errorCode(error) }); }
  });
}
