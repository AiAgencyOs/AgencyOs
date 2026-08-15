-- ═══════════════════════════════════════════════════════════════════════════
-- A follow-up the worker keeps looking at and cannot advance is visible.
--
-- Gap G-012's blind spot in the OTHER direction from delivery. A blocked
-- evaluation does not spend an attempt and does not move `next_due_at` (see
-- 20260815120002): the worker records `last_block_reason`, updates
-- `last_evaluated_at`, and leaves the row exactly where it was. That is correct
-- — a block is not an attempt — but it means a sequence can sit `active`,
-- overdue, and blocked for the same reason on every tick, forever, sending
-- nothing. No job is dead, no event is unpublished, no approval is late, so
-- `core.operational_backlog` shows nothing. The follow-up is wedged, and the
-- only trace is a `last_block_reason` column nobody reads.
--
-- The design already named the mechanism to notice it: `last_evaluated_at` is
-- distinct from `last_sent_at` precisely so a sequence evaluated every minute
-- that never sends can be told apart from a quiet one. This function reads that
-- distinction out.
--
-- ── why this is SEPARATE from operational_backlog, and by REASON ────────────
--
-- operational_backlog feeds the alert path — what wakes someone — and its
-- discipline is that it invents no threshold and no policy: every count is a
-- state the system already declared. A wedged follow-up does not fit that path,
-- because its reasons are heterogeneous and one of them is EXPECTED: a
-- deployment that has not set its agency timezone (G-137) blocks every due
-- sequence with `timezone_unavailable` — by design, in every deployment, until
-- an owner supplies the fact. Folding a total into the alert severity would
-- page on that known-empty state and invent the very policy the alert path
-- refuses to. So this is display-only, read by /operations for a human, and it
-- reports the worker's OWN reasons GROUPED, deciding nothing: the operator sees
-- `timezone_unavailable` (the known G-137 wait) apart from `no_conversation`
-- (a real defect), and judges. Classifying reasons as wedged-or-not here would
-- be the invented taxonomy this deliberately avoids.
--
-- The 15-minute floor is operational_backlog's own constant, reused not chosen:
-- the cron runs every minute, so a sequence due more than fifteen minutes ago
-- and still blocked has had ~15 evaluations and is not progressing.
--
-- SECURITY INVOKER, like operational_backlog: the service role (the cron) sees
-- the deployment, an owner opening /operations sees their own organization, and
-- there is no cross-tenant read to get wrong.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.wedged_follow_ups()
returns table (
  reason        text,
  wedged        bigint,
  oldest_due_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    last_block_reason              as reason,
    count(*)                       as wedged,
    min(next_due_at)               as oldest_due_at
  from crm.follow_up_sequences
  where status = 'active'
    and last_block_reason is not null
    and next_due_at < now() - interval '15 minutes'
  group by last_block_reason
  order by count(*) desc, last_block_reason;
$$;

comment on function core.wedged_follow_ups() is
  'Active follow-up sequences the worker keeps evaluating but cannot advance — blocked on the same reason and overdue past the 15-minute staleness constant — grouped by the worker''s own last_block_reason (G-012). Display-only and deliberately kept OUT of the alert path: the reasons mix an expected state (timezone_unavailable, the G-137 wait present in every un-configured deployment) with real defects (no_conversation), so it reports and does not judge — /operations shows the breakdown and a human decides. SECURITY INVOKER, so the service role sees the deployment and an owner sees their organization.';

revoke all on function core.wedged_follow_ups() from public;
grant execute on function core.wedged_follow_ups() to authenticated, service_role;
