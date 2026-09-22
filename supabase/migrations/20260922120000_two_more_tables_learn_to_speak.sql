-- ═══════════════════════════════════════════════════════════════════════════
-- Two more tables learn to speak.
--
-- `audit.record_row_change()` (20260813120013, since redefined six more
-- times as tables were added to it) refuses any table given its trigger
-- without also being given a vocabulary — "a table was given this trigger
-- without being given a name... the alternative is a log full of rows nobody
-- can read." `projects.project_files` and `projects.repositories`
-- (20260922100000, 20260922110000) were added without either, so their rows
-- carry no history at all — the only two of the now fourteen tables in this
-- trigger's family with no `audit.audit_log` trail.
--
-- This redefinition carries every branch the previous six migrations added
-- (leads, lead_activities, requirement_versions, communication_consent,
-- onboarding_baseline, follow_up_sequences, follow_up_sends, client_accounts,
-- opportunities, proposals, projects, defects) — read from
-- 20260815120004_sent_is_terminal.sql, the most recent redefinition, not
-- reconstructed from the original. An earlier draft of this migration copied
-- only the original seven branches and would have silently deleted the other
-- five the first time it ran; the local migration script's own seed caught it.
--
-- INSERT/UPDATE only, matching every other table here — none of the fourteen
-- audits DELETE either, so removing a file or repository reference stays
-- outside this trigger's boundary rather than a gap unique to these two.
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

    -- ── new below ──────────────────────────────────────────────────────────

    when 'project_files' then
      v_subject := 'project_file';
      v_action := case when tg_op = 'INSERT' then 'project_file.added' else 'project_file.updated' end;

    when 'repositories' then
      v_subject := 'repository';
      v_action := case when tg_op = 'INSERT' then 'repository.added' else 'repository.updated' end;

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
  'Writes audit.audit_log from inside the transaction that changed the row (G-093, ADM-51). Covers every path into the table, including PostgREST and psql. AFTER trigger returning null: it cannot alter the row it records. Extended 2026-09-22 to cover project_files and repositories, carrying forward every branch the six prior redefinitions added.';

drop trigger if exists audit_row_change on projects.project_files;
create trigger audit_row_change after insert or update on projects.project_files
  for each row execute function audit.record_row_change();

drop trigger if exists audit_row_change on projects.repositories;
create trigger audit_row_change after insert or update on projects.repositories
  for each row execute function audit.record_row_change();
