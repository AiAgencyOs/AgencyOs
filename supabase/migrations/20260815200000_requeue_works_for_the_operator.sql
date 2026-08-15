-- ═══════════════════════════════════════════════════════════════════════════
-- Requeuing a dead job actually requeues it.
--
-- G-099 shipped `core.requeue_job` as SECURITY INVOKER, on the stated intent
-- that "core.jobs RLS still decides whose queue this is". But `core.jobs` has
-- RLS enabled with only a SELECT policy (`jobs_select`) and one narrow INSERT
-- policy (`requirement.extract`) — and NO UPDATE policy for `authenticated` at
-- all. Every WORKING write path to the table (`claim_jobs`, `reap_stalled_jobs`)
-- is SECURITY DEFINER and bypasses RLS; `requeue_job` was the lone INVOKER
-- writer, and the RLS model was never extended to permit it.
--
-- So the operator path was broken end to end. `/operations` → `requeueJob` runs
-- as the signed-in `authenticated` user; inside the function the `UPDATE
-- core.jobs ... where id = p_job_id` matches no row under RLS (no UPDATE policy),
-- affects zero rows WITHOUT error, and the function then writes a `job.requeued`
-- audit and returns `'requeued'` — a false success, while the job stays `dead`
-- and never re-runs. The button reported success and did nothing. The verify
-- script missed it because it calls the RPC with the SERVICE key, which bypasses
-- RLS — so it exercised a path the real caller never takes.
--
-- The fix is the shape the other job writers already use: SECURITY DEFINER, so
-- the guarded UPDATE is not RLS-filtered, with the caller checks the function
-- must now make for itself moved inside it. A broad UPDATE policy on `core.jobs`
-- was the alternative and is worse: it would let any owner PATCH arbitrary job
-- columns over PostgREST — status, attempts, locked_by, payload — which is the
-- queue corruption this function's careful "only dead → queued, under a lock,
-- reusing the row" exists to prevent. The capability stays a function.
--
-- The caller guard: a session caller may requeue only a job in their OWN
-- organization, and only with the `job.requeue` capability — owner or ops_admin,
-- the same set the `/operations` page and `requeueJob` enforce, restated here so
-- a direct RPC cannot slip past the app. The service role — whose
-- `current_organization_id()` is null — stays unrestricted, so the reaper, any
-- system caller and the verify scripts are unaffected. A caller who may not act
-- on the job is answered `not_found`, the shape `decide_approval` uses for an
-- org it cannot see, so neither the job's existence nor its status leaks.
-- `auth.uid()` reads the request's JWT and SECURITY DEFINER does not change it,
-- so the `record_audit` attribution still names the human who clicked.
-- ═══════════════════════════════════════════════════════════════════════════

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
security definer
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

  -- The caller guard, now that this runs past RLS. A session caller may requeue
  -- only a job in their own org, and only with the job.requeue capability
  -- (owner/ops_admin); the service role (null org) is unrestricted. Answered as
  -- not_found so nothing leaks to a caller who may not act on it.
  if core.current_organization_id() is not null
     and (core.current_organization_id() is distinct from v_org
          or core.current_user_role() not in ('owner', 'ops_admin')) then
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
  'Sends one dead job back to the queue (G-099). Refuses anything not dead, under a row lock, because resetting a running job is the one way to get the same work claimed twice. Reuses the row rather than inserting a new one, so jobs_dedupe_key_key still holds. Attempts reset to zero; last_error is kept, because it is the only record of why the work stopped. Audits inside the transaction. SECURITY DEFINER, because core.jobs has no UPDATE policy for authenticated and an INVOKER write was silently RLS-filtered to nothing; the caller guard inside restricts a session caller to their own org and the job.requeue capability (owner/ops_admin), while the service role is unrestricted.';

revoke all on function core.requeue_job(uuid) from public, anon;
grant execute on function core.requeue_job(uuid) to authenticated, service_role;
