import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLERS, HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { CLIENT_FEEDBACK_CLASSIFICATIONS, clientFeedbackClassificationSchema } from '../src/modules/projects/schema.ts';
import { region } from './_region.ts';

/**
 * PM Agent spec §4.6/§8: "the controlled bridge between internal agents and
 * the client" — a six-way classification of a client's free-text UI revision
 * feedback. Before this, the PM Agent identity had zero AI workflows bound to
 * it at all; every client-communication behavior the spec named was a
 * deterministic handler (see docs/phase-4-implementation-traceability.md).
 * This is additive: the existing binary approve/change_requested revision
 * loop (`ui_designer:reviseUIVersion`) is untouched and keeps firing whether
 * or not a classification exists.
 *
 * Live-verified against a real scratch Postgres before this file was
 * written: a clarification insert/answer/idempotent-reanswer round-tripped
 * correctly, and a duplicate classification for the same decision was
 * refused by the unique constraint.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS_TS = read('app/api/jobs/run/workflows.ts');
const WORKFLOW = region(WORKFLOWS_TS, 'const CLASSIFY_CLIENT_FEEDBACK: AgentWorkflow', '\n// ═');

describe('A. the six-way vocabulary', () => {
  test('exactly the six categories the spec names', () => {
    assert.deepEqual(
      [...CLIENT_FEEDBACK_CLASSIFICATIONS].sort(),
      [
        'CLARIFICATION',
        'CORRECTION',
        'DESIGN_DIRECTION_CHANGE',
        'INCLUDED_REVISION',
        'POSSIBLE_SCOPE_CHANGE',
        'REJECTED_REQUEST',
      ].sort(),
    );
  });

  test('a valid classification parses; an invented category does not', () => {
    assert.ok(
      clientFeedbackClassificationSchema.safeParse({ classification: 'CORRECTION', reasoning: 'fix a typo' }).success,
    );
    assert.equal(
      clientFeedbackClassificationSchema.safeParse({ classification: 'MAYBE', reasoning: 'x' }).success,
      false,
    );
  });

  test('the schema is .strict() — no extra fields the model might invent', () => {
    assert.equal(
      clientFeedbackClassificationSchema.safeParse({
        classification: 'CORRECTION',
        reasoning: 'x',
        extra: 'field',
      }).success,
      false,
    );
  });
});

describe('B. it is additive — the binary revision loop is untouched', () => {
  test('both subscribers fire off the same event, neither gates the other', () => {
    const subs = SUBSCRIPTIONS['project.ui_version_client_decided'];
    assert.ok(subs?.includes('ui_designer:reviseUIVersion'));
    assert.ok(subs?.includes('project_manager:classifyClientFeedback'));
  });

  test('CORRECTION/INCLUDED_REVISION take no further action beyond recording the label', () => {
    assert.match(WORKFLOW, /CORRECTION \/ INCLUDED_REVISION: no further action/);
  });
});

describe('C. it filters to change_requested and skips otherwise, like the revision loop does', () => {
  test('final_confirmed is explicitly not_mine', () => {
    assert.match(WORKFLOW, /parsed\.data\.decision !== 'change_requested'/);
    assert.match(WORKFLOW, /outcome: 'not_mine'/);
  });

  test('idempotent: an already-classified decision is not classified twice', () => {
    assert.match(WORKFLOW, /already_classified/);
    assert.match(WORKFLOW, /from\('client_feedback_classifications'\)/);
  });
});

describe('D. each branch reaches the right door, directly — a job has no JWT role to call a gated one', () => {
  test('CLARIFICATION inserts into clarification_requests directly', () => {
    assert.match(WORKFLOW, /from\('clarification_requests'\)/);
    assert.match(WORKFLOW, /raised_by: 'project_manager'/);
  });

  test('POSSIBLE_SCOPE_CHANGE mirrors handlePossibleScopeChangeDetected\'s own body, not submit_change_request', () => {
    assert.match(WORKFLOW, /from\('scope_versions'\)/);
    assert.match(WORKFLOW, /from\('change_requests'\)/);
    assert.doesNotMatch(WORKFLOW, /submitChangeRequest/);
  });

  test('DESIGN_DIRECTION_CHANGE and REJECTED_REQUEST raise an internal-audience approval', () => {
    assert.match(WORKFLOW, /\.rpc\('request_approval'/);
    assert.match(WORKFLOW, /p_audience: 'internal'/);
  });
});

describe('E. it is reachable — the defect this repository has found repeatedly', () => {
  test('the handler is registered in HANDLERS and mapped to its job kind', () => {
    assert.ok(HANDLERS.includes('project_manager:classifyClientFeedback'));
    assert.equal(HANDLER_JOB_KIND['project_manager:classifyClientFeedback'], 'ui_version.classify_client_feedback');
  });

  test('the workflow is registered in AGENT_WORKFLOWS so its job kind is actually claimed', () => {
    assert.match(WORKFLOW, /jobKind: 'ui_version\.classify_client_feedback'/);
    assert.match(WORKFLOWS_TS, /\n {2}CLASSIFY_CLIENT_FEEDBACK,\n/);
  });

  test('the agent key is project_manager, not a new identity', () => {
    assert.match(WORKFLOW, /agentKey: 'project_manager'/);
  });
});
