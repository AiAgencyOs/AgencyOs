-- ═══════════════════════════════════════════════════════════════════════════
-- The requirement proposal lifecycle.
--
-- crm.requirement_versions has held proposals since Feature 6, but three
-- properties the lifecycle depends on were not expressible:
--
--   1. An extraction that will never succeed had no state. The job dies, the
--      agent run records why, and the CRM shows nothing at all — so a
--      conversation whose extraction permanently failed is indistinguishable
--      from one nobody has run yet.
--
--   2. Nothing recorded which *job* produced a version. A runner killed between
--      writing the version and settling the job leaves the job `running`; the
--      reaper releases it fifteen minutes later and the retry extracts the same
--      transcript again, writing a second version of the same thing. The
--      dedupe_key stops two jobs existing; nothing stopped one job running
--      twice.
--
--   3. Status could go anywhere. `accepted` → `rejected` was a permitted UPDATE,
--      so a decision a human had already made could be silently reversed by the
--      next caller. Approval is the control plane (ARCHITECTURE.md §6.1); a
--      control plane whose decisions can be overwritten without trace is not
--      one.
--
-- All three are additive: a widened CHECK, a nullable column with a partial
-- unique index, and a stricter version of a trigger that already existed. No
-- data is rewritten and no existing row can become invalid.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. `failed` joins the lifecycle ────────────────────────────────────────
--
-- Written only when an extraction has permanently failed — attempts exhausted,
-- not merely one bad attempt. A transient provider error stays where it
-- belongs, in ai.agent_runs.error and core.jobs.last_error, because a retry may
-- still produce a proposal. `failed` means "this will not produce one", which
-- is a fact about the conversation and belongs where a human will look.
alter table crm.requirement_versions
  drop constraint if exists requirement_versions_status_check;

alter table crm.requirement_versions
  add constraint requirement_versions_status_check
  check (status in ('proposed', 'accepted', 'rejected', 'superseded', 'failed'));

-- ── 2. Which job produced this version ─────────────────────────────────────
--
-- Provenance and idempotency in one column. FK-less for the same reason
-- generated_by_run_id is: crm does not take a hard dependency on another
-- module's table, and a job pruned from the queue must not delete the record of
-- what it produced.
alter table crm.requirement_versions
  add column if not exists source_job_id uuid;

comment on column crm.requirement_versions.source_job_id is
  'The core.jobs row whose run produced this version. Null for human-authored versions. Unique per organization, which is what makes a re-run of the same job idempotent rather than duplicating the proposal.';

-- The idempotency guard. A second run of the same job cannot write a second
-- version: the insert conflicts and the runner treats that as "already
-- produced" rather than as a failure.
create unique index if not exists requirement_versions_source_job_key
  on crm.requirement_versions (organization_id, source_job_id)
  where source_job_id is not null;

-- ── 3. The state machine, in the database ──────────────────────────────────
--
-- Replaces the append-only guard rather than sitting beside it, so there is one
-- trigger describing what an UPDATE may do. It keeps the original rule — every
-- column but `status` is immutable, and versioning is only real if the
-- versioned bytes cannot be edited — and adds the transitions.
--
--   proposed  → accepted | rejected | superseded
--   accepted  → superseded
--   rejected  → superseded
--   failed    → superseded
--   any       → itself            (a no-op update is not a transition)
--
-- `superseded` remains reachable from every state because a newer version
-- always wins; it is the one transition that is not a human decision. What is
-- now impossible is turning an accepted proposal into a rejected one, or
-- reviving a failed extraction by writing over its status.
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

drop trigger if exists requirement_versions_guard on crm.requirement_versions;
create trigger requirement_versions_guard
  before update on crm.requirement_versions
  for each row execute function crm.requirement_versions_guard();
