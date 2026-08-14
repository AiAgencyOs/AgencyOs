import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Seven kinds that were not notes — gap G-126.
 *
 * `audit.record_row_change` named every `crm.lead_activities` row
 * `lead.note_added` whatever its kind, so an assignment, a logged call, an
 * inbound message and an agent run were all filed as notes — in
 * `audit.audit_log`, the record that exists to be trusted. G-010 fixed the six
 * kinds it added and left the seven that came before, raising this gap rather
 * than widening that change.
 *
 * The tests worth having are the ones a later edit would quietly break: that
 * every admitted kind has a name, that no two events share one, and that the
 * fallback which produced the original defect has not come back.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const migration = read('../supabase/migrations/20260814120005_seven_kinds_that_were_not_notes.sql');
const g010 = read('../supabase/migrations/20260814120000_the_six_the_pipeline_let_go.sql');

/**
 * The branch under test, isolated so assertions cannot match prose elsewhere.
 *
 * Bounded by the *next* arm rather than by the first `end;`, which closes the
 * inner `case new.kind` and leaves the rest of the arm outside — the first
 * draft of this file did that and reported a difference that was its own.
 */
const ARM_ENDS = "when 'requirement_versions' then";
const armIn = (sql: string) => {
  const start = sql.indexOf("when 'lead_activities' then");
  const end = sql.indexOf(ARM_ENDS, start);
  assert.ok(start > 0 && end > start, 'the lead_activities arm could not be located');
  return sql.slice(start, end);
};
const branch = armIn(migration);

describe('A. each of the seven is recorded as what it is', () => {
  const expected = {
    note: 'lead.note_added',
    status_change: 'lead.status_change_logged',
    message_in: 'lead.message_in',
    message_out: 'lead.message_out',
    call: 'lead.call_logged',
    agent_run: 'lead.agent_run_logged',
    assignment: 'lead.assigned',
  } as const;

  for (const [kind, action] of Object.entries(expected)) {
    test(`${kind} audits as ${action}`, () => {
      assert.match(
        branch,
        new RegExp(`when '${kind}'\\s+then '${action.replace(/\./g, '\\.')}'`),
        `${kind} is not audited as ${action}`,
      );
    });
  }

  test('only note keeps the name all seven used to share', () => {
    // The defect was one name for seven events. If a second kind maps back to
    // `lead.note_added` the defect has partially returned, and every other
    // assertion here would still pass.
    const noteAdded = [...branch.matchAll(/then 'lead\.note_added'/g)];
    assert.equal(noteAdded.length, 1, 'more than one kind is still audited as a note');
  });
});

describe('B. two events may not share one action name', () => {
  test('status_change is not lead.status_changed, which leads already produce', () => {
    // The `leads` branch emits `lead.status_changed` when the lead's own status
    // moves. An activity *recording* a status change is a different event, and
    // one name for both would leave a reader unable to tell which happened —
    // a worse defect than the one being fixed.
    assert.match(branch, /when 'status_change' then 'lead\.status_change_logged'/);
    assert.ok(
      !/when 'status_change'\s+then 'lead\.status_changed'/.test(branch),
      'the activity reuses the name the lead branch already emits',
    );
    // And the name really is taken: the leads arm reaches it from a status
    // diff, so this is a collision avoided rather than a hypothetical one.
    assert.match(
      migration,
      /new\.status is distinct from old\.status then 'lead\.status_changed'/,
    );
  });

  test('and no action name is produced by two different branches', () => {
    const actions = [...migration.matchAll(/then '([a-z_]+\.[a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((a): a is string => a !== undefined);
    const seen = new Map<string, number>();
    for (const a of actions) seen.set(a, (seen.get(a) ?? 0) + 1);
    const shared = [...seen].filter(([, n]) => n > 1).map(([a]) => a);
    assert.deepEqual(shared, [], `these action names are produced more than once: ${shared.join(', ')}`);
  });
});

describe('C. the fallback is gone, which is how the defect happened', () => {
  test('no else clause absorbs an unnamed kind', () => {
    // A default that quietly files anything unrecognised as a note is exactly
    // how the first seven came to be wrong. Removing it means a fourteenth
    // kind is a loud failure at the first write rather than a silent lie in
    // the log that nobody notices until an audit.
    assert.ok(
      !/else 'lead\.[a-z_]+'/.test(branch),
      'a fallback action has returned to the lead_activities branch',
    );
    assert.match(branch, /else null/);
    assert.match(branch, /raise exception 'audit\.record_row_change: no action for lead_activities\.kind/);
  });

  test('and every kind the CHECK admits has a name', () => {
    // The two lists are in different files and nothing but this test holds
    // them together. Widening `kind` without adding a branch now fails here
    // rather than at the first insert in production.
    const check = g010.match(/kind[\s\S]{0,200}?check \(kind in \(([\s\S]*?)\)\)/);
    assert.ok(check, 'the kind CHECK could not be located');
    const admitted = [...(check[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    assert.equal(admitted.length, 13, `expected thirteen kinds, found ${admitted.length}`);

    for (const kind of admitted) {
      assert.match(
        branch,
        new RegExp(`when '${kind}'\\s+then`),
        `the kind "${kind}" is admitted by the CHECK but has no audit action`,
      );
    }
  });
});

describe('D. the rest of the function is the live definition, untouched', () => {
  test('every other branch survived the regeneration', () => {
    // An earlier change in this repository regenerated this same function from
    // an older copy and silently dropped the `proposals` branch, which would
    // have made every proposal write raise. Typecheck, lint and tests all
    // passed, because the failure was absence rather than error.
    for (const marker of [
      "when 'proposals' then",
      "'proposal.drafted'",
      "when 'leads' then",
      "when 'projects' then",
      'security invoker',
      'new.qualification is distinct from old.qualification',
    ]) {
      assert.ok(migration.includes(marker), `the live audit function lost: ${marker}`);
    }
  });

  test('and the branch is the only thing that differs from G-010s copy', () => {
    // Compared structurally rather than by eye: strip comments and whitespace,
    // cut the lead_activities branch out of both, and the remainder must be
    // identical. This is the assertion that would have caught the dropped
    // proposals branch.
    const bodyOf = (sql: string) => {
      const i = sql.indexOf('create or replace function audit.record_row_change');
      const fn = sql.slice(i, sql.indexOf('$$;', i));
      return fn
        .replace(armIn(fn), '')
        .split('\n')
        .map((l) => l.replace(/--.*$/, '').trim())
        .filter(Boolean)
        .join('\n');
    };
    assert.equal(bodyOf(migration), bodyOf(g010));
  });
});
