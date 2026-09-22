-- ═══════════════════════════════════════════════════════════════════════════
-- The gate, and the thing it gates.
--
-- `projects.deliverables` and `approvals.approval_requests` have never had
-- `audit.record_row_change()` attached — true since both tables were built,
-- confirmed by grep across every migration, not something this session's
-- Prototype (SCR-037) or Builds (SCR-043) screens introduced. It matters more
-- now that those screens make `addDeliverable`/`submitDeliverable` easier to
-- reach: the master prompt's own audit list names "design approved" and
-- "prototype approved" explicitly, and a deliverable's status IS that
-- decision (draft → in_review → approved/changes_requested → superseded).
-- The approval side carries `decided_at`/`decided_by`/`decision_note` on the
-- row itself, which is a real record but not the same searchable,
-- cross-entity log `audit.audit_log` and the /audit screen already read.
--
-- Base is the redefinition this function actually carries right now
-- (20260922120000, sixteen tables) — not the original — for the same reason
-- that migration's own header explains: `create or replace function` on the
-- wrong base silently deletes every branch added since.
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
        case new.kind
          when 'contacted'         then 'lead.contacted'
          when 'sample_sent'       then 'lead.sample_sent'
          when 'demo_sent'         then 'lead.demo_sent'
          when 'offer_sent'        then 'lead.offer_sent'
          when 'follow_up'         then 'lead.follow_up_recorded'
          when 'advance_requested' then 'lead.advance_requested'
          when 'note'          then 'lead.note_added'
          when 'status_change' then 'lead.status_change_logged'
          when 'message_in'    then 'lead.message_in'
          when 'message_out'   then 'lead.message_out'
          when 'call'          then 'lead.call_logged'
          when 'agent_run'     then 'lead.agent_run_logged'
          when 'assignment'    then 'lead.assigned'
          else null
        end;

      if v_action is null then
        raise exception 'audit.record_row_change: no action for lead_activities.kind %', new.kind;
      end if;

    when 'communication_consent' then
      v_subject := 'communication_consent';
      v_action  := 'consent.' || new.status;

    when 'onboarding_baseline' then
      v_subject := 'onboarding_baseline';
      v_action  :=
        case
          when tg_op = 'INSERT' then 'onboarding_baseline.added'
          when new.is_active is distinct from old.is_active
            then case when new.is_active then 'onboarding_baseline.restored'
                      else 'onboarding_baseline.retired' end
          else 'onboarding_baseline.updated'
        end;

    when 'follow_up_sequences' then
      v_subject := 'follow_up_sequence';
      v_action  :=
        case
          when tg_op = 'INSERT' then 'followup.sequence_started'
          when new.status is distinct from old.status
            then 'followup.sequence_' || new.status
          else 'followup.sequence_updated'
        end;

    when 'follow_up_sends' then
      v_subject := 'follow_up_send';
      v_action  :=
        case
          when tg_op = 'INSERT' then 'followup.attempt_claimed'
          else 'followup.attempt_' || new.outcome
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

    when 'project_files' then
      v_subject := 'project_file';
      v_action := case when tg_op = 'INSERT' then 'project_file.added' else 'project_file.updated' end;

    when 'repositories' then
      v_subject := 'repository';
      v_action := case when tg_op = 'INSERT' then 'repository.added' else 'repository.updated' end;

    -- ── new below ──────────────────────────────────────────────────────────

    -- A version's status IS the decision Doc 12/§20 asks to be visible:
    -- draft → in_review (sent to the client) → approved / changes_requested,
    -- or superseded by the next version. `kind` (design/prototype/build/
    -- document) rides along in `after` for the reader to filter on; it is
    -- not part of the action name, the same choice `defect.<status>` makes
    -- for severity rather than folding it into the vocabulary.
    when 'deliverables' then
      v_subject := 'deliverable';
      v_action :=
        case
          when tg_op = 'INSERT' then 'deliverable.added'
          when new.status is distinct from old.status then 'deliverable.' || new.status
          else 'deliverable.updated'
        end;

    -- The other half of the same decision: what was asked for, and what was
    -- answered. `state` is already the business vocabulary (pending →
    -- approved/rejected/changes_requested/expired/cancelled), so the
    -- derivation is the state itself, matching `proposals` above.
    when 'approval_requests' then
      v_subject := 'approval_request';
      v_action :=
        case
          when tg_op = 'INSERT' then 'approval.requested'
          when new.state is distinct from old.state then 'approval.' || new.state
          else 'approval.updated'
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
  'Writes audit.audit_log from inside the transaction that changed the row (G-093, ADM-51). Covers every path into the table, including PostgREST and psql. AFTER trigger returning null: it cannot alter the row it records. Extended 2026-09-22 to cover deliverables and approval_requests, carrying forward every branch the seven prior redefinitions added.';

drop trigger if exists audit_row_change on projects.deliverables;
create trigger audit_row_change after insert or update on projects.deliverables
  for each row execute function audit.record_row_change();

drop trigger if exists audit_row_change on approvals.approval_requests;
create trigger audit_row_change after insert or update on approvals.approval_requests
  for each row execute function audit.record_row_change();
