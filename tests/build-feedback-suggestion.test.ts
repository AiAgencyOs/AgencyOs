import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { definitionFor } from '../src/modules/agents/registry.ts';
import { BUILD_FEEDBACK_CLASSES, buildFeedbackSuggestionSchema } from '../src/modules/projects/build-feedback-suggestion.ts';

/** P5-FEED-02: the PM agent SUGGESTS a classification of client feedback on a build; a person's door still decides and routes. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const SRC = read('app/api/jobs/run/development-workflows.ts');

describe('the suggestion vocabulary', () => {
  test('is exactly the seven classes the database door accepts', () => {
    assert.deepEqual([...BUILD_FEEDBACK_CLASSES].sort(), ['bug', 'clarification', 'included_small_revision', 'missed_requirement', 'new_feature', 'possible_scope_change', 'ui_mismatch']);
    const migration = read('supabase/migrations/20261031180000_client_feedback_on_a_build_is_classified_and_routed.sql');
    for (const c of BUILD_FEEDBACK_CLASSES) assert.ok(migration.includes(`'${c}'`), c);
  });
  test('a valid suggestion parses; an invented class, an extra field and a bare clarification do not', () => {
    assert.ok(buildFeedbackSuggestionSchema.safeParse({ classification: 'bug', reasoning: 'the pay button does nothing' }).success);
    assert.equal(buildFeedbackSuggestionSchema.safeParse({ classification: 'maybe', reasoning: 'x' }).success, false);
    assert.equal(buildFeedbackSuggestionSchema.safeParse({ classification: 'bug', reasoning: 'x', approve: true }).success, false);
    assert.equal(buildFeedbackSuggestionSchema.safeParse({ classification: 'clarification', reasoning: 'unclear' }).success, false);
    assert.ok(buildFeedbackSuggestionSchema.safeParse({ classification: 'clarification', reasoning: 'unclear', clarifyingQuestion: 'Which page do you mean?' }).success);
    assert.equal(buildFeedbackSuggestionSchema.safeParse({ classification: 'bug', reasoning: '' }).success, false);
  });
});

describe('the workflow only suggests', () => {
  test('it records through the service-only suggestion door and never calls the classification door', () => {
    assert.match(SRC, /record_feedback_suggestion/);
    assert.doesNotMatch(SRC, /classify_build_feedback/);
    assert.doesNotMatch(SRC, /\.from\('defects'\)|change_requests|submit_deliverable|decide_build_admin/);
  });
  test('it re-reads the feedback for the JOB\'s organization and leaves classified feedback alone', () => {
    assert.match(SRC, /\.eq\('organization_id', job\.organization_id\)/);
    assert.match(SRC, /fb\.state !== 'received'/);
  });
  test('it validates strictly before it writes, and fails the job on a refused answer', () => {
    assert.ok(SRC.indexOf('buildFeedbackSuggestionSchema.safeParse') < SRC.indexOf("rpc('record_feedback_suggestion'"));
    assert.match(SRC, /the model's answer was refused/);
  });
  test('it is a draft-class workflow of the PM agent, which the registry defines', () => {
    assert.match(SRC, /agentKey: 'project_manager'/);
    assert.match(SRC, /workClass: 'draft'/);
    assert.ok(definitionFor('project_manager'));
  });
});

describe('it is reachable', () => {
  test('the build-feedback event queues it, with its job kind and handler declared', () => {
    assert.ok(SUBSCRIPTIONS['project.build_feedback_received']?.includes('project_manager:suggestBuildFeedbackClass'));
    assert.equal(HANDLER_JOB_KIND['project_manager:suggestBuildFeedbackClass'], 'build_feedback.suggest_classification');
    assert.ok((HANDLERS as readonly string[]).includes('project_manager:suggestBuildFeedbackClass'));
  });
  test('the runner claims the job kind', () => {
    assert.match(read('app/api/jobs/run/workflows.ts'), /\.\.\.DEVELOPMENT_WORKFLOWS/);
  });
});
