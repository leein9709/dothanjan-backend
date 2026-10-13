import Fastify from 'fastify';

export type Dependencies = { checkDatabase: () => Promise<void>; logger?: boolean };

export function buildApp({ checkDatabase, logger = false }: Dependencies) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
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
    mode: 'not_configured',
    providers: [
      { id: 'kakao', enabled: false },
      { id: 'naver', enabled: false },
      { id: 'apple', enabled: false },
    ],
  }));
  // No fake sessions or client-secret placeholders are accepted as authentication.
  // Add provider callbacks only after developer-console registration.
  return app;
}
