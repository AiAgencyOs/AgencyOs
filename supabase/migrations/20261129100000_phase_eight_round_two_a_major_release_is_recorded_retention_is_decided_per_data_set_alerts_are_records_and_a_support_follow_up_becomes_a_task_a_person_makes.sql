-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8A / 8B, round two. Deterministic, no credential, no funded model, nothing sent to a client, nothing priced.
--
--   8A activation    a MAJOR RELEASE is recorded by a person (there is no release-note source to read it from) and raises the existing major_release check-in
--                    through projects.create_check_in; one per (project, version label).
--   8A P8-SEC-006    retention DECISIONS for the data sets the Phase 7 class list does not cover: communication ledger, client feedback, value reports,
--                    opportunities, access denials. Admin-set, versioned. The Phase 7 class vocabulary is NOT widened (that would make every existing archive
--                    demand a new policy). A read shows rows held and rows older than the decision. Nothing is deleted: no delete surface exists.
--   8A CUS-IMP-009   ALERT rules (Admin-set thresholds) and ALERT records raised by a sweep that is handed its clock. An alert is a row for a person; nothing is
--                    sent. An Admin acknowledges; the sweep clears an alert whose figure fell back under its threshold.
--   8A SUP-TST-006   a Developer TASK from a support follow-up: a person with delivery rights turns an ACKNOWLEDGED developer handoff request into a task.
--                    The service role has no door; the task is built from the ticket row; one task per request.
--   8B routing cost  evidence is "no model call, nothing to record": the router calls no model, so no cost exists and none is ever returned.
--   8A VIP / scope-item comparison were built by an earlier part (client_strategic_designations, ticket_scope_references); this part adds nothing to them.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description) values
  ('project.major_release_recorded', 'A person recorded a major release of a delivered product; a major_release check-in was raised for Customer Success.'),
  ('project.cs_alert_raised', 'A Customer Success figure crossed an Admin-set alert threshold; the alert waits for a person.'),
  ('project.support_followup_task_created', 'A person turned an acknowledged support developer request into a task.')
on conflict (type) do nothing;

-- ── tables ─────────────────────────────────────────────────────────────────
create table if not exists projects.p789_major_releases (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  version_label    text not null check (length(btrim(version_label)) between 1 and 80 and not projects.p7_has_secret(version_label)),
  release_ref      text not null check (length(btrim(release_ref)) between 1 and 500 and not projects.p7_has_secret(release_ref)),
  summary          text not null check (length(btrim(summary)) between 10 and 2000 and not projects.p7_has_secret(summary)),
  released_on      date not null,
  check_in_id      uuid not null references projects.cs_check_ins(id) on delete restrict,
  recorded_by      uuid not null references core.users(id) on delete restrict,
  recorded_at      timestamptz not null default clock_timestamp(),
  unique (project_id, version_label)
);
comment on table projects.p789_major_releases is 'A major release a person recorded, with where its notes live. No release-note source exists; nothing is detected.';

create table if not exists projects.p789_phase_eight_retention_classes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  data_set         text not null check (data_set in ('communication_ledger', 'client_feedback', 'value_reports', 'opportunities', 'access_denials')),
  version          int not null check (version > 0),
  indefinite       boolean not null,
  retention_days   int check (retention_days is null or retention_days between 30 and 36500),
  basis            text not null check (length(btrim(basis)) between 10 and 1000 and not projects.p7_has_secret(basis)),
  set_by           uuid not null references core.users(id) on delete restrict,
  set_at           timestamptz not null default clock_timestamp(),
  unique (organization_id, data_set, version),
  check (indefinite = (retention_days is null))
);
comment on table projects.p789_phase_eight_retention_classes is 'An Admin''s retention decision for a Phase 8 data set the Phase 7 class list does not cover. A decision, not an executor: nothing here deletes.';

create table if not exists projects.p789_alert_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  metric           text not null check (metric in ('tickets_sla_breached', 'check_ins_overdue', 'recovery_plans_open', 'admin_notifications_overdue')),
  version          int not null check (version > 0),
  threshold        int not null check (threshold between 1 and 100000),
  reason           text not null check (length(btrim(reason)) between 5 and 500 and not projects.p7_has_secret(reason)),
  set_by           uuid not null references core.users(id) on delete restrict,
  set_at           timestamptz not null default clock_timestamp(),
  unique (organization_id, metric, version)
);

create table if not exists projects.p789_alerts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  rule_id          uuid not null references projects.p789_alert_rules(id) on delete restrict,
  metric           text not null check (metric in ('tickets_sla_breached', 'check_ins_overdue', 'recovery_plans_open', 'admin_notifications_overdue')),
  threshold        int not null,
  observed         int not null check (observed >= 0),
  state            text not null default 'open' check (state in ('open', 'acknowledged', 'cleared')),
  raised_at        timestamptz not null,
  acknowledged_by  uuid references core.users(id) on delete restrict,
  acknowledged_at  timestamptz,
  acknowledge_note text check (acknowledge_note is null or (length(btrim(acknowledge_note)) between 5 and 1000 and not projects.p7_has_secret(acknowledge_note))),
  cleared_at       timestamptz,
  constraint p789_alert_ack_is_a_persons check ((acknowledged_by is null) = (acknowledged_at is null) and (acknowledged_by is null) = (acknowledge_note is null)),
  constraint p789_alert_state_matches check ((state = 'cleared') = (cleared_at is not null) and (state <> 'acknowledged' or acknowledged_by is not null)),
  constraint p789_alert_crossed_its_threshold check (observed >= threshold)
);
create unique index if not exists p789_alert_one_live on projects.p789_alerts (organization_id, metric) where state <> 'cleared';
comment on table projects.p789_alerts is 'A figure crossed an Admin-set threshold. A record for a person; nothing is sent. The sweep clears it when the figure falls back.';

create table if not exists projects.p789_support_followup_tasks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  request_id       uuid not null unique references projects.support_handoff_requests(id) on delete restrict,
  ticket_id        uuid not null references projects.support_tickets(id) on delete cascade,
  task_id          uuid not null unique references projects.tasks(id) on delete restrict,
  created_by       uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default clock_timestamp()
);
comment on table projects.p789_support_followup_tasks is 'The task a person made from an acknowledged Developer request on a support ticket. One per request.';

do $$
declare r record;
begin
  for r in select * from (values
    ('p789_major_releases', 'project_id', 'projects.projects'), ('p789_major_releases', 'check_in_id', 'projects.cs_check_ins'),
    ('p789_alerts', 'rule_id', 'projects.p789_alert_rules'),
    ('p789_support_followup_tasks', 'request_id', 'projects.support_handoff_requests'), ('p789_support_followup_tasks', 'ticket_id', 'projects.support_tickets'), ('p789_support_followup_tasks', 'task_id', 'projects.tasks')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I, organization_id on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select * from (values
    ('p789_major_releases', ''), ('p789_phase_eight_retention_classes', ''), ('p789_alert_rules', ''),
    ('p789_alerts', 'observed,state,acknowledged_by,acknowledged_at,acknowledge_note,cleared_at'), ('p789_support_followup_tasks', '')
  ) as t(tbl, allowed) loop
    execute format('alter table projects.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on projects.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on projects.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on projects.%I from authenticated', r.tbl);
    execute format('grant select on projects.%I to authenticated', r.tbl);
    execute format('grant all on projects.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_guard', r.tbl);
    if r.allowed = '' then
      execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p789_guard()', r.tbl || '_guard', r.tbl);
    else
      execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p789_guard(%s)', r.tbl || '_guard', r.tbl,
        (select string_agg(quote_literal(x), ', ') from unnest(string_to_array(r.allowed, ',')) as x));
    end if;
  end loop;
end $$;

-- ═══ major release ═════════════════════════════════════════════════════════
create or replace function projects.p789_record_major_release(p_project_id uuid, p_version_label text, p_summary text, p_release_ref text, p_released_on date)
returns table (outcome text, release_id uuid, check_in_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_ci record; v_id uuid; v_label text := nullif(btrim(coalesce(p_version_label, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid, null::uuid; return; end if;
  if not coalesce((select core.is_internal()), false) or not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid, null::uuid; return; end if;
  if v_label is null then return query select 'version_required'::text, null::uuid, null::uuid; return; end if;
  if p_summary is null or length(btrim(p_summary)) < 10 then return query select 'summary_required'::text, null::uuid, null::uuid; return; end if;
  if p_release_ref is null or length(btrim(p_release_ref)) = 0 then return query select 'release_ref_required'::text, null::uuid, null::uuid; return; end if;
  if projects.p7_has_secret(p_summary) or projects.p7_has_secret(p_release_ref) or projects.p7_has_secret(v_label) then return query select 'contains_secret'::text, null::uuid, null::uuid; return; end if;
  if p_released_on is null or p_released_on > current_date + 1 then return query select 'bad_release_date'::text, null::uuid, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
  select r.id into v_id from projects.p789_major_releases r where r.project_id = p_project_id and r.version_label = v_label;
  if v_id is not null then return query select 'already_recorded'::text, v_id, (select m.check_in_id from projects.p789_major_releases m where m.id = v_id); return; end if;
  select * into v_ci from projects.create_check_in(p_project_id, 'major_release', 'major:' || v_label, greatest(current_date, p_released_on + 7), left('Major release ' || v_label || ': ' || btrim(p_summary), 4000));
  if v_ci.outcome not in ('created', 'already_exists') then return query select v_ci.outcome, null::uuid, null::uuid; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_major_releases (organization_id, project_id, version_label, release_ref, summary, released_on, check_in_id, recorded_by)
  values (v_org, p_project_id, v_label, btrim(p_release_ref), btrim(p_summary), p_released_on, v_ci.check_in_id, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'major_release.recorded', 'project', p_project_id, null, jsonb_build_object('version', v_label, 'checkInId', v_ci.check_in_id));
  perform core.emit_event(v_org, 'project.major_release_recorded', 'project', p_project_id, jsonb_build_object('projectId', p_project_id, 'version', v_label, 'checkInId', v_ci.check_in_id));
  return query select 'recorded'::text, v_id, v_ci.check_in_id;
end $$;
revoke all on function projects.p789_record_major_release(uuid, text, text, text, date) from public, anon, service_role;
grant execute on function projects.p789_record_major_release(uuid, text, text, text, date) to authenticated;

-- ═══ retention decisions ═══════════════════════════════════════════════════
create or replace function projects.p789_set_retention_class(p_data_set text, p_indefinite boolean, p_retention_days int, p_basis text)
returns table (outcome text, version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_v int;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::int; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::int; return; end if;
  if p_data_set is null or p_data_set not in ('communication_ledger', 'client_feedback', 'value_reports', 'opportunities', 'access_denials') then return query select 'bad_data_set'::text, null::int; return; end if;
  if p_indefinite is null or p_indefinite = (p_retention_days is not null) then return query select 'state_a_period_or_indefinite'::text, null::int; return; end if;
  if p_retention_days is not null and (p_retention_days < 30 or p_retention_days > 36500) then return query select 'bad_period'::text, null::int; return; end if;
  if p_basis is null or length(btrim(p_basis)) < 10 then return query select 'basis_required'::text, null::int; return; end if;
  if projects.p7_has_secret(p_basis) then return query select 'contains_secret'::text, null::int; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('p789_ret:' || v_org::text || p_data_set, 0));
  select coalesce(max(x.version), 0) + 1 into v_v from projects.p789_phase_eight_retention_classes x where x.organization_id = v_org and x.data_set = p_data_set;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_phase_eight_retention_classes (organization_id, data_set, version, indefinite, retention_days, basis, set_by) values (v_org, p_data_set, v_v, p_indefinite, p_retention_days, btrim(p_basis), v_actor);
  perform core.record_audit(v_org, 'retention.phase_eight_class_set', 'organization', v_org, null, jsonb_build_object('dataSet', p_data_set, 'indefinite', p_indefinite, 'days', p_retention_days, 'version', v_v));
  return query select 'set'::text, v_v;
end $$;
revoke all on function projects.p789_set_retention_class(text, boolean, int, text) from public, anon, service_role;
grant execute on function projects.p789_set_retention_class(text, boolean, int, text) to authenticated;

create or replace function projects.p789_retention_status(p_now timestamptz default null)
returns table (data_set text, decided boolean, version int, indefinite boolean, retention_days int, rows_held bigint, oldest_at timestamptz, rows_past_decision bigint)
language plpgsql stable security invoker set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_now timestamptz := coalesce(p_now, clock_timestamp());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  with held(ds, at) as (
    select 'communication_ledger', x.created_at from projects.client_communication_ledger x where x.organization_id = v_org
    union all select 'client_feedback', x.created_at from projects.client_feedback x where x.organization_id = v_org
    union all select 'value_reports', x.built_at from projects.value_report_drafts x where x.organization_id = v_org
    union all select 'opportunities', x.created_at from sales.phase_eight_opportunities x where x.organization_id = v_org
    union all select 'access_denials', x.created_at from projects.phase_eight_access_denials x where x.organization_id = v_org and (select core.is_admin())
  ), sets(ds) as (values ('access_denials'), ('client_feedback'), ('communication_ledger'), ('opportunities'), ('value_reports'))
  select s.ds, c.id is not null, c.version, c.indefinite, c.retention_days, count(h.at), min(h.at),
         count(h.at) filter (where c.retention_days is not null and h.at < v_now - make_interval(days => c.retention_days))
    from sets s
    left join lateral (select k.id, k.version, k.indefinite, k.retention_days from projects.p789_phase_eight_retention_classes k where k.organization_id = v_org and k.data_set = s.ds order by k.version desc limit 1) c on true
    left join held h on h.ds = s.ds
   group by s.ds, c.id, c.version, c.indefinite, c.retention_days order by s.ds;
end $$;
revoke all on function projects.p789_retention_status(timestamptz) from public, anon, service_role;
grant execute on function projects.p789_retention_status(timestamptz) to authenticated;
comment on function projects.p789_retention_status(timestamptz) is 'Read-only: per Phase 8 data set the Admin decision (if any), rows held, the oldest, and how many are older than the decision. It deletes nothing.';

-- ═══ alerts ════════════════════════════════════════════════════════════════
create or replace function projects.p789_set_alert_rule(p_metric text, p_threshold int, p_reason text)
returns table (outcome text, version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_v int;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::int; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::int; return; end if;
  if p_metric is null or p_metric not in ('tickets_sla_breached', 'check_ins_overdue', 'recovery_plans_open', 'admin_notifications_overdue') then return query select 'bad_metric'::text, null::int; return; end if;
  if p_threshold is null or p_threshold < 1 or p_threshold > 100000 then return query select 'bad_threshold'::text, null::int; return; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then return query select 'reason_required'::text, null::int; return; end if;
  if projects.p7_has_secret(p_reason) then return query select 'contains_secret'::text, null::int; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('p789_rule:' || v_org::text || p_metric, 0));
  select coalesce(max(x.version), 0) + 1 into v_v from projects.p789_alert_rules x where x.organization_id = v_org and x.metric = p_metric;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_alert_rules (organization_id, metric, version, threshold, reason, set_by) values (v_org, p_metric, v_v, p_threshold, btrim(p_reason), v_actor);
  perform core.record_audit(v_org, 'alert.rule_set', 'organization', v_org, null, jsonb_build_object('metric', p_metric, 'threshold', p_threshold, 'version', v_v));
  return query select 'set'::text, v_v;
end $$;
revoke all on function projects.p789_set_alert_rule(text, int, text) from public, anon, service_role;
grant execute on function projects.p789_set_alert_rule(text, int, text) to authenticated;

create or replace function projects.p789_alert_figure(p_org uuid, p_metric text, p_now timestamptz)
returns int language plpgsql stable security definer set search_path = '' as $$
begin
  return case p_metric
    when 'tickets_sla_breached' then (select count(*)::int from projects.support_tickets t where t.organization_id = p_org and t.closed_at is null and (t.response_breached_at is not null or t.resolution_breached_at is not null))
    when 'check_ins_overdue' then (select count(*)::int from projects.cs_check_ins c where c.organization_id = p_org and c.status = 'due' and c.due_on < p_now::date)
    when 'recovery_plans_open' then (select count(*)::int from projects.recovery_plans r where r.organization_id = p_org and r.status in ('open', 'in_progress'))
    when 'admin_notifications_overdue' then (select count(*)::int from projects.p789_admin_notifications n where n.organization_id = p_org and n.status = 'pending' and n.due_by < p_now)
    else 0 end;
end $$;
revoke all on function projects.p789_alert_figure(uuid, text, timestamptz) from public, anon, authenticated, service_role;

create or replace function projects.p789_sweep_alerts(p_organization_id uuid default null, p_now timestamptz default null)
returns table (outcome text, raised int, cleared int)
language plpgsql security definer set search_path = '' as $$
declare
  v_svc boolean := coalesce((select auth.role()), '') = 'service_role'; v_org uuid; v_now timestamptz; r record; v_fig int; v_raised int := 0; v_cleared int := 0; v_id uuid;
begin
  if v_svc then v_org := p_organization_id; v_now := coalesce(p_now, clock_timestamp());
  else
    if (select auth.uid()) is null then return query select 'no_actor'::text, 0, 0; return; end if;
    if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, 0, 0; return; end if;
    v_org := (select core.current_organization_id()); v_now := clock_timestamp();
  end if;
  for r in
    select distinct on (k.organization_id, k.metric) k.id, k.organization_id, k.metric, k.threshold
      from projects.p789_alert_rules k where (v_org is null or k.organization_id = v_org) order by k.organization_id, k.metric, k.version desc
  loop
    v_fig := projects.p789_alert_figure(r.organization_id, r.metric, v_now);
    perform set_config('projects.p789_door', 'on', true);
    if v_fig >= r.threshold then
      insert into projects.p789_alerts (organization_id, rule_id, metric, threshold, observed, raised_at) values (r.organization_id, r.id, r.metric, r.threshold, v_fig, v_now)
      on conflict (organization_id, metric) where state <> 'cleared' do nothing returning id into v_id;
      if v_id is not null then
        v_raised := v_raised + 1;
        perform core.emit_event(r.organization_id, 'project.cs_alert_raised', 'organization', r.organization_id, jsonb_build_object('metric', r.metric, 'observed', v_fig, 'threshold', r.threshold));
        v_id := null;
      else
        update projects.p789_alerts set observed = v_fig where organization_id = r.organization_id and metric = r.metric and state <> 'cleared' and observed is distinct from v_fig;
      end if;
    else
      update projects.p789_alerts set state = 'cleared', cleared_at = v_now where organization_id = r.organization_id and metric = r.metric and state <> 'cleared';
      if found then v_cleared := v_cleared + 1; end if;
    end if;
  end loop;
  return query select case when v_raised + v_cleared > 0 then 'swept' else 'nothing_changed' end, v_raised, v_cleared;
end $$;
revoke all on function projects.p789_sweep_alerts(uuid, timestamptz) from public, anon;
grant execute on function projects.p789_sweep_alerts(uuid, timestamptz) to authenticated, service_role;

create or replace function projects.p789_acknowledge_alert(p_alert_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_a projects.p789_alerts;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_note is null or length(btrim(p_note)) < 5 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_a from projects.p789_alerts x where x.id = p_alert_id and x.organization_id = v_org for update;
  if v_a.id is null then return query select 'not_found'::text; return; end if;
  if v_a.state = 'cleared' then return query select 'already_cleared'::text; return; end if;
  if v_a.state = 'acknowledged' then return query select 'already_acknowledged'::text; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  update projects.p789_alerts set state = 'acknowledged', acknowledged_by = v_actor, acknowledged_at = clock_timestamp(), acknowledge_note = btrim(p_note) where id = v_a.id;
  perform core.record_audit(v_org, 'alert.acknowledged', 'organization', v_org, null, jsonb_build_object('metric', v_a.metric));
  return query select 'acknowledged'::text;
end $$;
revoke all on function projects.p789_acknowledge_alert(uuid, text) from public, anon, service_role;
grant execute on function projects.p789_acknowledge_alert(uuid, text) to authenticated;

-- ═══ a Developer task from a support follow-up, made by a person ═══════════
create or replace function projects.p789_create_task_from_followup(p_request_id uuid, p_assignee_id uuid default null, p_due_on date default null)
returns table (outcome text, task_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.support_handoff_requests; v_t projects.support_tickets; v_task uuid;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_r from projects.support_handoff_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_r.target <> 'developer' then return query select 'not_a_developer_request'::text, null::uuid; return; end if;
  if v_r.status <> 'acknowledged' then return query select case when v_r.status = 'requested' then 'not_acknowledged_yet' else 'request_already_settled' end, null::uuid; return; end if;
  if exists (select 1 from projects.p789_support_followup_tasks f where f.request_id = p_request_id) then return query select 'already_created'::text, (select f.task_id from projects.p789_support_followup_tasks f where f.request_id = p_request_id); return; end if;
  if p_assignee_id is not null and not exists (select 1 from core.memberships m where m.organization_id = v_org and m.user_id = p_assignee_id) then return query select 'assignee_not_in_organization'::text, null::uuid; return; end if;
  select * into v_t from projects.support_tickets t where t.id = v_r.ticket_id and t.organization_id = v_org;
  if v_t.id is null then return query select 'ticket_not_found'::text, null::uuid; return; end if;
  insert into projects.tasks (organization_id, project_id, title, description, priority, assignee_id, due_on)
  values (v_org, v_t.project_id, left('Support follow-up ' || v_t.ticket_ref || ': ' || v_t.title, 300),
          'Raised from support ticket ' || v_t.ticket_ref || ' by a person, after the developer request was acknowledged. Reason given: ' || v_r.reason
            || '. The ticket is the record; this task is the work.',
          case v_t.priority when 'p1' then 'p1' when 'p2' then 'p2' else 'p3' end, p_assignee_id, p_due_on)
  returning id into v_task;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_support_followup_tasks (organization_id, request_id, ticket_id, task_id, created_by) values (v_org, v_r.id, v_t.id, v_task, v_actor);
  perform core.record_audit(v_org, 'support_followup.task_created', 'support_ticket', v_t.id, null, jsonb_build_object('requestId', v_r.id, 'taskId', v_task));
  perform core.emit_event(v_org, 'project.support_followup_task_created', 'support_ticket', v_t.id, jsonb_build_object('projectId', v_t.project_id, 'taskId', v_task));
  return query select 'created'::text, v_task;
end $$;
revoke all on function projects.p789_create_task_from_followup(uuid, uuid, date) from public, anon, service_role;
grant execute on function projects.p789_create_task_from_followup(uuid, uuid, date) to authenticated;

-- ═══ 8B routing cost evidence: honestly nothing ════════════════════════════
create or replace function projects.p789_maintenance_routing_cost_evidence(p_work_item_id uuid)
returns table (decision_key text, outcome text, model_call boolean, cost_minor bigint, statement text)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if (select core.current_organization_id()) is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query select d.decision_key, d.outcome, false, null::bigint, 'The router made no model call for this decision, so there is no cost to record. No figure is stored or invented.'::text
    from projects.maintenance_routing_decisions d where d.work_item_id = p_work_item_id and d.organization_id = (select core.current_organization_id()) order by d.decided_at, d.id;
end $$;
revoke all on function projects.p789_maintenance_routing_cost_evidence(uuid) from public, anon, service_role;
grant execute on function projects.p789_maintenance_routing_cost_evidence(uuid) to authenticated;

notify pgrst, 'reload schema';
