/**
 * Turning the database's cohort verdict into an app-layer answer — pure, so the
 * one line that matters can be tested without a database: the `no_consent`
 * verdict is NEVER an enrolment. `crm.add_lead_to_reactivation_pilot` refuses a
 * lead whose contact has no granted whatsapp consent; this maps that refusal to
 * a plain VALIDATION error a form can show, and there is no branch here that
 * turns it into success. Consent is the database's to grant, never this layer's
 * to assume.
 */

export type CohortErrorCode = 'VALIDATION' | 'FORBIDDEN' | 'NOT_FOUND' | 'INTERNAL';

export type CohortDecision =
  | { kind: 'enrolled' }
  | { kind: 'removed' }
  | { kind: 'error'; code: CohortErrorCode; message: string };

const FORBIDDEN = 'The database refused: only an owner or ops-admin may manage the cohort.';

/** Interpret `crm.add_lead_to_reactivation_pilot` → outcome. */
export function interpretAddOutcome(outcome: string | undefined): CohortDecision {
  switch (outcome) {
    case 'added':
    case 'already_in': // idempotent — already enrolled is a success
      return { kind: 'enrolled' };
    case 'no_consent':
      return {
        kind: 'error',
        code: 'VALIDATION',
        message:
          'This lead cannot be enrolled: its contact has no granted WhatsApp consent. Consent must be recorded first — it is never assumed.',
      };
    case 'forbidden':
      return { kind: 'error', code: 'FORBIDDEN', message: FORBIDDEN };
    case 'not_found':
      return { kind: 'error', code: 'NOT_FOUND', message: 'Lead not found.' };
    default:
      return { kind: 'error', code: 'INTERNAL', message: 'Could not enrol the lead.' };
  }
}

/** Interpret `crm.remove_lead_from_reactivation_pilot` → outcome. */
export function interpretRemoveOutcome(outcome: string | undefined): CohortDecision {
  switch (outcome) {
    case 'removed':
    case 'not_in': // idempotent — already out is a success
      return { kind: 'removed' };
    case 'forbidden':
      return { kind: 'error', code: 'FORBIDDEN', message: FORBIDDEN };
    case 'not_found':
      return { kind: 'error', code: 'NOT_FOUND', message: 'Lead not found.' };
    default:
      return { kind: 'error', code: 'INTERNAL', message: 'Could not remove the lead.' };
  }
}
