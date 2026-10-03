-- Phase 2's state follows the facts, and says what it is waiting for.
--
-- Master §9 / PM §11: onboarding is NOT_STARTED -> IN_PROGRESS ->
-- WAITING_CLIENT / WAITING_ADMIN -> READY_FOR_FINANCE -> FINANCE_PENDING ->
-- PLANNING -> READY_FOR_KICKOFF -> COMPLETED, so that an Admin can tell "what is
-- it waiting for, and who owns the next move" without reading anything else.
-- The column and its eleven values existed since G-250; code wrote only three of
-- them (context_loading, kickoff_sent, completed), so a project waiting a week
-- on a client's GST answer and one waiting on a payment both read
-- `context_loading`.
--
-- This derives the state from the same facts the kickoff gate reads, in the
-- order the flow needs them, and never invents one:
--
--   no billing mode confirmed          -> waiting_client   (the GST / Non-GST answer)
--   WhatsApp group not mapped          -> waiting_admin    (the manual group action)
--   advance not verified               -> waiting_finance  (invoice out, payment unverified)
--   no active plan                     -> waiting_planning (the blueprint)
--   required onboarding items open     -> waiting_client
--   nothing unmet                      -> kickoff_ready
--
-- It only moves a phase that is still running: kickoff_sent, completed and
-- blocked are left alone, and every real change is audited with before/after.
-- Run by the runner each tick; bounded, service role only.

create or replace function projects.refresh_phase_two_states(p_limit integer default 200)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row     record;
  v_ready   record;
  v_billing boolean;
  v_next    text;
  v_changed integer := 0;
begin
  if (select auth.role()) is distinct from 'service_role' then return 0; end if;

  for v_row in
    select t.id, t.organization_id, t.project_id, t.state
      from projects.phase_two t
     where t.state not in ('kickoff_sent', 'completed', 'blocked')
     order by t.updated_at asc
     limit greatest(coalesce(p_limit, 200), 1)
  loop
    select exists (
      select 1 from finance.billing_profiles bp
       where bp.project_id = v_row.project_id and bp.status = 'active'
    ) into v_billing;

    select * into v_ready from projects.pre_kickoff_readiness(v_row.project_id);

    v_next := case
      when not v_billing                                           then 'waiting_client'
      when 'whatsapp_group_not_mapped' = any(v_ready.unmet)        then 'waiting_admin'
      when 'advance_not_verified' = any(v_ready.unmet)             then 'waiting_finance'
      when 'no_active_plan' = any(v_ready.unmet)                   then 'waiting_planning'
      when 'onboarding_incomplete' = any(v_ready.unmet)            then 'waiting_client'
      when v_ready.ready                                           then 'kickoff_ready'
      else v_row.state
    end;

    if v_next is distinct from v_row.state then
      update projects.phase_two set state = v_next where id = v_row.id;
      perform core.record_audit(
        v_row.organization_id, 'project.phase_two_state_changed', 'project', v_row.project_id,
        jsonb_build_object('state', v_row.state), jsonb_build_object('state', v_next), null
      );
      v_changed := v_changed + 1;
    end if;
  end loop;

  return v_changed;
end;
$$;
revoke all on function projects.refresh_phase_two_states(integer) from public, anon, authenticated;
grant execute on function projects.refresh_phase_two_states(integer) to service_role;
comment on function projects.refresh_phase_two_states(integer) is
  'Derives each running Phase 2 state from the kickoff gate''s own facts (waiting_client / waiting_admin / waiting_finance / waiting_planning / kickoff_ready). Never touches kickoff_sent, completed or blocked. Service role only.';
