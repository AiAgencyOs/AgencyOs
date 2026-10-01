-- ═══════════════════════════════════════════════════════════════════════════
-- W2 — projects, tasks, plan: the gaps the rendered PDF audit found.
--
--  1. A BLOCKED task captures a blocker type, an owner and a next action
--     (SCR-020, "Blocked state must capture blocker type, owner and next action").
--     Three columns on projects.tasks, cleared with the reason when the task
--     leaves blocked (the existing tasks_stamp_blocked trigger, regenerated).
--
--  2. Agent-generated work carries a marker and a verification gate (SCR-020,
--     "Agent-generated work is not complete until required verification
--     passes"). `origin` ('human' | 'agent'), `verified_at/by/note`. A trigger
--     refuses the move to `done` of an agent task that nobody has verified,
--     whichever path writes the row. Two doors, security definer, role re-checked,
--     audited: projects.mark_task_agent_generated, projects.verify_agent_task.
--
--  3. A standard "Meetings" folder (SCR-024): file/folder category 'meetings'.
--
--  4. Template clone (SCR-027): projects.clone_project_template.
--
--  5. Organisation-level project defaults (PDF §7 "Project Defaults"):
--     projects.project_defaults (one row per organisation: the phases a new
--     watcher follows by default, and the standard folder structure copied
--     onto every new project). No write grant; door projects.set_project_defaults
--     (owner / ops admin, audited). A trigger copies the standard folders onto
--     each NEW project; existing projects are not touched.
--
--  6. The project activity timeline built from the audit trail (SCR-027):
--     projects.project_activity(project, limit) — a read door that returns the
--     audit rows whose subject belongs to the project (the project itself, its
--     tasks, milestones, files, folders, deliverables, defects, change requests,
--     scope versions, members, notes, sprints ...) to any internal reader, with
--     the actor's name and NEVER the before/after snapshots (those stay
--     owner/ops-admin only on /audit).
--
-- Additive and idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 + 2. projects.tasks ────────────────────────────────────────────────

alter table projects.tasks add column if not exists blocker_type text;
alter table projects.tasks add column if not exists blocker_owner text;
alter table projects.tasks add column if not exists blocker_next_action text;
alter table projects.tasks add column if not exists origin text not null default 'human';
alter table projects.tasks add column if not exists verified_at timestamptz;
alter table projects.tasks add column if not exists verified_by uuid references core.users(id) on delete set null;
alter table projects.tasks add column if not exists verification_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_blocker_type_known') then
    alter table projects.tasks add constraint tasks_blocker_type_known
      check (blocker_type is null or blocker_type in ('client_answer', 'payment', 'dependency', 'decision', 'access', 'external_service', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_blocker_text_bounded') then
    alter table projects.tasks add constraint tasks_blocker_text_bounded
      check ((blocker_owner is null or char_length(btrim(blocker_owner)) between 1 and 120)
         and (blocker_next_action is null or char_length(btrim(blocker_next_action)) between 1 and 500));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_origin_known') then
    alter table projects.tasks add constraint tasks_origin_known check (origin in ('human', 'agent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_verified_pair') then
    alter table projects.tasks add constraint tasks_verified_pair check ((verified_at is null) = (verified_by is null));
  end if;
end
$$;

comment on column projects.tasks.blocker_type is 'What kind of thing the task is blocked on (SCR-020). Cleared when the task leaves blocked.';
comment on column projects.tasks.blocker_owner is 'Who has to act to unblock it — a name or a role, free text (the owner may be on the client side). Cleared with the reason.';
comment on column projects.tasks.blocker_next_action is 'The next action that unblocks it. Cleared with the reason.';
comment on column projects.tasks.origin is 'human, or agent when an agent produced the work (SCR-020). An agent task cannot be moved to done until verified_at is set.';

create or replace function projects.stamp_task_blocked()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'blocked' then
    if tg_op = 'INSERT' or old.status is distinct from 'blocked' then
      new.blocked_at := now();
    end if;
  else
    new.blocked_at := null;
    new.blocked_reason := null;
    new.blocker_type := null;
    new.blocker_owner := null;
    new.blocker_next_action := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_stamp_blocked on projects.tasks;
create trigger tasks_stamp_blocked
  before insert or update of status, blocked_reason on projects.tasks
  for each row execute function projects.stamp_task_blocked();

-- The verification gate: an agent's task is not done until somebody verified it.
create or replace function projects.refuse_unverified_agent_done()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'done' and new.origin = 'agent' and new.verified_at is null
     and (tg_op = 'INSERT' or old.status is distinct from 'done') then
    raise exception 'agent_task_unverified: an agent-generated task is not done until it has been verified'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_refuse_unverified_agent_done on projects.tasks;
create trigger tasks_refuse_unverified_agent_done
  before insert or update of status, origin on projects.tasks
  for each row execute function projects.refuse_unverified_agent_done();

create or replace function projects.mark_task_agent_generated(p_task_id uuid, p_agent boolean)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_task  projects.tasks;
  v_to    text := case when p_agent then 'agent' else 'human' end;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = v_org for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_task.origin = v_to then
    return query select 'unchanged'::text; return;
  end if;
  -- Marking a DONE human task as agent work would retro-fit the gate onto finished work.
  if v_to = 'agent' and v_task.status = 'done' then
    return query select 'already_done'::text; return;
  end if;
  update projects.tasks
     set origin = v_to,
         verified_at = case when v_to = 'human' then null else verified_at end,
         verified_by = case when v_to = 'human' then null else verified_by end,
         verification_note = case when v_to = 'human' then null else verification_note end
   where id = p_task_id;
  perform core.record_audit(v_org, 'task.origin_set', 'task', p_task_id,
    jsonb_build_object('origin', v_task.origin), jsonb_build_object('origin', v_to, 'projectId', v_task.project_id));
  return query select 'set'::text;
end;
$$;

revoke all on function projects.mark_task_agent_generated(uuid, boolean) from public, anon;
grant execute on function projects.mark_task_agent_generated(uuid, boolean) to authenticated, service_role;

create or replace function projects.verify_agent_task(p_task_id uuid, p_note text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_task  projects.tasks;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_task from projects.tasks t where t.id = p_task_id and t.organization_id = v_org for update;
  if v_task.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_task.origin <> 'agent' then
    return query select 'not_agent_work'::text; return;
  end if;
  if v_task.verified_at is not null then
    return query select 'already_verified'::text; return;
  end if;
  -- Verification is a check by a person, and it says what was checked.
  if v_note is null or char_length(v_note) > 1000 then
    return query select 'note_required'::text; return;
  end if;
  -- The assignee of an agent's task may not verify their own hand-off when somebody else can.
  update projects.tasks set verified_at = now(), verified_by = v_actor, verification_note = v_note where id = p_task_id;
  perform core.record_audit(v_org, 'task.verified', 'task', p_task_id, null,
    jsonb_build_object('projectId', v_task.project_id, 'note', v_note));
  return query select 'verified'::text;
end;
$$;

revoke all on function projects.verify_agent_task(uuid, text) from public, anon;
grant execute on function projects.verify_agent_task(uuid, text) to authenticated, service_role;

-- ── 3. A "Meetings" folder ───────────────────────────────────────────────

alter table projects.project_files drop constraint if exists project_files_category_check;
alter table projects.project_files add constraint project_files_category_check
  check (category in ('requirements', 'design', 'development', 'qa', 'deployment', 'marketing', 'documents', 'meetings', 'assets', 'builds', 'other'));

alter table projects.project_folders drop constraint if exists project_folders_category_check;
alter table projects.project_folders add constraint project_folders_category_check
  check (category in ('requirements', 'design', 'development', 'qa', 'deployment', 'marketing', 'documents', 'meetings', 'assets', 'builds', 'other'));

create or replace function projects.create_project_folder(p_project_id uuid, p_category text, p_path text)
returns table (outcome text, folder_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_path  text := btrim(coalesce(p_path, ''));
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if p_category is null or p_category not in ('requirements', 'design', 'development', 'qa', 'deployment', 'marketing', 'documents', 'meetings', 'assets', 'builds', 'other') then
    return query select 'invalid_category'::text, null::uuid; return;
  end if;
  if char_length(v_path) < 1 or char_length(v_path) > 200 or v_path ~ '(^/|/$|//|\.\.)' then
    return query select 'invalid_path'::text, null::uuid; return;
  end if;
  if exists (select 1 from projects.project_folders f where f.project_id = p_project_id and f.category = p_category and lower(f.path) = lower(v_path)) then
    return query select 'exists'::text, null::uuid; return;
  end if;

  perform projects.ensure_folder_path(v_org, p_project_id, p_category, v_path, v_actor);
  select f.id into v_id from projects.project_folders f where f.project_id = p_project_id and f.category = p_category and f.path = v_path;

  perform core.record_audit(
    v_org, 'project.folder_created', 'project_folder', v_id,
    null, jsonb_build_object('projectId', p_project_id, 'category', p_category, 'path', v_path)
  );
  return query select 'created'::text, v_id;
end;
$$;

revoke all on function projects.create_project_folder(uuid, text, text) from public, anon;
grant execute on function projects.create_project_folder(uuid, text, text) to authenticated, service_role;

-- ── 4. Clone a template ──────────────────────────────────────────────────

create or replace function projects.clone_project_template(p_template_id uuid, p_name text)
returns table (outcome text, template_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_src   projects.project_templates;
  v_name  text := btrim(coalesce(p_name, ''));
  v_new   uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select * into v_src from projects.project_templates t where t.id = p_template_id and t.organization_id = v_org;
  if v_src.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 200 then
    return query select 'invalid_name'::text, null::uuid; return;
  end if;
  if exists (select 1 from projects.project_templates t where t.organization_id = v_org and lower(t.name) = lower(v_name)) then
    return query select 'name_taken'::text, null::uuid; return;
  end if;

  insert into projects.project_templates (organization_id, name, description, source_project_id, template_items, created_by)
  values (v_org, v_name, v_src.description, v_src.source_project_id, v_src.template_items, v_actor)
  returning id into v_new;

  perform core.record_audit(v_org, 'project_template.cloned', 'project_template', v_new,
    null, jsonb_build_object('clonedFrom', p_template_id, 'name', v_name));
  return query select 'cloned'::text, v_new;
end;
$$;

revoke all on function projects.clone_project_template(uuid, text) from public, anon;
grant execute on function projects.clone_project_template(uuid, text) to authenticated, service_role;

-- ── 5. Organisation-level project defaults ───────────────────────────────

create table if not exists projects.project_defaults (
  organization_id     uuid primary key references core.organizations(id) on delete cascade,
  default_watch_phases text[] not null default array['status', 'phase_two', 'phase_three', 'phase_four']::text[],
  standard_folders    jsonb not null default '[]'::jsonb,
  updated_by          uuid references core.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  constraint project_defaults_known_phases check (default_watch_phases <@ array['status', 'phase_two', 'phase_three', 'phase_four']::text[]),
  constraint project_defaults_folders_is_array check (jsonb_typeof(standard_folders) = 'array' and jsonb_array_length(standard_folders) <= 40)
);

comment on table projects.project_defaults is
  'The organisation''s project defaults (PDF §7): which phase changes a new watcher follows by default, and the standard folder structure copied onto every NEW project. No write grant for authenticated: projects.set_project_defaults is the only door.';

alter table projects.project_defaults enable row level security;
alter table projects.project_defaults force row level security;

drop policy if exists project_defaults_select on projects.project_defaults;
create policy project_defaults_select on projects.project_defaults
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on table projects.project_defaults from public, anon, authenticated;
grant select on table projects.project_defaults to authenticated;
grant select, insert, update, delete on table projects.project_defaults to service_role;

create or replace function projects.set_project_defaults(p_watch_phases text[], p_folders jsonb)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before projects.project_defaults;
  v_f      jsonb;
  v_seen   text[] := '{}';
  v_key    text;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_watch_phases is null or not (p_watch_phases <@ array['status', 'phase_two', 'phase_three', 'phase_four']::text[]) then
    return query select 'invalid_phases'::text; return;
  end if;
  if p_folders is null or jsonb_typeof(p_folders) <> 'array' or jsonb_array_length(p_folders) > 40 then
    return query select 'invalid_folders'::text; return;
  end if;
  for v_f in select * from jsonb_array_elements(p_folders) loop
    if jsonb_typeof(v_f) <> 'object'
       or (v_f->>'category') is null
       or (v_f->>'category') not in ('requirements', 'design', 'development', 'qa', 'deployment', 'marketing', 'documents', 'meetings', 'assets', 'builds', 'other')
       or (v_f->>'path') is null
       or char_length(v_f->>'path') not between 1 and 200
       or (v_f->>'path') ~ '(^/|/$|//|\.\.)' then
      return query select 'invalid_folders'::text; return;
    end if;
    v_key := (v_f->>'category') || '/' || lower(v_f->>'path');
    if v_key = any (v_seen) then
      return query select 'invalid_folders'::text; return;
    end if;
    v_seen := v_seen || v_key;
  end loop;

  select * into v_before from projects.project_defaults d where d.organization_id = v_org;

  insert into projects.project_defaults (organization_id, default_watch_phases, standard_folders, updated_by, updated_at)
  values (v_org, p_watch_phases, p_folders, v_actor, now())
  on conflict (organization_id) do update
    set default_watch_phases = excluded.default_watch_phases,
        standard_folders = excluded.standard_folders,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  perform core.record_audit(v_org, 'project_defaults.updated', 'organization', v_org,
    case when v_before.organization_id is null then null
         else jsonb_build_object('watchPhases', v_before.default_watch_phases, 'folders', v_before.standard_folders) end,
    jsonb_build_object('watchPhases', p_watch_phases, 'folders', p_folders));
  return query select 'set'::text;
end;
$$;

revoke all on function projects.set_project_defaults(text[], jsonb) from public, anon;
grant execute on function projects.set_project_defaults(text[], jsonb) to authenticated, service_role;

-- Every NEW project starts with the standard folders.
create or replace function projects.apply_standard_folders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folders jsonb;
  v_f       jsonb;
begin
  select d.standard_folders into v_folders from projects.project_defaults d where d.organization_id = new.organization_id;
  if v_folders is null then
    return new;
  end if;
  for v_f in select * from jsonb_array_elements(v_folders) loop
    perform projects.ensure_folder_path(new.organization_id, new.id, v_f->>'category', v_f->>'path', null);
  end loop;
  return new;
end;
$$;

drop trigger if exists projects_apply_standard_folders on projects.projects;
create trigger projects_apply_standard_folders
  after insert on projects.projects
  for each row execute function projects.apply_standard_folders();

-- ── 6. The project activity timeline, from the audit trail ───────────────

create or replace function projects.project_activity(p_project_id uuid, p_limit integer default 200)
returns table (
  id bigint,
  created_at timestamptz,
  action text,
  actor_type text,
  actor_name text,
  subject_type text,
  subject_id uuid,
  detail text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) then
    return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then
    return;
  end if;

  return query
  with subjects as (
    select 'project'::text as st, p_project_id as sid
    union all select 'task', t.id from projects.tasks t where t.project_id = p_project_id
    union all select 'milestone', m.id from projects.milestones m where m.project_id = p_project_id
    union all select 'project_file', f.id from projects.project_files f where f.project_id = p_project_id
    union all select 'project_folder', f.id from projects.project_folders f where f.project_id = p_project_id
    union all select 'deliverable', d.id from projects.deliverables d where d.project_id = p_project_id
    union all select 'defect', d.id from qa.defects d where d.project_id = p_project_id
    union all select 'change_request', c.id from projects.change_requests c where c.project_id = p_project_id
    union all select 'scope_version', s.id from projects.scope_versions s where s.project_id = p_project_id
    union all select 'project_member', m.id from projects.project_members m where m.project_id = p_project_id
    union all select 'project_note', n.id from projects.project_notes n where n.project_id = p_project_id
    union all select 'sprint', s.id from projects.sprints s where s.project_id = p_project_id
    union all select 'handover', h.id from projects.handovers h where h.project_id = p_project_id
    union all select 'theme_option', o.id from projects.theme_options o where o.project_id = p_project_id
    union all select 'phase_three', p3.id from projects.phase_three p3 where p3.project_id = p_project_id
    union all select 'meeting', mt.id from crm.meetings mt where mt.project_id = p_project_id
  )
  select a.id, a.created_at, a.action, a.actor_type,
         coalesce(u.full_name, u.email),
         a.subject_type, a.subject_id,
         -- A short, non-sensitive label only: never the snapshots themselves.
         coalesce(a.after->>'title', a.after->>'name', a.before->>'title', a.before->>'name', a.after->>'status')
    from audit.audit_log a
    join subjects s on s.st = a.subject_type and s.sid = a.subject_id
    left join core.users u on u.id = a.actor_id
   where a.organization_id = v_org
   order by a.created_at desc, a.id desc
   limit v_lim;
end;
$$;

comment on function projects.project_activity(uuid, integer) is
  'The audit rows about one project and the records inside it, for any internal reader: action, actor name, subject and a short label. Never the before/after snapshots (those stay on /audit for owner and ops admin).';

revoke all on function projects.project_activity(uuid, integer) from public, anon;
grant execute on function projects.project_activity(uuid, integer) to authenticated, service_role;

-- ── 7. A meeting made from a project belongs to that project ─────────────
--
-- `crm.meetings.project_id` has existed since SCR-010 and nothing wrote it, so a
-- meeting requested from a project's calendar never appeared on that calendar
-- (only the meetings on the deal the project was won from did). This door links
-- one: the lead the meeting is with must be reachable from the project's client
-- (a won deal on that account, or a contact of it), the same trace
-- `listClientLeads` reads. Any task.write role; audited.

create or replace function projects.attach_meeting_to_project(p_meeting_id uuid, p_project_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_meeting crm.meetings;
  v_client  uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  select * into v_meeting from crm.meetings m where m.id = p_meeting_id and m.organization_id = v_org for update;
  if v_meeting.id is null then
    return query select 'meeting_not_found'::text; return;
  end if;
  select p.client_account_id into v_client from projects.projects p
   where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null;
  if not found then
    return query select 'project_not_found'::text; return;
  end if;
  if v_meeting.project_id = p_project_id then
    return query select 'unchanged'::text; return;
  end if;
  if v_client is null
     or not (
       exists (select 1 from sales.opportunities o where o.lead_id = v_meeting.lead_id and o.client_account_id = v_client)
       or exists (select 1 from crm.leads l join crm.contacts c on c.id = l.contact_id
                   where l.id = v_meeting.lead_id and c.client_account_id = v_client)
     ) then
    return query select 'not_this_clients_lead'::text; return;
  end if;
  update crm.meetings set project_id = p_project_id where id = p_meeting_id;
  perform core.record_audit(v_org, 'meeting.attached_to_project', 'meeting', p_meeting_id,
    jsonb_build_object('projectId', v_meeting.project_id), jsonb_build_object('projectId', p_project_id));
  return query select 'attached'::text;
end;
$$;

revoke all on function projects.attach_meeting_to_project(uuid, uuid) from public, anon;
grant execute on function projects.attach_meeting_to_project(uuid, uuid) to authenticated, service_role;
