import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';

/**
 * Phase 7b structure: the properties scripts/verify-phase-seven-b.sql proves against a real Postgres are also pinned against the TEXT of the migrations, the
 * wiring and the UI, so a refactor that quietly drops a control is a red test even where no database is reachable. (A regex cannot say a migration works; only
 * the live run does. These say a control is still written, and several say a thing is ABSENT where its positive twin is asserted beside it.)
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const MIGRATIONS = readdirSync(`${root}supabase/migrations`).filter((f) => /^20261108\d{6}_.*\.sql$/.test(f)).sort();
const byPrefix = (prefix: string) => read(`supabase/migrations/${MIGRATIONS.find((f) => f.startsWith(prefix)) ?? 'missing'}`);
const SEAM = byPrefix('20261108010000');
const FIN = byPrefix('20261108020000');
const ROUTING = byPrefix('20261108030000');
const ARCHIVE = byPrefix('20261108040000');
const PORTAL = byPrefix('20261108050000');
const ALL = [SEAM, FIN, ROUTING, ARCHIVE, PORTAL].join('\n');
/** One function of a migration: split at the declaration that follows, never an open-ended slice from a marker. */
const fn = (sql: string, name: string): string => {
  const chunk = sql.split('create or replace function ').find((c) => c.startsWith(`projects.${name}(`));
  assert.ok(chunk, `projects.${name} is not defined`);
  return chunk.slice(0, chunk.indexOf('end $$;') + 7);
};

describe('the migrations live in the Phase 7b range and in order', () => {
  test('five migrations, 20261108010000 to 20261108050000', () => {
    assert.equal(MIGRATIONS.length, 5, MIGRATIONS.join(', '));
    assert.deepEqual(MIGRATIONS.map((m) => m.slice(0, 14)), ['20261108010000', '20261108020000', '20261108030000', '20261108040000', '20261108050000']);
  });
});

describe('the seam and the financial gate patch the LIVE definition and refuse to be a silent no-op', () => {
  test('both patchers raise when the expected text is missing', () => {
    for (const sql of [SEAM, FIN]) {
      assert.match(sql, /if position\(p_old in p_src\) = 0 then raise exception/);
      assert.match(sql, /pg_get_functiondef\(/);
    }
  });
  test('the seam edits only projects.p8_build_intake, and keeps it unreachable except through its two doors', () => {
    assert.match(SEAM, /'projects\.p8_build_intake\(uuid, uuid\)'::regprocedure/);
    assert.ok(!/create or replace function projects\.(fill_phase_eight_intake|start_phase_eight|waive_phase_eight_gate)/.test(SEAM));
    assert.match(SEAM, /has_function_privilege\('authenticated', v_oid, 'execute'\) or has_function_privilege\('service_role', v_oid, 'execute'\)/);
  });
  test('the seam reads the frozen handoff and names it as the source, with its id as the reference', () => {
    assert.match(SEAM, /from projects\.phase_seven_handoffs hh where hh\.project_id = v_project\.id and hh\.organization_id = p_organization_id/);
    assert.match(SEAM, /case when v_h7\.id is null then ''completion_record'' else ''phase_seven_handoff'' end/);
    assert.match(SEAM, /v_h7\.id::text, v_c\.scope_version_id/);
    assert.match(SEAM, /v_fin7 int/);
    assert.match(SEAM, /projects\.p7_financial_clearance\(v_project\.id\)/);
  });
  test('the legacy path is untouched: no phase seven handoff means the intake source is still the completion record', () => {
    assert.match(SEAM, /case when v_h7\.id is null then v_c\.id end/);
  });
  test('the financial gate keeps FIVE rows (no sixth row is added) and folds Phase 9 into no_open_dispute', () => {
    assert.ok(!/gate := '[a-z_]+'/.test(FIN.replace(/gate := 'no_open_dispute'/g, '')), 'no new gate row is introduced');
    assert.match(FIN, /finance\.finance_exceptions fx/);
    assert.match(FIN, /fx\.state = 'open' and fx\.blocking/);
    assert.match(FIN, /finance\.project_is_financially_closed\(p_project_id\)/);
    assert.match(FIN, /and v_blk = 0/);
  });
});

describe('every new table is hardened, door-written, append-only where it is history, and tenancy-guarded', () => {
  const tables = [...ALL.matchAll(/create table if not exists projects\.(p7b_[a-z_]+)\s*\(/g)].map((m) => m[1] as string);
  test('seven tables exist', () => {
    assert.equal(new Set(tables).size, 7, tables.join(', '));
  });
  test('each is passed to p7_harden', () => {
    for (const t of tables) assert.match(ALL, new RegExp(`p7_harden\\('projects', '${t}'\\)|'${t}'\\]`), `${t} is not hardened`);
  });
  test('every history table has the append-only trigger (a raw edit or delete is refused)', () => {
    for (const t of tables.filter((x) => x !== 'p7b_archives')) {
      assert.match(ALL, new RegExp(`${t}_append_only|'${t}'.*append_only|foreach t in array array\\[[^\\]]*'${t}'`), `${t} is not append-only`);
    }
    assert.match(ARCHIVE, /create trigger p7b_archive_guard before insert or update or delete on projects\.p7b_archives/);
  });
  test('every foreign key to an org-scoped parent is guarded, client_account_id included', () => {
    for (const m of ALL.matchAll(/(?:^|\n)\s+(client_account_id|project_id|package_id|phase_seven_id|completion_record_id|archive_id|request_id|acceptance_id)\s+uuid[^\n]*references (projects|core)\.([a-z_0-9]+)/g)) {
      const table = [...ALL.matchAll(/create table if not exists projects\.(p7b_[a-z_]+)\s*\(([\s\S]*?)\n\);/g)].find((t) => (t[2] as string).includes(m[0].trim()));
      if (!table || m[3] === 'organizations') continue;
      assert.match(ALL, new RegExp(`p7_guard_fk\\('${table[1]}', '${m[1]}', '${m[2]}\\.${m[3]}'\\)`), `${table[1]}.${m[1]} -> ${m[2]}.${m[3]} is not tenancy-guarded`);
    }
    assert.match(PORTAL, /p7_guard_fk\('p7b_handover_access_log', 'client_account_id', 'core\.client_accounts'\)/);
    assert.match(PORTAL, /p7_guard_fk\('p7b_portal_requests', 'client_account_id', 'core\.client_accounts'\)/);
  });
  test('the new tables are named p7b_, so the Phase 7 verifier\'s count of 24 p7_ tables stays true', () => {
    for (const t of tables) assert.match(t, /^p7b_/);
  });
});

describe('the Orchestrator: the three edges, a decisions table, and a service-role-only door that mirrors the rules', () => {
  test('the roster pairs are the three Phase 7 edges and nothing else', () => {
    const block = ROUTING.match(/insert into ai\.agent_handoff_targets[\s\S]*?;/)?.[0] ?? '';
    const pairs = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((p) => `${p[1]}>${p[2]}`);
    assert.deepEqual(pairs, ['orchestrator>deployment_agent', 'orchestrator>release_qa', 'orchestrator>incident_recovery']);
  });
  test('the door is service role only: revoked from everyone else, granted to service_role, and checks the role inside', () => {
    const body = fn(ROUTING, 'record_phase_seven_routing');
    assert.match(body, /auth\.role\(\)\), ''\) <> 'service_role' then return query select 'not_authorized'/);
    assert.match(ROUTING, /revoke all on function projects\.record_phase_seven_routing\([^)]*\) from public, anon, authenticated;/);
    assert.match(ROUTING, /grant execute on function projects\.record_phase_seven_routing\([^)]*\) to service_role;/);
  });
  test('the database mirrors the routing rules: held when disabled, no edge no route, a live approval, an Admin rollback, the owner of the task', () => {
    const body = fn(ROUTING, 'record_phase_seven_routing');
    assert.match(body, /'agent_not_enabled'/);
    assert.match(body, /ai\.agent_handoff_targets t where t\.from_agent = 'orchestrator'/);
    assert.match(body, /projects\.p7_deployment_approved\(v_plan\)/);
    assert.match(body, /p7_rollback_decisions r join projects\.p7_incidents i[\s\S]*r\.decision = 'approve'/);
    assert.match(body, /'wrong_agent_for_task'/);
    assert.match(body, /'handled_by_events_not_handoff'/);
    assert.match(body, /projects\.p7_has_secret\(p_reason\)/);
  });
  test('the organization is the job\'s: the door checks the project belongs to the organization it was handed', () => {
    assert.match(fn(ROUTING, 'record_phase_seven_routing'), /s\.project_id = p_project_id and s\.organization_id = p_organization_id/);
  });
});

describe('archive and retention: states, a person-set policy, a scoped freeze, and nothing is deleted', () => {
  test('ARCHIVING and ARCHIVED are a separate column; phase_seven.state and its check are NOT widened or rewritten', () => {
    assert.match(ARCHIVE, /alter table projects\.phase_seven add column if not exists archive_state text check \(archive_state in \('archiving', 'archived'\)\)/);
    assert.ok(!/phase_seven_state_check|drop constraint[^;]*state/.test(ARCHIVE), 'the state constraint is not touched');
    assert.ok(!/create or replace function projects\.(phase_seven_guard|p7_set_state)/.test(ARCHIVE), 'the guards that refuse work on a completed project are not rewritten');
  });
  test('a policy is a period or indefinite, never both and never neither, and the portal class alone says read-only', () => {
    assert.match(ARCHIVE, /check \(indefinite = \(retention_days is null\)\)/);
    assert.match(ARCHIVE, /check \(\(record_class = 'client_portal_access'\) = \(portal_read_only is not null\)\)/);
  });
  test('the system holds no default period: starting an archive needs a policy for every class a person set', () => {
    const body = fn(ARCHIVE, 'start_project_archive');
    assert.match(body, /'no_retention_policy'/);
    assert.match(body, /core\.is_admin\(\)/);
    assert.match(body, /p7_completion_records r where r\.project_id = p_project_id/);
    assert.ok(!/default \d+ days|interval '\d+ (days|years)'/.test(ARCHIVE), 'no duration is invented');
  });
  test('the freeze is a trigger on the five scope tables, keyed on an archive row (a legacy or merely completed project is untouched)', () => {
    assert.match(ARCHIVE, /foreach t in array array\['tasks', 'modules', 'features', 'deliverables', 'deliverable_details'\]/);
    assert.match(fn(ARCHIVE, 'p7b_archive_freeze'), /exists \(select 1 from projects\.p7b_archives a where a\.project_id = v_project\)/);
  });
  test('NOTHING is deleted: no archive, retention or sweep function contains a DELETE statement, and the sweep inserts only review markers', () => {
    for (const name of ['start_project_archive', 'finish_project_archive', 'set_retention_policy', 'sweep_retention_reviews', 'client_completed_state']) {
      assert.ok(!/delete\s+from/i.test(fn(ARCHIVE, name)), `${name} deletes`);
    }
    const sweep = fn(ARCHIVE, 'sweep_retention_reviews');
    assert.match(sweep, /insert into projects\.p7b_retention_reviews/);
    assert.match(sweep, /auth\.role\(\)\), ''\) <> 'service_role'/);
    assert.match(ARCHIVE, /revoke all on function projects\.sweep_retention_reviews\(timestamptz\) from public, anon, authenticated;/);
    assert.match(ARCHIVE, /check \(status = 'eligible_for_review'\)/);
  });
  test('the client-safe completed state exposes the lifecycle, the accepted version and the dates: no policy reason, evidence or person', () => {
    const body = fn(ARCHIVE, 'client_completed_state');
    assert.match(body, /returns table \(lifecycle text, portal_access text, completed_at timestamptz, archived_at timestamptz, accepted_version int, accepted_at timestamptz\)/);
    assert.match(body, /core\.current_client_account_id\(\)/);
  });
});

describe('the client handover surface: a request, never an acceptance; safe reads; a logged access', () => {
  test('the client-safe reads expose no evidence reference, note, reason, review, feedback or person', () => {
    for (const name of ['client_handover_overview', 'client_handover_items', 'client_handover_access_receipts']) {
      const head = fn(PORTAL, name).slice(0, fn(PORTAL, name).indexOf('language plpgsql'));
      assert.ok(!/(evidence|note|reason|review|feedback|_by\b|secret)/i.test(head), `${name} returns something internal: ${head}`);
    }
  });
  test('only the DELIVERED version and only READY items reach the client', () => {
    assert.match(fn(PORTAL, 'client_handover_overview'), /k\.status = 'delivered'/);
    assert.match(fn(PORTAL, 'client_handover_items'), /i\.status = 'ready'/);
    assert.match(fn(PORTAL, 'client_handover_items'), /k\.status = 'delivered'/);
  });
  test('the read gate is one definition: a client sees only its own account\'s project, and an expired portal reads nothing', () => {
    assert.match(fn(PORTAL, 'p7b_portal_project'), /v_p\.client_account_id is distinct from \(select core\.current_client_account_id\(\)\) then return null/);
    assert.match(fn(PORTAL, 'client_handover_overview'), /v_access = 'expired' then return/);
    for (const name of ['client_handover_items', 'client_handover_access_receipts']) assert.match(fn(PORTAL, name), /p7b_portal_access\(p_project_id\) = 'expired'/);
  });
  test('a portal click is NOT an acceptance: the request door never writes an acceptance, the settle door records one only through the existing door, with the person\'s verification', () => {
    const request = fn(PORTAL, 'request_handover_acceptance');
    assert.ok(!/p7_client_acceptances/.test(request) && !/record_client_acceptance/.test(request), 'the request door touches no acceptance');
    assert.match(request, /insert into projects\.p7b_portal_requests/);
    const settle = fn(PORTAL, 'settle_portal_handover_request');
    assert.match(settle, /projects\.record_client_acceptance\(v_r\.package_id,/);
    assert.match(settle, /'portal_confirmation'/);
    assert.match(settle, /core\.can_manage_delivery\(\)/);
    assert.match(settle, /length\(btrim\(p_verification\)\) < 10 then return query select 'verification_required'/);
    assert.match(settle, /'already_settled'/);
  });
  test('the request door is for a client only, refuses a read-only or expired portal, a completed project, a stale version and a secret', () => {
    const request = fn(PORTAL, 'request_handover_acceptance');
    assert.match(request, /core\.is_client\(\)/);
    assert.match(request, /p7b_portal_access\(v_pkg\.project_id\) <> 'open' then return query select 'portal_read_only'/);
    assert.match(request, /'project_completed'/);
    assert.match(request, /'package_superseded'/);
    assert.match(request, /projects\.p7_has_secret\(p_note\)/);
  });
  test('the access log is the client\'s: only a client, only a delivered item, append-only', () => {
    const log = fn(PORTAL, 'log_handover_access');
    assert.match(log, /core\.is_client\(\)/);
    assert.match(log, /i\.status = 'ready'/);
    assert.match(PORTAL, /p7b_handover_access_log_append_only|'p7b_handover_access_log', 'p7b_portal_requests', 'p7b_portal_request_settlements'/);
  });
  test('no portal or archive door is granted to anon or public, and the settle and request doors are not executable by the service role', () => {
    for (const name of ['request_handover_acceptance', 'log_handover_access', 'settle_portal_handover_request']) {
      assert.match(PORTAL, new RegExp(`revoke all on function projects\\.${name}\\([^)]*\\) from public, anon, service_role;`), name);
      assert.match(PORTAL, new RegExp(`grant execute on function projects\\.${name}\\([^)]*\\) to authenticated;`), name);
    }
  });
});

describe('the wiring is real: catalog, runner, handlers', () => {
  test('both handlers are registered with a job kind', () => {
    for (const h of ['projects:fillPhaseEightIntake', 'projects:routePhaseSevenTask'] as const) {
      assert.ok((HANDLERS as readonly string[]).includes(h), h);
      assert.ok(HANDLER_JOB_KIND[h], h);
    }
  });
  test('the completion event fills Phase 8\'s intake, and the Phase 7 events are routed', () => {
    assert.ok(SUBSCRIPTIONS['project.completed']?.includes('projects:fillPhaseEightIntake'));
    assert.ok(SUBSCRIPTIONS['project.completed']?.includes('crm:announceProjectCompleted'), 'the PM announcement is unchanged');
    for (const e of ['project.deployment_approved', 'project.deployment_failed', 'project.production_validation_failed']) assert.ok(SUBSCRIPTIONS[e]?.includes('projects:routePhaseSevenTask'), e);
  });
  test('the runner runs both, in the same envelope as every other event job', () => {
    const route = read('app/api/jobs/run/route.ts');
    assert.match(route, /runEventJobs\(admin, PHASE_EIGHT_INTAKE_JOB_KIND, handleFillPhaseEightIntake,/);
    assert.match(route, /runEventJobs\(admin, PHASE_SEVEN_ROUTE_JOB_KIND, handleRoutePhaseSevenTask,/);
    assert.match(route, /const PHASE_EIGHT_INTAKE_JOB_KIND = HANDLER_JOB_KIND\['projects:fillPhaseEightIntake'\]/);
  });
  test('the handlers read under the job organization and call only the named doors', () => {
    const h = read('src/modules/projects/phase-seven-handlers.ts');
    assert.match(h, /rpc\('fill_phase_eight_intake', \{ p_organization_id: job\.organization_id/);
    assert.match(h, /rpc\('record_phase_seven_routing', \{\s*p_organization_id: job\.organization_id/);
    assert.ok(!/rpc\('(start_phase_eight|decide_deployment_plan|record_deployment_progress|complete_phase_seven|record_client_acceptance)'/.test(h), 'a handler calls a decision door');
  });
});

describe('the UI: the client page cannot accept, and every read refuses on failure', () => {
  const PAGE = read('app/(client)/portal/[projectId]/handover/page.tsx');
  const ACTIONS = read('app/(client)/portal/[projectId]/handover/actions.ts');
  const SERVICE = read('src/modules/portal/handover-service.ts');
  test('no portal file calls the formal acceptance door or the settle door', () => {
    for (const src of [PAGE, ACTIONS, SERVICE, read('src/modules/portal/handover-queries.ts')]) {
      assert.ok(!/record_client_acceptance|settle_portal_handover_request/.test(src));
    }
    assert.match(SERVICE, /request_handover_acceptance/);
    assert.match(PAGE, /Nothing\s+is accepted until they have/);
  });
  test('the receipts show no reference value: the page renders no evidence field', () => {
    assert.ok(!/evidence/i.test(PAGE.replace(/\/\*[\s\S]*?\*\//g, '')));
  });
  test('the actions file is a use-server module that exports only async functions', () => {
    assert.match(ACTIONS, /^'use server';/);
    const exports = [...ACTIONS.matchAll(/^export (.*)$/gm)].map((m) => m[1] as string);
    assert.ok(exports.length >= 2);
    for (const e of exports) assert.match(e, /^async function /, e);
  });
  test('the open action follows the reference the database function returned, never one the form supplied, and logs first', () => {
    assert.match(ACTIONS, /readClientHandoverItems\(projectId\)/);
    assert.ok(ACTIONS.indexOf("logHandoverAccess(packageId, 'item_opened', kind)") < ACTIONS.indexOf('redirect(ref)'));
    assert.ok(!/formData\.get\('(url|ref|artifactRef)'\)/.test(ACTIONS));
  });
  test('every read guards its error with unreadable (the count of guards equals the count of refusals)', () => {
    for (const p of ['src/modules/portal/handover-queries.ts', 'src/modules/projects/phase-seven-b-queries.ts']) {
      const src = read(p);
      const guards = (src.match(/if \((?:[a-zA-Z.]*)error\)/g) ?? []).length;
      const refusals = (src.match(/unreadable\(/g) ?? []).length;
      assert.ok(guards > 0 && guards === refusals, `${p}: ${guards} guards, ${refusals} refusals`);
    }
  });
  test('the staff actions are a whitelist of doors and expose no delete', () => {
    const a = read('src/modules/projects/phase-seven-b-actions.ts');
    for (const rpc of ['settle_portal_handover_request', 'set_retention_policy', 'start_project_archive', 'finish_project_archive']) assert.match(a, new RegExp(`rpc: '${rpc}'`));
    assert.ok(!/\bdelete\b/i.test(a.replace(/[^\n]*\* [^\n]*/g, '')), 'a delete door');
  });
});

describe('the verifier: one transaction, rolled back, with the fixtures on top-level statements', () => {
  const V = read('scripts/verify-phase-seven-b.sql');
  test('begins, rolls back and ends with its OK line', () => {
    assert.match(V, /^begin;/m);
    assert.match(V, /\nrollback;\n/);
    assert.match(V.trimEnd(), /\\echo Phase 7b [^\n]* - OK$/);
  });
  test('a non-superuser CI database can run it: no session_replication_role is set from inside a function', () => {
    assert.ok(!/set_config\('session_replication_role'/.test(V));
    assert.match(V, /^set local session_replication_role = replica;$/m);
  });
});
