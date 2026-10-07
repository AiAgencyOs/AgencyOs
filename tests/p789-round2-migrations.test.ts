import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * A text pin on the round-two migrations (20261129*). Text can say a control is written down; only Postgres can say it works, and that is what the three
 * scripts/verify-p789-*.sql verifiers do (live doors, then red-proofs against the live definitions). This test holds the shape the verifiers rely on, so a
 * later edit cannot quietly drop a guard, a grant or the verifier itself.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = `${root}supabase/migrations/`;
const names = readdirSync(dir).filter((f) => /^20261129\d{6}_/.test(f)).sort();
const sql = names.map((f) => readFileSync(`${dir}${f}`, 'utf8')).join('\n');
const strip = sql.replace(/--.*$/gm, '');

describe('the round-two migrations', () => {
  test('there are three, inside the allotted range', () => {
    assert.equal(names.length, 3);
    for (const n of names) {
      const ts = Number(n.slice(0, 14));
      assert.ok(ts >= 20261129000000 && ts <= 20261129990000, n);
    }
  });
  test('no function sets the replication role, and nothing deletes or truncates', () => {
    assert.ok(!/session_replication_role/.test(strip));
    assert.ok(!/\btruncate\b/i.test(strip));
    assert.ok(!/\bdelete\s+from\b/i.test(strip));
    assert.ok(!/\bdrop\s+table\b/i.test(strip));
  });
  test('every p789 table has row security on, an internal read policy, no write for authenticated, and the door guard', () => {
    const tables = [...strip.matchAll(/create table if not exists (projects|finance)\.(p789_[a-z_]+)/g)].map((m) => ({ schema: m[1]!, table: m[2]! }));
    assert.ok(tables.length >= 12, `found ${tables.length}`);
    for (const { table } of tables) {
      assert.ok(new RegExp(`'${table}'`).test(strip) || new RegExp(`${table}`).test(strip), table);
    }
    // the shared loops: RLS, read policy, revoke and guard are applied to every name in their value lists
    for (const marker of ['enable row level security', 'revoke insert, update, delete on', 'execute function projects.p789_guard(', 'execute function core.freeze_organization_id()']) {
      assert.ok(strip.includes(marker), marker);
    }
    for (const { table } of tables) {
      const listed = new RegExp(`\\('${table}', `).test(strip) || new RegExp(`\\('(projects|finance)', '${table}', `).test(strip) || new RegExp(`alter table projects\\.${table} enable row level security`).test(strip);
      assert.ok(listed, `${table} is wired into a hardening loop`);
    }
  });
  test('the finance table is readable only by Admin and finance', () => {
    assert.match(strip, /if r\.sch = 'finance' then[\s\S]{0,400}core\.is_admin\(\)\) or \(select core\.is_finance\(\)\)/);
  });
  test('every door is revoked from public and anon; the person doors are also revoked from the service role', () => {
    const doors = [...strip.matchAll(/create or replace function ((?:projects|finance)\.p789_[a-z_]+|projects\.(?:render_completion_certificate))\(/g)].map((m) => m[1]!);
    assert.ok(doors.length >= 30, `found ${doors.length}`);
    for (const d of doors) assert.ok(strip.includes(`revoke all on function ${d}(`), `${d} is revoked from public`);
    for (const d of ['p789_set_admin_notification_policy', 'p789_acknowledge_admin_notification', 'p789_approve_provider_failover', 'p789_record_provider_failover_executed', 'p789_set_retention_class', 'p789_set_alert_rule', 'p789_acknowledge_alert', 'p789_create_task_from_followup', 'p789_review_feedback_signal_draft', 'p789_record_major_release']) {
      assert.match(strip, new RegExp(`revoke all on function projects\\.${d}\\([^)]*\\) from public, anon, service_role;`), d);
    }
  });
  test('the independent-approver rule is held by the door and by the table', () => {
    assert.match(strip, /constraint p789_pf_approver_is_independent check \(approved_by is null or approved_by <> recorded_by\)/);
    assert.match(strip, /if v_f\.recorded_by = v_actor then return query select 'self_approval'/);
  });
  test('the three verifiers exist, run through the real doors and carry red-proofs', () => {
    for (const f of ['verify-p789-phase-seven-round2.sql', 'verify-p789-phase-eight-round2.sql', 'verify-p789-feedback-signal.sql']) {
      assert.ok(existsSync(`${root}scripts/${f}`), f);
      const v = readFileSync(`${root}scripts/${f}`, 'utf8');
      assert.match(v, /RED-PROOF NO-OP/);
      assert.match(v, /rollback;\s*$/);
      assert.ok([...v.matchAll(/pg_temp\.red\(/g)].length >= 9, `${f} red-proofs`);
    }
  });
});
