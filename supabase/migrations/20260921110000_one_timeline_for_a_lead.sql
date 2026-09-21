-- One timeline for a lead — Doc 09 §28, closing a granular gap under an
-- already-built feature.
--
-- `crm.lead_activities` (7 kinds: note, status_change, message_in,
-- message_out, call, agent_run, assignment) has been the lead detail page's
-- only activity feed since the CRM schema was built, and every event §28
-- actually names beyond those seven — quote created/approved/sent, objection
-- logged, negotiation round, discount approved, acceptance received — IS
-- recorded, just never in that table: quotation status changes are audited
-- (`audit.audit_log`, subject_type='proposal'), objections are their own
-- table (`sales.objections`), and a discount or no-advance exception's
-- approval is `approvals.approval_requests`. A caller reading only
-- `lead_activities` sees none of them, which a big-picture "is it audited?"
-- check does not notice, because the facts genuinely are recorded somewhere.
--
-- This adds exactly one read — `crm.lead_timeline(p_lead_id)` — unioning the
-- four sources into one ordered feed. No new table, no new write path:
-- everything it returns is already recorded by code that existed before this
-- migration. SECURITY INVOKER throughout, so it adds no reach of its own —
-- a member sees what `lead_activities` and `objections` RLS already show
-- them, and the proposal/approval rows are silently absent for anyone who
-- is not owner or ops_admin, because `audit_log_select` already draws that
-- line and this reuses it rather than widening it.
--
-- Deliberately excluded: invoice and payment events. Both are scoped to
-- `client_account_id`, which an open lead does not carry until conversion —
-- inventing a lead-shaped view over client-shaped facts for a lead that has
-- none yet would be exactly the "column with no consumer" this codebase
-- keeps refusing to add (see 20260904170000's nurture rationale). A won
-- lead's project carries its own financial history once it exists.

create or replace function crm.lead_timeline(p_lead_id uuid)
returns table (
  occurred_at   timestamptz,
  event_type    text,
  summary       text,
  actor_type    text,
  actor_id      uuid,
  evidence_type text,
  evidence_id   uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  -- The seven kinds this page has always shown.
  select
    la.occurred_at,
    la.kind,
    la.body,
    la.actor_type,
    la.actor_id,
    'lead_activity'::text,
    la.id
    from crm.lead_activities la
   where la.lead_id = p_lead_id

  union all

  -- Objections: §19/§20's round, kind and outcome, read from the row that
  -- already carries them rather than the thinner audit.audit_log entry its
  -- own insert trigger also writes.
  select
    o.created_at,
    case when o.outcome is null then 'objection.raised' else 'objection.' || o.outcome end,
    'Round ' || o.round || ' — ' || o.kind || ': ' || o.concern,
    case when o.answered_by is not null then 'user' else 'agent' end,
    o.answered_by,
    'objection'::text,
    o.id
    from sales.objections o
   where o.lead_id = p_lead_id

  union all

  -- Quotation lifecycle: drafted, pending_approval, approved, sent,
  -- accepted, rejected, repriced — one audit row per status change,
  -- 20260814120012's trigger. Scoped to this lead's own proposals through
  -- its opportunities, the same chain the WON gate and conversion both walk.
  select
    al.created_at,
    al.action,
    case al.action
      when 'proposal.drafted'         then 'Quotation drafted'
      when 'proposal.pending_approval' then 'Quotation submitted for approval'
      when 'proposal.approved'        then 'Quotation approved'
      when 'proposal.sent'            then 'Quotation sent'
      when 'proposal.accepted'        then 'Quotation accepted'
      when 'proposal.rejected'        then 'Quotation rejected'
      when 'proposal.repriced'        then 'Quotation repriced'
      else 'Quotation updated'
    end,
    al.actor_type,
    al.actor_id,
    'proposal'::text,
    al.subject_id
    from audit.audit_log al
   where al.subject_type = 'proposal'
     and al.subject_id in (
       select p.id
         from sales.proposals p
         join sales.opportunities o on o.id = p.opportunity_id
        where o.lead_id = p_lead_id
     )

  union all

  -- A named approval decided against this lead's own quotation — a discount,
  -- a no-advance exception (G-311), or any other payload.kind an approval
  -- policy names. Deliberately narrower than every proposal approval: the
  -- plain approve/reject is already the row above, and this exists for the
  -- rows that carry a *kind* worth calling out on its own.
  select
    al.created_at,
    'approval.' || (ar.payload->>'kind'),
    initcap(replace(ar.payload->>'kind', '_', ' ')) || ' ' ||
      case al.action when 'approval.approved' then 'approved' else 'rejected' end,
    al.actor_type,
    al.actor_id,
    'approval_request'::text,
    al.subject_id
    from audit.audit_log al
    join approvals.approval_requests ar on ar.id = al.subject_id
   where al.subject_type = 'approval_request'
     and al.action in ('approval.approved', 'approval.rejected')
     and ar.payload ? 'kind'
     and ar.subject_type = 'proposal'
     and ar.subject_id in (
       select p.id
         from sales.proposals p
         join sales.opportunities o on o.id = p.opportunity_id
        where o.lead_id = p_lead_id
     )

  order by 1 desc
$$;

comment on function crm.lead_timeline(uuid) is
  'Every recorded event for a lead — activities, objections, quotation status changes, and named approval decisions on its quotations — merged into one ordered feed. SECURITY INVOKER: adds no reach beyond what lead_activities, objections and audit_log RLS already admit, so the proposal/approval rows are silently absent for a caller who is not owner or ops_admin. Deliberately excludes invoice and payment events, which are client_account_id-scoped and a lead has none until conversion.';

revoke all on function crm.lead_timeline(uuid) from public, anon;
grant execute on function crm.lead_timeline(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
