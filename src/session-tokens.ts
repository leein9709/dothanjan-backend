import { createHmac } from 'node:crypto';

export const ACCESS_SECONDS = 15 * 60;
export const REFRESH_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_PROTOCOL_VERSION = 2;
export const REFRESH_RETRY_SECONDS = 120;
export const expiryAfter = (seconds: number) => new Date(Date.now() + seconds * 1000);

// Regenerate the same response for a bounded retry of the same refresh operation.
// The server key prevents a holder of an old token from predicting new credentials.
export function rotatedToken(secret: string, refreshToken: string, requestId: string, purpose: 'access' | 'refresh'): string {
  return createHmac('sha256', Buffer.from(secret, 'hex')).update(`dothanjan:v1:${purpose}:${refreshToken}:${requestId}`).digest('base64url');
}
