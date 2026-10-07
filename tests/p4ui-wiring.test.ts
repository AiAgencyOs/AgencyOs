import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

/**
 * p4ui item 7 (the parts that are not workflow gates, which `p4q-revision-wiring.test.ts` covers): the prototype send gate reads the planned build's
 * share eligibility, the client prototype page renders the client notice, and an attached revision build records its lineage. The database behaviour of the
 * gate is proved by `scripts/verify-p4ui-prototype.sql` (with its negative); these pin that every connection is present in the code that calls it.
 */
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('prototype_send_gate reads p4ui_build_share_eligibility', () => {
  const migration = read('supabase/migrations/20261130000000_a_prototype_goes_to_the_client_only_when_its_planned_build_is_share_eligible.sql');
  test('the redefined gate calls the eligibility for the build planned for this artifact, and keeps its signature and grants', () => {
    assert.match(migration, /create or replace function projects\.prototype_send_gate\(p_deliverable_id uuid\)\s+returns table \(qa_passed boolean, admin_approved boolean, qa_source text\)/);
    assert.match(migration, /projects\.p4ui_build_share_eligibility\(pb\.id\)/);
    assert.match(migration, /b\.prototype_artifact_id = v_art\.id/);
    assert.match(migration, /grant execute on function projects\.prototype_send_gate\(uuid\) to authenticated, service_role;/);
  });
  test('the status reason is excluded (the artifact verdict is the authority, the build status lags) and a prototype with no planned build is gated as before', () => {
    assert.match(migration, /r not like 'the build has not passed Prototype QA%'/);
    assert.match(migration, /if coalesce\(cardinality\(v_reasons\), 0\) > 0 then/);
  });
  test('the verifier asserts the positive and the negative', () => {
    const v = read('scripts/verify-p4ui-prototype.sql');
    assert.match(v, /send gate: QA passed and the planned build is share-eligible, so qa_passed/);
    assert.match(v, /NEGATIVE: a failed upload on the planned build closes the send gate although Prototype QA passed the artifact/);
    assert.match(v, /the gate re-opens once the upload is retried/);
  });
  test('the migration uses a timestamp in the reserved range', () => {
    assert.match('20261130000000', /^2026113\d{7}$/);
  });
});

describe('the client prototype page renders the client notice', () => {
  const queries = read('src/modules/portal/queries.ts');
  const page = read('app/(client)/portal/[projectId]/prototype/[uiVersionId]/page.tsx');
  test('the query calls the database function that keeps the wording', () => {
    assert.match(queries, /rpc\('p4ui_prototype_client_notice', \{ p_deliverable_id: deliverableId \}\)/);
    assert.match(queries, /readClientPrototypeArtifact[\s\S]{0,400}deliverable_id/);
  });
  test('the page reads it for this build and renders the label, the limitations and what is simulated', () => {
    assert.match(page, /await readClientPrototypeNotice\(artifact\.deliverableId\)/);
    assert.match(page, /\{notice\.label\}/);
    assert.match(page, /notice\.limitations\.map/);
    assert.match(page, /notice\.simulated\.join/);
  });
});

describe('an attached revision build records its lineage', () => {
  const src = read('src/modules/projects/p4ui.ts');
  test('attachBuiltPrototype reads revision_of_build_id and calls p4ui_record_build_revision after the handoff', () => {
    const attach = src.indexOf('export async function attachBuiltPrototype');
    const sync = src.indexOf('export async function syncBuildForDeliverable');
    assert.ok(attach > 0 && sync > attach);
    const body = src.slice(attach, sync);
    assert.match(body, /revision_of_build_id/);
    assert.ok(body.indexOf("rpc('p4ui_record_build_revision'") > body.indexOf("rpc('p4ui_assemble_qa_handoff'"));
    assert.match(body, /if \(build\.revision_of_build_id\)/);
  });
});
