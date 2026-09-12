-- ═══════════════════════════════════════════════════════════════════════════
-- A quotation accepted is still a quotation sent — G-233
-- ═══════════════════════════════════════════════════════════════════════════
--
-- crm.sales_funnel (20260823150000, "where the leads are lost") counted a lead
-- as QUOTED only while its quotation's status was exactly `sent`. `accepted`
-- is what `sent` becomes when the client says yes — so the lead left the
-- quoted count at the moment the quotation succeeded, and a window could show
-- more deals WON than quotations SENT. Doc 09 §16/§18 ask for "a quotation
-- the client has actually received"; receipt is evidenced by `sent_at`, and
-- nothing that happens to the quotation afterwards un-sends it.
--
-- Found on PR #399's first full CI run: G-230 made every won deal carry an
-- accepted quotation, verify-sales-funnel began winning deals through the
-- governed path, and "sending it is what makes the lead count as quoted"
-- read +0 the moment the fixture accepted what it had sent. The verifier was
-- right about the function.
--
-- The function is carried forward VERBATIM from its only prior definition,
-- with exactly one marked edit in `quoted_leads`.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.sales_funnel(
  p_from timestamptz default (now() - interval '90 days'),
  p_to timestamptz default now(),
  p_organization_id uuid default null
)
returns table (
  -- Every count is of LEADS created in the window, so one number divides into
  -- another and means something. A deal, a message and a proposal all resolve
  -- back to the lead they belong to.
  leads                  int,
  responded              int,
  engaged                int,
  qualified              int,
  requirements_accepted  int,
  budget_known           int,
  quoted                 int,
  negotiating            int,
  won                    int,
  lost                   int,
  -- §37's three times, in hours, over the leads that reached each point.
  -- Null rather than zero when nothing reached it: an average of no rows is
  -- not zero hours, and a dashboard reading "0h response time" on an empty
  -- month is the false calm this codebase refuses everywhere else.
  hours_to_first_reply   numeric,
  hours_to_first_quote   numeric,
  hours_to_won           numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  -- The tenant pin `crm.reactivation_priority` uses: an authenticated caller
  -- reads its own organization whatever it passes, and the parameter is
  -- honoured only for the service role, which has no organization of its own.
  v_org := case
    when (select auth.uid()) is not null then (select core.current_organization_id())
    else p_organization_id
  end;

  if v_org is null then
    return;
  end if;

  return query
  with cohort as (
    select l.id, l.status, l.created_at
      from crm.leads l
     where l.organization_id = v_org
       and l.deleted_at is null
       and l.created_at >= p_from
       and l.created_at < p_to
  ),
  -- Doc 09 §6 CONTACTED: "Agency has initiated contact." The recorded fact is
  -- an outbound message on the lead's own thread.
  first_reply as (
    select c.id, min(m.occurred_at) as at
      from cohort c
      join crm.conversations v on v.lead_id = c.id and v.organization_id = v_org
      join crm.conversation_messages m
        on m.conversation_id = v.id
       and m.organization_id = v_org
       and m.author_type <> 'client'
     group by c.id
  ),
  -- §6 RESPONDING: "Two-way conversation active." Not two messages — a client
  -- who writes twice before anybody answers is not in a conversation. It is a
  -- client message that came AFTER something the agency sent.
  engaged_leads as (
    select distinct c.id
      from cohort c
      join first_reply f on f.id = c.id
      join crm.conversations v on v.lead_id = c.id and v.organization_id = v_org
      join crm.conversation_messages m
        on m.conversation_id = v.id
       and m.organization_id = v_org
       and m.author_type = 'client'
       and m.occurred_at > f.at
  ),
  -- The lead's own status, because §6 defines QUALIFIED as "enough information
  -- to pursue" and nobody has said what enough is. `converted` counts: ADM-41
  -- says a won deal implies its lead was qualified, and fills the date in.
  qualified_leads as (
    select c.id from cohort c where c.status in ('qualified', 'converted')
  ),
  -- A version a PERSON accepted. A `proposed` one is the agent's reading and
  -- is not the same fact.
  requirements_done as (
    select distinct c.id
      from cohort c
      join crm.conversations v on v.lead_id = c.id and v.organization_id = v_org
      join crm.requirement_versions r
        on r.conversation_id = v.id
       and r.organization_id = v_org
       and r.status = 'accepted'
  ),
  budget_leads as (
    select distinct q.lead_id as id
      from crm.qualification_coverage q
      join cohort c on c.id = q.lead_id
     where q.organization_id = v_org
       and q.area = 'budget'
  ),
  -- §16/§18: a quotation the client has actually received. A draft is internal.
  quoted_leads as (
    select o.lead_id as id, min(p.sent_at) as at
      from sales.proposals p
      join sales.opportunities o on o.id = p.opportunity_id and o.organization_id = v_org
      join cohort c on c.id = o.lead_id
     where p.organization_id = v_org
       -- G-233 (edit 1 of 1): was `and p.status = 'sent'` as well. `accepted` is
       -- what `sent` becomes when the client says yes, so the lead stopped
       -- counting as quoted at the moment the quotation succeeded, and a funnel
       -- could show more deals won than quotations sent. What the client
       -- received is evidenced by sent_at, whatever happened to it afterwards.
       and p.sent_at is not null
     group by o.lead_id
  ),
  negotiating_leads as (
    select distinct o.lead_id as id
      from sales.opportunities o
      join cohort c on c.id = o.lead_id
     where o.organization_id = v_org
       and o.stage = 'negotiation'
  ),
  won_leads as (
    select o.lead_id as id, min(o.closed_at) as at
      from sales.opportunities o
      join cohort c on c.id = o.lead_id
     where o.organization_id = v_org
       and o.stage = 'won'
     group by o.lead_id
  ),
  lost_leads as (
    select distinct o.lead_id as id
      from sales.opportunities o
      join cohort c on c.id = o.lead_id
     where o.organization_id = v_org
       and o.stage = 'lost'
  )
  select
    (select count(*)::int from cohort),
    (select count(*)::int from first_reply),
    (select count(*)::int from engaged_leads),
    (select count(*)::int from qualified_leads),
    (select count(*)::int from requirements_done),
    (select count(*)::int from budget_leads),
    (select count(*)::int from quoted_leads),
    (select count(*)::int from negotiating_leads),
    (select count(*)::int from won_leads),
    (select count(*)::int from lost_leads),
    -- Negative intervals are excluded rather than averaged. A reply whose
    -- `occurred_at` precedes its own lead row is not a fast response; it is an
    -- IMPORT — `crm.import_records` brings historical threads in, and the lead
    -- is created long after the conversation happened. Averaging those gives a
    -- negative "response time", which is not slow, fast, or true.
    (select round(avg(extract(epoch from (f.at - c.created_at)) / 3600)::numeric, 1)
       from first_reply f join cohort c on c.id = f.id where f.at >= c.created_at),
    (select round(avg(extract(epoch from (q.at - c.created_at)) / 3600)::numeric, 1)
       from quoted_leads q join cohort c on c.id = q.id where q.at >= c.created_at),
    (select round(avg(extract(epoch from (w.at - c.created_at)) / 3600)::numeric, 1)
       from won_leads w join cohort c on c.id = w.id where w.at is not null and w.at >= c.created_at);
end;
$$;

comment on function crm.sales_funnel(timestamptz, timestamptz, uuid) is
  'Document 09 section 37 and the Sales Dashboard of section 30: how many leads created in a window reached each recorded point, and how long the three that have a clock took. Counts FACTS ONLY - a message that was sent, a status a person set, an area the qualifier recorded, a version somebody accepted, a proposal marked sent, a deal stage. Nothing decides that N answered qualification areas means qualified, because section 6 says only "enough information to pursue" and nobody has said what enough is. THE STAGES ARE NOT NESTED: a won lead is not counted as quoted unless a quotation was actually sent, because ADM-13 lets a project start with no proposal row at all. A later stage larger than an earlier one is a finding, not a bug - it means deals are closing outside the quotation system. No money: value_minor is unset on most rows and an average of nulls is a fabricated KPI. An authenticated caller is pinned to its own organization; the org parameter is honoured only for the service role. Read-only.';

grant execute on function crm.sales_funnel(timestamptz, timestamptz, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
