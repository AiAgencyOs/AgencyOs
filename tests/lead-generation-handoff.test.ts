import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  deriveHandoffCode,
  extractHandoffCode,
  handoffLink,
  hashHandoffCode,
  normalizeHandoffCode,
  whatsappDeepLink,
} from '../src/modules/acquisition/handoff-code.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261015300000_a_prospect_who_moves_to_whatsapp_stays_one_lead.sql');
const ingest = read('src/modules/crm/ingest.ts');
const handoffTs = read('src/modules/acquisition/handoff-bind.ts');
const route = read('app/api/handoff/[code]/route.ts');

const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
const SECRET = 'a-signing-secret-for-the-test';
const FORMAT = /^AOS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

describe('lead generation, slice 3 - the tracked WhatsApp handoff', () => {
  describe('the reference', () => {
    test('is derived from the handoff id and a secret: stable for a retry, different for another id or secret', () => {
      const code = deriveHandoffCode(ID, SECRET);
      assert.match(code, FORMAT);
      assert.equal(deriveHandoffCode(ID, SECRET), code, 'a retried job regenerates the same link');
      assert.notEqual(deriveHandoffCode('3b241101-e2bb-4255-8caf-4136c566a963', SECRET), code);
      assert.notEqual(deriveHandoffCode(ID, `${SECRET}x`), code);
    });

    test('cannot be derived without a secret (an unsigned reference would be guessable from the id)', () => {
      assert.throws(() => deriveHandoffCode(ID, ''));
    });

    test('carries 80 bits: 2,000 derivations never collide and never leave the alphabet', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 2000; i += 1) {
        const c = deriveHandoffCode(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SECRET);
        assert.match(c, FORMAT);
        seen.add(c);
      }
      assert.equal(seen.size, 2000);
    });

    test('forgives how a person copies it: case, spaces, missing hyphens, look-alike letters', () => {
      const code = deriveHandoffCode(ID, SECRET);
      assert.equal(normalizeHandoffCode(code.toLowerCase()), code);
      assert.equal(normalizeHandoffCode(code.replaceAll('-', ' ')), code);
      assert.equal(normalizeHandoffCode(code.replaceAll('-', '')), code);
      assert.equal(normalizeHandoffCode('  aos-0o0o-1i1l-0000-1111 '), 'AOS-0000-1111-0000-1111', 'O reads as 0, I and L as 1');
    });

    test('rejects what is not a reference: too short, too long, wrong prefix, forbidden letters', () => {
      for (const bad of ['', 'AOS-1234', 'AOS-AAAA-AAAA-AAAA-AAAAA', 'XYZ-AAAA-AAAA-AAAA-AAAA', 'AOS-UUUU-UUUU-UUUU-UUUU', 'AOS-AAAA-AAAA-AAAA-AAA!']) {
        assert.equal(normalizeHandoffCode(bad), null, JSON.stringify(bad));
      }
    });

    test('is found inside a longer message, and only the first one is taken', () => {
      const a = deriveHandoffCode(ID, SECRET);
      const b = deriveHandoffCode('3b241101-e2bb-4255-8caf-4136c566a963', SECRET);
      assert.equal(extractHandoffCode(`Hi, I'm following up on our earlier conversation. Ref ${a}`), a);
      assert.equal(extractHandoffCode(`first ${a} then ${b}`), a);
      assert.equal(extractHandoffCode('Hi, I would like a website - no reference here'), null);
      assert.equal(extractHandoffCode('AOS rocks and so does 1234'), null);
    });

    test('is hashed as the canonical string, which is exactly what the SQL verifier hashes', () => {
      const code = 'AOS-AAAA-1111-BBBB-2222';
      assert.equal(hashHandoffCode(code), createHash('sha256').update(code).digest('hex'));
      assert.equal(hashHandoffCode(code.toLowerCase()), hashHandoffCode(code), 'the hash is of the canonical form');
      assert.throws(() => hashHandoffCode('not a code'));
      const verifier = read('scripts/verify-acquisition-handoff.sql');
      assert.match(verifier, /encode\(sha256\(convert_to\(code, 'UTF8'\)\), 'hex'\)/);
    });

    test('the links: the public link is encoded and slash-safe, the WhatsApp link opens with the reference pre-filled', () => {
      const code = deriveHandoffCode(ID, SECRET);
      assert.equal(handoffLink('https://app.example.com/', code), `https://app.example.com/api/handoff/${code}`);
      const wa = whatsappDeepLink('+91 98765-43210', code);
      assert.ok(wa.startsWith('https://wa.me/919876543210?text='));
      assert.ok(decodeURIComponent(wa).includes(`Ref ${code}`));
    });
  });

  describe('the move keeps ONE lead', () => {
    test('ingest binds BEFORE the unchanged ingest function and consumes AFTER it records the message', () => {
      const bind = ingest.indexOf('bindHandoffBeforeIngest(admin');
      const rpc = ingest.indexOf("rpc('ingest_whatsapp_message'");
      const consume = ingest.indexOf('consumeHandoffAfterIngest(admin');
      assert.ok(bind > 0 && rpc > bind && consume > rpc, 'order: bind, ingest, consume');
      assert.match(ingest, /if \(bound && row\.status === 'ingested'\)/, 'a replay does not consume again');
    });

    test('the ingest function itself is not re-emitted: the bind makes the unchanged function continue the lead', () => {
      assert.doesNotMatch(sql, /create or replace function crm\.ingest_whatsapp_message/);
    });

    test('a handoff failure can never lose the message it rides on: bind and consume catch everything', () => {
      for (const name of ['bindHandoffBeforeIngest', 'consumeHandoffAfterIngest']) {
        const start = handoffTs.indexOf(`export async function ${name}`);
        const body = handoffTs.slice(start, handoffTs.indexOf('\n}\n', start));
        assert.match(body, /try \{/, name);
        assert.match(body, /catch \(e\)/, name);
        assert.doesNotMatch(body.replace(/\/\*[\s\S]*?\*\//g, ''), /\bthrow new Error\(`/, `${name} must not throw out of its catch`);
      }
    });

    test('the bind re-keys the lead only when it is safe, otherwise it asks for a review and moves nothing', () => {
      const body = fn('crm.bind_handoff_from_message');
      assert.match(body, /v_other is not null/);
      assert.match(body, /v_wa_lead is not null and v_wa_lead <> v_lead\.id/);
      assert.match(body, /v_cphone is not null and v_cphone <> v_phone/);
      assert.match(body, /'review_needed'/);
      assert.match(body, /update crm\.leads set source = 'whatsapp', source_ref = v_thread/);
      assert.doesNotMatch(body, /delete from/i);
      assert.doesNotMatch(body, /merge_leads|function crm\.merge/i);
    });

    test('lookup is always (organisation, hash): a number can only resolve its own organisation\'s references', () => {
      assert.match(fn('crm.bind_handoff_from_message'), /x\.organization_id = v_org and x\.token_hash = p_code_hash/);
    });

    test('with no safe bind the true first touch is copied across, a handoff_claim review opens, and Sales owns the new thread', () => {
      const body = fn('crm.consume_channel_handoff');
      assert.match(body, /'handoff:' \|\| h\.id::text \|\| ':' \|\| r\.id::text/);
      assert.match(body, /_open_duplicate_review\(p_organization_id, h\.contact_id, p_contact_id, 'handoff_claim'/);
      assert.match(body, /'sales'/);
      assert.match(body, /'linked_for_review'/);
    });

    test('a bound handoff whose ingest did NOT continue the lead is left for a person, never guessed', () => {
      assert.match(fn('crm.consume_channel_handoff'), /'mismatch'/);
    });
  });

  describe('the reference is single-use and cannot be replayed, forged or carried across tenants', () => {
    test('the state machine allows only forward moves and never leaves a terminal state', () => {
      const body = fn('crm.channel_handoff_guard');
      assert.match(body, /old\.status = 'CREATED'\s+and new\.status in \('OPENED', 'RESOLVED', 'EXPIRED', 'CANCELLED', 'INVALID'\)/);
      assert.match(body, /old\.status = 'RESOLVED' and new\.status in \('CONSUMED', 'EXPIRED', 'CANCELLED', 'INVALID'\)/);
      assert.doesNotMatch(body, /old\.status = '(CONSUMED|EXPIRED|CANCELLED|INVALID)'/, 'a terminal state has no way out');
    });

    test('identity, context and lifetime are frozen, and a handoff is never deleted', () => {
      const body = fn('crm.channel_handoff_guard');
      for (const col of ['lead_id', 'token_hash', 'context', 'expires_at', 'organization_id']) assert.match(body, new RegExp(`new\\.${col}`), col);
      assert.match(body, /tg_op = 'DELETE'/);
    });

    test('at most one LIVE handoff per lead, so a retried creation cannot mint a second', () => {
      assert.match(sql, /create unique index if not exists channel_handoffs_one_live_per_lead\s+on crm\.channel_handoffs \(lead_id\) where status in \('CREATED', 'OPENED', 'RESOLVED'\)/);
      assert.match(fn('crm.create_channel_handoff'), /'exists'/);
    });

    test('only an UNUSED link expires: a RESOLVED one was already used', () => {
      assert.match(fn('crm.expire_channel_handoffs'), /x\.status in \('CREATED', 'OPENED'\) and x\.expires_at < now\(\)/);
      assert.match(fn('crm.open_channel_handoff'), /h\.status in \('CREATED', 'OPENED'\) and h\.expires_at < now\(\)/);
    });

    test('the token is stored only as a SHA-256 and the hash is not readable by a session', () => {
      assert.match(sql, /token_hash\s+text not null check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
      assert.match(sql, /revoke all on table crm\.channel_handoffs from public, anon, authenticated;\ngrant select \(/);
      const grant = sql.slice(sql.indexOf('grant select (id,'), sql.indexOf('on crm.channel_handoffs to authenticated;'));
      assert.doesNotMatch(grant, /token_hash/);
    });

    test('the context is built in the database from authoritative rows, not accepted from the caller', () => {
      const body = fn('crm.create_channel_handoff');
      assert.doesNotMatch(body.split('returns table')[0] ?? '', /p_context/);
      assert.match(body, /v_ctx := jsonb_build_object\(/);
      assert.match(body, /v_lead\.requirements/);
    });

    test('the engines\' doors are service-role only; creation and cancellation are admin-only for a session', () => {
      for (const sig of ['crm.open_channel_handoff(text)', 'crm.bind_handoff_from_message(text, text, text)', 'crm.consume_channel_handoff(uuid, uuid, uuid, uuid)', 'crm.expire_channel_handoffs(integer)']) {
        const esc = sig.replace(/[().]/g, '\\$&');
        assert.match(sql, new RegExp(`revoke all on function ${esc} from public, anon, authenticated`), sig);
        assert.match(sql, new RegExp(`grant execute on function ${esc} to service_role`), sig);
      }
      assert.match(fn('crm.cancel_channel_handoff'), /core\.is_admin\(\)/);
      assert.match(fn('crm.create_channel_handoff'), /p_organization_id is distinct from \(select core\.current_organization_id\(\)\) or not coalesce\(\(select core\.is_admin\(\)\)/);
    });
  });

  describe('the public link', () => {
    test('every failure is the same redirect home, so the route is not an oracle for which references exist', () => {
      assert.match(route, /const home = NextResponse\.redirect\(/);
      const returnsOfHome = route.match(/return home;/g) ?? [];
      assert.ok(returnsOfHome.length >= 3, 'malformed, error and not-open all return home');
      assert.match(route, /row\?\.outcome !== 'open' \|\| !row\.business_number/);
      assert.doesNotMatch(route, /NextResponse\.json/);
    });
    test('following the link only opens the handoff: it never binds, consumes or reads context', () => {
      assert.match(route, /rpc\('open_channel_handoff'/);
      for (const word of ['bind_handoff', 'consume_channel', 'context']) assert.doesNotMatch(route, new RegExp(word));
    });
  });

  describe('tenancy and privileges', () => {
    test('every new table revokes the platform default privileges before granting what it means to', () => {
      for (const t of ['whatsapp_handoff_settings', 'channel_handoffs']) assert.match(sql, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), t);
      for (const [file, tables] of [
        ['supabase/migrations/20261015100000_lead_generation_is_configured_not_coded.sql', ['target_services', 'icp_versions', 'acquisition_channels']],
        ['supabase/migrations/20261015200000_one_person_one_identity_across_channels.sql', ['identity_keys', 'duplicate_reviews', 'lead_touchpoints', 'lead_conversation_owner', 'conversation_owner_transfers']],
      ] as const) {
        const text = read(file);
        for (const t of tables) assert.match(text, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), `${file} ${t}`);
      }
    });
    test('every foreign key to an org-scoped parent is guarded and the table is frozen to its organisation', () => {
      for (const g of ['lead', 'contact', 'opportunity', 'consumed_contact', 'consumed_lead']) assert.match(sql, new RegExp(`create trigger org_match_channel_handoffs_${g} before insert or update of`), g);
      assert.match(sql, /create trigger freeze_org_channel_handoffs before update of organization_id/);
      assert.match(sql, /alter table crm\.channel_handoffs force row level security/);
    });
  });
});
