import { LoginError, type LoginIdentity, type LoginProvider } from './login-provider.js';
export type KakaoConfig = { restKey: string; clientSecret: string; appId: string; redirectUri: string };
export type KakaoIdentity = LoginIdentity;
export type KakaoProvider = LoginProvider;
export class KakaoError extends LoginError {}

// Kakao IDs are 64-bit values. Preserve their decimal representation before JSON parsing.
function parseKakao(text: string): Record<string, any> {
  return JSON.parse(text.replace(/("id"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"'));
}

export function kakaoProvider(config: KakaoConfig, fetcher: typeof fetch = fetch): KakaoProvider {
  async function json(url: string, init: RequestInit): Promise<Record<string, any>> {
    try {
      const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw new KakaoError(response.status >= 500 || response.status === 429 ? 'provider_unavailable' : 'invalid_token');
      return parseKakao(await response.text());
    } catch (error) {
      if (error instanceof KakaoError) throw error;
      throw new KakaoError('provider_unavailable');
    }
  }
  async function verify(accessToken: string): Promise<KakaoIdentity> {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const info = await json('https://kapi.kakao.com/v1/user/access_token_info', { headers });
    if (String(info.app_id) !== config.appId || !/^\d+$/.test(String(info.id)) || !(info.expires_in > 0)) throw new KakaoError('invalid_token');
    const url = new URL('https://kapi.kakao.com/v2/user/me');
    url.searchParams.set('property_keys', '["kakao_account.email"]');
    const user = await json(url.href, { headers });
    if (String(user.id) !== String(info.id)) throw new KakaoError('invalid_token');
    const account = user.kakao_account;
    const email = account?.is_email_valid === true && account?.is_email_verified === true && typeof account.email === 'string' && account.email.length <= 254
      ? account.email.trim().toLowerCase() : null;
    return { subject: String(info.id), email };
  }
  return {
    authorizationUrl(state) {
      const url = new URL('https://kauth.kakao.com/oauth/authorize');
      url.search = new URLSearchParams({ client_id: config.restKey, redirect_uri: config.redirectUri, response_type: 'code', state }).toString();
      return url.href;
    },
    async exchange(code) {
      const token = await json('https://kauth.kakao.com/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.restKey, client_secret: config.clientSecret, redirect_uri: config.redirectUri, code }),
      });
      if (typeof token.access_token !== 'string') throw new KakaoError('invalid_token');
      return verify(token.access_token);
    },
    verify,
  };
}
