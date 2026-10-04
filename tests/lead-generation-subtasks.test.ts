import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { CONVERSATION_OWNERS } from '../src/modules/acquisition/identity.ts';
import { acceptSubtask, linkSubtaskProposal, requestMeeting, requestQuotation } from '../src/modules/acquisition/subtasks.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const sql = read('supabase/migrations/20261017100000_a_subtask_returns_to_the_conversation_owner.sql');
const ts = read('src/modules/acquisition/subtasks.ts');

const fn = (name: string) => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start > 0, `${name} is missing`);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

describe('lead generation, slice 5 - a subtask returns to the conversation owner', () => {
  describe('there is no second meeting or quotation lifecycle', () => {
    test('the migration creates no meeting or proposal table and re-emits none of their doors', () => {
      for (const t of ['crm.meetings', 'sales.proposals']) assert.doesNotMatch(sql, new RegExp(`create table (if not exists )?${t.replace('.', '\\.')}\\b`));
      for (const door of ['request_meeting', 'book_meeting', 'reschedule_meeting', 'complete_meeting', 'cancel_meeting', 'propose_meeting_slots', 'draft_proposal', 'decide_approval']) {
        assert.doesNotMatch(sql, new RegExp(`create or replace function [a-z_.]*${door}\\(`), door);
      }
      assert.match(fn('crm.request_subtask'), /crm\.request_meeting\(/);
    });

    test('the meeting link follows a reschedule (the new row) and is not failed by the old row being cancelled', () => {
      const body = fn('crm.carry_meeting_to_subtask');
      assert.match(body, /new\.supersedes_id/);
      assert.match(body, /where meeting_id = new\.supersedes_id and status = 'IN_PROGRESS'/);
      assert.match(body, /like 'rescheduled%'/);
    });

    test('only an IN_PROGRESS subtask is moved by the lifecycles it follows', () => {
      assert.match(fn('crm.carry_meeting_to_subtask'), /x\.meeting_id = new\.id and x\.status = 'IN_PROGRESS'/);
      assert.match(fn('crm.carry_proposal_to_subtask'), /x\.proposal_id = new\.id and x\.status = 'IN_PROGRESS'/);
    });

    test('the AFTER triggers audit and swallow their own failure: bookkeeping must never stop a booking or an approval', () => {
      for (const name of ['crm.carry_meeting_to_subtask', 'crm.carry_proposal_to_subtask']) {
        const body = fn(name);
        assert.match(body, /exception when others then/, name);
        assert.match(body, /subtask\.carry_failed/, name);
      }
      assert.match(sql, /create trigger carry_meeting_to_subtask after insert or update of status, outcome on crm\.meetings/);
      assert.match(sql, /create trigger carry_proposal_to_subtask after insert or update of status on sales\.proposals/);
    });
  });

  describe('authority', () => {
    test('only the conversation owner may ask, and the Scheduler / Quotation Master are not owners', () => {
      const body = fn('crm.request_subtask');
      assert.match(body, /v_actor is null and p_requesting_agent is distinct from v_owner/);
      assert.match(body, /'no_owner'/);
      const owners = [...(sql.match(/requested_by_owner text not null check \(requested_by_owner in \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
      assert.deepEqual(owners, [...CONVERSATION_OWNERS] as string[]);
      for (const subtask of ['scheduler', 'quotation_master']) assert.ok(!(owners as string[]).includes(subtask), subtask);
    });

    test('a request cannot carry a price - for either kind, at any depth - and the TypeScript door has nowhere to put one', () => {
      const body = fn('crm.request_subtask');
      assert.match(body, /crm\._json_has_key\(v_input, array\['price'/);
      for (const key of ['price', 'discount', 'total', 'amount', 'fee', 'rate', 'cost', 'payment_terms']) assert.match(body, new RegExp(`'${key}'`), key);
      assert.ok(body.indexOf('pricing_not_allowed') < body.indexOf('insert into crm.subtask_requests'), 'refused before anything is written');
      assert.match(fn('crm._json_has_key'), /jsonb_array_elements/);
      const qStart = ts.indexOf('export function requestQuotation');
      const qEnd = ts.indexOf('export async function acceptSubtask', qStart);
      assert.ok(qStart > 0 && qEnd > qStart, 'requestQuotation region not found');
      assert.doesNotMatch(ts.slice(qStart, qEnd), /price|amount|discount|total/i);
    });

    test('a quotation is built from CONFIRMED requirements of THIS lead, and a proposal from any other version cannot satisfy it', () => {
      assert.match(fn('crm.request_subtask'), /rv\.status = 'accepted' and c\.lead_id = p_lead/);
      assert.match(sql, /constraint subtask_requests_quotation_names_requirements check \(kind <> 'prepare_quotation' or requirement_version_id is not null\)/);
      const link = fn('crm.link_subtask_proposal');
      assert.match(link, /p\.requirement_version_id is distinct from s\.requirement_version_id then return query select 'requirement_mismatch'/);
      assert.match(link, /v_lead is distinct from s\.lead_id then return query select 'lead_mismatch'/);
    });

    test('a closed lead takes no subtask', () => {
      assert.match(fn('crm.request_subtask'), /crm\.lead_outcome\(p_lead\) in \('WON', 'LOST', 'DISQUALIFIED'\)/);
    });

    test('control returns to whoever owns the conversation AT THE TIME IT ENDS, and the requester is kept apart', () => {
      const body = fn('crm._close_subtask');
      assert.match(body, /select o\.owner into v_owner from crm\.lead_conversation_owner o where o\.lead_id = s\.lead_id/);
      assert.match(body, /returned_to_owner = v_owner/);
      assert.match(sql, /requested_by_owner text not null/);
    });

    test('a subtask never changes the conversation owner', () => {
      assert.doesNotMatch(sql, /transfer_conversation_owner|update crm\.lead_conversation_owner|insert into crm\.lead_conversation_owner/);
    });
  });

  describe('idempotency and history', () => {
    test('the same key asks once, and only one subtask per kind is open per lead', () => {
      assert.match(sql, /create unique index if not exists subtask_requests_idempotency_key on crm\.subtask_requests \(organization_id, idempotency_key\)/);
      assert.match(sql, /create unique index if not exists subtask_requests_one_open_per_kind on crm\.subtask_requests \(lead_id, kind\) where status in \('REQUESTED', 'IN_PROGRESS'\)/);
      assert.match(fn('crm.request_subtask'), /'exists_open'/);
    });

    test('what was asked is frozen, an ended subtask is closed for good, and nothing is deleted', () => {
      const body = fn('crm.subtask_guard');
      for (const col of ['input', 'objective', 'requested_by_owner', 'requirement_version_id', 'lead_id', 'idempotency_key']) assert.match(body, new RegExp(`new\\.${col}`), col);
      assert.match(body, /old\.status in \('COMPLETED', 'FAILED', 'CANCELLED'\) then\s+raise exception/);
      assert.match(body, /tg_op = 'DELETE'/);
    });

    test('the doors that end a subtask are admin-or-service, need a reason, and are audited', () => {
      for (const name of ['crm.cancel_subtask', 'crm.fail_subtask']) {
        const body = fn(name);
        assert.match(body, /core\.is_admin\(\)/, name);
        assert.match(body, /'needs_reason'/, name);
      }
      assert.match(fn('crm._close_subtask'), /core\.record_audit\(s\.organization_id, 'subtask\.' \|\| lower\(p_status\)/);
      assert.match(sql, /revoke all on function crm\._close_subtask\([^)]*\) from public, anon, authenticated/);
    });
  });

  describe('tenancy', () => {
    test('the table revokes default privileges, is frozen to its organisation, guards every foreign key and forces RLS', () => {
      assert.match(sql, /revoke all on table crm\.subtask_requests from public, anon, authenticated/);
      assert.match(sql, /create trigger freeze_org_subtask_requests before update of organization_id/);
      for (const g of ['lead', 'requirement', 'meeting', 'proposal']) assert.match(sql, new RegExp(`create trigger org_match_subtask_requests_${g} before insert or update of`), g);
      assert.match(sql, /alter table crm\.subtask_requests force row level security/);
    });
  });

  describe('the typed doors', () => {
    const answer = (data: unknown) => ({ schema: () => ({ rpc: async () => ({ data, error: null }) }) }) as never;
    const base = { organizationId: 'o', leadId: 'l', requestingAgent: 'email_outreach' as const, idempotencyKey: 'a-long-enough-key' };

    test('a created subtask and a refusal both come back typed, and a missing answer is a refusal', async () => {
      const ok = await requestMeeting(answer([{ outcome: 'created', subtask_id: 's1', meeting_id: 'm1' }]), { ...base, objective: 'intro call', meeting: { mode: 'call', timezone: 'Asia/Kolkata' } });
      assert.deepEqual(ok, { ok: true, outcome: 'created', subtaskId: 's1', meetingId: 'm1' });
      const refused = await requestMeeting(answer([{ outcome: 'not_owner' }]), { ...base, objective: 'intro call', meeting: { mode: 'call', timezone: 'Asia/Kolkata' } });
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.refusal, 'not_owner');
      const nothing = await requestQuotation(answer(null), { ...base, requestingAgent: 'sales', objective: 'quote it', requirementVersionId: 'rv' });
      assert.equal(nothing.ok, false);
    });

    test('it sends exactly the structured payload: no price field exists to send', async () => {
      let sent: Record<string, unknown> | undefined;
      const spy = { schema: () => ({ rpc: async (_n: string, args: Record<string, unknown>) => { sent = args; return { data: [{ outcome: 'created', subtask_id: 's', meeting_id: null }], error: null }; } }) } as never;
      await requestQuotation(spy, { ...base, requestingAgent: 'sales', objective: 'quote it', requirementVersionId: 'rv-1', notes: '8 pages' });
      assert.deepEqual(sent?.p_input, { requirement_version_id: 'rv-1', notes: '8 pages' });
      assert.equal(sent?.p_kind, 'prepare_quotation');
    });

    test('accept and link surface the database outcome as a string, and default to invalid', async () => {
      assert.equal(await acceptSubtask(answer([{ outcome: 'accepted' }]), { organizationId: 'o', subtaskId: 's', assignee: 'quotation_master' }), 'accepted');
      assert.equal(await linkSubtaskProposal(answer([{ outcome: 'requirement_mismatch' }]), { organizationId: 'o', subtaskId: 's', proposalId: 'p' }), 'requirement_mismatch');
      assert.equal(await linkSubtaskProposal(answer(null), { organizationId: 'o', subtaskId: 's', proposalId: 'p' }), 'invalid');
    });
  });
});
