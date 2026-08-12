import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Audit finding D19 — two concurrent first sign-ins could both become owner.
 *
 * `core.bootstrap_first_owner` counted memberships, counted organizations,
 * then inserted, with nothing held across the three:
 *
 *     select count(*) from core.memberships    →  0
 *     select count(*) from core.organizations  →  1
 *     insert into core.memberships … 'owner'
 *
 * The `on conflict (organization_id, user_id)` clause dedupes the *same* user
 * retrying; it says nothing about two different ones. Measured against the
 * unfixed function with eight simultaneous callers, **all eight** were
 * provisioned as owner in four rounds out of five.
 *
 * `owner` is the top of the matrix in permissions.ts — the only role holding
 * proposal.approve, refund.issue, agent.configure and organization.settings —
 * and nothing in the application demotes a membership, so it is permanent.
 *
 * The rule now lives where it can hold: an advisory transaction lock taken
 * before the first read. This file asserts the SQL that Postgres actually
 * runs, because there is nothing here to call — the decision is three
 * statements inside a `security definer` function. The behaviour is proved
 * concurrently against a real database in scripts/verify-first-owner.mjs.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFileSync(new URL(relative, new URL(root, 'file:')), 'utf8');

const migration = read('supabase/migrations/20260812120005_first_owner_serialized.sql');

/** The executable SQL, so a comment can never satisfy an assertion. */
const executable = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

/** The function body between `as $$` and `$$;`. */
const body = (() => {
  const from = executable.indexOf('as $$');
  const to = executable.indexOf('$$;', from);
  assert.ok(from > 0 && to > from, 'the migration no longer defines a function body');
  return executable.slice(from, to);
})();

/** An index that is a real position, or the assertion fails saying which. */
function at(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  assert.ok(index >= 0, `missing: ${needle}`);
  return index;
}

// ═══════════════════════════════════════════════════════════════════════════
// A. The lock
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the decision is serialised', () => {
  test('an advisory lock is taken', () => {
    assert.match(body, /pg_advisory_xact_lock/);
  });

  test('the count that decides is re-read after the lock', () => {
    // The whole finding. A lock is worth nothing unless the decision is taken
    // again inside it: the count from before the lock may have been made
    // false by the transaction that held it.
    const lock = at(body, 'pg_advisory_xact_lock');
    const counts = [...body.matchAll(/count\(\*\) into v_member_count/g)].map((m) => m.index ?? -1);

    assert.equal(counts.length, 2, 'the membership count is not double-checked');
    assert.ok(counts[0]! < lock, 'the cheap pre-lock read is gone');
    assert.ok(counts[1]! > lock, 'the deciding count is still taken outside the lock');
  });

  test('and nothing is written outside it', () => {
    assert.ok(
      at(body, 'insert into core.memberships') > at(body, 'pg_advisory_xact_lock'),
      'the insert can happen without holding the lock',
    );
    assert.ok(at(body, 'count(*) into v_org_count') > at(body, 'pg_advisory_xact_lock'));
  });

  test('the pre-lock read is a fast path, not an authority', () => {
    // It exists so that every sign-in after the first does not queue on one
    // global key — ensureProvisioned calls this on every callback, forever,
    // and `execute` is granted to `authenticated`. Being wrong there can only
    // mean failing to return early, which falls through to the locked path.
    const lock = at(body, 'pg_advisory_xact_lock');
    const firstReturn = at(body, 'return null;');
    assert.ok(firstReturn < lock, 'the early decline no longer short-circuits before the lock');
  });

  test('it is transaction-scoped, not session-scoped', () => {
    // A session lock would not survive transaction-mode connection pooling,
    // and every caller arrives through PostgREST. It would also have to be
    // released by hand, including on error.
    assert.match(body, /pg_advisory_xact_lock/);
    assert.doesNotMatch(body, /pg_advisory_lock\s*\(/);
    assert.doesNotMatch(body, /pg_advisory_unlock/);
  });

  test('the key is derived from the function name rather than a bare number', () => {
    // So it cannot silently collide with a lock taken later for another
    // reason, and so the number does not have to be documented separately.
    assert.match(body, /hashtext\('core\.bootstrap_first_owner'\)/);
  });

  test('it is schema-qualified, because search_path is empty', () => {
    assert.match(body, /pg_catalog\.pg_advisory_xact_lock/);
    assert.match(body, /pg_catalog\.hashtext/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The rule it protects is unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('B. the guard still says what it said', () => {
  test('zero memberships and exactly one organization', () => {
    assert.match(body, /if v_member_count > 0 then/);
    assert.match(body, /if v_org_count <> 1 then/);
  });

  test('it still returns null when it declines, rather than raising', () => {
    // Three now: the fast path, the re-check under the lock, and the
    // organization guard. ensureProvisioned reads null as "already
    // provisioned, nothing to do"; raising would surface a sign-in error for
    // a user whose only problem is that somebody else got there first.
    assert.equal((body.match(/return null;/g) ?? []).length, 3);
    assert.doesNotMatch(body, /raise exception/);
  });

  test('the role granted is still owner, active', () => {
    assert.match(body, /values \(v_org_id, p_user_id, 'owner', 'active'\)/);
  });

  test('the unique constraint is still named as the last line', () => {
    assert.match(body, /on conflict \(organization_id, user_id\) do nothing/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// C. Nothing else about the function moved
// ═══════════════════════════════════════════════════════════════════════════

describe('C. the security context is untouched', () => {
  test('still SECURITY DEFINER with an empty search_path', () => {
    // Definer because it must read and write tables the caller has no claims
    // for — that is the deadlock it exists to break.
    assert.match(executable, /security definer/);
    assert.match(executable, /set search_path = ''/);
  });

  test('still revoked from public and anon', () => {
    assert.match(
      executable,
      /revoke all on function core\.bootstrap_first_owner\(uuid\) from public, anon/,
    );
    assert.match(
      executable,
      /grant execute on function core\.bootstrap_first_owner\(uuid\) to authenticated, service_role/,
    );
  });

  test('it changes no table, column, index or constraint', () => {
    assert.doesNotMatch(executable, /create table|alter table|drop table|create index|drop index/);
  });

  test('and it does not redefine the public wrapper', () => {
    // One line of `select core.bootstrap_first_owner(...)`, so it inherits the
    // lock without knowing about it. Redefining it here would be a second
    // place to keep in step for no gain.
    assert.doesNotMatch(executable, /create or replace function public\.bootstrap_first_owner/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The caller's contract
// ═══════════════════════════════════════════════════════════════════════════

describe('D. ensureProvisioned still reads the answer the same way', () => {
  const service = read('src/modules/identity/service.ts');

  test('a null return is treated as "declined", not as a failure', () => {
    assert.match(service, /if \(!organizationId\) return;/);
  });

  test('and a provisioned user still gets a refreshed token', () => {
    // The membership now exists but the token was minted before it did, so
    // without this the brand-new owner is greeted with /no-access.
    const from = at(service, 'if (!organizationId) return;');
    assert.match(service.slice(from, from + 900), /refreshSession\(\)/);
  });
});
