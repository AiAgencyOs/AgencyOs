-- ═══════════════════════════════════════════════════════════════════════════
-- The outbox gives up, and says so.
--
-- `core.jobs` has the discipline of a queue that can fail: a job carries
-- `attempts`, and when they reach `max_attempts` the reaper parks it `dead`,
-- so a permanently-failing job stops being retried and is surfaced distinctly.
-- The outbox had half of it — an `attempts` counter — and none of the rest:
--
--   • a permanently-failing event was retried EVERY tick, forever, because
--     the dispatch scans `where published_at is null` with no ceiling;
--
--   • the scan is ordered by `id asc`, so a stuck low-id event sits at the
--     front of every batch — and if more than one batch's worth are stuck,
--     they STARVE newer events, which are never reached;
--
--   • there was no `dead` state, so a stuck event and a merely-slow one looked
--     the same in `unpublished_events`.
--
-- This adds the missing half. `dead_at` marks an event the dispatcher has
-- given up on after `attempts` cross a ceiling; the dispatcher skips dead
-- events and orders the rest fewest-attempts-first so a stuck event cannot
-- starve a fresh one; and the operational backlog counts dead events as their
-- own failing signal, separate from the unpublished ones still being tried.
--
-- The ceiling is a fixed constant here (the code and this column agree on it),
-- not a per-org setting — a number of retries is an engineering property of
-- the dispatcher, not a business rule an Admin tunes.
-- ═══════════════════════════════════════════════════════════════════════════

alter table core.outbox_events
  add column if not exists dead_at timestamptz;

comment on column core.outbox_events.dead_at is
  'When the dispatcher gave up publishing this event, after its attempts crossed the ceiling (G-053 discipline, matching core.jobs dead-parking). A dead event is not retried and is surfaced by core.operational_backlog as a failing signal distinct from an event still being tried. NULL for every event still live.';

-- Partial index: the dispatcher scans only live, unpublished events, and this
-- keeps that scan off the dead and the published.
create index if not exists outbox_events_dispatchable_idx
  on core.outbox_events (attempts, id)
  where published_at is null and dead_at is null;

-- ── the backlog learns to tell a dead event from a slow one ────────────────
--
-- Return-type change (a new column), so drop first.

drop function if exists core.operational_backlog();

create function core.operational_backlog()
returns table (
  dead_jobs             bigint,
  stalled_jobs          bigint,
  stuck_queued_jobs     bigint,
  unpublished_events    bigint,
  dead_events           bigint,
  overdue_approvals     bigint,
  oldest_dead_at        timestamptz,
  oldest_unpublished_at timestamptz,
  oldest_overdue_due_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*) from core.jobs where status = 'dead'),
    (select count(*) from core.jobs
      where status = 'running' and locked_at < now() - interval '15 minutes'),
    (select count(*) from core.jobs
      where status = 'queued' and run_at < now() - interval '15 minutes'),
    -- Unpublished and still being tried: live, past the staleness line.
    (select count(*) from core.outbox_events
      where published_at is null and dead_at is null and created_at < now() - interval '15 minutes'),
    -- Given up on: the dispatcher will not retry these, and the downstream
    -- work they carried never happened.
    (select count(*) from core.outbox_events where dead_at is not null),
    (select count(*) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now()),
    (select min(updated_at) from core.jobs where status = 'dead'),
    (select min(created_at) from core.outbox_events where published_at is null and dead_at is null),
    (select min(sla_due_at) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now());
$$;

comment on function core.operational_backlog() is
  'Everything the system already believes is wrong: dead jobs, stalled and stuck ones, events unpublished-and-still-trying, events the dispatcher gave up on (dead_events), and overdue approvals (G-053). SECURITY INVOKER, so the service role sees the deployment and an owner sees their organization. Invents no threshold - each count is a state the system set itself or the existing 15-minute staleness constant.';

revoke all on function core.operational_backlog() from public;
grant execute on function core.operational_backlog() to authenticated, service_role;
