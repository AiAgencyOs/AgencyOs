-- ═══════════════════════════════════════════════════════════════════════════
-- A task is worked on together, and a pause says why.
--
-- Two gaps from docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, bucket B:
--
-- 1. SCR-020 (Board), SCR-021 (My tasks) and SCR-041 (Task execution) all
--    draw a task with comments, a checklist, attachments and a blocker
--    field, and `projects.tasks` had none of them — the Board drawer said
--    so in prose. Three small child tables and two columns close it:
--
--      projects.task_comments         a note somebody left on the task
--      projects.task_checklist_items  the sub-steps a task is done through,
--                                     each ticked by a named person
--      projects.task_attachments      a titled link — the same link-not-blob
--                                     rule projects.project_files and
--                                     projects.deliverables already settled
--      projects.tasks.blocked_reason  why the task is in `blocked`
--      projects.tasks.blocked_at      since when
--
--    `blocked_at` is stamped by a trigger, so it is right for every path
--    into the table (PostgREST, psql, a future import) and not only the
--    one Server Action that knows about it. The reason itself is required
--    by the service door when a task moves to `blocked` — not by a CHECK
--    here, because a blocked task with no reason already exists and a
--    constraint the live data violates cannot be added.
--
-- 2. SCR-018 (All projects): pausing, resuming or cancelling a project
--    recorded nothing about why. `status_reason` and `status_changed_at`
--    live on the project row itself so the existing `audit_row_change`
--    trigger carries the reason in the audit row's `after` snapshot in the
--    same transaction as the status — one write, one trace.
--
-- Same authority as `tasks_write`: `core.can_write()` at every new door.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── projects.tasks: the blocker ──────────────────────────────────────────

alter table projects.tasks add column if not exists blocked_reason text;
alter table projects.tasks add column if not exists blocked_at timestamptz;

comment on column projects.tasks.blocked_reason is
  'Why the task is blocked (SCR-020/021). Required by the service when status becomes blocked; cleared with blocked_at when it leaves.';
comment on column projects.tasks.blocked_at is
  'When the task entered blocked. Stamped and cleared by tasks_stamp_blocked, never by the caller.';

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
  end if;
  return new;
end;
$$;

comment on function projects.stamp_task_blocked() is
  'Sets projects.tasks.blocked_at when a task enters blocked and clears blocked_at and blocked_reason when it leaves, whichever path wrote the row.';

drop trigger if exists tasks_stamp_blocked on projects.tasks;
create trigger tasks_stamp_blocked
  before insert or update of status, blocked_reason on projects.tasks
  for each row execute function projects.stamp_task_blocked();

-- ── projects.task_comments ───────────────────────────────────────────────

create table if not exists projects.task_comments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  author_id        uuid references core.users(id) on delete set null,
  body             text not null check (length(btrim(body)) between 1 and 4000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table projects.task_comments is
  'A note left on a task by a member of the delivery team — SCR-020/021/041. Append-only from the application; nothing edits or deletes one.';

create index if not exists task_comments_task_idx
  on projects.task_comments (task_id, created_at);
create index if not exists task_comments_organization_idx
  on projects.task_comments (organization_id, created_at desc);

drop trigger if exists set_updated_at on projects.task_comments;
create trigger set_updated_at before update on projects.task_comments
  for each row execute function core.set_updated_at();

alter table projects.task_comments enable row level security;
alter table projects.task_comments force row level security;

drop policy if exists task_comments_select on projects.task_comments;
create policy task_comments_select on projects.task_comments
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists task_comments_write on projects.task_comments;
create policy task_comments_write on projects.task_comments
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert on projects.task_comments to authenticated, service_role;

drop trigger if exists org_match_task_comments_task on projects.task_comments;
create trigger org_match_task_comments_task
  before insert or update of task_id, organization_id on projects.task_comments
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_task_comments on projects.task_comments;
create trigger freeze_org_task_comments
  before update of organization_id on projects.task_comments
  for each row execute function core.freeze_organization_id();

-- ── projects.task_checklist_items ────────────────────────────────────────

create table if not exists projects.task_checklist_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  label            text not null check (length(btrim(label)) between 1 and 300),
  position         integer not null default 0 check (position >= 0),
  done_at          timestamptz,
  done_by          uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Ticked by somebody, or not ticked: never one without the other.
  constraint task_checklist_items_done_pair check ((done_at is null) = (done_by is null))
);

comment on table projects.task_checklist_items is
  'The sub-steps a task is completed through — SCR-021/041. Each is ticked by a named person at a time; the task''s progress is the ticked share.';

create index if not exists task_checklist_items_task_idx
  on projects.task_checklist_items (task_id, position, created_at);
create index if not exists task_checklist_items_organization_idx
  on projects.task_checklist_items (organization_id, task_id);

drop trigger if exists set_updated_at on projects.task_checklist_items;
create trigger set_updated_at before update on projects.task_checklist_items
  for each row execute function core.set_updated_at();

alter table projects.task_checklist_items enable row level security;
alter table projects.task_checklist_items force row level security;

drop policy if exists task_checklist_items_select on projects.task_checklist_items;
create policy task_checklist_items_select on projects.task_checklist_items
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists task_checklist_items_write on projects.task_checklist_items;
create policy task_checklist_items_write on projects.task_checklist_items
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert, update, delete on projects.task_checklist_items to authenticated, service_role;

drop trigger if exists org_match_task_checklist_items_task on projects.task_checklist_items;
create trigger org_match_task_checklist_items_task
  before insert or update of task_id, organization_id on projects.task_checklist_items
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_task_checklist_items on projects.task_checklist_items;
create trigger freeze_org_task_checklist_items
  before update of organization_id on projects.task_checklist_items
  for each row execute function core.freeze_organization_id();

-- ── projects.task_attachments ────────────────────────────────────────────

create table if not exists projects.task_attachments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  task_id          uuid not null references projects.tasks(id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 200),
  url              text not null check (length(btrim(url)) between 1 and 2000),
  added_by         uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table projects.task_attachments is
  'A titled link attached to a task — SCR-020/041. A reference to where the file already lives, never a blob, the rule projects.project_files and projects.deliverables set.';

create index if not exists task_attachments_task_idx
  on projects.task_attachments (task_id, created_at);
create index if not exists task_attachments_organization_idx
  on projects.task_attachments (organization_id, task_id);

drop trigger if exists set_updated_at on projects.task_attachments;
create trigger set_updated_at before update on projects.task_attachments
  for each row execute function core.set_updated_at();

alter table projects.task_attachments enable row level security;
alter table projects.task_attachments force row level security;

drop policy if exists task_attachments_select on projects.task_attachments;
create policy task_attachments_select on projects.task_attachments
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists task_attachments_write on projects.task_attachments;
create policy task_attachments_write on projects.task_attachments
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert, update, delete on projects.task_attachments to authenticated, service_role;

drop trigger if exists org_match_task_attachments_task on projects.task_attachments;
create trigger org_match_task_attachments_task
  before insert or update of task_id, organization_id on projects.task_attachments
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

drop trigger if exists freeze_org_task_attachments on projects.task_attachments;
create trigger freeze_org_task_attachments
  before update of organization_id on projects.task_attachments
  for each row execute function core.freeze_organization_id();

-- ── projects.projects: why it was paused, resumed or cancelled ───────────

alter table projects.projects add column if not exists status_reason text
  check (status_reason is null or length(btrim(status_reason)) between 1 and 1000);
alter table projects.projects add column if not exists status_changed_at timestamptz;

comment on column projects.projects.status_reason is
  'Why the project was last moved to its current status (SCR-018). The service requires one for on_hold and cancelled; the audit row''s after snapshot carries it.';
comment on column projects.projects.status_changed_at is
  'When the current status was set through the status door. Null for rows that predate it.';
