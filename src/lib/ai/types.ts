import type { Result } from '@/lib/result';

/**
 * The provider port (ARCHITECTURE.md §6).
 *
 * Everything above this interface — agents, prompts, extraction — is written
 * against these types and never against a vendor SDK. Swapping or adding a
 * provider is implementing this interface and registering it in router.ts.
 *
 * The *model* is deliberately not an enum here. Model ids live in
 * `ai.agents.default_model` as data, so retargeting an agent from one model to
 * another is an UPDATE rather than a deploy (ARCHITECTURE.md §6.7 applies the
 * same reasoning to autonomy levels).
 */

export type AiRole = 'user' | 'assistant';

/**
 * The image formats this port carries.
 *
 * A closed list rather than any string, because the value goes straight to a
 * provider: an unrecognised media type is a request that fails at the vendor
 * with the vendor's wording, and the caller learns nothing it could act on.
 * These four are what WhatsApp delivers and what current models accept.
 */
export const AI_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export type AiImageMediaType = (typeof AI_IMAGE_MEDIA_TYPES)[number];

/**
 * One piece of a message.
 *
 * Introduced so a client's photograph can be read (brief 2026-08-22 §28) —
 * before this, `content` was a string and there was no shape in the port for
 * anything that is not text, so "analyse the image they sent" had nowhere to
 * put the image.
 *
 * Base64 and a media type rather than a URL or a vendor's file handle: those
 * are the two things every provider's image API is expressible in, and a URL
 * would make the model's success depend on a host reaching a link that, for
 * WhatsApp media, expires in minutes.
 */
export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: AiImageMediaType; dataBase64: string };

export type AiMessage = {
  role: AiRole;
  /**
   * A plain string, or blocks when the message carries more than text.
   *
   * The string form is kept rather than migrated away from: every caller but
   * one sends text, and rewriting them all as `[{type:'text'}]` would be a
   * large diff whose only effect is to make the common case louder.
   */
  content: string | readonly AiContentBlock[];
};

/** Mirrors ai.agents.default_effort. */
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type StructuredRequest = {
  /** Model id as stored in ai.agents.default_model, e.g. 'claude-sonnet-5'. */
  model: string;
  system: string;
  messages: readonly AiMessage[];
  /**
   * JSON Schema the provider must constrain output to. Passed as data so no
   * provider-specific schema helper leaks into callers; the caller re-validates
   * with Zod regardless, because a provider claiming conformance is not proof
   * of it (ARCHITECTURE.md §6.6).
   */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  effort?: AiEffort;
  maxOutputTokens?: number;
};

/**
 * Token and cost accounting for one call. `costMinor` is in minor units to
 * match ai.agent_runs.cost_minor and the money rule in ARCHITECTURE.md §4.1.
 * A provider that cannot report cost reports 0 rather than guessing.
 */
export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  costMinor: number;
};

export type StructuredResponse = {
  /** Parsed JSON, still unvalidated. The caller applies its Zod schema. */
  json: unknown;
  usage: AiUsage;
  /** Exact model that served the request; may differ from the one requested. */
  model: string;
};

/**
 * The audio formats this port carries.
 *
 * WhatsApp sends a voice note as `audio/ogg; codecs=opus`, and a forwarded
 * music file or a recording from another app as one of the others. Closed for
 * the same reason the image list is: the value goes to a vendor, and a type it
 * refuses should be refused here, where the caller learns something it can act
 * on.
 */
export const AI_AUDIO_MEDIA_TYPES = [
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/webm',
  'audio/flac',
] as const;
export type AiAudioMediaType = (typeof AI_AUDIO_MEDIA_TYPES)[number];

/**
 * One recording, to be turned into the words that are in it.
 *
 * Bytes rather than base64: a transcription API takes a file upload, and
 * base64 would inflate a sixteen-megabyte voice note by a third for nothing.
 * That is the opposite of the image path, which base64s because that is what
 * a message content block takes — the difference is the vendor's, and it stops
 * here.
 */
export type TranscriptionRequest = {
  /** Model id, e.g. 'whisper-1'. Named by the caller, never by this port. */
  model: string;
  audio: { bytes: Uint8Array; mediaType: AiAudioMediaType; fileName: string };
};

/**
 * There is deliberately no language hint.
 *
 * The obvious one — the contact's `preferred_language` — makes Hinglish worse
 * rather than better: told the speaker is Hindi, a transcriber renders the
 * English half in Devanagari, and told they are English it drops the Hindi.
 * Auto-detection handles the code-switching these recordings actually contain.
 * A parameter nothing passes is also a parameter nothing maintains, which is
 * what G-130 records.
 */

export type TranscriptionResponse = {
  /** The words that were said. Empty is a failure, not an answer. */
  text: string;
  /** What language the provider heard, as a short tag, or null if it did not say. */
  language: string | null;
  usage: AiUsage;
};

/**
 * Classified rather than returned as a plain `Result`, and for the reason
 * `SendResult` and `FetchMediaResult` are: the caller is a job with an attempt
 * budget, and "try again" and "this will never work" are different answers.
 *
 * It matters more here than it looks. A recording that holds its conversation
 * open for five spaced attempts is a client waiting minutes for a reply that
 * was never going to be better informed — and the commonest cause is a key
 * that is simply wrong, which no number of retries improves.
 *
 *   permanent  a 4xx that is not 429 (bad key, bad model, a file the service
 *              will not take), and a recording nothing could be made out in —
 *              re-uploading the same silence produces the same silence.
 *   transient  429, any 5xx, a transport failure or timeout, and an
 *              unreadable response.
 */
export type TranscriptionResult =
  | ({ ok: true } & TranscriptionResponse)
  | { ok: false; permanent: boolean; message: string };

/**
 * Speech to text — a THIRD capability, and deliberately its own interface.
 *
 * Not folded into `AiProvider`, because ADM-84 §5 is explicit that generation
 * and embeddings are different capabilities and that a vendor named for one is
 * not thereby chosen for another. Transcription is a third, and giving it its
 * own port keeps that distinction in the type system rather than in a comment:
 * the Anthropic provider does not implement this and cannot be asked to, and
 * whoever serves it is a separate registration and a separate decision
 * (ADM-94).
 */
export interface AiTranscriber {
  /** Stable identifier recorded on the run, e.g. 'openai'. */
  readonly id: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface AiProvider {
  /** Stable identifier recorded on the run, e.g. 'anthropic'. */
  readonly id: string;
  /** True when this provider can serve the given model id. */
  supports(model: string): boolean;
  generateStructured(request: StructuredRequest): Promise<Result<StructuredResponse>>;
}
