/** Resolve the model that will be sent upstream before selecting operator credentials. */
import { ASR_PROVIDERS, TTS_PROVIDERS } from '@/lib/audio/constants';
import { normalizeVoxCPMBackend } from '@/lib/audio/voxcpm';
import type { ImageProviderId, VideoProviderId } from '@/lib/media/types';
import type { ASRProviderId, TTSProviderId } from '@/lib/audio/types';
import { resolveMediaProviderConfig } from '@/lib/server/provider-config';

export { ServerMediaModelError } from '@/lib/server/provider-config';

// Preserve the existing adapter defaults, including providers whose first UI model
// differs from their API default. Passing this model explicitly prevents the
// adapter from silently selecting a different model after the allowlist check.
const IMAGE_DEFAULTS: Record<ImageProviderId, string> = {
  seedream: 'doubao-seedream-5-0-260128',
  'openai-image': 'gpt-image-2',
  'qwen-image': 'qwen-image-max',
  'nano-banana': 'gemini-2.5-flash-image',
  'minimax-image': 'image-01',
  'grok-image': 'grok-imagine-image',
  lemonade: 'Qwen-Image-GGUF',
};
const VIDEO_DEFAULTS: Record<VideoProviderId, string> = {
  seedance: 'doubao-seedance-1-5-pro-251215',
  kling: 'kling-v2-6',
  veo: 'veo-3.0-generate-001',
  sora: '',
  'minimax-video': 'MiniMax-Hailuo-2.3',
  'grok-video': 'grok-imagine-video',
  happyhorse: 'happyhorse-1.0-t2v',
};

interface ClientConfig {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Only automatic classroom generation chooses the first configured model. */
  useConfiguredDefault?: boolean;
  /** Preserve the existing UI default used by automatic classroom generation. */
  defaultModel?: string;
  providerOptions?: Record<string, unknown>;
}

export function resolveImageConfig(providerId: ImageProviderId, params: ClientConfig = {}) {
  return {
    providerId,
    ...resolveMediaProviderConfig('image', providerId, {
      ...params,
      defaultModel: params.defaultModel ?? IMAGE_DEFAULTS[providerId] ?? '',
    }),
  };
}

export function resolveVideoConfig(providerId: VideoProviderId, params: ClientConfig = {}) {
  return {
    providerId,
    ...resolveMediaProviderConfig('video', providerId, {
      ...params,
      defaultModel: params.defaultModel ?? VIDEO_DEFAULTS[providerId] ?? '',
    }),
  };
}

export function resolveTTSConfig(providerId: TTSProviderId, params: ClientConfig = {}) {
  const resolved = resolveMediaProviderConfig('tts', providerId, {
    ...params,
    defaultModel:
      TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS]?.defaultModelId ?? 'gpt-4o-mini-tts',
    // Apply adapter normalization after automatic model selection too. Fixed-model
    // backends must check their actual service/resource rather than an ignored
    // client model field. VoxCPM's UI alias cannot authorize another wire model.
    normalizeModel: (model) => {
      if (providerId === 'azure-tts') return '';
      if (providerId === 'doubao-tts') return 'seed-tts-2.0';
      if (providerId === 'voxcpm-tts') {
        if (normalizeVoxCPMBackend(params.providerOptions?.backend) !== 'vllm-omni')
          return 'voxcpm2';
        const normalized = model.trim();
        return !normalized || normalized === 'VoxCPM2' ? 'voxcpm2' : normalized;
      }
      return model;
    },
  });
  return {
    providerId,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    modelId: resolved.model,
  };
}

export function resolveASRConfig(providerId: ASRProviderId, params: ClientConfig = {}) {
  const resolved = resolveMediaProviderConfig('asr', providerId, {
    ...params,
    defaultModel:
      ASR_PROVIDERS[providerId as keyof typeof ASR_PROVIDERS]?.defaultModelId ??
      'gpt-4o-mini-transcribe',
  });
  return {
    providerId,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    modelId: resolved.model,
  };
}
