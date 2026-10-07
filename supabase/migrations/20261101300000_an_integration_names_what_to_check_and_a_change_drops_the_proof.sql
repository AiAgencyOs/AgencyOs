-- P5-INTEG-02 / INT5-T036, T039: an integration names the endpoint a check calls and the NAME of the secret it authenticates with (never the value).
-- Changing either drops VERIFIED: the proof described a connection that no longer exists. Checks are written by the adapter runner (service role).
alter table projects.integration_connections
  add column if not exists check_url text,
  add column if not exists credential_ref text,
  add column if not exists last_check_at timestamptz,
  add column if not exists last_check_class text;
alter table projects.integration_connections drop constraint if exists integration_check_url_https;
alter table projects.integration_connections add constraint integration_check_url_https check (check_url is null or check_url ~ '^https://[^ ]+$');
alter table projects.integration_connections drop constraint if exists integration_credential_ref_name;
alter table projects.integration_connections add constraint integration_credential_ref_name check (credential_ref is null or credential_ref ~ '^[A-Z][A-Z0-9_]{2,63}$');

create or replace function projects.set_integration_check_target(p_connection_id uuid, p_check_url text, p_credential_ref text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_row projects.integration_connections;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_check_url is null or p_check_url !~ '^https://[^ ]+$' then return query select 'bad_url'::text; return; end if;
  if p_credential_ref is not null and p_credential_ref !~ '^[A-Z][A-Z0-9_]{2,63}$' then return query select 'bad_credential_name'::text; return; end if;
  select * into v_row from projects.integration_connections c where c.id = p_connection_id and c.organization_id = v_org for update;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  perform set_config('projects.integration_sanctioned', 'on', true);
  update projects.integration_connections
     set check_url = p_check_url, credential_ref = p_credential_ref,
         -- a changed target is a different connection: the proof is dropped and the integration is only configured until a check passes again
         health = case when health = 'verified' and (check_url is distinct from p_check_url or credential_ref is distinct from p_credential_ref) then 'configured' else health end,
         verification_evidence = case when health = 'verified' and (check_url is distinct from p_check_url or credential_ref is distinct from p_credential_ref) then null else verification_evidence end,
         verified_at = case when health = 'verified' and (check_url is distinct from p_check_url or credential_ref is distinct from p_credential_ref) then null else verified_at end,
         verified_by_adapter = case when health = 'verified' and (check_url is distinct from p_check_url or credential_ref is distinct from p_credential_ref) then null else verified_by_adapter end
   where id = v_row.id;
  perform core.record_audit(v_org, 'integration.check_target_set', 'integration_connection', v_row.id, null, jsonb_build_object('checkUrl', p_check_url, 'credentialRef', p_credential_ref));
  return query select 'set'::text;
end $$;
revoke all on function projects.set_integration_check_target(uuid, text, text) from public, anon;
grant execute on function projects.set_integration_check_target(uuid, text, text) to authenticated;

-- the adapter runner's note of WHAT a check found (class, time) beside the health it recorded
create or replace function projects.note_integration_check(p_connection_id uuid, p_class text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'adapter_only'::text; return; end if;
  if p_class not in ('ok', 'unauthorized', 'not_found', 'rate_limited', 'server_error', 'timeout', 'network', 'credential_missing', 'no_target') then return query select 'bad_class'::text; return; end if;
  update projects.integration_connections set last_check_at = now(), last_check_class = p_class where id = p_connection_id;
  if not found then return query select 'not_found'::text; return; end if;
  return query select 'noted'::text;
end $$;
revoke all on function projects.note_integration_check(uuid, text) from public, anon, authenticated;
grant execute on function projects.note_integration_check(uuid, text) to service_role;
notify pgrst, 'reload schema';
