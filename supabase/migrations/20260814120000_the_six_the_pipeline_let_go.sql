-- ═══════════════════════════════════════════════════════════════════════════
-- The six the pipeline let go.
--
-- Gap G-010, decision ADM-10, as written at docs/business-os/02-business-rules
-- §7: *"The pipeline stays four stages: discovery → proposal → negotiation →
-- won, with lost off any of them. Everything else the agency actually does —
-- contacted, sample sent, demo sent, offer sent, follow-up, advance requested
-- — is recorded as a **timestamped activity on the lead**, not as a pipeline
-- stage. A deal is in one stage; a lead has a history."*
--
-- The 2026-08-14 audit of G-010 found the decision half-honoured. The stage
-- half is exact: four stages plus `lost` as the off-ramp, and the enum matches.
-- The activity half was never built. `crm.lead_activities.kind` admits seven
-- values and not one of the six is among them, and four of the six —
-- sample_sent, demo_sent, offer_sent, advance_requested — appear nowhere in
-- the repository at all.
--
-- **The six states the decision moved out of the pipeline were never given the
-- home it moved them to.** They were not recorded somewhere worse; they were
-- not recordable.
--
-- ── why new kinds rather than metadata ────────────────────────────────────
--
-- G-016 set the precedent for the other reading: a returning client is filed
-- as `message_in` with `metadata->>'returning'`, reusing a kind rather than
-- inventing one. That was right there and is wrong here, and the difference is
-- worth stating because it decides every future case.
--
-- A returning client's message **is** a message_in. The metadata says
-- something *about* an event the vocabulary already names. None of these six
-- is like that. `advance_requested` is not a message — the agency may ask for
-- an advance in a call, in a group, or in a quotation, and the asking is the
-- event whatever carried it. Filing it as `message_out` would record the
-- carrier and lose the act.
--
-- The second reason is queryability. §7's whole point is that a lead has a
-- history somebody reads. A CHECK-constrained kind is enumerable, indexable
-- and visible in the schema; `metadata->>'type' = 'demo_sent'` is a string
-- convention that nothing enforces and a typo silently breaks.
--
-- The list is closed at six. ADM-10 names six; this adds six; a seventh needs
-- a decision, not a migration.
--
-- ── what this deliberately does not do ────────────────────────────────────
--
-- **It does not touch the seven existing kinds.** They keep their behaviour
-- exactly, including the audit action below.
--
-- **It does not move any stage.** `sales.opportunities.stage` is untouched;
-- ADM-10's stage half was already correct and G-010's audit proved it.
--
-- **It backfills nothing.** No historic lead gains an activity it never had —
-- the ADM-76 principle: a record invented now is indistinguishable from one
-- made at the time.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.lead_activities drop constraint if exists lead_activities_kind_check;

alter table crm.lead_activities add constraint lead_activities_kind_check
  check (kind in (
    -- The seven this table shipped with, unchanged.
    'note', 'status_change', 'message_in', 'message_out',
    'call', 'agent_run', 'assignment',
    -- The six ADM-10 §7 moved out of the pipeline, in the order §7 lists them.
    'contacted', 'sample_sent', 'demo_sent',
    'offer_sent', 'follow_up', 'advance_requested'
  ));

comment on column crm.lead_activities.kind is
  'What happened on this lead. The seven the timeline shipped with, plus the six ADM-10 section 7 moved out of the pipeline and into the history: contacted, sample_sent, demo_sent, offer_sent, follow_up, advance_requested. Closed at thirteen - a fourteenth needs a decision, not a migration.';

-- ═══════════════════════════════════════════════════════════════════════════
-- The audit log stops calling them notes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `audit.record_row_change` names every `lead_activities` row `lead.note_added`
-- whatever its kind, so an assignment is filed in the audit log as a note. That
-- is the defect class G-101 and the ADM-74 announcement belong to — the system
-- telling a reader something it did not do — and here it is telling the audit
-- log, which is the record that exists to be trusted.
--
-- **The existing seven are left exactly as they are.** Correcting them changes
-- what the audit log says about behaviour nobody is changing today, and that
-- deserves its own change and its own review rather than riding along with a
-- feature. It is recorded as its own gap.
--
-- What this refuses to do is *add* to the problem. Six new kinds filed as
-- `lead.note_added` would be six new false statements in the audit log,
-- written knowingly, in the same change that exists to make the six honest.

create or replace function audit.record_row_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_action  text;
  v_subject text;
  v_before  jsonb;
  v_after   jsonb;
  v_org     uuid;
begin
  v_after := to_jsonb(new);
  v_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;

  v_org := (v_after->>'organization_id')::uuid;

  if v_org is null then
    raise exception 'audit.record_row_change: % has no organization_id', tg_table_name;
  end if;

  case tg_table_name
    when 'leads' then
      v_subject := 'lead';
      v_action :=
        case
          when tg_op = 'INSERT' then 'lead.created'
          when new.status = 'converted' and old.status is distinct from 'converted' then 'lead.converted'
          when new.status is distinct from old.status then 'lead.status_changed'
          when new.qualification is distinct from old.qualification then 'lead.qualification_updated'
          when new.next_follow_up_at is distinct from old.next_follow_up_at then 'lead.follow_up_scheduled'
          else 'lead.updated'
        end;

    when 'lead_activities' then
      v_subject := 'lead';
      v_action :=
        -- G-010. The six kinds ADM-10 §7 names are recorded as what they are.
        -- The seven that came before keep `lead.note_added`, which is wrong
        -- for some of them and is not this change's to fix — it is recorded
        -- as its own gap. What this refuses to do is *add* to the problem:
        -- six new kinds filed as notes would be six new false statements in
        -- the audit log, written knowingly, in the change that exists to make
        -- the six honest.
        case new.kind
          when 'contacted'         then 'lead.contacted'
          when 'sample_sent'       then 'lead.sample_sent'
          when 'demo_sent'         then 'lead.demo_sent'
          when 'offer_sent'        then 'lead.offer_sent'
          when 'follow_up'         then 'lead.follow_up_recorded'
          when 'advance_requested' then 'lead.advance_requested'
          else 'lead.note_added'
        end;

    when 'requirement_versions' then
      v_subject := 'requirement_version';
      v_action :=
        case
          when tg_op = 'INSERT' then 'requirement.proposed'
          when new.status is distinct from old.status then 'requirement.' || new.status
          else 'requirement.updated'
        end;

    when 'client_accounts' then
      v_subject := 'client_account';
      v_action := case when tg_op = 'INSERT' then 'client_account.created' else 'client_account.updated' end;

    when 'opportunities' then
      v_subject := 'opportunity';
      v_action :=
        case
          when tg_op = 'INSERT' then 'opportunity.created'
          when new.stage = 'won' and old.stage is distinct from 'won' then 'opportunity.won'
          when new.stage is distinct from old.stage then 'opportunity.stage_changed'
          when new.value_minor is distinct from old.value_minor then 'opportunity.value_changed'
          else 'opportunity.updated'
        end;

    -- G-011. The status vocabulary is already the business vocabulary — the
    -- states a quote moves through are exactly the events worth reading in a
    -- log — so the derivation is the status itself. `proposal.repriced` is
    -- named separately because a discount or tax change on a draft is the one
    -- material money edit that leaves the status alone, and it is the edit
    -- Document 09 §17 gates approval on.
    when 'proposals' then
      v_subject := 'proposal';
      v_action :=
        case
          when tg_op = 'INSERT' then 'proposal.drafted'
          when new.status is distinct from old.status then 'proposal.' || new.status
          when new.total_minor is distinct from old.total_minor then 'proposal.repriced'
          else 'proposal.updated'
        end;

    when 'projects' then
      v_subject := 'project';
      v_action :=
        case
          when tg_op = 'INSERT' then 'project.created'
          when new.status is distinct from old.status then 'project.status_changed'
          else 'project.updated'
        end;

    when 'defects' then
      v_subject := 'defect';
      v_action :=
        case
          when tg_op = 'INSERT' then 'defect.raised'
          when new.status is distinct from old.status then 'defect.' || new.status
          else 'defect.updated'
        end;

    else
      raise exception 'audit.record_row_change: no vocabulary for table %', tg_table_name;
  end case;

  if tg_op = 'UPDATE' and (v_before - 'updated_at') = (v_after - 'updated_at') then
    return null;
  end if;

  insert into audit.audit_log (
    organization_id, actor_type, actor_id, action, subject_type, subject_id, before, after
  )
  values (
    v_org,
    case when (select auth.uid()) is null then 'system' else 'user' end,
    (select auth.uid()),
    v_action,
    v_subject,
    (v_after->>'id')::uuid,
    v_before,
    v_after
  );

  return null;
end;
$$;

comment on function audit.record_row_change() is
  'Writes audit.audit_log from inside the transaction that changed the row (G-093, ADM-51). Since G-010 the six activity kinds ADM-10 section 7 names are audited as what they are rather than all as lead.note_added; the seven older kinds keep the generic action, which is wrong for some of them and is recorded as its own gap rather than changed here.';
