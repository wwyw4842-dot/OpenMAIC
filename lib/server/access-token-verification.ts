import { createHmac, timingSafeEqual } from 'crypto';
import { parseAccessToken } from '@/lib/server/access-token-lifetime';

/** Verify an HMAC-signed token against the access code */
export function verifyAccessToken(token: string, accessCode: string): boolean {
  const parsed = parseAccessToken(token);
  if (!parsed) return false;
  const { timestamp, signature } = parsed;

  const expected = createHmac('sha256', accessCode).update(timestamp).digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;

  return timingSafeEqual(sigBuf, expBuf);
}
