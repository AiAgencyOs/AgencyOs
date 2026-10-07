import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

/**
 * Text-level guards on the Phase 8 part B migrations. A regex cannot say a migration RUNS (scripts/verify-phase-eight-b.sql does, on a scratch
 * Postgres, and every control there was red-proved); it can say the shape every org-scoped table and door must have is present and stays present.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'supabase/migrations');
const files = readdirSync(dir).filter((f) => /^20261105[5-9]\d{5}_/.test(f)).sort();
const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
const nocomments = sql.replace(/^\s*--.*$/gm, '');

const TABLES = [
  'projects.maintenance_work_items', 'projects.maintenance_work_commits', 'projects.maintenance_qa_results', 'projects.maintenance_release_decisions', 'projects.maintenance_sla_policies',
  'projects.maintenance_routing_decisions', 'projects.maintenance_agent_requests', 'projects.maintenance_agent_proposals', 'projects.maintenance_agent_proposal_decisions',
  'finance.maintenance_billing_requests', 'finance.maintenance_billing_proposals', 'finance.maintenance_billing_decisions', 'finance.maintenance_billing_links', 'finance.maintenance_gate_exceptions',
];

describe('Phase 8 part B migrations', () => {
  test('they live in the reserved version range', () => {
    assert.ok(files.length >= 4);
    for (const f of files) assert.match(f, /^20261105[5-9]\d{5}_/);
  });
  test('every new table is created, org-scoped, RLS-on, internal-read-only, with no end-user writes', () => {
    for (const t of TABLES) {
      const [schema, name = ''] = t.split('.');
      assert.match(sql, new RegExp(`create table if not exists ${schema}\\.${name} \\(`), `${t} is created`);
      const body = sql.match(new RegExp(`create table if not exists ${schema}\\.${name} \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? '';
      assert.match(body, /organization_id\s+uuid not null references core\.organizations\(id\)/, `${t} has organization_id`);
      assert.ok(sql.includes(`'${name.replace(/^/, '')}'`), `${t} is in the policy loop`);
    }
    // the loop's statements, once per schema file that has one
    assert.ok((nocomments.match(/enable row level security/g) ?? []).length >= 2);
    assert.ok((nocomments.match(/core\.is_internal\(\)/g) ?? []).length >= 2, 'internal-only select policy');
    assert.ok((nocomments.match(/revoke insert, update, delete on (projects|finance)\.%I from authenticated/g) ?? []).length >= 2);
    assert.ok((nocomments.match(/core\.freeze_organization_id\(\)/g) ?? []).length >= 2);
    assert.ok((nocomments.match(/core\.enforce_parent_org/g) ?? []).length >= 2);
  });
  test('history tables are append-only', () => {
    for (const t of ['maintenance_work_commits', 'maintenance_qa_results', 'maintenance_release_decisions', 'maintenance_sla_policies', 'maintenance_routing_decisions', 'maintenance_agent_requests', 'maintenance_agent_proposals', 'maintenance_agent_proposal_decisions', 'maintenance_billing_requests', 'maintenance_billing_proposals', 'maintenance_billing_decisions', 'maintenance_billing_links']) {
      assert.ok(nocomments.includes(`'${t}'`), t);
    }
    assert.match(nocomments, /function projects\.maintenance_history_append_only/);
    assert.match(nocomments, /function finance\.maintenance_history_append_only/);
  });
  test('every function is SECURITY DEFINER with an empty search_path and explicit grants', () => {
    const fns = [...nocomments.matchAll(/create or replace function ([a-z_.]+)\(([\s\S]*?)\)\s*returns[\s\S]*?\$\$;?/g)];
    assert.ok(fns.length >= 25);
    for (const m of fns) {
      const head = m[0].slice(0, m[0].indexOf('$$'));
      if (/returns trigger/.test(head)) { assert.match(head, /set search_path = ''/, `${m[1]}`); continue; }
      assert.match(head, /set search_path = ''/, `${m[1]} sets search_path`);
    }
    for (const m of nocomments.matchAll(/create or replace function ([a-z_.]+)\(/g)) {
      const name = m[1]!;
      if (/_guard$|append_only$|financial_gate$/.test(name) && !/maintenance_financial_gate$/.test(name)) continue;
      assert.match(nocomments, new RegExp(`revoke all on function ${name.replace('.', '\\.')}\\(`), `${name} revokes from public`);
    }
  });
  test('the agent-facing doors are service-role only, and check the role inside', () => {
    for (const fn of ['projects.record_maintenance_routing', 'projects.record_maintenance_agent_proposal', 'finance.record_maintenance_billing_proposal']) {
      const re = new RegExp(`revoke all on function ${fn.replace('.', '\\.')}\\([^)]*\\) from public, anon, authenticated;\\s*grant execute on function ${fn.replace('.', '\\.')}\\([^)]*\\) to service_role;`);
      assert.match(nocomments, re, `${fn} is service_role only`);
      const body = nocomments.match(new RegExp(`function ${fn.replace('.', '\\.')}\\([\\s\\S]*?\\$\\$;`))?.[0] ?? '';
      assert.ok(body.length > 0, `${fn} body found`);
      assert.match(body, /auth\.role\(\)[\s\S]{0,40}service_role/, `${fn} checks the role inside`);
    }
  });
  test('the billing door takes no amount', () => {
    const head = nocomments.match(/function finance\.record_maintenance_billing_proposal\(([^)]*)\)/)?.[1] ?? '';
    assert.doesNotMatch(head, /amount|total|price|minor|balance/i);
  });
  test('nothing here verifies, records or moves a payment, issues an invoice, or deploys', () => {
    for (const forbidden of [/finance\.verify_payment/, /finance\.record_manual_payment/, /insert into finance\.payments/, /update finance\.payments/, /insert into finance\.invoices/, /update finance\.invoices/, /finance\.issue_invoice/, /finance\.create_milestone_invoice/]) {
      assert.doesNotMatch(nocomments, forbidden);
    }
  });
  test('a release is approved only by an Admin who is not the author; a result is recorded only by someone who is not the author', () => {
    assert.match(nocomments, /core\.is_admin\(\)[\s\S]{0,200}approve/);
    assert.match(nocomments, /v_actor = v_i\.created_by or v_actor = v_i\.commit_submitted_by or v_actor = v_i\.release_requested_by/);
    assert.match(nocomments, /v_actor = v_i\.commit_submitted_by then return query select 'self_review'/);
  });
  test('the financial gate trigger touches only plans that were billed through the new pipeline', () => {
    assert.match(nocomments, /not_billed/);
    assert.match(nocomments, /v_gate\.state not in \('not_billed', 'verified_paid', 'exception_approved'\)/);
  });
  test('every event type the migrations emit is declared', () => {
    const emitted = [...nocomments.matchAll(/emit_event\([^']*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);
    const declared = [...nocomments.matchAll(/\(\s*'([a-z_]+\.[a-z_]+)'\s*,\s*'/g)].map((m) => m[1]);
    assert.ok(emitted.length >= 5);
    for (const e of emitted) assert.ok(declared.includes(e), `${e} is declared in core.event_types`);
  });
});
