-- ═══════════════════════════════════════════════════════════════════════════
-- The agency timezone is set through an audited function, and a valid single-
-- label zone like UTC is accepted — G-137 operability.
--
-- Two defects the reactivation work surfaced:
--
--   1. VALIDATION MISMATCH. The app validates a timezone with Intl (isValidTimeZone),
--      which accepts single-label IANA zones — UTC, GMT — but the column CHECK
--      required at least one '/'. So an owner whose real zone is UTC passed the
--      app check and then hit a raw CHECK violation: the app said yes, the
--      database said no. The CHECK is now the honest shape-guard it was meant to
--      be (zero-to-two segments), and the AUTHORITY moves to pg_timezone_names —
--      Postgres's own IANA list, exactly the set the old comment wished it could
--      name — checked inside the setter below.
--
--   2. UNAUDITED. Every other operational setting is written through a function
--      that re-checks authority in-DB and records an audit row (set_reactivation_
--      pilot). The timezone was a plain PostgREST UPDATE on RLS + CHECK alone —
--      no audit, so the one fact the whole follow-up engine waits on could change
--      with no trace. It now goes through core.set_agency_timezone, and a guard
--      refuses any other authenticated write of the column, the same shape the
--      pilot flag uses.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. The CHECK stops rejecting valid single-label zones. `{0,2}` admits UTC (no
--    segment), Asia/Kolkata (one) and America/Argentina/Buenos_Aires (two). It
--    stays a loose shape-guard for the service-role path; pg_timezone_names in
--    the setter is the real validator for the sanctioned path.
alter table core.organizations drop constraint if exists organizations_timezone_iana;
alter table core.organizations add constraint organizations_timezone_iana
  check (
    timezone is null
    or timezone ~ '^[A-Za-z]+(_[A-Za-z]+)*(/[A-Za-z0-9+_-]+){0,2}$'
  );

-- 2. The audited setter. Mirrors core.set_reactivation_pilot: an authenticated
--    caller must be owner/ops_admin and pinned to its own org; a service-role
--    caller (identity-less) is trusted. The zone is validated against the real
--    IANA set, the write is flagged so the guard admits it, and an audit row is
--    written in the same transaction (core.organizations has no row-change audit
--    trigger, so it is explicit, as the pilot toggle does).
create or replace function core.set_agency_timezone(p_organization_id uuid, p_timezone text)
returns table (outcome text)   -- 'set' | 'forbidden' | 'not_found' | 'invalid'
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_was   text;
  v_tz    text := nullif(btrim(coalesce(p_timezone, '')), '');
begin
  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text; return;
    end if;
    if p_organization_id is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text; return;
    end if;
  end if;

  -- The authority on what is a real timezone. UTC is in here; so is every zone
  -- Postgres itself recognises. A name it does not know is refused rather than
  -- stored to fail later at send time.
  if v_tz is null or not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
    return query select 'invalid'::text; return;
  end if;

  select o.timezone into v_was
    from core.organizations o
   where o.id = p_organization_id
   for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  perform set_config('crm.timezone_write', 'on', true);
  update core.organizations set timezone = v_tz where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    'organization.timezone_set',
    'organization',
    p_organization_id,
    jsonb_build_object('timezone', v_was),
    jsonb_build_object('timezone', v_tz)
  );

  return query select 'set'::text;
end;
$$;

comment on function core.set_agency_timezone(uuid, text) is
  'Sets core.organizations.timezone for the caller''s org, validated against pg_timezone_names (so UTC and every IANA zone Postgres knows are accepted, and an unknown name is refused). Owner/ops_admin only for an authenticated caller, pinned to its own org; service role trusted. Audited in-transaction, and it sets the crm.timezone_write flag the guard checks so the write is admitted.';

revoke all on function core.set_agency_timezone(uuid, text) from public;
grant execute on function core.set_agency_timezone(uuid, text) to authenticated, service_role;

-- 3. The guard. Any authenticated write that CHANGES the timezone outside the
--    setter is refused, so the audit trail cannot be sidestepped by a direct
--    PostgREST PATCH. Fires only on a timezone change, so ordinary org writes
--    (name, settings, the pilot flag) are untouched; the service role and other
--    identity-less callers are unrestricted.
create or replace function core.timezone_write_is_sanctioned()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.timezone is not distinct from old.timezone then
    return new;
  end if;
  if tg_op = 'INSERT' and new.timezone is null then
    return new;
  end if;
  if current_setting('crm.timezone_write', true) = 'on' then
    return new;
  end if;
  if (select auth.uid()) is null then
    return new;
  end if;
  raise exception
    'core.organizations.timezone is set only through core.set_agency_timezone, not by a direct write'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function core.timezone_write_is_sanctioned() is
  'Refuses any authenticated end-user write that changes core.organizations.timezone outside core.set_agency_timezone (which sets the transaction-scoped crm.timezone_write flag). Fires only when the column changes, so ordinary organization writes are unaffected. Service role and other identity-less callers are unrestricted.';

drop trigger if exists timezone_write_is_sanctioned on core.organizations;
create trigger timezone_write_is_sanctioned
  before insert or update on core.organizations
  for each row execute function core.timezone_write_is_sanctioned();
