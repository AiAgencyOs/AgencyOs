-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 6 remaining tasks, part 2 (P601 §9, §38, §61; P602).
--
--  1. API / data contracts the QA tests against are DECLARED on the intake (name + reference), by a person: nothing infers a contract.
--  2. Client clarification (P601 §38): when expected behaviour is genuinely ambiguous the client may be asked - one question, recorded, answered, never guessed.
--     A question is internal until the PM relays it; the answer is a recorded fact a case result can cite.
--  3. A defect handed to development emits a client-safe progress fact (severity class only, never the finding).
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.qa_intakes add column if not exists api_contract_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(api_contract_refs) = 'array');

create or replace function qa.declare_intake_contracts(p_project_id uuid, p_refs jsonb)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_in projects.qa_intakes;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_refs is null or jsonb_typeof(p_refs) <> 'array' or jsonb_array_length(p_refs) = 0
     or exists (select 1 from jsonb_array_elements(p_refs) e where jsonb_typeof(e) <> 'object' or coalesce(btrim(e->>'name'), '') = '' or coalesce(btrim(e->>'ref'), '') = '') then
    return query select 'each_contract_needs_a_name_and_a_reference'::text; return;
  end if;
  select * into v_in from projects.qa_intakes i where i.project_id = p_project_id and i.organization_id = v_org for update;
  if v_in.id is null then return query select 'no_intake'::text; return; end if;
  update projects.qa_intakes set api_contract_refs = p_refs where id = v_in.id;
  perform core.record_audit(v_org, 'qa_intake.contracts_declared', 'qa_intake', v_in.id, null, jsonb_build_object('projectId', p_project_id, 'count', jsonb_array_length(p_refs)));
  return query select 'declared'::text;
end $$;
revoke all on function qa.declare_intake_contracts(uuid, jsonb) from public, anon;
grant execute on function qa.declare_intake_contracts(uuid, jsonb) to authenticated;

create table if not exists qa.qa_clarifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  case_id          uuid references qa.phase6_cases(id) on delete set null,
  question         text not null check (length(btrim(question)) > 0 and length(question) <= 1000),
  status           text not null default 'open' check (status in ('open', 'answered')),
  answer           text,
  asked_by         uuid references core.users(id) on delete set null,
  answered_by      uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  answered_at      timestamptz,
  check ((status = 'answered') = (answer is not null and length(btrim(answer)) > 0 and answered_at is not null))
);
alter table qa.qa_clarifications enable row level security;
drop policy if exists qa_clarifications_read on qa.qa_clarifications;
create policy qa_clarifications_read on qa.qa_clarifications for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
grant select on qa.qa_clarifications to authenticated;
grant all on qa.qa_clarifications to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('case_id', 'qa.phase6_cases')) as t(col, parent) loop
    execute format('drop trigger if exists %I on qa.qa_clarifications', 'qa_clarifications_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on qa.qa_clarifications for each row execute function core.enforce_parent_org(%L, %L)', 'qa_clarifications_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_qa_clarifications on qa.qa_clarifications;
create trigger freeze_org_qa_clarifications before update of organization_id on qa.qa_clarifications for each row execute function core.freeze_organization_id();
-- the question and who asked it are history; only the answer is added, once
create or replace function qa.qa_clarifications_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a clarification is a record and is never deleted' using errcode = 'restrict_violation'; end if;
  if new.question is distinct from old.question or new.asked_by is distinct from old.asked_by or new.project_id is distinct from old.project_id or new.case_id is distinct from old.case_id
     or (old.status = 'answered' and (new.answer is distinct from old.answer or new.status is distinct from old.status)) then
    raise exception 'a clarification is asked once and answered once; neither is edited' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists qa_clarifications_guard on qa.qa_clarifications;
create trigger qa_clarifications_guard before update or delete on qa.qa_clarifications for each row execute function qa.qa_clarifications_guard();

insert into core.event_types (type, description, canonical) values
  ('project.qa_clarification_requested', 'QA needs a genuinely ambiguous expected behaviour clarified. The PM relays the question; the question itself is read from the row, never carried here.', true),
  ('project.qa_defect_handed_off', 'A defect found in testing was handed to development for correction and will be independently retested. Carries the severity class only, never the finding.', true)
on conflict (type) do nothing;

create or replace function qa.ask_clarification(p_project_id uuid, p_question text, p_case_id uuid default null)
returns table (outcome text, clarification_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  -- one open question per case: the PM asks the client one thing at a time
  if p_case_id is not null and exists (select 1 from qa.qa_clarifications c where c.case_id = p_case_id and c.status = 'open') then return query select 'already_open'::text, null::uuid; return; end if;
  begin
    insert into qa.qa_clarifications (organization_id, project_id, case_id, question, asked_by) values (v_org, p_project_id, p_case_id, p_question, v_actor) returning id into v_new;
  exception when check_violation then return query select 'invalid_question'::text, null::uuid; return; end;
  perform core.emit_event(v_org, 'project.qa_clarification_requested', 'qa_clarification', v_new, jsonb_build_object('projectId', p_project_id));
  return query select 'asked'::text, v_new;
end $$;
revoke all on function qa.ask_clarification(uuid, text, uuid) from public, anon;
grant execute on function qa.ask_clarification(uuid, text, uuid) to authenticated;

create or replace function qa.answer_clarification(p_clarification_id uuid, p_answer text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c qa.qa_clarifications;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_answer is null or length(btrim(p_answer)) = 0 then return query select 'answer_required'::text; return; end if;
  select * into v_c from qa.qa_clarifications c where c.id = p_clarification_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status = 'answered' then return query select 'already_answered'::text; return; end if;
  update qa.qa_clarifications set status = 'answered', answer = p_answer, answered_by = v_actor, answered_at = now() where id = v_c.id;
  return query select 'answered'::text;
end $$;
revoke all on function qa.answer_clarification(uuid, text) from public, anon;
grant execute on function qa.answer_clarification(uuid, text) to authenticated;

CREATE OR REPLACE FUNCTION qa.hand_off_defect(p_defect_id uuid)
 RETURNS TABLE(outcome text, handoff_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_org uuid := (select core.current_organization_id()); v_d qa.defects; v_new uuid; v_existing uuid;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_d from qa.defects d where d.id = p_defect_id and d.organization_id = v_org;
  if v_d.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_d.classification <> 'product_defect' then return query select 'not_a_product_defect'::text, null::uuid; return; end if;
  if v_d.status <> 'open' then return query select 'not_open'::text, null::uuid; return; end if;
  select h.id into v_existing from ai.handoffs h where h.subject_type = 'defect' and h.subject_id = v_d.id and h.status in ('queued', 'accepted', 'running', 'needs_input', 'awaiting_approval');
  if v_existing is not null then return query select 'already_handed_off'::text, v_existing; return; end if;
  insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, project_id, subject_type, subject_id, objective, context, requirements)
  values (v_org, v_d.project_id, 'orchestrator', 'bug_fix', v_d.project_id, 'defect', v_d.id,
          'Fix defect (S' || v_d.s_level || '): ' || v_d.title,
          jsonb_build_object('defectId', v_d.id, 'sLevel', v_d.s_level, 'foundCommit', v_d.found_commit, 'buildDeliverableId', v_d.deliverable_id,
                             'reproduction', v_d.reproduction, 'expected', v_d.expected, 'actual', v_d.actual, 'evidenceUrl', v_d.evidence_url),
          jsonb_build_object('mustReproduceFirst', true, 'minimalFixOnly', true, 'targetedTests', true, 'securityReviewIfSensitive', true,
                             'qaMustRetestFixedBuild', true, 'regressionRequired', true, 'fixReadyIsNotVerified', true))
  returning id into v_new;
  -- client-safe progress: the PM may say an issue found in testing is being corrected and will be retested (severity class only; never the finding)
  perform core.emit_event(v_org, 'project.qa_defect_handed_off', 'defect', v_d.id, jsonb_build_object('projectId', v_d.project_id, 'sLevel', v_d.s_level));
  update projects.phase_six set state = 'defect_fix_loop' where project_id = v_d.project_id and state in ('testing', 'final_verification', 'plan_ready');
  return query select 'handed_off'::text, v_new;
end $function$;

revoke all on function qa.hand_off_defect(uuid) from public, anon;
grant execute on function qa.hand_off_defect(uuid) to authenticated;

notify pgrst, 'reload schema';
