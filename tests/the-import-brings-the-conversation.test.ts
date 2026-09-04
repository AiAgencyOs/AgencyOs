import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

/**
 * The import brings the conversation with it — gap G-218, decision ADM-92.
 *
 * `crm.commit_import_record` was documented as *"no consent, no send"*, and
 * that was right when it was written: a name and a number in a spreadsheet is
 * not permission to message anybody.
 *
 * But the import does not read a spreadsheet. It reads a WhatsApp export — a
 * transcript of these people writing to this agency — and then threw the
 * transcript away, keeping a count. So every imported lead arrived with no
 * consent and no history, ADM-70's chokepoint refused to send to them, and
 * `window_state` answered `never`. Twelve hundred leads, unreachable by a
 * design that was reading the wrong document.
 *
 * The behaviour is proved against a real Postgres by `verify-lead-import`
 * §10b, including that the consent's evidence is a line THEY sent. What is
 * here is the shape of the refusals, which are the half that must never
 * loosen.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260906160000_the_import_brings_the_conversation.sql'));

describe('A. what the import refuses to invent', () => {
  test('a transcript with no timezone is refused, never dated as UTC', () => {
    // A WhatsApp export states no timezone; the format has none. The 24-hour
    // window is computed from exactly these times, so a guess here would put
    // twelve hundred people on a timeline nobody wrote.
    assert.match(SQL, /if v_tz is null or btrim\(v_tz\) = '' then[\s\S]{0,120}?'no_timezone'/);
  });

  test('and a record with NO transcript still commits, because a lead needs no timeline', () => {
    assert.match(SQL, /if v_staged > 0 then[\s\S]{0,400}?select o\.timezone/);
  });

  test('messages are dated when they were written, not when they were imported', () => {
    assert.match(SQL, /im\.occurred_at_local at time zone v_tz/);
    // The failure this forbids: `now()` would make every imported lead's
    // window read OPEN, and every free-text send to them would earn a 400.
    const insert = SQL.slice(SQL.indexOf('insert into crm.conversation_messages'), SQL.indexOf('get diagnostics v_written'));
    assert.doesNotMatch(insert, /now\(\)/);
  });

  test('a live thread wins — an export is never interleaved into one', () => {
    assert.match(SQL, /if v_existing = 0 then/);
  });

  test('and the import still queues no job', () => {
    assert.doesNotMatch(SQL, /insert into core\.jobs/);
    assert.doesNotMatch(SQL, /insert into core\.outbox_events/);
  });
});

describe('B. whose message is whose', () => {
  test('theirs is the client, ours is the agent', () => {
    // The attribution consent rests on. Flipping it leaves the transcript
    // looking plausible and infers consent from the AGENCY'S own words.
    assert.match(SQL, /case when im\.direction = 'inbound' then 'client' else 'agent' end/);
  });

  test('an imported outbound message is never authored by a person', () => {
    // 'user' would name somebody who never typed it in this system.
    const insert = SQL.slice(SQL.indexOf('insert into crm.conversation_messages'), SQL.indexOf('get diagnostics v_written'));
    assert.doesNotMatch(insert, /'user'/);
  });

  test('and provenance travels with every line', () => {
    assert.match(SQL, /'import:' \|\| p_record_id::text \|\| ':' \|\| im\.ordinal::text/);
  });
});

describe('C. what the staging refuses', () => {
  const upload = codeOnly(read('src/lib/import/upload.ts'));

  test('a GROUP export stages no transcript at all', () => {
    // "Not theirs" is not "ours" when five people are in the room, and
    // inventing a sender is the fabrication ADM-76 forbids.
    assert.match(upload, /if \(!parsed\.meta\.isGroup && staged\.length > 0\)/);
  });

  test('a message with no resolvable timestamp is dropped, not dated', () => {
    assert.match(upload, /messages\.filter\(\(m\) => m\.at !== null/);
  });

  test('and one export cannot carry an unbounded history', () => {
    assert.match(upload, /TRANSCRIPT_CAP/);
    // The NEWEST are kept: a re-engagement written from a three-year-old
    // opening line would be a stranger quoting a stranger.
    assert.match(upload, /usable\.slice\(Math\.max\(0, usable\.length - TRANSCRIPT_CAP\)\)/);
  });
});

describe('D. the record says what changed', () => {
  test('the lead summary no longer claims no consent is implied', () => {
    // It used to say "No consent implied", and with the transcript imported
    // that is not what happens. A sentence that contradicts the row beside it
    // is worse than no sentence.
    assert.doesNotMatch(SQL, /No consent implied/);
  });

  test('and the commit reports how much history came with it', () => {
    assert.match(SQL, /messages_imported int, messages_skipped int/);
  });
});
