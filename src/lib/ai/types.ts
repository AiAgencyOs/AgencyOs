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

export interface AiProvider {
  /** Stable identifier recorded on the run, e.g. 'anthropic'. */
  readonly id: string;
  /** True when this provider can serve the given model id. */
  supports(model: string): boolean;
  generateStructured(request: StructuredRequest): Promise<Result<StructuredResponse>>;
}
