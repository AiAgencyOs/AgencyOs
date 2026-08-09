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

const PROVIDERS: readonly AiProvider[] = [createClaudeProvider()].filter(
  (provider): provider is AiProvider => provider !== null,
);

export function resolveProvider(model: string): Result<AiProvider> {
  const provider = PROVIDERS.find((p) => p.supports(model));

  if (!provider) {
    return err(
      'PROVIDER_ERROR',
      PROVIDERS.length === 0
        ? `No AI provider is configured, so model "${model}" cannot be served. Set ANTHROPIC_API_KEY, or register another provider in src/lib/ai/router.ts.`
        : `No configured AI provider serves model "${model}".`,
    );
  }

  return ok(provider);
}

/** True when at least one provider is registered. Lets callers skip work. */
export function hasConfiguredProvider(): boolean {
  return PROVIDERS.length > 0;
}
