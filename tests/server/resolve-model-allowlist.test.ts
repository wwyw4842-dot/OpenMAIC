import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ allowed: vi.fn(), model: vi.fn(() => ({ model: {}, modelInfo: {} })), key: vi.fn(() => 'synthetic-server-key') }));
vi.mock('@/lib/server/provider-config', () => ({ assertServerModelAllowed: mocks.allowed, resolveApiKey: mocks.key, resolveBaseUrl: () => undefined, resolveProxy: () => undefined }));
vi.mock('@/lib/ai/providers', () => ({ getModel: mocks.model, parseModelString: (text: string) => { const i = text.indexOf(':'); return i < 0 ? { providerId: 'openai', modelId: text } : { providerId: text.slice(0, i), modelId: text.slice(i + 1) }; } }));
import { resolveModel } from '@/lib/server/resolve-model';
beforeEach(() => { vi.clearAllMocks(); mocks.allowed.mockReset(); });
test('disallowed server model never constructs an upstream client', async () => {
  mocks.allowed.mockImplementation(() => { throw new Error('Model is not enabled'); });
  await expect(resolveModel({ modelString: 'openai:denied' })).rejects.toThrow(/not enabled/);
  expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.key).not.toHaveBeenCalled();
});
test('allowed model resolves exactly once after checking the normalized provider and id', async () => {
  await resolveModel({ modelString: 'openai:allowed' });
  expect(mocks.allowed).toHaveBeenCalledWith('openai', 'allowed'); expect(mocks.model).toHaveBeenCalledTimes(1);
});
test('client credentials preserve BYOK without consuming server credentials', async () => {
  await resolveModel({ modelString: 'openai:custom', apiKey: 'synthetic-client-key' });
  expect(mocks.allowed).not.toHaveBeenCalled();
  expect(mocks.key).toHaveBeenCalledWith('openai', 'synthetic-client-key');
});
test('client URL without a key cannot inherit server credentials', async () => {
  const result = await resolveModel({ modelString: 'openai:custom', baseUrl: 'https://example.test/v1' });
  expect(result.apiKey).toBe(''); expect(mocks.key).not.toHaveBeenCalled(); expect(mocks.allowed).not.toHaveBeenCalled();
});
