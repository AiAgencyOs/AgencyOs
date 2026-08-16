-- ═══════════════════════════════════════════════════════════════════════════
-- An audit row's time is when the server recorded it, never when the caller claims.
--
-- audit.audit_log admits an authenticated append by design (audit_log_insert,
-- 20260807120003): "anyone acting inside the organization may append, but only
-- about themselves" — the row is forced to actor_id = auth.uid() and
-- actor_type in ('user','client') in the caller's own org, and it cannot be
-- updated or deleted (the no_update/no_delete triggers hold even for the service
-- role). That policy is load-bearing: the app's INVOKER writers (core.record_audit
-- and the record_row_change trigger, and lib/audit.ts) rely on it to append.
--
-- But `created_at` was left to the caller. It carries a default of now(), and no
-- legitimate writer ever sets it (record_audit, the trigger path, and the two
-- app inserts all omit it), yet a direct Data-API insert can supply any value —
-- so a client (who cannot even READ the log) can append a self-attributed row
-- back-dated to 2020 or forward-dated to next year, reordering the timeline an
-- owner reads for forensics. Proven: as a client, `insert ... created_at =
-- '2020-01-01'` stored 2020. The attribution boundedness (own id, own org, no
-- suppression) makes this low-severity, and the arbitrary self-attributed
-- `action` is the accepted "append about yourself" design — but the *timestamp*
-- being caller-controlled is not a property an append-only audit log should have.
--
-- Fix: a BEFORE INSERT trigger stamps created_at = now() for any caller that has
-- an identity (auth.uid() is not null), so an end-user's row is timestamped by
-- the server regardless of what it sent. A caller with no identity — the service
-- role, whose writes are the trusted server-side ones and which is RLS-exempt
-- anyway — is left free, so a future historical backfill remains possible. This
-- changes nothing for the legitimate writers (they already omit created_at and
-- get now()); it only removes the back-/forward-dating an end-user could do.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function audit.stamp_created_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A caller with an identity does not get to choose when the row was written.
  -- The service role (auth.uid() is null) keeps the value it supplied — it is
  -- the trusted server-side writer and the only one that could ever legitimately
  -- backfill a historical event.
  if (select auth.uid()) is not null then
    new.created_at := now();
  end if;
  return new;
end;
$$;

comment on function audit.stamp_created_at() is
  'Forces audit.audit_log.created_at = now() for any caller with an identity (auth.uid() is not null), so an authenticated end-user — permitted to append about itself — cannot back- or forward-date the audit timeline. The identity-less service role (the trusted server-side writer) keeps its supplied value, leaving a historical backfill possible.';

drop trigger if exists audit_log_stamp_created_at on audit.audit_log;
create trigger audit_log_stamp_created_at
  before insert on audit.audit_log
  for each row execute function audit.stamp_created_at();
