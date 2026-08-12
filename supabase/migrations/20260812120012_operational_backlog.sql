-- ═══════════════════════════════════════════════════════════════════════════
-- What is going wrong right now, in one query.
--
-- Gap G-053 (observability is console.error), and with it G-058 (dead jobs are
-- invisible) and the open half of G-080 (nothing displays the backlog).
--
-- The system already knows when something has failed. A job reaches `dead`
-- because the runner decided it had, an outbox event sits unpublished because
-- nothing dispatched it, an approval passes `sla_due_at` because a policy said
-- so. Every one of those facts is in the database and none of them reaches a
-- human: they are `console.error` lines in a Vercel log nobody is watching at
-- two in the morning.
--
-- ── no thresholds are invented here ───────────────────────────────────────
--
-- That is the constraint this function is written under, because a threshold
-- is a business rule and inventing one is what directive §48 forbids.
--
--   dead              — the runner's own classification. No threshold at all.
--   stalled           — `running` past STALE_AFTER (src/lib/jobs/staleness.ts),
--                       the existing constant that already decides when a lock
--                       cannot belong to a live invocation.
--   stuck in queue    — `queued` past the same interval. Cron runs every
--                       minute, so fifteen minutes of waiting means the runner
--                       is not draining, and reusing the constant beats
--                       choosing a second one.
--   unpublished       — same interval, same argument.
--   overdue approval  — `sla_due_at`, which came from the organization's own
--                       approval policy. Their number, not ours.
--
-- ── SECURITY INVOKER, deliberately ────────────────────────────────────────
--
-- The counts are whatever the caller may read. The service role, which the
-- cron tick uses, sees the whole deployment; an owner opening /operations sees
-- their own organization and nothing else. One function, two correct answers,
-- and no cross-tenant read to get wrong — a SECURITY DEFINER version would
-- have had to re-implement tenancy and would eventually have got it wrong,
-- which is D22 in a different chair.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.operational_backlog()
returns table (
  dead_jobs             bigint,
  stalled_jobs          bigint,
  stuck_queued_jobs     bigint,
  unpublished_events    bigint,
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
    (select count(*) from core.outbox_events
      where published_at is null and created_at < now() - interval '15 minutes'),
    (select count(*) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now()),
    (select min(updated_at) from core.jobs where status = 'dead'),
    (select min(created_at) from core.outbox_events where published_at is null),
    (select min(sla_due_at) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now());
$$;

comment on function core.operational_backlog() is
  'Everything the system already believes is wrong: dead jobs, stalled and stuck ones, unpublished events, approvals past the deadline their own policy set. SECURITY INVOKER, so the service role sees the deployment and an owner sees their organization. Invents no threshold — each one is either a state the system set itself or the existing 15-minute staleness constant.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Alert state — so a problem is reported, and then not reported every minute
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists core.alert_state (
  key           text primary key,
  -- A fingerprint of what was wrong when the alert went out. While it is
  -- unchanged the situation is the same situation, and a second message adds
  -- nothing; when it changes, something got worse or better and that is worth
  -- saying immediately rather than at the end of a cooldown.
  signature     text not null,
  last_sent_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table core.alert_state is
  'One row per alert key, holding what was last reported and when. Cron runs every minute; without this, one dead job would produce 1,440 identical messages a day and the next real alert would arrive in a channel nobody reads any more.';

alter table core.alert_state enable row level security;

-- No policy for `authenticated`, so PostgREST refuses every read and write.
-- This is operator state with no tenant, and the only writer is the cron tick
-- running as the service role.

drop trigger if exists set_updated_at on core.alert_state;
create trigger set_updated_at
  before update on core.alert_state
  for each row execute function core.set_updated_at();

/**
 * Claim the right to send one alert.
 *
 * The decision and the write are one statement on purpose. Two cron
 * invocations overlapping — a slow tick and the next one — would otherwise
 * both read "nothing sent recently", both decide to send, and both send. That
 * is the read-decide-write shape this repository has spent twenty-two findings
 * removing, and an alert is a message to a human: duplicates are the failure
 * mode that gets alerting muted.
 *
 * Returns true exactly once per (signature, cooldown) window.
 */
create or replace function core.claim_alert(
  p_key            text,
  p_signature      text,
  p_cooldown_hours int default 1
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  insert into core.alert_state (key, signature, last_sent_at)
  values (p_key, p_signature, now())
  on conflict (key) do update
     set signature    = excluded.signature,
         last_sent_at = now()
   where core.alert_state.signature is distinct from excluded.signature
      or core.alert_state.last_sent_at < now() - make_interval(hours => p_cooldown_hours)
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function core.claim_alert(text, text, int) is
  'True when this alert should be sent: the situation changed, or the cooldown elapsed while it persisted. Decided and recorded in one statement, so two overlapping cron invocations cannot both send the same message.';

revoke all on function core.operational_backlog() from public;
revoke all on function core.claim_alert(text, text, int) from public;

grant execute on function core.operational_backlog() to authenticated, service_role;
grant execute on function core.claim_alert(text, text, int) to service_role;
grant select, insert, update on core.alert_state to service_role;
