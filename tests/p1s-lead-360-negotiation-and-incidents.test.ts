import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { NAV_MODULES } from '../app/(internal)/nav-config.ts';
import { formatAge, parseIncidentRows } from '../src/lib/p1s/incident-model.ts';
import { INCIDENT_RUNBOOKS, runbookFor } from '../src/lib/p1s/incident-runbooks.ts';
import { parseNegotiationQueue } from '../src/modules/sales/p1s-negotiation-model.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const migration = read('supabase/migrations/20261204300000_p1s_the_negotiation_queue_and_the_incident_recovery_queue_are_reads_of_what_already_exists.sql');
const items = NAV_MODULES.flatMap((m) => m.items.map((i) => ({ ...i, module: m.key })));

/**
 * A04 Lead 360's Negotiation / Tasks / Audit tabs, A15 the Negotiation workspace, A29 Incidents and recovery. All three are reads of existing records, so what
 * is pinned here is that the reads are guarded, the pages are gated and reachable, every kind of incident the database can name has a runbook, and the rows are
 * parsed defensively.
 */

describe('A29: every runbook key the database can emit has a runbook, and every runbook says what to do', () => {
  const emitted = [...migration.matchAll(/'(uncertain_side_effect|task_rejected|task_failed|security_incident|escalation|dead_job|provider_outage)'/g)].map((m) => m[1]!);
  const keys = [...new Set(emitted)];

  test('the SQL names the seven kinds', () => {
    assert.deepEqual(keys.sort(), ['dead_job', 'escalation', 'provider_outage', 'security_incident', 'task_failed', 'task_rejected', 'uncertain_side_effect']);
  });

  test('each has a runbook with at least three steps, and no step claims anything happens by itself', () => {
    for (const k of keys) {
      const rb = runbookFor(k);
      assert.ok(rb, `no runbook for ${k}`);
      assert.ok(rb.steps.length >= 3, `${k} has ${rb.steps.length} steps`);
      for (const s of rb.steps) assert.doesNotMatch(s, /automatically (closes|resolves|fixes)/i, s);
    }
    assert.equal(INCIDENT_RUNBOOKS.length, keys.length, 'no orphan runbook');
  });

  test('the uncertain-side-effect runbook says not to retry first (a retry could do it twice)', () => {
    assert.match(runbookFor('uncertain_side_effect')!.steps[0]!, /Do not retry/);
  });

  test('the security runbook says only an Admin closes an incident (owner decision, 20261130100000)', () => {
    assert.ok(runbookFor('security_incident')!.steps.some((s) => /Only an Admin can close/.test(s)));
  });
});

describe('parsing: a row the database should never send is dropped, not guessed at', () => {
  const good = { incident_key: 'handoff:1', source: 'task', source_id: '1', source_task_id: '1', severity: 'high', title: 't', state: 'open', owner_label: 'a -> b', opened_at: '2026-10-07T00:00:00Z', age_minutes: 90, uncertain_side_effect: true, outage_provider: null, runbook_key: 'task_failed', detail: 'd', correlation_id: null };

  test('a well-formed row parses; an unknown severity or source is dropped', () => {
    const rows = parseIncidentRows([good, { ...good, incident_key: 'x', severity: 'catastrophic' }, { ...good, incident_key: 'y', source: 'weather' }]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.uncertainSideEffect, true);
    assert.equal(rows[0]!.ageMinutes, 90);
  });

  test('not an array is nothing, and "closed" is the only other state', () => {
    assert.deepEqual(parseIncidentRows(null), []);
    assert.equal(parseIncidentRows([{ ...good, state: 'closed' }])[0]!.state, 'closed');
    assert.equal(parseIncidentRows([{ ...good, state: 'weird' }])[0]!.state, 'open');
  });

  test('age reads as people say it', () => {
    assert.equal(formatAge(5), '5 min');
    assert.equal(formatAge(150), '3 h');
    assert.equal(formatAge(60 * 72), '3 d');
  });

  test('a negotiation row keeps its numbers and its flags', () => {
    const [row] = parseNegotiationQueue([{ opportunity_id: 'o', opportunity_name: 'Deal', lead_id: 'l', stage: 'negotiation', proposal_id: 'p', proposal_version: 2, proposal_status: 'sent', total_minor: '900000', discount_minor: 100000, policy_version: 'pv-1', rounds: 2, open_objections: 1, latest_objection_kind: 'price', latest_concern: 'too dear', latest_objection_at: '2026-10-07T00:00:00Z', pending_discount_decisions: 1, approval_state: null, acceptance_unclear: true, round_cap: 2, at_round_cap: true, next_action: 'Answer the open objection', last_activity_at: null }]);
    assert.equal(row!.totalMinor, 900000);
    assert.equal(row!.atRoundCap, true);
    assert.equal(row!.acceptanceUnclear, true);
    assert.equal(row!.roundCap, 2);
    assert.equal(row!.lastActivityAt, null);
  });
});

describe('the pages are gated, reachable and honest about a failed read', () => {
  test('A29 and A15 are in the rail behind the capability their page enforces', () => {
    const inc = items.find((i) => i.href === '/operations/incidents');
    assert.ok(inc && inc.module === 'operations' && inc.capability === 'audit.read');
    assert.match(read('app/(internal)/operations/incidents/page.tsx'), /can\(context, 'audit\.read'\)\) return <PermissionDenied/);
    const neg = items.find((i) => i.href === '/quotations/negotiation');
    assert.ok(neg && neg.module === 'sales' && neg.capability === 'lead.read');
    assert.match(read('app/(internal)/quotations/negotiation/page.tsx'), /can\(context, 'lead\.read'\)\) return <PermissionDenied/);
  });

  test('the operations page links to the incident queue', () => {
    assert.match(read('app/(internal)/operations/page.tsx'), /href="\/operations\/incidents"/);
  });

  test('every read reports a failure instead of showing an all-clear', () => {
    for (const f of ['src/lib/p1s/incident-queries.ts', 'src/modules/sales/p1s-negotiation-queries.ts', 'src/modules/crm/p1s-lead-360-queries.ts']) {
      const src = read(f);
      const errors = (src.match(/if \([\w.]*error\)/g) ?? []).length;
      const unread = (src.match(/unreadable\(/g) ?? []).length;
      assert.ok(errors > 0 && errors === unread, `${f}: ${errors} error checks, ${unread} unreadable calls`);
    }
  });

  test('the incident page offers the same controls as the task board, to the same people, and closes nothing itself', () => {
    const src = read('app/(internal)/operations/incidents/page.tsx');
    assert.match(src, /from '\.\.\/task-board\/task-controls'/);
    assert.match(src, /const admin = can\(context, 'agent\.configure'\)/);
    assert.match(src, /admin && r\.source === 'task' && task \?/);
    assert.doesNotMatch(src, /closeIncident|resolveIncident|\.rpc\(/);
  });

  test('both queue functions are read-only, internal-only and granted to signed-in users and the service role, never anon', () => {
    for (const fn of ['sales.p1s_negotiation_queue\\(integer\\)', 'ai.p1s_incident_queue\\(boolean, integer\\)']) {
      assert.match(migration, new RegExp(`revoke all on function ${fn} from public, anon;`));
      assert.match(migration, new RegExp(`grant execute on function ${fn} to authenticated, service_role;`));
    }
    assert.equal(/\binsert\s+into\b|\bdelete\s+from\b|\bupdate\s+\w+\.\w+\s+set\b/i.test(migration.replace(/--.*$/gm, '')), false, 'the migration writes nothing');
    assert.equal((migration.match(/not coalesce\(\(select core\.is_internal\(\)\), false\)/g) ?? []).length, 2);
  });
});

describe('Lead 360 gains the three tabs, each with the section it scrolls to', () => {
  const page = read('app/(internal)/leads/[leadId]/page.tsx');
  const sections = read('app/(internal)/leads/[leadId]/lead-360-sections.tsx');

  test('tab ids match the section ids', () => {
    for (const id of ['negotiation', 'tasks', 'audit']) {
      assert.match(page, new RegExp(`\\{ id: '${id}', label: `), `${id} tab`);
    }
    assert.match(sections, /id="negotiation"/);
    assert.match(sections, /<Card id="tasks">/);
    assert.match(sections, /<Card id="audit">/);
  });

  test('the page renders the three sections, and the audit one only for a person who may read the audit log', () => {
    assert.match(page, /<LeadNegotiationSection leadId=\{leadId\} opportunityId=\{opportunity\?\.id \?\? null\} \/>/);
    assert.match(page, /<LeadAgentTasksSection /);
    assert.match(page, /can\(context, 'audit\.read'\) \? \(\s*<LeadAuditSection/);
    assert.match(page, /\.\.\.\(can\(context, 'audit\.read'\) \? \[\{ id: 'audit'/);
  });

  test('the audit read covers the lead, its deal, its quotations and its conversation', () => {
    assert.match(page, /subjectIds=\{\[leadId, \.\.\.\(opportunity \? \[opportunity\.id\] : \[\]\), \.\.\.proposals\.map\(\(p\) => p\.id\), \.\.\.\(conversation \? \[conversation\.id\] : \[\]\)\]\}/);
  });
});
