// Round 4, Scheduler: the client-facing messages are drafts a person sends; the provider reconcile; the wiring that connects them.
// The database half (draft doors, the person-only send record, overlap, reconcile doors, metrics) is proved in scripts/verify-p1r-scheduler.sql.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { saveSchedulingDraftAsService } from '../src/modules/crm/p1r-draft-store.ts';
import { reconcileProviderEvents, reconcileResult } from '../src/modules/crm/p1r-provider-reconcile.ts';
import { routeSchedulingMessage } from '../src/modules/crm/p1o-message-handlers.ts';
import { composeClarification, composeConfirmation, composeNoAvailability, composeProposal, whenIn } from '../src/lib/scheduling/p1r-messages.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SLOT_A = { startAt: '2026-12-10T05:00:00Z', endAt: '2026-12-10T05:30:00Z' };
const SLOT_B = { startAt: '2026-12-11T09:30:00Z', endAt: '2026-12-11T10:00:00Z' };

describe('P1R the words to the client', () => {
  test('several options ask for the NUMBER; each states date, time, zone and duration', () => {
    const t = composeProposal({ slots: [SLOT_A, SLOT_B], timezone: 'Asia/Kolkata', mode: 'video_meeting', language: 'en', clientName: 'Asha' });
    assert.match(t, /^Hi Asha,/);
    assert.match(t, /1\) Thu, 10 Dec, 10:30 am - 11:00 am/);
    assert.match(t, /2\) Fri, 11 Dec, 3:00 pm - 3:30 pm/);
    assert.match(t, /30-minute video meeting/);
    assert.match(t, /Asia\/Kolkata/);
    assert.match(t, /reply with the number/);
  });
  test('one option asks for a yes, never offers a number', () => {
    const t = composeProposal({ slots: [SLOT_A], timezone: 'Asia/Kolkata', mode: 'call', language: 'en' });
    assert.match(t, /would this time work/);
    assert.doesNotMatch(t, /\b1\)/);
  });
  test('a proposal with no slot is refused rather than written', () => {
    assert.throws(() => composeProposal({ slots: [], timezone: 'Asia/Kolkata', mode: 'call', language: 'en' }));
  });
  test('the time is written in the meeting zone, not the server zone; an unknown zone or time is refused', () => {
    assert.equal(whenIn('2026-12-10T05:00:00Z', 'America/New_York'), 'Thu, 10 Dec, 12:00 am');
    assert.throws(() => whenIn('2026-12-10T05:00:00Z', 'Mars/Olympus'));
    assert.throws(() => whenIn('not a time', 'Asia/Kolkata'));
  });
  test('the confirmation carries the exact time, zone, type and the link only when there is one, and the way to change it', () => {
    const withLink = composeConfirmation({ ...SLOT_A, timezone: 'Asia/Kolkata', mode: 'video_meeting', meetUrl: 'https://meet.example/abc', language: 'en' });
    assert.match(withLink, /confirmed for Thu, 10 Dec, 10:30 am - 11:00 am \(Asia\/Kolkata\)/);
    assert.match(withLink, /Join here: https:\/\/meet\.example\/abc/);
    assert.match(withLink, /change or cancel/);
    const noLink = composeConfirmation({ ...SLOT_A, timezone: 'Asia/Kolkata', mode: 'call', meetUrl: null, language: 'en' });
    assert.doesNotMatch(noLink, /Join here/);
    assert.doesNotMatch(noLink, /http/);
  });
  test('"nothing is free" gives no reason and asks for another day or time', () => {
    const t = composeNoAvailability({ language: 'en', clientName: 'Asha' });
    assert.match(t, /another day or time/);
    assert.doesNotMatch(t, /calendar|busy|booked|meeting with/i);
  });
  test('a clarification lists what it could mean with letters and asks which; a single meeting asks keep, move or cancel', () => {
    const many = composeClarification({ intent: 'cancel', candidates: [{ startAt: SLOT_A.startAt, timezone: 'Asia/Kolkata', mode: 'call' }, { startAt: SLOT_B.startAt, timezone: 'Asia/Kolkata', mode: 'video_meeting' }], language: 'en', fallbackTimezone: 'Asia/Kolkata' });
    assert.match(many, /A\) call, Thu, 10 Dec, 10:30 am \(Asia\/Kolkata\)/);
    assert.match(many, /B\) video meeting, Fri, 11 Dec, 3:00 pm/);
    assert.match(many, /Which one would you like to cancel\?/);
    const one = composeClarification({ intent: 'unclear', candidates: [{ startAt: SLOT_A.startAt, timezone: null, mode: 'call' }], language: 'en', fallbackTimezone: 'Asia/Kolkata' });
    assert.match(one, /keep it, move it to another time, or cancel it/);
    assert.match(one, /Asia\/Kolkata/, 'the agency zone stands in only when the meeting has none');
  });
  test('the three languages each produce a full message (Roman Hinglish and Devanagari Hindi are real text, not the English one)', () => {
    for (const language of ['hinglish', 'hindi'] as const) {
      const p = composeProposal({ slots: [SLOT_A, SLOT_B], timezone: 'Asia/Kolkata', mode: 'call', language });
      const c = composeConfirmation({ ...SLOT_A, timezone: 'Asia/Kolkata', mode: 'call', language });
      const n = composeNoAvailability({ language });
      const q = composeClarification({ intent: 'reschedule', candidates: [{ startAt: SLOT_A.startAt, timezone: 'Asia/Kolkata', mode: 'call' }, { startAt: SLOT_B.startAt, timezone: 'Asia/Kolkata', mode: 'call' }], language, fallbackTimezone: 'Asia/Kolkata' });
      for (const t of [p, c, n, q]) assert.ok(t.length > 40 && !/would this time work|these times are free|just to be sure/.test(t));
    }
    assert.match(composeNoAvailability({ language: 'hindi' }), /[ऀ-ॿ]/);
    assert.doesNotMatch(composeNoAvailability({ language: 'hinglish' }), /[ऀ-ॿ]/);
  });
});

describe('P1R the provider reconcile', () => {
  function fake(due: Array<Record<string, unknown>>, record: (args: Record<string, unknown>) => { outcome: string } | { error: string }, listError?: string) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const admin = {
      schema: () => ({
        rpc: (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          if (fn === 'p1r_meetings_to_reconcile') return Promise.resolve(listError ? { data: null, error: { message: listError } } : { data: due, error: null });
          const r = record(args);
          return Promise.resolve('error' in r ? { data: null, error: { message: r.error } } : { data: [r], error: null });
        },
      }),
    } as never;
    return { admin, calls };
  }
  const DUE = [{ meeting_id: 'm1', provider: 'google', provider_event_id: 'e1' }, { meeting_id: 'm2', provider: 'google', provider_event_id: 'e2' }, { meeting_id: 'm3', provider: 'google', provider_event_id: 'e3' }];

  test('each answer is passed on as the provider gave it, and the database decides sync or conflict', async () => {
    const answers: Record<string, unknown> = {
      e1: { ok: true, state: 'confirmed', startAt: '2026-12-10T05:00:00.000Z', endAt: '2026-12-10T05:30:00.000Z' },
      e2: { ok: true, state: 'cancelled' },
      e3: { ok: false, permanent: false, message: 'Google did not answer in time.' },
    };
    const f = fake(DUE, (a) => ({ outcome: a.p_provider_state === 'unreadable' ? 'unreadable' : a.p_provider_state === 'cancelled' ? 'conflict_flagged' : 'in_sync' }));
    const r = await reconcileProviderEvents(f.admin, 'org', async () => ({ getEvent: async (id: string) => answers[id] as never }));
    assert.deepEqual(r, { status: 'done', checked: 3, inSync: 1, conflicts: 1, unreadable: 1 });
    const recorded = f.calls.filter((c) => c.fn === 'p1r_record_provider_check').map((c) => c.args);
    assert.deepEqual(recorded[0], { p_meeting_id: 'm1', p_provider_state: 'confirmed', p_provider_start: '2026-12-10T05:00:00.000Z', p_provider_end: '2026-12-10T05:30:00.000Z' });
    assert.deepEqual(recorded[1], { p_meeting_id: 'm2', p_provider_state: 'cancelled' });
    assert.equal(recorded[2]?.p_provider_state, 'unreadable', 'an unreachable provider is never reported as a cancelled or missing event');
    assert.match(String(recorded[2]?.p_detail), /did not answer/);
  });
  test('a provider read that throws is recorded unreadable, not as a conflict', async () => {
    const f = fake([DUE[0]!], () => ({ outcome: 'unreadable' }));
    const r = await reconcileProviderEvents(f.admin, 'org', async () => ({ getEvent: async () => { throw new Error('socket hang up'); } }));
    assert.equal(r.status === 'done' && r.unreadable, 1);
    assert.equal(f.calls.find((c) => c.fn === 'p1r_record_provider_check')?.args.p_provider_state, 'unreadable');
  });
  test('no calendar is an honest environment_missing and records nothing; with nothing due the calendar is not even resolved', async () => {
    const f = fake(DUE, () => ({ outcome: 'in_sync' }));
    const r = await reconcileProviderEvents(f.admin, 'org', async () => null);
    assert.equal(r.status, 'environment_missing');
    assert.equal(f.calls.filter((c) => c.fn === 'p1r_record_provider_check').length, 0);
    let resolved = false;
    const idle = await reconcileProviderEvents(fake([], () => ({ outcome: 'x' })).admin, 'org', async () => { resolved = true; return null; });
    assert.deepEqual(idle, { status: 'done', checked: 0, inSync: 0, conflicts: 0, unreadable: 0 });
    assert.equal(resolved, false);
    const result = reconcileResult(r);
    assert.ok(result.status === 'succeeded' && result.outcome === 'environment_missing');
  });
  test('a failed list or a failed record is a retryable failure, never "nothing to compare"', async () => {
    assert.equal((await reconcileProviderEvents(fake([], () => ({ outcome: 'x' }), 'down').admin, 'org', async () => null)).status, 'failed');
    const f = fake([DUE[0]!], () => ({ error: 'write failed' }));
    const r = await reconcileProviderEvents(f.admin, 'org', async () => ({ getEvent: async () => ({ ok: true, state: 'cancelled' }) as never }));
    assert.equal(r.status, 'failed');
    const out = reconcileResult(r);
    assert.ok(out.status === 'failed' && out.permanent === false);
  });
  test('the coordination tick runs it per organisation (the connection)', () => {
    assert.match(read('src/modules/orchestrator/p1o-coordination-sweep.ts'), /await reconcileProviderEvents\(admin, org\.id, resolveCalendar\)/);
  });
});

describe('P1R the draft store and the clarification', () => {
  test('the runner stores a draft through the door and never writes a message', async () => {
    const calls: string[] = [];
    const admin = { schema: () => ({ rpc: (fn: string) => { calls.push(fn); return Promise.resolve({ data: [{ outcome: 'saved', draft_id: 'd1' }], error: null }); } }) } as never;
    const r = await saveSchedulingDraftAsService(admin, { meetingId: 'm', kind: 'clarification', language: 'en', body: 'x' });
    assert.deepEqual(r, { ok: true, draftId: 'd1', replaced: false });
    assert.deepEqual(calls, ['p1r_save_scheduling_draft']);
  });
  test('a refusal or an error is reported as a reason, not swallowed', async () => {
    const refuse = { schema: () => ({ rpc: () => Promise.resolve({ data: [{ outcome: 'wrong_state' }], error: null }) }) } as never;
    assert.deepEqual(await saveSchedulingDraftAsService(refuse, { meetingId: 'm', kind: 'proposal', language: 'en', body: 'x' }), { ok: false, reason: 'wrong_state' });
    const broken = { schema: () => ({ rpc: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) } as never;
    assert.deepEqual(await saveSchedulingDraftAsService(broken, { meetingId: 'm', kind: 'proposal', language: 'en', body: 'x' }), { ok: false, reason: 'down' });
  });

  // a minimal stand-in for the handler's reads
  function handlerAdmin(meetings: Array<Record<string, unknown>>, drafts: Array<Record<string, unknown>>, draftOutcome = 'saved') {
    const table = (name: string) => {
      const rows = name === 'conversation_messages' ? [{ id: 'msg1', body: 'cancel my meeting', conversation_id: 'c1', language: 'en', author_type: 'client' }]
        : name === 'conversations' ? [{ lead_id: 'lead1' }] : meetings;
      const chain: Record<string, unknown> = {};
      for (const k of ['select', 'eq', 'in', 'not']) chain[k] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
      return chain;
    };
    return {
      schema: () => ({
        from: (t: string) => table(t),
        rpc: (fn: string, args: Record<string, unknown>) => {
          if (fn === 'p1o_flag_meeting') return Promise.resolve({ data: [{ outcome: 'flagged', flag_id: 'f1' }], error: null });
          if (fn === 'p1r_save_scheduling_draft') { drafts.push(args); return Promise.resolve({ data: [{ outcome: draftOutcome, draft_id: 'd1' }], error: null }); }
          return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
        },
      }),
    } as never;
  }
  const job = { id: 'j', organization_id: 'o', payload: { subjectId: '00000000-0000-4000-8000-000000000001' }, correlation_id: null };

  test('a message that fits two meetings is flagged AND a clarification is drafted that lists both', async () => {
    const drafts: Array<Record<string, unknown>> = [];
    const meetings = [
      { id: 'm1', status: 'booked', confirmed_start_at: SLOT_A.startAt, timezone: 'Asia/Kolkata', booked_mode: 'call', requested_mode: 'call' },
      { id: 'm2', status: 'booked', confirmed_start_at: SLOT_B.startAt, timezone: 'Asia/Kolkata', booked_mode: 'video_meeting', requested_mode: 'video_meeting' },
    ];
    const r = await routeSchedulingMessage(handlerAdmin(meetings, drafts), job);
    assert.ok(r.status === 'succeeded' && r.outcome === 'flagged');
    assert.match(r.detail, /clarification question was drafted for a person to send/);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.p_kind, 'clarification');
    assert.equal(drafts[0]?.p_meeting_id, 'm1');
    assert.match(String(drafts[0]?.p_body), /A\) call/);
    assert.match(String(drafts[0]?.p_body), /B\) video meeting/);
  });
  test('a single clear cancel request is flagged and NOT asked about: no draft', async () => {
    const drafts: Array<Record<string, unknown>> = [];
    const r = await routeSchedulingMessage(handlerAdmin([{ id: 'm1', status: 'booked', confirmed_start_at: SLOT_A.startAt, timezone: 'Asia/Kolkata', booked_mode: 'call', requested_mode: 'call' }], drafts), job);
    assert.ok(r.status === 'succeeded' && r.outcome === 'flagged');
    assert.equal(drafts.length, 0);
  });
  test('a draft the database refuses does not undo the flag; the detail says so', async () => {
    const drafts: Array<Record<string, unknown>> = [];
    const meetings = [
      { id: 'm1', status: 'booked', confirmed_start_at: SLOT_A.startAt, timezone: null, booked_mode: 'call', requested_mode: 'call' },
      { id: 'm2', status: 'booked', confirmed_start_at: SLOT_B.startAt, timezone: null, booked_mode: 'call', requested_mode: 'call' },
    ];
    const r = await routeSchedulingMessage(handlerAdmin(meetings, drafts, 'wrong_state'), job);
    assert.ok(r.status === 'succeeded' && r.outcome === 'flagged' && /could not be kept \(wrong_state\)/.test(r.detail));
  });
});

describe('P1R the wiring: drafted after the step, sent only by a person', () => {
  const booking = read('src/lib/scheduling/booking.ts');
  const actions = read('app/(internal)/meetings/[meetingId]/actions.ts');
  test('the scheduling layer takes hooks and does not import modules (lib may not depend on modules)', () => {
    assert.doesNotMatch(booking, /@\/modules\//);
    assert.match(booking, /export type SchedulingHooks/);
  });
  test('proposing runs the hooks after the proposal was recorded: the proposal, or the "nothing is free" note', () => {
    assert.ok(booking.indexOf("rpc('propose_meeting_slots'") < booking.indexOf("runHook('proposed'"));
    assert.match(booking, /row\?\.outcome === 'nothing_to_offer'\) await runHook\('nothingToOffer'/);
    assert.ok(booking.indexOf("runHook('nothingToOffer'") < booking.indexOf("if (decision.kind === 'error') return err(decision.code, decision.message);\n  await runHook('proposed'"));
  });
  test('booking runs its hook only after the booking stood', () => {
    const decision = booking.indexOf('const decision = interpretBook(outcome, event.meetUrl);');
    const hook = booking.indexOf("runHook('booked'");
    assert.ok(decision > 0 && hook > decision);
    assert.ok(hook > booking.indexOf("rpc('book_meeting'"));
  });
  test('a hook that throws is logged and never changes the answer', () => {
    assert.match(booking, /async function runHook[\s\S]*?try \{\s*await hook;\s*\} catch \(e\) \{[\s\S]*?console\.error/);
  });
  test('the meeting screens pass the draft hooks to both steps', () => {
    assert.match(actions, /proposeSlots\(id, Number\(formData\.get\('duration'\) \?\? 30\), DRAFT_HOOKS\)/);
    assert.match(actions, /bookProposedSlot\(id, String\(formData\.get\('startAt'\) \?\? ''\), String\(formData\.get\('mode'\) \?\? 'call'\), DRAFT_HOOKS\)/);
    assert.match(actions, /proposed: \(c\) => draftProposal\(/);
    assert.match(actions, /nothingToOffer: \(c\) => draftNoAvailability\(/);
    assert.match(actions, /booked: \(c\) => draftConfirmation\(/);
  });
  test('the compose helpers never send: they keep a draft and swallow their own failure', () => {
    const src = read('src/modules/crm/p1r-scheduling-compose.ts');
    assert.doesNotMatch(src, /send_outbound_message|sendClientMessage|sendClientDocument/);
    assert.match(src, /catch \(e\)/);
  });
  test('sending a draft goes through the ordinary outbound door first and records the send second; the record is a person-only database door', () => {
    const src = read('src/modules/crm/p1r-scheduling-drafts.ts');
    assert.ok(src.indexOf('await sendClientMessage(') > 0);
    assert.ok(src.indexOf("rpc('p1r_record_scheduling_draft_sent'") > src.indexOf('await sendClientMessage('));
    assert.match(src, /idempotencyKey: `sched-draft:\$\{draft\.draftId\}`/);
    const migration = read('supabase/migrations/20261203100000_p1r_b_a_booked_meeting_cannot_overlap_another_the_provider_is_compared_with_agencyos_a_scheduling_message_is_a_draft_a_person_sends_and_reminders_are_counted.sql');
    assert.match(migration, /if \(select auth\.uid\(\)\) is null then return query select 'person_required'::text; end if;|if \(select auth\.uid\(\)\) is null then return query select 'person_required'::text; return; end if;/);
  });
  test('the attention page shows the drafts, the reminder numbers and the provider checks', () => {
    const page = read('app/(internal)/meetings/attention/page.tsx');
    assert.match(page, /listOpenSchedulingDrafts\(\)/);
    assert.match(page, /readReminderMetrics\(\)/);
    assert.match(page, /readProviderCheckSummary\(\)/);
    assert.match(page, /<SchedulingDraftForm /);
  });
  test('the policy page carries the overlap switch', () => {
    assert.match(read('app/(internal)/meetings/policy/page.tsx'), /<OverlapRuleForm /);
  });
  test("'use server' files export only async functions", () => {
    for (const f of ['app/(internal)/meetings/attention/draft-actions.ts', 'app/(internal)/meetings/policy/overlap-actions.ts']) {
      const src = read(f);
      assert.match(src, /^'use server';/);
      const exports = [...src.matchAll(/^export (\w+)/gm)].map((m) => m[1]);
      assert.ok(exports.length > 0 && exports.every((e) => e === 'async'), `${f} exports ${exports.join(',')}`);
    }
  });
});
