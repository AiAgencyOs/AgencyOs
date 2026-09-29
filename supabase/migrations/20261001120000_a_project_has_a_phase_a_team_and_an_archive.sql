-- ═══════════════════════════════════════════════════════════════════════════
-- A project has a phase, a team and an archive.
--
-- Bucket F, stream F-C (docs/AGENCYOS_ADMIN_BUCKET_F_PLAN.md, "Stream F-C"):
-- the Projects, Requirements & Scope screens SCR-018–031 of the PDF, at
-- element level. Nine things, one migration, each the smallest honest
-- table or column the screen's element needs:
--
-- 1. ARCHIVE (SCR-018 "Archive completed project"). `projects.projects`
--    gains `archived_at` / `archived_by`, written only by
--    `projects.archive_project`, which refuses any project that is not
--    `completed` — an archive is where finished work goes, never a way to
--    hide an active one — and audits `project.archived`. The list hides
--    archived rows by default and shows them under `?archived=1`.
--
-- 2. PROJECT MEMBERS (SCR-025 "assign/remove member, set project role").
--    `projects.project_members`: who is on THIS project and in what role,
--    added by whom. Until now a person joined a project by being assigned a
--    task; that stays true and the Team page still lists everyone with a
--    task — this is the roster a PM chooses before the first task exists,
--    and the Board's assignee lists read from it, falling back to the
--    organisation roster when a project has no members. Write policy:
--    `core.can_manage_delivery()` (owner, ops_admin, delivery_lead — the
--    roles holding project.write). Audited on insert, update and delete.
--
-- 3. PROJECT LINKS (SCR-019 "Project links"). `projects.project_links`: a
--    labelled URL with a kind (repository, design, document, environment,
--    other). A link, never a copy — the same rule project_files set.
--
-- 4. PROJECT UPDATES (SCR-019 "Send project update"). `projects.project_
--    updates`: the body, who it went to (`client` — through the project's
--    WhatsApp group thread and `crm.send_outbound_message`, the ONE outbound
--    chokepoint, so consent and the 24-hour window decide — or `internal`,
--    recorded on the project for the team), who sent it, and the outbound
--    message's id when one went. A row is written only after the send
--    succeeded; a refused send leaves nothing here, so the list never
--    claims a client heard something they did not.
--
-- 5. TYPED EVIDENCE (SCR-020 "Link evidence"). `projects.task_attachments`
--    gains `kind` in {screenshot, log, url, file}, default `url` for every
--    row that exists — a generic attachment stays a URL until somebody says
--    what it is.
--
-- 6. FOLDERS (SCR-024 "Folder tree"). `projects.project_files` gains
--    `folder`, a slash-separated path inside the category (e.g.
--    `mockups/mobile`), empty for the category root. Rename/move is the
--    existing update door with the folder added; nothing is copied.
--
-- 7. CALENDAR FEED (SCR-022 "Sync supported calendars"). Without OAuth the
--    one honest sync is a subscribable ICS feed: `projects.calendar_feed_
--    tokens` holds a random token per person per project; the public route
--    `/api/projects/[id]/calendar.ics?token=…` resolves it through
--    `projects.resolve_calendar_feed` (SECURITY DEFINER, service_role only,
--    the share-link pattern of 20260930110000) and renders the project's
--    dated tasks, milestones and meetings. Revoking the row ends the feed.
--
-- 8. A CHANGE REQUEST IS BILLED AND PAID BEFORE IT IS APPLIED (SCR-031).
--    `projects.change_requests.invoice_id`; `finance.create_change_request_
--    invoice` raises a milestone-less invoice through the existing
--    `finance.create_milestone_invoice` door (lines and number computed by
--    the caller, as ever), links it to the request and audits
--    `change_request.invoiced`. `projects.apply_change_request` is
--    re-declared byte-for-byte with one addition: a `paid_change` refuses to
--    open the next baseline until its invoice is `paid` (`not_invoiced`,
--    `unpaid` are the two new outcomes). The proposal (ADM-22) prices it;
--    the invoice collects it; the apply happens after.
--
-- 9. SCOPE APPROVAL EVIDENCE (SCR-030 "Approval evidence"). `projects.scope_
--    versions` gains `approved_by` (the client's name as they signed),
--    `approved_at`, `approval_evidence_url`, `approval_note`, written by
--    `projects.record_scope_approval_evidence` on a frozen version only —
--    a draft has nothing to approve — and audited.
--
-- Plus `projects.add_unpriced_milestone` (SCR-022 "create milestone from a
-- day"): a milestone with no payment share, so the plan's 100% rule is
-- untouched, inserted at the next position with a name and a date; and
-- `projects.projects.template_id` + `projects.set_project_template`
-- (SCR-027 "template selection"): which saved template a project follows,
-- recorded when it is created from one and changeable on Settings.
--
-- Audit: `projects.record_stream_fc_change` — the D2 recorder's shape, its
-- own vocabulary, covering insert, update and delete for the four new
-- tables. The doors that are functions call `core.record_audit` inside
-- their own transaction.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the archive ───────────────────────────────────────────────────────

alter table projects.projects add column if not exists archived_at timestamptz;
alter table projects.projects add column if not exists archived_by uuid references core.users(id) on delete set null;
alter table projects.projects add column if not exists template_id uuid references projects.project_templates(id) on delete set null;

alter table projects.projects drop constraint if exists projects_archived_is_completed;
alter table projects.projects add constraint projects_archived_is_completed
  check (archived_at is null or status = 'completed');

create index if not exists projects_archived_idx
  on projects.projects (organization_id, archived_at) where archived_at is not null;

comment on column projects.projects.archived_at is
  'SCR-018. Set by projects.archive_project on a completed project only; the list hides archived rows unless asked. Null means live.';
comment on column projects.projects.template_id is
  'SCR-027. The saved template this project follows — recorded when it was created from one, changeable on Settings. Informational: nothing is re-applied when it changes.';

drop trigger if exists org_match_projects_template on projects.projects;
create trigger org_match_projects_template
  before insert or update of template_id, organization_id on projects.projects
  for each row execute function core.enforce_parent_org('template_id', 'projects.project_templates');

create or replace function projects.archive_project(p_project_id uuid, p_reason text default null)
returns table (outcome text, archived_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project projects.projects%rowtype;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::timestamptz;
    return;
  end if;

  select * into v_project
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = (select core.current_organization_id())
     and p.deleted_at is null
     for update;

  if not found then
    return query select 'not_found'::text, null::timestamptz;
    return;
  end if;
  if v_project.archived_at is not null then
    return query select 'already_archived'::text, v_project.archived_at;
    return;
  end if;
  if v_project.status <> 'completed' then
    return query select 'not_completed'::text, null::timestamptz;
    return;
  end if;

  update projects.projects
     set archived_at = now(),
         archived_by = auth.uid(),
         updated_at  = now()
   where id = v_project.id;

  perform core.record_audit(
    v_project.organization_id,
    'project.archived',
    'project',
    v_project.id,
    jsonb_build_object('status', v_project.status, 'archived_at', null),
    jsonb_build_object('status', v_project.status, 'archived_at', now(), 'reason', p_reason)
  );

  return query select 'archived'::text, now()::timestamptz;
end;
$$;

comment on function projects.archive_project(uuid, text) is
  'SCR-018. Archives a COMPLETED project: sets archived_at/by and audits project.archived. Refuses any other status (not_completed) — an archive is where finished work goes. can_manage_delivery() only.';

revoke all on function projects.archive_project(uuid, text) from public, anon;
grant execute on function projects.archive_project(uuid, text) to authenticated, service_role;

create or replace function projects.set_project_template(p_project_id uuid, p_template_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project projects.projects%rowtype;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text;
    return;
  end if;

  select * into v_project
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = (select core.current_organization_id())
     and p.deleted_at is null
     for update;
  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  if p_template_id is not null and not exists (
    select 1 from projects.project_templates t
     where t.id = p_template_id and t.organization_id = v_project.organization_id
  ) then
    return query select 'unknown_template'::text;
    return;
  end if;

  update projects.projects
     set template_id = p_template_id, updated_at = now()
   where id = v_project.id;

  perform core.record_audit(
    v_project.organization_id,
    'project.template_set',
    'project',
    v_project.id,
    jsonb_build_object('template_id', v_project.template_id),
    jsonb_build_object('template_id', p_template_id)
  );

  return query select 'set'::text;
end;
$$;

comment on function projects.set_project_template(uuid, uuid) is
  'SCR-027. Records which saved template a project follows (or clears it with null). Informational — nothing is re-applied. can_manage_delivery() only; audited project.template_set.';

revoke all on function projects.set_project_template(uuid, uuid) from public, anon;
grant execute on function projects.set_project_template(uuid, uuid) to authenticated, service_role;

-- ── 2. projects.project_members ──────────────────────────────────────────

create table if not exists projects.project_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,
  project_role     text not null default 'contributor' check (project_role in (
                     'project_manager', 'designer', 'developer', 'qa', 'contributor', 'observer'
                   )),
  added_by         uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, user_id)
);

comment on table projects.project_members is
  'SCR-025. Who is on a project and in what role — the roster a PM chooses. The Board''s assignee lists read from it and fall back to the organisation roster when a project has none. A person with a task but no row here is still shown on the Team page: membership never hides work.';

create index if not exists project_members_project_idx on projects.project_members (project_id, project_role);
create index if not exists project_members_organization_idx on projects.project_members (organization_id, user_id);

drop trigger if exists set_updated_at on projects.project_members;
create trigger set_updated_at before update on projects.project_members
  for each row execute function core.set_updated_at();

alter table projects.project_members enable row level security;
alter table projects.project_members force row level security;

drop policy if exists project_members_select on projects.project_members;
create policy project_members_select on projects.project_members
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists project_members_write on projects.project_members;
create policy project_members_write on projects.project_members
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

grant select, insert, update, delete on projects.project_members to authenticated, service_role;

drop trigger if exists org_match_project_members_project on projects.project_members;
create trigger org_match_project_members_project
  before insert or update of project_id, organization_id on projects.project_members
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_project_members on projects.project_members;
create trigger freeze_org_project_members
  before update of organization_id on projects.project_members
  for each row execute function core.freeze_organization_id();

-- A member must hold a membership in the same organisation: a project roster
-- names people who are on the team, never an arbitrary user id.
create or replace function projects.check_project_member_is_internal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from core.memberships m
     where m.user_id = new.user_id
       and m.organization_id = new.organization_id
       and m.status = 'active'
       and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor')
  ) then
    raise exception 'a project member must hold an active internal membership in the same organisation';
  end if;
  return new;
end;
$$;

drop trigger if exists project_members_check_membership on projects.project_members;
create trigger project_members_check_membership
  before insert or update of user_id, organization_id on projects.project_members
  for each row execute function projects.check_project_member_is_internal();

-- ── 3. projects.project_links ────────────────────────────────────────────

create table if not exists projects.project_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  label            text not null check (length(btrim(label)) between 1 and 120),
  url              text not null check (length(btrim(url)) between 1 and 2000),
  kind             text not null default 'other' check (kind in (
                     'repository', 'design', 'document', 'environment', 'tracker', 'other'
                   )),
  added_by         uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table projects.project_links is
  'SCR-019. A labelled link on the project overview — where the repo, the Figma, the staging site or the brief lives. A reference, never a copy.';

create index if not exists project_links_project_idx on projects.project_links (project_id, kind, created_at);
create index if not exists project_links_organization_idx on projects.project_links (organization_id, project_id);

drop trigger if exists set_updated_at on projects.project_links;
create trigger set_updated_at before update on projects.project_links
  for each row execute function core.set_updated_at();

alter table projects.project_links enable row level security;
alter table projects.project_links force row level security;

drop policy if exists project_links_select on projects.project_links;
create policy project_links_select on projects.project_links
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists project_links_write on projects.project_links;
create policy project_links_write on projects.project_links
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert, update, delete on projects.project_links to authenticated, service_role;

drop trigger if exists org_match_project_links_project on projects.project_links;
create trigger org_match_project_links_project
  before insert or update of project_id, organization_id on projects.project_links
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_project_links on projects.project_links;
create trigger freeze_org_project_links
  before update of organization_id on projects.project_links
  for each row execute function core.freeze_organization_id();

-- ── 4. projects.project_updates ──────────────────────────────────────────

create table if not exists projects.project_updates (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  body             text not null check (length(btrim(body)) between 1 and 4000),
  sent_to          text not null check (sent_to in ('client', 'internal')),
  sent_by          uuid references core.users(id) on delete set null,
  conversation_id  uuid references crm.conversations(id) on delete set null,
  message_id       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A client update names the thread and the message that carried it. An
  -- internal one is a note on the project and names neither.
  constraint project_updates_client_names_message
    check (sent_to <> 'client' or (conversation_id is not null and message_id is not null))
);

comment on table projects.project_updates is
  'SCR-019. A project update a person sent: to the client through the project''s WhatsApp group (crm.send_outbound_message decided consent and the window; message_id is that row), or internally as a note on the project. Written only after the send succeeded.';

create index if not exists project_updates_project_idx on projects.project_updates (project_id, created_at desc);
create index if not exists project_updates_organization_idx on projects.project_updates (organization_id, created_at desc);

drop trigger if exists set_updated_at on projects.project_updates;
create trigger set_updated_at before update on projects.project_updates
  for each row execute function core.set_updated_at();

alter table projects.project_updates enable row level security;
alter table projects.project_updates force row level security;

drop policy if exists project_updates_select on projects.project_updates;
create policy project_updates_select on projects.project_updates
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists project_updates_insert on projects.project_updates;
create policy project_updates_insert on projects.project_updates
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

grant select, insert on projects.project_updates to authenticated, service_role;

drop trigger if exists org_match_project_updates_project on projects.project_updates;
create trigger org_match_project_updates_project
  before insert or update of project_id, organization_id on projects.project_updates
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_project_updates_conversation on projects.project_updates;
create trigger org_match_project_updates_conversation
  before insert or update of conversation_id, organization_id on projects.project_updates
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists freeze_org_project_updates on projects.project_updates;
create trigger freeze_org_project_updates
  before update of organization_id on projects.project_updates
  for each row execute function core.freeze_organization_id();

-- ── 5. typed evidence on a task ──────────────────────────────────────────

alter table projects.task_attachments add column if not exists kind text not null default 'url';
alter table projects.task_attachments drop constraint if exists task_attachments_kind_check;
alter table projects.task_attachments add constraint task_attachments_kind_check
  check (kind in ('screenshot', 'log', 'url', 'file'));

comment on column projects.task_attachments.kind is
  'SCR-020. What the link is evidence of: screenshot, log, url or file. Default url — an attachment nobody typed stays a plain link.';

-- ── 6. a folder inside a category ────────────────────────────────────────

alter table projects.project_files add column if not exists folder text not null default '';
alter table projects.project_files drop constraint if exists project_files_folder_shape;
alter table projects.project_files add constraint project_files_folder_shape
  check (folder = '' or (length(folder) <= 200 and folder !~ '(^/|/$|//|\.\.)'));

comment on column projects.project_files.folder is
  'SCR-024. A slash-separated path inside the category (mockups/mobile). Empty is the category root. Rename/move is the existing update door.';

-- ── 7. the calendar feed ─────────────────────────────────────────────────

create table if not exists projects.calendar_feed_tokens (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,
  token            text not null unique check (length(token) between 32 and 128),
  revoked_at       timestamptz,
  last_fetched_at  timestamptz,
  fetch_count      integer not null default 0 check (fetch_count >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table projects.calendar_feed_tokens is
  'SCR-022. A subscribable ICS feed of one project''s dated tasks, milestones and meetings, keyed by a random token per person. Resolved by projects.resolve_calendar_feed for the public route; revoking the row ends the feed. The honest "sync" without OAuth.';

create index if not exists calendar_feed_tokens_project_idx on projects.calendar_feed_tokens (project_id, user_id);
create index if not exists calendar_feed_tokens_organization_idx on projects.calendar_feed_tokens (organization_id, project_id);

drop trigger if exists set_updated_at on projects.calendar_feed_tokens;
create trigger set_updated_at before update on projects.calendar_feed_tokens
  for each row execute function core.set_updated_at();

alter table projects.calendar_feed_tokens enable row level security;
alter table projects.calendar_feed_tokens force row level security;

drop policy if exists calendar_feed_tokens_select on projects.calendar_feed_tokens;
create policy calendar_feed_tokens_select on projects.calendar_feed_tokens
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal())
         and user_id = (select auth.uid()));

-- One's own feed only: a token is a credential, and a colleague's is not
-- yours to read, make or revoke.
drop policy if exists calendar_feed_tokens_write on projects.calendar_feed_tokens;
create policy calendar_feed_tokens_write on projects.calendar_feed_tokens
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()) and user_id = (select auth.uid()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_internal()) and user_id = (select auth.uid()));

grant select, insert, update on projects.calendar_feed_tokens to authenticated, service_role;

drop trigger if exists org_match_calendar_feed_tokens_project on projects.calendar_feed_tokens;
create trigger org_match_calendar_feed_tokens_project
  before insert or update of project_id, organization_id on projects.calendar_feed_tokens
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_calendar_feed_tokens on projects.calendar_feed_tokens;
create trigger freeze_org_calendar_feed_tokens
  before update of organization_id on projects.calendar_feed_tokens
  for each row execute function core.freeze_organization_id();

create or replace function projects.resolve_calendar_feed(p_token text)
returns table (project_id uuid, organization_id uuid, project_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row projects.calendar_feed_tokens%rowtype;
  v_project projects.projects%rowtype;
begin
  if p_token is null or length(p_token) < 32 then
    return;
  end if;

  select * into v_row from projects.calendar_feed_tokens t where t.token = p_token;
  if not found then return; end if;
  if v_row.revoked_at is not null then return; end if;

  select * into v_project from projects.projects p where p.id = v_row.project_id;
  if not found then return; end if;
  if v_project.deleted_at is not null then return; end if;

  update projects.calendar_feed_tokens t
     set fetch_count = t.fetch_count + 1,
         last_fetched_at = now()
   where t.id = v_row.id;

  return query select v_project.id, v_project.organization_id, v_project.name;
end;
$$;

comment on function projects.resolve_calendar_feed(text) is
  'Resolves a calendar feed token to its project, or nothing when unknown or revoked. service_role only: the public ICS route calls it; the fetch count is the only trace.';

revoke all on function projects.resolve_calendar_feed(text) from public, anon, authenticated;
grant execute on function projects.resolve_calendar_feed(text) to service_role;

-- ── 8. a change request is billed, and paid before it is applied ─────────

alter table projects.change_requests add column if not exists invoice_id uuid references finance.invoices(id) on delete set null;

create index if not exists change_requests_invoice_idx
  on projects.change_requests (invoice_id) where invoice_id is not null;

comment on column projects.change_requests.invoice_id is
  'SCR-031. The invoice raised for a paid change through finance.create_change_request_invoice. apply_change_request refuses a paid change until this invoice is paid.';

drop trigger if exists org_match_change_requests_invoice on projects.change_requests;
create trigger org_match_change_requests_invoice
  before insert or update of invoice_id, organization_id on projects.change_requests
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

create or replace function finance.create_change_request_invoice(
  p_change_request_id uuid,
  p_number            text,
  p_currency          char(3),
  p_subtotal_minor    bigint,
  p_tax_minor         bigint,
  p_total_minor       bigint,
  p_lines             jsonb,
  p_billing_profile_id uuid default null,
  p_due_at            timestamptz default null,
  p_notes             text default null
)
returns table (outcome text, invoice_id uuid, number text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cr      projects.change_requests%rowtype;
  v_project projects.projects%rowtype;
  v_created record;
begin
  -- invoice.create's two roles, the same pair invoices_write admits.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid, null::text;
    return;
  end if;

  select * into v_cr
    from projects.change_requests cr
   where cr.id = p_change_request_id
     and cr.organization_id = (select core.current_organization_id())
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_cr.classification is distinct from 'paid_change' then
    return query select 'not_billable'::text, null::uuid, null::text;
    return;
  end if;
  if v_cr.status not in ('classified', 'pending_approval', 'approved') then
    return query select 'wrong_state'::text, null::uuid, null::text;
    return;
  end if;
  if v_cr.proposal_id is null then
    return query select 'no_proposal'::text, null::uuid, null::text;
    return;
  end if;

  -- Already billed, and the bill is live: that invoice is the answer.
  if v_cr.invoice_id is not null and exists (
    select 1 from finance.invoices i where i.id = v_cr.invoice_id and i.status <> 'void'
  ) then
    return query
      select 'already_invoiced'::text, i.id, i.number
        from finance.invoices i where i.id = v_cr.invoice_id;
    return;
  end if;

  select * into v_project from projects.projects p where p.id = v_cr.project_id;
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  select * into v_created
    from finance.create_milestone_invoice(
      v_project.organization_id,
      v_project.client_account_id,
      v_project.id,
      null,                 -- no milestone: the change request is the reason
      p_number,
      p_currency,
      p_subtotal_minor,
      p_tax_minor,
      p_total_minor,
      p_lines,
      p_due_at,
      p_notes,
      p_billing_profile_id
    );

  if v_created.outcome <> 'created' then
    return query select v_created.outcome, v_created.invoice_id, v_created.number;
    return;
  end if;

  update projects.change_requests
     set invoice_id = v_created.invoice_id,
         updated_at = now()
   where id = v_cr.id;

  perform core.record_audit(
    v_cr.organization_id,
    'change_request.invoiced',
    'change_request',
    v_cr.id,
    jsonb_build_object('invoice_id', v_cr.invoice_id),
    jsonb_build_object('invoice_id', v_created.invoice_id, 'number', v_created.number, 'total_minor', p_total_minor, 'proposal_id', v_cr.proposal_id)
  );

  return query select 'created'::text, v_created.invoice_id, v_created.number;
end;
$$;

comment on function finance.create_change_request_invoice(uuid, text, char, bigint, bigint, bigint, jsonb, uuid, timestamptz, text) is
  'SCR-031 "Trigger finance". Raises a milestone-less invoice for a paid change request through finance.create_milestone_invoice (lines and number computed by the caller, as ever), links it to the request and audits change_request.invoiced. Refuses an unclassified, unpriced (no proposal — ADM-22) or already-billed request. is_admin() only — invoice.create''s roles.';

revoke all on function finance.create_change_request_invoice(uuid, text, char, bigint, bigint, bigint, jsonb, uuid, timestamptz, text) from public, anon;
grant execute on function finance.create_change_request_invoice(uuid, text, char, bigint, bigint, bigint, jsonb, uuid, timestamptz, text) to authenticated, service_role;

-- apply_change_request, re-declared with the payment gate. Everything else
-- is 20260921190000's body unchanged.
create or replace function projects.apply_change_request(p_change_request_id uuid)
returns table (outcome text, scope_version_id uuid, version int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project        uuid;
  v_status         text;
  v_classification text;
  v_invoice        uuid;
  v_invoice_status text;
  v_active         uuid;
  v_new            uuid;
  v_version        int;
  v_opened         record;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid, null::int;
    return;
  end if;

  select cr.project_id, cr.status, cr.classification, cr.invoice_id
    into v_project, v_status, v_classification, v_invoice
    from projects.change_requests cr
   where cr.id = p_change_request_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::int;
    return;
  end if;

  if v_status <> 'approved' then
    return query select 'not_approved'::text, null::uuid, null::int;
    return;
  end if;

  -- SCR-031 "Implement after payment where required": a paid change opens
  -- the next baseline only once its invoice is paid.
  if v_classification = 'paid_change' then
    if v_invoice is null then
      return query select 'not_invoiced'::text, null::uuid, null::int;
      return;
    end if;
    select i.status into v_invoice_status from finance.invoices i where i.id = v_invoice;
    if v_invoice_status is null or v_invoice_status = 'void' then
      return query select 'not_invoiced'::text, null::uuid, null::int;
      return;
    end if;
    if v_invoice_status <> 'paid' then
      return query select 'unpaid'::text, null::uuid, null::int;
      return;
    end if;
  end if;

  select sv.id into v_active
    from projects.scope_versions sv
   where sv.project_id = v_project and sv.status = 'active';

  if v_active is null then
    return query select 'no_baseline'::text, null::uuid, null::int;
    return;
  end if;

  select * into v_opened
    from projects.open_scope_version(v_project, 'change_request', null, p_change_request_id);

  if v_opened.outcome <> 'opened' then
    return query select v_opened.outcome, null::uuid, null::int;
    return;
  end if;

  v_new     := v_opened.scope_version_id;
  v_version := v_opened.version;

  insert into projects.scope_items (
    organization_id, scope_version_id, feature_id, title, detail,
    inclusion, acceptance_criteria, position
  )
  select si.organization_id, v_new, si.feature_id, si.title, si.detail,
         si.inclusion, si.acceptance_criteria, si.position
    from projects.scope_items si
   where si.scope_version_id = v_active;

  update projects.change_requests
     set resulting_scope_version_id = v_new,
         status     = 'implemented',
         updated_at = now()
   where id = p_change_request_id;

  return query select 'opened'::text, v_new, v_version;
end;
$$;

comment on function projects.apply_change_request(uuid) is
  'Opens the next baseline by COPYING the active one, so the frozen version is never touched (Doc 11 section 29). Refuses a request that is not approved, and — since 20261001120000 — a paid change whose invoice is missing (not_invoiced) or not yet paid (unpaid). can_manage_delivery() only.';

-- ── 9. scope approval evidence ───────────────────────────────────────────

alter table projects.scope_versions add column if not exists approved_by text check (approved_by is null or length(btrim(approved_by)) between 1 and 200);
alter table projects.scope_versions add column if not exists approved_at timestamptz;
alter table projects.scope_versions add column if not exists approval_evidence_url text check (approval_evidence_url is null or length(btrim(approval_evidence_url)) between 1 and 2000);
alter table projects.scope_versions add column if not exists approval_note text check (approval_note is null or length(btrim(approval_note)) <= 1000);

alter table projects.scope_versions drop constraint if exists scope_versions_approval_pair;
alter table projects.scope_versions add constraint scope_versions_approval_pair
  check ((approved_by is null) = (approved_at is null));

comment on column projects.scope_versions.approval_evidence_url is
  'SCR-030. Where the client''s approval of this baseline is recorded — a signed PDF, a message link. Written by projects.record_scope_approval_evidence on a frozen version only.';

create or replace function projects.record_scope_approval_evidence(
  p_scope_version_id uuid,
  p_approved_by      text,
  p_evidence_url     text default null,
  p_note             text default null
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sv projects.scope_versions%rowtype;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text;
    return;
  end if;

  select * into v_sv
    from projects.scope_versions sv
   where sv.id = p_scope_version_id
     and sv.organization_id = (select core.current_organization_id())
     for update;
  if not found then
    return query select 'not_found'::text;
    return;
  end if;
  if v_sv.status = 'draft' then
    return query select 'not_frozen'::text;
    return;
  end if;
  if p_approved_by is null or length(btrim(p_approved_by)) = 0 then
    return query select 'no_approver'::text;
    return;
  end if;

  update projects.scope_versions
     set approved_by = btrim(p_approved_by),
         approved_at = coalesce(v_sv.approved_at, now()),
         approval_evidence_url = nullif(btrim(coalesce(p_evidence_url, '')), ''),
         approval_note = nullif(btrim(coalesce(p_note, '')), ''),
         updated_at = now()
   where id = v_sv.id;

  perform core.record_audit(
    v_sv.organization_id,
    'scope_version.approval_recorded',
    'scope_version',
    v_sv.id,
    jsonb_build_object('approved_by', v_sv.approved_by, 'approval_evidence_url', v_sv.approval_evidence_url),
    jsonb_build_object('approved_by', btrim(p_approved_by), 'approval_evidence_url', p_evidence_url, 'approval_note', p_note)
  );

  return query select 'recorded'::text;
end;
$$;

comment on function projects.record_scope_approval_evidence(uuid, text, text, text) is
  'SCR-030 "Approval evidence". Records who approved a FROZEN baseline and where the evidence lives. A draft has nothing to approve (not_frozen). can_manage_delivery() only; audited scope_version.approval_recorded.';

revoke all on function projects.record_scope_approval_evidence(uuid, text, text, text) from public, anon;
grant execute on function projects.record_scope_approval_evidence(uuid, text, text, text) to authenticated, service_role;

-- ── 10. a milestone from a day, with no payment share ────────────────────

create or replace function projects.add_unpriced_milestone(
  p_project_id uuid,
  p_name       text,
  p_due_on     date default null
)
returns table (outcome text, milestone_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project projects.projects%rowtype;
  v_id      uuid;
  v_next    int;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid;
    return;
  end if;
  if p_name is null or length(btrim(p_name)) = 0 then
    return query select 'no_name'::text, null::uuid;
    return;
  end if;

  select * into v_project
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = (select core.current_organization_id())
     and p.deleted_at is null
     for update;
  if not found then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  select coalesce(max(m.position), 0) + 1 into v_next
    from projects.milestones m where m.project_id = v_project.id;

  insert into projects.milestones (
    organization_id, project_id, name, position, status, currency, amount_minor, payment_percent, due_on
  )
  values (
    v_project.organization_id, v_project.id, btrim(p_name), v_next, 'pending', v_project.currency, 0, null, p_due_on
  )
  returning id into v_id;

  perform core.record_audit(
    v_project.organization_id,
    'milestone.added_unpriced',
    'milestone',
    v_id,
    null,
    jsonb_build_object('project_id', v_project.id, 'name', btrim(p_name), 'due_on', p_due_on, 'position', v_next)
  );

  return query select 'added'::text, v_id;
end;
$$;

comment on function projects.add_unpriced_milestone(uuid, text, date) is
  'SCR-022 "create a milestone from a day". Inserts a milestone with NO payment share (payment_percent null, amount 0) at the next position, so the payment plan''s 100% rule is untouched and nothing is billed for it. can_manage_delivery() only; audited milestone.added_unpriced.';

revoke all on function projects.add_unpriced_milestone(uuid, text, date) from public, anon;
grant execute on function projects.add_unpriced_milestone(uuid, text, date) to authenticated, service_role;

-- ── audit for the four new tables ────────────────────────────────────────

create or replace function projects.record_stream_fc_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before  jsonb;
  v_after   jsonb;
  v_org     uuid;
  v_id      uuid;
  v_subject text;
  v_action  text;
begin
  if tg_op = 'DELETE' then
    v_before := to_jsonb(old);
    v_after  := null;
    v_org    := old.organization_id;
    v_id     := old.id;
  else
    v_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
    v_after  := to_jsonb(new);
    v_org    := new.organization_id;
    v_id     := new.id;
  end if;

  case tg_table_name
    when 'project_members' then
      v_subject := 'project_member';
      v_action := case tg_op when 'INSERT' then 'project_member.added' when 'UPDATE' then 'project_member.role_set' else 'project_member.removed' end;

    when 'project_links' then
      v_subject := 'project_link';
      v_action := case tg_op when 'INSERT' then 'project_link.added' when 'UPDATE' then 'project_link.updated' else 'project_link.removed' end;

    when 'project_updates' then
      v_subject := 'project_update';
      v_action := case tg_op when 'INSERT' then 'project_update.sent' else 'project_update.updated' end;

    when 'calendar_feed_tokens' then
      v_subject := 'calendar_feed_token';
      v_action :=
        case
          when tg_op = 'INSERT' then 'calendar_feed_token.created'
          when tg_op = 'UPDATE' and new.revoked_at is not null and old.revoked_at is null then 'calendar_feed_token.revoked'
          when tg_op = 'UPDATE' and new.fetch_count <> old.fetch_count then 'calendar_feed_token.fetched'
          else 'calendar_feed_token.updated'
        end;
      -- The token is a credential; the audit row must not carry it.
      v_before := case when v_before is null then null else v_before - 'token' end;
      v_after  := case when v_after  is null then null else v_after  - 'token' end;

    else
      raise exception 'projects.record_stream_fc_change: no vocabulary for table %', tg_table_name;
  end case;

  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    v_action,
    v_subject,
    v_id,
    v_before,
    v_after
  );

  return null;
end;
$$;

comment on function projects.record_stream_fc_change() is
  'Writes audit.audit_log for project_members, project_links, project_updates and calendar_feed_tokens inside the transaction that changed the row. Same actor rule as audit.record_row_change; the feed token itself is stripped from the snapshots.';

drop trigger if exists audit_row_change on projects.project_members;
create trigger audit_row_change after insert or update or delete on projects.project_members
  for each row execute function projects.record_stream_fc_change();

drop trigger if exists audit_row_change on projects.project_links;
create trigger audit_row_change after insert or update or delete on projects.project_links
  for each row execute function projects.record_stream_fc_change();

drop trigger if exists audit_row_change on projects.project_updates;
create trigger audit_row_change after insert or update on projects.project_updates
  for each row execute function projects.record_stream_fc_change();

drop trigger if exists audit_row_change on projects.calendar_feed_tokens;
create trigger audit_row_change after insert or update on projects.calendar_feed_tokens
  for each row execute function projects.record_stream_fc_change();

notify pgrst, 'reload schema';
