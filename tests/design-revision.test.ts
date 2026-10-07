// P3-UID-015: the designer's answer to a Phase 3 revision round, proved against a stand-in database and a stand-in model.
// What is proved: the ORDER (read the revision for the JOB's organization, read the earlier direction, ask, validate, then write through the door), the
// REFUSALS (a locked direction and an already-delivered round never reach the model; a malformed answer never reaches the door) and WHERE it writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { designRevisionSchema, resolveRevisionId, reviseDesignDirection, type RevisionAdmin } from '../src/modules/projects/design-revision.ts';

type Rows = Record<string, Record<string, unknown> | null>;

function fake(rows: Rows, rpcAnswers: Record<string, unknown> = {}) {
  const calls: { kind: 'read' | 'rpc'; what: string; filters?: Record<string, unknown>; args?: Record<string, unknown> }[] = [];
  const admin: RevisionAdmin = {
    schema: () => ({
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const q = {
          select: () => q,
          eq: (c: string, v: unknown) => {
            filters[c] = v;
            return q;
          },
          order: () => q,
          limit: () => q,
          maybeSingle: () => {
            calls.push({ kind: 'read', what: table, filters: { ...filters } });
            return Promise.resolve({ data: rows[table] ?? null, error: null });
          },
          then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
        };
        return q as never;
      },
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ kind: 'rpc', what: fn, args });
        return Promise.resolve({ data: rpcAnswers[fn] ?? null, error: null });
      },
    }),
  };
  return { admin, calls };
}

const REV = { id: 'r1', project_id: 'p1', status: 'open', origin: 'admin_edit', requested_changes: 'darken the headings', from_theme_option_id: 'o1', to_theme_option_id: null };
const OPT = { id: 'o1', name: 'Calm', direction_summary: 'quiet and airy', direction_metadata: {}, version: 1, client_status: 'not_shared' };
const GOOD = { name: 'Calm, darker', directionSummary: 'quiet and airy with darker headings and a larger logo' };

test('the answer is delivered through the door, after the model, for the job organization', async () => {
  const { admin, calls } = fake({ design_revisions: REV, theme_options: OPT }, { deliver_design_revision: [{ outcome: 'delivered', theme_option_id: 'n1' }] });
  let prompt = '';
  const out = await reviseDesignDirection(admin, { organizationId: 'org1', revisionId: 'r1' }, async (p, subject) => {
    prompt = p;
    assert.equal(subject.projectId, 'p1');
    return { ok: true, json: GOOD };
  });
  assert.deepEqual(out, { status: 'delivered', themeOptionId: 'n1' });
  assert.match(prompt, /darken the headings/);
  assert.match(prompt, /quiet and airy/);
  assert.equal(calls[0]?.filters?.organization_id, 'org1', 'the revision is read for the JOB organization');
  const rpcs = calls.filter((c) => c.kind === 'rpc');
  assert.equal(rpcs.length, 1);
  assert.equal(rpcs[0]?.what, 'deliver_design_revision');
  assert.equal(rpcs[0]?.args?.p_revision_id, 'r1');
});

test('a locked direction never reaches the model', async () => {
  const { admin, calls } = fake({ design_revisions: REV, theme_options: { ...OPT, client_status: 'locked' } });
  let asked = false;
  const out = await reviseDesignDirection(admin, { organizationId: 'org1', revisionId: 'r1' }, async () => {
    asked = true;
    return { ok: true, json: GOOD };
  });
  assert.equal(out.status, 'skipped');
  assert.equal(asked, false);
  assert.equal(calls.filter((c) => c.kind === 'rpc').length, 0);
});

test('an already-delivered round is not drawn twice', async () => {
  const { admin } = fake({ design_revisions: { ...REV, status: 'delivered', to_theme_option_id: 'n1' } });
  let asked = false;
  const out = await reviseDesignDirection(admin, { organizationId: 'org1', revisionId: 'r1' }, async () => {
    asked = true;
    return { ok: true, json: GOOD };
  });
  assert.deepEqual(out, { status: 'already_delivered', themeOptionId: 'n1' });
  assert.equal(asked, false);
});

test('a cancelled round and a vanished round are skipped, not failed', async () => {
  const cancelled = fake({ design_revisions: { ...REV, status: 'cancelled' } });
  assert.equal((await reviseDesignDirection(cancelled.admin, { organizationId: 'org1', revisionId: 'r1' }, async () => ({ ok: true, json: GOOD }))).status, 'skipped');
  const gone = fake({});
  assert.equal((await reviseDesignDirection(gone.admin, { organizationId: 'org1', revisionId: 'r1' }, async () => ({ ok: true, json: GOOD }))).status, 'skipped');
});

test('a malformed model answer never reaches the door', async () => {
  const { admin, calls } = fake({ design_revisions: REV, theme_options: OPT });
  const out = await reviseDesignDirection(admin, { organizationId: 'org1', revisionId: 'r1' }, async () => ({ ok: true, json: { name: 'x', directionSummary: 'too short', figmaNodeId: '1:2' } }));
  assert.equal(out.status, 'failed');
  assert.equal(calls.filter((c) => c.kind === 'rpc').length, 0);
});

test('the schema has no field to claim a Figma node', () => {
  assert.equal(designRevisionSchema.safeParse({ ...GOOD, figmaNodeId: '1:2' }).success, false);
  assert.equal(designRevisionSchema.safeParse(GOOD).success, true);
});

test('the door holding a rule (phase stopped) is a skip, not a failure to retry', async () => {
  const { admin } = fake({ design_revisions: REV, theme_options: OPT }, { deliver_design_revision: [{ outcome: 'phase_stopped', theme_option_id: null }] });
  const out = await reviseDesignDirection(admin, { organizationId: 'org1', revisionId: 'r1' }, async () => ({ ok: true, json: GOOD }));
  assert.equal(out.status, 'skipped');
});

test('an Admin EDIT event opens the revision through the door; a client round is read; an internal round is not answered twice', async () => {
  const edit = fake({ theme_options: { id: 'o1' } }, { open_internal_design_revision: [{ outcome: 'opened', revision_id: 'r9' }] });
  assert.deepEqual(await resolveRevisionId(edit.admin, { organizationId: 'org1', eventType: 'project.admin_design_edit_requested', subjectId: 'o1' }), { revisionId: 'r9' });
  const replay = fake({ theme_options: { id: 'o1' } }, { open_internal_design_revision: [{ outcome: 'exists', revision_id: 'r9' }] });
  assert.deepEqual(await resolveRevisionId(replay.admin, { organizationId: 'org1', eventType: 'project.internal_design_changes_required', subjectId: 'o1' }), { revisionId: 'r9' });
  const client = fake({ design_revisions: { id: 'r2', origin: 'client_revision', status: 'open' } });
  assert.deepEqual(await resolveRevisionId(client.admin, { organizationId: 'org1', eventType: 'project.design_revision_opened', subjectId: 'r2' }), { revisionId: 'r2' });
  const internal = fake({ design_revisions: { id: 'r3', origin: 'admin_edit', status: 'open' } });
  assert.ok('skip' in (await resolveRevisionId(internal.admin, { organizationId: 'org1', eventType: 'project.design_revision_opened', subjectId: 'r3' })));
  const other = fake({});
  assert.ok('skip' in (await resolveRevisionId(other.admin, { organizationId: 'org1', eventType: 'project.something_else', subjectId: 'x' })));
});
