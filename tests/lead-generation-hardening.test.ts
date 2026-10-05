import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { ENGINE_STATUS } from '../src/modules/acquisition/schema.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261024100000_independent_review_findings_closed.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  const end = [sql.indexOf('\n$function$;', start), sql.indexOf('\n$$;', start)].filter((i) => i > 0).sort((a, b) => a - b)[0] as number;
  return sql.slice(start, end);
};

describe('lead generation, slice 12 - what three independent reviews found, closed', () => {
  describe('tenancy and privilege', () => {
    test('another organisation\'s qualification weights are not returned', () => {
      assert.match(fn('crm.current_qualification_weights'), /p_organization_id = \(select core\.current_organization_id\(\)\) and \(select core\.is_internal\(\)\)/);
    });

    test('the policy question, the lead outcome, the post status and every read function refuse a portal client', () => {
      assert.match(fn('crm.acquisition_decide'), /not coalesce\(\(select core\.is_internal\(\)\), false\)[\s\S]*'not_internal'/);
      assert.match(fn('crm.lead_outcome'), /\(select core\.is_internal\(\)\)/);
      assert.match(fn('crm.content_status'), /not coalesce\(\(select core\.is_internal\(\)\), false\) then return null/);
      for (const n of ['crm.acquisition_funnel', 'crm.acquisition_goal_progress', 'crm.acquisition_failures', 'crm.acquisition_recommendations', 'crm.ad_outcomes', 'crm.b2b_outcomes']) {
        assert.match(fn(n), /k\.internal|core\.is_internal/, `${n} must check is_internal`);
      }
    });

    test('with no session the cross-channel reads answer with nothing, so no aggregate can span tenants', () => {
      for (const n of ['crm.acquisition_funnel', 'crm.acquisition_goal_progress', 'crm.acquisition_recommendations']) {
        const body = fn(n);
        assert.match(body, /k\.uid is not null and k\.internal/, n);
        assert.doesNotMatch(body, /k\.uid is null/, `${n} must not treat "no session" as "every organisation"`);
      }
    });

    test('binding an approval is an admin\'s act, and a handoff token hash is unique across the database', () => {
      assert.match(fn('crm.bind_approval'), /not coalesce\(\(select core\.is_admin\(\)\), false\) then\s+return query select 'forbidden'/);
      assert.match(sql, /create unique index if not exists channel_handoffs_token_hash_global_key on crm\.channel_handoffs \(token_hash\)/);
    });

    test('the landing address cannot be an IP literal or an internal name, in the table and again at the moment of the fetch', async () => {
      assert.match(sql, /landing_versions_public_url_host[\s\S]*\(\[0-9\]\{1,3\}\\\.\)\{3\}/);
      const { isPublicHttpsAddress } = await import('../src/modules/acquisition/landing.ts');
      for (const ok of ['https://lp.example.com/page', 'https://www.example.co.uk/a/b']) assert.equal(isPublicHttpsAddress(ok), true, ok);
      for (const bad of ['http://lp.example.com/', 'https://10.0.0.5/page', 'https://127.0.0.1/', 'https://localhost/x', 'https://intranet.corp/x', 'https://lp.example.com:8443/x', 'https://user:pw@lp.example.com/', 'https://[::1]/', 'https://nodots/x', 'not a url'])
        assert.equal(isPublicHttpsAddress(bad), false, bad);
    });
  });

  describe('governed execution', () => {
    test('in-flight work counts against the daily limit; committed budget counts against the monthly cap', () => {
      assert.match(fn('crm.acquisition_decide'), /e\.status in \('executing', 'unknown'\)/);
      assert.match(fn('crm._manual_gate'), /e\.status in \('executing', 'unknown'\)/);
      assert.match(fn('crm.begin_ad_apply'), /crm\._ad_committed_over_cap\(p_organization_id, v\.id\)/);
      assert.match(fn('crm._ad_committed_over_cap'), /o\.state in \('LIVE', 'LAUNCHING'\)/);
      assert.match(fn('crm._b2b_begin_submit'), /p\.state = 'SUBMITTING' and p\.id <> v\.id/);
    });

    test('a channel outside the plan does not act - except email, which a new switch must not stop', () => {
      assert.match(fn('crm.acquisition_decide'), /v_channel not in \('none', 'email'\)[\s\S]*'channel_not_enabled'/);
      assert.match(fn('crm._manual_gate'), /p_channel <> 'email' and not coalesce\(ch\.enabled, false\)/);
    });

    test('the connector for the version\'s OWN social platform is required', () => {
      assert.match(fn('crm.begin_content_publish'), /i\.provider = case ci\.platform when 'facebook' then 'facebook_page' else ci\.platform end/);
    });

    test('all four finishing doors refuse an execution that belongs to another artifact', () => {
      for (const n of ['crm.record_publish', 'crm.record_ad_apply', 'crm.record_landing_deploy', 'crm._b2b_finish_submit']) {
        const body = fn(n);
        assert.match(body, /e\.id = p_execution and e\.organization_id = p_organization_id and e\.artifact_id = v\.id/, n);
        assert.ok(body.indexOf("'wrong_execution'") < body.indexOf('finish_governed_execution('), `${n} checks before it finishes`);
      }
    });

    test('a person\'s recorded B2B submission and profile update are held to the same gate as everything else', () => {
      assert.match(fn('crm._b2b_begin_submit'), /crm\._manual_gate\(p_organization_id, 'b2b', 'b2b_proposal_submit', 0\)/);
      assert.match(fn('crm.record_manual_profile_update'), /crm\._manual_gate\(p_organization_id, 'b2b', 'profile_update', 0\)/);
    });

    test('a price needs a signed-in person in the door and in the table; lifting an owner\'s block is the owner\'s; a daily rate rise is an increase', () => {
      assert.match(fn('crm.add_b2b_proposal_version'), /\(select auth\.uid\(\)\) is null/);
      assert.match(sql, /check \(price_minor is null or \(created_by_type = 'human' and created_by is not null\)\)/);
      assert.match(fn('crm.set_acquisition_policy'), /v_before ->> 'mode' = 'block' and p_mode <> 'block'/);
      assert.match(fn('crm.ad_version_stamp'), /new\.budget_daily_minor > p\.budget_daily_minor/);
    });
  });

  describe('the by-hand path is real', () => {
    const doors = ['crm.record_manual_ad_apply', 'crm.record_manual_publish', 'crm.record_manual_landing_deploy'];
    test('every by-hand door needs an admin, asks the same questions as the engine, and goes through the one governed execution', () => {
      for (const n of [...doors, 'crm.record_manual_ad_change', 'crm.record_manual_ad_metrics']) assert.match(fn(n), /crm\._social_caller_ok\(p_organization_id, true\)/, n);
      for (const n of doors) {
        const body = fn(n);
        assert.match(body, /crm\._manual_gate\(/, n);
        assert.match(body, /crm\.begin_governed_execution\(p_organization_id, v\.approval_request_id, '(ad_campaign|social_content|acquisition_action)', v\.id, v\.content_hash/, n);
      }
    });

    test('a hand-uploaded landing page is DEPLOYED, never VERIFIED: only a fetch of the public address can verify it', () => {
      const body = fn('crm.record_manual_landing_deploy');
      assert.doesNotMatch(body, /_landing_set_state\([^)]*'VERIFIED'\)|record_landing_verification/);
      assert.match(body, /_landing_set_state\(v\.id, 'DEPLOYING'\)/);
      const service = read('src/modules/acquisition/service.ts');
      assert.match(service, /verifyLandingVersion\(admin, \{ organizationId: gate\.data\.organizationId, versionId \}\)/);
    });

    test('a hand-recorded Google launch still needs a VERIFIED page, read at that moment', () => {
      assert.match(fn('crm.record_manual_ad_apply'), /lv\.state = 'VERIFIED'[\s\S]*'landing_page_not_verified'/);
    });

    test('the helpers are reachable by nobody, the doors by admin sessions only', () => {
      for (const f of ['_manual_gate(uuid, text, text, bigint)', '_ad_committed_over_cap(uuid, uuid)']) assert.match(sql, new RegExp(`revoke all on function crm\\.${f.replace(/[()]/g, '\\$&')} from public, anon, authenticated`), f);
      for (const f of ['record_manual_ad_apply(uuid, uuid, text, jsonb)', 'record_manual_ad_change(uuid, uuid, boolean, text)', 'record_manual_ad_metrics(uuid, uuid, date, bigint, bigint, bigint, bigint)', 'record_manual_publish(uuid, uuid, text, text)', 'record_manual_landing_deploy(uuid, uuid, text)']) {
        assert.match(sql, new RegExp(`revoke all on function crm\\.${f.replace(/[()]/g, '\\$&')} from public, anon;`), f);
        assert.match(sql, new RegExp(`grant execute on function crm\\.${f.replace(/[()]/g, '\\$&')} to authenticated;`), f);
      }
    });

    test('the screens offer every by-hand record the alerts promise', () => {
      const page = read('app/(internal)/lead-generation/[channel]/page.tsx');
      for (const part of ['RecordLaunchForm', 'AdChangeDoneForm', 'AdFiguresForm', 'RecordPostedForm', 'RecordUploadedForm', 'RecheckLandingButton']) assert.ok(page.includes(`<${part}`), `${part} is not on the page`);
      assert.ok(existsSync(new URL('../app/api/landing/[versionId]/page/route.ts', import.meta.url)), 'the approved page can be downloaded');
      const alerts = ['ads.ts', 'social.ts', 'landing.ts'].map((f) => read(`src/modules/acquisition/${f}`)).join('\n');
      assert.match(alerts, /I applied it - record it/);
      assert.match(alerts, /I posted it - record it/);
      assert.match(alerts, /download the approved page from the Google tab/);
      assert.match(read('app/(internal)/lead-generation/ads-forms.tsx'), /I applied it - record it/);
      assert.match(read('app/(internal)/lead-generation/social-forms.tsx'), /I posted it - record it/);
    });
  });

  describe('honesty', () => {
    test('a caller cannot claim an adapter exists; the engine records it', () => {
      assert.match(fn('crm.register_integration'), /false, 'NOT_IMPLEMENTED', v_actor\)/);
      const integrations = read('src/modules/acquisition/integrations.ts');
      assert.match(integrations, /p_adapter_implemented: false/);
      assert.match(integrations, /rpc\('sync_integration_adapter'/);
    });

    test('no engine summary claims what is not there', () => {
      assert.doesNotMatch(ENGINE_STATUS.meta_ads.summary, /pause that reaches the money|reaches the money,/);
      assert.match(ENGINE_STATUS.meta_ads.summary, /pause cannot reach the money by itself/);
      assert.match(ENGINE_STATUS.meta_ads.summary, /figures a person copies in/);
      assert.match(ENGINE_STATUS.google_ads.summary, /FETCHES the public address/);
      assert.doesNotMatch(ENGINE_STATUS.email.summary, /drafts are checked against recorded research;/);
      assert.match(ENGINE_STATUS.email.summary, /nothing writes drafts yet/);
    });

    test('the pages no longer print a "still to come" list that includes things that are built', () => {
      const page = read('app/(internal)/lead-generation/[channel]/page.tsx');
      assert.doesNotMatch(page, /Still to come on this tab|const SOON/);
      assert.match(page, /o\.spendMinor > 0 \? inr\(o\.spendMinor\) : '-'/);
    });

    test('what the Email and handoff screens promise can be done from a screen', () => {
      const page = read('app/(internal)/lead-generation/[channel]/page.tsx');
      for (const part of ['ScoreProspectForm', 'RecordFactForm', 'CheckDraftForm']) assert.ok(page.includes(`<${part}`), part);
      assert.ok(read('app/(internal)/lead-generation/identity/page.tsx').includes('<TrackedLinkForm'));
    });
  });

  describe('secrets and hygiene', () => {
    test('the handoff reference key is the vault key, domain-separated, with no borrowed fallback', () => {
      const handoff = read('src/modules/acquisition/handoff.ts');
      assert.match(handoff, /handoff-reference:v1:/);
      assert.doesNotMatch(handoff, /CRON_SECRET/);
    });

    test('a malformed percent-escape on the public handoff link is the same redirect, never an error', () => {
      const route = read('app/api/handoff/[code]/route.ts');
      assert.match(route, /try \{ decoded = decodeURIComponent\(raw\); \} catch \{ return home; \}/);
    });

    test('a worker that cannot read what it needs says so instead of reporting "nothing to do"', () => {
      for (const f of ['ads.ts', 'landing.ts', 'b2b.ts']) {
        const body = read(`src/modules/acquisition/${f}`);
        assert.ok((body.match(/Error\) throw new Error\(`could not read/g) ?? []).length >= 2, `${f} must check its reads`);
        assert.match(body, /could not close lapsed approvals/, f);
      }
    });

    test('the landing verifier does not follow redirects and bounds what it reads', () => {
      const landing = read('src/modules/acquisition/landing.ts');
      assert.match(landing, /redirect: 'manual'/);
      assert.match(landing, /MAX_BODY_CHARS/);
      assert.doesNotMatch(landing, /redirect: 'follow'/);
    });
  });

  describe('the red-proofs are an artifact, not a claim', () => {
    const cases = JSON.parse(read('scripts/redproof/cases.json')) as Record<string, { kind?: string; test?: string; migration: string; verifier: string; cases: { name: string; find?: string; file?: string; edits?: { find: string }[]; migration?: string; ddl?: boolean }[] }>;

    test('every case names a migration and verifier that exist, and its text really occurs there (a stale case would silently prove nothing)', () => {
      let total = 0;
      for (const [slice, spec] of Object.entries(cases)) {
        if (spec.kind === 'ts') {
          assert.ok(existsSync(new URL(`../${spec.test}`, import.meta.url)), `${slice} test`);
          for (const c of spec.cases) { total += 1; assert.ok(read(c.file as string).includes(c.find as string), `${slice}: "${c.name}" no longer matches ${c.file}`); }
          continue;
        }
        assert.ok(existsSync(new URL(`../${spec.verifier}`, import.meta.url)), `${slice} verifier`);
        for (const c of spec.cases) {
          total += 1;
          if (c.ddl) continue;
          const migration = read(c.migration ?? spec.migration);
          for (const f of c.edits?.map((e) => e.find) ?? [c.find as string]) assert.ok(migration.includes(f), `${slice}: "${c.name}" no longer matches its migration`);
        }
      }
      assert.ok(total >= 100, `found ${total} cases`);
    });

    test('every case has a distinct name within its slice', () => {
      for (const [slice, spec] of Object.entries(cases)) assert.equal(new Set(spec.cases.map((c) => c.name)).size, spec.cases.length, slice);
    });

    test('the documents quote the harness\'s counts, not remembered ones', () => {
      const counts = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.cases.length]));
      const doc = read('docs/lead-generation/GAP_MATRIX_AND_BACKLOG.md');
      assert.match(doc, new RegExp(`scripts/redproof/cases\\.json[^\\n]*${counts.ads} ads, ${counts.landing} landing, ${counts.b2b} B2B, ${counts.analytics} analytics, ${counts.hardening} hardening, ${counts.landing_ts} landing TypeScript, ${counts.b2b_ts} B2B TypeScript`));
    });
  });
});
