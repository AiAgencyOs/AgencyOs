-- ═══════════════════════════════════════════════════════════════════════════
-- A deal that is handed off — PH1-CLS-002
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CRM Doc 09 §33 ends with one sentence that this migration exists to honour:
--
--   "Handoff completion should be a real workflow event, not simply a note."
--
-- Master Development Plan V3 §13.4 lists what the WON packet carries — the
-- lead and client, the exact approved requirement version, the exact accepted
-- quotation version, the approval that authorized it, the acceptance with its
-- actor and moment, the payment/exception reference, the workflow trace, and
-- the client's context — and says the packet is READY while Phase 2 is NOT
-- activated. Coordination Agent §16 says the same: "record real handoff
-- event; preserve sales history."
--
-- ── what already existed, and what did not ────────────────────────────────
--
-- Every FACT in the packet is already a row. G-017 made conversion carry the
-- accepted proposal onto the project; G-230 made a won deal always have one;
-- acceptance stores who and when; the approval stores who decided; the lead
-- knows its contact, the contact its language, the thread its summary. The
-- packet is a PROJECTION over rows that exist.
--
-- What did not exist was the handoff. `opportunity.won` is an AUDIT action
-- and nothing more: no outbox event, no `core.event_types` row, nothing to
-- subscribe to. `convertToProject` writes a client, a project, a checklist
-- and a lead status, one call after another, and emits nothing. A project
-- appearing is the note; this is the event.
--
-- ── why ai.handoffs, and why nothing consumes it ───────────────────────────
--
-- `ai.handoffs` is the envelope this repository already has for work passed
-- between agents (ADM-83): references rather than copied prose, a status
-- machine that begins at `queued`, an allowed-target registry that already
-- permits `sales → project_manager`, and a correlation chain. A WON handoff
-- IS Sales handing to the Project Manager. Inventing a second envelope for it
-- would be a second thing to keep honest.
--
-- Both agents are disabled (BLK-002), and the row will sit at `queued` with no
-- receiver. That is not a defect; it is §13.4 field 8 exactly: "structured
-- handoff packet ready; Phase 2 not activated." The `opportunity.handed_off`
-- event is declared and emitted with NO subscriber for the same reason — and
-- this is deliberately the opposite call from G-227, where `meeting.booked`
-- was NOT declared because no source named it. Here the source names it.
--
-- ── at the moment of the win, not at the click after it ───────────────────
--
-- WON and conversion are two separate human acts: `setOpportunityStage` moves
-- the stage; `convertToProject` is a later, optional button — hours later, or
-- never. §13.4 says the packet is READY at the win. So the row is written by
-- an AFTER trigger on the transition itself, with no project yet, and
-- conversion BINDS its project to that row (`project_bound`). A failure to
-- record the handoff fails the close — the same fail-closed choice the gate
-- makes, because a win nobody can hand off is a win the system has not
-- finished recording.
--
-- ── ADM-72: absence is visible, never filled in ───────────────────────────
--
-- An Admin may create a project with no accepted quotation, and "the absence
-- must remain visible and auditable; do not fabricate." A won deal has one
-- (G-230), but a proposal may carry no requirement version, a lead may have no
-- contact, a thread may have no summary. Each absence goes into `unresolved`
-- by name. The packet says what it does not know rather than pretending.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the event, declared ───────────────────────────────────────────────────
--
-- `core.emit_event` refuses an undeclared type (Doc 23 §5), so the row must
-- exist before the first emit. `canonical` is null: Doc 23 §7 names no
-- canonical event for this moment, the same honest null as `proposal.sent`.
insert into core.event_types (type, description, canonical) values
  ('opportunity.handed_off',
   'A won deal''s structured handoff packet was recorded for Phase 2 (Doc 09 §33, Master Plan V3 §13.4). Emitted with no subscriber while Phase 2 is not activated.',
   null)
on conflict (type) do nothing;

-- ── one WON handoff per deal, at the row ──────────────────────────────────
create unique index if not exists handoffs_won_handoff_key
  on ai.handoffs (organization_id, subject_id)
  where subject_type = 'opportunity' and from_agent = 'sales' and to_agent = 'project_manager';

comment on index ai.handoffs_won_handoff_key is
  'PH1-CLS-002. A deal is handed off once. sales.record_won_handoff answers already_recorded under the opportunity lock; this holds the same rule against a direct write and a lost race.';


-- ═══════════════════════════════════════════════════════════════════════════
-- sales.record_won_handoff — the event
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sales.record_won_handoff(
  p_opportunity_id uuid,
  p_project_id     uuid default null
)
returns table (
  -- 'recorded'         the packet was written (the trigger, at the win)
  -- 'project_bound'    an existing packet now names this project (conversion)
  -- 'already_recorded' the packet exists; nothing to add
  -- 'not_found' | 'not_won' | 'project_mismatch' | 'forbidden'
  outcome    text,
  handoff_id uuid
)
language plpgsql
volatile
-- DEFINER, with the tenancy guard explicit: this writes ai.handoffs, and the
-- lesson of the review round is that an invoker function writing a table it
-- has no policy for is unreachable by everyone. The org is derived from the
-- locked opportunity row, never from the caller's claim; the service role is
-- the worker and is trusted, per the repository's idiom.
security definer
set search_path = ''
as $$
declare
  v_actor        uuid := (select auth.uid());
  v_opp          sales.opportunities;
  v_project      projects.projects;
  v_lead         crm.leads;
  v_contact      crm.contacts;
  v_proposal     sales.proposals;
  v_approval     approvals.approval_requests;
  v_requirement  crm.requirement_versions;
  v_conversation uuid;
  v_summary_seq  int;
  v_consent      text;
  v_trust        uuid[];
  v_switch       text;
  v_verdict      text;
  v_existing     ai.handoffs;
  v_prev         projects.projects;
  v_rebound      boolean := false;
  v_id           uuid;
  -- A fresh chain. A human won this deal; there is no agent run to inherit a
  -- correlation from, and the handoff is the root of whatever Phase 2 does.
  v_correlation  uuid := gen_random_uuid();
  v_unresolved   jsonb := '[]'::jsonb;
  v_payment_evidence jsonb;
begin
  select o.* into v_opp
    from sales.opportunities o
   where o.id = p_opportunity_id
   for update;

  if v_opp.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and v_opp.organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  -- A DEFINER door is open to whoever may call it, and this one is granted to
  -- authenticated. The tables it writes admit far fewer: handoffs_write is
  -- admin-only, outbox_insert owner/ops_admin-only. A portal client of the
  -- same organization must not be able to write a handoff, emit the event and
  -- sign the audit row by calling this directly — review found it could.
  -- Staff may: the trigger runs as whoever moved the stage, which any member
  -- with lead.write can do, and conversion is the same people.
  if v_actor is not null and not (select core.is_internal()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_opp.stage <> 'won' then
    return query select 'not_won'::text, null::uuid; return;
  end if;

  -- A project, when one is named, must be THIS deal's, in this tenant, and
  -- alive. A handoff pointing at somebody else's project is worse than none.
  -- The trigger names none: at the win there is no project yet.
  if p_project_id is not null then
    select p.* into v_project
      from projects.projects p
     where p.id = p_project_id
       and p.deleted_at is null;

    if v_project.id is null
       or v_project.opportunity_id is distinct from v_opp.id
       or v_project.organization_id <> v_opp.organization_id then
      return query select 'project_mismatch'::text, null::uuid; return;
    end if;
  end if;

  -- Idempotent, under the lock. The trigger wrote this row at the win; a
  -- conversion binds its project to it; a second click, or a re-run that
  -- repairs a half-finished one, finds it and stops.
  select h.* into v_existing
    from ai.handoffs h
   where h.organization_id = v_opp.organization_id
     and h.subject_type = 'opportunity'
     and h.subject_id   = v_opp.id
     and h.from_agent   = 'sales'
     and h.to_agent     = 'project_manager';

  if v_existing.id is not null then
    if v_project.id is null or v_existing.project_id = v_project.id then
      return query select 'already_recorded'::text, v_existing.id; return;
    end if;
    if v_existing.project_id is not null then
      select p.* into v_prev from projects.projects p where p.id = v_existing.project_id;
      if v_prev.id is not null and v_prev.deleted_at is null then
        -- Bound to a LIVE project of this deal already. Two projects from one
        -- win is not a handoff this row can describe; refused by name (and
        -- projects_opportunity_key refuses the second project at the row).
        return query select 'project_mismatch'::text, v_existing.id; return;
      end if;
      -- Bound to a project raised by mistake and soft-deleted. The projects
      -- model allows a fresh one (projects_opportunity_key is partial on
      -- deleted_at); review found this row then refusing the fresh one forever
      -- and the projection presenting the dead one. The packet follows the
      -- live project — and says so.
      v_rebound := true;
    end if;
    -- Bind. The packet was assembled at the win from the latest accepted
    -- version — the selector conversion uses too — so a project raised from
    -- some other version is a fact worth naming, not a reason to refuse the
    -- conversion (ADM-72: visible, never fabricated, never silently fixed).
    v_unresolved := v_existing.unresolved - 'project_proposal_differs';
    if v_project.proposal_id is not null
       and (v_existing.artifacts->0->>'proposal_id') is distinct from v_project.proposal_id::text then
      v_unresolved := v_unresolved || '"project_proposal_differs"'::jsonb;
    end if;
    if v_rebound then
      v_unresolved := v_unresolved || '"project_rebound"'::jsonb;
    end if;
    update ai.handoffs h
       set project_id = v_project.id,
           context    = h.context || jsonb_strip_nulls(jsonb_build_object(
                          'project_id', v_project.id,
                          'client_account_id', coalesce(v_project.client_account_id, v_opp.client_account_id),
                          'previous_project_id', case when v_rebound then v_existing.project_id end)),
           unresolved = v_unresolved
     where h.id = v_existing.id;
    perform core.record_audit(
      v_opp.organization_id, 'opportunity.handoff_bound', 'opportunity', v_opp.id,
      null,
      jsonb_strip_nulls(jsonb_build_object('handoff_id', v_existing.id, 'project_id', v_project.id,
                                           'previous_project_id', case when v_rebound then v_existing.project_id end)),
      v_existing.correlation_id
    );
    return query select 'project_bound'::text, v_existing.id; return;
  end if;

  -- ── the facts, each read from the table that owns it ──────────────────

  -- §13.4 Commercial: the exact accepted version. `accepted` is terminal, so
  -- a re-quoted, re-accepted deal has more than one, and the synthesis found
  -- two selectors in this repository disagreeing about which (the gate:
  -- decided_at desc; conversion: version desc). The gate now uses conversion's.
  -- At the win — the trigger's call — there is no project, and the latest
  -- accepted version is the answer, by the same selector; a project named on
  -- the call (a repair run after a lost trigger) supplies its own.
  if v_project.proposal_id is not null then
    select p.* into v_proposal
      from sales.proposals p
     where p.id = v_project.proposal_id
       and p.opportunity_id = v_opp.id
       and p.status = 'accepted';
  end if;
  if v_proposal.id is null then
    select p.* into v_proposal
      from sales.proposals p
     where p.opportunity_id = v_opp.id
       and p.status = 'accepted'
     order by p.version desc
     limit 1;
  end if;

  if v_proposal.id is not null then
    -- §13.4 Approval: the decision that authorized THIS version. A standalone
    -- quotation carries its approval id; a plan-set member does not — the set
    -- was approved once, on the recommended plan, and the id sits on the set
    -- (sync_plan_set_decision). The synthesis caught the first draft listing
    -- 'approval' as absent for every 3-plan deal, which was a false absence.
    if v_proposal.approval_request_id is not null then
      select a.* into v_approval
        from approvals.approval_requests a
       where a.id = v_proposal.approval_request_id;
    elsif v_proposal.plan_set_id is not null then
      select a.* into v_approval
        from sales.proposal_plan_sets ps
        join approvals.approval_requests a on a.id = ps.approval_request_id
       where ps.id = v_proposal.plan_set_id
         and ps.organization_id = v_opp.organization_id;
    end if;
    -- §13.4 Requirements: the exact version this quotation was priced against.
    if v_proposal.requirement_version_id is not null then
      select r.* into v_requirement
        from crm.requirement_versions r
       where r.id = v_proposal.requirement_version_id;
    end if;
  end if;

  -- §13.4 Lead/client, and Doc 09 §33's context: who, in what language, with
  -- what standing consent, and which thread the summary belongs to.
  if v_opp.lead_id is not null then
    select l.* into v_lead from crm.leads l where l.id = v_opp.lead_id;
  end if;
  if v_lead.contact_id is not null then
    select c.* into v_contact from crm.contacts c where c.id = v_lead.contact_id;
  end if;
  if v_opp.lead_id is not null then
    select cv.id into v_conversation
      from crm.conversations cv
     where cv.lead_id = v_opp.lead_id
     order by cv.created_at desc
     limit 1;
  end if;
  if v_conversation is not null then
    select s.through_seq into v_summary_seq
      from crm.conversation_summaries s
     where s.conversation_id = v_conversation;
  end if;
  if v_contact.id is not null then
    select cc.status into v_consent
      from crm.communication_consent cc
     where cc.organization_id = v_opp.organization_id
       and cc.contact_id = v_contact.id
       and cc.channel = 'whatsapp';
  end if;
  -- Doc 09 §33: "trust concerns". The rows, not a paraphrase of them.
  if v_opp.lead_id is not null then
    select coalesce(array_agg(ob.id order by ob.created_at), '{}'::uuid[])
      into v_trust
      from sales.objections ob
     where ob.lead_id = v_opp.lead_id
       and ob.kind = 'trust';
  end if;

  -- §13.4 Payment/exception: the configured verification reference. What the
  -- gate says AT THIS MOMENT, and whether the switch that would demand
  -- payment evidence is on — so a reader knows which rule the deal closed
  -- under, not merely that it closed.
  select o.settings->>'won_requires_payment_evidence' into v_switch
    from core.organizations o
   where o.id = v_opp.organization_id;
  v_verdict := sales.won_gate_verdict(v_opp.id);

  -- When the switch is on and the gate passed, WHAT passed it. The synthesis
  -- found the first draft recording the rule the deal closed under and not the
  -- evidence — and §13.4 asks for "the configured verification reference".
  -- Same two forms the gate itself accepts, read the same way; the exception
  -- first because it names this exact version.
  if v_switch = 'on' and v_verdict is null and v_proposal.id is not null then
    select jsonb_build_object('kind', 'payment_exception', 'approval_id', a.id, 'decided_at', a.decided_at)
      into v_payment_evidence
      from approvals.approval_requests a
     where a.organization_id = v_opp.organization_id
       and a.subject_type = 'proposal' and a.subject_id = v_proposal.id
       and a.state = 'approved'
       and coalesce(a.payload->>'kind', '') = 'payment_exception'
     order by a.decided_at desc
     limit 1;
    -- The client the GATE keys on: the deal's own account, which a returning
    -- client has at the win; the project's is null on the trigger path.
    if v_payment_evidence is null and coalesce(v_project.client_account_id, v_opp.client_account_id) is not null then
      select jsonb_build_object('kind', 'captured_payment', 'payment_id', pay.id, 'invoice_id', inv.id,
                                'amount_minor', pay.amount_minor, 'captured_at', pay.captured_at)
        into v_payment_evidence
        from finance.payments pay
        join finance.invoices inv on inv.id = pay.invoice_id
       where inv.organization_id = v_opp.organization_id
         and inv.client_account_id = coalesce(v_project.client_account_id, v_opp.client_account_id)
         and pay.status = 'captured'
       order by pay.captured_at desc nulls last
       limit 1;
    end if;
  end if;

  -- ── what is ABSENT, by name (ADM-72) ──────────────────────────────────
  if v_proposal.id is null then v_unresolved := v_unresolved || '"accepted_quotation"'::jsonb; end if;
  if v_requirement.id is null then v_unresolved := v_unresolved || '"requirement_version"'::jsonb; end if;
  -- A version that exists but was never accepted is carried by reference AND
  -- named: draft_proposal stores p_requirement_version_id verbatim and checks
  -- nothing about it, so "exact APPROVED requirement version" is not a
  -- guarantee this row can give — only a fact it can report.
  if v_requirement.id is not null and v_requirement.status <> 'accepted' then
    v_unresolved := v_unresolved || '"requirement_version_not_accepted"'::jsonb;
  end if;
  if v_approval.id is null then v_unresolved := v_unresolved || '"approval"'::jsonb; end if;
  if v_contact.id is null then v_unresolved := v_unresolved || '"contact"'::jsonb; end if;
  -- §13.4 Acceptance: "authorized actor". record_proposal_response takes the
  -- contact as optional, so an acceptance can exist with nobody named on it.
  -- Carried as it is, and named as weak.
  if v_proposal.id is not null and v_proposal.responded_by_contact_id is null then
    v_unresolved := v_unresolved || '"acceptance_actor"'::jsonb;
  end if;
  if v_summary_seq is null then v_unresolved := v_unresolved || '"conversation_summary"'::jsonb; end if;
  if v_switch = 'on' and v_verdict is not null then v_unresolved := v_unresolved || '"payment_evidence"'::jsonb; end if;

  -- ── the handoff ───────────────────────────────────────────────────────
  --
  -- References, never copied prose — the table's own rule. A receiver reads
  -- the current facts through its own RLS rather than a sender's snapshot.
  insert into ai.handoffs (
    organization_id, correlation_id, from_agent, to_agent, status,
    project_id, subject_type, subject_id, objective, requested_action,
    context, requirements, artifacts, decisions, constraints, state, unresolved
  ) values (
    v_opp.organization_id, v_correlation, 'sales', 'project_manager', 'queued',
    v_project.id, 'opportunity', v_opp.id,
    'Onboard the won deal: ' || v_opp.name,
    'onboard',
    jsonb_strip_nulls(jsonb_build_object(
      'opportunity_id',    v_opp.id,
      'lead_id',           v_opp.lead_id,
      'contact_id',        v_contact.id,
      'client_account_id', coalesce(v_project.client_account_id, v_opp.client_account_id),
      'project_id',        v_project.id,
      'owner_id',          v_opp.owner_id,
      'language',          v_contact.preferred_language,
      'conversation_id',   v_conversation,
      'summary_through_seq', v_summary_seq,
      'whatsapp_consent',  v_consent
    )),
    case when v_requirement.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'requirement_version_id', v_requirement.id,
      'status',                 v_requirement.status
    )) end,
    case when v_proposal.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'kind',        'proposal',
      'proposal_id', v_proposal.id,
      'version',     v_proposal.version,
      'total_minor', v_proposal.total_minor,
      'currency',    v_proposal.currency,
      'sent_at',     v_proposal.sent_at,
      'sent_message_ref', v_proposal.sent_message_ref
    )) end,
    -- coalesce: jsonb_agg over zero rows is NULL, and the column is NOT NULL.
    -- A deal with neither an approval nor a proposal (an ADM-72 project) is
    -- exactly the row that would otherwise fail here, which is exactly the row
    -- whose absences the packet exists to record.
    coalesce((select jsonb_agg(d) from (
      select jsonb_strip_nulls(jsonb_build_object(
        'kind', 'approval', 'approval_id', v_approval.id, 'state', v_approval.state,
        'decided_at', v_approval.decided_at, 'decided_by', v_approval.decided_by,
        'approved_by_name', v_proposal.approved_by_name, 'approved_by_role', v_proposal.approved_by_role
      )) as d where v_approval.id is not null
      union all
      select jsonb_strip_nulls(jsonb_build_object(
        'kind', 'acceptance', 'proposal_id', v_proposal.id,
        'decided_at', v_proposal.decided_at, 'responded_by_contact_id', v_proposal.responded_by_contact_id,
        'has_note', v_proposal.response_note is not null
      )) where v_proposal.id is not null
    ) x), '[]'::jsonb),
    jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'kind', 'payment_gate',
        'requires_payment_evidence', coalesce(v_switch, 'off'),
        'verdict_at_handoff', v_verdict,
        'evidence', v_payment_evidence
      )),
      jsonb_build_object('kind', 'trust_concerns', 'objection_ids', to_jsonb(coalesce(v_trust, '{}'::uuid[])))
    ),
    jsonb_build_object('won_at', v_opp.closed_at, 'recorded_at', clock_timestamp()),
    v_unresolved
  )
  returning id into v_id;

  -- Doc 09 §33: a real workflow event. Declared above; no subscriber while
  -- Phase 2 is not activated, and that is the design rather than an omission.
  perform core.emit_event(
    v_opp.organization_id, 'opportunity.handed_off', 'opportunity', v_opp.id,
    jsonb_strip_nulls(jsonb_build_object(
      'handoff_id', v_id, 'project_id', v_project.id, 'proposal_id', v_proposal.id,
      'requirement_version_id', v_requirement.id, 'unresolved', v_unresolved
    )),
    v_correlation
  );

  -- §13.4 field 9: the audit row joins the trail the handoff row and the outbox
  -- event already share, so the three are one story under one correlation id.
  perform core.record_audit(
    v_opp.organization_id, 'opportunity.handed_off', 'opportunity', v_opp.id,
    null,
    jsonb_build_object('handoff_id', v_id, 'project_id', v_project.id, 'unresolved', v_unresolved),
    v_correlation
  );

  return query select 'recorded'::text, v_id;

exception
  -- handoffs_won_handoff_key, when two conversions of one deal pass the
  -- pre-check at once. The answer is the row the other one wrote.
  when unique_violation then
    select h.* into v_existing
      from ai.handoffs h
     where h.organization_id = v_opp.organization_id
       and h.subject_type = 'opportunity' and h.subject_id = v_opp.id
       and h.from_agent = 'sales' and h.to_agent = 'project_manager';
    return query select 'already_recorded'::text, v_existing.id;
end;
$$;

comment on function sales.record_won_handoff(uuid, uuid) is
  'PH1-CLS-002. Records the structured handoff of a won deal to Phase 2 as an ai.handoffs row (sales -> project_manager, born queued, consumed by nobody while Phase 2 is not activated) and emits opportunity.handed_off - Doc 09 section 33: a real workflow event, not simply a note. The packet is references over recorded facts (Master Plan V3 section 13.4): the accepted proposal and its version, the approval that authorized it, the acceptance, the requirement version it was priced against, the payment-gate reading at this moment, the contact and language, the thread and its summary position, standing consent, trust objections. What is ABSENT is listed in unresolved by name (ADM-72). Written by opportunities_won_handoff at the moment of the win with no project; conversion binds its project to the row (project_bound). Idempotent per deal under the opportunity lock and at the row.';

revoke all on function sales.record_won_handoff(uuid, uuid) from public, anon;
grant execute on function sales.record_won_handoff(uuid, uuid) to authenticated, service_role;


-- ── at the win ────────────────────────────────────────────────────────────
--
-- INVOKER: the function it calls carries its own guard and its own privilege.
create or replace function sales.hand_off_on_a_win()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_outcome text;
begin
  -- The transition only, as the gate and remember_the_client_on_a_win: a deal
  -- already won is not handed off again, and a reopened deal won a second time
  -- finds its first packet (already_recorded) rather than minting another.
  if new.stage = 'won' and old.stage is distinct from 'won' then
    select h.outcome into v_outcome from sales.record_won_handoff(new.id, null) h;
    -- The function answers rather than raises. Here, anything but the two
    -- answers a transition can produce is an error, and an error fails the
    -- close — "a refusal fails the close" is a promise only this line keeps.
    if v_outcome is null or v_outcome not in ('recorded', 'already_recorded') then
      raise exception 'won_handoff: %', coalesce(v_outcome, 'no answer')
        using errcode = 'check_violation',
              hint = 'The WON handoff packet could not be recorded; see sales.record_won_handoff.';
    end if;
  end if;
  return new;
end;
$$;

comment on function sales.hand_off_on_a_win() is
  'PH1-CLS-002. Records the WON handoff packet at the transition into won, so §13.4 field 8 - packet READY - is true at the moment of the win rather than at a later, optional conversion click. A refusal or error here fails the close.';

drop trigger if exists opportunities_won_handoff on sales.opportunities;
create trigger opportunities_won_handoff
  after update of stage on sales.opportunities
  for each row
  execute function sales.hand_off_on_a_win();

notify pgrst, 'reload schema';


-- ═══════════════════════════════════════════════════════════════════════════
-- sales.won_handoff_packet — the projection, for whoever needs to read it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The handoff row holds references. This resolves the ones a reader wants
-- beside each other — the packet as §13.4 lists it — without the reader
-- learning six tables. INVOKER: a read, under the reader's own RLS, which is
-- what "references, not a snapshot" is for.

create or replace function sales.won_handoff_packet(p_opportunity_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'handoff_id',    h.id,
    'status',        h.status,
    'recorded_at',   h.created_at,
    'correlation_id', h.correlation_id,
    'opportunity',   jsonb_build_object('id', o.id, 'name', o.name, 'stage', o.stage, 'won_at', o.closed_at, 'owner_id', o.owner_id),
    -- No project → no key. jsonb_build_object over an all-null row is an object
    -- of nulls, and jsonb_strip_nulls leaves `{}` behind — a half-answer the
    -- first CI run of db:verify:handoff caught ("project": {} beside
    -- "project_deleted": true).
    'project',       case when p.id is not null then jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status, 'budget_minor', p.budget_minor, 'currency', p.currency) end,
    -- A bound project that was soft-deleted is not presented as the project;
    -- it is named as gone until conversion rebinds a live one.
    'project_deleted', case when h.project_id is not null and p.id is null then true end,
    'client',        jsonb_build_object('client_account_id', p.client_account_id, 'lead_id', o.lead_id,
                                        'contact_id', h.context->>'contact_id', 'language', h.context->>'language',
                                        'whatsapp_consent', h.context->>'whatsapp_consent'),
    'requirements',  h.requirements,
    'commercial',    h.artifacts,
    'decisions',     h.decisions,
    'constraints',   h.constraints,
    'context',       jsonb_build_object('conversation_id', h.context->>'conversation_id',
                                        -- `->`, not `->>`: the position is a number and stays one.
                                        'summary_through_seq', h.context->'summary_through_seq'),
    'unresolved',    h.unresolved
  ))
    from ai.handoffs h
    join sales.opportunities o on o.id = h.subject_id
    left join projects.projects p on p.id = h.project_id and p.deleted_at is null
   where h.subject_type = 'opportunity'
     and h.subject_id   = p_opportunity_id
     and h.from_agent   = 'sales'
     and h.to_agent     = 'project_manager'
   limit 1
$$;

comment on function sales.won_handoff_packet(uuid) is
  'PH1-CLS-002. The WON packet as Master Plan V3 section 13.4 lists it, resolved from the handoff row and the rows it references. Null when the deal has not been handed off. A read under the caller''s own RLS.';

revoke all on function sales.won_handoff_packet(uuid) from public, anon;
grant execute on function sales.won_handoff_packet(uuid) to authenticated, service_role;
