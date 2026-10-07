import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_JOB_KIND, HANDLERS, SUBSCRIPTIONS } from '../src/lib/events/catalog.ts';

/**
 * Phase 7c / 8A completions, structure: the properties scripts/verify-phase-seven-c.sql proves against a real Postgres (and scripts/redproof/phase-seven-c.py
 * mutates away one by one) are also pinned against the TEXT of the migrations, the wiring and the UI, so a refactor that quietly drops a control is a red test
 * even where no database is reachable. A regex cannot say a migration works; only the live run does. These say a control is still written, and several say a
 * thing is ABSENT where its positive twin is asserted beside it.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(`${root}${p}`, 'utf8');
const MIGRATIONS = readdirSync(`${root}supabase/migrations`).filter((f) => /^20261112\d{6}_.*\.sql$/.test(f)).sort();
const byPrefix = (prefix: string) => read(`supabase/migrations/${MIGRATIONS.find((f) => f.startsWith(prefix)) ?? 'missing'}`);
const SWEEPS = byPrefix('20261112000000');
const ACTIONS = byPrefix('20261112100000');
const QUEUE = byPrefix('20261112200000');
const ALL = [SWEEPS, ACTIONS, QUEUE].join('\n');
const NOCOMMENTS = ALL.replace(/^\s*--.*$/gm, '');
/** One function of a migration: split at the declaration that follows, never an open-ended slice from a marker. */
const fn = (sql: string, name: string): string => {
  const chunk = sql.split('create or replace function ').find((c) => c.startsWith(`projects.${name}(`));
  assert.ok(chunk, `projects.${name} is not defined`);
  return chunk.slice(0, chunk.indexOf('end $$;') > 0 ? chunk.indexOf('end $$;') + 7 : chunk.indexOf('$$;', chunk.indexOf('$$') + 2) + 3);
};

const SERVICE_ONLY = ['sweep_phase_eight_health', 'sweep_checkins_due', 'open_support_ticket_from_message', 'sweep_message_support_tickets', 'create_draft_handover_package_for_validated', 'sweep_draft_handover_packages'];
const CLIENT_DOORS = ['resolve_client_action_request', 'client_action_requests_for_client', 'client_financial_statement', 'client_financial_statement_payments', 'client_financial_statement_totals'];
const STAFF_DOORS = ['create_client_action_request', 'settle_client_action_request'];
const TABLES = ['cs_check_in_due_notices', 'p7c_client_action_requests', 'p7c_client_action_events'];

describe('the migrations live in the Phase 7c range and in order', () => {
  test('three migrations, 20261112000000 to 20261112200000', () => {
    assert.deepEqual(MIGRATIONS.map((m) => m.slice(0, 14)), ['20261112000000', '20261112100000', '20261112200000']);
  });
  test('none of them sets a session parameter, which a non-superuser migration role cannot do', () => {
    assert.doesNotMatch(NOCOMMENTS, /session_replication_role/);
    assert.doesNotMatch(NOCOMMENTS, /alter (role|database|system)\b/i);
  });
});

describe('the service-role doors check the role inside, are not granted to a person, and pin the search path', () => {
  for (const name of SERVICE_ONLY) {
    test(name, () => {
      const sql = [SWEEPS, QUEUE].find((s) => s.includes(`function projects.${name}(`)) ?? '';
      const body = fn(sql, name);
      assert.match(body, /coalesce\(\(select auth\.role\(\)\), ''\) <> 'service_role'/, 'the role is checked inside');
      assert.match(body, /security definer set search_path = ''/);
      assert.match(sql, new RegExp(`revoke all on function projects\\.${name}\\([^)]*\\) from public, anon, authenticated;`));
      assert.match(sql, new RegExp(`grant execute on function projects\\.${name}\\([^)]*\\) to service_role;`));
      assert.doesNotMatch(sql, new RegExp(`grant execute on function projects\\.${name}\\([^)]*\\) to [^;]*(authenticated|anon|public)`));
    });
  }
});

describe('the client-facing and staff doors', () => {
  for (const name of [...CLIENT_DOORS, ...STAFF_DOORS]) {
    test(`${name} is SECURITY DEFINER with an empty search path and is granted to signed-in people only`, () => {
      const sql = [ACTIONS, QUEUE].find((s) => s.includes(`function projects.${name}(`)) ?? '';
      assert.match(fn(sql, name), /security definer set search_path = ''/);
      assert.match(sql, new RegExp(`revoke all on function projects\\.${name}\\([^)]*\\) from public, anon, service_role;`));
      assert.match(sql, new RegExp(`grant execute on function projects\\.${name}\\([^)]*\\) to authenticated;`));
    });
  }
  test('a client reads and answers only its own account: the account claim and the portal guard are in every client function', () => {
    for (const [sql, name] of [[ACTIONS, 'resolve_client_action_request'], [ACTIONS, 'client_action_requests_for_client']] as const) {
      const body = fn(sql, name);
      assert.match(body, /core\.is_client\(\)/, name);
      assert.match(body, /p7b_portal_project\(/, name);
      assert.match(body, /current_client_account_id\(\)/, name);
    }
    for (const name of ['client_financial_statement', 'client_financial_statement_payments']) {
      const body = fn(QUEUE, name);
      assert.match(body, /v_acct uuid := projects\.p7c_statement_account\(\)/, name);
      assert.match(body, /i\.client_account_id = v_acct/, name);
      assert.match(body, /i\.organization_id = v_org/, name);
    }
    assert.match(fn(QUEUE, 'p7c_statement_account'), /core\.is_client\(\)/);
  });
  test('the client-safe request read exposes no internal column, and its positive twin is the note meant for the client', () => {
    const body = fn(ACTIONS, 'client_action_requests_for_client');
    assert.doesNotMatch(body.slice(body.indexOf('return query'), body.indexOf('order by r.due_at')), /confirmation_note|created_by|submission_note|submission_ref|submitted_by|cancel_reason|cancelled_by|confirmed_by/);
    assert.match(body, /r\.returned_note/);
    assert.match(body, /r\.status <> 'cancelled'/);
  });
  test('a client\'s answer is a CLAIM: the door sets submitted, never confirmed, and a person confirms', () => {
    const answer = fn(ACTIONS, 'resolve_client_action_request');
    assert.match(answer, /set status = 'submitted'/);
    assert.doesNotMatch(answer, /status = 'confirmed'|confirmed_by|confirmed_at/);
    const settle = fn(ACTIONS, 'settle_client_action_request');
    assert.match(settle, /can_manage_delivery\(\)/);
    assert.match(settle, /'verification_required'/);
  });
  test('the statement states facts and writes nothing: no insert, update, delete or trigger in any statement function', () => {
    for (const name of ['client_financial_statement', 'client_financial_statement_payments', 'client_financial_statement_totals', 'p7c_statement_account', 'p7_failure_queue']) {
      assert.doesNotMatch(fn(QUEUE, name), /\b(insert into|update |delete from)\b/i, name);
    }
    assert.doesNotMatch(NOCOMMENTS, /create trigger[^;]*on finance\./i);
  });
  test('the statement counts only money a person verified, hides drafts, and excludes void from what is owed', () => {
    const stmt = fn(QUEUE, 'client_financial_statement');
    assert.match(stmt, /i\.status not in \('draft', 'pending_approval'\)/);
    assert.match(stmt, /i\.total_minor - i\.verified_minor/);
    assert.match(stmt, /case when i\.status = 'void' then 0/);
    assert.match(fn(QUEUE, 'client_financial_statement_payments'), /y\.status = 'captured' and y\.verified_at is not null/);
  });
});

describe('the new tables are tenancy-guarded, RLS-on, internal-read and door-written', () => {
  test('each is hardened (RLS, internal-only read, no write grant, frozen organization)', () => {
    for (const t of TABLES) assert.match(ALL, new RegExp(`select projects\\.p7_harden\\('projects', '${t}'\\);`), t);
  });
  test('every foreign key to an organization-scoped table is guarded, client_account_id included', () => {
    assert.match(ALL, /p7_guard_fk\('p7c_client_action_requests', 'client_account_id', 'core\.client_accounts'\)/);
    assert.match(ALL, /p7_guard_fk\('p7c_client_action_requests', 'project_id', 'projects\.projects'\)/);
    assert.match(ALL, /p7_guard_fk\('p7c_client_action_events', 'request_id', 'projects\.p7c_client_action_requests'\)/);
    assert.match(ALL, /p7_guard_fk\('cs_check_in_due_notices', 'project_id', 'projects\.projects'\)/);
    assert.match(ALL, /p7_guard_fk\('cs_check_in_due_notices', 'check_in_id', 'projects\.cs_check_ins'\)/);
  });
  test('the request table is written only by a door; the event and notice tables are history', () => {
    assert.match(ALL, /create trigger p7c_client_action_requests_door_only before insert or update or delete on projects\.p7c_client_action_requests for each row execute function projects\.p7_door_only\(\)/);
    assert.match(ALL, /create trigger p7c_client_action_events_append_only before insert or update or delete on projects\.p7c_client_action_events for each row execute function projects\.p7_append_only\(\)/);
    assert.match(ALL, /create trigger cs_check_in_due_notices_append_only before update or delete on projects\.cs_check_in_due_notices for each row execute function projects\.p8_append_only\(\)/);
    assert.match(ALL, /create trigger p7c_client_action_requests_identity before update on projects\.p7c_client_action_requests/);
  });
  test('the table CHECKs hold the evidence rules at the table, not only at the door', () => {
    assert.match(ACTIONS, /constraint p7c_car_confirmed_is_verified check \(\(status = 'confirmed'\) = \(confirmed_by is not null/);
    assert.match(ACTIONS, /constraint p7c_car_submitted_is_evidenced/);
    assert.match(ACTIONS, /constraint p7c_car_cancelled_says_why/);
    assert.match(ACTIONS, /not projects\.p7_has_secret\(instructions\)/);
    assert.match(SWEEPS, /check_in_id\s+uuid not null unique references projects\.cs_check_ins\(id\)/);
  });
  test('a live request is unique per project, kind and title', () => {
    assert.match(ACTIONS, /create unique index if not exists p7c_car_one_live on projects\.p7c_client_action_requests \(project_id, kind, lower\(btrim\(title\)\)\) where status in \('open', 'submitted'\)/);
  });
});

describe('nothing here sends, delivers or decides for a person', () => {
  test('the automatic draft door creates a draft only: no submit, approve, deliver or acceptance, and no created_by', () => {
    const body = fn(QUEUE, 'create_draft_handover_package_for_validated');
    assert.doesNotMatch(body, /update projects\.p7_handover_packages|status\s*=\s*'(admin_review|approved|delivered)'|delivered_by|admin_approved|record_client_acceptance|deliver_handover_package|submit_handover_for_review/);
    assert.match(body, /insert into projects\.p7_handover_packages \(organization_id, project_id, phase_seven_id, version, deployment_id, validation_run_id, candidate_id, commit_ref, artifact_sha256\)/);
    assert.match(body, /p7_production_validation\(v_s\.project_id\)/);
    assert.match(body, /m4_verified_paid\(v_s\.project_id\)/);
    assert.match(body, /p7_contract_deliverables/);
  });
  test('the message door opens a ticket and replies to no one: it writes no message and calls no sender', () => {
    const body = fn(SWEEPS, 'open_support_ticket_from_message');
    assert.doesNotMatch(body, /insert into crm\.|send_outbound|conversation_messages \(/);
    assert.match(body, /projects\.open_support_ticket\(/);
    assert.match(body, /v_m\.intent <> 'support_request'/);
    assert.match(body, /v_c\.kind <> 'project_group'/);
    assert.match(body, /v_w\.state <> 'active'/);
    assert.match(body, /v_m\.author_type <> 'client'/);
  });
  test('the check-in sweep notices and contacts nobody: it writes the notice and an event, and never completes, skips or sends', () => {
    const body = fn(SWEEPS, 'sweep_checkins_due');
    assert.match(body, /insert into projects\.cs_check_in_due_notices/);
    assert.doesNotMatch(body, /update projects\.cs_check_ins|complete_check_in|skip_check_in|send|outbound/i);
    assert.match(body, /check_in_eligibility\(/);
  });
  test('the health sweep goes through the existing snapshot door and reads only active workspaces', () => {
    const body = fn(SWEEPS, 'sweep_phase_eight_health');
    assert.match(body, /record_health_snapshot\(r\.project_id, 'scheduled', r\.organization_id, p_now\)/);
    assert.match(body, /w\.state = 'active'/);
    assert.doesNotMatch(body, /insert into projects\.customer_health_snapshots/);
  });
});

describe('the wiring is real: catalog, runner, sweep', () => {
  test('both handlers are registered with a job kind', () => {
    for (const h of ['projects:openSupportTicketFromMessage', 'projects:createDraftHandoverPackage'] as const) {
      assert.ok((HANDLERS as readonly string[]).includes(h), h);
      assert.ok(HANDLER_JOB_KIND[h], h);
    }
    assert.equal(HANDLER_JOB_KIND['projects:openSupportTicketFromMessage'], 'support_ticket.open_from_message');
    assert.equal(HANDLER_JOB_KIND['projects:createDraftHandoverPackage'], 'handover.create_draft');
  });
  test('a client message opens a ticket, and a validated production gets its draft, beside the existing subscribers', () => {
    assert.ok(SUBSCRIPTIONS['message.received']?.includes('projects:openSupportTicketFromMessage'));
    assert.ok(SUBSCRIPTIONS['message.received']?.includes('sales:readIntent'), 'the intent reader is unchanged');
    assert.ok(SUBSCRIPTIONS['project.production_validated']?.includes('projects:createDraftHandoverPackage'));
    assert.ok(SUBSCRIPTIONS['project.production_validated']?.includes('crm:announceProductionValidated'), 'the PM announcement is unchanged');
  });
  test('the runner runs both in the same envelope as every other event job, and the tick calls the sweep once after the cron secret is checked', () => {
    const route = read('app/api/jobs/run/route.ts');
    assert.match(route, /runEventJobs\(admin, SUPPORT_FROM_MESSAGE_JOB_KIND, handleOpenSupportTicketFromMessage,/);
    assert.match(route, /runEventJobs\(admin, DRAFT_HANDOVER_JOB_KIND, handleCreateDraftHandoverPackage,/);
    assert.match(route, /const SUPPORT_FROM_MESSAGE_JOB_KIND = HANDLER_JOB_KIND\['projects:openSupportTicketFromMessage'\]/);
    assert.match(route, /const DRAFT_HANDOVER_JOB_KIND = HANDLER_JOB_KIND\['projects:createDraftHandoverPackage'\]/);
    assert.equal(route.split('await sweepSupportAndHealth(admin);').length - 1, 1);
    const auth = route.indexOf('authorizeCronRequest(request.headers.get');
    const sibling = route.indexOf('await sweepMaintenanceLifecycle(admin);');
    const mine = route.indexOf('await sweepSupportAndHealth(admin);');
    assert.ok(auth > 0 && sibling > auth && mine > sibling);
  });
  test('the handlers read under the job organization and call only the named doors', () => {
    const h = read('src/modules/projects/phase-seven-handlers.ts');
    assert.match(h, /rpc\('open_support_ticket_from_message', \{ p_organization_id: job\.organization_id/);
    assert.match(h, /rpc\('create_draft_handover_package_for_validated', \{ p_organization_id: job\.organization_id/);
    assert.ok(!/rpc\('(submit_handover_for_review|decide_handover_package|deliver_handover_package|record_client_acceptance|classify_support_ticket|send_outbound_message)'/.test(h), 'a handler calls a decision or sending door');
  });
  test('the sweep names the five doors, none of which sends', () => {
    const src = read('src/modules/orchestrator/sweeps.ts');
    const body = src.match(/export async function sweepSupportAndHealth[\s\S]*?\n}\n/)?.[0] ?? '';
    for (const d of ['sweep_support_sla', 'sweep_phase_eight_health', 'sweep_checkins_due', 'sweep_message_support_tickets', 'sweep_draft_handover_packages']) assert.match(body, new RegExp(`name: '${d}'`), d);
    assert.doesNotMatch(body, /send|reply|deliver/i);
  });
});

describe('the UI reads through the safe functions and every read refuses on failure', () => {
  const QUEUES = read('src/modules/projects/phase-seven-c-queries.ts');
  const CLIENTQ = read('src/modules/portal/client-action-queries.ts');
  const ACTIONS_TS = read('src/modules/projects/phase-seven-c-actions.ts');
  const PORTAL_ACTIONS = read('app/(client)/portal/[projectId]/actions/actions.ts');
  test('each read has its own unreadable() guard, and no comment names one', () => {
    for (const [name, src] of [['phase-seven-c-queries', QUEUES], ['client-action-queries', CLIENTQ]] as const) {
      const guards = (src.match(/if \(\w+(\.error)?\) unreadable\(/g) ?? []).length;
      assert.ok(guards >= 2, name);
      assert.equal((src.match(/unreadable\(/g) ?? []).length, guards, `${name}: no stray call and no mention in a comment`);
    }
  });
  test('the portal reads only through database functions: no table is read from a client page', () => {
    assert.doesNotMatch(CLIENTQ, /\.from\(/);
    for (const page of ['app/(client)/portal/[projectId]/actions/page.tsx', 'app/(client)/portal/[projectId]/statement/page.tsx']) {
      const src = read(page);
      assert.match(src, /requireClient\(\)/, page);
      assert.doesNotMatch(src, /\.from\(|createClient|createAdminClient/, page);
    }
  });
  test('the client\'s page cannot confirm anything: it offers an answer only, and says a person confirms', () => {
    const page = read('app/(client)/portal/[projectId]/actions/page.tsx');
    assert.match(page, /confirm/i);
    assert.doesNotMatch(page, /settle_client_action|confirmed_by|decision/);
    assert.match(PORTAL_ACTIONS, /resolveClientActionRequest\(/);
    assert.doesNotMatch(PORTAL_ACTIONS, /settle/);
  });
  test('the statement page changes nothing: no form, no action, no write', () => {
    const page = read('app/(client)/portal/[projectId]/statement/page.tsx');
    assert.doesNotMatch(page, /<form|action=|use server|rpc\(/);
  });
  test('use-server files export only async functions', () => {
    for (const src of [ACTIONS_TS, PORTAL_ACTIONS]) {
      assert.match(src, /^'use server';/);
      const exports = [...src.matchAll(/^export (?!async function)(.*)$/gm)].map((m) => m[0]);
      assert.deepEqual(exports, []);
    }
  });
  test('the Admin action is a whitelist of exactly the two staff doors', () => {
    assert.match(ACTIONS_TS, /rpc: 'create_client_action_request'/);
    assert.match(ACTIONS_TS, /rpc: 'settle_client_action_request'/);
    assert.equal((ACTIONS_TS.match(/rpc: '/g) ?? []).length, 2);
    assert.match(ACTIONS_TS, /can\(context, 'project\.write'\)/);
    assert.match(ACTIONS_TS, /Object\.prototype\.hasOwnProperty\.call\(DOORS, name\)/);
  });
  test('the internal panel and the standalone page exist and use unique keys', () => {
    const panel = read('app/(internal)/projects/[projectId]/phase-seven-c-panel.tsx');
    assert.match(panel, /export function PhaseSevenCPanel/);
    assert.match(panel, /key=\{`\$\{f\.kind\}:\$\{f\.subjectId\}`\}/);
    assert.match(read('app/(internal)/operations/phase-seven-failures/page.tsx'), /requireInternal\(\)/);
  });
});
