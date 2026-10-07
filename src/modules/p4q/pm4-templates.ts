/**
 * P4-PM-005 / 021 / 027. The PM4 milestone messages and the VERSION of the wording each was built from, keyed by the externalRef prefix each announcer already writes
 * (`announceToInternalChannel`). `crm.pm_message_log` then says which wording every Task 2 message used, exactly as it already does for PM5+.
 *
 * Wiring: spread `PM4_TEMPLATES` into `PM_TEMPLATES` in `src/modules/crm/schema.ts` (`...PM4_TEMPLATES,`). Change a template's text and raise its version here.
 */
export const PM4_TEMPLATES: Readonly<Record<string, { milestone: string; version: number }>> = {
  'phase-four-started': { milestone: 'PM4-M01', version: 1 },
  'ui-version-admin-approved': { milestone: 'PM4-M02', version: 1 },
  'ui-version-change-requested': { milestone: 'PM4-M03', version: 1 },
  'ui-version-locked': { milestone: 'PM4-M04', version: 1 },
  'prototype-submitted': { milestone: 'PM4-M05', version: 1 },
  'prototype-change-requested': { milestone: 'PM4-M06', version: 1 },
  'task2-complete': { milestone: 'PM4-M07', version: 1 },
  'm2-payment-verified': { milestone: 'PM4-M08', version: 1 },
  'prototype-qa-blocked': { milestone: 'PM4-QA-BLOCKED', version: 1 },
};

/** Words that must never appear in a client-facing or team-facing PM message: provider and model details (PM spec section 6). */
export const PROVIDER_WORDS = /\b(openai|anthropic|claude|gpt|gemini|llama|mistral|openrouter|llm|language model|token budget|api key|temperature|prompt)\b/i;

/** Pure: the words in a rendered message that expose a provider or model, empty when it is clean. */
export function providerDetailsIn(message: string): string[] {
  const found = message.match(new RegExp(PROVIDER_WORDS.source, 'gi'));
  return found ? [...new Set(found.map((w) => w.toLowerCase()))] : [];
}
