-- ═══════════════════════════════════════════════════════════════════════════
-- A sequence remembers who it is for.
--
-- Gap G-012. A defect found by driving the post-project rhythm through the
-- real worker.
--
-- ── what was wrong ───────────────────────────────────────────────────────
--
-- `crm.observe_follow_up_candidates` returns a `contact_id` for every
-- client-facing situation — including post-project, where it comes from the
-- client account rather than from a thread. **The sequence did not store it**,
-- and the worker looked the contact up through `conversation_id`.
--
-- For any situation that has no conversation, that lookup returns null,
-- `hasConsent(null)` is false, and the sequence blocks with `no_consent`
-- forever — reporting a consent problem for a contact who had granted it.
--
-- The observed fact was being thrown away and then missed.
--
-- ── why the column rather than a smarter lookup ──────────────────────────
--
-- The worker could re-derive the contact per situation: through the
-- conversation for a lead, through the client account for a project. That is
-- the observer's logic written a second time, in a second place, for the same
-- five situations — and the two would drift the first time a situation was
-- added.
--
-- The observer already decides who a follow-up concerns. Storing its answer
-- means one definition, and the worker reads rather than re-derives.
--
-- Null stays legal: `pending_approval` is internal and has no contact by
-- design, which is exactly why the consent check skips it.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.follow_up_sequences
  add column if not exists contact_id uuid references crm.contacts(id) on delete set null;

comment on column crm.follow_up_sequences.contact_id is
  'Who the follow-up concerns, as the observer determined it (G-012). Stored rather than re-derived: the worker would otherwise need the observer per-situation logic a second time, and the two would drift. Null is legal - pending_approval is internal and has no contact, which is why the consent check skips it.';

create index if not exists follow_up_sequences_contact_idx
  on crm.follow_up_sequences (organization_id, contact_id)
  where contact_id is not null;

-- ── the starter carries it through ───────────────────────────────────────

create or replace function crm.start_follow_up_sequence(
  p_organization_id uuid,
  p_situation_key   text,
  p_subject_type    text,
  p_subject_id      uuid,
  p_triggered_at    timestamptz,
  p_conversation_id uuid default null,
  p_contact_id      uuid default null
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
    organization_id, situation_key, subject_type, subject_id,
    conversation_id, contact_id, triggered_at
  )
  values (
    p_organization_id, p_situation_key, p_subject_type, p_subject_id,
    p_conversation_id, p_contact_id, p_triggered_at
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

comment on function crm.start_follow_up_sequence(uuid, text, text, uuid, timestamptz, uuid, uuid) is
  'Starts a follow-up sequence, or returns the one that already exists (G-012). Carries the contact the observer identified, so a situation with no conversation can still have its consent checked.';

revoke all on function crm.start_follow_up_sequence(uuid, text, text, uuid, timestamptz, uuid, uuid) from public;
grant execute on function crm.start_follow_up_sequence(uuid, text, text, uuid, timestamptz, uuid, uuid) to service_role;

-- The previous six-argument signature would otherwise remain callable and
-- would silently write a null contact, which is the defect this fixes.
drop function if exists crm.start_follow_up_sequence(uuid, text, text, uuid, timestamptz, uuid);

-- ── the due list carries it too ──────────────────────────────────────────
--
-- Dropped first: adding a column changes the return type, and Postgres
-- refuses `create or replace` for that. The grant below re-establishes
-- exactly what the drop removes.

drop function if exists crm.due_follow_up_sequences(int);

create function crm.due_follow_up_sequences(p_limit int default 200)
returns table (
  sequence_id     uuid,
  organization_id uuid,
  situation_key   text,
  subject_type    text,
  subject_id      uuid,
  conversation_id uuid,
  contact_id      uuid,
  triggered_at    timestamptz,
  attempts_sent   int,
  correlation_id  uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.organization_id, s.situation_key, s.subject_type, s.subject_id,
         s.conversation_id, s.contact_id, s.triggered_at, s.attempts_sent, s.correlation_id
    from crm.follow_up_sequences s
   where s.status = 'active'
     and s.next_due_at is not null
     and s.next_due_at <= now()
   order by s.next_due_at
   limit p_limit;
$$;

comment on function crm.due_follow_up_sequences(int) is
  'Sequences already running whose next attempt is due (G-012). Carries the contact so the worker can check consent without a conversation.';

revoke all on function crm.due_follow_up_sequences(int) from public;
grant execute on function crm.due_follow_up_sequences(int) to service_role;
