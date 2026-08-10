-- ═══════════════════════════════════════════════════════════════════════════
-- One proposal per transcript state, one accepted proposal per conversation.
--
-- Two defects from the pre-merge audit, both reproduced against a running
-- stack before this was written.
--
-- C1 — duplicate identical proposals, and a model call paid for twice.
--
--   The extraction job is deduped on (conversation, message count), so two
--   messages arriving between cron ticks queue two jobs: one at count 1, one at
--   count 2. By the time either runs the transcript already holds both
--   messages, so both extract exactly the same conversation and both write a
--   proposal. Observed: 2 jobs, 2 model calls, 2 versions with byte-identical
--   payloads, both `proposed`. The owner is asked to decide the same thing
--   twice, and the second call is money spent on an answer already held.
--
--   `source_job_id` cannot catch this — the jobs genuinely differ. What is
--   duplicated is not the job but the *transcript state*, so that is what has
--   to be unique.
--
-- C3 — no authoritative version.
--
--   Nothing ever set `superseded`, so every proposal stayed decidable forever.
--   Observed: accepting v1 and then v2 left both `accepted`, with nothing
--   saying which is the agreed scope. Worse than untidy — it also means an
--   *older* proposal can be accepted after a newer extraction has superseded
--   it in fact, freezing scope that the transcript has already moved past.
--
-- Both fixes are additive: two columns' worth of meaning, two partial unique
-- indexes, and one new trigger. No data is rewritten. Existing rows have
-- source_message_count null and so are exempt from the C1 index, which is
-- correct — nothing is known about the transcript they came from.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── C1: the transcript state a version was extracted from ──────────────────
alter table crm.requirement_versions
  add column if not exists source_message_count int
  check (source_message_count is null or source_message_count >= 0);

comment on column crm.requirement_versions.source_message_count is
  'How many transcript messages the extraction read. Unique per conversation, so two jobs racing over the same transcript produce one proposal rather than two identical ones. Null for human-authored versions and for rows written before this column existed.';

-- The invariant. A second extraction of an unchanged transcript conflicts here;
-- the runner checks for the same thing before calling the model, so in practice
-- this is the backstop for two runners inside the same instant rather than the
-- thing that normally fires.
create unique index if not exists requirement_versions_transcript_state_key
  on crm.requirement_versions (conversation_id, source_message_count)
  where source_message_count is not null;

-- ── C3: at most one accepted version per conversation ──────────────────────
--
-- The authoritative scope, made unrepresentable in the plural. Partial so that
-- any number of proposed, rejected, failed or superseded versions may coexist —
-- only agreement is exclusive.
create unique index if not exists requirement_versions_one_accepted_key
  on crm.requirement_versions (conversation_id)
  where status = 'accepted';

-- ── C3: and something that actually sets `superseded` ──────────────────────
--
-- Fires BEFORE, not after, because the unique index above is checked as the row
-- is written: an AFTER trigger would be too late to clear the previous accepted
-- version and the second approval would fail instead of superseding.
--
-- Two rules, deliberately narrow:
--
--   accepting a version supersedes any other accepted version of the same
--   conversation — agreement moves, it does not accumulate;
--
--   inserting a new proposal supersedes any still-undecided older proposal of
--   the same conversation — the newest reading of the transcript is the one
--   worth deciding, and leaving stale proposals decidable is how scope gets
--   frozen from a conversation that has since moved on.
--
-- Terminating by construction: the updates it issues set `superseded`, and
-- neither rule matches a row becoming superseded.
create or replace function crm.requirement_versions_supersede()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.status = 'accepted'
     and old.status is distinct from 'accepted'
  then
    update crm.requirement_versions
       set status = 'superseded'
     where conversation_id = new.conversation_id
       and id <> new.id
       and status = 'accepted';

  elsif tg_op = 'INSERT' and new.status = 'proposed' then
    update crm.requirement_versions
       set status = 'superseded'
     where conversation_id = new.conversation_id
       and id <> new.id
       and status = 'proposed';
  end if;

  return new;
end;
$$;

-- Named to sort after requirement_versions_guard, so the transition is
-- validated before anything is superseded on the strength of it.
drop trigger if exists requirement_versions_supersede on crm.requirement_versions;
create trigger requirement_versions_supersede
  before insert or update on crm.requirement_versions
  for each row execute function crm.requirement_versions_supersede();

-- ── provenance stays provenance ────────────────────────────────────────────
--
-- The guard is restated only to add source_message_count to the immutable set.
-- Every other rule is unchanged, including the state machine.
create or replace function crm.requirement_versions_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organization_id        is distinct from old.organization_id
     or new.conversation_id     is distinct from old.conversation_id
     or new.version             is distinct from old.version
     or new.source              is distinct from old.source
     or new.payload             is distinct from old.payload
     or new.generated_by_run_id is distinct from old.generated_by_run_id
     or new.source_job_id       is distinct from old.source_job_id
     or new.source_message_count is distinct from old.source_message_count
     or new.created_by          is distinct from old.created_by
     or new.created_at          is distinct from old.created_at
  then
    raise exception
      'crm.requirement_versions is append-only except for status; insert version % instead',
      old.version + 1
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status
     and not (
       new.status = 'superseded'
       or (old.status = 'proposed' and new.status in ('accepted', 'rejected'))
     )
  then
    raise exception
      'requirement version % is %; it cannot become %',
      old.version, old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

-- UPDATE only, as it has always been. On INSERT there is no `old`, so every
-- `is distinct from old.x` would be true and the guard would reject every row.
drop trigger if exists requirement_versions_guard on crm.requirement_versions;
create trigger requirement_versions_guard
  before update on crm.requirement_versions
  for each row execute function crm.requirement_versions_guard();
