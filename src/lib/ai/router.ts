import 'server-only';

import { err, ok, type Result } from '@/lib/result';

import { createClaudeProvider } from './claude';
import type { AiProvider } from './types';

/**
 * Model id → provider resolution.
 *
 * Providers register themselves here and nowhere else; callers name a model,
 * never a vendor. ARCHITECTURE.md §6.4 designates Anthropic for generation and
 * OpenAI for embeddings only, so `claude.ts` is the one entry today and an
 * embeddings provider would be the next.
 *
 * Registration is conditional on the provider being usable — createClaudeProvider()
 * returns null when ANTHROPIC_API_KEY is unset. A deployment without the key
 * therefore behaves exactly as it did before any provider existed: extraction
 * fails with AI_PROVIDER_NOT_CONFIGURED rather than with a runtime auth error
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
  registry ??= [createClaudeProvider()].filter(
    (provider): provider is AiProvider => provider !== null,
  );
  return registry;
}

export function resolveProvider(model: string): Result<AiProvider> {
  const registered = providers();
  const provider = registered.find((p) => p.supports(model));

  if (!provider) {
    return err(
      'PROVIDER_ERROR',
      registered.length === 0
        ? `No AI provider is configured, so model "${model}" cannot be served. Set ANTHROPIC_API_KEY, or register another provider in src/lib/ai/router.ts.`
        : `No configured AI provider serves model "${model}".`,
    );
  }

  return ok(provider);
}

/** True when at least one provider is registered. Lets callers skip work. */
export function hasConfiguredProvider(): boolean {
  return providers().length > 0;
}
