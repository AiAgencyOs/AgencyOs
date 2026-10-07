-- Shared helpers for the p4q verifiers (included with \ir inside an open transaction). Nothing here touches data.
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.as_nobody() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '', true); end $$;
grant execute on function pg_temp.as_nobody() to public;
create temp table fx (k text primary key, v text);
grant all on fx to public;
create or replace function pg_temp.fx(p text) returns uuid language sql stable as $$ select v::uuid from fx where k = p $$;
grant execute on function pg_temp.fx(text) to public;
create or replace function pg_temp.direct(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'allowed'; exception when others then return 'refused'; end $$;
grant execute on function pg_temp.direct(text) to public;
-- RED-PROOF: mutate the LIVE definition, run the probe (true = the control still holds), restore by rolling the block back. A no-op mutation raises.
create or replace function pg_temp.red(p_what text, p_fn text, p_from text, p_to text, p_probe text) returns void language plpgsql as $$
declare d text; m text; held boolean := false; ok boolean;
begin
  d := pg_get_functiondef(p_fn::regprocedure);
  m := replace(d, p_from, p_to);
  if m = d then raise exception 'RED-PROOF DID NOT RUN (the mutation changed nothing): %', p_what; end if;
  begin
    execute m;
    begin execute p_probe into ok; exception when others then ok := false; end;
    held := coalesce(ok, false);
    raise exception 'restore';
  exception when others then
    if sqlerrm <> 'restore' then raise; end if;
  end;
  if held then raise exception 'RED-PROOF FAILED: the control still holds with % mutated (%)', p_fn, p_what; end if;
  raise notice 'red %', p_what;
end $$;
grant execute on function pg_temp.red(text, text, text, text, text) to public;
