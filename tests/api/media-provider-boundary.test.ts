// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const fixtures = vi.hoisted(() => ({
  yaml: '',
  fetch: vi.fn(),
  transcribe: vi.fn(),
  write: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, mkdir: vi.fn(), writeFile: fixtures.write },
    default: {
      ...actual,
      existsSync: (file: string) =>
        file.endsWith('server-providers.yml') ? !!fixtures.yaml : actual.existsSync(file),
      readFileSync: (file: string, ...args: unknown[]) =>
        file.endsWith('server-providers.yml')
          ? fixtures.yaml
          : Reflect.apply(actual.readFileSync, actual, [file, ...args]),
    },
  };
});
vi.mock('@/lib/server/classroom-storage', () => ({ CLASSROOMS_DIR: '/synthetic-classrooms' }));
vi.mock('@/lib/audio/asr-providers', () => ({ transcribeAudio: fixtures.transcribe }));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: () => Promise.resolve(null) }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const routes = [
  { path: 'image', provider: 'openai-image', model: 'gpt-image-1', section: 'image' },
  { path: 'verify-image', provider: 'openai-image', model: 'gpt-image-1', section: 'image' },
  { path: 'video', provider: 'grok-video', model: 'grok-imagine-video', section: 'video' },
  { path: 'verify-video', provider: 'grok-video', model: 'grok-imagine-video', section: 'video' },
  { path: 'tts', provider: 'openai-tts', model: 'tts-1', section: 'tts' },
  { path: 'asr', provider: 'openai-whisper', model: 'whisper-1', section: 'asr' },
] as const;

type Route = {
  path: (typeof routes)[number]['path'];
  section: (typeof routes)[number]['section'];
  provider: string;
  model: string;
};
async function post(
  route: Route,
  {
    model = route.model as string | undefined,
    key,
    url,
  }: { model?: string; key?: string; url?: string } = {},
) {
  let handler: (req: NextRequest) => Promise<Response>;
  let body: string | FormData = JSON.stringify({ prompt: 'synthetic prompt' });
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (route.section === 'image' || route.section === 'video') {
    headers[`x-${route.section}-provider`] = route.provider;
    if (model) headers[`x-${route.section}-model`] = model;
    if (key) headers['x-api-key'] = key;
    if (url) headers['x-base-url'] = url;
    if (route.path === 'image') handler = (await import('@/app/api/generate/image/route')).POST;
    else if (route.path === 'video')
      handler = (await import('@/app/api/generate/video/route')).POST;
    else if (route.path === 'verify-image')
      handler = (await import('@/app/api/verify-image-provider/route')).POST;
    else handler = (await import('@/app/api/verify-video-provider/route')).POST;
  } else if (route.section === 'tts') {
    handler = (await import('@/app/api/generate/tts/route')).POST;
    body = JSON.stringify({
      text: 'synthetic speech',
      audioId: 'a1',
      ttsProviderId: route.provider,
      ttsVoice: 'alloy',
      ttsModelId: model,
      ttsApiKey: key,
      ttsBaseUrl: url,
    });
  } else {
    handler = (await import('@/app/api/transcription/route')).POST;
    const form = new FormData();
    form.set('audio', new Blob(['synthetic audio']), 'a.webm');
    form.set('providerId', route.provider);
    if (model) form.set('modelId', model);
    if (key) form.set('apiKey', key);
    if (url) form.set('baseUrl', url);
    body = form;
    headers = {};
  }
  return handler(
    new Request('http://localhost/api/test', { method: 'POST', headers, body }) as NextRequest,
  );
}

function setConfig(route: Route, models: string[] | undefined) {
  fixtures.yaml =
    `${route.section}:\n  ${route.provider}:\n    apiKey: synthetic-operator-key\n    baseUrl: https://operator.example.test/v1\n` +
    (models === undefined ? '' : `    models: ${JSON.stringify(models)}\n`);
}

function sentConfig(route: Route) {
  if (route.section === 'asr') return fixtures.transcribe.mock.calls[0]?.[0];
  const [url, init] = fixtures.fetch.mock.calls[0] ?? [];
  return {
    url,
    key: init?.headers?.Authorization,
    model: init?.body
      ? JSON.parse(init.body).model
      : decodeURIComponent(url?.split('/').at(-1) ?? ''),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixtures.yaml = '';
  // Tests must never inherit operator configuration or make real provider requests.
  for (const envName of Object.keys(process.env)) {
    if (/^(OPENAI|IMAGE_|VIDEO_|TTS_|ASR_)/.test(envName)) vi.stubEnv(envName, '');
  }
  fixtures.fetch.mockImplementation((url: string) => {
    if (url.includes('/audio/speech'))
      return Promise.resolve(new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } }));
    if (url.includes('/images/generations'))
      return Promise.resolve(Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] }));
    if (url.includes('/videos/generations'))
      return Promise.resolve(Response.json({ request_id: 'synthetic-task' }));
    if (url.includes('/videos/synthetic-task'))
      return Promise.resolve(
        Response.json({ status: 'done', video: { url: 'https://cdn.example.test/v.mp4' } }),
      );
    if (url === 'https://cdn.example.test/v.mp4') return Promise.resolve(new Response('video'));
    return Promise.resolve(Response.json({ id: 'synthetic-model' }));
  });
  fixtures.transcribe.mockResolvedValue({ text: 'synthetic transcript' });
  vi.stubGlobal('fetch', fixtures.fetch);
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: Parameters<typeof setTimeout>[0],
    delay: number,
    ...args: unknown[]
  ) => realTimeout(fn, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(routes)('$path operator model boundary', (route) => {
  test('denied and prefixed alias models make zero upstream calls', async () => {
    setConfig(route, [route.model]);
    for (const model of ['denied-model', `${route.provider}:${route.model}`]) {
      const res = await post(route, { model });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
    }
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.transcribe).not.toHaveBeenCalled();
  });

  test('other-provider entries and qualified request aliases cannot borrow server authorization', async () => {
    setConfig(route, [`other-provider:${route.model}`]);
    expect((await post(route)).status).toBe(403);
    vi.resetModules();
    setConfig(route, [`${route.provider}:${route.model}`]);
    expect((await post(route, { model: `${route.provider}:${route.model}` })).status).toBe(403);
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.transcribe).not.toHaveBeenCalled();
  });

  test('explicit empty list rejects both selected and omitted models', async () => {
    setConfig(route, []);
    expect((await post(route)).status).toBe(403);
    expect((await post(route, { model: '' })).status).toBe(403);
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.transcribe).not.toHaveBeenCalled();
  });

  test.each([[''], [`${route.provider}:`]])(
    'empty configured model entries cannot authorize an adapter fallback (%s)',
    async (configuredModel) => {
      setConfig(route, [configuredModel]);
      expect((await post(route)).status).toBe(403);
      expect(fixtures.fetch).not.toHaveBeenCalled();
      expect(fixtures.transcribe).not.toHaveBeenCalled();
    },
  );

  test('allowed qualified config entry forwards the raw model and operator key once', async () => {
    setConfig(route, [`${route.provider}:${route.model}`]);
    expect((await post(route)).status).toBe(200);
    if (route.section === 'asr') {
      expect(fixtures.transcribe).toHaveBeenCalledTimes(1);
      expect(sentConfig(route)).toMatchObject({
        modelId: route.model,
        apiKey: 'synthetic-operator-key',
      });
    } else {
      expect(fixtures.fetch).toHaveBeenCalledTimes(route.path === 'video' ? 2 : 1);
      expect(sentConfig(route)).toMatchObject({
        model: route.model,
        key: 'Bearer synthetic-operator-key',
      });
    }
  });

  test('BYOK model remains available without operator credentials', async () => {
    setConfig(route, []);
    expect(
      (await post(route, { model: 'custom-byok-model', key: 'synthetic-client-key' })).status,
    ).toBe(200);
    if (route.section === 'asr')
      expect(sentConfig(route)).toMatchObject({
        modelId: 'custom-byok-model',
        apiKey: 'synthetic-client-key',
      });
    else
      expect(sentConfig(route)).toMatchObject({
        model: 'custom-byok-model',
        key: 'Bearer synthetic-client-key',
      });
  });

  test('custom URL never inherits the operator key, and BYOK uses the client URL', async () => {
    setConfig(route, []);
    await post(route, { url: 'https://client.example.test/v1' });
    expect(
      JSON.stringify([...fixtures.fetch.mock.calls, ...fixtures.transcribe.mock.calls]),
    ).not.toContain('synthetic-operator-key');
    vi.clearAllMocks();
    expect(
      (await post(route, { url: 'https://client.example.test/v1', key: 'synthetic-client-key' }))
        .status,
    ).toBe(200);
    if (route.section === 'asr')
      expect(sentConfig(route)).toMatchObject({
        baseUrl: 'https://client.example.test/v1',
        apiKey: 'synthetic-client-key',
      });
    else expect(sentConfig(route)).toMatchObject({ key: 'Bearer synthetic-client-key' });
  });

  test('omitted allowlist preserves the existing unrestricted contract', async () => {
    setConfig(route, undefined);
    expect((await post(route, { model: 'custom-server-model' })).status).toBe(200);
  });
});

test.each([
  { path: 'verify-image', section: 'image', provider: 'minimax-image', model: 'image-01-live' },
  {
    path: 'verify-video',
    section: 'video',
    provider: 'minimax-video',
    model: 'MiniMax-Hailuo-2.3-Fast',
  },
] as const)('$path uses the checked MiniMax model in its actual request', async (route) => {
  setConfig(route as Route, [route.model]);
  expect((await post(route as Route)).status).toBe(200);
  expect(sentConfig(route as Route)).toMatchObject({
    model: route.model,
    key: 'Bearer synthetic-operator-key',
  });
});

const outlines = [
  {
    mediaGenerations: [
      { type: 'image', elementId: 'gen_img_fixture', prompt: 'synthetic image' },
      { type: 'video', elementId: 'gen_vid_fixture', prompt: 'synthetic video' },
    ],
  },
] as unknown as SceneOutline[];
function speechScenes() {
  return [
    { id: 's1', order: 1, actions: [{ id: 'speech1', type: 'speech', text: 'synthetic speech' }] },
  ] as unknown as Scene[];
}

describe('automatic classroom generation', () => {
  test('uses configured image/video/TTS models instead of unrestricted registry defaults', async () => {
    fixtures.yaml = `image:
  openai-image:
    apiKey: synthetic-operator-key
    models: ["openai-image:gpt-image-1"]
video:
  grok-video:
    apiKey: synthetic-operator-key
    models: ["grok-video:grok-imagine-video"]
tts:
  openai-tts:
    apiKey: synthetic-operator-key
    models: ["openai-tts:tts-1"]
`;
    const { generateMediaForClassroom, generateTTSForClassroom } =
      await import('@/lib/server/classroom-media-generation');
    const media = await generateMediaForClassroom(outlines, 'c1', 'https://classroom.example.test');
    const scenes = speechScenes();
    await generateTTSForClassroom(scenes, 'c1', 'https://classroom.example.test');
    expect(Object.keys(media)).toHaveLength(2);
    expect(scenes[0].actions?.[0]).toHaveProperty('audioUrl');
    const submits = fixtures.fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(submits.map(([, init]) => JSON.parse(init.body).model).sort()).toEqual([
      'gpt-image-1',
      'grok-imagine-video',
      'tts-1',
    ]);
    expect(fixtures.write).toHaveBeenCalledTimes(3);
  });

  test('explicit empty image/video/TTS lists forward nothing and write no output', async () => {
    fixtures.yaml = `image:
  openai-image:
    apiKey: synthetic-operator-key
    models: []
video:
  grok-video:
    apiKey: synthetic-operator-key
    models: []
tts:
  openai-tts:
    apiKey: synthetic-operator-key
    models: []
`;
    const { generateMediaForClassroom, generateTTSForClassroom } =
      await import('@/lib/server/classroom-media-generation');
    expect(
      await generateMediaForClassroom(outlines, 'c1', 'https://classroom.example.test'),
    ).toEqual({});
    const scenes = speechScenes();
    await generateTTSForClassroom(scenes, 'c1', 'https://classroom.example.test');
    expect(scenes[0].actions?.[0]).not.toHaveProperty('audioUrl');
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.write).not.toHaveBeenCalled();
  });

  test('automatic generation rejects a model qualified for another provider', async () => {
    fixtures.yaml = `image:
  openai-image:
    apiKey: synthetic-operator-key
    models: ["other-provider:gpt-image-1"]
`;
    const { generateMediaForClassroom } = await import('@/lib/server/classroom-media-generation');
    expect(
      await generateMediaForClassroom(outlines, 'c1', 'https://classroom.example.test'),
    ).toEqual({});
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.write).not.toHaveBeenCalled();
  });
});

test('OpenAI image fallback honors IMAGE_OPENAI_MODELS even when key comes from OPENAI_API_KEY', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-operator-key');
  vi.stubEnv('IMAGE_OPENAI_MODELS', '');
  expect((await post(routes[0])).status).toBe(403);
  expect(fixtures.fetch).not.toHaveBeenCalled();
});

test.each([
  { path: 'image', section: 'image', provider: 'openai-image', model: 'gpt-image-2' },
  { path: 'video', section: 'video', provider: 'grok-video', model: 'grok-imagine-video' },
  { path: 'tts', section: 'tts', provider: 'openai-tts', model: 'gpt-4o-mini-tts' },
  { path: 'asr', section: 'asr', provider: 'openai-whisper', model: 'gpt-4o-mini-transcribe' },
] as const)(
  '$path checks the actual adapter default when client model is omitted',
  async (route) => {
    setConfig(route, ['unrelated-model']);
    expect((await post(route, { model: '' })).status).toBe(403);
    expect(fixtures.fetch).not.toHaveBeenCalled();
    expect(fixtures.transcribe).not.toHaveBeenCalled();
    vi.resetModules();
    setConfig(route, [route.model]);
    expect((await post(route, { model: '' })).status).toBe(200);
    if (route.section === 'asr') expect(sentConfig(route)).toMatchObject({ modelId: route.model });
    else expect(sentConfig(route)).toMatchObject({ model: route.model });
  },
);

test('VoxCPM alias is checked against its canonical wire model before taking the server key', async () => {
  const route: Route = { path: 'tts', section: 'tts', provider: 'voxcpm-tts', model: 'VoxCPM2' };
  setConfig(route, ['VoxCPM2']);
  expect((await post(route)).status).toBe(403);
  expect(fixtures.fetch).not.toHaveBeenCalled();
  vi.resetModules();
  setConfig(route, ['voxcpm2']);
  expect((await post(route)).status).toBe(200);
  expect(sentConfig(route)).toMatchObject({
    model: 'voxcpm2',
    key: 'Bearer synthetic-operator-key',
  });
});

test('automatic VoxCPM model selection cannot bypass wire normalization', async () => {
  fixtures.yaml = `tts:
  voxcpm-tts:
    apiKey: synthetic-operator-key
    models: ["VoxCPM2"]
`;
  const { resolveTTSConfig } = await import('@/lib/server/resolve-media-config');
  expect(() => resolveTTSConfig('voxcpm-tts', { useConfiguredDefault: true })).toThrow(
    /not enabled/,
  );
  expect(fixtures.fetch).not.toHaveBeenCalled();
});

test('fixed-model audio adapters check the actual model/resource instead of ignored model fields', async () => {
  fixtures.yaml = `tts:
  doubao-tts:
    apiKey: synthetic-operator-key
    models: ["unrelated-model"]
  azure-tts:
    apiKey: synthetic-operator-key
    models: ["unrelated-model"]
  voxcpm-tts:
    baseUrl: https://operator.example.test
    models: ["unrelated-model"]
`;
  const { resolveTTSConfig } = await import('@/lib/server/resolve-media-config');
  for (const provider of ['doubao-tts', 'azure-tts', 'voxcpm-tts'] as const) {
    expect(() =>
      resolveTTSConfig(provider, {
        model: 'unrelated-model',
        providerOptions: { backend: 'python-api' },
      }),
    ).toThrow(/not enabled/);
  }
  expect(fixtures.fetch).not.toHaveBeenCalled();
});

test('BYOK keeps fixed-model audio available without operator allowlist authorization', async () => {
  fixtures.yaml = `tts:
  azure-tts:
    apiKey: synthetic-operator-key
    baseUrl: https://operator.example.test
    models: ["operator-only-model"]
`;
  const { resolveTTSConfig } = await import('@/lib/server/resolve-media-config');
  expect(
    resolveTTSConfig('azure-tts', {
      model: 'client-model-is-ignored-by-azure',
      apiKey: 'synthetic-client-key',
      baseUrl: 'https://client.example.test',
    }),
  ).toMatchObject({
    providerId: 'azure-tts',
    modelId: '',
    apiKey: 'synthetic-client-key',
    baseUrl: 'https://client.example.test',
  });
});
