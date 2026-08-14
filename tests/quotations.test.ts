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
mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc: async (fn: string, args: Record<string, unknown>) => {
            seen.calls.push([fn, args]);
            return results.get(fn) ?? { data: null, error: null };
          },
        };
      },
    }),
  },
});

const {
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

  test('an unapproved send says which of the two reasons it is', async () => {
    results.set('send_proposal', {
      data: [{ outcome: 'not_approved', status: 'pending_approval', sent_at: null }],
      error: null,
    });
    const waiting = await sendProposal({ proposalId: PROPOSAL });
    assert.ok(!waiting.ok);
    assert.match(waiting.error.message, /has not answered/);

    results.set('send_proposal', {
      data: [{ outcome: 'not_approved', status: 'draft', sent_at: null }],
      error: null,
    });
    const draft = await sendProposal({ proposalId: PROPOSAL });
    assert.ok(!draft.ok);
    assert.match(draft.error.message, /after the owner approves/);
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
