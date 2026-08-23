-- The client asks for a change — brief §23/§24, gap G-157.
--
-- "Can you add live tracking and reduce price to 55k?" The mandate's answer
-- is a loop: the ask is RECORDED as a structured fact, a person drafts the
-- revised version, the owner approves it, the client receives v2 — and the
-- loop may repeat, unbounded. §26's own instruction was "do not create a
-- duplicate state machine if one already exists", and almost all of this one
-- already did:
--
--   the structured change request   sales.objections (§19/§20: the client's
--                                   exact words, the kind, the version it
--                                   was raised against, open until a person
--                                   answers)
--   the revised version             sales.draft_proposal (supersedes ANY
--                                   live version, sent included; cancels its
--                                   pending approval; unbounded versions)
--   the owner's review              submit_proposal → the announcement with
--                                   the full quotation and its PDF (G-155/6)
--   v2 to the client                send_proposal (text + PDF, idempotent)
--
-- What was actually missing is two small facts, and both live here:
--
-- 1. THE ASK NEVER BECAME A ROW. crm.emit_objection_raised fired on
--    price_inquiry, negotiation and trust_concern — but "add live tracking"
--    is none of those. The intent read can already name it (change_request
--    is in Doc 08 §12's twenty-two); the trigger just never asked for it to
--    be read. One intent added to the gate.
--
-- 2. THE QUEUE TOLD A TRUE COUNT AND A FALSE SENTENCE. A lead whose client
--    answered the quotation with "change it" sat in quoted_no_answer — as
--    if they had said nothing. crm.lead_attention gains the tier between
--    "they wrote last" and "quote out, no answer": revision_asked, an open
--    objection against the version that is out with the client. It clears
--    itself the honest way — drafting v2 supersedes v1 and the join on
--    status = 'sent' stops matching — because writing anything into the
--    objection's `response` column would fabricate a person's words
--    (ADM-76: the response is what somebody actually said).
--
-- What is deliberately NOT here: no auto-drafted v2. The mandate's diagram
-- sends the change request straight into a generated revision; drafting v2
-- SUPERSEDES the quotation the client is holding, and an agent retracting
-- the standing offer on its own reading of one message is a decision, not a
-- read (ADM-61 §5, ADM-22). The row and the tier put the ask in front of a
-- person; the person clicks draft. The agent's own reply keeps §23's script
-- — acknowledge, promise nothing, say it is being confirmed internally —
-- which lives in the composer's context, not in this file.
--
-- D16: both functions are carried forward verbatim from their latest
-- definitions (20260822230000, 20260823190000) with the marked edits.
create or replace function crm.emit_objection_raised()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- EDIT (G-157): + change_request. "Add live tracking" against a sent
  -- quotation carried no objection intent, so §23's ask — the one the whole
  -- revision loop starts from — never became a row. A change request IS a
  -- feature/price objection wearing plainer words, and the read that follows
  -- quotes it either way.
  if new.intent in ('price_inquiry', 'negotiation', 'trust_concern', 'change_request')
     and old.intent is null
  then
    perform core.emit_event(
      new.organization_id, 'objection.raised', 'conversation_message', new.id,
      jsonb_build_object('conversation_id', new.conversation_id, 'intent', new.intent)
    );
  end if;
  return new;
end;
$$;
-- The trigger statement is unchanged (after update of intent); re-issued so
-- the migration stands alone if the function above ever moves again.
drop trigger if exists emit_objection_raised on crm.conversation_messages;
create trigger emit_objection_raised
  after update of intent on crm.conversation_messages
  for each row execute function crm.emit_objection_raised();

create or replace function crm.lead_attention(
  p_limit int default 25,
  p_organization_id uuid default null
)
returns table (
  lead_id     uuid,
  title       text,
  status      text,
  -- Which tier put it here, in one word a person can act on.
  reason      text,
  -- When it entered that state. The column a reader scans: three days beats
  -- three minutes, whatever the tier.
  waiting_since timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  v_org := case
    when (select auth.uid()) is not null then (select core.current_organization_id())
    else p_organization_id
  end;

  if v_org is null then
    return;
  end if;

  return query
  with live as (
    -- A settled lead is not somebody's morning. `converted` is terminal and
    -- `disqualified` is a decision a person made.
    select l.id, l.title, l.status
      from crm.leads l
     where l.organization_id = v_org
       and l.deleted_at is null
       and l.status not in ('converted', 'disqualified')
  ),
  thread as (
    select c.lead_id, c.id as conversation_id, c.agent_paused_at
      from crm.conversations c
      join live on live.id = c.lead_id
     where c.organization_id = v_org
       and c.status <> 'abandoned'
  ),
  -- The newest message on each thread, and who wrote it. One statement rather
  -- than a per-lead lookup, because at 300 leads the difference is the page
  -- loading or not.
  newest as (
    select distinct on (t.lead_id)
           t.lead_id, m.author_type, m.occurred_at
      from thread t
      join crm.conversation_messages m
        on m.conversation_id = t.conversation_id
       and m.organization_id = v_org
     order by t.lead_id, m.occurred_at desc, m.seq desc
  ),
  -- A quotation the client has received, and nothing from them since.
  quoted as (
    select t.lead_id, max(p.sent_at) as sent_at
      from thread t
      join sales.opportunities o on o.lead_id = t.lead_id and o.organization_id = v_org
      join sales.proposals p on p.opportunity_id = o.id and p.organization_id = v_org
     where p.status = 'sent' and p.sent_at is not null
     group by t.lead_id
  ),
  -- Requirements a person accepted, with no quotation against them yet.
  ready as (
    select distinct t.lead_id, min(r.updated_at) as at
      from thread t
      join crm.requirement_versions r
        on r.conversation_id = t.conversation_id
       and r.organization_id = v_org
       and r.status = 'accepted'
      left join sales.proposals p
        on p.requirement_version_id = r.id
       and p.organization_id = v_org
     where p.id is null
     group by t.lead_id
  ),
  -- A concern nobody has answered. §19's `response` is a person's, so a null
  -- one means exactly that: nobody has.
  -- EDIT (G-157): the tier between "they wrote last" and "quote out, no
  -- answer". An open objection AGAINST the version that is out with the
  -- client means they answered the quote — with "change it" — and somebody
  -- promised them a revision. Labelling that lead quoted_no_answer was a
  -- true count and a false sentence. Self-clearing without fabricating a
  -- response: drafting v2 supersedes v1, the join on status = 'sent' stops
  -- matching, and the lead falls back to the ordinary tiers.
  revising as (
    select ob.lead_id, min(ob.created_at) as at
      from sales.objections ob
      join sales.proposals p
        on p.id = ob.proposal_id
       and p.organization_id = v_org
       and p.status = 'sent'
       -- The same two facts `quoted` below calls "out with the client": a
       -- status alone is a claim, the timestamp is the send.
       and p.sent_at is not null
      -- And the version must belong to THIS lead's own deal. An objection
      -- row citing another lead's proposal is corrupt data; ranking a lead
      -- by somebody else's quotation would launder that corruption into a
      -- work queue.
      join sales.opportunities po
        on po.id = p.opportunity_id
       and po.organization_id = v_org
       and po.lead_id = ob.lead_id
      join live on live.id = ob.lead_id
     where ob.organization_id = v_org
       and ob.response is null
     group by ob.lead_id
  ),
  unanswered as (
    select ob.lead_id, min(ob.created_at) as at
      from sales.objections ob
      join live on live.id = ob.lead_id
     where ob.organization_id = v_org
       and ob.response is null
     group by ob.lead_id
  )
  select
    live.id,
    live.title,
    live.status,
    -- First match wins, and the order IS the priority. Read it as a sentence:
    -- somebody was promised a person, somebody is waiting, somebody has our
    -- quotation, somebody is ready for one, somebody raised a concern.
    case
      when t.agent_paused_at is not null                    then 'handed_over'
      when n.author_type = 'client'                         then 'waiting_on_us'
      when rv.at is not null                                then 'revision_asked'
      when q.sent_at is not null                            then 'quoted_no_answer'
      when rd.at is not null                                then 'ready_to_quote'
      when u.at is not null                                 then 'open_objection'
      when n.lead_id is null                                then 'never_answered'
      else 'quiet'
    end,
    case
      when t.agent_paused_at is not null                    then t.agent_paused_at
      when n.author_type = 'client'                         then n.occurred_at
      when rv.at is not null                                then rv.at
      when q.sent_at is not null                            then q.sent_at
      when rd.at is not null                                then rd.at
      when u.at is not null                                 then u.at
      else n.occurred_at
    end
    from live
    left join thread t     on t.lead_id  = live.id
    left join newest n     on n.lead_id  = live.id
    left join revising rv  on rv.lead_id = live.id
    left join quoted q     on q.lead_id  = live.id
    left join ready rd     on rd.lead_id = live.id
    left join unanswered u on u.lead_id  = live.id
   order by
    -- The tier, then how long it has been in it. Oldest first, always: a
    -- client waiting three days outranks one waiting three minutes, and a
    -- queue that does not say so is a queue that loses the patient ones.
    case
      when t.agent_paused_at is not null then 1
      when n.author_type = 'client'      then 2
      when rv.at is not null             then 3
      when q.sent_at is not null         then 4
      when rd.at is not null             then 5
      when u.at is not null              then 6
      when n.lead_id is null             then 7
      else 8
    end,
    coalesce(
      t.agent_paused_at,
      case when n.author_type = 'client' then n.occurred_at end,
      rv.at, q.sent_at, rd.at, u.at, n.occurred_at
    ) asc nulls last,
    -- A stable tie-break, so two leads in the same second do not swap places
    -- between two loads of the same page.
    live.id
   limit greatest(p_limit, 0);
end;
$$;
comment on function crm.lead_attention(int, uuid) is
  'Document 09 section 31, under ADM-88: who needs a person first, as a deterministic FACT-TIER order and never a score. The tiers, most urgent first - handed_over (the agent stopped and asked for a person), waiting_on_us (they wrote last and nobody answered), revision_asked (an open objection against the quotation that is out with them - they answered the quote with "change it", and somebody owes them a revision; clears itself when drafting v2 supersedes the version it was raised against), quoted_no_answer, ready_to_quote (requirements accepted, no quotation), open_objection (a concern with no answer), never_answered, quiet. Within a tier, oldest first: a client waiting three days outranks one waiting three minutes. No weight, no threshold, nothing to tune - and so nothing to explain when somebody disagrees with a placement, because the reason is one word. Deliberately NOT consent-gated, unlike crm.reactivation_priority: that one feeds an outbound queue and this one feeds a person''s morning, and a client who wrote to us yesterday must appear whether or not a consent row exists. Read-only, tenant-pinned to the caller''s own organization.';

notify pgrst, 'reload schema';
