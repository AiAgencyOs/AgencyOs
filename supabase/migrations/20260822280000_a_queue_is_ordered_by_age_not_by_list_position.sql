-- ═══════════════════════════════════════════════════════════════════════════
-- A queue is ordered by age, not by list position.
--
-- The runner claims one agent job per invocation, which is right: claiming
-- more would leave rows `running` that nothing in the tick will settle. How it
-- chooses which one is not right.
--
--   for (const kind of AGENT_JOB_KINDS) { … if (claimedRow) break; }
--
-- `core.claim_jobs` takes ONE kind, so the kinds are tried in the order the
-- workflow array happens to list them and the first with a queued row wins.
-- That was harmless while there was one kind. There are eleven.
--
-- **So a kind early in the list starves every kind after it.** While any
-- `message.intent` is queued — and one is queued for every inbound client
-- message — nothing below it in the array is ever claimed: not the
-- qualification read, not the objection read, not the QA plan, not the
-- check-in brief, not the handover package, not the follow-up text. They are
-- not slow. They are never reached.
--
-- ── found by a test that had to be made forty times more patient ─────────
--
-- `verify-agent-dispatch` polls "tick until this subject's run exists". Eight
-- ticks was a comfortable margin for months. The handover section began
-- failing at eight with nothing in that section changed — because the system
-- had grown to eight agents across thirteen subscriptions, and one inbound
-- message now queues three jobs. Raising the budget to forty made the test
-- pass and left the defect exactly where it was: in production the cron runs
-- once a minute, and "forty ticks" is forty minutes.
--
-- Doc 23 §36 names the class — *"Detect queue growth… Throttle low-priority
-- tasks… Alert on sustained queue lag"* — and §37 asks for the property this
-- restores: work is claimed fairly, not by whoever is listed first.
--
-- ── the fix is to ask the queue one question instead of eleven ───────────
--
-- The oldest queued job among the kinds the runner can perform, in one
-- statement, under the same `for update skip locked`. Age is the ordering a
-- queue already has: `priority, run_at` is what `claim_jobs` sorts by within a
-- kind, and this applies it *across* them.
--
-- `core.claim_jobs` is untouched. It is correct for what it does — G-119's
-- batch-size lesson lives in it — and it has other callers; this is a second
-- entry point beside it rather than a rewrite of it, because re-emitting a
-- function is how a branch gets silently dropped (D16).

create or replace function core.claim_agent_job(
  p_worker_id text,
  p_kinds     text[]
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
         -- Against the row being locked, not a copy read a statement earlier —
         -- the property `claim_jobs` exists to hold, held the same way here.
         attempts  = j.attempts + 1
   where j.id = (
     select id
       from core.jobs
      where kind = any(p_kinds)
        and status = 'queued'
        and run_at <= now()
      -- The whole of the fix. Ordered by what the queue is actually about:
      -- what has waited longest, not what the caller listed first.
      order by priority, run_at, id
      limit 1
        for update skip locked
   )
  returning j.*;
$$;

comment on function core.claim_agent_job(text, text[]) is
  'Claims the OLDEST queued job among several kinds, atomically. The runner used to try its eleven agent kinds in array order and take the first with a row, so a kind early in the list starved every kind after it - while any message.intent was queued, and one is queued for every inbound client message, nothing below it was ever claimed. Ordered by priority then run_at, which is the ordering core.claim_jobs already applies WITHIN a kind; this applies it across them. Doc 23 sections 36 and 37.';

revoke all on function core.claim_agent_job(text, text[]) from public, anon, authenticated;
grant execute on function core.claim_agent_job(text, text[]) to service_role;

notify pgrst, 'reload schema';
