import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import type { Role } from '../src/lib/auth/claims.ts';

/**
 * Commit the whole file at once — gap G-224.
 *
 * An operator who uploads a WhatsApp export lands on the batch preview and sees
 * an "Importable" count, then files those records ONE CLICK AT A TIME: the door
 * (`crm.commit_import_record`) takes one id. A file of hundreds is hundreds of
 * clicks to do a thing the operator decided once. This is the shape G-219 fixed
 * for enrolment, applied to the commit step that precedes it.
 *
 * Two layers, tested in the two ways they can be:
 *
 *   The SQL function's bounds and rule-reuse are read as source here and PROVED
 *   against a real Postgres by `db:verify:import`. A unit test has no database.
 *
 *   The app wrapper — `commitImportBatch()` — is EXECUTED, with only the
 *   database stubbed. It holds the capability check and the mapping from the
 *   database's verdict to a Result, and nothing else was running either.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260909130000_commit_the_whole_file_at_once.sql'));

describe('A. a ceiling, not a faucet', () => {
  test('there is a maximum the caller cannot raise', () => {
    assert.match(SQL, /c_max\s+constant int := 500/);
    assert.match(SQL, /least\(greatest\(coalesce\(p_limit, 100\), 1\), c_max\)/);
  });
});

describe('B. through the single-record door', () => {
  test('the batch goes through crm.commit_import_record rather than repeating its rules', () => {
    // The failure this gap's sibling (G-219) is an instance of: a rule in one
    // path and not the other. Idempotency, phone-keyed-only and the
    // no-timezone refusal all live in the single-record function.
    assert.match(SQL, /select c\.outcome into v_result from crm\.commit_import_record\(v_rec\) c/);
  });

  test('and it only ever offers a clean phone decision to that door', () => {
    // exact/new, auto_importable, phone not null — the same gate the
    // single-record function applies, so the loop never sees not_importable.
    assert.match(SQL, /r\.auto_importable/);
    assert.match(SQL, /r\.classification in \('exact', 'new'\)/);
    assert.match(SQL, /r\.phone is not null/);
  });
});

describe('C. it says what it did, and what it refused', () => {
  test('every outcome is counted', () => {
    assert.match(SQL, /committed\s+int,\s*\n\s*already\s+int,\s*\n\s*skipped\s+int,\s*\n\s*uncommitted\s+int,\s*\n\s*remaining\s+int/);
  });

  test('including the rows this action will never reach — the manual-review remainder', () => {
    // An operator reading "committed 40" needs to know the other sixty need a
    // human, not another pass.
    assert.match(SQL, /uncommitted/);
    assert.match(SQL, /not \(r\.auto_importable and r\.classification in \('exact', 'new'\) and r\.phone is not null\)/);
  });

  test('and how many auto-importable rows are left for the next pass', () => {
    assert.match(SQL, /remaining/);
  });

  test('the audit records the bound it actually used', () => {
    assert.match(SQL, /'import\.batch_committed'/);
    assert.match(SQL, /'limit', v_limit/);
  });
});

describe('D. it files, it never sends', () => {
  test('nothing here queues a job, emits an event, or sends', () => {
    assert.doesNotMatch(SQL, /insert into core\.jobs/);
    assert.doesNotMatch(SQL, /insert into core\.outbox_events/);
    assert.doesNotMatch(SQL, /send_outbound_message/);
  });

  test('and there is no pilot gate, because filing starts no campaign', () => {
    // The reactivation batch obeys ADM-87's gate; a commit files a contact and
    // a lead and starts nothing, so there is nothing for a gate to hold back.
    assert.doesNotMatch(SQL, /reactivation_pilot_enabled/);
    assert.doesNotMatch(SQL, /'pilot_off'/);
  });

  test('and the operator is told so in the words they read', () => {
    const actions = codeOnly(read('app/(internal)/import/actions.ts'));
    assert.match(actions, /No consent was set and nothing was sent/);
  });
});

describe('E. authority derived from the row, and the grant rides along', () => {
  test('owner or ops_admin of the batch’s own org, tenant never trusted from the caller', () => {
    assert.match(SQL, /core\.current_user_role\(\)\) not in \('owner', 'ops_admin'\)/);
    assert.match(SQL, /v_org is distinct from \(select core\.current_organization_id\(\)\)/);
  });

  test('revoke from public is followed by a grant, so the function stays callable', () => {
    // The G-184 lesson: revoke-from-PUBLIC also revokes service_role, so the
    // grant must ride along or a job can no longer call it.
    assert.match(SQL, /revoke all on function crm\.commit_import_batch\(uuid, int\) from public, anon/);
    assert.match(SQL, /grant execute on function crm\.commit_import_batch\(uuid, int\) to authenticated, service_role/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. The caller — executed, with only the database stubbed
//
// `commitImportBatch()` is not a pass-through. It decides who may ask, which
// function is asked, what bound rides along, and what every verdict the
// database can return means to the operator reading the screen. None of that
// is in the migration, so none of it is covered by reading the migration.
// ═══════════════════════════════════════════════════════════════════════════

const BATCH_ID = '44444444-4444-4444-8444-444444444444';

let role: Role = 'owner';
let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const seen = { schemas: [] as string[], rpcs: [] as [string, Record<string, unknown>][] };

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role,
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }),
  },
});

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema(name: string) {
        seen.schemas.push(name);
        return {
          rpc(fn: string, args: Record<string, unknown>) {
            seen.rpcs.push([fn, args]);
            return { then: (resolve: (v: typeof rpcOutcome) => unknown) => resolve(rpcOutcome) };
          },
        };
      },
    }),
  },
});

const { commitImportBatch } = await import('../src/lib/import/commit.ts');

/** One committed row, as the function's `returns table` shape delivers it. */
const committed = (over: Record<string, unknown> = {}) => ({
  data: [{ outcome: 'committed', committed: 40, already: 2, skipped: 1, uncommitted: 60, remaining: 17, ...over }],
  error: null,
});

beforeEach(() => {
  role = 'owner';
  rpcOutcome = { data: null, error: null };
  seen.schemas.length = 0;
  seen.rpcs.length = 0;
});

describe('F1. who may ask, decided before the database is troubled', () => {
  test('an id that is not a uuid is refused, and nothing is asked', async () => {
    const result = await commitImportBatch('the-whole-file');

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION');
    assert.equal(seen.rpcs.length, 0, 'a malformed id reached the database');
  });

  test('an ops_admin is refused by the app, though the database would admit them', async () => {
    // Deliberate asymmetry, and the reason it is worth executing: the SQL
    // admits owner OR ops_admin, the capability `organization.settings` is
    // the owner's alone, and the app is therefore the stricter of the two.
    // Reading either layer on its own reports the wrong answer.
    role = 'ops_admin';
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.rpcs.length, 0, 'a forbidden caller still reached the database');
  });

  test('a delivery lead is refused too', async () => {
    role = 'delivery_lead';
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.rpcs.length, 0);
  });

  test('the owner is let through to the batch function, in the crm schema', async () => {
    rpcOutcome = committed();
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, true);
    assert.deepEqual(seen.schemas, ['crm']);
    assert.equal(seen.rpcs.length, 1);
    assert.equal(seen.rpcs[0]?.[0], 'commit_import_batch');
    assert.equal(seen.rpcs[0]?.[1]?.p_batch_id, BATCH_ID);
  });
});

describe('F2. the bound the operator files in passes they can watch', () => {
  test('a caller who names no bound gets 100, not the database default', async () => {
    rpcOutcome = committed();
    await commitImportBatch(BATCH_ID);

    assert.equal(seen.rpcs[0]?.[1]?.p_limit, 100);
  });

  test('and a caller’s own bound is carried through untouched', async () => {
    rpcOutcome = committed();
    await commitImportBatch(BATCH_ID, 250);

    assert.equal(seen.rpcs[0]?.[1]?.p_limit, 250);
  });

  test('a bound above the ceiling is still sent — the database is what clamps it', async () => {
    // The app does not second-guess `c_max`. One place decides the ceiling,
    // and it is the place a job calling the function directly also passes.
    rpcOutcome = committed();
    await commitImportBatch(BATCH_ID, 9_000);

    assert.equal(seen.rpcs[0]?.[1]?.p_limit, 9_000);
  });
});

describe('F3. what came back, reported as what it was', () => {
  test('a committed batch reports all five counts', async () => {
    rpcOutcome = committed();
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.committed, 40);
    assert.equal(result.ok === true && result.data.already, 2);
    assert.equal(result.ok === true && result.data.skipped, 1);
    assert.equal(result.ok === true && result.data.uncommitted, 60);
    assert.equal(result.ok === true && result.data.remaining, 17);
  });

  test('counts that come back null read as zero rather than undefined', async () => {
    rpcOutcome = committed({ committed: null, already: null, skipped: null, uncommitted: null, remaining: null });
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.committed, 0);
    assert.equal(result.ok === true && result.data.already, 0);
    assert.equal(result.ok === true && result.data.skipped, 0);
    assert.equal(result.ok === true && result.data.uncommitted, 0);
    assert.equal(result.ok === true && result.data.remaining, 0);
  });

  test('a row delivered bare rather than in an array is still read', async () => {
    rpcOutcome = { data: { outcome: 'committed', committed: 3, already: 0, skipped: 0, uncommitted: 0, remaining: 0 }, error: null };
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.committed, 3);
  });
});

describe('F4. every refusal keeps its own name', () => {
  test('the database’s own refusal stays a refusal', async () => {
    rpcOutcome = { data: [{ outcome: 'forbidden' }], error: null };
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
  });

  test('a batch that does not exist is not found, not an internal fault', async () => {
    rpcOutcome = { data: [{ outcome: 'not_found' }], error: null };
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
  });

  test('an outcome nobody planned for fails, and names what came back', async () => {
    rpcOutcome = { data: [{ outcome: 'pilot_off' }], error: null };
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.match(result.ok === false ? result.error.message : '', /pilot_off/);
  });

  test('no row at all fails rather than reporting a batch of nothing committed', async () => {
    // The shape that matters: an empty answer must not become `committed: 0`,
    // which an operator reads as "there was nothing to file".
    rpcOutcome = { data: [], error: null };
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.match(result.ok === false ? result.error.message : '', /no answer/);
  });

  test('a transport error is never reported as a commit', async () => {
    rpcOutcome = { data: null, error: { message: 'connection reset' } };
    const result = await commitImportBatch(BATCH_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.ok === false ? result.error.message : '', /connection reset/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. The door the batch goes through — also executed
//
// `commit_import_batch` reuses `commit_import_record` precisely so a rule
// cannot be missing from the bulk path. That argument only holds if the door
// itself behaves, and `commitImportRecord()` had no test of any kind: not an
// execution, not a pin. Its refusals carry the two facts an operator most
// needs (a name is not enough; set your timezone first), and nothing was
// checking that either of them survives a refactor.
// ═══════════════════════════════════════════════════════════════════════════

const RECORD_ID = '55555555-5555-4555-8555-555555555555';

const { commitImportRecord } = await import('../src/lib/import/commit.ts');

/** One committed record, as `commit_import_record`'s row shape delivers it. */
const filed = (over: Record<string, unknown> = {}) => ({
  data: [{
    outcome: 'committed',
    contact_id: '66666666-6666-4666-8666-666666666666',
    lead_id: '77777777-7777-4777-8777-777777777777',
    messages_imported: 240,
    messages_skipped: 3,
    ...over,
  }],
  error: null,
});

describe('G1. the single-record door admits the same callers', () => {
  test('an id that is not a uuid is refused before the database', async () => {
    const result = await commitImportRecord('row-one');

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION');
    assert.equal(seen.rpcs.length, 0);
  });

  test('an ops_admin is refused here too, by the same capability', async () => {
    role = 'ops_admin';
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
    assert.equal(seen.rpcs.length, 0);
  });

  test('the owner reaches crm.commit_import_record with the row id', async () => {
    rpcOutcome = filed();
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, true);
    assert.deepEqual(seen.schemas, ['crm']);
    assert.equal(seen.rpcs[0]?.[0], 'commit_import_record');
    assert.equal(seen.rpcs[0]?.[1]?.p_record_id, RECORD_ID);
  });
});

describe('G2. what was filed, and how much history came with it', () => {
  test('a committed row reports its contact, its lead and its transcript counts', async () => {
    rpcOutcome = filed();
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.contactId, '66666666-6666-4666-8666-666666666666');
    assert.equal(result.ok === true && result.data.leadId, '77777777-7777-4777-8777-777777777777');
    assert.equal(result.ok === true && result.data.messagesImported, 240);
    assert.equal(result.ok === true && result.data.messagesSkipped, 3);
  });

  test('committing the same row twice succeeds rather than erroring — it is idempotent', async () => {
    // The database says `already_committed`; a second press must not look like
    // a failure to the operator, or they will press it a third time.
    rpcOutcome = filed({ outcome: 'already_committed' });
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.messagesImported, 240);
  });

  test('a row that imported none of its history says zero, not nothing', async () => {
    // G-218's fact: "0 of 240" has to be visible, because the agent will
    // otherwise be handed a lead with no conversation behind it.
    rpcOutcome = filed({ messages_imported: null, messages_skipped: null, contact_id: null, lead_id: null });
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.data.messagesImported, 0);
    assert.equal(result.ok === true && result.data.messagesSkipped, 0);
    assert.equal(result.ok === true && result.data.contactId, '');
    assert.equal(result.ok === true && result.data.leadId, '');
  });
});

describe('G3. each refusal carries the fact the operator needs', () => {
  test('a row keyed only by a name stays for manual review, and says why', async () => {
    rpcOutcome = { data: [{ outcome: 'not_importable' }], error: null };
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION');
    assert.match(result.ok === false ? result.error.message : '', /a name is not enough/);
  });

  test('no agency timezone names the setting that unblocks it', async () => {
    // G-137 + G-218: a WhatsApp export states no timezone, and the 24-hour
    // window is computed from these times. "Could not commit" would send the
    // operator looking in the wrong place.
    rpcOutcome = { data: [{ outcome: 'no_timezone' }], error: null };
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VALIDATION');
    assert.match(result.ok === false ? result.error.message : '', /timezone/i);
    assert.match(result.ok === false ? result.error.message : '', /Settings/);
  });

  test('the database’s own refusal stays a refusal', async () => {
    rpcOutcome = { data: [{ outcome: 'forbidden' }], error: null };
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'FORBIDDEN');
  });

  test('a row that does not exist is not found', async () => {
    rpcOutcome = { data: [{ outcome: 'not_found' }], error: null };
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_FOUND');
  });

  test('an unplanned outcome fails rather than reporting a filed row', async () => {
    rpcOutcome = { data: [{ outcome: 'pilot_off' }], error: null };
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
  });

  test('a transport error does not leak the database’s words to the screen', async () => {
    rpcOutcome = { data: null, error: { message: 'relation "crm.import_records" does not exist' } };
    const result = await commitImportRecord(RECORD_ID);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.ok === false ? result.error.message : '', /relation/);
  });
});
