import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The three Phase 8A agent workflows, run against a STAND-IN model and a STAND-IN database. NOTHING here ran on a real model. What is proved is the ORDER (read
 * for the job's organization, ask, validate, then write), the REFUSALS (a shape that is not the schema, a price, a discount, a commitment, a claim of work done, a
 * secret, a coverage the facts do not support, evidence the facts do not contain) and WHERE each writes: ONE service-only door each, never a classification, a send,
 * a completed check-in, a qualification, a handoff, a quote or a discount.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
/** Source with its comments removed: a comment may NAME a forbidden door to say it is not used. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const events: string[] = [];
let modelResult: unknown = null;
let rpcAnswer: Record<string, unknown> = {};
let rpcCalls: { schema: string; fn: string; args: Record<string, unknown> }[] = [];
let readFilters: { table: string; column: string; value: unknown }[] = [];
let tables: Record<string, Record<string, unknown>[]> = {};
let jobUpdates: Record<string, unknown>[] = [];
let lastPrompt = '';

mock.module('../app/api/jobs/run/agent-run.ts', {
  namedExports: {
    settledSucceeded: { status: 'succeeded' },
    openRun: async () => { events.push('openRun'); return 'run-1'; },
    finishRun: async (_a: unknown, _r: unknown, status: string) => { events.push(`finishRun:${status}`); },
    succeedRun: async () => { events.push('succeedRun'); },
    failJob: async (_a: unknown, _j: unknown, reason: string) => { events.push(`failJob:${reason}`); },
    callModel: async (_c: unknown, _w: unknown, messages: { content: string }[]) => { events.push('model'); lastPrompt = messages[0]?.content ?? ''; return modelResult; },
  },
});

const { PHASE_EIGHT_CS_WORKFLOWS } = await import('../app/api/jobs/run/phase-eight-cs-workflows.ts');
const proposals = await import('../src/modules/projects/phase-eight-proposals.ts');
const { definitionFor } = await import('../src/modules/agents/registry.ts');

function makeAdmin() {
  return {
    schema: (s: string) => ({
      rpc: async (fn: string, args: Record<string, unknown>) => {
        events.push(`rpc:${s}.${fn}`);
        rpcCalls.push({ schema: s, fn, args });
        return { data: rpcAnswer[fn] ?? [{ outcome: 'proposed' }], error: null };
      },
      from: (table: string) => {
        const rows = tables[`${s}.${table}`] ?? [];
        const chain: Record<string, unknown> = {};
        for (const m of ['select', 'in', 'order', 'limit']) chain[m] = () => chain;
        chain.update = (v: Record<string, unknown>) => { jobUpdates.push(v); return chain; };
        chain.eq = (column: string, value: unknown) => { readFilters.push({ table: `${s}.${table}`, column, value }); return chain; };
        chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
        chain.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
        return chain;
      },
    }),
  };
}
const ctxFor = (agentKey: string, payload: Record<string, unknown>) =>
  ({ admin: makeAdmin(), job: { id: 'job-1', organization_id: 'org-1', payload, correlation_id: 'c', attempts: 0, max_attempts: 5 }, agent: { key: agentKey, autonomy_level: 'L1', default_model: 'm' } }) as never;
const usage = { inputTokens: 1, outputTokens: 1, costMinor: 0 };
const answer = (json: unknown) => { modelResult = { ok: true, json, usage, stepCount: 1 }; };
const wf = (kind: string) => PHASE_EIGHT_CS_WORKFLOWS.find((w: { jobKind: string }) => w.jobKind === kind)!;
const secret = () => `api_key=${'x'.repeat(20)}`;

const T1 = '00000000-0000-4000-8000-0000000000a1';
const T2 = '00000000-0000-4000-8000-0000000000a2';
const CI = '00000000-0000-4000-8000-0000000000c1';
const SIG = '00000000-0000-4000-8000-0000000000e1';
const STRANGER = '00000000-0000-4000-8000-0000000000ff';

const today = new Date().toISOString().slice(0, 10);
const reset = () => {
  events.length = 0; rpcCalls = []; readFilters = []; rpcAnswer = {}; modelResult = null; jobUpdates = []; lastPrompt = '';
  tables = {
    'projects.support_tickets': [{ id: T1, project_id: 'p-1', title: 'Checkout button does nothing', description: 'It broke after Tuesday', status: 'new', raised_at: `${today}T10:00:00Z`, classification: 'change_request', priority: 'p2' }],
    'projects.phase_eight': [{ state: 'active', warranty_starts_on: '2000-01-01', warranty_ends_on: '2999-12-31' }],
    'projects.maintenance_plans': [{ name: 'Care plan', version: 1, status: 'active', starts_on: '2000-01-01', ends_on: '2999-12-31' }],
    'projects.projects': [{ name: 'Shop', status: 'completed' }],
    'projects.cs_check_ins': [{ id: CI, project_id: 'p-1', kind: 'adoption', status: 'due', outcome: 'spoke about reports' }],
    'sales.upsell_signals': [{ id: SIG, kind: 'scope_added' }],
  };
  rpcAnswer.customer_health_status = [{ status: 'stable', reasons: [{ signal: 'open_tickets', value: '1', level: 'ok', detail: 'x' }] }];
};

const supportAnswer = (over: Record<string, unknown> = {}) => ({ proposedClassification: 'how_to', rationale: 'The client asks how something works.', draftReply: 'Thanks for writing. We are looking at the checkout button.', language: 'en', ...over });

describe('the three workflows', () => {
  test('one job kind and one agent each, all draft work, all agents the registry defines in the operations layer', () => {
    assert.deepEqual(PHASE_EIGHT_CS_WORKFLOWS.map((w: { jobKind: string }) => w.jobKind), ['support.propose_ticket_handling', 'customer_success.draft_check_in_agenda', 'upsell.propose_opportunity']);
    for (const w of PHASE_EIGHT_CS_WORKFLOWS) {
      assert.equal(w.workClass, 'draft');
      assert.equal(definitionFor(w.agentKey)?.layer, 'operations');
      assert.match(w.jobKind, /^[a-z_]+\.[a-z_]+$/);
    }
  });
  test('their job kinds collide with no other workflow', () => {
    const kinds = readdirSync(fileURLToPath(new URL('../app/api/jobs/run/', import.meta.url)))
      .filter((f) => f.endsWith('.ts') && f !== 'phase-eight-cs-workflows.ts')
      .flatMap((f) => [...read(`app/api/jobs/run/${f}`).matchAll(/^\s*jobKind: '([a-z_.]+)',/gm)].map((m) => m[1]!));
    for (const w of PHASE_EIGHT_CS_WORKFLOWS) assert.ok(!kinds.includes(w.jobKind), w.jobKind);
  });
  test('the file is NOT yet wired into the runner: the parent appends the spread (report it)', () => {
    const src = read('app/api/jobs/run/workflows.ts');
    assert.ok(!src.includes('PHASE_EIGHT_CS_WORKFLOWS') || /\.\.\.PHASE_EIGHT_CS_WORKFLOWS/.test(src), 'either absent, or wired as ONE spread');
  });
  test('the source writes ONLY through the three proposal doors and never classifies, sends, completes, qualifies, hands off, quotes or discounts', () => {
    const src = code('app/api/jobs/run/phase-eight-cs-workflows.ts');
    const rpcs = [...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(rpcs.filter((n) => n!.startsWith('record_')), ['record_support_proposal', 'record_check_in_agenda', 'record_phase_eight_opportunity']);
    assert.deepEqual([...new Set(rpcs.filter((n) => !n!.startsWith('record_')))], ['customer_health_status'], 'the only other call is the derived health read');
    for (const forbidden of ['classify_support_ticket', 'advance_support_ticket', 'record_client_confirmation', 'record_support_reply_sent', 'draft_support_reply', 'complete_check_in', 'qualify_phase_eight_opportunity',
      'hand_off_phase_eight_opportunity', 'close_phase_eight_opportunity', 'sales.proposals', 'record_discount_decision', 'set_proposal_pricing', 'draft_proposal', 'send_outbound_message', 'open_renewal', '.insert(', '.delete(', '.upsert(']) {
      assert.ok(!src.includes(forbidden), `the workflow must not use ${forbidden}`);
    }
    assert.equal([...src.matchAll(/\.update\(/g)].length, 1, 'the only update is settling its own core.jobs row');
  });
});

describe('support: propose a classification and a reply DRAFT', () => {
  test('order: read, model, then the one door, with the job\'s organization and the support agent', async () => {
    reset();
    answer(supportAnswer());
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['openRun', 'model', 'rpc:projects.record_support_proposal', 'succeedRun']);
    const args = rpcCalls[0]!.args;
    assert.equal(args.p_organization_id, 'org-1');
    assert.equal(args.p_ticket_id, T1);
    assert.equal(args.p_agent_key, 'support');
    assert.equal(args.p_proposed_classification, 'how_to');
    assert.match(String(args.p_draft_body), /looking at the checkout button/);
    assert.match(lastPrompt, /Checkout button does nothing/);
  });
  test('every read is scoped to the JOB\'s organization, never one the payload names', async () => {
    reset();
    answer(supportAnswer());
    await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1, organizationId: 'org-2', organization_id: 'org-2' }));
    const orgFilters = readFilters.filter((f) => f.column === 'organization_id');
    assert.ok(orgFilters.length >= 4);
    assert.ok(orgFilters.every((f) => f.value === 'org-1'));
    assert.equal(rpcCalls[0]!.args.p_organization_id, 'org-1');
  });
  test('a ticket in another organization is simply not there: nothing is asked and nothing is written', async () => {
    reset();
    tables['projects.support_tickets'] = [];
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
    assert.equal(r.status, 'succeeded');
    assert.equal((r as { outcome?: string }).outcome, 'gone');
    assert.ok(!events.includes('model') && rpcCalls.length === 0);
  });
  test('a closed ticket is not worked on', async () => {
    reset();
    tables['projects.support_tickets'] = [{ id: T1, project_id: 'p-1', title: 't', status: 'closed', raised_at: `${today}T00:00:00Z` }];
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
    assert.equal((r as { outcome?: string }).outcome, 'gone');
    assert.ok(!events.includes('model'));
  });
  test('a payload with no ticket fails before anything is read', async () => {
    reset();
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', {}));
    assert.equal(r.status, 'failed');
    assert.ok(events.some((e) => e.startsWith('failJob:')) && !events.includes('model'));
  });
  for (const [what, over] of [
    ['an extra key', { surprise: true }],
    ['a classification outside the vocabulary', { proposedClassification: 'covered_warranty' }],
    ['a price in the draft', { draftReply: 'We can do this for ₹5000 this week.' }],
    ['a currency word in the draft', { draftReply: 'It will cost Rs. 500.' }],
    ['a discount in the draft', { draftReply: 'We can offer a discount on the next module.' }],
    ['a refund promise', { draftReply: 'We will refund you in full.' }],
    ['free work', { draftReply: 'We will do it free of charge.' }],
    ['a claim that something was fixed', { draftReply: 'We have fixed the button and deployed it.' }],
    ['a deadline promise', { draftReply: 'It will be fixed by tomorrow.' }],
    ['a secret in the draft', { draftReply: `Use ${secret()} to log in.` }],
    ['a price in the rationale', { rationale: 'Quote them $200 for it.' }],
    ['nothing proposed', { proposedClassification: null, draftReply: null }],
  ] as const) {
    test(`refused before any write: ${what}`, async () => {
      reset();
      answer(supportAnswer(over));
      const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
      assert.equal(r.status, 'failed');
      assert.equal(rpcCalls.length, 0, 'the door is never called');
      assert.ok(events.some((e) => e.startsWith('failJob:the model')));
    });
  }
  test('a warranty bug is not proposed for a day outside the warranty window', async () => {
    reset();
    tables['projects.phase_eight'] = [{ state: 'active', warranty_starts_on: '2000-01-01', warranty_ends_on: '2000-02-01' }];
    answer(supportAnswer({ proposedClassification: 'warranty_bug' }));
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
    assert.equal(r.status, 'failed');
    assert.equal(rpcCalls.length, 0);
  });
  test('maintenance is not proposed when no plan is active', async () => {
    reset();
    tables['projects.maintenance_plans'] = [];
    answer(supportAnswer({ proposedClassification: 'maintenance' }));
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
    assert.equal(r.status, 'failed');
    assert.equal(rpcCalls.length, 0);
  });
  test('a reply-only proposal (no classification) is valid', async () => {
    reset();
    answer(supportAnswer({ proposedClassification: null }));
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
    assert.equal(r.status, 'succeeded');
    assert.equal(rpcCalls[0]!.args.p_proposed_classification, null);
  });
  test('a door refusal fails the job with the door\'s word, and a retried proposal is a good answer', async () => {
    reset();
    answer(supportAnswer());
    rpcAnswer.record_support_proposal = [{ outcome: 'not_found' }];
    assert.equal((await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }))).status, 'failed');
    assert.ok(events.includes('finishRun:failed') && events.some((e) => e === 'failJob:the door answered not_found'));
    reset();
    answer(supportAnswer());
    rpcAnswer.record_support_proposal = [{ outcome: 'already_proposed' }];
    assert.equal((await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }))).status, 'succeeded');
  });
  test('no provider configured is reported as exactly that, and nothing is written', async () => {
    reset();
    modelResult = { ok: false, kind: 'no_provider', detail: 'no key', stepCount: 0 };
    const r = await wf('support.propose_ticket_handling').run(ctxFor('support', { ticketId: T1 }));
    assert.equal(r.status, 'failed');
    assert.equal((r as { reason?: string }).reason, 'AI_PROVIDER_NOT_CONFIGURED');
    assert.equal(rpcCalls.length, 0);
  });
});

describe('customer success: draft an agenda for a DUE check-in', () => {
  const point = (over: Record<string, unknown> = {}) => ({ kind: 'confirm_use', note: 'Ask how the reports are used.', ticketId: null, ...over });
  test('a valid agenda is rendered and written through the one door, the check-in staying due', async () => {
    reset();
    answer({ points: [point(), point({ kind: 'feedback_to_collect', note: 'Ask what they would change.' })] });
    rpcAnswer.record_check_in_agenda = [{ outcome: 'recorded' }];
    const r = await wf('customer_success.draft_check_in_agenda').run(ctxFor('customer_success', { checkInId: CI }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['rpc:projects.customer_health_status', 'openRun', 'model', 'rpc:projects.record_check_in_agenda', 'succeedRun']);
    const args = rpcCalls.find((c) => c.fn === 'record_check_in_agenda')!.args;
    assert.equal(args.p_agent_key, 'customer_success');
    assert.equal(args.p_organization_id, 'org-1');
    assert.match(String(args.p_agenda), /^1\. Confirm the product is being used: Ask how the reports are used\.\n2\. Feedback to collect:/);
  });
  test('a check-in that is no longer due (completed or skipped) is not drafted for', async () => {
    reset();
    tables['projects.cs_check_ins'] = [{ id: CI, project_id: 'p-1', kind: 'adoption', status: 'completed' }];
    const r = await wf('customer_success.draft_check_in_agenda').run(ctxFor('customer_success', { checkInId: CI }));
    assert.equal((r as { outcome?: string }).outcome, 'gone');
    assert.ok(!events.includes('model'));
  });
  test('a check-in in another organization is not there', async () => {
    reset();
    tables['projects.cs_check_ins'] = [];
    const r = await wf('customer_success.draft_check_in_agenda').run(ctxFor('customer_success', { checkInId: CI }));
    assert.equal((r as { outcome?: string }).outcome, 'gone');
    assert.ok(readFilters.every((f) => f.column !== 'organization_id' || f.value === 'org-1'));
  });
  for (const [what, body, health] of [
    ['an unresolved issue citing a ticket that is not open', { points: [point({ kind: 'unresolved_issue', ticketId: STRANGER, note: 'Follow up the checkout bug.' })] }, 'stable'],
    ['an unresolved issue citing nothing', { points: [point({ kind: 'unresolved_issue', note: 'Some problem.' })] }, 'stable'],
    ['new work raised while the account is at risk', { points: [point({ kind: 'possible_new_work', note: 'A loyalty module.' })] }, 'at_risk'],
    ['a renewal point with no maintenance plan', { points: [point({ kind: 'renewal_timing', note: 'Plan the renewal.' })] }, 'stable'],
    ['a price in a point', { points: [point({ note: 'Mention the new module at $500.' })] }, 'stable'],
    ['a discount in a point', { points: [point({ note: 'Offer a 20% off discount.' })] }, 'stable'],
    ['a secret in a point', { points: [point({ note: `Ask about ${secret()}.` })] }, 'stable'],
    ['no points', { points: [] }, 'stable'],
    ['an extra key', { points: [point()], surprise: 1 }, 'stable'],
  ] as const) {
    test(`refused before any write: ${what}`, async () => {
      reset();
      rpcAnswer.customer_health_status = [{ status: health, reasons: [] }];
      if (what.includes('renewal')) tables['projects.maintenance_plans'] = [];
      answer(body);
      const r = await wf('customer_success.draft_check_in_agenda').run(ctxFor('customer_success', { checkInId: CI }));
      assert.equal(r.status, 'failed');
      assert.equal(rpcCalls.filter((c) => c.fn.startsWith('record_')).length, 0, 'the door is never called');
    });
  }
  test('a person-written agenda is never overwritten, and that is a complete answer', async () => {
    reset();
    answer({ points: [point()] });
    rpcAnswer.record_check_in_agenda = [{ outcome: 'a_person_wrote_the_agenda' }];
    assert.equal((await wf('customer_success.draft_check_in_agenda').run(ctxFor('customer_success', { checkInId: CI }))).status, 'succeeded');
  });
});

describe('upsell: record an opportunity DETECTED from evidence', () => {
  const opp = (over: Record<string, unknown> = {}) => ({ kind: 'change_request', need: 'The client has twice asked for a loyalty module in the app.', requestedOutcome: 'loyalty points', urgency: 'normal', stakeholders: null, constraints: null, evidence: [{ type: 'ticket', id: T2 }], ...over });
  const withTicket = () => { tables['projects.support_tickets'] = [{ id: T2, title: 'Add loyalty points', description: 'we want a loyalty module', classification: 'change_request' }]; };
  test('a valid opportunity is written through the one door as the upsell agent, in the job\'s organization', async () => {
    reset(); withTicket();
    answer({ opportunity: opp(), reason: 'Two requests for the same new feature.' });
    rpcAnswer.record_phase_eight_opportunity = [{ outcome: 'recorded' }];
    const r = await wf('upsell.propose_opportunity').run(ctxFor('upsell', { projectId: 'p-1' }));
    assert.equal(r.status, 'succeeded');
    assert.deepEqual(events.filter((e) => e.startsWith('rpc:') || ['openRun', 'model', 'succeedRun'].includes(e)), ['rpc:projects.customer_health_status', 'openRun', 'model', 'rpc:sales.record_phase_eight_opportunity', 'succeedRun']);
    const args = rpcCalls.find((c) => c.fn === 'record_phase_eight_opportunity')!.args;
    assert.equal(args.p_agent_key, 'upsell');
    assert.equal(args.p_organization_id, 'org-1');
    assert.deepEqual(args.p_evidence, [{ type: 'ticket', id: T2 }]);
    assert.equal(Object.keys(args).some((k) => /price|amount|quote|discount/i.test(k)), false, 'the door call carries no price field');
  });
  test('no legitimate opportunity is a good answer and writes nothing', async () => {
    reset();
    answer({ opportunity: null, reason: 'Nothing recorded suggests new work.' });
    const r = await wf('upsell.propose_opportunity').run(ctxFor('upsell', { projectId: 'p-1' }));
    assert.equal(r.status, 'succeeded');
    assert.equal((r as { outcome?: string }).outcome, 'no_opportunity');
    assert.equal(rpcCalls.filter((c) => c.fn === 'record_phase_eight_opportunity').length, 0);
  });
  for (const [what, body] of [
    ['evidence that is not in the facts', { opportunity: opp({ evidence: [{ type: 'ticket', id: STRANGER }] }), reason: 'x' }],
    ['a ticket that is not classified as out of scope', { opportunity: opp(), reason: 'x', _classification: 'how_to' }],
    ['a price in the need', { opportunity: opp({ need: 'A loyalty module, quoted at ₹50000 as agreed.' }), reason: 'x' }],
    ['a discount in the constraints', { opportunity: opp({ constraints: 'Offer a discount to win it.' }), reason: 'x' }],
    ['a secret in the need', { opportunity: opp({ need: `The client shared ${secret()} for the integration.` }), reason: 'x' }],
    ['no evidence', { opportunity: opp({ evidence: [] }), reason: 'x' }],
    ['a kind outside the vocabulary', { opportunity: opp({ kind: 'renewal' }), reason: 'x' }],
    ['a price field smuggled in', { opportunity: { ...opp(), price: 100 }, reason: 'x' }],
  ] as const) {
    test(`refused before any write: ${what}`, async () => {
      reset(); withTicket();
      if ('_classification' in body) tables['projects.support_tickets'] = [{ id: T2, title: 'How do I export', description: null, classification: 'how_to' }];
      const { _classification, ...answerBody } = body as Record<string, unknown>;
      void _classification;
      answer(answerBody);
      const r = await wf('upsell.propose_opportunity').run(ctxFor('upsell', { projectId: 'p-1' }));
      assert.equal(r.status, 'failed');
      assert.equal(rpcCalls.filter((c) => c.fn === 'record_phase_eight_opportunity').length, 0, 'the door is never called');
    });
  }
  test('a retried run is the same opportunity (duplicate is a good answer); a door refusal such as already_included is a failure, not hidden', async () => {
    reset(); withTicket();
    answer({ opportunity: opp(), reason: 'Two requests.' });
    rpcAnswer.record_phase_eight_opportunity = [{ outcome: 'duplicate' }];
    assert.equal((await wf('upsell.propose_opportunity').run(ctxFor('upsell', { projectId: 'p-1' }))).status, 'succeeded');
    reset(); withTicket();
    answer({ opportunity: opp(), reason: 'Two requests.' });
    rpcAnswer.record_phase_eight_opportunity = [{ outcome: 'already_included' }];
    assert.equal((await wf('upsell.propose_opportunity').run(ctxFor('upsell', { projectId: 'p-1' }))).status, 'failed');
  });
  test('a project in another organization is simply not there', async () => {
    reset();
    tables['projects.projects'] = [];
    const r = await wf('upsell.propose_opportunity').run(ctxFor('upsell', { projectId: 'p-1' }));
    assert.equal((r as { outcome?: string }).outcome, 'gone');
    assert.ok(!events.includes('model'));
  });
});

describe('the pure rules', () => {
  const cases: [string, boolean][] = [
    ['It costs ₹5000', true], ['pay $20 a month', true], ['about Rs. 500', true], ['Rs 500', true], ['INR 100', true], ['500 rupees', true], ['10 dollars', true], ['a 20% off discount', true], ['discount', true],
    ['we will update you within 4 hours', false], ['the hours of operation are 9 to 5', false], ['tours 5 days a week', false], ['your users 5 and 6', false], ['Thanks for your message', false],
  ];
  for (const [text, expected] of cases) test(`namesAPrice(${JSON.stringify(text)}) is ${expected}`, () => assert.equal(proposals.namesAPrice(text), expected));
  test('the price pattern is held equal to the one in the migrations (reply drafts, agendas, opportunities and the three doors)', () => {
    const dir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
    const files = readdirSync(dir).filter((f) => /^2026110[5][0-9]{6}_/.test(f));
    const all = files.map((f) => readFileSync(`${dir}${f}`, 'utf8')).join('\n');
    const occurrences = all.split(proposals.PRICE_PATTERN).length - 1;
    assert.ok(occurrences >= 6, `the SQL carries the pattern ${occurrences} times`);
  });
  test('commitments are recognised: refund, free of charge, a guarantee, work claimed done, a deadline', () => {
    for (const t of ['We will refund you', 'free of charge', 'at no cost', 'We guarantee it', 'we have fixed it', 'We\'ve deployed the update', 'it will be fixed by Friday', 'The issue is now resolved']) assert.equal(proposals.makesACommitment(t), true, t);
    for (const t of ['We are looking into it', 'Could you tell us which page this happens on?']) assert.equal(proposals.makesACommitment(t), false, t);
  });
  test('the three prompts forbid pricing and invention, and name only what the agent may do', () => {
    for (const p of [proposals.supportSystemPrompt, proposals.agendaSystemPrompt, proposals.opportunitySystemPrompt]) {
      assert.match(p, /No price|names no price|never a price|Never write a price|no price|never invent|Do not invent|Never write a secret/i);
    }
    assert.match(proposals.opportunitySystemPrompt, /detected only|only as detected/i);
  });
  test('the JSON schemas are strict objects', () => {
    for (const s of [proposals.supportJsonSchema(), proposals.agendaJsonSchema(), proposals.opportunityJsonSchema()]) assert.equal((s as { additionalProperties?: boolean }).additionalProperties, false);
  });
});
