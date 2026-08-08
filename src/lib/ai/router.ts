import 'server-only';

import { err, ok, type Result } from '@/lib/result';

import type { AiProvider } from './types';

/**
 * Model id → provider resolution.
 *
 * ── Why this registry is empty ────────────────────────────────────────────
 * No AI provider is configured in this project yet: there is no vendor SDK in
 * package.json and no API key in the environment. ARCHITECTURE.md §6.4 names
 * Anthropic for generation and OpenAI for embeddings, and the seed points the
 * `requirement_collector` agent at `claude-sonnet-5` — but naming a model is
 * not the same as having a working client, and pretending otherwise would mean
 * shipping a code path that reports success without calling anything.
 *
 * So extraction fails loudly with AI_PROVIDER_NOT_CONFIGURED until a provider
 * is registered here. The rest of the pipeline — conversations, transcripts,
 * the job runner, the agent run record, versioned requirements — is complete
 * and exercised; only the model call is absent, and it is absent visibly.
 *
 * To enable one: implement AiProvider (src/lib/ai/types.ts) in e.g.
 * src/lib/ai/anthropic.ts, add it to PROVIDERS, and set its key in the
 * environment. Nothing above this file changes.
 */

const PROVIDERS: readonly AiProvider[] = [];

export function resolveProvider(model: string): Result<AiProvider> {
  const provider = PROVIDERS.find((p) => p.supports(model));

  if (!provider) {
    return err(
      'PROVIDER_ERROR',
      PROVIDERS.length === 0
        ? `No AI provider is configured, so model "${model}" cannot be served. Register one in src/lib/ai/router.ts.`
        : `No configured AI provider serves model "${model}".`,
    );
  }

  return ok(provider);
}

/** True when at least one provider is registered. Lets callers skip work. */
export function hasConfiguredProvider(): boolean {
  return PROVIDERS.length > 0;
}
