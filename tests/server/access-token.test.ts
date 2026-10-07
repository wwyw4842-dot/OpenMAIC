// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { verifyAccessToken } from '@/app/api/access-code/verify/route';
import { middleware } from '@/middleware';
import { ACCESS_TOKEN_MAX_AGE_SECONDS } from '@/lib/server/access-token-lifetime';

const now = 1_790_000_000_000;
const secret = 'synthetic-access-code';
const ttl = ACCESS_TOKEN_MAX_AGE_SECONDS * 1000;
const signed = (timestamp: string, key = secret) => `${timestamp}.${createHmac('sha256', key).update(timestamp).digest('hex')}`;
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

for (const [label, timestamp, valid] of [
  ['new', String(now), true], ['last millisecond', String(now - ttl + 1), true],
  ['expired boundary', String(now - ttl), false], ['expired', String(now - ttl - 1), false],
  ['future', String(now + 1), false], ['not numeric', 'abc', false],
  ['leading zero', `0${now}`, false], ['fraction', `${now}.5`, false],
  ['unsafe integer', '9999999999999999', false],
] as const) {
  test(`node and middleware enforce ${label}`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubEnv('ACCESS_CODE', secret);
    const token = signed(timestamp);
    expect(verifyAccessToken(token, secret)).toBe(valid);
    const response = await middleware(new NextRequest('https://example.test/api/classrooms', { headers: { cookie: `openmaic_access=${token}` } }));
    expect(response.status).toBe(valid ? 200 : 401);
  });
}
test('rotation and malformed signatures fail closed', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); vi.stubEnv('ACCESS_CODE', secret);
  for (const token of [signed(String(now), 'old-secret'), signed(String(now)) + 'junk', signed(String(now)).slice(0, -1)]) {
    expect(verifyAccessToken(token, secret)).toBe(false);
    expect((await middleware(new NextRequest('https://example.test/api/classrooms', { headers: { cookie: `openmaic_access=${token}` } }))).status).toBe(401);
  }
});
