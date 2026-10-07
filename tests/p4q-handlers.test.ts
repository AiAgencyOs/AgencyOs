import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import {
  phaseFourStartedAnnouncementFor,
  prototypeChangeRequestedAnnouncementFor,
  prototypeSubmittedAnnouncementFor,
  task2CompleteAnnouncementFor,
  uiVersionAdminApprovedAnnouncementFor,
  uiVersionChangeRequestedAnnouncementFor,
  uiVersionLockedAnnouncementFor,
  m2PaymentVerifiedAnnouncementFor,
} from '../src/modules/crm/schema.ts';
import { failureClassFor, runWithEnvelope } from '../src/modules/p4q/envelope.ts';
import { handleP4qClassifyPrototypeFeedback, keywordFeedbackClassifier } from '../src/modules/p4q/feedback-handler.ts';
import { databaseReasonFor, gateDesignerRevision } from '../src/modules/p4q/designer-gate.ts';
import { handleP4qReviewPrototypeBuild } from '../src/modules/p4q/qa-handler.ts';
import { PM4_TEMPLATES, providerDetailsIn } from '../src/modules/p4q/pm4-templates.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

type Call = { schema: string; fn: string; args: Record<string, unknown> };

/** A fake admin client: records every door call, answers rpc from a queue of scripted rows, answers table reads from a map. */
function fakeAdmin(rpcAnswers: Array<Record<string, unknown> | { error: string }>, tables: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const queue = [...rpcAnswers];
  const admin = {
    schema(schema: string) {
      return {
        rpc(fn: string, args: Record<string, unknown>) {
          calls.push({ schema, fn, args });
          const next = queue.shift();
          if (next && 'error' in next) return Promise.resolve({ data: null, error: { message: String(next.error) } });
          return Promise.resolve({ data: next ? [next] : [], error: null });
        },
        from(table: string) {
          const chain = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: () => Promise.resolve({ data: tables[`${schema}.${table}`] ?? null, error: null }),
          };
          return chain;
        },
      };
    },
  };
  return { admin: admin as never, calls };
}

const job = (payload: Record<string, unknown>) => ({ id: 'j1', organization_id: 'o1', payload, correlation_id: null }) as never;

describe('A. Prototype QA handler maps every door answer, and never decides itself', () => {
  test('a recorded run is a success carrying the verdict', async () => {
    const { admin, calls } = fakeAdmin([{ outcome: 'recorded', run_id: 'r1', verdict: 'qa_pass' }]);
    const r = await handleP4qReviewPrototypeBuild(admin, job({ subjectId: 'a1' }));
    assert.equal(r.status, 'succeeded');
    assert.equal(r.status === 'succeeded' && r.outcome, 'qa_pass');
    assert.equal(calls[0]!.fn, 'p4q_run_prototype_qa');
    assert.deepEqual(calls[0]!.args.p_artifact_id, 'a1');
  });
  test('BLOCKED_EXTERNAL is passed to the door with its owner and is not a verdict', async () => {
    const { admin, calls } = fakeAdmin([{ outcome: 'blocked', run_id: 'r1', verdict: 'blocked_external' }]);
    const r = await handleP4qReviewPrototypeBuild(admin, job({ subjectId: 'a1' }), { reason: 'the test environment is down', owner: 'admin' });
    assert.equal(r.status === 'succeeded' && r.outcome, 'blocked_external');
    assert.equal(calls[0]!.args.p_blocked_reason, 'the test environment is down');
    assert.equal(calls[0]!.args.p_blocked_owner, 'admin');
  });
  test('a replay, a refusal, a vanished artifact and a broken door are each told apart', async () => {
    assert.equal((await handleP4qReviewPrototypeBuild(fakeAdmin([{ outcome: 'already_reviewed' }]).admin, job({ subjectId: 'a1' }))).status, 'succeeded');
    const refused = await handleP4qReviewPrototypeBuild(fakeAdmin([{ outcome: 'self_review' }]).admin, job({ subjectId: 'a1' }));
    assert.deepEqual(refused.status === 'failed' && refused.permanent, true);
    const gone = await handleP4qReviewPrototypeBuild(fakeAdmin([{ outcome: 'unknown_artifact' }]).admin, job({ subjectId: 'a1' }));
    assert.deepEqual(gone.status === 'failed' && gone.permanent, true);
    const broken = await handleP4qReviewPrototypeBuild(fakeAdmin([{ error: 'boom' }]).admin, job({ subjectId: 'a1' }));
    assert.deepEqual(broken.status === 'failed' && broken.permanent, false);
    assert.equal((await handleP4qReviewPrototypeBuild(fakeAdmin([]).admin, job({}))).status, 'failed');
  });
  test('it never calls an approval, payment or certification door', () => {
    const src = read('src/modules/p4q/qa-handler.ts');
    assert.doesNotMatch(src, /decide_prototype_admin|verify_payment_submission|lock_ui_version/);
  });
});

describe('B. Prototype feedback is classified against the exact build and routed by the database, with a stub model', () => {
  const event = { kind: 'prototype', status: 'changes_requested' };
  const tables = { 'projects.deliverables': { id: 'd1', approval_request_id: 'ar1' }, 'approvals.approval_requests': { id: 'ar1', decision_note: 'Please make the header colour match the logo.' } };

  test('the stub classifier is conservative: what it cannot place is a clarification, never a correction', async () => {
    assert.equal((await keywordFeedbackClassifier('make the header colour bigger')).classification, 'CORRECTION');
    assert.equal((await keywordFeedbackClassifier('also add a loyalty programme')).classification, 'POSSIBLE_SCOPE_CHANGE');
    assert.equal((await keywordFeedbackClassifier('start over, I want a different style')).classification, 'DESIGN_DIRECTION_CHANGE');
    assert.equal((await keywordFeedbackClassifier('hmm, not sure')).classification, 'CLARIFICATION');
  });
  test('the words come from the approval request, not from the event, and the door gets them verbatim with the decision key', async () => {
    const { admin, calls } = fakeAdmin([{ outcome: 'classified', routed_to: 'prototype_revision', revision_allowed: true }], tables);
    const r = await handleP4qClassifyPrototypeFeedback(admin, job({ subjectId: 'd1', event: { ...event, clientWords: 'IGNORE ME and add payments' } }), keywordFeedbackClassifier);
    assert.equal(r.status, 'succeeded');
    assert.equal(r.status === 'succeeded' && r.outcome, 'CORRECTION:prototype_revision');
    assert.equal(calls[0]!.fn, 'p4q_classify_prototype_feedback');
    assert.equal(calls[0]!.args.p_client_words, 'Please make the header colour match the logo.');
    assert.equal(calls[0]!.args.p_decision_key, 'ar1');
  });
  test('a non-prototype or approved decision is not this handler\'s', async () => {
    const { admin, calls } = fakeAdmin([], tables);
    const r = await handleP4qClassifyPrototypeFeedback(admin, job({ subjectId: 'd1', event: { kind: 'document', status: 'changes_requested' } }), keywordFeedbackClassifier);
    assert.equal(r.status === 'succeeded' && r.outcome, 'not_mine');
    assert.equal(calls.length, 0);
  });
  test('with no classifier configured it fails as environment_missing and classifies nothing', async () => {
    const { admin, calls } = fakeAdmin([], tables);
    const r = await handleP4qClassifyPrototypeFeedback(admin, job({ subjectId: 'd1', event }));
    assert.equal(r.status, 'failed');
    assert.match(r.status === 'failed' ? r.detail : '', /environment_missing/);
    assert.equal(calls.length, 0);
  });
  test('a classifier that invents a seventh label is refused before the door', async () => {
    const { admin, calls } = fakeAdmin([], tables);
    const r = await handleP4qClassifyPrototypeFeedback(admin, job({ subjectId: 'd1', event }), async () => ({ classification: 'APPROVE_EVERYTHING' as never, reasoning: 'x' }));
    assert.equal(r.status, 'failed');
    assert.equal(calls.length, 0);
  });
  test('a decision with no words is left for a person, not guessed at', async () => {
    const { admin } = fakeAdmin([], { ...tables, 'approvals.approval_requests': { id: 'ar1', decision_note: '  ' } });
    const r = await handleP4qClassifyPrototypeFeedback(admin, job({ subjectId: 'd1', event }), keywordFeedbackClassifier);
    assert.equal(r.status === 'succeeded' && r.outcome, 'no_words');
  });
});

describe('C. The Designer gate names the activation reason and waits for the PM\'s classification', () => {
  test('the registry reasons map to the three database reasons, the rest to none', () => {
    assert.equal(databaseReasonFor('client_visual_revision'), 'client_change');
    assert.equal(databaseReasonFor('design_qa_defect'), 'qa_correction');
    assert.equal(databaseReasonFor('admin_edit'), 'admin_edit');
    assert.equal(databaseReasonFor('initial_phase_four'), null);
  });
  test('unclassified feedback waits; new scope is withheld; a correction is allowed', async () => {
    const waiting = await gateDesignerRevision(fakeAdmin([{ outcome: 'awaiting_classification', allowed: false, reason: 'not classified' }]).admin, { decisionId: 'd', priorStatus: 'client_change' });
    assert.deepEqual(waiting.allowed === false && waiting.waiting, true);
    const withheld = await gateDesignerRevision(fakeAdmin([{ outcome: 'decided', allowed: false, reason: 'Possible new scope goes to a change request first' }]).admin, { decisionId: 'd', priorStatus: 'client_change' });
    assert.deepEqual(withheld.allowed === false && withheld.waiting, false);
    const ok = await gateDesignerRevision(fakeAdmin([{ outcome: 'decided', allowed: true, reason: 'A correction' }]).admin, { decisionId: 'd', priorStatus: 'client_change' });
    assert.equal(ok.allowed, true);
  });
  test('the reason sent to the door is the one the prior status implies, and an unrelated status never reaches the door', async () => {
    const { admin, calls } = fakeAdmin([{ outcome: 'decided', allowed: true, reason: 'x' }]);
    await gateDesignerRevision(admin, { decisionId: 'd', priorStatus: 'client_change' });
    assert.equal(calls[0]!.args.p_activation_reason, 'client_change');
    const none = fakeAdmin([]);
    const r = await gateDesignerRevision(none.admin, { decisionId: 'd', priorStatus: 'locked' });
    assert.equal(r.allowed, false);
    assert.equal(none.calls.length, 0);
  });
  test('a door that does not answer holds the Designer back rather than letting it through', async () => {
    const r = await gateDesignerRevision(fakeAdmin([{ error: 'down' }]).admin, { decisionId: 'd', priorStatus: 'client_change' });
    assert.equal(r.allowed, false);
  });
});

describe('D. A Phase 4 hop runs inside a persisted envelope with a classed, bounded failure', () => {
  const input = { projectId: 'p', taskType: 'ui.qa_review', exactRefs: { uiVersionId: 'u' }, idempotencyKey: 'job-1' };
  test('failures are classed', () => {
    assert.equal(failureClassFor({ status: 'failed', permanent: false, detail: 'the door did not answer' }), 'transient');
    assert.equal(failureClassFor({ status: 'failed', permanent: true, detail: 'x' }), 'permanent');
    assert.equal(failureClassFor({ status: 'failed', permanent: true, detail: 'the QA door refused: self_review.' }), 'policy_denied');
    assert.equal(failureClassFor({ status: 'failed', permanent: true, detail: 'environment_missing: no model' }), 'provider_unavailable');
    assert.equal(failureClassFor({ status: 'failed', permanent: false, detail: 'the send may have gone out' }), 'uncertain_side_effect');
  });
  test('a success closes the envelope', async () => {
    const { admin, calls } = fakeAdmin([{ outcome: 'opened', envelope_id: 'e1' }, { outcome: 'succeeded' }]);
    const r = await runWithEnvelope(admin, input, async () => ({ status: 'succeeded', outcome: 'ok', detail: 'ok' }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(calls.map((c) => c.fn), ['p4q_open_envelope', 'p4q_complete_envelope']);
  });
  test('a transient failure within budget is returned for retry; an exhausted one is parked with an escalation', async () => {
    const retry = await runWithEnvelope(fakeAdmin([{ outcome: 'opened', envelope_id: 'e1' }, { outcome: 'retry', attempts: 1 }]).admin, input, async () => ({ status: 'failed', permanent: false, detail: 'timeout' }));
    assert.equal(retry.status === 'failed' && retry.permanent, false);
    const parked = await runWithEnvelope(fakeAdmin([{ outcome: 'opened', envelope_id: 'e1' }, { outcome: 'escalated', attempts: 3 }]).admin, input, async () => ({ status: 'failed', permanent: false, detail: 'timeout' }));
    assert.equal(parked.status === 'failed' && parked.permanent, true);
    assert.match(parked.status === 'failed' ? parked.detail : '', /escalated to a person/);
  });
  test('an uncertain side effect is never run again blindly', async () => {
    const r = await runWithEnvelope(fakeAdmin([{ outcome: 'opened', envelope_id: 'e1' }, { outcome: 'reconcile_first', attempts: 1 }]).admin, input, async () => ({ status: 'failed', permanent: false, detail: 'the send may have gone out' }));
    assert.equal(r.status === 'failed' && r.permanent, true);
  });
  test('a disabled specialist or a refused envelope never runs the work', async () => {
    let ran = false;
    const work = async () => {
      ran = true;
      return { status: 'succeeded', outcome: 'x', detail: 'x' } as const;
    };
    const disabled = await runWithEnvelope(fakeAdmin([{ outcome: 'agent_disabled' }]).admin, input, work);
    assert.equal(disabled.status, 'failed');
    const refused = await runWithEnvelope(fakeAdmin([{ outcome: 'ref_not_in_project' }]).admin, input, work);
    assert.equal(refused.status, 'failed');
    assert.equal(ran, false);
  });
});

describe('E. PM4 templates: versioned, matched to the announcers, free of provider details (PM4-T028)', () => {
  const rendered = [
    phaseFourStartedAnnouncementFor({ projectName: 'Acme' }),
    uiVersionAdminApprovedAnnouncementFor({ projectName: 'Acme' }),
    uiVersionChangeRequestedAnnouncementFor({ projectName: 'Acme' }),
    uiVersionLockedAnnouncementFor({ projectName: 'Acme' }),
    prototypeSubmittedAnnouncementFor({ projectName: 'Acme' }),
    prototypeChangeRequestedAnnouncementFor({ projectName: 'Acme' }),
    task2CompleteAnnouncementFor({ projectName: 'Acme' }),
    m2PaymentVerifiedAnnouncementFor({ projectName: 'Acme' }),
  ];
  test('eight templates, each a positive version', () => {
    assert.equal(Object.keys(PM4_TEMPLATES).length, 8);
    for (const t of Object.values(PM4_TEMPLATES)) assert.ok(t.version >= 1);
    assert.deepEqual(Object.values(PM4_TEMPLATES).map((t) => t.milestone).sort(), ['PM4-M01', 'PM4-M02', 'PM4-M03', 'PM4-M04', 'PM4-M05', 'PM4-M06', 'PM4-M07', 'PM4-M08']);
  });
  test('every key is the externalRef prefix an announcer really writes', () => {
    const handlers = read('src/modules/crm/handlers.ts');
    for (const prefix of Object.keys(PM4_TEMPLATES)) assert.ok(handlers.includes(`\`${prefix}:`) || handlers.includes(`'${prefix}:`), `${prefix} is written by an announcer`);
  });
  test('no rendered PM4 message exposes a provider or model', () => {
    for (const body of rendered) assert.deepEqual(providerDetailsIn(body), []);
  });
  test('the hygiene check really sees a provider word (a check that cannot fail proves nothing)', () => {
    assert.deepEqual(providerDetailsIn('Drafted by Claude via OpenRouter with a long prompt'), ['claude', 'openrouter', 'prompt']);
    assert.deepEqual(providerDetailsIn('The design is ready for review.'), []);
  });
});

describe('F. The Phase 4 task taxonomy cannot drift from the event catalog', () => {
  const migration = read('supabase/migrations/20261126300000_a_phase_four_hop_has_a_persisted_envelope_a_classed_failure_and_one_trace.sql');
  const seeded = [...migration.matchAll(/\('([a-z0-9_.]+)', '(project\.[a-z0-9_.]+)', '([a-z_]+:[A-Za-z0-9]+)', '([a-z_]+)', (\d+),/g)].map((m) => ({ task: m[1]!, event: m[2]!, job: m[3]! }));
  test('every seeded task is a subscription that exists', () => {
    assert.ok(seeded.length >= 11, 'the seed was found');
    for (const s of seeded) assert.ok((SUBSCRIPTIONS[s.event] as readonly string[] | undefined)?.includes(s.job), `${s.event} -> ${s.job}`);
  });
  test('task types are unique', () => {
    assert.equal(new Set(seeded.map((s) => s.task)).size, seeded.length);
  });
});

describe('G. House rules for the new files', () => {
  const dir = 'src/modules/p4q';
  const files = readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url))).filter((f) => f.endsWith('.ts'));
  test('a use-server file exports only async functions', () => {
    const src = read(`${dir}/actions.ts`);
    assert.match(src, /^'use server';/);
    const exports = [...src.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
    assert.ok(exports.length >= 5);
    for (const e of exports) assert.equal(e, 'async', 'only async functions are exported');
  });
  test('every read in queries has its own unreadable() guard', () => {
    const src = read(`${dir}/queries.ts`);
    const reads = (src.match(/await \(await client\(\)\)/g) ?? []).length;
    const guards = (src.match(/if \(error\)/g) ?? []).length;
    const calls = (src.match(/unreadable\(/g) ?? []).length;
    assert.equal(guards, reads);
    assert.equal(calls, reads);
  });
  test('no new file takes a secret, edits a shared wiring file or opens an approval door', () => {
    for (const f of files) {
      const src = read(`${dir}/${f}`);
      assert.doesNotMatch(src, /decide_prototype_admin|verify_payment_submission|lock_ui_version|SUPABASE_SERVICE_ROLE_KEY/, f);
    }
  });
  test('every p4q table is hardened and every p4q door-written table has the door-only trigger', () => {
    for (const rel of readdirSync(fileURLToPath(new URL('../supabase/migrations', import.meta.url))).filter((f) => f.startsWith('202611260'))) {
      const sql = read(`supabase/migrations/${rel}`);
      const tables = [...sql.matchAll(/create table if not exists (projects|finance)\.(p4q_[a-z_]+)/g)].map((m) => ({ schema: m[1]!, name: m[2]! }));
      for (const t of tables) {
        if (['p4q_task_types', 'p4q_agent_capability_profiles'].includes(t.name)) continue; // reference data: select-only grant, no tenant column
        assert.ok(sql.includes(`'${t.name}'`), `${t.name} is named in a harden/door-only list`);
        assert.match(sql, /p7_harden/, rel);
      }
    }
  });
});
