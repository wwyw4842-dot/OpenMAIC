import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/verify-pdf-provider/route';
import { resolvePDFApiKey } from '@/lib/server/provider-config';

vi.mock('@/lib/server/provider-config', () => ({
  resolvePDFApiKey: vi.fn(() => 'synthetic-operator-pdf-token'),
  resolvePDFBaseUrl: vi.fn(() => 'https://operator.example.test'),
}));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: vi.fn(async () => null) }));
const upstream = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', upstream);
  upstream.mockResolvedValue(new Response('{}', { status: 404 }));
});
afterEach(() => vi.unstubAllGlobals());
function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/verify-pdf-provider', {
    method: 'POST',
    body: JSON.stringify({ providerId: 'mineru-cloud', ...body }),
  });
}

test('custom PDF address without client key does not resolve or transmit the operator key', async () => {
  const response = await POST(request({ baseUrl: 'https://other.example.test' }));
  expect(response.status).toBe(400);
  expect(resolvePDFApiKey).not.toHaveBeenCalled();
  expect(upstream).not.toHaveBeenCalled();
});

test('custom PDF address only receives the explicitly provided client key', async () => {
  const response = await POST(
    request({ baseUrl: 'https://other.example.test', apiKey: 'synthetic-client-key' }),
  );
  expect(response.status).toBe(200);
  expect(resolvePDFApiKey).not.toHaveBeenCalled();
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0][0]).toBe(
    'https://other.example.test/extract-results/batch/test-connection',
  );
  expect(upstream.mock.calls[0][1]).toMatchObject({
    headers: { Authorization: 'Bearer synthetic-client-key' },
    redirect: 'manual',
  });
});

test('operator PDF endpoint retains server key fallback', async () => {
  const response = await POST(request({}));
  expect(response.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0][0]).toBe(
    'https://operator.example.test/extract-results/batch/test-connection',
  );
  expect(upstream.mock.calls[0][1].headers.Authorization).toBe(
    'Bearer synthetic-operator-pdf-token',
  );
});

test('PDF connectivity redirects are rejected without a second upstream call', async () => {
  upstream.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
  );
  const response = await POST(request({}));
  expect(response.status).toBe(403);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0][1].redirect).toBe('manual');
});
