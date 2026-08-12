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
 *
 * One part of it was not actually of that kind. `decideRequirementVersion` is
 * application branching, not a database rule, and section D below asserts it by
 * matching its own source text — which cannot fail when the function stops
 * doing what the text says. That gate is now executed in
 * tests/requirement-decision.test.ts, which stubs the database and calls the
 * real function; section D is kept as the cheaper structural pin over the same
 * code. Everything else here — the trigger, the unique indexes, the policies,
 * the allocator — stays source-asserted on purpose, because simulating them
 * would prove only that the simulation agrees with itself.
 */

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const migration = read('../supabase/migrations/20260810120002_crm_requirement_proposal_lifecycle.sql');
const policyMigration = read('../supabase/migrations/20260810120003_requirement_decision_policy.sql');
const uniqueMigration = read('../supabase/migrations/20260810120004_requirement_version_uniqueness.sql');
const allocMigration = read('../supabase/migrations/20260810120005_requirement_version_allocation.sql');
const orgScopeMigration = read('../supabase/migrations/20260811120001_requirement_version_org_scoping.sql');
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

  test('an already-produced proposal settles the job, not as a conflict', () => {
    // Since C4 the outcome depends on what was produced: a proposal succeeds
    // the job, a failed marker parks it dead. Suite J covers that split; what
    // matters here is that neither is treated as an error.
    const at = routeSource.indexOf('if (alreadyProduced) {');
    const end = routeSource.indexOf('const { data: messages }', at);
    assert.ok(at > 0 && end > at, 'the already-produced branch is gone');
    const branch = routeSource.slice(at, end);
    assert.match(branch, /failed \? 'dead' : 'succeeded'/);
    // Neither is *called* here — the branch settles the job itself.
    assert.doesNotMatch(branch, /await (failJob|failExtraction)\(/);
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
    // `job.attempts` is the attempt in progress: core.claim_jobs increments it
    // inside the statement that takes the lock (G-082), so adding one here
    // would write the `failed` marker an attempt before it was true.
    assert.match(body, /const exhausted = job\.attempts >= job\.max_attempts/);
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
// H. C1 — one proposal per transcript state
//
// Reproduced before the fix: two messages between ticks queued two jobs, both
// read the same two-message transcript, and both wrote a proposal — two
// identical rows and two model calls.
//
// The behaviour is proved against a real database and the real runner by
// scripts/verify-requirement-proposal.mjs §7b. What is pinned here is that the
// runner still checks *before* it spends a model call, which is the part a
// refactor could quietly lose while leaving the database invariant intact.
// ═══════════════════════════════════════════════════════════════════════════

describe('H. one proposal per transcript state', () => {
  test('the transcript state is unique per conversation', () => {
    assert.match(
      uniqueMigration,
      /create unique index[\s\S]{0,140}\(conversation_id, source_message_count\)/,
    );
  });

  test('partial, so human-authored versions are exempt', () => {
    const at = uniqueMigration.indexOf('requirement_versions_transcript_state_key');
    assert.match(uniqueMigration.slice(at, at + 320), /where source_message_count is not null/);
  });

  test('the runner checks the transcript state before calling the model', () => {
    const check = routeSource.indexOf("eq('source_message_count', transcript.length)");
    const call = routeSource.indexOf('generateStructured(');
    assert.ok(check > 0, 'the transcript-state check is gone');
    assert.ok(check < call, 'it must come before the model call, or the call is wasted');
  });

  test('and before the run record is opened, so no empty run is left behind', () => {
    const check = routeSource.indexOf("eq('source_message_count', transcript.length)");
    assert.ok(check < routeSource.indexOf("from('agent_runs')"));
  });

  test('a redundant job settles as succeeded, not as a failure', () => {
    // Bounded to the branch rather than a fixed window, which a comment added
    // above the return could push the assertion out of.
    const at = routeSource.indexOf('if (sameTranscript) {');
    const end = routeSource.indexOf('// ── open the run record', at);
    assert.ok(at > 0 && end > at, 'the redundant-job branch is gone');
    const branch = routeSource.slice(at, end);
    assert.match(branch, /status: 'succeeded'/);
    assert.match(branch, /transcript already extracted/);
  });

  test('every version records the transcript it was extracted from', () => {
    assert.match(routeSource, /source_message_count: transcript\.length/);
    // Including the failed marker, so provenance is not lost on failure.
    assert.match(routeSource, /source_message_count: messageCount/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I. C3 — one authoritative version
//
// Reproduced before the fix: accepting v1 and then v2 left both `accepted`,
// with nothing marking either as the agreed scope, because no code ever set
// `superseded`. Behaviour proved live in §7c; the invariants are pinned here.
// ═══════════════════════════════════════════════════════════════════════════

/** The supersede function body alone — the guard below it also mentions statuses. */
function supersedeFn(): string {
  const start = uniqueMigration.indexOf('function crm.requirement_versions_supersede');
  const end = uniqueMigration.indexOf('$$;', start);
  return uniqueMigration.slice(start, end);
}

describe('I. one authoritative version', () => {
  test('at most one accepted version per conversation', () => {
    assert.match(
      uniqueMigration,
      /create unique index[\s\S]{0,140}\(conversation_id\)\s*\n?\s*where status = 'accepted'/,
    );
  });

  test('accepting a version supersedes the previously accepted one', () => {
    const fn = supersedeFn();
    assert.match(fn, /new\.status = 'accepted'/);
    assert.match(fn, /set status = 'superseded'[\s\S]{0,200}status = 'accepted'/);
  });

  test('a new proposal supersedes an older undecided one', () => {
    const fn = supersedeFn();
    assert.match(fn, /tg_op = 'INSERT' and new\.status = 'proposed'/);
    assert.match(fn, /set status = 'superseded'[\s\S]{0,200}status = 'proposed'/);
  });

  test('it fires BEFORE, or the unique index would reject the second approval', () => {
    assert.match(
      uniqueMigration,
      /create trigger requirement_versions_supersede\s*\n?\s*before insert or update/,
    );
  });

  test('it cannot recurse — neither rule matches a row becoming superseded', () => {
    const fn = supersedeFn();
    assert.doesNotMatch(fn, /new\.status = 'superseded'/);
  });

  test('the guard still fires on UPDATE only — on INSERT there is no old row', () => {
    const at = uniqueMigration.lastIndexOf('create trigger requirement_versions_guard');
    assert.match(uniqueMigration.slice(at, at + 160), /before update on/);
    assert.doesNotMatch(uniqueMigration.slice(at, at + 160), /before insert/);
  });

  test('source_message_count joins the immutable set', () => {
    assert.match(uniqueMigration, /new\.source_message_count is distinct from old\.source_message_count/);
  });

  test('the migration is additive — nothing is dropped but re-created objects', () => {
    assert.doesNotMatch(uniqueMigration, /drop table|drop column|drop index/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J. C4 — a failed extraction settles as failed
//
// Reproduced before the fix: a job whose `failed` marker was written but whose
// settlement never ran was released by the reaper, and the retry reported
// `succeeded`. Behaviour proved live in §8b; the decision is pinned here.
// ═══════════════════════════════════════════════════════════════════════════

describe('J. a reaped failed extraction stays failed', () => {
  test('the already-produced branch reads the status, not just the existence', () => {
    const at = routeSource.indexOf('alreadyProduced');
    const branch = routeSource.slice(at, at + 1600);
    assert.match(branch, /alreadyProduced\.status === 'failed'/);
  });

  test('a failed version parks the job dead, a proposal succeeds it', () => {
    const at = routeSource.indexOf("alreadyProduced.status === 'failed'");
    const branch = routeSource.slice(at, at + 900);
    assert.match(branch, /failed \? 'dead' : 'succeeded'/);
    assert.match(branch, /status: failed \? 'failed' : 'succeeded'/);
  });

  test('and it says which, rather than reporting one reason for both', () => {
    const at = routeSource.indexOf("alreadyProduced.status === 'failed'");
    assert.match(routeSource.slice(at, at + 900), /'already failed' : 'already produced'/);
  });

  test('a reason already recorded is preserved, not overwritten', () => {
    assert.match(routeSource, /last_error: job\.last_error \?\?/);
    // Which requires the claim to hand back the whole row. core.claim_jobs
    // returns `j.*` (G-082), where the old two-step named its columns and
    // could have dropped this one by omission.
    const migration = readFileSync(
      fileURLToPath(new URL('../supabase/migrations/20260812120009_claim_jobs_by_kind.sql', import.meta.url)),
      'utf8',
    );
    assert.match(migration, /returning j\.\*/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K. C2 — allocating a version without a race
//
// Reproduced before the fix: two runners on one conversation both read the
// highest version and both inserted it; the loser failed on the unique index
// after paying for a model call, and the failure burned an attempt. Behaviour
// proved live in §8c.
// ═══════════════════════════════════════════════════════════════════════════

describe('K. version allocation', () => {
  test('the version is allocated inside the insert, under a lock', () => {
    assert.match(allocMigration, /for update/);
    assert.match(allocMigration, /coalesce\(max\(v\.version\), 0\) \+ 1/);
  });

  test('the runner no longer reads the maximum and then inserts', () => {
    assert.doesNotMatch(
      routeSource,
      /select\('version'\)[\s\S]{0,200}order\('version'[\s\S]{0,200}const nextVersion = \(latest/,
    );
    assert.match(routeSource, /rpc\('insert_requirement_version'/);
  });

  test('both write paths use it — the proposal and the failed marker', () => {
    assert.equal((routeSource.match(/rpc\('insert_requirement_version'/g) ?? []).length, 2);
  });

  test('losing either idempotency race is a success, not a failure', () => {
    const at = routeSource.indexOf('const raced =');
    assert.ok(at > 0, 'the raced branch is gone');
    const branch = routeSource.slice(at, at + 700);
    assert.match(branch, /source_job/);
    assert.match(branch, /transcript_state/);
    assert.match(branch, /status: 'succeeded'/);
  });

  test('the allocator is service-role only and borrows no privilege', () => {
    assert.match(allocMigration, /security invoker/);
    assert.match(allocMigration, /revoke all on function crm\.insert_requirement_version/);
    assert.match(allocMigration, /grant execute on function crm\.insert_requirement_version[\s\S]{0,140}to service_role/);
  });

  test('every trigger still applies — it inserts, it does not bypass', () => {
    assert.doesNotMatch(allocMigration, /disable trigger|alter table .* disable/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L. C8 — every version lookup carries the organization
//
// A conversation belongs to one organization, so filtering versions by
// conversation looks like it implies the organization. It does not: the insert
// policy checks the row's own organization_id, not the conversation's, so a
// tenant can attach a row to another tenant's conversation. Behaviour proved
// live in §7d; the shape is enumerated here so a new unscoped read fails.
// ═══════════════════════════════════════════════════════════════════════════

describe('L. version lookups are organization-scoped', () => {
  /** Every requirement_versions query in the route, with the filters it applies. */
  const versionQueries = (() => {
    const lines = routeSource.split('\n');
    const found: { line: number; kind: 'read' | 'insert'; scoped: boolean }[] = [];
    lines.forEach((line, i) => {
      if (!line.includes("from('requirement_versions')")) return;
      const block: string[] = [];
      for (let j = i; j < Math.min(i + 18, lines.length); j += 1) {
        block.push(lines[j]!);
        if (lines[j]!.includes('.maybeSingle()') || lines[j]!.includes('});')) break;
      }
      const text = block.join('\n');
      found.push({
        line: i + 1,
        kind: text.includes('.insert(') ? 'insert' : 'read',
        scoped: /organization_id/.test(text),
      });
    });
    return found;
  })();

  test('the route still queries requirement_versions at all', () => {
    // Two reads remain in the route: the already-produced check and the
    // transcript-state check. The two version allocations moved into
    // crm.insert_requirement_version with C2, and their scoping is asserted
    // against that function below rather than here.
    assert.ok(versionQueries.length >= 2, `found only ${versionQueries.length} queries`);
  });

  test('every read filters on organization_id', () => {
    const unscoped = versionQueries.filter((q) => q.kind === 'read' && !q.scoped);
    assert.deepEqual(
      unscoped.map((q) => q.line),
      [],
      `unscoped reads at line(s) ${unscoped.map((q) => q.line).join(', ')}`,
    );
  });

  test('every insert sets organization_id from the job, never from input', () => {
    const unscoped = versionQueries.filter((q) => q.kind === 'insert' && !q.scoped);
    assert.deepEqual(unscoped.map((q) => q.line), []);
    assert.match(routeSource, /organization_id: job\.organization_id/);
  });

  test('the allocator scopes its max(version) by organization too', () => {
    // The version lookup moved into SQL with C2; the scoping had to follow it,
    // or a foreign row on the conversation decides this organization's next
    // version number.
    const fn = orgScopeMigration.slice(
      orgScopeMigration.indexOf('function crm.insert_requirement_version'),
      orgScopeMigration.indexOf('$$;', orgScopeMigration.indexOf('function crm.insert_requirement_version')),
    );
    assert.match(fn, /where v\.conversation_id = p_conversation_id/);
    assert.match(fn, /and v\.organization_id = p_organization_id/);
  });

  test('and C2 is otherwise unchanged — the lock and the aggregate survive', () => {
    const fn = orgScopeMigration.slice(orgScopeMigration.indexOf('function crm.insert_requirement_version'));
    assert.match(fn, /for update/);
    assert.match(fn, /coalesce\(max\(v\.version\), 0\) \+ 1/);
  });

  test('the transcript-state key includes the organization', () => {
    assert.match(
      orgScopeMigration,
      /requirement_versions_transcript_state_key[\s\S]{0,200}\(organization_id, conversation_id, source_message_count\)/,
    );
  });

  test('so does the one-accepted key', () => {
    assert.match(
      orgScopeMigration,
      /requirement_versions_one_accepted_key[\s\S]{0,200}\(organization_id, conversation_id\)/,
    );
  });

  test('the supersede trigger only reaches rows in the same organization', () => {
    const fn = orgScopeMigration.slice(
      orgScopeMigration.indexOf('function crm.requirement_versions_supersede'),
      orgScopeMigration.indexOf('$$;', orgScopeMigration.indexOf('function crm.requirement_versions_supersede')),
    );
    const updates = fn.match(/update crm\.requirement_versions/g) ?? [];
    const scopes = fn.match(/organization_id = new\.organization_id/g) ?? [];
    assert.equal(scopes.length, updates.length, 'an unscoped supersede would cross tenants');
  });

  test('and C3 is otherwise unchanged — both rules survive', () => {
    const fn = orgScopeMigration.slice(orgScopeMigration.indexOf('function crm.requirement_versions_supersede'));
    assert.match(fn, /new\.status = 'accepted'/);
    assert.match(fn, /tg_op = 'INSERT' and new\.status = 'proposed'/);
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
