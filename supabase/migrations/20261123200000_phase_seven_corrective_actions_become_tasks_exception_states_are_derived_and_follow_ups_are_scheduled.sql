-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 gap closure that needs no credential, no model and no provider:
--
--   P7-INC-09  a corrective action is a TASK. projects.add_incident_corrective_action creates a real projects.tasks row, linked to the incident, with the
--              severity's priority; projects.p7_incident_corrective_status reads how many are done. The incident's own close rule is untouched.
--   P7-COMP-05 the exception states HANDOVER_BLOCKED, CLIENT_ACTION_REQUIRED and DISPUTED are DERIVED (projects.p7_exception_states): nothing is stored, no
--              state machine value is added, and every row names the record it was read from.
--   P7-CS-03   the post-handover follow-ups (day 0, week 1, warranty end minus 7 days) are scheduled as tasks, once each (projects.schedule_handover_follow_ups).
--              The warranty date is the DELIVERED package's own; with none stated that follow-up is reported, never invented.
--   P7-ARC-06  LinkedFutureWork is a derived read (projects.p7_linked_future_work): open handover feedback routed away from this project, undisclosed
--              work and known limitations, and open code changes, each with its source.
--   P7-PM-06   a deterministic classifier SUGGESTS a class and route for handover feedback (projects.p7_suggest_feedback_classification). Staff still apply
--              it through record_handover_feedback; an unmatched or ambiguous text is reported as such, never guessed.
--   P7-QA-06   a ProductionHealthSnapshot is a recorded fact with its SOURCE named. A person records one (source = manual); no monitoring source exists, so
--              none is ever written as a monitor's reading, and the latest snapshot says how old it is.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── P7-INC-09: corrective actions are tasks ────────────────────────────────
create table if not exists projects.p7d_incident_corrective_actions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  incident_id      uuid not null references projects.p7_incidents(id) on delete cascade,
  task_id          uuid not null unique references projects.tasks(id) on delete restrict,
  title            text not null check (length(btrim(title)) > 0 and length(title) <= 300),
  created_by       uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default clock_timestamp()
);
create index if not exists p7_corrective_actions_incident_idx on projects.p7d_incident_corrective_actions (incident_id);

-- ── P7-QA-06: a health snapshot with its source ────────────────────────────
create table if not exists projects.p7d_health_snapshots (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  deployment_id    uuid references projects.p7_deployments(id) on delete restrict,
  commit_ref       text check (commit_ref is null or commit_ref ~ '^[0-9a-f]{7,40}$'),
  source           text not null check (source = 'manual'),
  status           text not null check (status in ('healthy', 'degraded', 'down', 'unknown')),
  error_summary    text check (error_summary is null or (length(error_summary) <= 2000 and not projects.p7_has_secret(error_summary))),
  integrations_ok  boolean,
  database_ok      boolean,
  evidence_ref     text not null check (length(btrim(evidence_ref)) > 0 and length(evidence_ref) <= 500 and not projects.p7_has_secret(evidence_ref)),
  recorded_by      uuid not null references core.users(id) on delete restrict,
  recorded_at      timestamptz not null default clock_timestamp()
);
create index if not exists p7d_health_snapshots_project_idx on projects.p7d_health_snapshots (project_id, recorded_at desc);

-- ── P7-CS-03: follow-up tasks, one per kind per project ────────────────────
create table if not exists projects.p7d_follow_up_tasks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  kind             text not null check (kind in ('day_zero', 'week_one', 'warranty_end_minus_7')),
  task_id          uuid not null unique references projects.tasks(id) on delete restrict,
  due_on           date not null,
  created_at       timestamptz not null default clock_timestamp(),
  unique (project_id, kind)
);

do $$
declare r record;
begin
  for r in select * from (values
    ('p7d_incident_corrective_actions', 'incident_id', 'projects.p7_incidents'), ('p7d_incident_corrective_actions', 'task_id', 'projects.tasks'),
    ('p7d_health_snapshots', 'project_id', 'projects.projects'), ('p7d_health_snapshots', 'deployment_id', 'projects.p7_deployments'),
    ('p7d_follow_up_tasks', 'project_id', 'projects.projects'), ('p7d_follow_up_tasks', 'task_id', 'projects.tasks')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['p7d_incident_corrective_actions', 'p7d_health_snapshots', 'p7d_follow_up_tasks']) as tbl loop
    execute format('alter table projects.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on projects.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on projects.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on projects.%I from authenticated', r.tbl);
    execute format('grant select on projects.%I to authenticated', r.tbl);
    execute format('grant all on projects.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.maintenance_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

-- ── P7-INC-09 door and read ────────────────────────────────────────────────
create or replace function projects.add_incident_corrective_action(p_incident_id uuid, p_title text, p_assignee_id uuid default null, p_due_on date default null)
returns table (outcome text, task_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_i projects.p7_incidents; v_t uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_title is null or length(btrim(p_title)) = 0 then return query select 'title_required'::text, null::uuid; return; end if;
  if length(p_title) > 300 then return query select 'title_too_long'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_title) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select * into v_i from projects.p7_incidents i where i.id = p_incident_id and i.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_assignee_id is not null and not exists (select 1 from core.memberships m where m.organization_id = v_org and m.user_id = p_assignee_id) then return query select 'assignee_not_in_organization'::text, null::uuid; return; end if;
  if exists (select 1 from projects.p7d_incident_corrective_actions a where a.incident_id = p_incident_id and lower(btrim(a.title)) = lower(btrim(p_title))) then return query select 'already_recorded'::text, null::uuid; return; end if;
  insert into projects.tasks (organization_id, project_id, title, description, priority, assignee_id, due_on)
  values (v_org, v_i.project_id, left('Corrective action: ' || btrim(p_title), 300),
          'Raised from production incident ' || v_i.id || ' (' || v_i.incident_type || ', ' || v_i.severity || '). A corrective action is work somebody owns, not text.',
          case v_i.severity when 'sev1' then 'p0' when 'sev2' then 'p1' else 'p2' end, p_assignee_id, p_due_on)
  returning id into v_t;
  insert into projects.p7d_incident_corrective_actions (organization_id, incident_id, task_id, title, created_by) values (v_org, v_i.id, v_t, btrim(p_title), v_actor);
  perform core.record_audit(v_org, 'incident.corrective_action_created', 'incident', v_i.id, null, jsonb_build_object('taskId', v_t));
  return query select 'created'::text, v_t;
end $$;
revoke all on function projects.add_incident_corrective_action(uuid, text, uuid, date) from public, anon;
grant execute on function projects.add_incident_corrective_action(uuid, text, uuid, date) to authenticated;

create or replace function projects.p7_incident_corrective_status(p_incident_id uuid)
returns table (total int, done int, open int)
language plpgsql stable security definer set search_path = '' as $$
declare v_i projects.p7_incidents;
begin
  select * into v_i from projects.p7_incidents i where i.id = p_incident_id;
  if v_i.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and (v_i.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  return query select count(*)::int, (count(*) filter (where t.status = 'done'))::int, (count(*) filter (where t.status <> 'done'))::int
    from projects.p7d_incident_corrective_actions a join projects.tasks t on t.id = a.task_id where a.incident_id = p_incident_id;
end $$;
revoke all on function projects.p7_incident_corrective_status(uuid) from public, anon;
grant execute on function projects.p7_incident_corrective_status(uuid) to authenticated, service_role;

-- ── P7-COMP-05: derived exception states ───────────────────────────────────
create or replace function projects.p7_exception_states(p_project_id uuid)
returns table (state text, reason text, source text)
language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.phase_seven; v_pk projects.p7_handover_packages; v_acc projects.p7_client_acceptances; v_n int;
begin
  select * into v_p from projects.phase_seven s where s.project_id = p_project_id;
  if v_p.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and (v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;

  -- HANDOVER_BLOCKED: the handover cannot move, and the row that says why
  if v_p.state in ('handover_preparing', 'admin_handover_review', 'handover_ready') then
    if v_p.completion_paused then
      return query select 'handover_blocked'::text, coalesce(v_p.paused_reason, 'completion is paused'), 'phase_seven.completion_paused'::text;
    end if;
    select count(*) into v_n from projects.p7_incidents i where i.project_id = p_project_id and i.state <> 'closed';
    if v_n > 0 then return query select 'handover_blocked'::text, v_n || ' production incident(s) are not closed', 'p7_incidents'::text; end if;
    select * into v_pk from projects.p7_handover_packages k where k.project_id = p_project_id and k.status <> 'superseded' order by k.version desc limit 1;
    if v_pk.id is not null and v_pk.status = 'changes_requested' then
      return query select 'handover_blocked'::text, 'the latest handover package version ' || v_pk.version || ' was sent back for changes', 'p7_handover_packages'::text;
    end if;
  end if;

  -- CLIENT_ACTION_REQUIRED: the phase waits on the client, or the client owes an action that is not confirmed
  if v_p.state = 'client_action_required' then
    return query select 'client_action_required'::text, 'the project waits on the client', 'phase_seven.state'::text;
  end if;
  select count(*) into v_n from projects.p7c_client_action_requests r where r.project_id = p_project_id and r.status in ('open', 'submitted');
  if v_n > 0 then return query select 'client_action_required'::text, v_n || ' client action request(s) are open or awaiting confirmation', 'p7c_client_action_requests'::text; end if;

  -- DISPUTED: the client's latest decision on the latest package is a dispute, or a dispute / chargeback is open
  select a.* into v_acc from projects.p7_client_acceptances a where a.project_id = p_project_id order by a.recorded_at desc, a.id desc limit 1;
  if v_acc.id is not null and v_acc.decision = 'disputed' then
    return query select 'disputed'::text, 'the client''s latest decision on the handover is a dispute', 'p7_client_acceptances'::text;
  end if;
  select count(*) into v_n from projects.p7_financial_exceptions e where e.project_id = p_project_id and e.status = 'open' and e.kind in ('dispute', 'chargeback');
  if v_n > 0 then return query select 'disputed'::text, v_n || ' open dispute or chargeback record(s)', 'p7_financial_exceptions'::text; end if;
end $$;
revoke all on function projects.p7_exception_states(uuid) from public, anon;
grant execute on function projects.p7_exception_states(uuid) to authenticated, service_role;

-- ── P7-CS-03: follow-up tasks ──────────────────────────────────────────────
create or replace function projects.schedule_handover_follow_ups(p_project_id uuid)
returns table (outcome text, created int, skipped text[])
language plpgsql security definer set search_path = '' as $$
declare
  v_svc boolean := coalesce((select auth.role()), '') = 'service_role';
  v_org uuid; v_actor uuid := (select auth.uid()); v_p projects.phase_seven; v_rec projects.p7_completion_records; v_pk projects.p7_handover_packages;
  v_made int := 0; v_skip text[] := '{}'; v_due date; v_task uuid; k text;
begin
  select * into v_p from projects.phase_seven s where s.project_id = p_project_id;
  if v_p.id is null then return query select 'not_found'::text, 0, '{}'::text[]; return; end if;
  v_org := v_p.organization_id;
  if not v_svc then
    if v_actor is null then return query select 'no_actor'::text, 0, '{}'::text[]; return; end if;
    if v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, 0, '{}'::text[]; return; end if;
  end if;
  select * into v_rec from projects.p7_completion_records c where c.project_id = p_project_id;
  if v_rec.id is null then return query select 'not_completed'::text, 0, '{}'::text[]; return; end if;
  select * into v_pk from projects.p7_handover_packages k2 where k2.project_id = p_project_id and k2.status = 'delivered' order by k2.version desc limit 1;
  foreach k in array array['day_zero', 'week_one', 'warranty_end_minus_7'] loop
    if exists (select 1 from projects.p7d_follow_up_tasks f where f.project_id = p_project_id and f.kind = k) then continue; end if;
    v_due := case k when 'day_zero' then v_rec.completed_at::date when 'week_one' then v_rec.completed_at::date + 7
                    else case when v_pk.warranty_ends_on is null then null else v_pk.warranty_ends_on - 7 end end;
    if v_due is null then v_skip := v_skip || (k || ': no warranty end date is stated on the delivered handover'); continue; end if;
    insert into projects.tasks (organization_id, project_id, title, description, priority, due_on)
    values (v_org, p_project_id,
            case k when 'day_zero' then 'Day-0 check-in with the client after handover' when 'week_one' then 'Week-1 follow-up with the client after handover' else 'Warranty ends in 7 days: confirm open items and maintenance offer' end,
            'Scheduled from the completed handover. A person does this; nothing is sent automatically.', 'p2', v_due)
    returning id into v_task;
    insert into projects.p7d_follow_up_tasks (organization_id, project_id, kind, task_id, due_on) values (v_org, p_project_id, k, v_task, v_due);
    v_made := v_made + 1;
  end loop;
  if v_made > 0 then perform core.record_audit(v_org, 'handover.follow_ups_scheduled', 'project', p_project_id, null, jsonb_build_object('created', v_made)); end if;
  return query select case when v_made > 0 then 'scheduled' else 'nothing_to_schedule' end, v_made, v_skip;
end $$;
revoke all on function projects.schedule_handover_follow_ups(uuid) from public, anon;
grant execute on function projects.schedule_handover_follow_ups(uuid) to authenticated, service_role;

-- ── P7-ARC-06: linked future work, derived ─────────────────────────────────
create or replace function projects.p7_linked_future_work(p_project_id uuid)
returns table (kind text, ref_id uuid, summary text, route text, source text)
language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.phase_seven;
begin
  select * into v_p from projects.phase_seven s where s.project_id = p_project_id;
  if v_p.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and (v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  return query select 'handover_feedback'::text, f.id, left(f.body, 200), f.route, 'p7_handover_feedback'::text
    from projects.p7_handover_feedback f where f.project_id = p_project_id and f.status = 'open' and f.route in ('change_request', 'customer_success', 'support_bug');
  return query select 'known_limitation'::text, l.id, left(l.title, 200), null::text, 'p7_known_limitations'::text
    from projects.p7_known_limitations l where l.project_id = p_project_id;
  return query select 'code_change'::text, c.id, left(c.description, 200), null::text, 'p7_change_records'::text
    from projects.p7_change_records c where c.project_id = p_project_id and c.status = 'open';
end $$;
revoke all on function projects.p7_linked_future_work(uuid) from public, anon;
grant execute on function projects.p7_linked_future_work(uuid) to authenticated, service_role;

-- ── P7-PM-06: a deterministic suggestion, never a decision ─────────────────
create or replace function projects.p7_suggest_feedback_classification(p_body text)
returns table (classification text, route text, rule text, ambiguous boolean, alternatives text[])
language plpgsql immutable set search_path = '' as $$
declare
  v_t text := lower(coalesce(p_body, '')); v_hits text[] := '{}'; v_first text;
begin
  if length(btrim(v_t)) = 0 then return query select null::text, null::text, 'empty_text'::text, false, '{}'::text[]; return; end if;
  if v_t ~ '(password|log ?in|sign ?in|locked out|permission|cannot access|can''t access|no access|dns|domain)' then v_hits := array_append(v_hits, 'access_issue'::text); end if;
  if v_t ~ '(error|bug|broken|crash|not working|doesn''t work|does not work|fails|failed|blank page|500)' then v_hits := array_append(v_hits, 'production_defect'::text); end if;
  if v_t ~ '(handover|hand-over|document|guide|typo|wrong (name|date|url|link)|missing from the)' then v_hits := array_append(v_hits, 'handover_correction'::text); end if;
  if v_t ~ '(new feature|can you add|would like to add|we want a|please add|wish)' then v_hits := array_append(v_hits, 'new_feature'::text); end if;
  if v_t ~ '(instead of|replace the|different from what we agreed|change the scope|scope)' then v_hits := array_append(v_hits, 'scope_change'::text); end if;
  if v_t ~ '(how do i|how to|where can i|help me|question about)' then v_hits := array_append(v_hits, 'support_question'::text); end if;
  if v_t ~ '(what does|what is|explain|unclear|confused|clarify)' then v_hits := array_append(v_hits, 'clarification'::text); end if;
  if cardinality(v_hits) = 0 then return query select null::text, null::text, 'no_rule_matched'::text, false, '{}'::text[]; return; end if;
  v_first := v_hits[1];
  return query select v_first, projects.p7_feedback_route(v_first), 'keyword:' || v_first, cardinality(v_hits) > 1, v_hits[2:cardinality(v_hits)];
end $$;
grant execute on function projects.p7_suggest_feedback_classification(text) to authenticated, service_role;

-- ── P7-QA-06: a person records a production health snapshot, source named ──
create or replace function projects.record_production_health_snapshot(
  p_project_id uuid, p_status text, p_evidence_ref text, p_error_summary text default null, p_integrations_ok boolean default null, p_database_ok boolean default null,
  p_deployment_id uuid default null, p_commit_ref text default null)
returns table (outcome text, snapshot_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_status is null or p_status not in ('healthy', 'degraded', 'down', 'unknown') then return query select 'bad_status'::text, null::uuid; return; end if;
  if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then return query select 'evidence_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_evidence_ref) or projects.p7_has_secret(p_error_summary) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  if p_deployment_id is not null and not exists (select 1 from projects.p7_deployments d where d.id = p_deployment_id and d.project_id = p_project_id and d.organization_id = v_org) then return query select 'deployment_not_found'::text, null::uuid; return; end if;
  begin
    insert into projects.p7d_health_snapshots (organization_id, project_id, deployment_id, commit_ref, source, status, error_summary, integrations_ok, database_ok, evidence_ref, recorded_by)
    values (v_org, p_project_id, p_deployment_id, lower(nullif(btrim(p_commit_ref), '')), 'manual', p_status, nullif(btrim(p_error_summary), ''), p_integrations_ok, p_database_ok, btrim(p_evidence_ref), v_actor)
    returning id into v_id;
  exception when check_violation then return query select 'invalid'::text, null::uuid; return; end;
  perform core.record_audit(v_org, 'production.health_snapshot_recorded', 'project', p_project_id, null, jsonb_build_object('status', p_status, 'source', 'manual'));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_production_health_snapshot(uuid, text, text, text, boolean, boolean, uuid, text) from public, anon;
grant execute on function projects.record_production_health_snapshot(uuid, text, text, text, boolean, boolean, uuid, text) to authenticated;

create or replace function projects.p7_latest_health_snapshot(p_project_id uuid)
returns table (snapshot_id uuid, status text, source text, recorded_at timestamptz, age_minutes int, monitoring_source_configured boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.phase_seven;
begin
  select * into v_p from projects.phase_seven s where s.project_id = p_project_id;
  if v_p.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and (v_p.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false)) then return; end if;
  -- the last column is false by construction: no monitoring source exists in this system, so no snapshot is ever a monitor's reading
  return query select h.id, h.status, h.source, h.recorded_at, (extract(epoch from (clock_timestamp() - h.recorded_at)) / 60)::int, false
    from projects.p7d_health_snapshots h where h.project_id = p_project_id order by h.recorded_at desc, h.id desc limit 1;
end $$;
revoke all on function projects.p7_latest_health_snapshot(uuid) from public, anon;
grant execute on function projects.p7_latest_health_snapshot(uuid) to authenticated, service_role;
