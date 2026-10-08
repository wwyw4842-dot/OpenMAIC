/**
 * Verify Video Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating video.
 *
 * POST /api/verify-video-provider
 *
 * Headers:
 *   x-video-provider: VideoProviderId
 *   x-video-model: string (optional)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { testVideoConnectivity } from '@/lib/media/video-providers';
import { resolveVideoConfig, ServerMediaModelError } from '@/lib/server/resolve-media-config';
import type { VideoProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';

const log = createLogger('VerifyVideoProvider');

export async function POST(request: NextRequest) {
  try {
    const providerId = (request.headers.get('x-video-provider') || 'seedance') as VideoProviderId;
    const model = request.headers.get('x-video-model') || undefined;
    const clientApiKey = request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = request.headers.get('x-base-url') || undefined;

    if (clientBaseUrl && process.env.NODE_ENV === 'production') {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const config = resolveVideoConfig(providerId, {
      model: model,
      apiKey: clientApiKey,
      baseUrl: clientBaseUrl,
    });
    const { apiKey } = config;

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const result = await testVideoConnectivity(config);

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

    return apiSuccess({ message: result.message });
  } catch (err) {
    if (err instanceof ServerMediaModelError) {
      return apiError('INVALID_REQUEST', 403, err.message);
    }
    log.error(
      `Video provider verification failed [provider=${request.headers.get('x-video-provider') ?? 'seedance'}]:`,
      err,
    );
    return apiError('INTERNAL_ERROR', 500, `Connectivity test error: ${err}`);
  }
}
