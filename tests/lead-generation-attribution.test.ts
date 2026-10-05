import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261025100000_attribution_is_shown_four_ways_and_over_time.sql');

describe('lead generation follow-up - attribution four ways, and over time', () => {
  test('both functions are STABLE reads for an internal session of its own organisation only; with no session they answer with nothing', () => {
    for (const n of ['acquisition_attribution_models', 'acquisition_trend']) {
      const start = sql.indexOf(`create or replace function crm.${n}(`);
      const body = sql.slice(start, sql.indexOf('\n$$;', start));
      assert.match(body, /language sql stable security definer set search_path = ''/);
      assert.match(body, /k\.uid is not null and k\.internal and l\.organization_id = k\.org/);
      assert.doesNotMatch(body, /\b(insert into|update |delete from)\b/i);
      assert.match(sql, new RegExp(`revoke all on function crm\\.${n}\\([^)]*\\) from public, anon;`));
    }
  });

  test('the four models and their weights: 40/20/40, two channels 50/50, first = last takes 80%', () => {
    assert.match(sql, /when f\.ch = l\.ch then case when c\.ch = f\.ch then 0\.8 else 0\.2 \/ \(n\.k - 1\) end/);
    assert.match(sql, /when n\.k = 2 then 0\.5/);
    assert.match(sql, /when c\.ch = f\.ch or c\.ch = l\.ch then 0\.4/);
    assert.match(sql, /else 0\.2 \/ \(n\.k - 2\)/);
    assert.match(sql, /sum\(1\.0 \/ n\.k\)/);
  });

  test('the window is bounded and the verifier is wired into the chain', () => {
    assert.match(sql, /least\(coalesce\(p_weeks, 12\), 52\)/);
    assert.match(sql, /least\(coalesce\(p_days, 90\), 730\)/);
    assert.match(read('package.json'), /verify-acquisition-attribution\.sql/);
    assert.match(read('app/(internal)/lead-generation/performance/page.tsx'), /Credit, four ways/);
  });
});
