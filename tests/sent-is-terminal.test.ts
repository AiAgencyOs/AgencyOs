import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * Sent is terminal — gap G-012, ADM-69 step 10.
 *
 * Two protections in one migration, both found by driving the delivery path:
 * a retry that succeeds may now correct `failed → sent`, and the follow-up
 * lifecycle is audited without flooding the log.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260815120004_sent_is_terminal.sql');
const previous = read('../supabase/migrations/20260814120012_a_list_the_admin_can_change.sql');
const code = sqlCode(migration);

describe('A. sent is terminal, and nothing else is', () => {
  test('the settle predicate names the two settleable states, no more', () => {
    // The old pending-only guard blocked failed → sent, so a retried delivery
    // read failed forever. The first fix used `is distinct from 'sent'`, and
    // review caught that as WIDER than the stated rule: it also admitted rows
    // with no delivery key at all — every inbound message — so a wrong id
    // from a service-role caller would stamp outbound state onto a client's
    // own words. The list is the rule, exactly.
    assert.match(code, /delivery' in \('pending', 'failed'\)/);
    assert.ok(!/is distinct from 'sent'/.test(code), 'the wide predicate is back');
    assert.ok(
      !/delivery' = 'pending'/.test(code),
      'the pending-only guard is back, and a successful retry can never say so again',
    );
  });

  test('a corrected message does not keep the failure it recovered from', () => {
    // {delivery: sent, error: 'HTTP 500'} reads as both at once.
    assert.match(code, /metadata - 'error'/);
  });
});

describe('B. the lifecycle is audited without noise', () => {
  test('sequences audit on insert and status change only', () => {
    // The worker touches last_evaluated_at every tick; auditing that would be
    // a row per active sequence per minute — a log nobody can read.
    assert.match(migration, /after insert or update of status on crm\.follow_up_sequences/);
  });

  test('sends audit on insert and outcome change only', () => {
    assert.match(migration, /after insert or update of outcome on crm\.follow_up_sends/);
  });

  test('the vocabulary arrives in the same change as the triggers', () => {
    assert.match(code, /'followup\.sequence_started'/);
    assert.match(code, /'followup\.sequence_' \|\| new\.status/);
    assert.match(code, /'followup\.attempt_claimed'/);
    assert.match(code, /'followup\.attempt_' \|\| new\.outcome/);
  });
});

describe('C. the audit function was regenerated whole', () => {
  test('every branch of the previous copy survived, and only the new block was added', () => {
    const linesOf = (sql: string) => {
      const i = sql.indexOf('create or replace function audit.record_row_change');
      return sql
        .slice(i, sql.indexOf('$$;', i))
        .split('\n')
        .map((l) => l.replace(/--.*$/, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    };
    const mine = linesOf(migration);
    const prior = linesOf(previous);
    const at = mine.indexOf("when 'follow_up_sequences' then");
    assert.ok(at > 0, 'the new branch is missing from the regenerated function');
    const spliced = [...mine];
    spliced.splice(at, mine.length - prior.length);
    assert.deepEqual(spliced, prior);
  });
});
