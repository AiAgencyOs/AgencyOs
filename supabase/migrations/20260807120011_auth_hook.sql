-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — Authentication: token claims hook, profile sync, bootstrap
--
-- This migration is what makes Feature 2's RLS actually work. Until now
-- core.current_organization_id() returned NULL for everyone and every policy
-- denied. The hook below runs at token issuance and stamps the tenancy claims
-- those policies read.
--
-- REQUIRES A DASHBOARD STEP: Authentication → Hooks → Customize Access Token
-- must be pointed at core.custom_access_token_hook. Without it the function
-- exists but is never called, and every policy keeps denying.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- Profile sync: auth.users → core.users
--
-- SECURITY DEFINER because the trigger fires in the auth subsystem's context,
-- which has no rights on core.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into core.users (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
     set email      = excluded.email,
         full_name  = coalesce(excluded.full_name, core.users.full_name),
         avatar_url = coalesce(excluded.avatar_url, core.users.avatar_url);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function core.handle_new_auth_user();

-- ═══════════════════════════════════════════════════════════════════════════
-- V1 bootstrap: the first user to sign in becomes owner.
--
-- Without this there is a deadlock: memberships grant claims, claims are
-- required to write memberships, and nobody can create the first one. The
-- guard is deliberately narrow — it fires only when there are zero memberships
-- and exactly one organization, i.e. a fresh single-tenant install.
--
-- When multi-tenant signup arrives this becomes an invite flow and this
-- function should be dropped.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.bootstrap_first_owner(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_org_count int;
  v_member_count int;
begin
  select count(*) into v_member_count from core.memberships;
  if v_member_count > 0 then
    return null;
  end if;

  select count(*) into v_org_count from core.organizations;
  if v_org_count <> 1 then
    return null;
  end if;

  select id into v_org_id from core.organizations limit 1;

  insert into core.memberships (organization_id, user_id, role, status)
  values (v_org_id, p_user_id, 'owner', 'active')
  on conflict (organization_id, user_id) do nothing;

  return v_org_id;
end;
$$;

revoke all on function core.bootstrap_first_owner(uuid) from public, anon;
grant execute on function core.bootstrap_first_owner(uuid) to authenticated, service_role;

-- PostgREST resolves rpc() against `public`, and `public` is always exposed.
-- This thin wrapper keeps the logic in core while giving the app one reliable
-- entry point that works before the module schemas are on the exposed list.
create or replace function public.bootstrap_first_owner(p_user_id uuid)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select core.bootstrap_first_owner(p_user_id);
$$;

revoke all on function public.bootstrap_first_owner(uuid) from public, anon;
grant execute on function public.bootstrap_first_owner(uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOM ACCESS TOKEN HOOK
--
-- Supabase Auth calls this on every token issue and refresh. Whatever it puts
-- in app_metadata becomes a signed claim the client cannot forge — which is
-- precisely why RLS trusts it and never trusts request data.
--
-- Resolution order:
--   1. internal staff  → core.memberships       (organization_id, role)
--   2. portal user     → core.client_users      (+ client_account_id)
--   3. neither         → no claims, so RLS denies everything
--
-- SECURITY DEFINER so it can read those tables regardless of RLS. It returns
-- only claims, never rows.
--
-- It must never throw: an exception here breaks login entirely. The exception
-- handler degrades to a claimless token, which denies access rather than
-- granting it.
-- ═══════════════════════════════════════════════════════════════════════════
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
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_app_metadata := coalesce(v_claims -> 'app_metadata', '{}'::jsonb);

  -- 1. Internal staff
  select m.organization_id, m.role
    into v_membership
    from core.memberships m
   where m.user_id = v_user_id
     and m.status = 'active'
   order by
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

-- Only the auth subsystem may invoke the hook.
revoke all on function core.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function core.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- The auth role needs to reach the tables the hook reads. Guarded because
-- supabase_auth_admin does not exist on every Postgres deployment.
do $$
begin
  execute 'grant usage on schema core to supabase_auth_admin';
  execute 'grant select on core.memberships to supabase_auth_admin';
  execute 'grant select on core.client_users to supabase_auth_admin';
  execute 'grant select on core.organizations to supabase_auth_admin';
exception when undefined_object then
  raise warning 'supabase_auth_admin role not present; skipping hook grants.';
end;
$$;

comment on function core.custom_access_token_hook(jsonb) is
  'Supabase Auth token hook. Stamps organization_id, role, and client_account_id into app_metadata so RLS can trust them. Enable at Authentication -> Hooks -> Customize Access Token.';
