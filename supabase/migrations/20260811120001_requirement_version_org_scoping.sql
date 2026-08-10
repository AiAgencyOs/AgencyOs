-- ═══════════════════════════════════════════════════════════════════════════
-- Organization scoping for the transcript-state guard.  (audit C8)
--
-- The route reads crm.requirement_versions by conversation, and those reads
-- omitted organization_id — which the route's own docblock says every
-- service-role query must carry, because the service role bypasses RLS and
-- nothing else scopes it.
--
-- That looked harmless: a conversation belongs to exactly one organization, so
-- filtering by conversation appears to imply the organization. It does not. A
-- *version* is not required to agree with the conversation it points at.
-- crm.requirement_versions_insert checks the row's own organization_id, not the
-- organization of the conversation, so any tenant with write access can attach a
-- row to another tenant's conversation. Reproduced with an ordinary
-- `ops_admin` token: ACCEPTED.
--
-- With the reads unscoped, one such row at the same transcript length made the
-- runner skip the real extraction and return the foreign row's id:
--
--     runner response : status=succeeded reason=transcript already extracted
--                       versionId=<another organization's row>
--     model calls     : 0
--     orgA's versions : 0
--
-- Scoping the reads is the fix, and it lives in the route. It is not enough on
-- its own: requirement_versions_transcript_state_key is unique on
-- (conversation_id, source_message_count) with no organization, so once the
-- read correctly ignores the foreign row, the *insert* collides with it instead
-- — a silent skip becomes a hard failure, which is not an improvement.
--
-- The index is simply inconsistent with its own sibling.
-- requirement_versions_source_job_key has been (organization_id, source_job_id)
-- since it was introduced; this one omitted the organization. Aligning them is
-- the smallest change that makes the scoping coherent end to end.
--
-- C1 is preserved exactly. Its invariant is one proposal per transcript state
-- per conversation, and a conversation has one legitimate organization, so
-- adding organization_id narrows nothing that mattered — it only stops a
-- foreign row from occupying the slot. The index keeps its name, so the
-- runner's idempotency-race detection continues to recognise it.
-- ═══════════════════════════════════════════════════════════════════════════

drop index if exists crm.requirement_versions_transcript_state_key;

create unique index if not exists requirement_versions_transcript_state_key
  on crm.requirement_versions (organization_id, conversation_id, source_message_count)
  where source_message_count is not null;

comment on index crm.requirement_versions_transcript_state_key is
  'One proposal per transcript state, per conversation, per organization. The organization is part of the key because a version is not constrained to agree with its conversation''s organization, so without it a foreign row can occupy another tenant''s slot.';


-- ── the allocator inherited the gap when the lookup moved into SQL ─────────
--
-- crm.insert_requirement_version (C2) replaced the route's read-then-insert
-- version allocation, and carried the same blind spot with it: it computes
-- `max(version)` filtered by conversation alone. A foreign row on the
-- conversation therefore decides what this organization's next version number
-- is — exactly the defect scoped out of the route above, one layer down.
--
-- Restated with the organization in the predicate. Nothing else changes: the
-- lock, the aggregate, the returned columns, the grants and the signature are
-- all as C2 defined them, so its race fix is untouched.
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
#variable_conflict use_column
declare
  v_id      uuid;
  v_version int;
begin
  perform 1 from crm.conversations c where c.id = p_conversation_id for update;

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
     and v.organization_id = p_organization_id
  returning requirement_versions.id, requirement_versions.version
       into v_id, v_version;

  return query select v_id, v_version;
end;
$$;


-- ── the supersede trigger has the same gap ─────────────────────────────────
--
-- It selects the rows to supersede by conversation and status alone, so a
-- proposal inserted by one organization superseded another organization's row
-- on the same conversation. Observed while verifying the fix above: orgA's
-- extraction silently moved orgB's row from `proposed` to `superseded`.
--
-- That is a cross-tenant *write*, and a quiet one — the affected organization
-- sees a proposal it never decided marked as overtaken.
--
-- The rules are unchanged; each now only reaches rows belonging to the same
-- organization as the row that triggered it. Within one organization C3
-- behaves exactly as before: accepting a version supersedes the previously
-- accepted one, and a new proposal supersedes an older undecided one.
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
     where organization_id = new.organization_id
       and conversation_id = new.conversation_id
       and id <> new.id
       and status = 'accepted';

  elsif tg_op = 'INSERT' and new.status = 'proposed' then
    update crm.requirement_versions
       set status = 'superseded'
     where organization_id = new.organization_id
       and conversation_id = new.conversation_id
       and id <> new.id
       and status = 'proposed';
  end if;

  return new;
end;
$$;

-- Recreated unchanged; the trigger definition is restated only because the
-- function it calls was replaced. BEFORE, for the reason PR #3 gives: the
-- one-accepted index is checked as the row is written, so an AFTER trigger
-- would be too late to clear the previous accepted version.
drop trigger if exists requirement_versions_supersede on crm.requirement_versions;
create trigger requirement_versions_supersede
  before insert or update on crm.requirement_versions
  for each row execute function crm.requirement_versions_supersede();

-- The one-accepted guard is per conversation and shares the same blind spot: a
-- foreign row marked `accepted` would occupy the slot. Scoped for the same
-- reason and with the same name, so nothing that references it has to change.
drop index if exists crm.requirement_versions_one_accepted_key;

create unique index if not exists requirement_versions_one_accepted_key
  on crm.requirement_versions (organization_id, conversation_id)
  where status = 'accepted';
