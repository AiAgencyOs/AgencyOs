import 'server-only';

import { serverEnv } from '@/lib/env';

import { createChatCompletionsProvider, reasoningEffort } from './chat-completions';
import type { AiProvider } from './types';

/**
 * The providers ADM-85 named, each a configuration of the one chat-completions
 * adapter, each on the agency's own account, each registering only when its
 * key is in the deployment environment. The owner places the keys; no value
 * is read anywhere but serverEnv(), and none is ever logged or shown.
 *
 * Model routing is by id shape, because that is what an agent row carries:
 *
 *   gpt-* / o1…o9 / chatgpt-*   → OpenAI
 *   gemini-*                    → Google Gemini (its OpenAI-compatible endpoint)
 *   grok-*                      → xAI
 *   vendor/model                → OpenRouter (its ids always carry a slash)
 *   claude-*                    → Anthropic (src/lib/ai/claude.ts, unchanged)
 *
 * OpenRouter is asked last: a slash is its whole namespace, so it would
 * otherwise claim `openai/gpt-…` from the vendor with the direct account.
 *
 * The base-URL overrides exist for the verification harness only and are
 * forbidden on an external host in production (productionConfigProblems),
 * exactly as ANTHROPIC_BASE_URL is.
 */

const trimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v ? v : undefined;
};

export function createOpenAiProvider(): AiProvider | null {
  const env = serverEnv();
  const apiKey = trimmed(env.OPENAI_API_KEY);
  if (!apiKey) return null;
  return createChatCompletionsProvider({
    id: 'openai',
    name: 'OpenAI',
    baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey,
    supports: (model) => /^(gpt-|o[1-9]|chatgpt-)/.test(model),
    maxTokensParam: 'max_completion_tokens',
    // Only the reasoning family understands the parameter; a chat model —
    // including gpt-5-chat-* — 400s on it.
    effort: (model, effort) => (/^(o[1-9]|gpt-5)/.test(model) && !/-chat/.test(model) ? { reasoning_effort: reasoningEffort(effort) } : {}),
    keyPatterns: [/sk-[A-Za-z0-9_-]{10,}/g],
  });
}

export function createGeminiProvider(): AiProvider | null {
  const env = serverEnv();
  const apiKey = trimmed(env.GEMINI_API_KEY);
  if (!apiKey) return null;
  return createChatCompletionsProvider({
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey,
    supports: (model) => model.startsWith('gemini-'),
    keyPatterns: [/AIza[A-Za-z0-9_-]{20,}/g],
  });
}

export function createXaiProvider(): AiProvider | null {
  const env = serverEnv();
  const apiKey = trimmed(env.XAI_API_KEY);
  if (!apiKey) return null;
  return createChatCompletionsProvider({
    id: 'xai',
    name: 'xAI',
    baseUrl: env.XAI_BASE_URL ?? 'https://api.x.ai/v1',
    apiKey,
    supports: (model) => model.startsWith('grok-'),
    keyPatterns: [/xai-[A-Za-z0-9_-]{10,}/g],
  });
}

export function createOpenRouterProvider(): AiProvider | null {
  const env = serverEnv();
  const apiKey = trimmed(env.OPENROUTER_API_KEY);
  if (!apiKey) return null;
  return createChatCompletionsProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    apiKey,
    supports: (model) => model.includes('/'),
    headers: { 'HTTP-Referer': 'https://agencyos.app', 'X-Title': 'AgencyOS' },
    keyPatterns: [/sk-or-[A-Za-z0-9_-]{10,}/g, /sk-[A-Za-z0-9_-]{10,}/g],
  });
}

/** The five, in routing order. Anthropic first as the incumbent; OpenRouter last for the reason above. */
export const PROVIDER_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

/**
 * The model each provider is PROBED with by the Agents page's Verify control
 * (G-236): one small structured call, answered or refused by name. A probe
 * model that no longer exists answers 404 as "the configured model does not
 * exist", which is an honest verification result, not a fake one. Review
 * found the first draft probing only claude-sonnet-5, so a deployment whose
 * only key was OpenAI's read "configured" and could never verify.
 */
export const PROBE_MODELS: Readonly<Record<string, string>> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash',
  xai: 'grok-4',
  openrouter: 'openai/gpt-5-mini',
};
