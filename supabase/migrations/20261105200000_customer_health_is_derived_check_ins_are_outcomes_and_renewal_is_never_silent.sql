-- ═════════════════════════════════════════════════════════════════
-- Phase 8A: customer health, recovery, check-ins and renewal hooks.
--
-- HEALTH IS A DERIVED READ. projects.customer_health(project, now) reads authoritative records (tickets, SLA stamps, invoices, defects, maintenance plans,
-- recovery plans, check-ins) and returns each signal with its value and level; projects.customer_health_status() reduces those to
-- healthy / stable / watch / at_risk / critical with the contributing signals attached. There is no score, no weight and no column a person or an agent
-- can type a status into. A snapshot (projects.customer_health_snapshots) is a dated copy of what the function returned, written only by the door and
-- only when the status CHANGED, so the history is explainable; it is never an input to the status.
-- Silence is not a signal: "no response" to a check-in is recorded as engagement and never lowers health (spec section 11).
--
-- Check-ins are records of a conversation a PERSON had, with an outcome and a channel; nothing here sends a message. Renewal is never silent: the sweep
-- flags a plan as renewal_approaching and opens a review, and marks a plan whose end date passed as expired; it never renews, extends or re-dates a plan.
-- ═════════════════════════════════════════════════════════════════

create table if not exists projects.customer_health_snapshots (
  id               uuid primary key default gen_random_uuid(),
  seq              bigint generated always as identity,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  status           text not null check (status in ('healthy', 'stable', 'watch', 'at_risk', 'critical')),
  previous_status  text check (previous_status in ('healthy', 'stable', 'watch', 'at_risk', 'critical')),
  signals          jsonb not null check (jsonb_typeof(signals) = 'array'),
  trigger          text not null check (trigger in ('start', 'scheduled', 'manual', 'ticket', 'recovery_resolution')),
  computed_at      timestamptz not null default clock_timestamp(),
  computed_by      uuid references core.users(id) on delete set null
);
create index if not exists customer_health_snapshots_project_idx on projects.customer_health_snapshots (project_id, seq desc);
comment on table projects.customer_health_snapshots is 'Append-only history of the DERIVED health read: status, previous status and the signals as they stood. Never an input to health.';

create table if not exists projects.recovery_plans (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references core.organizations(id) on delete cascade,
  project_id             uuid not null references projects.projects(id) on delete cascade,
  status                 text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'abandoned')),
  trigger_snapshot_id    uuid references projects.customer_health_snapshots(id) on delete set null,
  owner_id               uuid references core.users(id) on delete set null,
  root_cause             text,
  actions                text,
  deadline               date,
  outcome                text,
  resolved_snapshot_id   uuid references projects.customer_health_snapshots(id) on delete set null,
  closed_by              uuid references core.users(id) on delete set null,
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint recovery_plans_in_progress_is_owned check (status <> 'in_progress' or (owner_id is not null and length(btrim(coalesce(root_cause, ''))) > 0
                                                         and length(btrim(coalesce(actions, ''))) > 0 and deadline is not null)),
  constraint recovery_plans_closed_is_evidenced check ((status in ('resolved', 'abandoned')) = (closed_at is not null and closed_by is not null and length(btrim(coalesce(outcome, ''))) > 0)),
  constraint recovery_plans_resolved_has_a_fresh_read check (status <> 'resolved' or resolved_snapshot_id is not null)
);
create unique index if not exists recovery_plans_one_live on projects.recovery_plans (project_id) where status in ('open', 'in_progress');
comment on table projects.recovery_plans is 'Retention recovery for an at_risk/critical account: root cause, owner, actions, deadline and an outcome. Resolving takes a fresh health read and refuses while the account is still at_risk/critical.';

create table if not exists projects.cs_check_ins (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  kind              text not null check (kind in ('post_handover', 'adoption', 'renewal', 'major_release', 'post_incident', 'scheduled', 'recovery')),
  period_key        text not null check (length(btrim(period_key)) between 1 and 200),
  due_on            date not null,
  status            text not null default 'due' check (status in ('due', 'completed', 'skipped')),
  agenda            text check (agenda is null or length(agenda) <= 4000),
  agenda_by_agent   text,
  source_ref        uuid,
  engagement        text check (engagement in ('responded', 'no_response', 'declined', 'not_applicable')),
  channel           text check (channel in ('call', 'whatsapp', 'email', 'portal', 'meeting')),
  outcome           text check (outcome is null or length(outcome) <= 4000),
  completed_by      uuid references core.users(id) on delete set null,
  completed_at      timestamptz,
  skipped_reason    text,
  created_by        uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (project_id, kind, period_key),
  -- a relationship task is complete only with a recorded outcome, a channel, an engagement state and a person
  constraint cs_check_ins_complete_is_evidenced check ((status = 'completed') = (completed_by is not null and completed_at is not null and engagement is not null and channel is not null and length(btrim(coalesce(outcome, ''))) >= 10)),
  constraint cs_check_ins_skipped_says_why check ((status = 'skipped') = (length(btrim(coalesce(skipped_reason, ''))) >= 5)),
  constraint cs_check_ins_agenda_names_no_price check (agenda is null or agenda !~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off')
);
create index if not exists cs_check_ins_project_idx on projects.cs_check_ins (project_id, status, due_on);
comment on table projects.cs_check_ins is 'A post-launch check-in (post-handover, adoption, renewal, major release, post-incident, scheduled, recovery). One per (project, kind, period) so a retried event cannot make a duplicate. Complete only with a person, a channel, an engagement state and an outcome; no_response is engagement, not dissatisfaction.';

do $$
declare r record;
begin
  for r in select * from (values
    ('customer_health_snapshots', 'project_id', 'projects.projects'),
    ('recovery_plans', 'project_id', 'projects.projects'), ('recovery_plans', 'trigger_snapshot_id', 'projects.customer_health_snapshots'), ('recovery_plans', 'resolved_snapshot_id', 'projects.customer_health_snapshots'),
    ('cs_check_ins', 'project_id', 'projects.projects')
  ) as t(tbl, col, parent) loop
    perform projects.p8_wire_parent('projects', r.tbl, r.col, r.parent);
  end loop;
  perform projects.p8_wire_table('projects', 'customer_health_snapshots', false, true);
  perform projects.p8_wire_table('projects', 'recovery_plans', true, false);
  perform projects.p8_wire_table('projects', 'cs_check_ins', true, false);
end $$;

insert into core.event_types (type, description, canonical) values
  ('customer.health_changed', 'The derived health status of a Phase 8 project changed. Carries the new and previous status; the signals are read from the snapshot.', true),
  ('customer.retention_recovery_required', 'A Phase 8 project is at_risk or critical and has no recovery plan: one was opened. Emitted once per plan.', true),
  ('maintenance.renewal_due', 'A maintenance plan entered its renewal window: a renewal review was opened. Nothing is renewed, re-dated or sent.', true)
on conflict (type) do nothing;

-- ── health: derived, never stored as a fact ─────────────────────────────────

create or replace function projects.customer_health(p_project_id uuid, p_now timestamptz default clock_timestamp())
returns table (signal text, value text, level text, detail text)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org uuid; v_open int; v_p1 int; v_p1_late int; v_breach int; v_overdue int; v_defects int; v_plan_risk int; v_plan_lapsed int; v_recovery int; v_last timestamptz; v_w projects.phase_eight;
  t_watch int; t_risk int; b_risk int; i_risk int;
begin
  if coalesce((select auth.role()), '') <> 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then return; end if;
  t_watch := projects.p8_setting(v_org, 'health_open_tickets_watch'); t_risk := projects.p8_setting(v_org, 'health_open_tickets_at_risk');
  b_risk := projects.p8_setting(v_org, 'health_sla_breaches_at_risk'); i_risk := projects.p8_setting(v_org, 'health_overdue_invoices_at_risk');
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id;

  select count(*), count(*) filter (where t.priority = 'p1'), count(*) filter (where t.priority = 'p1' and t.resolution_due_at < p_now)
    into v_open, v_p1, v_p1_late from projects.support_tickets t where t.project_id = p_project_id and t.status not in ('closed', 'cancelled');
  select count(*) into v_breach from projects.support_tickets t
   where t.project_id = p_project_id and t.status <> 'cancelled' and t.raised_at > p_now - interval '90 days'
     and (t.response_breached_at is not null or t.resolution_breached_at is not null
          or (t.first_response_at is null and t.response_due_at < p_now) or (t.status <> 'closed' and t.resolution_due_at < p_now));
  select count(*) into v_overdue from finance.invoices i where i.project_id = p_project_id and i.status = 'overdue';
  select count(*) into v_defects from qa.defects d where d.project_id = p_project_id and d.status = 'open' and d.severity in ('blocker', 'major');
  select count(*) filter (where pl.status = 'at_risk'), count(*) filter (where pl.status in ('expired', 'declined', 'cancelled') and pl.updated_at > p_now - interval '90 days')
    into v_plan_risk, v_plan_lapsed from projects.maintenance_plans pl where pl.project_id = p_project_id;
  select count(*) into v_recovery from projects.recovery_plans rp where rp.project_id = p_project_id and rp.status in ('open', 'in_progress');
  select max(c.completed_at) into v_last from projects.cs_check_ins c where c.project_id = p_project_id and c.status = 'completed';

  return query select 'open_tickets', v_open::text,
    case when v_open >= t_risk then 'at_risk' when v_open >= t_watch then 'watch' else 'ok' end,
    v_open || ' open support ticket(s); watch at ' || t_watch || ', at risk at ' || t_risk;
  return query select 'urgent_open_tickets', v_p1::text,
    case when v_p1_late > 0 then 'critical' when v_p1 > 0 then 'at_risk' else 'ok' end,
    v_p1 || ' open P1 ticket(s)' || case when v_p1_late > 0 then ', ' || v_p1_late || ' past the resolution target' else '' end;
  return query select 'sla_breaches_90d', v_breach::text,
    case when v_breach >= b_risk then 'at_risk' when v_breach > 0 then 'watch' else 'ok' end,
    v_breach || ' ticket(s) missed an SLA target in the last 90 days; at risk at ' || b_risk;
  return query select 'overdue_invoices', v_overdue::text, case when v_overdue >= i_risk then 'at_risk' else 'ok' end, v_overdue || ' overdue invoice(s) on the project';
  return query select 'open_blocking_defects', v_defects::text, case when v_defects > 0 then 'watch' else 'ok' end, v_defects || ' open blocker/major defect(s)';
  return query select 'maintenance_plan_risk', v_plan_risk::text, case when v_plan_risk > 0 then 'at_risk' when v_plan_lapsed > 0 then 'watch' else 'ok' end,
    v_plan_risk || ' plan(s) marked at risk; ' || v_plan_lapsed || ' expired, declined or cancelled in the last 90 days';
  return query select 'open_recovery_plans', v_recovery::text, 'info', v_recovery || ' open recovery plan(s)';
  return query select 'last_completed_check_in', coalesce((p_now::date - v_last::date)::text || ' days ago', 'none yet'), 'info', 'informational only: silence is never scored';
  return query select 'warranty_remaining_days', coalesce(greatest(v_w.warranty_ends_on - p_now::date, 0)::text, 'no warranty'), 'info', 'informational only';
end $$;
revoke all on function projects.customer_health(uuid, timestamptz) from public, anon;
grant execute on function projects.customer_health(uuid, timestamptz) to authenticated, service_role;

create or replace function projects.customer_health_status(p_project_id uuid, p_now timestamptz default clock_timestamp())
returns table (status text, reasons jsonb)
language sql stable security invoker set search_path = '' as $$
  with h as (select * from projects.customer_health(p_project_id, p_now))
  select case when exists (select 1 from h where h.level = 'critical') then 'critical'
              when exists (select 1 from h where h.level = 'at_risk') then 'at_risk'
              when exists (select 1 from h where h.level = 'watch') then 'watch'
              when exists (select 1 from h where h.signal = 'open_tickets' and h.value::int > 0) then 'stable'
              else 'healthy' end,
         (select jsonb_agg(jsonb_build_object('signal', h.signal, 'value', h.value, 'level', h.level, 'detail', h.detail) order by h.signal) from h)
   where exists (select 1 from h);
$$;
revoke all on function projects.customer_health_status(uuid, timestamptz) from public, anon;
grant execute on function projects.customer_health_status(uuid, timestamptz) to authenticated, service_role;

-- the snapshot writer: only the doors reach it
create or replace function projects.p8_take_snapshot(p_org uuid, p_project_id uuid, p_trigger text, p_now timestamptz, p_actor uuid, p_force boolean default false)
returns table (outcome text, snapshot_id uuid, health_status text)
language plpgsql security definer set search_path = '' as $$
declare v_prev projects.customer_health_snapshots; v_new record; v_id uuid; v_plan uuid;
begin
  select * into v_prev from projects.customer_health_snapshots s where s.project_id = p_project_id order by s.seq desc limit 1;
  select * into v_new from projects.customer_health_status(p_project_id, coalesce(p_now, clock_timestamp()));
  if v_new.status is null then return query select 'no_signals'::text, null::uuid, null::text; return; end if;
  if v_prev.id is not null and v_prev.status = v_new.status and not p_force then return query select 'unchanged'::text, v_prev.id, v_new.status; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.customer_health_snapshots (organization_id, project_id, status, previous_status, signals, trigger, computed_at, computed_by)
  values (p_org, p_project_id, v_new.status, v_prev.status, v_new.reasons, p_trigger, coalesce(p_now, clock_timestamp()), p_actor) returning id into v_id;
  if v_prev.id is null or v_prev.status <> v_new.status then
    perform core.emit_event(p_org, 'customer.health_changed', 'health_snapshot', v_id, jsonb_build_object('projectId', p_project_id, 'snapshotId', v_id, 'status', v_new.status, 'previous', v_prev.status));
  end if;
  if v_new.status in ('at_risk', 'critical') and not exists (select 1 from projects.recovery_plans rp where rp.project_id = p_project_id and rp.status in ('open', 'in_progress')) then
    insert into projects.recovery_plans (organization_id, project_id, trigger_snapshot_id) values (p_org, p_project_id, v_id) returning id into v_plan;
    perform core.emit_event(p_org, 'customer.retention_recovery_required', 'recovery_plan', v_plan, jsonb_build_object('projectId', p_project_id, 'planId', v_plan, 'status', v_new.status));
  end if;
  return query select case when v_prev.id is null then 'first' else 'changed' end::text, v_id, v_new.status;
end $$;
revoke all on function projects.p8_take_snapshot(uuid, uuid, text, timestamptz, uuid, boolean) from public, anon, authenticated, service_role;

create or replace function projects.record_health_snapshot(p_project_id uuid, p_trigger text default 'manual', p_organization_id uuid default null, p_now timestamptz default null)
returns table (outcome text, snapshot_id uuid, health_status text)
language plpgsql security definer set search_path = '' as $$
declare v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_org uuid; v_actor uuid := (select auth.uid()); v_w projects.phase_eight;
begin
  if v_service then v_org := p_organization_id;
  else
    if v_actor is null or not coalesce((select core.is_internal()), false) or not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid, null::text; return; end if;
    v_org := (select core.current_organization_id());
    if p_organization_id is not null and p_organization_id is distinct from v_org then return query select 'not_authorized'::text, null::uuid, null::text; return; end if;
  end if;
  if p_trigger not in ('scheduled', 'manual', 'ticket') then return query select 'bad_trigger'::text, null::uuid, null::text; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id and w.organization_id = v_org;
  if v_w.id is null then return query select 'no_phase_eight'::text, null::uuid, null::text; return; end if;
  if v_w.state <> 'active' then return query select 'paused'::text, null::uuid, null::text; return; end if;
  return query select * from projects.p8_take_snapshot(v_org, p_project_id, p_trigger, case when v_service then p_now end, v_actor);
end $$;
revoke all on function projects.record_health_snapshot(uuid, text, uuid, timestamptz) from public, anon;
grant execute on function projects.record_health_snapshot(uuid, text, uuid, timestamptz) to authenticated, service_role;

-- ── recovery ────────────────────────────────────────────────────────────────

create or replace function projects.update_recovery_plan(p_plan_id uuid, p_owner uuid, p_root_cause text, p_actions text, p_deadline date)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.recovery_plans; v_rc text := nullif(btrim(coalesce(p_root_cause, '')), ''); v_ac text := nullif(btrim(coalesce(p_actions, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_p from projects.recovery_plans r where r.id = p_plan_id and r.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if v_p.status not in ('open', 'in_progress') then return query select 'closed'::text; return; end if;
  if p_owner is null or v_rc is null or v_ac is null or p_deadline is null then return query select 'incomplete'::text; return; end if;
  if not exists (select 1 from core.memberships m where m.organization_id = v_org and m.user_id = p_owner and m.status = 'active' and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member')) then
    return query select 'owner_not_a_member'::text; return;
  end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.recovery_plans set owner_id = p_owner, root_cause = left(v_rc, 2000), actions = left(v_ac, 4000), deadline = p_deadline, status = 'in_progress' where id = v_p.id;
  perform core.record_audit(v_org, 'recovery_plan.updated', 'recovery_plan', v_p.id, jsonb_build_object('status', v_p.status), jsonb_build_object('status', 'in_progress', 'owner', p_owner, 'deadline', p_deadline));
  return query select 'updated'::text;
end $$;
revoke all on function projects.update_recovery_plan(uuid, uuid, text, text, date) from public, anon, service_role;
grant execute on function projects.update_recovery_plan(uuid, uuid, text, text, date) to authenticated;

create or replace function projects.resolve_recovery_plan(p_plan_id uuid, p_outcome text)
returns table (outcome text, health_status text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.recovery_plans; v_out text := nullif(btrim(coalesce(p_outcome, '')), ''); v_s record; v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::text; return; end if;
  select * into v_p from projects.recovery_plans r where r.id = p_plan_id and r.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v_p.status <> 'in_progress' then return query select 'not_in_progress'::text, null::text; return; end if;
  if v_out is null or length(v_out) < 10 then return query select 'outcome_required'::text, null::text; return; end if;
  -- the re-evaluation is the evidence: a fresh derived read, taken now
  select * into v_s from projects.p8_take_snapshot(v_org, v_p.project_id, 'recovery_resolution', null, v_actor, true);
  if v_s.snapshot_id is null then return query select 'no_signals'::text, null::text; return; end if;
  if v_s.health_status in ('at_risk', 'critical') then return query select 'health_not_recovered'::text, v_s.health_status; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.recovery_plans set status = 'resolved', outcome = left(v_out, 2000), resolved_snapshot_id = v_s.snapshot_id, closed_by = v_actor, closed_at = v_now where id = v_p.id;
  perform core.record_audit(v_org, 'recovery_plan.resolved', 'recovery_plan', v_p.id, null, jsonb_build_object('healthAfter', v_s.health_status, 'snapshot', v_s.snapshot_id));
  return query select 'resolved'::text, v_s.health_status;
end $$;
revoke all on function projects.resolve_recovery_plan(uuid, text) from public, anon, service_role;
grant execute on function projects.resolve_recovery_plan(uuid, text) to authenticated;

create or replace function projects.abandon_recovery_plan(p_plan_id uuid, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.recovery_plans; v_r text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_p from projects.recovery_plans r where r.id = p_plan_id and r.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if v_p.status not in ('open', 'in_progress') then return query select 'closed'::text; return; end if;
  if v_r is null or length(v_r) < 10 then return query select 'reason_required'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.recovery_plans set status = 'abandoned', outcome = left(v_r, 2000), closed_by = v_actor, closed_at = clock_timestamp() where id = v_p.id;
  perform core.record_audit(v_org, 'recovery_plan.abandoned', 'recovery_plan', v_p.id, null, jsonb_build_object('reason', v_r));
  return query select 'abandoned'::text;
end $$;
revoke all on function projects.abandon_recovery_plan(uuid, text) from public, anon, service_role;
grant execute on function projects.abandon_recovery_plan(uuid, text) to authenticated;

-- ── check-ins ───────────────────────────────────────────────────────────────

create or replace function projects.create_check_in(p_project_id uuid, p_kind text, p_period_key text, p_due_on date, p_agenda text default null, p_source_ref uuid default null, p_organization_id uuid default null)
returns table (outcome text, check_in_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_org uuid; v_actor uuid := (select auth.uid()); v_w projects.phase_eight; v_id uuid; v_key text := nullif(btrim(coalesce(p_period_key, '')), '');
begin
  if v_service then v_org := p_organization_id;
  else
    if v_actor is null or not coalesce((select core.is_internal()), false) or not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
    v_org := (select core.current_organization_id());
    if p_organization_id is not null and p_organization_id is distinct from v_org then return query select 'not_authorized'::text, null::uuid; return; end if;
  end if;
  if p_kind not in ('post_handover', 'adoption', 'renewal', 'major_release', 'post_incident', 'scheduled', 'recovery') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if v_key is null or p_due_on is null then return query select 'bad_period'::text, null::uuid; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id and w.organization_id = v_org;
  if v_w.id is null then return query select 'no_phase_eight'::text, null::uuid; return; end if;
  if v_w.state = 'closed' then return query select 'workspace_closed'::text, null::uuid; return; end if;
  select c.id into v_id from projects.cs_check_ins c where c.project_id = p_project_id and c.kind = p_kind and c.period_key = v_key;
  if v_id is not null then return query select 'already_exists'::text, v_id; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.cs_check_ins (organization_id, project_id, kind, period_key, due_on, agenda, source_ref, created_by)
  values (v_org, p_project_id, p_kind, v_key, p_due_on, left(nullif(btrim(coalesce(p_agenda, '')), ''), 4000), p_source_ref, v_actor) returning id into v_id;
  return query select 'created'::text, v_id;
end $$;
revoke all on function projects.create_check_in(uuid, text, text, date, text, uuid, uuid) from public, anon;
grant execute on function projects.create_check_in(uuid, text, text, date, text, uuid, uuid) to authenticated, service_role;

create or replace function projects.complete_check_in(p_check_in_id uuid, p_engagement text, p_channel text, p_outcome text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.cs_check_ins; v_out text := nullif(btrim(coalesce(p_outcome, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_engagement not in ('responded', 'no_response', 'declined', 'not_applicable') then return query select 'bad_engagement'::text; return; end if;
  if p_channel not in ('call', 'whatsapp', 'email', 'portal', 'meeting') then return query select 'bad_channel'::text; return; end if;
  if v_out is null or length(v_out) < 10 then return query select 'outcome_required'::text; return; end if;
  select * into v_c from projects.cs_check_ins c where c.id = p_check_in_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status <> 'due' then return query select 'not_due'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.cs_check_ins set status = 'completed', engagement = p_engagement, channel = p_channel, outcome = left(v_out, 4000), completed_by = v_actor, completed_at = clock_timestamp() where id = v_c.id;
  perform core.record_audit(v_org, 'check_in.completed', 'cs_check_in', v_c.id, null, jsonb_build_object('kind', v_c.kind, 'engagement', p_engagement, 'channel', p_channel));
  return query select 'completed'::text;
end $$;
revoke all on function projects.complete_check_in(uuid, text, text, text) from public, anon, service_role;
grant execute on function projects.complete_check_in(uuid, text, text, text) to authenticated;

create or replace function projects.skip_check_in(p_check_in_id uuid, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.cs_check_ins; v_r text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_r is null or length(v_r) < 5 then return query select 'reason_required'::text; return; end if;
  select * into v_c from projects.cs_check_ins c where c.id = p_check_in_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status <> 'due' then return query select 'not_due'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.cs_check_ins set status = 'skipped', skipped_reason = left(v_r, 1000) where id = v_c.id;
  return query select 'skipped'::text;
end $$;
revoke all on function projects.skip_check_in(uuid, text) from public, anon, service_role;
grant execute on function projects.skip_check_in(uuid, text) to authenticated;

-- what the Customer Success agent may do: draft an agenda for a due check-in, never complete one, never contact anybody
create or replace function projects.record_check_in_agenda(p_organization_id uuid, p_check_in_id uuid, p_agent_key text, p_agenda text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_c projects.cs_check_ins; v_a text := nullif(btrim(coalesce(p_agenda, '')), '');
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text; return; end if;
  if p_agent_key is distinct from 'customer_success' then return query select 'not_the_customer_success_agent'::text; return; end if;
  if v_a is null or length(v_a) > 4000 then return query select 'bad_agenda'::text; return; end if;
  if v_a ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' then return query select 'no_price_here'::text; return; end if;
  select * into v_c from projects.cs_check_ins c where c.id = p_check_in_id and c.organization_id = p_organization_id for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status <> 'due' then return query select 'not_due'::text; return; end if;
  if v_c.agenda is not null and v_c.agenda_by_agent is null then return query select 'a_person_wrote_the_agenda'::text; return; end if;
  if v_c.agenda = v_a then return query select 'already_recorded'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.cs_check_ins set agenda = v_a, agenda_by_agent = p_agent_key where id = v_c.id;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_check_in_agenda(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function projects.record_check_in_agenda(uuid, uuid, text, text) to service_role;

-- eligibility to contact the client, by category. Preferences are read where AgencyOS holds them (WhatsApp consent per contact); anything else is not invented.
create or replace function projects.check_in_eligibility(p_project_id uuid, p_kind text default 'scheduled', p_now timestamptz default clock_timestamp())
returns table (category text, allowed boolean, reasons text[])
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_w projects.phase_eight; v_org uuid; v_status text; v_p1 int; v_urgent int; v_recovery int; v_optout boolean; v_last timestamptz; v_gap int; v_rel text[] := '{}'; v_com text[] := '{}'; v_op text[] := '{}';
begin
  if coalesce((select auth.role()), '') <> 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id;
  if v_w.id is null then return; end if;
  v_org := v_w.organization_id; v_gap := projects.p8_setting(v_org, 'checkin_min_gap_days');
  select h.status into v_status from projects.customer_health_status(p_project_id, p_now) h;
  select count(*) filter (where t.priority = 'p1'), count(*) filter (where t.priority in ('p1', 'p2')) into v_p1, v_urgent
    from projects.support_tickets t where t.project_id = p_project_id and t.status not in ('closed', 'cancelled');
  select count(*) into v_recovery from projects.recovery_plans rp where rp.project_id = p_project_id and rp.status in ('open', 'in_progress');
  v_optout := exists (select 1 from crm.communication_consent cc join crm.contacts ct on ct.id = cc.contact_id
                       where ct.client_account_id = v_w.client_account_id and ct.organization_id = v_org and cc.status = 'withdrawn');
  select max(c.completed_at) into v_last from projects.cs_check_ins c where c.project_id = p_project_id and c.status = 'completed';

  if v_w.state <> 'active' then
    v_op := array_append(v_op, 'the workspace is ' || v_w.state); v_rel := array_append(v_rel, 'the workspace is ' || v_w.state); v_com := array_append(v_com, 'the workspace is ' || v_w.state);
  end if;
  if v_optout then
    v_rel := array_append(v_rel, 'a contact withdrew consent');
    v_com := array_append(v_com, 'a contact withdrew consent (promotional outreach is off)');
  end if;
  if v_p1 > 0 and p_kind not in ('recovery', 'post_incident') then v_rel := array_append(v_rel, 'an open P1 ticket comes first'); end if;
  if v_last is not null and p_now - v_last < make_interval(days => v_gap) and p_kind not in ('recovery', 'post_incident') then
    v_rel := array_append(v_rel, 'the last check-in was under ' || v_gap || ' days ago');
  end if;
  if v_status in ('at_risk', 'critical') then v_com := array_append(v_com, 'health is ' || v_status || ': recovery comes first'); end if;
  if v_recovery > 0 then v_com := array_append(v_com, 'a recovery plan is open'); end if;
  if v_urgent > 0 then v_com := array_append(v_com, 'a P1/P2 service issue is unresolved'); end if;
  return query select 'operational'::text, coalesce(cardinality(v_op), 0) = 0, v_op;
  return query select 'relationship'::text, coalesce(cardinality(v_rel), 0) = 0, v_rel;
  return query select 'commercial'::text, coalesce(cardinality(v_com), 0) = 0, v_com;
end $$;
revoke all on function projects.check_in_eligibility(uuid, text, timestamptz) from public, anon;
grant execute on function projects.check_in_eligibility(uuid, text, timestamptz) to authenticated, service_role;

-- ── the workspace starts with a first read and a first check-in ─────────────

create or replace function projects.phase_eight_opened()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.cs_check_ins (organization_id, project_id, kind, period_key, due_on, created_by)
  values (new.organization_id, new.project_id, 'post_handover', 'post_handover', ((new.started_at at time zone 'UTC')::date + projects.p8_setting(new.organization_id, 'checkin_post_handover_days')), new.started_by)
  on conflict (project_id, kind, period_key) do nothing;
  perform projects.p8_take_snapshot(new.organization_id, new.project_id, 'start', null, new.started_by);
  return new;
end $$;
drop trigger if exists phase_eight_opened on projects.phase_eight;
create trigger phase_eight_opened after insert on projects.phase_eight for each row execute function projects.phase_eight_opened();

-- ── renewal: flagged and reviewed, never silently renewed ───────────────────

create or replace function projects.sweep_maintenance_renewals(p_organization_id uuid default null, p_now timestamptz default null)
returns table (flagged int, expired int)
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := coalesce(p_now, clock_timestamp()); v_today date := (coalesce(p_now, clock_timestamp()) at time zone 'UTC')::date; r record; v_flag int := 0; v_exp int := 0; v_window int;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  for r in
    select pl.*, w.organization_id as w_org from projects.maintenance_plans pl join projects.phase_eight w on w.project_id = pl.project_id
     where (p_organization_id is null or pl.organization_id = p_organization_id) and w.state = 'active' and pl.ends_on is not null
       and pl.status in ('active', 'renewed', 'renewal_approaching', 'renewal_proposed', 'pending_client')
     order by pl.ends_on for update of pl skip locked
  loop
    v_window := projects.p8_setting(r.organization_id, 'renewal_window_days');
    if r.ends_on < v_today then
      -- the end date passed and nobody recorded a renewal: the plan lapses, honestly and with a reason; it is not extended
      update projects.maintenance_plans set status = 'expired', ended_reason = 'the plan end date passed with no recorded renewal' where id = r.id;
      perform core.record_audit(r.organization_id, 'maintenance_plan.expired', 'maintenance_plan', r.id, jsonb_build_object('status', r.status), jsonb_build_object('status', 'expired', 'endsOn', r.ends_on));
      v_exp := v_exp + 1;
    elsif r.status in ('active', 'renewed') and r.ends_on - v_today <= v_window then
      update projects.maintenance_plans set status = 'renewal_approaching' where id = r.id;
      insert into projects.cs_check_ins (organization_id, project_id, kind, period_key, due_on, source_ref)
      values (r.organization_id, r.project_id, 'renewal', 'renewal:' || r.id::text || ':' || r.ends_on::text, v_today, r.id) on conflict (project_id, kind, period_key) do nothing;
      perform core.emit_event(r.organization_id, 'maintenance.renewal_due', 'maintenance_plan', r.id, jsonb_build_object('projectId', r.project_id, 'planId', r.id, 'endsOn', r.ends_on));
      v_flag := v_flag + 1;
    end if;
  end loop;
  return query select v_flag, v_exp;
end $$;
revoke all on function projects.sweep_maintenance_renewals(uuid, timestamptz) from public, anon, authenticated;
grant execute on function projects.sweep_maintenance_renewals(uuid, timestamptz) to service_role;

-- ── the Admin's reads: the support queue with its SLA states, and the account overview, both derived on read ──

create or replace function projects.support_queue(p_project_id uuid, p_now timestamptz default clock_timestamp())
returns table (id uuid, ticket_ref text, title text, source text, status text, classification text, coverage_decision text, coverage_reason text, priority text, assignee_id uuid, raised_at timestamptz,
               first_response_at timestamptz, response_due_at timestamptz, resolution_due_at timestamptz, response_state text, resolution_state text, escalated_to_role text, escalated_at timestamptz,
               escalation_ack_at timestamptz, plan_id uuid, defect_id uuid, change_request_id uuid, maintenance_item_id uuid, opportunity_id uuid, release_needed boolean, client_confirmed_at timestamptz,
               proposed_classification text, proposed_rationale text, closed_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select t.id, t.ticket_ref, t.title, t.source, t.status, t.classification, t.coverage_decision, t.coverage_reason, t.priority, t.assignee_id, t.raised_at, t.first_response_at, t.response_due_at, t.resolution_due_at,
         s.response_state, s.resolution_state, t.escalated_to_role, t.escalated_at, t.escalation_ack_at, t.plan_id, t.defect_id, t.change_request_id, t.maintenance_item_id, t.opportunity_id, t.release_needed,
         t.client_confirmed_at, t.proposed_classification, t.proposed_rationale, t.closed_at
    from projects.support_tickets t
    cross join lateral projects.support_sla_state(t.id, p_now) s
   where t.project_id = p_project_id
   order by (t.status in ('closed', 'cancelled')), t.raised_at desc
   limit 100;
$$;
revoke all on function projects.support_queue(uuid, timestamptz) from public, anon;
grant execute on function projects.support_queue(uuid, timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
