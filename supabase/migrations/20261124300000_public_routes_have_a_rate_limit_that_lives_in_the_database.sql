-- ═══════════════════════════════════════════════════════════════════════════
-- P1-DOD-064 / P1-DOD-076 (traceability: docs/phase-1-3-implementation-traceability.md): inbound rate limiting.
--
-- The public routes (provider webhooks, the one-click unsubscribe, the landing-page route) answer anyone on the internet, and the only thing in front of
-- them was a signature or token check done AFTER the body was read. This adds a fixed-window counter that lives in Postgres - not in process memory, which
-- on a serverless deployment is a different process per request and limits nothing:
--
--   core.rate_limit_hit(bucket, key, limit, window_seconds)  one atomic upsert per call; returns allowed / remaining / retry_after_seconds.
--
-- The key is hashed before it is stored (an IP address is personal data; the table never holds one). The table has no organization column ON PURPOSE: the
-- caller is not authenticated yet, so there is no tenant to attribute it to. It is callable by the service role only, and it purges its own expired rows.
-- The caller decides what to do when THIS function fails (the routes fail OPEN and say so in the log: a limiter outage must not drop a provider's webhook).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.rate_limit_windows (
  bucket        text        not null check (length(bucket) between 1 and 80),
  key_hash      text        not null check (length(key_hash) = 64),
  window_start  timestamptz not null,
  hits          integer     not null default 0 check (hits >= 0),
  primary key (bucket, key_hash, window_start)
);
comment on table core.rate_limit_windows is
  'Fixed-window counters for unauthenticated routes. Keys are SHA-256 hashed; no organization column because the caller is not yet a tenant. Written only by core.rate_limit_hit (service role).';
create index if not exists rate_limit_windows_expiry_idx on core.rate_limit_windows (window_start);

alter table core.rate_limit_windows enable row level security;
alter table core.rate_limit_windows force row level security;
revoke all on core.rate_limit_windows from public, anon, authenticated;

create or replace function core.rate_limit_hit(p_bucket text, p_key text, p_limit integer, p_window_seconds integer)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_hash  text;
  v_hits  integer;
  v_end   timestamptz;
begin
  if p_bucket is null or length(btrim(p_bucket)) = 0 or length(p_bucket) > 80 then
    raise exception 'rate_limit_hit: a bucket name of 1..80 characters is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception 'rate_limit_hit: limit must be between 1 and 100000';
  end if;
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'rate_limit_hit: window must be between 1 and 86400 seconds';
  end if;

  v_start := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds);
  v_end   := v_start + make_interval(secs => p_window_seconds);
  v_hash  := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');

  insert into core.rate_limit_windows as w (bucket, key_hash, window_start, hits)
  values (p_bucket, v_hash, v_start, 1)
  on conflict (bucket, key_hash, window_start) do update set hits = w.hits + 1
  returning w.hits into v_hits;

  -- expired windows of this bucket are removed opportunistically, a few rows at a time, so the table stays small without a scheduled job
  delete from core.rate_limit_windows d
   where d.ctid in (select x.ctid from core.rate_limit_windows x where x.bucket = p_bucket and x.window_start < v_start - make_interval(secs => p_window_seconds * 2) limit 50);

  return query select v_hits <= p_limit, greatest(p_limit - v_hits, 0), greatest(ceil(extract(epoch from (v_end - clock_timestamp())))::integer, 1);
end $$;
revoke all on function core.rate_limit_hit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function core.rate_limit_hit(text, text, integer, integer) to service_role;
comment on function core.rate_limit_hit(text, text, integer, integer) is
  'P1-DOD-064. One fixed-window hit for (bucket, key). Atomic (single upsert). The hit is counted even when over the limit, so a flood keeps itself blocked for the window. Service role only; the key is hashed.';

notify pgrst, 'reload schema';
