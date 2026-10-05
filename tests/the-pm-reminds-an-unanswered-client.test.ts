import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, mock, test } from 'node:test';

import { pmFollowUp } from '../src/modules/projects/pm-messages.ts';

mock.module('../src/modules/crm/system-message.ts', { namedExports: { sendSystemText: async () => ({ kind: 'sent', messageId: 'm' }) } });
mock.module('../src/modules/projects/pm-client-comms.ts', { namedExports: { loadContext: async () => 'gone' } });
const { decideOnboardingFollowUp, MAX_ONBOARDING_REMINDERS, runOnboardingFollowUps } = await import('../src/modules/projects/pm-followups.ts');

const read = (p: string) => readFileSync(p, 'utf8');
const TZ = 'Asia/Kolkata';
// 2026-10-07 is a Wednesday; 11:00 IST = 05:30 UTC, inside the 10:00-19:00 window.
const at = (iso: string) => new Date(iso);
const ASKED = at('2026-10-05T05:30:00Z'); // Monday 11:00 IST

describe('when a client who has not answered is reminded', () => {
  const base = { timeZone: TZ, days: 2, askedAt: ASKED, lastClientAt: null as Date | null, reminderTimes: [] as Date[] };

  test('not before the wait the owner chose', () => {
    assert.deepEqual(decideOnboardingFollowUp({ ...base, now: at('2026-10-06T10:00:00Z') }), { action: 'wait' });
  });

  test('then one reminder, inside the sending window', () => {
    assert.deepEqual(decideOnboardingFollowUp({ ...base, now: at('2026-10-07T05:30:00Z') }), { action: 'send', reminderNumber: 1 });
  });

  test('a reminder that falls due at night, or on a weekend, waits for the window', () => {
    assert.deepEqual(decideOnboardingFollowUp({ ...base, now: at('2026-10-07T20:00:00Z') }), { action: 'outside_window' }, '01:30 IST');
    assert.deepEqual(decideOnboardingFollowUp({ ...base, askedAt: at('2026-10-02T05:30:00Z'), now: at('2026-10-04T05:30:00Z') }), { action: 'outside_window' }, 'a Sunday');
  });

  test('the second is spaced by the same wait from the FIRST, not from the ask', () => {
    const first = at('2026-10-07T05:30:00Z');
    assert.deepEqual(decideOnboardingFollowUp({ ...base, reminderTimes: [first], now: at('2026-10-08T05:30:00Z') }), { action: 'wait' });
    assert.deepEqual(decideOnboardingFollowUp({ ...base, reminderTimes: [first], now: at('2026-10-09T05:30:00Z') }), { action: 'send', reminderNumber: 2 });
  });

  test('never more than two - after that it is a person\'s', () => {
    assert.equal(MAX_ONBOARDING_REMINDERS, 2);
    const both = [at('2026-10-07T05:30:00Z'), at('2026-10-09T05:30:00Z')];
    assert.deepEqual(decideOnboardingFollowUp({ ...base, reminderTimes: both, now: at('2026-10-30T05:30:00Z') }), { action: 'done' });
  });

  test('a client who has written since the ask is never chased, however unhelpful the reply', () => {
    assert.deepEqual(decideOnboardingFollowUp({ ...base, lastClientAt: at('2026-10-05T09:00:00Z'), now: at('2026-10-07T05:30:00Z') }), { action: 'client_replied' });
    assert.deepEqual(decideOnboardingFollowUp({ ...base, lastClientAt: at('2026-10-05T04:00:00Z'), now: at('2026-10-07T05:30:00Z') }), { action: 'send', reminderNumber: 1 }, 'a message from BEFORE the ask does not count');
  });
});

describe('what a reminder says', () => {
  test('it says what is still needed in the client\'s language, and nothing about who is late, a date or a consequence', () => {
    for (const language of ['en', 'hinglish', 'hindi'] as const) {
      for (const what of ['billing', 'gst_details'] as const) {
        const text = pmFollowUp(language, what);
        assert.ok(text.length > 30);
        assert.doesNotMatch(text, /[₹$]|\d{2,}|late|overdue|deadline|otherwise|will be/i, text);
      }
    }
    assert.match(pmFollowUp('hindi', 'billing'), /[ऀ-ॿ]/);
    assert.match(pmFollowUp('en', 'gst_details'), /GSTIN/);
  });
});

describe('the owner chooses the number, and nothing chases until they do', () => {
  const sql = read('supabase/migrations/20261011380000_the_owner_chooses_how_long_the_pm_waits_before_a_reminder.sql');
  const sweep = read('src/modules/projects/pm-followups.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the setting is whole days 1-30, in the settings door AND its write guard', () => {
    assert.match(sql, /if p_key = 'onboarding_followup_days' then\s*\n\s*if v_value !~ '\^\[0-9\]\{1,2\}\$' or v_value::numeric < 1 or v_value::numeric > 30 then/);
    assert.equal((sql.match(/'onboarding_followup_days'/g) ?? []).length >= 3, true, 'the door\'s key list, its validation and the guard\'s list');
  });

  test('the sweep reads only organizations that chose, and sends through the one chokepoint under a stable reference', () => {
    assert.match(sweep, /\.not\('settings->>onboarding_followup_days', 'is', null\)/);
    assert.match(sweep, /ref: `pm:followup:\$\{projectId\}:\$\{decision\.reminderNumber\}`/);
    assert.equal((sweep.match(/sendSystemText\(/g) ?? []).length, 1);
    assert.doesNotMatch(sweep, /send_outbound_message|sendWhatsApp/, 'never around the chokepoint');
  });

  test('it chases only the two asks the PM makes itself', () => {
    assert.match(sweep, /pm:billing-question:/);
    assert.match(sweep, /pm:gst-details:/);
  });

  test('the runner calls it each tick', () => {
    assert.match(read('app/api/jobs/run/route.ts'), /await runOnboardingFollowUps\(admin\)/);
  });
});

/**
 * A chainable stand-in for the query builder. Only what the sweep touches: the organizations that chose a wait, their waiting phases (paged
 * with `range`), and one billing-profile read per phase - answered with a finished non-GST profile, so every project is "nothing to chase".
 */
function sweepAdmin(waiting: number) {
  const ids = Array.from({ length: waiting }, (_, i) => ({ project_id: `p-${String(i).padStart(4, '0')}` }));
  const make = (table: string) => {
    let window: [number, number] | null = null;
    let cap: number | null = null;
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q, not: () => q, order: () => q,
      limit: (n: number) => { cap = n; return q; },
      range: (a: number, b: number) => { window = [a, b]; return q; },
      maybeSingle: async () => ({ data: table === 'billing_profiles' ? { mode: 'non_gst', version: 1 } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'organizations') return resolve({ data: [{ id: 'org-1', timezone: 'UTC', settings: { onboarding_followup_days: '2' } }], error: null });
        if (table === 'phase_two') {
          const rows = window ? ids.slice(window[0], window[1] + 1) : ids.slice(0, cap ?? ids.length);
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return q;
  };
  return { schema: () => ({ from: make }) };
}

describe('the sweep looks at every waiting project, not the first fifty', () => {
  test('120 waiting projects are all checked', async () => {
    const out = await runOnboardingFollowUps(sweepAdmin(120) as never, new Date('2026-10-07T05:30:00Z'));
    assert.equal(out.checked, 120);
    assert.equal(out.failed, false);
  });

  test('and exactly one page of fifty is still one page', async () => {
    const out = await runOnboardingFollowUps(sweepAdmin(50) as never, new Date('2026-10-07T05:30:00Z'));
    assert.equal(out.checked, 50);
  });

  test('a small organization is checked once, not paged forever', async () => {
    const out = await runOnboardingFollowUps(sweepAdmin(3) as never, new Date('2026-10-07T05:30:00Z'));
    assert.equal(out.checked, 3);
  });
});
