import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { B2B_CONNECTORS } from '../src/modules/acquisition/adapters.ts';
import { sendB2bProposal, runB2bOperations, type B2bConnector } from '../src/modules/acquisition/b2b.ts';
import { AUTOMATION_ORDER, b2bProblemWords, B2B_PLATFORMS, fitReasonWords, OFFPLATFORM_ORDER, OPPORTUNITY_WORDS, PROPOSAL_STATE_WORDS } from '../src/modules/acquisition/b2b-vocabulary.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261022100000_a_marketplace_rule_decides_whether_a_conversation_may_leave_it.sql');
const verifier = read('scripts/verify-acquisition-b2b.sql');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};
const quotedList = (text: string) => [...text.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1] as string);

type Script = { begin?: unknown; record?: unknown; version?: Record<string, unknown> | null; waiting?: unknown[]; approvalState?: string };
function fakeAdmin(script: Script) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    schema(name: string) {
      return {
        rpc: async (fnName: string, args: Record<string, unknown>) => {
          calls.push({ fn: `${name}.${fnName}`, args });
          if (fnName === 'begin_b2b_submit') return { data: script.begin ?? [{ outcome: 'blocked', reason: 'platform_not_automated', execution_id: null }], error: null };
          if (fnName === 'record_b2b_submit') return { data: script.record ?? [{ outcome: 'recorded' }], error: null };
          if (fnName === 'sync_b2b_approvals') return { data: 0, error: null };
          return { data: null, error: null };
        },
        from(table: string) {
          const chain: Record<string, unknown> = {};
          for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit']) chain[m] = () => chain;
          chain.maybeSingle = async () => {
            if (table === 'b2b_proposal_versions') return { data: script.version === undefined ? { opportunity_id: 'opp', body: 'Approved words.', price_minor: 150000, currency: 'USD', timeline_days: 21, connects_cost: 4, content_hash: 'a'.repeat(64) } : script.version, error: null };
            if (table === 'b2b_opportunities') return { data: { platform: 'upwork', external_ref: 'job-1', title: 'A job' }, error: null };
            if (table === 'approval_requests') return { data: { state: script.approvalState ?? 'approved' }, error: null };
            return { data: null, error: null };
          };
          chain.then = (resolve: (v: unknown) => void) => resolve({ data: table === 'b2b_proposal_versions' ? script.waiting ?? [] : [], error: null });
          return chain;
        },
      };
    },
  } as never;
  return { admin, calls };
}

describe('lead generation, slice 10 - a marketplace\'s rule decides whether a conversation may leave it', () => {
  describe('the rule table fails closed', () => {
    test('the default is the restrictive one, and a platform with no row is forbidden', () => {
      assert.match(sql, /offplatform_contact text not null default 'forbidden'/);
      assert.match(sql, /automation_mode\s+text not null default 'manual'/);
      assert.match(fn('crm.b2b_copy_problems'), /p_offplatform is distinct from 'allowed'/);
      assert.match(fn('crm.check_b2b_proposal'), /coalesce\(rule\.offplatform_contact, 'forbidden'\)/);
    });

    test('loosening a rule is the owner\'s; tightening is the admin\'s', () => {
      const body = fn('crm.set_b2b_platform_rule');
      assert.match(body, /array_position\(array\['forbidden', 'after_award', 'allowed'\]/);
      assert.match(body, /array_position\(array\['manual', 'assisted', 'automated'\]/);
      assert.match(body, /if v_loosens and not coalesce\(\(select core\.is_owner\(\)\), false\)/);
    });

    test('the tracked WhatsApp handoff is carried forward so a B2B handoff needs the marketplace\'s permission', () => {
      const body = fn('crm.create_channel_handoff');
      assert.match(body, /if p_source_channel = 'b2b' then/);
      assert.match(body, /platform_required/);
      assert.match(body, /offplatform_forbidden/);
      assert.match(body, /r\.offplatform_contact = 'allowed'/);
      assert.match(body, /r\.offplatform_contact = 'after_award' and exists \(select 1 from crm\.b2b_opportunities o where o\.organization_id = p_organization_id and o\.lead_id = p_lead and o\.status = 'won'\)/);
      // the original body is otherwise intact: it still builds the package from authoritative rows
      assert.match(body, /The package is built HERE from authoritative rows/);
    });
  });

  describe('opportunities are facts, judged by the Admin\'s own thresholds', () => {
    test('the facts are frozen and the judgement moves only through the doors; a won or lost job never reopens', () => {
      const guard = fn('crm.b2b_opportunity_guard');
      for (const col of ['title', 'description', 'budget_min_minor', 'budget_max_minor', 'external_ref', 'posted_at']) assert.match(guard, new RegExp(`new\\.${col}`), col);
      assert.match(guard, /current_setting\('crm\.b2b_write', true\)/);
      assert.match(guard, /old\.status in \('won', 'lost'\)/);
    });

    test('an excluded term is a refusal, checked before any score is added', () => {
      const body = fn('crm.b2b_fit');
      assert.ok(body.indexOf("'excluded'") < body.indexOf('v_score := v_score + 50'));
      assert.match(body, /return query select 0, 'excluded'::text/);
      assert.match(fn('crm.decide_b2b_opportunity'), /if o\.status = 'excluded' then return query select 'excluded'::text/);
    });

    test('the score is explainable: every reason the database can give has words', () => {
      const reasons = quotedList(fn('crm.b2b_fit')).filter((c) => ['no_target_service_mentioned', 'budget_ok', 'budget_not_stated', 'budget_below_minimum', 'enough_detail', 'thin_description'].includes(c));
      assert.equal(new Set(reasons).size, 6);
      for (const r of reasons) assert.notEqual(fitReasonWords(r), r, r);
      assert.match(fitReasonWords('service_match:Website Development'), /Website Development/);
      assert.match(fitReasonWords('excluded_term:wordpress'), /excluded/);
    });
  });

  describe('proposals are immutable versions that a person prices', () => {
    test('the hash is derived by a trigger from the platform, job, words, price, timeline, connects and past work', () => {
      assert.match(sql, /create trigger b2b_proposal_stamp before insert on crm\.b2b_proposal_versions/);
      const stamp = fn('crm.b2b_proposal_stamp');
      for (const part of ["'platform', o.platform", "'external_ref', o.external_ref", "'body', new.body", "'price', new.price_minor", "'timeline'", "'connects'", "'portfolio'"]) assert.ok(stamp.includes(part), part);
    });

    test('words, price, timeline, connects and hash are frozen; state and submission move only through the doors', () => {
      const guard = fn('crm.b2b_proposal_guard');
      for (const col of ['body', 'price_minor', 'timeline_days', 'connects_cost', 'portfolio_item_ids', 'content_hash']) assert.match(guard, new RegExp(`new\\.${col}`), col);
      assert.match(guard, /new\.external_ref, new\.submitted_via/);
      assert.doesNotMatch(guard, /old\.state = 'DRAFT'\s+and new\.state in \([^)]*'SUBMITTED'/);
      assert.match(guard, /old\.state = 'SUBMITTING'\s+and new\.state in \('SUBMITTED', 'ADMIN_REVIEW'\)/);
    });

    test('an agent can never carry a price - in the table and in the door', () => {
      assert.match(sql, /constraint b2b_proposal_price_is_human check \(price_minor is null or created_by_type = 'human'\)/);
      assert.match(fn('crm.add_b2b_proposal_version'), /\(p_by_type <> 'human' and p_price_minor is not null\)/);
      assert.match(fn('crm.check_b2b_proposal'), /needs_a_price_from_a_person/);
    });

    test('where a marketplace forbids it, a proposal may hold no email, phone, messaging app or link', () => {
      const body = fn('crm.b2b_copy_problems');
      for (const code of ['contains_an_email_address', 'contains_a_phone_number', 'names_a_messaging_app', 'contains_an_external_link']) assert.ok(body.includes(code), code);
    });

    test('one proposal is sent per job, in the database', () => {
      assert.match(sql, /create unique index if not exists b2b_proposals_one_submitting_key on crm\.b2b_proposal_versions \(opportunity_id\) where state in \('SUBMITTING', 'SUBMITTED'\)/);
    });
  });

  describe('sending is governed, once, and re-reads everything at that moment', () => {
    test('a person\'s recorded submission needs no connector but is held to the stops, the daily limit, the budget and the exact approval', () => {
      const begin = fn('crm._b2b_begin_submit');
      assert.match(begin, /crm\.acquisition_blocked\(p_organization_id, 'b2b'\)/);
      assert.match(begin, /ch\.daily_limit/);
      assert.match(begin, /monthly_connects_exceeded/);
      assert.match(begin, /crm\.begin_governed_execution\(p_organization_id, v\.approval_request_id, 'b2b_proposal', v\.id, v\.content_hash, 'b2b_proposal_submit', 'b2b'/);
      assert.ok(begin.indexOf('monthly_connects_exceeded') < begin.indexOf('begin_governed_execution'));
    });

    test('the engine path additionally needs the platform marked automated and a connector, through the one policy question', () => {
      const begin = fn('crm._b2b_begin_submit');
      assert.match(begin, /if p_via = 'adapter' then/);
      assert.match(begin, /platform_not_automated/);
      assert.match(begin, /crm\.acquisition_decide\(p_organization_id, 'b2b_proposal_submit', 'b2b'/);
    });

    test('the internals are unreachable and the machine doors are the engine\'s alone', () => {
      for (const f of ['_b2b_begin_submit(uuid, uuid, text, uuid)', '_b2b_finish_submit(uuid, uuid, uuid, text, text, text, jsonb)', '_b2b_set(text, uuid, text)']) {
        assert.match(sql, new RegExp(`revoke all on function crm\\.${f.replace(/[()]/g, '\\$&')} from public, anon, authenticated`), f);
        assert.doesNotMatch(sql, new RegExp(`grant execute on function crm\\.${f.replace(/[()]/g, '\\$&')}`), f);
      }
      for (const f of ['begin_b2b_submit(uuid, uuid, uuid)', 'record_b2b_submit(uuid, uuid, uuid, text, text, jsonb)', 'sync_b2b_approvals(integer)']) assert.match(sql, new RegExp(`grant execute on function crm\\.${f.replace(/[()]/g, '\\$&')} to service_role`), f);
    });

    test('a successful send counts one action and its connects, once', () => {
      const fin = fn('crm._b2b_finish_submit');
      assert.match(fin, /record_acquisition_usage\(p_organization_id, 'b2b', 'action', 1, 'b2b-submit:'/);
      assert.match(fin, /record_acquisition_usage\(p_organization_id, 'b2b', 'connect', v\.connects_cost, 'b2b-connects:'/);
    });
  });

  describe('every table is tenant-bound', () => {
    test('forced RLS, internal-only reads, explicit revokes, organisation frozen', () => {
      for (const t of ['b2b_platform_rules', 'b2b_settings', 'b2b_opportunities', 'b2b_proposal_versions', 'b2b_profile_versions']) {
        assert.match(sql, new RegExp(`alter table crm\\.${t} force row level security`), t);
        assert.match(sql, new RegExp(`revoke all on table crm\\.${t} from public, anon, authenticated`), t);
        assert.match(sql, new RegExp(`create trigger freeze_org_${t} before update of organization_id on crm\\.${t}`), t);
        assert.match(sql, new RegExp(`create policy ${t}_select on crm\\.${t} for select to authenticated using \\(organization_id = \\(select core\\.current_organization_id\\(\\)\\) and \\(select core\\.is_internal\\(\\)\\)\\)`), t);
      }
      assert.match(sql, /core\.enforce_parent_org\('opportunity_id', 'crm\.b2b_opportunities'\)/);
      assert.match(sql, /core\.enforce_parent_org\('lead_id', 'crm\.leads'\)/);
    });
  });

  describe('the vocabulary covers what the database can say', () => {
    test('every state, status and problem code has words', () => {
      const proposalStates = quotedList(sql.match(/state\s+text not null default 'DRAFT' check \(state in \(([^)]*)\)\)/)?.[1] ?? '');
      assert.ok(proposalStates.includes('SUBMITTED'));
      for (const s of [...proposalStates, 'APPLIED']) assert.ok(PROPOSAL_STATE_WORDS[s], s);
      const statuses = quotedList(sql.match(/status\s+text not null default 'new' check \(status in \(([^)]*)\)\)/)?.[1] ?? '');
      assert.equal(statuses.length, 9);
      for (const s of statuses) assert.ok(OPPORTUNITY_WORDS[s], s);
      const codes = [...[fn('crm.b2b_copy_problems'), fn('crm.check_b2b_proposal'), fn('crm.b2b_profile_problems')].join('\n').matchAll(/to_jsonb\('([a-z_0-9]+)'(?:::text)?\)/g)].map((m) => m[1] as string);
      assert.ok(codes.length >= 12, `found ${codes.length}`);
      for (const c of codes) assert.notEqual(b2bProblemWords(c), c, `${c} has no words`);
      assert.deepEqual([...B2B_PLATFORMS].sort(), quotedList(sql.match(/platform\s+text not null check \(platform in \(([^)]*)\)\)/)?.[1] ?? '').sort());
      assert.deepEqual([...OFFPLATFORM_ORDER], ['forbidden', 'after_award', 'allowed']);
      assert.deepEqual([...AUTOMATION_ORDER], ['manual', 'assisted', 'automated']);
    });
  });

  describe('the worker never sends without the governed door, and never fakes it', () => {
    const connector = (over: Partial<B2bConnector> = {}): { c: B2bConnector; seen: unknown[] } => {
      const seen: unknown[] = [];
      return { seen, c: { send: async (i) => { seen.push(i); return { status: 'sent', externalRef: 'plat-9' }; }, ...over } };
    };

    test('no connector exists, and nothing pretends one does', () => {
      assert.deepEqual(Object.keys(B2B_CONNECTORS), []);
    });

    test('a send the door refuses never reaches the platform', async () => {
      const { admin, calls } = fakeAdmin({});
      const { c, seen } = connector();
      const r = await sendB2bProposal(admin, { organizationId: 'org', versionId: 'v', connector: c });
      assert.deepEqual(r, { outcome: 'not_proceeding', reason: 'blocked:platform_not_automated' });
      assert.equal(seen.length, 0);
      assert.deepEqual(calls.map((x) => x.fn), ['crm.begin_b2b_submit']);
    });

    test('an approved send passes exactly the version row\'s words and price, then records the platform\'s reference', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', reason: 'first_execution', execution_id: 'ex' }] });
      const { c, seen } = connector();
      assert.deepEqual(await sendB2bProposal(admin, { organizationId: 'org', versionId: 'v', connector: c }), { outcome: 'sent' });
      const sent = seen[0] as { body: string; priceMinor: number; contentHash: string };
      assert.equal(sent.body, 'Approved words.');
      assert.equal(sent.priceMinor, 150000);
      const rec = calls.find((x) => x.fn === 'crm.record_b2b_submit');
      assert.equal(rec?.args.p_status, 'executed');
      assert.equal(rec?.args.p_external_ref, 'plat-9');
    });

    test('a connector that throws is UNKNOWN (never resent); one that refuses is a failure', async () => {
      const thrown = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }] });
      const r1 = await sendB2bProposal(thrown.admin, { organizationId: 'org', versionId: 'v', connector: { send: async () => { throw new Error('timeout'); } } });
      assert.equal(r1.outcome, 'unknown');
      assert.equal(thrown.calls.find((x) => x.fn === 'crm.record_b2b_submit')?.args.p_status, 'unknown');
      const refused = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }] });
      const r2 = await sendB2bProposal(refused.admin, { organizationId: 'org', versionId: 'v', connector: { send: async () => ({ status: 'rejected', reason: 'no connects left' }) } });
      assert.deepEqual(r2, { outcome: 'failed', reason: 'no connects left' });
    });

    test('a version with no price is never sent (an agent\'s draft cannot reach the platform)', async () => {
      const { admin, calls } = fakeAdmin({ begin: [{ outcome: 'proceed', execution_id: 'ex' }], version: { opportunity_id: 'opp', body: 'x', price_minor: null, currency: 'USD', timeline_days: 1, connects_cost: 0, content_hash: 'a'.repeat(64) } });
      const { c, seen } = connector();
      const r = await sendB2bProposal(admin, { organizationId: 'org', versionId: 'v', connector: c });
      assert.equal(r.outcome, 'unknown');
      assert.equal(seen.length, 0);
      assert.equal(calls.find((x) => x.fn === 'crm.record_b2b_submit')?.args.p_status, 'unknown');
    });

    test('with no connector the sweep tells a person once per proposal and sends nothing', async () => {
      const { admin, calls } = fakeAdmin({ waiting: [{ id: 'v1', organization_id: 'org', opportunity_id: 'opp', approval_request_id: 'req' }] });
      const sweep = await runB2bOperations(admin, {});
      assert.equal(sweep.waitingForAPerson, 1);
      assert.equal(sweep.sent, 0);
      assert.equal(calls.filter((x) => x.fn === 'core.raise_alert').length, 1);
      assert.equal(calls.some((x) => x.fn === 'crm.begin_b2b_submit'), false);
    });

    test('an approval that is not approved raises nothing and sends nothing', async () => {
      const { admin, calls } = fakeAdmin({ waiting: [{ id: 'v1', organization_id: 'org', opportunity_id: 'opp', approval_request_id: 'req' }], approvalState: 'pending' });
      await runB2bOperations(admin, { upwork: connector().c });
      assert.equal(calls.some((x) => x.fn === 'core.raise_alert' || x.fn === 'crm.begin_b2b_submit'), false);
    });
  });

  describe('the verifier proves it on a real database', () => {
    test('it drives the approval engine, the governed door and the handoff, and is wired into the verify chain', () => {
      for (const part of ['approvals.decide_approval', 'crm.record_manual_b2b_submission', 'crm.create_channel_handoff', 'crm.record_manual_profile_update', 'monthly_connects_exceeded', 'ALL CHECKS PASSED']) assert.ok(verifier.includes(part), part);
      assert.match(read('package.json'), /verify-acquisition-b2b\.sql/);
      assert.match(read('scripts/verify-acquisition-handoff.sql'), /a B2B handoff with no marketplace rule is refused/);
    });
  });
});
