-- ═══════════════════════════════════════════════════════════════════════════
-- 015 — Outbox dispatch: invoice.paid → job runner → next milestone
--
-- Almost nothing is needed here, which is the point. The transactional outbox
-- (migration 002) already has everything the dispatcher requires:
--
--   core.outbox_events.published_at   dispatch-once marker
--   core.outbox_events.attempts       visible failure counter
--   outbox_unpublished_idx            the claim index
--   core.jobs.dedupe_key + its unique index
--                                     at-least-once delivery made harmless
--   core.jobs.kind                    free text, so a new handler needs no DDL
--   audit.audit_log actor_type 'system'
--                                     the runner can record itself honestly
--
-- No table, column, status or constraint changes. `milestone.unlock` is simply
-- a second value in an existing column, and the milestone it moves goes from
-- `pending` to `in_progress` — both already in the migration 006 CHECK. This
-- layer introduces no new state anywhere.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Claim index for a queue with more than one kind ───────────────────────
-- The runner now claims by (kind, status), and jobs_claim_idx from migration
-- 002 leads on priority — so with two kinds queued it scans past every job of
-- the wrong kind to find the right one. Cheap today, quadratic in kinds later,
-- and the fix is one index.
create index if not exists jobs_kind_claim_idx
  on core.jobs (kind, priority, run_at)
  where status = 'queued';

comment on index core.jobs_kind_claim_idx is
  'Serves the runner claim: one kind at a time, oldest and highest priority first.';

comment on column core.jobs.kind is
  'Which handler runs this job. ''requirement.extract'' (AI extraction) and ''milestone.unlock'' (invoice.paid → next milestone). Mapped from event subscriptions in src/lib/events/catalog.ts.';

comment on column core.jobs.dedupe_key is
  'Globally unique. Outbox dispatch writes ''evt:<event id>:<handler>'', which is what makes at-least-once event delivery enqueue exactly one job.';

comment on column core.outbox_events.published_at is
  'Set once the dispatcher has enqueued every subscribed handler''s job. Enqueue happens first, so a crash in between replays harmlessly: the dedupe key absorbs it.';
