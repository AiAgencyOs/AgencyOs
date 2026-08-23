import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import {
  hasLapsed,
  isLiveProposal,
  LIVE_PROPOSAL_STATUSES,
  PROPOSAL_STATUSES,
  PROPOSAL_TRANSITIONS,
} from '../src/modules/sales/schema.ts';

/**
 * Quotations — gap G-011, decision ADM-07.
 *
 * `sales.proposals` and `sales.proposal_items` had tables, RLS and a version
 * column from the first day of this repository and no code at all.
 *
 * The guarantees that matter are held in Postgres and proved against a real
 * database by `scripts/verify-quotations.mjs` — 50 checks, and all three of
 * the guarantees spot-checked here were watched failing first with the trigger
 * and constraint removed. What is here is the vocabulary pinned against the
 * constraints it mirrors, the rules read out of the migration, and the
 * service's outcome mapping, which no live script exercises because it is the
 * translation from an outcome to a sentence.
 */

const migration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260813120019_the_quote_the_owner_signs.sql', import.meta.url),
  ),
  'utf8',
);

const salesMigration = readFileSync(
  fileURLToPath(new URL('../supabase/migrations/20260807120005_sales.sql', import.meta.url)),
  'utf8',
);

/** G-111 moved the status CHECK here when it added `lapsed`. */
const lapseMigration = readFileSync(
  fileURLToPath(
    new URL('../supabase/migrations/20260814120007_a_quotation_that_went_cold.sql', import.meta.url),
  ),
  'utf8',
);

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-not-a-real-one';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://agencyos.test';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-key-not-a-real-one';

const PROPOSAL = '11111111-1111-4111-8111-111111111111';
const OPPORTUNITY = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';

const seen = { calls: [] as [string, Record<string, unknown>][] };
const results = new Map<string, { data: unknown; error: { message: string } | null }>();

/**
 * Rows the service now READS, not just functions it calls.
 *
 * `sendProposal` composes the quotation from the proposal and its items, so
 * the stub needs a table reader as well as an RPC. It used to need neither:
 * "send" marked a row and sent nothing.
 */
const rows = new Map<string, unknown>();
const sent: { conversationId: string; body: string; idempotencyKey: string }[] = [];
const docsSent: { conversationId: string; filename: string; idempotencyKey: string; bytes: Uint8Array }[] = [];
/** How the document leg answers: 'ok' | 'transient' | 'permanent' | 'err'. */
const docMode = { value: 'ok' as 'ok' | 'transient' | 'permanent' | 'err' | 'forbidden' };
/** Flipped by one test — an ES module namespace cannot be reassigned. */
const refuseSend = { value: false };

const APPROVED_PROPOSAL = {
  id: PROPOSAL,
  version: 2,
  title: 'Delivery app',
  body: 'Covers the three apps. Does not cover marketing.',
  status: 'approved',
  currency: 'INR',
  subtotal_minor: 7000000,
  discount_minor: 0,
  tax_minor: 0,
  total_minor: 7000000,
  valid_until: null,
  conversation_id: '66666666-6666-4666-8666-666666666666',
  created_at: '2026-08-23T10:15:00Z',
  opportunity_id: '77777777-7777-4777-8777-777777777777',
};

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role: 'owner',
      userId: '44444444-4444-4444-8444-444444444444',
      organizationId: '55555555-5555-4555-8555-555555555555',
    }),
  },
});
mock.module('@/lib/audit', { exports: { recordAudit: async () => {} } });
mock.module('@/modules/crm/service', {
  exports: {
    markLeadConverted: async () => ({ ok: true, data: {} }),
    // The one path a quotation now takes to a client. Recorded rather than
    // performed, so a test can assert WHAT would have been sent.
    sendClientMessage: async (input: { conversationId: string; body: string; idempotencyKey: string }) => {
      if (refuseSend.value) {
        return { ok: false, error: { code: 'PROVIDER_ERROR', message: 'WhatsApp refused the message (401).' } };
      }
      sent.push(input);
      return { ok: true, data: { messageId: 'msg-1', seq: 7, delivered: true } };
    },
    sendClientDocument: async (input: {
      conversationId: string;
      filename: string;
      idempotencyKey: string;
      bytes: Uint8Array;
    }) => {
      if (docMode.value === 'err') {
        return { ok: false, error: { code: 'INTERNAL', message: 'Could not record the document.' } };
      }
      if (docMode.value === 'forbidden') {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'This contact has no recorded consent to be messaged on WhatsApp. Record their consent before AgencyOS sends to them.' } };
      }
      if (docMode.value === 'transient') {
        return { ok: true, data: { messageId: 'doc-1', seq: 8, delivered: false, retryable: true, reason: 'WhatsApp could not be reached.' } };
      }
      if (docMode.value === 'permanent') {
        return { ok: true, data: { messageId: 'doc-1', seq: 8, delivered: false, retryable: false, reason: 'WhatsApp refused the file (415).' } };
      }
      docsSent.push(input);
      return { ok: true, data: { messageId: 'doc-1', seq: 8, delivered: true } };
    },
  },
});
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            seen.calls.push([fn, args]);
            return results.get(fn) ?? { data: null, error: null };
          },
          from(table: string) {
            // Enough of the builder for what the service actually chains, and
            // no more — a fuller fake would be a second Supabase to maintain.
            // Thenable, so `.order('position')` and
            // `.order('position').order('created_at')` both await to the
            // same list — the real client's builders are thenable the same
            // way.
            const builder = {
              select: () => builder,
              eq: () => builder,
              limit: () => builder,
              order: () => builder,
              maybeSingle: () => Promise.resolve({ data: rows.get(table) ?? null, error: null }),
              then: (resolve: (value: unknown) => void) =>
                resolve({ data: rows.get(`${table}:list`) ?? [], error: null }),
            };
            return builder;
          },
        };
      },
    }),
  },
});

const {
  quotationPdfForProposal,
  addProposalItem,
  draftProposal,
  recordProposalResponse,
  sendProposal,
  setProposalPricing,
  submitProposal,
} = await import('../src/modules/sales/service.ts');

beforeEach(() => {
  seen.calls = [];
  results.clear();
  rows.clear();
  sent.length = 0;
  docsSent.length = 0;
  docMode.value = 'ok';
  refuseSend.value = false;
  // What the document renderer reads beyond the proposal: the letterhead and
  // the clock. Present by default so the PDF leg runs for real — the tests
  // that want the render to fail remove it.
  rows.set('organizations', { name: 'Bussen Hancer Agency', timezone: 'Asia/Kolkata' });
  rows.set('opportunities', { lead_id: null });
  rows.set('proposals', APPROVED_PROPOSAL);
  rows.set('proposal_items:list', [
    { description: 'Customer app', quantity: 1, amount_minor: 4000000 },
    { description: 'Driver app', quantity: 1, amount_minor: 3000000 },
  ]);
  results.set('draft_proposal', {
    data: [{ outcome: 'created', proposal_id: PROPOSAL, version: 1, superseded: null }],
    error: null,
  });
  results.set('add_proposal_item', {
    data: [{ outcome: 'added', item_id: PROPOSAL, subtotal_minor: 300000, total_minor: 300000 }],
    error: null,
  });
  results.set('set_proposal_pricing', {
    data: [
      {
        outcome: 'priced',
        subtotal_minor: 300000,
        discount_minor: 0,
        tax_minor: 0,
        total_minor: 300000,
      },
    ],
    error: null,
  });
  results.set('submit_proposal', {
    data: [{ outcome: 'submitted', request_id: REQUEST, status: 'pending_approval' }],
    error: null,
  });
  results.set('send_proposal', {
    data: [{ outcome: 'sent', status: 'sent', sent_at: '2026-08-13T00:00:00.000Z' }],
    error: null,
  });
  results.set('record_proposal_response', {
    data: [{ outcome: 'recorded', status: 'accepted', decided_at: '2026-08-13T00:00:00.000Z' }],
    error: null,
  });
});

describe('A. the vocabulary matches the constraints it mirrors', () => {
  test('every status in schema.ts is one the CHECK admits', () => {
    // The CHECK moved to `20260814120007` when G-111 added `lapsed`, so both
    // are searched: a status may be introduced by either, and pinning only the
    // older one would pass while the newer vocabulary drifted unchecked.
    const checks = migration + lapseMigration;
    for (const status of PROPOSAL_STATUSES) {
      assert.ok(checks.includes(`'${status}'`), `${status} is in schema.ts but not in the CHECK`);
    }
  });

  test('the six the table shipped with are all still there', () => {
    // The status CHECK is re-created rather than extended, so a rewrite that
    // quietly dropped one would compile and lose history.
    for (const status of ['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected']) {
      assert.ok(
        salesMigration.includes(`'${status}'`) && migration.includes(`'${status}'`),
        `${status} was in the original CHECK and is missing from the new one`,
      );
    }
  });

  test('a client’s answer is terminal — it names the exact version (§16)', () => {
    assert.deepEqual(PROPOSAL_TRANSITIONS.accepted, []);
    assert.deepEqual(PROPOSAL_TRANSITIONS.rejected, []);
    assert.deepEqual(PROPOSAL_TRANSITIONS.superseded, []);
  });

  test('the owner’s refusal goes back to draft, which is where a revision is made', () => {
    assert.ok(PROPOSAL_TRANSITIONS.pending_approval.includes('draft'));
  });

  test('sending is only ever reachable from approved (ADM-07)', () => {
    for (const status of PROPOSAL_STATUSES) {
      const reachesSent = PROPOSAL_TRANSITIONS[status].includes('sent');
      assert.equal(
        reachesSent,
        status === 'approved',
        `${status} should not reach 'sent' — only the owner's approval does`,
      );
    }
  });

  test('every live status may be superseded, because the next version always can be drafted', () => {
    for (const status of LIVE_PROPOSAL_STATUSES) {
      assert.ok(
        PROPOSAL_TRANSITIONS[status].includes('superseded'),
        `${status} cannot be superseded`,
      );
    }
  });

  test('the live set is exactly the partial unique index’s predicate', () => {
    // If these drift, "only one version is current" (§16) stops being true of
    // whatever the application believes.
    const index = migration.slice(migration.indexOf('proposals_live_version_key'));
    const predicate = index.slice(0, index.indexOf(';'));
    for (const status of PROPOSAL_STATUSES) {
      assert.equal(
        predicate.includes(`'${status}'`),
        isLiveProposal(status),
        `${status} disagrees between LIVE_PROPOSAL_STATUSES and the index`,
      );
    }
  });
});

describe('B. the rules the database holds', () => {
  test('the version is allocated under the opportunity’s lock', () => {
    assert.match(migration, /from sales\.opportunities o[\s\S]*?for update/);
    assert.match(migration, /coalesce\(max\(p\.version\), 0\) \+ 1/);
  });

  test('the total is arithmetic rather than a caller’s claim', () => {
    assert.match(migration, /proposals_total_is_arithmetic/);
    assert.match(migration, /total_minor = subtotal_minor - discount_minor \+ tax_minor/);
    // The line's own amount, too — the subtotal is only as honest as its parts.
    assert.match(migration, /new\.amount_minor := round\(new\.quantity \* new\.unit_price_minor\)/);
  });

  test('a version is frozen once it leaves draft, terms and lines both', () => {
    assert.match(migration, /proposals_guard/);
    assert.match(migration, /proposal_items_guard/);
    assert.match(migration, /its terms cannot change/);
    assert.match(migration, /its lines cannot change/);
  });

  test('nothing is ever deleted — a superseded version is the history §16 asks for', () => {
    assert.ok(
      !/delete from sales\.proposals/i.test(migration),
      'a quotation version is never deleted',
    );
    assert.match(migration, /set status = 'superseded'/);
  });

  test('submitting raises an approval rather than inventing a second review', () => {
    assert.match(migration, /approvals\.request_approval\(/);
    const fn = migration.slice(migration.indexOf('function sales.submit_proposal'));
    assert.match(fn.slice(0, 3000), /'proposal',/);
  });

  test('the review is internal — the owner signing off, not the client answering', () => {
    const fn = migration.slice(migration.indexOf('function sales.submit_proposal'));
    assert.match(fn.slice(0, 3000), /'internal'/);
  });

  test('the total travels with the request, so the ladder resolves the approver (§17)', () => {
    const fn = migration.slice(migration.indexOf('function sales.submit_proposal'));
    assert.match(fn.slice(0, 3000), /v_row\.total_minor,/);
  });

  test('no quotation policy may name below the owner (ADM-07)', () => {
    assert.match(migration, /when subject_type = 'proposal' then required_role = 'owner'/);
    // And the two the floor already held are not dropped on the way past.
    assert.match(migration, /when subject_type = 'refund'\s+then required_role = 'owner'/);
    assert.match(migration, /when subject_type = 'invoice'\s+then required_role in \('owner', 'ops_admin'\)/);
  });

  test('sending is gated on approval, under the row’s own lock', () => {
    const fn = migration.slice(migration.indexOf('function sales.send_proposal'));
    const body = fn.slice(0, 2500);
    assert.match(body, /for update/);
    assert.match(body, /v_row\.status <> 'approved'/);
    assert.match(body, /not_approved/);
  });

  test('delivery is not acceptance — a response is only taken from sent or lapsed (§18)', () => {
    // G-111 widened this by exactly one status and no more. `lapsed` joins
    // because ADM-77 keeps a client's ability to decline; acceptance is still
    // refused there by the validity check below.
    const fn = lapseMigration.slice(lapseMigration.indexOf('function sales.record_proposal_response'));
    // Bounded to the function body, and comments stripped inside it. This file
    // *explains* why `not_sent` was replaced — in a `--` comment and again in
    // the `comment on function` string that follows the body — so a slice by
    // character count plus a `--` strip still finds the explanation and fails
    // on it. A check matching its own documentation has caught this repository
    // out before; the fix is to look at code and only code.
    const body = fn
      .slice(0, fn.indexOf('$function$;'))
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');
    assert.match(body, /v_row\.status not in \('sent', 'lapsed'\)/);
    assert.match(body, /not_answerable/);
    assert.ok(!/not_sent/.test(body), 'the outcome that was false of a sent-then-lapsed quote is back');
  });

  test('a lapsed quotation cannot be accepted, and refusal is left alone (§15)', () => {
    const fn = migration.slice(migration.indexOf('function sales.record_proposal_response'));
    const body = fn.slice(0, 3000);
    assert.match(body, /p_response = 'accepted'[\s\S]*?valid_until[\s\S]*?expired/);
  });

  test('superseding cancels through the engine rather than writing its table', () => {
    // sales has no write policy on approval_requests, so an UPDATE from here
    // would match zero rows and report success.
    assert.match(migration, /perform approvals\.cancel_request\(/);
    const draftFn = migration.slice(migration.indexOf('function sales.draft_proposal'));
    assert.ok(
      !/update approvals\.approval_requests/i.test(draftFn.slice(0, 4000)),
      'draft_proposal must not write approval_requests directly',
    );
  });

  test('cancel_request restates the tenancy rule it bypasses RLS to reach', () => {
    const fn = migration.slice(migration.indexOf('function approvals.cancel_request'));
    const body = fn.slice(0, 3000);
    assert.match(body, /security definer/);
    assert.match(body, /v_actor is not null/);
    assert.match(body, /core\.current_organization_id\(\)/);
    assert.match(body, /forbidden/);
  });

  test('cancelling settles nothing — it can never stand in for an approval', () => {
    const fn = migration.slice(migration.indexOf('function approvals.cancel_request'));
    const body = fn.slice(0, 3000);
    assert.ok(!/decided_by/.test(body), 'a cancellation must name no approver');
    assert.match(body, /state\s+= 'cancelled'/);
  });

  test('the history is the trigger’s, not the functions’ — one mechanism, not two', () => {
    assert.match(migration, /when 'proposals' then/);
    assert.match(migration, /'proposal\.drafted'/);
    assert.match(migration, /'proposal\.repriced'/);
    assert.match(migration, /create trigger audit_row_change\s+after insert or update on sales\.proposals/);

    // G-093 moved these rows to the trigger. A record_audit call in a proposal
    // function would be the second mechanism it removed.
    const proposalFns = migration.slice(migration.indexOf('function sales.draft_proposal'));
    const upToAudit = proposalFns.slice(0, proposalFns.indexOf('function audit.record_row_change'));
    assert.ok(
      !/core\.record_audit/.test(upToAudit),
      'the proposal functions must not write audit rows themselves',
    );
  });

  test('the audit function is carried forward whole, not regenerated from an older copy', () => {
    // D16 was silently reverted exactly this way. Every table the trigger
    // covered before must still have a case.
    for (const table of [
      'leads',
      'lead_activities',
      'requirement_versions',
      'client_accounts',
      'opportunities',
      'projects',
      'defects',
    ]) {
      assert.match(migration, new RegExp(`when '${table}' then`), `${table} lost its vocabulary`);
    }
  });
});

describe('C. who may do what', () => {
  test('ADM-07 is the capability matrix, unchanged: staff draft, the owner approves', () => {
    assert.equal(can('ops_admin', 'proposal.draft'), true);
    assert.equal(can('ops_admin', 'proposal.send'), true);
    assert.equal(can('ops_admin', 'proposal.approve'), false);
    assert.equal(can('owner', 'proposal.approve'), true);
  });

  test('nobody below an ops_admin touches a quotation', () => {
    for (const role of ['delivery_lead', 'member', 'contractor', 'client_admin', 'client_member'] as const) {
      assert.equal(can(role, 'proposal.draft'), false, `${role} may draft`);
      assert.equal(can(role, 'proposal.send'), false, `${role} may send`);
      assert.equal(can(role, 'proposal.approve'), false, `${role} may approve`);
    }
  });
});

describe('D. the service turns an outcome into something a person can act on', () => {
  test('a draft that supersedes says so', async () => {
    results.set('draft_proposal', {
      data: [{ outcome: 'created', proposal_id: PROPOSAL, version: 2, superseded: 'older' }],
      error: null,
    });
    const result = await draftProposal({ opportunityId: OPPORTUNITY, title: 'Rebuild' });
    assert.ok(result.ok);
    assert.equal(result.data.version, 2);
    assert.equal(result.data.supersededId, 'older');
  });

  test('a settled deal is a conflict, not a crash', async () => {
    results.set('draft_proposal', {
      data: [{ outcome: 'settled', proposal_id: null, version: null, superseded: null }],
      error: null,
    });
    const result = await draftProposal({ opportunityId: OPPORTUNITY, title: 'Too late' });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
  });

  test('editing a version that has left draft points at the next version', async () => {
    results.set('add_proposal_item', {
      data: [{ outcome: 'not_draft', item_id: null, subtotal_minor: 1, total_minor: 1 }],
      error: null,
    });
    const result = await addProposalItem({
      proposalId: PROPOSAL,
      description: 'Extra',
      quantity: 1,
      unitPriceMinor: 100,
    });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /next version/);
  });

  test('a discount larger than the work is a validation error against the field', async () => {
    results.set('set_proposal_pricing', {
      data: [
        {
          outcome: 'discount_exceeds_subtotal',
          subtotal_minor: 100,
          discount_minor: 0,
          tax_minor: 0,
          total_minor: 100,
        },
      ],
      error: null,
    });
    const result = await setProposalPricing({ proposalId: PROPOSAL, discountMinor: 999 });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION');
    assert.ok(result.error.details?.discountMinor);
  });

  test('no policy is refused as a conflict naming who fixes it, not a default-open', async () => {
    results.set('submit_proposal', {
      data: [{ outcome: 'no_policy', request_id: null, status: 'draft' }],
      error: null,
    });
    const result = await submitProposal({ proposalId: PROPOSAL });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /owner sets one/);
  });

  test('a quotation with no lines is refused before it reaches anybody', async () => {
    results.set('submit_proposal', {
      data: [{ outcome: 'no_items', request_id: null, status: 'draft' }],
      error: null,
    });
    const result = await submitProposal({ proposalId: PROPOSAL });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'VALIDATION');
  });

  test('submitting twice is not an error — it answers with the pending question', async () => {
    results.set('submit_proposal', {
      data: [{ outcome: 'already_pending', request_id: REQUEST, status: 'pending_approval' }],
      error: null,
    });
    const result = await submitProposal({ proposalId: PROPOSAL });
    assert.ok(result.ok);
    assert.equal(result.data.requestId, REQUEST);
    assert.equal(result.data.alreadyPending, true);
  });

  test('the amount is never sent from here — the database reads its own total', async () => {
    await submitProposal({ proposalId: PROPOSAL });
    const [, args] = seen.calls.find(([fn]) => fn === 'submit_proposal') ?? [];
    assert.ok(args);
    assert.ok(
      !('p_amount_minor' in args) && !('p_total_minor' in args),
      'a caller-supplied amount would choose its own approver',
    );
  });

  /**
   * Now refused BEFORE anything is sent, not after.
   *
   * `sendProposal` composes the quotation and sends it, so the approval check
   * that used to live only in the RPC's answer has to happen first — a
   * quotation that reaches a client and is then reported as unapproved has
   * already failed. The RPC still refuses it under the row lock, which is the
   * check that counts; this is the one that keeps the client's phone quiet.
   */
  test('an unapproved send says which of the two reasons it is, before sending', async () => {
    rows.set('proposals', { ...APPROVED_PROPOSAL, status: 'pending_approval' });
    const waiting = await sendProposal({ proposalId: PROPOSAL });
    assert.ok(!waiting.ok);
    assert.match(waiting.error.message, /has not answered/);

    rows.set('proposals', { ...APPROVED_PROPOSAL, status: 'draft' });
    const draft = await sendProposal({ proposalId: PROPOSAL });
    assert.ok(!draft.ok);
    assert.match(draft.error.message, /after the owner approves/);

    // And nothing was handed to the client on either attempt.
    assert.equal(sent.length, 0, 'an unapproved quotation must not reach anybody');
  });

  test('a response to something never sent is refused (§18)', async () => {
    results.set('record_proposal_response', {
      data: [{ outcome: 'not_answerable', status: 'draft', decided_at: null }],
      error: null,
    });
    const result = await recordProposalResponse({ proposalId: PROPOSAL, response: 'accepted' });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /has not been sent yet/);
  });

  test('an already-answered quotation is told so, not told it never went out', async () => {
    // This branch was unreachable before G-111: the outcome implied the status
    // was not `sent`, so an accepted quote received the sentence claiming it
    // was never sent to the client. A live, user-facing false statement.
    for (const status of ['accepted', 'rejected'] as const) {
      results.set('record_proposal_response', {
        data: [{ outcome: 'not_answerable', status, decided_at: null }],
        error: null,
      });
      const r = await recordProposalResponse({ proposalId: PROPOSAL, response: 'accepted' });
      assert.ok(!r.ok);
      assert.match(r.error.message, /already answered/, `${status} was described wrongly`);
    }
  });

  test('and a superseded one points at the version that replaced it', async () => {
    results.set('record_proposal_response', {
      data: [{ outcome: 'not_answerable', status: 'superseded', decided_at: null }],
      error: null,
    });
    const r = await recordProposalResponse({ proposalId: PROPOSAL, response: 'accepted' });
    assert.ok(!r.ok);
    assert.match(r.error.message, /newer version/);
  });

  test('a lapsed quotation says what to do instead', async () => {
    results.set('record_proposal_response', {
      data: [{ outcome: 'expired', status: 'sent', decided_at: null }],
      error: null,
    });
    const result = await recordProposalResponse({ proposalId: PROPOSAL, response: 'accepted' });
    assert.ok(!result.ok);
    assert.match(result.error.message, /next version/);
  });

  test('a read that fails is INTERNAL, never a quotation that does not exist', async () => {
    results.set('draft_proposal', { data: null, error: { message: 'connection reset' } });
    const result = await draftProposal({ opportunityId: OPPORTUNITY, title: 'X' });
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'INTERNAL');
  });
});

describe('E. the validity date the page renders', () => {
  test('no date never lapses', () => {
    assert.equal(hasLapsed(null), false);
  });

  test('yesterday has lapsed and today has not — the boundary is inclusive', () => {
    const today = new Date('2026-08-13T12:00:00.000Z');
    assert.equal(hasLapsed('2026-08-12', today), true);
    assert.equal(hasLapsed('2026-08-13', today), false);
    assert.equal(hasLapsed('2026-08-14', today), false);
  });

  test('the page’s reading matches the one the database enforces', () => {
    // `valid_until < today` in both places. If the SQL ever became `<=`, a
    // button would be offered for an action the database refuses.
    assert.match(migration, /v_row\.valid_until < \(v_now at time zone 'utc'\)::date/);
  });
});

/**
 * F. the quotation actually reaches the client — Doc 09 §18.
 *
 * `sales.send_proposal` never sent anything. It marked the row `sent` and
 * recorded a message reference the caller had typed, so "Send quotation" meant
 * *"I have sent this myself, note it down"* — and on a deployment where nobody
 * knew that, an approved quotation reached nobody.
 */
describe('F. sending a quotation sends it', () => {
  test('the client is handed the quotation, and it reads like one', async () => {
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1, 'exactly one message');

    const body = sent[0]!.body;
    assert.match(body, /Delivery app — v2/);
    assert.match(body, /Does not cover marketing/);
    assert.match(body, /Customer app/);
    assert.match(body, /Driver app/);
    assert.match(body, /Total: ₹70,000/);
  });

  test('and it goes to the conversation the quotation belongs to', async () => {
    await sendProposal({ proposalId: PROPOSAL });
    assert.equal(sent[0]!.conversationId, APPROVED_PROPOSAL.conversation_id);
  });

  /**
   * §28: *"never send the same quotation twice."* A property of the key rather
   * than of the caller remembering — `send_outbound_message` answers
   * `already_sent` on a repeat and the client's phone stays quiet.
   */
  test('the idempotency key names the quotation AND its version', async () => {
    await sendProposal({ proposalId: PROPOSAL });
    assert.equal(sent[0]!.idempotencyKey, `proposal:${PROPOSAL}:v2`);
  });

  test('the row records the message this system sent, not one somebody typed', async () => {
    await sendProposal({ proposalId: PROPOSAL });
    const call = seen.calls.find(([fn]) => fn === 'send_proposal');
    assert.ok(call);
    assert.equal(call![1].p_message_ref, 'msg-1');
  });

  test('…unless the caller names its own — an emailed quotation is still a send', async () => {
    await sendProposal({ proposalId: PROPOSAL, messageRef: 'email:2026-08-23' });
    const call = seen.calls.find(([fn]) => fn === 'send_proposal');
    assert.equal(call![1].p_message_ref, 'email:2026-08-23');
  });

  /**
   * The order that matters. Mark-then-send would leave a row saying `sent`
   * with nothing sent whenever the provider refused — the exact shape that
   * made a refused reply unretryable in PR #300.
   */
  test('a refused send leaves the quotation sendable rather than marked sent', async () => {
    refuseSend.value = true;
    const refused = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(refused.ok, false);
    assert.ok(
      !seen.calls.some(([fn]) => fn === 'send_proposal'),
      'the row must not be stamped when nothing went',
    );
  });

  test('a quotation attached to no conversation says so rather than failing oddly', async () => {
    rows.set('proposals', { ...APPROVED_PROPOSAL, conversation_id: null });
    const nowhere = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(nowhere.ok, false);
    if (!nowhere.ok) assert.match(nowhere.error.message, /nobody to send it to/);
    assert.equal(sent.length, 0);
  });
});

/**
 * The second leg — the document the client keeps (brief §12, G-156).
 *
 * The failure rule under test is §27's, stated in sendProposal's own words:
 * what a retry could fix blocks the stamp so the retry can run; what it
 * cannot fix is said and stepped past. The renderer itself is proved in
 * tests/the-quotation-is-a-document.test.ts; here it runs for real (fonts
 * and all) and what is asserted is the DECISIONS around it.
 */
describe('G. the quotation travels as a document too', () => {
  test('a real PDF goes with the text, keyed one step apart', async () => {
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.pdfDelivered, true);

    assert.equal(docsSent.length, 1, 'exactly one document');
    const doc = docsSent[0]!;
    assert.equal(doc.conversationId, APPROVED_PROPOSAL.conversation_id);
    assert.equal(doc.idempotencyKey, `proposal:${PROPOSAL}:v2:pdf`);
    assert.equal(doc.filename, 'Quotation-v2-Delivery-app.pdf');
    // Real bytes from the real renderer — %PDF, not a placeholder.
    assert.equal(new TextDecoder().decode(doc.bytes.slice(0, 5)), '%PDF-');
  });

  test('a transient document failure stops BEFORE the stamp, so a retry can finish it', async () => {
    docMode.value = 'transient';
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /text was delivered/);
      assert.match(result.error.message, /still approved/);
    }
    assert.ok(
      !seen.calls.some(([fn]) => fn === 'send_proposal'),
      'a stamped quotation refuses this whole path — the PDF would be stranded forever',
    );
  });

  test('a permanent refusal is said and stepped past — the quotation still becomes sent', async () => {
    docMode.value = 'permanent';
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.pdfDelivered, false);
      assert.match(result.data.pdfNote ?? '', /refused/);
    }
    assert.ok(seen.calls.some(([fn]) => fn === 'send_proposal'), 'the stamp proceeds');
  });

  test('a document that cannot even be recorded blocks the stamp too', async () => {
    docMode.value = 'err';
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, false);
    assert.ok(!seen.calls.some(([fn]) => fn === 'send_proposal'));
  });

  test('unreadable surroundings block the stamp — a read failure is a retry away from a PDF', async () => {
    // No organization row: the letterhead read fails. That is the database
    // blinking, not the renderer breaking, so the stamp must WAIT — stepping
    // past it would strand the client's PDF permanently over a blink.
    rows.set('organizations', null);
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /still approved/);
    assert.equal(docsSent.length, 0, 'nothing was sent');
    assert.ok(!seen.calls.some(([fn]) => fn === 'send_proposal'), 'the stamp must wait for the retry');
  });

  test('a renderer that crashes does not lose the quotation', async () => {
    // A genuinely broken render — a title that is not a string reaches the
    // renderer and throws inside it. Deterministic, so no retry fixes it:
    // the quotation completes and the answer says the PDF is missing.
    rows.set('proposals', { ...APPROVED_PROPOSAL, title: 123 as unknown as string });
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.pdfDelivered, false);
      assert.match(result.data.pdfNote ?? '', /could not be rendered/);
    }
    assert.equal(docsSent.length, 0, 'nothing was sent');
    assert.ok(seen.calls.some(([fn]) => fn === 'send_proposal'), 'the text quotation still completes');
  });

  test('a consent withdrawn between the legs is said, not looped on', async () => {
    // The text went (consent held a moment ago), then the document is refused
    // FORBIDDEN. No retry fixes a withdrawal — "press Send again" would jam
    // an approved quotation behind a promise the button cannot keep.
    docMode.value = 'forbidden';
    const result = await sendProposal({ proposalId: PROPOSAL });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.pdfDelivered, false);
      assert.match(result.data.pdfNote ?? '', /consent/);
    }
    assert.ok(seen.calls.some(([fn]) => fn === 'send_proposal'), 'the stamp proceeds');
  });

  test('a refused TEXT leg means no document is attempted at all', async () => {
    refuseSend.value = true;
    await sendProposal({ proposalId: PROPOSAL });
    assert.equal(docsSent.length, 0, 'the PDF must not overtake the words');
  });
});

/**
 * The document on demand — the download half of G-156.
 *
 * The route (app/api/quotations/[proposalId]/pdf) only translates this
 * service's answer into HTTP, so the service is where the behavior lives:
 * session and capability checked, RLS-scoped reads, the same renderer as
 * both WhatsApp legs.
 */
describe('H. the document on demand', () => {
  test('an existing quotation renders to real bytes with its versioned filename', async () => {
    const result = await quotationPdfForProposal(PROPOSAL);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(new TextDecoder().decode(result.data.bytes.slice(0, 5)), '%PDF-');
      assert.equal(result.data.filename, 'Quotation-v2-Delivery-app.pdf');
    }
  });

  test('a quotation that does not exist is NOT_FOUND, not a broken render', async () => {
    rows.set('proposals', null);
    const result = await quotationPdfForProposal(PROPOSAL);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'NOT_FOUND');
  });

  test('a word that is not an id is refused before any read', async () => {
    const result = await quotationPdfForProposal('not-a-uuid');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'VALIDATION');
    assert.equal(seen.calls.length, 0);
  });

  test('the route maps the service’s refusals to honest statuses', () => {
    const route = readFileSync(
      fileURLToPath(new URL('../app/api/quotations/[proposalId]/pdf/route.ts', import.meta.url)),
      'utf8',
    );
    assert.match(route, /NOT_FOUND: 404/);
    assert.match(route, /FORBIDDEN: 403/);
    assert.match(route, /'Content-Type': 'application\/pdf'/);
    assert.match(route, /'Cache-Control': 'no-store'/);
    assert.match(route, /quotationPdfForProposal/);
  });
});
