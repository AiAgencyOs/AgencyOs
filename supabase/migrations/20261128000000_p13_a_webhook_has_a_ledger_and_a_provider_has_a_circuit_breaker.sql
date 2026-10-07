-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1-3 rest-gaps, platform contracts (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-MP3-030 / P1-API-018  every inbound webhook leaves a ledger row: accepted, duplicate, or rejected WITH a reason (bad signature, stale, malformed)
--   P1-MP3-035 / P1-API-021  a per-organization, per-provider circuit breaker: repeated failure opens it, a single probe after the cool-down closes it
--
-- Both are service-role runner doors (a webhook route and a worker call them with the admin client; no end user does) plus an internal admin read.
-- The ledger keeps a SHA-256 of the payload and its size, never the payload: a webhook body is personal data and the retention policy for it is not this
-- table's to decide. The breaker is advisory to the caller (it says whether to try); it never retries anything and never replays a financial operation.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── webhook ledger ──────────────────────────────────────────────────────────
create table if not exists core.p13_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  -- null only for a rejection that happened before a tenant could be resolved (a bad signature names no tenant)
  organization_id   uuid references core.organizations(id) on delete cascade,
  provider          text not null check (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  event_key         text check (event_key is null or length(event_key) between 1 and 200),
  signature_status  text not null check (signature_status in ('valid', 'invalid', 'missing', 'not_applicable')),
  received_at       timestamptz not null default clock_timestamp(),
  event_at          timestamptz,
  normalized_type   text check (normalized_type is null or length(normalized_type) <= 120),
  resource_type     text check (resource_type is null or length(resource_type) <= 60),
  resource_id       uuid,
  payload_sha256    text check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_bytes     integer check (payload_bytes is null or payload_bytes >= 0),
  correlation_id    uuid,
  status            text not null check (status in ('accepted', 'duplicate', 'rejected', 'processed', 'failed')),
  idempotency_result text not null check (idempotency_result in ('first', 'duplicate', 'not_applicable')),
  duplicate_of      uuid references core.p13_webhook_events(id) on delete set null,
  rejection_reason  text check (rejection_reason is null or rejection_reason in ('bad_signature', 'missing_signature', 'stale', 'future_dated', 'malformed')),
  error_class       text check (error_class is null or length(error_class) <= 60),
  processed_at      timestamptz,
  constraint p13_webhook_rejection_says_why check (status <> 'rejected' or rejection_reason is not null),
  constraint p13_webhook_only_rejection_has_reason check (status = 'rejected' or rejection_reason is null)
);
comment on table core.p13_webhook_events is
  'P1-API-018. One row per inbound webhook delivery: provider, event key, signature evidence, received time, normalized type, mapped resource, processing status, idempotency result and a rejection reason. Payload is NOT stored, only its SHA-256 and size. Written only by core.p13_record_webhook_event / p13_finish_webhook_event (service role).';

-- one ORIGINAL per (provider, event_key); duplicates and rejections are additional rows that point at it
create unique index if not exists p13_webhook_events_original_key
  on core.p13_webhook_events (provider, event_key)
  where event_key is not null and status in ('accepted', 'processed', 'failed');
create index if not exists p13_webhook_events_org_idx on core.p13_webhook_events (organization_id, received_at desc);
create index if not exists p13_webhook_events_status_idx on core.p13_webhook_events (provider, status, received_at desc);

drop trigger if exists org_match_p13_webhook_duplicate_of on core.p13_webhook_events;
create trigger org_match_p13_webhook_duplicate_of before insert or update of duplicate_of, organization_id on core.p13_webhook_events
  for each row execute function core.enforce_parent_org('duplicate_of', 'core.p13_webhook_events');
drop trigger if exists freeze_org_p13_webhook_events on core.p13_webhook_events;
create trigger freeze_org_p13_webhook_events before update of organization_id on core.p13_webhook_events
  for each row execute function core.freeze_organization_id();

alter table core.p13_webhook_events enable row level security;
alter table core.p13_webhook_events force row level security;
drop policy if exists p13_webhook_events_read on core.p13_webhook_events;
create policy p13_webhook_events_read on core.p13_webhook_events for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()));
revoke all on core.p13_webhook_events from public, anon, authenticated;
grant select on core.p13_webhook_events to authenticated;
grant all on core.p13_webhook_events to service_role;

create or replace function core.p13_record_webhook_event(
  p_organization_id uuid,
  p_provider        text,
  p_event_key       text,
  p_signature_status text,
  p_event_at        timestamptz default null,
  p_normalized_type text default null,
  p_resource_type   text default null,
  p_resource_id     uuid default null,
  p_payload_sha256  text default null,
  p_payload_bytes   integer default null,
  p_max_age_seconds integer default 900,
  p_correlation_id  uuid default null
)
returns table (outcome text, event_id uuid, duplicate_of uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := clock_timestamp();
  v_reason text;
  v_id     uuid;
  v_orig   uuid;
  v_key    text := nullif(btrim(coalesce(p_event_key, '')), '');
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{1,39}$' then
    raise exception 'p13_record_webhook_event: a lower-case provider name is required';
  end if;
  if p_max_age_seconds is null or p_max_age_seconds < 30 or p_max_age_seconds > 86400 then
    raise exception 'p13_record_webhook_event: the replay window must be between 30 and 86400 seconds';
  end if;

  -- Order matters: malformed, then signature, then freshness, THEN the duplicate check. An unauthenticated or stale delivery must never be able to
  -- occupy an event key and so shadow the genuine delivery that arrives later.
  if v_key is null and p_signature_status <> 'invalid' and p_signature_status <> 'missing' then
    v_reason := 'malformed';
  elsif p_signature_status = 'invalid' then
    v_reason := 'bad_signature';
  elsif p_signature_status = 'missing' then
    v_reason := 'missing_signature';
  elsif p_event_at is not null and p_event_at < v_now - make_interval(secs => p_max_age_seconds) then
    v_reason := 'stale';
  elsif p_event_at is not null and p_event_at > v_now + interval '5 minutes' then
    v_reason := 'future_dated';
  end if;

  if v_reason is not null then
    insert into core.p13_webhook_events (organization_id, provider, event_key, signature_status, received_at, event_at, normalized_type, resource_type, resource_id,
                                         payload_sha256, payload_bytes, correlation_id, status, idempotency_result, rejection_reason)
    values (p_organization_id, p_provider, v_key, p_signature_status, v_now, p_event_at, p_normalized_type, p_resource_type, p_resource_id,
            p_payload_sha256, p_payload_bytes, p_correlation_id, 'rejected', 'not_applicable', v_reason)
    returning id into v_id;
    return query select ('rejected_' || case v_reason when 'bad_signature' then 'signature' when 'missing_signature' then 'signature' when 'stale' then 'stale'
                                                      when 'future_dated' then 'stale' else 'malformed' end)::text, v_id, null::uuid;
    return;
  end if;

  insert into core.p13_webhook_events (organization_id, provider, event_key, signature_status, received_at, event_at, normalized_type, resource_type, resource_id,
                                       payload_sha256, payload_bytes, correlation_id, status, idempotency_result)
  values (p_organization_id, p_provider, v_key, p_signature_status, v_now, p_event_at, p_normalized_type, p_resource_type, p_resource_id,
          p_payload_sha256, p_payload_bytes, p_correlation_id, 'accepted', 'first')
  on conflict (provider, event_key) where event_key is not null and status in ('accepted', 'processed', 'failed') do nothing
  returning id into v_id;

  if v_id is not null then
    return query select 'accepted'::text, v_id, null::uuid;
    return;
  end if;

  select e.id into v_orig from core.p13_webhook_events e
   where e.provider = p_provider and e.event_key = v_key and e.status in ('accepted', 'processed', 'failed');
  insert into core.p13_webhook_events (organization_id, provider, event_key, signature_status, received_at, event_at, normalized_type, resource_type, resource_id,
                                       payload_sha256, payload_bytes, correlation_id, status, idempotency_result, duplicate_of)
  values (p_organization_id, p_provider, v_key, p_signature_status, v_now, p_event_at, p_normalized_type, p_resource_type, p_resource_id,
          p_payload_sha256, p_payload_bytes, p_correlation_id, 'duplicate', 'duplicate', v_orig)
  returning id into v_id;
  return query select 'duplicate'::text, v_id, v_orig;
end $$;
revoke all on function core.p13_record_webhook_event(uuid, text, text, text, timestamptz, text, text, uuid, text, integer, integer, uuid) from public, anon, authenticated;
grant execute on function core.p13_record_webhook_event(uuid, text, text, text, timestamptz, text, text, uuid, text, integer, integer, uuid) to service_role;
comment on function core.p13_record_webhook_event(uuid, text, text, text, timestamptz, text, text, uuid, text, integer, integer, uuid) is
  'P1-MP3-030. Records one webhook delivery and says what to do: accepted | duplicate | rejected_signature | rejected_stale | rejected_malformed. A rejection never occupies the event key, so it cannot shadow the genuine delivery. Service role only.';

create or replace function core.p13_finish_webhook_event(p_event_id uuid, p_ok boolean, p_error_class text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_row core.p13_webhook_events;
begin
  select * into v_row from core.p13_webhook_events where id = p_event_id for update;
  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'accepted' then return 'not_accepted'; end if;   -- a duplicate or a rejection is never "processed"
  update core.p13_webhook_events
     set status = case when p_ok then 'processed' else 'failed' end,
         processed_at = clock_timestamp(),
         error_class = case when p_ok then null else left(coalesce(p_error_class, 'UNKNOWN_ERROR'), 60) end
   where id = p_event_id;
  return case when p_ok then 'processed' else 'failed' end;
end $$;
revoke all on function core.p13_finish_webhook_event(uuid, boolean, text) from public, anon, authenticated;
grant execute on function core.p13_finish_webhook_event(uuid, boolean, text) to service_role;

-- ── circuit breaker ─────────────────────────────────────────────────────────
create table if not exists core.p13_circuit_breakers (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  provider              text not null check (provider ~ '^[a-z][a-z0-9_.-]{1,59}$'),
  state                 text not null default 'closed' check (state in ('closed', 'open', 'half_open')),
  consecutive_failures  integer not null default 0 check (consecutive_failures >= 0),
  failure_threshold     integer not null default 5 check (failure_threshold between 1 and 100),
  open_seconds          integer not null default 60 check (open_seconds between 5 and 3600),
  opened_at             timestamptz,
  probe_started_at      timestamptz,
  last_failure_at       timestamptz,
  last_success_at       timestamptz,
  last_error_class      text check (last_error_class is null or length(last_error_class) <= 60),
  forced_by             uuid references core.users(id) on delete set null,
  forced_reason         text check (forced_reason is null or length(forced_reason) <= 500),
  updated_at            timestamptz not null default clock_timestamp(),
  unique (organization_id, provider),
  constraint p13_circuit_open_is_dated check (state = 'closed' or opened_at is not null)
);
comment on table core.p13_circuit_breakers is
  'P1-API-021. Per organization and provider: closed (calls go), open (calls are held for open_seconds), half_open (one probe is in flight). Moved only by core.p13_circuit_admit / p13_circuit_record (service role) and core.p13_circuit_force (an admin, with a reason).';

drop trigger if exists freeze_org_p13_circuit_breakers on core.p13_circuit_breakers;
create trigger freeze_org_p13_circuit_breakers before update of organization_id on core.p13_circuit_breakers
  for each row execute function core.freeze_organization_id();

alter table core.p13_circuit_breakers enable row level security;
alter table core.p13_circuit_breakers force row level security;
drop policy if exists p13_circuit_breakers_read on core.p13_circuit_breakers;
create policy p13_circuit_breakers_read on core.p13_circuit_breakers for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on core.p13_circuit_breakers from public, anon, authenticated;
grant select on core.p13_circuit_breakers to authenticated;
grant all on core.p13_circuit_breakers to service_role;

-- Which failures count toward opening. A caller's own fault (validation, permission, not-found, duplicate, policy) says nothing about the provider's health.
create or replace function core.p13_error_counts_toward_circuit(p_error_class text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_error_class, 'UNKNOWN_ERROR') not in ('VALIDATION_ERROR', 'AUTHORIZATION_ERROR', 'NOT_FOUND', 'CONFLICT_DUPLICATE', 'POLICY_BLOCKED');
$$;

create or replace function core.p13_circuit_admit(p_organization_id uuid, p_provider text)
returns table (admitted boolean, state text, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row core.p13_circuit_breakers;
  v_now timestamptz := clock_timestamp();
  v_wait integer;
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_.-]{1,59}$' then
    raise exception 'p13_circuit_admit: a lower-case provider name is required';
  end if;
  insert into core.p13_circuit_breakers (organization_id, provider) values (p_organization_id, p_provider) on conflict (organization_id, provider) do nothing;
  select * into v_row from core.p13_circuit_breakers b where b.organization_id = p_organization_id and b.provider = p_provider for update;

  if v_row.state = 'closed' then
    return query select true, 'closed'::text, 0; return;
  end if;

  if v_row.state = 'open' then
    v_wait := ceil(extract(epoch from (v_row.opened_at + make_interval(secs => v_row.open_seconds) - v_now)))::integer;
    if v_wait <= 0 then
      -- cool-down over: exactly ONE caller is admitted as the probe
      update core.p13_circuit_breakers set state = 'half_open', probe_started_at = v_now, updated_at = v_now where id = v_row.id;
      return query select true, 'half_open'::text, 0; return;
    end if;
    return query select false, 'open'::text, v_wait; return;
  end if;

  -- half_open: a probe is already out. If it was lost (the caller died) a new one is admitted after another cool-down.
  v_wait := ceil(extract(epoch from (v_row.probe_started_at + make_interval(secs => v_row.open_seconds) - v_now)))::integer;
  if v_wait <= 0 then
    update core.p13_circuit_breakers set probe_started_at = v_now, updated_at = v_now where id = v_row.id;
    return query select true, 'half_open'::text, 0; return;
  end if;
  return query select false, 'half_open'::text, v_wait;
end $$;
revoke all on function core.p13_circuit_admit(uuid, text) from public, anon, authenticated;
grant execute on function core.p13_circuit_admit(uuid, text) to service_role;

create or replace function core.p13_circuit_record(p_organization_id uuid, p_provider text, p_ok boolean, p_error_class text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row core.p13_circuit_breakers;
  v_now timestamptz := clock_timestamp();
  v_next text;
  v_fails integer;
begin
  insert into core.p13_circuit_breakers (organization_id, provider) values (p_organization_id, p_provider) on conflict (organization_id, provider) do nothing;
  select * into v_row from core.p13_circuit_breakers b where b.organization_id = p_organization_id and b.provider = p_provider for update;

  if p_ok then
    update core.p13_circuit_breakers
       set state = 'closed', consecutive_failures = 0, opened_at = null, probe_started_at = null, last_success_at = v_now, forced_by = null, forced_reason = null, updated_at = v_now
     where id = v_row.id;
    return 'closed';
  end if;

  if not core.p13_error_counts_toward_circuit(p_error_class) then
    update core.p13_circuit_breakers set last_error_class = left(p_error_class, 60), updated_at = v_now where id = v_row.id;
    -- a caller-fault answer from a probe still proves the provider answered: it does not hold the circuit half open forever
    if v_row.state = 'half_open' then
      update core.p13_circuit_breakers set state = 'closed', consecutive_failures = 0, opened_at = null, probe_started_at = null, updated_at = v_now where id = v_row.id;
      return 'closed';
    end if;
    return v_row.state;
  end if;

  v_fails := v_row.consecutive_failures + 1;
  -- invalid credentials open the circuit at once: retrying a bad key is the loop the contract forbids
  v_next := case
    when v_row.state = 'half_open' then 'open'
    when v_row.state = 'open' then 'open'
    when p_error_class = 'AUTHENTICATION_ERROR' then 'open'
    when v_fails >= v_row.failure_threshold then 'open'
    else 'closed'
  end;
  update core.p13_circuit_breakers
     set state = v_next, consecutive_failures = v_fails, last_failure_at = v_now, last_error_class = left(coalesce(p_error_class, 'UNKNOWN_ERROR'), 60),
         opened_at = case when v_next = 'open' and (v_row.state <> 'open') then v_now else opened_at end,
         probe_started_at = case when v_next = 'open' then null else probe_started_at end,
         updated_at = v_now
   where id = v_row.id;
  return v_next;
end $$;
revoke all on function core.p13_circuit_record(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function core.p13_circuit_record(uuid, text, boolean, text) to service_role;

-- An admin can hold a provider open (stop calling it) or close it by hand, with a reason; audited.
create or replace function core.p13_circuit_force(p_provider text, p_state text, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_actor uuid := (select auth.uid());
  v_now timestamptz := clock_timestamp();
  v_before text;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not coalesce((select core.is_admin()), false) then return 'not_authorized'; end if;
  if p_state not in ('open', 'closed') then return 'invalid_state'; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return 'reason_required'; end if;
  insert into core.p13_circuit_breakers (organization_id, provider) values (v_org, p_provider) on conflict (organization_id, provider) do nothing;
  select b.state into v_before from core.p13_circuit_breakers b where b.organization_id = v_org and b.provider = p_provider for update;
  update core.p13_circuit_breakers
     set state = p_state, consecutive_failures = case when p_state = 'closed' then 0 else consecutive_failures end,
         opened_at = case when p_state = 'open' then v_now else null end, probe_started_at = null,
         forced_by = v_actor, forced_reason = left(btrim(p_reason), 500), updated_at = v_now
   where organization_id = v_org and provider = p_provider;
  perform core.record_audit(v_org, 'circuit_breaker.forced', 'circuit_breaker', null, jsonb_build_object('state', v_before), jsonb_build_object('provider', p_provider, 'state', p_state, 'reason', left(btrim(p_reason), 500)));
  return 'forced';
end $$;
revoke all on function core.p13_circuit_force(text, text, text) from public, anon;
grant execute on function core.p13_circuit_force(text, text, text) to authenticated;

notify pgrst, 'reload schema';
