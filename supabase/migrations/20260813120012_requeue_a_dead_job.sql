-- G-099 — a dead job can be sent back to the queue.
--
-- `/operations` has shown what the system gave up on since G-053, and nothing
-- could bring any of it back. The page says so in its own header: reviving dead
-- work is a write with real consequences, so it was recorded as a gap rather
-- than added as a button.
--
-- The consequence that was feared is not there, and the reason is worth stating
-- because it is the whole argument for this migration being small:
--
--   **A dead job is one the runner already attempted `max_attempts` times.**
--   Retry is not a new capability being introduced here; it is what the queue
--   has always done, unattended, five times over, before giving up. Requeuing
--   is a sixth attempt of something the system already attempts five times on
--   its own. A handler that cannot survive a replay is already broken today,
--   and was broken before this function existed.
--
-- Both handlers that exist were in fact written for replay, and neither relies
-- on the queue to be careful:
--
--   `milestone.unlock` — the UPDATE carries `status = 'pending'`. A milestone
--   already in_progress, submitted or met matches no row, and the handler
--   answers `already_unlocked` rather than acting twice. Its own comment calls
--   this the layer that matters, "because it holds even if the first two are
--   bypassed entirely".
--
--   `requirement.extract` — `requirement_versions_transcript_state_key` makes a
--   second extraction of an unchanged transcript conflict in the database. Two
--   runners over one transcript produce one proposal; so do two attempts.
--
-- What this function must therefore protect is not the handler. It is the
-- queue's own bookkeeping:
--
--   1. Only a `dead` job may be requeued. A `running` job has a live claim
--      against it, and resetting that row to `queued` is how the same work gets
--      claimed twice at once — the one way to manufacture the double-run
--      everybody was worried about. A `succeeded` job is finished; replaying it
--      is a decision nobody has asked for.
--   2. The decision is taken under a row lock, so the status it acts on is the
--      status at the moment it writes. The check-then-write shape is what D1,
--      D2, D4 and D20 all were.
--   3. The row is *reused*, never re-inserted. `jobs_dedupe_key_key` is unique
--      across the whole table, so a new row carrying the same dedupe key would
--      be refused — and one carrying a fresh key would defeat the deduplication
--      that makes redelivery free.
--
-- `last_error` is deliberately left where it is. It is the only record of why
-- the work stopped, the operator read it before deciding to requeue, and
-- clearing it would erase the reason at the exact moment somebody acted on it.

create or replace function core.requeue_job(p_job_id uuid)
returns table (
  -- 'requeued' | 'not_found' | 'not_dead'
  outcome    text,
  -- The status read under the lock. The caller quotes it back in a refusal, so
  -- what it tells the operator cannot be made wrong by a write that landed
  -- after the caller's own read.
  job_status text,
  -- How many times it had already been attempted, before this reset it.
  attempts   int
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org      uuid;
  v_status   text;
  v_kind     text;
  v_attempts int;
begin
  select j.organization_id, j.status, j.kind, j.attempts
    into v_org, v_status, v_kind, v_attempts
    from core.jobs j
   where j.id = p_job_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text, null::int;
    return;
  end if;

  if v_status <> 'dead' then
    return query select 'not_dead'::text, v_status, v_attempts;
    return;
  end if;

  update core.jobs
     set status     = 'queued',
         attempts   = 0,
         run_at     = now(),
         locked_at  = null,
         locked_by  = null,
         updated_at = now()
   where id = p_job_id;

  -- Inside this transaction, per G-079. A human deliberately reviving work the
  -- system had given up on is exactly the kind of action that must not be able
  -- to happen with no record of who did it.
  perform core.record_audit(
    v_org,
    'job.requeued',
    'job',
    p_job_id,
    jsonb_build_object('status', 'dead', 'attempts', v_attempts),
    jsonb_build_object('status', 'queued', 'attempts', 0, 'kind', v_kind)
  );

  return query select 'requeued'::text, 'queued'::text, v_attempts;
end;
$$;

comment on function core.requeue_job(uuid) is
  'Sends one dead job back to the queue (G-099). Refuses anything not dead, under a row lock, because resetting a running job is the one way to get the same work claimed twice. Reuses the row rather than inserting a new one, so jobs_dedupe_key_key still holds. Attempts reset to zero; last_error is kept, because it is the only record of why the work stopped. Audits inside the transaction. SECURITY INVOKER: core.jobs RLS still decides whose queue this is.';

revoke all on function core.requeue_job(uuid) from public, anon;
grant execute on function core.requeue_job(uuid) to authenticated, service_role;
