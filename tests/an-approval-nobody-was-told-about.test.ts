import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly, sqlCode } from './_code-only.ts';

import {
  describeBacklog,
  severityOf,
  signatureOf,
  type BacklogRow,
} from '../src/lib/observability/backlog.ts';

/**
 * An approval nobody was told about — G-176.
 *
 * The quietest failure in the system, and a fresh zero-trust audit found it by
 * looking at the live database rather than at the code.
 *
 * `handleApprovalRequested` resolves the organization's internal channel. With
 * none linked it returns `{ status: 'succeeded', outcome: 'no_group' }`. The
 * job settles **green**. No dead job, no stalled job, no unpublished event —
 * nothing the operational backlog counted. A quotation the agent drafted,
 * priced and submitted sat at `pending_approval` indefinitely, and the only
 * way anybody discovered it was by opening /approvals and happening to look.
 *
 * ── the branch is right; the silence was wrong ────────────────────────────
 *
 * An organization that has not linked a channel has nowhere to send, and
 * failing the job would retry into the same absence until it parked dead — a
 * configuration gap dressed up as a system fault. So the outcome stays a
 * success. What changes is that the CONSEQUENCE is now visible, and that
 * linking the channel repairs the past as well as the future.
 *
 * ── and a second defect, found in the same log ────────────────────────────
 *
 *     jobs/dead · approval.announce · attempts 1
 *     "malformed approval.requested payload: expected object, received undefined"
 *     parked dead — nothing retries this
 *
 * The handler parsed the EVENT and killed the announcement permanently when
 * the parse failed. An outbox event is insertable over PostgREST by an org
 * owner (the PR #178 lesson), so an unparseable payload says something about
 * the event and nothing about the approval — which may be perfectly real and
 * waiting. It reads the ROW now, the doctrine `dispatchApprovedQuotation` has
 * followed since ADM-96: *the row is the authority; the payload only says
 * which row.*
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const MIGRATION = read('supabase/migrations/20260901120000_an_approval_nobody_was_told_about.sql');
const HANDLERS = read('src/modules/crm/handlers.ts');
const PAGE = read('app/(internal)/operations/page.tsx');

const CLEAR: BacklogRow = {
  dead_jobs: 0,
  stalled_jobs: 0,
  stuck_queued_jobs: 0,
  unpublished_events: 0,
  dead_events: 0,
  overdue_approvals: 0,
  unannounced_approvals: 0,
  oldest_dead_at: null,
  oldest_unpublished_at: null,
  oldest_overdue_due_at: null,
  oldest_unannounced_at: null,
};

describe('A. the system can say it did not tell anybody', () => {
  test('an unannounced approval is FAILING, not degraded', () => {
    // The distinction this gap turns on. `overdue_approvals` is degraded
    // because a person has not answered — a person problem. This is the system
    // never having asked one, and until somebody links a channel nothing is
    // coming: the same "lost, nothing coming" shape as a dead job.
    assert.equal(severityOf(CLEAR), 'clear');
    assert.equal(severityOf({ ...CLEAR, overdue_approvals: 1 }), 'degraded');
    assert.equal(severityOf({ ...CLEAR, unannounced_approvals: 1 }), 'failing');
  });

  test('it is described in words that name the fix, not the symptom', () => {
    const lines = describeBacklog({
      ...CLEAR,
      unannounced_approvals: 2,
      oldest_unannounced_at: '2026-09-01T10:00:00.000Z',
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /2 approval\(s\) raised with nobody told/);
    // The sentence has to say what to DO. "2 approvals unannounced" would send
    // an owner to the wrong place entirely.
    assert.match(lines[0]!, /no internal WhatsApp channel linked/);
    assert.match(lines[0]!, /oldest since 2026-09-01T10:00:00\.000Z/);
  });

  test('and it is told apart from an approval that is merely late', () => {
    const both = describeBacklog({ ...CLEAR, overdue_approvals: 1, unannounced_approvals: 1 });
    assert.equal(both.length, 2);
    // Worst first, which is the file's stated ordering rule.
    assert.match(both[0]!, /nobody told/);
    assert.match(both[1]!, /past their deadline/);
  });

  test('the alert fingerprint moves when it appears, or the alert never fires', () => {
    // `core.claim_alert` compares this signature against the last one sent.
    // A count outside it is a count that can rise from zero in silence — which
    // is the exact defect, one layer up.
    assert.notEqual(signatureOf(CLEAR), signatureOf({ ...CLEAR, unannounced_approvals: 1 }));
  });

  test('a clean backlog is still clean — the new column did not make everything failing', () => {
    assert.equal(severityOf(CLEAR), 'clear');
    assert.deepEqual(describeBacklog(CLEAR), []);
  });
});

describe('B. what the database counts, and what it deliberately does not', () => {
  const sql = sqlCode(MIGRATION);

  test('only INTERNAL-audience requests', () => {
    // Exactly the set `approvals.request_approval` emits approval.requested
    // for. A client-audience request is a decision recorded by staff with
    // evidence (ADM-08d) and was never going to be announced anywhere, so
    // counting it would be an alarm nobody could clear.
    assert.match(sql, /r\.audience = 'internal'/);
  });

  test('only where NEITHER kind of internal channel exists', () => {
    // ADM-91 made internal_direct the preferred channel because Meta refuses
    // Groups eligibility, but an organization with a working group is not
    // unannounced. Hard-coding the preference here would raise a false alarm
    // the day that changes.
    assert.match(sql, /c\.kind in \('internal_direct', 'internal_group'\)/);
    assert.match(sql, /c\.status <> 'abandoned'/);
  });

  test('only PENDING ones — a decided request needs no announcement', () => {
    // Asserted as the whole predicate rather than by slicing the statement:
    // `unannounced` and `oldest_dead_at` both appear in the RETURN TABLE
    // declaration before either subquery, so a slice between them measured the
    // signature and not the query.
    //
    // THREE, and that is the assertion: the count, the oldest timestamp, and
    // `announce_waiting_approvals` must all select the same set. If the
    // announcer's predicate drifted from the backlog's, the page could report
    // an approval waiting that linking a channel would never announce — or
    // announce one the page said was already handled.
    const predicate = /r\.state = 'pending'\s*\n\s*and r\.audience = 'internal'/g;
    assert.equal([...sql.matchAll(predicate)].length, 3);
  });

  test('the function is dropped and recreated, because its shape changed', () => {
    // Postgres refuses to change the return type of an existing function. A
    // `create or replace` alone fails at APPLY time, not at review time — which
    // is where this was actually caught.
    assert.match(sql, /drop function if exists core\.operational_backlog\(\)/);
    const dropped = sql.indexOf('drop function if exists core.operational_backlog()');
    const created = sql.indexOf('create function core.operational_backlog()');
    assert.ok(dropped > 0 && created > dropped, 'the drop must precede the create');
  });
});

describe('C. linking the channel announces what was already waiting', () => {
  const sql = sqlCode(MIGRATION);

  test('both linkers call it — which door the owner used must not decide this', () => {
    assert.match(sql, /create or replace function crm\.link_internal_recipient/);
    assert.match(sql, /create or replace function crm\.link_whatsapp_group/);
    const calls = [...sql.matchAll(/perform crm\.announce_waiting_approvals\(p_organization_id\)/g)];
    assert.equal(calls.length, 2, 'both linkers must announce what was waiting');
  });

  test('but the PROJECT group does not — that is the client’s thread', () => {
    // Emitting an internal approval announcement at a client group is the one
    // mistake this whole area exists to prevent.
    assert.match(sql, /if p_kind = 'internal_group' then\s*\n\s*perform crm\.announce_waiting_approvals/);
  });

  test('and it happens AFTER the link, never before', () => {
    // An announcement emitted while the channel does not yet exist is a job
    // that finds no group and answers `no_group` — the exact silence this
    // migration exists to end, re-created by getting the order wrong.
    const body = sql.slice(sql.indexOf('create or replace function crm.link_internal_recipient'));
    const linked = body.indexOf("v_result := 'linked'");
    const announced = body.indexOf('perform crm.announce_waiting_approvals');
    assert.ok(linked > 0 && announced > linked, 'the announcement must follow the link');
  });

  test('it is NOT security definer — a tenant id it was handed is not a permission', () => {
    // The function takes an organization id. A definer function reading
    // approval requests for an id somebody passed it is a cross-tenant read
    // waiting to be found. Under the caller's own RLS an owner of one
    // organization passing another's id selects nothing and emits nothing:
    // safe by construction rather than by a check that could be removed.
    const fn = sql.slice(
      sql.indexOf('create or replace function crm.announce_waiting_approvals'),
      sql.indexOf('grant execute on function crm.announce_waiting_approvals'),
    );
    assert.ok(fn.length > 200, 'the function body was not found');
    assert.ok(!/security definer/i.test(fn), 'announce_waiting_approvals must not be security definer');
    assert.match(fn, /set search_path = ''/);
  });

  test('it emits the same payload request_approval does, not a second shape', () => {
    const fn = sql.slice(sql.indexOf('create or replace function crm.announce_waiting_approvals'));
    for (const key of ['reference', 'subjectType', 'subjectId', 'summary', 'amountMinor', 'requiredRole', 'slaDueAt']) {
      assert.ok(fn.includes(`'${key}'`), `the re-emitted payload must carry ${key}`);
    }
  });
});

describe('D. the announcement is built from the row, not from the event', () => {
  const code = codeOnly(HANDLERS);

  test('every fact it needs is selected off approval_requests', () => {
    assert.match(
      code,
      /'requested_by_type, requested_by_id, payload, reference, subject_type, subject_id, summary, amount_minor, required_role, sla_due_at'/,
    );
  });

  test('and the event payload is no longer parsed at all', () => {
    // Asserted against code with comments stripped: the docblock above the
    // change explains the old behaviour and quotes it, and prose satisfying a
    // claim about code is the mistake `_code-only.ts` exists to stop.
    assert.ok(
      !code.includes('approvalRequestedEventSchema.safeParse'),
      'the handler still parses the untrusted event payload',
    );
    assert.ok(
      !code.includes('malformed approval.requested payload'),
      'the permanent-failure branch is still there',
    );
  });

  test('a request that has vanished is a success, not a crash', () => {
    assert.match(code, /outcome: 'gone',\s*\n\s*detail: 'the approval request no longer exists/);
  });

  test('a job naming no request is still permanent — the row cannot rescue that', () => {
    assert.match(code, /detail: 'approval\.requested names no request'/);
    const named = code.indexOf("approval.requested names no request");
    const channel = code.indexOf('internalChannel(admin, job.organization_id)');
    assert.ok(named > 0 && channel > named, 'the id is checked before any work is done');
  });

  test('the no_group branch is unchanged — it was never the defect', () => {
    assert.match(code, /outcome: 'no_group'/);
    assert.match(code, /status: 'succeeded',\s*\n\s*outcome: 'no_group'/);
  });
});

describe('E. and an operator can see it without reading a log', () => {
  test('the operations page counts it separately from a late approval', () => {
    assert.match(PAGE, /\['Approvals late', backlog\.overdue_approvals\]/);
    assert.match(PAGE, /\['Nobody told', backlog\.unannounced_approvals\]/);
  });

  test('the grid was widened rather than losing a column', () => {
    // Seven stats in a six-column grid silently drops one onto a second row
    // with an empty space beside it, which reads as a rendering fault.
    assert.match(PAGE, /xl:grid-cols-7/);
  });
});
