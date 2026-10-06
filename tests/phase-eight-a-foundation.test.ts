import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGENT_DEFINITIONS, definitionFor } from '../src/modules/agents/registry.ts';

/**
 * Phase 8A (Customer Success, Support, Upsell, post-launch Sales): what can be held by reading the files. The behaviour is proved in Postgres by
 * scripts/verify-phase-eight-a.sql (275+ checks, run through the real doors on a scratch database) and red-proved by scripts/redproof/phase-eight-a.py; this
 * file holds the shape: the migrations stay in their lane, every door is granted to exactly who may call it, no price exists anywhere in the phase, the readers
 * refuse a failed read, and the actions can only reach a whitelisted door.
 */

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');
const MIG_DIR = root('supabase/migrations/');
const ALL = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const MINE = ALL.filter((f) => /^2026110[5][0-9]{6}_/.test(f));
const SQL = MINE.map((f) => readFileSync(`${MIG_DIR}${f}`, 'utf8')).join('\n');
/** SQL without line comments: a comment may NAME a forbidden thing to say it is absent. */
const CODE = SQL.replace(/^\s*--.*$/gm, '');

const TABLES = ['phase_eight_settings', 'phase_eight_intake', 'phase_eight_gate_waivers', 'phase_eight', 'support_tickets', 'support_ticket_events', 'support_reply_drafts', 'customer_health_snapshots', 'recovery_plans', 'cs_check_ins', 'phase_eight_opportunities'];

describe('the migrations stay in their lane', () => {
  test('four migrations, all inside the reserved version range, in order', () => {
    assert.equal(MINE.length, 4);
    for (const f of MINE) assert.ok(f >= '20261105000000' && f < '20261105500000', f);
    assert.deepEqual(MINE, [...MINE].sort());
  });
  test('they redefine no function an earlier migration defined, and alter no table they do not own', () => {
    const earlier = ALL.filter((f) => !MINE.includes(f) && f < '20261105');
    const defined = new Set(earlier.flatMap((f) => [...read(`supabase/migrations/${f}`).matchAll(/create (?:or replace )?function ((?:core|projects|sales|qa|finance|crm)\.[a-z0-9_]+)\(/g)].map((m) => m[1]!)));
    const mine = [...CODE.matchAll(/create (?:or replace )?function ((?:core|projects|sales)\.[a-z0-9_]+)\(/g)].map((m) => m[1]!);
    assert.ok(mine.length >= 40, `found ${mine.length} functions`);
    for (const fn of mine) assert.ok(!defined.has(fn), `${fn} was defined by an earlier migration`);
    const alters = [...CODE.matchAll(/alter table ([a-z_.]+)/g)].map((m) => m[1]!);
    for (const t of alters) assert.ok(t === 'projects.support_tickets' || t === '%I.%I', `a migration alters ${t}`);
    assert.ok(!/(update|delete from|insert into)\s+(projects\.projects|projects\.completion_records|projects\.handovers|projects\.scope_versions|sales\.proposals|finance\.[a-z_]+)\b/.test(CODE.replace(/select[\s\S]*?;/g, '')), 'no write to the completed project, its record, a proposal or finance');
  });
  test('the completed project is only ever read: no function updates projects.projects', () => {
    assert.ok(!/update\s+projects\.projects\b/.test(CODE));
    assert.ok(!/update\s+projects\.completion_records\b/.test(CODE));
  });
  test('every new table is wired (tenancy, internal-only read, no direct write) and the verifier lists exactly those tables', () => {
    for (const t of TABLES) assert.match(CODE, new RegExp(`p8_wire_table\\('(projects|sales)', '${t}'`), t);
    const verifier = read('scripts/verify-phase-eight-a.sql');
    for (const t of TABLES) assert.ok(verifier.includes(`'${t}'`), `${t} is in the verifier's table list`);
    assert.equal([...CODE.matchAll(/create table if not exists ([a-z_.]+)/g)].length, TABLES.length);
  });
  test('NO price, amount, quote, discount, score or currency column exists on any Phase 8A table', () => {
    const blocks = [...CODE.matchAll(/create table if not exists ([a-z_.]+) \(([\s\S]*?)\n\);/g)];
    assert.equal(blocks.length, TABLES.length);
    for (const [, name, body] of blocks) {
      const columns = [...body!.matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text|int|bigint|boolean|date|timestamptz|jsonb|char)/gm)].map((m) => m[1]!);
      assert.ok(columns.length >= 4, String(name));
      for (const c of columns) assert.doesNotMatch(c, /price|amount|quote|quotation|discount|cost|fee|total|score|minor|currency|rate/, `${name}.${c}`);
    }
  });
  test('health is not a stored column anywhere but its dated history', () => {
    assert.ok(!/\bhealth_score\b|\bhealth_status\s+text\b/.test(CODE.replace(/returns table[\s\S]*?\)/g, '')));
    assert.match(CODE, /create or replace function projects\.customer_health\(/);
    assert.match(CODE, /create or replace function projects\.customer_health_status\(/);
  });
  test('every SECURITY DEFINER function pins an empty search_path', () => {
    const blocks = [...CODE.matchAll(/create or replace function ((?:projects|sales)\.[a-z0-9_]+)\(([\s\S]*?)(?:\bas \$\$|\bas \$m\$)/g)];
    assert.ok(blocks.length >= 40);
    for (const [, name, header] of blocks) {
      if (/security definer/.test(header!)) assert.match(header!, /set search_path = ''/, String(name));
      else if (!/returns trigger/.test(header!)) assert.match(header!, /set search_path = ''/, `${name} (invoker)`);
    }
  });
  test('every door has explicit grants: service-only doors reach the service role alone, person-only doors never the service role', () => {
    const serviceOnly = ['fill_phase_eight_intake', 'record_support_proposal', 'record_check_in_agenda', 'sweep_support_sla', 'sweep_maintenance_renewals'];
    const personOnly = ['set_phase_eight_setting', 'waive_phase_eight_gate', 'start_phase_eight', 'set_phase_eight_state', 'classify_support_ticket', 'assign_support_ticket', 'link_support_root_cause', 'advance_support_ticket',
      'record_client_confirmation', 'escalate_support_ticket', 'acknowledge_support_escalation', 'draft_support_reply', 'record_support_reply_sent', 'discard_support_reply_draft', 'update_recovery_plan', 'resolve_recovery_plan',
      'abandon_recovery_plan', 'complete_check_in', 'skip_check_in', 'qualify_phase_eight_opportunity', 'hand_off_phase_eight_opportunity', 'close_phase_eight_opportunity'];
    for (const f of serviceOnly) {
      assert.match(CODE, new RegExp(`revoke all on function (?:projects|sales)\\.${f}\\([^)]*\\) from public, anon, authenticated;\\s*\\ngrant execute on function (?:projects|sales)\\.${f}\\([^)]*\\) to service_role;`), f);
    }
    for (const f of personOnly) {
      assert.match(CODE, new RegExp(`revoke all on function (?:projects|sales)\\.${f}\\([^)]*\\) from public, anon, service_role;\\s*\\ngrant execute on function (?:projects|sales)\\.${f}\\([^)]*\\) to authenticated;`), f);
    }
    for (const f of ['open_support_ticket', 'create_check_in', 'record_health_snapshot', 'record_phase_eight_opportunity']) {
      assert.match(CODE, new RegExp(`grant execute on function (?:projects|sales)\\.${f}\\([^)]*\\) to authenticated, service_role;`), `${f} serves a person and the runner`);
    }
  });
  test('internal helpers are executable by nobody', () => {
    for (const f of ['p8_build_intake', 'p8_ticket_event', 'p8_hours', 'p8_take_snapshot', 'p8_commercial_hold']) {
      assert.match(CODE, new RegExp(`revoke all on function (?:projects|sales)\\.${f}\\([^)]*\\) from public, anon, authenticated, service_role;`), f);
    }
  });
  test('every emitted event type is declared by a Phase 8A migration', () => {
    const emitted = new Set([...CODE.matchAll(/core\.emit_event\([^,]+,\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!));
    assert.ok(emitted.size >= 10, `${emitted.size} event types`);
    for (const type of emitted) assert.ok(CODE.includes(`('${type}',`), `${type} is not declared`);
  });
  test('the agents cannot reach the person-only doors, and the table guard is wired on every mutable table', () => {
    for (const t of ['phase_eight_intake', 'phase_eight', 'support_tickets', 'support_reply_drafts', 'recovery_plans', 'cs_check_ins', 'phase_eight_opportunities']) {
      assert.match(CODE, new RegExp(`p8_wire_table\\('(?:projects|sales)', '${t}', true, false\\)`), `${t} is mutable and guarded`);
    }
    for (const t of ['support_ticket_events', 'customer_health_snapshots', 'phase_eight_gate_waivers']) {
      assert.match(CODE, new RegExp(`p8_wire_table\\('projects', '${t}', false, true\\)`), `${t} is append-only`);
    }
  });
  test('the helpers that wire the tables are dropped at the end of the phase', () => {
    assert.match(read(`supabase/migrations/${MINE[3]}`), /drop function if exists projects\.p8_wire_table/);
  });
});

describe('the verifier and the red-proof harness', () => {
  const verifier = read('scripts/verify-phase-eight-a.sql');
  test('the verifier rolls back, ends with its OK line, and has at least 270 checks', () => {
    assert.match(verifier, /\\set ON_ERROR_STOP on\nbegin;/);
    assert.match(verifier, /\\echo Phase 8A [^\n]+ verified OK\nrollback;\s*$/);
    assert.ok([...verifier.matchAll(/pg_temp\.check\(/g)].length >= 270);
  });
  test('it is written to the traps this repository knows: split snapshots, role switching, scoped counts, a real portal client', () => {
    assert.match(verifier, /pg_temp\.as_client\(/);
    assert.match(verifier, /'client_member'/);
    assert.match(verifier, /clock_timestamp|now\(\) - interval/);
    assert.ok(!/select \*\s+from pg_temp\.mk\('P8A-MAIN'/.test(verifier));
  });
  test('the red-proof harness carries at least 44 controls and refuses a no-op mutation', () => {
    const harness = read('scripts/redproof/phase-eight-a.py');
    assert.ok([...harness.matchAll(/^ {4}\('/gm)].length >= 44);
    assert.match(harness, /NO-OP MUTATION/);
  });
});

describe('the readers refuse a failed read', () => {
  const q = read('src/modules/projects/phase-eight-queries.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  test('every database read is followed by an unreadable() refusal', () => {
    const reads = [...q.matchAll(/error: (\w+Error) \} =|\{ data, error \} =/g)].map((m) => m[1] ?? 'error');
    const refusals = [...q.matchAll(/if \((\w*[eE]rror)\) unreadable\(/g)].map((m) => m[1]!);
    assert.ok(reads.length >= 15, `${reads.length} reads`);
    assert.deepEqual(refusals.sort(), reads.sort());
    assert.equal([...q.matchAll(/unreadable\(/g)].length, reads.length, 'every unreadable() answers a read, and every read has one');
  });
  test('it asks the database for health, SLA state and eligibility and computes none of them', () => {
    for (const fn of ['customer_health_status', 'support_queue', 'check_in_eligibility', 'customer_success_overview']) assert.match(q, new RegExp(`rpc\\('${fn}'`));
    assert.ok(!/responseDueAt\s*[<>]|new Date\(|Date\.now\(/.test(q), 'no clock arithmetic');
  });
});

describe('the actions can only reach a whitelisted door', () => {
  const src = read('src/modules/projects/phase-eight-actions.ts');
  const actions = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  test('a use-server file exporting one async function', () => {
    assert.match(src, /^'use server';/);
    assert.deepEqual([...actions.matchAll(/^export (\w+)/gm)].map((m) => m[1]), ['async']);
    assert.match(actions, /export async function phaseEightDoorAction\(/);
  });
  test('it writes nothing itself and sends, quotes and prices nothing', () => {
    for (const forbidden of ['.insert(', '.update(', '.delete(', '.upsert(', 'send_outbound_message', 'sales.proposals', 'set_proposal_pricing', 'record_discount_decision', 'draft_proposal', 'deliverQueuedText']) {
      assert.ok(!actions.includes(forbidden), forbidden);
    }
    assert.equal([...actions.matchAll(/createAdminClient\(/g)].length, 1, 'the one service-role door is the intake refresh');
    assert.match(actions, /if \(!can\(context, 'project\.write'\)\)/);
    assert.match(actions, /Object\.prototype\.hasOwnProperty\.call\(DOORS, name\)/);
  });
  test('every door names a function a Phase 8A migration defines, granted to signed-in people', () => {
    const rpcs = [...actions.matchAll(/rpc: '([a-z_]+)'/g)].map((m) => m[1]!);
    assert.ok(rpcs.length >= 25, `${rpcs.length} doors`);
    for (const r of rpcs) {
      assert.match(CODE, new RegExp(`create or replace function (?:projects|sales)\\.${r}\\(`), r);
      assert.match(CODE, new RegExp(`grant execute on function (?:projects|sales)\\.${r}\\([^)]*\\) to authenticated`), `${r} is callable by a person`);
    }
    for (const forbidden of ['record_support_proposal', 'record_check_in_agenda', 'sweep_support_sla', 'sweep_maintenance_renewals']) assert.ok(!rpcs.includes(forbidden), `${forbidden} is the runner's, not the Admin's`);
  });
  test('a malformed id or date is refused with a word before the database is asked', () => {
    assert.match(actions, /A selected record is not valid\./);
    assert.match(actions, /A date is not valid/);
  });
});

describe('the panel and its forms', () => {
  const forms = read('app/(internal)/projects/[projectId]/phase-eight-forms.tsx');
  const panel = read('app/(internal)/projects/[projectId]/phase-eight-panel.tsx');
  test('the forms are a client file over the one action; the panel is a server component that never imports the action', () => {
    assert.match(forms, /^'use client';/);
    assert.match(forms, /phaseEightDoorAction/);
    assert.ok(!/^'use client'/.test(panel));
    assert.ok(!panel.includes('phase-eight-actions'));
    assert.match(panel, /export async function PhaseEightPanel\(/);
    assert.match(panel, /if \(!view\.workspace && view\.project\.status !== 'completed'\) return null;/);
  });
  test('no form field is named for a price, amount, quote or discount', () => {
    for (const [, name] of panel.matchAll(/name: '([A-Za-z]+)'/g)) assert.doesNotMatch(name!, /price|amount|quote|discount|cost|fee|total/i, String(name));
  });
  test('health is shown with its signals and never offered as a field; replies are drafts a person sends', () => {
    assert.match(panel, /derived on every read/);
    assert.ok(!/name: 'health'|name: 'status'/.test(panel));
    assert.match(panel, /Nothing was sent|nothing was sent/);
    assert.match(panel, /I sent this: record it/);
  });
  test('the overview page is a nested page under /projects, so it is reachable from the rail', () => {
    assert.ok(existsSync(root('app/(internal)/projects/customer-success/page.tsx')));
    assert.ok(!existsSync(root('app/(internal)/customer-success/page.tsx')));
  });
});

describe('the agents the phase names, and what each may not do', () => {
  test('every agent the four specs name is defined; none was missing, so none was added', () => {
    for (const key of ['customer_success', 'support', 'upsell', 'sales', 'orchestrator', 'finance', 'developer', 'quality_assurance']) assert.ok(definitionFor(key), key);
    assert.equal(new Set(AGENT_DEFINITIONS.map((a) => a.key)).size, AGENT_DEFINITIONS.length);
  });
  test('upsell has zero pricing authority and no client contact; no Phase 8A agent has money authority beyond proposing', () => {
    const upsell = definitionFor('upsell')!;
    assert.equal(upsell.clientFacing, false);
    assert.equal(upsell.moneyAuthority, 'none');
    assert.ok(!upsell.tools.includes('crm.sendClientMessage'));
    for (const key of ['support', 'customer_success', 'upsell']) {
      const d = definitionFor(key)!;
      assert.equal(d.moneyAuthority, 'none', key);
      assert.equal(d.mayVerify, false, key);
      assert.equal(d.verification.selfAssertionAllowed, false, key);
    }
  });
  test('the seed and the migrations install no new agent: Phase 8A defines none', () => {
    assert.ok(!/insert into ai\.agents/.test(CODE));
  });
});

describe('the documents exist and say what is and is not built', () => {
  for (const f of ['docs/phase-8a-implementation-traceability.md', 'docs/phase-8a-implementation-log.md', 'docs/phase-8a-manual-actions.md']) {
    test(`${f} exists`, () => assert.ok(existsSync(root(f)), f));
  }
  test('the traceability matrix classifies every row with a known status and names a section from each spec', () => {
    const t = read('docs/phase-8a-implementation-traceability.md');
    assert.match(t, /EXISTS/);
    assert.match(t, /MISSING/);
    assert.match(t, /MANUAL_EXTERNAL/);
    for (const section of ['P8-GATE-001', 'P8-GATE-008', 'CUS-TST-001', 'CUS-TST-008', 'SUP-', 'UPS-', 'SAL-', 'E2E-01', 'E2E-13']) assert.ok(t.includes(section), section);
    const rows = t.split('\n').filter((l) => /^\|/.test(l) && !/^\|[-\s|]+\|$/.test(l) && !/\| *Status *\|/.test(l));
    for (const r of rows) assert.match(r, /EXISTS|PARTIAL|MISSING|MANUAL_EXTERNAL|NOT_APPLICABLE/, r.slice(0, 80));
  });
});
