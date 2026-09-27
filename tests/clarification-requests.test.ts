import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { region } from './_region.ts';

/**
 * PM Agent spec §4.3/§8: the CLARIFICATION branch's landing spot.
 *
 * `ui_version_client_decisions` carries an UNCONDITIONAL no-update/no-delete
 * trigger ("a client decision is a record of what was said, never edited or
 * removed") — this is why a classification cannot be a column on that table
 * and lives here instead, as its own append-only row.
 *
 * Live-verified against a real scratch Postgres before this file was
 * written: insert (service role) -> answer (authenticated internal owner,
 * via answer_clarification_request) -> re-answer is idempotent
 * (already_answered, not an error, not a second write).
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const MIGRATION = read('supabase/migrations/20260928110000_a_clarification_is_a_named_thing.sql');

const clarificationTable = region(MIGRATION, "create table if not exists projects.clarification_requests");
const classificationTable = region(MIGRATION, "create table if not exists projects.client_feedback_classifications");
const answerDoor = region(MIGRATION, 'function projects.answer_clarification_request', '$$;\n\ncomment');

describe('A. a client decision cannot be edited, so a classification is its own row', () => {
  test('client_feedback_classifications is one row per decision, insert-only from the door\'s perspective', () => {
    assert.match(classificationTable, /decision_id\s+uuid not null unique references projects\.ui_version_client_decisions/);
  });

  test('there is no UPDATE grant or policy on client_feedback_classifications', () => {
    const section = region(MIGRATION, 'create table if not exists projects.client_feedback_classifications', '-- ═');
    assert.doesNotMatch(section, /grant update on projects\.client_feedback_classifications/);
    assert.doesNotMatch(section, /for update to/);
  });
});

describe('B. clarification_requests — status and its evidence', () => {
  test('answered requires both an answer and a timestamp, not just one', () => {
    assert.match(
      clarificationTable,
      /check \(status <> 'answered' or \(answer is not null and answered_at is not null\)\)/,
    );
  });

  test('internal-only — a clarification is relayed by staff, not shown raw to the client', () => {
    assert.match(MIGRATION, /clarification_requests_select[\s\S]{0,200}core\.is_internal\(\)/);
    assert.doesNotMatch(MIGRATION, /clarification_requests[\s\S]{0,300}core\.is_client\(\)/);
  });

  test('the update policy exists — a SECURITY INVOKER door with RLS forced needs one, or it silently touches zero rows', () => {
    assert.match(MIGRATION, /create policy clarification_requests_update/);
  });
});

describe('C. answer_clarification_request — a person\'s own act', () => {
  test('security invoker, gated on can_write(), the same authority as every other internal-write door', () => {
    assert.match(answerDoor, /security invoker/);
    assert.match(answerDoor, /core\.can_write\(\)/);
  });

  test('idempotent: answering an already-answered request is a named outcome, not an error', () => {
    assert.match(answerDoor, /'already_answered'::text/);
  });

  test('an empty answer is refused before the row is even locked', () => {
    assert.match(answerDoor, /'no_answer'::text/);
  });

  test('the update qualifies the table name — the OUT parameter used to shadow the column', () => {
    // A real bug this file's own author found: `returns table (..., id uuid)`
    // shadows the bare `id` column inside the function body, making
    // `where id = v_request.id` ambiguous. Fixed by naming the OUT param
    // clarification_request_id and qualifying the UPDATE explicitly.
    assert.doesNotMatch(answerDoor, /returns table \(\s*outcome\s+text,\s*id\s+uuid\s*\)/);
    assert.match(answerDoor, /where clarification_requests\.id = v_request\.id/);
  });
});
