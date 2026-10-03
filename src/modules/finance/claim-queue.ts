/**
 * The verification queue's search, filter and cross-check — PDF SCR-054
 * "search/filtering", "Bank/gateway reference" and "Invoice/project context".
 * Pure: the page and the tests share it.
 */

export type QueueClaim = {
  id: string;
  status: string;
  amountMinor: number;
  reference: string | null;
  payerName: string | null;
  invoiceNumber: string;
  clientName: string | null;
  projectName: string | null;
};

export type QueueFilter = { q?: string; status?: string };

/** Search over what a reviewer types: client, project, invoice number, reference, payer or amount. */
export function filterQueue<T extends QueueClaim>(claims: readonly T[], f: QueueFilter): T[] {
  const needle = (f.q ?? '').trim().toLowerCase();
  const digits = needle.replace(/[^0-9.]/g, '');
  return claims.filter((c) => {
    if (f.status && c.status !== f.status) return false;
    if (!needle) return true;
    const hay = [c.clientName, c.projectName, c.invoiceNumber, c.reference, c.payerName].filter(Boolean).join(' ').toLowerCase();
    if (hay.includes(needle)) return true;
    // An amount in rupees ("15000" or "15,000.50") matches the claim's amount.
    return digits.length > 0 && /^[0-9]+(\.[0-9]{1,2})?$/.test(digits) && Math.round(Number(digits) * 100) === c.amountMinor;
  });
}

export type BankLineFact = { id: string; statementDate: string; description: string; reference: string | null; amountMinor: number; status: string };

export type CrossCheck =
  | { kind: 'reference_and_amount'; line: BankLineFact }
  | { kind: 'reference'; line: BankLineFact }
  | { kind: 'amount'; line: BankLineFact }
  | { kind: 'none' };

const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/**
 * Does any uploaded bank statement line agree with this claim? A reference that
 * equals (or is contained in) a line's reference or description is the strong
 * signal; an amount alone is weaker and only offered when the claim carries no
 * reference of its own that disagrees. A reading for the reviewer, never a match.
 */
export function crossCheckClaim(claim: { reference: string | null; amountMinor: number }, lines: readonly BankLineFact[]): CrossCheck {
  const ref = norm(claim.reference);
  const byRef = ref.length >= 4 ? lines.filter((l) => norm(l.reference) === ref || norm(l.description).includes(ref) || (norm(l.reference) !== '' && ref.includes(norm(l.reference)) && norm(l.reference).length >= 6)) : [];
  const both = byRef.find((l) => l.amountMinor === claim.amountMinor);
  if (both) return { kind: 'reference_and_amount', line: both };
  if (byRef[0]) return { kind: 'reference', line: byRef[0] };
  const byAmount = lines.filter((l) => l.amountMinor === claim.amountMinor);
  if (byAmount.length === 1 && byAmount[0]) return { kind: 'amount', line: byAmount[0] };
  return { kind: 'none' };
}

export function crossCheckSentence(c: CrossCheck): string {
  switch (c.kind) {
    case 'reference_and_amount':
      return `A bank line agrees on reference and amount (${c.line.description}).`;
    case 'reference':
      return `A bank line carries this reference but a different amount (${c.line.description}).`;
    case 'amount':
      return `Only one bank line has this amount, with no matching reference (${c.line.description}).`;
    default:
      return 'No uploaded bank statement line agrees with this claim.';
  }
}
