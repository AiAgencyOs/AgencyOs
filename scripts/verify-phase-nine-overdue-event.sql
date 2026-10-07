-- ═══════════════════════════════════════════════════════════════════════════
-- P9-EV-05: finance.payment_overdue is emitted once when the sweep opens an overdue exception. Rolls back.
-- driven through the REAL doors on a scratch Postgres. No model, repository, deployment or payment provider ran.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-b.sql        (rolls back)
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;

create or replace function pg_temp.mk_inv(p_org uuid, p_client uuid, p_project uuid, p_num text, p_total bigint, p_due timestamptz) returns uuid language plpgsql as $$
declare v uuid; v_prev text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into finance.invoices (organization_id, client_account_id, project_id, number, status, subtotal_minor, tax_minor, total_minor, issued_at, due_at)
  values (p_org, p_client, p_project, p_num, 'issued', p_total, 0, p_total, now(), p_due) returning id into v;
  perform set_config('request.jwt.claims', coalesce(v_prev, ''), true);
  return v;
end $$;
grant execute on function pg_temp.mk_inv(uuid, uuid, uuid, text, bigint, timestamptz) to public;
\set ORG '00000000-0000-4000-8000-000000000001'
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest overdue client') returning id as "A" \gset
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A', 'zztest overdue', 'ZP9-OD') returning id as "P" \gset
select pg_temp.as_service();
select pg_temp.mk_inv(:'ORG', :'A', :'P', 'ZOD-1', 5000, now() - interval '20 days') as "IOVER" \gset
select pg_temp.mk_inv(:'ORG', :'A', :'P', 'ZOD-2', 5000, now() + interval '20 days') as "ICURRENT" \gset
select pg_temp.check((select count(*) from core.outbox_events where type = 'finance.payment_overdue' and subject_id in (:'IOVER', :'ICURRENT')) = 0, 'no event before the sweep');
select opened_overdue as "S1" from finance.sweep_finance_exceptions(1000) \gset
select pg_temp.check(:'S1'::int >= 1, 'the sweep opened an overdue exception');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'ORG' and type = 'finance.payment_overdue' and subject_id = :'IOVER') = 1, 'PaymentOverdue was emitted for the overdue invoice');
select pg_temp.check((select count(*) from core.outbox_events where type = 'finance.payment_overdue' and subject_id = :'ICURRENT') = 0, 'no event for an invoice that is not overdue (suppressed)');
select pg_temp.check((select payload ->> 'invoiceId' = :'IOVER' and payload ? 'exceptionId' and not (payload::text ~* 'email|phone|amount') from core.outbox_events where type = 'finance.payment_overdue' and subject_id = :'IOVER'), 'the payload carries ids only');
select finance.sweep_finance_exceptions(1000) \gset
select pg_temp.check((select count(*) from core.outbox_events where type = 'finance.payment_overdue' and subject_id = :'IOVER') = 1, 'a second sweep emits nothing more (once per opening)');
insert into finance.finance_exceptions (organization_id, project_id, invoice_id, kind, reason) values (:'ORG', :'P', :'ICURRENT', 'unclear_proof', 'blurry screenshot');
select pg_temp.check((select count(*) from core.outbox_events where type = 'finance.payment_overdue' and subject_id = :'ICURRENT') = 0, 'an exception of another kind is not a PaymentOverdue');
select pg_temp.check(pg_get_functiondef('finance.emit_payment_overdue()'::regprocedure) like '%new.kind = ''overdue''%', 'live definition holds the overdue-only branch');
rollback;
\echo VERIFIED
