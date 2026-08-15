-- ═══════════════════════════════════════════════════════════════════════════
-- The scheduler has a pulse.
--
-- Gap G-053, the half the alert path cannot cover. `alertOnBacklog` runs
-- INSIDE the cron tick, so it can only tell somebody about a problem while the
-- tick is still firing. The one failure it can never report is its own: a
-- scheduler that has stopped calling `/api/jobs/run` at all. A dead cron looks
-- exactly like a quiet one — no jobs, no events, no alerts — and every queued
-- follow-up, every unpublished event, and every unclaimed job simply stops
-- moving, silently.
--
-- The only thing that can notice a dead scheduler is something OUTSIDE it. So
-- each authorized tick records that it ran, and `/api/health` reports how long
-- ago the last one was. An external uptime monitor reading that endpoint — the
-- alert destination ADM-60 will name — is what turns a stopped scheduler from
-- an invisible outage into a page. This migration is the pulse; the route
-- stamps it and health reads it.
--
-- A singleton row rather than a log: what matters is only the latest tick, and
-- a one-row table cannot grow without bound the way an append would. The
-- boolean primary key with its CHECK makes a second row unrepresentable.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.cron_heartbeat (
  singleton    boolean primary key default true check (singleton),
  last_tick_at timestamptz not null default now(),
  ticks        bigint not null default 0
);

comment on table core.cron_heartbeat is
  'When the job runner last ran an authorized tick (G-053). One row, ever. A dead scheduler cannot alert on itself, so /api/health reports the age of last_tick_at for an external monitor to watch. `ticks` is a lifetime counter, useful only for spotting that it is or is not advancing.';

alter table core.cron_heartbeat enable row level security;
-- No policy: like alert_state, this is operator state, not tenant data. The
-- service role (the tick) writes it; the health route reads it with the same
-- key. PostgREST refuses everyone else.

-- Seeded so the age is always computable — before the first tick it reads as
-- "a long time ago", which is the honest answer for a scheduler that has never
-- run rather than a null the reader must special-case.
insert into core.cron_heartbeat (singleton, last_tick_at, ticks)
values (true, '-infinity'::timestamptz, 0)
on conflict (singleton) do nothing;

create or replace function core.record_cron_tick()
returns timestamptz
language sql
volatile
security definer
set search_path = ''
as $$
  update core.cron_heartbeat
     set last_tick_at = now(), ticks = ticks + 1
   where singleton
  returning last_tick_at;
$$;

comment on function core.record_cron_tick() is
  'Stamps the heartbeat at the start of an authorized tick (G-053), returning the instant. Called once per /api/jobs/run, after authentication and before the work, so even a tick whose work throws is recorded as having run — the pulse is about the scheduler, not the outcome.';

create or replace function core.cron_heartbeat_age_seconds()
returns double precision
language sql
stable
security definer
set search_path = ''
as $$
  select extract(epoch from (now() - last_tick_at)) from core.cron_heartbeat where singleton;
$$;

comment on function core.cron_heartbeat_age_seconds() is
  'Seconds since the last authorized tick (G-053). Read by /api/health so an external monitor can tell a stopped scheduler from a quiet one. A very large value means the scheduler has not run.';

revoke all on function core.record_cron_tick() from public;
revoke all on function core.cron_heartbeat_age_seconds() from public;
grant execute on function core.record_cron_tick() to service_role;
-- The health route reads with the anon/publishable key, so the age is readable
-- by that role — it exposes no tenant data, only how long since a tick.
grant execute on function core.cron_heartbeat_age_seconds() to service_role, authenticated, anon;
