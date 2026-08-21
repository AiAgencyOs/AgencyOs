import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const migrations = readdirSync(join(root, 'supabase/migrations'));
const read = (needle: string) =>
  migrations
    .filter((f) => f.includes(needle))
    .map((f) => readFileSync(join(root, 'supabase/migrations', f), 'utf8'))
    .join('\n');

const migration = read('maintenance_is_specified_after_all');
/** The SQL with both forms of prose removed — see tests/payment-verification. */
const sql = migration
  .replace(/comment on [\s\S]*?';/g, '')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

/**
 * Maintenance is specified after all.
 *
 * The refusals are triggers and constraints, proved against real Postgres by
 * `db:verify:maintenance`. What this file protects is the three ABSENCES and
 * the reason the earlier migration was minimal — both of which read as
 * omissions to anybody who has not read Doc 18 and ADM-22 side by side.
 */
describe('Doc 18 — maintenance, and the three things it deliberately does not get', () => {
  test('the earlier migration measured against the wrong corpus, and this says so', () => {
    // `work_that_comes_after_handover` opens: "The business documentation
    // defines maintenance nowhere." Document 18 is twelve pages of it. Being
    // minimal was still right — it added no price, no SLA, no due date, no
    // tier, and every one of those refusals holds up against Doc 18.
    assert.ok(migration, 'the migration is missing');
    assert.match(migration, /Document 18 is\n-- \*\*twelve pages of it\*\*|twelve pages of it/);
    const earlier = read('work_that_comes_after_handover');
    assert.match(earlier, /defines maintenance \*\*nowhere\*\*/, 'the earlier claim is no longer there to correct');
  });

  test('a plan has no price — ADM-22 wins over Doc 18 §3', () => {
    // §3 says a plan has a price. ADM-22: "There is no price catalog. Every
    // price is quoted per client by a human." A tiered plan carrying a price
    // IS a catalog, so the price lives on the sales.proposals row the plan
    // references — exactly how Doc 11 resolved this for change requests.
    assert.doesNotMatch(sql, /price_minor|amount_minor|rate_minor/);
    assert.match(sql, /accepted_proposal_id uuid references sales\.proposals/);
    // §10: "Renewal cannot be silently assumed."
    assert.match(sql, /maintenance_plans_acceptance_is_evidenced/);
    assert.match(sql, /status not in \('active', 'renewed'\)/);
  });

  test('there is no health score and no health status', () => {
    // §12 lists the signals and then says "Each signal should have
    // configurable weight". Nobody has configured one. Third time this system
    // has declined to invent a weight, after ADM-88 and Doc 14 §19.
    assert.doesNotMatch(sql, /\b(weight|health_score|health_status)\b/i);
    assert.match(sql, /returns table \(\s*\n\s*signal text,\s*\n\s*value {2}text\s*\n\)/);
  });

  test('and no VIP flag, declined before it is created rather than after', () => {
    // §15: "VIP status is configurable by Admin policy" and "should not be
    // based solely on an AI agent's subjective judgment"; §35: "Never claim a
    // client is VIP without configured criteria."
    //
    // This is ADM-88's lesson applied forwards: an empty flag beside a client
    // account is exactly the invitation `crm.leads.score` turned out to be.
    assert.doesNotMatch(sql, /\bvip\b/i);
  });

  test('§6 decides which exit a ticket may take, and both exits already existed', () => {
    // §35 "Never classify new scope as maintenance to avoid approval" and §18
    // "Do not label a bug as a paid feature" are the same rule in two
    // directions, and both cost somebody money.
    assert.match(sql, /coverage in \('warranty', 'maintenance', 'change_request', 'new_project', 'upsell'\)/);
    assert.match(sql, /change_request_id uuid references projects\.change_requests/);
    assert.match(sql, /upsell_signal_id uuid references sales\.upsell_signals/);
    // Nothing new was invented for the routing: Doc 11's change requests and
    // G-036's upsell signals were both already here.
    assert.doesNotMatch(sql, /create table if not exists projects\.change_requests/);
    assert.doesNotMatch(sql, /create table if not exists sales\.upsell_signals/);
  });

  test('classification is required to CLOSE a ticket, not to open one', () => {
    // §7 puts CLASSIFY after CLIENT REQUEST. Demanding a classification at
    // insert would refuse the request before anybody has read it.
    const fn = sql.slice(sql.indexOf('function projects.refuse_miscoded_maintenance'));
    assert.match(fn, /if new\.status not in \('resolved', 'declined'\) then\s*\n\s*return new;/);
    // And declining an out-of-scope request without opening a change request
    // is the correct outcome, not an evasion.
    assert.match(fn, /if new\.status = 'declined' then\s*\n\s*return new;/);
  });

  test('§5 is enforced only where the facts are recorded', () => {
    // Two of its seven conditions are recorded facts. The others — "technical
    // ownership/access is sufficient", "maintenance offering is compatible
    // with the project" — are judgements nothing records, and a check that
    // guesses them would refuse real work for a reason nobody can inspect.
    assert.match(sql, /from projects\.handovers h/);
    assert.match(migration, /§5's eligibility list is not fully enforced/);
  });

  test('the twelve §8 ticket types are used as written', () => {
    for (const t of ['production_bug', 'security_update', 'dependency_update', 'performance',
                     'content_change', 'minor_ui', 'monitoring_alert', 'backup_recovery',
                     'access_support', 'new_feature', 'integration_change', 'upgrade_migration']) {
      assert.ok(sql.includes(`'${t}'`), `Doc 18 §8 names ${t} and the CHECK does not`);
    }
  });
});
