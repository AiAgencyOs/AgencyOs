-- ═══════════════════════════════════════════════════════════════════════════
-- A failed extraction is not an extraction.
--
-- Found on production, from the owner's own screen: three requirement versions,
-- v1 v2 v3, every one of them **Failed**, under a button labelled "Extract
-- requirements" and a line reading *"Add more detail or queue it again"*.
-- Queueing it again did nothing, and could never have done anything. The
-- transcript was wedged, permanently, by two mechanisms that each looked
-- correct on its own.
--
--   1. `app/api/jobs/run/route.ts` asks whether this transcript has already
--      been extracted, keyed on (organization, conversation, message count).
--      It selects `id, version, status` — and never reads `status`. So a row
--      recording that extraction FAILED answers "already extracted", the job is
--      marked `succeeded`, and no model is called. Its sibling check, the one
--      keyed on source_job_id, reads the same column and handles `failed`
--      distinctly. The asymmetry is the tell: this is an oversight, not a
--      decision.
--
--   2. This index. Unique on (organization, conversation, source_message_count)
--      with no regard for status, so even with the read corrected the *insert*
--      of a successful retry would collide with the failed row still sitting in
--      the slot — a silent skip turning into a hard failure, which is exactly
--      the trap 20260811120001 called out when it widened this key.
--
-- Together they mean a transcript that failed once can never be extracted
-- again. The only escape is a new message, because that changes the count and
-- therefore the key. Nothing in the product says so, and the empty-state
-- sentence promises the opposite.
--
-- The invariant this index is named for is **one proposal per transcript
-- state**. A `failed` row is not a proposal. It carries `payload = '{}'` and
-- exists to record that no proposal was produced — so excluding it from the key
-- does not weaken C1, it states C1 more precisely than the original did.
--
-- What is deliberately kept: the failed rows themselves. They are the history
-- the screen shows, and an extraction that has failed three times is worth
-- knowing about. Several may now coexist at one transcript state, one per
-- exhausted job, which is the honest record of how many times it was tried.
-- `status` is `not null`, so the predicate is never null and every existing row
-- is classified by it.
--
-- Rebuilding the index is also what unwedges the rows already on production:
-- v1, v2 and v3 stop occupying the slot the moment the predicate excludes them.
-- ═══════════════════════════════════════════════════════════════════════════

drop index if exists crm.requirement_versions_transcript_state_key;

create unique index if not exists requirement_versions_transcript_state_key
  on crm.requirement_versions (organization_id, conversation_id, source_message_count)
  where source_message_count is not null and status <> 'failed';

comment on index crm.requirement_versions_transcript_state_key is
  'One proposal per transcript state, per conversation, per organization. Failed versions are excluded: a failure records that no proposal was produced, so it must not occupy the slot a retry needs — a transcript that failed once could otherwise never be extracted again. The organization is part of the key because a version is not constrained to agree with its conversation''s organization, so without it a foreign row can occupy another tenant''s slot.';
