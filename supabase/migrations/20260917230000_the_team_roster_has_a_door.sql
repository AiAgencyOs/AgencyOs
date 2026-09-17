-- ═══════════════════════════════════════════════════════════════════════════
-- The team roster has a door.
--
-- Master §6, P2-05: *"Build Default Team Members settings."*
--
-- G-253 built `projects.group_team_defaults` — the roster every WhatsApp group
-- card is prepared from — with a SELECT policy, no write policy and **no
-- door**. Nothing in the product could put a person in it. Every card since
-- has therefore shipped with the client's contacts and **none of the agency's
-- own team**, which is exactly the list an Admin needs when they open WhatsApp
-- to make the group.
--
-- That is the same defect G-254 fixed for the card and G-263 for the phase:
-- **a table nobody can write to is a table that does not exist.** It is
-- recorded here rather than quietly filled in, because three units shipped
-- between G-253 and this one and none of them noticed.
--
-- ── removing a person is safe, and that is not an accident ───────────────
--
-- A card's member list is a **copy**, taken when the card is raised and frozen
-- when the group is confirmed (G-253). So deleting somebody from the roster
-- cannot rewrite a group that already exists — which is the property that
-- copy was chosen for, now being relied on.
--
-- `active = false` is still the softer answer and stays the default gesture:
-- it keeps a person on the roster without putting them in the next group,
-- which is what happens when somebody leaves a project rather than the
-- company. Deletion is for a row that should never have been there.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.add_team_default(
  p_display_name text,
  p_phone text,
  p_role text default null,
  p_position int default 0
)
returns table (
  -- 'added' | 'already_listed' | 'invalid_phone' | 'no_actor' | 'forbidden'
  outcome text,
  member_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_new   uuid;
begin
  -- The same shape the column checks, refused here first so a person pasting a
  -- name into the number field is told which field, not which constraint.
  if v_phone is null or v_phone !~ '^\+?[0-9]{6,20}$' then
    return query select 'invalid_phone'::text, null::uuid; return;
  end if;

  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  v_org := (select core.current_organization_id());
  if v_org is null or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- One row per number: two entries for the same phone is two names for one
  -- person in a group of eight. Answered rather than raised, because adding
  -- somebody who is already there is not a mistake worth an error.
  select d.id into v_new
    from projects.group_team_defaults d
   where d.organization_id = v_org and d.phone = v_phone;
  if v_new is not null then
    return query select 'already_listed'::text, v_new; return;
  end if;

  insert into projects.group_team_defaults (organization_id, display_name, phone, role, position)
  values (v_org, btrim(p_display_name), v_phone, nullif(btrim(coalesce(p_role, '')), ''), coalesce(p_position, 0))
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$$;

comment on function projects.add_team_default(text, text, text, int) is
  'Master section 6 P2-05 - put a person on the roster every WhatsApp group card is prepared from. Adding somebody already listed answers already_listed rather than raising: it is not a mistake worth an error.';

create or replace function projects.set_team_default_active(
  p_member_id uuid,
  p_active boolean
)
returns table (
  -- 'set' | 'unchanged' | 'unknown_member' | 'no_actor' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_team_defaults;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  select d.* into v_row from projects.group_team_defaults d where d.id = p_member_id for update;
  if v_row.id is null then
    return query select 'unknown_member'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.active = p_active then
    return query select 'unchanged'::text; return;
  end if;

  update projects.group_team_defaults set active = p_active where id = v_row.id;
  return query select 'set'::text;
end;
$$;

comment on function projects.set_team_default_active(uuid, boolean) is
  'Master section 6 - preselected or not. Inactive keeps a person on the roster without putting them in the next group, which is what happens when somebody leaves a project rather than the company.';

create or replace function projects.remove_team_default(p_member_id uuid)
returns table (
  -- 'removed' | 'unknown_member' | 'no_actor' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.group_team_defaults;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  select d.* into v_row from projects.group_team_defaults d where d.id = p_member_id for update;
  if v_row.id is null then
    return query select 'unknown_member'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  -- Safe because a card's member list is a COPY (G-253): deleting somebody
  -- here cannot reach into a group that already exists. That is the property
  -- the copy was chosen for.
  delete from projects.group_team_defaults where id = v_row.id;
  return query select 'removed'::text;
end;
$$;

comment on function projects.remove_team_default(uuid) is
  'Master section 6. Safe because a group card copies its member list rather than referencing the roster (G-253), so a deletion cannot rewrite a group that already exists. Deactivating is still the softer gesture; this is for a row that should never have been there.';

revoke all on function projects.add_team_default(text, text, text, int) from public;
revoke all on function projects.set_team_default_active(uuid, boolean) from public;
revoke all on function projects.remove_team_default(uuid) from public;

grant execute on function projects.add_team_default(text, text, text, int) to authenticated;
grant execute on function projects.set_team_default_active(uuid, boolean) to authenticated;
grant execute on function projects.remove_team_default(uuid) to authenticated;

notify pgrst, 'reload schema';
