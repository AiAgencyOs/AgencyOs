-- ═══════════════════════════════════════════════════════════════════════════
-- A portal user sees the people on its OWN account, not every client's.
--
-- `core.users_select` is `id = auth.uid() OR core.shares_organization(id)`, and
-- `shares_organization` is where the tenant boundary is drawn. Its membership
-- branch is right — a client sees the agency's staff, whom they work with. But
-- its client_users branch scoped only by `organization_id`, and a portal user's
-- organization_id IS the agency's org (the auth hook stamps it from
-- client_users), identical to staff. So for a signed-in CLIENT the branch
-- returned true for every OTHER client account's portal users too — and
-- `core.users` carries name, email and avatar. A client could `GET
-- /rest/v1/users` with their own token and read the name and email of every
-- rival client's people in the agency: cross-client PII enumeration, from an
-- ordinary multi-client portal, no credential or owner action required.
--
-- The join table `core.client_users` already gets this right — its select policy
-- restricts a client to `client_account_id = current_client_account_id()` — but
-- the PII-bearing `core.users` did not. The fix adds the same account scope to
-- the client_users branch, and only for a client caller: an internal caller
-- (`current_client_account_id()` is null) still sees every user in the org, so
-- staff visibility is unchanged; a client sees themselves, the staff, and the
-- portal users on their own account, and no other client's.
--
-- `shares_organization` is used by exactly one policy (`users_select`), so this
-- changes nothing else. `create or replace`, same signature.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.shares_organization(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from core.memberships m
     where m.user_id = target_user_id
       and m.organization_id = core.current_organization_id()
       and m.status = 'active'
  ) or exists (
    select 1
      from core.client_users cu
     where cu.user_id = target_user_id
       and cu.organization_id = core.current_organization_id()
       and cu.status = 'active'
       -- A client caller sees only the portal users on its OWN account; an
       -- internal caller (null client account) sees every client user in the
       -- org, as before. Without this, a portal user reads every other client's
       -- name and email through core.users.
       and (core.current_client_account_id() is null
            or cu.client_account_id = core.current_client_account_id())
  );
$$;

comment on function core.shares_organization(uuid) is
  'Whether the caller may see this user: a member of the caller''s org, or a client user in it — and, for a CLIENT caller, only a client user on the caller''s own client_account, so a portal user cannot enumerate other clients'' names and emails through core.users. Used by core.users_select. SECURITY DEFINER to read the membership and client_user tables past their own RLS.';
