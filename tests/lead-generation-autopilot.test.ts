import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261031200000_the_acquisition_agents_start_their_week_when_asked_to.sql');
const route = read('app/api/jobs/run/route.ts');
const page = read('app/(internal)/lead-generation/page.tsx');
const runStart = sql.indexOf('create or replace function crm.run_acquisition_autopilot(');
const run = sql.slice(runStart, sql.indexOf('\n$$;', runStart));

describe('lead generation - the weekly autopilot (ADM-114)', () => {
  test('it is opt-in, off until an admin turns it on, and service-role only to run', () => {
    assert.match(sql, /enabled boolean not null default false/);
    assert.match(sql, /where p\.enabled loop/);
    assert.match(sql, /revoke all on function crm\.run_acquisition_autopilot\(timestamptz\) from public, anon, authenticated;/);
    assert.match(sql, /crm\._social_caller_ok\(p_organization_id, true\)/);
  });

  test('it queues only the same jobs a person queues, so every guard those jobs have still applies', () => {
    for (const k of ['ads.assist', 'email.assist', 'social.assist', 'marketplace.assist']) assert.ok(run.includes(`'${k}'`), k);
    assert.match(run, /insert into core\.jobs/);
    assert.doesNotMatch(run, /pg_net|http_|crm\.(send|publish|launch|deploy|approve|apply)/i);
  });

  test('a stop, the plan, an enabled agent and the ISO week all gate it', () => {
    assert.match(run, /crm\.acquisition_blocked\(o\.id, c\) is null/);
    assert.match(run, /ch\.enabled/);
    assert.match(run, /g\.key = a\.agent and g\.enabled/);
    assert.match(run, /'autopilot:' \|\| a\.kind \|\| ':' \|\| v_week/);
    assert.match(run, /isodow from v_local\) = 1 and extract\(hour from v_local\) < 9/);
  });

  test('its standing tasks only ask for drafts and approval, never an act on a platform', () => {
    const tasks = run.slice(run.indexOf("('ad_manager'"), run.indexOf(') as t(agent'));
    assert.match(tasks, /Submit for approval only what passes/);
    assert.match(tasks, /with no price/);
    assert.doesNotMatch(tasks, /\b(launch it|publish it|send it|deploy it|approve it)\b/i);
  });

  test('the job runner calls it every tick, and the Overview offers the switch to an admin only', () => {
    assert.match(route, /rpc\('run_acquisition_autopilot'\)/);
    assert.match(page, /mayManage \? <AutopilotForm/);
  });
});
