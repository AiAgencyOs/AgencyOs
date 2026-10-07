import { parseMinorUnits } from './schema';

/**
 * Phase 9 Admin / Finance actions as DATA: ONE whitelist of database doors, so the server action is a thin dispatcher and the table is testable.
 *
 * Nothing here decides. Each door checks the role, the state, the separation of duties (waiver and close-exception approver is an Admin who did not ask;
 * a blocking exception is resolved by someone who did not open it; a proposal is accepted by someone who did not request the run) and the gates under
 * its own lock, and its answer is reported in plain words. The door name comes from the form, but it can only select an entry of this table; an unknown
 * name is refused, so a forged field cannot reach any other function.
 *
 * Deliberately ABSENT: verifying a payment (an owner / runner act in finance.verify_payment, unchanged), recording or approving a refund, editing an
 * invoice or an amount, sending a message. There is no entry for any of them.
 */

type Fd = FormData;
export const text = (fd: Fd, key: string): string => String(fd.get(key) ?? '').trim();
const optional = (fd: Fd, key: string): string | null => text(fd, key) || null;

export type Phase9Door = {
  rpc: string;
  /** null means the form's values were not valid (and nothing is sent). */
  args: (fd: Fd) => Record<string, unknown> | null;
  ok: readonly string[];
};

export const PHASE_NINE_DOORS: Readonly<Record<string, Phase9Door>> = {
  evaluate: { rpc: 'evaluate_project_close', args: (fd) => ({ p_project_id: text(fd, 'projectId') }), ok: ['evaluated'] },
  close_project: { rpc: 'close_project_finances', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_note: optional(fd, 'note') }), ok: ['closed', 'already_closed'] },
  request_close_exception: { rpc: 'request_close_exception', args: (fd) => ({ p_project_id: text(fd, 'projectId'), p_reason: text(fd, 'reason') }), ok: ['requested'] },
  decide_close_exception: {
    rpc: 'decide_close_exception',
    args: (fd) => ({ p_close_exception_id: text(fd, 'closeExceptionId'), p_decision: text(fd, 'decision'), p_note: text(fd, 'note') }),
    ok: ['approved', 'rejected'],
  },
  open_exception: {
    rpc: 'open_finance_exception',
    args: (fd) => ({ p_kind: text(fd, 'kind'), p_reason: text(fd, 'reason'), p_project_id: optional(fd, 'projectId'), p_invoice_id: optional(fd, 'invoiceId'), p_submission_id: optional(fd, 'submissionId'), p_evidence: {} }),
    ok: ['opened', 'already_open'],
  },
  resolve_exception: {
    rpc: 'resolve_finance_exception',
    args: (fd) => ({ p_exception_id: text(fd, 'exceptionId'), p_resolution: text(fd, 'resolution'), p_note: text(fd, 'note') }),
    ok: ['resolved', 'dismissed'],
  },
  request_waiver: {
    rpc: 'request_waiver',
    args: (fd) => {
      const minor = parseMinorUnits(text(fd, 'amount'));
      if (minor === null || minor <= 0) return null;
      return { p_invoice_id: text(fd, 'invoiceId'), p_amount_minor: minor, p_reason: text(fd, 'reason') };
    },
    ok: ['requested'],
  },
  decide_waiver: {
    rpc: 'decide_waiver',
    args: (fd) => ({ p_waiver_id: text(fd, 'waiverId'), p_decision: text(fd, 'decision'), p_note: text(fd, 'note') }),
    ok: ['approved', 'rejected'],
  },
  close_period: {
    rpc: 'close_period',
    args: (fd) => ({ p_period_start: text(fd, 'periodStart'), p_period_end: text(fd, 'periodEnd'), p_label: text(fd, 'label'), p_acknowledgement: optional(fd, 'acknowledgement') }),
    ok: ['closed'],
  },
  request_agent_run: {
    rpc: 'request_finance_agent_run',
    args: (fd) => ({ p_agent_key: text(fd, 'agentKey'), p_project_id: text(fd, 'projectId'), p_invoice_id: optional(fd, 'invoiceId') }),
    ok: ['requested'],
  },
  accept_proposal: { rpc: 'accept_finance_proposal', args: (fd) => ({ p_proposal_id: text(fd, 'proposalId'), p_note: optional(fd, 'note') }), ok: ['accepted'] },
  reject_proposal: { rpc: 'reject_finance_proposal', args: (fd) => ({ p_proposal_id: text(fd, 'proposalId'), p_note: text(fd, 'note') }), ok: ['rejected'] },
};

/** The words a person reads for a door outcome. A refusal is shown as the database gave it, in plain language. */
export const PHASE_NINE_WORDS: Readonly<Record<string, string>> = {
  evaluated: 'Evaluated and recorded. Read the blockers, not only the result.',
  closed: 'Closed. This is the financial close only: the project is not complete until Phase 7 says so.',
  already_closed: 'Already closed.',
  requested: 'Requested.',
  approved: 'Approved.',
  rejected: 'Rejected. A rejection is final.',
  opened: 'Exception opened.',
  already_open: 'That exception is already open.',
  resolved: 'Resolved.',
  dismissed: 'Dismissed with your reason.',
  accepted: 'Accepted. Nothing was sent and no money moved.',
  blocked: 'Cannot close: something blocks it. The blockers are listed.',
  balance_needs_an_approved_exception: 'A balance remains. It can close only against a close exception an Admin who did not ask for it has approved, and that still covers the balance.',
  not_authorized: 'You do not have permission to do this.',
  not_found: 'That record was not found.',
  self_approval: 'You requested this, so another Admin must decide it.',
  self_resolution: 'You opened this exception, so someone else must resolve it.',
  self_acceptance: 'You asked for this run, so someone else must decide on what it proposed.',
  admin_only: 'Only an Admin settles this.',
  already_decided: 'That has already been decided; a decision is final.',
  already_resolved: 'That exception is already resolved.',
  already_pending: 'One is already waiting.',
  already_proposed: 'Already proposed.',
  reason_required: 'Say why.',
  secret_in_text: 'That text looks like a secret value. Name the variable, never its value.',
  exceeds_outstanding: 'A waiver cannot be more than what is still owed.',
  non_positive: 'The amount must be more than zero.',
  not_collectible: 'That invoice is not collectible (draft, void or paid).',
  stale_amount: 'The balance changed since this was requested; ask again.',
  stale_draft: 'The balance this draft quotes has changed; ask for a new draft.',
  nothing_to_except: 'There is no balance to except.',
  other_blockers_stand: 'Other blockers stand besides the balance; an exception covers a balance and nothing else.',
  exceptions_not_acknowledged: 'Exceptions stand in this period. Write the acknowledgement that formally documents them.',
  overlaps_a_closed_period: 'That period overlaps one already closed.',
  period_not_ended: 'That period has not ended yet.',
  bad_period: 'The period must end after it starts.',
  bad_input: 'Something in the form is not valid.',
  bad_kind: 'That is not a kind of exception.',
  bad_agent: 'That is not a finance agent.',
  name_an_invoice: 'A reminder draft is about exactly one invoice: choose it.',
  name_a_subject: 'Name a project, an invoice or a submission.',
  subject_mismatch: 'Those records do not belong together.',
  refused_by_exception_door: 'The exception door refused to open it; nothing was decided.',
};

export function phaseNineWords(outcome: string): string {
  return PHASE_NINE_WORDS[outcome] ?? `Refused: ${outcome.replace(/_/g, ' ')}.`;
}

export function isPhaseNineDoor(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PHASE_NINE_DOORS, name);
}
