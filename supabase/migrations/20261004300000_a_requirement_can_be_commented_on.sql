-- ═══════════════════════════════════════════════════════════════════════════
-- A requirement can be commented on.
--
-- Stream Q3 — the project Requirements tab (reference images 29 and 41: the
-- requirement list and the requirement detail panel). The panel is built from
-- what the model already holds: a requirement is a `projects.scope_items` row
-- on the project's active (or draft) scope version, carrying its title, its
-- detail and its acceptance criteria. Its module is the feature it is planned
-- under; its delivery state is that feature's state.
--
-- One thing was missing: the panel's "Comments" — a place for the team to
-- say something about a requirement WITHOUT reopening a frozen baseline. A
-- scope item cannot take the note itself (`projects.refuse_frozen_scope_item`
-- freezes the row with its version, on purpose), so a comment is a row
-- beside it: `projects.scope_item_comments`.
--
--   • append-only: there is a door to add one and none to edit or delete —
--     a comment on a requirement is part of why the requirement is what it
--     is, so it is never rewritten;
--   • org-scoped, RLS enabled and forced, internal SELECT;
--   • NO write grant to `authenticated`: the only way in is
--     `projects.comment_on_scope_item`, which re-checks the role
--     (`core.can_write()`, the four writing internal roles) and writes an
--     audit row `scope_item.commented`;
--   • the item must belong to the caller's organization (refused as
--     not_found otherwise — the same answer whether the item is absent or
--     another tenant's).
--
-- Idempotent: every statement is create-if-not-exists / create-or-replace /
-- drop-then-create.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.scope_item_comments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  scope_item_id    uuid not null references projects.scope_items(id) on delete cascade,
  author_id        uuid references core.users(id) on delete set null,
  body             text not null check (length(btrim(body)) between 1 and 2000),
  created_at       timestamptz not null default now()
);

comment on table projects.scope_item_comments is
  'Q3: a note on one requirement (scope item) of a project''s scope. Append-only; written only through projects.comment_on_scope_item, which audits it. A scope item itself is frozen with its version, so the conversation about it lives beside it.';

create index if not exists scope_item_comments_item_idx
  on projects.scope_item_comments (scope_item_id, created_at);
create index if not exists scope_item_comments_organization_idx
  on projects.scope_item_comments (organization_id, created_at desc);

drop trigger if exists org_match_scope_item_comments_item on projects.scope_item_comments;
create trigger org_match_scope_item_comments_item
  before insert or update of scope_item_id, organization_id on projects.scope_item_comments
  for each row execute function core.enforce_parent_org('scope_item_id', 'projects.scope_items');

drop trigger if exists freeze_org_scope_item_comments on projects.scope_item_comments;
create trigger freeze_org_scope_item_comments
  before update of organization_id on projects.scope_item_comments
  for each row execute function core.freeze_organization_id();

alter table projects.scope_item_comments enable row level security;
alter table projects.scope_item_comments force row level security;

drop policy if exists scope_item_comments_select on projects.scope_item_comments;
create policy scope_item_comments_select on projects.scope_item_comments
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- SELECT only: no insert / update / delete for an end user, on any path.
revoke all on projects.scope_item_comments from public, anon, authenticated;
grant select on projects.scope_item_comments to authenticated;
grant select, insert, update, delete on projects.scope_item_comments to service_role;

create or replace function projects.comment_on_scope_item(
  p_scope_item_id uuid,
  p_body          text
)
returns table (
  -- 'commented' (comment_id set)
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'empty' | 'too_long'
  outcome    text,
  comment_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_body  text := btrim(coalesce(p_body, ''));
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  if length(v_body) = 0 then
    return query select 'empty'::text, null::uuid; return;
  end if;
  if length(v_body) > 2000 then
    return query select 'too_long'::text, null::uuid; return;
  end if;

  select i.organization_id into v_org
    from projects.scope_items i
   where i.id = p_scope_item_id
     and i.organization_id = (select core.current_organization_id());
  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  insert into projects.scope_item_comments (organization_id, scope_item_id, author_id, body)
  values (v_org, p_scope_item_id, v_actor, v_body)
  returning id into v_id;

  perform core.record_audit(
    v_org,
    'scope_item.commented',
    'scope_item', p_scope_item_id,
    null,
    jsonb_build_object('comment_id', v_id, 'length', length(v_body))
  );

  return query select 'commented'::text, v_id;
end;
$$;

comment on function projects.comment_on_scope_item(uuid, text) is
  'Q3: appends a comment to a requirement (scope item) of the caller''s organization. core.can_write(). Refuses no_actor, not_authorized, empty, too_long, not_found. Audits scope_item.commented (the comment id and its length, not its text).';

revoke all on function projects.comment_on_scope_item(uuid, text) from public, anon;
grant execute on function projects.comment_on_scope_item(uuid, text) to authenticated, service_role;
