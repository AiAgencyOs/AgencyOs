/**
 * Phase 9B Admin / Finance actions as DATA: ONE whitelist of database doors (the same pattern as phase-nine-doors.ts).
 *
 * Nothing here decides. Each door checks the role under its own lock (the schedule and the pause are Admin only; the account check is Finance or Admin)
 * and its refusal is shown as written. Deliberately ABSENT: verifying a payment, refunding, editing an invoice or an amount, sending a message.
 */

type Fd = FormData;
export const text = (fd: Fd, key: string): string => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string): string | null => text(fd, key) || null;

export type Phase9BDoor = {
  rpc: string;
  /** null means the form's values were not valid (and nothing is sent). */
  args: (fd: Fd) => Record<string, unknown> | null;
  ok: readonly string[];
};

export const PHASE_NINE_B_DOORS: Readonly<Record<string, Phase9BDoor>> = {
  set_reconciliation_schedule: {
    rpc: 'set_reconciliation_schedule',
    args: (fd) => {
      const count = Number(text(fd, 'cadenceCount'));
      if (!Number.isInteger(count) || count < 1) return null;
      return {
        p_account_id: optional(fd, 'accountId'),
        p_cadence_unit: text(fd, 'cadenceUnit'),
        p_cadence_count: count,
        p_anchor_date: text(fd, 'anchorDate'),
        p_source: text(fd, 'source'),
        p_enabled: text(fd, 'enabled') !== 'false',
      };
    },
    ok: ['set', 'updated'],
  },
  set_automation_paused: {
    rpc: 'set_finance_automation_paused',
    args: (fd) => {
      const paused = text(fd, 'paused');
      if (paused !== 'true' && paused !== 'false') return null;
      return { p_agent_key: text(fd, 'agentKey'), p_paused: paused === 'true', p_reason: text(fd, 'reason') };
    },
    ok: ['paused', 'resumed'],
  },
  check_payment_account: {
    rpc: 'check_payment_account',
    args: (fd) => ({ p_submission_id: text(fd, 'submissionId') }),
    ok: ['consistent', 'payer_differs', 'account_not_active', 'both', 'already_checked'],
  },
};

export const PHASE_NINE_B_WORDS: Readonly<Record<string, string>> = {
  set: 'Schedule set. The runner opens each period once it has ended; it never closes one.',
  updated: 'Schedule changed.',
  paused: 'Paused. Nothing new is queued or written by that finance agent until an Admin resumes it.',
  resumed: 'Resumed. Nothing runs by itself because of this.',
  unchanged: 'That was already the state.',
  consistent: 'Checked: the payer and receiving account agree with the books.',
  payer_differs: 'Checked: the payer does not match the client account; an exception was recorded. The payment was not changed.',
  account_not_active: 'Checked: the receiving account was not active; an exception was recorded. The payment was not changed.',
  both: 'Checked: payer and receiving account both differ; an exception was recorded. The payment was not changed.',
  already_checked: 'That claim was already checked.',
  bad_cadence: 'The cadence is not valid (unit, count and anchor date are all required).',
  bad_input: 'Something in the form is not valid.',
  bad_agent: 'That is not a finance agent.',
  reason_required: 'Say why.',
  not_authorized: 'You do not have permission to do this.',
  not_found: 'That record was not found.',
};

export function phaseNineBWords(outcome: string): string {
  return PHASE_NINE_B_WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;
}

export function isPhaseNineBDoor(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PHASE_NINE_B_DOORS, name);
}
