-- ═══════════════════════════════════════════════════════════════════════════
-- Round 3c, stream T1 (owner decisions S2-1, S2-2, S2-3):
--
--  S2-1  Task attachments (titled links on a task) are bound by the project role
--        like comments, time logs and checklist items: an observer changes none,
--        a contributor only on a task assigned to them; the roster managers
--        (role union) are exempt. Same trigger function as the other task
--        children, so the refusal text is identical. System writers are not bound.
--
--  S2-2  The project roster and default-assignee doors use the role UNION
--        (projects.is_roster_manager: owner, ops_admin, delivery_lead as a primary
--        or secondary role) instead of the primary-role-only
--        core.can_manage_delivery():
--          - projects.set_project_default_assignee (per-role defaults);
--          - the project_members write policy (the roster itself);
--          - projects.set_project_fallback_assignee, a NEW audited door for the
--            project's one default assignee (projects.default_assignee_id), which
--            was written through the projects_write policy (primary role only).
--
--  S2-3  Start Task: a dependency on a task that is done, cancelled or archived
--        is satisfied. projects.tasks has today only the statuses todo,
--        in_progress, blocked, in_review, done and NO archived column, so the
--        check reads status and, defensively, an `archived_at` / `cancelled_at`
--        value if a later migration adds one (via to_jsonb, so it does not fail
--        where the column is absent). A dependency across projects stays refused
--        by task_dependency_guard (unchanged).
--
-- Additive and idempotent: functions are create or replace, policies and
-- triggers are dropped and recreated.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── S2-1. attachments obey the project role ──────────────────────────────

drop trigger if exists enforce_project_role_on_task_attachments on projects.task_attachments;
create trigger enforce_project_role_on_task_attachments
  before insert or update or delete on projects.task_attachments
  for each row execute function projects.enforce_project_role_on_task_child();

comment on function projects.enforce_project_role_on_task_child() is
  'R2-2 / S2-1. Refuses a comment, time log, checklist item or attachment written by a person whose project role forbids changing the task it belongs to (observer: anything; contributor: a task not assigned to them). Role union for the roster-manager exemption.';

-- ── S2-2. the roster and default-assignee doors read the role union ──────

drop policy if exists project_members_write on projects.project_members;
create policy project_members_write on projects.project_members
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select projects.is_roster_manager()))
  with check (organization_id = (select core.current_organization_id()) and (select projects.is_roster_manager()));

create or replace function projects.set_project_default_assignee(
  p_project_id   uuid,
  p_project_role text,
  p_user_id      uuid
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before projects.project_default_assignees;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select projects.is_roster_manager()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_project_role is null or p_project_role not in ('project_manager', 'designer', 'developer', 'qa', 'contributor', 'observer') then
    return query select 'bad_role'::text; return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then
    return query select 'not_found'::text; return;
  end if;

  select * into v_before from projects.project_default_assignees d
   where d.project_id = p_project_id and d.project_role = p_project_role;

  if p_user_id is null then
    if v_before.id is null then
      return query select 'cleared'::text; return;
    end if;
    delete from projects.project_default_assignees where id = v_before.id;
    perform core.record_audit(v_org, 'project.default_assignee_cleared', 'project', p_project_id,
      jsonb_build_object('projectRole', p_project_role, 'userId', v_before.user_id), null);
    return query select 'cleared'::text; return;
  end if;

  if not exists (
    select 1 from core.memberships m
     where m.user_id = p_user_id and m.organization_id = v_org and m.status = 'active'
       and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor')
  ) then
    return query select 'not_internal'::text; return;
  end if;

  insert into projects.project_default_assignees (organization_id, project_id, project_role, user_id, set_by)
  values (v_org, p_project_id, p_project_role, p_user_id, v_actor)
  on conflict (project_id, project_role) do update
    set user_id = excluded.user_id, set_by = excluded.set_by;

  perform core.record_audit(v_org, 'project.default_assignee_set', 'project', p_project_id,
    case when v_before.id is null then null else jsonb_build_object('projectRole', p_project_role, 'userId', v_before.user_id) end,
    jsonb_build_object('projectRole', p_project_role, 'userId', p_user_id));
  return query select 'set'::text;
end;
$$;

comment on function projects.set_project_default_assignee(uuid, text, uuid) is
  'Q-B4 / S2-2. Sets (or, with a null user, clears) the default assignee of one project role on one project. Owner, ops admin and delivery lead by the role union (primary or secondary); the person must hold an active internal membership; audited project.default_assignee_set / project.default_assignee_cleared.';

revoke all on function projects.set_project_default_assignee(uuid, text, uuid) from public, anon;
grant execute on function projects.set_project_default_assignee(uuid, text, uuid) to authenticated, service_role;

-- The project's one default assignee (the fallback for every role): an audited door
-- with the same union check. The service uses this door instead of a plain update
-- through the projects_write policy (which reads the primary role only).
create or replace function projects.set_project_fallback_assignee(p_project_id uuid, p_user_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select projects.is_roster_manager()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select p.default_assignee_id into v_before
    from projects.projects p
   where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null;
  if not found then
    return query select 'not_found'::text; return;
  end if;
  if p_user_id is not null and not exists (
    select 1 from core.memberships m
     where m.user_id = p_user_id and m.organization_id = v_org and m.status = 'active'
  ) then
    return query select 'not_internal'::text; return;
  end if;

  update projects.projects set default_assignee_id = p_user_id where id = p_project_id;

  perform core.record_audit(v_org,
    case when p_user_id is null then 'project.fallback_assignee_cleared' else 'project.fallback_assignee_set' end,
    'project', p_project_id,
    case when v_before is null then null else jsonb_build_object('userId', v_before) end,
    case when p_user_id is null then null else jsonb_build_object('userId', p_user_id) end);
  return query select (case when p_user_id is null then 'cleared' else 'set' end)::text;
end;
$$;

comment on function projects.set_project_fallback_assignee(uuid, uuid) is
  'S2-2. Sets (or clears) the one default assignee of a project. Owner, ops admin and delivery lead by the role union; the person must hold an active membership; audited project.fallback_assignee_set / _cleared.';

revoke all on function projects.set_project_fallback_assignee(uuid, uuid) from public, anon;
grant execute on function projects.set_project_fallback_assignee(uuid, uuid) to authenticated, service_role;

-- ── S2-3. a done, cancelled or archived dependency is satisfied ──────────

drop function if exists projects.task_start_check(uuid);
create function projects.task_start_check(p_task_id uuid)
returns table (
  startable          boolean,
  requirement_ok     boolean,
  open_dependencies  integer,
  reason             text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_task   projects.tasks;
  v_req    boolean;
  v_open   integer := 0;
  v_names  text;
begin
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then
    return;
  end if;

  v_req := v_task.requirement_version_id is not null
    or (v_task.feature_id is not null and exists (
         select 1 from projects.scope_items si
          where si.feature_id = v_task.feature_id and si.inclusion in ('included', 'optional')));

  -- Satisfied: done, cancelled or archived. Open: everything else.
  select string_agg('"' || x.title || '" (' || replace(x.status::text, '_', ' ') || ')', ', ' order by x.title)
    into v_names
    from (
      select t.title, t.status
        from projects.task_dependencies d
        join projects.tasks t on t.id = d.depends_on_task_id
       where d.task_id = p_task_id
         and t.status::text not in ('done', 'cancelled', 'archived')
         and to_jsonb(t) ->> 'archived_at' is null
         and to_jsonb(t) ->> 'cancelled_at' is null
       order by t.title
       limit 3
    ) x;
  select count(*)::integer into v_open
    from projects.task_dependencies d
    join projects.tasks t on t.id = d.depends_on_task_id
   where d.task_id = p_task_id
     and t.status::text not in ('done', 'cancelled', 'archived')
     and to_jsonb(t) ->> 'archived_at' is null
     and to_jsonb(t) ->> 'cancelled_at' is null;

  return query select
    (v_req and v_open = 0),
    v_req,
    v_open,
    case
      when not v_req then 'Requirement check failed: this task is not linked to a requirement or scope item. Link it to the feature that delivers one, or ask the requirement on the task page.'
      when v_open > 0 then 'Dependency check failed: waiting on ' || v_names
        || case when v_open > 3 then ' and ' || (v_open - 3) || ' more' else '' end
        || '. Finish ' || case when v_open = 1 then 'it' else 'them' end || ' first, or remove the dependency.'
      else null
    end;
end;
$$;

comment on function projects.task_start_check(uuid) is
  'Q-C3 / R2-1 / S2-3. The two gates in front of Start Task: the requirement check and the dependency check (every task this task depends on is done, cancelled or archived; a dependency on another project is refused when it is written). reason names the failing task.';

revoke all on function projects.task_start_check(uuid) from public, anon;
grant execute on function projects.task_start_check(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
