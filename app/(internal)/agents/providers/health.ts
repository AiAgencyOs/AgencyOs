import type { Tone } from '@/ui';

/** How a provider or key health state reads on screen. Health is a runtime condition the system reports, never a thing an Admin sets. */
export const HEALTH_LABEL: Record<string, string> = {
  unknown: 'Not checked',
  healthy: 'Healthy',
  degraded: 'Degraded',
  rate_limited: 'Rate limited',
  quota_exhausted: 'Quota exhausted',
  auth_error: 'Key rejected',
  unavailable: 'Unavailable',
};

export const HEALTH_TONE: Record<string, Tone> = {
  unknown: 'neutral',
  healthy: 'success',
  degraded: 'warning',
  rate_limited: 'warning',
  quota_exhausted: 'danger',
  auth_error: 'danger',
  unavailable: 'danger',
};

export const KIND_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai_compat: 'OpenAI-compatible',
  anthropic_compat: 'Anthropic-compatible',
};
