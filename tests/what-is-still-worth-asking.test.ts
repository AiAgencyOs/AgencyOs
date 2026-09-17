import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * What is still worth asking — PM §4.1, §4.2, §6 PM-03; G-276.
 *
 * Two units each answered half of *"do not re-ask known details"*, and
 * **neither had a caller**.
 *
 * `resolveProjectContext` (G-252) says what Phase 1 already confirmed. Its
 * service function was dead: one occurrence in the whole repository, its own
 * definition. `projects.outstanding_client_requests` (G-266) says what is
 * still unsettled and which single item is the next question — and G-266's own
 * record said so at the time, deferring the surface to *"the one ADM-109 would
 * also feed"*. **That deferral was wrong.** ADM-109 is about how often to
 * chase a client; showing somebody the next question needs no cadence at all.
 *
 * Sixth instance of built-and-unreachable in this sweep.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const QUERIES = read('src/modules/projects/queries.ts');
const READER = QUERIES.slice(QUERIES.indexOf('What is still worth asking this client'));
const PAGE = read('app/(internal)/projects/[projectId]/page.tsx');
const MIGRATION = read('supabase/migrations/20260917220000_only_what_is_still_missing.sql');

describe('A. both halves are reachable now', () => {
  test('the page reads them through one query', () => {
    assert.match(PAGE, /readNextQuestions/);
    assert.match(PAGE, /const questions = await readNextQuestions\(projectId\)/);
    assert.match(READER, /rpc\('outstanding_client_requests', \{ p_project_id: projectId \}\)/);
    assert.match(READER, /await resolveProjectContext\(projectId, supabase\)/);
  });

  test('resolveProjectContext is no longer dead', () => {
    // The state the gap was: one occurrence in the repository, its own
    // definition. Counted rather than asserted by name, so re-deleting the
    // caller fails here.
    const service = read('src/modules/projects/service.ts');
    const occurrences =
      (service.match(/\bresolveProjectContext\b/g) ?? []).length +
      (QUERIES.match(/\bresolveProjectContext\b/g) ?? []).length;
    assert.ok(occurrences >= 3, `resolveProjectContext appears ${occurrences} times — it is dead again`);
  });
});

describe('B. one question at a time, chosen by the database', () => {
  test('the page does not pick the next question', () => {
    // "Outstanding" and "askable" are different — an item already asked and an
    // item they answered that nobody checked are both outstanding and neither
    // is a question. G-266 got that wrong in its own first draft.
    assert.match(PAGE, /questions\.outstanding\.find\(\(q\) => q\.askNext\)/);
    assert.doesNotMatch(PAGE, /status === 'pending'\)\[0\]|\.filter\(\(q\) => q\.status === 'pending'\)/);
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /nothing here picks it, because "outstanding" and "askable" are different/,
    );
  });

  test('and the rule it relies on is still in the migration', () => {
    // The positive twin: if `ask_next` stopped meaning "at most one", the page
    // would render several questions as "ask next".
    assert.match(MIGRATION, /limit 1\), false\) as ask_next/);
  });

  test('nothing askable is SAID, not left blank', () => {
    // Everything outstanding being with the client or with us is a real state
    // and a useful one. A blank reads as "nothing outstanding".
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /Nothing to ask right now — everything outstanding is either already with the client or waiting on somebody here to check it/,
    );
    assert.match(PAGE, /q\.withClient/);
    assert.match(PAGE, /q\.withUs/);
  });
});

describe('C. "no packet" and "nothing confirmed" are different answers', () => {
  test('a missing handoff packet is null, not an empty list', () => {
    // A project converted before G-250 has no packet. Saying "0 details
    // confirmed" would invite somebody to re-ask a client everything they
    // already said — the exact failure PM-03 exists to prevent.
    assert.match(READER, /known: context\.ok \? context\.data\.knownKeys\.map\(String\) : null/);
    assert.match(PAGE, /questions\.known === null \?/);
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /Inherited context is not available for this project — it has no WON handoff packet/,
    );
  });

  test('and the page says which of the two it is showing', () => {
    assert.match(
      PAGE.replace(/\n\s*/g, ' '),
      /Not "nothing was confirmed"\. A project converted before G-250 has no handoff packet/,
    );
  });

  test('but the outstanding read itself refuses on failure', () => {
    // The checklist read is not allowed to fail soft: an empty question list
    // reads as "nothing left to ask", which is a statement about the client.
    assert.match(READER, /if \(error\) unreadable\('readNextQuestions', error\)/);
  });
});

describe('D. it still does not send and still does not schedule', () => {
  test('nothing here messages anybody', () => {
    assert.doesNotMatch(READER, /send_outbound_message|dispatchMessage|conversation_messages/i);
    const block = PAGE.slice(PAGE.indexOf('G-276. PM §4.2'), PAGE.indexOf('<ol className="flex flex-col gap-1">'));
    assert.ok(block.length > 500, 'the block slice is wrong — the check would pass on nothing');
    assert.doesNotMatch(block, /sendAction|follow_up|whatsapp/i);
  });

  test('and no cadence is invented — ADM-109 is still the open question', () => {
    // G-266 raised it and refused to borrow another situation's rhythm. A
    // surface that showed "chase again in 3 days" would answer it by accident.
    // The BLOCK, not the page: `dueInDays` on the invoice form is a payment
    // term and has nothing to do with chasing a client for their assets.
    const block = PAGE.slice(PAGE.indexOf('G-276. PM §4.2'), PAGE.indexOf('<ol className="flex flex-col gap-1">'));
    assert.ok(block.length > 500, 'the block slice is wrong — the check would pass on nothing');
    assert.doesNotMatch(block, /\bdays\b|remind|chase again|follow up in/i);
    assert.match(MIGRATION, /ADM-109/);
  });
});
