import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261031100000_the_week_in_lead_generation_is_told_once.sql');
const route = read('app/api/jobs/run/route.ts');

describe('lead generation - the week is told once (scheduled digest)', () => {
  test('it is a service-role-only door that writes one info alert and nothing outside the application', () => {
    assert.match(sql, /revoke all on function crm\.run_acquisition_digest\(timestamptz\) from public, anon, authenticated;/);
    assert.match(sql, /grant execute on function crm\.run_acquisition_digest\(timestamptz\) to service_role;/);
    assert.match(sql, /core\.raise_alert\(o\.id, 'acquisition', 'info'/);
    assert.doesNotMatch(sql, /pg_net|http_|net\./i);
  });

  test('it is told once per ISO week in any alert state, and says nothing when nothing happened', () => {
    assert.match(sql, /to_char\(p_now, 'IYYY-"W"IW'\)/);
    assert.match(sql, /where a\.organization_id = o\.id and a\.fingerprint = v_fp\) then continue/);
    assert.match(sql, /if v_text = '' and v_wait = 0 then continue/);
  });

  test('it never guesses a cost: the figures come from agent_results, which leaves a cost with nothing to divide by empty', () => {
    assert.match(sql, /crm\.agent_results\(o\.id, 7\)/);
    assert.match(sql, /too few leads to judge/);
  });

  test('the job runner calls it every tick, and a failure is logged and ignored', () => {
    assert.match(route, /rpc\('run_acquisition_digest'\)/);
    assert.match(route, /acquisition digest: \$\{digest\.error\.message\}/);
  });
});
