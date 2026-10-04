import 'server-only';

import { err, ok, type Result } from '@/lib/result';

import { createOpenAiTranscriber } from './openai';
import { createOpenRouterImageGenerator } from './openrouter-image';
import { configuredProviderIds, resetProviderRegistry as resetRegistry, resolveRegisteredProvider } from './provider-registry';
import type { AiImageGenerator, AiProvider, AiTranscriber } from './types';

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
 * The provider registry now lives in `provider-registry.ts`: it is built from DATA (ai.providers and ai.provider_keys, managed in the
 * AI Provider Manager) with the five built-ins' environment keys still tried first. Everything below keeps the contract this file always
 * had - callers name a model and the router picks the vendor - and adds the one thing a manual assignment needs: naming the provider too.
 *
 * Built lazily (never at import: reading the environment at import made `next build` demand real credentials) and cached briefly, so an
 * Admin's change reaches the running process without a redeploy.
 */

/** The ids of every enabled provider that has a usable key - never a key. For the Agents page. */
export async function configuredProviders(): Promise<readonly string[]> {
  return configuredProviderIds();
}

/**
 * Forgets the cached registry so the next call rebuilds it from the database and the environment as they are NOW.
 * Called after every provider, key or model change in this process; other processes pick the change up when their cache expires.
 */
export function resetProviderRegistry(): void {
  resetRegistry();
  imageGenerators = null;
}

/**
 * The provider that serves a model. With `providerId` (a MANUAL assignment) exactly that provider, or a clear error when it is
 * disabled or has no usable key - never a silent substitute.
 */
export async function resolveProvider(model: string, options: { providerId?: string } = {}): Promise<Result<AiProvider>> {
  return resolveRegisteredProvider(model, options);
}

/** True when at least one provider is registered. Lets callers skip work. */
export async function hasConfiguredProvider(): Promise<boolean> {
  return (await configuredProviderIds()).length > 0;
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

/**
 * Image generation — Designer §9, ADM-111. One vendor, same lazy/cached-promise
 * shape as `providers()`: a vault lookup is a database read.
 */
let imageGenerators: Promise<readonly AiImageGenerator[]> | null = null;

function allImageGenerators(): Promise<readonly AiImageGenerator[]> {
  imageGenerators ??= Promise.all([createOpenRouterImageGenerator()]).then(
    (built) => built.filter((g): g is AiImageGenerator => g !== null),
  );
  return imageGenerators;
}

export async function resolveImageGenerator(): Promise<Result<AiImageGenerator>> {
  const registered = await allImageGenerators();
  const generator = registered[0];

  if (!generator) {
    return err(
      'PROVIDER_ERROR',
      'No image generator is configured, so no reference image can be drawn. Set OPENROUTER_API_KEY, or store an OpenRouter key through Settings.',
    );
  }

  return ok(generator);
}

/** True when a reference image could be drawn. Lets callers skip work rather than pretend. */
export async function hasConfiguredImageGenerator(): Promise<boolean> {
  return (await allImageGenerators()).length > 0;
}
