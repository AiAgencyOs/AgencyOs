import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { region } from './_region.ts';

/**
 * The verification gate had no door — ADM-04, Finance §6; G-270.
 *
 * `finance.verify_payment` was written in August under the invoice's row lock,
 * `verifyPayment` wrapped it with the right capability, and both were tested.
 * **Neither was ever called by anything.**
 *
 * G-007 made `status = 'paid'` follow *confirmed* money rather than recorded
 * money. So from that day, no invoice in AgencyOS could ever become paid:
 * money could be written down and the product offered no act that confirmed
 * it. Everything downstream was waiting on a step nobody could take — ADM-13's
 * advance condition for starting a project, the milestone unlock, G-264's
 * Phase 7 gate, and G-269's ₹0 maintenance invoice, which refuses below 100%
 * verified.
 *
 * This is the third time in this sweep the same shape has turned up — a rule
 * built, tested and unreachable — and it is by far the most expensive one.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const ACTIONS = read('src/modules/finance/actions.ts');
const ACTION = region(ACTIONS, 'Confirms that recorded money actually arrived', "Billing mode and billing details");
const PANEL = read('app/(internal)/invoices/[invoiceId]/invoice-panel.tsx');
const PAGE = read('app/(internal)/invoices/[invoiceId]/page.tsx');
const QUERIES = read('src/modules/finance/queries.ts');
const SERVICE = read('src/modules/finance/service.ts');

describe('A. the act exists in the product, not only in the module', () => {
  test('a page reaches verifyPayment, through an action', () => {
    assert.match(ACTIONS, /export async function verifyPaymentAction/);
    assert.match(ACTIONS, /await verifyPayment\(\{ paymentId:/);
    assert.match(PANEL, /verifyPaymentAction/);
    assert.match(PAGE, /<VerifyPaymentButton/);
  });

  test('and the reason it was unreachable is written down, not just fixed', () => {
    assert.match(
      PANEL.replace(/\n\s*\*\s?/g, ' '),
      /both tested, and \*\*nothing ever called either of them\*\*/,
    );
    assert.match(
      PANEL.replace(/\n\s*\*\s?/g, ' '),
      /no invoice in this system could ever become paid/,
    );
  });

  test('nothing else in the product had grown a second way to confirm money', () => {
    // If a second path existed, this gap would have been a duplicate rather
    // than a hole — and a second place money is believed is a second place
    // ADM-04 can be walked around.
    const callers = ['src', 'app']
      .flatMap(function walk(dir): string[] {
        const base = fileURLToPath(new URL(`../${dir}`, import.meta.url));
        const out: string[] = [];
        const visit = (path: string) => {
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const next = `${path}/${entry.name}`;
            if (entry.isDirectory()) visit(next);
            else if (/\.tsx?$/.test(entry.name)) out.push(next);
          }
        };
        visit(base);
        return out;
      })
      .filter((file) => !file.endsWith('db/types.ts'))
      .filter((file) => /rpc\('verify_payment'/.test(readFileSync(file, 'utf8')));

    assert.deepEqual(
      callers.map((f) => f.slice(f.indexOf('/src/') + 1 || f.indexOf('/app/') + 1)),
      ['src/modules/finance/service.ts'],
      'more than one place calls verify_payment — ADM-04 has two doors',
    );
  });
});

describe('B. recorded and confirmed are shown as two different facts', () => {
  test('the payments read carries verified_at', () => {
    // It did not, so the page could not have told them apart even if it tried.
    assert.match(QUERIES, /status, captured_at, verified_at'\)/);
    assert.match(read('src/modules/finance/types.ts'), /'captured_at' \| 'verified_at'/);
  });

  test('an unconfirmed payment SAYS so rather than showing a blank', () => {
    assert.match(PAGE, /not confirmed yet/);
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /A blank cell reads as "no information"; this is a claim nobody has checked/,
    );
  });

  test('and the empty state names both steps', () => {
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /somebody records money, and then somebody confirms they have seen it on the statement \(ADM-04\)/,
    );
    assert.match(PAGE.replace(/\n\s*/g, ' '), /the invoice stays unpaid and the next milestone stays shut/);
  });
});

describe('C. the control this restores is not weakened by restoring it', () => {
  test('confirming is behind invoice.issue — owner and ops_admin, who ADM-04 names', () => {
    assert.match(SERVICE, /if \(!can\(context\.role, 'invoice\.issue'\)\) \{\n\s*return err\('FORBIDDEN', 'You do not have permission to confirm payments\.'\)/);
    assert.match(PAGE, /mayIssue && p\.status === 'captured'/);
  });

  test('only CAPTURED money is offered for confirmation', () => {
    // Finance §4.7: only CONFIRM may move a payment to VERIFIED, and money
    // that failed or was never captured is not money to confirm.
    assert.match(PAGE, /p\.status === 'captured'/);
    assert.match(SERVICE, /case 'not_captured':/);
  });

  test('the verifier is the session, never a form field', () => {
    // A payment verified by whoever the form said would be ADM-04 with the
    // authority removed. `p_verified_by` comes from the server context.
    assert.match(SERVICE, /p_verified_by: context\.userId/);
    assert.doesNotMatch(PANEL, /verifiedBy|verified_by/);
  });

  test('nothing here decides the invoice status — the door does, under the lock', () => {
    assert.match(ACTION, /result\.data\.fullyPaid/);
    assert.doesNotMatch(ACTION, />= |total_minor|net_verified/);
  });

  test('a second confirmation is reported honestly, not as a failure', () => {
    // Two people reading one bank statement should not fight.
    assert.match(ACTION, /if \(!result\.data\.changed\)/);
    assert.match(ACTION, /Already confirmed by somebody else/);
    assert.match(
      PANEL.replace(/\n\s*\*\s?/g, ' '),
      /Two people reading the same statement do not fight/,
    );
  });
});
