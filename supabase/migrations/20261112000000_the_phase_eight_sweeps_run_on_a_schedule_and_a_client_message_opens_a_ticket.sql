-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8A, finished: the sweeps that existed with nothing to call them, and the door that turns a client's support message into a ticket.
--
--   * sweep_phase_eight_health: for every ACTIVE Phase 8 workspace, call the existing record_health_snapshot door ('scheduled'). That door writes a snapshot only
--     when the derived status changed, so a quiet account costs nothing and a changed one is recorded once.
--   * sweep_checkins_due: a check-in that is DUE (its date has come, nobody has completed or skipped it) is recorded ONCE as a notice for Customer Success, with
--     the answer of the existing eligibility read beside it (whether a relationship contact is allowed now, and why not). It contacts nobody and changes no
--     check-in: a person still contacts the client, or skips, with the existing doors.
--   * open_support_ticket_from_message: a client's message in a PROJECT conversation of a project in an ACTIVE Phase 8 workspace, whose intent label is a
--     support request, opens a ticket through the existing open_support_ticket door (idempotent on the message id). It never replies and never sends.
--   * sweep_message_support_tickets: the same door for a label that arrived after the event was handled (the intent reader is asynchronous).
--
-- Every function here is the SERVICE ROLE's and checks the role inside as well as by grant.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('customer.check_in_due', 'A Phase 8 check-in came due and nobody has completed or skipped it: a notice was recorded for Customer Success. Emitted once per check-in. Nothing was sent to the client.', true)
on conflict (type) do nothing;

-- ── the notice: an item for Customer Success, once per check-in ────────────
create table if not exists projects.cs_check_in_due_notices (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  check_in_id           uuid not null unique references projects.cs_check_ins(id) on delete cascade,
  kind                  text not null,
  due_on                date not null,
  cs_owner              uuid references core.users(id) on delete set null,
  relationship_allowed  boolean not null,
  reasons               text[] not null default '{}',
  noticed_at            timestamptz not null default clock_timestamp()
);
comment on table projects.cs_check_in_due_notices is
  'A due check-in, noticed once for Customer Success (the answer of check_in_eligibility for the relationship category beside it). Append-only. It is an item to act on, never a message: nothing here contacts anyone.';
create index if not exists cs_check_in_due_notices_project_idx on projects.cs_check_in_due_notices (project_id, noticed_at desc);

select projects.p7_guard_fk('cs_check_in_due_notices', 'project_id', 'projects.projects');
select projects.p7_guard_fk('cs_check_in_due_notices', 'check_in_id', 'projects.cs_check_ins');
select projects.p7_harden('projects', 'cs_check_in_due_notices');
drop trigger if exists cs_check_in_due_notices_append_only on projects.cs_check_in_due_notices;
create trigger cs_check_in_due_notices_append_only before update or delete on projects.cs_check_in_due_notices for each row execute function projects.p8_append_only();

-- ── the health sweep ───────────────────────────────────────────────────────
create or replace function projects.sweep_phase_eight_health(p_organization_id uuid default null, p_now timestamptz default null, p_limit int default 500)
returns table (checked int, recorded int, unchanged int)
language plpgsql security definer set search_path = '' as $$
declare r record; v_checked int := 0; v_recorded int := 0; v_unchanged int := 0; v_out text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0, 0; return; end if;
  for r in
    select w.project_id, w.organization_id from projects.phase_eight w
     where w.state = 'active' and (p_organization_id is null or w.organization_id = p_organization_id)
     order by w.organization_id, w.project_id limit greatest(coalesce(p_limit, 500), 1)
  loop
    v_checked := v_checked + 1;
    select s.outcome into v_out from projects.record_health_snapshot(r.project_id, 'scheduled', r.organization_id, p_now) s;
    if v_out in ('first', 'changed') then v_recorded := v_recorded + 1; else v_unchanged := v_unchanged + 1; end if;
  end loop;
  return query select v_checked, v_recorded, v_unchanged;
end $$;
revoke all on function projects.sweep_phase_eight_health(uuid, timestamptz, int) from public, anon, authenticated;
grant execute on function projects.sweep_phase_eight_health(uuid, timestamptz, int) to service_role;

-- ── the check-in due sweep ─────────────────────────────────────────────────
create or replace function projects.sweep_checkins_due(p_organization_id uuid default null, p_now timestamptz default null, p_limit int default 500)
returns table (checked int, noticed int)
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp()); v_today date := (coalesce(p_now, clock_timestamp()) at time zone 'UTC')::date;
  r record; v_checked int := 0; v_noticed int := 0; v_allowed boolean; v_reasons text[]; v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  for r in
    select c.id, c.organization_id, c.project_id, c.kind, c.due_on, w.cs_owner
      from projects.cs_check_ins c join projects.phase_eight w on w.project_id = c.project_id
     where c.status = 'due' and c.due_on <= v_today and w.state = 'active' and (p_organization_id is null or c.organization_id = p_organization_id)
       and not exists (select 1 from projects.cs_check_in_due_notices n where n.check_in_id = c.id)
     order by c.due_on, c.id limit greatest(coalesce(p_limit, 500), 1)
  loop
    v_checked := v_checked + 1;
    v_id := null;
    select e.allowed, e.reasons into v_allowed, v_reasons from projects.check_in_eligibility(r.project_id, r.kind, v_now) e where e.category = 'relationship';
    insert into projects.cs_check_in_due_notices (organization_id, project_id, check_in_id, kind, due_on, cs_owner, relationship_allowed, reasons, noticed_at)
    values (r.organization_id, r.project_id, r.id, r.kind, r.due_on, r.cs_owner, coalesce(v_allowed, false), coalesce(v_reasons, '{}'), v_now)
    on conflict (check_in_id) do nothing returning id into v_id;
    if v_id is not null then
      v_noticed := v_noticed + 1;
      perform core.emit_event(r.organization_id, 'customer.check_in_due', 'cs_check_in', r.id, jsonb_build_object('projectId', r.project_id, 'checkInId', r.id, 'kind', r.kind, 'dueOn', r.due_on));
    end if;
  end loop;
  return query select v_checked, v_noticed;
end $$;
revoke all on function projects.sweep_checkins_due(uuid, timestamptz, int) from public, anon, authenticated;
grant execute on function projects.sweep_checkins_due(uuid, timestamptz, int) to service_role;

-- ── a client's support message opens a ticket (it never replies) ───────────
-- The message ROW is the authority, never the event payload: the organization is the caller's, the conversation, the project, the workspace state and the intent
-- label are all read here. Only a PROJECT conversation of a project whose Phase 8 workspace is ACTIVE can open a ticket, and only for the label support_request.
create or replace function projects.open_support_ticket_from_message(p_organization_id uuid, p_message_id uuid)
returns table (outcome text, ticket_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_m crm.conversation_messages; v_c crm.conversations; v_w projects.phase_eight; v_src text; v_body text; v_out text; v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_m from crm.conversation_messages m where m.id = p_message_id and m.organization_id = p_organization_id;
  if v_m.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_m.author_type <> 'client' then return query select 'not_a_client_message'::text, null::uuid; return; end if;
  select * into v_c from crm.conversations c where c.id = v_m.conversation_id and c.organization_id = p_organization_id;
  if v_c.id is null or v_c.kind <> 'project_group' or v_c.project_id is null then return query select 'not_a_project_conversation'::text, null::uuid; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = v_c.project_id and w.organization_id = p_organization_id;
  if v_w.id is null then return query select 'no_phase_eight'::text, null::uuid; return; end if;
  if v_w.state <> 'active' then return query select 'workspace_not_active'::text, null::uuid; return; end if;
  if v_m.intent is null then
    -- the reader of intents is asynchronous: a young message may simply not be labelled yet
    if v_m.created_at > clock_timestamp() - interval '15 minutes' then return query select 'intent_pending'::text, null::uuid; return; end if;
    return query select 'no_intent_label'::text, null::uuid; return;
  end if;
  if v_m.intent <> 'support_request' then return query select 'not_a_support_request'::text, null::uuid; return; end if;
  v_src := case v_c.channel when 'whatsapp' then 'whatsapp' when 'email' then 'email' when 'web_form' then 'portal' else 'internal' end;
  v_body := btrim(regexp_replace(v_m.body, '\s+', ' ', 'g'));
  select t.outcome, t.ticket_id into v_out, v_id
    from projects.open_support_ticket(p_organization_id, v_c.project_id, 'Client message: ' || left(v_body, 150), left(v_m.body, 8000), v_src, v_m.id::text) t;
  return query select case when v_out in ('opened', 'duplicate') then v_out else 'refused:' || coalesce(v_out, 'nothing') end::text, v_id;
end $$;
revoke all on function projects.open_support_ticket_from_message(uuid, uuid) from public, anon, authenticated;
grant execute on function projects.open_support_ticket_from_message(uuid, uuid) to service_role;

-- the catch-up: a label that arrived after the message event was handled
create or replace function projects.sweep_message_support_tickets(p_organization_id uuid default null, p_limit int default 200)
returns table (checked int, opened int)
language plpgsql security definer set search_path = '' as $$
declare r record; v_checked int := 0; v_opened int := 0; v_out text;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;
  for r in
    select m.id, m.organization_id
      from crm.conversation_messages m
      join crm.conversations c on c.id = m.conversation_id and c.kind = 'project_group' and c.project_id is not null
      join projects.phase_eight w on w.project_id = c.project_id and w.state = 'active'
     where m.author_type = 'client' and m.intent = 'support_request' and m.created_at > clock_timestamp() - interval '3 days'
       and (p_organization_id is null or m.organization_id = p_organization_id)
       and not exists (select 1 from projects.support_tickets t where t.organization_id = m.organization_id and t.source_ref = m.id::text)
     order by m.created_at limit greatest(coalesce(p_limit, 200), 1)
  loop
    v_checked := v_checked + 1;
    select t.outcome into v_out from projects.open_support_ticket_from_message(r.organization_id, r.id) t;
    if v_out = 'opened' then v_opened := v_opened + 1; end if;
  end loop;
  return query select v_checked, v_opened;
end $$;
revoke all on function projects.sweep_message_support_tickets(uuid, int) from public, anon, authenticated;
grant execute on function projects.sweep_message_support_tickets(uuid, int) to service_role;

notify pgrst, 'reload schema';
