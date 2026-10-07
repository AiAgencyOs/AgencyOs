import { crossCheckSentence, type CrossCheck } from './claim-queue';

/**
 * The packet-ready summary of ONE payment claim for the person who verifies it (Phase 9 plan section 9: "tracks submissions and prepares verification
 * packets"). Pure, composed only from what is already on the claim, its invoice, the bank statement lines a person imported, the open finance exceptions
 * and the recorded account check: it computes no balance of its own (the remaining amount is the invoice's total less what a person has already
 * verified) and it decides nothing. It never says a payment IS received: the headline always says verification is a person's act. There is no agent
 * behind it; it is the same facts a reviewer would otherwise collect by hand, arranged once.
 */

export type PacketClaim = {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  method: string;
  reference: string | null;
  payerName: string | null;
  paidAt: string | null;
  submittedAt: string;
  hasProof: boolean;
  receivingAccountLabel: string | null;
};
export type PacketInvoice = { number: string; status: string; currency: string; totalMinor: number; verifiedMinor: number; dueAt: string | null };
export type PacketException = { id: string; kind: string; blocking: boolean; reason: string };
export type PacketAccountCheck = { outcome: 'consistent' | 'payer_differs' | 'account_not_active' | 'both'; clientName: string } | null;

export type PacketFacts = {
  claim: PacketClaim;
  invoice: PacketInvoice;
  clientName: string | null;
  projectName: string | null;
  /** Other claims on the same invoice (never this one). */
  otherClaims: { id: string; status: string; reference: string | null; amountMinor: number }[];
  crossCheck: CrossCheck;
  openExceptions: PacketException[];
  accountCheck: PacketAccountCheck;
};

export type PacketTone = 'ok' | 'attention' | 'blocking';
export type PacketFlag = { code: string; tone: PacketTone; text: string };
export type VerificationPacket = {
  headline: string;
  lines: { label: string; value: string }[];
  flags: PacketFlag[];
  /** 'ready': nothing in the data needs a second look before a person decides. It is never "verified". */
  readiness: 'ready' | 'needs_attention';
  reminder: string;
};

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;
const norm = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

export function buildVerificationPacket(f: PacketFacts): VerificationPacket {
  const c = f.claim;
  const remaining = Math.max(f.invoice.totalMinor - f.invoice.verifiedMinor, 0);
  const flags: PacketFlag[] = [];

  if (c.status === 'verified' || c.status === 'rejected' || c.status === 'duplicate' || c.status === 'refunded') {
    flags.push({ code: 'already_decided', tone: 'attention', text: `This claim is already ${c.status.replace(/_/g, ' ')}.` });
  }
  if (c.currency !== f.invoice.currency) flags.push({ code: 'currency_differs', tone: 'blocking', text: `The claim is in ${c.currency} but the invoice is in ${f.invoice.currency}.` });
  else if (remaining === 0) flags.push({ code: 'nothing_remaining', tone: 'attention', text: 'The invoice has no unverified balance left, so this claim would be a surplus.' });
  else if (c.amountMinor === remaining) flags.push({ code: 'amount_matches', tone: 'ok', text: `The amount equals what is still unverified on the invoice (${money(remaining, f.invoice.currency)}).` });
  else if (c.amountMinor < remaining) flags.push({ code: 'partial_amount', tone: 'attention', text: `The claim is less than what is still unverified (${money(c.amountMinor, c.currency)} of ${money(remaining, f.invoice.currency)}): a partial payment.` });
  else flags.push({ code: 'amount_exceeds', tone: 'blocking', text: `The claim is more than what is still unverified (${money(c.amountMinor, c.currency)} against ${money(remaining, f.invoice.currency)}).` });

  const ref = norm(c.reference);
  if (ref === '') flags.push({ code: 'no_reference', tone: 'attention', text: 'The claim carries no payment reference.' });
  else if (f.otherClaims.some((o) => norm(o.reference) === ref)) flags.push({ code: 'duplicate_reference', tone: 'blocking', text: 'Another claim on this invoice uses the same reference.' });
  if (!c.hasProof) flags.push({ code: 'no_proof', tone: 'attention', text: 'No proof of payment is attached.' });

  flags.push({ code: 'bank_cross_check', tone: f.crossCheck.kind === 'reference_and_amount' ? 'ok' : 'attention', text: crossCheckSentence(f.crossCheck) });

  if (f.accountCheck && f.accountCheck.outcome !== 'consistent') {
    const parts = [
      f.accountCheck.outcome === 'payer_differs' || f.accountCheck.outcome === 'both' ? `the payer named does not match the client account (${f.accountCheck.clientName})` : null,
      f.accountCheck.outcome === 'account_not_active' || f.accountCheck.outcome === 'both' ? 'the receiving account named was not an active account of the agency at the time' : null,
    ].filter((x): x is string => x !== null);
    flags.push({ code: 'account_check', tone: 'blocking', text: `The recorded account check found a difference: ${parts.join('; ')}.` });
  } else if (f.accountCheck) {
    flags.push({ code: 'account_check', tone: 'ok', text: 'The recorded account check found the payer and receiving account consistent with the books.' });
  } else {
    flags.push({ code: 'account_unchecked', tone: 'attention', text: 'The payer and receiving account have not been checked yet.' });
  }

  for (const e of f.openExceptions) {
    flags.push({ code: `exception_${e.kind}`, tone: e.blocking ? 'blocking' : 'attention', text: `Open ${e.kind.replace(/_/g, ' ')} exception: ${e.reason}` });
  }

  const lines = [
    { label: 'Client', value: f.clientName ?? 'not shown' },
    { label: 'Project', value: f.projectName ?? 'none' },
    { label: 'Invoice', value: `${f.invoice.number} (${f.invoice.status}), total ${money(f.invoice.totalMinor, f.invoice.currency)}, already verified ${money(f.invoice.verifiedMinor, f.invoice.currency)}` },
    { label: 'Claimed', value: `${money(c.amountMinor, c.currency)} by ${c.method.replace(/_/g, ' ')}${c.reference ? `, reference ${c.reference}` : ''}` },
    { label: 'Payer named', value: c.payerName ?? 'not named' },
    { label: 'Receiving account named', value: c.receivingAccountLabel ?? 'not named' },
    { label: 'Paid on', value: c.paidAt ?? 'not stated' },
    { label: 'Claimed on', value: c.submittedAt },
  ];

  const readiness = flags.every((x) => x.tone === 'ok') ? 'ready' : 'needs_attention';
  return {
    headline: `Claim of ${money(c.amountMinor, c.currency)} on invoice ${f.invoice.number}: ${readiness === 'ready' ? 'nothing in the data needs a second look' : `${flags.filter((x) => x.tone !== 'ok').length} point${flags.filter((x) => x.tone !== 'ok').length === 1 ? '' : 's'} to look at`}`,
    lines,
    flags,
    readiness,
    reminder: 'This packet is a summary of what is recorded. A claim is not a payment: only a person verifying it makes it money received.',
  };
}
