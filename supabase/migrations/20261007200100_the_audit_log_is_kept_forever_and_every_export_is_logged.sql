-- X2 / decision 11 (2026-10-01): the audit log is kept forever; the owner and
-- the ops admin may export it; every export is itself an audit event.
--
-- 1. KEPT FOREVER. There was already no delete path: no DELETE/UPDATE policy,
--    and `audit_log_no_update` / `audit_log_no_delete` row triggers
--    (20260807120003_audit.sql). Two holes remained that this closes:
--      a. TRUNCATE is not a row operation, so neither trigger fired for it, and
--         service_role holds TRUNCATE. A statement-level BEFORE TRUNCATE trigger
--         now refuses it, for every role.
--      b. `authenticated` was GRANTed UPDATE and DELETE on the table (refused
--         only by the absent policy and the trigger). The grants are revoked,
--         so the privilege layer says what the triggers say.
--    No retention job, purge or archive function exists or is added.
--
-- 2. EXPORT IS A DOOR. `audit.log_audit_export(filters, row_count)` is the only
--    way the export route may produce a file: it re-checks core.is_admin()
--    (owner or ops admin, primary or secondary role) and appends one
--    `audit.exported` row naming the actor, the filters used and the number of
--    rows in the file. The route logs BEFORE it sends the file and refuses to
--    send when the log fails, so no export exists without its audit event.
--
-- Additive and idempotent.

create or replace function audit.reject_truncate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'audit.audit_log is kept forever (attempted TRUNCATE)'
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_log_no_truncate on audit.audit_log;
create trigger audit_log_no_truncate
  before truncate on audit.audit_log
  for each statement execute function audit.reject_truncate();

revoke update, delete, truncate on audit.audit_log from authenticated, anon;

comment on table audit.audit_log is
  'Append-only and kept forever (owner decision 11, 2026-10-01): no UPDATE, DELETE or TRUNCATE for any role (triggers audit_log_no_update, audit_log_no_delete, audit_log_no_truncate). Every export is itself recorded as audit.exported.';

create or replace function audit.log_audit_export(
  p_filters   jsonb,
  p_row_count integer
)
returns table (outcome text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_row_count is null or p_row_count < 0 then
    return query select 'bad_count'::text; return;
  end if;
  if p_filters is not null and jsonb_typeof(p_filters) <> 'object' then
    return query select 'bad_filters'::text; return;
  end if;

  perform core.record_audit(
    v_org, 'audit.exported', 'audit_log', null, null,
    jsonb_build_object('format', 'csv', 'rows', p_row_count, 'filters', coalesce(p_filters, '{}'::jsonb))
  );
  return query select 'logged'::text;
end;
$$;

comment on function audit.log_audit_export(jsonb, integer) is
  'X2 decision 11 - records that the audit log was exported (who, the filters, how many rows) as an audit.exported entry. Owner or ops admin only. The export route calls it before sending the file and sends nothing when it fails.';

revoke all on function audit.log_audit_export(jsonb, integer) from public, anon;
grant execute on function audit.log_audit_export(jsonb, integer) to authenticated;

notify pgrst, 'reload schema';
