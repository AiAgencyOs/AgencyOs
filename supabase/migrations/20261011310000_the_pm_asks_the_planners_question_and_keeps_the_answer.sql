-- The project manager asks the client the planner's question, and keeps the answer.
--
-- Phase 2 Planning §10: when the planner meets an ambiguity it does not guess -
-- it raises a clarification, the PM asks the client, the PM records the
-- structured answer, and the plan resumes. The register and its states existed
-- (open -> asked -> answered -> resolved), but both recording doors required a
-- PERSON, on the stated ground that asking a client is an event outside this
-- system which an unattended process cannot witness.
--
-- That ground no longer holds once the system sends the question itself: the
-- outbound message is a row in `crm.conversation_messages`, and the client's
-- reply is another. So two doors for the runner, each carrying its EVIDENCE:
--
--   agent_mark_clarification_asked(clarification, message)
--       open -> asked, only when the named message is OUR message, in a thread
--       that belongs to this project;
--   agent_record_clarification_answer(clarification, message)
--       asked -> answered, the answer being the CLIENT'S OWN message read here
--       (never text passed in), sent after the question and in a thread that
--       belongs to this project.
--
-- Settling the question - resolve, or route it to a change request when the
-- answer is new scope - stays a person's act, exactly as before. The system
-- asks and listens; it does not decide what the answer means for the plan.

create or replace function projects.agent_mark_clarification_asked(p_clarification_id uuid, p_message_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row     projects.plan_clarifications;
  v_project uuid;
  v_msg     crm.conversation_messages;
begin
  if (select auth.role()) is distinct from 'service_role' then return 'forbidden'; end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then return 'unknown_clarification'; end if;
  if v_row.status <> 'open' then return 'already_asked'; end if;

  select pp.project_id into v_project from projects.project_plans pp where pp.id = v_row.plan_id;

  select m.* into v_msg from crm.conversation_messages m
   where m.id = p_message_id and m.organization_id = v_row.organization_id;
  if v_msg.id is null or v_msg.author_type <> 'user' then return 'not_our_message'; end if;
  if not exists (
    select 1 from crm.conversations c
     where c.id = v_msg.conversation_id and c.organization_id = v_row.organization_id
       and (c.project_id = v_project
            or (c.kind = 'direct' and exists (
                 select 1 from sales.opportunities o join projects.projects p on p.opportunity_id = o.id
                  where o.lead_id = c.lead_id and p.id = v_project)))
  ) then
    return 'not_this_projects_thread';
  end if;

  update projects.plan_clarifications set status = 'asked', asked_at = now(), asked_by = null where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'project.clarification_asked', 'project', v_project, null,
    jsonb_build_object('clarification_id', v_row.id, 'message_id', p_message_id, 'by', 'project_manager'), null
  );
  return 'asked';
end;
$$;
revoke all on function projects.agent_mark_clarification_asked(uuid, uuid) from public, anon, authenticated;
grant execute on function projects.agent_mark_clarification_asked(uuid, uuid) to service_role;

create or replace function projects.agent_record_clarification_answer(p_clarification_id uuid, p_message_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row     projects.plan_clarifications;
  v_project uuid;
  v_msg     crm.conversation_messages;
  v_body    text;
begin
  if (select auth.role()) is distinct from 'service_role' then return 'forbidden'; end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then return 'unknown_clarification'; end if;
  if v_row.status in ('resolved', 'routed_to_change_request') then return 'already_settled'; end if;
  -- An answer to a question nobody asked is a guess wearing a client's voice.
  if v_row.status = 'open' then return 'not_asked'; end if;
  if v_row.status = 'answered' then return 'already_answered'; end if;

  select pp.project_id into v_project from projects.project_plans pp where pp.id = v_row.plan_id;

  select m.* into v_msg from crm.conversation_messages m
   where m.id = p_message_id and m.organization_id = v_row.organization_id;
  if v_msg.id is null or v_msg.author_type <> 'client' then return 'not_the_clients_message'; end if;
  if v_msg.created_at < v_row.asked_at then return 'sent_before_the_question'; end if;
  if not exists (
    select 1 from crm.conversations c
     where c.id = v_msg.conversation_id and c.organization_id = v_row.organization_id
       and (c.project_id = v_project
            or (c.kind = 'direct' and exists (
                 select 1 from sales.opportunities o join projects.projects p on p.opportunity_id = o.id
                  where o.lead_id = c.lead_id and p.id = v_project)))
  ) then
    return 'not_this_projects_thread';
  end if;

  v_body := left(btrim(coalesce(v_msg.body, '')), 2000);
  if v_body = '' then return 'empty_answer'; end if;

  update projects.plan_clarifications
     set status = 'answered', answer = v_body, answered_at = now(), answered_by = null, answered_via = 'client_whatsapp'
   where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'project.clarification_answered', 'project', v_project, null,
    jsonb_build_object('clarification_id', v_row.id, 'message_id', p_message_id, 'via', 'client_whatsapp'), null
  );
  return 'answered';
end;
$$;
revoke all on function projects.agent_record_clarification_answer(uuid, uuid) from public, anon, authenticated;
grant execute on function projects.agent_record_clarification_answer(uuid, uuid) to service_role;
