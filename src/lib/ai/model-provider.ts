/**
 * Which adapter serves a model id — the adapters' own `supports` rules,
 * restated without the registry, so a page can say "provider: anthropic"
 * beside a model without holding a key (SCR-063 "current provider",
 * SCR-065's provider filter).
 *
 * The rules are the ones in `claude.ts` and `providers.ts`, in the registry's
 * precedence order — OpenRouter last, because its ids carry a slash and would
 * otherwise claim `openai/gpt-…` from the vendor with the direct account.
 * `resolveProvider` remains the runtime's answer (it also knows which keys
 * exist); this is only the naming. Pure, no imports.
 */
export const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'xai', 'openrouter'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function providerOfModel(model: string | null | undefined): ProviderId | null {
  if (!model) return null;
  if (model.startsWith('claude-')) return 'anthropic';
  if (/^(gpt-|o[1-9]|chatgpt-)/.test(model)) return 'openai';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('grok-')) return 'xai';
  if (model.includes('/')) return 'openrouter';
  return null;
}
