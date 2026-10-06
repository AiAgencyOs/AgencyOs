-- PM5 spec section 15 (revision tracking): every revision round on a build lineage is recorded with its origin, its from/to build, the features it
-- touches and whether it spends the client's included allowance. Only a CLIENT-origin revision spends the allowance: an Admin edit, a QA
-- correction (the agency fixing its own work) and an approved Change Request (commercially separate) do not. Past the limit a person decides:
-- the round is not opened, an escalation record is, and the event the earlier phases use for the same situation tells the team.
--
-- Why a new escalation table instead of projects.orchestrator_escalations: that table's task_id is NOT NULL and its Phase 5 reader joins every row
-- to a task; a revision limit belongs to the project's build lineage, not a task. QA result and Admin re-approval are READ from the to-build's own
-- details by the timeline function, never copied, so a stored copy cannot go stale.

alter table projects.phase_five add column if not exists build_revision_limit integer not null default 3 check (build_revision_limit between 1 and 10);

create table if not exists projects.build_revisions (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  round_number         integer not null check (round_number >= 1),
  origin               text not null check (origin in ('client', 'admin', 'qa_correction', 'approved_change_request')),
  from_deliverable_id  uuid not null references projects.deliverables(id) on delete restrict,
  to_deliverable_id    uuid not null references projects.deliverables(id) on delete restrict,
  affected_feature_ids uuid[] not null default '{}',
  change_request_id    uuid references projects.change_requests(id) on delete restrict,
  consumes_allowance   boolean not null,
  reason               text not null check (length(btrim(reason)) between 1 and 1000),
  recorded_by          uuid references core.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  unique (project_id, round_number),
  unique (to_deliverable_id),
  constraint build_revisions_distinct_builds check (from_deliverable_id <> to_deliverable_id),
  -- the allowance rule is a row rule: only the client's own revision spends it
  constraint build_revisions_allowance_rule check (consumes_allowance = (origin = 'client')),
  constraint build_revisions_change_request_rule check ((origin = 'approved_change_request') = (change_request_id is not null))
);
alter table projects.build_revisions enable row level security;
drop policy if exists build_revisions_read on projects.build_revisions;
create policy build_revisions_read on projects.build_revisions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.build_revisions from public, anon;
revoke insert, update, delete on projects.build_revisions from authenticated;
grant select on projects.build_revisions to authenticated;
grant all on projects.build_revisions to service_role;
create trigger build_revisions_parent_org_project before insert or update of project_id on projects.build_revisions for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger build_revisions_parent_org_from before insert or update of from_deliverable_id on projects.build_revisions for each row execute function core.enforce_parent_org('from_deliverable_id', 'projects.deliverables');
create trigger build_revisions_parent_org_to before insert or update of to_deliverable_id on projects.build_revisions for each row execute function core.enforce_parent_org('to_deliverable_id', 'projects.deliverables');
create trigger build_revisions_parent_org_cr before insert or update of change_request_id on projects.build_revisions for each row execute function core.enforce_parent_org('change_request_id', 'projects.change_requests');
create trigger freeze_org_build_revisions before update of organization_id on projects.build_revisions for each row execute function core.freeze_organization_id();
create or replace function projects.build_revision_facts_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a revision round is part of the record: it is never rewritten or deleted' using errcode = 'restrict_violation'; end $$;
create trigger build_revisions_append_only before update or delete on projects.build_revisions for each row execute function projects.build_revision_facts_append_only();

create table if not exists projects.build_revision_escalations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  rounds_used      integer not null check (rounds_used >= 0),
  round_limit      integer not null check (round_limit >= 1),
  requested_reason text not null check (length(btrim(requested_reason)) between 1 and 1000),
  status           text not null default 'open' check (status in ('open', 'resolved')),
  decision         text check (decision in ('extra_rounds_granted', 'handled_as_change_request', 'declined')),
  extra_rounds     integer not null default 0 check (extra_rounds between 0 and 10),
  resolution_note  text,
  resolved_by      uuid references core.users(id) on delete set null,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now(),
  check ((status = 'open') = (decision is null and resolved_at is null)),
  check (status = 'open' or (resolution_note is not null and length(btrim(resolution_note)) > 0)),
  check ((decision = 'extra_rounds_granted') = (extra_rounds > 0))
);
create unique index if not exists build_revision_escalations_one_open on projects.build_revision_escalations (project_id) where status = 'open';
alter table projects.build_revision_escalations enable row level security;
drop policy if exists build_revision_escalations_read on projects.build_revision_escalations;
create policy build_revision_escalations_read on projects.build_revision_escalations for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.build_revision_escalations from public, anon;
revoke insert, update, delete on projects.build_revision_escalations from authenticated;
grant select on projects.build_revision_escalations to authenticated;
grant all on projects.build_revision_escalations to service_role;
create trigger build_revision_escalations_parent_org_project before insert or update of project_id on projects.build_revision_escalations for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger freeze_org_build_revision_escalations before update of organization_id on projects.build_revision_escalations for each row execute function core.freeze_organization_id();
create or replace function projects.build_revision_escalations_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a revision escalation is part of the record: it is resolved, never deleted' using errcode = 'restrict_violation'; end if;
  if old.status = 'resolved' then raise exception 'a resolved revision escalation is final' using errcode = 'restrict_violation'; end if;
  if (new.project_id, new.rounds_used, new.round_limit, new.requested_reason) is distinct from (old.project_id, old.rounds_used, old.round_limit, old.requested_reason) then
    raise exception 'what was escalated is not edited' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger build_revision_escalations_guard before update or delete on projects.build_revision_escalations for each row execute function projects.build_revision_escalations_guard();

-- the count, derived: consuming rounds on this project against the project's included limit (3 when the project has no Phase 5 row yet)
create or replace function projects.build_revision_allowance(p_project_id uuid)
returns table (rounds_used integer, round_limit integer, remaining integer, exceeded boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_used integer; v_limit integer;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return; end if;
  select count(*)::integer into v_used from projects.build_revisions r where r.project_id = p_project_id and r.organization_id = v_org and r.consumes_allowance;
  select coalesce((select pf.build_revision_limit from projects.phase_five pf where pf.project_id = p_project_id), 3) into v_limit;
  return query select v_used, v_limit, greatest(v_limit - v_used, 0), v_used >= v_limit;
end $$;
revoke all on function projects.build_revision_allowance(uuid) from public, anon;
grant execute on function projects.build_revision_allowance(uuid) to authenticated, service_role;

-- the door: records one revision round (the revised build already exists as a draft deliverable)
create or replace function projects.record_build_revision(p_project_id uuid, p_origin text, p_from_deliverable_id uuid, p_to_deliverable_id uuid, p_reason text,
  p_feature_ids uuid[] default '{}', p_change_request_id uuid default null)
returns table (outcome text, revision_id uuid, rounds_used integer, round_limit integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_from projects.deliverables; v_to projects.deliverables; v_existing uuid; v_new uuid; v_round integer; v_used integer; v_limit integer;
  v_feat uuid[] := coalesce(p_feature_ids, '{}'); v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_pf projects.phase_five; v_esc uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::integer, null::integer; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid, null::integer, null::integer; return; end if;
  if p_origin is null or p_origin not in ('client', 'admin', 'qa_correction', 'approved_change_request') then return query select 'bad_origin'::text, null::uuid, null::integer, null::integer; return; end if;
  if v_reason is null or length(v_reason) > 1000 then return query select 'reason_required'::text, null::uuid, null::integer, null::integer; return; end if;
  -- serialise rounds of one project: the count and the next round number are read under this lock
  perform 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org for update;
  if not found then return query select 'not_found'::text, null::uuid, null::integer, null::integer; return; end if;
  select * into v_from from projects.deliverables d where d.id = p_from_deliverable_id and d.organization_id = v_org and d.project_id = p_project_id and d.kind = 'build';
  select * into v_to from projects.deliverables d where d.id = p_to_deliverable_id and d.organization_id = v_org and d.project_id = p_project_id and d.kind = 'build';
  if v_from.id is null or v_to.id is null then return query select 'build_not_on_project'::text, null::uuid, null::integer, null::integer; return; end if;
  if v_to.version <= v_from.version then return query select 'not_a_later_build'::text, null::uuid, null::integer, null::integer; return; end if;
  select r.id into v_existing from projects.build_revisions r where r.to_deliverable_id = v_to.id;
  if v_existing is not null then return query select 'already_recorded'::text, v_existing, null::integer, null::integer; return; end if;
  if exists (select 1 from unnest(v_feat) f where not exists (select 1 from projects.features ft where ft.id = f and ft.project_id = p_project_id and ft.organization_id = v_org)) then
    return query select 'feature_not_on_project'::text, null::uuid, null::integer, null::integer; return;
  end if;
  if p_origin = 'approved_change_request' then
    if p_change_request_id is null or not exists (select 1 from projects.change_requests cr where cr.id = p_change_request_id and cr.project_id = p_project_id and cr.organization_id = v_org and cr.status in ('approved', 'implemented')) then
      return query select 'change_request_not_approved'::text, null::uuid, null::integer, null::integer; return;
    end if;
  elsif p_change_request_id is not null then
    return query select 'change_request_only_for_approved_change'::text, null::uuid, null::integer, null::integer; return;
  end if;

  select * into v_pf from projects.phase_five pf where pf.project_id = p_project_id;
  v_limit := coalesce(v_pf.build_revision_limit, 3);
  select count(*)::integer into v_used from projects.build_revisions r where r.project_id = p_project_id and r.consumes_allowance;

  if p_origin = 'client' then
    -- a decision is already waiting: no further client round until a person decides it
    if exists (select 1 from projects.build_revision_escalations e where e.project_id = p_project_id and e.status = 'open') then
      return query select 'escalated_awaiting_decision'::text, null::uuid, v_used, v_limit; return;
    end if;
    -- PASSING THE LIMIT IS A DECISION FOR A PERSON, NOT AN ERROR RETURN: the round is not opened, an escalation is
    if v_used >= v_limit then
      insert into projects.build_revision_escalations (organization_id, project_id, rounds_used, round_limit, requested_reason) values (v_org, p_project_id, v_used, v_limit, v_reason) returning id into v_esc;
      perform core.emit_event(v_org, 'project.revision_limit_escalated', 'phase_five', coalesce(v_pf.id, p_project_id),
        jsonb_build_object('projectId', p_project_id, 'revisionCount', v_used, 'revisionLimit', v_limit));
      perform core.record_audit(v_org, 'build.revision_limit_escalated', 'project', p_project_id, null, jsonb_build_object('escalationId', v_esc, 'roundsUsed', v_used, 'roundLimit', v_limit));
      return query select 'revision_limit_reached'::text, v_esc, v_used, v_limit; return;
    end if;
  end if;

  select coalesce(max(r.round_number), 0) + 1 into v_round from projects.build_revisions r where r.project_id = p_project_id;
  insert into projects.build_revisions (organization_id, project_id, round_number, origin, from_deliverable_id, to_deliverable_id, affected_feature_ids, change_request_id, consumes_allowance, reason, recorded_by)
  values (v_org, p_project_id, v_round, p_origin, v_from.id, v_to.id, v_feat, p_change_request_id, p_origin = 'client', v_reason, v_actor) returning id into v_new;
  perform core.record_audit(v_org, 'build.revision_recorded', 'project', p_project_id, null, jsonb_build_object('revisionId', v_new, 'round', v_round, 'origin', p_origin, 'consumesAllowance', p_origin = 'client'));
  return query select 'recorded'::text, v_new, v_used + case when p_origin = 'client' then 1 else 0 end, v_limit;
end $$;
revoke all on function projects.record_build_revision(uuid, text, uuid, uuid, text, uuid[], uuid) from public, anon;
grant execute on function projects.record_build_revision(uuid, text, uuid, uuid, text, uuid[], uuid) to authenticated;

-- Admin or owner decides an escalated limit: grant extra rounds (the limit rises), treat the work as a change request, or decline
create or replace function projects.resolve_build_revision_escalation(p_escalation_id uuid, p_decision text, p_note text, p_extra_rounds integer default 0)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_e projects.build_revision_escalations; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision is null or p_decision not in ('extra_rounds_granted', 'handled_as_change_request', 'declined') then return query select 'bad_decision'::text; return; end if;
  if v_note is null then return query select 'note_required'::text; return; end if;
  if (p_decision = 'extra_rounds_granted') <> (coalesce(p_extra_rounds, 0) > 0) or coalesce(p_extra_rounds, 0) > 10 then return query select 'extra_rounds_mismatch'::text; return; end if;
  select * into v_e from projects.build_revision_escalations e where e.id = p_escalation_id and e.organization_id = v_org for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_e.status = 'resolved' then return query select 'already_resolved'::text; return; end if;
  if p_decision = 'extra_rounds_granted' then
    update projects.phase_five set build_revision_limit = least(build_revision_limit + p_extra_rounds, 10) where project_id = v_e.project_id;
    if not found then return query select 'no_phase_five'::text; return; end if;
  end if;
  update projects.build_revision_escalations set status = 'resolved', decision = p_decision, extra_rounds = coalesce(p_extra_rounds, 0), resolution_note = v_note, resolved_by = v_actor, resolved_at = now() where id = v_e.id;
  perform core.record_audit(v_org, 'build.revision_escalation_resolved', 'project', v_e.project_id, null, jsonb_build_object('escalationId', v_e.id, 'decision', p_decision, 'extraRounds', coalesce(p_extra_rounds, 0)));
  return query select 'resolved'::text;
end $$;
revoke all on function projects.resolve_build_revision_escalation(uuid, text, text, integer) from public, anon;
grant execute on function projects.resolve_build_revision_escalation(uuid, text, text, integer) to authenticated;

-- the Admin's revision timeline: from/to build, origin, allowance impact, and the to-build's QA and Admin states as they stand NOW
create or replace function projects.build_revision_timeline(p_project_id uuid)
returns table (revision_id uuid, round_number integer, origin text, from_version integer, to_version integer, affected_feature_ids uuid[], consumes_allowance boolean, qa_status text, admin_status text, reason text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
    select r.id, r.round_number, r.origin, f.version, t.version, r.affected_feature_ids, r.consumes_allowance, dd.qa_status, dd.admin_status, r.reason, r.created_at
      from projects.build_revisions r
      join projects.deliverables f on f.id = r.from_deliverable_id
      join projects.deliverables t on t.id = r.to_deliverable_id
      left join projects.deliverable_details dd on dd.deliverable_id = r.to_deliverable_id
     where r.project_id = p_project_id and r.organization_id = v_org
     order by r.round_number;
end $$;
revoke all on function projects.build_revision_timeline(uuid) from public, anon;
grant execute on function projects.build_revision_timeline(uuid) to authenticated, service_role;
notify pgrst, 'reload schema';
