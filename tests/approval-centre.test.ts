import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

/**
 * The approval centre — gap G-044, directive §27.
 *
 * The engine (G-040) held decisions nobody could see. This is the queue that
 * shows them, and the action that settles one.
 *
 * The action is **executed** rather than read. The repository's earlier action
 * tests assert on source text, which is what was available before; a
 * `'use server'` module is an ordinary module of async functions at run time,
 * so the outcome mapping can be driven for real with the service stubbed. Two
 * things are still asserted structurally, at the bottom, and both are about
 * what the page must NOT do.
 */

type Result =
  | { ok: true; data: { requestId: string; state: string; decidedAt: string } }
  | { ok: false; error: { code: string; message: string; details?: Record<string, string[]> } };

let outcome: Result = {
  ok: true,
  data: { requestId: 'r1', state: 'approved', decidedAt: '2026-08-12T00:00:00.000Z' },
};

const seen = {
  inputs: [] as Record<string, unknown>[],
  revalidated: [] as string[],
  /** Which subject the settled decision was carried onto, and its id. */
  carried: [] as [string, string][],
};

/**
 * The request the action reads back to find out what it just settled.
 *
 * G-112: until this landed, `syncDeliverableDecision` and
 * `syncProposalDecision` had no caller at all, so a decision was recorded in
 * the engine and the thing it answered never heard about it.
 */
let subject: { subject_type: string; subject_id: string | null } | null = {
  subject_type: 'invoice',
  subject_id: 's1',
};
let carryOk = true;

mock.module('next/cache', {
  exports: {
    revalidatePath: (path: string) => {
      seen.revalidated.push(path);
    },
  },
});
mock.module('@/modules/approvals/service', {
  exports: {
    decideApproval: async (input: Record<string, unknown>) => {
      seen.inputs.push(input);
      return outcome;
    },
    // `actions.ts` imports this too now — a mock that omits an export the
    // module under test imports fails at load with a message about the
    // MODULE, which reads like the export is missing from the real file.
    upsertApprovalPolicy: async (input: Record<string, unknown>) => {
      seen.inputs.push(input);
      return { ok: true, data: { id: 'policy-1' } };
    },
  },
});
mock.module('@/modules/approvals/queries', {
  exports: { getApproval: async () => subject },
});
mock.module('@/modules/sales/service', {
  exports: {
    syncProposalDecision: async (id: string) => {
      seen.carried.push(['proposal', id]);
      return carryOk ? { ok: true, data: { status: 'approved' } } : { ok: false, error: { code: 'INTERNAL', message: 'no' } };
    },
  },
});
mock.module('@/modules/projects/service', {
  exports: {
    syncDeliverableDecision: async (id: string) => {
      seen.carried.push(['deliverable', id]);
      return carryOk ? { ok: true, data: { status: 'approved' } } : { ok: false, error: { code: 'INTERNAL', message: 'no' } };
    },
  },
});

const { decideApprovalAction } = await import('../src/modules/approvals/actions.ts');

const IDLE = { status: 'idle' as const };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
}

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

beforeEach(() => {
  seen.inputs = [];
  seen.revalidated = [];
  seen.carried = [];
  subject = { subject_type: 'invoice', subject_id: 's1' };
  carryOk = true;
  outcome = { ok: true, data: { requestId: 'r1', state: 'approved', decidedAt: '2026-08-12T00:00:00.000Z' } };
});

describe('A. settling a request', () => {
  test('an approval says so, and refreshes the queue', async () => {
    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.status, 'success');
    assert.equal(state.message, 'Approved.');
    assert.deepEqual(seen.revalidated, ['/approvals']);
  });

  test('the three decisions each report what actually happened', async () => {
    for (const [decision, said] of [
      ['approved', 'Approved.'],
      ['rejected', 'Rejected.'],
      ['changes_requested', 'Changes requested.'],
    ] as const) {
      outcome = { ok: true, data: { requestId: 'r1', state: decision, decidedAt: 'now' } };
      const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision }));
      assert.equal(state.message, said, `${decision} reported as "${state.message}"`);
    }
  });

  test('the message reports the state the database wrote, not the button pressed', async () => {
    // The two can differ: the engine is what decides, and this is the shape
    // that stops the screen inventing an outcome the row does not carry.
    outcome = { ok: true, data: { requestId: 'r1', state: 'rejected', decidedAt: 'now' } };

    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.message, 'Rejected.');
  });

  test('optional fields are omitted rather than sent empty', async () => {
    await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved', note: '   ' }));

    const input = seen.inputs[0]!;
    assert.ok(!('note' in input), 'a note of spaces is not a note');
    assert.ok(!('evidenceRef' in input), 'an absent evidence reference is absent, not empty');
  });

  test('evidence is passed through when the client’s decision is being recorded', async () => {
    await decideApprovalAction(
      IDLE,
      form({ requestId: 'r1', decision: 'approved', evidenceRef: 'wamid.ABC', note: 'client said yes' }),
    );

    assert.equal(seen.inputs[0]!.evidenceRef, 'wamid.ABC');
    assert.equal(seen.inputs[0]!.note, 'client said yes');
  });
});

describe('B. refusals, each said in its own words', () => {
  test('a refusal from the engine is surfaced as written', async () => {
    outcome = { ok: false, error: { code: 'FORBIDDEN', message: 'This approval needs a different role.' } };

    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.status, 'error');
    assert.equal(
      state.message,
      'This approval needs a different role.',
      'flattening this to "something went wrong" loses the only useful part',
    );
    assert.deepEqual(seen.revalidated, [], 'nothing changed, so nothing is revalidated');
  });

  test('somebody else answering first is reported as their answer', async () => {
    outcome = { ok: false, error: { code: 'CONFLICT', message: 'This request was already rejected.' } };

    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.status, 'error');
    assert.match(state.message!, /already rejected/);
  });

  test('a missing evidence reference lights up its own field', async () => {
    outcome = {
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'Recording a client decision needs the evidence it came from.',
        details: { evidenceRef: ['Where the client agreed.'] },
      },
    };

    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.status, 'error');
    assert.deepEqual(state.fieldErrors, { evidenceRef: ['Where the client agreed.'] });
  });

  test('`expired` is not a button, and never reaches the service', async () => {
    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'expired' }));

    assert.equal(state.status, 'error');
    assert.equal(seen.inputs.length, 0, 'the system expires a request; a person does not');
  });

  test('`cancelled` is not offered on this screen either', async () => {
    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'cancelled' }));

    assert.equal(state.status, 'error');
    assert.equal(seen.inputs.length, 0);
  });
});

describe('C. the decision is carried back onto what it answered (G-112)', () => {
  test('a quotation approval lands on the quotation', async () => {
    subject = { subject_type: 'proposal', subject_id: 'p1' };

    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.status, 'success');
    assert.deepEqual(seen.carried, [['proposal', 'p1']]);
  });

  test('a deliverable approval lands on the deliverable', async () => {
    // The case that was silently broken: settling this used to leave the
    // deliverable `in_review` forever, because nothing called the sync.
    subject = { subject_type: 'deliverable', subject_id: 'd1' };

    await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.deepEqual(seen.carried, [['deliverable', 'd1']]);
  });

  test('a refusal is carried too — it is what sends a quotation back to draft', async () => {
    subject = { subject_type: 'proposal', subject_id: 'p1' };
    outcome = { ok: true, data: { requestId: 'r1', state: 'rejected', decidedAt: 'now' } };

    await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'rejected' }));

    assert.deepEqual(seen.carried, [['proposal', 'p1']]);
  });

  test('every other subject type gates by reading the engine, so nothing is carried', async () => {
    for (const type of ['invoice', 'refund', 'scope_change', 'prototype', 'agent_action', 'ticket_plan']) {
      subject = { subject_type: type, subject_id: 'x' };
      const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));
      assert.equal(state.message, 'Approved.', `${type} said "${state.message}"`);
    }
    assert.deepEqual(seen.carried, []);
  });

  test('a decision whose subject cannot be read is still a decision', async () => {
    subject = null;

    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.status, 'success');
    assert.equal(state.message, 'Approved.');
  });

  test('a carry that fails says so rather than reporting a clean approval', async () => {
    // The decision is durable either way. Somebody told only "Approved." would
    // go looking for a quotation that still reads pending_approval.
    subject = { subject_type: 'proposal', subject_id: 'p1' };
    carryOk = false;

    const state = await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.equal(state.status, 'success');
    assert.match(state.message!, /^Approved\./);
    assert.match(state.message!, /could not be updated/);
  });

  test('nothing is carried when the decision itself failed', async () => {
    subject = { subject_type: 'proposal', subject_id: 'p1' };
    outcome = { ok: false, error: { code: 'FORBIDDEN', message: 'This approval needs a different role.' } };

    await decideApprovalAction(IDLE, form({ requestId: 'r1', decision: 'approved' }));

    assert.deepEqual(seen.carried, [], 'a refused decision must not move the subject');
  });
});

describe('D. what the page must not do', () => {
  const page = read('../app/(internal)/approvals/page.tsx');
  const formComponent = read('../app/(internal)/approvals/approval-decision-form.tsx');

  test('the page does not decide who may settle — the row and the lock do', () => {
    assert.doesNotMatch(
      page,
      /canSettle\(/,
      'a role check here would be a copy of the rule that can go stale; the refusal comes from the engine',
    );
    assert.doesNotMatch(formComponent, /canSettle\(/);
  });

  test('the page says what happens to an overdue request, now that something does', () => {
    // This asserted the opposite until G-096 landed: the page used to say
    // nobody was notified, which was true and worth saying. It now says what
    // the cron tick does, and the one thing that must never change is the
    // last clause.
    assert.match(page, /expired on the next cron tick and raised again with the owner/);
    assert.match(page, /Nothing is ever approved by silence/);
  });
});

/**
 * The form that was written for and never written — ADM-08b.
 *
 * `upsertApprovalPolicy` has existed since the engine landed, and
 * `violatesMoneyFloor` says in its own comment that it exists *"so a form can
 * say why before submitting"*. **No form was ever written.** So on a fresh
 * deployment there is no policy at all, `sales.submit_proposal` answers
 * `no_policy`, and the message an owner reads — *"An owner sets one before
 * this can be approved"* — names an action the product offered nowhere. The
 * whole of ADM-07's close path stopped at the first submit.
 */
describe('an owner can set the policy the error message tells them to set', () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

  test('there is an action, and it reaches the service that was already there', () => {
    const actions = read('src/modules/approvals/actions.ts');
    assert.match(actions, /export async function upsertApprovalPolicyAction/);
    assert.match(actions, /await upsertApprovalPolicy\(/);
  });

  test('the service writes through set_policy, never through PostgREST\u2019s upsert \u2014 G-158', () => {
    // The rung index is PARTIAL (`where active`), and a partial index can
    // only be an upsert's conflict target when the statement states the
    // predicate. PostgREST's upsert cannot, so the Set policy button failed
    // with 42P10 on EVERY press, including the first \u2014 and nothing went
    // red, because the live scripts planted policies with plain POSTs and
    // these tests mocked the client. verify-approvals \u00a72b now walks the
    // form's own door; this pin keeps the service ON that door.
    const service = readFileSync(
      fileURLToPath(new URL('../src/modules/approvals/service.ts', import.meta.url)),
      'utf8',
    );
    const fn = service.slice(service.indexOf('export async function upsertApprovalPolicy'));
    assert.match(fn, /\.rpc\('set_policy', \{/);
    assert.ok(!/\.upsert\(/.test(fn), 'the broken upsert path came back');
    // And the function itself states the predicate \u2014 the load-bearing clause.
    const migration = readFileSync(
      fileURLToPath(new URL('../supabase/migrations/20260823230000_the_policy_button_never_worked.sql', import.meta.url)),
      'utf8',
    );
    assert.match(migration, /on conflict \(organization_id, subject_type, min_amount_minor\) where active/);
  });

  test('and a form on the owner’s configuration page, not on the queue', () => {
    const settings = read('app/(internal)/settings/page.tsx');
    const approvals = read('app/(internal)/approvals/page.tsx');
    assert.match(settings, /<ApprovalPolicyForm/);
    // The approvals page's own reasoning, honoured rather than overturned:
    // "changing who may approve what is an authority change… not a screen a
    // queue view should hand out."
    assert.doesNotMatch(approvals, /ApprovalPolicyForm|upsertApprovalPolicy/);
  });

  test('every subject type and role the schema admits is offered', () => {
    const settings = read('app/(internal)/settings/page.tsx');
    // Passed from the schema rather than restated in JSX — a hand-written list
    // is a fourth copy, and the one that drifts offers a value the row refuses.
    assert.match(settings, /subjectTypes=\{APPROVAL_SUBJECT_TYPES\}/);
    assert.match(settings, /roles=\{APPROVER_ROLES\}/);
  });

  test('the money floor is stated on the form, not discovered on submit', () => {
    const forms = read('app/(internal)/settings/forms.tsx');
    assert.match(forms, /Refunds are owner-only/);
    assert.match(forms, /stricter, never looser/);
  });

  /**
   * The floor helper had no caller at all. It is the rule restated for a
   * reader; the DDL constraint is the rule.
   */
  test('and the helper that exists for it still refuses what the DDL refuses', async () => {
    const { violatesMoneyFloor } = await import('../src/modules/approvals/schema.ts');
    assert.ok(violatesMoneyFloor({ subjectType: 'refund', requiredRole: 'ops_admin' }));
    assert.ok(violatesMoneyFloor({ subjectType: 'invoice', requiredRole: 'delivery_lead' }));
    assert.equal(violatesMoneyFloor({ subjectType: 'refund', requiredRole: 'owner' }), null);
    assert.equal(violatesMoneyFloor({ subjectType: 'proposal', requiredRole: 'delivery_lead' }), null);
  });
});
