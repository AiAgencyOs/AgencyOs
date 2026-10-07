import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { NAV_MODULES } from '../app/(internal)/nav-config.ts';

/**
 * Wiring of the Phase 1 Orchestrator / Quotation / Scheduler / credit-note builder (W-P1O-1, W-P1O-3): the pages it built are reachable from the rail
 * and from the places a person would look for them, and a staff-recorded acceptance goes through the evidenced door.
 */
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const items = NAV_MODULES.flatMap((m) => m.items.map((i) => ({ ...i, module: m.key })));

describe('W-P1O-1 the five pages are in the navigation, under the module a person would look in, behind the capability their page enforces', () => {
  const expected: Array<[string, string, string, string]> = [
    ['/operations/task-board', 'operations', 'audit.read', 'Workflow task board'],
    ['/meetings/attention', 'sales', 'lead.read', 'Meetings needing a person'],
    ['/meetings/policy', 'sales', 'lead.read', 'Scheduling policy'],
    ['/quotations/policy', 'sales', 'lead.read', 'Quotation policy'],
    ['/invoices/credit-notes', 'finance', 'invoice.read', 'Credit notes'],
  ];
  for (const [href, module, capability, label] of expected) {
    test(`${href}`, () => {
      const item = items.find((i) => i.href === href);
      assert.ok(item, `${href} is in NAV_MODULES`);
      assert.equal(item.module, module);
      assert.equal(item.capability, capability);
      assert.equal(item.label, label);
    });
  }

  test('each page enforces the capability its entry names (the rail never promises a page the role cannot open)', () => {
    const pages: Array<[string, RegExp]> = [
      ['app/(internal)/operations/task-board/page.tsx', /audit\.read/],
      ['app/(internal)/meetings/attention/page.tsx', /lead\.read/],
      ['app/(internal)/meetings/policy/page.tsx', /lead\.read/],
      ['app/(internal)/quotations/policy/page.tsx', /lead\.read/],
      ['app/(internal)/invoices/credit-notes/page.tsx', /invoice\.read/],
    ];
    for (const [file, cap] of pages) assert.match(read(file), cap, file);
  });
});

describe("W-P1O-1 / W-P1O-3 a deal's quotations link to its negotiation record", () => {
  test('the quotations list offers it on every row', () => {
    assert.match(read('app/(internal)/quotations/page.tsx'), /key: 'negotiation', label: 'Open the negotiation record', href: `\/quotations\/negotiation\/\$\{p\.opportunity_id\}`/);
  });
});

describe('W-P1O-3 a staff-recorded acceptance goes through the evidenced door', () => {
  const form = read('app/(internal)/leads/[leadId]/quotation-panel.tsx');
  const action = read('src/modules/sales/actions.ts');
  const negotiation = read('app/(internal)/quotations/negotiation/[opportunityId]/quote-forms.tsx') + read('app/(internal)/quotations/negotiation/[opportunityId]/actions.ts');

  test('the response form no longer offers "Accepted": it records a rejection and sends an acceptance to the negotiation page', () => {
    assert.doesNotMatch(form, /<option value="accepted">/);
    assert.match(form, /<input type="hidden" name="response" value="rejected" \/>/);
    assert.match(form, /href=\{`\/quotations\/negotiation\/\$\{opportunityId\}`\}/);
  });

  test('the action refuses an acceptance outright (a form posted by hand gets the same answer) before the old door is reached', () => {
    const refusal = action.indexOf("if (String(formData.get('response') ?? '') === 'accepted') {");
    const door = action.indexOf('const result = await recordProposalResponse({', refusal);
    assert.ok(refusal > 0 && door > refusal);
    assert.match(action, /An acceptance is recorded with its evidence on the deal/);
  });

  test('both callers pass the deal, and the negotiation page records through recordEvidencedAcceptance', () => {
    assert.match(read('app/(internal)/leads/[leadId]/page.tsx'), /opportunityId=\{opportunity\?\.id \?\? null\}/);
    assert.match(read('app/(internal)/quotations/row-actions.tsx'), /<QuotationResponseForm leadId=\{leadId\} proposalId=\{proposalId\} opportunityId=\{opportunityId\}/);
    assert.match(read('app/(internal)/quotations/page.tsx'), /opportunityId=\{p\.opportunity_id\}/);
    assert.match(negotiation, /recordEvidencedAcceptance/);
  });
});

// ── W-P789 / W-P1O: the booking path reads the dayparts and the meeting zone; the portal links the documents ──────────────────────────────────
import { DEFAULT_SCHEDULING_POLICY, applyDaypart, daypartInText, type SchedulingPolicy, type Slot } from '../src/lib/scheduling/p1o-policy.ts';

describe('the booking path narrows to the daypart the client named, in the agency’s own definition of it', () => {
  const policy: SchedulingPolicy = { ...DEFAULT_SCHEDULING_POLICY, configured: true, timezone: 'Asia/Kolkata' };
  // 2030-01-07 (Monday) in Asia/Kolkata (UTC+5:30): 10:00-10:30 IST, 14:00-14:30 IST, 18:00-18:30 IST
  const slot = (h: number, m: number): Slot => {
    const start = Date.UTC(2030, 0, 7, h, m) - 330 * 60_000;
    return { startAt: new Date(start).toISOString(), endAt: new Date(start + 30 * 60_000).toISOString() };
  };
  const slots = [slot(10, 0), slot(14, 0), slot(18, 0)];

  test('the words are read as whole words, in English and Hinglish, and only when exactly one daypart is named', () => {
    assert.equal(daypartInText('can we talk in the evening'), 'evening');
    assert.equal(daypartInText('kal shaam ko baat karte hain'), 'evening');
    assert.equal(daypartInText('subah ya shaam'), null);
    assert.equal(daypartInText('we work evenings-and-weekends'), null);
    assert.equal(daypartInText('tuesday at 5'), null);
  });

  test('evening keeps the slot inside the policy window and drops the rest', () => {
    assert.deepEqual(applyDaypart(policy, 'evening', slots), [slots[2]]);
    assert.deepEqual(applyDaypart(policy, 'morning', slots), [slots[0]]);
  });

  test('it never narrows to nothing, and no daypart (or no window for it) leaves the list whole', () => {
    assert.deepEqual(applyDaypart(policy, 'night', slots), slots);
    assert.deepEqual(applyDaypart(policy, null, slots), slots);
    assert.deepEqual(applyDaypart(policy, 'evening', [slots[0] as Slot]), [slots[0]]);
  });

  test('the window is the owner’s: a saved evening window of 13:00-15:00 moves what "evening" keeps', () => {
    const custom: SchedulingPolicy = { ...policy, dayparts: { ...policy.dayparts, evening: { start: '13:00', end: '15:00' } } };
    assert.deepEqual(applyDaypart(custom, 'evening', slots), [slots[1]]);
  });

  test('proposeSlots applies it only under a saved policy and bookProposedSlot reads the meeting zone only under one', () => {
    const src = read('src/lib/scheduling/booking.ts');
    assert.match(src, /const asked = policy\.configured && meeting\.data\.requested_message_id \? await readRequestedDaypart\(meeting\.data\.requested_message_id\) : null;\n\s+const slots = applyDaypart\(policy, asked, withinHours\);/);
    assert.match(src, /const zoneRead = policyRead\.data\.configured \? await readMeetingZone\(parsed\.data\.id\) : null;/);
    assert.match(src, /const zone = zoneRead && !zoneRead\.mustAsk \? zoneRead\.timezone : \(meeting\.data\.timezone \?\? \(await getAgencyTimeZone\(\)\)\);/);
    assert.match(read('src/lib/scheduling/p1o-booking-policy.ts'), /rpc\('p1o_meeting_timezone', \{ p_meeting_id: meetingId \}\)/);
  });
});

describe('W-P789 the portal links the rendered documents', () => {
  test('a verified payment row links its receipt and a completed project’s handover page links the certificate', () => {
    assert.match(read('app/(client)/portal/[projectId]/statement/page.tsx'), /href=\{`\/api\/p789\/receipt\/\$\{p\.paymentId\}`\}/);
    assert.match(read('app/(client)/portal/[projectId]/handover/page.tsx'), /href=\{`\/api\/p789\/certificate\/\$\{projectId\}`\}/);
  });
});
