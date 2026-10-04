import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { can } from '../src/lib/authz/permissions.ts';
import { KILL_SWITCHES } from '../src/lib/observability/kill-switch-types.ts';
import {
  ACQUISITION_CHANNELS,
  CHANNEL_SLUG,
  ENGINE_STATUS,
  buildIcpDefinition,
  channelFromSlug,
  parseList,
} from '../src/modules/acquisition/schema.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const config = read('supabase/migrations/20261015100000_lead_generation_is_configured_not_coded.sql');
const pause = read('supabase/migrations/20261015110000_a_paused_channel_sends_nothing.sql');

describe('lead generation, slice 1 - what the Admin decides and the brake the Admin can throw', () => {
  describe('the vocabulary', () => {
    test('the five channels are the five the specification names, each with a distinct tab slug', () => {
      assert.deepEqual([...ACQUISITION_CHANNELS], ['meta_ads', 'email', 'social', 'google_ads', 'b2b']);
      assert.equal(new Set(Object.values(CHANNEL_SLUG)).size, 5);
      for (const c of ACQUISITION_CHANNELS) assert.equal(channelFromSlug(CHANNEL_SLUG[c]), c);
      assert.equal(channelFromSlug('tiktok'), null);
      assert.equal(channelFromSlug('meta_ads'), null, 'the database key is not a URL slug');
    });

    test('the SQL channel list and the TypeScript channel list are the same list', () => {
      const m = config.match(/check \(channel in \(([^)]*)\)\)/);
      assert.ok(m, 'the channel CHECK was not found');
      const sql = [...(m[1] ?? '').matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]);
      assert.deepEqual(sql, [...ACQUISITION_CHANNELS]);
    });

    test('an engine is never described as built unless it is - email and social are partly built (no provider adapters yet), nothing is fully built', () => {
      for (const c of ACQUISITION_CHANNELS) {
        assert.equal(ENGINE_STATUS[c].build, c === 'b2b' ? 'not_built' : 'partial', c);
        assert.ok(ENGINE_STATUS[c].summary.length > 20);
      }
    });

    test('the new emergency stop is a real kill switch with the same name in SQL and TypeScript', () => {
      assert.ok((KILL_SWITCHES as readonly string[]).includes('acquisition_paused'));
      assert.match(config, /check \(switch in \('agents_paused', 'outbound_paused', 'jobs_paused', 'acquisition_paused'\)\)/);
      assert.match(config, /p_switch not in \('agents_paused', 'outbound_paused', 'jobs_paused', 'acquisition_paused'\)/);
    });
  });

  describe('the ICP form turns text into a profile', () => {
    test('one item per line or comma, trimmed, de-duplicated, empties dropped', () => {
      assert.deepEqual(parseList(' Retail,\nLogistics\n\n retail ,Retail'), ['Retail', 'Logistics', 'retail']);
    });
    test('a list that was left empty is absent from the profile, not an empty array that means "everything excluded"', () => {
      assert.deepEqual(buildIcpDefinition({ industries: 'Retail', exclusions: '  ', minScore: '' }), { industries: ['Retail'] });
    });
    test('a blank score is "no minimum", a typed zero is a minimum of zero', () => {
      assert.equal('min_qualification_score' in buildIcpDefinition({ industries: 'a' }), false);
      assert.equal(buildIcpDefinition({ minScore: '0' }).min_qualification_score, 0);
    });
    test('a pasted file cannot become the profile: lists are capped', () => {
      assert.equal(parseList(Array.from({ length: 500 }, (_, i) => `item${i}`).join('\n')).length, 100);
    });
  });

  describe('who may do what', () => {
    test('owner and ops_admin manage lead generation; no other role sees or changes it', () => {
      for (const role of ['owner', 'ops_admin'] as const) {
        assert.ok(can(role, 'acquisition.read'), `${role} read`);
        assert.ok(can(role, 'acquisition.manage'), `${role} manage`);
      }
      for (const role of ['delivery_lead', 'member', 'contractor', 'finance', 'client_admin', 'client_member'] as const) {
        assert.equal(can(role, 'acquisition.read'), false, `${role} read`);
        assert.equal(can(role, 'acquisition.manage'), false, `${role} manage`);
      }
    });

    test('every acquisition door re-checks admin in the database - the capability only mirrors it', () => {
      for (const door of ['ensure_acquisition_defaults', 'set_target_service', 'set_channel_settings', 'set_channel_pause', 'save_icp']) {
        const start = config.indexOf(`create or replace function crm.${door}(`);
        assert.ok(start > 0, `${door} is missing`);
        const body = config.slice(start, config.indexOf('\n$$;', start));
        assert.match(body, /core\.is_admin\(\)/, `${door} does not check is_admin`);
        assert.match(body, /v_org\s+uuid := \(select core\.current_organization_id\(\)\)/, `${door} is not pinned to the session organisation`);
        assert.match(body, /core\.record_audit\(|'forbidden'/, door);
      }
    });

    test('the global stop stays owner-only: the whitelist grew, the owner gate did not move', () => {
      const start = config.indexOf('create or replace function core.set_kill_switch');
      const body = config.slice(start, config.indexOf('\n$$;', start));
      assert.match(body, /core\.is_owner\(\)/);
      assert.match(body, /'no_reason'/);
      assert.match(body, /kill_switch\.engaged/);
    });
  });

  describe('the data is the Admin\'s, not the code\'s', () => {
    test('no worker or screen holds the default target services as a constant', () => {
      const sources = [
        read('src/modules/acquisition/schema.ts'),
        read('src/modules/acquisition/queries.ts'),
        read('src/modules/acquisition/service.ts'),
        read('src/modules/acquisition/actions.ts'),
        read('app/(internal)/lead-generation/page.tsx'),
        read('app/(internal)/lead-generation/forms.tsx'),
      ].join('\n');
      assert.doesNotMatch(sources, /Website Development|App Development|General Development Services/);
      // They exist in exactly one place: the seeding door.
      assert.match(config, /'Website Development'/);
    });

    test('an ICP version is history: no update or delete path, and the next version is taken under a lock', () => {
      assert.match(config, /before update or delete on crm\.icp_versions/);
      assert.match(config, /pg_advisory_xact_lock\(hashtextextended\('icp:'/);
      assert.match(config, /unique \(organization_id, version\)/);
    });

    test('seeding never undoes a deliberate change: defaults go only into an organisation with no service at all', () => {
      assert.match(config, /if not exists \(select 1 from crm\.target_services where organization_id = v_org\)/);
    });
  });

  describe('the brake', () => {
    test('one function answers "may this channel act?" and it fails closed on an unknown channel', () => {
      const start = config.indexOf('create or replace function crm.acquisition_blocked');
      const body = config.slice(start, config.indexOf('\n$$;', start));
      assert.match(body, /'unknown_channel'/);
      assert.match(body, /'tenant_mismatch'/);
      assert.match(body, /'acquisition_paused'/);
      assert.match(body, /'channel_paused'/);
      assert.ok(body.indexOf("'acquisition_paused'") < body.indexOf("'channel_paused'"), 'the global stop outranks the channel stop');
    });

    test('pausing needs a reason, in the table as well as in the door', () => {
      assert.match(config, /acquisition_channels_pause_says_why/);
      assert.match(config, /if coalesce\(p_paused, false\) and v_reason is null then/);
    });

    test('the email chokepoint reads the stop at the moment a send is reserved, after the outbound gate and before anything is reserved', () => {
      assert.match(pause, /if crm\.acquisition_blocked\(p_organization_id, 'email'\) is not null then return; end if;/);
      assert.ok(pause.indexOf("'outbound_paused'") < pause.indexOf('crm.acquisition_blocked(p_organization_id'), 'outbound gate first');
      assert.ok(pause.indexOf('crm.acquisition_blocked(p_organization_id') < pause.indexOf('insert into crm.email_outreach_sends'), 'the pause is read before a reservation');
    });

    test('it does NOT gate on `enabled`: a campaign that already runs is not stopped by a new switch defaulting to off', () => {
      assert.doesNotMatch(pause, /\.enabled\b/);
    });
  });

  describe('every new tenant table carries the tenancy guards the scanner demands', () => {
    test('each table has its own freeze trigger, forced RLS, an internal-only select policy, and no write grant to authenticated', () => {
      for (const t of ['target_services', 'icp_versions', 'acquisition_channels']) {
        assert.match(config, new RegExp(`create trigger freeze_org_${t}\\s+before update of organization_id on crm\\.${t}\\s+for each row execute function core\\.freeze_organization_id\\(\\)`), `${t} freeze`);
        assert.match(config, new RegExp(`alter table crm\\.${t} enable row level security`), `${t} rls`);
        assert.match(config, new RegExp(`alter table crm\\.${t} force row level security`), `${t} force`);
        assert.match(config, new RegExp(`create policy ${t}_select on crm\\.${t}\\s+for select to authenticated\\s+using \\(organization_id = \\(select core\\.current_organization_id\\(\\)\\) and \\(select core\\.is_internal\\(\\)\\)\\)`), `${t} select policy`);
        assert.match(config, new RegExp(`grant select on crm\\.${t} to authenticated`), `${t} grant`);
      }
      assert.doesNotMatch(config, /grant (insert|update|delete)[^;]*to authenticated/);
    });
  });
});
