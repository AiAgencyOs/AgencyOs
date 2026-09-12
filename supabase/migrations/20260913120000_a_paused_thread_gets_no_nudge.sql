-- ═══════════════════════════════════════════════════════════════════════════
-- A paused thread gets no nudge — G-241
--
-- Doc 09 §7 and §36: a conversation handed to a person is a person's. The
-- follow-up worker never read `crm.conversations.agent_paused_at`, so a
-- client the lead page said was waiting for somebody was still chased by the
-- agent's sequences in the agent's voice. Rare while a pause was something a
-- client asked for; routine once G-240 hands every analysed meeting's thread
-- to a person to confirm it.
--
-- The due list carries the fact and the WORKER blocks on it — a named block
-- (`thread_waiting_for_a_person`) beside the timezone, consent and ceiling
-- blocks, tried again next tick, no attempt spent — rather than the query
-- hiding the sequence, which would leave nothing on the row for a person to
-- read. When a person puts the agent back, the next tick sends.
--
-- Carried forward VERBATIM from 20260815120003 with ONE marked edit. Dropped
-- first, as that migration did, because a new column changes the return
-- type; the grant below re-establishes exactly what the drop removes.
-- ═══════════════════════════════════════════════════════════════════════════

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
  correlation_id  uuid,
  -- [G-241 edit 1 of 1] When the sequence's thread was handed to a person.
  thread_paused_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.organization_id, s.situation_key, s.subject_type, s.subject_id,
         s.conversation_id, s.contact_id, s.triggered_at, s.attempts_sent, s.correlation_id,
         -- [G-241 edit 1 of 1] the same edit, its value: read from the thread, never claimed.
         c.agent_paused_at
    from crm.follow_up_sequences s
    left join crm.conversations c on c.id = s.conversation_id
   where s.status = 'active'
     and s.next_due_at is not null
     and s.next_due_at <= now()
   order by s.next_due_at
   limit p_limit;
$$;

comment on function crm.due_follow_up_sequences(int) is
  'Sequences already running whose next attempt is due (G-012). Carries the contact so the worker can check consent without a conversation, and (G-241) when the thread was handed to a person, so the worker blocks rather than nudging a client who is waiting for somebody.';

revoke all on function crm.due_follow_up_sequences(int) from public;
grant execute on function crm.due_follow_up_sequences(int) to service_role;

notify pgrst, 'reload schema';
