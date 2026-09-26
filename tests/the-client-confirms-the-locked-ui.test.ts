import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The client confirms, and only then is it locked — Impl §7.2; Master's
 * locked objective steps 13/14/19/20/21.
 *
 * The assertions that matter most: this is a bespoke append-only log (the
 * proven `client_design_decisions` shape), not the untested generic
 * `approvals` client-audience path; sharing, deciding and locking are three
 * separate doors because Master's own numbered flow keeps them separate; and
 * a locked version is structurally frozen, not merely labelled.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260923140000_the_client_confirms_the_locked_ui.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');

const doorFor = (name: string) => {
  const start = SQL.indexOf(`create or replace function projects.${name}`);
  assert.ok(start > 0, `${name} not found`);
  return SQL.slice(start, SQL.indexOf('$$;', start));
};

const shareDoor = doorFor('share_ui_version_with_client');
const decisionDoor = doorFor('record_ui_version_client_decision');
const lockDoor = doorFor('lock_ui_version');

describe('A. a bespoke proven log, not the untested generic engine', () => {
  test('it is not built on approvals.approval_requests', () => {
    assert.doesNotMatch(SQL, /approvals\.request_approval|approvals\.decide_approval|audience/);
  });

  test('and the migration says why', () => {
    assert.match(PROSE, /never once exercised by\s+a real caller anywhere in this codebase/);
  });

  test('only two decisions, not Phase 3\'s six', () => {
    assert.match(SQL, /decision\s+text not null check \(decision in \('change_requested', 'final_confirmed'\)\)/);
  });

  test('verbatim client words are required, the same rule client_design_decisions keeps', () => {
    assert.match(SQL, /client_words\s+text not null check \(length\(btrim\(client_words\)\) between 1 and 4000\)/);
  });
});

describe('B. append-only — a decision is a fact, never edited', () => {
  test('update and delete are both refused by trigger', () => {
    assert.match(SQL, /before update or delete on projects\.ui_version_client_decisions/);
    assert.match(SQL, /never edited or removed/);
  });

  test('no write policy either — RLS forced, select only', () => {
    assert.match(SQL, /alter table projects\.ui_version_client_decisions force row level security/);
    assert.doesNotMatch(SQL, /create policy ui_version_client_decisions_(insert|update|delete)/);
  });
});

describe('C. three separate doors for three separate acts', () => {
  test('sharing only moves admin_approved to client_review', () => {
    assert.match(shareDoor, /if v_version\.status <> 'admin_approved' then/);
    assert.match(shareDoor, /set status = 'client_review'/);
  });

  test('a decision is accepted from client_review OR client_change — the second round is ordinary', () => {
    assert.match(decisionDoor, /if v_version\.status not in \('client_review', 'client_change'\) then/);
  });

  test('final_confirmed and change_requested map to two different, named states', () => {
    assert.match(decisionDoor, /when 'final_confirmed'\s*then 'client_approved'/);
    assert.match(decisionDoor, /when 'change_requested'\s*then 'client_change'/);
  });

  test('locking only accepts a client_approved version', () => {
    assert.match(lockDoor, /if v_version\.status <> 'client_approved' then/);
    assert.match(lockDoor, /set status = 'locked'/);
  });

  test('a repeated lock is idempotent, not an error', () => {
    assert.match(lockDoor, /if v_version\.status = 'locked' then/);
    assert.match(lockDoor, /'already_locked'::text, v_version\.id/);
  });
});

describe('D. locked is structurally frozen, not merely labelled', () => {
  test('the freeze trigger exists and covers every update', () => {
    assert.match(SQL, /create or replace function projects\.freeze_locked_ui_version/);
    assert.match(SQL, /if old\.status = 'locked' then/);
    assert.match(SQL, /create trigger freeze_locked_ui_version\s*\n\s*before update on projects\.ui_versions/);
  });

  test('and the migration says why this arrives now, not earlier', () => {
    assert.match(
      PROSE,
      /a lock with nothing enforcing it is a label, not a lock/,
    );
  });
});

describe('E. these are person-driven acts, not job-triggered doors', () => {
  test('none of the three doors allow a service-role, no-actor caller', () => {
    for (const door of [shareDoor, decisionDoor, lockDoor]) {
      assert.match(door, /if v_actor is null then\s*\n\s*return query select 'no_actor'/);
      assert.doesNotMatch(door, /auth\.role\(\) is distinct from 'service_role'/);
    }
  });

  test('all three are authenticated-only, never service_role or anon', () => {
    assert.match(SQL, /grant execute on function projects\.share_ui_version_with_client\(uuid, text\) to authenticated;/);
    assert.match(SQL, /grant execute on function projects\.record_ui_version_client_decision\(uuid, text, text, text, uuid\) to authenticated;/);
    assert.match(SQL, /grant execute on function projects\.lock_ui_version\(uuid\) to authenticated;/);
  });
});

describe('F. the guards every table and door in this repository carries', () => {
  test('tenancy on the log table', () => {
    assert.match(SQL, /core\.enforce_parent_org\('project_id', 'projects\.projects'\)/);
    assert.match(SQL, /core\.enforce_parent_org\('ui_version_id', 'projects\.ui_versions'\)/);
  });

  test('every door is security definer, coalesced can_write, no fail-open', () => {
    for (const door of [shareDoor, decisionDoor, lockDoor]) {
      assert.match(door, /not coalesce\(\(select core\.can_write\(\)\), false\)/);
      assert.doesNotMatch(door, /not\s+\(\s*select\s+core\.can_write\s*\(/);
    }
  });

  test('not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.share_ui_version_with_client\(uuid, text\) from public, anon/);
    assert.match(SQL, /revoke all on function projects\.record_ui_version_client_decision\(uuid, text, text, text, uuid\) from public, anon/);
    assert.match(SQL, /revoke all on function projects\.lock_ui_version\(uuid\) from public, anon/);
  });

  test('every door audits and announces inside its own transaction', () => {
    for (const door of [shareDoor, decisionDoor, lockDoor]) {
      assert.match(door, /perform core\.record_audit\(/);
      assert.match(door, /perform core\.emit_event\(/);
    }
  });
});

describe('G. the revision loop is named as not built, not silently skipped', () => {
  test('the migration says so explicitly', () => {
    assert.match(PROSE.toLowerCase(), /the revision loop is not built here/);
    assert.match(PROSE, /`ui_revision_count`\/`ui_revision_limit` columns exist for exactly this and\s+remain unread/);
  });
});
