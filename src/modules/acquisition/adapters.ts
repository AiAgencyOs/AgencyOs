import type { Provider, ProviderAdapter } from './providers';

/**
 * The provider adapters that actually exist. EMPTY, deliberately: no adapter has been written, and the registry says so
 * (NOT_IMPLEMENTED) instead of pretending. An adapter lands here with its own contract tests, and the connection screens
 * pick it up with no other change. Never register a stub that returns ok.
 */
export const ADAPTERS: Partial<Record<Provider, ProviderAdapter>> = {};

export const hasAdapter = (provider: string): boolean => Object.hasOwn(ADAPTERS, provider);
