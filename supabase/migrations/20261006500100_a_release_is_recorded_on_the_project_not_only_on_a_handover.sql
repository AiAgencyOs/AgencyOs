-- A release is recorded on the project, not only on a handover — theme W5,
-- SCR-049 (Production Readiness & Release Candidate).
--
-- The rendered audit (docs/pdf-gap/C.md) found "Deployment dependencies",
-- "Rollback plan" and "Post-deploy smoke checklist" all PARTIAL for the same
-- reason: each was stored on projects.handovers, and a handover is created by
-- the hand-off workflow, late. Until it exists the Release tab said "No
-- handover has been prepared, so there is nowhere to record them yet" — a
-- release manager could not write the rollback plan BEFORE the release, which
-- is when it is needed.
--
--   1. projects.release_records — one row per project holding the rollback
--      plan, the smoke checklist and the deployment dependencies. Backfilled
--      from each project's newest handover so nothing already recorded is lost.
--      The three handover columns and their doors stay where they are; the
--      Release tab reads and writes this row.
--   2. projects.release_verifications — the dated "post-deploy verification"
--      record (SCR-049 action "Record post-deploy verification"): who, when,
--      against which build and environment, with the outcome and evidence.
--      Appended, never edited.
--   3. Four security-definer doors (can_manage_delivery(), audited):
--      set_release_rollback_plan, set_release_smoke_item,
--      set_release_dependency, record_release_verification.
--
-- Reports beside the gate: projects.mark_production_ready reads none of these.
-- No table here is directly writable by authenticated.

create table if not exists projects.release_records (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references core.organizations(id) on delete cascade,
  project_id              uuid not null references projects.projects(id) on delete cascade,
  rollback_plan           text check (rollback_plan is null or length(btrim(rollback_plan)) between 1 and 8000),
  smoke_checklist         jsonb not null default '[]'::jsonb,
  deployment_dependencies jsonb not null default '[]'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (project_id),
  constraint release_records_smoke_is_a_list check (jsonb_typeof(smoke_checklist) = 'array'),
  constraint release_records_dependencies_is_a_list check (jsonb_typeof(deployment_dependencies) = 'array')
);

comment on table projects.release_records is
  'SCR-049: the release candidate''s rollback plan, smoke checklist ([{label, done_at}]) and deployment dependencies ([{label, status, updated_at}]), one row per project, recorded before there is any handover. Reports beside the gate: mark_production_ready does not read it. Written only through the set_release_* doors.';

drop trigger if exists set_updated_at on projects.release_records;
create trigger set_updated_at before update on projects.release_records
  for each row execute function core.set_updated_at();

alter table projects.release_records enable row level security;
alter table projects.release_records force row level security;

drop policy if exists release_records_select on projects.release_records;
create policy release_records_select on projects.release_records
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists org_match_release_records_project on projects.release_records;
create trigger org_match_release_records_project
  before insert or update of project_id, organization_id on projects.release_records
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_release_records on projects.release_records;
create trigger freeze_org_release_records
  before update of organization_id on projects.release_records
  for each row execute function core.freeze_organization_id();

grant select on projects.release_records to authenticated, service_role;

-- What a handover already held becomes the project's record (once).
insert into projects.release_records (organization_id, project_id, rollback_plan, smoke_checklist, deployment_dependencies)
select distinct on (h.project_id)
       h.organization_id, h.project_id,
       nullif(btrim(coalesce(h.rollback_plan, '')), ''),
       coalesce(h.smoke_checklist, '[]'::jsonb),
       coalesce(h.deployment_dependencies, '[]'::jsonb)
  from projects.handovers h
 where h.rollback_plan is not null
    or jsonb_array_length(coalesce(h.smoke_checklist, '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(h.deployment_dependencies, '[]'::jsonb)) > 0
 order by h.project_id, h.created_at desc
on conflict (project_id) do nothing;

-- ── the verification record ────────────────────────────────────────────────

create table if not exists projects.release_verifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  deliverable_id  uuid references projects.deliverables(id) on delete set null,
  environment     text not null check (environment in ('staging', 'production', 'other')),
  outcome         text not null check (outcome in ('passed', 'partial', 'failed')),
  notes           text check (notes is null or length(btrim(notes)) between 1 and 2000),
  evidence_url    text check (evidence_url is null or evidence_url ~* '^https?://[^[:space:]]+$'),
  verified_by     uuid references core.users(id) on delete set null,
  verified_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

comment on table projects.release_verifications is
  'SCR-049 "Record post-deploy verification": a dated statement that somebody checked the deployed release — the build, the environment, passed / partial / failed, notes and a link. Appended, never edited; the newest row is the current word.';

create index if not exists release_verifications_project_idx
  on projects.release_verifications (organization_id, project_id, verified_at desc);

alter table projects.release_verifications enable row level security;
alter table projects.release_verifications force row level security;

drop policy if exists release_verifications_select on projects.release_verifications;
create policy release_verifications_select on projects.release_verifications
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists org_match_release_verifications_project on projects.release_verifications;
create trigger org_match_release_verifications_project
  before insert or update of project_id, organization_id on projects.release_verifications
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_release_verifications_deliverable on projects.release_verifications;
create trigger org_match_release_verifications_deliverable
  before insert or update of deliverable_id, organization_id on projects.release_verifications
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');

drop trigger if exists freeze_org_release_verifications on projects.release_verifications;
create trigger freeze_org_release_verifications
  before update of organization_id on projects.release_verifications
  for each row execute function core.freeze_organization_id();

grant select on projects.release_verifications to authenticated, service_role;

-- ── the doors ─────────────────────────────────────────────────────────────

create or replace function projects.set_release_rollback_plan(p_project_id uuid, p_rollback_plan text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_plan   text := nullif(btrim(coalesce(p_rollback_plan, '')), '');
  v_before text;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if v_plan is not null and length(v_plan) > 8000 then
    return query select 'bad_plan'::text; return;
  end if;

  select p.organization_id into v_org from projects.projects p
   where p.id = p_project_id and p.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  select r.rollback_plan into v_before from projects.release_records r where r.project_id = p_project_id;

  insert into projects.release_records (organization_id, project_id, rollback_plan)
  values (v_org, p_project_id, v_plan)
  on conflict (project_id) do update set rollback_plan = excluded.rollback_plan;

  perform core.record_audit(v_org, 'release.rollback_plan_set', 'project', p_project_id,
    jsonb_build_object('rollback_plan', v_before), jsonb_build_object('rollback_plan', v_plan));

  return query select 'set'::text;
end;
$$;

comment on function projects.set_release_rollback_plan(uuid, text) is
  'SCR-049: writes (or, blank, clears) the project''s rollback plan on its release record, creating the record if there is none. No handover needed. can_manage_delivery(). Audits release.rollback_plan_set.';

revoke all on function projects.set_release_rollback_plan(uuid, text) from public, anon;
grant execute on function projects.set_release_rollback_plan(uuid, text) to authenticated, service_role;

create or replace function projects.set_release_smoke_item(
  p_project_id uuid,
  p_label      text,
  p_done       boolean,
  p_remove     boolean default false
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_label  text := btrim(coalesce(p_label, ''));
  v_list   jsonb;
  v_next   jsonb := '[]'::jsonb;
  v_item   jsonb;
  v_seen   boolean := false;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if length(v_label) = 0 or length(v_label) > 200 then
    return query select 'bad_label'::text; return;
  end if;

  select p.organization_id into v_org from projects.projects p
   where p.id = p_project_id and p.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  insert into projects.release_records (organization_id, project_id)
  values (v_org, p_project_id)
  on conflict (project_id) do nothing;

  select r.smoke_checklist into v_list from projects.release_records r where r.project_id = p_project_id for update;

  for v_item in select * from jsonb_array_elements(coalesce(v_list, '[]'::jsonb)) loop
    if v_item->>'label' = v_label then
      v_seen := true;
      if p_remove then
        continue;
      end if;
      -- A tick already made keeps its moment; an untick clears it.
      v_next := v_next || jsonb_build_object(
        'label', v_label,
        'done_at', case
                     when not p_done then null
                     when v_item->>'done_at' is not null then v_item->'done_at'
                     else to_jsonb(now())
                   end
      );
    else
      v_next := v_next || v_item;
    end if;
  end loop;

  if not v_seen and not p_remove then
    v_next := v_next || jsonb_build_object('label', v_label, 'done_at', case when p_done then to_jsonb(now()) else null end);
  end if;

  update projects.release_records set smoke_checklist = v_next where project_id = p_project_id;

  perform core.record_audit(v_org,
    case when p_remove then 'release.smoke_item_removed' else 'release.smoke_item_set' end,
    'project', p_project_id,
    jsonb_build_object('smoke_checklist', v_list), jsonb_build_object('smoke_checklist', v_next));

  return query select (case when p_remove then 'removed' else 'set' end)::text;
end;
$$;

comment on function projects.set_release_smoke_item(uuid, text, boolean, boolean) is
  'SCR-049: adds, ticks, unticks or removes one post-deploy smoke check on the project''s release record. The label is the key; a tick already made keeps its done_at. can_manage_delivery(). Audited. A report, not a gate.';

revoke all on function projects.set_release_smoke_item(uuid, text, boolean, boolean) from public, anon;
grant execute on function projects.set_release_smoke_item(uuid, text, boolean, boolean) to authenticated, service_role;

create or replace function projects.set_release_dependency(
  p_project_id uuid,
  p_label      text,
  p_status     text default 'pending',
  p_remove     boolean default false
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_label text := btrim(coalesce(p_label, ''));
  v_list  jsonb;
  v_next  jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if length(v_label) < 1 or length(v_label) > 200 then
    return query select 'bad_label'::text; return;
  end if;
  if p_status not in ('pending', 'ready') then
    return query select 'bad_status'::text; return;
  end if;

  select p.organization_id into v_org from projects.projects p
   where p.id = p_project_id and p.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  insert into projects.release_records (organization_id, project_id)
  values (v_org, p_project_id)
  on conflict (project_id) do nothing;

  select r.deployment_dependencies into v_list from projects.release_records r where r.project_id = p_project_id for update;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_next
    from jsonb_array_elements(v_list) e
   where e->>'label' <> v_label;
  if not p_remove then
    v_next := v_next || jsonb_build_array(jsonb_build_object('label', v_label, 'status', p_status, 'updated_at', now()));
  end if;

  update projects.release_records set deployment_dependencies = v_next where project_id = p_project_id;

  perform core.record_audit(v_org, 'release.dependency_set', 'project', p_project_id,
    jsonb_build_object('dependencies', v_list), jsonb_build_object('dependencies', v_next));

  return query select (case when p_remove then 'removed' else 'set' end)::text;
end;
$$;

comment on function projects.set_release_dependency(uuid, text, text, boolean) is
  'SCR-049: adds, updates or removes one deployment dependency (DNS, a vendor key, a client sign-off) on the project''s release record. can_manage_delivery(). Audits release.dependency_set.';

revoke all on function projects.set_release_dependency(uuid, text, text, boolean) from public, anon;
grant execute on function projects.set_release_dependency(uuid, text, text, boolean) to authenticated, service_role;

create or replace function projects.record_release_verification(
  p_project_id     uuid,
  p_environment    text,
  p_outcome        text,
  p_deliverable_id uuid default null,
  p_notes          text default null,
  p_evidence_url   text default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_url   text := nullif(btrim(coalesce(p_evidence_url, '')), '');
  v_new   uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if p_environment not in ('staging', 'production', 'other') then
    return query select 'bad_environment'::text, null::uuid; return;
  end if;
  if p_outcome not in ('passed', 'partial', 'failed') then
    return query select 'bad_outcome'::text, null::uuid; return;
  end if;
  if v_notes is not null and length(v_notes) > 2000 then
    return query select 'bad_notes'::text, null::uuid; return;
  end if;
  if v_url is not null and v_url !~* '^https?://[^[:space:]]+$' then
    return query select 'bad_url'::text, null::uuid; return;
  end if;
  -- A failed or partial verification that says nothing is a rumour.
  if p_outcome <> 'passed' and v_notes is null then
    return query select 'notes_required'::text, null::uuid; return;
  end if;

  select p.organization_id into v_org from projects.projects p
   where p.id = p_project_id and p.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  if p_deliverable_id is not null and not exists (
    select 1 from projects.deliverables d
     where d.id = p_deliverable_id and d.project_id = p_project_id and d.organization_id = v_org
  ) then
    return query select 'build_not_on_project'::text, null::uuid; return;
  end if;

  insert into projects.release_verifications (organization_id, project_id, deliverable_id, environment, outcome, notes, evidence_url, verified_by)
  values (v_org, p_project_id, p_deliverable_id, p_environment, p_outcome, v_notes, v_url, v_actor)
  returning projects.release_verifications.id into v_new;

  perform core.record_audit(v_org, 'release.verification_recorded', 'project', p_project_id, null,
    jsonb_build_object('verification_id', v_new, 'environment', p_environment, 'outcome', p_outcome));

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function projects.record_release_verification(uuid, text, text, uuid, text, text) is
  'SCR-049 "Record post-deploy verification": appends a dated verification of the deployed release — environment, passed / partial / failed, optionally the build, notes (required unless passed) and a link. can_manage_delivery(). Audits release.verification_recorded.';

revoke all on function projects.record_release_verification(uuid, text, text, uuid, text, text) from public, anon;
grant execute on function projects.record_release_verification(uuid, text, text, uuid, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
