-- A client who writes while their thread waits for a person is told so — once.
--
-- Found by the first live run: after the agent hands a thread to a person it
-- stays silent, correctly, and the client who keeps writing ("Hello? koi jawab
-- nahi aaya") meets only silence — four unanswered price objections, and the
-- staff were told once, at the pause, and never again. The owner decided
-- (2026-10-03): the client gets one fixed acknowledgement per pause, and staff
-- are told each time the client writes.
--
-- The agent is NOT involved: this emits `conversation.client_waiting`, handled
-- by the application (`handleClientWaiting`). Additive: the one change to
-- `crm.emit_reply_due` is that the paused branch emits that event instead of
-- returning silently; everything else in the function is carried over from its
-- live definition.

insert into core.event_types (type, description, canonical) values
  ('conversation.client_waiting',
   'A client wrote on a thread that is waiting for a person; the application acknowledges once per pause and tells staff.',
   null)
on conflict (type) do nothing;

CREATE OR REPLACE FUNCTION crm.emit_reply_due()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_paused_at timestamptz;
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
  select c.agent_paused_at into v_paused_at
    from crm.conversations c
   where c.id = new.conversation_id;

  if not exists (
    select 1 from core.organizations o
     where o.id = new.organization_id
       and o.agent_answers_clients
  ) then
    return new;
  end if;

  -- The thread is waiting for a person. The agent still stays silent — but a
  -- client who writes into a silence deserves to hear that somebody is
  -- coming, once, and the staff deserve to be told the client wrote again.
  -- That is the application's job, not the agent's, so it is a different
  -- event (`conversation.client_waiting`); the handler sends one fixed,
  -- code-written acknowledgement per pause and raises an alert.
  if v_paused_at is not null then
    perform core.emit_event(
      new.organization_id, 'conversation.client_waiting', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq, 'pausedAt', v_paused_at)
    );
    return new;
  end if;

  perform core.emit_event(
    new.organization_id, 'reply.due', 'conversation_message', new.id,
    jsonb_build_object('conversation_id', new.conversation_id, 'seq', new.seq)
  );

  return new;
end;
$function$;

notify pgrst, 'reload schema';
