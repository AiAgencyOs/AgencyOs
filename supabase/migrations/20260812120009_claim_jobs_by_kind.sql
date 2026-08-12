-- ═══════════════════════════════════════════════════════════════════════════
-- The claim function claims the kind it was asked for.
--
-- Gap G-082, and it is sharper than "dead code". core.claim_jobs has never had
-- a call site — and it has never had a `kind` filter either:
--
--     where status = 'queued' and run_at <= now()
--     order by priority, run_at limit batch_size for update skip locked
--
-- So the first person to wire it up would have had the extraction path claim
-- `milestone.unlock` jobs and hand a paid client's milestone to the AI
-- extractor, or the unlock loop claim `requirement.extract` jobs and refuse
-- them as malformed until their attempts ran out. Unused code that would be
-- *wrong* if used is worse than either using it or removing it: it reads as an
-- available mechanism and is a trap.
--
-- It also contradicts its own neighbour. `jobs_kind_claim_idx` was added in
-- 20260809120003 with the note that "the runner now claims by (kind, status)",
-- and shaped `(kind, priority, run_at) where status = 'queued'` precisely for
-- this query. The index documents an intention the function does not implement.
--
-- ── Why fix it rather than delete it ──────────────────────────────────────
--
-- Deleting would also close the trap, and it was the smaller change. What it
-- would leave behind is the reason not to: the route claims in two statements —
-- SELECT a candidate, then UPDATE it — and computes the new attempt count in
-- TypeScript from the row it read. Finding D18 had to add `run_at` to that
-- second statement after review found a racing invocation could take a
-- backed-off job *and* write `attempts: candidate.attempts + 1` from its own
-- stale read, rolling the count backwards so the job would neither wait nor
-- ever die.
--
-- That is now correct, but it is correct by predicate: it holds because
-- somebody remembered to restate two conditions on the write. Here the same
-- guarantee is structural — one statement, `attempts = attempts + 1` evaluated
-- against the row being locked, and `for update skip locked` so a second runner
-- steps over a held row instead of contending for it. SECURITY.md's own
-- checklist says it: "anything two callers could race is enforced in Postgres,
-- not TypeScript."
--
-- ── What changes for callers ──────────────────────────────────────────────
--
-- The old two-argument signature is dropped rather than left as an overload, so
-- the version without a `kind` cannot be called by accident. Nothing calls it
-- today, so nothing breaks; the drop is what makes that permanent.
--
-- `run_at <= now()` is the database clock, where the route's filter was the
-- application's. Both sides of the comparison were already crossing clocks —
-- `run_at` defaults to `now()` on insert — so this narrows the crossing rather
-- than widening it: the only application-clock value left is the one D18 writes
-- for a backoff, and the smallest of those is a minute against a skew measured
-- in milliseconds.
--
-- The arguments are renamed to the `p_` prefix every other function in this
-- schema uses. Dropping the old signature is the one free moment for that:
-- after this lands, PostgREST callers name arguments in the request body, so a
-- rename becomes a breaking change.
--
-- No schema change: no table, column, index or constraint is added, altered or
-- dropped.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists core.claim_jobs(text, int);

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
      limit p_batch_size
        -- The second runner steps over a row somebody else is taking rather
        -- than blocking on it, which is what keeps one slow claim from stalling
        -- a tick.
        for update skip locked
   )
  returning j.*;
$$;

comment on function core.claim_jobs(text, text, int) is
  'Claims up to p_batch_size queued jobs of one kind, atomically: the status change, the lock and the attempt increment are one statement, and FOR UPDATE SKIP LOCKED lets a second runner pass over a row rather than contend for it. Takes the kind explicitly — the version without it could hand a milestone unlock to the AI extractor, which is why that signature is dropped rather than kept as an overload. A caller must be able to settle every row it claims: p_batch_size defaults to 1 and both callers pass 1, because an invocation killed part-way through a larger batch strands the rest in ''running'' with their attempts already spent.';

revoke all on function core.claim_jobs(text, text, int) from public, anon, authenticated;
grant execute on function core.claim_jobs(text, text, int) to service_role;

-- PostgREST caches the schema, and both claim sites now depend on this function
-- being in that cache. The repo's own precedent (20260807120010) notifies
-- explicitly rather than trusting the auto-reload trigger, and the cost of
-- being wrong here is higher than there: an unlock loop that cannot find the
-- function logs and breaks, and extraction answers 503 every minute.
notify pgrst, 'reload schema';
