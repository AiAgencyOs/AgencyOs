import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { codeOnly } from './_code-only.ts';

import { planJobsForEvent } from '../src/lib/events/catalog.ts';
import { revisionFactFor } from '../src/modules/sales/handlers.ts';

/**
 * What the owner changes, every time — G-185.
 *
 * The audit's LM-B: **owner edits are not captured as structured deltas.**
 * G-180 gave the system its first memory — what the owner *decided* about a
 * price. It records nothing about what they DID to the quotation, and that is
 * the half a next draft could act on: an owner who adds an admin panel to
 * every second quotation is telling the agency something no price says.
 *
 * ── the rule that shapes it, again ────────────────────────────────────────
 *
 * **Only an approved quotation teaches anything**, and this adds a second
 * condition: **the owner has to have sent the previous version back.** Without
 * it a delta would be recorded every time a v2 exists for any reason — a
 * client's change request, a price-objection redraft — and the agency would
 * learn to pre-empt requests its own owner never made.
 *
 * ── arithmetic, not a paraphrase ──────────────────────────────────────────
 *
 * No model call. Which lines appeared and disappeared is a set difference;
 * whether the timeline moved is a comparison. `explicit` confidence demands a
 * source and the source is the pair of quotations, so the sentence is
 * checkable by opening them.
 *
 * ── and no client in it ───────────────────────────────────────────────────
 *
 * No lead, no conversation, and deliberately **not the owner's note**. The
 * note is their words about one deal; a permanent organization-scoped memory
 * quoting it would carry one client's circumstances into every future draft.
 * What generalises is the shape of the correction.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const HANDLERS = codeOnly(read('src/modules/sales/handlers.ts'));
const HANDLERS_RAW = read('src/modules/sales/handlers.ts');
const WORKFLOWS = codeOnly(read('app/api/jobs/run/workflows.ts'));

const BASE = {
  decidedOn: '2026-09-02',
  title: 'Turf booking platform',
  added: [] as string[],
  removed: [] as string[],
  beforeMinor: 50_000_00,
  afterMinor: 50_000_00,
  timelineBefore: null,
  timelineAfter: null,
  exclusionsAdded: 0,
};

describe('A. the sentence says what the owner did', () => {
  test('a line the owner added', () => {
    const fact = revisionFactFor({ ...BASE, added: ['Admin panel'] });
    assert.match(fact, /the owner added “Admin panel”/);
    assert.match(fact, /^On 2026-09-02, after sending a quotation back,/);
    assert.match(fact, /“Turf booking platform”\.$/);
  });

  test('a line they dropped, and a price they moved with it', () => {
    const fact = revisionFactFor({
      ...BASE,
      removed: ['Loyalty points'],
      beforeMinor: 50_000_00,
      afterMinor: 42_000_00,
    });
    assert.match(fact, /dropped “Loyalty points”/);
    assert.match(fact, /reduced the price from ₹50,000 to ₹42,000/);
  });

  test('a timeline they widened', () => {
    const fact = revisionFactFor({
      ...BASE,
      timelineBefore: { min: 4, max: 6 },
      timelineAfter: { min: 6, max: 8 },
    });
    assert.match(fact, /moved the timeline from 4–6 weeks to 6–8 weeks/);
  });

  test('a timeline they gave a quotation that had none', () => {
    const fact = revisionFactFor({ ...BASE, timelineAfter: { min: 6, max: 8 } });
    assert.match(fact, /set the timeline to 6–8 weeks/);
  });

  test('an unchanged timeline is not mentioned at all', () => {
    const fact = revisionFactFor({
      ...BASE,
      added: ['Admin panel'],
      timelineBefore: { min: 4, max: 6 },
      timelineAfter: { min: 4, max: 6 },
    });
    assert.ok(!fact.includes('timeline'));
  });

  test('exclusions are counted, not quoted', () => {
    // The words are this client's circumstances; the habit is what carries.
    assert.match(revisionFactFor({ ...BASE, exclusionsAdded: 1 }), /added 1 exclusion —/);
    assert.match(revisionFactFor({ ...BASE, exclusionsAdded: 3 }), /added 3 exclusions —/);
    assert.ok(!revisionFactFor({ ...BASE, exclusionsAdded: 0 }).includes('exclusion'));
  });

  test('a long list is capped, and says how many it did not name', () => {
    // Eight line names is a paragraph the next prompt pays for and no reader
    // finishes. Three is enough to see a pattern.
    const fact = revisionFactFor({ ...BASE, added: ['A', 'B', 'C', 'D', 'E'] });
    assert.match(fact, /added “A”, “B”, “C” and 2 more/);
  });

  test('a long line name is shortened, because the sentence has to stay one', () => {
    // A real line reads "Customer app: signup, browse restaurants, order,
    // track delivery", and three of those is not a sentence anybody learns
    // from.
    const fact = revisionFactFor({
      ...BASE,
      added: ['Customer app: signup, browse restaurants, order, track delivery'],
    });
    assert.match(fact, /“Customer app: signup, browse restaurant…”/);
  });

  test('and one that already fits is left alone', () => {
    assert.match(revisionFactFor({ ...BASE, added: ['Admin panel'] }), /“Admin panel”/);
  });

  test('sent back and returned identical is recorded as exactly that', () => {
    // A memory that only recorded changed ones would teach that every note
    // produces a change, which is the opposite of what this is for.
    assert.match(revisionFactFor(BASE), /the owner approved it unchanged/);
  });

  test('several changes read as one sentence, in a fixed order', () => {
    const fact = revisionFactFor({
      ...BASE,
      added: ['Admin panel'],
      removed: ['Loyalty points'],
      timelineBefore: { min: 4, max: 6 },
      timelineAfter: { min: 6, max: 8 },
      exclusionsAdded: 2,
      afterMinor: 58_000_00,
    });
    const order = ['added “Admin panel”', 'dropped “Loyalty points”', 'moved the timeline', 'added 2 exclusions', 'raised the price'];
    let at = -1;
    for (const part of order) {
      const next = fact.indexOf(part);
      assert.ok(next > at, `${part} is out of order in: ${fact}`);
      at = next;
    }
  });
});

describe('B. what it refuses to learn from', () => {
  test('only an approved decision, read from the ROW', () => {
    assert.match(HANDLERS, /if \(request\.state !== 'approved'\)/);
    assert.match(HANDLERS, /\.from\('approval_requests'\)[\s\S]{0,300}\.eq\('organization_id', job\.organization_id\)/);
  });

  test('and only a version that still stands', () => {
    assert.match(HANDLERS, /outcome: 'not_standing'/);
  });

  test('v1 revises nothing', () => {
    assert.match(HANDLERS, /if \(approved\.version < 2\)[\s\S]{0,140}'not_a_revision'/);
  });

  test('the owner must have SENT IT BACK — the condition the whole thing turns on', () => {
    // Without it, a client's change request or a price-objection redraft would
    // be filed as the owner's correction.
    assert.match(HANDLERS, /\.eq\('state', 'changes_requested'\)/);
    assert.match(HANDLERS, /outcome: 'not_sent_back'/);
    assert.match(HANDLERS_RAW, /Those are the\s+\* CLIENT changing their mind/);
  });

  test('and it reads the request rows, NOT the column that is empty in this exact case', () => {
    // `sync_proposal_decision` returns a changes_requested proposal to `draft`
    // and clears its approval_request_id in the same statement — so the
    // version the owner sent back is precisely the one whose column is null.
    // The first draft read the column and answered `not_sent_back` to every
    // genuine correction; the live verifier is what said so.
    assert.match(HANDLERS, /\.eq\('subject_type', 'proposal'\)\s*\n\s*\.eq\('subject_id', previous\.id\)/);
    assert.ok(!HANDLERS.includes('previous.approval_request_id'));
    assert.match(HANDLERS_RAW, /clears its `approval_request_id` in the same statement/);
  });

  test('a reworded line reads as one dropped and one added, and says so', () => {
    // Fuzzy matching would be the handler inventing a judgement about what
    // counts as the same line — the one thing every other decision in it
    // refuses to do. The limit is stated where the comparison happens.
    assert.match(HANDLERS_RAW, /a line the owner REWORDED reads here as one dropped and one\s+\* added/);
  });

  test('a failed read is not a quotation with no lines', () => {
    // G-054. "Dropped everything" because a query errored is a lie the agency
    // would then learn from.
    assert.match(HANDLERS, /could not read the lines/);
    assert.match(HANDLERS_RAW, /a read that failed is not a quotation with no lines/);
  });

  test('one lesson per quotation, however often the event arrives', () => {
    assert.match(HANDLERS, /\.eq\('kind', REVISION_DECISION\)[\s\S]{0,80}\.eq\('source_id', approved\.id\)/);
    assert.match(HANDLERS, /outcome: 'already_recorded'/);
  });

  test('every refusal is a success — this handler owes nobody any state', () => {
    const section = HANDLERS.slice(HANDLERS.indexOf('export async function learnFromRevision'));
    const refusals = section.match(/status: '(succeeded|failed)'/g) ?? [];
    assert.ok(refusals.filter((r) => r.includes('succeeded')).length >= 7);
  });
});

describe('C. the memory is about the agency, not about a client', () => {
  test('organization-scoped, with no scope id — the constraint requires it', () => {
    const section = HANDLERS.slice(HANDLERS.indexOf('export async function learnFromRevision'));
    assert.match(section, /scope: 'organization',\n\s+scope_id: null,/);
  });

  test('written by no agent, credited to the person who decided', () => {
    const section = HANDLERS.slice(HANDLERS.indexOf('export async function learnFromRevision'));
    assert.match(section, /authored_by_agent: null,/);
    assert.match(section, /created_by: request\.decided_by,/);
    assert.match(section, /confidence: 'explicit',/);
    // `explicit` demands a source, and the source is the quotation itself.
    assert.match(section, /source_kind: 'sales\.proposal',/);
  });

  test('and the owner’s note is nowhere in it', () => {
    const section = HANDLERS.slice(HANDLERS.indexOf('export async function learnFromRevision'));
    assert.ok(!section.includes('decision_note'));
    assert.match(HANDLERS_RAW, /No client, no lead, no conversation, and no note text/);
  });
});

describe('D. it is wired, and something reads it back', () => {
  test('the decision buys both lessons, and they are separate jobs', () => {
    const jobs = planJobsForEvent({
      id: 1,
      organization_id: 'org-1',
      type: 'approval.decided',
      subject_type: 'approval_request',
      subject_id: 'req-1',
      payload: { subjectType: 'proposal', subjectId: 'prop-1', decision: 'approved' },
    });
    const kinds = jobs.map((j) => j.kind);
    assert.ok(kinds.includes('quotation.learn'));
    assert.ok(kinds.includes('quotation.learnrevision'));
  });

  test('an approval about anything else buys neither', () => {
    const jobs = planJobsForEvent({
      id: 1,
      organization_id: 'org-1',
      type: 'approval.decided',
      subject_type: 'approval_request',
      subject_id: 'req-1',
      payload: { subjectType: 'invoice', subjectId: 'inv-1', decision: 'approved' },
    });
    assert.ok(!jobs.some((j) => j.kind === 'quotation.learnrevision'));
  });

  test('the runner drains it, after the client-facing work', () => {
    const route = codeOnly(read('app/api/jobs/run/route.ts'));
    assert.match(route, /learnFromRevision/);
    assert.match(route, /REVISION_JOB_KIND/);
    assert.ok(route.indexOf('DISPATCH_JOB_KIND') < route.indexOf('REVISION_JOB_KIND'));
  });

  test('the draft reads them back — a memory nothing reads is not learning', () => {
    // The whole finding G-180 was raised for, one layer on: recording a lesson
    // nothing consults is the same defect as not recording it.
    assert.match(WORKFLOWS, /async function revisionCorrectionsFor\(/);
    assert.match(WORKFLOWS, /m\.kind === 'revision_decision' && m\.organization_id === organizationId/);
    assert.match(WORKFLOWS, /const corrections = await revisionCorrectionsFor\(admin, job\.organization_id\)/);
  });

  test('and so does the rework, because that version goes to the owner too', () => {
    assert.match(WORKFLOWS, /\(await revisionCorrectionsFor\(admin, job\.organization_id\)\) \|\| null,/);
  });

  test('the prompts say how to read them, and that they are not a rate card', () => {
    assert.equal((WORKFLOWS.match(/WHAT THE OWNER KEEPS CORRECTING/g) ?? []).length, 3);
    assert.match(WORKFLOWS, /These are the corrections you are meant to PRE-EMPT/);
    assert.match(WORKFLOWS, /Never carry a PRICE across from one/);
  });

  test('the recall is capped, like its sibling', () => {
    // Doc 05 §20: never send the entire history by default.
    const section = WORKFLOWS.slice(WORKFLOWS.indexOf('async function revisionCorrectionsFor'));
    assert.match(section.slice(0, 600), /p_limit: 8,/);
  });
});
