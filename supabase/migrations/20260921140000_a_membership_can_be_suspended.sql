-- ═══════════════════════════════════════════════════════════════════════════
-- A membership can be suspended.
--
-- `core.memberships.status` has admitted 'active' | 'suspended' since the
-- table was created, and `core.custom_access_token_hook` (20260807120011)
-- already filters `m.status = 'active'` when it resolves which membership to
-- stamp into a new session token — suspension was already wired all the way
-- through to sign-in. What has never existed is a door: nothing in the
-- application has ever written 'suspended'. The Admin Panel's Users & Roles
-- screen is the first caller — an owner revoking a person's access without
-- deleting their history (their audit trail, their authored records, every
-- FK that points at their membership all stay intact; a suspended membership
-- just stops being the one the hook selects).
--
-- Takes effect on the person's NEXT token mint or refresh, not instantly —
-- an existing access token stays valid for whatever window Supabase issued
-- it with. This migration does not attempt to invalidate a live session; that
-- is a Supabase Auth admin operation (revoking refresh tokens), out of scope
-- for a database function.
--
-- ── the guard this migration exists to have ────────────────────────────────
--
-- Suspending the LAST active owner would leave the organization with nobody
-- able to grant roles, approve refunds, or reverse the suspension itself —
-- a lockout with no recovery path short of direct database access. The door
-- refuses ('last_owner') rather than allowing it. Self-suspension is refused
-- outright ('self') for the same reason one step earlier: an owner locking
-- out their own account is very rarely the click they meant to make.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.set_membership_status(
  p_membership_id uuid,
  p_status        text
)
returns table (
  -- 'updated'
  -- refusals: 'no_actor' | 'not_owner' | 'not_a_member' | 'bad_status' | 'unchanged' | 'last_owner' | 'self'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_org         uuid := (select core.current_organization_id());
  v_target      core.memberships;
  v_owner_count int;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;

  if p_status not in ('active', 'suspended') then
    return query select 'bad_status'::text; return;
  end if;

  select m.* into v_target
    from core.memberships m
   where m.id = p_membership_id and m.organization_id = v_org;

  if v_target.id is null then
    return query select 'not_a_member'::text; return;
  end if;

  if v_target.status = p_status then
    return query select 'unchanged'::text; return;
  end if;

  if p_status = 'suspended' and v_target.user_id = v_actor then
    return query select 'self'::text; return;
  end if;

  if p_status = 'suspended' and v_target.role = 'owner' then
    select count(*) into v_owner_count
      from core.memberships m
     where m.organization_id = v_org and m.role = 'owner' and m.status = 'active';

    if v_owner_count <= 1 then
      return query select 'last_owner'::text; return;
    end if;
  end if;

  update core.memberships
     set status = p_status, updated_at = now()
   where id = p_membership_id;

  perform core.record_audit(
    v_org, 'membership.status_changed', 'membership', p_membership_id, jsonb_build_object('status', v_target.status),
    jsonb_build_object('status', p_status, 'changedBy', v_actor)
  );

  return query select 'updated'::text;
end;
$$;

comment on function core.set_membership_status(uuid, text) is
  'Suspends or reactivates an internal membership. Owner only. Refuses last_owner rather than suspending the sole remaining active owner, and self rather than letting an owner suspend their own membership — both would risk a lockout with no recovery path short of direct database access. Takes effect on the affected person''s next token mint/refresh, per core.custom_access_token_hook''s existing status filter.';

revoke all on function core.set_membership_status(uuid, text) from public, anon;
grant execute on function core.set_membership_status(uuid, text) to authenticated;
