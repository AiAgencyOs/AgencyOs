-- ═══════════════════════════════════════════════════════════════════════════
-- Allocating a requirement version without a race.  (audit C2)
--
-- The runner assigned `version` by reading the highest one and then inserting:
-- two statements with a gap. Two runners working the same conversation — two
-- jobs at different transcript lengths, claimed by overlapping invocations —
-- both read the same maximum and both insert it. `unique (conversation_id,
-- version)` stops the duplicate, so nothing is corrupted, but the loser fails
-- *after* its model call has been made and paid for, and the failure burns one
-- of its attempts.
--
-- Reproduced against a running stack before this was written:
--
--     queued jobs: 2
--     model calls: 2
--     runner A: status=succeeded
--     runner B: status=failed  reason=persist failed
--     versions: 1
--     job: status=queued attempts=1
--          last_error=duplicate key value violates unique constraint
--                     "requirement_versions_conversation_id_version_key"
--
-- This is the same defect the transcript `seq` had, and it gets the same
-- answer: the maximum is read *inside* the insert, under a row lock on the
-- conversation, so concurrent allocations queue instead of colliding. See
-- crm.ingest_whatsapp_message, which does this for conversation_messages.seq.
--
-- Nothing about what is inserted changes. Every trigger still fires, so the
-- append-only guard, the state machine, and the supersede rules apply exactly
-- as they do to a direct insert.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.insert_requirement_version(
  p_organization_id      uuid,
  p_conversation_id      uuid,
  p_source               text,
  p_status               text,
  p_payload              jsonb,
  p_generated_by_run_id  uuid default null,
  p_source_job_id        uuid default null,
  p_source_message_count int  default null
)
returns table (id uuid, version int)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
-- `id` and `version` are both output names and real column names; without this
-- the RETURNING clause below is ambiguous. Nothing here reads the outputs.
#variable_conflict use_column
declare
  v_id      uuid;
  v_version int;
begin
  -- The lock is the fix. Locking the conversation rather than the versions
  -- because there is nothing to lock when a conversation has none yet, and the
  -- conversation row is guaranteed to exist by the time this is called.
  perform 1 from crm.conversations c where c.id = p_conversation_id for update;

  -- max() over an empty set yields null, so coalesce gives version 1 for the
  -- first. The aggregate makes this exactly one row, always.
  insert into crm.requirement_versions (
    organization_id, conversation_id, version, source, status, payload,
    generated_by_run_id, source_job_id, source_message_count
  )
  select p_organization_id,
         p_conversation_id,
         coalesce(max(v.version), 0) + 1,
         p_source,
         p_status,
         p_payload,
         p_generated_by_run_id,
         p_source_job_id,
         p_source_message_count
    from crm.requirement_versions v
   where v.conversation_id = p_conversation_id
  returning requirement_versions.id, requirement_versions.version
       into v_id, v_version;

  return query select v_id, v_version;
end;
$$;

comment on function crm.insert_requirement_version(uuid, uuid, text, text, jsonb, uuid, uuid, int) is
  'Inserts one requirement version, allocating its version number under a lock on the conversation so concurrent runners cannot collide. Every trigger on the table still applies.';

-- Service role only. The job runner is the only caller, and it already holds
-- that key as one of the four sanctioned call sites (ARCHITECTURE.md §7.3).
-- Security invoker rather than definer: this needs no privilege the caller does
-- not already have, so it borrows none.
revoke all on function crm.insert_requirement_version(uuid, uuid, text, text, jsonb, uuid, uuid, int)
  from public, anon, authenticated;
grant execute on function crm.insert_requirement_version(uuid, uuid, text, text, jsonb, uuid, uuid, int)
  to service_role;
