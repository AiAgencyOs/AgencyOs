-- ═══════════════════════════════════════════════════════════════════════════
-- A send that waits is work nobody is doing — G-220
-- ═══════════════════════════════════════════════════════════════════════════
--
-- G-214 gave this system a way for a send to WAIT: the window is shut, so the
-- job parks and the counterpart's next message wakes it. G-216 added a second
-- kind of waiting, for a rate. Both are right, and both are invisible.
--
-- `core.operational_backlog()` is what decides whether anybody is told
-- anything (G-053), and it does not know these exist. So an approved
-- quotation can sit parked for thirty days and the only trace is a row in a
-- table nobody opens.
--
-- **I added the waiting and did not add it to the thing that notices
-- waiting.** That is the gap.
--
-- ── the hard part is not counting them ────────────────────────────────────
--
-- Most of this waiting is CORRECT and must never raise an alert. A quotation
-- waiting for a client who has not written back is the design working: Meta
-- will not carry it, so it waits, and their reply releases it. Alerting on
-- that would be exactly the noise `alert.ts` was built to avoid — and the
-- fastest way to teach somebody to ignore alerts.
--
-- What is worth telling somebody is the waiting THEY can end:
--
--   window       — waiting on a person. Normal. Counted, never alerted.
--   no_template  — waiting on an ADMIN to register an approved template.
--                  Nothing will ever release this on its own.
--   limit        — waiting on a clock, hours away. Normal.
--
-- So the wait is CLASSIFIED at the moment it is created, by the caller that
-- knows why, rather than inferred later by matching the prose in `reason`.
-- A count derived from free text is a count that changes when somebody
-- rewords a sentence.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.deferred_sends
  add column if not exists blocked_on text not null default 'window';

alter table crm.deferred_sends
  drop constraint if exists deferred_sends_blocked_on_check;

alter table crm.deferred_sends
  add constraint deferred_sends_blocked_on_check check (blocked_on in (
    'window',       -- waiting on the counterpart to write. Only they end it.
    'no_template',  -- waiting on an Admin. Nothing else will ever end it.
    'limit'         -- waiting on a clock, and the clock is already running.
  ));

comment on column crm.deferred_sends.blocked_on is
  'What has to change before this send can go (G-220). Set by the caller that knows, never inferred from `reason` — a count derived from free text changes when somebody rewords a sentence. Only ''no_template'' is anybody''s to act on: the other two end by themselves.';

create index if not exists deferred_sends_blocked_idx
  on crm.deferred_sends (organization_id, blocked_on)
  where woken_at is null;

-- The parameter comes last and defaults, so every existing caller keeps
-- working and says 'window' — which is what they all meant.
create or replace function crm.defer_send(
  p_job_id uuid,
  p_conversation_id uuid,
  p_reason text,
  p_until timestamptz default null,
  p_blocked_on text default 'window'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job     core.jobs;
  v_digits  text;
begin
  if p_blocked_on not in ('window', 'no_template', 'limit') then
    return 'bad_reason';
  end if;

  select * into v_job from core.jobs where id = p_job_id;
  if v_job.id is null then
    return 'no_job';
  end if;

  select c.id into v_digits
    from crm.conversations c
   where c.id = p_conversation_id
     and c.organization_id = v_job.organization_id;
  if v_digits is null then
    return 'wrong_tenant';
  end if;

  v_digits := crm.conversation_counterpart_digits(p_conversation_id);
  if v_digits is null then
    return 'no_counterpart';
  end if;

  update core.jobs
     set status     = 'queued',
         run_at     = coalesce(p_until, now() + interval '30 days'),
         locked_at  = null,
         locked_by  = null,
         attempts   = greatest(attempts - 1, 0),
         last_error = left(p_reason, 500),
         updated_at = now()
   where id = p_job_id;

  insert into crm.deferred_sends (
    organization_id, job_id, conversation_id, counterpart_digits, reason, blocked_on
  )
  values (
    v_job.organization_id, p_job_id, p_conversation_id, v_digits,
    left(p_reason, 500), p_blocked_on
  )
  on conflict (job_id) do update
    set reason             = excluded.reason,
        conversation_id    = excluded.conversation_id,
        counterpart_digits = excluded.counterpart_digits,
        blocked_on         = excluded.blocked_on,
        deferred_at        = now(),
        woken_at           = null,
        updated_at         = now();

  return 'deferred';
end;
$$;

comment on function crm.defer_send(uuid, uuid, text, timestamptz, text) is
  'Parks an outbound job until whatever is blocking it clears (G-214, G-216, classified by G-220): the job stays queued, the attempt it spent discovering the obstacle is given back, and a deferred_sends row records why and WHAT has to change. `p_until` is for an obstacle a clock clears; `p_blocked_on` says which of the three kinds of waiting this is, so the operational backlog can count the one an Admin has to act on without alerting on the two that end by themselves.';

revoke all on function crm.defer_send(uuid, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function crm.defer_send(uuid, uuid, text, timestamptz, text) to service_role;

drop function if exists crm.defer_send(uuid, uuid, text, timestamptz);

-- ── and now the backlog knows ─────────────────────────────────────────────
drop function if exists core.operational_backlog();

create function core.operational_backlog()
returns table (
  dead_jobs bigint,
  stalled_jobs bigint,
  stuck_queued_jobs bigint,
  unpublished_events bigint,
  dead_events bigint,
  overdue_approvals bigint,
  unannounced_approvals bigint,
  -- G-220. Only the kind somebody has to act on: a send with no approved
  -- template to carry it, which nothing will release on its own.
  sends_waiting_on_admin bigint,
  -- Counted and reported, deliberately NOT part of severity: waiting for a
  -- client to write back is the design working, and alerting on it is how a
  -- person learns to ignore alerts.
  sends_waiting_on_reply bigint,
  oldest_dead_at timestamptz,
  oldest_unpublished_at timestamptz,
  oldest_overdue_due_at timestamptz,
  oldest_unannounced_at timestamptz,
  oldest_waiting_on_admin_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    (select count(*) from core.jobs where status = 'dead'),
    (select count(*) from core.jobs
      where status = 'running' and locked_at < now() - interval '15 minutes'),
    /**
     * Unchanged, and that took a red-proof to establish.
     *
     * A parked send is `queued`, which is the shape of a stuck job, so this
     * gap's first draft excluded deferrals from the count. Removing that
     * exclusion to red-prove it changed nothing — because a park sets `run_at`
     * in the FUTURE and this asks for jobs whose time came and went. The
     * exclusion was answering a question the clause had already answered.
     *
     * And it was worse than redundant. A park whose thirty days have expired
     * IS stuck: nobody wrote, nothing woke it, and it has been waiting a
     * month. The exclusion would have hidden exactly that, forever.
     */
    (select count(*) from core.jobs
      where status = 'queued' and run_at < now() - interval '15 minutes'),
    (select count(*) from core.outbox_events
      where published_at is null and dead_at is null and created_at < now() - interval '15 minutes'),
    (select count(*) from core.outbox_events where dead_at is not null),
    (select count(*) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now()),
    (select count(*) from approvals.approval_requests r
      where r.state = 'pending'
        and r.audience = 'internal'
        and not exists (
          select 1 from crm.conversations c
           where c.organization_id = r.organization_id
             and c.kind in ('internal_direct', 'internal_group')
             and c.status <> 'abandoned'
        )),
    (select count(*) from crm.deferred_sends
      where woken_at is null and blocked_on = 'no_template'),
    (select count(*) from crm.deferred_sends
      where woken_at is null and blocked_on <> 'no_template'),
    (select min(updated_at) from core.jobs where status = 'dead'),
    (select min(created_at) from core.outbox_events where published_at is null and dead_at is null),
    (select min(sla_due_at) from approvals.approval_requests
      where state = 'pending' and sla_due_at < now()),
    (select min(r.created_at) from approvals.approval_requests r
      where r.state = 'pending'
        and r.audience = 'internal'
        and not exists (
          select 1 from crm.conversations c
           where c.organization_id = r.organization_id
             and c.kind in ('internal_direct', 'internal_group')
             and c.status <> 'abandoned'
        )),
    (select min(deferred_at) from crm.deferred_sends
      where woken_at is null and blocked_on = 'no_template');
$$;

comment on function core.operational_backlog() is
  'What the system believes is wrong, counted from states it declared itself. G-176 adds unannounced_approvals: raised, waiting, and nobody ever told. G-220 adds the two kinds of waiting send: one an Admin must end by registering a template, one that ends by itself when a client writes. A parked job needs no exclusion from stuck_queued_jobs — its run_at is in the future, and once that time passes it really is stuck.';
