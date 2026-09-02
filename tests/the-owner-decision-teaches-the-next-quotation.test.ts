import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { decisionFactFor, learnFromDecision, PRICING_DECISION } from '../src/modules/sales/handlers.ts';
import { HANDLER_JOB_KIND, planJobsForEvent, subscribersFor } from '../src/lib/events/catalog.ts';

/**
 * The owner's decision teaches the next quotation — G-180.
 *
 * A zero-trust audit's finding, in one line: **nothing in this system learns
 * anything.** `ai.memory_records` had one writer and two readers, all of them
 * per-lead. The pricing delta G-172 records is displayed on a dashboard and
 * read by nothing else. `PRICING_KNOWLEDGE` — the only thing that behaves like
 * learning — updates the way its own docblock says: *"re-run the corpus study,
 * change the numbers here"*, which is a person, an analysis, a pull request
 * and a deploy.
 *
 * So the owner could correct the same mistake on fifty quotations and the
 * fifty-first would make it again.
 *
 * ── the rule that shapes everything here ──────────────────────────────────
 *
 * **Only an APPROVED quotation teaches anything.** The brief is explicit that
 * unapproved drafts must not become permanent learning, and that is not
 * enforced by care: it is the first thing the handler checks, against the
 * approval request ROW rather than the event payload, because an outbox event
 * is insertable over PostgREST by an org owner and its `decision` is a claim.
 *
 * ── and why there is no model call ────────────────────────────────────────
 *
 * Comparing what the agent drafted with what the owner approved is arithmetic.
 * Asking a model to paraphrase it would turn a fact into an opinion — and the
 * memory table grades exactly that distinction: a row claiming `explicit` must
 * name where it came from, and an agent may never write one. These rows are
 * written with **no agent at all** and `created_by` set to the person who
 * decided, because that is what they are.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));
const ROUTE = read('app/api/jobs/run/route.ts');
const HANDLERS = codeOnly(read('src/modules/sales/handlers.ts'));

// ── a mock admin client, shaped like the one the runner passes ─────────────
type Row = Record<string, unknown> | null;

function adminWith(rows: {
  request?: Row;
  proposal?: Row;
  existing?: Row;
  requestError?: { message: string };
  inserted?: Record<string, unknown>[];
}) {
  const inserted = rows.inserted ?? [];
  const admin = {
    schema: (name: string) => ({
      from: (table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => {
            if (table === 'approval_requests') {
              return rows.requestError
                ? { data: null, error: rows.requestError }
                : { data: rows.request ?? null, error: null };
            }
            if (table === 'proposals') return { data: rows.proposal ?? null, error: null };
            if (table === 'memory_records') return { data: rows.existing ?? null, error: null };
            return { data: null, error: null };
          },
          insert: async (row: Record<string, unknown>) => {
            inserted.push({ ...row, __schema: name, __table: table });
            return { error: null };
          },
        };
        return chain;
      },
    }),
  };
  return { admin, inserted };
}

const JOB = {
  id: 'job-1',
  organization_id: 'org-1',
  payload: { subjectId: 'req-1' },
  correlation_id: null,
};

const APPROVED_REQUEST = {
  state: 'approved',
  decided_by: 'user-1',
  decided_at: '2026-09-01T10:00:00.000Z',
  subject_type: 'proposal',
  subject_id: 'prop-1',
};

const PROPOSAL = {
  id: 'prop-1',
  version: 2,
  title: 'Turf booking platform',
  status: 'approved',
  total_minor: 110_000_00,
  opportunity_id: 'opp-1',
  decided_at: '2026-09-01T10:00:00.000Z',
  document: {
    understanding: 'A player books a turf.',
    pricingReference: { lane: 2, referenceRupees: 95_000, proposedRupees: 87_000, surfaces: 3, depth: 'standard' },
  },
};

describe('A. the sentence a decision becomes', () => {
  test('a correction says which way it went, by how much, and against what shape', () => {
    const fact = decisionFactFor({
      approvedTotalMinor: 110_000_00,
      draftedTotalMinor: 87_000_00,
      decidedOn: '2026-09-01',
      surfaces: 3,
      depth: 'standard',
      lane: 2,
      title: 'Turf booking platform',
    });
    assert.match(fact, /On 2026-09-01 the owner raised a draft of ₹87,000 to ₹1,10,000/);
    assert.match(fact, /26% up/);
    assert.match(fact, /\(3 surface\(s\), standard, lane 2\)/);
    assert.match(fact, /"Turf booking platform"/);
  });

  test('and a reduction reads as one, not as a raise with a minus sign', () => {
    const fact = decisionFactFor({
      approvedTotalMinor: 45_000_00,
      draftedTotalMinor: 60_000_00,
      decidedOn: '2026-09-01',
      surfaces: 2,
      depth: 'basic',
      lane: 2,
      title: 'Bakery app',
    });
    assert.match(fact, /reduced a draft of ₹60,000 to ₹45,000/);
    assert.match(fact, /25% down/);
  });

  test('approved unchanged is a decision too — and the commonest one', () => {
    // A memory that only recorded corrections would teach the agency its
    // mistakes and none of its agreements, which is the wrong half.
    const fact = decisionFactFor({
      approvedTotalMinor: 87_000_00,
      draftedTotalMinor: 87_000_00,
      decidedOn: '2026-09-01',
      surfaces: 3,
      depth: 'standard',
      lane: 2,
      title: 'Turf booking platform',
    });
    assert.match(fact, /approved ₹87,000 exactly as drafted/);
  });

  test('a quotation with no recorded reference still produces a usable sentence', () => {
    // Everything drafted before G-172 has no pricingReference at all.
    const fact = decisionFactFor({
      approvedTotalMinor: 87_000_00,
      draftedTotalMinor: null,
      decidedOn: '2026-09-01',
      surfaces: null,
      depth: null,
      lane: null,
      title: 'An older quotation',
    });
    assert.match(fact, /approved ₹87,000 exactly as drafted — "An older quotation"/);
    assert.ok(!fact.includes('()'), 'an absent shape must not render as empty brackets');
  });
});

describe('B. only an approved quotation teaches anything', () => {
  test('an approved one is recorded, scoped to the organization and nobody else', async () => {
    const { admin, inserted } = adminWith({ request: APPROVED_REQUEST, proposal: PROPOSAL });
    const result = await learnFromDecision(admin as never, JOB as never);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.status === 'succeeded' && result.outcome, 'recorded');
    assert.equal(inserted.length, 1);

    const row = inserted[0]!;
    assert.equal(row.scope, 'organization');
    // `memory_scope_id_matches_scope` requires exactly this.
    assert.equal(row.scope_id, null);
    assert.equal(row.kind, PRICING_DECISION);
    assert.match(String(row.fact), /raised a draft of ₹87,000 to ₹1,10,000/);
  });

  test('written with NO agent, and credited to the person who decided', async () => {
    // The distinction the memory table grades. `explicit` means a person
    // stated it; an agent may never write that confidence at all
    // (memory_agent_cannot_verify), and no agent wrote this.
    const { admin, inserted } = adminWith({ request: APPROVED_REQUEST, proposal: PROPOSAL });
    await learnFromDecision(admin as never, JOB as never);
    const row = inserted[0]!;
    assert.equal(row.authored_by_agent, null);
    assert.equal(row.created_by, 'user-1');
    assert.equal(row.confidence, 'explicit');
    // And an explicit row must name where it came from.
    assert.equal(row.source_kind, 'sales.proposal');
    assert.equal(row.source_id, 'prop-1');
  });

  test('a REJECTED decision teaches nothing', async () => {
    const { admin, inserted } = adminWith({
      request: { ...APPROVED_REQUEST, state: 'rejected' },
      proposal: PROPOSAL,
    });
    const result = await learnFromDecision(admin as never, JOB as never);
    assert.equal(result.status === 'succeeded' && result.outcome, 'not_approved');
    assert.equal(inserted.length, 0);
  });

  test('and neither does changes_requested — a price sent back is not one endorsed', async () => {
    // The sharpest case. Recording it would teach the agency to repeat exactly
    // what the owner had just corrected.
    const { admin, inserted } = adminWith({
      request: { ...APPROVED_REQUEST, state: 'changes_requested' },
      proposal: PROPOSAL,
    });
    const result = await learnFromDecision(admin as never, JOB as never);
    assert.equal(result.status === 'succeeded' && result.outcome, 'not_approved');
    assert.equal(inserted.length, 0);
  });

  test('nor does a still-pending one, whatever the event claimed', async () => {
    const { admin, inserted } = adminWith({
      request: { ...APPROVED_REQUEST, state: 'pending' },
      proposal: PROPOSAL,
    });
    await learnFromDecision(admin as never, JOB as never);
    assert.equal(inserted.length, 0);
  });

  test('a quotation that no longer STANDS teaches nothing either', async () => {
    // Superseded by a later version, or pulled back to draft. A lesson from a
    // version that no longer stands is a lesson about nothing.
    for (const status of ['superseded', 'draft', 'lapsed', 'rejected']) {
      const { admin, inserted } = adminWith({
        request: APPROVED_REQUEST,
        proposal: { ...PROPOSAL, status },
      });
      const result = await learnFromDecision(admin as never, JOB as never);
      assert.equal(result.status === 'succeeded' && result.outcome, 'not_standing', status);
      assert.equal(inserted.length, 0, status);
    }
  });

  test('but sent and accepted do — the owner still stands behind those', async () => {
    for (const status of ['approved', 'sent', 'accepted']) {
      const { admin, inserted } = adminWith({ request: APPROVED_REQUEST, proposal: { ...PROPOSAL, status } });
      await learnFromDecision(admin as never, JOB as never);
      assert.equal(inserted.length, 1, status);
    }
  });

  test('an invoice decision is not a pricing lesson', async () => {
    const { admin, inserted } = adminWith({
      request: { ...APPROVED_REQUEST, subject_type: 'invoice' },
      proposal: PROPOSAL,
    });
    const result = await learnFromDecision(admin as never, JOB as never);
    assert.equal(result.status === 'succeeded' && result.outcome, 'not_mine');
    assert.equal(inserted.length, 0);
  });

  test('one decision is recorded once, however many times the event arrives', async () => {
    const { admin, inserted } = adminWith({
      request: APPROVED_REQUEST,
      proposal: PROPOSAL,
      existing: { id: 'mem-1' },
    });
    const result = await learnFromDecision(admin as never, JOB as never);
    assert.equal(result.status === 'succeeded' && result.outcome, 'already_recorded');
    assert.equal(inserted.length, 0);
  });

  test('a failed read is retryable; a vanished request is not a failure at all', async () => {
    const failed = adminWith({ requestError: { message: 'connection reset' } });
    const a = await learnFromDecision(failed.admin as never, JOB as never);
    assert.equal(a.status, 'failed');
    assert.equal(a.status === 'failed' && a.permanent, false);

    const gone = adminWith({ request: null });
    const b = await learnFromDecision(gone.admin as never, JOB as never);
    assert.equal(b.status === 'succeeded' && b.outcome, 'gone');
  });

  test('every refusal is a SUCCESS — this handler owes nobody any state', async () => {
    // A job that retried its way to `dead` because a quotation was cancelled
    // would put a red mark on the operations page for something that went
    // entirely correctly.
    // Scoped to `learnFromDecision`'s own body: G-185 put a second handler in
    // this file, and reading to the end of the file would measure both. Each
    // owns its own assertion, in its own test file.
    const body = HANDLERS.slice(
      HANDLERS.indexOf("subject_type !== 'proposal'"),
      HANDLERS.indexOf('export const REVISION_DECISION'),
    );
    assert.ok(
      !/permanent: true/.test(body),
      'no refusal after the id check may be a permanent failure',
    );
  });
});

describe('C. it compares this version with what the AGENT asked for it', () => {
  test('the drafted figure comes off the frozen reference on the SAME version', async () => {
    // Not version 1 of the opportunity. A revision usually changes the lines
    // as well as the price, so comparing prices across two different scopes
    // would teach a relationship that does not exist.
    assert.match(HANDLERS, /document\?\.pricingReference \?\? null/);
    assert.match(HANDLERS, /reference\?\.proposedRupees/);
    assert.ok(!/version.*eq\(.*1\)/.test(HANDLERS), 'it must not fetch a different version to compare against');
  });

  test('and it records the shape, never the client', async () => {
    // Organization-scoped by design: the lesson is how this agency prices,
    // not what a particular client paid.
    const { admin, inserted } = adminWith({ request: APPROVED_REQUEST, proposal: PROPOSAL });
    await learnFromDecision(admin as never, JOB as never);
    const row = inserted[0]!;
    assert.ok(!('lead_id' in row));
    assert.equal(row.scope_id, null);
    assert.match(String(row.fact), /3 surface\(s\), standard, lane 2/);
  });
});

describe('D. the wiring, end to end', () => {
  test('the decision event reaches it, beside the two listeners that were there', () => {
    const subscribers = subscribersFor('approval.decided');
    assert.deepEqual(subscribers, [
      'crm:dispatchApprovedQuotation',
      'sales:reviseQuotation',
      'sales:learnFromDecision',
      // G-185's sibling lesson: what the owner CHANGED, which this one cannot
      // see. Listed here rather than asserted loosely, so a listener arriving
      // or leaving this event is a decision somebody makes on purpose.
      'sales:learnFromRevision',
    ]);
    assert.equal(HANDLER_JOB_KIND['sales:learnFromDecision'], 'quotation.learn');
  });

  test('an invoice decision spends no job on it', () => {
    const planned = planJobsForEvent({
      id: 1,
      organization_id: 'org-1',
      type: 'approval.decided',
      subject_type: 'approval_request',
      subject_id: 'req-1',
      payload: { subjectType: 'invoice' },
    });
    assert.ok(!planned.some((j) => j.kind === 'quotation.learn'));
  });

  test('and a proposal decision does', () => {
    const planned = planJobsForEvent({
      id: 1,
      organization_id: 'org-1',
      type: 'approval.decided',
      subject_type: 'approval_request',
      subject_id: 'req-1',
      payload: { subjectType: 'proposal' },
    });
    assert.ok(planned.some((j) => j.kind === 'quotation.learn'));
  });

  test('the runner drains it — a subscribed kind nothing drains is work accepted and never done', () => {
    assert.match(ROUTE, /const LEARN_JOB_KIND = HANDLER_JOB_KIND\['sales:learnFromDecision'\]/);
    assert.match(ROUTE, /LEARN_JOB_KIND,\s*\n\s*learnFromDecision/);
    assert.match(ROUTE, /lessons: lessons\.results/);
  });

  test('and it is drained AFTER the dispatch, because a client is waiting for that', () => {
    const dispatch = ROUTE.indexOf('const dispatches = await runEventJobs');
    const lesson = ROUTE.indexOf('const lessons = await runEventJobs');
    assert.ok(dispatch > 0 && lesson > dispatch);
  });
});

describe('E2. a memory is retired, never deleted', () => {
  const VERIFIER = read('scripts/verify-quotation-dispatch.mjs');

  test('the live verifier EXPIRES the lessons it wrote', () => {
    // The database settled this, not a preference: a memory refuses DELETE
    // outright — "a memory is superseded, never deleted (Doc 05 §32)" — so the
    // first cleanup answered 23514 on every run and left every row behind.
    //
    // It matters more than tidiness. A leftover pricing decision is recalled
    // into the NEXT script's drafting prompt, which is the one place a stray
    // fixture can change what a model writes.
    // G-185 added a second kind to expire beside it, for the same reason.
    assert.match(VERIFIER, /memory_records\?organization_id=eq\.\$\{ORG\}&kind=in\.\(pricing_decision,revision_decision\)&expires_at=is\.null/);
    assert.match(VERIFIER, /expires_at: new Date\(Date\.now\(\) - 60_000\)\.toISOString\(\)/);
    assert.ok(
      !/DELETE', 'ai', `memory_records/.test(VERIFIER),
      'a delete would fail on every run and leave the fixtures behind',
    );
  });

  test('and ai.recall is what makes an expiry mean something', () => {
    // Asserted against the migration that defines it, because the cleanup is
    // only sound if the reader honours the field.
    const recall = read('supabase/migrations/20260821200000_memory_that_cannot_promote_itself.sql');
    assert.match(recall, /m\.expires_at is null or m\.expires_at > now\(\)/);
  });
});

describe('E. and the next draft is shown what was decided', () => {
  test('the drafting workflow recalls them, organization-scoped', () => {
    assert.match(WORKFLOWS, /async function pricingDecisionsFor\(/);
    assert.match(WORKFLOWS, /p_scope: 'organization'/);
    assert.match(WORKFLOWS, /m\.kind === 'pricing_decision'/);
  });

  test('capped, because Doc 05 §20 says never send the whole history', () => {
    assert.match(WORKFLOWS, /p_limit: 8/);
  });

  test('a failed recall costs the draft nothing', () => {
    const helper = WORKFLOWS.slice(
      WORKFLOWS.indexOf('async function pricingDecisionsFor'),
      WORKFLOWS.indexOf('async function submitDraftedQuotation'),
    );
    assert.ok(helper.length > 100, 'the helper was not found');
    assert.ok(!/failJob|throw /.test(helper), 'a recall must not be able to fail a draft');
  });

  test('they arrive as their own turn, not folded into the requirements', () => {
    // So a past decision about another client cannot be mistaken for a fact
    // about this one.
    assert.match(WORKFLOWS, /const decisions = await pricingDecisionsFor\(admin, job\.organization_id\)/);
    assert.match(WORKFLOWS, /\.filter\(\(part\) => part !== ''\)/);
  });

  test('and the prompt says what they are — and what they are not', () => {
    // Without the frame they are just more text in the turn, and a model
    // reading "the owner raised a draft by 26%" is as likely to copy the
    // percentage as to learn the pattern.
    assert.equal((WORKFLOWS.match(/WHAT THE OWNER HAS ACTUALLY DECIDED/g) ?? []).length, 3);
    assert.equal((WORKFLOWS.match(/They are RECORDS,/g) ?? []).length, 3);
    assert.equal((WORKFLOWS.match(/Never copy a figure across from/g) ?? []).length, 3);
  });
});
