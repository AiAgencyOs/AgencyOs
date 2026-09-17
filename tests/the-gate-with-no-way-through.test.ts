import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A gate with no way through it — Finance §4.1–§4.3, §16; G-275.
 *
 * G-255 built `confirm_billing_mode` and `record_billing_details` and their
 * service wrappers. G-259 then made `generateInvoiceFromMilestone` **refuse
 * until a billing mode is confirmed**, which was right: every quotation this
 * agency sends promises 18% GST and every invoice was adding none.
 *
 * **Neither door ever had a caller.** So the gate that shipped in this same
 * sweep would have blocked every invoice on the deployment with a message
 * telling somebody to *"confirm whether this project is billed with GST or
 * without it"* — an action the product did not offer anywhere.
 *
 * This is the fifth instance of built-and-unreachable in this sweep, after
 * G-263, G-268, G-270 and G-274, and the only one **introduced by the sweep
 * itself**. It was found by a systematic reachability pass over every service
 * export rather than by noticing it.
 */

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const SERVICE = read('src/modules/finance/service.ts');
const QUERIES = read('src/modules/finance/queries.ts');
const BILLING_READ = QUERIES.slice(QUERIES.indexOf("A project's billing profile and what is still missing"));
const ACTIONS = read('src/modules/finance/actions.ts');
const BILLING_ACTIONS = ACTIONS.slice(ACTIONS.indexOf('Billing mode and billing details'));
const PANEL = read('app/(internal)/projects/[projectId]/billing-panel.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');

describe('A. the gate and the way through it are both real', () => {
  test('the refusal that names an action — and the action it names', () => {
    // G-259's message. Asserted together with its remedy on purpose: the pair
    // is the unit, and either one alone is the defect.
    assert.match(SERVICE, /Confirm whether this project is billed with GST or without it before raising an invoice/);
    assert.match(BILLING_ACTIONS, /await confirmBillingMode\(\{/);
    assert.match(PANEL, /export function BillingModeForm/);
    assert.match(PAGE, /<BillingModeForm/);
  });

  test('the details half is reachable too', () => {
    // §16's second row: "incomplete GST data → block GST invoice". Same shape
    // — a block whose remedy does not exist is a project that can never be
    // invoiced.
    assert.match(BILLING_ACTIONS, /await recordBillingDetails\(\{/);
    assert.match(PANEL, /export function BillingDetailsForm/);
    assert.match(PAGE, /<BillingDetailsForm/);
  });

  test('no finance service export is left without a caller', () => {
    // The sweep that found this gap, kept as a standing check. It is the
    // shape that has appeared five times, and the only cheap way to notice
    // the sixth.
    const files: string[] = [];
    const visit = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const next = `${path}/${entry.name}`;
        if (entry.isDirectory()) visit(next);
        else if (/\.tsx?$/.test(entry.name)) files.push(next);
      }
    };
    visit(root('src'));
    visit(root('app'));

    const exported = [...SERVICE.matchAll(/^export async function ([a-zA-Z]+)/gm)].map((m) => m[1]!);
    assert.ok(exported.length > 10, `only ${exported.length} exports found — the scan is broken`);

    const unreachable = exported.filter((name) => {
      const callers = files.filter(
        (file) =>
          !file.endsWith('modules/finance/service.ts') &&
          new RegExp(`\\b${name}\\b`).test(readFileSync(file, 'utf8')),
      );
      return callers.length === 0;
    });
    assert.deepEqual(unreachable, [], 'a finance service export has no caller anywhere');
  });
});

describe('B. §16 is answered with the gap, not with a bare no', () => {
  test('the page shows exactly what is still missing', () => {
    // "Request only missing fields." A block that says no without saying what
    // is owed produces a message asking a client for everything again.
    assert.match(PAGE, /billing\.missing\.join\(', '\)/);
    assert.match(PAGE, /billing\.invalid\.map/);
  });

  test('and the list comes from billingReadiness, not from the page', () => {
    // §4.3: "do not add GST merely because the agency has GST configuration."
    // Which fields a NON-GST project needs is that function's answer, and a
    // page that guessed would ask for a GSTIN it must not have.
    assert.match(BILLING_READ, /await readBillingReadiness\(projectId, supabase\)/);
    assert.doesNotMatch(PAGE, /mode === 'gst' \? \['gstin'/);
  });

  test('an unconfirmed mode says what it blocks, in the client’s terms', () => {
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /No invoice can be raised for this project until somebody records whether the client is billed with GST or without it/,
    );
    // And why choosing wrongly matters: G-255 found the quotation corpus
    // promises GST in writing on every document.
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /Every quotation this agency sends says GST is extra/,
    );
  });
});

describe('C. the choice is recorded as somebody’s, not assumed', () => {
  test('the source is asked for and is not defaulted to the agency', () => {
    // §4.3. A mode the agency assumed and a mode the client confirmed are
    // different facts, and only one is safe to print on an invoice.
    assert.match(PANEL, /name="source"/);
    assert.match(PANEL, /the client confirmed it/);
    assert.match(PANEL, /we decided internally/);
  });

  test('a repeated confirmation is not reported as a change', () => {
    // §4.3 calls it not a legitimate change, so it gets no new version — and
    // saying "recorded" would invite somebody to look for the new version.
    assert.match(BILLING_ACTIONS, /if \(!result\.data\.changed\)/);
    assert.match(BILLING_ACTIONS, /Already recorded — nothing changed/);
  });

  test('the panel states no tax rate of its own', () => {
    // `taxRateBpForMode` owns 18%. A second copy in a caption is a second
    // thing to keep in step with the quotations that promise it.
    const body = PANEL.slice(PANEL.indexOf('export function BillingModeForm'));
    assert.doesNotMatch(body, /\b18\b|1800|tax_rate/);
  });

  test('a GSTIN is checked before the write, not after', () => {
    assert.match(SERVICE, /The checksum, before the write rather than after it/);
    assert.match(PANEL.replace(/\n\s*/g, ' '), /refused while the person who typed it is still looking at it/);
  });
});

describe('D. the read refuses rather than answering "not confirmed"', () => {
  test('an unreadable profile is not an unconfirmed one', () => {
    // "No billing mode confirmed" is the state that blocks every invoice on
    // the project, so answering it for a read that did not happen tells
    // somebody to confirm a mode they already confirmed.
    assert.match(BILLING_READ, /if \(billingError\) unreadable\('readProjectBilling', billingError\)/);
    assert.match(
      BILLING_READ.replace(/\n\s*\*\s?/g, ' '),
      /answering it for a read that did not happen would tell somebody to confirm a mode they had already confirmed/,
    );
  });

  test('it is behind invoice.read, and writing is behind invoice.create', () => {
    assert.match(PAGE, /can\(context\.role, 'invoice\.read'\) \? await readProjectBilling\(projectId\) : null/);
    assert.match(PAGE, /\{mayInvoice \?/);
    assert.match(SERVICE, /You do not have permission to set a billing mode\./);
  });
});
