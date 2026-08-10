import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { can, type Capability } from '../src/lib/authz/permissions.ts';
import type { Role } from '../src/lib/auth/claims.ts';

/**
 * The requirement proposal lifecycle.
 *
 * The rules live in two places that cannot be called from a unit test — a
 * trigger inside Postgres, and a route that needs a service-role client and a
 * model provider. What is asserted here is that those rules are *present and
 * ordered correctly*; that they *behave* is proved against a real database and
 * a real HTTP route by scripts/verify-requirement-proposal.mjs
 * (`npm run db:verify:proposal`).
 *
 * The division is the repo's existing one — see tests/outbox-dispatch.test.ts,
 * which asserts finance still emits invoice.paid as source because emitting it
 * requires a session and a database.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const migration = read('../supabase/migrations/20260810120002_crm_requirement_proposal_lifecycle.sql');
const policyMigration = read('../supabase/migrations/20260810120003_requirement_decision_policy.sql');
const routeSource = read('../app/api/jobs/run/route.ts');
const serviceSource = read('../src/modules/crm/service.ts');
const actionsSource = read('../src/modules/crm/actions.ts');
const pageSource = read('../app/(internal)/leads/[leadId]/page.tsx');
const formSource = read('../app/(internal)/leads/[leadId]/requirement-decision-form.tsx');

/** The decideRequirementVersion function body, isolated. */
const decideBody = (() => {
  const at = serviceSource.indexOf('export async function decideRequirementVersion');
  assert.ok(at > 0, 'decideRequirementVersion is gone');
  const next = serviceSource.indexOf('\nexport async function', at + 10);
  return serviceSource.slice(at, next === -1 ? undefined : next);
})();

// ═══════════════════════════════════════════════════════════════════════════
// A. The state machine
// ═══════════════════════════════════════════════════════════════════════════

describe('A. the proposal states', () => {
  test('all four states the lifecycle needs are permitted', () => {
    const at = migration.indexOf('requirement_versions_status_check');
    const constraint = migration.slice(at, at + 400);
    for (const status of ['proposed', 'accepted', 'rejected', 'failed']) {
      assert.match(constraint, new RegExp(`'${status}'`), `${status} is not a permitted status`);
    }
  });

  test('superseded is kept — versions still supersede one another', () => {
    assert.match(migration, /'superseded'/);
  });

  test('a decision can only be made from proposed', () => {
    assert.match(migration, /old\.status = 'proposed' and new\.status in \('accepted', 'rejected'\)/);
  });

  test('any state may still be superseded — a newer version always wins', () => {
    assert.match(migration, /new\.status = 'superseded'/);
  });

  test('the trigger refuses anything else, rather than logging it', () => {
    const at = migration.indexOf('it cannot become');
    assert.ok(at > 0, 'the illegal-transition branch is gone');
    assert.match(migration.slice(Math.max(0, at - 200), at + 200), /raise exception/);
  });

  test('the payload stays immutable — versioning is only real if bytes cannot change', () => {
    for (const column of ['payload', 'version', 'organization_id', 'conversation_id']) {
      assert.match(
        migration,
        new RegExp(`new\\.${column}\\s+is distinct from old\\.${column}`),
        `${column} is no longer append-only`,
      );
    }
  });

  test('source_job_id is immutable too — provenance that can be edited is not provenance', () => {
    assert.match(migration, /new\.source_job_id\s+is distinct from old\.source_job_id/);
  });

  test('the migration is additive — no drop of a column, table or index', () => {
    assert.doesNotMatch(migration, /drop table/i);
    assert.doesNotMatch(migration, /drop column/i);
    assert.doesNotMatch(migration, /drop index/i);
    // Dropping the CHECK is how a CHECK is widened; it is re-added immediately.
    assert.match(migration, /drop constraint if exists requirement_versions_status_check/);
    assert.match(migration, /add constraint requirement_versions_status_check/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe('B. one job cannot produce two proposals', () => {
  test('the guard is a unique index on the producing job', () => {
    assert.match(
      migration,
      /create unique index[\s\S]{0,120}requirement_versions[\s\S]{0,120}\(organization_id, source_job_id\)/,
    );
  });

  test('it is partial, so human-authored versions do not collide on null', () => {
    const at = migration.indexOf('requirement_versions_source_job_key');
    assert.match(migration.slice(at, at + 300), /where source_job_id is not null/);
  });

  test('the runner records which job produced the version', () => {
    assert.match(routeSource, /source_job_id: job\.id/);
  });

  test('a re-run checks before it pays for a model call', () => {
    const check = routeSource.indexOf(".eq('source_job_id', job.id)");
    const call = routeSource.indexOf('generateStructured(');
    assert.ok(check > 0, 'the already-produced check is gone');
    assert.ok(check < call, 'the idempotency check must come before the model call');
  });

  test('an already-produced job settles as succeeded, not as a conflict', () => {
    const at = routeSource.indexOf('alreadyProduced');
    const branch = routeSource.slice(at, at + 800);
    assert.match(branch, /status: 'succeeded'/);
  });

  test('a lost race on the unique index is also a success', () => {
    assert.match(routeSource, /insertError\.code === '23505'/);
    const at = routeSource.indexOf("insertError.code === '23505'");
    assert.match(routeSource.slice(at, at + 400), /'succeeded'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Failure is a state, but only when it is final
// ═══════════════════════════════════════════════════════════════════════════

describe('C. failed', () => {
  test('a failed extraction is recorded on the conversation', () => {
    assert.match(routeSource, /status: 'failed'/);
    assert.match(routeSource, /async function failExtraction/);
  });

  test('only when the attempts are exhausted — a retry may still succeed', () => {
    const at = routeSource.indexOf('async function failExtraction');
    const body = routeSource.slice(at, at + 1800);
    assert.match(body, /const exhausted = job\.attempts \+ 1 >= job\.max_attempts/);
    const guard = body.indexOf('if (exhausted)');
    const insert = body.indexOf("status: 'failed'");
    assert.ok(guard > 0 && insert > guard, 'the failed marker must sit inside the exhausted guard');
  });

  test('it carries the same provenance a proposal does', () => {
    const at = routeSource.indexOf('async function failExtraction');
    const body = routeSource.slice(at, at + 1800);
    for (const field of ['organization_id', 'conversation_id', 'generated_by_run_id', 'source_job_id']) {
      assert.match(body, new RegExp(field), `failed versions do not record ${field}`);
    }
  });

  test('every post-conversation failure path routes through it', () => {
    // The paths before a conversation is known keep plain failJob — there is no
    // conversation to attach a failed proposal to.
    assert.equal((routeSource.match(/await failExtraction\(/g) ?? []).length, 4);
  });

  test('a marker that will not insert does not block settling the job', () => {
    const at = routeSource.indexOf('async function failExtraction');
    const body = routeSource.slice(at, at + 2200);
    assert.match(body, /console\.error/);
    assert.match(body, /await failJob\(admin, job, reason\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. The approval gate
// ═══════════════════════════════════════════════════════════════════════════

describe('D. deciding a proposal', () => {
  test('it requires a capability, not merely a session', () => {
    assert.match(decideBody, /can\(context\.role, 'lead\.write'\)/);
    assert.match(decideBody, /FORBIDDEN/);
  });

  test('it reads through the RLS client, so tenancy is the database’s answer', () => {
    assert.match(decideBody, /await createClient\(\)/);
    assert.doesNotMatch(decideBody, /createAdminClient/);
  });

  test('a version in another organization is NOT_FOUND, never a silent success', () => {
    assert.match(decideBody, /if \(!version\) return err\('NOT_FOUND'/);
  });

  test('an already-decided proposal is a CONFLICT', () => {
    assert.match(decideBody, /version\.status !== 'proposed'/);
    assert.match(decideBody, /CONFLICT/);
  });

  test('the write is conditional on the state that was read', () => {
    const update = decideBody.indexOf(".update({ status: decision })");
    assert.ok(update > 0);
    assert.match(decideBody.slice(update, update + 300), /\.eq\('status', 'proposed'\)/);
  });

  test('a lost race reports a conflict rather than claiming success', () => {
    assert.match(decideBody, /if \(!updated\)[\s\S]{0,120}CONFLICT/);
  });

  test('the decision is audited — who agreed to what scope, and when', () => {
    assert.match(decideBody, /recordAudit\(/);
    assert.match(decideBody, /action: `requirement\.\$\{decision\}`/);
    assert.match(decideBody, /before: \{ status: 'proposed' \}/);
  });

  test('it only ever moves status — it cannot rewrite the scope it approves', () => {
    const update = decideBody.indexOf('.update(');
    const updateCall = decideBody.slice(update, decideBody.indexOf(')', update) + 1);
    assert.match(updateCall, /status: decision/);
    assert.doesNotMatch(updateCall, /payload/);
  });

  test('nothing in the decision path calls out to a provider', () => {
    assert.doesNotMatch(decideBody, /\bfetch\(/);
    assert.doesNotMatch(decideBody, /generateStructured/);
    assert.doesNotMatch(decideBody, /resolveProvider/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Reachable, and only where it should be
// ═══════════════════════════════════════════════════════════════════════════

describe('E. the gate is reachable', () => {
  test('a server action exists and delegates to the service', () => {
    assert.match(actionsSource, /export async function decideRequirementVersionAction/);
    assert.match(actionsSource, /await decideRequirementVersion\(/);
  });

  test('the action refuses a decision it does not recognise', () => {
    assert.match(actionsSource, /decision !== 'accepted' && decision !== 'rejected'/);
  });

  test('it re-renders the lead so the new status is what the owner sees', () => {
    const at = actionsSource.indexOf('decideRequirementVersionAction');
    assert.match(actionsSource.slice(at, at + 900), /revalidatePath/);
  });

  test('the existing requirement list renders the control', () => {
    assert.match(pageSource, /RequirementDecisionForm/);
  });

  test('only for a proposal still open, and only for a writer', () => {
    const at = pageSource.indexOf('RequirementDecisionForm versionId');
    const context = pageSource.slice(Math.max(0, at - 300), at);
    assert.match(context, /mayWrite/);
    assert.match(context, /v\.status === 'proposed'/);
  });

  test('a failed extraction is explained rather than shown as a broken payload', () => {
    assert.match(pageSource, /v\.status === 'failed'/);
  });

  test('the form posts a decision and the version it decides', () => {
    assert.match(formSource, /name="versionId"/);
    assert.match(formSource, /value="accepted"/);
    assert.match(formSource, /value="rejected"/);
  });

  test('the client component holds no authorization of its own', () => {
    assert.doesNotMatch(formSource, /can\(/);
    assert.doesNotMatch(formSource, /createClient/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. RLS and the capability model agree on who may decide
//
// They did not, and nothing noticed. The UPDATE policy admitted anyone
// core.can_write() admits — owner, ops_admin, delivery_lead, member — while the
// service required `lead.write`, which only owner and ops_admin hold. The crm
// schema is exposed through PostgREST and a signed-in browser holds a session
// token, so two internal roles could approve a requirement set by PATCHing the
// row directly, skipping the capability check and the audit write entirely.
//
// This is the test that was missing. It compares the two definitions rather
// than restating either, so widening one without the other fails here.
// ═══════════════════════════════════════════════════════════════════════════

describe('G. the database agrees with the capability model', () => {
  const ROLES: readonly Role[] = [
    'owner',
    'ops_admin',
    'delivery_lead',
    'member',
    'contractor',
    'client_admin',
    'client_member',
  ];

  /** Asked of the capability model itself, never copied from it. */
  const holders = (capability: Capability) => ROLES.filter((role) => can(role, capability)).sort();

  /** The roles core.is_admin() admits, read out of the migration. */
  const policyRoles = (() => {
    const fn = policyMigration.slice(policyMigration.indexOf('function core.is_admin'));
    const roleList = /core\.current_user_role\(\) in \(([^)]*)\)/.exec(fn)?.[1];
    assert.ok(roleList, 'core.is_admin no longer selects on a role list');
    return [...roleList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  })();

  test('the UPDATE policy admits exactly the roles that hold lead.write', () => {
    assert.deepEqual(
      policyRoles,
      holders('lead.write'),
      'RLS and the capability model disagree about who may decide a proposal',
    );
  });

  test('and that is strictly narrower than can_write()', () => {
    // The bug in one line: can_write() also admits delivery_lead and member, so
    // gating the decision on it let them through.
    for (const role of ['delivery_lead', 'member'] as const) {
      assert.equal(can(role, 'lead.write'), false, `${role} must not hold lead.write`);
      assert.equal(policyRoles.includes(role), false, `${role} must not pass core.is_admin()`);
    }
  });

  test('the update policy gates on is_admin, not can_write', () => {
    const policy = policyMigration.slice(
      policyMigration.indexOf('create policy requirement_versions_update'),
    );
    assert.match(policy, /core\.is_admin\(\)/);
    assert.doesNotMatch(policy, /core\.can_write\(\)/);
  });

  test('organization scoping survives the tightening', () => {
    const policy = policyMigration.slice(
      policyMigration.indexOf('create policy requirement_versions_update'),
    );
    assert.match(policy, /using \(organization_id = \(select core\.current_organization_id\(\)\)/);
    assert.match(policy, /with check \(organization_id = \(select core\.current_organization_id\(\)\)/);
  });

  test('only the UPDATE policy is touched — reading and authoring are unchanged', () => {
    assert.doesNotMatch(policyMigration, /create policy requirement_versions_select/);
    assert.doesNotMatch(policyMigration, /create policy requirement_versions_insert/);
  });

  test('the service still requires the capability the policy now enforces', () => {
    assert.match(decideBody, /can\(context\.role, 'lead\.write'\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. The agent proposes and nothing more
// ═══════════════════════════════════════════════════════════════════════════

describe('F. the agent cannot approve its own work', () => {
  test('the runner writes proposed, and never a decided status', () => {
    assert.match(routeSource, /status: 'proposed'/);
    assert.doesNotMatch(routeSource, /status: 'accepted'/);
    assert.doesNotMatch(routeSource, /status: 'rejected'/);
  });

  test('the runner never records a requirement decision in the audit trail', () => {
    assert.doesNotMatch(routeSource, /requirement\.accepted|requirement\.rejected/);
  });

  test('the extraction path sends nothing to a client', () => {
    const withoutComments = routeSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(withoutComments, /graph\.facebook/);
    assert.doesNotMatch(withoutComments, /messages\/send/);
    assert.doesNotMatch(withoutComments, /whatsapp/i);
  });
});
