import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { DEFAULT_WINDOW, failureTitle, FUNNEL_CHANNEL_LABEL, RECOMMENDATION_TITLE, recommendationLine, revenueLine, WINDOWS, windowFrom } from '../src/modules/acquisition/analytics-vocabulary.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261023100000_results_are_read_from_the_crm_and_failures_are_loud.sql');
const verifier = read('scripts/verify-acquisition-analytics.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

describe('lead generation, slice 11 - results are read from the CRM and failures are loud', () => {
  describe('every analytic is a read that cannot write and cannot cross a tenant', () => {
    const names = ['crm.acquisition_funnel', 'crm.acquisition_goal_progress', 'crm.acquisition_failures', 'crm.acquisition_recommendations'];
    test('each is STABLE SQL, revoked from anon and public, and granted to signed-in users and the engine', () => {
      for (const n of names) {
        const body = fn(n);
        assert.match(body, /language sql stable security definer set search_path = ''/, n);
        assert.match(sql, new RegExp(`revoke all on function ${n.replace('.', '\\.')}\\([^)]*\\) from public, anon;`), n);
        assert.match(sql, new RegExp(`grant execute on function ${n.replace('.', '\\.')}\\([^)]*\\) to authenticated, service_role;`), n);
        assert.doesNotMatch(body, /\b(insert into|update |delete from)\b/i, `${n} must not write`);
      }
    });

    test('a session sees only its own organisation (the service role, with no session, sees all)', () => {
      for (const n of names.slice(0, 3)) assert.match(fn(n), /k\.uid is null or [a-z]+\.organization_id = k\.org|select k\.uid from caller k\) is null or/, n);
      assert.match(fn('crm.acquisition_recommendations'), /\(k\.uid is null or u\.organization_id = k\.org\)/, 'the advice reads usage for the caller\'s organisation only');
    });

    test('every table the failures list reads is scoped to the caller', () => {
      const body = fn('crm.acquisition_failures');
      const froms = body.match(/from (crm|core)\.[a-z_]+ [a-z]+/g) ?? [];
      assert.ok(froms.length >= 12, `found ${froms.length} reads`);
      const scoped = (body.match(/\(k\.uid is null or [a-z]+\.organization_id = k\.org\)/g) ?? []).length;
      assert.ok(scoped >= froms.length, `${scoped} scoped of ${froms.length}`);
    });
  });

  describe('attribution is honest about what it is', () => {
    test('a lead is credited to its FIRST touch, with last-touch and touched-by counts from the same rows', () => {
      const body = fn('crm.acquisition_funnel');
      assert.match(body, /ft as \([\s\S]*order by t\.lead_id, t\.occurred_at, t\.recorded_at, t\.id/);
      assert.match(body, /lt as \([\s\S]*order by t\.lead_id, t\.occurred_at desc, t\.recorded_at desc, t\.id desc/);
      assert.match(body, /touched as/);
    });

    test('revenue is grouped by currency and never summed across them', () => {
      assert.match(fn('crm.acquisition_funnel'), /jsonb_object_agg\(cur, s\)[\s\S]*group by ch, cur/);
    });

    test('a cost with no spend or nothing to divide by is null, and a thin sample is marked', () => {
      const body = fn('crm.acquisition_funnel');
      assert.match(body, /case when count\(p\.id\) > 0 and coalesce\(\(select s\.s from spend s where s\.ch = c\.ch\), 0\) > 0 then/);
      assert.match(body, /coalesce\(count\(p\.id\), 0\) < 10/);
    });

    test('the channel list is the five engines plus "other", in a fixed order', () => {
      assert.match(sql, /array\['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other'\]/);
      for (const c of ['meta_ads', 'email', 'social', 'google_ads', 'b2b', 'other']) assert.ok(FUNNEL_CHANNEL_LABEL[c], c);
    });
  });

  describe('goals', () => {
    test('a channel with no goal has no pace and no percentage', () => {
      const body = fn('crm.acquisition_goal_progress');
      assert.match(body, /when c\.monthly_qualified_target is not null and c\.monthly_qualified_target > 0/);
      assert.match(body, /when c\.monthly_budget_minor is not null and c\.monthly_budget_minor > 0/);
      assert.match(body, />= c\.monthly_qualified_target \* 0\.8/);
    });
  });

  describe('failures are one list, worst first', () => {
    test('an unknown outcome is critical; a success is never listed; only the acquisition workers\' alerts are', () => {
      const body = fn('crm.acquisition_failures');
      assert.match(body, /case when e\.status = 'unknown' or \(e\.status = 'failed' and e\.attempt >= 3\) then 'critical' else 'warning' end/);
      assert.match(body, /where e\.status in \('failed', 'unknown'\)/);
      assert.match(body, /a\.source in \('social_publishing', 'ad_operations', 'landing_pages', 'b2b_operations'\)/);
      assert.match(body, /order by case r\.severity when 'critical' then 0 when 'warning' then 1 else 2 end/);
    });

    test('every worker source the TypeScript alerts under is one the list reads', () => {
      const sources = new Set<string>();
      for (const file of ['social.ts', 'ads.ts', 'landing.ts', 'b2b.ts']) for (const m of read(`src/modules/acquisition/${file}`).matchAll(/p_source: '([a-z0-9_]+)'/g)) sources.add(m[1] as string);
      assert.deepEqual([...sources].sort(), ['ad_operations', 'b2b_operations', 'landing_pages', 'social_publishing']);
      for (const s of sources) assert.ok(fn('crm.acquisition_failures').includes(`'${s}'`), s);
    });

    test('every kind the database can emit has a title (suffixed kinds by prefix)', () => {
      const body = fn('crm.acquisition_failures');
      const kinds = [...body.matchAll(/select '([a-z_]+)'(?:\s*\|\|[^,]+)?,/g)].map((m) => m[1] as string).filter((k) => !k.endsWith('_'));
      assert.ok(kinds.length >= 8, `found ${kinds.length}`);
      for (const k of [...kinds, 'execution_failed', 'execution_unknown', 'connection_degraded', 'connection_revoked']) assert.notEqual(failureTitle(k), k.replaceAll('_', ' '), `${k} has no title`);
      assert.match(failureTitle('campaign_zero_delivery'), /zero delivery/);
    });
  });

  describe('advice is advice', () => {
    test('every recommendation the database can give has a title and a sentence built from its numbers', () => {
      const body = fn('crm.acquisition_recommendations');
      const recs = [...body.matchAll(/select [a-z.]+channel, '([a-z_]+)'/g)].map((m) => m[1] as string);
      assert.ok(recs.length >= 5, `found ${recs.length}`);
      for (const r of recs) {
        assert.ok(RECOMMENDATION_TITLE[r], `${r} has no title`);
        assert.notEqual(recommendationLine(r, { target: 5, qualified_so_far: 1, pace_pct: 30, days_elapsed: 12, budget_used_pct: 92, days_in_month: 30, actions: 12, leads: 0 }), r.replaceAll('_', ' '), r);
      }
    });
    test('a sentence says what it rests on and never claims to have changed anything', () => {
      const line = recommendationLine('behind_pace_for_the_monthly_goal', { target: 5, qualified_so_far: 1, pace_pct: 30, days_elapsed: 12 });
      assert.match(line, /1 qualified so far against a goal of 5/);
      assert.match(line, /nothing has been changed/);
      assert.match(recommendationLine('too_early_to_judge', { leads: 1 }), /Only 1 lead so far/);
      assert.match(recommendationLine('too_early_to_judge', { leads: 4 }), /Only 4 leads so far/);
    });
    test('the cost comparison needs both ad channels past the thin-sample line', () => {
      assert.match(fn('crm.acquisition_recommendations'), /where channel in \('meta_ads', 'google_ads'\) and not insufficient_data and cost_per_qualified_minor is not null/);
    });
  });

  describe('the page words', () => {
    test('revenue is shown per currency, never as one total', () => {
      assert.equal(revenueLine({ INR: 5000000, USD: 120000 }), 'INR 50,000 + USD 1,200');
      assert.equal(revenueLine({}), '-');
      assert.equal(revenueLine(null), '-');
    });
    test('the window defaults to 90 days and ignores anything it does not offer', () => {
      assert.equal(DEFAULT_WINDOW, 90);
      assert.deepEqual(WINDOWS.map((w) => w.days), [30, 90, 365]);
      assert.equal(windowFrom('30'), 30);
      assert.equal(windowFrom('9999'), 90);
      assert.equal(windowFrom(undefined), 90);
      assert.equal(windowFrom("1; drop table crm.leads"), 90);
    });
  });

  describe('the verifier proves it on a real database', () => {
    test('it builds leads with histories across channels and is wired into the verify chain', () => {
      for (const part of ['crm.acquisition_funnel(90)', 'crm.acquisition_failures(100)', 'finish_governed_execution', 'another organisation gets none of our advice', 'ALL CHECKS PASSED']) assert.ok(verifier.includes(part), part);
      assert.match(read('package.json'), /verify-acquisition-analytics\.sql/);
    });
  });
});
