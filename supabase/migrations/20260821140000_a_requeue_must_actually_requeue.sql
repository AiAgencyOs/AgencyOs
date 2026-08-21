-- ═══════════════════════════════════════════════════════════════════════════
-- A requeue must actually requeue.
--
-- The sibling of 20260821130000, one check further in, and found the same way:
-- the owner did what the product told them to. They opened Operations, pressed
-- **Requeue** on five dead extractions, and every one of them went straight
-- back to `dead` — inside a second, without calling a model, and rewriting the
-- error from the run *before*. One of the five still reported "The configured
-- Anthropic API key was rejected", a failure fixed two days earlier, because
-- the old reason was kept rather than replaced.
--
-- The evidence is that no `ai.agent_runs` row was written for any of the five:
--
--     jobs updated  20:55 20:56 20:57 20:58 20:59   (all -> dead, attempts 1/5)
--     agent_runs    ...20:37                        (nothing after)
--
-- The route's first idempotency check reads crm.requirement_versions by
-- `source_job_id` and settles the job from what it finds. Its docblock explains
-- the `failed` case as a crash: *"the process died between the marker and
-- failJob, and the reaper released it"*. That cannot happen. The failed marker
-- is only written once `attempts >= max_attempts`, and `recoveryFor` returns
-- **`dead`** — not `queued` — for a running job at max attempts, so the reaper
-- never releases such a job to run again.
--
-- The only thing that moves a `dead` job back into the queue is
-- `core.requeue_job`, which refuses every other status and is an explicit
-- operator action. So the branch is reachable in exactly one situation, and in
-- that situation it is exactly wrong: it answers "another run would only
-- rediscover the same failure" to a person who requeued *because the failure
-- was fixed*.
--
-- Correcting the read is again not enough on its own, for the same reason
-- 20260811120001 gave and 20260821130000 repeated: this index is unique on
-- (organization, source_job_id) regardless of status, so a requeued job that
-- finally succeeded would collide on 23505 with the failed row its previous
-- run left behind. A silent skip would become a hard failure.
--
-- What the key is *for* is one **proposal** per job — the double-run guard the
-- route's docblock describes, where a job that already produced a version must
-- not pay for a second model call. A `failed` row is not a proposal. Excluding
-- it keeps that guarantee intact and stops it from also meaning "this job may
-- never be retried".
--
-- Failed rows accumulate, one per exhausted run, which is the honest history of
-- a job that was tried, fixed, and tried again. `status` is `not null`, so the
-- predicate classifies every existing row.
-- ═══════════════════════════════════════════════════════════════════════════

drop index if exists crm.requirement_versions_source_job_key;

create unique index if not exists requirement_versions_source_job_key
  on crm.requirement_versions (organization_id, source_job_id)
  where source_job_id is not null and status <> 'failed';

comment on index crm.requirement_versions_source_job_key is
  'One proposal per job, per organization — the guard that stops a re-run of the same job paying for a second model call. Failed versions are excluded: a failure is not a proposal, and leaving it in the key made an operator''s requeue collide with the record of the run they were retrying.';
