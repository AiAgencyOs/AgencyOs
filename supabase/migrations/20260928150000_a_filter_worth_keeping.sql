-- Saved views — the shared filtering rule's "saved views for frequent
-- workflows" (screen architecture page 5), and SCR-018's own list of what
-- All Projects needs. Every list screen in the admin panel already expresses
-- its filter and sort state entirely in the URL query string (`?status=sent`,
-- `?sort=total&dir=desc`); a saved view is a name for one such string,
-- nothing more — no second copy of the filtering logic, no interpretation of
-- what the query string means. The page that reads it back is the only place
-- that ever parses it, exactly as it already does for a typed URL.
--
-- Personal, not shared: `user_id` scopes every row, because a filter someone
-- finds useful is a fact about how they work, not a policy the organization
-- imposes on every seat. Two people on the same team can keep different
-- named views of the same page without either seeing the other's.

create table if not exists core.saved_views (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  user_id          uuid not null references core.users(id) on delete cascade,

  -- The route this view belongs to, e.g. `/quotations` — never a full URL,
  -- so a view never smuggles a different page's filters into this one.
  page             text not null check (length(btrim(page)) > 0 and length(page) <= 200),

  name             text not null check (length(btrim(name)) between 1 and 60),

  -- The query string alone (no leading `?`), e.g. `status=sent&sort=total&dir=desc`.
  -- Opaque here on purpose — see the header note.
  query            text not null default '' check (length(query) <= 2000),

  created_at       timestamptz not null default now()
);

comment on table core.saved_views is
  'A named filter/sort preset for one list screen, scoped to the user who saved it. The query column is an opaque URL query string the owning page already knows how to parse — this table never interprets it.';

-- One name per person per page — saving "Overdue" twice on the same screen
-- replaces the old one rather than creating a second, indistinguishable entry.
create unique index if not exists saved_views_user_page_name_key
  on core.saved_views (user_id, page, lower(btrim(name)));

create index if not exists saved_views_user_page_idx
  on core.saved_views (user_id, page, created_at desc);

alter table core.saved_views enable row level security;
alter table core.saved_views force row level security;

drop policy if exists saved_views_select on core.saved_views;
create policy saved_views_select on core.saved_views
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  );

drop policy if exists saved_views_write on core.saved_views;
create policy saved_views_write on core.saved_views
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  );

drop policy if exists saved_views_delete on core.saved_views;
create policy saved_views_delete on core.saved_views
  for delete to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and user_id = (select auth.uid())
  );

-- No update policy: a saved view is replaced (delete + insert, the unique
-- index above makes the "same name" case a clean swap) rather than edited in
-- place — one fewer state transition for a value this small to get wrong.

drop trigger if exists freeze_org_saved_views on core.saved_views;
create trigger freeze_org_saved_views
  before update on core.saved_views
  for each row execute function core.freeze_organization_id();
