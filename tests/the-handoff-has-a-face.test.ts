import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';
import {
  ACCEPTANCE_EVIDENCE_NOT_RECORDED,
  packetSections,
  readiness,
  UNRESOLVED_SENTENCES,
  unresolvedSentences,
  type HandoffPacket,
} from '../src/modules/sales/handoff-view.ts';

/**
 * The handoff has a face — G-235. The WON packet G-232 records is shown as
 * Master Plan V3 §13.4's nine rows, and what the packet does not know is said
 * by name (ADM-72) rather than left as an empty box.
 *
 * Executed throughout. The one place source is read, the list of names the
 * database can write is extracted into an array first, and the assertion is
 * about the array — so the closed vocabulary here can never lag the migration.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

describe('A. the vocabulary is closed, and closed on the same list the migration writes', () => {
  test('every name record_won_handoff can put in `unresolved` has a sentence, and no sentence is for a name it cannot', () => {
    const migration = sqlCode(read('supabase/migrations/20260911180000_a_deal_that_is_handed_off.sql'));
    const namesInSql = [...new Set([...migration.matchAll(/'"([a-z_]+)"'::jsonb/g)].map((m) => m[1]!))].sort();
    const namesHere = Object.keys(UNRESOLVED_SENTENCES).sort();
    assert.ok(namesInSql.length >= 8, `the extraction found only ${namesInSql.length} names — the scan broke`);
    assert.deepEqual(namesHere, namesInSql);
  });

  test('a name nobody planned for is still said, as itself — and a name twice is said once', () => {
    assert.deepEqual(unresolvedSentences({ unresolved: ['contact', 'something_new', 'contact'] }), [
      UNRESOLVED_SENTENCES.contact,
      'Unresolved: something_new',
    ]);
  });
});

const FULL: HandoffPacket = {
  handoff_id: 'h-1',
  status: 'queued',
  recorded_at: '2026-09-12T10:00:00Z',
  correlation_id: '380d418b-08c8-4daf-9794-94ecfb87bfaf',
  opportunity: { id: 'o-1', name: 'Tiffin app', stage: 'won', won_at: '2026-09-12T09:59:00Z', owner_id: '11111111-1111-4111-8111-111111111111' },
  project: { id: 'p-1', name: 'Tiffin app project', status: 'planning', budget_minor: 25000000, currency: 'INR' },
  client: { client_account_id: 'ca-1', lead_id: 'l-1', contact_id: '00000000-0000-4000-8000-000000000201', language: 'hi', whatsapp_consent: 'granted' },
  requirements: [{ requirement_version_id: 'dddddddd-0000-4000-8000-0000000000b1', status: 'accepted' }],
  commercial: [{ kind: 'proposal', proposal_id: 'q-1', version: 2, total_minor: 25000000, currency: 'INR', sent_at: '2026-09-11T12:00:00Z', sent_message_ref: 'wamid.X' }],
  decisions: [
    { kind: 'approval', approval_id: 'a-1', state: 'approved', decided_at: '2026-09-11T11:00:00Z', decided_by: '11111111-1111-4111-8111-111111111111', approved_by_role: 'owner' },
    { kind: 'acceptance', proposal_id: 'q-1', decided_at: '2026-09-11T13:00:00Z', responded_by_contact_id: '00000000-0000-4000-8000-000000000201', has_note: false },
  ],
  constraints: [
    { kind: 'payment_gate', requires_payment_evidence: 'on', evidence: { kind: 'payment_exception', approval_id: 'bfa1ebd8-c091-40a8-9ec2-9b93e097171a', decided_at: '2026-09-12T09:58:00Z' } },
    { kind: 'trust_concerns', objection_ids: ['ob-1'] },
  ],
  context: { conversation_id: 'eeeeeeee-0000-4000-8000-0000000000a1', summary_through_seq: 7 },
  unresolved: [],
};

describe('B. nine rows, in §13.4’s order, from what the packet knows', () => {
  test('the sections are §13.4’s nine, in order', () => {
    assert.deepEqual(packetSections(FULL).map((s) => s.key), ['client', 'requirements', 'commercial', 'approval', 'acceptance', 'payment', 'workflow', 'next', 'audit']);
  });

  test('a full packet has no absences and a line in every section', () => {
    const sections = packetSections(FULL);
    assert.ok(sections.every((s) => s.absences.length === 0));
    assert.ok(sections.every((s) => s.lines.length > 0), sections.filter((s) => s.lines.length === 0).map((s) => s.key).join(','));
  });

  test('the commercial row carries the version, the money and the message reference; the approval row who and as what', () => {
    const by = Object.fromEntries(packetSections(FULL).map((s) => [s.key, s]));
    assert.match(by.commercial!.lines[0]!, /Quotation v2 — INR 2,50,000, sent 2026-09-11T12:00:00Z \(wamid\.X\)/);
    assert.match(by.approval!.lines[0]!, /^approved by 11111111 \(owner\) at 2026-09-11T11:00/);
    assert.match(by.acceptance!.lines[0]!, /by contact 00000000/);
    assert.match(by.payment!.lines.join(' '), /Satisfied by an approved exception bfa1ebd8/);
    assert.match(by.audit!.lines.join(' '), /1 trust concern recorded/);
    assert.match(by.audit!.lines.join(' '), /summarised through message 7/);
  });

  test('links go to the lead, the project, the quotation PDF and the audit trail', () => {
    const links = packetSections(FULL).flatMap((s) => s.links.map((l) => l.href));
    assert.ok(links.includes('/leads/l-1'));
    assert.ok(links.includes('/projects/p-1'));
    assert.ok(links.includes('/api/quotations/q-1/pdf'));
    assert.ok(links.some((h) => h.startsWith('/audit')));
  });

  test('queued is READY, NOT ACTIVATED — said with the reason; any other status is said as itself', () => {
    const next = packetSections(FULL).find((s) => s.key === 'next')!;
    assert.match(next.lines[0]!, /Ready — not activated/);
    assert.match(next.lines[0]!, /BLK-002/);
    assert.deepEqual(readiness(FULL).title, 'Ready — not activated');
    // Review caught the first draft titling every packet 'Ready' whatever the row held.
    assert.deepEqual(readiness({ ...FULL, status: 'rejected' }), { title: 'Handoff rejected', tone: 'danger', text: 'The handoff row is rejected; nothing here is ready.' });
    assert.equal(readiness({ ...FULL, status: 'completed' }).tone, 'success');
    assert.equal(readiness({ ...FULL, status: 'in_progress' }).tone, 'warning');
    assert.match(readiness({}).title, /unknown/);
  });

  test('row 5 always says what the packet cannot carry: acceptance evidence is not recorded anywhere', () => {
    // §13.4 asks for actor, timestamp and evidence; record_proposal_response
    // records no channel or message reference, so the sentence is a fact of
    // every packet, not an absence the row could name.
    const acc = packetSections(FULL).find((s) => s.key === 'acceptance')!;
    assert.ok(acc.lines.includes(ACCEPTANCE_EVIDENCE_NOT_RECORDED));
    assert.match(ACCEPTANCE_EVIDENCE_NOT_RECORDED, /not recorded/);
  });
});

describe('C. what the packet does not know, it says by name, in the right row', () => {
  test('an ADM-72 project — no quotation, no approval, nobody named — reads as absences, not blanks', () => {
    const thin: HandoffPacket = {
      status: 'queued',
      opportunity: { id: 'o-2', name: 'Bare deal' },
      unresolved: ['accepted_quotation', 'approval', 'requirement_version', 'contact', 'conversation_summary'],
    };
    const by = Object.fromEntries(packetSections(thin).map((s) => [s.key, s]));
    assert.deepEqual(by.commercial!.absences, [UNRESOLVED_SENTENCES.accepted_quotation]);
    assert.deepEqual(by.approval!.absences, [UNRESOLVED_SENTENCES.approval]);
    assert.deepEqual(by.requirements!.absences, [UNRESOLVED_SENTENCES.requirement_version]);
    assert.deepEqual(by.client!.absences, [UNRESOLVED_SENTENCES.contact]);
    assert.deepEqual(by.audit!.absences, [UNRESOLVED_SENTENCES.conversation_summary]);
    assert.equal(by.commercial!.lines.length, 0, 'nothing is invented for the missing quotation');
  });

  test('an acceptance that names nobody is shown, and named as weak', () => {
    const p: HandoffPacket = { ...FULL, decisions: [{ kind: 'acceptance', proposal_id: 'q-1', decided_at: '2026-09-11T13:00:00Z' }], unresolved: ['acceptance_actor'] };
    const acc = packetSections(p).find((s) => s.key === 'acceptance')!;
    assert.match(acc.lines[0]!, /nobody named/);
    assert.deepEqual(acc.absences, [UNRESOLVED_SENTENCES.acceptance_actor]);
  });

  test('no project yet, a deleted project, and a rebound one each say what happened', () => {
    const none = packetSections({ ...FULL, project: undefined }).find((s) => s.key === 'workflow')!;
    assert.match(none.lines.join(' '), /No project yet — conversion has not run/);
    const deleted = packetSections({ ...FULL, project: undefined, project_deleted: true }).find((s) => s.key === 'workflow')!;
    assert.match(deleted.lines.join(' '), /bound to this handoff was deleted/);
    assert.equal(deleted.links.length, 0, 'a deleted project is not linked');
    const rebound = packetSections({ ...FULL, unresolved: ['project_rebound', 'project_proposal_differs'] });
    assert.deepEqual(rebound.find((s) => s.key === 'workflow')!.absences, [UNRESOLVED_SENTENCES.project_rebound]);
    assert.deepEqual(rebound.find((s) => s.key === 'commercial')!.absences, [UNRESOLVED_SENTENCES.project_proposal_differs]);
  });

  test('a payment gate that is off says off; one that is on and unsatisfied names the absence', () => {
    const off = packetSections({ ...FULL, constraints: [{ kind: 'payment_gate', requires_payment_evidence: 'off' }] }).find((s) => s.key === 'payment')!;
    assert.deepEqual(off.lines, ['Payment evidence before a win: off']);
    const on = packetSections({ ...FULL, constraints: [{ kind: 'payment_gate', requires_payment_evidence: 'on', verdict_at_handoff: 'no_payment_evidence' }], unresolved: ['payment_evidence'] }).find((s) => s.key === 'payment')!;
    assert.match(on.lines.join(' '), /Gate verdict at the handoff: no_payment_evidence/);
    assert.deepEqual(on.absences, [UNRESOLVED_SENTENCES.payment_evidence]);
  });
});
