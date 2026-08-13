import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, mock, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import { PROJECT_TRANSITIONS } from '../src/modules/projects/schema.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * G-026 — a project starts when it is actually ready.
 *
 * ADM-13: the advance **verified**, a requirement approved, and the WhatsApp
 * group linked. The owner may start one anyway, and the reason is recorded.
 *
 * The striking thing about this gap is that the conditions were written down on
 * the first delivery migration and enforced by nobody. `projects.status` has
 * carried this comment since then:
 *
 *   'planning → onboarding → active → completed. onboarding covers kickoff,
 *    group setup, and advance payment, before delivery starts.'
 *
 * A project became active because somebody picked `active` from a dropdown.
 *
 *   A. the transition this gates, and the ones it leaves alone
 *   B. the conditions, read from the tables that own them
 *   C. an override is an exception with a reason attached
 *   D. the caller names what is missing
 *   E. who may override
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const executable = read('../supabase/migrations/20260813120016_project_start_conditions.sql')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const fn = (signature: string) => {
  const start = executable.indexOf(signature);
  assert.ok(start >= 0, `${signature} is missing`);
  return executable.slice(start, executable.indexOf('$$;', start));
};

const start = fn('create or replace function projects.start_project');
const readiness = fn('create or replace function projects.start_readiness');

// ═══════════════════════════════════════════════════════════════════════════
// A. Which transition this is
// ═══════════════════════════════════════════════════════════════════════════

describe('A. onboarding → active is what starting means', () => {
  test('and the state machine already said so', () => {
    assert.ok(PROJECT_TRANSITIONS.onboarding.includes('active'));
    assert.ok(PROJECT_TRANSITIONS.planning.includes('onboarding'));
    assert.ok(!PROJECT_TRANSITIONS.planning.includes('active'), 'planning may not jump to active');
  });

  test('the function refuses any other origin', () => {
    assert.match(start, /if v_status <> 'onboarding' then/);
    assert.match(start, /'not_startable'/);
  });

  test('resuming a paused project is deliberately not this', () => {
    // PROJECT_TRANSITIONS admits active from on_hold too. Resuming is a
    // different act, and it stays with setProjectStatus where it already
    // lives — a paused project has already started once.
    assert.ok(PROJECT_TRANSITIONS.on_hold.includes('active'));
    assert.doesNotMatch(start, /on_hold/);
  });

  test('starting a started project is answered, not refused', () => {
    const already = start.indexOf("'already_active'");
    const notStartable = start.indexOf("'not_startable'");
    assert.ok(already > 0 && already < notStartable, 'active must be answered before the origin check');
  });

  test('and it decides under the project row lock', () => {
    assert.match(start, /from projects\.projects p\s*\n\s*where p\.id = p_project_id\s*\n\s*for update/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The three conditions
// ═══════════════════════════════════════════════════════════════════════════

describe('B. each condition is read from the table that owns it', () => {
  test('the advance is a paid invoice on one of the project milestones', () => {
    assert.match(readiness, /from projects\.milestones m\s*\n\s*join finance\.invoices i on i\.milestone_id = m\.id/);
    assert.match(readiness, /and i\.status = 'paid'/);
  });

  test("and since G-007 'paid' means confirmed, which is what ADM-13 asked for", () => {
    // The condition is worded "advance payment verified". It reads as an
    // invoice status only because G-007 made that status mean confirmed money.
    // If paid ever goes back to meaning recorded, this condition silently
    // weakens — which is why it is written down here.
    const finance = read('../supabase/migrations/20260813120015_payment_verified.sql');
    assert.match(finance, /when v_after >= v_total then 'paid'/);
    assert.match(finance, /set verified_minor = v_after/);
  });

  test('the requirement is an accepted version, reached through the deal', () => {
    assert.match(readiness, /join sales\.opportunities o on o\.id = pr\.opportunity_id/);
    assert.match(readiness, /join crm\.requirement_versions rv on rv\.conversation_id = c\.id/);
    assert.match(readiness, /and rv\.status = 'accepted'/);
  });

  test('the group is a live project group on this project', () => {
    assert.match(readiness, /and c\.kind = 'project_group'/);
    assert.match(readiness, /and c\.status <> 'abandoned'/);
  });

  test('none of them is cached on the project', () => {
    // A cached advance_paid flag is a second copy of a fact finance holds, and
    // the first thing a second copy does is disagree with the first.
    assert.doesNotMatch(executable, /add column if not exists advance/);
    assert.match(readiness, /stable/, 'readiness must be side-effect free so a screen can call it');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. The override
// ═══════════════════════════════════════════════════════════════════════════

describe('C. an override carries its reason', () => {
  test('an unmet condition with no reason is refused', () => {
    assert.match(
      start,
      /if array_length\(v_unmet, 1\) is not null\s*\n\s*and \(p_override_reason is null or length\(trim\(p_override_reason\)\) = 0\)/,
    );
  });

  test('and the reason is only stored when it was actually an override', () => {
    // A project that started normally must not carry an explanation for an
    // exception that did not happen.
    assert.match(start, /start_override_reason = case\s*\n\s*when array_length\(v_unmet, 1\) is not null/);
    assert.match(start, /else null/);
  });

  test('the result says whether it was overridden', () => {
    assert.match(start, /array_length\(v_unmet, 1\) is not null;/);
  });

  test('and nothing writes an audit row by hand', () => {
    // G-093 chose one mechanism. The trigger on projects.projects records the
    // whole row, so the override reason reaches the trail without anybody
    // remembering to put it there.
    assert.doesNotMatch(start, /record_audit/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The caller
// ═══════════════════════════════════════════════════════════════════════════

let role: Role = 'owner';
let rpcOutcome: { data: unknown; error: { message: string } | null } = { data: null, error: null };
const seen = { rpcs: [] as [string, unknown][] };

mock.module('@/lib/auth/session', {
  exports: {
    requireInternal: async () => ({
      role,
      userId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    }),
  },
});

mock.module('@/lib/db/server', {
  exports: {
    createClient: async () => ({
      schema() {
        return {
          rpc(name: string, args: unknown) {
            seen.rpcs.push([name, args]);
            return { then: (resolve: (v: typeof rpcOutcome) => unknown) => resolve(rpcOutcome) };
          },
        };
      },
    }),
  },
});

const { startProject } = await import('../src/modules/projects/service.ts');

const PROJECT = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  role = 'owner';
  rpcOutcome = { data: null, error: null };
  seen.rpcs = [];
});

describe('D. startProject answers each outcome', () => {
  test('a started project reports it started', async () => {
    rpcOutcome = {
      data: [{ outcome: 'started', project_status: 'active', unmet: [], overridden: false }],
      error: null,
    };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, { status: 'active', started: true, overridden: false });
  });

  test('an unready project is told exactly what is missing', async () => {
    // "Not ready" tells nobody what to do. These are usually three different
    // people's problems.
    rpcOutcome = {
      data: [
        {
          outcome: 'not_ready',
          project_status: 'onboarding',
          unmet: ['advance_not_verified', 'no_whatsapp_group'],
          overridden: false,
        },
      ],
      error: null,
    };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'CONFLICT');
    assert.match(result.error.message, /advance payment has not been confirmed/);
    assert.match(result.error.message, /no WhatsApp group/);
    assert.doesNotMatch(result.error.message, /requirement/, 'it named a condition that was met');
  });

  test('an unknown reason code is passed through rather than swallowed', async () => {
    rpcOutcome = {
      data: [{ outcome: 'not_ready', project_status: 'onboarding', unmet: ['something_new'], overridden: false }],
      error: null,
    };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /something_new/);
  });

  test('a project already active is the answer, not an error', async () => {
    rpcOutcome = {
      data: [{ outcome: 'already_active', project_status: 'active', unmet: [], overridden: false }],
      error: null,
    };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.started, false);
  });

  test('a project somewhere else in its life is a conflict naming where', async () => {
    rpcOutcome = {
      data: [{ outcome: 'not_startable', project_status: 'planning', unmet: [], overridden: false }],
      error: null,
    };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /planning/);
  });

  test('an empty response is a failed read, not a start — G-054', async () => {
    rpcOutcome = { data: [], error: null };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
  });

  test('a failed call does not leave a project quietly unstarted', async () => {
    rpcOutcome = { data: null, error: { message: 'could not connect to server' } };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'INTERNAL');
    assert.doesNotMatch(result.error.message, /could not connect|server/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Who may override
// ═══════════════════════════════════════════════════════════════════════════

describe('E. starting and overriding are different permissions', () => {
  test('a delivery lead may start a project that is ready', async () => {
    role = 'delivery_lead';
    rpcOutcome = {
      data: [{ outcome: 'started', project_status: 'active', unmet: [], overridden: false }],
      error: null,
    };

    const result = await startProject({ projectId: PROJECT });

    assert.equal(result.ok, true);
    assert.equal(can('delivery_lead', 'project.write'), true);
  });

  test('but may not start one that is not', async () => {
    role = 'delivery_lead';

    const result = await startProject({ projectId: PROJECT, overrideReason: 'client is in a hurry' });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.match(result.error.message, /Only the owner/);
    assert.deepEqual(seen.rpcs, [], 'a forbidden override still reached the database');
  });

  test('an ops admin may not either — overriding is the owner alone', async () => {
    role = 'ops_admin';

    const result = await startProject({ projectId: PROJECT, overrideReason: 'advance agreed verbally' });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'FORBIDDEN');
    assert.equal(can('ops_admin', 'organization.settings'), false);
  });

  test('and the owner may, with the reason reaching the database', async () => {
    rpcOutcome = {
      data: [{ outcome: 'started', project_status: 'active', unmet: ['no_whatsapp_group'], overridden: true }],
      error: null,
    };

    const result = await startProject({ projectId: PROJECT, overrideReason: 'group is being created today' });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.overridden, true);
    assert.deepEqual(seen.rpcs, [
      [
        'start_project',
        { p_project_id: PROJECT, p_override_reason: 'group is being created today' },
      ],
    ]);
  });

  test('a blank reason is not an override, and is refused before the database', async () => {
    const result = await startProject({ projectId: PROJECT, overrideReason: '   ' });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'VALIDATION');
    assert.deepEqual(seen.rpcs, []);
  });
});
