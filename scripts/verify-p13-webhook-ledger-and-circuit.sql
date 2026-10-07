-- ═══════════════════════════════════════════════════════════════════════════
-- P1-MP3-030 / P1-API-018 / P1-MP3-035 / P1-API-021: the webhook ledger and the circuit breaker, driven through the real doors on a scratch Postgres.
--   * a bad / missing signature, a stale and a future-dated delivery, and a malformed one are each recorded as REJECTED with a reason and never occupy the event key
--   * a genuine delivery after a rejection is still accepted; a repeat is a duplicate pointing at the original; a duplicate is never "processed"
--   * the circuit opens at the threshold, holds callers out for the cool-down, admits exactly ONE probe, closes on a good probe, re-opens on a bad one,
--     opens at once on invalid credentials, ignores caller-fault errors, and an admin can force it with a reason
-- Rolls back.
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p13-webhook-ledger-and-circuit.sql
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
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000013b2'
\set ADM '00000000-0000-4000-8000-000000013a01'
\set MEM '00000000-0000-4000-8000-000000013a02'
\set SHA 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

insert into auth.users (id, email) values (:'ADM', 'p13a-adm@example.test'), (:'MEM', 'p13a-mem@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'ADM', 'p13a-adm@example.test', 'P13 Admin'), (:'MEM', 'p13a-mem@example.test', 'P13 Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'ADM', 'ops_admin'), (:'ORG', :'MEM', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p13a other org', 'zztest-p13a-other') on conflict do nothing;

-- ═════════ webhook ledger ═════════
select pg_temp.as_service();
set local role service_role;

select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-1', 'valid', now(), 'message.in', 'conversation', null, :'SHA', 120)) = 'accepted',
  'a signed, fresh, new delivery is accepted');
select pg_temp.check((select o.outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-1', 'valid', now(), 'message.in', 'conversation', null, :'SHA', 120) o) = 'duplicate',
  'the same event key again is a duplicate');
select pg_temp.check((select count(*) from core.p13_webhook_events where provider = 'zzp13wa' and status = 'accepted') = 1
                     and (select count(*) from core.p13_webhook_events where provider = 'zzp13wa' and status = 'duplicate' and duplicate_of is not null) = 1,
  'one original and one duplicate row that points at it');
select pg_temp.check((select idempotency_result from core.p13_webhook_events where provider = 'zzp13wa' and status = 'duplicate') = 'duplicate', 'the duplicate says so in its idempotency result');

-- rejections: each with its reason, none stored as accepted
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-bad', 'invalid', now())) = 'rejected_signature', 'NEGATIVE: a bad signature is rejected');
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-nosig', 'missing', now())) = 'rejected_signature', 'NEGATIVE: a missing signature is rejected');
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-old', 'valid', now() - interval '2 hours')) = 'rejected_stale', 'NEGATIVE: a two-hour-old delivery is stale');
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-future', 'valid', now() + interval '1 hour')) = 'rejected_stale', 'NEGATIVE: a delivery dated an hour ahead is refused');
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', null, 'valid', now())) = 'rejected_malformed', 'NEGATIVE: a delivery with no event key is malformed');
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-edge', 'valid', now() - interval '2 hours', null, null, null, null, null, 86400)) = 'accepted',
  'a wider replay window admits what the default window refuses (the window is a parameter)');
select pg_temp.check((select count(*) from core.p13_webhook_events where provider = 'zzp13wa' and status = 'rejected' and rejection_reason is not null) = 5, 'five rejections, each with a reason');
select pg_temp.check(exists (select 1 from core.p13_webhook_events where provider = 'zzp13wa' and rejection_reason = 'bad_signature')
                     and exists (select 1 from core.p13_webhook_events where provider = 'zzp13wa' and rejection_reason = 'missing_signature')
                     and exists (select 1 from core.p13_webhook_events where provider = 'zzp13wa' and rejection_reason = 'stale')
                     and exists (select 1 from core.p13_webhook_events where provider = 'zzp13wa' and rejection_reason = 'future_dated')
                     and exists (select 1 from core.p13_webhook_events where provider = 'zzp13wa' and rejection_reason = 'malformed'), 'the five reasons are the five distinct ones');

-- a rejection must not shadow the genuine delivery that follows it
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-bad', 'valid', now())) = 'accepted',
  'the genuine delivery after a forged one with the same key is still accepted');
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-old', 'valid', now())) = 'accepted',
  'and a fresh delivery after a stale one with the same key is still accepted');

-- processing result
select event_id as e1 from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-proc', 'valid', now()) \gset
select pg_temp.check(core.p13_finish_webhook_event(:'e1', true) = 'processed', 'an accepted delivery can be marked processed');
select pg_temp.check((select status from core.p13_webhook_events where id = :'e1') = 'processed' and (select processed_at from core.p13_webhook_events where id = :'e1') is not null, 'it is stamped processed');
select pg_temp.check((select outcome from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-proc', 'valid', now())) = 'duplicate', 'a processed original still dedupes later repeats');
select id as dup_id from core.p13_webhook_events where provider = 'zzp13wa' and status = 'duplicate' limit 1 \gset
select pg_temp.check(core.p13_finish_webhook_event(:'dup_id', true) = 'not_accepted', 'NEGATIVE: a duplicate row is never marked processed');
select event_id as e2 from core.p13_record_webhook_event(:'ORG', 'zzp13wa', 'evt-fail', 'valid', now()) \gset
select pg_temp.check(core.p13_finish_webhook_event(:'e2', false, 'TIMEOUT') = 'failed', 'a failed delivery is marked failed');
select pg_temp.check((select error_class from core.p13_webhook_events where id = :'e2') = 'TIMEOUT', 'and records its canonical class');
select pg_temp.check(core.p13_finish_webhook_event(gen_random_uuid(), true) = 'not_found', 'an unknown id is reported, not invented');
select pg_temp.check(not exists (select 1 from core.p13_webhook_events where provider = 'zzp13wa' and payload_sha256 is not null and length(payload_sha256) <> 64), 'only a hash of the payload is ever stored');

-- bad arguments raise
do $$ begin
  begin perform core.p13_record_webhook_event(null, 'BAD NAME', 'k', 'valid'); raise exception 'FAILED: a bad provider name was accepted'; exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end;
  begin perform core.p13_record_webhook_event(null, 'zzp13wa', 'k', 'valid', now(), null, null, null, null, null, 1); raise exception 'FAILED: a one-second replay window was accepted'; exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;

-- who may do what
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check(pg_temp.denied($q$select * from core.p13_record_webhook_event(null, 'zzp13wa', 'k', 'valid')$q$), 'NEGATIVE: an authenticated user cannot call the ledger door');
select pg_temp.check(pg_temp.denied($q$select core.p13_circuit_admit(null, 'zzp13p')$q$), 'NEGATIVE: an authenticated user cannot call the breaker door');
select pg_temp.check((select count(*) from core.p13_webhook_events where provider = 'zzp13wa') > 0, 'an admin of the organization can read its ledger');
reset role;
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select count(*) from core.p13_webhook_events where provider = 'zzp13wa') = 0, 'NEGATIVE: a plain member reads no ledger rows');
reset role;
select pg_temp.as_user(:'ADM', :'ORG2', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from core.p13_webhook_events where provider = 'zzp13wa') = 0, 'NEGATIVE: another organization reads none of it');
reset role;

-- ═════════ circuit breaker ═════════
select pg_temp.as_service();
set local role service_role;

select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG', 'zzp13p')) is true, 'a new provider is admitted (closed)');
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', false, 'PROVIDER_UNAVAILABLE') = 'closed', 'one failure of five leaves it closed');
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', false, 'TIMEOUT') = 'closed', 'two failures leave it closed');
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', false, 'VALIDATION_ERROR') = 'closed', 'a validation error leaves it closed');
select pg_temp.check((select consecutive_failures from core.p13_circuit_breakers where organization_id = :'ORG' and provider = 'zzp13p') = 2, 'NEGATIVE: a validation error is the caller''s fault and does not count');
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', false, 'NETWORK_ERROR') = 'closed' and core.p13_circuit_record(:'ORG', 'zzp13p', false, 'RATE_LIMITED') = 'closed', 'four failures leave it closed');
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', false, 'PROVIDER_ERROR') = 'open', 'the fifth counted failure opens it');
select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG', 'zzp13p')) is false
                     and (select retry_after_seconds from core.p13_circuit_admit(:'ORG', 'zzp13p')) between 1 and 60, 'NEGATIVE: an open circuit holds callers out and says when to retry');

-- cool-down elapsed: exactly one probe
reset role;
update core.p13_circuit_breakers set opened_at = now() - interval '2 minutes' where organization_id = :'ORG' and provider = 'zzp13p';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG', 'zzp13p')) is true, 'after the cool-down the first caller is admitted as the probe');
select pg_temp.check((select state from core.p13_circuit_breakers where organization_id = :'ORG' and provider = 'zzp13p') = 'half_open', 'and the circuit is half open');
select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG', 'zzp13p')) is false, 'NEGATIVE: a second caller is not admitted while the probe is out');
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', false, 'TIMEOUT') = 'open', 'a failed probe re-opens the circuit');
reset role;
update core.p13_circuit_breakers set opened_at = now() - interval '2 minutes' where organization_id = :'ORG' and provider = 'zzp13p';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG', 'zzp13p')) is true, 'a second cool-down admits a second probe');
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', true) = 'closed', 'a good probe closes it (health recovery)');
select pg_temp.check((select consecutive_failures from core.p13_circuit_breakers where organization_id = :'ORG' and provider = 'zzp13p') = 0, 'and clears the failure count');
select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG', 'zzp13p')) is true, 'and callers go through again');

-- a lost probe does not wedge the circuit
reset role;
update core.p13_circuit_breakers set state = 'half_open', opened_at = now() - interval '10 minutes', probe_started_at = now() - interval '5 minutes' where organization_id = :'ORG' and provider = 'zzp13p';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG', 'zzp13p')) is true, 'a probe whose caller died is replaced after another cool-down');

-- invalid credentials: open at once
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13auth', false, 'AUTHENTICATION_ERROR') = 'open', 'invalid credentials open the circuit on the first failure (no retry loop on a bad key)');

-- a caller-fault answer from a probe still shows the provider answered
reset role;
update core.p13_circuit_breakers set state = 'half_open', opened_at = now() - interval '10 minutes', probe_started_at = now() where organization_id = :'ORG' and provider = 'zzp13p';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(core.p13_circuit_record(:'ORG', 'zzp13p', false, 'POLICY_BLOCKED') = 'closed', 'a probe that is refused by policy proves the provider is up: it closes');

-- organizations are independent
select pg_temp.check((select admitted from core.p13_circuit_admit(:'ORG2', 'zzp13auth')) is true, 'another organization''s circuit for the same provider is separate');

-- the counting rule itself
select pg_temp.check(not core.p13_error_counts_toward_circuit('VALIDATION_ERROR') and not core.p13_error_counts_toward_circuit('AUTHORIZATION_ERROR')
                     and not core.p13_error_counts_toward_circuit('NOT_FOUND') and not core.p13_error_counts_toward_circuit('CONFLICT_DUPLICATE') and not core.p13_error_counts_toward_circuit('POLICY_BLOCKED')
                     and core.p13_error_counts_toward_circuit('TIMEOUT') and core.p13_error_counts_toward_circuit('UNKNOWN_ERROR') and core.p13_error_counts_toward_circuit(null), 'five caller-fault classes do not count; the rest, and an unknown one, do');
reset role;

-- admin force
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check(core.p13_circuit_force('zzp13p', 'open', '') = 'reason_required', 'NEGATIVE: forcing needs a reason');
select pg_temp.check(core.p13_circuit_force('zzp13p', 'half_open', 'x') = 'invalid_state', 'NEGATIVE: only open or closed can be forced');
select pg_temp.check(core.p13_circuit_force('zzp13p', 'open', 'provider announced an outage') = 'forced', 'an admin can hold a provider open with a reason');
select pg_temp.check((select state from core.p13_circuit_breakers where provider = 'zzp13p') = 'open', 'and it is open');
select pg_temp.check((select count(*) from audit.audit_log where action = 'circuit_breaker.forced' and organization_id = :'ORG') >= 1, 'and it is audited');
reset role;
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(core.p13_circuit_force('zzp13p', 'closed', 'because') = 'not_authorized', 'NEGATIVE: a plain member cannot force a circuit');
reset role;

rollback;
\echo 'verify-p13-webhook-ledger-and-circuit: all checks passed'
