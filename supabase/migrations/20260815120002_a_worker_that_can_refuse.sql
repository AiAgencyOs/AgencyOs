-- ═══════════════════════════════════════════════════════════════════════════
-- A worker that can refuse.
--
-- Gap G-012, decisions ADM-69 and ADM-70. What the follow-up worker needs in
-- order to run, decline, and be explainable afterwards.
--
-- ── the timezone, and what is and is not being decided ───────────────────
--
-- G-137: ADM-69 requires the contact timezone when known and the **agency
-- timezone** otherwise, and neither is stored anywhere.
--
-- Adding somewhere to put the agency timezone is **technical completion of a
-- requirement ADM-69 already recorded**, not a new business policy. What would
-- be inventing a fact is choosing the *value* — an agency's timezone is a
-- real-world detail nobody has stated, and a default would silently send at
-- the wrong hour in every deployment that never noticed the column.
--
-- So this adds validated storage and **leaves it null**. The worker refuses to
-- send while it is null and says why. G-137 stays open, narrowed from "no
-- column exists" to "no value is set".
--
-- The contact half is deliberately not added. No inbound channel supplies a
-- timezone, so a column for it would be a permission to guess later.
--
-- ── why a column rather than a settings key ──────────────────────────────
--
-- `core.organizations.settings` is jsonb and already holds
-- `whatsapp_phone_number_id`. A key there would work and would be untyped and
-- unvalidated: a typo'd zone name would be stored happily and fail at send
-- time, in a scheduler, at ten in the evening. A column with a CHECK refuses
-- the typo where somebody is looking at it.
--
-- ── why a blocked sequence does not spend an attempt ─────────────────────
--
-- ADM-69 gives Sales-Active seven attempts. If a sequence blocked on a missing
-- timezone consumed one per tick, it would exhaust in seven minutes and
-- escalate — reporting a client who ignored seven messages that were never
-- sent.
--
-- So a block is recorded on the sequence and an *attempt* is recorded only
-- when one is genuinely claimed. `last_block_reason` is what a blocked
-- sequence has instead of a send row.
-- ═══════════════════════════════════════════════════════════════════════════

alter table core.organizations
  add column if not exists timezone text;

-- IANA names only, loosely shaped: `Area/Location`, optionally with a third
-- segment. Deliberately not a list of every zone - that would need
-- maintaining, and Postgres already knows the real set.
alter table core.organizations drop constraint if exists organizations_timezone_iana;
alter table core.organizations add constraint organizations_timezone_iana
  check (
    timezone is null
    or timezone ~ '^[A-Za-z]+(_[A-Za-z]+)*(/[A-Za-z0-9+_-]+){1,2}$'
  );

comment on column core.organizations.timezone is
  'The agency timezone ADM-69 requires as the fallback for follow-up sending hours (G-137). An IANA name such as Asia/Kolkata. NULL BY DESIGN: an agency timezone is a real-world fact nobody has stated, and a default would silently send at the wrong hour in every deployment that never noticed. The follow-up worker refuses to send while this is null and records timezone_unavailable as the reason.';

-- ── what a sequence remembers about being blocked ────────────────────────

alter table crm.follow_up_sequences
  add column if not exists last_evaluated_at timestamptz,
  add column if not exists last_block_reason text;

comment on column crm.follow_up_sequences.last_block_reason is
  'Why the last evaluation did not produce a send, when it did not. A BLOCK IS NOT AN ATTEMPT: a sequence blocked on a missing timezone would otherwise consume one of ADM-69 seven attempts per tick, exhaust in seven minutes, and escalate about a client who ignored seven messages that were never sent.';

comment on column crm.follow_up_sequences.last_evaluated_at is
  'When the worker last looked at this sequence. Distinct from last_sent_at: a sequence can be evaluated every minute and send nothing, and the difference between the two is how a stalled scheduler is told apart from a quiet one.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Starting a sequence, idempotently
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `on conflict do nothing` rather than a "does one exist" query: the unique
-- constraint is the authority, and asking first leaves a race between the
-- asking and the writing. Returns the row either way so a caller cannot tell
-- - and does not need to tell - whether it won.

create or replace function crm.start_follow_up_sequence(
  p_organization_id uuid,
  p_situation_key   text,
  p_subject_type    text,
  p_subject_id      uuid,
  -- Defaulted because a sequence may legitimately have no thread yet - a
  -- post-project follow-up, an internal approval. Without the default the
  -- generated client type is a required string and the null is unrepresentable.
  p_triggered_at    timestamptz,
  p_conversation_id uuid default null
)
returns table (sequence_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into crm.follow_up_sequences (
    organization_id, situation_key, subject_type, subject_id, conversation_id, triggered_at
  )
  values (
    p_organization_id, p_situation_key, p_subject_type, p_subject_id, p_conversation_id, p_triggered_at
  )
  on conflict (organization_id, situation_key, subject_type, subject_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select v_id, true;
    return;
  end if;

  select s.id into v_id
    from crm.follow_up_sequences s
   where s.organization_id = p_organization_id
     and s.situation_key   = p_situation_key
     and s.subject_type    = p_subject_type
     and s.subject_id      = p_subject_id;

  return query select v_id, false;
end;
$$;

comment on function crm.start_follow_up_sequence(uuid, text, text, uuid, timestamptz, uuid) is
  'Starts a follow-up sequence, or returns the one that already exists (G-012). on conflict do nothing rather than a lookup: the unique constraint is the authority, and asking first leaves a race between the asking and the writing.';

revoke all on function crm.start_follow_up_sequence(uuid, text, text, uuid, timestamptz, uuid) from public;
grant execute on function crm.start_follow_up_sequence(uuid, text, text, uuid, timestamptz, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Escalation, exactly once
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADM-69 requires it once. The guarantee is the same shape as the attempt
-- claim: a **conditional UPDATE** whose predicate includes the state it is
-- leaving, so a second worker matches no row rather than losing a comparison.
--
-- `status = 'active'` in the WHERE is the whole mechanism. Two workers both
-- see an exhausted sequence; both run this; the first moves it to `escalated`
-- and the second updates nothing.

create or replace function crm.escalate_follow_up_sequence(
  p_sequence_id uuid,
  p_reason      text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated int;
begin
  update crm.follow_up_sequences
     set status       = 'escalated',
         stop_reason  = p_reason,
         escalated_at = now(),
         next_due_at  = null
   where id = p_sequence_id
     and status = 'active';

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

comment on function crm.escalate_follow_up_sequence(uuid, text) is
  'Escalates an exhausted sequence exactly once (G-012, ADM-69). The guarantee is a conditional UPDATE whose predicate includes the state it is leaving: two workers both run it, the first moves the row out of active and the second updates nothing. Returns whether this caller was the one that escalated, so only the winner acts on it.';

revoke all on function crm.escalate_follow_up_sequence(uuid, text) from public;
grant execute on function crm.escalate_follow_up_sequence(uuid, text) to service_role;
