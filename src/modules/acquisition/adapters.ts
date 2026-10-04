import type { Provider, ProviderAdapter } from './providers';

/**
 * The provider adapters that actually exist. EMPTY, deliberately: no adapter has been written, and the registry says so
 * (NOT_IMPLEMENTED) instead of pretending. An adapter lands here with its own contract tests, and the connection screens
 * pick it up with no other change. Never register a stub that returns ok.
 */
export const ADAPTERS: Partial<Record<Provider, ProviderAdapter>> = {};

export const hasAdapter = (provider: string): boolean => Object.hasOwn(ADAPTERS, provider);

import type { SocialPublisher } from './social';
import type { SocialPlatform } from './social-vocabulary';

/**
 * The social publishers that actually exist. EMPTY, deliberately, like ADAPTERS: a due post with no publisher is
 * ASSISTED_ACTION_REQUIRED - a person is told and posts it by hand - never silently skipped and never faked as published.
 */
export const SOCIAL_PUBLISHERS: Partial<Record<SocialPlatform, SocialPublisher>> = {};
