-- PM5 spec catalog: the clarification loop (M02, one question at a time, the client's answer recorded by staff), the Admin review request (A01),
-- module progress (M03) and the escalation of work nobody can take (A02). Events carry ids, never the client's words or a model's reasoning.
insert into core.event_types (type, description, canonical) values
  ('project.dev_clarification_requested', 'During development the PM needs one answer from the client before work can continue. The question is read from the row.', true),
  ('project.build_ready_for_admin', 'A development build passed QA on its exact commit and waits for an Admin decision.', true),
  ('project.development_escalated', 'A development task could not be routed, or failed past its rules, and waits for a person''s decision.', true),
  ('project.module_completed', 'Every task of a module is done: a client-safe progress milestone.', true)
on conflict (type) do nothing;

create table if not exists projects.dev_clarifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  task_id          uuid references projects.tasks(id) on delete set null,
  question         text not null check (length(btrim(question)) > 0 and length(question) <= 1000),
  why_needed       text check (why_needed is null or length(why_needed) <= 600),
  status           text not null default 'open' check (status in ('open', 'answered')),
  answer           text,
  evidence_ref     text,
  asked_by         uuid references core.users(id) on delete set null,
  answered_by      uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  answered_at      timestamptz,
  check ((status = 'answered') = (answer is not null and length(btrim(answer)) > 0 and answered_at is not null))
);
create unique index if not exists dev_clarifications_one_open_per_task on projects.dev_clarifications (task_id) where status = 'open' and task_id is not null;
alter table projects.dev_clarifications enable row level security;
drop policy if exists dev_clarifications_read on projects.dev_clarifications;
create policy dev_clarifications_read on projects.dev_clarifications for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.dev_clarifications from public, anon;
revoke insert, update, delete on projects.dev_clarifications from authenticated;
grant select on projects.dev_clarifications to authenticated;
grant all on projects.dev_clarifications to service_role;
create trigger dev_clarifications_parent_org_project before insert or update of project_id on projects.dev_clarifications for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger dev_clarifications_parent_org_task before insert or update of task_id on projects.dev_clarifications for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');
create trigger freeze_org_dev_clarifications before update of organization_id on projects.dev_clarifications for each row execute function core.freeze_organization_id();
create or replace function projects.dev_clarifications_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a clarification is part of the record: it is answered, never deleted' using errcode = 'restrict_violation'; end if;
  if old.status = 'answered' then raise exception 'an answered clarification is final' using errcode = 'restrict_violation'; end if;
  if new.question is distinct from old.question or new.project_id is distinct from old.project_id then raise exception 'a clarification''s question is not edited: ask a new one' using errcode = 'restrict_violation'; end if;
  return new;
end $$;
create trigger dev_clarifications_guard before update or delete on projects.dev_clarifications for each row execute function projects.dev_clarifications_guard();

create or replace function projects.ask_dev_clarification(p_project_id uuid, p_question text, p_task_id uuid default null, p_why text default null)
returns table (outcome text, clarification_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  if p_task_id is not null and not exists (select 1 from projects.tasks t where t.id = p_task_id and t.project_id = p_project_id and t.organization_id = v_org) then return query select 'task_not_on_project'::text, null::uuid; return; end if;
  -- one open question per task: the PM asks the client one thing at a time
  if p_task_id is not null and exists (select 1 from projects.dev_clarifications c where c.task_id = p_task_id and c.status = 'open') then return query select 'already_open'::text, null::uuid; return; end if;
  begin
    insert into projects.dev_clarifications (organization_id, project_id, task_id, question, why_needed, asked_by) values (v_org, p_project_id, p_task_id, btrim(p_question), p_why, v_actor) returning id into v_new;
  exception when check_violation then return query select 'invalid_question'::text, null::uuid; return; end;
  perform core.emit_event(v_org, 'project.dev_clarification_requested', 'dev_clarification', v_new, jsonb_build_object('projectId', p_project_id));
  return query select 'asked'::text, v_new;
end $$;
revoke all on function projects.ask_dev_clarification(uuid, text, uuid, text) from public, anon;
grant execute on function projects.ask_dev_clarification(uuid, text, uuid, text) to authenticated;

create or replace function projects.answer_dev_clarification(p_clarification_id uuid, p_answer text, p_evidence_ref text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.dev_clarifications;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_answer is null or length(btrim(p_answer)) = 0 then return query select 'answer_required'::text; return; end if;
  select * into v_c from projects.dev_clarifications c where c.id = p_clarification_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status = 'answered' then return query select 'already_answered'::text; return; end if;
  update projects.dev_clarifications set status = 'answered', answer = btrim(p_answer), evidence_ref = p_evidence_ref, answered_by = v_actor, answered_at = now() where id = v_c.id;
  perform core.record_audit(v_org, 'dev_clarification.answered', 'dev_clarification', v_c.id, null, null);
  return query select 'answered'::text;
end $$;
revoke all on function projects.answer_dev_clarification(uuid, text, text) from public, anon;
grant execute on function projects.answer_dev_clarification(uuid, text, text) to authenticated;

-- A01: QA passed this exact build: the Admin is told it waits for a decision
create or replace function projects.emit_build_ready_for_admin() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_d projects.deliverables;
begin
  if new.qa_status = 'passed' and old.qa_status is distinct from 'passed' then
    select * into v_d from projects.deliverables d where d.id = new.deliverable_id;
    if v_d.kind = 'build' and new.commit_ref is not null then
      perform core.emit_event(v_d.organization_id, 'project.build_ready_for_admin', 'deliverable', v_d.id, jsonb_build_object('projectId', v_d.project_id, 'deliverableId', v_d.id, 'version', v_d.version));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists deliverable_details_build_ready_for_admin on projects.deliverable_details;
create trigger deliverable_details_build_ready_for_admin after update of qa_status on projects.deliverable_details for each row execute function projects.emit_build_ready_for_admin();

-- A02: work nobody can take, or that failed past its rules, becomes a message to the team (the escalation row itself is the record)
create or replace function projects.emit_development_escalated() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform core.emit_event(new.organization_id, 'project.development_escalated', 'orchestrator_escalation', new.id, jsonb_build_object('projectId', new.project_id, 'taskId', new.task_id));
  return new;
end $$;
drop trigger if exists orchestrator_escalations_emit on projects.orchestrator_escalations;
create trigger orchestrator_escalations_emit after insert on projects.orchestrator_escalations for each row execute function projects.emit_development_escalated();

-- M03: a module whose tasks are all done is a progress milestone (once per module: the event's own subject is the module)
create or replace function projects.emit_module_completed() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' and new.module_id is not null then
    if not exists (select 1 from projects.tasks t where t.module_id = new.module_id and t.status not in ('done', 'cancelled') and t.archived_at is null)
       and exists (select 1 from projects.phase_five pf where pf.project_id = new.project_id) then
      perform core.emit_event(new.organization_id, 'project.module_completed', 'module', new.module_id, jsonb_build_object('projectId', new.project_id, 'moduleId', new.module_id));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists tasks_emit_module_completed on projects.tasks;
create trigger tasks_emit_module_completed after update of status on projects.tasks for each row execute function projects.emit_module_completed();
notify pgrst, 'reload schema';
