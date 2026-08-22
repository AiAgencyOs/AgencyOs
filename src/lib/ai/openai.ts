import 'server-only';

import { serverEnv } from '@/lib/env';

import { REQUEST_TIMEOUT_MS } from './budget';
import {
  AI_AUDIO_MEDIA_TYPES,
  type AiTranscriber,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types';

/**
 * Speech to text — the second vendor AgencyOS talks to, and the first outside
 * Anthropic. **ADM-94.**
 *
 * ── why this is a decision and not an implementation detail ──────────────
 *
 * ADM-84 §5 refused to pick OpenAI for generation merely because
 * ARCHITECTURE.md §6.4 names it for embeddings — *"generation and embeddings
 * are different capabilities"* — and ADM-85 records what makes that a business
 * question rather than an engineering one: *"an account, a billing
 * relationship, and credentials whose custodian is one of ADM-60's five
 * deferred facts."* Every word of that applies here.
 *
 * So this file does not settle it. It is the first adapter, chosen on a
 * capability argument rather than on familiarity — Hindi/English code-switching
 * is what these voice notes actually contain, and it is the case general
 * speech APIs handle worst — and the port above is what makes the choice
 * cheap to reverse: a different vendor is this file again and one line in
 * `router.ts`. **The owner names the vendor; the code does not pretend to
 * have.**
 *
 * ── and it does nothing without a key ────────────────────────────────────
 *
 * The same contract `createClaudeProvider` keeps: no key, no transcriber, and
 * the caller is told exactly that. A deployment without OPENAI_API_KEY behaves
 * as it did before this file existed — a voice note is recorded, not heard,
 * and the transcript says `[voice note — not transcribed]`, which is true.
 */

const TRANSCRIBER_ID = 'openai';

const DEFAULT_BASE = 'https://api.openai.com/v1';

/**
 * The model, as a constant rather than as data — and that is a gap, stated.
 *
 * ARCHITECTURE.md §6 wants model ids in `ai.agents.default_model` so retargeting
 * is an UPDATE. There is no row for a transcription model: `ai.models` ships
 * empty by ADM-84 §6, and inventing one here would put a context window and a
 * price nobody has established into a table that reads as authoritative. A
 * named constant is the honest version of "not configurable yet".
 */
export const TRANSCRIPTION_MODEL = 'whisper-1';

function apiKey(): string | undefined {
  const key = serverEnv().OPENAI_API_KEY?.trim();
  return key ? key : undefined;
}

/** Returns the transcriber, or null when no API key is configured. */
export function createOpenAiTranscriber(): AiTranscriber | null {
  const key = apiKey();
  if (!key) return null;

  return {
    id: TRANSCRIBER_ID,

    async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
      if (!(AI_AUDIO_MEDIA_TYPES as readonly string[]).includes(request.audio.mediaType)) {
        return {
          ok: false,
          permanent: true,
          message: `${request.audio.mediaType} is not audio this port carries.`,
        };
      }

      const base = serverEnv().OPENAI_BASE_URL ?? DEFAULT_BASE;

      const form = new FormData();
      form.set('model', request.model);
      form.set(
        'file',
        // A Blob rather than a path: the bytes are already in memory and never
        // touch a disk. Nothing in this system keeps a copy of a client's
        // recording — the same rule the image path follows.
        new Blob([new Uint8Array(request.audio.bytes)], { type: request.audio.mediaType }),
        request.audio.fileName,
      );
      // `verbose_json` is what carries the detected language back. The plain
      // `json` response is the text alone, and a transcript whose language
      // nobody recorded makes the reply guess at a register.
      //
      // No `language` parameter, deliberately — see TranscriptionRequest.
      // Naming the language makes Hinglish worse, and Hinglish is what these
      // recordings are.
      form.set('response_format', 'verbose_json');

      let response: Response;
      try {
        response = await fetch(`${base}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          cache: 'no-store',
          // The same ceiling the generation path uses (src/lib/ai/budget.ts):
          // the runner has a life, and a transcription that outlives it is
          // decided by the platform rather than recorded by us.
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
        return {
          ok: false,
          permanent: false,
          message: timedOut
            ? `The recording was not transcribed within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. The job will be retried.`
            : 'Could not reach the transcription service.',
        };
      }

      const text = await response.text();

      if (!response.ok) {
        // Logged in full, reported in summary — and never with the key in it.
        console.error(
          JSON.stringify({
            level: 'error',
            scope: 'openai.transcribe',
            status: response.status,
            detail: redactSecrets(text.slice(0, 500)),
          }),
        );
        // A 4xx that is not 429 is the service saying no to THIS request — a
        // rejected key, an unknown model, a file it will not take — and a
        // retry sends the same request to the same no.
        return {
          ok: false,
          permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
          message: `The transcription service refused the recording (${response.status}).`,
        };
      }

      let parsed: { text?: unknown; language?: unknown; duration?: unknown };
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        return {
          ok: false,
          permanent: false,
          message: 'The transcription service returned output that was not valid JSON.',
        };
      }

      const said = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      if (said === '') {
        // Silence, or speech nothing could make out. Not an empty transcript:
        // writing one would say the client said nothing, and they did speak.
        // Permanent: the recording is what it is, and re-uploading the same
        // silence produces the same silence.
        return { ok: false, permanent: true, message: 'Nothing could be made out in the recording.' };
      }

      return {
        ok: true,
        text: said,
        // Whisper answers in English words — "hindi", "english" — rather than
        // in tags. Mapped to the two-letter form the language column takes, and
        // null rather than guessed when it is a language nothing here maps.
        language: toTag(parsed.language),
        usage: {
          inputTokens: 0,
          // Priced per minute rather than per token, so both counts are 0
          // rather than invented — the same rule claude.ts applies to cost:
          // a fabricated number in a column that exists to make spend
          // auditable is worse than an honest zero.
          outputTokens: 0,
          costMinor: 0,
        },
      };
    },
  };
}

/**
 * Whisper's language names, as the tags `crm.conversation_messages.language`
 * takes.
 *
 * Deliberately small: these are the languages this agency's clients actually
 * write and speak in. Anything else returns null — a tag nothing recognises
 * would fail the column's own CHECK and lose the whole transcript over a
 * label.
 */
const LANGUAGE_TAGS: Record<string, string> = {
  english: 'en',
  hindi: 'hi',
  urdu: 'ur',
  punjabi: 'pa',
  gujarati: 'gu',
  marathi: 'mr',
  bengali: 'bn',
  tamil: 'ta',
  telugu: 'te',
  kannada: 'kn',
  malayalam: 'ml',
};

export function toTag(language: unknown): string | null {
  if (typeof language !== 'string') return null;
  const name = language.trim().toLowerCase();
  if (LANGUAGE_TAGS[name]) return LANGUAGE_TAGS[name];
  // Some responses already give a tag. Accept the shape the column accepts.
  return /^[a-z]{2,3}$/.test(name) ? name : null;
}

const REDACTED = '[redacted]';

function redactSecrets(text: string): string {
  const key = apiKey();
  const withoutConfigured = key ? text.split(key).join(REDACTED) : text;
  return withoutConfigured.replace(/sk-[A-Za-z0-9_-]{10,}/g, REDACTED);
}
