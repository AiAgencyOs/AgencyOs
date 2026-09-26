import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { region, TO_END } from './_region.ts';

/**
 * PM4-M08 — M2 Verified / Task 3 Start. Impl §8; PM §5; Finance §12-17.
 * docs/phase-4-gap-analysis.md step 5 (now complete).
 *
 * The point of this unit: no new verification gate was invented.
 * `invoice.paid` already fires only once a real Admin session has verified a
 * payment in full (`finance.verify_payment_submission`) — this handler is a
 * second, independent listener on that same pre-existing fact, filtered to
 * M2 by re-reading the milestone row.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const RUNNER = read('app/api/jobs/run/route.ts');

const HANDLER = region(HANDLERS_TS, 'export async function announceM2PaymentVerified', TO_END);

describe('A. no new gate — a second listener on the one that already exists', () => {
  test('it has its own crm-local copy of the event schema, not a cross-module import', () => {
    // ARCHITECTURE.md §3.2: cross-module access goes through service.ts, not
    // another module's schema.ts. The same discipline this file already
    // keeps for phaseThreeCompletedEventSchema, approvalDecidedEventSchema.
    assert.doesNotMatch(HANDLERS_TS, /from '@\/modules\/projects\/schema'/);
    assert.match(HANDLERS_TS, /invoicePaidForM2EventSchema/);
    assert.match(HANDLER, /invoicePaidForM2EventSchema\.safeParse/);
  });

  test('the milestone is RE-READ, not trusted from the event payload', () => {
    assert.match(HANDLER, /\.from\('milestones'\)/);
    assert.match(HANDLER, /\.eq\('id', event\.milestoneId\)/);
    assert.match(HANDLER, /if \(milestone\.position !== 2\)/);
  });

  test('a non-M2 milestone is explicitly not this handler\'s concern', () => {
    assert.match(HANDLER, /outcome: 'not_mine'/);
  });

  test('the docblock says this is not a new gate', () => {
    const prose = HANDLERS_TS.replace(/\n\s*\*\s?/g, ' ');
    assert.match(prose, /this is not a new gate, only a new listener on the same fact/);
  });
});

describe('B. idempotency keyed on the milestone, not the invoice', () => {
  test('a stable externalRef', () => {
    assert.match(HANDLER, /externalRef: `m2-payment-verified:\$\{milestone\.id\}`/);
  });
});

describe('C. it is reachable — the defect this repository has found repeatedly', () => {
  test('invoice.paid fans out to both the milestone unlock AND the PM announcement', () => {
    assert.deepEqual(SUBSCRIPTIONS['invoice.paid'], ['projects:unlockNextMilestone', 'crm:announceM2PaymentVerified']);
    assert.ok(HANDLERS.includes('crm:announceM2PaymentVerified'));
    assert.equal(HANDLER_JOB_KIND['crm:announceM2PaymentVerified'], 'm2_payment_verified.announce');
  });

  test('the runner drains the new job kind', () => {
    assert.match(RUNNER, /const M2_PAYMENT_VERIFIED_JOB_KIND = HANDLER_JOB_KIND\['crm:announceM2PaymentVerified'\]/);
    assert.match(RUNNER, /announceM2PaymentVerified,\s*\n\s*'runM2PaymentVerifiedAnnouncementJobs'/);
  });
});
