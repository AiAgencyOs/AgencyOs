-- ═══════════════════════════════════════════════════════════════════════════
-- A person can hold more than one role.
--
-- Every membership has always carried exactly one role — `core.memberships.role`,
-- a single enum column, read once into the session JWT by
-- `core.custom_access_token_hook` and checked by every RLS policy and every
-- `can(role, capability)` call in `src/lib/authz/permissions.ts`. That stays
-- true after this migration: nothing here changes what the column means, what
-- the hook stamps, or what any existing policy or capability check does. This
-- is additive, not a replacement.
--
-- ── what "multirole" means here ───────────────────────────────────────────
--
-- An owner may grant a membership one or more ADDITIONAL internal roles
-- beyond its primary one — an ops_admin who is also given delivery_lead, say,
-- so their effective capabilities become the UNION of both roles' grants
-- (src/lib/authz/permissions.ts's new `effectiveCapabilitiesFor`). The
-- primary role is unchanged and is still what the JWT carries and what RLS
-- reads — this table is consulted only by application-layer capability
-- checks that explicitly opt into it, not by any row-level policy. Stated
-- plainly rather than left to be discovered: granting a secondary role here
-- widens what a person may DO in server actions and admin pages that check
-- for it; it does not widen what rows they can SELECT or UPDATE through
-- PostgREST, because RLS still reads only the primary role from the JWT.
--
-- ── why a person, not a role, is the granularity ──────────────────────────
--
-- Keyed on membership_id rather than (organization_id, user_id) directly: a
-- membership is already the row that owns "this person, in this
-- organization", and reaching it through the same foreign key every other
-- org-scoped child uses keeps the tenancy guard uniform with the 62+
-- relationships `core.enforce_parent_org` already covers.
--
-- ── what is deliberately excluded ─────────────────────────────────────────
--
-- Only the five INTERNAL roles are grantable here — the same five
-- `core.memberships.role` itself admits. `client_admin` and `client_member`
-- belong to `core.client_users`, a different table on a different tenancy
-- surface entirely; a "secondary client role" is not a thing this table
-- describes and the CHECK constraint refuses it rather than silently
-- accepting a role that means nothing in this context.
--
-- Granting a role identical to the membership's own primary role is refused
-- as redundant (`already_primary`) — the union already includes it, and a
-- redundant grant is a row nobody would ever have reason to read.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.membership_roles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  membership_id    uuid not null references core.memberships(id) on delete cascade,
  role             text not null check (role in
                     ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor')),
  granted_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),

  -- One row per (membership, role): granting the same secondary role twice
  -- is a no-op the door answers rather than a second row to keep in step.
  unique (membership_id, role)
);

comment on table core.membership_roles is
  'Additional roles a membership holds beyond its primary core.memberships.role. Application-layer only: consulted by src/lib/authz/permissions.ts''s effectiveCapabilitiesFor for callers that opt in, never by RLS, which still reads only the JWT''s single primary role. Only the five internal roles are grantable; client roles live on core.client_users and are out of scope.';

create index if not exists membership_roles_membership_idx
  on core.membership_roles (membership_id);

create index if not exists membership_roles_organization_idx
  on core.membership_roles (organization_id);

-- ── tenancy, the same pattern every org-scoped child follows ─────────────

create trigger membership_roles_parent_org_membership
  before insert or update of membership_id on core.membership_roles
  for each row execute function core.enforce_parent_org('membership_id', 'core.memberships');

create trigger freeze_org_membership_roles
  before update of organization_id on core.membership_roles
  for each row execute function core.freeze_organization_id();

alter table core.membership_roles enable row level security;
alter table core.membership_roles force row level security;

-- Read: any internal staff member of the organization. Knowing who holds
-- which additional role is not sensitive within the org the same way the
-- grant/revoke act is — every existing roster read (`listInternalRoster`)
-- is already this wide.
drop policy if exists membership_roles_select on core.membership_roles;
create policy membership_roles_select on core.membership_roles
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- No INSERT/UPDATE/DELETE policy: every write goes through the two doors
-- below, which are SECURITY DEFINER and check core.is_owner() themselves —
-- the same shape core.set_default_design_reviewer already established for
-- an owner-gated assignment. Granting or revoking a role is at least as
-- sensitive as approving money (ADM-22's "a human behind every price"); the
-- analogous act here is "a human behind every capability", and that human is
-- the owner alone, not ops_admin — narrower than most of this table's
-- siblings on purpose.
grant select on core.membership_roles to authenticated, service_role;

-- ── the doors ──────────────────────────────────────────────────────────

create or replace function core.grant_secondary_role(
  p_membership_id uuid,
  p_role          text
)
returns table (
  -- 'granted' | 'already_granted' | 'already_primary'
  -- refusals: 'no_actor' | 'not_owner' | 'not_a_member' | 'bad_role'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_target core.memberships;
  v_new    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text, null::uuid; return;
  end if;

  if p_role not in ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor') then
    return query select 'bad_role'::text, null::uuid; return;
  end if;

  select m.* into v_target
    from core.memberships m
   where m.id = p_membership_id and m.organization_id = v_org;

  if v_target.id is null then
    return query select 'not_a_member'::text, null::uuid; return;
  end if;

  -- The union already includes the primary role; granting it again as a
  -- "secondary" would be a row that says nothing a reader does not already
  -- know from core.memberships itself.
  if v_target.role = p_role then
    return query select 'already_primary'::text, null::uuid; return;
  end if;

  insert into core.membership_roles (organization_id, membership_id, role, granted_by)
  values (v_org, p_membership_id, p_role, v_actor)
  on conflict (membership_id, role) do nothing
  returning core.membership_roles.id into v_new;

  if v_new is null then
    return query select 'already_granted'::text, null::uuid; return;
  end if;

  perform core.record_audit(
    v_org, 'membership.secondary_role_granted', 'membership', p_membership_id, null,
    jsonb_build_object('role', p_role, 'grantedBy', v_actor)
  );

  return query select 'granted'::text, v_new;
end;
$$;

comment on function core.grant_secondary_role(uuid, text) is
  'Grants a membership an additional internal role beyond its primary one. Owner only. Refuses a role identical to the membership''s own primary role (already_primary) rather than storing a redundant row, and answers already_granted on a repeat grant rather than erroring, so a caller retrying a timed-out request gets the same outcome either way.';

revoke all on function core.grant_secondary_role(uuid, text) from public, anon;
grant execute on function core.grant_secondary_role(uuid, text) to authenticated;

create or replace function core.revoke_secondary_role(
  p_membership_id uuid,
  p_role          text
)
returns table (
  -- 'revoked' | 'not_granted'
  -- refusals: 'no_actor' | 'not_owner'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_rows  int;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;

  delete from core.membership_roles
   where membership_id = p_membership_id
     and organization_id = v_org
     and role = p_role;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return query select 'not_granted'::text; return;
  end if;

  perform core.record_audit(
    v_org, 'membership.secondary_role_revoked', 'membership', p_membership_id, null,
    jsonb_build_object('role', p_role, 'revokedBy', v_actor)
  );

  return query select 'revoked'::text;
end;
$$;

comment on function core.revoke_secondary_role(uuid, text) is
  'Revokes a membership''s additional internal role. Owner only. A role never granted answers not_granted rather than a generic no-op, because a caller reading the roster should be able to tell "nothing happened" from "there was nothing to undo".';

revoke all on function core.revoke_secondary_role(uuid, text) from public, anon;
grant execute on function core.revoke_secondary_role(uuid, text) to authenticated;

-- ── the read: every membership's secondary roles, for the roster page ────

create or replace function core.list_membership_roles(p_organization_id uuid)
returns table (
  membership_id uuid,
  role          text,
  granted_by    uuid,
  created_at    timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select mr.membership_id, mr.role, mr.granted_by, mr.created_at
    from core.membership_roles mr
   where mr.organization_id = p_organization_id
   order by mr.membership_id, mr.role;
$$;

comment on function core.list_membership_roles(uuid) is
  'Every secondary role granted in an organisation, for the roster page. SECURITY INVOKER — the select policy already scopes this to internal staff of the caller''s own organisation, so this function adds no reach of its own.';

revoke all on function core.list_membership_roles(uuid) from public, anon;
grant execute on function core.list_membership_roles(uuid) to authenticated, service_role;
