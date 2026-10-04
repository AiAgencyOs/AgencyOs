import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { normalizePhone } from '../src/lib/import/phone.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261015200000_one_person_one_identity_across_channels.sql');
const identityTs = read('src/modules/acquisition/identity.ts');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

/** lead_outcome's own region: from its create to its revoke - both ends named. */
const outcomeFn = () => {
  const start = sql.indexOf('create or replace function crm.lead_outcome(');
  assert.ok(start > 0);
  const end = sql.indexOf('revoke all on function crm.lead_outcome', start);
  assert.ok(end > start);
  return sql.slice(start, end);
};

describe('lead generation, slice 2 - one person, one identity across channels', () => {
  describe('the rules that make a match safe', () => {
    test('there is no merge anywhere in this change: nothing re-points, deletes or rewrites a contact or lead', () => {
      const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      assert.doesNotMatch(code, /delete from crm\.contacts/i);
      assert.doesNotMatch(code, /update crm\.leads\s+set\s+contact_id/i);
      assert.doesNotMatch(code, /merged_into/i);
      assert.doesNotMatch(code, /function crm\.merge_/i);
    });

    test('a decision on a duplicate review is a judgement only: the door writes the review and nothing else', () => {
      const body = fn('crm.decide_duplicate_review');
      assert.match(body, /update crm\.duplicate_reviews/);
      for (const t of ['crm.contacts', 'crm.leads', 'crm.identity_keys']) assert.doesNotMatch(body, new RegExp(`(update|delete from|insert into) ${t.replace('.', '\\.')}`));
      assert.match(body, /'confirmed_same', 'kept_separate', 'dismissed'/, 'there is no "merge" decision');
    });

    test('a key owned by another contact stays with its owner and opens a review (no last-write-wins)', () => {
      const body = fn('crm._attach_identity_keys');
      assert.match(body, /on conflict \(organization_id, kind, value\) do nothing/);
      assert.match(body, /_open_duplicate_review\(/);
      assert.doesNotMatch(body, /do update/i);
    });

    test('weak signals only suggest: the domain and the name never enter the key registry', () => {
      assert.match(sql, /check \(kind in \('email', 'phone', 'linkedin', 'instagram', 'facebook', 'b2b'\)\)/);
      assert.doesNotMatch(sql, /kind in \([^)]*'domain'/);
      const body = fn('crm.resolve_identity');
      assert.match(body, /'name_and_domain'/);
      assert.match(body, /lower\(btrim\(c\.full_name\)\) = lower\(v_name\)/);
    });

    test('the pair of a review is unordered and unique forever, so a decided pair is never re-opened', () => {
      assert.match(sql, /constraint duplicate_reviews_ordered check \(contact_a < contact_b\)/);
      assert.match(sql, /unique \(organization_id, contact_a, contact_b\)/);
    });

    test('resolution is serialised per key, in a fixed order, so two arrivals of one person cannot both create them', () => {
      const body = fn('crm.resolve_identity');
      assert.match(body, /pg_advisory_xact_lock\(hashtextextended\(p_organization_id::text/);
      assert.match(body, /order by 1 loop/);
    });

    test('no array is built by concatenating a bare literal (text[] || \'x\' parses \'x\' as an array literal)', () => {
      assert.doesNotMatch(sql, /v_(kinds|vals)\s*:=\s*v_(kinds|vals)\s*\|\|/);
    });

    test('the phone rule is the TypeScript rule: only a written + carries a country, 8 to 15 digits, never guessed', () => {
      assert.match(fn('crm.norm_phone'), /c like '\+%' and length\(regexp_replace\(c, '\\D', '', 'g'\)\) between 8 and 15/);
      assert.equal(normalizePhone('9876543210').e164, null);
      assert.equal(normalizePhone('+91 98765-43210').e164, '+919876543210');
      assert.equal(normalizePhone('+1234567').e164, null, '7 digits is too short in both');
      assert.equal(normalizePhone('+1234567890123456').e164, null, '16 digits is too long in both');
    });
  });

  describe('who may call what', () => {
    test('the engines\' doors are service-role only; a person\'s doors are admin-only and org-pinned', () => {
      for (const sig of ['crm.resolve_identity(uuid, jsonb, text)', 'crm.record_touchpoint(uuid, uuid, text, text, text, jsonb, jsonb, text, timestamptz, uuid)']) {
        assert.match(sql, new RegExp(`revoke all on function ${sig.replace(/[().]/g, '\\$&')} from public, anon, authenticated`), sig);
        assert.match(sql, new RegExp(`grant execute on function ${sig.replace(/[().]/g, '\\$&')} to service_role`), sig);
      }
      const decide = fn('crm.decide_duplicate_review');
      assert.match(decide, /core\.is_admin\(\)/);
      assert.match(decide, /v_org\s+uuid := \(select core\.current_organization_id\(\)\)/);
    });

    test('a session may only act inside its own organisation on every door that takes one', () => {
      for (const name of ['crm.resolve_identity', 'crm.record_touchpoint', 'crm.transfer_conversation_owner']) {
        assert.match(fn(name), /p_organization_id is distinct from \(select core\.current_organization_id\(\)\)/, name);
      }
      assert.match(outcomeFn(), /l\.organization_id = \(select core\.current_organization_id\(\)\)/);
    });
  });

  describe('history cannot be rewritten', () => {
    test('a touchpoint and an owner transfer are append-only', () => {
      assert.match(sql, /create trigger lead_touchpoints_immutable\s+before update or delete on crm\.lead_touchpoints/);
      assert.match(sql, /create trigger conversation_owner_transfers_immutable\s+before update or delete on crm\.conversation_owner_transfers/);
      assert.doesNotMatch(sql, /grant [^;]*(update|delete)[^;]*on crm\.lead_touchpoints/);
    });

    test('rows recorded in one transaction still have an order (clock_timestamp, not now)', () => {
      assert.match(sql, /recorded_at\s+timestamptz not null default clock_timestamp\(\)/);
      assert.match(sql, /created_at\s+timestamptz not null default clock_timestamp\(\)\n\);\ncreate index if not exists conversation_owner_transfers_lead_idx/);
      assert.match(sql, /order by occurred_at, recorded_at, id limit 1/);
    });

    test('first touch is derived, never stored: there is no first-touch column to overwrite', () => {
      assert.doesNotMatch(sql, /add column[^;]*first_touch/i);
      assert.match(fn('crm.lead_attribution'), /order by occurred_at, recorded_at, id limit 1/);
    });

    test('a Click-to-WhatsApp ad becomes the earlier touch, so existing data keeps its true first touch', () => {
      assert.match(sql, /new\.created_at - interval '1 second'/);
      assert.match(sql, /'lead-ad:' \|\| new\.id::text/);
    });
  });

  describe('exactly one conversation owner', () => {
    test('the SQL owner list and the TypeScript owner list are the same, and neither contains a subtask agent', () => {
      const m = sql.match(/owner\s+text not null check \(owner in \(([^)]*)\)\)/);
      assert.ok(m);
      const owners = [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      const ts = [...identityTs.matchAll(/CONVERSATION_OWNERS = \[([^\]]*)\]/g)][0]?.[1] ?? '';
      assert.deepEqual(owners, [...ts.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
      for (const subtask of ['scheduler', 'quotation_master']) assert.ok(!owners.includes(subtask), subtask);
    });

    test('a transfer is compare-and-set under the lead row lock, refuses a closed lead, and records who, to whom and why', () => {
      const body = fn('crm.transfer_conversation_owner');
      assert.match(body, /for update;/);
      assert.match(body, /p_expected_from is distinct from v_cur\.owner then return query select 'stale'/);
      assert.match(body, /v_outcome in \('WON', 'LOST', 'DISQUALIFIED'\)/);
      assert.match(body, /insert into crm\.conversation_owner_transfers/);
      assert.match(body, /length\(v_reason\) < 3/);
    });
  });

  describe('the lifecycle is not duplicated', () => {
    test('the canonical outcome is derived from the leads and opportunities that already exist, and is not a column', () => {
      assert.doesNotMatch(sql, /alter table crm\.leads add column/i);
      const body = outcomeFn();
      for (const word of ["'WON'", "'LOST'", "'DISQUALIFIED'", "'NURTURE'", "'OPEN'"]) assert.match(body, new RegExp(word));
      assert.match(body, /sales\.opportunities/);
      assert.match(body, /l\.status = 'converted'/);
    });
  });

  describe('the existing doors are covered without being re-emitted', () => {
    test('contacts and leads are keyed by AFTER triggers that audit and swallow a failure instead of losing the row', () => {
      assert.match(sql, /create trigger key_a_contact\s+after insert or update of email, phone on crm\.contacts/);
      assert.match(sql, /create trigger touch_a_new_lead\s+after insert or update of campaign_source_id on crm\.leads/);
      assert.match(sql, /identity\.key_sync_failed/);
      assert.match(sql, /identity\.touch_failed/);
      assert.doesNotMatch(sql, /create or replace function crm\.ingest_whatsapp_message/);
      assert.doesNotMatch(sql, /create or replace function crm\.convert_prospect/);
    });

    test('the Phase 1 reachability rule is extended, not removed', () => {
      assert.match(sql, /check \(email is not null or phone is not null or reachable_via is not null\)/);
      assert.match(sql, /reachable_via in \('linkedin', 'instagram', 'facebook', 'b2b'\)/);
    });
  });

  describe('tenancy', () => {
    test('every new table is frozen to its organisation, guards each foreign key to its parent, and forces RLS', () => {
      for (const t of ['identity_keys', 'duplicate_reviews', 'lead_touchpoints', 'lead_conversation_owner', 'conversation_owner_transfers']) {
        assert.match(sql, new RegExp(`create trigger freeze_org_${t} before update of organization_id on crm\\.${t}`), `${t} freeze`);
        assert.match(sql, new RegExp(`alter table crm\\.${t} enable row level security`), `${t} rls`);
        assert.match(sql, new RegExp(`alter table crm\\.${t} force row level security`), `${t} force`);
        assert.match(sql, new RegExp(`create policy ${t}_select on crm\\.${t} for select to authenticated`), `${t} select`);
      }
      for (const guard of ['identity_keys_contact', 'duplicate_reviews_a', 'duplicate_reviews_b', 'lead_touchpoints_lead', 'lead_conversation_owner_lead', 'conversation_owner_transfers_lead']) {
        assert.match(sql, new RegExp(`create trigger org_match_${guard} before insert or update of`), guard);
      }
      assert.doesNotMatch(sql, /grant (insert|update|delete)[^;]*to authenticated/);
    });
  });
});
