-- ═══════════════════════════════════════════════════════════════════════════
-- The pieces a project is actually built from.
--
-- Phase 12, gaps G-024 (development module tracking) and G-025 (client
-- development review). Directive §16 describes a food-delivery build as
-- customer app, delivery app, vendor, admin, backend, payments, notifications,
-- maps — and `projects.tasks` was a flat list with no way to say which of
-- those a task belonged to, so "how is the vendor panel going" had no answer
-- the system could give.
--
-- ── the task state machine is not duplicated ──────────────────────────────
--
-- Directive §16 lists a development lifecycle — not_started, planned,
-- in_progress, code_review, qa, ready_for_client, approved — and immediately
-- warns: *"Do not invent statuses if an existing state machine already
-- exists."* `projects.tasks` has one: todo, in_progress, blocked, in_review,
-- done. A module is not a task and needs the coarser vocabulary, so it gets
-- the directive's own list; the task statuses are untouched, and a task's
-- status still means exactly what it meant before.
--
-- ── what closes G-025, and what was already there ─────────────────────────
--
-- Client development review is mostly built: a build is a `deliverable` of
-- kind `build`, versioned, submitted through the approval engine, carrying its
-- changelog and known issues. Directive §17 asks for one more thing —
-- *"test credentials through approved secure mechanism"* — and the answer is
-- the handover answer: the column records **how** a client gets test access
-- and never what the access is. `deliverables_test_access_shape` refuses a
-- value that looks like it is carrying one.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.modules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  name             text not null check (length(trim(name)) > 0),
  description      text,

  -- Directive §16's own vocabulary. Coarser than a task's on purpose: a module
  -- is in code review when its work is, and nobody wants to reconcile
  -- fourteen task rows to find that out.
  status           text not null default 'not_started' check (status in
                     ('not_started', 'planned', 'in_progress', 'code_review',
                      'qa', 'ready_for_client', 'approved')),

  -- Ordering for display. Explicit rather than alphabetical: "backend" comes
  -- before "admin panel" in the plan and after it in the alphabet.
  position         int not null default 0,

  owner_id         uuid references core.users(id) on delete set null,
  due_on           date,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (project_id, name)
);

comment on table projects.modules is
  'The pieces a project is built from — customer app, backend, admin panel. Directive §16''s own status vocabulary, deliberately coarser than a task''s: a module is in QA when its work is, and nobody should have to reconcile fourteen task rows to learn that.';

create index if not exists modules_project_idx on projects.modules (project_id, position);

drop trigger if exists set_updated_at on projects.modules;
create trigger set_updated_at
  before update on projects.modules
  for each row execute function core.set_updated_at();

-- A task may belong to a module. Nullable, because every task that exists
-- today belongs to none and back-filling them by guess would be worse than
-- leaving them where they are.
alter table projects.tasks
  add column if not exists module_id uuid references projects.modules(id) on delete set null;

create index if not exists tasks_module_idx on projects.tasks (module_id) where module_id is not null;

comment on column projects.tasks.module_id is
  'Which piece of the project this task belongs to. Nullable: tasks predating modules belong to none, and guessing where they go would be worse than admitting it.';

-- ── a module and its tasks belong to the same project ────────────────────
--
-- Nothing in a foreign key says so: `module_id` and `project_id` are separate
-- references, and a task could name a module from another project entirely —
-- which would then appear in that project's progress. The kind of quiet
-- cross-wiring D22 was.
create or replace function projects.tasks_module_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare v_project uuid;
begin
  if new.module_id is null then return new; end if;

  select m.project_id into v_project
    from projects.modules m
   where m.id = new.module_id;

  if v_project is distinct from new.project_id then
    raise exception 'that module belongs to another project'
      using errcode = 'foreign_key_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_module_guard on projects.tasks;
create trigger tasks_module_guard
  before insert or update of module_id, project_id on projects.tasks
  for each row execute function projects.tasks_module_guard();

alter table projects.modules enable row level security;

drop policy if exists modules_select on projects.modules;
create policy modules_select on projects.modules
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        -- A client may see the shape of their own build and how far along it
        -- is. Not the tasks underneath — that is the team's working surface.
        (select core.is_client())
        and exists (
          select 1 from projects.projects p
           where p.id = project_id
             and p.client_account_id = (select core.current_client_account_id())
        )
      )
    )
  );

drop policy if exists modules_write on projects.modules;
create policy modules_write on projects.modules
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

-- ═══════════════════════════════════════════════════════════════════════════
-- G-025 — test access, without the credentials
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.deliverables
  add column if not exists test_access_method text;

comment on column projects.deliverables.test_access_method is
  'How the client gets into the build to try it — "credentials shared in 1Password", "demo account, no login needed". Never the credentials themselves: directive §22''s rule, and a build handed to a client is exactly where somebody would be tempted to paste a password.';

alter table projects.deliverables drop constraint if exists deliverables_test_access_shape;
alter table projects.deliverables add constraint deliverables_test_access_shape check (
  test_access_method is null
  or (
    -- Not a secret detector, and not pretending to be one: it refuses the
    -- three shapes somebody actually pastes when they mean well and are in a
    -- hurry. The rule is stated in the column comment; this stops the
    -- accident, not a determined author.
    test_access_method !~* '(password|passwd)\s*[:=]'
    and test_access_method !~* '\mpin\s*[:=]\s*\d'
    and test_access_method !~* '(api[_ -]?key|secret|token)\s*[:=]'
  )
);

-- The guard already refuses edits to a settled version; it must know about the
-- new column too, or a delivered build's test access could be rewritten after
-- the client approved it.
create or replace function projects.deliverables_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.project_id   is distinct from old.project_id
     or new.kind         is distinct from old.kind
     or new.version      is distinct from old.version
     or new.title        is distinct from old.title
     or new.artifact_url is distinct from old.artifact_url
     or new.changelog    is distinct from old.changelog
     or new.known_issues is distinct from old.known_issues
     or new.test_access_method is distinct from old.test_access_method
     or new.created_by   is distinct from old.created_by
     or new.created_at   is distinct from old.created_at
  then
    raise exception
      'deliverable %s v% is immutable; submit version % instead',
      old.kind, old.version, old.version + 1
      using errcode = 'restrict_violation';
  end if;

  if old.status in ('approved', 'superseded') and new.status is distinct from old.status then
    raise exception 'deliverable %s v% is already %', old.kind, old.version, old.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

-- `add_deliverable` gains two arguments, so a build can be recorded with its
-- module and its access instructions in the statement that creates it.
--
-- The old signature is DROPPED rather than left beside the new one. `create or
-- replace` with a different parameter list makes an overload, not a
-- replacement, and PostgREST then cannot tell which function a call meant —
-- every deliverable call in the repository started answering PGRST202. That is
-- G-082's lesson exactly ("the old signature is dropped rather than kept as an
-- overload"), and it was found by CI rather than by me, because I re-ran the
-- script for the migration I had just written and not the one it changed.
drop function if exists projects.add_deliverable(uuid, text, text, text, text, text, uuid);

create or replace function projects.add_deliverable(
  p_project_id   uuid,
  p_kind         text,
  p_title        text,
  p_artifact_url text default null,
  p_changelog    text default null,
  p_known_issues text default null,
  p_created_by   uuid default null,
  p_test_access_method text default null,
  p_module_id    uuid default null
)
returns table (outcome text, deliverable_id uuid, version int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project projects.projects;
  v_next    int;
  v_row     projects.deliverables;
begin
  select p.* into v_project from projects.projects p where p.id = p_project_id for update;

  if v_project.id is null then
    return query select 'not_found'::text, null::uuid, null::int;
    return;
  end if;

  if p_module_id is not null
     and not exists (select 1 from projects.modules m
                      where m.id = p_module_id and m.project_id = p_project_id)
  then
    -- Same cross-wiring the task guard refuses, one table along.
    return query select 'wrong_module'::text, null::uuid, null::int;
    return;
  end if;

  select coalesce(max(d.version), 0) + 1 into v_next
    from projects.deliverables d
   where d.project_id = p_project_id and d.kind = p_kind;

  insert into projects.deliverables (
    organization_id, project_id, kind, version, title,
    artifact_url, changelog, known_issues, created_by, test_access_method, module_id
  )
  values (
    v_project.organization_id, p_project_id, p_kind, v_next, p_title,
    p_artifact_url, p_changelog, p_known_issues, p_created_by, p_test_access_method, p_module_id
  )
  returning * into v_row;

  perform core.record_audit(
    v_project.organization_id, 'deliverable.added', 'deliverable', v_row.id, null,
    jsonb_build_object('kind', p_kind, 'version', v_next, 'project_id', p_project_id)
  );

  return query select 'created'::text, v_row.id, v_next;
end;
$$;

alter table projects.deliverables
  add column if not exists module_id uuid references projects.modules(id) on delete set null;

comment on column projects.deliverables.module_id is
  'Which piece of the project this build is of. A customer APK and a vendor panel are two client reviews, not one.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Where a project actually is
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.module_progress(p_project_id uuid)
returns table (
  module_id     uuid,
  name          text,
  status        text,
  tasks_total   bigint,
  tasks_done    bigint,
  open_defects  bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.id, m.name, m.status,
    (select count(*) from projects.tasks t where t.module_id = m.id),
    (select count(*) from projects.tasks t where t.module_id = m.id and t.status = 'done'),
    (select count(*) from qa.defects d
      join projects.deliverables dv on dv.id = d.deliverable_id
     where dv.module_id = m.id and d.status = 'open')
  from projects.modules m
 where m.project_id = p_project_id
 order by m.position, m.name;
$$;

comment on function projects.module_progress(uuid) is
  'Where each piece of a project is: its own status, its task counts, and the open defects against builds of it. The answer to "how is the vendor panel going", which nothing could give before.';

revoke all on function projects.module_progress(uuid) from public;
grant execute on function projects.module_progress(uuid) to authenticated, service_role;
grant select, insert, update, delete on projects.modules to authenticated, service_role;
