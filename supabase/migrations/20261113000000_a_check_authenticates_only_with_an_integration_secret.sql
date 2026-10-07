-- Independent review (TypeScript, finding 1): a check authenticated with ANY server environment variable whose NAME a person typed, and sent it to a URL the
-- person typed. A secret reference is now confined to INTEGRATION_... names (a secret created for integrations), in the door and in the table. Existing rows are
-- not rewritten (NOT VALID); a row with another name is simply refused at check time by the runner.
do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('projects.set_integration_check_target(uuid,text,text)'::regprocedure);
  n := replace(d, '!~ ''^[A-Z][A-Z0-9_]{2,63}$''', '!~ ''^INTEGRATION_[A-Z0-9_]{2,50}$''');
  if n = d then raise exception 'set_integration_check_target: expected text not found'; end if;
  execute n;
end $m$;
alter table projects.integration_connections drop constraint if exists integration_credential_ref_name;
alter table projects.integration_connections add constraint integration_credential_ref_name check (credential_ref is null or credential_ref ~ '^INTEGRATION_[A-Z0-9_]{2,50}$') not valid;
notify pgrst, 'reload schema';
