-- An announcement belongs to a project, a retry says why, and email is a lane —
-- theme W5, SCR-057 (Communication Center), SCR-059 (Templates & Announcements),
-- SCR-060 (Delivery Failures).
--
-- From docs/pdf-gap/D.md:
--
--   SCR-059 "Audience/project selection" and "Announcements are recorded
--   against project/client timelines" (MISSING): crm.announcements gains
--   project_id and client_account_id. The project's Activity feed and the
--   client's 360 read the rows that name them.
--   SCR-059 "reusable client update formats" / §7 "Announcement templates"
--   (MISSING): crm.announcement_templates, written through an owner-only
--   door. A template may be a general one or the milestone template.
--   SCR-059 "project milestone announcements" (MISSING): when a client-visible
--   milestone is met and the owner has an active milestone template, a DRAFT
--   announcement is prepared from it (naming the project, the client and the
--   milestone). Publishing stays the owner's act; nothing is sent.
--   SCR-060 "Requeue dead delivery with reason" (PARTIAL): the failed-delivery
--   retry takes a reason, kept in crm.delivery_retry_reasons through
--   crm.requeue_failed_delivery.
--   SCR-057 "across WhatsApp, email, announcements, client updates" (PARTIAL):
--   crm.outbound_emails is the email and client-update lane — what was
--   written, to whom, by which transport, whether the provider accepted it,
--   and why a failed one was sent again.
--
-- Every table: organization_id, RLS enabled and forced, internal select, no
-- write grant to authenticated; the doors re-check the role and audit.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. an announcement names its project and client
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.announcements
  add column if not exists project_id        uuid references projects.projects(id) on delete set null,
  add column if not exists client_account_id uuid references core.client_accounts(id) on delete set null,
  add column if not exists template_id       uuid,
  add column if not exists milestone_id      uuid references projects.milestones(id) on delete set null,
  add column if not exists source            text not null default 'manual';

alter table crm.announcements drop constraint if exists announcements_source_named;
alter table crm.announcements
  add constraint announcements_source_named check (source in ('manual', 'milestone'));

comment on column crm.announcements.project_id is
  'SCR-059: the project this announcement is about. It is recorded on that project''s activity timeline. Null means agency-wide.';
comment on column crm.announcements.client_account_id is
  'SCR-059: the client this announcement is for — taken from the project when one is named, or chosen alone. It is recorded on that client''s 360. Null means not addressed to one client.';
comment on column crm.announcements.milestone_id is
  'SCR-059: the milestone whose being met drafted this announcement (source = milestone).';

create index if not exists announcements_project_idx
  on crm.announcements (organization_id, project_id, published_at desc) where project_id is not null;
create index if not exists announcements_client_idx
  on crm.announcements (organization_id, client_account_id, published_at desc) where client_account_id is not null;

drop trigger if exists org_match_announcements_project on crm.announcements;
create trigger org_match_announcements_project
  before insert or update of project_id, organization_id on crm.announcements
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_announcements_client on crm.announcements;
create trigger org_match_announcements_client
  before insert or update of client_account_id, organization_id on crm.announcements
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. reusable announcement formats
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.announcement_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 120),
  kind            text not null default 'general' check (kind in ('general', 'milestone')),
  audience        text not null check (audience in ('internal', 'clients')),
  title_template  text not null check (length(btrim(title_template)) between 1 and 160),
  body_template   text not null check (length(btrim(body_template)) between 1 and 5000),
  active          boolean not null default true,
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table crm.announcement_templates is
  'SCR-059 / §7 "Announcement templates": a reusable title and body with {{project}}, {{client}}, {{milestone}} and {{due}} placeholders. A template of kind milestone, while active, drafts an announcement each time a client-visible milestone is met. Owner-written through crm.save_announcement_template; archived by setting active false, never deleted.';

create unique index if not exists announcement_templates_name_key
  on crm.announcement_templates (organization_id, lower(name));

drop trigger if exists set_updated_at on crm.announcement_templates;
create trigger set_updated_at before update on crm.announcement_templates
  for each row execute function core.set_updated_at();

alter table crm.announcement_templates enable row level security;
alter table crm.announcement_templates force row level security;

drop policy if exists announcement_templates_select on crm.announcement_templates;
create policy announcement_templates_select on crm.announcement_templates
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists freeze_org_announcement_templates on crm.announcement_templates;
create trigger freeze_org_announcement_templates
  before update of organization_id on crm.announcement_templates
  for each row execute function core.freeze_organization_id();

grant select on crm.announcement_templates to authenticated, service_role;

alter table crm.announcements drop constraint if exists announcements_template_fkey;
alter table crm.announcements
  add constraint announcements_template_fkey foreign key (template_id)
  references crm.announcement_templates(id) on delete set null;

-- The one renderer, so the page and the trigger say the same words.
create or replace function crm.render_announcement_text(
  p_text text, p_project text, p_client text, p_milestone text, p_due text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(coalesce(p_text, ''),
    '{{project}}',   coalesce(p_project, '')),
    '{{client}}',    coalesce(p_client, '')),
    '{{milestone}}', coalesce(p_milestone, '')),
    '{{due}}',       coalesce(p_due, ''));
$$;

revoke all on function crm.render_announcement_text(text, text, text, text, text) from public, anon;
grant execute on function crm.render_announcement_text(text, text, text, text, text) to authenticated, service_role;

create or replace function crm.save_announcement_template(
  p_template_id    uuid,
  p_name           text,
  p_kind           text,
  p_audience       text,
  p_title_template text,
  p_body_template  text,
  p_active         boolean default true
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_name  text := btrim(coalesce(p_name, ''));
  v_title text := btrim(coalesce(p_title_template, ''));
  v_body  text := btrim(coalesce(p_body_template, ''));
  v_before jsonb;
  v_id    uuid := p_template_id;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  -- Owner only, as the announcements themselves are.
  if not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if length(v_name) = 0 or length(v_name) > 120 then
    return query select 'bad_name'::text, null::uuid; return;
  end if;
  if p_kind not in ('general', 'milestone') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if p_audience not in ('internal', 'clients') then
    return query select 'bad_audience'::text, null::uuid; return;
  end if;
  if length(v_title) = 0 or length(v_title) > 160 or length(v_body) = 0 or length(v_body) > 5000 then
    return query select 'bad_text'::text, null::uuid; return;
  end if;

  begin
    if v_id is null then
      insert into crm.announcement_templates (organization_id, name, kind, audience, title_template, body_template, active, created_by)
      values (v_org, v_name, p_kind, p_audience, v_title, v_body, coalesce(p_active, true), v_actor)
      returning crm.announcement_templates.id into v_id;
      perform core.record_audit(v_org, 'announcement_template.created', 'announcement_template', v_id, null,
        jsonb_build_object('name', v_name, 'kind', p_kind, 'audience', p_audience));
      return query select 'created'::text, v_id; return;
    end if;

    select to_jsonb(t) into v_before from crm.announcement_templates t
     where t.id = v_id and t.organization_id = v_org for update;
    if v_before is null then
      return query select 'not_found'::text, null::uuid; return;
    end if;

    update crm.announcement_templates
       set name = v_name, kind = p_kind, audience = p_audience,
           title_template = v_title, body_template = v_body, active = coalesce(p_active, true)
     where crm.announcement_templates.id = v_id;
    perform core.record_audit(v_org, 'announcement_template.updated', 'announcement_template', v_id, v_before,
      jsonb_build_object('name', v_name, 'kind', p_kind, 'audience', p_audience, 'active', coalesce(p_active, true)));
    return query select 'updated'::text, v_id;
  exception
    when unique_violation then
      return query select 'name_taken'::text, null::uuid;
  end;
end;
$$;

comment on function crm.save_announcement_template(uuid, text, text, text, text, text, boolean) is
  'SCR-059: creates (id null) or updates an announcement template; active false archives it. Owner only. Audits announcement_template.created / .updated.';

revoke all on function crm.save_announcement_template(uuid, text, text, text, text, text, boolean) from public, anon;
grant execute on function crm.save_announcement_template(uuid, text, text, text, text, text, boolean) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. drafting an announcement against a project or client
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.create_announcement(
  p_title              text,
  p_body               text,
  p_audience           text,
  p_project_id         uuid default null,
  p_client_account_id  uuid default null,
  p_template_id        uuid default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_title  text := btrim(coalesce(p_title, ''));
  v_body   text := btrim(coalesce(p_body, ''));
  v_client uuid := p_client_account_id;
  v_proj_client uuid;
  v_new    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if length(v_title) = 0 or length(v_title) > 160 then
    return query select 'bad_title'::text, null::uuid; return;
  end if;
  if length(v_body) = 0 or length(v_body) > 5000 then
    return query select 'bad_body'::text, null::uuid; return;
  end if;
  if p_audience not in ('internal', 'clients') then
    return query select 'bad_audience'::text, null::uuid; return;
  end if;

  if p_project_id is not null then
    select p.client_account_id into v_proj_client from projects.projects p
     where p.id = p_project_id and p.organization_id = v_org;
    if not found then
      return query select 'project_not_found'::text, null::uuid; return;
    end if;
    -- A project names its client; a different client beside it is a contradiction.
    if v_client is not null and v_client <> v_proj_client then
      return query select 'client_not_on_project'::text, null::uuid; return;
    end if;
    v_client := v_proj_client;
  elsif v_client is not null and not exists (
    select 1 from core.client_accounts c where c.id = v_client and c.organization_id = v_org
  ) then
    return query select 'client_not_found'::text, null::uuid; return;
  end if;

  if p_template_id is not null and not exists (
    select 1 from crm.announcement_templates t where t.id = p_template_id and t.organization_id = v_org
  ) then
    return query select 'template_not_found'::text, null::uuid; return;
  end if;

  insert into crm.announcements (organization_id, title, body, audience, project_id, client_account_id, template_id, created_by)
  values (v_org, v_title, v_body, p_audience, p_project_id, v_client, p_template_id, v_actor)
  returning crm.announcements.id into v_new;

  perform core.record_audit(v_org, 'announcement.drafted', 'announcement', v_new, null,
    jsonb_build_object('title', v_title, 'audience', p_audience, 'project_id', p_project_id, 'client_account_id', v_client, 'template_id', p_template_id));

  return query select 'drafted'::text, v_new;
end;
$$;

comment on function crm.create_announcement(text, text, text, uuid, uuid, uuid) is
  'SCR-059: drafts an announcement, optionally about a project (which fixes its client) or addressed to one client, optionally from a template. Owner only. The project/client named here is where it is later recorded on a timeline. Audits announcement.drafted.';

revoke all on function crm.create_announcement(text, text, text, uuid, uuid, uuid) from public, anon;
grant execute on function crm.create_announcement(text, text, text, uuid, uuid, uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. a milestone being met drafts its announcement
-- ═══════════════════════════════════════════════════════════════════════════

-- The one place a milestone draft is made, called by the trigger below and by
-- the "Draft its announcement" button (crm.draft_milestone_announcement).
create or replace function crm.prepare_milestone_announcement(p_milestone_id uuid)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ms      projects.milestones;
  v_project projects.projects;
  v_client  text;
  v_tpl     crm.announcement_templates;
  v_new     uuid;
begin
  select * into v_ms from projects.milestones m where m.id = p_milestone_id;
  if v_ms.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_ms.status <> 'met' then
    return query select 'not_met'::text, null::uuid; return;
  end if;
  if v_ms.visibility <> 'client' then
    return query select 'not_client_visible'::text, null::uuid; return;
  end if;
  if exists (select 1 from crm.announcements a where a.milestone_id = v_ms.id) then
    return query select 'already_drafted'::text, null::uuid; return;
  end if;

  select * into v_tpl from crm.announcement_templates t
   where t.organization_id = v_ms.organization_id and t.kind = 'milestone' and t.active
   order by t.updated_at desc limit 1;
  if v_tpl.id is null then
    return query select 'no_template'::text, null::uuid; return;
  end if;

  select * into v_project from projects.projects p where p.id = v_ms.project_id;
  select c.name into v_client from core.client_accounts c where c.id = v_project.client_account_id;

  insert into crm.announcements (
    organization_id, title, body, audience, project_id, client_account_id,
    template_id, milestone_id, source, created_by
  )
  values (
    v_ms.organization_id,
    left(crm.render_announcement_text(v_tpl.title_template, v_project.name, v_client, v_ms.name, v_ms.due_on::text), 160),
    left(crm.render_announcement_text(v_tpl.body_template, v_project.name, v_client, v_ms.name, v_ms.due_on::text), 5000),
    v_tpl.audience, v_ms.project_id, v_project.client_account_id,
    v_tpl.id, v_ms.id, 'milestone', (select auth.uid())
  )
  returning crm.announcements.id into v_new;

  perform core.record_audit(v_ms.organization_id, 'announcement.drafted', 'announcement', v_new, null,
    jsonb_build_object('source', 'milestone', 'milestone_id', v_ms.id, 'project_id', v_ms.project_id, 'template_id', v_tpl.id));

  return query select 'drafted'::text, v_new;
end;
$$;

comment on function crm.prepare_milestone_announcement(uuid) is
  'SCR-059: drafts (never publishes) an announcement for a met, client-visible milestone from the newest active milestone template, naming the project, client and milestone. Once per milestone. Internal: called by the trigger and by crm.draft_milestone_announcement.';

revoke all on function crm.prepare_milestone_announcement(uuid) from public, anon, authenticated;
grant execute on function crm.prepare_milestone_announcement(uuid) to service_role;

create or replace function crm.draft_milestone_announcement(p_milestone_id uuid)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if (select auth.uid()) is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  select m.organization_id into v_org from projects.milestones m where m.id = p_milestone_id;
  if v_org is distinct from (select core.current_organization_id()) then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  return query select * from crm.prepare_milestone_announcement(p_milestone_id);
end;
$$;

comment on function crm.draft_milestone_announcement(uuid) is
  'SCR-059: the owner''s button for a met milestone the trigger did not draft (no template was active at the time). Same refusals as the preparer.';

revoke all on function crm.draft_milestone_announcement(uuid) from public, anon;
grant execute on function crm.draft_milestone_announcement(uuid) to authenticated, service_role;

create or replace function crm.milestone_met_drafts_an_announcement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'met' and old.status is distinct from 'met' then
    -- A draft is a convenience; it must never stop a milestone being met.
    begin
      perform crm.prepare_milestone_announcement(new.id);
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists milestone_met_drafts_an_announcement on projects.milestones;
create trigger milestone_met_drafts_an_announcement
  after update of status on projects.milestones
  for each row execute function crm.milestone_met_drafts_an_announcement();

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. a delivery retry says why
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.delivery_retry_reasons (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  original_id     uuid not null references crm.conversation_messages(id) on delete cascade,
  retry_id        uuid references crm.conversation_messages(id) on delete set null,
  reason          text not null check (length(btrim(reason)) between 5 and 600),
  requested_by    uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

comment on table crm.delivery_retry_reasons is
  'SCR-060 "Requeue with reason": the words a person gave when they sent a failed delivery again. Appended through crm.requeue_failed_delivery, never edited. The retry itself is the message row that points back at the original (retry_of).';

create index if not exists delivery_retry_reasons_original_idx
  on crm.delivery_retry_reasons (organization_id, original_id, created_at desc);

alter table crm.delivery_retry_reasons enable row level security;
alter table crm.delivery_retry_reasons force row level security;

drop policy if exists delivery_retry_reasons_select on crm.delivery_retry_reasons;
create policy delivery_retry_reasons_select on crm.delivery_retry_reasons
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists freeze_org_delivery_retry_reasons on crm.delivery_retry_reasons;
create trigger freeze_org_delivery_retry_reasons
  before update of organization_id on crm.delivery_retry_reasons
  for each row execute function core.freeze_organization_id();

grant select on crm.delivery_retry_reasons to authenticated, service_role;

create or replace function crm.requeue_failed_delivery(
  p_original_id uuid,
  p_retry_id    uuid,
  p_reason      text
)
returns table (outcome text, retry_count int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_out    record;
begin
  if (select auth.uid()) is null then
    return query select 'no_actor'::text, null::int; return;
  end if;
  if length(v_reason) < 5 or length(v_reason) > 600 then
    return query select 'no_reason'::text, null::int; return;
  end if;
  -- The same two roles crm.record_delivery_retry admits.
  if (select core.current_user_role()) not in ('owner', 'ops_admin') then
    return query select 'forbidden'::text, null::int; return;
  end if;

  select m.organization_id into v_org from crm.conversation_messages m where m.id = p_original_id;
  if v_org is distinct from (select core.current_organization_id()) then
    return query select 'not_found'::text, null::int; return;
  end if;

  select * into v_out from crm.record_delivery_retry(p_original_id, p_retry_id);

  if v_out.outcome in ('linked', 'already_linked') then
    insert into crm.delivery_retry_reasons (organization_id, original_id, retry_id, reason, requested_by)
    select v_org, p_original_id, p_retry_id, v_reason, (select auth.uid())
     where not exists (select 1 from crm.delivery_retry_reasons r where r.retry_id = p_retry_id);
    if v_out.outcome = 'linked' then
      perform core.record_audit(v_org, 'message.outbound.requeued_with_reason', 'conversation_message', p_original_id, null,
        jsonb_build_object('reason', v_reason, 'retry_message_id', p_retry_id));
    end if;
  end if;

  return query select v_out.outcome, v_out.retry_count;
end;
$$;

comment on function crm.requeue_failed_delivery(uuid, uuid, text) is
  'SCR-060: links a re-sent message to the failed one it retried (crm.record_delivery_retry) AND keeps the reason the person gave (at least five characters). Owner or ops_admin. Audits message.outbound.requeued_with_reason.';

revoke all on function crm.requeue_failed_delivery(uuid, uuid, text) from public, anon;
grant execute on function crm.requeue_failed_delivery(uuid, uuid, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. email and client updates are a lane of the Center
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.outbound_emails (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  kind               text not null default 'email' check (kind in ('email', 'client_update')),
  to_address         text not null check (to_address ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  subject            text not null check (length(btrim(subject)) between 1 and 200),
  body               text not null check (length(btrim(body)) between 1 and 10000),
  project_id         uuid references projects.projects(id) on delete set null,
  client_account_id  uuid references core.client_accounts(id) on delete set null,
  status             text not null check (status in ('sent', 'failed')),
  transport          text check (transport is null or transport in ('resend', 'smtp')),
  message_ref        text,
  error              text,
  retry_of           uuid references crm.outbound_emails(id) on delete set null,
  retry_reason       text check (retry_reason is null or length(btrim(retry_reason)) between 5 and 600),
  sent_by            uuid references core.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint outbound_emails_failed_says_why check (status <> 'failed' or error is not null),
  constraint outbound_emails_retry_says_why check (retry_of is null or retry_reason is not null)
);

comment on table crm.outbound_emails is
  'SCR-057: the email and client-update lane. One row per send attempt — who wrote it, to whom, about which project, by which transport, whether the provider accepted it (sent) or refused (failed, with the reason). A failed one is sent again as a NEW row that points back (retry_of) with the reason. Written only through crm.record_outbound_email.';

create index if not exists outbound_emails_org_idx on crm.outbound_emails (organization_id, created_at desc);
create index if not exists outbound_emails_project_idx on crm.outbound_emails (organization_id, project_id, created_at desc) where project_id is not null;
create index if not exists outbound_emails_retry_idx on crm.outbound_emails (retry_of) where retry_of is not null;

alter table crm.outbound_emails enable row level security;
alter table crm.outbound_emails force row level security;

drop policy if exists outbound_emails_select on crm.outbound_emails;
create policy outbound_emails_select on crm.outbound_emails
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists org_match_outbound_emails_project on crm.outbound_emails;
create trigger org_match_outbound_emails_project
  before insert or update of project_id, organization_id on crm.outbound_emails
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_outbound_emails_client on crm.outbound_emails;
create trigger org_match_outbound_emails_client
  before insert or update of client_account_id, organization_id on crm.outbound_emails
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_outbound_emails_retry on crm.outbound_emails;
create trigger org_match_outbound_emails_retry
  before insert or update of retry_of, organization_id on crm.outbound_emails
  for each row execute function core.enforce_parent_org('retry_of', 'crm.outbound_emails');

drop trigger if exists freeze_org_outbound_emails on crm.outbound_emails;
create trigger freeze_org_outbound_emails
  before update of organization_id on crm.outbound_emails
  for each row execute function core.freeze_organization_id();

grant select on crm.outbound_emails to authenticated, service_role;

create or replace function crm.record_outbound_email(
  p_kind        text,
  p_to          text,
  p_subject     text,
  p_body        text,
  p_status      text,
  p_project_id  uuid default null,
  p_transport   text default null,
  p_message_ref text default null,
  p_error       text default null,
  p_retry_of    uuid default null,
  p_retry_reason text default null
)
returns table (outcome text, id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_client uuid;
  v_new    uuid;
  v_reason text := nullif(btrim(coalesce(p_retry_reason, '')), '');
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  -- lead.write: owner and ops_admin.
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if p_kind not in ('email', 'client_update') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if p_status not in ('sent', 'failed') then
    return query select 'bad_status'::text, null::uuid; return;
  end if;
  if p_status = 'failed' and nullif(btrim(coalesce(p_error, '')), '') is null then
    return query select 'error_required'::text, null::uuid; return;
  end if;
  if p_retry_of is not null then
    if v_reason is null or length(v_reason) < 5 then
      return query select 'no_reason'::text, null::uuid; return;
    end if;
    if not exists (select 1 from crm.outbound_emails e where e.id = p_retry_of and e.organization_id = v_org and e.status = 'failed') then
      return query select 'not_failed'::text, null::uuid; return;
    end if;
  end if;

  if p_project_id is not null then
    select p.client_account_id into v_client from projects.projects p
     where p.id = p_project_id and p.organization_id = v_org;
    if not found then
      return query select 'project_not_found'::text, null::uuid; return;
    end if;
  end if;

  begin
    insert into crm.outbound_emails (
      organization_id, kind, to_address, subject, body, project_id, client_account_id,
      status, transport, message_ref, error, retry_of, retry_reason, sent_by
    )
    values (
      v_org, p_kind, btrim(p_to), btrim(p_subject), btrim(p_body), p_project_id, v_client,
      p_status, p_transport, nullif(btrim(coalesce(p_message_ref, '')), ''),
      nullif(left(btrim(coalesce(p_error, '')), 1000), ''), p_retry_of, v_reason, v_actor
    )
    returning crm.outbound_emails.id into v_new;
  exception
    when check_violation then
      return query select 'invalid'::text, null::uuid; return;
  end;

  perform core.record_audit(v_org,
    case when p_status = 'sent' then 'email.sent' else 'email.failed' end,
    'outbound_email', v_new, null,
    jsonb_build_object('kind', p_kind, 'project_id', p_project_id, 'transport', p_transport, 'retry_of', p_retry_of, 'retry_reason', v_reason));

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function crm.record_outbound_email(text, text, text, text, text, uuid, text, text, text, uuid, text) is
  'SCR-057: records one email or client-update send attempt (sent, or failed with the provider''s reason), optionally about a project (whose client is recorded with it) and, for a resend, the failed row it retries with the reason (required). Owner or ops_admin. Audits email.sent / email.failed.';

revoke all on function crm.record_outbound_email(text, text, text, text, text, uuid, text, text, text, uuid, text) from public, anon;
grant execute on function crm.record_outbound_email(text, text, text, text, text, uuid, text, text, text, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
