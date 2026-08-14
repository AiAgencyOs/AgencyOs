import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * Work that comes after handover — gap G-034.
 *
 * The business documentation defines maintenance **nowhere**. The word appears
 * exactly once in the whole of `docs/business-os`, in one lifecycle arrow:
 *
 *   delivery → handover → completed → maintenance → repeat business
 *
 * That is the entire specification. So the tests here are mostly about what is
 * *absent*: every column this model does not have is a product decision
 * somebody would otherwise have made by accident.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120010_work_that_comes_after_handover.sql');
const lifecycle = read('../docs/business-os/04-client-lifecycle.md');

/** The table definition alone, so header prose cannot satisfy a check. */
const tableDef = migration.slice(
  migration.indexOf('create table if not exists projects.maintenance_items'),
  migration.indexOf('comment on table projects.maintenance_items'),
);

describe('A. it invents no product', () => {
  const columns = [...tableDef.matchAll(/^\s{2}(\w+)\s+/gm)].map((m) => m[1] ?? '');

  test('the column parse found a real table', () => {
    assert.ok(columns.length > 8, `only ${columns.length} columns parsed, so the absences prove nothing`);
  });

  test('no column can hold money', () => {
    for (const c of columns) {
      assert.ok(!/price|amount|minor|cost|rate|fee|invoice/i.test(c), `maintenance gained a money column: ${c}`);
    }
  });

  test('no column is an SLA, a response time, or a due date', () => {
    // The due date is the one that looks harmless and is not. "Due on Friday"
    // is a promise to somebody, and no AgencyOS document makes one.
    for (const c of columns) {
      assert.ok(!/sla|due|deadline|response_time|target/i.test(c), `maintenance gained a commitment column: ${c}`);
    }
  });

  test('and no column is a package, plan or tier', () => {
    for (const c of columns) {
      assert.ok(!/plan|tier|package|subscription|renewal|expiry/i.test(c), `maintenance gained a product column: ${c}`);
    }
  });
});

describe('B. it follows the lifecycle rather than elaborating on it', () => {
  test('the arrow this implements is the whole specification', () => {
    assert.match(lifecycle, /handover → completed → maintenance/);
  });

  test('post-handover is enforced, not assumed', () => {
    // A maintenance item on a project that was never delivered is delivery
    // work filed in the wrong place, which makes both records mean less.
    assert.match(codeOnly(migration), /h\.status in \('delivered', 'accepted'\)/);
    assert.match(migration, /create trigger enforce_post_handover/);
  });

  test('and it refuses rather than corrects', () => {
    // Which of the two records is wrong is a judgement; guessing would move
    // somebody's work without telling them.
    // Both the slice and the index must come from the same string: a first
    // draft indexed the raw text and sliced the stripped one, so the slice
    // started in the wrong place and the assertion proved nothing.
    const code = codeOnly(migration);
    const fn = code.slice(code.indexOf('function projects.enforce_post_handover'));
    assert.match(fn, /raise exception/);
    assert.ok(!/update projects\./.test(fn), 'the trigger edits data instead of refusing');
  });
});

describe('C. one client cannot inherit another\'s delivered work', () => {
  test('the client account must own the project', () => {
    // RLS would not catch this: both rows are in the same organization.
    assert.match(codeOnly(migration), /p\.client_account_id = new\.client_account_id/);
  });
});

describe('D. the record stays honest', () => {
  test('closed is a state and a time together, or neither', () => {
    assert.match(
      migration,
      /check \(\(status in \('resolved', 'declined'\)\) = \(closed_at is not null\)\)/,
    );
  });

  test('declined is kept rather than deleted', () => {
    // "We were asked and said no" is a different fact from "nobody asked".
    assert.match(migration, /check \(status in \('open', 'in_progress', 'resolved', 'declined'\)\)/);
  });
});

describe('E. it is internal, and sells nothing', () => {
  test('there is no client policy at all', () => {
    // An absent policy is a stronger guarantee than one that excludes them,
    // because there is nothing to get wrong.
    assert.ok(!/is_client\(\)/.test(migration), 'a client can reach the maintenance log');
    assert.match(migration, /create policy maintenance_items_select[\s\S]{0,200}core\.is_internal\(\)/);
  });

  test('and nothing here sends or prices', () => {
    const code = codeOnly(migration);
    for (const forbidden of ['send_outbound_message', 'proposal', 'invoice']) {
      assert.ok(!code.includes(forbidden), `the maintenance model reaches ${forbidden}`);
    }
  });
});

describe('F. it does not quietly complete G-036', () => {
  test('the support-pattern signal is still not implemented', () => {
    // There is now something to observe, but a *pattern* means a threshold —
    // how many items, over how long — and no business rule states one.
    // Choosing a number would be exactly the invention G-036 refused.
    assert.ok(
      !/support_pattern/.test(codeOnly(migration)),
      'a support-pattern signal was added on an invented threshold',
    );
  });
});
