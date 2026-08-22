-- ═══════════════════════════════════════════════════════════════════════════
-- A salesperson who asks for help.
--
-- Document 09 §7: *"Sales Agent must escalate high-risk/out-of-policy
-- requests."* §36: *"AI must escalate uncertainty."* Both are listed as
-- guardrails, and **there is no way to escalate.** `agent_answers_clients` is
-- one switch for a whole agency; there is nothing that stops the agent on one
-- conversation, so a client who says *"main kisi insaan se baat karna chahta
-- hoon"* is answered by the agent, again, for ever.
--
-- That is the worst single failure available to this system. Everything else
-- on the list — a clumsy question, a missed signal — costs a little. Refusing
-- to fetch a person when somebody asks for one is the failure a client tells
-- other people about.
--
-- ── what this is, and what it deliberately is not ────────────────────────
--
-- It is a **pause on one conversation**, set by the agent, cleared only by a
-- person. It narrows ADM-91 rather than widening anything: the agent's power
-- to answer unread is exactly what is being given up, on the thread where
-- giving it up is right.
--
-- It is **not** an approval request. Nothing is being decided and nobody is
-- being asked to permit anything — a person is being asked to take over a
-- conversation. `approvals.approval_requests` models a decision with an
-- outcome and a deadline, and borrowing it here would put a question in the
-- queue that has no answer.
--
-- It is **not** a new `lead_activities` kind. That CHECK is closed at
-- thirteen, and its own comment says *"a fourteenth needs a decision, not a
-- migration."*
--
-- ── the absence that makes it safe ───────────────────────────────────────
--
-- **Nothing here can un-pause.** There is no agent path, no job, no trigger
-- and no expiry that clears `agent_paused_at`; only an authenticated person
-- writing the row. An agent that could resume itself after escalating would
-- be an agent deciding that whatever it escalated no longer matters.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.conversations
  add column if not exists agent_paused_at timestamptz,
  add column if not exists agent_paused_reason text
    check (agent_paused_reason is null or length(btrim(agent_paused_reason)) between 1 and 300);

-- The pair travels together: a pause with no reason is a stopped conversation
-- nobody can act on, and a reason with no pause is a note.
alter table crm.conversations
  drop constraint if exists conversations_agent_pause_check;

alter table crm.conversations
  add constraint conversations_agent_pause_check check (
    (agent_paused_at is null) = (agent_paused_reason is null)
  );

comment on column crm.conversations.agent_paused_at is
  'When the sales agent handed this conversation to a person and stopped answering it - Doc 09 sections 7 and 36. Set by the agent, cleared only by a human: nothing in this system can un-pause a conversation, because an agent that could resume itself after escalating would be an agent deciding that what it escalated no longer matters.';

comment on column crm.conversations.agent_paused_reason is
  'Why, in the agent''s own words - "the client asked to speak to a person", "they are asking for a commitment I cannot make". Read by whoever picks the thread up.';

create index if not exists conversations_agent_paused_idx
  on crm.conversations (organization_id, agent_paused_at desc)
  where agent_paused_at is not null;


-- ── the agent stops answering a thread it has handed over ────────────────
--
-- Carried forward from `20260823130000`, its latest definition, with one added
-- clause and nothing else touched.

create or replace function crm.emit_reply_due()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.author_type <> 'client' then
    return new;
  end if;

  -- A file nobody has read is not yet a message anybody can answer. Deferred,
  -- not dropped: `crm.emit_media_read` fires this event when the reading
  -- lands, and a reading that cannot be had also lands — with nothing in it —
  -- so there is no state in which a client's voice note leaves them
  -- unanswered.
  if crm.awaits_media_reading(new.metadata, new.media_read_at) then
    return new;
  end if;

  -- Doc 09 §7 and §36. Once the agent has handed this thread to a person, it
  -- does not take it back — not on the next message, not on the tenth. Only a
  -- human clearing `agent_paused_at` starts it answering again.
  if exists (
    select 1 from crm.conversations c
     where c.id = new.conversation_id
       and c.agent_paused_at is not null
  ) then
    return new;
  end if;

  if not exists (
    select 1 from core.organizations o
     where o.id = new.organization_id
       and o.agent_answers_clients
  ) then
    return new;
  end if;

  perform core.emit_event(
    new.organization_id, 'reply.due', 'conversation_message', new.id,
    jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
  );

  return new;
end;
$$;


-- ── and the one way to set it ────────────────────────────────────────────
--
-- A function rather than a policy grant, so the agent's only route in writes
-- both halves at once and cannot clear what somebody else set. `on conflict`
-- is not the shape here: the guard is `agent_paused_at is null`, so a second
-- escalation on an already-paused thread changes nothing and reports so.

create or replace function crm.hand_conversation_to_a_person(
  p_conversation uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paused boolean;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'handing a conversation to a person requires a reason somebody can act on'
      using errcode = 'check_violation';
  end if;

  update crm.conversations c
     set agent_paused_at     = now(),
         agent_paused_reason = left(btrim(p_reason), 300),
         updated_at          = now()
   where c.id = p_conversation
     and c.agent_paused_at is null
  returning true into v_paused;

  return coalesce(v_paused, false);
end;
$$;

comment on function crm.hand_conversation_to_a_person(uuid, text) is
  'Stops the sales agent answering ONE conversation, with a reason a person can act on. The only way the pause is ever set. It cannot clear one: an agent that could resume itself after escalating would be deciding that what it escalated no longer matters. Returns false when the thread was already handed over, which is not an error - two escalations in a row are one handover.';

revoke all on function crm.hand_conversation_to_a_person(uuid, text) from public;
grant execute on function crm.hand_conversation_to_a_person(uuid, text) to service_role;

notify pgrst, 'reload schema';
