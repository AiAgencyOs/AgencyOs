-- ═══════════════════════════════════════════════════════════════════════════
-- Seven kinds that were not notes.
--
-- Gap G-126, raised while building G-010 and deliberately left then.
--
-- `audit.record_row_change` named every `crm.lead_activities` row
-- `lead.note_added` whatever its kind, so an assignment, a logged call, an
-- inbound message and an agent run were all filed as notes -- in
-- `audit.audit_log`, the record that exists to be trusted. G-010 fixed it for
-- the six kinds it added and left the seven that came before, because
-- correcting those changes what the log says about behaviour nobody was
-- touching, and that deserved its own change rather than riding along with a
-- feature.
--
-- This is that change.
--
-- ── one name is not the obvious one ──────────────────────────────────────
--
-- `status_change` becomes `lead.status_change_logged` rather than
-- `lead.status_changed`. The `leads` branch already produces
-- `lead.status_changed` for the lead's own status moving, and two different
-- events sharing one action name would be a worse defect than the one being
-- fixed: a reader filtering the log could no longer tell which happened.
--
-- ── the fallback is removed, deliberately ────────────────────────────────
--
-- The `kind` CHECK admits thirteen values and all thirteen are now named. A
-- fourteenth arriving without an action here raises, rather than being filed
-- as a note -- which is exactly how the first seven came to be wrong. The
-- alternative is a default that quietly absorbs every future mistake.
--
-- ── regenerated from the live definition, not retyped ────────────────────
--
-- The function body below is `20260814120000`'s verbatim, with one branch
-- changed. An earlier change in this repository regenerated this same function
-- from an older copy and silently dropped the `proposals` branch, which would
-- have made every proposal write raise. The diff was checked before this was
-- committed.
-- ═══════════════════════════════════════════════════════════════════════════

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
          -- G-126. The seven the timeline shipped with, each recorded as what
          -- it is. Until now every one of them was filed as `lead.note_added`,
          -- so an assignment, a logged call, an inbound message and an agent
          -- run all read as notes -- in audit.audit_log, the record that
          -- exists to be trusted.
          --
          -- `status_change` becomes `lead.status_change_logged` rather than
          -- `lead.status_changed`, which the `leads` branch already produces
          -- for the lead's own status. Two different events sharing one action
          -- name would be a worse defect than the one being fixed.
          when 'note'          then 'lead.note_added'
          when 'status_change' then 'lead.status_change_logged'
          when 'message_in'    then 'lead.message_in'
          when 'message_out'   then 'lead.message_out'
          when 'call'          then 'lead.call_logged'
          when 'agent_run'     then 'lead.agent_run_logged'
          when 'assignment'    then 'lead.assigned'
          -- No fallback. The kind CHECK admits thirteen values and all
          -- thirteen are named above, so a fourteenth arriving without an
          -- action here raises rather than being filed as a note - which is
          -- exactly how the first seven came to be wrong.
          else null
        end;

      if v_action is null then
        raise exception 'audit.record_row_change: no action for lead_activities.kind %', new.kind;
      end if;

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
