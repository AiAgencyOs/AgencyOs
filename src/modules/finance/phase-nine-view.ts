/**
 * Pure presentation helpers for the Phase 9 finance close screens. No money is computed here: every figure is the database's, and these only format it.
 */

export type CloseResult = 'clear' | 'outstanding_only' | 'blocked';

export function formatMinor(minor: number, currency = 'INR'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  // Indian digit grouping for rupees; plain thousands grouping for any other currency
  const grouped = currency === 'INR'
    ? (() => {
        const s = String(whole);
        if (s.length <= 3) return s;
        const last3 = s.slice(-3);
        const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
        return `${rest},${last3}`;
      })()
    : String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${currency} ${grouped}.${frac}`;
}

export function resultTone(result: string | null): 'success' | 'warning' | 'danger' | 'neutral' {
  if (result === 'clear') return 'success';
  if (result === 'outstanding_only') return 'warning';
  if (result === 'blocked') return 'danger';
  return 'neutral';
}

export function resultLabel(result: string | null): string {
  if (result === 'clear') return 'Clear to close';
  if (result === 'outstanding_only') return 'Only a balance stands';
  if (result === 'blocked') return 'Blocked';
  return 'Not evaluated';
}

export function closeModeLabel(mode: string | null): string {
  if (mode === 'zero_balance') return 'Closed at zero balance';
  if (mode === 'approved_exception') return 'Closed against an approved exception';
  return 'Not closed';
}

/** Words for the blocker codes the database emits; an unknown code is shown humanised, never hidden. */
export const BLOCKER_TITLES: Readonly<Record<string, string>> = {
  no_financial_record: 'No financial record',
  milestone_not_invoiced: 'Milestone not invoiced',
  invoice_not_issued: 'Invoice not issued',
  unverified_money: 'Unverified money',
  payment_submission_unresolved: 'Payment submission unresolved',
  overpayment: 'Overpayment',
  open_exception: 'Open exception',
  waiver_pending: 'Waiver waiting for an Admin',
  refund_pending: 'Refund requested, not recorded',
  reconciliation_open: 'Open reconciliation item',
  outstanding_balance: 'Outstanding balance',
};

export function blockerTitle(code: string): string {
  return BLOCKER_TITLES[code] ?? code.replace(/_/g, ' ');
}

export const PROPOSAL_KIND_LABEL: Readonly<Record<string, string>> = {
  reconciliation_finding: 'Reconciliation finding',
  anomaly_flag: 'Anomaly flag',
  reminder_draft: 'Reminder draft',
  close_readiness_note: 'Close-readiness note',
  exception_classification: 'Exception classification',
};

export const AGENT_LABEL: Readonly<Record<string, string>> = {
  finance_reconciliation: 'Finance Reconciliation Agent',
  finance_communication: 'Finance Communication Agent',
  finance_close: 'Finance Close Agent',
};
