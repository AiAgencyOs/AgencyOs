import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { TOPICS } from '../src/lib/realtime/topics.ts';
import { codeOnly, sqlCode } from './_code-only.ts';
import { region } from './_region.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * An alert is acknowledged by a person — SCR-067, with SCR-068's override
 * centre and emergency controls beside it (bucket F, stream F-F).
 *
 *   A. `core.alerts`: raised only by the runner, acknowledged only by a
 *      person with a reason, audited; the same situation is one row seen
 *      twice; the banner hears the table
 *   B. the runner raises: a dead job, a provider over budget
 *   C. `core.overrides`: the domain overrides land by a trigger on the audit
 *      trail, in the same transaction; a manual exception is owner-only
 *   D. `core.kill_switches`: owner-only with a reason, honoured by the runner
 *      between steps and by the send chokepoint
 *   E. the pages: the banner in the layout, the panels on Operations and
 *      the override centre under Governance
 */

const migration = readdirSync(join(root, 'supabase/migrations'))
  .filter((f) => f.includes('a_model_is_managed_a_role_is_honoured_and_an_alert_is_acknowledged'))
  .map((f) => read(`supabase/migrations/${f}`))
  .join('\n');
const code = sqlCode(migration);

describe('A. core.alerts — raised by the runner, acknowledged by a person', () => {
  test('the table exists with the whole acknowledgement or none of it', () => {
    assert.match(code, /create table if not exists core\.alerts \(/);
    assert.match(code, /constraint alerts_acknowledgement_is_whole check/);
    assert.match(code, /severity\s+text not null check \(severity in \('info', 'warning', 'critical'\)\)/);
  });

  test('RLS on and forced, staff may read, only the service role may write directly', () => {
    assert.match(code, /alter table core\.alerts enable row level security;/);
    assert.match(code, /alter table core\.alerts force row level security;/);
    assert.match(code, /create policy alerts_select on core\.alerts[\s\S]*?core\.is_internal\(\)/);
    assert.doesNotMatch(code, /create policy alerts_(write|insert|update|delete)/);
    assert.match(code, /grant select on core\.alerts to authenticated;/);
    assert.match(code, /grant select, insert, update on core\.alerts to service_role;/);
    assert.match(code, /create trigger freeze_org_alerts[\s\S]*?core\.freeze_organization_id\(\)/);
  });

  test('the same situation raised twice is one open row seen twice', () => {
    assert.match(code, /create unique index if not exists alerts_open_fingerprint_idx\s*on core\.alerts \(organization_id, fingerprint\)\s*where acknowledged_at is null;/);
    const raise = region(code, 'create or replace function core.raise_alert(', '$$;');
    assert.match(raise, /on conflict \(organization_id, fingerprint\) where acknowledged_at is null do update/);
    assert.match(raise, /occurrences\s*= core\.alerts\.occurrences \+ 1/);
  });

  test('raise_alert is the runner’s alone; acknowledge_alert is a person’s, with a reason, audited', () => {
    assert.match(code, /revoke all on function core\.raise_alert\(uuid, text, text, text, text\) from public, anon, authenticated;/);
    assert.match(code, /grant execute on function core\.raise_alert\(uuid, text, text, text, text\) to service_role;/);
    const ack = region(code, 'create or replace function core.acknowledge_alert(', '$$;');
    assert.match(ack, /security definer/);
    assert.match(ack, /if not coalesce\(\(select core\.is_admin\(\)\), false\) then/);
    assert.match(ack, /if v_reason is null then\s*return query select 'no_reason'::text/);
    assert.match(ack, /'already_acknowledged'::text/);
    assert.match(ack, /core\.record_audit\(v_org, 'alert\.acknowledged', 'alert', p_alert_id, v_before, v_after\)/);
    assert.match(code, /grant execute on function core\.acknowledge_alert\(uuid, text\) to authenticated;/);
  });

  test('the banner hears the table: published (in the companion publication file), and a topic names it', () => {
    const companion = readdirSync(join(root, 'supabase/migrations'))
      .filter((f) => f.includes('the_panel_hears_an_alert_and_a_switch'))
      .map((f) => read(`supabase/migrations/${f}`))
      .join('\n');
    assert.match(companion, /'core\.alerts',\s*'core\.kill_switches'/);
    assert.match(companion, /alter publication supabase_realtime add table/);
    assert.deepEqual([...TOPICS.alerts], ['core.alerts', 'core.kill_switches']);
  });

  test('the app door checks job.requeue’s roles over the union and calls the function', () => {
    const lib = codeOnly(read('src/lib/observability/alerts.ts'));
    const door = region(lib, 'export async function acknowledgeAlert(');
    assert.match(door, /if \(!can\(context, 'job\.requeue'\)\)/);
    assert.match(door, /rpc\('acknowledge_alert', \{ p_alert_id: alertId, p_reason: trimmed \}\)/);
    assert.match(door, /if \(!trimmed\) return err\('VALIDATION'/);
  });
});

describe('B. the runner raises', () => {
  test('a dead job is a critical alert, raised where the job is parked', () => {
    const agentRun = codeOnly(read('app/api/jobs/run/agent-run.ts'));
    const fail = region(agentRun, 'export async function failJob(');
    assert.match(fail, /if \(settlement\.status === 'dead'\) \{[\s\S]*?await raiseAlert\(admin, \{[\s\S]*?severity: 'critical'[\s\S]*?fingerprint: `dead-job:\$\{job\.kind\}`/);
  });

  test('raiseAlert calls the runner-only function and never fails the tick', () => {
    const gates = codeOnly(read('src/lib/ai/run-gates.ts'));
    const raise = region(gates, 'export async function raiseAlert(');
    assert.match(raise, /rpc\('raise_alert'/);
    assert.match(raise, /console\.error/);
    assert.doesNotMatch(raise, /throw /);
  });
});

describe('C. core.overrides — the override centre', () => {
  test('the table, its tenancy discipline, and no plain write policy', () => {
    assert.match(code, /create table if not exists core\.overrides \(/);
    assert.match(code, /alter table core\.overrides enable row level security;/);
    assert.match(code, /alter table core\.overrides force row level security;/);
    assert.match(code, /create policy overrides_select on core\.overrides[\s\S]*?core\.is_internal\(\)/);
    assert.doesNotMatch(code, /create policy overrides_(write|insert|update|delete)/);
    assert.match(code, /create trigger freeze_org_overrides[\s\S]*?core\.freeze_organization_id\(\)/);
  });

  test('the domain overrides land by a trigger on the audit trail, in the same transaction', () => {
    const mirror = region(code, 'create or replace function core.mirror_override_from_audit()', '$$;');
    assert.match(mirror, /security definer/);
    assert.match(mirror, /new\.action = 'scope_version\.unfrozen'/);
    assert.match(mirror, /new\.action = 'release\.payment_overridden'/);
    assert.match(mirror, /'start_override_reason'/);
    assert.match(mirror, /insert into core\.overrides/);
    assert.match(code, /create trigger mirror_override_from_audit\s*after insert on audit\.audit_log\s*for each row execute function core\.mirror_override_from_audit\(\);/);
  });

  test('a manual exception is owner-only, needs ten characters of reason, and audits override.recorded', () => {
    const door = region(code, 'create or replace function core.record_manual_override(', '$$;');
    assert.match(door, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
    assert.match(door, /length\(v_reason\) < 10/);
    assert.match(door, /v_kind !~ '\^manual\\\.\[a-z\]\[a-z0-9_\]\*\$'/);
    assert.match(door, /'override\.recorded'/);
  });
});

describe('D. core.kill_switches — emergency controls', () => {
  test('three switches, a reason whenever one is engaged, owner-only through the door', () => {
    assert.match(code, /switch\s+text not null check \(switch in \('agents_paused', 'outbound_paused', 'jobs_paused'\)\)/);
    assert.match(code, /constraint kill_switches_active_says_why check \(not active or \(reason is not null/);
    const door = region(code, 'create or replace function core.set_kill_switch(', '$$;');
    assert.match(door, /if not coalesce\(\(select core\.is_owner\(\)\), false\) then/);
    assert.match(door, /'kill_switch\.engaged' else 'kill_switch\.released'/);
    assert.doesNotMatch(code, /create policy kill_switches_(write|insert|update|delete)/);
  });

  test('the runner honours agents_paused between steps and the app door is owner-only by the union', () => {
    const gates = codeOnly(read('src/lib/ai/run-gates.ts'));
    const check = region(gates, 'export async function checkRunGates(');
    assert.match(check, /\.eq\('switch', 'agents_paused'\)/);
    assert.match(check, /throw new AgentsPaused\(/);
    assert.match(check, /throw new JobCancelled\(/);
    const lib = codeOnly(read('src/lib/observability/kill-switches.ts'));
    assert.match(region(lib, 'export async function setKillSwitch('), /if \(!hasRole\(context, 'owner'\) \|\| !can\(context, 'organization\.settings'\)\)/);
  });

  test('the send callers name the outbound switch once, in one place', () => {
    const ks = read('src/modules/crm/kill-switch.ts');
    assert.match(ks, /export const OUTBOUND_PAUSED = 'outbound_paused' as const;/);
    assert.match(ks, /permanent: false/);
  });
});

describe('E. the pages', () => {
  test('the banner is mounted in the internal layout, under the header, and reads after paint', () => {
    const layout = read('app/(internal)/layout.tsx');
    assert.match(layout, /<IncidentBanner \/>/);
    assert.ok(layout.indexOf('</header>') < layout.indexOf('<IncidentBanner />'));
    const banner = read('app/(internal)/incident-banner.tsx');
    assert.match(banner, /useLive\(\{ topics: \['alerts'\]/);
    assert.match(banner, /if \(!state \|\| \(state\.critical\.length === 0 && state\.engaged\.length === 0\)\) return null;/);
    const action = read('app/(internal)/incident-banner-action.ts');
    assert.match(action, /a\.severity === 'critical'/);
  });

  test('Operations shows the alerts with a real count per severity and the acknowledge form; Governance has the override centre', () => {
    const ops = read('app/(internal)/operations/page.tsx');
    assert.match(ops, /<AlertsPanel open=\{openAlerts\.map\(alertView\)\}/);
    assert.match(ops, /label="Critical open" value=\{criticalOpen\}/);
    // SCR-066: an operational failure is escalated through stream F-A's shared control, on each dead letter.
    assert.match(read('app/(internal)/operations/dead-letters-list.tsx'), /<EscalateControl subjectType="job" subjectKey=\{`job-\$\{job\.id\}`\}/);
    const centre = read('app/(internal)/governance/overrides/page.tsx');
    assert.match(centre, /<KillSwitchPanel switches=/);
    assert.match(centre, /<ManualOverrideForm \/>/);
    assert.match(centre, /listOverrides\(\{ kind: kind \|\| undefined \}\)/);
    const nav = read('app/(internal)/nav-config.ts');
    assert.match(nav, /href: '\/governance\/overrides'/);
    assert.match(nav, /href: '\/security\/incidents'/);
  });
});
