-- ═══════════════════════════════════════════════════════════════════════════
-- A follow-up the worker could never even schedule is wedged too — and visible.
--
-- core.wedged_follow_ups (20260815170000) surfaces active sequences the worker
-- keeps evaluating but cannot advance, so an operator sees them on /operations.
-- Its staleness filter was `next_due_at < now() - interval '15 minutes'`, and in
-- SQL a NULL `next_due_at` makes that predicate NULL — never true. But a sequence
-- blocked on the missing agency timezone FROM BIRTH has exactly `next_due_at IS
-- NULL`: the create branch cannot compute a due time without a zone, and the
-- worker leaves it un-scheduled while stamping `last_block_reason =
-- 'timezone_unavailable'`. So the single most common wedged population in an
-- un-configured deployment — the whole G-137 wait — was invisible to the monitor
-- whose own comment claimed it showed `timezone_unavailable`. The worker recovers
-- these once a timezone is set (proved live), so this was never a silent
-- permanent wedge; it was a silent *monitor*, which is the thing /operations
-- exists to prevent.
--
-- Fix: treat a NULL `next_due_at` as wedged immediately (there is no "overdue by
-- 15 minutes" for a row that was never given a due time — it is stuck the moment
-- the worker blocks it). The existing `last_block_reason is not null` clause
-- already restricts the result to sequences the worker has seen and blocked, so
-- a brand-new sequence not yet evaluated (reason NULL) is still excluded — only
-- worker-acknowledged, never-scheduled sequences are surfaced.
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
    and (next_due_at is null or next_due_at < now() - interval '15 minutes')
  group by last_block_reason
  order by count(*) desc, last_block_reason;
$$;

comment on function core.wedged_follow_ups() is
  'Active follow-up sequences the worker keeps evaluating but cannot advance — blocked on the same reason and either overdue past the 15-minute staleness constant OR never scheduled at all (next_due_at NULL, the timezone_unavailable population G-137 leaves in every un-configured deployment) — grouped by the worker''s own last_block_reason (G-012). oldest_due_at is NULL for a group that was never scheduled. Display-only and deliberately kept OUT of the alert path: the reasons mix an expected state (timezone_unavailable) with real defects (no_conversation), so it reports and does not judge — /operations shows the breakdown and a human decides. SECURITY INVOKER, so the service role sees the deployment and an owner sees their organization.';

revoke all on function core.wedged_follow_ups() from public;
grant execute on function core.wedged_follow_ups() to authenticated, service_role;
