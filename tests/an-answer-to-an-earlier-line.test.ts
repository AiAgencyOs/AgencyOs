import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

/**
 * An answer to an earlier line is not an answer to this one — G-192.
 *
 * ── the guard, and the case it could not see ──────────────────────────────
 *
 * The reply workflow stands down when the thread has moved on since the
 * message it was queued for. That is right for a **burst**: a client types
 * four lines, four jobs are queued, three see something newer and skip, and
 * the last one answers with the whole burst in front of it. One reply, and it
 * is the informed one.
 *
 * It could not tell that ordering from the other one. A client adds a line
 * **while the agent is composing**, so the agent's answer to the earlier line
 * lands *above* the new one — an answer written without ever seeing those
 * words. The new line's own job then read that answer as *"somebody has
 * answered"* and stood down, and **the client's last words were never answered
 * at all.**
 *
 * Reproduced live before this was written, in `verify-flow-01` §K1b: X, then
 * Y, then the reply to X — and Y met with silence.
 *
 * ── what tells them apart ─────────────────────────────────────────────────
 *
 * A reply carries the message it answers in its own `external_ref`. A reply to
 * something OLDER than this message did not see it and does not count.
 * Anything else — a newer client line, a person typing, a reply that did see
 * this message — still stands the job down.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const WORKFLOWS_RAW = read('app/api/jobs/run/workflows.ts');
const FLOW01 = codeOnly(read('scripts/verify-flow-01.mjs'));

describe('A. the two orderings are told apart by what a reply answers', () => {
  test('a reply names its target, and the target’s position is read', () => {
    assert.match(WORKFLOWS, /\/\^reply:\(\[0-9a-f-\]\{36\}\)\$\//);
    assert.match(WORKFLOWS, /const seqOf = new Map\(\(repliedTo \?\? \[\]\)\.map/);
  });

  test('a reply to something older than this message does not count', () => {
    assert.match(WORKFLOWS, /return targetSeq >= message\.seq;/);
  });

  test('and anything that is not a reply still stands the job down', () => {
    // A newer client line (a later job will answer it, with more context) or a
    // person typing (they have taken over). Both must still stop this job.
    assert.match(WORKFLOWS, /if \(!target\) return true;/);
  });

  test('a reply whose target cannot be read is treated as an answer', () => {
    // The safe direction: refusing to send costs a reply, and the alternative
    // costs the client two. G-054's posture applied to a decision.
    assert.match(WORKFLOWS, /if \(targetSeq === undefined\) return true;/);
    assert.match(WORKFLOWS_RAW, /refusing\s*\n\s*\/\/ to send is the safe direction/);
  });

  test('the job’s own reply is still excluded, which is why a refused send retries', () => {
    // `send_outbound_message` writes the row before the provider is called, so
    // a send Meta refuses leaves a message at a higher seq. Without this
    // exclusion the retry reads its own failed attempt as somebody else's
    // answer — the defect the owner's first real message found.
    assert.match(WORKFLOWS, /\.neq\('external_ref', `reply:\$\{message\.id\}`\)/);
  });
});

describe('B. the live proof has both halves', () => {
  test('the silence case is reproduced, not described', () => {
    assert.match(FLOW01, /K1b\. A line added while the agent was composing is still answered/);
    assert.match(FLOW01, /the second line is answered too/);
  });

  test('and the burst case proves the loosened guard still protects what it protected', () => {
    // K1b LOOSENS a guard. Testing that alone is an absence tested without its
    // positive twin — the shape this repository has a name for.
    assert.match(FLOW01, /K1c\. Four lines in a row still get one answer/);
    assert.match(FLOW01, /exactly one of them is answered — not four/);
    assert.match(FLOW01, /the client’s phone buzzes once/);
  });

  test('the burst check reads the provider, not only the database', () => {
    // One row and one send are different claims: the row could exist while the
    // client's phone stayed quiet, or four sends could share one row.
    assert.match(FLOW01, /graphSends\.length - sendsBeforeBurst === 1/);
  });
});
