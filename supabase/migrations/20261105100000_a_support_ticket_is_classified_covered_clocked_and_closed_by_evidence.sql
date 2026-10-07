-- ═════════════════════════════════════════════════════════════════
-- Phase 8A: the support ticket lifecycle.
--
--   new -> classified -> assigned -> in_progress -> in_qa -> (release) -> client_confirmation -> closed        (or cancelled)
--
-- The rules this file makes structural (CHECK or trigger, not a service that could forget):
--   * a ticket's classification decides the coverage it may carry: a how-to is included support, a change request or a new project is NEVER
--     covered, so new scope cannot be filed as warranty or maintenance (Doc 18 sections 6 and 35). It is a CHECK, so even a direct write fails.
--   * a warranty claim needs the project's warranty window to cover the day the issue was raised; a maintenance claim needs an active plan
--     version covering that day. Otherwise the person records not_covered with a reason and the work routes to a change request/opportunity.
--   * a ticket that involves a technical fix cannot close without QA verification, a release reference where a release was needed, and a
--     client confirmation a PERSON recorded with evidence. A change request / new project closes only by naming what it became.
--   * SLA clocks (response and resolution) are computed in SQL from the raise time and the organization's settings; the sweep takes an
--     injectable clock and stamps each breach once, escalating to a person. A breach changes nothing else.
--   * an agent only PROPOSES (a classification and a draft reply). A reply is a draft; a person sends it elsewhere and records that they did.
-- ═════════════════════════════════════════════════════════════════

create table if not exists projects.support_tickets (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references core.organizations(id) on delete cascade,
  project_id               uuid not null references projects.projects(id) on delete cascade,
  client_account_id        uuid not null references core.client_accounts(id) on delete restrict,
  ticket_ref               text generated always as ('TKT-' || upper(left(replace(id::text, '-', ''), 8))) stored,
  source                   text not null check (source in ('portal', 'email', 'whatsapp', 'phone', 'monitoring', 'customer_success', 'internal')),
  source_ref               text check (source_ref is null or length(btrim(source_ref)) between 1 and 200),
  title                    text not null check (length(btrim(title)) between 1 and 200),
  description              text check (description is null or length(description) <= 8000),
  status                   text not null default 'new' check (status in ('new', 'classified', 'assigned', 'in_progress', 'in_qa', 'release', 'client_confirmation', 'closed', 'cancelled')),
  classification           text check (classification in ('how_to', 'warranty_bug', 'maintenance', 'minor_change', 'change_request', 'new_project', 'disputed')),
  coverage_decision        text check (coverage_decision in ('included_support', 'covered_warranty', 'covered_maintenance', 'not_covered', 'needs_review')),
  coverage_reason          text check (coverage_reason is null or length(btrim(coverage_reason)) >= 5),
  priority                 text check (priority in ('p1', 'p2', 'p3', 'p4')),
  plan_id                  uuid references projects.maintenance_plans(id) on delete set null,
  defect_id                uuid references qa.defects(id) on delete set null,
  change_request_id        uuid references projects.change_requests(id) on delete set null,
  maintenance_item_id      uuid references projects.maintenance_items(id) on delete set null,
  opportunity_id           uuid,
  assignee_id              uuid references core.users(id) on delete set null,
  raised_at                timestamptz not null default clock_timestamp(),
  first_response_at        timestamptz,
  response_due_at          timestamptz,
  resolution_due_at        timestamptz,
  response_breached_at     timestamptz,
  resolution_breached_at   timestamptz,
  release_needed           boolean not null default false,
  escalated_to_role        text check (escalated_to_role in ('owner', 'ops_admin')),
  escalated_at             timestamptz,
  escalation_reason        text,
  escalation_ack_by        uuid references core.users(id) on delete set null,
  escalation_ack_at        timestamptz,
  client_confirmed_at      timestamptz,
  client_confirmation_evidence text,
  resolution_note          text,
  close_reason             text,
  closed_at                timestamptz,
  proposed_classification  text check (proposed_classification in ('how_to', 'warranty_bug', 'maintenance', 'minor_change', 'change_request', 'new_project', 'disputed')),
  proposed_rationale       text,
  proposed_by_agent        text,
  proposed_at              timestamptz,
  raised_by                uuid references core.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- a classification names the coverage it may carry; new scope can never be covered
  constraint support_tickets_coverage_matches_classification check (classification is null or case classification
      when 'how_to' then coverage_decision = 'included_support'
      when 'warranty_bug' then coverage_decision in ('covered_warranty', 'not_covered')
      when 'maintenance' then coverage_decision in ('covered_maintenance', 'not_covered')
      when 'minor_change' then coverage_decision in ('covered_maintenance', 'not_covered')
      when 'change_request' then coverage_decision = 'not_covered'
      when 'new_project' then coverage_decision = 'not_covered'
      when 'disputed' then coverage_decision = 'needs_review'
    end),
  constraint support_tickets_covered_maintenance_names_a_plan check (coverage_decision is distinct from 'covered_maintenance' or plan_id is not null),
  constraint support_tickets_classified_is_complete check (status in ('new', 'cancelled')
      or (classification is not null and coverage_decision is not null and coverage_reason is not null and priority is not null and response_due_at is not null and resolution_due_at is not null)),
  constraint support_tickets_terminal_is_stamped check ((status in ('closed', 'cancelled')) = (closed_at is not null) and (closed_at is null or close_reason is not null)),
  -- a how-to is not a defect; a covered defect is not a sale; new scope never carries a defect or a maintenance item
  constraint support_tickets_links_fit_the_classification check (
      (classification is distinct from 'how_to' or (defect_id is null and change_request_id is null and maintenance_item_id is null and opportunity_id is null))
      and (classification in ('change_request', 'new_project') or (change_request_id is null and opportunity_id is null))
      and (classification in ('warranty_bug', 'maintenance', 'minor_change') or (defect_id is null and maintenance_item_id is null))),
  constraint support_tickets_closed_technical_needs_confirmation check (status <> 'closed' or classification not in ('warranty_bug', 'maintenance', 'minor_change')
      or (client_confirmed_at is not null and length(btrim(coalesce(client_confirmation_evidence, ''))) > 0)),
  constraint support_tickets_closed_scope_names_what_it_became check (status <> 'closed' or classification not in ('change_request', 'new_project') or change_request_id is not null or opportunity_id is not null),
  constraint support_tickets_confirmation_is_evidenced check (client_confirmed_at is null or length(btrim(coalesce(client_confirmation_evidence, ''))) > 0)
);
create unique index if not exists support_tickets_source_once on projects.support_tickets (organization_id, source, source_ref) where source_ref is not null;
create index if not exists support_tickets_open_idx on projects.support_tickets (organization_id, project_id, status) where status not in ('closed', 'cancelled');
create index if not exists support_tickets_sla_idx on projects.support_tickets (organization_id, response_due_at, resolution_due_at) where status not in ('closed', 'cancelled', 'new');
comment on table projects.support_tickets is
  'Phase 8A support ticket (Doc 18 sections 6-8). Changed only through its doors. CHECKs make the forbidden states unrepresentable: new scope covered as warranty/maintenance, a how-to carrying a defect, a technical ticket closed without a person-recorded client confirmation, a change request closed without naming what it became. No amount or price column exists.';

create table if not exists projects.support_ticket_events (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  ticket_id        uuid not null references projects.support_tickets(id) on delete cascade,
  kind             text not null check (kind in ('opened', 'classified', 'assigned', 'linked', 'state_changed', 'escalated', 'escalation_acknowledged', 'proposal_recorded',
                                                'reply_drafted', 'reply_sent', 'reply_discarded', 'client_confirmed', 'client_rejected', 'sla_breach', 'cancelled')),
  from_status      text,
  to_status        text,
  actor_id         uuid references core.users(id) on delete set null,
  actor_kind       text not null check (actor_kind in ('person', 'system', 'agent')),
  note             text,
  evidence         text,
  at               timestamptz not null default clock_timestamp()
);
create index if not exists support_ticket_events_ticket_idx on projects.support_ticket_events (ticket_id, seq);
comment on table projects.support_ticket_events is 'Append-only history of one ticket: actor, previous/new state, note and evidence (P8-SEC-004).';

create table if not exists projects.support_reply_drafts (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  ticket_id            uuid not null references projects.support_tickets(id) on delete cascade,
  body                 text not null check (length(btrim(body)) between 1 and 4000),
  body_hash            text not null,
  language             text check (language is null or language ~ '^[a-z]{2,8}(-[A-Za-z0-9]{2,8})?$'),
  status               text not null default 'draft' check (status in ('draft', 'discarded', 'sent_recorded')),
  drafted_by_agent     text,
  drafted_by           uuid references core.users(id) on delete set null,
  sent_recorded_by     uuid references core.users(id) on delete set null,
  sent_recorded_at     timestamptz,
  sent_channel         text check (sent_channel in ('portal', 'email', 'whatsapp', 'phone')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint support_reply_drafts_has_an_author check (drafted_by_agent is not null or drafted_by is not null),
  constraint support_reply_drafts_sent_is_a_person check ((status = 'sent_recorded') = (sent_recorded_by is not null and sent_recorded_at is not null and sent_channel is not null)),
  -- ADM-22: nothing an agent writes names a price. A person drafting may; the rule is on the agent's draft.
  constraint support_reply_drafts_agent_names_no_price check (drafted_by_agent is null or body !~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off'),
  unique (ticket_id, body_hash)
);
comment on table projects.support_reply_drafts is 'A reply to a client is a DRAFT. Nothing here sends: a person sends it in WhatsApp/email/the portal and records that they did (status sent_recorded, channel, who, when). An agent draft cannot name a price or a discount.';

do $$
declare r record;
begin
  for r in select * from (values
    ('support_tickets', 'project_id', 'projects.projects'), ('support_tickets', 'client_account_id', 'core.client_accounts'), ('support_tickets', 'plan_id', 'projects.maintenance_plans'),
    ('support_tickets', 'defect_id', 'qa.defects'), ('support_tickets', 'change_request_id', 'projects.change_requests'), ('support_tickets', 'maintenance_item_id', 'projects.maintenance_items'),
    ('support_ticket_events', 'ticket_id', 'projects.support_tickets'), ('support_reply_drafts', 'ticket_id', 'projects.support_tickets')
  ) as t(tbl, col, parent) loop
    perform projects.p8_wire_parent('projects', r.tbl, r.col, r.parent);
  end loop;
  perform projects.p8_wire_table('projects', 'support_tickets', true, false);
  perform projects.p8_wire_table('projects', 'support_ticket_events', false, true);
  perform projects.p8_wire_table('projects', 'support_reply_drafts', true, false);
end $$;

create or replace function projects.support_tickets_identity_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.project_id is distinct from old.project_id or new.client_account_id is distinct from old.client_account_id or new.source is distinct from old.source
     or new.source_ref is distinct from old.source_ref or new.raised_at is distinct from old.raised_at or new.raised_by is distinct from old.raised_by then
    raise exception 'a ticket''s project, client, source and raise time are its identity and are never edited' using errcode = 'restrict_violation';
  end if;
  if old.status in ('closed', 'cancelled') then
    raise exception 'a closed ticket is history: raise a new ticket instead of editing it' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists support_tickets_identity_frozen on projects.support_tickets;
create trigger support_tickets_identity_frozen before update on projects.support_tickets for each row execute function projects.support_tickets_identity_frozen();

insert into core.event_types (type, description, canonical) values
  ('support.ticket_created', 'A support ticket was raised for a Phase 8 project. Carries the project and ticket ids only.', true),
  ('support.ticket_escalated', 'A support ticket was escalated to a person (the owner or an ops admin), by a person, by a disputed classification or by an SLA breach. The reason is read from the ticket.', true),
  ('support.sla_breached', 'A support ticket missed its response or its resolution target. Stamped once per kind by the SLA sweep.', true)
on conflict (type) do nothing;

-- ── internal helpers (no execute for anyone but the doors) ─────────────────

create or replace function projects.p8_ticket_event(p_org uuid, p_ticket uuid, p_kind text, p_from text, p_to text, p_actor uuid, p_actor_kind text, p_note text, p_evidence text, p_at timestamptz default null)
returns void language sql security definer set search_path = '' as $$
  insert into projects.support_ticket_events (organization_id, ticket_id, kind, from_status, to_status, actor_id, actor_kind, note, evidence, at)
  values (p_org, p_ticket, p_kind, p_from, p_to, p_actor, p_actor_kind, left(p_note, 1000), left(p_evidence, 1000), coalesce(p_at, clock_timestamp()));
$$;
revoke all on function projects.p8_ticket_event(uuid, uuid, text, text, text, uuid, text, text, text, timestamptz) from public, anon, authenticated, service_role;

create or replace function projects.p8_hours(p_org uuid, p_kind text, p_priority text)
returns int language sql stable security definer set search_path = '' as $$ select projects.p8_setting(p_org, 'sla_' || p_kind || '_hours_' || p_priority) $$;
revoke all on function projects.p8_hours(uuid, text, text) from public, anon, authenticated, service_role;

-- ── raising ─────────────────────────────────────────────────────────────────

create or replace function projects.open_support_ticket(p_organization_id uuid, p_project_id uuid, p_title text, p_description text, p_source text, p_source_ref text default null, p_now timestamptz default null)
returns table (outcome text, ticket_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_actor uuid := (select auth.uid()); v_org uuid; v_project projects.projects; v_w projects.phase_eight; v_id uuid; v_ref text := nullif(btrim(coalesce(p_source_ref, '')), '');
  v_title text := nullif(btrim(coalesce(p_title, '')), ''); v_at timestamptz;
begin
  if v_service then v_org := p_organization_id;
  else
    if v_actor is null or not coalesce((select core.is_internal()), false) or not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
    v_org := (select core.current_organization_id());
    if p_organization_id is not null and p_organization_id is distinct from v_org then return query select 'not_authorized'::text, null::uuid; return; end if;
  end if;
  if v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if v_title is null or length(v_title) > 200 then return query select 'bad_title'::text, null::uuid; return; end if;
  if p_source not in ('portal', 'email', 'whatsapp', 'phone', 'monitoring', 'customer_success', 'internal') then return query select 'bad_source'::text, null::uuid; return; end if;
  select * into v_project from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null;
  if v_project.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id;
  if v_w.id is null then return query select 'no_phase_eight'::text, null::uuid; return; end if;
  if v_w.state = 'closed' then return query select 'workspace_closed'::text, null::uuid; return; end if;
  -- a repeated webhook delivery is the same ticket
  if v_ref is not null then
    select t.id into v_id from projects.support_tickets t where t.organization_id = v_org and t.source = p_source and t.source_ref = v_ref;
    if v_id is not null then return query select 'duplicate'::text, v_id; return; end if;
  end if;
  v_at := case when v_service and p_now is not null then p_now else clock_timestamp() end;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.support_tickets (organization_id, project_id, client_account_id, source, source_ref, title, description, raised_at, raised_by)
  values (v_org, p_project_id, v_project.client_account_id, p_source, v_ref, left(v_title, 200), left(p_description, 8000), v_at, v_actor) returning id into v_id;
  perform projects.p8_ticket_event(v_org, v_id, 'opened', null, 'new', v_actor, case when v_actor is null then 'system' else 'person' end, null, v_ref, v_at);
  perform core.emit_event(v_org, 'support.ticket_created', 'support_ticket', v_id, jsonb_build_object('projectId', p_project_id, 'ticketId', v_id));
  return query select 'opened'::text, v_id;
end $$;
revoke all on function projects.open_support_ticket(uuid, uuid, text, text, text, text, timestamptz) from public, anon;
grant execute on function projects.open_support_ticket(uuid, uuid, text, text, text, text, timestamptz) to authenticated, service_role;

-- ── classification, coverage and priority: a person decides ─────────────────

create or replace function projects.classify_support_ticket(p_ticket_id uuid, p_classification text, p_coverage_decision text, p_coverage_reason text, p_priority text, p_plan_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets; v_w projects.phase_eight; v_reason text := nullif(btrim(coalesce(p_coverage_reason, '')), '');
  v_day date; v_plan projects.maintenance_plans; v_valid boolean; v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.status not in ('new', 'classified') then return query select 'too_late'::text; return; end if;
  if p_priority not in ('p1', 'p2', 'p3', 'p4') then return query select 'bad_priority'::text; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;
  v_valid := case p_classification
    when 'how_to' then p_coverage_decision = 'included_support'
    when 'warranty_bug' then p_coverage_decision in ('covered_warranty', 'not_covered')
    when 'maintenance' then p_coverage_decision in ('covered_maintenance', 'not_covered')
    when 'minor_change' then p_coverage_decision in ('covered_maintenance', 'not_covered')
    when 'change_request' then p_coverage_decision = 'not_covered'
    when 'new_project' then p_coverage_decision = 'not_covered'
    when 'disputed' then p_coverage_decision = 'needs_review'
    else false end;
  if not coalesce(v_valid, false) then return query select 'coverage_mismatch'::text; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = v_t.project_id;
  v_day := (v_t.raised_at at time zone 'UTC')::date;
  if p_coverage_decision = 'covered_warranty' and not (v_w.warranty_starts_on is not null and v_day between v_w.warranty_starts_on and v_w.warranty_ends_on) then
    return query select 'outside_warranty'::text; return;
  end if;
  if p_coverage_decision = 'covered_maintenance' then
    select * into v_plan from projects.maintenance_plans p where p.id = p_plan_id and p.project_id = v_t.project_id and p.organization_id = v_org;
    if v_plan.id is null or v_plan.status not in ('active', 'renewed', 'renewal_approaching') or (v_plan.starts_on is not null and v_day < v_plan.starts_on) or (v_plan.ends_on is not null and v_day > v_plan.ends_on) then
      return query select 'no_active_plan'::text; return;
    end if;
  elsif p_plan_id is not null then
    return query select 'plan_only_for_maintenance'::text; return;
  end if;

  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_tickets set
    classification = p_classification, coverage_decision = p_coverage_decision, coverage_reason = v_reason, priority = p_priority,
    plan_id = case when p_coverage_decision = 'covered_maintenance' then p_plan_id end,
    defect_id = null, change_request_id = null, maintenance_item_id = null, opportunity_id = null,
    response_due_at = v_t.raised_at + make_interval(hours => projects.p8_hours(v_org, 'response', p_priority)),
    resolution_due_at = v_t.raised_at + make_interval(hours => projects.p8_hours(v_org, 'resolution', p_priority)),
    status = 'classified'
  where id = v_t.id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'classified', v_t.status, 'classified', v_actor, 'person', p_classification || ' / ' || p_coverage_decision || ' / ' || p_priority, v_reason, v_now);
  -- an unclear or disputed classification is never guessed and never silently billed: a person is asked
  if p_classification = 'disputed' and v_t.escalated_at is null then
    update projects.support_tickets set escalated_to_role = 'ops_admin', escalated_at = v_now, escalation_reason = left('disputed classification: ' || v_reason, 1000) where id = v_t.id;
    perform projects.p8_ticket_event(v_org, v_t.id, 'escalated', 'classified', 'classified', v_actor, 'person', 'disputed classification', v_reason, v_now);
    perform core.emit_event(v_org, 'support.ticket_escalated', 'support_ticket', v_t.id, jsonb_build_object('projectId', v_t.project_id, 'ticketId', v_t.id));
  end if;
  return query select 'classified'::text;
end $$;
revoke all on function projects.classify_support_ticket(uuid, text, text, text, text, uuid) from public, anon, service_role;
grant execute on function projects.classify_support_ticket(uuid, text, text, text, text, uuid) to authenticated;

create or replace function projects.assign_support_ticket(p_ticket_id uuid, p_assignee uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.status in ('new', 'closed', 'cancelled') then return query select 'wrong_state'::text; return; end if;
  if not exists (select 1 from core.memberships m where m.organization_id = v_org and m.user_id = p_assignee and m.status = 'active' and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member')) then
    return query select 'assignee_not_a_member'::text; return;
  end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_tickets set assignee_id = p_assignee, status = case when status = 'classified' then 'assigned' else status end where id = v_t.id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'assigned', v_t.status, case when v_t.status = 'classified' then 'assigned' else v_t.status end, v_actor, 'person', 'assigned to ' || p_assignee::text, null);
  return query select 'assigned'::text;
end $$;
revoke all on function projects.assign_support_ticket(uuid, uuid) from public, anon, service_role;
grant execute on function projects.assign_support_ticket(uuid, uuid) to authenticated;

-- root cause: the ticket points at the defect, change request, maintenance work or opportunity it became
create or replace function projects.link_support_root_cause(p_ticket_id uuid, p_defect_id uuid default null, p_change_request_id uuid default null, p_maintenance_item_id uuid default null, p_opportunity_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if num_nonnulls(p_defect_id, p_change_request_id, p_maintenance_item_id, p_opportunity_id) = 0 then return query select 'nothing_to_link'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.status in ('new', 'closed', 'cancelled') then return query select 'wrong_state'::text; return; end if;
  if (p_defect_id is not null and (v_t.classification not in ('warranty_bug', 'maintenance', 'minor_change')))
     or (p_maintenance_item_id is not null and (v_t.classification not in ('maintenance', 'minor_change', 'warranty_bug')))
     or (p_change_request_id is not null and v_t.classification not in ('change_request', 'new_project') )
     or (p_opportunity_id is not null and v_t.classification not in ('change_request', 'new_project')) then
    return query select 'wrong_link_for_classification'::text; return;
  end if;
  if p_defect_id is not null and not exists (select 1 from qa.defects d where d.id = p_defect_id and d.organization_id = v_org and d.project_id = v_t.project_id) then return query select 'wrong_project'::text; return; end if;
  if p_change_request_id is not null and not exists (select 1 from projects.change_requests c where c.id = p_change_request_id and c.organization_id = v_org and c.project_id = v_t.project_id) then return query select 'wrong_project'::text; return; end if;
  if p_maintenance_item_id is not null and not exists (select 1 from projects.maintenance_items m where m.id = p_maintenance_item_id and m.organization_id = v_org and m.project_id = v_t.project_id) then return query select 'wrong_project'::text; return; end if;
  if p_opportunity_id is not null and not exists (select 1 from sales.phase_eight_opportunities o where o.id = p_opportunity_id and o.organization_id = v_org and o.project_id = v_t.project_id) then return query select 'wrong_project'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_tickets set defect_id = coalesce(p_defect_id, defect_id), change_request_id = coalesce(p_change_request_id, change_request_id),
    maintenance_item_id = coalesce(p_maintenance_item_id, maintenance_item_id), opportunity_id = coalesce(p_opportunity_id, opportunity_id) where id = v_t.id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'linked', v_t.status, v_t.status, v_actor, 'person',
    concat_ws(', ', case when p_defect_id is not null then 'defect ' || p_defect_id end, case when p_change_request_id is not null then 'change request ' || p_change_request_id end,
              case when p_maintenance_item_id is not null then 'maintenance item ' || p_maintenance_item_id end, case when p_opportunity_id is not null then 'opportunity ' || p_opportunity_id end), null);
  return query select 'linked'::text;
end $$;
revoke all on function projects.link_support_root_cause(uuid, uuid, uuid, uuid, uuid) from public, anon, service_role;
grant execute on function projects.link_support_root_cause(uuid, uuid, uuid, uuid, uuid) to authenticated;

-- ── the state machine ───────────────────────────────────────────────────────

create or replace function projects.advance_support_ticket(p_ticket_id uuid, p_to text, p_note text default null, p_evidence text default null, p_release_needed boolean default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets;
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_ev text := nullif(btrim(coalesce(p_evidence, '')), ''); v_tech boolean; v_def qa.defects; v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.status in ('closed', 'cancelled') then return query select 'terminal'::text; return; end if;
  if p_to not in ('in_progress', 'in_qa', 'release', 'client_confirmation', 'closed', 'cancelled') then return query select 'bad_target'::text; return; end if;
  v_tech := v_t.classification in ('warranty_bug', 'maintenance', 'minor_change');

  if p_to = 'cancelled' then
    if v_note is null then return query select 'note_required'::text; return; end if;
    perform set_config('projects.p8_sanctioned', 'on', true);
    update projects.support_tickets set status = 'cancelled', closed_at = v_now, close_reason = 'cancelled_by_person', resolution_note = v_note where id = v_t.id;
    perform projects.p8_ticket_event(v_org, v_t.id, 'cancelled', v_t.status, 'cancelled', v_actor, 'person', v_note, v_ev, v_now);
    return query select 'cancelled'::text; return;
  end if;
  if v_t.status = 'new' then return query select 'classify_first'::text; return; end if;

  if p_to = 'in_progress' then
    if v_t.status = 'classified' then return query select 'assign_first'::text; return; end if;
    if v_t.classification in ('change_request', 'new_project') then return query select 'out_of_scope_is_not_maintenance_work'::text; return; end if;
    if v_t.classification = 'disputed' then return query select 'dispute_unresolved'::text; return; end if;
    if v_t.status = 'assigned' then
      if v_t.classification = 'warranty_bug' and v_t.defect_id is null then return query select 'root_cause_required'::text; return; end if;
      if v_t.classification in ('maintenance', 'minor_change') and v_t.defect_id is null and v_t.maintenance_item_id is null then return query select 'root_cause_required'::text; return; end if;
    elsif v_t.status in ('in_qa', 'client_confirmation') then
      if v_note is null then return query select 'note_required'::text; return; end if;   -- a failed QA or a client who says it is not fixed
    else return query select 'wrong_state'::text; return;
    end if;
  elsif p_to = 'in_qa' then
    if v_t.status <> 'in_progress' then return query select 'wrong_state'::text; return; end if;
    if not v_tech then return query select 'no_qa_for_this_class'::text; return; end if;
  elsif p_to = 'release' then
    if v_t.status <> 'in_qa' then return query select 'wrong_state'::text; return; end if;
    if not v_t.release_needed then return query select 'no_release_needed'::text; return; end if;
  elsif p_to = 'client_confirmation' then
    if v_t.status = 'in_qa' then
      if v_t.release_needed then return query select 'release_required'::text; return; end if;
    elsif v_t.status = 'release' then
      if v_ev is null then return query select 'release_evidence_required'::text; return; end if;
    elsif v_t.status = 'in_progress' then
      if v_tech then return query select 'qa_required'::text; return; end if;
    else return query select 'wrong_state'::text; return;
    end if;
  elsif p_to = 'closed' then
    if v_t.classification in ('change_request', 'new_project') then
      if v_t.change_request_id is null and v_t.opportunity_id is null then return query select 'must_route_first'::text; return; end if;
      if v_t.status not in ('classified', 'assigned') then return query select 'wrong_state'::text; return; end if;
    elsif v_t.classification = 'how_to' and v_t.status = 'in_progress' then
      if v_note is null or v_ev is null then return query select 'answer_and_source_required'::text; return; end if;   -- the approved knowledge it came from
    elsif v_t.status = 'client_confirmation' then
      if v_t.client_confirmed_at is null then return query select 'client_confirmation_required'::text; return; end if;
    else return query select 'wrong_state'::text; return;
    end if;
  end if;

  -- QA verification: a linked defect must be verified; with no defect the QA evidence is the person's recorded reference
  if p_to in ('release', 'client_confirmation') and v_t.status = 'in_qa' then
    if v_t.defect_id is not null then
      select * into v_def from qa.defects d where d.id = v_t.defect_id;
      if v_def.status <> 'verified' then return query select 'qa_not_verified'::text; return; end if;
    elsif v_ev is null then return query select 'qa_evidence_required'::text; return;
    end if;
  end if;

  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_tickets set
    status = p_to,
    release_needed = case when p_to = 'in_qa' then coalesce(p_release_needed, false) else release_needed end,
    resolution_note = case when p_to = 'closed' then coalesce(v_note, resolution_note) else resolution_note end,
    closed_at = case when p_to = 'closed' then v_now end,
    close_reason = case when p_to = 'closed' then case when v_t.classification in ('change_request', 'new_project') then 'routed' when v_t.classification = 'how_to' and v_t.status = 'in_progress' then 'answered' else 'resolved' end end
  where id = v_t.id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'state_changed', v_t.status, p_to, v_actor, 'person', v_note, v_ev, v_now);
  return query select 'advanced'::text;
end $$;
revoke all on function projects.advance_support_ticket(uuid, text, text, text, boolean) from public, anon, service_role;
grant execute on function projects.advance_support_ticket(uuid, text, text, text, boolean) to authenticated;

create or replace function projects.record_client_confirmation(p_ticket_id uuid, p_evidence text, p_confirmed boolean default true)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets; v_ev text := nullif(btrim(coalesce(p_evidence, '')), ''); v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.status <> 'client_confirmation' then return query select 'wrong_state'::text; return; end if;
  -- the client's confirmation is a fact somebody saw: where and what, never inferred from silence
  if v_ev is null or length(v_ev) < 5 then return query select 'evidence_required'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  if p_confirmed then
    update projects.support_tickets set client_confirmed_at = v_now, client_confirmation_evidence = v_ev where id = v_t.id;
    perform projects.p8_ticket_event(v_org, v_t.id, 'client_confirmed', v_t.status, v_t.status, v_actor, 'person', null, v_ev, v_now);
    return query select 'confirmed'::text;
  else
    update projects.support_tickets set status = 'in_progress' where id = v_t.id;
    perform projects.p8_ticket_event(v_org, v_t.id, 'client_rejected', v_t.status, 'in_progress', v_actor, 'person', null, v_ev, v_now);
    return query select 'reopened'::text;
  end if;
end $$;
revoke all on function projects.record_client_confirmation(uuid, text, boolean) from public, anon, service_role;
grant execute on function projects.record_client_confirmation(uuid, text, boolean) to authenticated;

-- ── escalation to a person ──────────────────────────────────────────────────

create or replace function projects.escalate_support_ticket(p_ticket_id uuid, p_to_role text, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_to_role not in ('owner', 'ops_admin') then return query select 'bad_role'::text; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.status in ('closed', 'cancelled') then return query select 'terminal'::text; return; end if;
  if v_t.escalated_at is not null and v_t.escalation_ack_at is null then return query select 'already_open'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_tickets set escalated_to_role = p_to_role, escalated_at = v_now, escalation_reason = left(v_reason, 1000), escalation_ack_by = null, escalation_ack_at = null where id = v_t.id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'escalated', v_t.status, v_t.status, v_actor, 'person', 'to ' || p_to_role, v_reason, v_now);
  perform core.emit_event(v_org, 'support.ticket_escalated', 'support_ticket', v_t.id, jsonb_build_object('projectId', v_t.project_id, 'ticketId', v_t.id));
  return query select 'escalated'::text;
end $$;
revoke all on function projects.escalate_support_ticket(uuid, text, text) from public, anon, service_role;
grant execute on function projects.escalate_support_ticket(uuid, text, text) to authenticated;

create or replace function projects.acknowledge_support_escalation(p_ticket_id uuid, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets; v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.escalated_at is null then return query select 'not_escalated'::text; return; end if;
  if v_t.escalation_ack_at is not null then return query select 'already_acknowledged'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_tickets set escalation_ack_by = v_actor, escalation_ack_at = v_now where id = v_t.id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'escalation_acknowledged', v_t.status, v_t.status, v_actor, 'person', p_note, null, v_now);
  return query select 'acknowledged'::text;
end $$;
revoke all on function projects.acknowledge_support_escalation(uuid, text) from public, anon, service_role;
grant execute on function projects.acknowledge_support_escalation(uuid, text) to authenticated;

-- ── replies: a draft, and a record that a person sent it ────────────────────

create or replace function projects.draft_support_reply(p_ticket_id uuid, p_body text, p_language text default null)
returns table (outcome text, draft_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_t projects.support_tickets; v_body text := nullif(btrim(coalesce(p_body, '')), ''); v_id uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if v_body is null or length(v_body) > 4000 then return query select 'bad_body'::text, null::uuid; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = v_org;
  if v_t.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_t.status in ('closed', 'cancelled') then return query select 'terminal'::text, null::uuid; return; end if;
  select d.id into v_id from projects.support_reply_drafts d where d.ticket_id = v_t.id and d.body_hash = md5(v_body);
  if v_id is not null then return query select 'already_drafted'::text, v_id; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.support_reply_drafts (organization_id, ticket_id, body, body_hash, language, drafted_by) values (v_org, v_t.id, v_body, md5(v_body), p_language, v_actor) returning id into v_id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'reply_drafted', v_t.status, v_t.status, v_actor, 'person', null, null);
  return query select 'drafted'::text, v_id;
end $$;
revoke all on function projects.draft_support_reply(uuid, text, text) from public, anon, service_role;
grant execute on function projects.draft_support_reply(uuid, text, text) to authenticated;

create or replace function projects.record_support_reply_sent(p_draft_id uuid, p_channel text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d projects.support_reply_drafts; v_t projects.support_tickets; v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_channel not in ('portal', 'email', 'whatsapp', 'phone') then return query select 'bad_channel'::text; return; end if;
  select * into v_d from projects.support_reply_drafts d where d.id = p_draft_id and d.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  if v_d.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = v_d.ticket_id for update;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_reply_drafts set status = 'sent_recorded', sent_recorded_by = v_actor, sent_recorded_at = v_now, sent_channel = p_channel where id = v_d.id;
  -- the response clock stops when a person says they replied; the system never assumes a reply was sent
  update projects.support_tickets set first_response_at = coalesce(first_response_at, v_now) where id = v_t.id;
  perform projects.p8_ticket_event(v_org, v_t.id, 'reply_sent', v_t.status, v_t.status, v_actor, 'person', 'recorded as sent by ' || p_channel, null, v_now);
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_support_reply_sent(uuid, text) from public, anon, service_role;
grant execute on function projects.record_support_reply_sent(uuid, text) to authenticated;

create or replace function projects.discard_support_reply_draft(p_draft_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d projects.support_reply_drafts;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_d from projects.support_reply_drafts d where d.id = p_draft_id and d.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  if v_d.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_reply_drafts set status = 'discarded' where id = v_d.id;
  perform projects.p8_ticket_event(v_org, v_d.ticket_id, 'reply_discarded', null, null, v_actor, 'person', null, null);
  return query select 'discarded'::text;
end $$;
revoke all on function projects.discard_support_reply_draft(uuid) from public, anon, service_role;
grant execute on function projects.discard_support_reply_draft(uuid) to authenticated;

-- ── what the Support agent may do: propose, in the JOB's organization, through this one door ──

create or replace function projects.record_support_proposal(p_organization_id uuid, p_ticket_id uuid, p_agent_key text, p_proposed_classification text, p_rationale text, p_draft_body text, p_language text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_t projects.support_tickets; v_rat text := nullif(btrim(coalesce(p_rationale, '')), ''); v_body text := nullif(btrim(coalesce(p_draft_body, '')), ''); v_did uuid; v_changed boolean := false; v_now timestamptz := clock_timestamp();
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text; return; end if;
  if p_agent_key is distinct from 'support' then return query select 'not_the_support_agent'::text; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket_id and t.organization_id = p_organization_id for update;
  if v_t.id is null then return query select 'not_found'::text; return; end if;
  if v_t.status in ('closed', 'cancelled') then return query select 'terminal'::text; return; end if;
  if p_proposed_classification is null and v_body is null then return query select 'nothing_proposed'::text; return; end if;
  if p_proposed_classification is not null and (p_proposed_classification not in ('how_to', 'warranty_bug', 'maintenance', 'minor_change', 'change_request', 'new_project', 'disputed') or v_rat is null) then
    return query select 'bad_proposal'::text; return;
  end if;
  if v_body is not null and length(v_body) > 4000 then return query select 'bad_body'::text; return; end if;
  -- ADM-22: an agent's draft names no price and no discount; refused here with a name, and again by the table's CHECK
  if v_body is not null and v_body ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' then return query select 'no_price_here'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  if p_proposed_classification is not null and v_t.status in ('new', 'classified')
     and (v_t.proposed_classification is distinct from p_proposed_classification or v_t.proposed_rationale is distinct from left(v_rat, 2000)) then
    update projects.support_tickets set proposed_classification = p_proposed_classification, proposed_rationale = left(v_rat, 2000), proposed_by_agent = p_agent_key, proposed_at = v_now where id = v_t.id;
    v_changed := true;
  end if;
  if v_body is not null then
    select d.id into v_did from projects.support_reply_drafts d where d.ticket_id = v_t.id and d.body_hash = md5(v_body);
    if v_did is null then
      insert into projects.support_reply_drafts (organization_id, ticket_id, body, body_hash, language, drafted_by_agent) values (p_organization_id, v_t.id, v_body, md5(v_body), p_language, p_agent_key);
      v_changed := true;
    end if;
  end if;
  if not v_changed then return query select 'already_proposed'::text; return; end if;
  perform projects.p8_ticket_event(p_organization_id, v_t.id, 'proposal_recorded', v_t.status, v_t.status, null, 'agent', coalesce(p_proposed_classification, 'reply draft'), null, v_now);
  return query select 'proposed'::text;
end $$;
revoke all on function projects.record_support_proposal(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function projects.record_support_proposal(uuid, uuid, text, text, text, text, text) to service_role;

-- ── SLA: computed in SQL, with an injectable clock ──────────────────────────

create or replace function projects.support_sla_state(p_ticket_id uuid, p_now timestamptz default clock_timestamp())
returns table (response_state text, resolution_state text, response_due_at timestamptz, resolution_due_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select
    case when t.response_due_at is null then 'not_started'
         when t.first_response_at is not null then case when t.first_response_at <= t.response_due_at then 'met' else 'met_late' end
         when p_now > t.response_due_at then 'breached' else 'running' end,
    case when t.status = 'cancelled' then 'not_applicable'
         when t.resolution_due_at is null then 'not_started'
         when t.status = 'closed' then case when t.closed_at <= t.resolution_due_at then 'met' else 'met_late' end
         when p_now > t.resolution_due_at then 'breached' else 'running' end,
    t.response_due_at, t.resolution_due_at
  from projects.support_tickets t where t.id = p_ticket_id;
$$;
revoke all on function projects.support_sla_state(uuid, timestamptz) from public, anon;
grant execute on function projects.support_sla_state(uuid, timestamptz) to authenticated, service_role;

create or replace function projects.sweep_support_sla(p_organization_id uuid default null, p_now timestamptz default null)
returns table (response_breaches int, resolution_breaches int, escalated int)
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := coalesce(p_now, clock_timestamp()); r record; v_resp int := 0; v_res int := 0; v_esc int := 0; v_resp_hit boolean; v_res_hit boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0, 0; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  for r in
    select t.* from projects.support_tickets t join projects.phase_eight w on w.project_id = t.project_id
     where (p_organization_id is null or t.organization_id = p_organization_id) and w.state = 'active' and t.status not in ('new', 'closed', 'cancelled')
       and ((t.first_response_at is null and t.response_breached_at is null and t.response_due_at < v_now) or (t.resolution_breached_at is null and t.resolution_due_at < v_now))
     order by t.raised_at for update of t skip locked
  loop
    v_resp_hit := r.first_response_at is null and r.response_breached_at is null and r.response_due_at < v_now;
    v_res_hit := r.resolution_breached_at is null and r.resolution_due_at < v_now;
    update projects.support_tickets set response_breached_at = case when v_resp_hit then v_now else response_breached_at end,
                                         resolution_breached_at = case when v_res_hit then v_now else resolution_breached_at end where id = r.id;
    if v_resp_hit then
      v_resp := v_resp + 1;
      perform projects.p8_ticket_event(r.organization_id, r.id, 'sla_breach', r.status, r.status, null, 'system', 'response target missed', null, v_now);
      perform core.emit_event(r.organization_id, 'support.sla_breached', 'support_ticket', r.id, jsonb_build_object('projectId', r.project_id, 'ticketId', r.id, 'kind', 'response'));
    end if;
    if v_res_hit then
      v_res := v_res + 1;
      perform projects.p8_ticket_event(r.organization_id, r.id, 'sla_breach', r.status, r.status, null, 'system', 'resolution target missed', null, v_now);
      perform core.emit_event(r.organization_id, 'support.sla_breached', 'support_ticket', r.id, jsonb_build_object('projectId', r.project_id, 'ticketId', r.id, 'kind', 'resolution'));
    end if;
    -- a breach asks a person; it changes no state and no coverage
    if r.escalated_at is null then
      update projects.support_tickets set escalated_to_role = 'ops_admin', escalated_at = v_now, escalation_reason = 'an SLA target was missed' where id = r.id;
      perform projects.p8_ticket_event(r.organization_id, r.id, 'escalated', r.status, r.status, null, 'system', 'to ops_admin', 'an SLA target was missed', v_now);
      perform core.emit_event(r.organization_id, 'support.ticket_escalated', 'support_ticket', r.id, jsonb_build_object('projectId', r.project_id, 'ticketId', r.id));
      v_esc := v_esc + 1;
    end if;
  end loop;
  return query select v_resp, v_res, v_esc;
end $$;
revoke all on function projects.sweep_support_sla(uuid, timestamptz) from public, anon, authenticated;
grant execute on function projects.sweep_support_sla(uuid, timestamptz) to service_role;

-- ── the client's own read: status only, in the client's words; never classification, coverage, priority, assignee or SLA ──

create or replace function projects.client_support_tickets(p_project_id uuid)
returns table (ticket_ref text, title text, status_label text, raised_at timestamptz, closed_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null then return; end if;
  if coalesce((select core.is_client()), false) then
    if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.client_account_id = (select core.current_client_account_id())) then return; end if;
  elsif not coalesce((select core.is_internal()), false) then return;
  end if;
  return query
    select t.ticket_ref, t.title,
           case t.status when 'new' then 'Received' when 'classified' then 'Received' when 'assigned' then 'Being looked at' when 'in_progress' then 'Being worked on'
                         when 'in_qa' then 'Being checked' when 'release' then 'Being checked' when 'client_confirmation' then 'Waiting for your confirmation'
                         when 'closed' then 'Resolved' else 'Closed' end,
           t.raised_at, t.closed_at
      from projects.support_tickets t where t.project_id = p_project_id and t.organization_id = v_org and t.client_account_id = (select p.client_account_id from projects.projects p where p.id = p_project_id)
     order by t.raised_at desc;
end $$;
revoke all on function projects.client_support_tickets(uuid) from public, anon;
grant execute on function projects.client_support_tickets(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
