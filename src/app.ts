import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import type { LoginProvider } from './login-provider.js';
import type { LoginStore } from './login-store.js';
import { registerAuthRoutes, registerLoginRoutes } from './login-routes.js';
import { AUTH_PROTOCOL_VERSION } from './session-tokens.js';

export type Dependencies = { checkDatabase: () => Promise<void>; logger?: boolean; kakao?: LoginProvider; naver?: LoginProvider; loginStore?: LoginStore; sessionRotationKey?: string };

export function buildApp({ checkDatabase, logger = false, kakao, naver, loginStore, sessionRotationKey }: Dependencies) {
  const app = Fastify({
    logger: logger ? { serializers: { req: request => ({ method: request.method, path: request.url?.split('?')[0] }) }, redact: ['req.headers.authorization', 'req.body', 'res.headers.location'] } : false,
    bodyLimit: 64 * 1024,
  });
  app.get('/assets/fonts/Dongle-Regular.ttf', async (_request, reply) => {
    return reply.type('font/ttf').header('Cache-Control', 'public, max-age=86400')
      .send(createReadStream(new URL('../assets/fonts/Dongle-Regular.ttf', import.meta.url)));
  });
  if (loginStore && (kakao || naver)) {
    if (!sessionRotationKey || !/^[a-f0-9]{64}$/i.test(sessionRotationKey)) throw new Error('SESSION_ROTATION_KEY is required for social sessions');
    registerAuthRoutes(app, loginStore, sessionRotationKey);
    if (kakao) registerLoginRoutes(app, kakao, loginStore, sessionRotationKey, 'kakao');
    if (naver) registerLoginRoutes(app, naver, loginStore, sessionRotationKey, 'naver');
  }
  app.get('/health/live', async () => ({ status: 'ok', service: 'dothanjan-api' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await checkDatabase();
      return { status: 'ok', database: 'connected' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'disconnected' });
    }
  });
  app.get('/v1/auth/providers', async () => ({
    protocol_version: AUTH_PROTOCOL_VERSION,
    mode: loginStore && kakao && naver ? 'social' : loginStore && kakao ? 'kakao' : loginStore && naver ? 'naver' : 'not_configured',
    providers: [
      { id: 'kakao', enabled: Boolean(kakao && loginStore) },
      { id: 'naver', enabled: Boolean(naver && loginStore) },
      { id: 'apple', enabled: false },
    ],
  }));
  // Only verified provider identities can issue game sessions.
  return app;
}
