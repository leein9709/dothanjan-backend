import { LoginError, type LoginIdentity, type LoginProvider } from './login-provider.js';

export type NaverConfig = { clientId: string; clientSecret: string; redirectUri: string };
type TokenResponse = { access_token?: unknown; expires_in?: unknown; token_type?: unknown; error?: unknown };
type ProfileResponse = { resultcode?: unknown; response?: { id?: unknown; email?: unknown } };

export function naverProvider(config: NaverConfig, fetcher: typeof fetch = fetch): LoginProvider {
  async function json<T>(url: string, init: RequestInit): Promise<T> {
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new LoginError(response.status >= 500 || response.status === 429 ? 'provider_unavailable' : 'invalid_token');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new LoginError('invalid_token');
      return result as T;
    } catch (error) {
      if (error instanceof LoginError) throw error;
      throw new LoginError('provider_unavailable');
    }
  }
  async function token(parameters: Record<string, string>): Promise<string> {
    const result = await json<TokenResponse>('https://nid.naver.com/oauth2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parameters, client_id: config.clientId, client_secret: config.clientSecret }),
    });
    if (result.error === 'server_error' || result.error === 'temporarily_unavailable') throw new LoginError('provider_unavailable');
    if (result.error || typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 4096 || /\s/.test(result.access_token)
      || !(Number(result.expires_in) > 0) || String(result.token_type).toLowerCase() !== 'bearer') throw new LoginError('invalid_token');
    return result.access_token;
  }
  async function profile(accessToken: string): Promise<LoginIdentity> {
    const result = await json<ProfileResponse>('https://openapi.naver.com/v1/nid/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    const user = result.response;
    if (result.resultcode !== '00' || typeof user?.id !== 'string' || !user.id || user.id.length > 128 || /\s/.test(user.id)) throw new LoginError('invalid_token');
    // Naver does not expose Kakao's is_email_verified flag. Email never proves account ownership.
    const email = typeof user.email === 'string' && user.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email.trim()) ? user.email.trim().toLowerCase() : null;
    return { subject: user.id, email };
  }
  return {
    authorizationUrl(state) {
      const url = new URL('https://nid.naver.com/oauth2.0/authorize');
      url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, state }).toString();
      return url.href;
    },
    async exchange(code, state) {
      if (!state) throw new LoginError('invalid_token');
      return profile(await token({ grant_type: 'authorization_code', code, state, redirect_uri: config.redirectUri }));
    },
    async verify(_accessToken, refreshToken) {
      if (!refreshToken) throw new LoginError('invalid_token');
      // Exchange against our client credentials, then read only the newly issued token's profile.
      // A profile fetched with an arbitrary client-supplied access token cannot establish its audience.
      return profile(await token({ grant_type: 'refresh_token', refresh_token: refreshToken }));
    },
  };
}
