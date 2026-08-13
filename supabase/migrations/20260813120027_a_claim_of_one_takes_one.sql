-- ═══════════════════════════════════════════════════════════════════════════
-- A claim of one takes one.
--
-- Gap G-119. `core.claim_jobs` could claim **every queued job of a kind in a
-- single statement**, hand them all to one worker, and leave all but one
-- stranded in `running` with their attempts already spent — invisible to every
-- other claim until the reaper released them fifteen minutes later.
--
-- ── the mechanism ─────────────────────────────────────────────────────────
--
--   limit p_batch_size
--
-- In Postgres, **`LIMIT NULL` means no limit**. It is not an error and it is
-- not zero; it is every row. So a null batch size turns a claim into a
-- take-everything:
--
--   select count(*) from core.claim_jobs('w', 'requirement.extract', null);
--    → 4          -- with four queued, all four claimed
--
-- and every one of them carries the same `locked_by` and the same `locked_at`,
-- because they were written by one statement. That is exactly the signature
-- that failed `verify-requirement-proposal` §8c four times in CI: two jobs,
-- one worker id, one timestamp to the microsecond, one settled and one left
-- `running`. Two separate transactions cannot share a `locked_at` — measured,
-- they differ by microseconds — so identical values proved a single statement.
--
-- ── why the callers being correct is not the fix ──────────────────────────
--
-- Both call sites pass 1 today, and the parameter defaults to 1 when omitted.
-- The defect is that the function is *capable* of this at all: a claim
-- contract that says "up to N" must never be able to mean "all of them",
-- whatever a caller, a driver, a schema cache or a future maintainer does with
-- the argument. AGENCYOS_SECURITY.md's rule for money is the same rule here —
-- anything two callers could race is settled in Postgres, not by everybody
-- remembering.
--
-- The consequence was never theoretical: a stranded `running` job is a client
-- waiting on a requirement proposal that no runner will pick up for fifteen
-- minutes, and a milestone unlock is the same shape with money behind it.
--
-- ── the fix ───────────────────────────────────────────────────────────────
--
-- The limit is made total. `coalesce(…, 1)` restores the documented default
-- for a null, and `greatest(…, 1)` refuses zero and negatives — `LIMIT 0`
-- would claim nothing and report an empty queue, which is the same lie in the
-- other direction.
--
-- Carried forward from 20260812120009, its only previous definition.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function core.claim_jobs(
  p_worker_id  text,
  p_kind       text,
  p_batch_size int default 1
)
returns setof core.jobs
language sql
volatile
security definer
set search_path = ''
as $$
  update core.jobs j
     set status    = 'running',
         locked_at = now(),
         locked_by = p_worker_id,
         -- Evaluated against the row being locked, not against a copy read a
         -- statement earlier. This is the whole of it: two runners cannot both
         -- write "the count I saw, plus one".
         attempts  = j.attempts + 1
   where j.id in (
     select id
       from core.jobs
      where kind = p_kind
        and status = 'queued'
        and run_at <= now()
      order by priority, run_at
      -- G-119. Total, not merely conventional: `LIMIT NULL` is no limit at
      -- all, so a null here claimed every queued job of the kind into one
      -- worker and stranded all but one in `running`. `greatest(…, 1)` also
      -- refuses 0 and negatives, which would claim nothing and report an
      -- empty queue — the same lie in the other direction.
      limit greatest(coalesce(p_batch_size, 1), 1)
        -- The second runner steps over a row somebody else is taking rather
        -- than blocking on it, which is what keeps one slow claim from stalling
        -- a tick.
        for update skip locked
   )
  returning j.*;
$$;

comment on function core.claim_jobs(text, text, int) is
  'Claims up to p_batch_size queued jobs of one kind, atomically: the status change, the lock and the attempt increment are one statement, and FOR UPDATE SKIP LOCKED lets a second runner pass over a row rather than contend for it. The limit is total (G-119): a null batch size once meant LIMIT NULL, which is no limit, so one worker claimed every queued job of a kind and stranded all but one in running until the reaper. A claim that says "up to N" may never mean "all of them", whatever a caller passes.';

revoke all on function core.claim_jobs(text, text, int) from public, anon, authenticated;
grant execute on function core.claim_jobs(text, text, int) to service_role;

notify pgrst, 'reload schema';
