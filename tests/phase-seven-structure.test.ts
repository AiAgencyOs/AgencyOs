import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENT_DEFINITIONS, definitionFor, mayHandOff } from '../src/modules/agents/registry.ts';

/**
 * Phase 7 structure: the properties the live verifier (scripts/verify-phase-seven.sql) proves against a real Postgres are also pinned here against the TEXT
 * of the migrations and the UI, so a refactor that quietly drops a control is a red test even where no database is reachable. (These text checks never replace
 * the live run: a regex cannot say a migration works, only that a control is still written.)
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const MIGRATIONS = readdirSync(`${root}supabase/migrations`).filter((f) => /^202611040\d{5}_.*\.sql$/.test(f) || /^20261104\d{6}_.*\.sql$/.test(f)).sort();
const SQL = MIGRATIONS.map((f) => read(`supabase/migrations/${f}`)).join('\n');
const ACTIONS = read('src/modules/projects/phase-seven-actions.ts');
const QUERIES = read('src/modules/projects/phase-seven-queries.ts');
/** One function (or one table definition) of the migrations: split at the declaration that follows, never an open-ended slice from a marker. */
const FUNCTIONS = SQL.split('create or replace function ');
const fnBody = (name: string): string => {
  const body = FUNCTIONS.find((c) => c.startsWith(`projects.${name}(`));
  assert.ok(body, `function projects.${name} is not defined`);
  return body;
};
const TABLE_DEFS = SQL.split('create table if not exists ');
const tableDef = (name: string): string => {
  const def = TABLE_DEFS.find((c) => c.startsWith(`projects.${name} (`));
  assert.ok(def, `table projects.${name} is not defined`);
  return def.slice(0, def.indexOf('\n);') + 3);
};
const PANEL = read('app/(internal)/projects/[projectId]/phase-seven-panel.tsx');

describe('the migrations live in the Phase 7 range and in order', () => {
  test('four migrations, 20261104100000 to 20261104400000', () => {
    assert.equal(MIGRATIONS.length, 4, MIGRATIONS.join(', '));
    assert.match(MIGRATIONS[0] ?? '', /^20261104100000_/);
    assert.match(MIGRATIONS[3] ?? '', /^20261104400000_/);
  });
});

describe('every Phase 7 table is hardened and tenancy-guarded', () => {
  const tables = [...SQL.matchAll(/create table if not exists projects\.((?:p7_[a-z_]+)|phase_seven(?:_handoffs)?)\s*\(/g)].map((m) => m[1] as string);
  test('24 tables exist', () => {
    assert.equal(new Set(tables).size, 24, tables.join(', '));
  });
  test('each is passed to p7_harden (RLS on, internal-only select, no write grant to authenticated, frozen tenant)', () => {
    const hardened = [...SQL.matchAll(/'((?:p7_[a-z_]+)|phase_seven(?:_handoffs)?)'/g)].map((m) => m[1] as string);
    for (const t of tables) assert.ok(hardened.includes(t), `${t} is not hardened`);
  });
  test('p7_harden writes the internal-only policy, revokes anon/public/writes and freezes the organization', () => {
    const body = SQL.slice(SQL.indexOf('create or replace function projects.p7_harden'), SQL.indexOf('create or replace function projects.p7_guard_fk'));
    assert.match(body, /enable row level security/);
    assert.match(body, /organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)/);
    assert.match(body, /revoke all on %I\.%I from public, anon/);
    assert.match(body, /revoke insert, update, delete on %I\.%I from authenticated/);
    assert.match(body, /core\.freeze_organization_id\(\)/);
  });
  test('every foreign key to an org-scoped Phase 7 / Phase 6 parent has a core.enforce_parent_org guard', () => {
    const guarded = [...SQL.matchAll(/p7_guard_fk\('([a-z_0-9]+)', '([a-z_0-9]+)', '([a-z_.0-9]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
    for (const t of tables) {
      const create = tableDef(t);
      for (const fk of create.matchAll(/^\s+([a-z_0-9]+)\s+uuid(?: not null)? references (projects|qa)\.([a-z_0-9]+)\(id\)/gm)) {
        assert.ok(guarded.includes(`${t}.${fk[1]}`), `${t}.${fk[1]} -> ${fk[2]}.${fk[3]} has no tenancy guard`);
      }
    }
  });
});

describe('no table has a column that could hold a secret value', () => {
  test('there is no password / secret value / token / api key / private key column', () => {
    for (const m of SQL.matchAll(/create table if not exists projects\.(?:p7_[a-z_]+|phase_seven(?:_handoffs)?)\s*\(([\s\S]*?)\n\);/g)) {
      for (const col of (m[1] ?? '').matchAll(/^\s{2}([a-z_0-9]+)\s+(?:text|jsonb)/gm)) {
        assert.doesNotMatch(col[1] as string, /password|passwd|secret_value|^secret$|token|api_key|private_key|credential/, `column ${col[1]}`);
      }
    }
  });
  test('every free-text column that a person writes refuses anything shaped like a secret (the build-log mask)', () => {
    assert.match(SQL, /create or replace function projects\.p7_has_secret\(p_text text\)[\s\S]*?projects\.mask_secrets\(p_text\)/);
    const guards = SQL.match(/not projects\.p7_has_secret\(/g) ?? [];
    assert.ok(guards.length >= 50, `only ${guards.length} secret guards in the table definitions`);
  });
});

describe('every door is a definer with an empty search_path and explicit grants', () => {
  const doors = SQL.split('create or replace function ').slice(1)
    .map((chunk) => ({ header: chunk.slice(0, chunk.indexOf(' as $$') > 0 ? chunk.indexOf(' as $$') : 400) + ' ', name: /^projects\.([a-z_0-9]+)\(/.exec(chunk)?.[1] }))
    .filter((d) => d.name && /security definer set search_path = ''/.test(d.header) && !/returns trigger/.test(d.header))
    .map((d) => d.name as string);
  test('there are many, and each is revoked from public and anon', () => {
    assert.ok(doors.length >= 40, `only ${doors.length} doors found`);
    for (const d of doors) assert.match(SQL, new RegExp(`revoke all on function projects\\.${d}\\([^)]*\\) from public, anon`), `${d} is not revoked`);
  });
  test('the deployment-record doors are executable by the service role only', () => {
    for (const d of ['request_deployment', 'record_deployment_blocker', 'record_deployment_progress']) {
      assert.match(SQL, new RegExp(`revoke all on function projects\\.${d}\\([^)]*\\) from public, anon, authenticated`), `${d} must revoke authenticated`);
      assert.match(SQL, new RegExp(`grant execute on function projects\\.${d}\\([^)]*\\) to service_role;`), `${d} is granted to service_role`);
      assert.doesNotMatch(SQL, new RegExp(`grant execute on function projects\\.${d}\\([^)]*\\) to [a-z_, ]*authenticated`), `${d} must not be granted to authenticated`);
      const fn = fnBody(d);
      assert.match(fn.slice(fn.indexOf('begin'), fn.indexOf('begin') + 260), /auth\.uid\(\)\) is not null or coalesce\(\(select auth\.role\(\)\), ''\) <> 'service_role'/, `${d} checks the service role inside too`);
    }
  });
  test('a person validates production: the validation doors are not granted to the service role', () => {
    for (const d of ['open_validation_run', 'record_validation_check', 'finish_validation_run', 'record_client_acceptance']) {
      assert.match(SQL, new RegExp(`grant execute on function projects\\.${d}\\([^)]*\\) to authenticated;`), `${d} is a person's door`);
      assert.doesNotMatch(SQL, new RegExp(`grant execute on function projects\\.${d}\\([^)]*\\) to [a-z_, ]*service_role`), `${d} must not be granted to the service role`);
    }
  });
});

describe('the locked rules are written where they are enforced', () => {
  test('only the exact Phase 6 approved candidate: the plan trigger, the approval and the start all re-check it', () => {
    assert.match(SQL, /a deployment plan carries exactly the Phase 6 approved candidate/);
    assert.match(SQL, /if not projects\.p7_deployment_approved\(v_d\.plan_id\)/);
    assert.match(SQL, /p7_candidate_ok\(p\.project_id, p\.candidate_id\)/);
  });
  test('deployment success alone is not completion: a pipeline project completes only through its completion record', () => {
    assert.match(SQL, /this project is in Phase 7: it completes only when the completion gate passes/);
    assert.match(SQL, /status in \('succeeded_pending_validation', 'recovered_pending_validation'\)/);
  });
  test('failed production validation pauses completion; an incident closes only after a passed re-validation', () => {
    assert.match(SQL, /set completion_paused = true, paused_reason = 'a production incident is open: '/);
    assert.match(SQL, /'recovery_not_verified'/);
    assert.match(SQL, /if v_s\.completion_paused then return; end if;/);
  });
  test('code changes after Phase 6 need a NEW approved candidate with every hard gate satisfied', () => {
    assert.match(SQL, /select count\(\*\) into v_gaps from qa\.evaluate_hard_gates\(v_c\.id\) g where not g\.satisfied/);
    assert.match(SQL, /'incident_path_is_not_config_recovery'/);
    assert.match(SQL, /'code_change_open'/);
  });
  test('agents never fabricate approval, acceptance or completion: those doors need a signed-in person and the right role', () => {
    for (const [fn, role] of [['decide_deployment_plan', 'is_admin'], ['decide_handover_package', 'is_admin'], ['decide_rollback', 'is_admin'], ['record_client_acceptance', 'can_manage_delivery'], ['approve_completion_exception', 'is_admin']] as const) {
      const body = fnBody(fn);
      assert.match(body.slice(0, 900), new RegExp(`core\\.${role}\\(\\)`), `${fn} needs ${role}`);
      assert.match(body.slice(0, 600), /if v_actor is null then return query select 'no_actor'/, `${fn} refuses a caller with no person`);
    }
    const completion = fnBody('complete_phase_seven');
    assert.match(completion.slice(0, 2400), /not coalesce\(\(select core\.is_admin\(\)\), false\)/);
  });
  test('the credentials rule: an access transfer is a receipt, support access needs an Admin, no value column exists', () => {
    assert.match(SQL, /THE RULE: this table records THAT a credential was transferred and HOW, never the value/);
    assert.match(SQL, /'support_access_needs_admin_authorization'/);
    assert.match(SQL, /check \(not support_access_retained or support_access_authorized_by is not null\)/);
  });
  test('a package version is immutable once it leaves draft, and an old version is never deleted', () => {
    assert.match(SQL, /a package version that left draft is not overwritten: an edit is a new version/);
    assert.match(SQL, /a handover package version is never deleted: an old version is preserved/);
    assert.match(SQL, /create unique index if not exists p7_packages_one_live/);
  });
  test('the completion record and the Phase 8 intake are frozen, and replay returns the one record', () => {
    assert.match(SQL, /is a completed project''s history and is never edited or deleted/);
    assert.match(SQL, /unique \(project_id\)/);
    assert.match(SQL, /'already_completed'/);
  });
  test('legacy projects are untouched: the new rule starts with "does a phase_seven row exist"', () => {
    assert.match(SQL, /if exists \(select 1 from projects\.phase_seven s where s\.project_id = new\.id\) then/);
  });
});

describe('the Phase 7 agents are installed disabled and bound to nothing', () => {
  const keys = ['deployment_agent', 'release_qa', 'incident_recovery'];
  test('defined, QA-verified, holding no tool, never a verifier, handing off only to QA', () => {
    for (const k of keys) {
      const d = definitionFor(k);
      assert.ok(d, k);
      assert.deepEqual(d?.tools, [], k);
      assert.equal(d?.mayVerify, false, k);
      assert.equal(d?.verification.verifiedBy, 'quality_assurance', k);
      assert.deepEqual(d?.handoffTargets, ['quality_assurance'], k);
      assert.equal(d?.clientFacing, false, k);
      assert.equal(d?.moneyAuthority, 'none', k);
      assert.ok(mayHandOff(k, 'quality_assurance'));
      assert.ok(!mayHandOff(k, 'finance') && !mayHandOff(k, 'handover') && !mayHandOff(k, 'project_manager'), `${k} reaches nothing but QA`);
    }
    assert.equal(AGENT_DEFINITIONS.filter((a) => a.mayVerify).length, 1);
  });
  test('the migration installs each with enabled = false and the mirror pairs match the registry', () => {
    const agentsMigration = read(`supabase/migrations/${MIGRATIONS[3]}`);
    for (const k of keys) assert.match(agentsMigration, new RegExp(`\\('${k}', '[^']*', '(?:[^']|'')*', 'L1', false,`), k);
    assert.equal((agentsMigration.match(/\('(?:deployment_agent|release_qa|incident_recovery)', 'quality_assurance'\)/g) ?? []).length, 6, 'three handoff pairs and three verifier pairs');
  });
});

describe('the Admin panel only calls whitelisted doors and cannot fabricate a deployment, validation or completion', () => {
  const doorKeys = [...ACTIONS.matchAll(/^ {2}([a-z_]+): \{ ?(?:rpc|$)/gm)].map((m) => m[1] as string);
  const rpcs = [...ACTIONS.matchAll(/rpc: '([a-z_0-9]+)'/g)].map((m) => m[1] as string);
  test('the actions file is one server action over a table of doors', () => {
    assert.ok(doorKeys.length >= 30, `${doorKeys.length} door keys`);
    assert.match(ACTIONS, /Object\.prototype\.hasOwnProperty\.call\(DOORS, name\)/);
    assert.equal((ACTIONS.match(/^export /gm) ?? []).length, 1, 'a use server file exports only the one async function');
    assert.match(ACTIONS, /^export async function phaseSevenDoorAction/m);
  });
  test('no door records a deployment, moves its status, or fabricates anything the runner or the gate owns', () => {
    for (const forbidden of ['request_deployment', 'record_deployment_progress', 'record_deployment_blocker', 'p7_refresh_validated', 'p7_open_incident', 'p7_set_state']) assert.ok(!rpcs.includes(forbidden), forbidden);
  });
  test('every rpc the actions call exists in a migration', () => {
    for (const rpc of rpcs) assert.match(SQL + read('supabase/migrations/20261101140000_phase_six_completes_on_an_approved_candidate_and_hands_phase_seven_an_intake.sql'), new RegExp(`function projects\\.${rpc}\\(`), rpc);
  });
  test('every door the panel posts is in the whitelist', () => {
    const used = [...PANEL.matchAll(/door="([a-z_]+)"/g)].map((m) => m[1] as string);
    assert.ok(used.length >= 30);
    for (const d of used) assert.ok(doorKeys.includes(d), `the panel posts door "${d}", which the action does not whitelist`);
  });
  test('the panel says the executor is not configured', () => {
    assert.match(PANEL, /No production deployment executor is bound/);
  });
});

describe('every read in the queries file is guarded (a failed read is not "nothing yet")', () => {
  test('each rpc/table read has its own unreadable() guard', () => {
    const reads = (QUERIES.match(/\bdb\s*\.(?:from|rpc)\(/g) ?? []).length;
    const guards = (QUERIES.match(/if \(\w+\) unreadable\(/g) ?? []).length;
    assert.equal(guards, reads, `${reads} reads, ${guards} guards`);
    assert.equal((QUERIES.match(/unreadable\(/g) ?? []).length, guards, 'no stray call and no mention in a comment');
  });
});
