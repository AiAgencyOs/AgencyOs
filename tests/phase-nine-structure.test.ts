import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { AGENT_DEFINITIONS } from '../src/modules/agents/registry.ts';

/**
 * Phase 9 structural facts about the migrations, the verifier and the files around them. These pin SHAPE; the BEHAVIOUR is proved by driving the doors
 * on a real Postgres (scripts/verify-phase-nine.sql, every control red-proved by mutating its live definition). A regex can say a string is present; only
 * Postgres can say the file is a program - so none of this stands in for that.
 */

const root = new URL('../', import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
const migrationFiles = readdirSync(new URL('supabase/migrations', root)).filter((f) => /^20261106/.test(f)).sort();
const migrations = migrationFiles.map((f) => ({ file: f, sql: read(`supabase/migrations/${f}`) }));
const all = migrations.map((m) => m.sql).join('\n');
/** SQL without line comments, so a comment may name what the code does not do. */
const bare = (s: string) => s.replace(/^\s*--.*$/gm, '');
const allBare = bare(all);

/** The text of ONE function definition: from its start to the next definition (or the end). A bounded region, never an open-ended slice. */
function fnText(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}`);
  assert.ok(start >= 0, `${name} is defined`);
  const next = text.indexOf('create or replace function ', start + 10);
  return text.slice(start, next < 0 ? text.length : next);
}

const NEW_TABLES = [
  'finance_exceptions', 'waivers', 'financial_close_evaluations', 'close_exceptions', 'project_financial_closes', 'period_closes',
  'finance_agent_requests', 'finance_proposals', 'finance_proposal_decisions',
];
const HISTORY_TABLES = ['finance_exceptions', 'waivers', 'financial_close_evaluations', 'close_exceptions', 'project_financial_closes', 'period_closes', 'finance_agent_requests', 'finance_proposals', 'finance_proposal_decisions'];

describe('the migrations are where they must be', () => {
  test('five migrations, all inside the Phase 9 range, in dependency order', () => {
    assert.equal(migrationFiles.length, 5);
    for (const f of migrationFiles) {
      const v = Number(f.slice(0, 14));
      assert.ok(v >= 20261106000000 && v <= 20261106999999, f);
    }
    assert.deepEqual(migrationFiles.map((f) => f.slice(0, 14)), ['20261106100000', '20261106200000', '20261106300000', '20261106400000', '20261106500000']);
  });
  test('every new table exists once, org-scoped, with RLS on', () => {
    for (const t of NEW_TABLES) {
      assert.equal([...all.matchAll(new RegExp(`create table if not exists finance\\.${t} \\(`, 'g'))].length, 1, t);
    }
    // the RLS loops name every table (period_closes is written out by hand, below)
    for (const t of NEW_TABLES.filter((x) => x !== 'period_closes')) assert.match(all, new RegExp(`'${t}'`), `${t} is in a policy/grant loop`);
    assert.ok((all.match(/enable row level security/g) ?? []).length >= 3);
    for (const t of NEW_TABLES) {
      const from = all.indexOf(`create table if not exists finance.${t} (`);
      const body = all.slice(from, all.indexOf('\n);', from));
      assert.match(body, /organization_id\s+uuid not null references core\.organizations\(id\) on delete cascade/, `${t} is organization-scoped`);
    }
  });
  test('the read policy admits Finance and Admin only - a client, a member and another organization read nothing', () => {
    const matches = [...all.matchAll(/create policy %I on finance\.%I for select to authenticated using \(([^$]*)\)\$p\$/g)];
    assert.ok(matches.length >= 3, 'the generic loops create the policy');
    for (const m of matches) {
      assert.match(m[1]!, /organization_id = \(select core\.current_organization_id\(\)\)/);
      assert.match(m[1]!, /\(select core\.is_admin\(\)\) or \(select core\.is_finance\(\)\)/);
      assert.ok(!/is_client|is_internal/.test(m[1]!), 'neither the client nor the whole internal team');
    }
    const period = all.match(/create policy period_closes_select[\s\S]*?;/)?.[0] ?? '';
    assert.match(period, /is_admin\(\)\)\s+or \(select core\.is_finance\(\)\)/);
  });
  test('grants: nothing for public or anon, no insert/update/delete for authenticated, everything for the service role', () => {
    assert.ok((all.match(/revoke all on finance\.%I from public, anon/g) ?? []).length >= 3);
    assert.ok((all.match(/revoke insert, update, delete on finance\.%I from authenticated/g) ?? []).length >= 3);
    assert.ok((all.match(/grant select on finance\.%I to authenticated/g) ?? []).length >= 3);
    assert.ok((all.match(/grant all on finance\.%I to service_role/g) ?? []).length >= 3);
    assert.match(all, /revoke all on finance\.period_closes from public, anon;\s*\nrevoke insert, update, delete on finance\.period_closes from authenticated;\s*\ngrant select on finance\.period_closes to authenticated;\s*\ngrant all on finance\.period_closes to service_role;/);
  });
  test('every foreign key to an org-scoped table has a parent-organization trigger, and the organization is frozen', () => {
    for (const [tbl, col] of [
      ['finance_exceptions', 'project_id'], ['finance_exceptions', 'invoice_id'], ['finance_exceptions', 'submission_id'], ['waivers', 'invoice_id'], ['waivers', 'project_id'],
      ['financial_close_evaluations', 'project_id'], ['close_exceptions', 'project_id'], ['project_financial_closes', 'project_id'], ['project_financial_closes', 'evaluation_id'], ['project_financial_closes', 'close_exception_id'],
      ['finance_agent_requests', 'project_id'], ['finance_agent_requests', 'invoice_id'], ['finance_proposals', 'project_id'], ['finance_proposals', 'request_id'], ['finance_proposals', 'invoice_id'],
      ['finance_proposals', 'submission_id'], ['finance_proposal_decisions', 'proposal_id'],
    ] as const) {
      assert.match(all, new RegExp(`\\('${tbl}', '${col}', '[a-z_.]+'\\)`), `${tbl}.${col} has a parent-org trigger`);
    }
    assert.ok((all.match(/core\.enforce_parent_org/g) ?? []).length >= 3, 'one per migration that has foreign keys');
    assert.ok((all.match(/core\.freeze_organization_id/g) ?? []).length >= 4);
    assert.match(all, /create trigger freeze_org_period_closes before update of organization_id/);
  });
  test('history tables are append-only or guarded: a close, an evaluation, a period close, a request, a proposal and a decision are never edited', () => {
    for (const t of ['project_financial_closes', 'financial_close_evaluations', 'finance_agent_requests', 'finance_proposals', 'finance_proposal_decisions']) {
      assert.match(all, new RegExp(`'${t}'`));
    }
    assert.ok((all.match(/_append_only/g) ?? []).length >= 4);
    assert.match(all, /create trigger period_closes_append_only before update or delete on finance\.period_closes/);
    for (const g of ['finance_exceptions_guard', 'waivers_guard', 'close_exceptions_guard']) assert.match(all, new RegExp(`create trigger ${g} before update or delete`));
    assert.equal(HISTORY_TABLES.length, NEW_TABLES.length);
  });
});

describe('the doors', () => {
  const defs = [...allBare.matchAll(/create or replace function (finance\.[a-z0-9_]+)\(([\s\S]*?)\)\s*(?:returns|\n\s*returns)/g)].map((m) => m[1]!);
  test('every function is created with a pinned search_path', () => {
    const fns = allBare.split(/create or replace function /).slice(1);
    assert.ok(fns.length >= 25);
    for (const f of fns) {
      const head = f.slice(0, f.indexOf('$$'));
      assert.match(head, /set search_path = ''/, f.slice(0, 60));
    }
    assert.ok(defs.length >= 25);
  });
  test('the person doors are SECURITY DEFINER with explicit grants; the runner doors are service-role only', () => {
    for (const person of ['open_finance_exception', 'resolve_finance_exception', 'request_waiver', 'decide_waiver', 'evaluate_project_close', 'request_close_exception', 'decide_close_exception', 'close_project_finances',
      'close_period', 'period_close_preview', 'request_finance_agent_run', 'accept_finance_proposal', 'reject_finance_proposal', 'project_close_position']) {
      assert.match(allBare, new RegExp(`create or replace function finance\\.${person}\\([\\s\\S]*?security definer`), `${person} is security definer`);
      assert.match(allBare, new RegExp(`revoke all on function finance\\.${person}\\([^)]*\\) from public, anon`), `${person} is revoked from public/anon`);
      assert.match(allBare, new RegExp(`grant execute on function finance\\.${person}\\([^)]*\\) to authenticated`), `${person} is granted to authenticated`);
    }
    for (const runner of ['sweep_finance_exceptions', 'record_finance_proposal', 'phase9_compute_position', 'phase9_period_position', 'phase9_invoice_rows', 'invoice_outstanding_minor', 'invoice_waived_minor']) {
      assert.match(allBare, new RegExp(`revoke all on function finance\\.${runner}\\([^)]*\\) from public, anon, authenticated`), `${runner} is revoked from authenticated`);
      assert.match(allBare, new RegExp(`grant execute on function finance\\.${runner}\\([^)]*\\) to service_role`), `${runner} is granted to the service role`);
    }
  });
  test('the service-only doors check the role INSIDE as well as in the grant', () => {
    const proposal = fnText(allBare, 'finance.record_finance_proposal');
    assert.match(proposal.slice(0, 1500), /if \(select auth\.uid\(\)\) is not null or coalesce\(\(select auth\.role\(\)\), ''\) <> 'service_role' then return query select 'not_authorized'/);
    const sweep = fnText(allBare, 'finance.sweep_finance_exceptions');
    assert.match(sweep.slice(0, 800), /if \(select auth\.uid\(\)\) is not null or coalesce\(\(select auth\.role\(\)\), ''\) <> 'service_role'/);
  });
  test('closing a project is a person\'s act: the runner is refused', () => {
    const close = fnText(allBare, 'finance.close_project_finances');
    assert.match(close.slice(0, 1200), /if v_kind not in \('admin', 'finance'\) then return query select 'not_authorized'/);
  });
  test('separation of duties is in the database: three CHECKs and the door refusals', () => {
    assert.match(allBare, /check \(decided_by is null or decided_by <> requested_by\)/g);
    assert.equal([...allBare.matchAll(/check \(decided_by is null or decided_by <> requested_by\)/g)].length, 2, 'a waiver and a close exception');
    assert.match(allBare, /if v_w\.requested_by = v_actor then return query select 'self_approval'/);
    assert.match(allBare, /if v_e\.requested_by = v_actor then return query select 'self_approval'/);
    assert.match(allBare, /v_e\.blocking and v_e\.opened_by is not null and v_e\.opened_by = v_actor then return query select 'self_resolution'/);
    assert.match(allBare, /if v_p\.requested_by = v_actor then return query select 'self_acceptance'/g);
    assert.equal([...allBare.matchAll(/if v_p\.requested_by = v_actor then return query select 'self_acceptance'/g)].length, 2, 'accept and reject');
  });
  test('a waiver is decided by an Admin only, and a chargeback is settled by an Admin only', () => {
    assert.match(allBare, /create or replace function finance\.decide_waiver[\s\S]*?if v_kind <> 'admin' then return query select 'not_authorized'/);
    assert.match(allBare, /v_e\.kind = 'chargeback' and v_kind <> 'admin' then return query select 'admin_only'/);
    assert.match(allBare, /check \(kind not in \('chargeback', 'overpayment'\) or blocking\)/);
  });
  test('unverified money is never revenue: collected counts only verified captured payments, and unverified is its own blocker', () => {
    const rows = fnText(allBare, 'finance.phase9_invoice_rows');
    assert.match(rows.slice(0, 2500), /p\.status = 'captured' and p\.verified_at is not null\) c/);
    assert.match(rows.slice(0, 2500), /p\.verified_at is null\) u/);
    assert.match(allBare, /if v_unv > 0 then[\s\S]{0,200}'unverified_money'/);
    assert.match(allBare, /'payment_submission_unresolved'/);
  });
  test('outstanding is total - net VERIFIED - approved waivers, floored at zero; a waiver is not cash', () => {
    assert.match(allBare, /greatest\(i\.total_minor - greatest\(finance\.net_verified_minor\(i\.id\), 0\) - finance\.invoice_waived_minor\(i\.id\), 0\)/);
    assert.match(allBare, /waived value and unverified money are not revenue/);
  });
  test('a close needs a zero balance or an approved exception that still covers it, and the project row is locked', () => {
    const close = fnText(allBare, 'finance.close_project_finances');
    assert.match(close, /for update;/);
    assert.match(close, /perform 1 from finance\.invoices i where i\.project_id = p_project_id order by i\.id for update;/);
    assert.match(close, /x\.status = 'approved' and x\.outstanding_at_request_minor >= v_out/);
    assert.match(close, /if v_result = 'blocked' then return query select 'blocked'/);
    assert.match(close, /'balance_needs_an_approved_exception'/);
    assert.match(close, /core\.emit_event\(v_org, 'project\.financially_closed'/);
  });
  test('a closed project\'s plan is not reopened; a closed period\'s expenses are not changed (only for what entered the close)', () => {
    assert.match(allBare, /create trigger zz_phase9_closed_project_refuses_milestone_invoice before insert on finance\.invoices/);
    assert.match(allBare, /create trigger zz_phase9_closed_project_refuses_plan_change before insert or update or delete on projects\.milestones/);
    assert.match(allBare, /create trigger zz_phase9_closed_period_refuses_expense_change before insert or update or delete on finance\.expenses/);
    assert.match(allBare, /exists \(select 1 from finance\.project_financial_closes c where c\.project_id = new\.project_id\)/);
  });
  test('the period close lists exceptions and requires the acknowledgement, in the door and in a CHECK', () => {
    assert.match(allBare, /check \(jsonb_array_length\(exceptions\) = 0 or acknowledgement is not null\)/);
    assert.match(allBare, /if jsonb_array_length\(v_ex\) > 0 and v_ack is null then return query select 'exceptions_not_acknowledged'/);
    assert.match(allBare, /pg_advisory_xact_lock\(hashtextextended\('finance\.period_close:'/);
  });
  test('the period is UTC-explicit, like the existing period report', () => {
    assert.match(allBare, /p_start::timestamp at time zone 'UTC'/);
  });
});

describe('what Phase 9 does NOT do to money', () => {
  test('no migration defines, replaces or calls the verification, refund or invoice-edit doors', () => {
    for (const forbidden of ['finance.verify_payment', 'finance.verify_payment_submission', 'finance.record_refund', 'finance.request_refund', 'finance.record_manual_payment', 'finance.issue_invoice', 'finance.void_invoice', 'finance.create_milestone_invoice']) {
      assert.ok(!allBare.includes(forbidden), `${forbidden} is not touched`);
    }
  });
  test('no migration writes an invoice, a payment or a refund row', () => {
    assert.ok(!/(insert into|update|delete from) finance\.(invoices|payments|refunds|receipts|payment_submissions)\b/i.test(allBare), 'no write to the money tables');
  });
  test('the only legacy function redefined is the reminder candidate list, and only to drop a fully waived invoice', () => {
    const redefined = [...allBare.matchAll(/create or replace function ((?:finance|core|projects|ai|qa)\.[a-z0-9_]+)/g)].map((m) => m[1]!);
    const legacy = redefined.filter((n) => !/^finance\.(phase9_|invoice_outstanding|invoice_waived|open_finance|resolve_finance|sweep_finance|request_waiver|decide_waiver|project_close_position|evaluate_project_close|request_close_exception|decide_close_exception|close_project_finances|project_is_financially_closed|closed_project_|closed_period_|period_close|close_period|finance_exceptions_guard|waivers_guard|close_exceptions_guard|request_finance_agent_run|record_finance_proposal|accept_finance_proposal|reject_finance_proposal)/.test(n));
    assert.deepEqual(legacy, ['finance.observe_invoice_reminder_candidates']);
    assert.match(allBare, /and not \(finance\.invoice_waived_minor\(i\.id\) > 0 and finance\.invoice_outstanding_minor\(i\.id\) = 0\)/);
  });
  test('no new table has a column that could hold a verified payment or an amount edit for an existing invoice', () => {
    assert.ok(!/^\s+(verified_minor|paid_minor)\s+bigint/m.test(allBare), 'no copy of the invoice money columns');
  });
});

describe('the agents are installed disabled and mirrored', () => {
  const keys = ['finance_reconciliation', 'finance_communication', 'finance_close'];
  const agentsSql = migrations.find((m) => m.file.includes('finance_agents_are_installed_disabled'))!.sql;
  test('three rows, each enabled = false, with a reason, and the registry defines the same three', () => {
    for (const k of keys) {
      assert.match(agentsSql, new RegExp(`\\('${k}', '[^']+', '(?:[^']|'')+', 'L1', false, 'claude-sonnet-5'`), `${k} is installed disabled at L1`);
      const def = AGENT_DEFINITIONS.find((a) => a.key === k);
      assert.ok(def, `${k} is defined in the registry`);
      assert.equal(def!.layer, 'operations');
      assert.equal(def!.moneyAuthority, 'none');
      assert.equal(def!.clientFacing, false);
      assert.equal(def!.mayVerify, false);
      assert.deepEqual([...def!.tools], []);
      assert.deepEqual([...def!.handoffTargets], ['finance']);
      assert.equal(def!.verification.verifiedBy, 'quality_assurance');
      assert.match(k, /^[a-z_]+$/);
    }
    assert.ok(!/true, 'claude/.test(agentsSql), 'nothing here is enabled');
  });
  test('the handoff mirror carries exactly what the registry declares: back to finance and to nobody else', () => {
    const pairs = [...agentsSql.matchAll(/\('(finance_[a-z]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`);
    assert.deepEqual(pairs.filter((p) => p.endsWith('>finance')).sort(), keys.map((k) => `${k}>finance`).sort());
    assert.ok(!pairs.some((p) => !p.endsWith('>finance') && !p.endsWith('>quality_assurance')), pairs.join(', '));
    assert.match(agentsSql, /insert into ai\.agent_verifiers[\s\S]*'quality_assurance'/);
  });
  test('the existing finance agent definition is untouched: still proposes for approval, verifies nothing', () => {
    const f = AGENT_DEFINITIONS.find((a) => a.key === 'finance')!;
    assert.equal(f.moneyAuthority, 'proposes_for_approval');
    assert.equal(f.mayVerify, false);
    assert.deepEqual([...f.tools], ['memory.recall', 'finance.generateInvoice', 'approvals.requestApproval']);
    assert.deepEqual([...f.handoffTargets], ['quality_assurance']);
  });
});

describe('the verifier and the record', () => {
  const verifier = read('scripts/verify-phase-nine.sql');
  test('it rolls back, runs every section, and ends in its own OK line', () => {
    assert.match(verifier, /\\set ON_ERROR_STOP on\nbegin;/);
    assert.match(verifier, /\\echo PHASE 9 FINANCE VERIFIER OK\nrollback;\s*$/);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.match(verifier, new RegExp(`\\\\echo ${n}\\. `), `section ${n}`);
    assert.ok((verifier.match(/pg_temp\.check\(/g) ?? []).length >= 180, 'a substantial number of checks');
  });
  test('it drives a finance user, a member, a client and another organization', () => {
    for (const role of ["'finance'", "'member'", "'client'", "'ops_admin'", "'owner'"]) assert.ok(verifier.includes(role), role);
    assert.match(verifier, /ORGB/);
  });
  test('it never verifies a payment through anything but the existing runner path, and never refunds through a door', () => {
    assert.ok(!/finance\.record_refund|finance\.request_refund/.test(verifier), 'a refund fixture is written as a row, not through a door');
    assert.equal([...verifier.matchAll(/finance\.verify_payment\(/g)].length, 2, 'the helper, and the one assertion that Finance is still forbidden');
  });
  test('the docs exist and name every spec section\'s status', () => {
    const trace = read('docs/phase-9-implementation-traceability.md');
    for (const s of ['EXISTS', 'PARTIAL', 'MISSING', 'MANUAL_EXTERNAL']) assert.ok(trace.includes(s), s);
    read('docs/phase-9-implementation-log.md');
    read('docs/phase-9-manual-actions.md');
  });
});
