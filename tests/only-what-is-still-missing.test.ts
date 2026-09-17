import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Only what is still missing — PM §4.2, §4.3, §6 PM-03 and PM-05.
 *
 * Three sentences across the specification say one thing: *"do not re-ask
 * known details"*, *"request only the first set of missing required
 * information"*, and *"ask one clear question/request at the appropriate
 * time."*
 *
 * The distinction this unit turns on — and got wrong first — is that
 * **outstanding is not the same as askable**. Three states are all unsettled
 * and only one of them is a question for the client.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260917220000_only_what_is_still_missing.sql');
const SQL = MIGRATION.replace(/^\s*--.*$/gm, '');
const PROSE = MIGRATION.replace(/\n\s*--\s?/g, ' ');

const fn = (() => {
  const start = SQL.indexOf('create or replace function projects.outstanding_client_requests');
  assert.ok(start > 0);
  return SQL.slice(start, SQL.indexOf('$$;', start));
})();

describe('A. outstanding is not the same as askable', () => {
  test('only `pending` is a question for the client', () => {
    assert.match(fn, /where o2\.status = 'pending'/);
  });

  test('`waiting_client` is outstanding and not asked again', () => {
    assert.match(fn, /oi\.status = 'waiting_client' as with_client/);
    // It is NOT excluded from the list — it is still missing.
    assert.doesNotMatch(fn, /status not in \([^)]*'waiting_client'/);
  });

  test('`received` is outstanding but waiting on US, so it is never re-asked', () => {
    // The bug this unit shipped in its first draft: a client offered the
    // question "please send your assets" for assets already sitting in the
    // thread. Found by driving it, not by reading it.
    assert.match(fn, /oi\.status = 'received' as with_us/);
    assert.match(PROSE, /The first draft of this function got `received` wrong and offered it as the\s+next question/);
    assert.match(PROSE, /a client being asked for assets they had already provided/);
  });

  test('and settled items are gone entirely', () => {
    assert.match(fn, /and oi\.status not in \('verified', 'not_applicable'\)/);
  });
});

describe('B. required, and only what is the client’s to answer', () => {
  test('optional items are not chased', () => {
    // ADM-06 says the checklist blocks nothing, and G-261 left `requirement`
    // null until somebody decides. An item nobody marked required is not a
    // thing to chase a client about.
    assert.match(fn, /and oi\.requirement = 'required'/);
    assert.match(PROSE, /an item nobody\s+marked required is not a thing to chase a client about/);
  });

  test('the agency’s own work is never a question for the client', () => {
    for (const key of [
      'kickoff_sent',
      'project_activated',
      'whatsapp_group_mapped',
      'payment_verified',
      'project_manager_assigned',
      'specialist_agents_assigned',
    ]) {
      assert.match(fn, new RegExp(`'${key}'`), `${key} could be asked of a client`);
    }
    // `payment_verified` most of all: proof never auto-verifies and Admin owns
    // it, so asking a client to confirm it would be asking them to do the one
    // thing they must not.
    assert.match(fn, /'payment_verified'/);
  });
});

describe('C. one question at a time, in the order the work happens', () => {
  test('at most one row is ask_next', () => {
    assert.match(fn, /limit 1\), false\) as ask_next/);
  });

  test('ordered by the checklist position, which is the order of the work', () => {
    assert.match(fn, /order by o2\.list_position, o2\.id limit 1/);
    assert.match(fn, /order by o\.list_position, o\.id;/);
    assert.match(PROSE, /roughly the order the work happens in/);
  });

  test('ask_next is FALSE when nothing is askable, never NULL', () => {
    // `id = NULL` is NULL, so a caller writing `not ask_next` would silently
    // drop every row instead of getting all of them.
    assert.match(fn, /coalesce\(o\.id = \(select o2\.id/);
    assert.match(PROSE, /A caller writing `not ask_next` would then\s+silently drop every row/);
  });

  test('`position` is aliased, because it is reserved', () => {
    // A bare `position` parses as POSITION(x IN y) — in a select list AND in
    // a RETURNS TABLE. Both cost an apply each to find.
    assert.match(fn, /oi\.position as list_position/);
    assert.match(SQL, /list_position int,/);
    assert.match(PROSE, /parsed as POSITION\(x IN\s+y\) here too, not only in a select list/);
  });
});

describe('D. it neither sends nor schedules, and says why', () => {
  test('nothing here messages anybody', () => {
    // The FUNCTION BODY. The `comment on function` says the words "follow-up
    // policy" in the sentence explaining why nothing is sent, and a check that
    // read that as sending would forbid the explanation.
    // Send MECHANISMS only. `whatsapp_group_mapped` is a checklist key this
    // function EXCLUDES, and `follow-up policy` appears in the sentence saying
    // why nothing is scheduled — a broader pattern reads both as sending.
    assert.doesNotMatch(fn, /send_outbound_message|dispatchMessage|conversation_messages|follow_up_sequences|whatsapp_templates/i);
    // The twin: that explanation is present, because its absence would leave
    // a reader thinking the omission was an oversight.
    assert.match(SQL, /It does not send and does not schedule/);
  });

  test('the missing cadence is raised, not invented', () => {
    // Every registered situation carries a rhythm somebody decided. None
    // covers onboarding, and `pending_payment` is already blocked for exactly
    // this reason.
    assert.match(PROSE, /there is no policy/);
    assert.match(PROSE, /ADM-109/);
    assert.match(PROSE, /Running it would mean inventing both/);
    // And NO rhythm is named anywhere. A red-proof that swapped the ADM for
    // "uses the sales_nurture rhythm" passed until this line existed: the
    // assertion above only checks that the question was raised, not that an
    // answer was not quietly assumed alongside it.
    assert.doesNotMatch(MIGRATION, /sales_nurture|sales_active|customer_success|internal_approval|meeting_missed/);
  });

  test('it reads and writes nothing', () => {
    assert.match(SQL, /language sql\s*\n\s*stable\s*\n\s*security invoker/);
    assert.doesNotMatch(fn, /insert into|update |delete from/i);
  });

  test('and it is not callable by the world', () => {
    assert.match(SQL, /revoke all on function projects\.outstanding_client_requests\(uuid\) from public, anon/);
    assert.match(SQL, /grant execute on function projects\.outstanding_client_requests\(uuid\) to authenticated, service_role/);
  });
});
