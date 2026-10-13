export type ProviderId = 'kakao' | 'naver';
export type LoginIdentity = { subject: string; email: string | null };
export type LoginProvider = {
  authorizationUrl(state: string): string;
  exchange(code: string, state?: string): Promise<LoginIdentity>;
  verify(accessToken: string, refreshToken?: string): Promise<LoginIdentity>;
};
export class LoginError extends Error {
  constructor(public kind: 'invalid_token' | 'provider_unavailable') { super(kind); }
}
