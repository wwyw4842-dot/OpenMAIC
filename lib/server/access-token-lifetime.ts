/** Match the existing seven-day access cookie lifetime on the server as well. */
export const ACCESS_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function parseAccessToken(token: string, now = Date.now()) {
  const match = /^([1-9]\d{0,15})\.([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  const issuedAt = Number(match[1]);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt >= ACCESS_TOKEN_MAX_AGE_SECONDS * 1000) {
    return null;
  }
  return { timestamp: match[1], signature: match[2] };
}
