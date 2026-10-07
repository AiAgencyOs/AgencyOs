-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8B / 9 gaps.
--
--   * 8B QA §6: a post-deploy smoke FAILURE on a released maintenance change is recorded (with evidence) by a person with delivery rights, and an
--     INDEPENDENT Admin records the decision (rollback executed elsewhere / forward fix / false alarm). AgencyOS runs no smoke check and rolls nothing
--     back: both rows are facts people record. One open failure per work item.
--   * 8B QA §7: the events QAHandoffCreated, TestRunCompleted and QAPassed exist, emitted by triggers on the rows that change (so no door was edited).
--   * 9 SPEC 14: FinancialExceptionCreated exists, emitted when a finance exception row is created (by a person or by the system sweep).
--
-- Nothing here moves money, approves, or bypasses a human gate.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.maintenance_qa_handoff_created', 'A developer submitted an exact commit of a maintenance change for independent QA.', true),
  ('project.maintenance_test_run_completed', 'An independent QA result (pass, fail or blocked) was recorded on the exact commit of a maintenance change.', true),
  ('project.maintenance_qa_passed', 'A maintenance change passed independent QA on its exact commit; it still needs its own Admin release approval.', true),
  ('project.maintenance_smoke_failed', 'A person recorded that the post-deploy smoke check of a released maintenance change failed. AgencyOS rolled nothing back.', true),
  ('project.maintenance_smoke_failure_decided', 'An independent Admin recorded the decision on a failed post-deploy smoke check.', true),
  ('finance.exception_created', 'A finance exception (wrong amount, overdue, chargeback ...) was opened. It blocks a close until a person resolves it.', true)
on conflict (type) do nothing;

-- ── events from the rows that change ───────────────────────────────────────
create or replace function projects.maintenance_emit_status_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'fix_submitted' and old.status is distinct from 'fix_submitted' then
    perform core.emit_event(new.organization_id, 'project.maintenance_qa_handoff_created', 'maintenance_work_item', new.id,
      jsonb_build_object('projectId', new.project_id, 'commit', new.commit_ref));
  elsif new.status = 'qa_passed' and old.status is distinct from 'qa_passed' then
    perform core.emit_event(new.organization_id, 'project.maintenance_qa_passed', 'maintenance_work_item', new.id,
      jsonb_build_object('projectId', new.project_id, 'commit', new.commit_ref));
  end if;
  return new;
end $$;
revoke all on function projects.maintenance_emit_status_events() from public, anon, authenticated;
drop trigger if exists maintenance_work_items_status_events on projects.maintenance_work_items;
create trigger maintenance_work_items_status_events after update of status on projects.maintenance_work_items
  for each row execute function projects.maintenance_emit_status_events();

create or replace function projects.maintenance_emit_test_run_completed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform core.emit_event(new.organization_id, 'project.maintenance_test_run_completed', 'maintenance_work_item', new.work_item_id,
    jsonb_build_object('category', new.category, 'status', new.status, 'commit', new.commit_ref));
  return new;
end $$;
revoke all on function projects.maintenance_emit_test_run_completed() from public, anon, authenticated;
drop trigger if exists maintenance_qa_results_test_run_event on projects.maintenance_qa_results;
create trigger maintenance_qa_results_test_run_event after insert on projects.maintenance_qa_results
  for each row execute function projects.maintenance_emit_test_run_completed();

create or replace function finance.emit_finance_exception_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform core.emit_event(new.organization_id, 'finance.exception_created', 'finance_exception', new.id,
    jsonb_build_object('kind', new.kind, 'blocking', new.blocking, 'projectId', new.project_id, 'invoiceId', new.invoice_id));
  return new;
end $$;
revoke all on function finance.emit_finance_exception_created() from public, anon, authenticated;
drop trigger if exists finance_exceptions_created_event on finance.finance_exceptions;
create trigger finance_exceptions_created_event after insert on finance.finance_exceptions
  for each row execute function finance.emit_finance_exception_created();

-- ── the smoke failure record ───────────────────────────────────────────────
create table if not exists projects.maintenance_smoke_failures (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  work_item_id     uuid not null references projects.maintenance_work_items(id) on delete restrict,
  deployment_ref   text not null check (length(btrim(deployment_ref)) > 0),
  evidence_ref     text not null check (length(btrim(evidence_ref)) between 1 and 500),
  reason           text not null check (length(btrim(reason)) between 1 and 2000),
  severity         text not null check (severity in ('minor', 'major', 'critical')),
  status           text not null default 'open' check (status in ('open', 'decided')),
  reported_by      uuid not null references core.users(id) on delete restrict,
  reported_at      timestamptz not null default clock_timestamp(),
  decision         text check (decision is null or decision in ('rollback_executed', 'forward_fix', 'false_alarm')),
  decision_note    text check (decision_note is null or length(decision_note) <= 2000),
  decided_by       uuid references core.users(id) on delete restrict,
  decided_at       timestamptz,
  check ((status = 'open' and decision is null and decided_by is null and decided_at is null)
      or (status = 'decided' and decision is not null and decided_by is not null and decided_at is not null
          and length(btrim(coalesce(decision_note, ''))) > 0 and decided_by <> reported_by))
);
create unique index if not exists maintenance_smoke_one_open on projects.maintenance_smoke_failures (work_item_id) where status = 'open';
create index if not exists maintenance_smoke_project_idx on projects.maintenance_smoke_failures (project_id, reported_at desc);

create or replace function projects.maintenance_smoke_failures_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a smoke failure is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.smoke_sanctioned', true), '') <> 'on' then
    raise exception 'a smoke failure moves through its doors' using errcode = 'restrict_violation';
  end if;
  if old.status <> 'open' or new.status <> 'decided'
     or (new.organization_id, new.project_id, new.work_item_id, new.deployment_ref, new.evidence_ref, new.reason, new.severity, new.reported_by, new.reported_at)
        is distinct from (old.organization_id, old.project_id, old.work_item_id, old.deployment_ref, old.evidence_ref, old.reason, old.severity, old.reported_by, old.reported_at) then
    raise exception 'a smoke failure is only ever decided once; what was reported is never edited' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_smoke_failures_guard on projects.maintenance_smoke_failures;
create trigger maintenance_smoke_failures_guard before update or delete on projects.maintenance_smoke_failures
  for each row execute function projects.maintenance_smoke_failures_guard();

drop trigger if exists maintenance_smoke_failures_parent_org_work_item on projects.maintenance_smoke_failures;
create trigger maintenance_smoke_failures_parent_org_work_item before insert or update of work_item_id on projects.maintenance_smoke_failures
  for each row execute function core.enforce_parent_org('work_item_id', 'projects.maintenance_work_items');
drop trigger if exists maintenance_smoke_failures_parent_org_project on projects.maintenance_smoke_failures;
create trigger maintenance_smoke_failures_parent_org_project before insert or update of project_id on projects.maintenance_smoke_failures
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_maintenance_smoke_failures on projects.maintenance_smoke_failures;
create trigger freeze_org_maintenance_smoke_failures before update of organization_id on projects.maintenance_smoke_failures
  for each row execute function core.freeze_organization_id();

alter table projects.maintenance_smoke_failures enable row level security;
drop policy if exists maintenance_smoke_failures_read on projects.maintenance_smoke_failures;
create policy maintenance_smoke_failures_read on projects.maintenance_smoke_failures for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.maintenance_smoke_failures from public, anon;
revoke insert, update, delete on projects.maintenance_smoke_failures from authenticated;
grant select on projects.maintenance_smoke_failures to authenticated;
grant all on projects.maintenance_smoke_failures to service_role;

-- ── doors ──────────────────────────────────────────────────────────────────
create or replace function projects.report_maintenance_smoke_failure(p_work_item_id uuid, p_evidence_ref text, p_reason text, p_severity text default 'major')
returns table (outcome text, failure_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_i projects.maintenance_work_items; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if length(btrim(coalesce(p_evidence_ref, ''))) = 0 or length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'evidence_required'::text, null::uuid; return; end if;
  if p_severity not in ('minor', 'major', 'critical') then return query select 'invalid_severity'::text, null::uuid; return; end if;
  if projects.p8c_has_secret(p_evidence_ref) or projects.p8c_has_secret(p_reason) then return query select 'secret_refused'::text, null::uuid; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_i.status <> 'released' then return query select 'not_released'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_smoke_failures f where f.work_item_id = v_i.id and f.status = 'open') then return query select 'already_open'::text, null::uuid; return; end if;
  insert into projects.maintenance_smoke_failures (organization_id, project_id, work_item_id, deployment_ref, evidence_ref, reason, severity, reported_by)
    values (v_org, v_i.project_id, v_i.id, v_i.deployment_ref, btrim(p_evidence_ref), btrim(p_reason), p_severity, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_work.smoke_failed', 'maintenance_work_item', v_i.id, null, jsonb_build_object('severity', p_severity, 'failureId', v_id));
  perform core.emit_event(v_org, 'project.maintenance_smoke_failed', 'maintenance_work_item', v_i.id, jsonb_build_object('projectId', v_i.project_id, 'severity', p_severity, 'failureId', v_id));
  return query select 'reported'::text, v_id;
end $$;
revoke all on function projects.report_maintenance_smoke_failure(uuid, text, text, text) from public, anon;
grant execute on function projects.report_maintenance_smoke_failure(uuid, text, text, text) to authenticated;

create or replace function projects.decide_maintenance_smoke_failure(p_failure_id uuid, p_decision text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_f projects.maintenance_smoke_failures;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('rollback_executed', 'forward_fix', 'false_alarm') then return query select 'invalid_decision'::text; return; end if;
  if length(btrim(coalesce(p_note, ''))) = 0 then return query select 'note_required'::text; return; end if;
  if projects.p8c_has_secret(p_note) then return query select 'secret_refused'::text; return; end if;
  select * into v_f from projects.maintenance_smoke_failures f where f.id = p_failure_id and f.organization_id = v_org for update;
  if v_f.id is null then return query select 'not_found'::text; return; end if;
  if v_f.status <> 'open' then return query select 'already_decided'::text; return; end if;
  if v_f.reported_by = v_actor then return query select 'self_decision'::text; return; end if;
  perform set_config('projects.smoke_sanctioned', 'on', true);
  update projects.maintenance_smoke_failures set status = 'decided', decision = p_decision, decision_note = btrim(p_note), decided_by = v_actor, decided_at = clock_timestamp() where id = v_f.id;
  perform core.record_audit(v_org, 'maintenance_work.smoke_failure_decided', 'maintenance_work_item', v_f.work_item_id, null, jsonb_build_object('decision', p_decision, 'failureId', v_f.id));
  perform core.emit_event(v_org, 'project.maintenance_smoke_failure_decided', 'maintenance_work_item', v_f.work_item_id, jsonb_build_object('projectId', v_f.project_id, 'decision', p_decision, 'failureId', v_f.id));
  return query select 'decided'::text;
end $$;
revoke all on function projects.decide_maintenance_smoke_failure(uuid, text, text) from public, anon;
grant execute on function projects.decide_maintenance_smoke_failure(uuid, text, text) to authenticated;
