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
} from './types';

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

function apiKey(): string | undefined {
  // Through serverEnv() rather than process.env directly: it applies the min(8)
  // length check (an obviously-truncated key registers a provider that dies
  // mid-run otherwise) and it is the one place secrets are read.
  const key = serverEnv().ANTHROPIC_API_KEY?.trim();
  return key ? key : undefined;
}

/**
 * Returns the provider, or null when no API key is configured.
 *
 * Returning null rather than a provider that fails on first use is what keeps
 * the existing error contract intact: with no key, router.ts still reports
 * AI_PROVIDER_NOT_CONFIGURED exactly as it did before this file existed.
 */
export function createClaudeProvider(): AiProvider | null {
  const key = apiKey();
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
  const baseURL = serverEnv().ANTHROPIC_BASE_URL;
  const client = new Anthropic({
    apiKey: key,
    ...(baseURL ? { baseURL } : {}),
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  return {
    id: PROVIDER_ID,

    supports(model: string): boolean {
      return model.startsWith(MODEL_PREFIX);
    },

    async generateStructured(request: StructuredRequest): Promise<Result<StructuredResponse>> {
      try {
        const response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          system: request.system,
          messages: request.messages.map((m) => ({ role: m.role, content: toContent(m.content) })),
          output_config: {
            ...(request.effort ? { effort: request.effort } : {}),
            format: { type: 'json_schema', schema: request.jsonSchema },
          },
          // Sampling parameters are deliberately absent: current Claude models
          // reject temperature/top_p/top_k outright. Behaviour is steered by
          // the prompt and by effort instead.
        });

        // A safety classifier can decline the request. This arrives as a
        // successful HTTP 200 with an empty or partial content array, so it
        // has to be checked before reading content at all.
        if (response.stop_reason === 'refusal') {
          return err(
            'PROVIDER_ERROR',
            'The model declined to process this conversation.',
          );
        }

        if (response.stop_reason === 'max_tokens') {
          return err(
            'PROVIDER_ERROR',
            'The model ran out of output budget before completing the extraction.',
          );
        }

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        if (!text.trim()) {
          return err('PROVIDER_ERROR', 'The model returned no output.');
        }

        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          // Constrained decoding should make this unreachable, but a provider
          // asserting conformance is not proof of it.
          return err('PROVIDER_ERROR', 'The model returned output that was not valid JSON.');
        }

        return ok({
          json,
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            // Reported as 0 rather than estimated. Converting Anthropic's
            // per-token USD rates into the minor units of an organization's
            // currency needs both a per-model price table and an FX rate;
            // inventing either here would put a fabricated number into
            // ai.agent_runs.cost_minor, which exists to make spend auditable.
            costMinor: 0,
          },
        });
      } catch (error) {
        return err('PROVIDER_ERROR', describeProviderError(error));
      }
    },
  };
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
  return content.map((block: AiContentBlock) =>
    block.type === 'text'
      ? ({ type: 'text', text: block.text } as const)
      : ({
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.dataBase64 },
        } as const),
  );
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
  const key = apiKey();
  // The configured key first — it is the only value known to be secret here,
  // and it need not look like anything in particular. The pattern is the
  // backstop for a key this process is not the one holding (a proxy's, say).
  const withoutConfigured = key ? text.split(key).join(REDACTED) : text;
  return withoutConfigured.replace(/sk-ant-[A-Za-z0-9_-]+/g, REDACTED);
}
