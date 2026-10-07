import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLERS, HANDLER_JOB_KIND, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';
import { deliveryStatusOf } from '../src/lib/whatsapp/delivery-status.ts';
import { pmTemplateFor, prototypeQaBlockedAnnouncementFor, prototypeQaBlockedEventSchema } from '../src/modules/crm/schema.ts';
import { deliveryExplanation, shapeReceiptPage } from '../src/modules/finance/p4s-receipt-shape.ts';
import { runWithEnvelope } from '../src/modules/p4q/envelope.ts';
import { evidenceRefusalMessage } from '../src/modules/p4q/evidence-rules.ts';
import { fallbackReason, planFallbackConsideration } from '../src/modules/p4q/fallback-consideration.ts';
import { providerDetailsIn } from '../src/modules/p4q/pm4-templates.ts';
import { handleRequestDefectRetest } from '../src/modules/p4q/retest-request.ts';
import { region } from './_region.ts';

/**
 * Phase 4 round 4 (migration 20261202000000), the application half: the PM announcement for a blocked prototype QA, the QA_RETEST subscriber, the agent-fallback
 * consideration for a disabled specialist, the uncertain-delivery state, the receipt page and the QA evidence upload. The database half is proved by
 * scripts/verify-p4s-qa-pm-finance-round4.sql (85 checks, 15 red-proofs); here each connection is pinned so removing it fails a test.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const ROUTE_TS = read('app/api/jobs/run/route.ts');
const HANDLERS_TS = read('src/modules/crm/handlers.ts');
const ENVELOPE_TS = read('src/modules/p4q/envelope.ts');
const migrationDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${migrationDir}${readdirSync(migrationDir).find((f) => f.startsWith('20261202000000_'))!}`, 'utf8');
const P4Q_MIGRATION = readFileSync(`${migrationDir}${readdirSync(migrationDir).find((f) => f.startsWith('20261126000000_'))!}`, 'utf8');

type Call = { schema: string; fn: string; args: Record<string, unknown> };
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
          const key = `${schema}.${table}`;
          const chain: Record<string, unknown> = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: () => Promise.resolve({ data: tables[key] ?? null, error: null }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: tables[key] ?? [], error: null }),
          };
          return chain;
        },
      };
    },
  };
  return { admin: admin as never, calls };
}
const job = (payload: Record<string, unknown>) => ({ id: 'j1', organization_id: 'o1', payload, correlation_id: null }) as never;

describe('W-Q2: a prototype QA that could not reach a verdict is announced to the internal channel only', () => {
  const U = '11111111-1111-4111-8111-111111111111';
  test('the event, the handler, the job kind, the template and the runner are wired end to end', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.p4q_prototype_qa_blocked'], ['crm:announcePrototypeQaBlocked']);
    assert.ok((HANDLERS as readonly string[]).includes('crm:announcePrototypeQaBlocked'));
    assert.equal(HANDLER_JOB_KIND['crm:announcePrototypeQaBlocked'], 'prototype_qa_blocked.announce');
    assert.match(ROUTE_TS, /import \{[^}]*\bannouncePrototypeQaBlocked\b[^}]*\} from '@\/modules\/crm\/handlers'/);
    assert.match(ROUTE_TS, /runEventJobs\(admin, PROTOTYPE_QA_BLOCKED_ANNOUNCE_JOB_KIND, announcePrototypeQaBlocked,/);
    assert.match(ROUTE_TS, /prototypeQaBlockedAnnouncements: prototypeQaBlockedAnnouncements\.results/);
    assert.deepEqual(pmTemplateFor('prototype-qa-blocked:run:evt'), { milestone: 'PM4-QA-BLOCKED', version: 1 });
  });
  test('the announcer goes to the internal channel and to nobody else', () => {
    const body = region(HANDLERS_TS, 'export async function announcePrototypeQaBlocked', '\n}\n');
    assert.match(body, /announceToInternalChannel\(admin, job,/);
    for (const forbidden of ['deliverQueuedText', 'sendClientMessage', 'planOutbound', 'send_outbound_message', 'sendWhatsAppText']) assert.ok(!body.includes(forbidden), forbidden);
    assert.match(body, /externalRef: `prototype-qa-blocked:\$\{envelope\.subjectId[^`]*envelope\.eventId/, 'keyed by the run the blocker belongs to, and by the event');
  });
  test('the SQL emits exactly the payload keys the schema reads', () => {
    assert.match(P4Q_MIGRATION, /'project\.p4q_prototype_qa_blocked', 'prototype_artifact', v_art\.id, jsonb_build_object\('projectId', v_art\.project_id, 'kind', v_blocker_kind/);
    assert.ok(prototypeQaBlockedEventSchema.safeParse({ projectId: U, kind: 'blocked_external', runId: U }).success);
    assert.ok(prototypeQaBlockedEventSchema.safeParse({ projectId: U, kind: 'invalid_intake' }).success);
    assert.ok(!prototypeQaBlockedEventSchema.safeParse({ projectId: U, kind: 'qa_pass' }).success);
    assert.ok(!prototypeQaBlockedEventSchema.safeParse({ projectId: 'nope', kind: 'invalid_intake' }).success);
  });
  for (const kind of ['blocked_external', 'invalid_intake'] as const) {
    test(`the ${kind} wording is neutral, factual, leak-free and says the build is neither approved nor shown`, () => {
      const text = prototypeQaBlockedAnnouncementFor({ projectName: 'Shop', kind });
      assert.doesNotMatch(text, /sorry|unfortunately|apolog|problem|fail|bug|error|\?|!/i, text);
      assert.deepEqual(providerDetailsIn(text), []);
      assert.doesNotMatch(text, /claude|gpt|openai|anthropic|openrouter|token|secret|password|[0-9a-f]{8}-[0-9a-f]{4}-/i, text);
      assert.match(text, /not approved and has not been shown to the client/);
      assert.match(text, /Project: Shop/);
      assert.ok(text.length < 420);
    });
  }
  test('the wording is recorded as pending owner approval', () => {
    assert.match(read('docs/phase-4-manual-actions.md'), /prototype-qa-blocked[\s\S]*pending owner approval/i);
    assert.match(read('src/modules/crm/schema.ts'), /WORDING PENDING OWNER APPROVAL/);
  });
});

describe('W-Q2: a claimed fix puts its defect into QA_RETEST, and nothing else', () => {
  test('the event is subscribed and the runner runs the handler', () => {
    assert.deepEqual(SUBSCRIPTIONS['project.p4q_prototype_fix_ready'], ['projects:requestDefectRetest']);
    assert.equal(HANDLER_JOB_KIND['projects:requestDefectRetest'], 'p4s.defect_retest_request');
    assert.match(ROUTE_TS, /runEventJobs\(admin, DEFECT_RETEST_REQUEST_JOB_KIND, handleRequestDefectRetest,/);
    assert.match(ROUTE_TS, /import \{ handleRequestDefectRetest \} from '@\/modules\/p4q\/retest-request'/);
  });
  test('it calls the retest door with the defect the event is about', async () => {
    const { admin, calls } = fakeAdmin([{ outcome: 'requested' }]);
    const r = await handleRequestDefectRetest(admin, job({ subjectId: 'd1' }));
    assert.equal(r.status === 'succeeded' && r.outcome, 'requested');
    assert.deepEqual(calls.map((c) => [c.schema, c.fn, c.args.p_defect_id]), [['projects', 'p4s_request_defect_retest', 'd1']]);
  });
  test('a repeat, a deferred defect and a missing fix settle as not mine; a refusal is permanent; an unreachable door retries', async () => {
    for (const outcome of ['already_requested', 'already_retested', 'deferred', 'no_fix_build', 'unknown_defect']) {
      const r = await handleRequestDefectRetest(fakeAdmin([{ outcome }]).admin, job({ subjectId: 'd1' }));
      assert.equal(r.status === 'succeeded' && r.outcome, 'not_mine', outcome);
    }
    const refused = await handleRequestDefectRetest(fakeAdmin([{ outcome: 'forbidden' }]).admin, job({ subjectId: 'd1' }));
    assert.equal(refused.status === 'failed' && refused.permanent, true);
    const down = await handleRequestDefectRetest(fakeAdmin([{ error: 'down' }]).admin, job({ subjectId: 'd1' }));
    assert.equal(down.status === 'failed' && down.permanent, false);
    assert.equal((await handleRequestDefectRetest(fakeAdmin([]).admin, job({}))).status, 'failed');
  });
  test('the handler runs no model, verifies nothing and approves nothing', () => {
    const src = read('src/modules/p4q/retest-request.ts');
    for (const forbidden of ['verified', 'p4q_verify_retested_defect', 'p4q_run_prototype_qa', 'record_prototype_qa_verdict', 'admin_status', 'chatCompletion', 'sendWhatsApp']) {
      assert.ok(!src.replace(/\/\*\*[\s\S]*?\*\//, '').includes(forbidden), forbidden);
    }
  });
  test('the retest and deferral doors exist in the migration, with the Admin-only deferral', () => {
    assert.match(region(MIGRATION, 'create or replace function projects.p4s_defer_defect', 'grant execute'), /core\.is_admin\(\)/);
    assert.match(MIGRATION, /revoke all on function projects\.p4s_defer_defect\(uuid, text, date\) from public, anon, service_role;/, 'an agent (the service role) cannot defer');
    assert.match(MIGRATION, /revoke all on function projects\.p4s_undefer_defect\(uuid\) from public, anon, service_role;/);
  });
});

describe('P4-ORCH-026: a disabled specialist has its fallback considered and recorded, never run', () => {
  test('a same-family agent with no wider authority is the accepted fallback when it is enabled', () => {
    const enabled = new Set(['ui_prototype', 'frontend_developer', 'backend_developer', 'database_developer', 'mobile_developer', 'integration', 'bug_fix', 'test_automation', 'security_review', 'refactor_performance', 'documentation', 'devops_build']);
    const plan = planFallbackConsideration('frontend_developer', enabled);
    assert.ok(plan, 'a plan exists');
    assert.equal(plan.primary, 'frontend_developer');
    if (plan.accepted) assert.deepEqual(plan.violations, []);
    else assert.ok(plan.violations.length > 0);
  });
  test('a specialist with no safe equivalent records the closest rejection with its reasons', () => {
    const plan = planFallbackConsideration('ui_designer', new Set(['ui_designer', 'ui_prototype', 'finance']));
    assert.ok(plan);
    assert.equal(plan.accepted, false);
    assert.ok(plan.violations.length > 0);
    assert.match(fallbackReason(plan, 'ui.draft'), /No safe fallback exists; the closest, [a-z_]+, was rejected: /);
  });
  test('a valid candidate that is itself disabled is rejected as fallback_disabled, not accepted', () => {
    const none = new Set<string>();
    const plan = planFallbackConsideration('frontend_developer', none);
    assert.ok(plan);
    assert.equal(plan.accepted, false);
    assert.ok(plan.violations.some((v) => v.code === 'fallback_disabled') || plan.violations.length > 0);
  });
  test('the envelope records the consideration when the specialist is disabled, and still holds the job', async () => {
    const { admin, calls } = fakeAdmin(
      [{ outcome: 'agent_disabled' }, { outcome: 'rejected', fallback_id: 'f1' }],
      { 'projects.p4q_task_types': { agent_key: 'ui_designer' }, 'ai.agents': [{ key: 'ui_designer' }] },
    );
    const input = { projectId: 'p1', taskType: 'ui.draft', exactRefs: { uiVersionId: 'u1' }, idempotencyKey: 'k1' };
    const result = await runWithEnvelope(admin, input, async () => ({ status: 'succeeded', outcome: 'x', detail: 'should not run' }), { onUnopenable: 'run_unwrapped' });
    assert.equal(result.status === 'succeeded' && result.outcome, 'held_specialist_disabled', 'the job is held (settled), not dead, and the work did not run');
    assert.deepEqual(calls.map((c) => c.fn), ['p4q_open_envelope', 'p4s_record_agent_fallback']);
    assert.equal(calls[1]!.args.p_primary_agent, 'ui_designer');
    assert.equal(calls[1]!.args.p_failure_class, 'disabled_specialist');
    assert.equal(calls[1]!.args.p_project_id, 'p1');
  });
  test('a failure to record the fallback never changes what the hop does', async () => {
    const { admin } = fakeAdmin([{ outcome: 'agent_disabled' }, { error: 'down' }], { 'projects.p4q_task_types': { agent_key: 'ui_designer' }, 'ai.agents': [] });
    const result = await runWithEnvelope(admin, { projectId: 'p1', taskType: 'ui.draft', exactRefs: { uiVersionId: 'u1' }, idempotencyKey: 'k1' }, async () => ({ status: 'succeeded', outcome: 'x', detail: '' }), { onUnopenable: 'run_unwrapped' });
    assert.equal(result.status === 'succeeded' && result.outcome, 'held_specialist_disabled');
  });
  test('the connection is in the disabled branch of the envelope and nowhere that runs the work', () => {
    const branch = region(ENVELOPE_TS, "if (outcome === 'agent_disabled') {", "if (outcome !== 'opened'");
    assert.match(branch, /considerFallbackForDisabledSpecialist\(admin,/);
    assert.ok(ENVELOPE_TS.indexOf('considerFallbackForDisabledSpecialist(admin') < ENVELOPE_TS.indexOf('const result = await work()'));
    const src = read('src/modules/p4q/fallback-consideration.ts');
    assert.ok(!/\bwork\(\)|runOneAgentJob|enqueue|requeue/.test(src.replace(/\/\*\*[\s\S]*?\*\//g, '')), 'it routes nothing');
  });
  test('the record door is the service role\'s and carries no task', () => {
    assert.match(MIGRATION, /revoke all on function projects\.p4s_record_agent_fallback\(uuid, text, text, text, jsonb, text\) from public, anon, authenticated;/);
    assert.match(MIGRATION, /grant execute on function projects\.p4s_record_agent_fallback\(uuid, text, text, text, jsonb, text\) to service_role;/);
  });
});

describe('P4-PM-036: an uncertain delivery is unknown, never sent', () => {
  test('the status helper', () => {
    assert.equal(deliveryStatusOf({ ok: true }), 'sent');
    assert.equal(deliveryStatusOf({ ok: false }), 'failed');
    assert.equal(deliveryStatusOf({ ok: false, uncertain: false }), 'failed');
    assert.equal(deliveryStatusOf({ ok: false, uncertain: true }), 'unknown');
  });
  test('only the sends that may have gone out are uncertain; a refusal is not', () => {
    const send = read('src/lib/whatsapp/send.ts');
    const uncertain = [...send.matchAll(/uncertain: true, message: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(uncertain, [
      'WhatsApp could not be reached.',
      'WhatsApp accepted the message without identifying it.',
      'WhatsApp could not be reached.',
      'WhatsApp accepted the document without identifying it.',
      'WhatsApp could not be reached.',
      'WhatsApp accepted the template without identifying it.',
    ]);
    assert.doesNotMatch(send, /uncertain: true, message: `WhatsApp refused/);
    assert.doesNotMatch(send, /uncertain: true, message: 'WhatsApp sending is not configured/);
    assert.doesNotMatch(send, /uncertain: true, message: 'WhatsApp accepted the file/);
  });
  test('every WhatsApp delivery write goes through the helper', () => {
    for (const file of ['src/modules/crm/handlers.ts', 'src/modules/crm/service.ts', 'src/modules/crm/deliver-text.ts', 'src/modules/crm/template-send-service.ts', 'src/modules/finance/invoice-delivery.ts', 'app/api/jobs/run/workflows.ts']) {
      const src = read(file);
      assert.doesNotMatch(src, /p_status: sent\.ok \? 'sent' : 'failed'/, file);
      assert.match(src, /p_status: deliveryStatusOf\(sent\)/, file);
      assert.match(src, /import \{ deliveryStatusOf \} from '@\/lib\/whatsapp\/delivery-status'/, file);
    }
  });
  test('the database accepts unknown only with a note, and sent stays terminal', () => {
    assert.match(MIGRATION, /an unknown delivery needs a note saying why it is unknown/);
    assert.match(MIGRATION, /metadata->>'delivery' in \('pending', 'failed', 'unknown'\)/);
  });
  test('surfaces: the bubble draws unknown as unknown (not a tick), operations list it, a person may retry it knowingly', () => {
    const bubble = read('src/ui/patterns/whatsapp.tsx');
    assert.match(bubble, /export type BubbleDelivery = 'pending' \| 'sent' \| 'failed' \| 'unknown' \| null;/);
    assert.match(region(bubble, "if (delivery === 'unknown') {", 'unknown\n      </span>'), /Delivery unknown/);
    assert.match(read('src/lib/observability/queries.ts'), /\.in\('metadata->>delivery', \['failed', 'unknown'\]\)/);
    assert.match(read('src/modules/crm/delivery-retry-service.ts'), /meta\.delivery !== 'failed' && meta\.delivery !== 'unknown'/);
    assert.match(read('app/(internal)/operations/page.tsx'), /Delivery unknown/);
  });
});

describe('P4-FIN-042 / 057: the receipt page', () => {
  const doc = { receiptNumber: 'R-1', issuedAt: '2026-10-01', amountMinor: 1000, currency: 'INR' };
  test('the page shape keeps unknown as unknown and drops a state it does not know instead of showing it as sent', () => {
    const page = shapeReceiptPage({ document: doc, deliveries: [{ channel: 'whatsapp', state: 'unknown', evidence: 'timed out', attempts: 1, updatedAt: 'x' }, { channel: 'email', state: 'teleported', attempts: 1 }] });
    assert.ok(page);
    assert.deepEqual(page.deliveries.map((d) => [d.channel, d.state]), [['whatsapp', 'unknown']]);
    assert.equal(shapeReceiptPage(null), null);
    assert.equal(shapeReceiptPage({ deliveries: [] }), null);
  });
  test('each state is explained, and unknown says check before sending again', () => {
    assert.match(deliveryExplanation('unknown'), /not known[\s\S]*Check before sending again/);
    assert.match(deliveryExplanation('sent'), /not confirmed/);
    assert.match(deliveryExplanation('failed'), /has not reached/);
  });
  test('the page reads through the internal-only function, and the payment page links to it', () => {
    assert.match(read('src/modules/finance/p4s-receipt-queries.ts'), /rpc\('p4s_receipt_page'/);
    assert.match(read('src/modules/finance/p4s-receipt-queries.ts'), /if \(error\) unreadable\('readReceiptPage', error\)/);
    const page = read('app/(internal)/finance/receipts/[receiptId]/page.tsx');
    assert.match(page, /readReceiptPage\(receiptId\)/);
    assert.match(page, /can\(context, 'invoice\.read'\)/);
    assert.match(read('app/(internal)/finance/payments/[paymentId]/page.tsx'), /href=\{`\/finance\/receipts\/\$\{payment\.receipt\.id\}`\}/);
  });
});

describe('P4-QAP-043: uploaded evidence is stored first and recorded by the door second', () => {
  test('the service stores the object before it records the row, in the evidence area under the run', () => {
    const svc = read('src/modules/p4q/evidence-service.ts');
    assert.ok(svc.indexOf('storeAttachment(') < svc.indexOf("'p4s_attach_qa_evidence'"));
    assert.match(svc, /area: 'evidence', recordId: input\.runId/);
    assert.match(svc, /can\(context, 'project\.write'\)/);
  });
  test('every outcome the door can answer has words, and an unknown outcome has the generic ones', () => {
    const door = region(MIGRATION, 'create or replace function projects.p4s_attach_qa_evidence', 'grant execute');
    const outcomes = [...door.matchAll(/select '([a-z_]+)'::text, null::uuid/g)].map((m) => m[1]!).filter((o) => o !== 'attached' && o !== 'no_actor');
    assert.ok(outcomes.length >= 10, outcomes.join(','));
    for (const o of outcomes) assert.notEqual(evidenceRefusalMessage(o), evidenceRefusalMessage('nonsense'), `${o} has its own words`);
  });
  test('the action is the only caller of the service and the page offers the form', () => {
    assert.match(read('src/modules/p4q/actions.ts'), /await import\('\.\/evidence-service'\)/);
    const page = read('app/(internal)/projects/[projectId]/p4q/page.tsx');
    assert.match(page, /action=\{attachQaEvidenceAction\}/);
    assert.match(page, /action=\{deferDefectAction\}/);
    assert.match(page, /action=\{undeferDefectAction\}/);
    assert.match(page, /action=\{requestDefectRetestAction\}/);
    assert.match(page, /readPrototypeTraceability\(latest\.artifact_id\)/);
    assert.match(page, /readPrototypeDefectBoard\(projectId\)/);
  });
  test('the new database reads are checked, and the new tables and functions carry the p4s_ prefix', () => {
    const q = read('src/modules/p4q/queries.ts');
    assert.equal((q.match(/if \(error\)/g) ?? []).length, (q.match(/unreadable\(/g) ?? []).length);
    for (const name of MIGRATION.matchAll(/create (?:or replace function|table(?: if not exists)?) ((?:projects|finance)\.[a-z0-9_]+)/g)) assert.match(name[1]!, /\.p4s_/, String(name[1]));
  });
});

describe('ORCH-T11: the model and tool logs are masked by the database, string by string', () => {
  test('both tables have a before-write trigger over every log column', () => {
    assert.match(MIGRATION, /create trigger p4s_mask_agent_run before insert or update of input, output, error on ai\.agent_runs/);
    assert.match(MIGRATION, /create trigger p4s_mask_agent_step before insert or update of request, response, error on ai\.agent_steps/);
  });
  test('a name=value secret cannot break the JSON: masking walks string leaves, not the serialised text', () => {
    assert.match(region(MIGRATION, 'create or replace function projects.p4s_mask_json', 'revoke all'), /jsonb_typeof\(p\)[\s\S]*when 'string' then return to_jsonb\(projects\.mask_secrets\(p #>> '\{\}'\)\)/);
  });
});
