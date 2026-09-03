import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import { SUBSCRIPTIONS, HANDLER_JOB_KIND } from '../src/lib/events/catalog.ts';
import { conversationSummarySchema } from '../src/modules/crm/schema.ts';

/**
 * The thread remembers its beginning — G-198 (Doc 05 §6, audit LM-07).
 *
 * ── the one that is a bug ─────────────────────────────────────────────────
 *
 * The reply read the conversation as `order('seq', ascending).limit(1000)` —
 * the OLDEST thousand messages. Past that length the agent was handed the
 * beginning of the thread and never saw the end of it, **including the
 * message it was queued to answer**. Silent and total. No thread here has
 * reached a thousand yet, which is the only reason nothing has caught it.
 *
 * ── the one Doc 05 §6 names ───────────────────────────────────────────────
 *
 * Fixing the order alone trades one end for the other: a window loses a
 * beginning, and a long negotiation's beginning is where the client said what
 * they were building and why. So the transcript starts where a rolling
 * summary stops — no overlap, and no hole, by construction.
 *
 * ── and what the summary is not ───────────────────────────────────────────
 *
 * It is internal context, never sent. It is one model's reading, which is
 * exactly why it carries `through_seq`: everything after that point the agent
 * reads verbatim. The summary can only ever be wrong about the distant past,
 * and the recent past — the part a reply turns on — is never summarised.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const MIGRATION = sqlCode(read('supabase/migrations/20260904140000_the_thread_remembers_its_beginning.sql'));

describe('A. the bug: the window bites at the OLD end now', () => {
  test('every transcript reader anchors on the newest message', () => {
    // Three readers, and the shape they must all have: descending order with
    // the limit, then reversed for the model. An ascending read with a limit
    // is the defect, wherever it appears.
    // Exactly one bounded transcript read may be ordered oldest-first, and it
    // is the summariser's — which reads the OLD end on purpose, bounded above
    // by `throughSeq`. Every other one must anchor on the newest message, or
    // it loses the message it was queued to answer.
    const bounded = [...WORKFLOWS.matchAll(/([\s\S]{0,120})\.order\('seq', \{ ascending: true \}\)\s*\.limit\(MAX_EXTRACTION_MESSAGES\)/g)];
    assert.equal(bounded.length, 1, 'only the summariser may read a bounded transcript oldest-first');
    assert.match(bounded[0]![1]!, /\.lte\('seq', throughSeq\)/, 'and only because it is bounded above');
  });

  test('and the reply reverses what it read, so the model sees a conversation', () => {
    assert.match(WORKFLOWS, /const rows = \(recent \?\? \[\]\)\.slice\(\)\.reverse\(\);/);
  });

  test('the SUMMARISER is the exception, and deliberately so', () => {
    // It reads the OLD end on purpose — everything up to the boundary — so it
    // is bounded ascending with an upper bound rather than newest-anchored.
    assert.match(WORKFLOWS, /\.lte\('seq', throughSeq\)\s*\.order\('seq', \{ ascending: true \}\)/);
  });
});

describe('B. no hole between the two halves', () => {
  test('the transcript starts exactly where the summary stops', () => {
    assert.match(WORKFLOWS, /\.gt\('seq', earlier\?\.through_seq \?\? -1\)/);
  });

  test('no summary means the whole thread — INCLUDING the message at seq zero', () => {
    /**
     * The sentinel is `-1`, and `0` was a bug that shipped for about an hour.
     *
     * `crm.ingest_whatsapp_message` numbers the first message of a
     * conversation `coalesce(max(seq), -1) + 1`, so **seq zero is a real
     * message** — the first thing the client ever said, which is usually why
     * they are here. A sentinel of 0 dropped it from every un-summarised
     * thread, silently.
     *
     * Found by a red-proof: the live twin that asserts the summarised half is
     * not ALSO pasted in verbatim was passing with the summary disabled,
     * which it could only do if the first message was missing for another
     * reason.
     */
    assert.match(WORKFLOWS, /earlier\?\.through_seq \?\? -1/);
    assert.ok(!WORKFLOWS.includes('through_seq ?? 0'), 'seq zero is a message, not an absence');
  });

  test('and the summary is labelled as a colleague’s note, not the client’s words', () => {
    // A model handed a paraphrase and told nothing would quote it back to the
    // client as something they said.
    assert.match(WORKFLOWS, /a colleague's note, not the client's words/);
  });

  test('a failed summary read answers from the window alone rather than refusing', () => {
    // A client waiting on an answer is not served by refusing to write one.
    assert.match(WORKFLOWS, /scope: 'reply\.summary'/);
    assert.match(WORKFLOWS, /const earlier = summaryError \? null : summaryRow;/);
  });
});

describe('C. the summariser costs nothing when there is nothing to do', () => {
  test('it subscribes to every message, and settles before any model call', () => {
    assert.deepEqual(SUBSCRIPTIONS['message.received'], [
      'sales:readIntent',
      'sales:readQualification',
      'sales:summariseThread',
    ]);
    assert.equal(HANDLER_JOB_KIND['sales:summariseThread'], 'conversation.summarise');
  });

  test('a short thread is answered without reading anything but a count', () => {
    const stand = WORKFLOWS.indexOf('the thread still fits in the window');
    const model = WORKFLOWS.indexOf('const call = await callModel', WORKFLOWS.indexOf('const THREAD_SUMMARY'));
    assert.ok(stand > 0 && model > stand, 'the short-thread exit must come before the model call');
  });

  test('and a summary that is nearly current is left alone', () => {
    assert.match(WORKFLOWS, /throughSeq - existing\.through_seq < SUMMARISE_EVERY/);
  });

  test('the thresholds leave the recent window unsummarised by construction', () => {
    const window = /const REPLY_WINDOW = (\d+);/.exec(WORKFLOWS);
    const after = /const SUMMARISE_AFTER = (\d+);/.exec(WORKFLOWS);
    assert.ok(window && after);
    assert.ok(Number(after![1]) > Number(window![1]), 'a thread is only summarised once it exceeds the window');
  });

  test('a failed read of the existing summary retries rather than rewriting from nothing', () => {
    // Rewriting would pay for what the agency already has — and could move
    // `through_seq` backwards behind a summary that had read more.
    assert.match(WORKFLOWS, /could not read the existing summary/);
  });
});

describe('D. the summary only ever moves forward', () => {
  test('the database refuses one that has read less of the thread', () => {
    assert.match(MIGRATION, /if new\.through_seq < old\.through_seq then/);
    assert.match(MIGRATION, /cannot replace one that has read more/);
  });

  test('and losing that race is a SUCCESS, not a failure', () => {
    // The later summary is the better one and it is already written; failing
    // would retry forever to lose the same race again.
    assert.match(WORKFLOWS, /a newer summary already covers more of this thread/);
    assert.match(WORKFLOWS, /superseded: true/);
  });

  test('one row per conversation, replaced — nobody reads the third-newest', () => {
    assert.match(MIGRATION, /conversation_id\s+uuid primary key references crm\.conversations\(id\) on delete cascade/);
    assert.match(WORKFLOWS, /\{ onConflict: 'conversation_id' \}/);
  });

  test('and it carries the tenancy pair every table in this schema carries', () => {
    assert.match(MIGRATION, /core\.enforce_parent_org\('conversation_id', 'crm\.conversations'\)/);
    assert.match(MIGRATION, /core\.freeze_organization_id\(\)/);
    assert.match(MIGRATION, /alter table crm\.conversation_summaries force row level security/);
  });
});

describe('E. what a summary may say', () => {
  test('bounded — a summary as long as the thread is not a summary', () => {
    assert.equal(conversationSummarySchema.safeParse({ summary: 'x'.repeat(4001) }).success, false);
    assert.equal(conversationSummarySchema.safeParse({ summary: 'too short' }).success, false);
    assert.equal(conversationSummarySchema.safeParse({ summary: 'x'.repeat(500) }).success, true);
  });

  test('and the prompt refuses to carry a number', () => {
    // Every amount in AgencyOS belongs to a row somebody wrote; one
    // remembered through a paraphrase is one nobody can trace.
    assert.match(WORKFLOWS, /Do NOT include amounts, prices, discounts or payment terms/);
    assert.match(WORKFLOWS, /number remembered through a paraphrase is a number nobody can trace/);
  });

  test('it is a read, not a draft — nothing it writes reaches a client', () => {
    const summary = WORKFLOWS.slice(WORKFLOWS.indexOf('const THREAD_SUMMARY'));
    assert.match(summary.slice(0, 900), /workClass: 'read'/);
  });
});
