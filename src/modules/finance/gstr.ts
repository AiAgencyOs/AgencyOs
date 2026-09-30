/**
 * GSTR-1 and GSTR-3B, as the GST portal's offline tool reads them — bucket
 * E5 (owner decision 2026-09-30: exports, no filing API, no e-invoice IRN).
 *
 * Pure. The caller hands in the confirmed register rows (gstr-queries.ts),
 * the agency's own identity and the period; it gets back the JSON body and
 * an `unresolved` list — every invoice the file OMITS and why, so the screen
 * can say what is missing and where to fix it. Nothing is guessed: no state
 * code from a city name, no rate from a total, no GSTIN from a checksum that
 * failed.
 *
 * Arithmetic is in paise (integers) end to end; rupees appear only in the
 * final JSON, where the offline tool wants numbers with two decimals.
 *
 * Shapes follow the GSTN offline-tool specification. `GSTR1_SPEC_VERSION`
 * is the `version` field the tool expects and the date it was matched
 * against; the top-level keys are pinned in tests/finance-gstr.test.ts so a
 * change on the GSTN's side is a deliberate constant update, not a silent
 * drift.
 */

import { checkGstin } from './gstin';
import { isGstStateCode, STATE_CODE_TO_NAME } from './gst-states';
import type { TaxPeriod } from './tax-report';

// ── what the spec pins ──────────────────────────────────────────────────────

/** GSTR-1 offline tool JSON `version` (GST Offline Tool v3.1.x, spec matched 2026-09-30). */
export const GSTR1_SPEC_VERSION = 'GST3.1.6';
/** The spec date the shapes below were matched against. */
export const GSTR_SPEC_DATE = '2026-09-30';
/** Top-level keys of a GSTR-1 file, in the order the tool writes them. */
export const GSTR1_TOP_LEVEL_KEYS = ['gstin', 'fp', 'version', 'hash', 'b2b', 'b2cl', 'b2cs', 'hsn', 'doc_issue'] as const;
/** Top-level keys of a GSTR-3B file. */
export const GSTR3B_TOP_LEVEL_KEYS = ['gstin', 'ret_period', 'sup_details', 'inter_sup', 'itc_elg', 'inward_sup', 'intr_ltfee'] as const;
/**
 * Inter-state supplies to an unregistered person at or above this value go
 * in table B2CL, invoice by invoice; below it they are summarised in B2CS.
 * ₹1,00,000 since 1 Aug 2024 (Notification 12/2024–Central Tax).
 */
export const B2CL_THRESHOLD_PAISE = 1_00_000_00;

// ── inputs ──────────────────────────────────────────────────────────────────

export type GstIdentity = {
  /** The agency's own GSTIN, or null while the owner has not stated it. */
  gstin: string | null;
  /** The two-digit registration state code, or null. */
  stateCode: string | null;
  /** The SAC every line is classified under until a per-line code exists. */
  defaultSac: string | null;
  legalName: string;
};

export type GstrLine = {
  description: string;
  /** Pre-tax line amount, paise. */
  amountMinor: number;
  taxRateBp: number;
};

export type GstrInvoice = {
  id: string;
  number: string;
  /** Any non-draft status; `void` rows count only in doc_issue.cancel. */
  status: string;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  issuedAt: string | null;
  projectId: string | null;
  billingMode: 'gst' | 'non_gst' | null;
  /** The recipient's GSTIN from the project's active billing profile. */
  gstin: string | null;
  /** The place of supply as the GSTN code, from billing_profiles.billing_state_code. */
  recipientStateCode: string | null;
  /** The free text the code was (or was not) derived from, for the callout. */
  billingState: string | null;
  lines: readonly GstrLine[];
};

export type Unresolved = {
  invoiceId: string;
  number: string;
  reason: string;
  /** Where a person fixes it. */
  fixHref: string;
  fixLabel: string;
};

export type IdentityIssue = { field: 'gstin' | 'stateCode' | 'defaultSac'; reason: string };

/** What Settings › Finance still lacks before either file can be written. */
export function gstIdentityIssues(identity: GstIdentity): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  if (!identity.gstin) issues.push({ field: 'gstin', reason: 'The agency’s own GSTIN is not set.' });
  else {
    const verdict = checkGstin(identity.gstin);
    if (!verdict.valid) issues.push({ field: 'gstin', reason: `The agency’s GSTIN cannot be a GSTIN: ${verdict.reason}.` });
  }
  if (!isGstStateCode(identity.stateCode)) issues.push({ field: 'stateCode', reason: 'The agency’s registration state code is not set.' });
  if (!identity.defaultSac) issues.push({ field: 'defaultSac', reason: 'The default SAC is not set, so the HSN summary cannot classify a line.' });
  return issues;
}

// ── period ──────────────────────────────────────────────────────────────────

/**
 * The return period as the tool writes it: `MMYYYY`. A month is itself; a
 * quarter files under its last month (QRMP). A financial year, a custom
 * range or "all time" is not a return period and yields null — the route
 * refuses rather than picking a month.
 */
export function returnPeriodFor(period: TaxPeriod): string | null {
  if (!period.from || !period.to) return null;
  const from = new Date(period.from);
  const to = new Date(period.to);
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (from.getUTCDate() !== 1 || to.getUTCDate() !== 1) return null;
  if (months !== 1 && months !== 3) return null;
  // The last month inside the window.
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
  return `${String(last.getUTCMonth() + 1).padStart(2, '0')}${last.getUTCFullYear()}`;
}

function inPeriod(at: string | null, period: TaxPeriod): boolean {
  if (!period.from || !period.to) return true;
  if (!at) return false;
  return at >= period.from && at < period.to;
}

// ── arithmetic ──────────────────────────────────────────────────────────────

export type TaxSplit = { igst: number; cgst: number; sgst: number };

/**
 * One line's tax, split by where the supply went. Same state as the
 * supplier → CGST and SGST in halves (the odd paisa, when the total is odd,
 * goes to SGST so the two still sum to the tax); a different state → IGST.
 */
export function splitTax(taxPaise: number, supplierStateCode: string, placeOfSupply: string): TaxSplit {
  if (supplierStateCode === placeOfSupply) {
    const cgst = Math.floor(taxPaise / 2);
    return { igst: 0, cgst, sgst: taxPaise - cgst };
  }
  return { igst: taxPaise, cgst: 0, sgst: 0 };
}

/** Tax on a taxable value at a rate in basis points, rounded to the paisa. */
export function taxAtRate(taxablePaise: number, rateBp: number): number {
  return Math.round((taxablePaise * rateBp) / 10_000);
}

export type RateGroup = { rateBp: number; taxablePaise: number; taxPaise: number };

/**
 * The invoice's lines grouped by rate, with the group taxes reconciled to
 * the tax the invoice actually carries (finance.invoices.tax_minor, set at
 * issue). Rounding each group separately can miss the stored total by a
 * paisa; the difference lands on the largest group so the file's totals
 * equal the register's, which is what a return has to say.
 */
export function rateGroups(invoice: Pick<GstrInvoice, 'lines' | 'taxMinor'>): RateGroup[] {
  const groups = new Map<number, RateGroup>();
  for (const line of invoice.lines) {
    const g = groups.get(line.taxRateBp) ?? { rateBp: line.taxRateBp, taxablePaise: 0, taxPaise: 0 };
    g.taxablePaise += line.amountMinor;
    g.taxPaise += taxAtRate(line.amountMinor, line.taxRateBp);
    groups.set(line.taxRateBp, g);
  }
  const list = [...groups.values()].sort((a, b) => b.taxablePaise - a.taxablePaise || a.rateBp - b.rateBp);
  const sum = list.reduce((s, g) => s + g.taxPaise, 0);
  const diff = invoice.taxMinor - sum;
  if (diff !== 0 && list.length > 0) {
    const carrier = list.find((g) => g.rateBp > 0) ?? list[0]!;
    carrier.taxPaise += diff;
  }
  return list;
}

const rupees = (paise: number): number => Number((paise / 100).toFixed(2));
const ratePercent = (bp: number): number => Number((bp / 100).toFixed(2));

/** `DD-MM-YYYY`, the offline tool's date shape. */
function toolDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

// ── selection ───────────────────────────────────────────────────────────────

export type Selection = {
  /** GST-mode invoices in the period with everything the file needs. */
  ready: (GstrInvoice & { recipientStateCode: string; recipientGstin: string | null })[];
  unresolved: Unresolved[];
  /** Void invoices in the period — counted in doc_issue.cancel, never as a supply. */
  voided: GstrInvoice[];
  /** Non-GST and unconfirmed-mode invoices in the period, left out by the same rule the CSV uses. */
  excluded: { nonGst: number; unconfirmed: number };
};

/**
 * Which rows go in the file, which are left out and why. An invoice is
 * unresolved when: it is not in INR (a return is filed in rupees), it has no
 * lines (no rate can be stated), its place of supply has no GSTN code, its
 * state code is not one the GSTN issues, or its recipient GSTIN fails the
 * checksum (a mistyped GSTIN filed under B2B is a credit the client never
 * receives).
 */
export function selectForReturn(rows: readonly GstrInvoice[], period: TaxPeriod): Selection {
  const ready: Selection['ready'] = [];
  const unresolved: Unresolved[] = [];
  const voided: GstrInvoice[] = [];
  const excluded = { nonGst: 0, unconfirmed: 0 };

  for (const row of rows) {
    if (!inPeriod(row.issuedAt, period)) continue;
    if (row.status === 'void') {
      voided.push(row);
      continue;
    }
    if (row.billingMode !== 'gst') {
      if (row.billingMode === 'non_gst') excluded.nonGst += 1;
      else excluded.unconfirmed += 1;
      continue;
    }
    const projectHref = row.projectId ? `/projects/${row.projectId}` : `/invoices/${row.id}`;
    const fixLabel = row.projectId ? 'Project › Billing' : 'Invoice';
    if (row.currency !== 'INR') {
      unresolved.push({ invoiceId: row.id, number: row.number, reason: `Invoiced in ${row.currency}; a GST return is filed in INR.`, fixHref: `/invoices/${row.id}`, fixLabel: 'Invoice' });
      continue;
    }
    if (row.lines.length === 0) {
      unresolved.push({ invoiceId: row.id, number: row.number, reason: 'No line items, so no rate can be stated.', fixHref: `/invoices/${row.id}`, fixLabel: 'Invoice' });
      continue;
    }
    if (!row.recipientStateCode) {
      unresolved.push({
        invoiceId: row.id,
        number: row.number,
        reason: row.billingState
          ? `Billing state “${row.billingState}” is not a state name the GSTN lists, so there is no place-of-supply code.`
          : 'No billing state on the project’s billing profile, so there is no place of supply.',
        fixHref: projectHref,
        fixLabel,
      });
      continue;
    }
    if (!isGstStateCode(row.recipientStateCode)) {
      unresolved.push({ invoiceId: row.id, number: row.number, reason: `State code ${row.recipientStateCode} is not one the GSTN issues.`, fixHref: projectHref, fixLabel });
      continue;
    }
    let recipientGstin: string | null = null;
    if (row.gstin) {
      const verdict = checkGstin(row.gstin);
      if (!verdict.valid) {
        unresolved.push({ invoiceId: row.id, number: row.number, reason: `Recipient GSTIN ${row.gstin}: ${verdict.reason}.`, fixHref: projectHref, fixLabel });
        continue;
      }
      recipientGstin = verdict.normalized;
    }
    ready.push({ ...row, recipientStateCode: row.recipientStateCode, recipientGstin });
  }

  return { ready, unresolved, voided, excluded };
}

// ── GSTR-1 ──────────────────────────────────────────────────────────────────

type ItemDet = { txval: number; rt: number; iamt?: number; camt?: number; samt?: number; csamt: number };
type Item = { num: number; itm_det: ItemDet };

export type Gstr1Json = {
  gstin: string;
  fp: string;
  version: string;
  hash: string;
  b2b: { ctin: string; inv: { inum: string; idt: string; val: number; pos: string; rchrg: 'N'; inv_typ: 'R'; itms: Item[] }[] }[];
  b2cl: { pos: string; inv: { inum: string; idt: string; val: number; itms: Item[] }[] }[];
  b2cs: { sply_ty: 'INTRA' | 'INTER'; pos: string; typ: 'OE'; txval: number; rt: number; iamt?: number; camt?: number; samt?: number; csamt: number }[];
  hsn: { data: { num: number; hsn_sc: string; desc: string; uqc: 'OTH'; qty: number; txval: number; rt: number; iamt: number; camt: number; samt: number; csamt: number }[] };
  doc_issue: { doc_det: { doc_num: number; docs: { num: number; from: string; to: string; totnum: number; cancel: number; net_issue: number }[] }[] };
};

export type Gstr1Result = {
  json: Gstr1Json;
  unresolved: Unresolved[];
  counts: { b2b: number; b2cl: number; b2cs: number; hsn: number; unresolved: number; voided: number; nonGst: number; unconfirmed: number };
};

function itemDet(taxable: number, rateBp: number, split: TaxSplit): ItemDet {
  const det: ItemDet = { txval: rupees(taxable), rt: ratePercent(rateBp), csamt: 0 };
  if (split.igst > 0 || (split.cgst === 0 && split.sgst === 0)) det.iamt = rupees(split.igst);
  if (split.cgst > 0 || split.sgst > 0) {
    det.camt = rupees(split.cgst);
    det.samt = rupees(split.sgst);
  }
  return det;
}

/**
 * GSTR-1 for the period. Requires a complete identity and a monthly or
 * quarterly period; throws on neither, because a file with an empty header
 * is not a file the tool accepts and a caller should not be able to write
 * one by accident. The route checks both first and refuses with words.
 */
export function gstr1(rows: readonly GstrInvoice[], identity: GstIdentity, period: TaxPeriod): Gstr1Result {
  const issues = gstIdentityIssues(identity);
  if (issues.length > 0) throw new Error(`GST identity incomplete: ${issues.map((i) => i.reason).join(' ')}`);
  const fp = returnPeriodFor(period);
  if (!fp) throw new Error('A GSTR-1 is for one month or one quarter.');
  const supplierState = identity.stateCode!;
  const sac = identity.defaultSac!;

  const { ready, unresolved, voided, excluded } = selectForReturn(rows, period);

  const b2bByCtin = new Map<string, Gstr1Json['b2b'][number]>();
  const b2clByPos = new Map<string, Gstr1Json['b2cl'][number]>();
  const b2cs = new Map<string, Gstr1Json['b2cs'][number] & { _txval: number; _tax: TaxSplit }>();
  const hsn = new Map<number, { txval: number; tax: TaxSplit }>();

  for (const inv of ready) {
    const groups = rateGroups(inv);
    const intra = inv.recipientStateCode === supplierState;
    const items: Item[] = groups.map((g, i) => ({ num: i + 1, itm_det: itemDet(g.taxablePaise, g.rateBp, splitTax(g.taxPaise, supplierState, inv.recipientStateCode)) }));

    for (const g of groups) {
      const split = splitTax(g.taxPaise, supplierState, inv.recipientStateCode);
      const h = hsn.get(g.rateBp) ?? { txval: 0, tax: { igst: 0, cgst: 0, sgst: 0 } };
      h.txval += g.taxablePaise;
      h.tax = { igst: h.tax.igst + split.igst, cgst: h.tax.cgst + split.cgst, sgst: h.tax.sgst + split.sgst };
      hsn.set(g.rateBp, h);
    }

    if (inv.recipientGstin) {
      const entry = b2bByCtin.get(inv.recipientGstin) ?? { ctin: inv.recipientGstin, inv: [] };
      entry.inv.push({ inum: inv.number, idt: toolDate(inv.issuedAt!), val: rupees(inv.totalMinor), pos: inv.recipientStateCode, rchrg: 'N', inv_typ: 'R', itms: items });
      b2bByCtin.set(inv.recipientGstin, entry);
      continue;
    }

    if (!intra && inv.totalMinor >= B2CL_THRESHOLD_PAISE) {
      const entry = b2clByPos.get(inv.recipientStateCode) ?? { pos: inv.recipientStateCode, inv: [] };
      entry.inv.push({ inum: inv.number, idt: toolDate(inv.issuedAt!), val: rupees(inv.totalMinor), itms: items });
      b2clByPos.set(inv.recipientStateCode, entry);
      continue;
    }

    for (const g of groups) {
      const key = `${inv.recipientStateCode}:${g.rateBp}`;
      const split = splitTax(g.taxPaise, supplierState, inv.recipientStateCode);
      const row = b2cs.get(key) ?? {
        sply_ty: intra ? 'INTRA' : 'INTER',
        pos: inv.recipientStateCode,
        typ: 'OE',
        txval: 0,
        rt: ratePercent(g.rateBp),
        csamt: 0,
        _txval: 0,
        _tax: { igst: 0, cgst: 0, sgst: 0 },
      };
      row._txval += g.taxablePaise;
      row._tax = { igst: row._tax.igst + split.igst, cgst: row._tax.cgst + split.cgst, sgst: row._tax.sgst + split.sgst };
      b2cs.set(key, row);
    }
  }

  const b2csRows = [...b2cs.values()].map(({ _txval, _tax, ...row }) => {
    const det = itemDet(_txval, Math.round(row.rt * 100), _tax);
    return { ...row, txval: det.txval, ...(det.iamt !== undefined ? { iamt: det.iamt } : {}), ...(det.camt !== undefined ? { camt: det.camt, samt: det.samt } : {}) };
  });

  const hsnRows = [...hsn.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateBp, h], i) => ({
      num: i + 1,
      hsn_sc: sac,
      desc: 'Services',
      uqc: 'OTH' as const,
      qty: 0,
      txval: rupees(h.txval),
      rt: ratePercent(rateBp),
      iamt: rupees(h.tax.igst),
      camt: rupees(h.tax.cgst),
      samt: rupees(h.tax.sgst),
      csamt: 0,
    }));

  const issuedNumbers = [...ready.map((r) => r.number), ...voided.map((r) => r.number)].sort();
  const docs =
    issuedNumbers.length > 0
      ? [{ num: 1, from: issuedNumbers[0]!, to: issuedNumbers[issuedNumbers.length - 1]!, totnum: issuedNumbers.length, cancel: voided.length, net_issue: ready.length }]
      : [];

  const json: Gstr1Json = {
    gstin: identity.gstin!,
    fp,
    version: GSTR1_SPEC_VERSION,
    hash: 'hash',
    b2b: [...b2bByCtin.values()],
    b2cl: [...b2clByPos.values()],
    b2cs: b2csRows,
    hsn: { data: hsnRows },
    doc_issue: { doc_det: [{ doc_num: 1, docs }] },
  };

  return {
    json,
    unresolved,
    counts: {
      b2b: json.b2b.reduce((s, e) => s + e.inv.length, 0),
      b2cl: json.b2cl.reduce((s, e) => s + e.inv.length, 0),
      b2cs: b2csRows.length,
      hsn: hsnRows.length,
      unresolved: unresolved.length,
      voided: voided.length,
      nonGst: excluded.nonGst,
      unconfirmed: excluded.unconfirmed,
    },
  };
}

// ── GSTR-3B ─────────────────────────────────────────────────────────────────

type Amounts = { txval: number; iamt: number; camt: number; samt: number; csamt: number };

export type Gstr3bJson = {
  gstin: string;
  ret_period: string;
  /** Table 3.1 — outward supplies. */
  sup_details: {
    /** 3.1(a) taxable outward supplies other than zero/nil/exempt. */
    osup_det: Amounts;
    /** 3.1(b) zero-rated. Not recorded by this deployment: nil. */
    osup_zero: { txval: number; iamt: number; csamt: number };
    /** 3.1(c) nil-rated and exempt. Nil. */
    osup_nil_exmp: { txval: number };
    /** 3.1(d) inward supplies liable to reverse charge. Nil. */
    isup_rev: Amounts;
    /** 3.1(e) non-GST outward supplies. Nil — non-GST-mode invoices are outside the register this file is drawn from. */
    osup_nongst: { txval: number };
  };
  /** Table 3.2 — inter-state supplies to unregistered persons, composition dealers and UIN holders, by place of supply. */
  inter_sup: {
    unreg_details: { pos: string; txval: number; iamt: number }[];
    comp_details: { pos: string; txval: number; iamt: number }[];
    uin_details: { pos: string; txval: number; iamt: number }[];
  };
  /** Table 4 — input tax credit. Nil: no purchase register exists here. */
  itc_elg: {
    itc_avl: { ty: 'IMPG' | 'IMPS' | 'ISRC' | 'ISD' | 'OTH'; iamt: number; camt: number; samt: number; csamt: number }[];
    itc_rev: { ty: 'RUL' | 'OTH'; iamt: number; camt: number; samt: number; csamt: number }[];
    itc_net: { iamt: number; camt: number; samt: number; csamt: number };
    itc_inelg: { ty: 'RUL' | 'OTH'; iamt: number; camt: number; samt: number; csamt: number }[];
  };
  /** Table 5 — exempt, nil-rated and non-GST inward supplies. Nil. */
  inward_sup: { isup_details: { ty: 'GST' | 'NONGST'; inter: number; intra: number }[] };
  /** Table 5.1 — interest and late fee. Nil. */
  intr_ltfee: { intr_details: { iamt: number; camt: number; samt: number; csamt: number } };
};

export type Gstr3bResult = {
  json: Gstr3bJson;
  unresolved: Unresolved[];
  /** The paise behind 3.1(a), so a test can hold them against the register. */
  totalsPaise: { taxable: number; igst: number; cgst: number; sgst: number; tax: number; invoices: number };
  /** What this file states as nil and why — printed beside the download, never hidden in a zero. */
  nilTables: string[];
  counts: { invoices: number; unresolved: number; nonGst: number; unconfirmed: number };
};

export const GSTR3B_NIL_TABLES = [
  '3.1(b) zero-rated, 3.1(c) nil-rated/exempt, 3.1(d) reverse charge and 3.1(e) non-GST outward supplies are nil: the register records only the supplies this agency invoices with GST.',
  '4 input tax credit is nil: no purchase register with supplier GSTINs exists in this deployment, so no credit is claimed.',
  '5 inward supplies (exempt, nil-rated, non-GST) are nil: not recorded here.',
  '5.1 interest and late fee are nil: computed by the portal, not by this file.',
] as const;

/**
 * GSTR-3B for the period, drawn from the same selection as GSTR-1, so the
 * two files agree with each other and with the register: 3.1(a) equals the
 * sum of the ready invoices' taxable value and tax, split by place of supply.
 */
export function gstr3b(rows: readonly GstrInvoice[], identity: GstIdentity, period: TaxPeriod): Gstr3bResult {
  const issues = gstIdentityIssues(identity);
  if (issues.length > 0) throw new Error(`GST identity incomplete: ${issues.map((i) => i.reason).join(' ')}`);
  const fp = returnPeriodFor(period);
  if (!fp) throw new Error('A GSTR-3B is for one month or one quarter.');
  const supplierState = identity.stateCode!;

  const { ready, unresolved, excluded } = selectForReturn(rows, period);

  const totals = { taxable: 0, igst: 0, cgst: 0, sgst: 0, tax: 0, invoices: ready.length };
  const unregByPos = new Map<string, { txval: number; iamt: number }>();

  for (const inv of ready) {
    for (const g of rateGroups(inv)) {
      const split = splitTax(g.taxPaise, supplierState, inv.recipientStateCode);
      totals.taxable += g.taxablePaise;
      totals.igst += split.igst;
      totals.cgst += split.cgst;
      totals.sgst += split.sgst;
      totals.tax += g.taxPaise;
      if (!inv.recipientGstin && split.igst > 0) {
        const u = unregByPos.get(inv.recipientStateCode) ?? { txval: 0, iamt: 0 };
        u.txval += g.taxablePaise;
        u.iamt += split.igst;
        unregByPos.set(inv.recipientStateCode, u);
      }
    }
  }

  const zero = { iamt: 0, camt: 0, samt: 0, csamt: 0 };
  const json: Gstr3bJson = {
    gstin: identity.gstin!,
    ret_period: fp,
    sup_details: {
      osup_det: { txval: rupees(totals.taxable), iamt: rupees(totals.igst), camt: rupees(totals.cgst), samt: rupees(totals.sgst), csamt: 0 },
      osup_zero: { txval: 0, iamt: 0, csamt: 0 },
      osup_nil_exmp: { txval: 0 },
      isup_rev: { txval: 0, ...zero },
      osup_nongst: { txval: 0 },
    },
    inter_sup: {
      unreg_details: [...unregByPos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pos, u]) => ({ pos, txval: rupees(u.txval), iamt: rupees(u.iamt) })),
      comp_details: [],
      uin_details: [],
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...zero },
        { ty: 'IMPS', ...zero },
        { ty: 'ISRC', ...zero },
        { ty: 'ISD', ...zero },
        { ty: 'OTH', ...zero },
      ],
      itc_rev: [
        { ty: 'RUL', ...zero },
        { ty: 'OTH', ...zero },
      ],
      itc_net: { ...zero },
      itc_inelg: [
        { ty: 'RUL', ...zero },
        { ty: 'OTH', ...zero },
      ],
    },
    inward_sup: {
      isup_details: [
        { ty: 'GST', inter: 0, intra: 0 },
        { ty: 'NONGST', inter: 0, intra: 0 },
      ],
    },
    intr_ltfee: { intr_details: { ...zero } },
  };

  return {
    json,
    unresolved,
    totalsPaise: totals,
    nilTables: [...GSTR3B_NIL_TABLES],
    counts: { invoices: ready.length, unresolved: unresolved.length, nonGst: excluded.nonGst, unconfirmed: excluded.unconfirmed },
  };
}

/** A place-of-supply label for the callout: "27 (Maharashtra)". */
export function describeStateCode(code: string): string {
  const name = STATE_CODE_TO_NAME[code];
  return name ? `${code} (${name})` : code;
}
