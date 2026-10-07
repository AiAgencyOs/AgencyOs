-- ═══════════════════════════════════════════════════════════════════════════
-- P1-DOD-064: core.rate_limit_hit is an atomic fixed-window counter that blocks the (limit+1)th hit, isolates keys and buckets, hashes the key, is callable
-- by the service role only and purges its own expired windows. Real function, real table, scratch Postgres; rolls back. The window is a day so a test cannot
-- straddle a boundary except at midnight UTC.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-rate-limit.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.fails_with(text, text) to public;

select pg_temp.as_service();
set local role service_role;

select pg_temp.check((select allowed from core.rate_limit_hit('zztest-rl', '203.0.113.7', 3, 86400)) is true, 'hit 1 of 3 is allowed');
select pg_temp.check((select remaining from core.rate_limit_hit('zztest-rl', '203.0.113.7', 3, 86400)) = 1, 'hit 2 leaves 1');
select pg_temp.check((select allowed from core.rate_limit_hit('zztest-rl', '203.0.113.7', 3, 86400)) is true, 'hit 3 of 3 is allowed');
select pg_temp.check((select allowed from core.rate_limit_hit('zztest-rl', '203.0.113.7', 3, 86400)) is false, 'NEGATIVE: hit 4 of 3 is refused');
select pg_temp.check((select retry_after_seconds from core.rate_limit_hit('zztest-rl', '203.0.113.7', 3, 86400)) between 1 and 86400, 'a refusal says when to retry');
select pg_temp.check((select allowed from core.rate_limit_hit('zztest-rl', '203.0.113.7', 3, 86400)) is false, 'a flood keeps itself blocked: over-limit hits still count');

-- isolation
select pg_temp.check((select allowed from core.rate_limit_hit('zztest-rl', '203.0.113.8', 3, 86400)) is true, 'another key has its own window');
select pg_temp.check((select allowed from core.rate_limit_hit('zztest-rl-other', '203.0.113.7', 3, 86400)) is true, 'another bucket has its own window');

-- the key is hashed
reset role;
select pg_temp.check(not exists (select 1 from core.rate_limit_windows where bucket like 'zztest-rl%' and key_hash like '%203.0.113%'), 'the raw key is not stored');
select pg_temp.check((select count(*) from core.rate_limit_windows where bucket = 'zztest-rl' and key_hash ~ '^[0-9a-f]{64}$') = 2, 'two hashed keys were stored for the bucket');

-- expired windows of the bucket are purged
insert into core.rate_limit_windows (bucket, key_hash, window_start, hits) values ('zztest-rl', repeat('a', 64), now() - interval '10 days', 5);
select pg_temp.as_service();
set local role service_role;
select allowed from core.rate_limit_hit('zztest-rl', '203.0.113.9', 3, 86400);
reset role;
select pg_temp.check(not exists (select 1 from core.rate_limit_windows where bucket = 'zztest-rl' and key_hash = repeat('a', 64)), 'an expired window is purged by the next hit');

-- bad arguments raise instead of silently allowing everything
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.fails_with($q$select * from core.rate_limit_hit('', 'k', 3, 60)$q$, 'P0001'), 'NEGATIVE: an empty bucket is refused');
select pg_temp.check(pg_temp.fails_with($q$select * from core.rate_limit_hit('b', 'k', 0, 60)$q$, 'P0001'), 'NEGATIVE: a zero limit is refused');
select pg_temp.check(pg_temp.fails_with($q$select * from core.rate_limit_hit('b', 'k', 3, 0)$q$, 'P0001'), 'NEGATIVE: a zero window is refused');
reset role;

-- nobody but the service role may call it or read the table
select pg_temp.check(not has_function_privilege('anon', 'core.rate_limit_hit(text,text,integer,integer)', 'execute'), 'NEGATIVE: anon cannot call it');
select pg_temp.check(not has_function_privilege('authenticated', 'core.rate_limit_hit(text,text,integer,integer)', 'execute'), 'NEGATIVE: an authenticated user cannot call it');
select pg_temp.check(has_function_privilege('service_role', 'core.rate_limit_hit(text,text,integer,integer)', 'execute'), 'the service role can');
select pg_temp.check(not has_table_privilege('authenticated', 'core.rate_limit_windows', 'select'), 'NEGATIVE: an authenticated user cannot read the counters');

rollback;
\echo 'verify-rate-limit: all checks passed'
