import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region, TO_END } from './_region.ts';

/**
 * A claim is not a payment — Doc 15 §11, §12 and §4.7; G-272.
 *
 * The table, the guard, the door and §4.7's three decisions were all built —
 * and **nothing in the application touched any of it**, on either side. No
 * read, no write, no surface. So Doc 15's claim layer existed only in the
 * database, and a client saying *"paid, UTR 402318"* had nowhere to go.
 *
 * **It was raised rather than half-built, for a stated reason**: building only
 * the verify half would have shown an always-empty list, because nothing could
 * submit a claim either. That is not a surface, it is the same defect wearing
 * a page. So the unit is the layer end to end.
 *
 * ── the distinction the whole layer exists for ────────────────────────
 *
 * **Verifying is not paying.** Driven on a scratch Postgres 16.14: a confirmed
 * claim comes back `verified` with `payment_id` still null, and the invoice it
 * names is still `issued` with `paid = 0`. The ledger row is
 * `recordManualPayment`, and it is a separate act by a person.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SERVICE = read('src/modules/finance/service.ts');
const SCHEMA = read('src/modules/finance/schema.ts');
const ACTIONS = read('src/modules/finance/actions.ts');
const QUERIES = read('src/modules/finance/queries.ts');
const PANEL = read('app/(internal)/projects/[projectId]/claims-panel.tsx');
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');

const recordSvc = region(SERVICE, 'export async function recordPaymentSubmission', '\nexport async function ');
const verifySvc = region(SERVICE, 'export async function verifyPaymentSubmission', '\nexport async function ');
const recordAct = region(ACTIONS, 'export async function recordPaymentSubmissionAction', '\nexport async function ');
const verifyAct = region(ACTIONS, 'export async function verifyPaymentSubmissionAction', TO_END);
const verifyForm = region(PANEL, 'export function VerifyClaimForm', TO_END);
const claimQuery = region(QUERIES, 'export async function listPaymentClaims', '\n/**');

describe('A. both halves have a caller, because half of it is not a surface', () => {
  test('a claim can be recorded', () => {
    assert.match(recordAct, /await recordPaymentSubmission\(\{/);
    assert.match(recordSvc, /\.from\('payment_submissions'\)\s*\n\s*\.insert\(\{/);
  });

  test('and answered, through the door G-271 finished', () => {
    assert.match(verifyAct, /await verifyPaymentSubmission\(\{/);
    assert.match(verifySvc, /\.rpc\('verify_payment_submission', \{/);
  });

  test('and the reason both were built together is recorded', () => {
    assert.match(
      ACTIONS,
      /a queue that nothing can put a claim\s*\n \* into is an always-empty list, which is the same defect wearing a page/,
    );
  });
});

describe('B. verifying is not paying', () => {
  test('the service says so where somebody would assume otherwise', () => {
    assert.match(SERVICE, /\*\*Verifying is not paying\.\*\*/);
    assert.match(SERVICE, /the door leaves\s*\n \* `payment_id` null until one exists/);
  });

  test('and the message does not read as a receipt', () => {
    assert.match(verifyAct, /Verified\. Record the payment itself to move the invoice\./);
  });

  test('the screen names a verified claim with no ledger row', () => {
    // The distinction, where somebody can act on it: a claim can be checked
    // and the invoice still not have moved.
    assert.match(PAGE, /c\.status === 'verified' && c\.payment_id === null/);
    assert.match(PAGE, /Verified, and not yet recorded as a payment — the invoice has not moved\./);
  });

  test('and recording a claim says the same thing the other way round', () => {
    assert.match(recordAct, /Claim recorded\. Nothing has moved until somebody verifies it\./);
  });
});

describe('C. §12’s rules are carried, not re-decided', () => {
  test('a confirmation records evidence, and the schema refuses it empty', () => {
    assert.match(SCHEMA, /\.refine\(\(v\) => v\.decision !== 'confirm' \|\| \(v\.evidence !== undefined && v\.evidence\.length > 0\)/);
    assert.match(SCHEMA, /a confirmation with no evidence is a click/);
  });

  test('and a refusal records a reason', () => {
    assert.match(SCHEMA, /\.refine\(\(v\) => v\.decision === 'confirm' \|\| \(v\.reason !== undefined && v\.reason\.length > 0\)/);
  });

  test('the verifier is the caller, never a name from the form', () => {
    // The guard refuses any other: "you may only say that YOU checked it".
    assert.match(verifySvc, /p_verified_by: context\.userId,/);
    assert.match(verifySvc, /the guard refuses any other name/);
    assert.doesNotMatch(verifyAct, /verifiedBy|verified_by/);
  });

  test('every refusal the door can produce is surfaced as written', () => {
    for (const outcome of ['settled', 'no_evidence', 'no_reason', 'no_note', 'no_verifier', 'not_found']) {
      assert.match(verifySvc, new RegExp(`case '${outcome}':`), `${outcome} is flattened`);
    }
  });

  test('and §36’s reference is required for every method that has one', () => {
    // Cash is the exception the column's nullability exists for; a bank
    // transfer claimed with nothing to match it against is not a claim.
    assert.match(SCHEMA, /\.refine\(\(v\) => v\.method === 'cash' \|\| \(v\.reference !== undefined && v\.reference\.length > 0\)/);
    assert.match(SCHEMA, /cash is the only method without one/);
  });

  test('a duplicate reference is a conflict, not a server fault', () => {
    assert.match(recordSvc, /if \(error\.code === '23505'\)/);
    assert.match(recordSvc, /That reference has already been claimed against an invoice\./);
  });
});

describe('D. a mismatch is not a rejection', () => {
  test('the control stays available on a mismatched claim', () => {
    // §6 calls it "requires resolution", and the guard lets it move again.
    assert.match(verifyForm, /if \(claim\.status !== 'pending_verification' && claim\.status !== 'mismatch'\) return null;/);
  });

  test('and the panel says why it does not stamp a verifier', () => {
    assert.match(PANEL, /it is the one\s*\n \* decision that does not stamp a verifier, because doing so would make the\s*\n \* queue of unchecked claims look shorter than it is/);
  });

  test('its own wording is a resolution, not a closure', () => {
    assert.match(verifyAct, /Recorded as a mismatch\. It stays in the queue until it is resolved\./);
  });
});

describe('E. the read, and what a failed one must not claim', () => {
  test('an unreadable invoice list does not become an empty queue', () => {
    // An empty claim queue is the screen saying "nothing needs checking",
    // which is the most expensive false sentence this page can print.
    assert.match(claimQuery, /if \(invoiceError\) unreadable\('listPaymentClaims\.invoices', invoiceError\);/);
    assert.match(claimQuery, /if \(error\) unreadable\('listPaymentClaims', error\);/);
  });

  test('the claims are read for the project, not one invoice at a time', () => {
    assert.match(claimQuery, /\.in\('invoice_id', ids\)/);
    assert.match(QUERIES, /that question does not stop at an invoice boundary/);
  });
});

describe('F. what the surface narrows, said rather than smuggled', () => {
  test('Doc 15 §11 names a client and Sales, and neither can reach this', () => {
    // `payment_submissions_insert` admits owner and ops_admin. Widening it is
    // an RLS change and a decision about who may claim on a client's behalf,
    // not a capability string.
    assert.match(SERVICE, /\*\*Doc 15 §11 names a client and Sales as well\*\*/);
    assert.match(SERVICE, /That\s*\n \* is a narrowing of the document, stated rather than smuggled/);
    assert.match(recordSvc, /if \(!can\(context\.role, 'invoice\.issue'\)\)/);
  });

  test('and the panel is offered only to the role that may use it', () => {
    assert.match(PAGE, /\{mayInvoice \? \(\s*\n\s*<section className="flex flex-col gap-3">\s*\n\s*<h2 className="text-\[13px\] font-semibold tracking-tight">Payment claims<\/h2>/);
  });
});
