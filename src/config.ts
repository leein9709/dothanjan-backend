export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required; run the local setup script.');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const values = [env.KAKAO_REST_API_KEY, env.KAKAO_CLIENT_SECRET, env.KAKAO_APP_ID, env.KAKAO_REDIRECT_URI];
  const configured = values.every(Boolean);
  if (values.some(Boolean) && !configured) throw new Error('Incomplete Kakao configuration');
  let kakao: { restKey: string; clientSecret: string; appId: string; redirectUri: string } | undefined;
  if (configured) {
    if (!/^\d+$/.test(env.KAKAO_APP_ID!)) throw new Error('Invalid KAKAO_APP_ID');
    const callback = new URL(env.KAKAO_REDIRECT_URI!);
    if (!['https:', 'http:'].includes(callback.protocol) || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/v1/auth/kakao/callback') throw new Error('Invalid Kakao callback');
    if (env.NODE_ENV === 'production' && callback.protocol !== 'https:') throw new Error('Production Kakao callback must use HTTPS');
    kakao = { restKey: env.KAKAO_REST_API_KEY!, clientSecret: env.KAKAO_CLIENT_SECRET!, appId: env.KAKAO_APP_ID!, redirectUri: callback.href };
  }
  const naverValues = [env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET, env.NAVER_REDIRECT_URI];
  const naverConfigured = naverValues.every(Boolean);
  if (naverValues.some(Boolean) && !naverConfigured) throw new Error('Incomplete Naver configuration');
  let naver: { clientId: string; clientSecret: string; redirectUri: string } | undefined;
  if (naverConfigured) {
    const callback = new URL(env.NAVER_REDIRECT_URI!);
    if (!['https:', 'http:'].includes(callback.protocol) || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/v1/auth/naver/callback') throw new Error('Invalid Naver callback');
    if (env.NODE_ENV === 'production' && callback.protocol !== 'https:') throw new Error('Production Naver callback must use HTTPS');
    naver = { clientId: env.NAVER_CLIENT_ID!, clientSecret: env.NAVER_CLIENT_SECRET!, redirectUri: callback.href };
  }
  const sessionRotationKey = env.SESSION_ROTATION_KEY;
  if ((kakao || naver || sessionRotationKey) && (!sessionRotationKey || !/^[a-f0-9]{64}$/i.test(sessionRotationKey))) throw new Error('Invalid SESSION_ROTATION_KEY; provide a local 32-byte hex key');
  return { port, host: env.HOST ?? '127.0.0.1', databaseUrl: env.DATABASE_URL, kakao, naver, sessionRotationKey };
}
