-- ═══════════════════════════════════════════════════════════════════════════
-- Round 3, stream R2, Q-B4 (SCR-027): a project has default assignees per
-- project role. `projects.projects.default_assignee_id` (one person for the
-- whole project) stays as the fallback; this child table names a person for
-- each project role (project manager, designer, developer, QA, contributor,
-- observer). A task created with a role chosen and nobody named goes to that
-- role's default, then to the project's one default, then to nobody.
--
-- The write is one security-definer door, `projects.set_project_default_assignee`:
-- it re-checks the caller is an owner / ops admin / delivery lead (the roles
-- that keep the roster, Q-B3), checks the person holds an active internal
-- membership of the organisation, upserts or clears the row, and audits both
-- in the same transaction. No direct write grant; reads are RLS-scoped to
-- internal people of the organisation. Tenancy guards on the new table.
-- Additive and idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.project_default_assignees (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  project_role     text not null check (project_role in (
                     'project_manager', 'designer', 'developer', 'qa', 'contributor', 'observer'
                   )),
  user_id          uuid not null references core.users(id) on delete cascade,
  set_by           uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, project_role)
);

comment on table projects.project_default_assignees is
  'Q-B4 / SCR-027. The person a new task of a given project role goes to when nobody is named. One row per (project, role). Written only through projects.set_project_default_assignee.';

create index if not exists project_default_assignees_org_idx on projects.project_default_assignees (organization_id, project_id);

drop trigger if exists set_updated_at on projects.project_default_assignees;
create trigger set_updated_at before update on projects.project_default_assignees
  for each row execute function core.set_updated_at();

alter table projects.project_default_assignees enable row level security;
alter table projects.project_default_assignees force row level security;

drop policy if exists project_default_assignees_select on projects.project_default_assignees;
create policy project_default_assignees_select on projects.project_default_assignees
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on table projects.project_default_assignees from public, anon, authenticated;
grant select on table projects.project_default_assignees to authenticated;
grant select, insert, update, delete on table projects.project_default_assignees to service_role;

drop trigger if exists org_match_project_default_assignees_project on projects.project_default_assignees;
create trigger org_match_project_default_assignees_project
  before insert or update of project_id, organization_id on projects.project_default_assignees
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_project_default_assignees on projects.project_default_assignees;
create trigger freeze_org_project_default_assignees
  before update of organization_id on projects.project_default_assignees
  for each row execute function core.freeze_organization_id();

drop trigger if exists project_default_assignees_check_membership on projects.project_default_assignees;
create trigger project_default_assignees_check_membership
  before insert or update of user_id, organization_id on projects.project_default_assignees
  for each row execute function projects.check_project_member_is_internal();

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
  if not coalesce((select core.can_manage_delivery()), false) then
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
  'Q-B4. Sets (or, with a null user, clears) the default assignee of one project role on one project. Owner, ops admin and delivery lead only; the person must hold an active internal membership; audited project.default_assignee_set / project.default_assignee_cleared.';

revoke all on function projects.set_project_default_assignee(uuid, text, uuid) from public, anon;
grant execute on function projects.set_project_default_assignee(uuid, text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
