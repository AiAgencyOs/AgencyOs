import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { AD_PROVIDERS } from '../src/modules/acquisition/adapters.ts';
import { AD_PLATFORMS, adActionFor, CHANGE_KINDS, CHANGE_LABEL, HEALTH_WORDS, planProblemWords, RECOMMENDATION_WORDS, VERSION_STATE_WORDS } from '../src/modules/acquisition/ad-vocabulary.ts';
import { applyAdVersion, runAdOperations, type AdProvider } from '../src/modules/acquisition/ads.ts';
import { NEVER_AUTO_ACTIONS } from '../src/modules/acquisition/policy-vocabulary.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261020100000_an_ad_campaign_launches_as_exactly_what_was_approved.sql');
const verifier = read('scripts/verify-acquisition-ads.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

type Script = { begin?: unknown; record?: unknown; version?: Record<string, unknown> | null; waiting?: unknown[]; approvalState?: string; pending?: unknown[]; running?: unknown[] };

function fakeAdmin(script: Script) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    schema(name: string) {
      return {
        rpc: async (fnName: string, args: Record<string, unknown>) => {
          calls.push({ fn: `${name}.${fnName}`, args });
          if (fnName === 'begin_ad_apply') return { data: script.begin ?? [{ outcome: 'blocked', reason: 'x', execution_id: null }], error: null };
          if (fnName === 'record_ad_apply') return { data: script.record ?? [{ outcome: 'recorded' }], error: null };
          if (fnName === 'pending_ad_changes') return { data: script.pending ?? [], error: null };
          if (fnName === 'sync_ad_approvals' || fnName === 'enforce_ad_stops') return { data: 0, error: null };
          return { data: null, error: null };
        },
        from(table: string) {
          const rows = (): unknown => {
            if (table === 'ad_campaign_versions') return script.waiting ?? [];
            if (table === 'ad_campaigns') return script.running ?? [];
            return [];
          };
          const single = (): unknown => {
            if (table === 'ad_campaign_versions') return script.version === undefined ? { campaign_id: 'camp', plan: { destination: { type: 'whatsapp' } }, budget_daily_minor: 100000, budget_total_minor: null, start_date: null, end_date: null, content_hash: 'a'.repeat(64), change_kind: 'launch' } : script.version;
            if (table === 'ad_campaigns') return { platform: 'meta_ads', name: 'Camp', currency: 'INR', live_version_id: null };
            if (table === 'approval_requests') return { state: script.approvalState ?? 'approved' };
            return null;
          };
          const chain: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit']) chain[m] = () => chain;
          chain.maybeSingle = async () => ({ data: single(), error: null });
          chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
          return chain;
        },
      };
    },
  } as never;
  return { admin, calls };
}

const okProvider = (over: Partial<AdProvider> = {}): { provider: AdProvider; seen: unknown[] } => {
  const seen: unknown[] = [];
  return { seen, provider: { apply: async (i) => { seen.push(i); return { status: 'applied', providerCampaignId: 'prov-1', objects: [{ objectType: 'ad', providerId: 'AD-1' }] }; }, ...over } };
};

describe('lead generation, slice 8 - an ad campaign launches as exactly what was approved', () => {
  describe('versions are immutable and the hash and kind of change cannot be forged', () => {
    test('the hash and the change kind are derived by a BEFORE INSERT trigger', () => {
      assert.match(sql, /create trigger ad_version_stamp before insert on crm\.ad_campaign_versions/);
      const stamp = fn('crm.ad_version_stamp');
      assert.match(stamp, /new\.content_hash := encode\(sha256\(convert_to\(/);
      for (const part of ["'platform', c.platform", "'plan', new.plan", "'daily', new.budget_daily_minor", "'total', new.budget_total_minor", "'start'", "'end'"]) assert.ok(stamp.includes(part), part);
      for (const kind of ['launch', 'budget_increase', 'budget_decrease', 'targeting_change', 'creative_change']) assert.ok(stamp.includes(`'${kind}'`), kind);
    });

    test('plan, budget, dates, hash and kind are frozen; the state moves only through the doors and only along the allowed edges', () => {
      const guard = fn('crm.ad_version_guard');
      for (const col of ['plan', 'budget_daily_minor', 'budget_total_minor', 'start_date', 'end_date', 'change_kind', 'change_amount_minor', 'content_hash']) assert.match(guard, new RegExp(`new\\.${col}`), col);
      assert.match(guard, /current_setting\('crm\.ad_write', true\)/);
      assert.match(guard, /if tg_op = 'DELETE' then raise exception/);
      assert.match(guard, /old\.state = 'ADMIN_REVIEW'\s+and new\.state in \('LAUNCHING'/);
      assert.doesNotMatch(guard, /old\.state = 'DRAFT'\s+and new\.state in \([^)]*'LIVE'/, 'a draft can never jump to LIVE');
    });

    test('there is at most one running and one launching version per campaign, in the database', () => {
      assert.match(sql, /create unique index if not exists ad_versions_one_running_key[^;]*where state in \('LIVE', 'PAUSED'\)/);
      assert.match(sql, /create unique index if not exists ad_versions_one_launching_key[^;]*where state = 'LAUNCHING'/);
    });
  });

  describe('every table is tenant-bound, append-only where it is history, and unreadable to a signed-out caller', () => {
    const tables = ['ad_campaigns', 'ad_campaign_versions', 'ad_provider_objects', 'ad_applications', 'ad_metrics', 'ad_provider_statuses', 'campaign_health_records'];
    test('forced RLS, an internal-only select policy, explicit revokes, and the organisation frozen', () => {
      for (const t of tables) {
        assert.match(sql, new RegExp(`alter table crm\\.${t} force row level security`), `${t} forced RLS`);
        assert.match(sql, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), `${t} revoke`);
        assert.match(sql, new RegExp(`create trigger freeze_org_${t} before update of organization_id on crm\\.${t}`), `${t} freezes its organisation`);
        assert.match(sql, new RegExp(`create policy ${t}_select on crm\\.${t} for select to authenticated using \\(organization_id = \\(select core\\.current_organization_id\\(\\)\\) and \\(select core\\.is_internal\\(\\)\\)\\)`), `${t} select policy`);
      }
    });
    test('the history tables refuse update and delete', () => {
      for (const t of ['ad_applications', 'ad_metrics', 'ad_provider_statuses', 'campaign_health_records']) assert.match(sql, new RegExp(`create trigger ${t}_immutable before update or delete on crm\\.${t}`), t);
    });
    test('every parent link is checked to be the same organisation', () => {
      for (const c of ['campaign_id', 'current_version_id', 'live_version_id', 'version_id', 'execution_id', 'approval_request_id', 'supersedes_version_id']) assert.match(sql, new RegExp(`core\\.enforce_parent_org\\('${c}'`), c);
    });
  });

  describe('the doors', () => {
    test('the machine doors are the engine\'s alone; the person doors need an admin and an organisation match', () => {
      for (const f of ['begin_ad_apply(uuid, uuid, uuid)', 'record_ad_apply(uuid, uuid, uuid, text, text, jsonb, jsonb)', 'record_ad_metrics(uuid, uuid, date, bigint, bigint, bigint, bigint)', 'confirm_ad_change(uuid, uuid, boolean, text)', 'enforce_ad_stops(integer)', 'assess_campaign_health(uuid, uuid)', 'sync_ad_approvals(integer)', 'record_ad_status(uuid, uuid, text, text)']) {
        const esc = f.replace(/[()]/g, '\\$&');
        assert.match(sql, new RegExp(`revoke all on function crm\\.${esc} from public, anon, authenticated`), `${f} revoked`);
        assert.match(sql, new RegExp(`grant execute on function crm\\.${esc} to service_role`), `${f} granted to the engine only`);
      }
      for (const f of ['create_ad_campaign', 'add_ad_version', 'check_ad_version', 'submit_ad_version', 'request_ad_change']) assert.match(fn(`crm.${f}`), /crm\._social_caller_ok\(p_organization_id, true\)/, `${f} needs an admin`);
    });

    test('applying asks the stops, the connector and the cap NOW, then the exact-version approval, through the one governed door', () => {
      const apply = fn('crm.begin_ad_apply');
      assert.match(apply, /crm\.acquisition_decide\(p_organization_id, crm\._ad_action\(v\.change_kind\), c\.platform, v\.change_amount_minor/);
      assert.match(apply, /if d\.decision = 'BLOCK' then/);
      assert.match(apply, /crm\.begin_governed_execution\(p_organization_id, v\.approval_request_id, 'ad_campaign', v\.id, v\.content_hash/);
      assert.ok(apply.indexOf('acquisition_decide') < apply.indexOf('begin_governed_execution'));
    });

    test('a pause or end is an intent until the platform confirms it', () => {
      assert.match(fn('crm.request_ad_change'), /update crm\.ad_campaigns set provider_sync_pending = p_action/);
      assert.doesNotMatch(fn('crm.request_ad_change'), /set status/);
      assert.match(fn('crm.confirm_ad_change'), /if p = 'pause' then perform crm\._ad_set_state\(c\.live_version_id, 'PAUSED'\)/);
    });

    test('only the increase in reported spend is added to the ledger', () => {
      assert.match(fn('crm.record_ad_metrics'), /v_delta := greatest\(p_spend_minor - coalesce\(v_prev, 0\), 0\)/);
    });

    test('results are attributed by FIRST touch, joined to the campaign\'s own provider ids, scoped to the caller', () => {
      const o = fn('crm.ad_outcomes');
      assert.match(o, /order by t\.lead_id, t\.occurred_at, t\.recorded_at, t\.id/);
      assert.match(o, /join crm\.ad_provider_objects o on o\.campaign_id = c\.id/);
      assert.match(o, /k\.uid is null or c\.organization_id = k\.org/);
      assert.match(o, /coalesce\(p\.leads, 0\) < 10/);
    });
  });

  describe('ad changes can never be automatic', () => {
    test('the hard gate and the door\'s own refusal list the same seven actions as TypeScript', () => {
      const gate = [...(sql.match(/check \(mode <> 'auto' or action_type not in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string);
      assert.deepEqual(new Set(gate), new Set(NEVER_AUTO_ACTIONS));
      assert.equal(NEVER_AUTO_ACTIONS.length, 7);
      for (const a of ['ad_budget_increase', 'ad_targeting_change']) assert.ok(NEVER_AUTO_ACTIONS.includes(a as never), a);
      assert.match(sql, /update crm\.acquisition_policies set mode = 'approval' where action_type in \('ad_budget_increase', 'ad_targeting_change'\) and mode = 'auto'/);
    });
    test('the change kind maps to the same governed action in SQL and TypeScript', () => {
      const body = fn('crm._ad_action');
      assert.match(body, /'budget_increase' then 'ad_budget_increase' when 'targeting_change' then 'ad_targeting_change' else 'ad_launch'/);
      assert.equal(adActionFor('budget_increase'), 'ad_budget_increase');
      assert.equal(adActionFor('targeting_change'), 'ad_targeting_change');
      for (const k of ['launch', 'creative_change', 'budget_decrease'] as const) assert.equal(adActionFor(k), 'ad_launch', k);
    });
  });

  describe('the vocabulary covers what the database can say', () => {
    test('every state, change kind, health kind and recommendation has words', () => {
      const states = [...(sql.match(/state in \('DRAFT', 'CHECKED'[^)]*\)/)?.[0] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
      assert.ok(states.length >= 10);
      for (const s of states) assert.ok(VERSION_STATE_WORDS[s], s);
      for (const k of CHANGE_KINDS) assert.ok(CHANGE_LABEL[k], k);
      const kinds = [...(sql.match(/kind\s+text not null check \(kind in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
      assert.ok(kinds.length >= 8);
      for (const k of kinds) assert.ok(HEALTH_WORDS[k], k);
      const recs = [...fn('crm.ad_recommendations').matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map((m) => (m[1] ?? m[2]) as string);
      assert.ok(recs.length >= 5);
      for (const r of recs) assert.ok(RECOMMENDATION_WORDS[r], r);
    });
    test('every plan-problem code the database can emit has words (prefixed codes aside)', () => {
      const body = fn('crm.ad_plan_problems');
      const codes = [...body.matchAll(/to_jsonb\('([a-z_0-9]+)'(?:::text)?\)/g)].map((m) => m[1] as string);
      assert.ok(codes.length >= 15, `found ${codes.length} codes`);
      for (const c of codes) assert.notEqual(planProblemWords(c), c, `${c} has no words`);
      assert.match(planProblemWords('manufactured_urgency:act now'), /Pressure language/);
      assert.deepEqual([...AD_PLATFORMS], ['meta_ads', 'google_ads']);
    });
  });

  describe('the worker goes only through the governed door', () => {
    test('no provider exists yet, and nothing pretends one does', () => {
      assert.deepEqual(Object.keys(AD_PROVIDERS), []);
    });

    test('a launch the door refuses never reaches the provider', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'not_covered', reason: 'state_pending', execution_id: null }] });
      const { provider, seen } = okProvider();
      const r = await applyAdVersion(admin, { organizationId: 'org', versionId: 'v', provider });
      assert.deepEqual(r, { outcome: 'not_proceeding', reason: 'not_covered', why: 'state_pending' });
      assert.equal(seen.length, 0);
      assert.deepEqual(calls.map((c) => c.fn), ['crm.begin_ad_apply']);
    });

    test('an approved launch sends exactly what the version row holds, then records the provider\'s ids', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'first_execution', execution_id: 'ex' }] });
      const { provider, seen } = okProvider();
      const r = await applyAdVersion(admin, { organizationId: 'org', versionId: 'v', provider });
      assert.deepEqual(r, { outcome: 'applied', providerCampaignId: 'prov-1' });
      const sent = seen[0] as { contentHash: string; budgetDailyMinor: number; changeKind: string };
      assert.equal(sent.contentHash, 'a'.repeat(64));
      assert.equal(sent.budgetDailyMinor, 100000);
      const rec = calls.find((c) => c.fn === 'crm.record_ad_apply');
      assert.equal(rec?.args.p_status, 'executed');
      assert.equal(rec?.args.p_provider_campaign_id, 'prov-1');
      assert.deepEqual(rec?.args.p_objects, [{ object_type: 'ad', provider_id: 'AD-1' }]);
    });

    test('a provider that throws is UNKNOWN (never retried blindly); one that refuses is a failure', async () => {
      const thrown = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }] });
      const r1 = await applyAdVersion(thrown.admin, { organizationId: 'org', versionId: 'v', provider: { apply: async () => { throw new Error('socket hang up'); } } });
      assert.equal(r1.outcome, 'unknown');
      assert.equal(thrown.calls.find((c) => c.fn === 'crm.record_ad_apply')?.args.p_status, 'unknown');
      const refused = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }] });
      const r2 = await applyAdVersion(refused.admin, { organizationId: 'org', versionId: 'v', provider: { apply: async () => ({ status: 'rejected', reason: 'policy' }) } });
      assert.deepEqual(r2, { outcome: 'failed', reason: 'policy' });
      assert.equal(refused.calls.find((c) => c.fn === 'crm.record_ad_apply')?.args.p_status, 'failed');
    });

    test('the sweep, with no provider, raises an alert for approved work and for a pending pause - it does not fake either', async () => {
      const { admin, calls } = fakeAdmin({
        waiting: [{ id: 'v1', organization_id: 'org', campaign_id: 'camp', approval_request_id: 'req' }],
        pending: [{ organization_id: 'org', campaign_id: 'camp', platform: 'meta_ads', action: 'pause' }],
      });
      const sweep = await runAdOperations(admin, {});
      assert.equal(sweep.assisted, 1);
      assert.equal(sweep.applied, 0);
      assert.equal(calls.filter((c) => c.fn === 'core.raise_alert').length, 2);
      assert.equal(calls.some((c) => c.fn === 'crm.begin_ad_apply'), false, 'no governed execution is started without a provider');
      assert.equal(calls.some((c) => c.fn === 'crm.confirm_ad_change'), false, 'a pause is never confirmed without the platform');
    });

    test('an approved version is not applied until the approval engine says approved', async () => {
      const { admin, calls } = fakeAdmin({ waiting: [{ id: 'v1', organization_id: 'org', campaign_id: 'camp', approval_request_id: 'req' }], approvalState: 'pending' });
      const { provider, seen } = okProvider();
      await runAdOperations(admin, { meta_ads: provider });
      assert.equal(seen.length, 0);
      assert.equal(calls.some((c) => c.fn === 'crm.begin_ad_apply'), false);
    });
  });

  describe('the verifier proves it on a real database', () => {
    test('it drives the real approval engine and the governed door, and is wired into the acquisition verify chain', () => {
      for (const part of ['approvals.decide_approval', 'crm.begin_ad_apply', 'crm.record_ad_apply', 'crm.set_channel_pause', 'crm.enforce_ad_stops', 'crm.ad_outcomes', 'ALL CHECKS PASSED']) assert.ok(verifier.includes(part), part);
      assert.match(read('package.json'), /verify-acquisition-ads\.sql/);
    });
  });
});
