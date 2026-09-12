import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * A retry that books twice — gap G-227.
 *
 * P0, and the failure the Scheduler specification returns to more than any
 * other: §6.3 "Use idempotency to prevent duplicate bookings" and "Verify
 * provider response before reporting success"; §14 "Provider timeout → verify
 * actual provider state before retry → avoid double-booking"; Master
 * Development Plan V3 §19, where "worker crash during booking → second
 * booking created" is a HARD FAIL.
 *
 * The behaviour is proved against a real Postgres by `db:verify:booking`,
 * which is the only place a race can actually be run. What is here is the
 * shape of the three rules and the outcomes the door answers with — and the
 * arithmetic of the freshness bound, which is a pure function of its inputs
 * and is therefore executed rather than read.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260911150000_a_retry_that_books_twice.sql'));

describe('A. one attempt, one booking', () => {
  test('a booking key is unique per organization, so a retry cannot mint a second row', () => {
    assert.match(SQL, /create unique index if not exists meetings_booking_key\s*\n\s*on crm\.meetings \(organization_id, booking_key\)\s*\n\s*where booking_key is not null/);
  });

  test('every decision is made UNDER the lock — the idempotent answer included', () => {
    // The first draft answered the idempotent case before locking, "so a retry
    // is cheap". A retry racing the attempt it retried could not see that
    // attempt's uncommitted row, waited on the lock, then read the booked row
    // and was told 'wrong_state' about its own success. Cheap and wrong. Found
    // by review, and by the eight-way race in verify-booking.mjs, which that
    // draft could not have passed. So: the lock comes first, and the key check
    // reads the locked row.
    const lockAt = SQL.indexOf('for update');
    const keyCheckAt = SQL.indexOf('if v_row.booking_key = v_key then');

    assert.ok(lockAt > 0 && keyCheckAt > 0, 'lock or key check not found — the scan broke');
    assert.ok(lockAt < keyCheckAt, 'the idempotent answer is read before the lock is taken');
  });

  test('the same attempt on the same meeting answers already_booked, not an error', () => {
    // The caller asking twice is the caller having been unsure, which is the
    // situation the whole function exists for.
    assert.match(SQL, /if v_row\.booking_key = v_key then\s*\n\s*return query select 'already_booked'::text, v_row\.id/);
  });

  test('the same key on a DIFFERENT meeting is a caller bug, and is not hidden behind a success', () => {
    // Scoped by the ROW's organization, not by the caller's claim about theirs
    // — which is null for the service role.
    assert.match(SQL, /where m\.organization_id = v_row\.organization_id\s*\n\s*and m\.booking_key = v_key\s*\n\s*and m\.id <> v_row\.id/);
    assert.match(SQL, /return query select 'key_taken'::text, v_other/);
  });
});

describe('B. one external event, one meeting', () => {
  test('a provider event maps to exactly one meeting', () => {
    assert.match(SQL, /create unique index if not exists meetings_provider_event_key\s*\n\s*on crm\.meetings \(provider, provider_event_id\)/);
  });

  test('a booking that names a provider must name the event it created there', () => {
    // §6.3 / §14. "We think we created it" is the false success the
    // specification forbids.
    assert.match(SQL, /constraint meetings_booked_provider_is_evidenced check/);
    assert.match(SQL, /status <> 'booked'\s*\n\s*or provider is null\s*\n\s*or provider_event_id is not null/);
  });

  test('and the door says so by name rather than leaving it to the constraint', () => {
    assert.match(SQL, /return query select 'unverified_provider'::text/);
  });

  test('a null provider is the deployment with no calendar, not a provider that failed', () => {
    // BLK-005. The constraint deliberately admits it; the two are different
    // facts and collapsing them would refuse every booking in a deployment
    // that has no calendar to name.
    assert.match(SQL, /or provider is null/);
  });
});

describe('C. the re-check is a measurement, not a hope', () => {
  test('a booking cannot rest on an answer that was never read', () => {
    assert.match(SQL, /if v_row\.availability_read_at is null or v_row\.availability_source is null then\s*\n\s*return query select 'never_checked'::text/);
  });

  test('an answer older than the bound is refused rather than trusted', () => {
    assert.match(SQL, /availability_read_at < \(clock_timestamp\(\) - make_interval\(secs => v_staleness\)\)/);
    assert.match(SQL, /return query select 'stale_availability'::text/);
  });

  test('the caller names the bound and cannot raise it past the ceiling', () => {
    // A generous freshness is a slower way of not checking.
    assert.match(SQL, /c_max_staleness constant int := 900/);
    assert.match(SQL, /least\(greatest\(coalesce\(p_max_staleness_seconds, 300\), 1\), c_max_staleness\)/);
  });

  /**
   * The clamp, executed.
   *
   * `least(greatest(coalesce(x, 300), 1), 900)` is arithmetic, and arithmetic
   * can be run. Reading it proves the line is present; running it proves the
   * line does what the sentence above it claims — which is the difference the
   * pin ratio exists to push towards.
   */
  // The three constants are READ FROM THE MIGRATION, not chosen here: review
  // found the first draft asserting against a lambda of its own, which no
  // change to the SQL could ever fail. Now a different default, floor or
  // ceiling in `book_meeting` fails every line below.
  const bounds = /least\(greatest\(coalesce\(p_max_staleness_seconds,\s*(\d+)\),\s*(\d+)\),\s*c_max_staleness\)/.exec(SQL);
  const ceiling = /c_max_staleness\s+constant\s+int\s*:=\s*(\d+)/.exec(SQL);
  assert.ok(bounds && ceiling, 'the clamp expression and its ceiling constant are in book_meeting');
  const [DEFAULT_SECONDS, FLOOR, CEILING] = [Number(bounds![1]), Number(bounds![2]), Number(ceiling![1])];
  const clamp = (requested: number | null) => Math.min(Math.max(requested ?? DEFAULT_SECONDS, FLOOR), CEILING);

  test('the default is five minutes, and the ceiling is fifteen', () => {
    assert.equal(clamp(null), 300);
    assert.equal(clamp(900), 900);
    assert.equal(clamp(901), 900);
    assert.equal(clamp(86_400), 900, 'a day-old answer cannot be asked for');
  });

  test('and a caller asking for less gets less, down to one second', () => {
    assert.equal(clamp(60), 60);
    assert.equal(clamp(1), 1);
    assert.equal(clamp(0), 1, 'zero would mean "never fresh", which refuses everything');
    assert.equal(clamp(-5), 1);
  });
});

describe('D. only a live request becomes a booking', () => {
  test('a meeting that is already settled is not this attempt’s to overwrite', () => {
    assert.match(SQL, /if v_row\.status not in \('requested', 'proposed'\) then\s*\n\s*return query select 'wrong_state'::text/);
  });

  test('the write happens under the row lock, not after a separate read', () => {
    // The defect D1, D2 and D4 all were: a check and a write with a gap.
    assert.match(SQL, /for update;/);
    const afterLock = SQL.slice(SQL.indexOf('for update'));
    assert.match(afterLock, /update crm\.meetings\s*\n\s*set status\s*= 'booked'/);
  });

  test('an incomplete booking is refused before anything is written', () => {
    assert.match(SQL, /if p_start_at is null or p_end_at is null or p_timezone is null or p_mode is null then/);
    assert.match(SQL, /if p_end_at <= p_start_at then/);
  });

  test('an authenticated caller from another organization is refused on the row’s own tenant', () => {
    assert.match(SQL, /if v_actor is not null\s*\n\s*and v_row\.organization_id is distinct from \(select core\.current_organization_id\(\)\) then\s*\n\s*return query select 'forbidden'::text/);
  });

  test('and the service role — the worker whose retries this exists for — is not', () => {
    // core.current_organization_id() is NULL for a service-role JWT, so the
    // first draft's unconditional comparison answered 'forbidden' on every
    // worker call, including all twenty in verify-booking.mjs. The repository's
    // idiom is `v_actor := auth.uid()` and a guard only when it is set; every
    // other authority-gated function here does this, and now so does this one.
    // Found by review.
    assert.match(SQL, /v_actor\s+uuid := \(select auth\.uid\(\)\);/);
  });
});

describe('E. a lost race is an answer, not an exception', () => {
  test('both unique violations come back as named outcomes', () => {
    // Reaching here means two callers passed every check at once, which is
    // exactly the case an application pre-check cannot see.
    assert.match(SQL, /when unique_violation then/);
    assert.match(SQL, /meetings_provider_event_key%' then\s*\n\s*return query select 'event_taken'::text/);
  });

  test('the booking is audited with what it was decided against', () => {
    assert.match(SQL, /'meeting\.booked'/);
    assert.match(SQL, /'availability_read_at', v_row\.availability_read_at/);
  });

  test('the door is not reachable by anon or the public role', () => {
    assert.match(SQL, /revoke all on function crm\.book_meeting\([^)]*\) from public, anon/);
    assert.match(SQL, /grant execute on function crm\.book_meeting\([^)]*\) to authenticated, service_role/);
  });

  test('no outbox event type is declared, because nothing consumes one yet', () => {
    // G-106 from the registry end: a declared type with no emitter and no
    // subscriber is the object the next module wrongly reaches for. The Sales
    // reactivation that would consume this is G-229.
    assert.doesNotMatch(SQL, /insert into core\.event_types/);
  });
});
