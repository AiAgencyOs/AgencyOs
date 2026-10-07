-- The Test Automation and Documentation agents (P10, P514) propose; a person decides. Their only writes are these two service-only doors:
--   * a proposed test case is a DRAFT row - it is never a test run, a result or a report, so it cannot count as evidence of anything;
--   * a documentation draft is a technical document whose status is always 'partial' (never 'implemented': that needs evidence the agent cannot
--     give itself), it never overwrites a document that already exists, and it carries the word DRAFT in its body.

create table if not exists projects.test_case_drafts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  task_id           uuid not null references projects.tasks(id) on delete cascade,
  name              text not null check (length(btrim(name)) > 0 and length(name) <= 200),
  layer             text not null check (layer in ('unit', 'component', 'api', 'database', 'integration', 'e2e', 'ui', 'security', 'performance', 'other')),
  description       text not null check (length(btrim(description)) > 0 and length(description) <= 2000),
  steps             jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 30),
  expected          text not null check (length(btrim(expected)) > 0 and length(expected) <= 1000),
  covers_criterion  text check (covers_criterion is null or length(covers_criterion) <= 1000),
  status            text not null default 'draft' check (status in ('draft')),
  agent_run_id      uuid,
  created_at        timestamptz not null default now(),
  unique (task_id, name)
);
alter table projects.test_case_drafts enable row level security;
drop policy if exists test_case_drafts_read on projects.test_case_drafts;
create policy test_case_drafts_read on projects.test_case_drafts for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.test_case_drafts from public, anon;
revoke insert, update, delete on projects.test_case_drafts from authenticated;
grant select on projects.test_case_drafts to authenticated;
grant all on projects.test_case_drafts to service_role;
create trigger test_case_drafts_parent_org_project before insert or update of project_id on projects.test_case_drafts
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger test_case_drafts_parent_org_task before insert or update of task_id on projects.test_case_drafts
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');
create trigger freeze_org_test_case_drafts before update of organization_id on projects.test_case_drafts
  for each row execute function core.freeze_organization_id();

-- service role only; the organization and project come from the TASK, never from the caller's claim
create or replace function projects.record_test_case_draft(p_task_id uuid, p_name text, p_layer text, p_description text, p_steps jsonb, p_expected text, p_covers text default null, p_run_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_task projects.tasks; v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  select * into v_task from projects.tasks t where t.id = p_task_id;
  if v_task.id is null then return query select 'not_found'::text; return; end if;
  begin
    insert into projects.test_case_drafts (organization_id, project_id, task_id, name, layer, description, steps, expected, covers_criterion, agent_run_id)
    values (v_task.organization_id, v_task.project_id, v_task.id, btrim(p_name), p_layer, p_description, coalesce(p_steps, '[]'::jsonb), p_expected, nullif(btrim(coalesce(p_covers, '')), ''), p_run_id)
    on conflict (task_id, name) do nothing returning id into v_id;
  exception when check_violation then return query select 'bad_input'::text; return;
  end;
  if v_id is null then return query select 'already_drafted'::text; return; end if;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_test_case_draft(uuid, text, text, text, jsonb, text, text, uuid) from public, anon, authenticated;
grant execute on function projects.record_test_case_draft(uuid, text, text, text, jsonb, text, text, uuid) to service_role;

-- a documentation draft: never 'implemented', never an overwrite, never a derived kind (integration / build_run / test are derived from rows)
create or replace function projects.record_documentation_draft(p_project_id uuid, p_kind text, p_title text, p_body text)
returns table (outcome text, document_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return query select 'not_found'::text, null::uuid; return; end if;
  if p_kind not in ('architecture', 'api', 'database', 'handoff', 'known_limitations', 'other') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_title is null or length(btrim(p_title)) = 0 or length(p_title) > 200 or p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 20000 then
    return query select 'bad_input'::text, null::uuid; return;
  end if;
  begin
    insert into projects.technical_documents (organization_id, project_id, kind, title, status, evidence_ref, body, derived)
    values (v_org, p_project_id, p_kind, btrim(p_title), 'partial', null, 'DRAFT (written by the Documentation agent; not reviewed by a person)' || E'\n\n' || p_body, false)
    on conflict (project_id, kind, title) do nothing returning id into v_id;
  exception
    when restrict_violation then return query select 'refused'::text, null::uuid; return;
    when check_violation then return query select 'bad_input'::text, null::uuid; return;
  end;
  if v_id is null then return query select 'exists'::text, null::uuid; return; end if;
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_documentation_draft(uuid, text, text, text) from public, anon, authenticated;
grant execute on function projects.record_documentation_draft(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
