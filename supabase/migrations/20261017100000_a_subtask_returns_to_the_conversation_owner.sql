-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 5 — a Scheduler or Quotation task is a SUBTASK, and
-- control returns to whoever owns the conversation.
--
-- Spec §40, §44, §86, §87, §173. An acquisition agent that needs a meeting or a
-- quotation does not "continue this lead" to another agent. It hands over a
-- structured request, the other agent owns ONLY that subtask, and when it ends
-- control is back with the conversation owner. Scheduler has no pricing
-- authority; the Quotation Master works from confirmed requirements and
-- configured pricing, never from a number somebody typed into the request.
--
-- What the audit found: the meeting doors already admit the service role ("the
-- Scheduler agent records a request"), and the quote engine already versions
-- and binds approval to a row - but nothing connects a REQUEST from an owner to
-- those lifecycles, nothing stops a non-owner asking, and nothing carries the
-- result back. Building a second meeting or quote lifecycle would be the
-- parallel system the specification forbids, so this is a thin LINK over the two
-- that exist:
--
--   * crm.subtask_requests is the structured request and its result package.
--   * A meeting subtask CREATES (or finds - one live meeting per lead is
--     already a rule) the crm.meetings row through the existing door, and a
--     trigger carries every later move of that row back: booked, rescheduled
--     (a reschedule is a NEW row with supersedes_id, so the link follows it),
--     cancelled, no-show, completed.
--   * A quotation subtask names the CONFIRMED requirement version it must be
--     built from; linking a proposal built from any other version is refused,
--     and a trigger completes the subtask once the proposal is approved/sent.
--   * Only the conversation owner may ask (a Scheduler or Quotation Master can
--     never ask for work on a lead it does not own, and never owns one), no
--     request may carry a price, and a closed lead takes none.
--
-- Triggers on crm.meetings and sales.proposals are AFTER triggers that audit and
-- swallow their own failure: a bookkeeping error must never stop a person
-- booking a meeting or approving a quote.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. a request may not carry a price ─────────────────────────────────────

create or replace function crm._json_has_key(p jsonb, p_keys text[])
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p) = 'object' then
    for k, v in select e.key, e.value from jsonb_each(p) as e loop
      if lower(k) = any (p_keys) then return true; end if;
      if crm._json_has_key(v, p_keys) then return true; end if;
    end loop;
  elsif jsonb_typeof(p) = 'array' then
    for v in select e.value from jsonb_array_elements(p) as e loop
      if crm._json_has_key(v, p_keys) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;

-- ── 2. the subtask ─────────────────────────────────────────────────────────

create table if not exists crm.subtask_requests (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  lead_id            uuid not null references crm.leads(id) on delete restrict,
  kind               text not null check (kind in ('schedule_meeting', 'prepare_quotation')),
  requested_by_owner text not null check (requested_by_owner in ('email_outreach', 'social_media', 'b2b_opportunity', 'sales', 'human')),
  assignee           text check (assignee is null or assignee in ('scheduler', 'quotation_master', 'human')),
  status             text not null default 'REQUESTED' check (status in ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED')),
  priority           integer not null default 3 check (priority between 1 and 5),
  objective          text not null check (length(btrim(objective)) between 3 and 500),
  input              jsonb not null check (jsonb_typeof(input) = 'object' and octet_length(input::text) <= 10000),
  context_refs       jsonb not null default '{}'::jsonb check (jsonb_typeof(context_refs) = 'object'),
  requirement_version_id uuid references crm.requirement_versions(id) on delete restrict,
  meeting_id         uuid references crm.meetings(id) on delete set null,
  proposal_id        uuid references sales.proposals(id) on delete set null,
  progress           jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  result             jsonb check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 20000)),
  failure_reason     text check (failure_reason is null or length(failure_reason) <= 500),
  returned_to_owner  text check (returned_to_owner is null or returned_to_owner in ('email_outreach', 'social_media', 'b2b_opportunity', 'sales', 'human')),
  idempotency_key    text not null check (length(idempotency_key) between 8 and 120),
  correlation_id     uuid,
  created_by         uuid references core.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  accepted_at        timestamptz,
  completed_at       timestamptz,
  updated_at         timestamptz not null default now(),
  constraint subtask_requests_closed_says_when check (status not in ('COMPLETED', 'FAILED', 'CANCELLED') or completed_at is not null),
  constraint subtask_requests_quotation_names_requirements check (kind <> 'prepare_quotation' or requirement_version_id is not null)
);
create unique index if not exists subtask_requests_idempotency_key on crm.subtask_requests (organization_id, idempotency_key);
create unique index if not exists subtask_requests_one_open_per_kind on crm.subtask_requests (lead_id, kind) where status in ('REQUESTED', 'IN_PROGRESS');
create index if not exists subtask_requests_org_status_idx on crm.subtask_requests (organization_id, status, priority, created_at);
create index if not exists subtask_requests_meeting_idx on crm.subtask_requests (meeting_id) where meeting_id is not null;
create index if not exists subtask_requests_proposal_idx on crm.subtask_requests (proposal_id) where proposal_id is not null;

comment on table crm.subtask_requests is
  'A structured request from a conversation owner for ONE subtask - a meeting or a quotation (spec §44). The assignee owns only the subtask; the conversation owner never changes because of it, and the result returns to the owner at the time it ends. Links to the existing meeting and proposal lifecycles; it is not a second one. Never deleted.';

create or replace function crm.subtask_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'a subtask is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.lead_id, new.kind, new.requested_by_owner, new.objective, new.input, new.context_refs,
      new.requirement_version_id, new.idempotency_key, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.lead_id, old.kind, old.requested_by_owner, old.objective, old.input, old.context_refs,
      old.requirement_version_id, old.idempotency_key, old.created_by, old.created_at) then
    raise exception 'what a subtask asked for is fixed when it is asked' using errcode = '42501';
  end if;
  if old.status in ('COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception 'a % subtask is closed', old.status using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'REQUESTED'   and new.status in ('IN_PROGRESS', 'FAILED', 'CANCELLED'))
    or (old.status = 'IN_PROGRESS' and new.status in ('COMPLETED', 'FAILED', 'CANCELLED'))) then
    raise exception 'a subtask cannot go from % to %', old.status, new.status using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists subtask_guard on crm.subtask_requests;
create trigger subtask_guard before update or delete on crm.subtask_requests for each row execute function crm.subtask_guard();

drop trigger if exists freeze_org_subtask_requests on crm.subtask_requests;
create trigger freeze_org_subtask_requests before update of organization_id on crm.subtask_requests for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_subtask_requests_lead on crm.subtask_requests;
create trigger org_match_subtask_requests_lead before insert or update of lead_id, organization_id on crm.subtask_requests
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');
drop trigger if exists org_match_subtask_requests_requirement on crm.subtask_requests;
create trigger org_match_subtask_requests_requirement before insert or update of requirement_version_id, organization_id on crm.subtask_requests
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');
drop trigger if exists org_match_subtask_requests_meeting on crm.subtask_requests;
create trigger org_match_subtask_requests_meeting before insert or update of meeting_id, organization_id on crm.subtask_requests
  for each row execute function core.enforce_parent_org('meeting_id', 'crm.meetings');
drop trigger if exists org_match_subtask_requests_proposal on crm.subtask_requests;
create trigger org_match_subtask_requests_proposal before insert or update of proposal_id, organization_id on crm.subtask_requests
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');
alter table crm.subtask_requests enable row level security;
alter table crm.subtask_requests force row level security;
drop policy if exists subtask_requests_select on crm.subtask_requests;
create policy subtask_requests_select on crm.subtask_requests for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.subtask_requests from public, anon, authenticated;
grant select on crm.subtask_requests to authenticated;
grant select, insert, update on crm.subtask_requests to service_role;

-- ── 3. request ─────────────────────────────────────────────────────────────

create or replace function crm.request_subtask(
  p_organization_id uuid, p_lead uuid, p_kind text, p_requesting_agent text, p_objective text, p_input jsonb,
  p_idempotency_key text, p_priority integer default 3, p_correlation_id uuid default null
)
returns table (outcome text, subtask_id uuid, meeting_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_lead   crm.leads;
  v_owner  text;
  v_exist  crm.subtask_requests;
  v_input  jsonb := coalesce(p_input, '{}'::jsonb);
  v_rv     uuid;
  v_mode   text;
  v_new    uuid;
  v_meeting uuid;
  v_mreq   record;
  v_start  timestamptz;
  v_end    timestamptz;
  v_dur    integer;
begin
  if v_actor is not null then
    if p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false) then
      return query select 'forbidden'::text, null::uuid, null::uuid; return;
    end if;
  end if;
  if p_kind not in ('schedule_meeting', 'prepare_quotation')
     or p_requesting_agent not in ('email_outreach', 'social_media', 'b2b_opportunity', 'sales', 'human')
     or length(btrim(coalesce(p_objective, ''))) not between 3 and 500
     or jsonb_typeof(v_input) <> 'object' or octet_length(v_input::text) > 10000
     or length(coalesce(p_idempotency_key, '')) not between 8 and 120
     or coalesce(p_priority, 3) not between 1 and 5 then
    return query select 'invalid'::text, null::uuid, null::uuid; return;
  end if;

  -- Neither a meeting nor a quotation request may carry a price. The Scheduler has no pricing authority, and the Quotation
  -- Master builds from configured pricing: a number typed into the request would be a price an agent decided.
  if crm._json_has_key(v_input, array['price', 'prices', 'pricing', 'discount', 'total', 'amount', 'fee', 'fees', 'rate', 'cost',
                                      'quote_amount', 'payment_terms', 'payment_plan']) then
    return query select 'pricing_not_allowed'::text, null::uuid, null::uuid; return;
  end if;

  select * into v_exist from crm.subtask_requests s where s.organization_id = p_organization_id and s.idempotency_key = p_idempotency_key;
  if v_exist.id is not null then return query select 'exists'::text, v_exist.id, v_exist.meeting_id; return; end if;

  select * into v_lead from crm.leads l where l.id = p_lead and l.organization_id = p_organization_id for update;
  if v_lead.id is null then return query select 'unknown_lead'::text, null::uuid, null::uuid; return; end if;
  if v_lead.merged_into_lead_id is not null or crm.lead_outcome(p_lead) in ('WON', 'LOST', 'DISQUALIFIED') then
    return query select 'closed'::text, null::uuid, null::uuid; return;
  end if;

  -- Only the conversation owner may ask. A person acting as an admin may ask on the owner's behalf.
  select o.owner into v_owner from crm.lead_conversation_owner o where o.lead_id = p_lead;
  if v_owner is null then return query select 'no_owner'::text, null::uuid, null::uuid; return; end if;
  if v_actor is null and p_requesting_agent is distinct from v_owner then
    return query select 'not_owner'::text, null::uuid, null::uuid; return;
  end if;

  select * into v_exist from crm.subtask_requests s where s.lead_id = p_lead and s.kind = p_kind and s.status in ('REQUESTED', 'IN_PROGRESS');
  if v_exist.id is not null then return query select 'exists_open'::text, v_exist.id, v_exist.meeting_id; return; end if;

  if p_kind = 'prepare_quotation' then
    begin v_rv := (v_input ->> 'requirement_version_id')::uuid; exception when others then v_rv := null; end;
    -- "Confirmed requirements used" (spec §87): the version must be the ACCEPTED one of one of THIS lead's conversations.
    if v_rv is null or not exists (
         select 1 from crm.requirement_versions rv join crm.conversations c on c.id = rv.conversation_id
          where rv.id = v_rv and rv.organization_id = p_organization_id and rv.status = 'accepted' and c.lead_id = p_lead) then
      return query select 'requirements_not_confirmed'::text, null::uuid, null::uuid; return;
    end if;
    insert into crm.subtask_requests (organization_id, lead_id, kind, requested_by_owner, assignee, objective, input, requirement_version_id,
                                      priority, idempotency_key, correlation_id, created_by)
    values (p_organization_id, p_lead, p_kind, v_owner, null, btrim(p_objective), v_input, v_rv, coalesce(p_priority, 3), p_idempotency_key, p_correlation_id, v_actor)
    returning id into v_new;
    perform core.record_audit(p_organization_id, 'subtask.requested', 'lead', p_lead, null,
      jsonb_build_object('subtask_id', v_new, 'kind', p_kind, 'owner', v_owner), p_correlation_id);
    return query select 'created'::text, v_new, null::uuid; return;
  end if;

  -- schedule_meeting: create the meeting request through the EXISTING door (or find the live one: one per lead is already a rule).
  v_mode := v_input ->> 'mode';
  if v_mode is null or v_mode not in ('call', 'video_meeting', 'in_person_meeting', 'other') or coalesce(btrim(v_input ->> 'timezone'), '') = '' then
    return query select 'invalid'::text, null::uuid, null::uuid; return;
  end if;
  begin
    v_start := nullif(v_input ->> 'requested_start_at', '')::timestamptz;
    v_end := nullif(v_input ->> 'requested_window_end', '')::timestamptz;
    v_dur := nullif(v_input ->> 'duration_minutes', '')::integer;
  exception when others then
    return query select 'invalid'::text, null::uuid, null::uuid; return;
  end;
  select * into v_mreq from crm.request_meeting(p_lead, v_mode, v_input ->> 'timezone', nullif(v_input ->> 'purpose', ''), null, null,
                                                v_lead.contact_id, null, v_start, v_end, v_dur);
  if v_mreq.outcome not in ('requested', 'already_requested') then
    return query select ('meeting_' || v_mreq.outcome)::text, null::uuid, null::uuid; return;
  end if;
  v_meeting := v_mreq.meeting_id;

  insert into crm.subtask_requests (organization_id, lead_id, kind, requested_by_owner, assignee, status, accepted_at, objective, input, meeting_id,
                                    priority, idempotency_key, correlation_id, created_by, progress)
  values (p_organization_id, p_lead, p_kind, v_owner, 'scheduler', 'IN_PROGRESS', now(), btrim(p_objective), v_input, v_meeting,
          coalesce(p_priority, 3), p_idempotency_key, p_correlation_id, v_actor,
          jsonb_build_object('meeting_status', 'requested', 'reused_live_meeting', v_mreq.outcome = 'already_requested'))
  returning id into v_new;
  perform core.record_audit(p_organization_id, 'subtask.requested', 'lead', p_lead, null,
    jsonb_build_object('subtask_id', v_new, 'kind', p_kind, 'owner', v_owner, 'meeting_id', v_meeting), p_correlation_id);
  return query select 'created'::text, v_new, v_meeting;
end;
$$;
revoke all on function crm.request_subtask(uuid, uuid, text, text, text, jsonb, text, integer, uuid) from public, anon;
grant execute on function crm.request_subtask(uuid, uuid, text, text, text, jsonb, text, integer, uuid) to authenticated, service_role;

-- ── 4. accept, link, complete, fail, cancel ────────────────────────────────

create or replace function crm.accept_subtask(p_organization_id uuid, p_subtask uuid, p_assignee text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare s crm.subtask_requests;
begin
  if (select auth.uid()) is not null and (p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false)) then
    return query select 'forbidden'::text; return;
  end if;
  select * into s from crm.subtask_requests x where x.id = p_subtask and x.organization_id = p_organization_id for update;
  if s.id is null then return query select 'not_found'::text; return; end if;
  if p_assignee not in ('scheduler', 'quotation_master', 'human')
     or (s.kind = 'schedule_meeting' and p_assignee = 'quotation_master') or (s.kind = 'prepare_quotation' and p_assignee = 'scheduler') then
    return query select 'invalid'::text; return;
  end if;
  if s.status <> 'REQUESTED' then return query select 'wrong_state'::text; return; end if;
  update crm.subtask_requests set status = 'IN_PROGRESS', assignee = p_assignee, accepted_at = now() where id = s.id;
  perform core.record_audit(p_organization_id, 'subtask.accepted', 'lead', s.lead_id, null, jsonb_build_object('subtask_id', s.id, 'assignee', p_assignee));
  return query select 'accepted'::text;
end;
$$;
revoke all on function crm.accept_subtask(uuid, uuid, text) from public, anon;
grant execute on function crm.accept_subtask(uuid, uuid, text) to authenticated, service_role;

-- Attach the proposal a quotation subtask produced. It must be BUILT FROM the confirmed requirements the request named.
create or replace function crm.link_subtask_proposal(p_organization_id uuid, p_subtask uuid, p_proposal uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare s crm.subtask_requests; p sales.proposals; v_lead uuid;
begin
  if (select auth.uid()) is not null and (p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false)) then
    return query select 'forbidden'::text; return;
  end if;
  select * into s from crm.subtask_requests x where x.id = p_subtask and x.organization_id = p_organization_id for update;
  if s.id is null then return query select 'not_found'::text; return; end if;
  if s.kind <> 'prepare_quotation' then return query select 'wrong_kind'::text; return; end if;
  if s.status <> 'IN_PROGRESS' then return query select 'wrong_state'::text; return; end if;
  select * into p from sales.proposals x where x.id = p_proposal and x.organization_id = p_organization_id;
  if p.id is null then return query select 'unknown_proposal'::text; return; end if;
  select o.lead_id into v_lead from sales.opportunities o where o.id = p.opportunity_id;
  if v_lead is distinct from s.lead_id then return query select 'lead_mismatch'::text; return; end if;
  if p.requirement_version_id is distinct from s.requirement_version_id then return query select 'requirement_mismatch'::text; return; end if;
  update crm.subtask_requests set proposal_id = p.id,
         progress = progress || jsonb_build_object('proposal_id', p.id, 'proposal_version', p.version, 'proposal_status', p.status)
   where id = s.id;
  perform core.record_audit(p_organization_id, 'subtask.proposal_linked', 'lead', s.lead_id, null,
    jsonb_build_object('subtask_id', s.id, 'proposal_id', p.id, 'version', p.version));
  return query select 'linked'::text;
end;
$$;
revoke all on function crm.link_subtask_proposal(uuid, uuid, uuid) from public, anon;
grant execute on function crm.link_subtask_proposal(uuid, uuid, uuid) to authenticated, service_role;

-- Close a subtask: complete / fail / cancel. Control returns to whoever owns the conversation NOW.
create or replace function crm._close_subtask(p_subtask uuid, p_status text, p_result jsonb, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare s crm.subtask_requests; v_owner text;
begin
  select * into s from crm.subtask_requests x where x.id = p_subtask for update;
  if s.id is null then return 'not_found'; end if;
  if s.status in ('COMPLETED', 'FAILED', 'CANCELLED') then return 'already_closed'; end if;
  select o.owner into v_owner from crm.lead_conversation_owner o where o.lead_id = s.lead_id;
  update crm.subtask_requests
     set status = p_status, completed_at = now(), returned_to_owner = v_owner,
         result = case when p_status = 'COMPLETED' then coalesce(p_result, '{}'::jsonb) else result end,
         failure_reason = case when p_status <> 'COMPLETED' then left(p_reason, 500) else failure_reason end
   where id = s.id;
  perform core.record_audit(s.organization_id, 'subtask.' || lower(p_status), 'lead', s.lead_id, null,
    jsonb_build_object('subtask_id', s.id, 'kind', s.kind, 'requested_by', s.requested_by_owner, 'returned_to', v_owner, 'reason', left(p_reason, 200)));
  return 'closed';
end;
$$;
revoke all on function crm._close_subtask(uuid, text, jsonb, text) from public, anon, authenticated;

create or replace function crm.cancel_subtask(p_organization_id uuid, p_subtask uuid, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare s crm.subtask_requests; v_res text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if (select auth.uid()) is not null and (p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false)) then
    return query select 'forbidden'::text; return;
  end if;
  if v_reason is null then return query select 'needs_reason'::text; return; end if;
  select * into s from crm.subtask_requests x where x.id = p_subtask and x.organization_id = p_organization_id;
  if s.id is null then return query select 'not_found'::text; return; end if;
  v_res := crm._close_subtask(s.id, 'CANCELLED', null, v_reason);
  return query select case when v_res = 'closed' then 'cancelled' else 'not_live' end::text;
end;
$$;
revoke all on function crm.cancel_subtask(uuid, uuid, text) from public, anon;
grant execute on function crm.cancel_subtask(uuid, uuid, text) to authenticated, service_role;

create or replace function crm.fail_subtask(p_organization_id uuid, p_subtask uuid, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare s crm.subtask_requests; v_res text; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if (select auth.uid()) is not null and (p_organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_admin()), false)) then
    return query select 'forbidden'::text; return;
  end if;
  if v_reason is null then return query select 'needs_reason'::text; return; end if;
  select * into s from crm.subtask_requests x where x.id = p_subtask and x.organization_id = p_organization_id;
  if s.id is null then return query select 'not_found'::text; return; end if;
  v_res := crm._close_subtask(s.id, 'FAILED', null, v_reason);
  return query select case when v_res = 'closed' then 'failed' else 'not_live' end::text;
end;
$$;
revoke all on function crm.fail_subtask(uuid, uuid, text) from public, anon;
grant execute on function crm.fail_subtask(uuid, uuid, text) to authenticated, service_role;

-- ── 5. the link follows the lifecycles that already exist ──────────────────

create or replace function crm.carry_meeting_to_subtask()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare s crm.subtask_requests; v_old uuid;
begin
  if tg_op = 'INSERT' then
    -- A reschedule is a NEW row (supersedes_id): the subtask follows it, so the link never points at history.
    if new.supersedes_id is null then return new; end if;
    update crm.subtask_requests
       set meeting_id = new.id, progress = progress || jsonb_build_object('meeting_status', new.status, 'rescheduled_from', new.supersedes_id, 'rescheduled_at', now())
     where meeting_id = new.supersedes_id and status = 'IN_PROGRESS' and organization_id = new.organization_id;
    return new;
  end if;

  select * into s from crm.subtask_requests x where x.meeting_id = new.id and x.status = 'IN_PROGRESS' and x.organization_id = new.organization_id for update;
  if s.id is null then return new; end if;

  if new.status = 'completed' then
    perform crm._close_subtask(s.id, 'COMPLETED',
      jsonb_build_object('meeting_id', new.id, 'outcome', coalesce(new.outcome, 'completed'), 'completed_at', new.completed_at,
                         'start', new.confirmed_start_at, 'end', new.confirmed_end_at, 'timezone', new.timezone, 'mode', coalesce(new.booked_mode, new.requested_mode),
                         'evidence_count', (select count(*) from crm.meeting_evidence ev where ev.meeting_id = new.id)), null);
  elsif new.status in ('cancelled', 'no_show') then
    -- Cancelled BECAUSE it was rescheduled is not a failure. reschedule_meeting cancels the old row first, with a reason that
    -- begins 'rescheduled', and inserts the successor (supersedes_id) straight after - the INSERT branch re-points this subtask.
    if new.status = 'cancelled' and coalesce(new.cancellation_reason, '') like 'rescheduled%' then
      update crm.subtask_requests set progress = progress || jsonb_build_object('meeting_status', 'rescheduling') where id = s.id;
    else
      perform crm._close_subtask(s.id, 'FAILED', null, case new.status when 'no_show' then 'the client did not attend' else coalesce(new.cancellation_reason, 'the meeting was cancelled') end);
    end if;
  else
    update crm.subtask_requests set progress = progress || jsonb_build_object('meeting_status', new.status, 'start', new.confirmed_start_at, 'end', new.confirmed_end_at) where id = s.id;
  end if;
  return new;
exception when others then
  begin perform core.record_audit(new.organization_id, 'subtask.carry_failed', 'meeting', new.id, null, jsonb_build_object('error', sqlerrm));
  exception when others then null; end;
  return new;
end;
$$;
revoke all on function crm.carry_meeting_to_subtask() from public, anon, authenticated;
drop trigger if exists carry_meeting_to_subtask on crm.meetings;
create trigger carry_meeting_to_subtask after insert or update of status, outcome on crm.meetings
  for each row execute function crm.carry_meeting_to_subtask();

create or replace function crm.carry_proposal_to_subtask()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare s crm.subtask_requests; v_lead uuid;
begin
  select o.lead_id into v_lead from sales.opportunities o where o.id = new.opportunity_id;
  if v_lead is null then return new; end if;

  if tg_op = 'INSERT' then
    -- A new version of the same opportunity, built from the same confirmed requirements, becomes the one the subtask follows.
    update crm.subtask_requests
       set proposal_id = new.id, progress = progress || jsonb_build_object('proposal_id', new.id, 'proposal_version', new.version, 'proposal_status', new.status)
     where lead_id = v_lead and kind = 'prepare_quotation' and status = 'IN_PROGRESS' and organization_id = new.organization_id
       and requirement_version_id is not distinct from new.requirement_version_id;
    return new;
  end if;

  select * into s from crm.subtask_requests x where x.proposal_id = new.id and x.status = 'IN_PROGRESS' and x.organization_id = new.organization_id for update;
  if s.id is null then return new; end if;
  if new.status in ('approved', 'sent', 'accepted') then
    perform crm._close_subtask(s.id, 'COMPLETED',
      jsonb_build_object('proposal_id', new.id, 'version', new.version, 'status', new.status, 'approval_request_id', new.approval_request_id,
                         'requirement_version_id', new.requirement_version_id), null);
  elsif new.status in ('rejected', 'lapsed') then
    perform crm._close_subtask(s.id, 'FAILED', null, 'the quotation was ' || new.status);
  else
    update crm.subtask_requests set progress = progress || jsonb_build_object('proposal_version', new.version, 'proposal_status', new.status) where id = s.id;
  end if;
  return new;
exception when others then
  begin perform core.record_audit(new.organization_id, 'subtask.carry_failed', 'proposal', new.id, null, jsonb_build_object('error', sqlerrm));
  exception when others then null; end;
  return new;
end;
$$;
revoke all on function crm.carry_proposal_to_subtask() from public, anon, authenticated;
drop trigger if exists carry_proposal_to_subtask on sales.proposals;
create trigger carry_proposal_to_subtask after insert or update of status on sales.proposals
  for each row execute function crm.carry_proposal_to_subtask();

notify pgrst, 'reload schema';
