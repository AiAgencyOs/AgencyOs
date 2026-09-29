-- ═══════════════════════════════════════════════════════════════════════════
-- The shell remembers, and escalates.
--
-- Bucket F, stream F-A (docs/AGENCYOS_ADMIN_BUCKET_F_PLAN.md, "Stream F-A"):
-- the four Global Control screens of the PDF — Command Center (SCR-001),
-- Global Search (SCR-002), Notifications (SCR-003) and Quick Create
-- (SCR-004) — each asked for something the database had no row for.
--
--   1. SCR-004 "Recent commands": the ⌘K palette remembered recent SEARCHES
--      (core.saved_searches) and nothing else. `core.recent_commands` is the
--      last twenty commands a person ran from the palette — a page, a create,
--      a record — keyed by the person, pruned by the reader.
--   2. SCR-004 "Save draft when creation is interrupted": a create form closed
--      halfway lost its fields. `core.create_drafts` keeps one draft per
--      entity kind per person, as the form's own fields (jsonb, opaque here),
--      restored when the palette opens on that form again.
--   3. SCR-001 "Acknowledge / escalate an operational item" and SCR-003
--      "Escalate to owner or ops admin": the inbox's Escalate was a LINK to
--      /approvals, and nothing recorded that anybody escalated anything.
--      `core.escalations` is that record — which derived item (its stable key,
--      the same string the Action Center uses), by whom, to which role, why —
--      with a life of open → acknowledged → resolved, through two doors that
--      write audit.audit_log in the same transaction (`escalation.raised`,
--      `escalation.acknowledged`, `escalation.resolved`).
--   4. SCR-001 "Organization selector": a person may hold memberships in more
--      than one organisation (core.users "deliberately has no organization_id:
--      membership is the many-to-many join"), and the token hook always chose
--      the highest-ranked one. `core.user_preferences.current_organization_id`
--      is the one the person CHOSE; `core.switch_organization` writes it
--      (refusing an organisation the person holds no active membership of)
--      and audits `organization.switched` in the organisation being LEFT — the
--      only one audit_log_insert admits for this token. The hook then honours
--      the choice on the next token mint; the app refreshes the session right
--      after the door so the switch takes effect on the next request.
--      `core.list_my_organizations` is the selector's reader: memberships_select
--      is scoped to the CURRENT organisation, so a person cannot see their
--      other memberships through the table, and a security-definer function
--      that returns only the caller's own active memberships is the honest
--      door.
--
-- Notification severity (critical | action | warning | information) is
-- DERIVED in the reader from the source row (an overdue approval is critical,
-- a due approval is action …) and gets no column: the rows themselves are
-- derived, and a stored severity would drift from the row it describes.
--
-- Plain Postgres, idempotent. Every tenant table: organization_id FK, RLS
-- enabled and forced, role-named policies, grants, freeze trigger; the one
-- table with a second FK to an org-scoped table (none here — escalations
-- point at derived rows by key, not at a table) needs no enforce_parent_org.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Recent commands
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.recent_commands (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,

  -- The palette entry's own key (`create-task`, `/leads`, `Lead:<uuid>`) and
  -- what it read as, so the palette can show it without resolving it again.
  command_key      text not null check (length(btrim(command_key)) between 1 and 200),
  label            text not null check (length(btrim(label)) between 1 and 200),
  href             text check (href is null or length(href) <= 500),

  last_used_at     timestamptz not null default now(),
  use_count        integer not null default 1 check (use_count >= 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, user_id, command_key)
);

comment on table core.recent_commands is
  'A person''s last twenty ⌘K palette commands — SCR-004 "Recent commands". Key, label and href are the palette entry''s own; nothing here is interpreted. Pruned to twenty by the reader.';

create index if not exists recent_commands_user_idx
  on core.recent_commands (organization_id, user_id, last_used_at desc);

drop trigger if exists set_updated_at on core.recent_commands;
create trigger set_updated_at before update on core.recent_commands
  for each row execute function core.set_updated_at();

alter table core.recent_commands enable row level security;
alter table core.recent_commands force row level security;

drop policy if exists recent_commands_own on core.recent_commands;
create policy recent_commands_own on core.recent_commands
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  );

grant select, insert, update, delete on core.recent_commands to authenticated, service_role;

drop trigger if exists freeze_org_recent_commands on core.recent_commands;
create trigger freeze_org_recent_commands
  before update of organization_id on core.recent_commands
  for each row execute function core.freeze_organization_id();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Create drafts
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.create_drafts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,

  -- Which create form: the palette's own vocabulary (lead, client, project,
  -- invoice, task, quotation, meeting, change_request).
  kind             text not null check (kind ~ '^[a-z_]{1,40}$'),
  -- The form's fields as the form wrote them. Opaque here, bounded there.
  draft            jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, user_id, kind)
);

comment on table core.create_drafts is
  'One unfinished Quick Create form per kind per person — SCR-004 "Save draft when creation is interrupted". The draft is the form''s own fields; it is restored when the form opens again and deleted when the record is created.';

create index if not exists create_drafts_user_idx
  on core.create_drafts (organization_id, user_id);

drop trigger if exists set_updated_at on core.create_drafts;
create trigger set_updated_at before update on core.create_drafts
  for each row execute function core.set_updated_at();

alter table core.create_drafts enable row level security;
alter table core.create_drafts force row level security;

drop policy if exists create_drafts_own on core.create_drafts;
create policy create_drafts_own on core.create_drafts
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  );

grant select, insert, update, delete on core.create_drafts to authenticated, service_role;

drop trigger if exists freeze_org_create_drafts on core.create_drafts;
create trigger freeze_org_create_drafts
  before update of organization_id on core.create_drafts
  for each row execute function core.freeze_organization_id();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Escalations
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.escalations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- What was escalated: the Action Center row's category and stable key
  -- (`approval-<uuid>`, `claim-<uuid>`, `job-<uuid>` …), and its title as it
  -- read at the time — the row itself is derived and may be gone tomorrow.
  subject_type     text not null check (subject_type ~ '^[a-z_]{1,40}$'),
  subject_key      text not null check (length(btrim(subject_key)) between 1 and 200),
  title            text not null check (length(btrim(title)) between 1 and 300),

  from_user        uuid not null references core.users(id) on delete cascade,
  to_role          text not null check (to_role in ('owner', 'ops_admin')),
  reason           text not null check (length(btrim(reason)) between 1 and 2000),

  state            text not null default 'open'
                   check (state in ('open', 'acknowledged', 'resolved')),
  acknowledged_by  uuid references core.users(id) on delete set null,
  acknowledged_at  timestamptz,
  resolved_by      uuid references core.users(id) on delete set null,
  resolved_at      timestamptz,
  resolution_note  text check (resolution_note is null or length(resolution_note) <= 2000),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint escalations_acknowledged_has_who
    check (state = 'open' or (acknowledged_by is not null and acknowledged_at is not null)),
  constraint escalations_resolved_has_who
    check (state <> 'resolved' or (resolved_by is not null and resolved_at is not null))
);

comment on table core.escalations is
  'A recorded escalation of one Action Center row to the owner or the ops admin (SCR-001 / SCR-003): who raised it, to which role, why, and whether the role acknowledged or resolved it. Written only through core.escalate and core.acknowledge_escalation, both audited.';

create index if not exists escalations_open_idx
  on core.escalations (organization_id, state, created_at desc);

create index if not exists escalations_subject_idx
  on core.escalations (organization_id, subject_key);

drop trigger if exists set_updated_at on core.escalations;
create trigger set_updated_at before update on core.escalations
  for each row execute function core.set_updated_at();

alter table core.escalations enable row level security;
alter table core.escalations force row level security;

-- Every internal member reads them: the inbox shows "escalated to the owner"
-- beside the row, and the owner's queue is the same table.
drop policy if exists escalations_select on core.escalations;
create policy escalations_select on core.escalations
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Any internal member may RAISE one (as themself).
drop policy if exists escalations_insert on core.escalations;
create policy escalations_insert on core.escalations
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and from_user = (select auth.uid())
    and (select core.is_internal())
  );

-- Only an admin (owner or ops_admin — the two roles an escalation can name)
-- acknowledges or resolves. No delete: an escalation is history.
drop policy if exists escalations_update on core.escalations;
create policy escalations_update on core.escalations
  for update to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

grant select, insert, update on core.escalations to authenticated, service_role;

drop trigger if exists freeze_org_escalations on core.escalations;
create trigger freeze_org_escalations
  before update of organization_id on core.escalations
  for each row execute function core.freeze_organization_id();

-- The raising door. Security INVOKER: escalations_insert decides again, and
-- record_audit's own policy keeps the audit row attributed to the caller.
-- One OPEN escalation per subject: raising the same row twice bumps nothing
-- and refuses 'already_open', so a queue cannot fill with duplicates.
create or replace function core.escalate(
  p_organization_id uuid,
  p_subject_type    text,
  p_subject_key     text,
  p_title           text,
  p_to_role         text,
  p_reason          text
)
returns table (outcome text, escalation_id uuid)
  -- 'raised' | 'forbidden' | 'invalid' | 'already_open'
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_title  text := nullif(btrim(coalesce(p_title, '')), '');
  v_key    text := nullif(btrim(coalesce(p_subject_key, '')), '');
  v_id     uuid;
begin
  if v_actor is null or not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_reason is null or v_title is null or v_key is null
     or p_to_role not in ('owner', 'ops_admin')
     or p_subject_type !~ '^[a-z_]{1,40}$' then
    return query select 'invalid'::text, null::uuid; return;
  end if;

  select e.id into v_id
    from core.escalations e
   where e.organization_id = p_organization_id
     and e.subject_key = v_key
     and e.state = 'open'
   limit 1;
  if v_id is not null then
    return query select 'already_open'::text, v_id; return;
  end if;

  insert into core.escalations
    (organization_id, subject_type, subject_key, title, from_user, to_role, reason)
  values
    (p_organization_id, p_subject_type, v_key, left(v_title, 300), v_actor, p_to_role, v_reason)
  returning id into v_id;

  perform core.record_audit(
    p_organization_id, 'escalation.raised', 'escalation', v_id,
    null,
    jsonb_build_object('subject_type', p_subject_type, 'subject_key', v_key, 'to_role', p_to_role, 'reason', v_reason)
  );

  return query select 'raised'::text, v_id;
end;
$$;

comment on function core.escalate(uuid, text, text, text, text, text) is
  'Raises an escalation of one Action Center row to the owner or the ops admin (SCR-001 / SCR-003), refusing a second open one for the same row. Audited as escalation.raised. SECURITY INVOKER: escalations_insert decides again.';

revoke all on function core.escalate(uuid, text, text, text, text, text) from public, anon;
grant execute on function core.escalate(uuid, text, text, text, text, text) to authenticated, service_role;

-- The answering door: open → acknowledged, and open|acknowledged → resolved.
create or replace function core.acknowledge_escalation(
  p_organization_id uuid,
  p_escalation_id   uuid,
  p_state           text,
  p_note            text default null
)
returns table (outcome text)
  -- 'acknowledged' | 'resolved' | 'forbidden' | 'not_found' | 'invalid_state' | 'already'
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   core.escalations%rowtype;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null or not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text; return;
  end if;
  if p_state not in ('acknowledged', 'resolved') then
    return query select 'invalid_state'::text; return;
  end if;

  select * into v_row
    from core.escalations e
   where e.id = p_escalation_id
     and e.organization_id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  if v_row.state = 'resolved' or (p_state = 'acknowledged' and v_row.state = 'acknowledged') then
    return query select 'already'::text; return;
  end if;

  update core.escalations
     set state           = p_state,
         acknowledged_by = coalesce(acknowledged_by, v_actor),
         acknowledged_at = coalesce(acknowledged_at, now()),
         resolved_by     = case when p_state = 'resolved' then v_actor else resolved_by end,
         resolved_at     = case when p_state = 'resolved' then now() else resolved_at end,
         resolution_note = case when p_state = 'resolved' then v_note else resolution_note end
   where id = v_row.id;

  perform core.record_audit(
    p_organization_id, 'escalation.' || p_state, 'escalation', v_row.id,
    jsonb_build_object('state', v_row.state, 'subject_key', v_row.subject_key),
    jsonb_build_object('state', p_state, 'subject_key', v_row.subject_key, 'note', v_note)
  );

  return query select p_state;
end;
$$;

comment on function core.acknowledge_escalation(uuid, uuid, text, text) is
  'Acknowledges or resolves an escalation (owner or ops_admin). open → acknowledged → resolved; an open one may be resolved directly. Audited as escalation.acknowledged / escalation.resolved. SECURITY INVOKER: escalations_update decides again.';

revoke all on function core.acknowledge_escalation(uuid, uuid, text, text) from public, anon;
grant execute on function core.acknowledge_escalation(uuid, uuid, text, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. The organisation a person chose
-- ═══════════════════════════════════════════════════════════════════════════

alter table core.user_preferences
  add column if not exists current_organization_id uuid references core.organizations(id) on delete set null;

comment on column core.user_preferences.current_organization_id is
  'SCR-001 organisation selector — the organisation this person chose to act in. Honoured by core.custom_access_token_hook when the person holds an active membership there; ignored otherwise. Null = the hook''s default (highest-ranked active membership).';

-- What a person may switch TO: their own active memberships, wherever they
-- are. memberships_select is scoped to the current organisation, so this is
-- the only honest way to read the rest. Returns nothing about anybody else.
create or replace function core.list_my_organizations()
returns table (organization_id uuid, name text, role text, is_current boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id,
         o.name,
         m.role,
         m.organization_id = (select core.current_organization_id()) as is_current
    from core.memberships m
    join core.organizations o on o.id = m.organization_id
   where m.user_id = (select auth.uid())
     and m.status = 'active'
   order by o.name;
$$;

comment on function core.list_my_organizations() is
  'The caller''s own active memberships across organisations, for the shell''s organisation selector (SCR-001). SECURITY DEFINER because memberships_select is scoped to the current organisation; returns rows about the caller alone.';

revoke all on function core.list_my_organizations() from public, anon;
grant execute on function core.list_my_organizations() to authenticated, service_role;

-- The switch. SECURITY DEFINER for the same reason as the reader: the
-- membership being checked is in the organisation the caller is NOT yet in.
-- Audited in the organisation being left — the only one this token's
-- audit_log_insert admits — with before/after naming both.
create or replace function core.switch_organization(p_organization_id uuid)
returns table (outcome text)
  -- 'switched' | 'unauthenticated' | 'not_a_member' | 'unchanged' | 'no_organization'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_from  uuid := (select core.current_organization_id());
begin
  if v_actor is null then
    return query select 'unauthenticated'::text; return;
  end if;
  if v_from is null then
    return query select 'no_organization'::text; return;
  end if;
  if not exists (
    select 1 from core.memberships m
     where m.user_id = v_actor
       and m.organization_id = p_organization_id
       and m.status = 'active'
  ) then
    return query select 'not_a_member'::text; return;
  end if;
  if p_organization_id = v_from then
    return query select 'unchanged'::text; return;
  end if;

  insert into core.user_preferences (user_id, current_organization_id)
  values (v_actor, p_organization_id)
  on conflict (user_id) do update
    set current_organization_id = excluded.current_organization_id;

  perform core.record_audit(
    v_from, 'organization.switched', 'organization', p_organization_id,
    jsonb_build_object('organization_id', v_from),
    jsonb_build_object('organization_id', p_organization_id)
  );

  return query select 'switched'::text;
end;
$$;

comment on function core.switch_organization(uuid) is
  'Records which organisation the caller wants to act in (core.user_preferences.current_organization_id), refusing one they hold no active membership of. Audited as organization.switched in the organisation being left. Takes effect on the next token mint; the app refreshes the session right after.';

revoke all on function core.switch_organization(uuid) from public, anon;
grant execute on function core.switch_organization(uuid) to authenticated, service_role;

-- The hook, carried forward from 20260807120011 in full (never regenerated
-- from an older copy — G-126), with one addition: step 1 prefers the
-- organisation the person chose when they hold an active membership there,
-- and falls back to the highest-ranked active membership otherwise. It
-- still never throws.
create or replace function core.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_claims jsonb;
  v_app_metadata jsonb;
  v_membership record;
  v_client_user record;
  v_chosen uuid;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_app_metadata := coalesce(v_claims -> 'app_metadata', '{}'::jsonb);

  -- 1. Internal staff — the organisation they chose first (SCR-001), then
  --    the highest-ranked active membership.
  select p.current_organization_id into v_chosen
    from core.user_preferences p
   where p.user_id = v_user_id;

  select m.organization_id, m.role
    into v_membership
    from core.memberships m
   where m.user_id = v_user_id
     and m.status = 'active'
   order by
     case when v_chosen is not null and m.organization_id = v_chosen then 0 else 1 end,
     case m.role
       when 'owner' then 1
       when 'ops_admin' then 2
       when 'delivery_lead' then 3
       when 'member' then 4
       else 5
     end
   limit 1;

  if found then
    v_app_metadata := v_app_metadata
      || jsonb_build_object(
           'organization_id', v_membership.organization_id,
           'role', v_membership.role,
           'audience', 'internal'
         );
  else
    -- 2. Client portal user
    select cu.organization_id, cu.client_account_id, cu.role
      into v_client_user
      from core.client_users cu
     where cu.user_id = v_user_id
       and cu.status = 'active'
     limit 1;

    if found then
      v_app_metadata := v_app_metadata
        || jsonb_build_object(
             'organization_id', v_client_user.organization_id,
             'client_account_id', v_client_user.client_account_id,
             'role', v_client_user.role,
             'audience', 'client'
           );
    end if;
  end if;

  v_claims := jsonb_set(v_claims, '{app_metadata}', v_app_metadata);
  return jsonb_set(event, '{claims}', v_claims);

exception when others then
  -- Never break sign-in. A claimless token means RLS denies, which is the
  -- safe direction to fail.
  raise warning 'custom_access_token_hook failed for %: %', v_user_id, sqlerrm;
  return event;
end;
$$;

comment on function core.custom_access_token_hook(jsonb) is
  'Supabase Auth token hook. Stamps organization_id, role, and client_account_id into app_metadata so RLS can trust them. Prefers the organisation the person chose (core.user_preferences.current_organization_id) when they hold an active membership there. Enable at Authentication -> Hooks -> Customize Access Token.';

do $$
begin
  execute 'grant select on core.user_preferences to supabase_auth_admin';
exception when undefined_object then
  raise warning 'supabase_auth_admin role not present; skipping hook grant on user_preferences.';
end;
$$;
