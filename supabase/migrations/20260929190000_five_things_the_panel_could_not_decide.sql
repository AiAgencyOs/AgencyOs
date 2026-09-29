-- ═══════════════════════════════════════════════════════════════════════════
-- Five things the panel could not decide.
--
-- Five element-level gaps from docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, bucket
-- C-1 — screens the Admin Panel PDF draws with a control the schema could
-- not honestly back, or refused outright.
--
--   SCR-027 Default assignee, phase notifications
--       `projects.projects` had no default-assignee column, so a task created
--       with nobody named stayed unowned; and nothing recorded who wants to
--       hear when a project's phase moves, so the Action Center could not
--       tell them.
--   SCR-030 Unfreeze override
--       `refuse_frozen_scope_edit` lets a frozen scope version become only
--       `superseded` (Doc 11 §29). The PDF draws an "unfreeze" the owner
--       reaches for when a baseline was frozen by mistake and no change
--       request has yet argued with it. RULE RELAXED HERE, and exactly this
--       far: `active → draft` is allowed ONLY inside
--       `projects.unfreeze_scope_version`, which is owner-only, requires a
--       reason, refuses when any later version exists, and writes
--       audit.audit_log. Every other path stays refused.
--   SCR-043 Mark dependency supplied
--       `projects.dependencies` (the technical register, 20260922140000) had
--       no status, so "waiting on X" could be written and never closed. The
--       PLAN's register (`plan_dependencies`) keeps its refusal once the plan
--       is active — that is the plan's own rule and the page says so.
--   SCR-044 Block release
--       Production sign-off had two conditions and no way for the people who
--       hold `project.sign_off` to say "not this one, not yet" for a reason
--       the gate does not measure (a client freeze, a legal hold). A release
--       hold is a HARD gate: `mark_production_ready` refuses while one is on,
--       quoting the reason.
--   SCR-047 Linked task on a defect
--       `qa.defects` could name a deliverable and a person, never the task
--       whose work it is about.
--
-- Rules held here rather than by convention:
--   · a watcher row is written by the person it names, or by owner/ops_admin
--     for anyone — the same two roles that manage the roster.
--   · unfreezing is owner-only: it is the one move that makes a baseline stop
--     being one, and the roles that may freeze (`milestone.write`) are wider
--     than the one that should be able to take it back.
--   · holding and lifting a release are `project.sign_off` (owner, ops_admin,
--     via core.is_admin()) — the role the production-ready door already uses,
--     because a hold is that decision's own "no".
--   · every governed write here lands in audit.audit_log from inside the
--     transaction, like every door before it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── SCR-027 · a default assignee, and who watches a project ──────────────

alter table projects.projects
  add column if not exists default_assignee_id uuid references core.users(id) on delete set null;

comment on column projects.projects.default_assignee_id is
  'Who a task on this project goes to when it is created with nobody named (SCR-027). Set on /projects/[id]/settings; read by createTask. Null means the task stays unassigned, as before.';

create table if not exists projects.project_watchers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,

  -- Which changes this person wants in their Action Center. An empty array
  -- is a watcher who hears about nothing — allowed, because "watch" and
  -- "unwatch" are the two doors and a row with no phases is what an owner
  -- who cleared every box has asked for.
  phases           text[] not null default array['status', 'phase_two', 'phase_three', 'phase_four'],

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint project_watchers_one_per_person unique (project_id, user_id),
  constraint project_watchers_known_phases check (
    phases <@ array['status', 'phase_two', 'phase_three', 'phase_four']::text[]
  )
);

comment on table projects.project_watchers is
  'Who wants to hear when a project moves phase (SCR-027). One row per person per project; `phases` names which state rows they follow — the project status, or the Phase 2/3/4 workspaces. Read by the Action Center, never by the runner.';

create index if not exists project_watchers_project_idx
  on projects.project_watchers (organization_id, project_id);
create index if not exists project_watchers_user_idx
  on projects.project_watchers (organization_id, user_id);

drop trigger if exists set_updated_at on projects.project_watchers;
create trigger set_updated_at
  before update on projects.project_watchers
  for each row execute function core.set_updated_at();

alter table projects.project_watchers enable row level security;
alter table projects.project_watchers force row level security;

drop policy if exists project_watchers_select on projects.project_watchers;
create policy project_watchers_select on projects.project_watchers
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Anyone internal may watch or unwatch for themselves; owner and ops_admin
-- may add or remove anyone.
drop policy if exists project_watchers_write on projects.project_watchers;
create policy project_watchers_write on projects.project_watchers
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
    and (user_id = (select auth.uid()) or (select core.is_admin()))
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
    and (user_id = (select auth.uid()) or (select core.is_admin()))
  );

grant select, insert, update, delete on projects.project_watchers to authenticated, service_role;

drop trigger if exists org_match_project_watchers_project on projects.project_watchers;
create trigger org_match_project_watchers_project
  before insert or update of project_id, organization_id on projects.project_watchers
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_project_watchers on projects.project_watchers;
create trigger freeze_org_project_watchers
  before update of organization_id on projects.project_watchers
  for each row execute function core.freeze_organization_id();

-- ── SCR-030 · an owner may unfreeze, through one door, for a reason ──────

-- The trigger: `active → draft` is allowed only while the transaction-local
-- setting `projects.unfreeze_version` names this row, which only
-- `projects.unfreeze_scope_version` sets. Everything else is as before.
create or replace function projects.refuse_frozen_scope_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_unfreezing boolean := false;
begin
  v_unfreezing := coalesce(current_setting('projects.unfreeze_version', true), '') = old.id::text;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'a frozen scope version is history and cannot be deleted (Doc 11 §29)'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status <> 'draft' then
    if new.status is distinct from old.status
       and not (old.status = 'active' and new.status = 'superseded')
       and not (old.status = 'active' and new.status = 'draft' and v_unfreezing) then
      raise exception 'a frozen scope version may only be superseded (Doc 11 §29); an owner may unfreeze it through projects.unfreeze_scope_version'
        using errcode = 'check_violation';
    end if;

    if new.version              is distinct from old.version
       or new.project_id        is distinct from old.project_id
       or (new.frozen_at        is distinct from old.frozen_at and not v_unfreezing)
       or new.source            is distinct from old.source
       or new.change_request_id is distinct from old.change_request_id
       or new.requirement_version_id is distinct from old.requirement_version_id then
      raise exception 'a frozen scope version is immutable (Doc 11 §29); create a new version instead'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function projects.refuse_frozen_scope_edit() is
  'A frozen scope version may only be superseded, never edited or deleted (Doc 11 §29) — with one owner-only exception: projects.unfreeze_scope_version may move active back to draft, and marks the transaction so this trigger lets exactly that row through.';

create or replace function projects.unfreeze_scope_version(
  p_version_id uuid,
  p_reason     text
)
returns table (
  -- 'unfrozen'
  -- refusals: 'no_actor' | 'not_authorized' | 'bad_reason' | 'not_found' |
  --           'not_frozen' | 'later_version_exists'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_project uuid;
  v_version int;
  v_status  text;
  v_before  jsonb;
  v_after   jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  -- Owner only. Freezing is milestone.write; taking a baseline back is the
  -- one move that makes it stop being one, and that is the owner's.
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_reason is null or length(trim(p_reason)) < 10 then
    return query select 'bad_reason'::text; return;
  end if;

  select sv.organization_id, sv.project_id, sv.version, sv.status, to_jsonb(sv)
    into v_org, v_project, v_version, v_status, v_before
    from projects.scope_versions sv
   where sv.id = p_version_id
     and sv.organization_id = (select core.current_organization_id())
     for update;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  if v_status <> 'active' then
    return query select 'not_frozen'::text; return;
  end if;

  -- A later version — a draft opened from a change request, or a baseline
  -- that already superseded this one — means this row is history, and
  -- history is not unfrozen.
  if exists (
    select 1 from projects.scope_versions later
     where later.project_id = v_project and later.version > v_version
  ) then
    return query select 'later_version_exists'::text; return;
  end if;

  -- Mark the transaction for the trigger. Local to this transaction, so no
  -- other statement inherits the permission.
  perform set_config('projects.unfreeze_version', p_version_id::text, true);

  update projects.scope_versions
     set status = 'draft', frozen_at = null
   where id = p_version_id
  returning to_jsonb(projects.scope_versions.*) into v_after;

  perform set_config('projects.unfreeze_version', '', true);

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org, 'user', v_actor, 'scope_version.unfrozen', 'scope_version', p_version_id,
    v_before, v_after || jsonb_build_object('reason', trim(p_reason))
  );

  return query select 'unfrozen'::text;
end;
$$;

comment on function projects.unfreeze_scope_version(uuid, text) is
  'Moves an active scope baseline back to draft (SCR-030). Owner only (core.is_owner()), a reason of at least ten characters, refused when any later version exists. The only path refuse_frozen_scope_edit admits for active → draft. Writes audit.audit_log with the reason in the same transaction.';

revoke all on function projects.unfreeze_scope_version(uuid, text) from public, anon;
grant execute on function projects.unfreeze_scope_version(uuid, text) to authenticated;

-- ── SCR-043 · a technical dependency can be supplied or waived ───────────

alter table projects.dependencies
  add column if not exists status      text not null default 'open',
  add column if not exists supplied_at timestamptz,
  add column if not exists supplied_by uuid references core.users(id) on delete set null,
  add column if not exists note        text;

alter table projects.dependencies drop constraint if exists dependencies_status_check;
alter table projects.dependencies
  add constraint dependencies_status_check check (status in ('open', 'supplied', 'waived'));

alter table projects.dependencies drop constraint if exists dependencies_settled_is_dated;
alter table projects.dependencies
  add constraint dependencies_settled_is_dated check (
    (status = 'open' and supplied_at is null)
    or (status in ('supplied', 'waived') and supplied_at is not null)
  );

comment on column projects.dependencies.status is
  'open until somebody marks it supplied (it arrived) or waived (not needed after all) through projects.set_dependency_status (SCR-043). The PLAN''s register, plan_dependencies, is a different thing and keeps its own rule.';

create index if not exists dependencies_open_idx
  on projects.dependencies (organization_id, project_id) where status = 'open';

create or replace function projects.set_dependency_status(
  p_dependency_id uuid,
  p_status        text,
  p_note          text default null
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'bad_status' | 'not_found' | 'unchanged'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_status text;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  -- project.write's roles — the same gate the technical register's own
  -- add/remove doors use in the service layer.
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_status not in ('open', 'supplied', 'waived') then
    return query select 'bad_status'::text; return;
  end if;

  select d.organization_id, d.status, to_jsonb(d)
    into v_org, v_status, v_before
    from projects.dependencies d
   where d.id = p_dependency_id
     and d.organization_id = (select core.current_organization_id())
     for update;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  if v_status = p_status then
    return query select 'unchanged'::text; return;
  end if;

  update projects.dependencies
     set status      = p_status,
         supplied_at = case when p_status = 'open' then null else now() end,
         supplied_by = case when p_status = 'open' then null else v_actor end,
         note        = nullif(trim(coalesce(p_note, '')), '')
   where id = p_dependency_id
  returning to_jsonb(projects.dependencies.*) into v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (v_org, 'user', v_actor, 'dependency.' || p_status, 'dependency', p_dependency_id, v_before, v_after);

  return query select 'set'::text;
end;
$$;

comment on function projects.set_dependency_status(uuid, text, text) is
  'Marks a technical dependency open, supplied or waived (SCR-043), with an optional note. can_manage_delivery() only. Refuses unchanged so a repeat click writes no audit row. Writes audit.audit_log in the same transaction.';

revoke all on function projects.set_dependency_status(uuid, text, text) from public, anon;
grant execute on function projects.set_dependency_status(uuid, text, text) to authenticated;

-- ── SCR-044 · a release can be held, and the sign-off door honours it ─────

alter table projects.projects
  add column if not exists release_hold_reason text,
  add column if not exists release_held_at     timestamptz,
  add column if not exists release_held_by     uuid references core.users(id) on delete set null;

alter table projects.projects drop constraint if exists projects_release_hold_shape;
alter table projects.projects
  add constraint projects_release_hold_shape check (
    (release_hold_reason is null and release_held_at is null)
    or (release_hold_reason is not null and length(trim(release_hold_reason)) > 0 and release_held_at is not null)
  );

comment on column projects.projects.release_hold_reason is
  'Why production sign-off is refused right now, in the words of the owner or ops_admin who held it (SCR-044). Null means no hold. Set and cleared only through projects.hold_release / projects.lift_release_hold; mark_production_ready answers held while it is set.';

create or replace function projects.hold_release(
  p_project_id uuid,
  p_reason     text
)
returns table (
  -- 'held'
  -- refusals: 'no_actor' | 'not_authorized' | 'bad_reason' | 'not_found' | 'already_held'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_reason text;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  -- project.sign_off's roles (owner, ops_admin): a hold is that decision's "no".
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_reason is null or length(trim(p_reason)) < 10 then
    return query select 'bad_reason'::text; return;
  end if;

  select p.organization_id, p.release_hold_reason, to_jsonb(p)
    into v_org, v_reason, v_before
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = (select core.current_organization_id())
     and p.deleted_at is null
     for update;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  if v_reason is not null then
    return query select 'already_held'::text; return;
  end if;

  update projects.projects
     set release_hold_reason = trim(p_reason),
         release_held_at     = now(),
         release_held_by     = v_actor,
         updated_at          = now()
   where id = p_project_id
  returning to_jsonb(projects.projects.*) into v_after;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (v_org, 'user', v_actor, 'release.held', 'project', p_project_id, v_before, v_after);

  return query select 'held'::text;
end;
$$;

comment on function projects.hold_release(uuid, text) is
  'Puts a release hold on a project (SCR-044): mark_production_ready refuses while it stands. is_admin() (owner, ops_admin) — the roles holding project.sign_off. A reason of at least ten characters. Writes audit.audit_log in the same transaction.';

revoke all on function projects.hold_release(uuid, text) from public, anon;
grant execute on function projects.hold_release(uuid, text) to authenticated;

create or replace function projects.lift_release_hold(
  p_project_id uuid,
  p_reason     text
)
returns table (
  -- 'lifted'
  -- refusals: 'no_actor' | 'not_authorized' | 'bad_reason' | 'not_found' | 'not_held'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_reason text;
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  if p_reason is null or length(trim(p_reason)) < 10 then
    return query select 'bad_reason'::text; return;
  end if;

  select p.organization_id, p.release_hold_reason, to_jsonb(p)
    into v_org, v_reason, v_before
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = (select core.current_organization_id())
     and p.deleted_at is null
     for update;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  if v_reason is null then
    return query select 'not_held'::text; return;
  end if;

  update projects.projects
     set release_hold_reason = null,
         release_held_at     = null,
         release_held_by     = null,
         updated_at          = now()
   where id = p_project_id
  returning to_jsonb(projects.projects.*) into v_after;

  -- The lifting reason has no column: the hold is gone, and the audit row is
  -- where "why it was lifted" lives, beside the hold it ends.
  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org, 'user', v_actor, 'release.hold_lifted', 'project', p_project_id,
    v_before, v_after || jsonb_build_object('lift_reason', trim(p_reason))
  );

  return query select 'lifted'::text;
end;
$$;

comment on function projects.lift_release_hold(uuid, text) is
  'Lifts a release hold (SCR-044). is_admin() (owner, ops_admin), a reason of at least ten characters, kept in audit.audit_log since the hold columns are cleared. Refuses not_held.';

revoke all on function projects.lift_release_hold(uuid, text) from public, anon;
grant execute on function projects.lift_release_hold(uuid, text) to authenticated;

-- mark_production_ready gains one refusal, ahead of ADM-19's three: a
-- standing release hold answers 'held' with the reason as the single unmet
-- line. Otherwise identical to 20260815210000.
create or replace function projects.mark_production_ready(p_project_id uuid)
returns table (
  -- 'ready' | 'already_ready' | 'not_found' | 'not_ready' | 'held'
  outcome text,
  unmet   text[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ready_at    timestamptz;
  v_hold_reason text;
  v_state       record;
  v_unmet       text[] := '{}';
begin
  if core.current_organization_id() is not null
     and core.current_user_role() not in ('owner', 'ops_admin') then
    return query select 'not_found'::text, '{}'::text[];
    return;
  end if;

  select p.production_ready_at, p.release_hold_reason
    into v_ready_at, v_hold_reason
    from projects.projects p
   where p.id = p_project_id
     for update;

  if not found then
    return query select 'not_found'::text, '{}'::text[];
    return;
  end if;

  if v_ready_at is not null then
    return query select 'already_ready'::text, '{}'::text[];
    return;
  end if;

  -- SCR-044: a hold is a hard gate, decided by a person, checked before the
  -- three the database measures.
  if v_hold_reason is not null then
    return query select 'held'::text, array[v_hold_reason];
    return;
  end if;

  select * into v_state from projects.production_readiness(p_project_id);

  if not v_state.no_open_blockers then
    v_unmet := v_unmet || 'open_blockers'::text;
  end if;
  if not v_state.no_open_majors then
    v_unmet := v_unmet || 'open_majors'::text;
  end if;
  if not v_state.build_approved then
    v_unmet := v_unmet || 'no_approved_build'::text;
  end if;

  if array_length(v_unmet, 1) is not null then
    return query select 'not_ready'::text, v_unmet;
    return;
  end if;

  update projects.projects
     set production_ready_at = now(),
         updated_at          = now()
   where id = p_project_id;

  -- The audit row is written by the G-093 trigger, from inside this
  -- transaction, and records the whole row.

  return query select 'ready'::text, '{}'::text[];
end;
$$;

comment on function projects.mark_production_ready(uuid) is
  'Marks a project production ready when ADM-19''s conditions hold (no open blockers or majors, an approved build) and no release hold stands (SCR-044: answers held with the reason). No other override. Caller-scoped: a session caller must hold project.sign_off (owner or ops_admin); the service role is unrestricted. Answers not_found to a caller who may not sign off, so nothing leaks.';

revoke all on function projects.mark_production_ready(uuid) from public, anon;
grant execute on function projects.mark_production_ready(uuid) to authenticated, service_role;

-- ── SCR-047 · a defect may name the task it is about ─────────────────────

alter table qa.defects
  add column if not exists task_id uuid references projects.tasks(id) on delete set null;

comment on column qa.defects.task_id is
  'The task whose work this defect is about (SCR-047), set at triage. Same project as the defect — the service checks; the FK alone would accept any task in the organization. Null means nobody linked one.';

create index if not exists defects_task_idx
  on qa.defects (organization_id, task_id) where task_id is not null;

drop trigger if exists org_match_defects_task_id on qa.defects;
create trigger org_match_defects_task_id
  before insert or update of task_id, organization_id on qa.defects
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');
