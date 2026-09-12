import 'server-only';

import { err, ok, type Result } from '@/lib/result';

import { createClaudeProvider } from './claude';
import { createOpenAiTranscriber } from './openai';
import { PROVIDER_ENV_KEYS, createGeminiProvider, createOpenAiProvider, createOpenRouterProvider, createXaiProvider } from './providers';
import type { AiProvider, AiTranscriber } from './types';

/**
 * Model id → provider resolution.
 *
 * Providers register themselves here and nowhere else; callers name a model,
 * never a vendor. ADM-85 (2026-09-12) chose SEVERAL providers on the agency's
 * own accounts — Anthropic, OpenAI, Google Gemini, xAI, OpenRouter — so the
 * property this file always claimed, that a caller names a model and the
 * router picks the vendor, is now exercised rather than asserted: five
 * adapters, and `resolveProvider` chooses between them by the model id.
 *
 * Registration is conditional on the provider being usable — every factory
 * returns null when its key is unset. A deployment without a key therefore
 * behaves exactly as it did before any provider existed: extraction fails
 * with AI_PROVIDER_NOT_CONFIGURED rather than with a runtime auth error
 * halfway through a run, and nothing is ever reported as succeeding that did
 * not call a model.
 */

/**
 * Built on first use rather than at import.
 *
 * `createClaudeProvider()` reads `serverEnv()`, so building the registry at
 * module scope made *importing* this file read the environment — and Next
 * imports it during `next build`'s page-data collection, by way of the Agents
 * page. The build therefore demanded `SUPABASE_SERVICE_ROLE_KEY`, the one
 * required entry in the server schema, and failed on any deployment that
 * (correctly) withholds secrets from the build. CI has always said that is a
 * defect rather than a secret to supply:
 *
 *   "The build must not need real credentials — if it ever does, that is a
 *    defect worth failing on rather than a secret."   (.github/workflows/verify.yml)
 *
 * Cached after the first call, so the registry is still resolved once per
 * process and a deployment cannot half-register a provider mid-run.
 */
let registry: readonly AiProvider[] | null = null;

function providers(): readonly AiProvider[] {
  // Order is routing precedence. OpenRouter last: its ids carry a slash, and
  // it would otherwise claim `openai/gpt-…` from the vendor with the direct account.
  registry ??= [createClaudeProvider(), createOpenAiProvider(), createGeminiProvider(), createXaiProvider(), createOpenRouterProvider()].filter(
    (provider): provider is AiProvider => provider !== null,
  );
  return registry;
}

/** The ids of every registered provider — never a key. For the Agents page. */
export function configuredProviders(): readonly string[] {
  return providers().map((p) => p.id);
}

export function resolveProvider(model: string): Result<AiProvider> {
  const registered = providers();
  const provider = registered.find((p) => p.supports(model));

  if (!provider) {
    return err(
      'PROVIDER_ERROR',
      registered.length === 0
        ? `No AI provider is configured, so model "${model}" cannot be served. Set one of ${PROVIDER_ENV_KEYS.join(', ')}, or register another provider in src/lib/ai/router.ts.`
        : `No configured AI provider serves model "${model}" (registered: ${registered.map((p) => p.id).join(', ')}).`,
    );
  }

  return ok(provider);
}

/** True when at least one provider is registered. Lets callers skip work. */
export function hasConfiguredProvider(): boolean {
  return providers().length > 0;
}

/**
 * Speech to text — a separate registry, because it is a separate capability
 * and a separate decision (ADM-94).
 *
 * Kept apart from `providers()` deliberately rather than as a second method on
 * `AiProvider`: ADM-84 §5 is explicit that a vendor named for one capability is
 * not thereby chosen for another, and folding transcription into the
 * generation port would make Anthropic — which cannot hear anything — look
 * like a candidate.
 *
 * Built on first use for the same reason the generation registry is: reading
 * the environment at import time made `next build` demand real credentials,
 * which CI calls a defect rather than a secret to supply.
 */
let transcribers: readonly AiTranscriber[] | null = null;

function allTranscribers(): readonly AiTranscriber[] {
  transcribers ??= [createOpenAiTranscriber()].filter(
    (t): t is AiTranscriber => t !== null,
  );
  return transcribers;
}

export function resolveTranscriber(): Result<AiTranscriber> {
  const registered = allTranscribers();
  const transcriber = registered[0];

  if (!transcriber) {
    return err(
      'PROVIDER_ERROR',
      'No transcription service is configured, so a recording cannot be turned into words. Set OPENAI_API_KEY, or register another transcriber in src/lib/ai/router.ts.',
    );
  }

  return ok(transcriber);
}

/** True when something can hear. Lets callers skip work rather than pretend. */
export function hasConfiguredTranscriber(): boolean {
  return allTranscribers().length > 0;
}
