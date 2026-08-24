import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

/**
 * The agent does everything but decide — ADM-96, G-162.
 *
 * The owner's words: "agent sab kuch kre mai bs pdf approve changes karo".
 * Two verbs remain human — approve, and changes — and everything else moved
 * agent-side: the deal is opened, the quotation is priced from the agency's
 * own corpus, submitted, announced with its PDF, dispatched to the client on
 * approval, and revised from the owner's note. These tests hold the wiring
 * and the carry-forward fidelity (D16); the live halves are proved in
 * verify-quotation-scope, verify-approval-announcements §0d and
 * verify-quotation-dispatch.
 *
 * Sibling file: `the-sales-agent-under-pressure.test.ts` §F holds the
 * schema, the prompt, the retired guard and the deal-opening race.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const MIGRATION_RAW = read('supabase/migrations/20260824120000_the_agent_does_everything_but_decide.sql');
const MIGRATION = sqlCode(MIGRATION_RAW);
const ENGINE = sqlCode(read('supabase/migrations/20260812120011_approval_engine.sql'));
const CATALOG = read('src/lib/events/catalog.ts');
const HANDLERS = read('src/modules/crm/handlers.ts');
const WORKFLOWS = read('app/api/jobs/run/workflows.ts');
const ROUTE = read('app/api/jobs/run/route.ts');
const SERVICE = read('src/modules/sales/service.ts');

describe('A. the decision leaves a wire, not only a row', () => {
  test('the event type is declared, canonical NULL — no mapping invented', () => {
    assert.match(MIGRATION, /'approval\.decided',/);
    const stmt = MIGRATION.slice(
      MIGRATION.indexOf('into core.event_types'),
      MIGRATION.indexOf('on conflict (type) do nothing'),
    );
    assert.match(stmt, /null\s*\)\s*$/m);
  });

  test('decide_approval carried forward whole (D16): every outcome, every gate', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function approvals.decide_approval'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    // The outcome vocabulary, complete — a regenerated function loses branches.
    for (const outcome of [
      "'decided'",
      "'not_found'",
      "'already_decided'",
      "'forbidden'",
      "'no_actor'",
      "'evidence_required'",
      "'invalid_decision'",
    ]) {
      assert.ok(body.includes(outcome), `the carry-forward lost outcome ${outcome}`);
    }
    // The role ladder, the client-evidence gate, the audit.
    assert.match(body, /required_role = 'ops_admin'\s+and v_role = 'ops_admin'/);
    assert.match(body, /v_req\.audience = 'client'/);
    assert.match(body, /core\.record_audit/);
    // The qualified predicate the D18 review demanded, restated on the write.
    assert.match(body, /and approval_requests\.state = 'pending'/);
    assert.match(body, /security definer/);
  });

  test('the one edit: emitted after the audit, inside the transaction, naming the subject and the decider', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function approvals.decide_approval'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    const audit = body.indexOf('core.record_audit');
    const emit = body.indexOf("'approval.decided'");
    assert.ok(audit > 0 && emit > audit, 'the emission must follow the audit');
    const call = body.slice(body.indexOf('core.emit_event'), body.indexOf('return query select \'decided\''));
    for (const key of ["'subjectType'", "'subjectId'", "'decision'", "'decidedBy'", "'note'", "'reference'"]) {
      assert.ok(call.includes(key), `the payload lost ${key}`);
    }
    assert.match(call, /v_row\.subject_type/);
    assert.match(call, /v_actor/);
    // And the original still ends the same way — the edit added, not replaced.
    assert.match(body, /return query select 'decided'::text, v_row\.id, v_row\.state, v_row\.decided_at/);
  });

  test('the original migration is untouched — the carry-forward lives in 179, not in a rewrite of history', () => {
    assert.doesNotMatch(ENGINE, /approval\.decided/);
  });
});

describe('B. the wiring: one event, two listeners, one drain', () => {
  test('the catalog routes the decision to the dispatcher and the reviser', () => {
    assert.match(CATALOG, /'approval\.decided': \['crm:dispatchApprovedQuotation', 'sales:reviseQuotation'\]/);
    assert.match(CATALOG, /'crm:dispatchApprovedQuotation': 'proposal\.dispatch'/);
    assert.match(CATALOG, /'sales:reviseQuotation': 'quotation\.revise'/);
  });

  test('the runner drains the dispatch queue — a subscribed kind nothing drains is work accepted and never done', () => {
    assert.match(ROUTE, /const DISPATCH_JOB_KIND = HANDLER_JOB_KIND\['crm:dispatchApprovedQuotation'\]/);
    assert.match(ROUTE, /DISPATCH_JOB_KIND,\s*\n\s*dispatchApprovedQuotation/);
    // And its results are reported beside the other drains.
    assert.match(ROUTE, /dispatches: dispatches\.results/);
  });

  test('the revise queue drains through the agent runner — it is registered', () => {
    assert.match(WORKFLOWS, /QUOTATION_SCOPE,\s*\n\s*QUOTATION_REVISE,\s*\n\]/);
  });

  test('a decision about anything else buys no job — planned only for proposal claims', () => {
    // approval.decided fires for every subject type; without this filter an
    // invoice approval would enqueue two not-mine jobs, and with the sales
    // agent disabled the reviser's would park dead — one per unrelated
    // decision. The filter reads the payload CLAIM, and that is fine here:
    // it only decides whether to spend a job; authority stays in the row the
    // handlers re-read.
    assert.match(CATALOG, /'crm:dispatchApprovedQuotation': \(event\) =>/);
    assert.match(CATALOG, /'sales:reviseQuotation': \(event\) =>/);
    assert.match(CATALOG, /\.filter\(\(handler\) => HANDLER_RELEVANT\[handler\]\?\.\(event\) \?\? true\)/);
  });
});

describe('C. the dispatch: approval is the authorization to send', () => {
  const fn = HANDLERS.slice(HANDLERS.indexOf('export async function dispatchApprovedQuotation'));

  test('the ROW is the authority — a forged event cannot send, or sign as somebody', () => {
    // The PR #178 lesson: an org owner can insert outbox events over
    // PostgREST, so the payload's decision and decidedBy are CLAIMS. Every
    // fact is read off approval_requests, whose state only decide_approval
    // can reach.
    assert.match(fn, /\.select\('state, decided_by, subject_type, subject_id'\)/);
    assert.match(fn, /\.eq\('organization_id', job\.organization_id\)/);
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /event\.decidedBy|event\.decision\b|event\.subjectId/);
    // And a row still pending sends nothing — the claimed decision never happened.
    assert.match(fn, /request\.state === 'pending'/);
  });

  test('the decision is carried to the proposal FIRST, whatever it was', () => {
    const sync = fn.indexOf("rpc('sync_proposal_decision'");
    const gate = fn.indexOf("request.state !== 'approved'");
    assert.ok(sync > 0 && gate > sync, 'sync must run before the approved-only gate');
  });

  test('the idempotency keys are sendProposal’s own — two doors, one send', () => {
    // Span-anchored in BOTH files: the same template literal, character for
    // character, so the manual button and the handler collapse onto one send.
    const key = 'proposal:${proposal.id}:v${proposal.version}';
    assert.ok(fn.includes('`' + key + '`'), 'the handler lost the shared text key');
    assert.ok(fn.includes('`' + key + ':pdf`'), 'the handler lost the shared pdf key');
    assert.ok(SERVICE.includes('`' + key + '`'), 'sendProposal lost the shared text key');
    assert.ok(SERVICE.includes('`' + key + ':pdf`'), 'sendProposal lost the shared pdf key');
  });

  test('both legs are authored with the decider — the human whose approval this executes', () => {
    const authored = fn.match(/p_author_id: decidedBy/g) ?? [];
    assert.equal(authored.length, 2, 'text and document must both carry the approver');
    // And the decider comes off the request row, never the payload's claim.
    assert.match(fn, /const decidedBy = request\.decided_by/);
  });

  test('a consent refusal is ADM-70 winning, not a job failing', () => {
    const consent = fn.slice(fn.indexOf("queued.outcome === 'no_consent'"), fn.indexOf('const textRef'));
    assert.match(consent, /status: 'succeeded'/);
    assert.match(consent, /suppressed_no_consent/);
    assert.match(consent, /stays approved/);
  });

  test('the stamp comes last, and a transient document failure blocks it', () => {
    const stamp = fn.indexOf("rpc('send_proposal'");
    const docTransient = fn.indexOf('provider: ${sentDoc.message}');
    assert.ok(stamp > 0, 'the handler must stamp through send_proposal');
    assert.ok(
      docTransient > 0 && docTransient < stamp,
      'the transient document return must sit before the stamp, so the retry finishes the PDF',
    );
    // A world that moved between the send and the stamp is said, not retried.
    assert.match(fn, /sent_unstamped/);
  });

  test('the renderer is shared with the announcement — two surfaces, one document', () => {
    const calls = HANDLERS.match(/await renderQuotationDocument\(/g) ?? [];
    assert.equal(calls.length, 2, 'announce and dispatch must render through the one helper');
  });

  test('a failed read is never an empty quotation (G-054)', () => {
    assert.match(fn, /could not read the quotation's lines/);
    assert.match(fn, /Nothing was sent|Refused before anything can leave|hand the client an incomplete quotation/);
  });
});

describe('D. the revision: the owner’s note becomes the next version', () => {
  const fn = WORKFLOWS.slice(WORKFLOWS.indexOf('const QUOTATION_REVISE'));

  test('only a changes request with a note is revised — read off the ROW, not the payload', () => {
    // Same authority rule as the dispatcher: the note that shapes the next
    // version must be the one decide_approval recorded, or a forged event
    // could put words in the owner's mouth.
    assert.match(fn, /\.select\('state, decision_note, subject_type, subject_id'\)/);
    assert.match(fn, /request\.subject_type !== 'proposal'/);
    assert.match(fn, /request\.state !== 'changes_requested'/);
    // The note that shapes the version is the ROW's decision_note — the pin
    // is on the derivation, not just the select string.
    assert.match(fn, /const note = \(request\.decision_note \?\? ''\)\.trim\(\)/);
    // An empty note waits for a person: inventing a change is ADM-76's sin.
    assert.match(fn, /left no note; the draft waits for a person/);
  });

  test('a retry supersedes its own half, honors a person’s, and stops at a finished answer', () => {
    assert.match(fn, /\.gt\('version', proposal\.version\)/);
    // A newer version past draft already answers the note.
    assert.match(fn, /already answers this note/);
    // A person's newer draft wins; the agent's own failed one is superseded,
    // never submitted possibly half-written.
    assert.match(fn, /a person is already drafting the next version; theirs wins/);
    assert.match(fn, /supersedingOwnFailedDraft = true/);
    assert.doesNotMatch(fn, /submitDraftedQuotation\(admin, newer\.id\)/);
  });

  test('the revision supersedes through draft_proposal and resubmits — never edited in place', () => {
    assert.match(fn, /rpc\('draft_proposal'/);
    assert.match(fn, /p_unit_price_minor: item\.priceRupees \* 100/);
    assert.match(fn, /submitDraftedQuotation\(admin, draft\.proposal_id\)/);
    assert.doesNotMatch(fn, /\.update\(\{[^}]*unit_price_minor/);
  });

  test('the model sees the note as the decider’s instruction, beside the current quotation', () => {
    assert.match(fn, /The owner reviewed v\$\{proposal\.version\} and asked for changes/);
    const prompt = WORKFLOWS.slice(
      WORKFLOWS.indexOf('const REVISION_PROMPT'),
      WORKFLOWS.indexOf('const QUOTATION_REVISE'),
    );
    assert.match(prompt, /THE NOTE IS AN INSTRUCTION/);
    assert.match(prompt, /this is a revision, not a rewrite/);
    assert.match(prompt, /PRICING_KNOWLEDGE,/);
  });
});

describe('E. the announcement carries the question it asks', () => {
  test('the internal channel hears the full form even when the system submitted', () => {
    const at = HANDLERS.indexOf('const body = announcementFor(event, true,');
    assert.ok(at > 0, 'the announcement must always compose the full form (ADM-96)');
    // And the PDF gate no longer demands a human requester…
    const finish = HANDLERS.slice(HANDLERS.indexOf('const finish = async'), HANDLERS.indexOf('const pdf ='));
    assert.doesNotMatch(finish, /!author/);
    // …while attribution still follows one when present.
    assert.match(HANDLERS, /\.\.\.\(requestedById \? \{ p_author_id: requestedById \} : \{\}\)/);
  });

  test('the row-level exemption is exactly the two internal kinds (migration 179)', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function crm.refuse_unread_price'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    assert.match(body, /'internal_direct', 'internal_group'/);
    // The original clauses stand around it — the guard was carried, not gutted.
    assert.match(body, /new\.author_type = 'user' and new\.author_id is null/);
    assert.match(body, /crm\.states_a_price\(new\.body\)/);
    assert.match(body, /check_violation/);
  });
});

describe('F. the record says what moved and what did not', () => {
  const roadmap = read('docs/roadmap/roadmap.json');
  const rules = read('docs/business-os/02-business-rules.md');
  const absolutes = read('docs/business-os/08-ai-agent-responsibilities.md');

  test('ADM-96 is recorded in the owner’s words, and G-162 implements it', () => {
    assert.match(roadmap, /"id": "ADM-96"/);
    assert.match(roadmap, /agent sab kuch kre mai bs pdf approve changes karo/);
    assert.match(roadmap, /"id": "G-162"/);
  });

  test('what ADM-96 does NOT move is written where the rules live', () => {
    // ADM-07 and ADM-74, named as unmoved in the decision itself.
    const adm96 = roadmap.slice(roadmap.indexOf('"id": "ADM-96"'));
    assert.match(adm96, /ADM-07 whole/);
    assert.match(adm96, /ADM-74 whole/);
    // The business rule revised in place, with the surviving core stated.
    assert.match(rules, /revised by ADM-96/);
    assert.match(rules, /No price reaches a client until the owner decides it/);
    // Absolute 1 reworded to what it always protected.
    assert.match(absolutes, /State a price to a client that no human has decided/);
  });

  test('the two buttons say what they set in motion', () => {
    const form = read('app/(internal)/approvals/approval-decision-form.tsx');
    assert.match(form, /Approve sends this quotation to the client/);
    assert.match(form, /the agent drafts the next version from it/);
    assert.match(form, /subjectType === 'proposal'/);
  });
});
