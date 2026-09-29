import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  B2CL_THRESHOLD_PAISE,
  GSTR1_SPEC_VERSION,
  GSTR1_TOP_LEVEL_KEYS,
  GSTR3B_TOP_LEVEL_KEYS,
  gstIdentityIssues,
  gstr1,
  gstr3b,
  rateGroups,
  returnPeriodFor,
  selectForReturn,
  splitTax,
  type GstIdentity,
  type GstrInvoice,
} from '../src/modules/finance/gstr.ts';
import { STATE_NAME_TO_CODE, stateCodeForName } from '../src/modules/finance/gst-states.ts';
import { resolveTaxPeriod, splitByMode } from '../src/modules/finance/tax-report.ts';

// GSTR-1 and GSTR-3B are drawn from the confirmed GST register and invent
// nothing: the split is arithmetic in paise, an invoice the file cannot
// state honestly is listed as unresolved and omitted, and the file's totals
// are the register's totals. These are the promises.

const today = new Date('2026-09-29T00:00:00Z');
const september = resolveTaxPeriod('2026-09', today);

// A real GSTIN shape with a valid check character (Maharashtra, 27).
const AGENCY_GSTIN = '27AAPFU0939F1ZV';
// Karnataka (29) recipient, valid check character.
const KARNATAKA_GSTIN = '29AABCT1332L1ZA';

const identity: GstIdentity = { gstin: AGENCY_GSTIN, stateCode: '27', defaultSac: '998314', legalName: 'Agency' };

let seq = 0;
const inv = (over: Partial<GstrInvoice> = {}): GstrInvoice => {
  seq += 1;
  return {
    id: `i${seq}`,
    number: `INV-${String(seq).padStart(3, '0')}`,
    status: 'issued',
    currency: 'INR',
    subtotalMinor: 100_000_00,
    taxMinor: 18_000_00,
    totalMinor: 118_000_00,
    issuedAt: '2026-09-10T00:00:00Z',
    projectId: 'p1',
    billingMode: 'gst',
    gstin: null,
    recipientStateCode: '27',
    billingState: 'Maharashtra',
    lines: [{ description: 'Build', amountMinor: 100_000_00, taxRateBp: 1800 }],
    ...over,
  };
};

describe('the intra/inter-state split, in paise', () => {
  test('same state as the supplier: CGST and SGST in halves; the odd paisa goes to SGST', () => {
    assert.deepEqual(splitTax(18_000_00, '27', '27'), { igst: 0, cgst: 9_000_00, sgst: 9_000_00 });
    assert.deepEqual(splitTax(1_801, '27', '27'), { igst: 0, cgst: 900, sgst: 901 });
  });

  test('a different state: all of it is IGST', () => {
    assert.deepEqual(splitTax(18_000_00, '27', '29'), { igst: 18_000_00, cgst: 0, sgst: 0 });
  });

  test('the halves always sum to the tax, whatever the amount', () => {
    for (const paise of [0, 1, 2, 3, 99, 12_345, 18_000_01]) {
      const s = splitTax(paise, '27', '27');
      assert.equal(s.cgst + s.sgst + s.igst, paise);
    }
  });

  test('rate groups reconcile to the tax the invoice carries, so rounding cannot leave a paisa behind', () => {
    // Two lines at 18% whose separately rounded taxes miss the stored total by one paisa.
    const groups = rateGroups({ taxMinor: 3_00, lines: [{ description: 'a', amountMinor: 8_33, taxRateBp: 1800 }, { description: 'b', amountMinor: 8_33, taxRateBp: 1800 }] });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.taxablePaise, 16_66);
    assert.equal(groups[0]!.taxPaise, 3_00);
  });
});

describe('B2B and B2C are decided by the recipient GSTIN, nothing else', () => {
  test('a recipient with a GSTIN is B2B under its ctin; one without is summarised in B2CS', () => {
    const rows = [inv({ gstin: KARNATAKA_GSTIN, recipientStateCode: '29' }), inv(), inv({ recipientStateCode: '29', totalMinor: 59_000_00, subtotalMinor: 50_000_00, taxMinor: 9_000_00, lines: [{ description: 'x', amountMinor: 50_000_00, taxRateBp: 1800 }] })];
    const { json, counts } = gstr1(rows, identity, september);
    assert.equal(json.b2b.length, 1);
    assert.equal(json.b2b[0]!.ctin, KARNATAKA_GSTIN);
    assert.equal(json.b2b[0]!.inv[0]!.pos, '29');
    assert.deepEqual(json.b2b[0]!.inv[0]!.itms[0]!.itm_det, { txval: 100000, rt: 18, iamt: 18000, csamt: 0 });
    assert.equal(counts.b2b, 1);
    // The intra-state B2C invoice: CGST + SGST in the summary.
    const intra = json.b2cs.find((r) => r.sply_ty === 'INTRA');
    assert.ok(intra);
    assert.deepEqual(intra, { sply_ty: 'INTRA', pos: '27', typ: 'OE', txval: 100000, rt: 18, csamt: 0, camt: 9000, samt: 9000 });
    // The inter-state B2C invoice below the B2CL threshold: IGST in the summary.
    const inter = json.b2cs.find((r) => r.sply_ty === 'INTER');
    assert.deepEqual(inter, { sply_ty: 'INTER', pos: '29', typ: 'OE', txval: 50000, rt: 18, csamt: 0, iamt: 9000 });
    assert.equal(json.b2cl.length, 0);
  });

  test('an inter-state B2C invoice at or above the threshold goes to B2CL, invoice by invoice', () => {
    assert.equal(B2CL_THRESHOLD_PAISE, 1_00_000_00);
    const { json } = gstr1([inv({ recipientStateCode: '29' })], identity, september);
    assert.equal(json.b2cl.length, 1);
    assert.equal(json.b2cl[0]!.pos, '29');
    assert.equal(json.b2cl[0]!.inv[0]!.val, 118000);
    assert.equal(json.b2cs.length, 0);
  });
});

describe('what cannot be stated honestly is unresolved, and never exported', () => {
  test('no state code, an unknown state code, a failed GSTIN checksum, a non-INR invoice and no lines are each listed with where to fix them', () => {
    const rows = [
      inv({ recipientStateCode: null, billingState: 'Bengaluru' }),
      inv({ recipientStateCode: null, billingState: null }),
      inv({ recipientStateCode: '45' }),
      inv({ gstin: '29AABCT1332L1ZZ', recipientStateCode: '29' }),
      inv({ currency: 'USD' }),
      inv({ lines: [] }),
      inv(),
    ];
    const { json, unresolved, counts } = gstr1(rows, identity, september);
    assert.equal(unresolved.length, 6);
    assert.equal(counts.unresolved, 6);
    assert.match(unresolved[0]!.reason, /Bengaluru/);
    assert.equal(unresolved[0]!.fixHref, '/projects/p1');
    assert.match(unresolved[1]!.reason, /No billing state/);
    assert.match(unresolved[2]!.reason, /State code 45 is not one the GSTN issues/);
    assert.match(unresolved[3]!.reason, /check character/);
    assert.match(unresolved[4]!.reason, /USD/);
    assert.match(unresolved[5]!.reason, /No line items/);
    // Exactly the one good invoice is in the file, under no table but B2CS.
    const exportedNumbers: string[] = [...json.b2b.flatMap((e) => e.inv.map((i) => i.inum)), ...json.b2cl.flatMap((e) => e.inv.map((i) => i.inum))];
    assert.equal(exportedNumbers.length, 0);
    assert.equal(json.b2cs.length, 1);
    assert.equal(json.b2cs[0]!.txval, 100000);
    for (const u of unresolved) assert.ok(!exportedNumbers.includes(u.number));
  });

  test('non-GST and unconfirmed-mode invoices are outside the file by the same rule the CSV uses, and are counted, not unresolved', () => {
    const rows = [inv({ billingMode: 'non_gst', taxMinor: 0 }), inv({ billingMode: null }), inv()];
    const { unresolved, counts } = gstr1(rows, identity, september);
    assert.equal(unresolved.length, 0);
    assert.equal(counts.nonGst, 1);
    assert.equal(counts.unconfirmed, 1);
    assert.equal(counts.b2cs, 1);
  });

  test('a void invoice is a cancelled document, never a supply', () => {
    const rows = [inv(), inv({ status: 'void' })];
    const { json, counts } = gstr1(rows, identity, september);
    assert.equal(counts.voided, 1);
    assert.deepEqual(json.doc_issue.doc_det[0]!.docs[0], { num: 1, from: 'INV-0' + String(seq - 1).padStart(2, '0'), to: `INV-${String(seq).padStart(3, '0')}`, totnum: 2, cancel: 1, net_issue: 1 });
    assert.equal(json.b2cs.length, 1);
  });

  test('an invoice outside the period is neither exported nor unresolved', () => {
    const { unresolved, counts } = gstr1([inv({ issuedAt: '2026-08-31T23:59:59Z', recipientStateCode: null })], identity, september);
    assert.equal(unresolved.length, 0);
    assert.equal(counts.b2cs, 0);
  });

  test('an incomplete agency identity refuses the whole file rather than writing an empty header', () => {
    assert.deepEqual(gstIdentityIssues({ gstin: null, stateCode: null, defaultSac: null, legalName: '' }).map((i) => i.field), ['gstin', 'stateCode', 'defaultSac']);
    assert.throws(() => gstr1([inv()], { ...identity, gstin: null }, september), /GST identity incomplete/);
    assert.throws(() => gstr3b([inv()], { ...identity, defaultSac: null }, september), /GST identity incomplete/);
    assert.equal(gstIdentityIssues({ ...identity, gstin: '27AAPFU0939F1ZZ' })[0]!.reason.includes('check character'), true);
  });

  test('only a month or a quarter is a return period', () => {
    assert.equal(returnPeriodFor(resolveTaxPeriod('2026-09', today)), '092026');
    assert.equal(returnPeriodFor(resolveTaxPeriod('2026-Q2', today)), '062026');
    assert.equal(returnPeriodFor(resolveTaxPeriod('FY2026', today)), null);
    assert.equal(returnPeriodFor(resolveTaxPeriod('2026-09-01..2026-09-15', today)), null);
    assert.equal(returnPeriodFor(resolveTaxPeriod('all', today)), null);
    assert.throws(() => gstr1([inv()], identity, resolveTaxPeriod('FY2026', today)), /one month or one quarter/);
  });
});

describe('GSTR-3B says what the register says', () => {
  test('3.1(a) equals the GST register totals for the period, split by place of supply, and 3.2 lists inter-state B2C by state', () => {
    const rows = [
      inv(),                                                   // intra, B2C
      inv({ gstin: KARNATAKA_GSTIN, recipientStateCode: '29' }), // inter, B2B
      inv({ recipientStateCode: '33', totalMinor: 59_000_00, subtotalMinor: 50_000_00, taxMinor: 9_000_00, lines: [{ description: 'x', amountMinor: 50_000_00, taxRateBp: 1800 }] }), // inter, B2C
      inv({ billingMode: 'non_gst', taxMinor: 0, totalMinor: 100_000_00 }),
      inv({ issuedAt: '2026-10-01T00:00:00Z' }),
    ];
    const register = splitByMode(rows.filter((r) => r.issuedAt! < '2026-10-01').map((r) => ({ ...r, paidMinor: 0 })));
    const gst = register[0]!.gst;
    const { json, totalsPaise, counts } = gstr3b(rows, identity, september);

    assert.equal(totalsPaise.taxable, gst.subtotal);
    assert.equal(totalsPaise.tax, gst.tax);
    assert.equal(totalsPaise.igst + totalsPaise.cgst + totalsPaise.sgst, gst.tax);
    assert.equal(counts.invoices, 3);
    assert.deepEqual(json.sup_details.osup_det, { txval: 250000, iamt: 27000, camt: 9000, samt: 9000, csamt: 0 });
    assert.deepEqual(json.inter_sup.unreg_details, [{ pos: '33', txval: 50000, iamt: 9000 }]);
    assert.equal(json.ret_period, '092026');
    assert.equal(json.gstin, AGENCY_GSTIN);
  });

  test('GSTR-1 and GSTR-3B are drawn from one selection, so their totals agree', () => {
    const rows = [inv(), inv({ recipientStateCode: '29', gstin: KARNATAKA_GSTIN }), inv({ recipientStateCode: null })];
    const one = gstr1(rows, identity, september);
    const three = gstr3b(rows, identity, september);
    const hsnTaxable = one.json.hsn.data.reduce((s, h) => s + h.txval, 0);
    assert.equal(hsnTaxable, three.json.sup_details.osup_det.txval);
    assert.deepEqual(one.unresolved.map((u) => u.number), three.unresolved.map((u) => u.number));
  });

  test('every nil table is named as nil, with why, rather than hidden in a zero', () => {
    const { json, nilTables } = gstr3b([inv()], identity, september);
    assert.equal(nilTables.length, 4);
    assert.ok(nilTables.some((n) => /input tax credit/.test(n)));
    assert.deepEqual(json.itc_elg.itc_net, { iamt: 0, camt: 0, samt: 0, csamt: 0 });
  });
});

describe('the shapes are the offline tool’s, and pinned', () => {
  test('top-level keys and the spec version are constants a spec change must update on purpose', () => {
    const one = gstr1([inv()], identity, september);
    assert.deepEqual(Object.keys(one.json), [...GSTR1_TOP_LEVEL_KEYS]);
    assert.equal(one.json.version, GSTR1_SPEC_VERSION);
    assert.match(GSTR1_SPEC_VERSION, /^GST\d+\.\d+\.\d+$/);
    assert.equal(one.json.hash, 'hash');
    assert.equal(one.json.b2cs[0]!.typ, 'OE');
    assert.deepEqual(one.json.hsn.data[0], { num: 1, hsn_sc: '998314', desc: 'Services', uqc: 'OTH', qty: 0, txval: 100000, rt: 18, iamt: 0, camt: 9000, samt: 9000, csamt: 0 });
    assert.equal(one.json.b2cs[0]!.pos, '27');

    const three = gstr3b([inv()], identity, september);
    assert.deepEqual(Object.keys(three.json), [...GSTR3B_TOP_LEVEL_KEYS]);
    assert.deepEqual(Object.keys(three.json.sup_details), ['osup_det', 'osup_zero', 'osup_nil_exmp', 'isup_rev', 'osup_nongst']);
    assert.deepEqual(Object.keys(three.json.itc_elg), ['itc_avl', 'itc_rev', 'itc_net', 'itc_inelg']);
  });

  test('dates are DD-MM-YYYY and amounts are rupees with two decimals', () => {
    const { json } = gstr1([inv({ gstin: KARNATAKA_GSTIN, recipientStateCode: '29', issuedAt: '2026-09-03T10:00:00Z', totalMinor: 118_000_50, subtotalMinor: 100_000_42, taxMinor: 18_000_08, lines: [{ description: 'x', amountMinor: 100_000_42, taxRateBp: 1800 }] })], identity, september);
    const line = json.b2b[0]!.inv[0]!;
    assert.equal(line.idt, '03-09-2026');
    assert.equal(line.val, 118000.5);
    assert.equal(line.itms[0]!.itm_det.txval, 100000.42);
    assert.equal(line.itms[0]!.itm_det.iamt, 18000.08);
  });
});

describe('the state-name map', () => {
  test('resolves what a person types, forgiving punctuation and former names, and never a city', () => {
    assert.equal(stateCodeForName('Maharashtra'), '27');
    assert.equal(stateCodeForName(' jammu & kashmir '), '01');
    assert.equal(stateCodeForName('Jammu and Kashmir'), '01');
    assert.equal(stateCodeForName('Orissa'), '21');
    assert.equal(stateCodeForName('Tamil-Nadu'), '33');
    assert.equal(stateCodeForName('Andhra Pradesh'), '37');
    assert.equal(stateCodeForName('Bengaluru'), null);
    assert.equal(stateCodeForName(''), null);
    assert.equal(stateCodeForName(null), null);
  });

  test('is the SAME map the migration backfills with, entry for entry', () => {
    const sql = readFileSync(new URL('../supabase/migrations/20260930160000_the_agency_states_its_own_gst_identity.sql', import.meta.url), 'utf8');
    const body = sql.slice(sql.indexOf('create or replace function finance.indian_state_code'), sql.indexOf(') as m(name, code)'));
    const fromSql: Record<string, string> = {};
    for (const m of body.matchAll(/\('([a-z]+)', '(\d{2})'\)/g)) fromSql[m[1]!] = m[2]!;
    assert.deepEqual(fromSql, { ...STATE_NAME_TO_CODE });
  });

  test('the selection uses the code the profile holds; it does not re-derive one from the name', () => {
    // A profile whose free text is a state name but whose code was never set
    // (written before the migration's trigger, or by a direct insert) is
    // unresolved: the code column is the record, and the fix is on the project.
    const sel = selectForReturn([inv({ recipientStateCode: null, billingState: 'Maharashtra' })], september);
    assert.equal(sel.ready.length, 0);
    assert.equal(sel.unresolved.length, 1);
  });
});
