-- ═══════════════════════════════════════════════════════════════════════════
-- Sent is terminal, and the decision trail is on the record.
--
-- Gap G-012, decision ADM-69 step 10. Two changes, both found by driving the
-- delivery path rather than reading it.
--
-- ── 1. a retry that succeeds may now say so ──────────────────────────────
--
-- `crm.mark_outbound_delivery` settled only `pending` messages. That guard
-- exists so a late duplicate report cannot turn a delivered message into a
-- failed one — and it also blocked `failed → sent`, so a message that failed
-- transiently and then delivered on a retry read **failed forever**. The
-- transcript and the operations screen both showed an attempt that failed,
-- for a message the client actually received.
--
-- This is not new to follow-ups: the approval announcer has retried through
-- the same window since G-110. Any retried-then-delivered announcement is
-- mis-recorded today.
--
-- The rule becomes: **`sent` is terminal; everything else may still be
-- settled.** The protection the old guard existed for survives intact,
-- because the state that must never be overturned is `sent` - and it still
-- cannot be.
--
-- ── 2. the follow-up lifecycle is audited ────────────────────────────────
--
-- ADM-69's tenth step requires the decision and the send to be audited. The
-- send already is - `send_outbound_message` and `mark_outbound_delivery`
-- audit from inside their own transactions. The sequence lifecycle was not.
--
-- The sequences trigger fires only on INSERT and on a STATUS change: the
-- worker touches `last_evaluated_at` on every evaluation, and auditing that
-- would write a row per active sequence per minute - a log nobody can read
-- is not an audit trail.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION crm.mark_outbound_delivery(p_message_id uuid, p_status text, p_provider_ref text DEFAULT NULL::text, p_error text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_updated uuid;
begin
  if p_status not in ('sent', 'failed') then
    raise exception 'delivery status must be sent or failed, not %', p_status
      using errcode = 'check_violation';
  end if;

  update crm.conversation_messages
     -- A message that failed and then delivered must not keep the old error:
     -- {delivery: sent, error: 'HTTP 500'} reads as both at once, and no
     -- surface rendering metadata.error could tell recovery from failure.
     set metadata = (case when p_status = 'sent' then metadata - 'error' else metadata end)
       || jsonb_build_object('delivery', p_status)
       || case when p_provider_ref is null then '{}'::jsonb
               else jsonb_build_object('provider_ref', p_provider_ref) end
       || case when p_error is null then '{}'::jsonb
               else jsonb_build_object('error', p_error) end
   where id = p_message_id
     -- `sent` is terminal. The old
     -- predicate admitted only `pending`, which protected against a late
     -- duplicate report but also blocked failed → sent — so a message that
     -- failed transiently and then delivered on retry read `failed` forever,
     -- in the transcript and on the operations screen. Measured before
     -- fixing: mark(sent) after mark(failed) returned false and the state
     -- stayed failed.
     --
     -- The list names the two settleable states rather than excluding `sent`,
     -- and the difference is not style — review caught it. `is distinct from
     -- 'sent'` also admits rows with NO delivery key at all, which is every
     -- INBOUND message, so a wrong message id passed by a future service-role
     -- caller would have stamped delivery state and an outbound audit row
     -- onto a client's own words. Under this predicate, as under the original,
     -- that call matches zero rows and returns false.
     and metadata->>'delivery' in ('pending', 'failed')
  returning id into v_updated;

  -- Audited from inside the transaction that records the delivery, rather
  -- than from a thirteenth service call site. G-079 moved the four writes
  -- that had a function to sit inside; this one is born with one, so it
  -- should not be added to the twelve that G-093 still describes.
  if v_updated is not null then
    perform core.record_audit(
      (select m.organization_id from crm.conversation_messages m where m.id = p_message_id),
      'message.outbound.' || p_status,
      'conversation_message',
      p_message_id,
      null,
      jsonb_build_object('provider_ref', p_provider_ref, 'error', p_error)
    );
  end if;

  return v_updated is not null;
end;
$function$;

comment on function crm.mark_outbound_delivery(uuid, text, text, text) is
  'Settles a message delivery state (G-014, G-012). SENT IS TERMINAL and nothing else is: pending -> sent, pending -> failed and failed -> sent are all legal, so a retry that succeeds corrects the record - while a late duplicate report still cannot turn a delivered message into a failed one, which is what the old pending-only guard existed for and all it actually needed to forbid.';

-- ═══════════════════════════════════════════════════════════════════════════
-- The audit vocabulary, in the same change as the triggers
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Regenerated from the live definition in `20260814120012` with two branches
-- added and nothing else changed; the diff was checked before committing, and
-- a test splices the added block out and compares the remainder line by line.

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

    -- G-012, ADM-70. Consent is the thing that decides whether a client may
    -- be messaged at all, so a change to it is exactly the kind of act the
    -- audit log exists for. ADM-70 warned this branch must arrive in the same
    -- change as the trigger: this function RAISES for any table it has no
    -- vocabulary for, so attaching the trigger without a branch here would
    -- make every write to the consent table fail.
    when 'communication_consent' then
      v_subject := 'communication_consent';
      v_action  := 'consent.' || new.status;

    -- G-113, ADM-80. The baseline decides what every future project starts
    -- from, so a change to it is a change to how the agency works - exactly
    -- the kind of act the audit log exists for. As with the consent table,
    -- this branch must arrive in the same change as the trigger: this
    -- function RAISES for any table it has no vocabulary for.
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

    -- G-012, ADM-69 step 10: "both the decision and the resulting send are
    -- audited." The sequence lifecycle is the decision trail. The trigger
    -- fires only on INSERT and on a STATUS change, so the worker's per-tick
    -- bookkeeping updates (last_evaluated_at) do not flood the log.
    when 'follow_up_sequences' then
      v_subject := 'follow_up_sequence';
      v_action  :=
        case
          when tg_op = 'INSERT' then 'followup.sequence_started'
          when new.status is distinct from old.status
            then 'followup.sequence_' || new.status
          else 'followup.sequence_updated'
        end;

    -- Every attempt row is a decision: claimed, and with what outcome.
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

drop trigger if exists record_row_change on crm.follow_up_sequences;
create trigger record_row_change
  after insert or update of status on crm.follow_up_sequences
  for each row execute function audit.record_row_change();

drop trigger if exists record_row_change on crm.follow_up_sends;
create trigger record_row_change
  after insert or update of outcome on crm.follow_up_sends
  for each row execute function audit.record_row_change();
