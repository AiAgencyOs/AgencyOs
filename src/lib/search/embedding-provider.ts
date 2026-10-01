import 'server-only';

import { serverEnv } from '@/lib/env';
import { resolveSecret } from '@/lib/secrets/resolve';

/**
 * The embedding vendor for search by meaning — decision 14.
 *
 * The key comes from the resolver every other integration uses
 * (`src/lib/secrets/resolve.ts`: deployment environment first, the vault
 * second): OPENAI_API_KEY if it resolves, otherwise OPENROUTER_API_KEY. Neither
 * configured is not an error — it is `null`, and search by meaning is cleanly
 * off with a sentence saying why while keyword search carries on unchanged.
 *
 * The vector is 512 numbers (`dimensions`, which the text-embedding-3 family
 * accepts): a quarter of the default size, so a real[] column and a scan over
 * it stay small. A different size or model is a different content hash, so a
 * change re-embeds rather than mixing spaces.
 */

export const EMBEDDING_DIMENSIONS = 512;
export const EMBEDDING_BATCH = 50;

export type EmbedResult = { vectors: number[][]; tokens: number };
/** The function everything above this file depends on — a test passes a deterministic fake. */
export type EmbedFn = (texts: string[]) => Promise<EmbedResult>;

export type EmbeddingProvider = {
  /** 'openai' | 'openrouter' — the name the budgets and the ledger use. */
  id: string;
  model: string;
  dimensions: number;
  embed: EmbedFn;
};

const REQUEST_TIMEOUT_MS = 30_000;

function make(id: string, baseUrl: string, apiKey: string, model: string, headers: Record<string, string> = {}): EmbeddingProvider {
  return {
    id,
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...headers },
        body: JSON.stringify({ model, input: texts, dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // The vendor's body is not quoted: it is free to echo the credential back.
      if (!res.ok) throw new Error(`The embedding service answered ${res.status}.`);
      const body = (await res.json()) as { data?: { index?: number; embedding?: number[] }[]; usage?: { total_tokens?: number; prompt_tokens?: number } };
      const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding))) throw new Error('The embedding service returned an unexpected shape.');
      return { vectors: data.map((d) => d.embedding as number[]), tokens: Number(body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0) };
    },
  };
}

/** The configured embedding vendor, or null when no key resolves. */
export async function resolveEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  const env = serverEnv();
  const openai = await resolveSecret('OPENAI_API_KEY');
  if (openai) return make('openai', env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', openai, 'text-embedding-3-small');
  const openrouter = await resolveSecret('OPENROUTER_API_KEY');
  if (openrouter) {
    return make('openrouter', env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1', openrouter, 'openai/text-embedding-3-small', { 'HTTP-Referer': 'https://agencyos.app', 'X-Title': 'AgencyOS' });
  }
  return null;
}

/** Tokens → minor units at the price the owner entered for the model (per million tokens); 0 when none is set — never estimated. */
export function embeddingCostMinor(tokens: number, pricePerMtokMinor: number | null): number {
  if (!pricePerMtokMinor || pricePerMtokMinor <= 0 || tokens <= 0) return 0;
  return Math.ceil((tokens * pricePerMtokMinor) / 1_000_000);
}
