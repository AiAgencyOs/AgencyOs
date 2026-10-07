-- Independent review: " .env", ".env " and "a/ .env" slipped past the secrets pattern because the path was matched as typed. The path is normalised
-- (whitespace around the name and around each separator removed) before it is matched.
create or replace function projects.proposal_forbidden_path(p_file text, p_agent text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v_raw text := replace(coalesce(p_file, ''), E'\\', '/');
  v_f text := lower(regexp_replace(btrim(v_raw), '[[:space:]]*/[[:space:]]*', '/', 'g'));
begin
  if v_f ~ '(^|/)\.env[^/]*$' or v_f ~ '(^|/)secrets?(/|\.|$)' or v_f ~ '\.(pem|key|p12|pfx)[[:space:]]*$' or v_f ~ '(^|/)id_(rsa|ed25519)' then return 'secrets'; end if;
  if v_f ~ '(^|/)supabase/migrations(/|$)' and p_agent <> 'database_developer' then return 'migrations'; end if;
  return null;
end $$;
