-- ═══════════════════════════════════════════════════════════════════════════
-- A baseline needs a way to fill it.
--
-- 20260821180000 built the scope baseline (`projects.scope_versions`,
-- `.scope_items`) and its own comment says the reason plainly: "every write
-- goes through a service function, so a browser cannot move a baseline by
-- PATCH." 20260821190000 then built `open_scope_version` (draft a version)
-- and `freeze_scope_version` (lock it) — but never the door in between.
-- `scope_items` carries only a SELECT policy; nothing, anywhere, could ever
-- insert one. `freeze_scope_version` refuses `empty` when a version has zero
-- items, which — with no way to add one — made freezing permanently
-- unreachable. The Admin Panel rebuild's audit of every qa/projects table
-- found this while scoping the Test Plans screen (SCR-045), which needs a
-- frozen scope version to write a plan against and had none to point at.
--
-- Same authority as the version doors: `core.can_manage_delivery()`
-- (owner, ops_admin, delivery_lead) — the same three roles
-- `projects.modules`'s `can_manage_delivery()` RLS policy admits, since
-- assembling a scope baseline is the same kind of delivery-management act.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.add_scope_item(
  p_scope_version_id     uuid,
  p_title                text,
  p_detail               text default null,
  p_inclusion            text default 'included',
  p_acceptance_criteria  text default null,
  p_feature_id           uuid default null
)
returns table (
  -- 'added'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_draft' | 'bad_title' | 'bad_inclusion'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_status  text;
  v_next    int;
  v_new     uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  if p_title is null or length(trim(p_title)) = 0 then
    return query select 'bad_title'::text, null::uuid; return;
  end if;

  if p_inclusion not in ('included', 'excluded', 'optional') then
    return query select 'bad_inclusion'::text, null::uuid; return;
  end if;

  select sv.organization_id, sv.status into v_org, v_status
    from projects.scope_versions sv
   where sv.id = p_scope_version_id
     and sv.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  if v_status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  select coalesce(max(si.position), -1) + 1 into v_next
    from projects.scope_items si
   where si.scope_version_id = p_scope_version_id;

  insert into projects.scope_items (
    organization_id, scope_version_id, feature_id, title, detail,
    inclusion, acceptance_criteria, position
  )
  values (
    v_org, p_scope_version_id, p_feature_id, trim(p_title), p_detail,
    p_inclusion, p_acceptance_criteria, v_next
  )
  returning projects.scope_items.id into v_new;

  return query select 'added'::text, v_new;
end;
$$;

comment on function projects.add_scope_item(uuid, text, text, text, text, uuid) is
  'Adds a line to a DRAFT scope version. can_manage_delivery() only (owner, ops_admin, delivery_lead). Refuses not_draft once the version is frozen — scope_items has no RLS write policy at all, so this door is the only way a line can ever exist, matching the table''s own "every write goes through a service function" design.';

revoke all on function projects.add_scope_item(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function projects.add_scope_item(uuid, text, text, text, text, uuid) to authenticated;

create or replace function projects.remove_scope_item(p_scope_item_id uuid)
returns table (
  -- 'removed'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_draft'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_status text;
  v_rows   int;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select sv.status into v_status
    from projects.scope_items si
    join projects.scope_versions sv on sv.id = si.scope_version_id
   where si.id = p_scope_item_id
     and si.organization_id = (select core.current_organization_id());

  if v_status is null then
    return query select 'not_found'::text; return;
  end if;

  if v_status <> 'draft' then
    return query select 'not_draft'::text; return;
  end if;

  delete from projects.scope_items where id = p_scope_item_id;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return query select 'not_found'::text; return;
  end if;

  return query select 'removed'::text;
end;
$$;

comment on function projects.remove_scope_item(uuid) is
  'Removes a line from a DRAFT scope version. can_manage_delivery() only. The refuse_frozen_scope_item trigger would also refuse a frozen delete; this door checks first so the caller gets not_draft rather than a raised exception.';

revoke all on function projects.remove_scope_item(uuid) from public, anon;
grant execute on function projects.remove_scope_item(uuid) to authenticated;
