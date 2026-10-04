import 'server-only';

import Anthropic from '@anthropic-ai/sdk';

import { err, ok, type Result } from '@/lib/result';
import { serverEnv } from '@/lib/env';

import { MAX_RETRIES, REQUEST_TIMEOUT_MS } from './budget';
import type {
  AiContentBlock,
  AiMessage,
  AiProvider,
  StructuredRequest,
  StructuredResponse,
  ToolCallResponse,
  ToolUseRequest,
} from './types';
import { getProviderCredential } from './vault';
import { providerUnavailable, type FailureKind } from './failure';
import { parseModelJson } from './model-json';
import { fromWireToolName, toWireToolName } from './tool-names';

/**
 * Anthropic provider — implements the AiProvider port (ARCHITECTURE.md §6.4,
 * which names Anthropic for generation and OpenAI for embeddings only).
 *
 * Nothing above this file knows Anthropic exists. The model id arrives from
 * ai.agents.default_model as data, so retargeting an agent is an UPDATE rather
 * than a deploy, and adding a second provider is another file plus one entry
 * in router.ts.
 */

const PROVIDER_ID = 'anthropic';

/** Anthropic serves the claude-* family. The specific id comes from the registry. */
const MODEL_PREFIX = 'claude-';

/**
 * Default output ceiling.
 *
 * Deliberately under the ~16k mark where non-streaming requests start risking
 * SDK HTTP timeouts, so a plain create() is safe. Note this caps thinking *and*
 * response text together: current Claude models run adaptive thinking by
 * default, and the budget is shared.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

async function apiKey(): Promise<string | undefined> {
  // Through serverEnv() rather than process.env directly: it applies the min(8)
  // length check (an obviously-truncated key registers a provider that dies
  // mid-run otherwise) and it is the one place secrets are read. Env first,
  // the vault second (ADM-84 §9 overturned 2026-09-20) — a value the owner
  // placed directly in Vercel is never shadowed by a stale admin-entered one.
  const key = serverEnv().ANTHROPIC_API_KEY?.trim();
  if (key) return key;
  return (await getProviderCredential('anthropic')) ?? undefined;
}

/**
 * Returns the provider, or null when no API key is configured.
 *
 * Returning null rather than a provider that fails on first use is what keeps
 * the existing error contract intact: with no key, router.ts still reports
 * AI_PROVIDER_NOT_CONFIGURED exactly as it did before this file existed.
 */
export type ClaudeProviderOptions = {
  /** A registered provider's own identity (an Anthropic-compatible gateway). Defaults to the built-in 'anthropic'. */
  id?: string;
  /** A specific key (the provider manager hands one per key). Absent: the legacy env-then-vault lookup. */
  apiKey?: string;
  /** How the key is presented. The real API takes `x-api-key`; a gateway that mirrors Claude Code's ANTHROPIC_AUTH_TOKEN takes `Authorization: Bearer`. */
  authScheme?: 'x-api-key' | 'bearer';
  /**
   * A gateway in front of Claude may ignore `output_config` (the schema is then only a hint nobody enforces): with this on, the schema
   * is ALSO written into the system prompt and the model is told to answer with that object alone. The real API does not need it.
   */
  schemaInPrompt?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  supports?: (model: string) => boolean;
};

export async function createClaudeProvider(options: ClaudeProviderOptions = {}): Promise<AiProvider | null> {
  const key = options.apiKey ?? (await apiKey());
  if (!key) return null;

  /**
   * Bounded on purpose (src/lib/ai/budget.ts).
   *
   * The SDK's defaults are ten minutes per attempt with two retries, which is
   * longer than the function is allowed to live — so without these two options
   * the platform decided how a slow extraction ended, and it does so by killing
   * the invocation before it can write down what happened.
   *
   * Setting `timeout` here also takes the decision away from the SDK's own
   * heuristic: `messages.create` only computes a timeout from `max_tokens` when
   * the client has none, so an explicit value is the one that applies.
   */
  // ANTHROPIC_BASE_URL is now modelled (env-schema.ts) and FORBIDDEN in
  // production by the boot check (assertProductionConfig) — that forbiddance,
  // not this line, is what stops an injected host from redirecting a real
  // call. The SDK reads ANTHROPIC_BASE_URL from the environment via a default
  // parameter, so passing `undefined` re-triggers the same ambient read;
  // there is no way to override that from here. So the value is passed through
  // the schema ONLY when a test set it, and omitted otherwise — the SDK's own
  // default (which in production is the real API, because the var is unset)
  // takes over, and the code does not pretend to guard what the boot check
  // guards.
  const baseURL = options.baseUrl ?? serverEnv().ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    ...(options.authScheme === 'bearer' ? { apiKey: null, authToken: key } : { apiKey: key }),
    ...(baseURL ? { baseURL } : {}),
    timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  const withSchema = (system: string, schema: Record<string, unknown> | undefined): string =>
    options.schemaInPrompt && schema
      ? `${system}\n\nYour final answer must be ONE JSON object that conforms to this JSON Schema, and nothing else - no prose before or after, no markdown fence:\n${JSON.stringify(schema)}`
      : system;

  return {
    id: options.id ?? PROVIDER_ID,

    supports(model: string): boolean {
      return options.supports ? options.supports(model) : model.startsWith(MODEL_PREFIX);
    },

    /**
     * Tool-calling — G-187, ADM-99.
     *
     * A structural mirror of `generateStructured` above rather than a
     * refactor merging the two: they diverge on the one thing that matters —
     * `output_config`'s forced JSON Schema versus `tools` — and a shared
     * helper trying to serve both would grow a branch for every difference
     * between them. Two similar functions that never drift silently beat one
     * function with a flag threading through it.
     *
     * Returns `tool_calls` on `stop_reason === 'tool_use'` and `final`
     * otherwise. The caller (`callModelWithTools` in `agent-run.ts`) owns the
     * loop — this method makes exactly one request and reports what came
     * back, the same division `generateStructured` keeps with its own caller.
     */
    async generateWithTools(request: ToolUseRequest): Promise<Result<ToolCallResponse>> {
      try {
        const response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          system: withSchema(request.system, request.jsonSchema),
          messages: request.messages.map((m) => ({ role: m.role, content: toContent(m.content) })),
          tools: request.tools.map((t) => ({
            name: toWireToolName(t.name),
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
          ...(request.effort || request.jsonSchema
            ? {
                output_config: {
                  ...(request.effort ? { effort: request.effort } : {}),
                  ...(request.jsonSchema ? { format: { type: 'json_schema' as const, schema: request.jsonSchema } } : {}),
                },
              }
            : {}),
        });

        if (response.stop_reason === 'refusal') {
          return err('PROVIDER_ERROR', 'The model declined to process this conversation.');
        }
        if (response.stop_reason === 'max_tokens') {
          return err('PROVIDER_ERROR', 'The model ran out of output budget before completing the call.');
        }

        const usage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          // Same reasoning as generateStructured: a fabricated cost is worse
          // than an honest zero in a column that exists to be auditable.
          costMinor: 0,
        };

        if (response.stop_reason === 'tool_use') {
          const calls = response.content
            .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
            .map((block) => ({ id: block.id, name: fromWireToolName(block.name), input: block.input }));

          // A `tool_use` stop reason with no actual tool_use block would be a
          // provider contradicting its own field. Reported as a provider
          // error rather than silently treated as `final`, which would feed
          // the caller's json-parse path text that was never meant to be the
          // answer.
          if (calls.length === 0) {
            return err('PROVIDER_ERROR', 'The model signalled a tool call but sent none.');
          }

          return ok({ kind: 'tool_calls', calls, usage, model: response.model });
        }

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        if (!text.trim()) {
          return err('PROVIDER_ERROR', 'The model returned no output.');
        }

        return ok({ kind: 'final', text, usage, model: response.model });
      } catch (error) {
        return providerFailure(error);
      }
    },

    async generateStructured(request: StructuredRequest): Promise<Result<StructuredResponse>> {
      try {
        // A gateway that does not enforce the schema sometimes answers with prose, or with nothing: ONE repair attempt re-asks, showing
        // the model what it said and what is wanted. The real API enforces the schema and is never asked twice.
        const mayRepair = options.schemaInPrompt === true;
        let extra: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        let inputTokens = 0;
        let outputTokens = 0;

        for (let attempt = 0; ; attempt += 1) {
          const response = await client.messages.create({
            model: request.model,
            max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            system: withSchema(request.system, request.jsonSchema),
            messages: [...request.messages.map((m) => ({ role: m.role, content: toContent(m.content) })), ...extra],
            output_config: {
              ...(request.effort ? { effort: request.effort } : {}),
              format: { type: 'json_schema', schema: request.jsonSchema },
            },
            // Sampling parameters are deliberately absent: current Claude models
            // reject temperature/top_p/top_k outright. Behaviour is steered by
            // the prompt and by effort instead.
          });
          inputTokens += response.usage.input_tokens;
          outputTokens += response.usage.output_tokens;

          // A safety classifier can decline the request. This arrives as a
          // successful HTTP 200 with an empty or partial content array, so it
          // has to be checked before reading content at all.
          if (response.stop_reason === 'refusal') {
            return err('PROVIDER_ERROR', 'The model declined to process this conversation.');
          }

          if (response.stop_reason === 'max_tokens') {
            return err('PROVIDER_ERROR', 'The model ran out of output budget before completing the extraction.');
          }

          const text = structuredText(response.content);

          // Constrained decoding should make prose unreachable, but a provider asserting conformance is not proof of it (and a gateway
          // may ignore the schema altogether): a fenced or lightly wrapped object is read, anything else is refused.
          const parsed = text.trim() ? parseModelJson(text) : null;
          if (parsed?.ok) {
            return ok({
              json: parsed.json,
              model: response.model,
              usage: {
                inputTokens,
                outputTokens,
                // Reported as 0 rather than estimated. Converting Anthropic's
                // per-token USD rates into the minor units of an organization's
                // currency needs both a per-model price table and an FX rate;
                // inventing either here would put a fabricated number into
                // ai.agent_runs.cost_minor, which exists to make spend auditable.
                costMinor: 0,
              },
            });
          }

          if (mayRepair && attempt === 0) {
            extra = text.trim()
              ? [
                  { role: 'assistant', content: text.slice(0, 20_000) },
                  { role: 'user', content: 'That was not a single valid JSON object. Reply again with ONLY the JSON object that conforms to the schema - no prose, no markdown fence.' },
                ]
              : [{ role: 'user', content: 'You returned nothing. Reply with ONLY the JSON object that conforms to the schema.' }];
            continue;
          }

          if (!text.trim()) return err('PROVIDER_ERROR', 'The model returned no output.');
          // How it ended says whether it was cut off, wrapped in prose or something else - the first thing anyone asks.
          const tail = text.trim().slice(-60).replace(/\s+/g, ' ');
          return err('PROVIDER_ERROR', `The model returned output that was not valid JSON (${text.length} characters, ending "${tail}").`);
        }
      } catch (error) {
        return providerFailure(error);
      }
    },
  };
}

/**
 * The answer's text. Normally the text blocks. A gateway that carries structured output as a tool call (found live: a Bedrock-style
 * gateway answered with ONLY a tool_use block whose input held the JSON as a string) has no text block at all, so the one tool call's
 * input is read instead: its string field if that is where the JSON is, else the input object itself. Nothing is invented - an
 * answer with neither still reads as "no output".
 */
function structuredText(content: readonly Anthropic.ContentBlock[]): string {
  const text = content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (text.trim()) return text;
  const call = content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  if (!call || typeof call.input !== 'object' || call.input === null) return '';
  const input = call.input as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0] as string] === 'string') return input[keys[0] as string] as string;
  return keys.length > 0 ? JSON.stringify(input) : '';
}

/**
 * The port's content, in Anthropic's shape.
 *
 * A plain string passes straight through — the SDK accepts one, and wrapping
 * every existing caller's text in a single block would change the wire format
 * of calls that were working.
 *
 * An image block becomes Anthropic's `base64` source. The bytes are handed
 * over and never held: nothing in this file, and nothing in `agent-run.ts`,
 * writes them anywhere. `recordModelCall` deliberately records
 * `message_count` rather than the messages, so a client's photograph does not
 * end up in `ai.agent_steps` — which is read on an admin screen.
 */
function toContent(content: AiMessage['content']): Anthropic.MessageParam['content'] {
  if (typeof content === 'string') return content;
  return content.map((block: AiContentBlock) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text } as const;
      case 'image':
        return {
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
        } as const;
      // Echoed back exactly as the SDK produced it (see generateWithTools
      // below), so this branch only has to name the shape, not construct one
      // from scratch.
      case 'tool_use':
        return { type: 'tool_use', id: block.id, name: toWireToolName(block.name), input: block.input } as const;
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError ?? false,
        } as const;
    }
  });
}

/**
 * Maps SDK errors to a message safe to surface. Typed exception classes rather
 * than string matching, most specific first.
 *
 * Exported so the mapping can be asserted directly — a timeout in particular,
 * which would otherwise take the full bounded timeout to provoke through a
 * real call.
 *
 * Nothing here reads or reflects the API key: the messages are constants, and
 * the SDK's own error text is never interpolated.
 */
/**
 * A caught SDK error as a `Result`, tagged `unavailable` when this key, model
 * or vendor cannot serve the call (so the router may try another) and left
 * untagged when the request itself was the problem (so it never does).
 */
function providerFailure(error: unknown): Result<never> {
  const message = describeProviderError(error);
  const unavailable =
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof Anthropic.APIConnectionError ||
    (error instanceof Anthropic.APIError && typeof error.status === 'number' && error.status >= 500);
  const kind: FailureKind | undefined =
    error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError
      ? 'auth'
      : error instanceof Anthropic.NotFoundError
        ? 'model_missing'
        : error instanceof Anthropic.RateLimitError
          ? 'rate_limit'
          : error instanceof Anthropic.APIConnectionTimeoutError
            ? 'timeout'
            : error instanceof Anthropic.APIConnectionError
              ? 'network'
              : error instanceof Anthropic.APIError && typeof error.status === 'number' && error.status >= 500
                ? 'server'
                : undefined;
  return unavailable ? providerUnavailable(message, kind) : err('PROVIDER_ERROR', message);
}

export function describeProviderError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'The configured Anthropic API key was rejected.';
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'The configured Anthropic API key may not use this model.';
  }
  if (error instanceof Anthropic.NotFoundError) {
    return 'The configured model does not exist. Check ai.agents.default_model.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Rate limited by Anthropic. The job will be retried.';
  }
  // Before APIConnectionError, which it extends. A timeout reported as "could
  // not reach" would send whoever reads core.jobs.last_error looking for a
  // network fault instead of a slow extraction.
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return `The model did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. The job will be retried.`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach Anthropic.';
  }
  if (error instanceof Anthropic.APIError) {
    const detail = providerDetail(error);
    const status = error.status ?? 'an error';
    return detail ? `Anthropic returned ${status}: ${detail}` : `Anthropic returned ${status}.`;
  }
  return 'Unexpected failure calling Anthropic.';
}

/**
 * Anthropic's own words for what it objected to.
 *
 * The cases above each identify themselves from the exception's *class*, so
 * they can say something true without reading the body. Everything else lands
 * on the generic branch — and that branch is mostly 400, the one class of
 * failure that is never transient: the request is malformed, so every retry
 * sends the same malformed request. `Anthropic returned 400.` is all
 * core.jobs.last_error said while a requirement extraction failed its way to
 * `dead` over five attempts, which is enough to know something broke and not
 * enough to know what. The response body names the field. Record it.
 *
 * Bounded because this is read from a table cell and a provider is free to
 * return a long string.
 *
 * Redacted because this is the one place a secret could re-enter the system
 * sideways. The body is not the request, so it does not *carry* the key — but
 * an API is free to quote the offending credential back at you, and the
 * destination here is core.jobs.last_error, which renders in the admin panel.
 * Echoing a provider's words is only safe if the echo is filtered.
 */
const DETAIL_LIMIT = 400;
const REDACTED = '[redacted]';

// `Anthropic.APIError` is a value, not a type — the same name the `instanceof`
// checks above use, reached as a type without a second import.
function providerDetail(error: InstanceType<typeof Anthropic.APIError>): string | null {
  // `error.error` is the parsed JSON body, typed only as `Object | undefined`,
  // so every step down to the message is checked rather than asserted.
  const body: unknown = error.error;
  if (typeof body !== 'object' || body === null) return null;

  const inner: unknown = (body as { error?: unknown }).error;
  if (typeof inner !== 'object' || inner === null) return null;

  const message: unknown = (inner as { message?: unknown }).message;
  if (typeof message !== 'string') return null;

  // Redact before truncating: a key straddling the cut would otherwise leave a
  // prefix of itself in the column, which is less of a leak but still one.
  const safe = redactSecrets(message.trim());
  return safe === '' ? null : safe.slice(0, DETAIL_LIMIT);
}

function redactSecrets(text: string): string {
  // The env-configured key first, read directly rather than through apiKey()
  // — that function is async since the vault fallback needs a DB read, and
  // this call site is synchronous (inside error handling, not provider
  // construction). It need not look like anything in particular. The pattern
  // below is the backstop for a key this process is not holding this way: a
  // vault-stored key, or a proxy's.
  const key = serverEnv().ANTHROPIC_API_KEY?.trim();
  const withoutConfigured = key ? text.split(key).join(REDACTED) : text;
  return withoutConfigured.replace(/sk-ant-[A-Za-z0-9_-]+/g, REDACTED);
}
