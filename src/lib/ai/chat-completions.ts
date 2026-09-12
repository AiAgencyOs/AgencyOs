import 'server-only';

import { err, ok, type Result } from '@/lib/result';

import { MAX_RETRIES, REQUEST_TIMEOUT_MS, retryBackoffWorstCaseMs } from './budget';
import type { AiContentBlock, AiEffort, AiMessage, AiProvider, StructuredRequest, StructuredResponse } from './types';

/**
 * The OpenAI-style chat-completions adapter — one implementation of the
 * AiProvider port, configured four ways (src/lib/ai/providers.ts). **ADM-85.**
 *
 * ── why one adapter and not four ─────────────────────────────────────────
 *
 * The owner chose several providers on the agency's own accounts — OpenAI,
 * Google Gemini, xAI Grok, OpenRouter — and every one of them speaks the same
 * wire shape: `POST {base}/chat/completions` with `messages`, a
 * `response_format` of `json_schema`, and `choices[0].message.content` back.
 * Gemini and xAI publish an OpenAI-compatible endpoint for exactly this
 * reason, and OpenRouter is that shape by definition. Four copies of the same
 * HTTP call would be four places for the next fix to miss; what differs per
 * vendor — the host, the key, which model ids it serves, whether an effort
 * parameter is understood — is a configuration object, not code.
 *
 * ── what it holds to ─────────────────────────────────────────────────────
 *
 *   • Nothing above this file knows the vendor. The model id arrives from
 *     ai.agents.default_model as data; the router picks the adapter.
 *   • No key, no provider: a factory returns null and router.ts keeps saying
 *     AI_PROVIDER_NOT_CONFIGURED, exactly as claude.ts does.
 *   • The same wall clock as claude.ts (src/lib/ai/budget.ts): one bounded
 *     attempt, one in-function retry for what a tick of waiting would not
 *     improve (429, 5xx, a dropped socket), everything else to the queue.
 *   • JSON is parsed here and validated by the caller: a provider asserting
 *     conformance is not proof of it (ARCHITECTURE.md §6.6). `strict` is
 *     not requested because every vendor's strict mode rejects a schema
 *     with optional fields, and the callers' schemas have them.
 *   • Cost is 0, never estimated — the same rule claude.ts gives: a
 *     fabricated number in ai.agent_runs.cost_minor is worse than an honest
 *     zero.
 *   • The vendor's own error text is recorded, bounded and REDACTED: a body
 *     is free to quote the credential back, and it lands in a column the
 *     admin panel renders.
 */

export type ChatCompletionsConfig = {
  /** Stable identifier recorded on the run, e.g. 'openai'. */
  id: string;
  /** Human name for error text, e.g. 'OpenAI'. */
  name: string;
  /** `https://host/v1` — `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  /** Which model ids this configuration serves. */
  supports: (model: string) => boolean;
  /**
   * How the port's effort reaches the vendor, if it does. Vendors that reject
   * an unknown parameter get nothing: an effort that 400s every call is a
   * worse steer than none. Undefined = never sent.
   */
  effort?: (model: string, effort: AiEffort) => Record<string, unknown>;
  /** Extra headers the vendor asks for (OpenRouter attributes traffic by them). */
  headers?: Record<string, string>;
  /**
   * The output-ceiling parameter's name. OpenAI retired `max_tokens` for its
   * reasoning family and takes `max_completion_tokens` on every current
   * model; the compatible endpoints still take `max_tokens`. Review caught
   * the first draft sending the retired name to exactly the models the
   * effort hook targets.
   */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Patterns of this vendor's key shapes, redacted from any echoed error text. */
  keyPatterns: readonly RegExp[];
};

const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
const DETAIL_LIMIT = 400;
const REDACTED = '[redacted]';

type Choice = {
  finish_reason?: unknown;
  message?: { content?: unknown; refusal?: unknown };
};
type Completion = {
  model?: unknown;
  choices?: Choice[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  error?: { message?: unknown };
};

export function createChatCompletionsProvider(config: ChatCompletionsConfig): AiProvider {
  const redact = (text: string): string => {
    const withoutConfigured = text.split(config.apiKey).join(REDACTED);
    return config.keyPatterns.reduce((acc, pattern) => acc.replace(pattern, REDACTED), withoutConfigured);
  };

  const detailOf = (raw: string): string | null => {
    let message: unknown;
    try {
      const body = JSON.parse(raw) as Completion;
      message = body?.error?.message;
    } catch {
      message = raw;
    }
    if (typeof message !== 'string') return null;
    const safe = redact(message.trim());
    return safe === '' ? null : safe.slice(0, DETAIL_LIMIT);
  };

  const describeStatus = (status: number, raw: string): { message: string; retry: boolean } => {
    const detail = detailOf(raw);
    switch (status) {
      case 401:
        return { message: `The configured ${config.name} API key was rejected.`, retry: false };
      case 403:
        return { message: `The configured ${config.name} API key may not use this model.`, retry: false };
      case 404:
        return { message: 'The configured model does not exist. Check ai.agents.default_model.', retry: false };
      case 429:
        return { message: `Rate limited by ${config.name}. The job will be retried.`, retry: true };
      default:
        if (status >= 500) return { message: `${config.name} returned ${status}. The job will be retried.`, retry: true };
        return { message: detail ? `${config.name} returned ${status}: ${detail}` : `${config.name} returned ${status}.`, retry: false };
    }
  };

  return {
    id: config.id,
    supports: config.supports,

    async generateStructured(request: StructuredRequest): Promise<Result<StructuredResponse>> {
      const body = {
        model: request.model,
        [config.maxTokensParam ?? 'max_tokens']: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.map((m) => ({ role: m.role, content: toContent(m.content) })),
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schemaName, schema: request.jsonSchema },
        },
        ...(request.effort && config.effort ? config.effort(request.model, request.effort) : {}),
      };

      let last: Result<StructuredResponse> = err('PROVIDER_ERROR', `Unexpected failure calling ${config.name}.`);
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (attempt > 0) await sleep(retryBackoffWorstCaseMs(attempt) - retryBackoffWorstCaseMs(attempt - 1));
        const outcome = await once(body);
        if (outcome.kind === 'ok') return ok(outcome.response);
        last = err('PROVIDER_ERROR', outcome.message);
        if (!outcome.retry) return last;
      }
      return last;
    },
  };

  type Once = { kind: 'ok'; response: StructuredResponse } | { kind: 'fail'; message: string; retry: boolean };

  async function once(body: Record<string, unknown>): Promise<Once> {
    // The body read is inside the try as well: the timeout covers streaming,
    // and a connection dropped mid-body rejects text(), not fetch(). Review
    // found the first draft letting that escape as a throw — the one thing
    // this port promises never to do.
    let response: Response;
    let raw: string;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          ...(config.headers ?? {}),
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      raw = await response.text();
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      return {
        kind: 'fail',
        retry: true,
        message: timedOut
          ? `The model did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. The job will be retried.`
          : `Could not reach ${config.name}.`,
      };
    }

    if (!response.ok) {
      console.error(
        // Redact before truncating: a key straddling the cut would leave its prefix.
        JSON.stringify({ level: 'error', scope: `${config.id}.chat`, status: response.status, detail: redact(raw).slice(0, 500) }),
      );
      const { message, retry } = describeStatus(response.status, raw);
      return { kind: 'fail', message, retry };
    }

    let parsed: Completion;
    try {
      parsed = JSON.parse(raw) as Completion;
    } catch {
      return { kind: 'fail', retry: true, message: `${config.name} returned a response that was not valid JSON.` };
    }

    const choice = parsed.choices?.[0];
    if (!choice) return { kind: 'fail', retry: false, message: 'The model returned no output.' };

    // A refusal arrives as a 200 with `message.refusal` set and no content —
    // checked before content, exactly as claude.ts checks stop_reason.
    if (typeof choice.message?.refusal === 'string' && choice.message.refusal.trim() !== '') {
      return { kind: 'fail', retry: false, message: 'The model declined to process this conversation.' };
    }
    if (choice.finish_reason === 'length') {
      return { kind: 'fail', retry: false, message: 'The model ran out of output budget before completing the extraction.' };
    }
    if (choice.finish_reason === 'content_filter') {
      return { kind: 'fail', retry: false, message: 'The model declined to process this conversation.' };
    }

    const text = contentText(choice.message?.content);
    if (!text.trim()) return { kind: 'fail', retry: false, message: 'The model returned no output.' };

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'fail', retry: false, message: 'The model returned output that was not valid JSON.' };
    }

    return {
      kind: 'ok',
      response: {
        json,
        model: typeof parsed.model === 'string' && parsed.model ? parsed.model : body.model as string,
        usage: {
          inputTokens: count(parsed.usage?.prompt_tokens),
          outputTokens: count(parsed.usage?.completion_tokens),
          costMinor: 0,
        },
      },
    };
  }
}

/**
 * The answer's text. A string on every vendor today; a list of parts is the
 * shape the same wire uses for multimodal answers and some routed upstreams,
 * so its text parts are joined rather than read as silence.
 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
    .join('');
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * The port's content in the chat-completions shape. A string passes through;
 * an image block becomes an `image_url` data URL — the one form every
 * vendor on this wire accepts — and the bytes are handed over, never held.
 */
function toContent(content: AiMessage['content']): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map((block: AiContentBlock) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.dataBase64}` } },
  );
}

/** OpenAI's reasoning models take low | medium | high; the port's two upper rungs map to high. */
export function reasoningEffort(effort: AiEffort): 'low' | 'medium' | 'high' {
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}
