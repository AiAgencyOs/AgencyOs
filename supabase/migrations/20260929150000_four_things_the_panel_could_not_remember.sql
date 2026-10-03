-- Four things the panel could not remember.
--
-- docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, bucket B — items the screen
-- architecture asks for that had no table or column to land on:
--
--   1. SCR-003 Notifications: snooze, resolve, assign, batch mark-read and a
--      history. Every row in the inbox is DERIVED live from six sources
--      (approvals, claims, defects, dead jobs, failed deliveries, overdue
--      tasks) and stays that way; what was missing was somewhere to write
--      "I have seen this" against a row. `core.notification_states` is that
--      annotation — keyed by the row's own stable key, per person — and
--      `core.notification_state_events` is its history.
--   2. SCR-014 Client management: tags and a relationship owner on
--      `core.client_accounts`, which had neither column.
--   3. SCR-002 Global search: recent and saved searches, `core.saved_searches`,
--      personal like `core.saved_views` (20260928150000) and for the same
--      reason — how somebody searches is a fact about them, not a policy.
--   4. SCR-017/057/059 Announcements: `crm.announcements`, a record of what
--      was announced to whom, with a draft → published → archived life.
--      Publishing RECORDS the announcement; nothing here sends it. The
--      traceability inventory declines WhatsApp broadcast (row 59), and a
--      status column that quietly implied a send would be that decision
--      reversed by a migration.
--
-- Plain Postgres, idempotent. Governed writes (a resolution, an assignment, a
-- publish, an archive) go through one plpgsql door each that writes
-- audit.audit_log in the same transaction, the way core.set_organization_setting
-- does; personal bookkeeping (a read mark, a recent search) does not clutter
-- the audit log.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Notification state
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.notification_states (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,

  -- The inbox row's own key, e.g. `approval-<uuid>`, `task-<uuid>` — the
  -- same string app/(internal)/notifications/action-items.ts derives. Opaque
  -- here: the page is the only thing that knows what a key means.
  item_key         text not null check (length(btrim(item_key)) between 1 and 200),

  state            text not null default 'unread'
                   check (state in ('unread', 'read', 'snoozed', 'resolved')),
  snoozed_until    timestamptz,
  assigned_to      uuid references core.users(id) on delete set null,
  note             text check (note is null or length(note) <= 2000),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A snooze without an end is a resolve wearing the wrong word.
  constraint notification_states_snooze_has_until
    check (state <> 'snoozed' or snoozed_until is not null),
  unique (organization_id, user_id, item_key)
);

comment on table core.notification_states is
  'Per-person annotation of one derived Action Center row (SCR-003): read, snoozed until, resolved with a note, or assigned. The rows themselves are still derived live; this table never creates or removes one.';

create index if not exists notification_states_user_idx
  on core.notification_states (organization_id, user_id, state);

drop trigger if exists set_updated_at on core.notification_states;
create trigger set_updated_at before update on core.notification_states
  for each row execute function core.set_updated_at();

alter table core.notification_states enable row level security;
alter table core.notification_states force row level security;

-- Internal staff of the organization may read every annotation — an
-- assignee has to be able to see what was assigned to them.
drop policy if exists notification_states_select on core.notification_states;
create policy notification_states_select on core.notification_states
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Only the person a row belongs to may write it.
drop policy if exists notification_states_write on core.notification_states;
create policy notification_states_write on core.notification_states
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
    and (select core.is_internal())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
    and (select core.is_internal())
  );

grant select, insert, update, delete on core.notification_states to authenticated, service_role;

drop trigger if exists freeze_org_notification_states on core.notification_states;
create trigger freeze_org_notification_states
  before update of organization_id on core.notification_states
  for each row execute function core.freeze_organization_id();

-- The history: one row per change, append-only.
create table if not exists core.notification_state_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,
  item_key         text not null check (length(btrim(item_key)) between 1 and 200),
  event            text not null check (event in ('read', 'unread', 'snoozed', 'resolved', 'assigned')),
  from_state       text,
  to_state         text not null,
  snoozed_until    timestamptz,
  assigned_to      uuid references core.users(id) on delete set null,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table core.notification_state_events is
  'Append-only history of core.notification_states (SCR-003 "action history"): who marked what read, snoozed, resolved or assigned, and when.';

create index if not exists notification_state_events_user_idx
  on core.notification_state_events (organization_id, user_id, created_at desc);

alter table core.notification_state_events enable row level security;
alter table core.notification_state_events force row level security;

drop policy if exists notification_state_events_select on core.notification_state_events;
create policy notification_state_events_select on core.notification_state_events
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists notification_state_events_insert on core.notification_state_events;
create policy notification_state_events_insert on core.notification_state_events
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
    and (select core.is_internal())
  );

-- No update or delete policy: history is history.
grant select, insert on core.notification_state_events to authenticated, service_role;

drop trigger if exists freeze_org_notification_state_events on core.notification_state_events;
create trigger freeze_org_notification_state_events
  before update of organization_id on core.notification_state_events
  for each row execute function core.freeze_organization_id();

-- The one door. Security INVOKER: the two policies above decide again, and
-- core.record_audit's own policy keeps the audit row attributed to the
-- caller. Takes several keys so a batch "mark read" is one transaction.
create or replace function core.set_notification_state(
  p_organization_id uuid,
  p_item_keys       text[],
  p_state           text,
  p_snoozed_until   timestamptz default null,
  p_assigned_to     uuid default null,
  p_note            text default null
)
returns table (outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_key   text;
  v_prev  text;
  v_id    uuid;
  v_event text;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null or not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text; return;
  end if;
  if p_state not in ('unread', 'read', 'snoozed', 'resolved') then
    return query select 'invalid_state'::text; return;
  end if;
  if p_state = 'snoozed' and (p_snoozed_until is null or p_snoozed_until <= now()) then
    return query select 'invalid_snooze'::text; return;
  end if;
  if p_item_keys is null or cardinality(p_item_keys) = 0 or cardinality(p_item_keys) > 200 then
    return query select 'invalid_keys'::text; return;
  end if;

  -- The assignee must hold an ACTIVE membership of this organization: a row
  -- handed to somebody who cannot open the inbox is a row nobody is watching.
  if p_assigned_to is not null and not exists (
    select 1 from core.memberships m
     where m.organization_id = p_organization_id
       and m.user_id = p_assigned_to
       and m.status = 'active'
  ) then
    return query select 'not_a_member'::text; return;
  end if;

  v_event := case when p_assigned_to is not null then 'assigned' else p_state end;

  foreach v_key in array p_item_keys loop
    select s.state, s.id into v_prev, v_id
      from core.notification_states s
     where s.organization_id = p_organization_id
       and s.user_id = v_actor
       and s.item_key = v_key
     for update;

    if v_id is null then
      insert into core.notification_states
        (organization_id, user_id, item_key, state, snoozed_until, assigned_to, note)
      values
        (p_organization_id, v_actor, v_key, p_state,
         case when p_state = 'snoozed' then p_snoozed_until end,
         p_assigned_to, v_note)
      returning id into v_id;
    else
      update core.notification_states
         set state         = p_state,
             snoozed_until = case when p_state = 'snoozed' then p_snoozed_until end,
             assigned_to   = coalesce(p_assigned_to, case when p_state = 'unread' then null else assigned_to end),
             note          = coalesce(v_note, case when p_state = 'unread' then null else note end)
       where id = v_id;
    end if;

    insert into core.notification_state_events
      (organization_id, user_id, item_key, event, from_state, to_state, snoozed_until, assigned_to, note)
    values
      (p_organization_id, v_actor, v_key, v_event, v_prev, p_state,
       case when p_state = 'snoozed' then p_snoozed_until end, p_assigned_to, v_note);

    -- A resolution or an assignment is a decision about work; a read mark
    -- or a snooze is bookkeeping. Only the decisions reach the audit log.
    if p_state = 'resolved' or p_assigned_to is not null then
      perform core.record_audit(
        p_organization_id,
        'notification.' || v_event,
        'notification_state',
        v_id,
        jsonb_build_object('item_key', v_key, 'state', v_prev),
        jsonb_build_object('item_key', v_key, 'state', p_state, 'assigned_to', p_assigned_to, 'note', v_note)
      );
    end if;

    v_prev := null; v_id := null;
  end loop;

  return query select 'ok'::text;
end;
$$;

comment on function core.set_notification_state(uuid, text[], text, timestamptz, uuid, text) is
  'The one door for annotating Action Center rows (SCR-003): upserts the caller''s own state for each key, appends a history event per key, and audits resolutions and assignments. Security invoker, so RLS decides again.';

revoke all on function core.set_notification_state(uuid, text[], text, timestamptz, uuid, text) from public, anon;
grant execute on function core.set_notification_state(uuid, text[], text, timestamptz, uuid, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Client tags and relationship owner
-- ═══════════════════════════════════════════════════════════════════════════

alter table core.client_accounts add column if not exists tags text[] not null default '{}';
alter table core.client_accounts add column if not exists owner_id uuid references core.users(id) on delete set null;

-- Twenty short labels is a taxonomy; more is a paragraph. Each tag's own
-- shape (trimmed, ≤ 40 chars, lower-cased) is the door's job.
alter table core.client_accounts drop constraint if exists client_accounts_tags_bounded;
alter table core.client_accounts add constraint client_accounts_tags_bounded
  check (cardinality(tags) <= 20);

comment on column core.client_accounts.tags is
  'SCR-014 — free labels the agency puts on a client (industry, tier, source). Lower-cased, deduplicated by the door; filterable on /clients.';
comment on column core.client_accounts.owner_id is
  'SCR-014 — the relationship owner: the internal member who answers for this client. Must be an active membership; the door checks, and audit.record_row_change already records the change as client_account.updated.';

create index if not exists client_accounts_owner_idx
  on core.client_accounts (organization_id, owner_id);

create index if not exists client_accounts_tags_idx
  on core.client_accounts using gin (tags);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Saved and recent searches
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.saved_searches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,

  query            text not null check (length(btrim(query)) between 1 and 200),
  -- The /search page's own filters (`type`, `since`) as it wrote them —
  -- opaque here, exactly as saved_views.query is.
  filters          jsonb not null default '{}'::jsonb,
  -- Null means "recent"; a name makes it saved. One row per (query, filters)
  -- per person, so naming a recent search promotes it rather than copying it.
  name             text check (name is null or length(btrim(name)) between 1 and 60),

  last_used_at     timestamptz not null default now(),
  use_count        integer not null default 1 check (use_count >= 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (user_id, query, filters)
);

comment on table core.saved_searches is
  'A person''s recent (name null) and saved (named) global searches — SCR-002. Query and filters are the /search page''s own URL parameters, never interpreted here.';

create index if not exists saved_searches_user_idx
  on core.saved_searches (user_id, last_used_at desc);

drop trigger if exists set_updated_at on core.saved_searches;
create trigger set_updated_at before update on core.saved_searches
  for each row execute function core.set_updated_at();

alter table core.saved_searches enable row level security;
alter table core.saved_searches force row level security;

drop policy if exists saved_searches_own on core.saved_searches;
create policy saved_searches_own on core.saved_searches
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  );

grant select, insert, update, delete on core.saved_searches to authenticated, service_role;

drop trigger if exists freeze_org_saved_searches on core.saved_searches;
create trigger freeze_org_saved_searches
  before update of organization_id on core.saved_searches
  for each row execute function core.freeze_organization_id();

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Announcements
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.announcements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 160),
  body             text not null check (length(btrim(body)) between 1 and 5000),
  audience         text not null check (audience in ('internal', 'clients')),
  status           text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at     timestamptz,
  archived_at      timestamptz,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint announcements_published_has_moment
    check (status <> 'published' or published_at is not null)
);

comment on table crm.announcements is
  'What the agency announced, to whom, and when it was published or archived (SCR-017/057). A record only: nothing here sends. WhatsApp broadcast is declined on record (traceability row 59).';

create index if not exists announcements_org_status_idx
  on crm.announcements (organization_id, status, published_at desc);

drop trigger if exists set_updated_at on crm.announcements;
create trigger set_updated_at before update on crm.announcements
  for each row execute function core.set_updated_at();

alter table crm.announcements enable row level security;
alter table crm.announcements force row level security;

drop policy if exists announcements_select on crm.announcements;
create policy announcements_select on crm.announcements
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Owner only, mirroring the app's `organization.settings` capability, which
-- only the owner holds. Insert and update; an announcement is archived, never
-- deleted.
drop policy if exists announcements_write on crm.announcements;
create policy announcements_write on crm.announcements
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_owner())
  );

drop policy if exists announcements_update on crm.announcements;
create policy announcements_update on crm.announcements
  for update to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_owner())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_owner())
  );

grant select, insert, update on crm.announcements to authenticated, service_role;

drop trigger if exists freeze_org_announcements on crm.announcements;
create trigger freeze_org_announcements
  before update of organization_id on crm.announcements
  for each row execute function core.freeze_organization_id();

-- The status door: draft → published → archived (and draft → archived).
-- Publishing stamps the moment and writes the audit row; it sends nothing.
create or replace function crm.set_announcement_status(
  p_organization_id uuid,
  p_announcement_id uuid,
  p_status          text
)
returns table (outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   crm.announcements%rowtype;
begin
  if v_actor is null or not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text; return;
  end if;
  if p_status not in ('published', 'archived') then
    return query select 'invalid_status'::text; return;
  end if;

  select * into v_row
    from crm.announcements a
   where a.id = p_announcement_id
     and a.organization_id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  if p_status = 'published' and v_row.status <> 'draft' then
    return query select 'not_a_draft'::text; return;
  end if;
  if p_status = 'archived' and v_row.status = 'archived' then
    return query select 'already_archived'::text; return;
  end if;

  update crm.announcements
     set status       = p_status,
         published_at = case when p_status = 'published' then now() else published_at end,
         archived_at  = case when p_status = 'archived' then now() else archived_at end
   where id = v_row.id;

  perform core.record_audit(
    p_organization_id,
    'announcement.' || p_status,
    'announcement',
    v_row.id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', p_status, 'audience', v_row.audience, 'title', v_row.title)
  );

  return query select p_status;
end;
$$;

comment on function crm.set_announcement_status(uuid, uuid, text) is
  'Publishes or archives an announcement (owner only; draft → published → archived), stamping the moment and writing audit.audit_log in the same transaction. Records; never sends.';

revoke all on function crm.set_announcement_status(uuid, uuid, text) from public, anon;
grant execute on function crm.set_announcement_status(uuid, uuid, text) to authenticated, service_role;
