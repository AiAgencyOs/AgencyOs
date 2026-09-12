import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { sqlCode } from './_code-only.ts';

import {
  MEETING_MODES,
  MEETING_OUTCOMES,
  MEETING_STATUSES,
  MEETING_TRANSITIONS,
  TERMINAL_MEETING_STATUSES,
  completionIsAuthorized,
  isSettledMeeting,
  meetingTransitionAllowed,
  missingBookingFacts,
  type MeetingStatus,
} from '../src/modules/crm/schema.ts';

/**
 * A meeting is a thing the system knows about — gap G-225.
 *
 * The Scheduler is one of five locked Phase 1 agents and had NOTHING in this
 * repository: no table among the 86, no module, no route, no registry key, and
 * no gap saying so. This is the first unit — the domain a meeting lives in.
 *
 * Two halves. The row's rules are read as source, because a unit test has no
 * Postgres. The state machine and the two shape rules are EXECUTED, because
 * they are pure functions and there is no excuse not to — and section E reads
 * BOTH copies and fails if the database and TypeScript ever disagree, which is
 * the failure a mirror exists to have.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SQL = sqlCode(read('supabase/migrations/20260911130000_a_meeting_is_a_thing_the_system_knows_about.sql'));

// ═══════════════════════════════════════════════════════════════════════════
// A. Proposal and confirmation are different states
// ═══════════════════════════════════════════════════════════════════════════

describe('A. a slot that was offered is not a slot that was taken', () => {
  test('proposed and booked are both statuses, and one leads to the other', () => {
    // §6.2. The separation exists to stop one lie: an agent telling a client a
    // meeting is booked because it suggested a time.
    assert.ok(MEETING_STATUSES.includes('proposed'));
    assert.ok(MEETING_STATUSES.includes('booked'));
    assert.ok(meetingTransitionAllowed('proposed', 'booked'));
  });

  test('a proposal cannot skip to having happened', () => {
    assert.equal(meetingTransitionAllowed('proposed', 'completed'), false);
    assert.equal(meetingTransitionAllowed('proposed', 'no_show'), false);
  });

  test('and neither can a bare request', () => {
    assert.equal(meetingTransitionAllowed('requested', 'completed'), false);
    assert.equal(meetingTransitionAllowed('requested', 'no_show'), false);
  });

  test('only a booked meeting can have happened or been missed', () => {
    // §9: completion is a fact about a booking. Nothing else can reach it.
    for (const from of MEETING_STATUSES) {
      const reachesCompleted = meetingTransitionAllowed(from, 'completed');
      const reachesNoShow = meetingTransitionAllowed(from, 'no_show');
      assert.equal(reachesCompleted, from === 'booked' || from === 'completed');
      assert.equal(reachesNoShow, from === 'booked' || from === 'no_show');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The ends are ends
// ═══════════════════════════════════════════════════════════════════════════

describe('B. a meeting that happened does not un-happen', () => {
  test('all three terminal states are terminal', () => {
    for (const status of TERMINAL_MEETING_STATUSES) {
      assert.deepEqual(MEETING_TRANSITIONS[status], [], `${status} leads somewhere`);
      assert.ok(isSettledMeeting(status));
    }
  });

  test('a live state is not settled', () => {
    for (const status of ['requested', 'proposed', 'booked'] as const) {
      assert.equal(isSettledMeeting(status), false);
    }
  });

  test('a reschedule is therefore a new row, not a reopened one', () => {
    // §8: "Preserve old booking history." There is deliberately no arc out of
    // cancelled — the way back is supersedes_id on a new record, the shape
    // sales.proposals uses for a revised quotation.
    assert.equal(meetingTransitionAllowed('cancelled', 'booked'), false);
    assert.equal(meetingTransitionAllowed('cancelled', 'requested'), false);
    assert.match(SQL, /supersedes_id\s+uuid references crm\.meetings\(id\)/);
  });

  test('cancelling is reachable from every live state, and from no dead one', () => {
    assert.ok(meetingTransitionAllowed('requested', 'cancelled'));
    assert.ok(meetingTransitionAllowed('proposed', 'cancelled'));
    assert.ok(meetingTransitionAllowed('booked', 'cancelled'));
    assert.equal(meetingTransitionAllowed('completed', 'cancelled'), false);
    assert.equal(meetingTransitionAllowed('no_show', 'cancelled'), false);
  });

  test('every status has an entry, so a missing one is a type error not an undefined', () => {
    for (const status of MEETING_STATUSES) {
      assert.ok(Array.isArray(MEETING_TRANSITIONS[status]), `${status} has no entry`);
    }
  });

  test('and no transition points at a status that does not exist', () => {
    for (const [from, tos] of Object.entries(MEETING_TRANSITIONS)) {
      for (const to of tos) {
        assert.ok(
          MEETING_STATUSES.includes(to),
          `${from} → ${to}, and ${to} is not a status`,
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Time passing is not completion
// ═══════════════════════════════════════════════════════════════════════════

describe('C. a clock cannot conclude that a meeting happened', () => {
  const actor = '11111111-1111-4111-8111-111111111111';
  const when = '2026-09-11T10:00:00.000Z';

  test('completed needs both a person and a moment', () => {
    // §9.1, the rule the specification repeats more than any other.
    assert.equal(
      completionIsAuthorized({ status: 'completed', completedAt: null, completedBy: null }),
      false,
    );
    assert.equal(
      completionIsAuthorized({ status: 'completed', completedAt: when, completedBy: null }),
      false,
      'a timestamp alone is a clock, which is the caller this rule exists to refuse',
    );
    assert.equal(
      completionIsAuthorized({ status: 'completed', completedAt: null, completedBy: actor }),
      false,
    );
    assert.equal(
      completionIsAuthorized({ status: 'completed', completedAt: when, completedBy: actor }),
      true,
    );
  });

  test('no_show is held to exactly the same standard', () => {
    // §14: a no-show is a controlled workflow, not an inference from silence.
    assert.equal(
      completionIsAuthorized({ status: 'no_show', completedAt: when, completedBy: null }),
      false,
    );
    assert.equal(
      completionIsAuthorized({ status: 'no_show', completedAt: when, completedBy: actor }),
      true,
    );
  });

  test('and a live meeting is not asked for either', () => {
    for (const status of ['requested', 'proposed', 'booked', 'cancelled'] as const) {
      assert.equal(
        completionIsAuthorized({ status, completedAt: null, completedBy: null }),
        true,
        `${status} was asked for completion evidence it cannot have`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. A booking says when, until when, where and in what form
// ═══════════════════════════════════════════════════════════════════════════

describe('D. a booking that cannot say when is not a booking', () => {
  const complete = {
    confirmedStartAt: '2026-09-12T09:00:00.000Z',
    confirmedEndAt: '2026-09-12T09:30:00.000Z',
    timezone: 'Asia/Kolkata',
    bookedMode: 'video_meeting' as const,
  };

  test('a complete booking is missing nothing', () => {
    assert.deepEqual(missingBookingFacts(complete), []);
  });

  test('each missing fact is named, so the operator is told which', () => {
    assert.deepEqual(missingBookingFacts({ ...complete, confirmedStartAt: null }), ['a start time']);
    assert.deepEqual(missingBookingFacts({ ...complete, confirmedEndAt: null }), ['an end time']);
    assert.deepEqual(missingBookingFacts({ ...complete, bookedMode: null }), [
      'whether it is a call or a meeting',
    ]);
  });

  test('the timezone is one of them — §4.4 stores the zone a booking was agreed in', () => {
    const missing = missingBookingFacts({ ...complete, timezone: null });

    assert.equal(missing.length, 1);
    assert.match(missing[0] ?? '', /timezone/);
  });

  test('an empty booking names all four rather than stopping at the first', () => {
    const missing = missingBookingFacts({
      confirmedStartAt: null, confirmedEndAt: null, timezone: null, bookedMode: null,
    });

    assert.equal(missing.length, 4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. The two copies agree
// ═══════════════════════════════════════════════════════════════════════════

describe('E. the database and TypeScript describe the same machine', () => {
  /** Pull a CHECK's `in (...)` members out of the migration. */
  const vocabulary = (column: string) => {
    const match = SQL.match(new RegExp(`check \\(${column} in\\s*\\(([^)]*)\\)`));
    return match
      ? [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort()
      : null;
  };

  test('the status vocabularies are identical', () => {
    assert.deepEqual(vocabulary('status'), [...MEETING_STATUSES].sort());
  });

  test('the mode vocabularies are identical, in both columns', () => {
    // §4.1 keeps the requested mode apart from the booked one; they are the
    // same vocabulary, and a drift between them would be silent.
    assert.deepEqual(vocabulary('requested_mode'), [...MEETING_MODES].sort());
    assert.deepEqual(vocabulary('booked_mode'), [...MEETING_MODES].sort());
  });

  test('the outcome vocabularies are identical', () => {
    assert.deepEqual(vocabulary('outcome'), [...MEETING_OUTCOMES].sort());
  });

  test('the transition table is the one the trigger enforces', () => {
    const arms = [...SQL.matchAll(/when '([a-z_]+)'\s+then array\[([^\]]*)\]/g)];
    const fromSql: Record<string, string[]> = {};
    for (const [, from, members] of arms) {
      fromSql[from!] = [...members!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    }

    assert.ok(Object.keys(fromSql).length > 0, 'no trigger arms found — the scan broke');
    for (const [from, tos] of Object.entries(fromSql)) {
      assert.deepEqual(
        tos,
        [...MEETING_TRANSITIONS[from as MeetingStatus]].sort(),
        `${from} disagrees between the trigger and MEETING_TRANSITIONS`,
      );
    }

    // The arms the trigger does NOT list fall through to its empty default —
    // which must be exactly the terminal set, or a dead state has a way out.
    const listed = Object.keys(fromSql).sort();
    const live = MEETING_STATUSES.filter((s) => !isSettledMeeting(s)).sort();
    assert.deepEqual(listed, live);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. The row's own rules
// ═══════════════════════════════════════════════════════════════════════════

describe('F. what the row refuses on its own', () => {
  test('a booking must be specific, and completion must be authorized', () => {
    assert.match(SQL, /constraint meetings_booked_is_specific check/);
    assert.match(SQL, /constraint meetings_completion_is_authorized check/);
  });

  test('a meeting cannot end before it starts, nor supersede itself', () => {
    assert.match(SQL, /constraint meetings_ends_after_it_starts check/);
    assert.match(SQL, /constraint meetings_supersedes_another check/);
  });

  test('the provider columns exist and are empty — G-227 maps onto this row', () => {
    // Present and null rather than absent, because adding them later would be
    // a migration against live scheduling data.
    assert.match(SQL, /provider_event_id\s+text/);
    assert.match(SQL, /meeting_url\s+text/);
  });

  test('every org-scoped foreign key carries a tenancy guard', () => {
    // Six. core.unguarded_org_fks demands one for each, or
    // db:verify:tenancyguards fails; created_by and completed_by point at
    // core.users, which has no organization_id for the check to reach.
    for (const fk of [
      'lead_id', 'contact_id', 'opportunity_id',
      'conversation_id', 'requested_message_id', 'supersedes_id',
    ]) {
      assert.match(
        SQL,
        new RegExp(`core\\.enforce_parent_org\\('${fk}'`),
        `${fk} has no tenancy guard`,
      );
    }
    assert.match(SQL, /core\.freeze_organization_id\(\)/);
  });

  test('the table is org-scoped, internal-only, and row-level secured', () => {
    assert.match(SQL, /alter table crm\.meetings enable row level security/);
    assert.match(SQL, /core\.is_internal\(\)/);
    assert.match(SQL, /core\.can_write\(\)/);
  });
});
