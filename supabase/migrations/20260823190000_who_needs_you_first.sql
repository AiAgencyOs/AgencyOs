-- ═══════════════════════════════════════════════════════════════════════════
-- Who needs you first.
--
-- Document 09 §31 asks for lead prioritisation and the owner's mandate gives
-- it a number: **200–300 leads a month**. At that volume the question a
-- salesperson opens the day with is not "what is my pipeline", it is "who is
-- waiting for me". `/leads` answers the first and nothing answers the second.
--
-- ── no score, and that is ADM-88 rather than a preference ────────────────
--
-- §31 lists nine signals and §10 lists ten dimensions with *"configurable
-- weights"*. **ADM-88 refused all of it**, in these words:
--
--   *"no numeric lead score and no invented weights — the repository has no
--    approved scoring model and inventing one is out of scope. Priority is a
--    deterministic fact-tier order."*
--
-- `crm.reactivation_priority` is that decision built once already. This is the
-- same shape for a different question: that one ranks cold leads worth
-- re-approaching, this one ranks live ones somebody owes an answer to.
--
-- Every tier below is a row somebody or something wrote. There is no weight,
-- no threshold, and nothing to tune — which also means there is nothing to
-- explain when a lead appears in a place a person disagrees with. They can see
-- why in one word.
--
-- ── and no consent gate, deliberately ───────────────────────────────────
--
-- `reactivation_priority` ranks only consent-eligible leads, because what it
-- feeds is an outbound queue. **This feeds a person's morning.** Consent
-- governs sending, `crm.send_outbound_message` enforces it, and a client who
-- wrote to us yesterday must appear on this list whether or not anybody has
-- recorded a consent row for them yet — hiding them would be the opposite of
-- what ADM-70 protects.
-- ═══════════════════════════════════════════════════════════════════════════

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
      when q.sent_at is not null                            then 'quoted_no_answer'
      when rd.at is not null                                then 'ready_to_quote'
      when u.at is not null                                 then 'open_objection'
      when n.lead_id is null                                then 'never_answered'
      else 'quiet'
    end,
    case
      when t.agent_paused_at is not null                    then t.agent_paused_at
      when n.author_type = 'client'                         then n.occurred_at
      when q.sent_at is not null                            then q.sent_at
      when rd.at is not null                                then rd.at
      when u.at is not null                                 then u.at
      else n.occurred_at
    end
    from live
    left join thread t     on t.lead_id  = live.id
    left join newest n     on n.lead_id  = live.id
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
      when q.sent_at is not null         then 3
      when rd.at is not null             then 4
      when u.at is not null              then 5
      when n.lead_id is null             then 6
      else 7
    end,
    coalesce(
      t.agent_paused_at,
      case when n.author_type = 'client' then n.occurred_at end,
      q.sent_at, rd.at, u.at, n.occurred_at
    ) asc nulls last,
    -- A stable tie-break, so two leads in the same second do not swap places
    -- between two loads of the same page.
    live.id
   limit greatest(p_limit, 0);
end;
$$;

comment on function crm.lead_attention(int, uuid) is
  'Document 09 section 31, under ADM-88: who needs a person first, as a deterministic FACT-TIER order and never a score. The tiers, most urgent first - handed_over (the agent stopped and asked for a person), waiting_on_us (they wrote last and nobody answered), quoted_no_answer, ready_to_quote (requirements accepted, no quotation), open_objection (a concern with no answer), never_answered, quiet. Within a tier, oldest first: a client waiting three days outranks one waiting three minutes. No weight, no threshold, nothing to tune - and so nothing to explain when somebody disagrees with a placement, because the reason is one word. Deliberately NOT consent-gated, unlike crm.reactivation_priority: that one feeds an outbound queue and this one feeds a person''s morning, and a client who wrote to us yesterday must appear whether or not a consent row exists. Read-only, tenant-pinned to the caller''s own organization.';

grant execute on function crm.lead_attention(int, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
