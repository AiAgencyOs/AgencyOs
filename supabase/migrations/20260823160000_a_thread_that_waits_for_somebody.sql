-- ═══════════════════════════════════════════════════════════════════════════
-- A thread that waits for somebody.
--
-- `20260823140000` gave the sales agent a way to stop and ask for a person —
-- Doc 09 §7 and §36, both of which list escalation as a guardrail. It works,
-- and it was **half a feature**:
--
--   grep agent_paused  src/ app/   →   nothing
--
-- The agent pauses the thread. The client is told somebody is coming. And
-- **nobody is told**. A conversation waiting for a person who does not know
-- they are waited for is worse than no escalation at all: before it, the agent
-- kept answering badly; after it, the client sat in silence believing help was
-- on the way.
--
-- Found by checking rather than assumed, and it was mine.
--
-- ── it reuses the announcer that already exists ──────────────────────────
--
-- G-110 and ADM-74 built the path: an event, a handler, the organization's
-- internal group, `crm.send_outbound_message`, keyed so a redelivery announces
-- once. This adds a second event to it and nothing else. A second notifier
-- would be a second thing to keep in step, and the one that drifts is the one
-- nobody remembers exists.
--
-- ── and the way back ─────────────────────────────────────────────────────
--
-- `crm.resume_agent_replies` is the other half, and it is deliberately NOT the
-- mirror of the pause. The pause is the agent's and takes no identity; this
-- refuses a caller without one. **A person paused nothing and only a person
-- may un-pause it** — that is the sentence the last migration wrote, and this
-- is what makes it true rather than true-by-omission.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('conversation.escalated',
   'The sales agent stopped answering a conversation and asked for a person (Doc 09 §7, §36).',
   null)
on conflict (type) do nothing;

create or replace function crm.emit_conversation_escalated()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- On the transition only. `agent_paused_at` is written once and never
  -- cleared by anything but a person, so this fires once per handover.
  if old.agent_paused_at is null and new.agent_paused_at is not null then
    perform core.emit_event(
      new.organization_id, 'conversation.escalated', 'conversation', new.id,
      jsonb_build_object(
        'conversation_id', new.id,
        'lead_id', new.lead_id,
        'reason', new.agent_paused_reason
      )
    );
  end if;
  return new;
end;
$$;

comment on function crm.emit_conversation_escalated() is
  'Tells the internal group that a conversation is waiting for a person. Fires on the transition into paused, which happens once because nothing but a human clears it.';

drop trigger if exists emit_conversation_escalated on crm.conversations;
create trigger emit_conversation_escalated
  after update of agent_paused_at on crm.conversations
  for each row execute function crm.emit_conversation_escalated();


-- ── the way back, which only a person has ────────────────────────────────

create or replace function crm.resume_agent_replies(p_conversation uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_resumed boolean;
begin
  -- The asymmetry is the point. `hand_conversation_to_a_person` takes no
  -- identity because the agent has none; this refuses a caller without one,
  -- so the service role cannot resume a thread either. Whatever made the agent
  -- stop, a person decides it is over.
  if v_actor is null then
    raise exception 'only a person may put the agent back on a conversation it handed over'
      using errcode = 'insufficient_privilege';
  end if;

  update crm.conversations c
     set agent_paused_at     = null,
         agent_paused_reason = null,
         updated_at          = now()
   where c.id = p_conversation
     and c.agent_paused_at is not null
     -- RLS is bypassed by definer, so the tenant check is here by hand: the
     -- caller's own organization, from their session, never from the argument.
     and c.organization_id = (select core.current_organization_id())
  returning true into v_resumed;

  return coalesce(v_resumed, false);
end;
$$;

comment on function crm.resume_agent_replies(uuid) is
  'Puts the sales agent back on a conversation a person has finished with. REFUSES A CALLER WITH NO IDENTITY, including the service role - the asymmetry with hand_conversation_to_a_person is deliberate, because an agent that could resume itself would be deciding that what it escalated no longer matters. Tenant-pinned to the caller''s own organization. Returns false when the thread was not paused, which is not an error.';

revoke all on function crm.resume_agent_replies(uuid) from public;
grant execute on function crm.resume_agent_replies(uuid) to authenticated;

notify pgrst, 'reload schema';
