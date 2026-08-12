import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  nextUnlockedMilestone,
  type MilestoneBillingEntry,
} from '../src/modules/finance/schema.ts';

/**
 * Audit finding D17 — the outbox was not a transactional outbox.
 *
 * `core.outbox_events` has carried this comment since migration 002:
 *
 *     'Events are written in the same transaction as the state change they
 *      describe, so "state committed but event lost" cannot happen.'
 *
 * It could. emitEvent opened its own client and inserted in its own
 * transaction, always after the state change had committed. A failure there
 * left the state written and the event gone — not delayed, gone, because an
 * INSERT that failed leaves no row to find and nothing to replay. emitEvent's
 * own comment claimed the loss was "visible in the outbox and replayable",
 * which is how this stayed invisible for so long.
 *
 * `invoice.paid` is the only subscribed event. Losing one is a client who has
 * paid an invoice in full, a payment and a total correctly written, and a
 * milestone that never opens — no job, no error, nothing to reconcile from.
 *
 * The fix uses the transaction the Postgres functions already hold. This file
 * pins the three things that makes true, and one thing it does not:
 *
 *   A. each event is published inside its function, after the write
 *   B. no refusal publishes anything
 *   C. the service does not publish them a second time
 *   D. the SQL statement of "next unlocked milestone" is the same rule as the
 *      TypeScript one — the one duplication this fix accepts
 *   E. invoice.created is still on the old path, and says so
 *
 * Structural rather than executed, because these are properties of a Postgres
 * function that a node:test run has no database to call. The end-to-end proof
 * — an event actually present, in the same commit as the money — is
 * verify-milestone-invoicing.mjs §7f, against real Postgres.
 */

const MIGRATION =
  '../supabase/migrations/20260812120004_events_written_where_the_state_changes.sql';

const migration = readFileSync(fileURLToPath(new URL(MIGRATION, import.meta.url)), 'utf8');

const financeService = readFileSync(
  fileURLToPath(new URL('../src/modules/finance/service.ts', import.meta.url)),
  'utf8',
);

/** The SQL with comment lines removed, so a comment cannot satisfy an assertion. */
const executable = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/**
 * One function's body, from its `create or replace` to the `$$;` that closes
 * it. Every positional assertion below is made inside one of these rather than
 * across the file, so a match in a neighbouring function cannot stand in.
 */
function body(signature: string): string {
  const start = executable.indexOf(signature);
  assert.ok(start >= 0, `${signature} is not in the migration`);
  const end = executable.indexOf('$$;', start);
  assert.ok(end > start, `${signature} has no closing $$;`);
  return executable.slice(start, end);
}

/** An index that is a real position, or the assertion fails saying which. */
function at(haystack: string, needle: string, label: string): number {
  const index = haystack.indexOf(needle);
  assert.ok(index >= 0, `${label}: "${needle}" is missing`);
  return index;
}

const PAYMENT = 'create or replace function finance.record_manual_payment';
const ISSUE = 'create or replace function finance.issue_invoice';
const VOID = 'create or replace function finance.void_invoice';

// ═══════════════════════════════════════════════════════════════════════════
// A. The event is published where the state changes
// ═══════════════════════════════════════════════════════════════════════════

describe('A. every event a function owns is published inside it', () => {
  const published = [
    { fn: PAYMENT, event: 'payment.recorded', write: 'set paid_minor = v_after' },
    { fn: PAYMENT, event: 'invoice.paid', write: 'set paid_minor = v_after' },
    { fn: ISSUE, event: 'invoice.issued', write: "set status    = 'issued'" },
    { fn: VOID, event: 'invoice.voided', write: "set status = 'void'" },
  ];

  for (const { fn, event, write } of published) {
    const name = fn.replace('create or replace function ', '');

    test(`${name} publishes ${event}`, () => {
      const source = body(fn);
      const emit = at(source, `'${event}'`, event);
      // Named in a core.emit_event call, not merely mentioned.
      const call = source.lastIndexOf('core.emit_event(', emit);
      assert.ok(
        call >= 0 && call < emit,
        `${event} appears in ${name} but not as an argument to core.emit_event`,
      );
    });

    test(`and publishes it after the write, so both are one commit`, () => {
      const source = body(fn);
      assert.ok(
        at(source, write, `${name} write`) < at(source, `'${event}'`, event),
        `${name} publishes ${event} before it writes the state the event describes`,
      );
    });
  }

  test('the payloads carry exactly what each subscriber reads', () => {
    // invoice.paid is the only subscribed event, and projects/schema.ts
    // navigates by these three. The other payloads are pinned because a
    // subscriber added later reads what is here, not what was intended.
    const contracts = [
      { event: 'invoice.paid', fields: ['number', 'clientAccountId', 'projectId', 'milestoneId', 'unlockedMilestoneId', 'paidMinor', 'currency'] },
      { event: 'payment.recorded', fields: ['provider', 'amountMinor', 'currency', 'paidMinor', 'totalMinor'] },
      { event: 'invoice.issued', fields: ['number', 'clientAccountId', 'projectId', 'milestoneId', 'totalMinor', 'currency'] },
      { event: 'invoice.voided', fields: ['number', 'milestoneId', 'reason'] },
    ];

    for (const { event, fields } of contracts) {
      const from = at(executable, `'${event}'`, event);
      const payload = executable.slice(from, from + 700);
      for (const field of fields) {
        assert.match(payload, new RegExp(`'${field}'`), `${event} no longer carries ${field}`);
      }
    }
  });

  test('invoice.paid is published only when the invoice is covered', () => {
    const source = body(PAYMENT);
    // A partial payment must not open the next milestone. The emit sits inside
    // the branch; `payment.recorded` sits outside it, which is the difference.
    const branch = at(source, "if v_new = 'paid' then", 'fully-paid branch');
    assert.ok(branch < at(source, "'invoice.paid'", 'invoice.paid'));
    assert.ok(
      at(source, "'payment.recorded'", 'payment.recorded') < branch,
      'payment.recorded moved inside the fully-paid branch, so a partial payment now publishes nothing',
    );
  });

  test('the unlocked milestone is derived after the total is written, not before', () => {
    // "Next" means the first priced milestone with no paid invoice. Before the
    // UPDATE lands, that is the milestone being paid for right now — so a
    // derivation above the write names the wrong milestone every single time,
    // and the event would tell delivery to reopen the stage just paid for.
    const source = body(PAYMENT);
    assert.ok(
      at(source, 'set paid_minor = v_after', 'the total write') <
        at(source, 'finance.next_unlocked_milestone(', 'the derivation'),
    );
  });

  test('core.emit_event is SECURITY INVOKER, so outbox_insert still decides', () => {
    const helper = body('create or replace function core.emit_event');
    assert.match(helper, /security invoker/);
    assert.doesNotMatch(helper, /security definer/);
    assert.match(helper, /set search_path = ''/);
  });

  test('and it is not reachable by anon or public', () => {
    assert.match(executable, /revoke all on function core\.emit_event[\s\S]{0,120}from public, anon/);
    assert.match(
      executable,
      /grant execute on function core\.emit_event[\s\S]{0,120}to authenticated, service_role/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. A refusal publishes nothing
// ═══════════════════════════════════════════════════════════════════════════

describe('B. nothing is published on a path that writes nothing', () => {
  const refusals: Record<string, string[]> = {
    [PAYMENT]: ['not_found', 'not_payable', 'non_positive', 'overpayment', 'duplicate'],
    [ISSUE]: ['not_found', 'already_issued', 'not_issuable', 'no_amount', 'no_items'],
    [VOID]: ['not_found', 'already_void', 'not_voidable', 'has_payments'],
  };

  for (const [fn, outcomes] of Object.entries(refusals)) {
    const name = fn.replace('create or replace function ', '');

    for (const outcome of outcomes) {
      test(`${name} refuses ${outcome} before it could publish`, () => {
        const source = body(fn);
        const refusal = at(source, `'${outcome}'::text`, `${name} ${outcome}`);
        const firstEmit = at(source, 'core.emit_event(', `${name} emit`);
        // Every refusal is `return query …; return;` — reaching one means
        // leaving the function, so a refusal above the first emit cannot
        // publish. An event for a payment that was refused would tell delivery
        // to open a milestone nobody paid for.
        assert.ok(
          refusal < firstEmit,
          `${name} can reach ${outcome} after publishing, so a refusal would leave an event behind`,
        );
      });
    }
  }

  test('each refusal actually returns, rather than falling through to the emit', () => {
    for (const fn of [PAYMENT, ISSUE, VOID]) {
      const source = body(fn);
      const emit = at(source, 'core.emit_event(', 'emit');
      const before = source.slice(0, emit);
      // Every `return query select '<refusal>'` above the emit is followed by
      // a bare `return;`. Without it plpgsql continues, and a refused invoice
      // would publish and then be reported as refused.
      const returns = before.match(/return query select '[a-z_]+'::text[\s\S]*?;\s*\n\s*return;/g) ?? [];
      const refusalReturns = (before.match(/return query select '[a-z_]+'::text/g) ?? []).length;
      assert.equal(
        returns.length,
        refusalReturns,
        `${fn}: a refusal does not return, so it falls through to the emit`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. And not published a second time from the application
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the service does not publish them again', () => {
  for (const event of ['invoice.paid', 'payment.recorded', 'invoice.issued', 'invoice.voided']) {
    test(`finance/service.ts does not emit ${event}`, () => {
      // A surviving emit is not a harmless duplicate. Two outbox rows are two
      // event ids, two `evt:<id>:<handler>` dedupe keys, and therefore two
      // unlock jobs for one payment — the dedupe key cannot absorb what it
      // cannot see is the same event.
      assert.doesNotMatch(
        financeService,
        new RegExp(`type: '${event.replace('.', '\\.')}'`),
        `${event} is emitted from the service as well as the function, so every one is published twice`,
      );
    });
  }

  test('the caller reports the milestone the function named rather than deriving one', () => {
    assert.match(financeService, /settled\.unlocked_milestone_id/);
    // The read-after-commit helper this replaced is gone, not merely unused.
    assert.doesNotMatch(financeService, /async function resolveUnlockedMilestone/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The one duplication this fix accepts, checked rather than asserted
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `invoice.paid` carries `unlockedMilestoneId`, so publishing inside the
 * transaction means deriving it in SQL — a second statement of a rule
 * finance/service.ts explicitly warns against duplicating.
 *
 * It is accepted because the rule collapses to a predicate.
 * `nextUnlockedMilestone` returns `priced[paidThrough]`, and `paidThrough` is
 * the length of the leading run of paid milestones — so the answer is exactly
 * *the first priced milestone, in position order, with no paid invoice*. That
 * equivalence is the whole argument, so it is tested rather than claimed.
 *
 * This proves the reformulation. That the deployed function implements the
 * reformulation is pinned by the text assertion below, and that it agrees with
 * this rule on real rows is proved live in verify-milestone-invoicing §7f.
 */
describe('D. the SQL rule is the TypeScript rule', () => {
  /** The same entry shape billingEntries builds, so both rules see one input. */
  type Entry = MilestoneBillingEntry;

  /** "The first priced milestone, in position order, with no paid invoice." */
  function sqlRule(entries: readonly Entry[]): string | null {
    return (
      [...entries]
        .filter((e) => e.paymentPercent !== null && e.invoiceStatus !== 'paid')
        .sort((a, b) => a.position - b.position || a.milestoneId.localeCompare(b.milestoneId))[0]
        ?.milestoneId ?? null
    );
  }

  /** Every plan of `size` milestones over the statuses that can appear. */
  function* plans(size: number): Generator<Entry[]> {
    // Priced-and-paid, priced-and-live, priced-and-unbilled, unpriced. A void
    // invoice is already absent from a billing entry — billingEntries drops
    // it — so it appears here as the third cell, not a fourth status.
    const cells: (readonly [number | null, Entry['invoiceStatus']])[] = [
      [50, 'paid'],
      [50, 'issued'],
      [50, null],
      [null, null],
    ];
    const total = cells.length ** size;
    for (let n = 0; n < total; n += 1) {
      const entries: Entry[] = [];
      let rest = n;
      for (let i = 0; i < size; i += 1) {
        const cell = cells[rest % cells.length]!;
        rest = Math.floor(rest / cells.length);
        entries.push({
          milestoneId: `m${i}`,
          position: i,
          paymentPercent: cell[0],
          invoiceStatus: cell[1],
        });
      }
      yield entries;
    }
  }

  test('both rules agree on every plan of up to four milestones', () => {
    let checked = 0;
    for (const size of [0, 1, 2, 3, 4]) {
      for (const plan of plans(size)) {
        checked += 1;
        assert.equal(
          sqlRule(plan),
          nextUnlockedMilestone(plan)?.milestoneId ?? null,
          `the two rules disagree on ${JSON.stringify(plan.map((e) => [e.paymentPercent, e.invoiceStatus]))}`,
        );
      }
    }
    // 4^0 + 4^1 + … + 4^4. Asserted so a generator that silently produced
    // nothing would fail here rather than pass by checking zero plans.
    assert.equal(checked, 341);
  });

  test('and they agree that an unpriced milestone is never next', () => {
    const plan: Entry[] = [
      { milestoneId: 'm0', position: 0, paymentPercent: 50, invoiceStatus: 'paid' },
      { milestoneId: 'm1', position: 1, paymentPercent: null, invoiceStatus: null },
      { milestoneId: 'm2', position: 2, paymentPercent: 50, invoiceStatus: null },
    ];
    assert.equal(sqlRule(plan), 'm2');
    assert.equal(nextUnlockedMilestone(plan)?.milestoneId, 'm2');
  });

  test('a plan paid to the end unlocks nothing, in both', () => {
    const plan: Entry[] = [
      { milestoneId: 'm0', position: 0, paymentPercent: 50, invoiceStatus: 'paid' },
      { milestoneId: 'm1', position: 1, paymentPercent: 50, invoiceStatus: 'paid' },
    ];
    assert.equal(sqlRule(plan), null);
    assert.equal(nextUnlockedMilestone(plan), null);
  });

  test('the deployed function is that predicate, not something near it', () => {
    const fn = body('create or replace function finance.next_unlocked_milestone');

    assert.match(fn, /m\.payment_percent is not null/);
    assert.match(fn, /not exists/);
    assert.match(fn, /i\.status = 'paid'/);
    assert.match(fn, /order by m\.position/);
    assert.match(fn, /limit 1/);
    // Both tables scoped by the organization passed in, not by the caller's
    // claim — the answer must not change with who is asking (finding D16).
    assert.match(fn, /m\.organization_id = p_organization_id/);
    assert.match(fn, /i\.organization_id = p_organization_id/);
    assert.match(fn, /security definer/);
    // …and a signed-in caller still cannot ask about another tenant.
    assert.match(fn, /core\.current_organization_id\(\) = p_organization_id/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. What this fix does not close, pinned so it cannot be forgotten
// ═══════════════════════════════════════════════════════════════════════════

describe('E. invoice.created is still on the old path', () => {
  test('it is still emitted from the application', () => {
    // generateInvoiceFromMilestone has no Postgres function behind it — it
    // inserts the invoice, inserts the items, and hand-rolls a compensating
    // DELETE when the second fails. Moving that inside a transaction is a
    // larger change than this finding, recorded as G-078.
    //
    // This test exists so the gap is a decision rather than an oversight. When
    // G-078 lands, it fails, and the fix is to move the assertion to section A.
    assert.match(financeService, /type: 'invoice\.created'/);
  });

  test('nothing subscribes to it, which is why the gap is survivable', () => {
    const catalog = readFileSync(
      fileURLToPath(new URL('../src/lib/events/catalog.ts', import.meta.url)),
      'utf8',
    );
    const subscriptions = catalog.slice(
      at(catalog, 'export const SUBSCRIPTIONS', 'SUBSCRIPTIONS'),
      at(catalog, 'export const HANDLER_JOB_KIND', 'HANDLER_JOB_KIND'),
    );
    assert.doesNotMatch(
      subscriptions,
      /invoice\.created/,
      'something now listens to invoice.created, so losing one costs work — G-078 stops being survivable',
    );
  });

  test('and the table comment no longer claims the property holds for everything', () => {
    // Migration 002 asserted it outright while it was false everywhere. The
    // comment must now name what is true and what is not.
    const comment = executable.slice(at(executable, 'comment on table core.outbox_events', 'comment'));
    assert.match(comment, /invoice\.created/);
    assert.match(comment, /G-078/);
  });
});
