import 'server-only';

import { serverEnv } from '@/lib/env';

import { REQUEST_TIMEOUT_MS } from './budget';
import { keyFor } from './providers';
import type { AiImageGenerator, ImageGenerationRequest, ImageGenerationResult } from './types';

/**
 * Image generation — Designer §9, ADM-111 (2026-09-20, "use openrouter
 * models"). The fourth capability, its own adapter for the reason ADM-84 §5
 * gives every time: a vendor named for one capability is not thereby chosen
 * for another, and this one has exactly one vendor named.
 *
 * OpenRouter's image endpoint is a DEDICATED path, `/images`, not the
 * chat-completions wire `chat-completions.ts` speaks — a request here is
 * `{model, prompt}` and a response is `{data: [{b64_json, media_type}], usage}`,
 * neither of which `chat-completions.ts`'s `generateStructured` (which forces
 * `response_format: json_schema` and parses `choices[0].message.content` as
 * text) could serve. Reused from there: the API key resolution (env then
 * vault, `keyFor` from `providers.ts`), the request timeout, and the same
 * redaction discipline.
 *
 * No key, no generator — the same contract every provider in this file keeps.
 * `design.directions` (workflows.ts) treats a missing generator exactly as
 * Designer §9 calls for: the image is optional support, so its absence never
 * fails the run that proposes the directions.
 */

const GENERATOR_ID = 'openrouter';
const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

/**
 * The model, as a constant rather than as data — the same gap `TRANSCRIPTION_MODEL`
 * (openai.ts) states honestly rather than hides: `ai.models` ships empty by
 * ADM-84 §6, so there is no row to read a routing choice from. Named rather
 * than configurable yet.
 */
export const IMAGE_GENERATION_MODEL = 'google/gemini-2.5-flash-image';

const REDACTED = '[redacted]';

function redactSecrets(text: string, key: string | undefined): string {
  const withoutConfigured = key ? text.split(key).join(REDACTED) : text;
  return withoutConfigured.replace(/sk-or-[A-Za-z0-9_-]{10,}/g, REDACTED).replace(/sk-[A-Za-z0-9_-]{10,}/g, REDACTED);
}

const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export async function createOpenRouterImageGenerator(): Promise<AiImageGenerator | null> {
  const env = serverEnv();
  const key = await keyFor(env.OPENROUTER_API_KEY, 'openrouter');
  if (!key) return null;

  return {
    id: GENERATOR_ID,

    async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const base = env.OPENROUTER_BASE_URL ?? DEFAULT_BASE;

      let response: Response;
      try {
        response = await fetch(`${base}/images`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://agencyos.app',
            'X-Title': 'AgencyOS',
          },
          body: JSON.stringify({ model: request.model, prompt: request.prompt, n: 1 }),
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
        return {
          ok: false,
          permanent: false,
          message: timedOut
            ? `OpenRouter did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`
            : 'Could not reach OpenRouter.',
        };
      }

      const text = await response.text();

      if (!response.ok) {
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'openrouter.images',
            status: response.status,
            detail: redactSecrets(text.slice(0, 500), key),
          }),
        );
        return {
          ok: false,
          permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
          message: `OpenRouter refused the image request (${response.status}).`,
        };
      }

      let parsed: { data?: unknown; usage?: { cost?: unknown } };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        return { ok: false, permanent: false, message: 'OpenRouter returned output that was not valid JSON.' };
      }

      const first = Array.isArray(parsed.data) ? (parsed.data[0] as { b64_json?: unknown; media_type?: unknown } | undefined) : undefined;
      const b64 = typeof first?.b64_json === 'string' ? first.b64_json : '';
      const mediaType = typeof first?.media_type === 'string' ? first.media_type : '';

      if (b64 === '' || !(MEDIA_TYPES as readonly string[]).includes(mediaType)) {
        return { ok: false, permanent: false, message: 'OpenRouter answered without an image this port recognises.' };
      }

      return {
        ok: true,
        imageBase64: b64,
        mediaType: mediaType as (typeof MEDIA_TYPES)[number],
        model: request.model,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          // Real cost IS in the response (`usage.cost`, in dollars) — unlike
          // every other adapter's 0, this one is available. It is left 0
          // anyway, on the same rule `claude.ts` states: this system's cost
          // columns are INR minor units, converting a dollar figure to paise
          // is an exchange rate nobody has authorised, and a fabricated
          // number in a column that exists to make spend auditable is worse
          // than an honest zero.
          costMinor: 0,
        },
      };
    },
  };
}
