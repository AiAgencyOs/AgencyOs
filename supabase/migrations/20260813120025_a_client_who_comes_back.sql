-- ═══════════════════════════════════════════════════════════════════════════
-- A client who comes back.
--
-- Gap G-016, decision ADM-05: *"One lead per person, forever. A returning
-- client gets a new deal on their existing lead, so their whole history stays
-- in one place."*
--
-- Two thirds of that already worked, and were measured rather than assumed
-- before anything here was written:
--
--   ✓ the same phone resolves to the same lead — `leads_source_ref_key`
--   ✓ a second deal opens on it — `opportunities_open_lead_key` is partial on
--     unsettled stages, so a won deal does not block the next one (G-088)
--   ✗ **nothing marks the return at all**
--
-- The third is the whole gap. `crm.ingest_whatsapp_message` records the
-- message and then stops short of queueing an extraction when the lead is
-- `converted` or `disqualified` — correctly, because C6 established that
-- extraction exists to move an *undecided* lead forward and a settled deal is
-- not moved forward by proposing requirements at it.
--
-- But nothing takes its place. The message lands in the transcript of a lead
-- nobody is working, with no activity, no follow-up, no event and no change
-- anywhere a person looks. A client saying *"hi, I want a second app"* — which
-- is repeat revenue, and the entire premise of Document 18's retention and
-- upsell system — is filed silently.
--
-- ── a trigger, not a change to the ingest ─────────────────────────────────
--
-- The obvious place is that settled-lead branch. This is deliberately not
-- there, for two reasons.
--
-- It **covers every path**, which is the G-093 argument: a message inserted by
-- a future ingest, by a backfill, or straight through PostgREST marks the
-- return the same way. And carrying `ingest_whatsapp_message` forward whole to
-- add four lines is exactly the regeneration that silently changed a seq base
-- from -1 to 0 earlier today — a risk with no upside here.
--
-- ── what it deliberately does not do ──────────────────────────────────────
--
-- **It does not move the lead's status.** `converted` is terminal in
-- LEAD_TRANSITIONS, and ADM-05 says the returning client gets a new *deal*,
-- not a reopened lead. Flipping the status back would rewrite the history of
-- the engagement that closed.
--
-- **It does not set a follow-up date.** When somebody should be chased is a
-- business rule nobody has written, and inventing one puts a date in a queue
-- the agency never agreed to.
--
-- **It does not open the deal.** ADM-05 says a returning client gets a new
-- deal; it does not say the system opens it unasked, and opening one would
-- create a pipeline entry with no value, no owner and no conversation behind
-- it. What this does is make the return *visible*, which is what was missing.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.mark_returning_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead   crm.leads;
  v_conv   crm.conversations;
begin
  -- Only an inbound message from the client. Outbound is the agency talking,
  -- and `author_type` is how the two are told apart.
  if new.author_type <> 'client' then
    return null;
  end if;

  select c.* into v_conv
    from crm.conversations c
   where c.id = new.conversation_id;

  -- A group has no lead (G-115), and a message there is not a client
  -- returning — it is a conversation already in progress.
  if v_conv.lead_id is null or v_conv.kind <> 'direct' then
    return null;
  end if;

  select l.* into v_lead
    from crm.leads l
   where l.id = v_conv.lead_id;

  -- The whole condition: a message arriving on a lead that was already
  -- decided. An undecided lead is the ordinary case and the extraction path
  -- already handles it.
  if v_lead.id is null or v_lead.status not in ('converted', 'disqualified') then
    return null;
  end if;

  -- ── the mark ────────────────────────────────────────────────────────────
  --
  -- `message_in` from the vocabulary lead_activities already has, rather than
  -- a new kind: ADM-10 chose activities as the record of "everything the
  -- agency actually does", and this is one of those things. What makes it a
  -- *return* is the metadata, which is also what a screen filters on.
  --
  -- One per message, and the message id is unique, so a redelivery that
  -- somehow reached this twice would still write one row.
  insert into crm.lead_activities (
    organization_id, lead_id, kind, body, actor_type, metadata, occurred_at
  )
  values (
    new.organization_id,
    v_lead.id,
    'message_in',
    case v_lead.status
      when 'converted'    then 'A client whose deal is already won got in touch again.'
      else 'A disqualified lead got in touch again.'
    end,
    'client',
    jsonb_build_object(
      'returning', true,
      'lead_status', v_lead.status,
      'message_id', new.id,
      'conversation_id', new.conversation_id
    ),
    new.occurred_at
  );

  -- ── and the announcement ────────────────────────────────────────────────
  --
  -- Nothing subscribes to this yet — src/lib/events/catalog.ts lists only
  -- handlers that exist, and an event with no subscribers is published and
  -- costs nothing. It is emitted because this is the moment repeat revenue
  -- appears, and Document 18's retention and upsell work is what will read it.
  perform core.emit_event(
    new.organization_id,
    'lead.returned',
    'lead',
    v_lead.id,
    jsonb_build_object(
      'leadStatus', v_lead.status,
      'conversationId', new.conversation_id,
      'messageId', new.id
    )
  );

  return null;
end;
$$;

comment on function crm.mark_returning_client() is
  'Records a lead activity and emits lead.returned when a client whose lead was already converted or disqualified gets in touch again (G-016, ADM-05). Until this, such a message landed in the transcript of a lead nobody was working, with no activity, no event and no change anywhere a person looks - repeat revenue, filed silently. Deliberately does NOT move the lead status (converted is terminal, and ADM-05 gives the returning client a new deal rather than a reopened lead), set a follow-up date, or open the deal.';

drop trigger if exists mark_returning_client on crm.conversation_messages;
create trigger mark_returning_client
  after insert on crm.conversation_messages
  for each row execute function crm.mark_returning_client();

-- ═══════════════════════════════════════════════════════════════════════════
-- Reading it back
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Side-effect free, so a screen can show who has come back without pressing
-- anything — the same shape as start_readiness and requirement_coverage.

create or replace function crm.returning_clients(p_since timestamptz default null)
returns table (
  lead_id       uuid,
  title         text,
  lead_status   text,
  messages      int,
  last_message  timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id,
         l.title,
         l.status,
         count(*)::int,
         max(a.occurred_at)
    from crm.lead_activities a
    join crm.leads l on l.id = a.lead_id
   where a.metadata->>'returning' = 'true'
     and (p_since is null or a.occurred_at >= p_since)
     and l.deleted_at is null
   group by l.id, l.title, l.status
   order by max(a.occurred_at) desc;
$$;

comment on function crm.returning_clients(timestamptz) is
  'Leads that were already settled and whose client has been in touch since (G-016). The question Document 18 asks first, and which had no answer: who is coming back?';

revoke all on function crm.returning_clients(timestamptz) from public;
grant execute on function crm.returning_clients(timestamptz) to authenticated, service_role;
