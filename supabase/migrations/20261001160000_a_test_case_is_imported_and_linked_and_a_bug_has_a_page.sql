-- A test case is imported and linked, and a bug has a page — bucket G,
-- stream G-1 (SCR-045 Test Plan & Cases, SCR-047 Bugs & Defects).
--
-- The audit (docs/AGENCYOS_ADMIN_PDF_ELEMENT_AUDIT.md) left five elements
-- PARTIAL on these two screens, and each one comes down to a column or a
-- door the schema did not have:
--
--   SCR-045 "Linked requirement/task"  — a planned case names a scope item by
--                                        foreign key (Doc 14 §3) and nothing
--                                        else; the task that builds it had no
--                                        column to be named in.
--   SCR-045 "Create/import test case"  — one case at a time through
--                                        qa.add_test_plan_item; a plan of
--                                        forty cases was forty forms.
--   SCR-047 "Evidence"                 — one evidence_url on the defect, so
--                                        the second screenshot overwrote the
--                                        first, and the only place evidence
--                                        was listed was the CSV export.
--   SCR-047 "Linked task/build"        — task_id exists (20260929190000); the
--                                        build a fix lands in had no column.
--                                        deliverable_id is a different fact:
--                                        the version the bug was FOUND on,
--                                        which is what the §4.8 gate reads,
--                                        and a bug found on a design is fixed
--                                        in a build.
--   SCR-047 "Bug detail"               — a page, not a column; nothing here.
--
-- What this migration adds:
--
--   1. qa.test_plan_items.task_id (nullable, projects.tasks, same org) and
--      qa.link_test_case_task(p_test_case_id, p_task_id): null unlinks. The
--      task must be on the plan's own project — the FK alone would accept
--      any task in the organization. Allowed on an APPROVED plan: linking a
--      task changes nothing about what is tested, only who is building it,
--      so the "what was approved is what is tested" rule is untouched.
--   2. qa.import_test_cases(p_plan_id, p_cases jsonb): a batch of cases in
--      ONE transaction. The first invalid row refuses the whole batch with
--      its row number and the reason; nothing is written. Audited
--      test_case.imported with the count. A case is what the table already
--      is — a scope item of the plan's baseline (by id or by exact title),
--      a category, a reason, and the optional preconditions / steps /
--      expected result — because the plan model has no free-text case title:
--      a case that names no agreed requirement cannot be planned for (§3).
--   3. qa.defect_evidence: an append-only list of URLs and notes per defect,
--      with qa.add_defect_evidence(p_defect_id, p_kind, p_value). Never
--      edited, never deleted — evidence is evidence. The existing
--      qa.defects.evidence_url stays and the page renders both.
--   4. qa.defects.build_id (nullable, projects.deliverables of kind 'build',
--      same project) and qa.link_defect_build(p_defect_id, p_build_id).
--      There is no separate builds table: a build is a projects.deliverables
--      row of kind 'build' (the Builds tab and qa.test_runs both point there).
--
-- Roles: the case doors use core.can_manage_delivery() like every other
-- test-plan door (project.write in the service). Evidence uses
-- core.can_write() — a member is the developer who submits the fix, and Doc
-- 14 §18 admits manual testing by that role (the same choice
-- qa.assign_retest and qa.record_test_run made). The build link uses
-- core.can_manage_delivery(), the roles the defects_write policy names.
--
-- Every new table: organization_id, RLS enabled and forced, internal select,
-- role-named writes, tenancy triggers on every org-scoped FK, freeze trigger,
-- grants. Every governed write audits through core.record_audit inside the
-- transaction.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. a planned case may name the task that builds it
-- ═══════════════════════════════════════════════════════════════════════════

alter table qa.test_plan_items
  add column if not exists task_id uuid references projects.tasks(id) on delete set null;

comment on column qa.test_plan_items.task_id is
  'SCR-045: the project task whose work this case exercises, linked through qa.link_test_case_task. Same project as the plan — the door checks; the FK alone would accept any task in the organization. Null means nobody linked one.';

create index if not exists test_plan_items_task_idx
  on qa.test_plan_items (organization_id, task_id) where task_id is not null;

drop trigger if exists org_match_test_plan_items_task on qa.test_plan_items;
create trigger org_match_test_plan_items_task
  before insert or update of task_id, organization_id on qa.test_plan_items
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

create or replace function qa.link_test_case_task(
  p_test_case_id uuid,
  p_task_id      uuid default null
)
returns table (
  -- 'linked' | 'unlinked'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'task_not_on_project'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid;
  v_project  uuid;
  v_before   uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select i.organization_id, tp.project_id, i.task_id
    into v_org, v_project, v_before
    from qa.test_plan_items i
    join qa.test_plans tp on tp.id = i.plan_id
   where i.id = p_test_case_id
     and i.organization_id = (select core.current_organization_id())
     for update of i;

  if v_org is null then
    return query select 'not_found'::text; return;
  end if;

  if p_task_id is not null and not exists (
    select 1 from projects.tasks t
     where t.id = p_task_id
       and t.project_id = v_project
       and t.organization_id = v_org
  ) then
    return query select 'task_not_on_project'::text; return;
  end if;

  update qa.test_plan_items
     set task_id = p_task_id
   where id = p_test_case_id;

  perform core.record_audit(
    v_org,
    case when p_task_id is null then 'test_case.task_unlinked' else 'test_case.task_linked' end,
    'test_case', p_test_case_id,
    jsonb_build_object('task_id', v_before),
    jsonb_build_object('task_id', p_task_id)
  );

  return query select (case when p_task_id is null then 'unlinked' else 'linked' end)::text;
end;
$$;

comment on function qa.link_test_case_task(uuid, uuid) is
  'SCR-045: links a planned test case to one of its project''s tasks (null unlinks). can_manage_delivery(). Refuses task_not_on_project. Allowed on an approved plan — the link changes who builds the case, not what is tested. Audits test_case.task_linked / test_case.task_unlinked.';

revoke all on function qa.link_test_case_task(uuid, uuid) from public, anon;
grant execute on function qa.link_test_case_task(uuid, uuid) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. a batch of cases is imported in one transaction, or not at all
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Each element of p_cases is an object:
--   requirement     text  — a scope item of the plan's baseline: its id, or
--                           its exact title (case-insensitive). Required.
--   category        text  — one of Doc 14 §6's eleven. Required.
--   reason          text  — why this category applies (1–600). Required.
--   critical_path   bool  — optional, default false.
--   preconditions, steps, expected_result — optional text.
--   task            uuid  — optional: a task on the plan's project to link.
--
-- The loop runs inside a nested block. A row that fails raises, the block's
-- exception clause catches it, and Postgres rolls the block's writes back —
-- so a batch of forty with a bad thirty-ninth writes nothing, and the
-- refusal says which row and why.

create or replace function qa.import_test_cases(
  p_plan_id uuid,
  p_cases   jsonb
)
returns table (
  -- 'imported' (imported = the count)
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'plan_approved' |
  --           'empty_batch' | 'not_an_array' | 'invalid_row' (row_number, detail)
  outcome    text,
  imported   int,
  row_number int,
  detail     text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor          uuid := (select auth.uid());
  v_org            uuid;
  v_project        uuid;
  v_scope_version  uuid;
  v_plan_status    text;
  v_count          int := 0;
  v_ids            uuid[] := '{}';
  v_row            int := 0;
  v_case           jsonb;
  v_ref            text;
  v_scope_item     uuid;
  v_matches        int;
  v_category       text;
  v_reason         text;
  v_task           uuid;
  v_new            uuid;
  v_message        text;
begin
  if v_actor is null then
    return query select 'no_actor'::text, 0, null::int, null::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, 0, null::int, null::text; return;
  end if;

  if p_cases is null or jsonb_typeof(p_cases) <> 'array' then
    return query select 'not_an_array'::text, 0, null::int, null::text; return;
  end if;

  if jsonb_array_length(p_cases) = 0 then
    return query select 'empty_batch'::text, 0, null::int, null::text; return;
  end if;

  select tp.organization_id, tp.project_id, tp.scope_version_id, tp.status
    into v_org, v_project, v_scope_version, v_plan_status
    from qa.test_plans tp
   where tp.id = p_plan_id
     and tp.organization_id = (select core.current_organization_id())
     for update;

  if v_org is null then
    return query select 'not_found'::text, 0, null::int, null::text; return;
  end if;

  -- What was approved is what is tested (qa.approve_test_plan).
  if v_plan_status = 'approved' then
    return query select 'plan_approved'::text, 0, null::int, null::text; return;
  end if;

  begin
    for v_case in select value from jsonb_array_elements(p_cases) loop
      v_row := v_row + 1;

      if jsonb_typeof(v_case) <> 'object' then
        raise exception 'not an object';
      end if;

      -- the requirement: a scope item of THIS plan's baseline, by id or title
      v_ref := nullif(btrim(coalesce(v_case->>'requirement', '')), '');
      if v_ref is null then
        raise exception 'requirement is missing';
      end if;

      select count(*), (array_agg(si.id))[1]
        into v_matches, v_scope_item
        from projects.scope_items si
       where si.scope_version_id = v_scope_version
         and si.organization_id = v_org
         and (si.id::text = v_ref or lower(btrim(si.title)) = lower(v_ref));

      if v_matches = 0 then
        raise exception 'requirement "%" is not in the plan''s baseline', v_ref;
      elsif v_matches > 1 then
        raise exception 'requirement "%" names more than one scope item; use its id', v_ref;
      end if;

      -- the category: Doc 14 §6's eleven and no twelfth
      v_category := lower(btrim(coalesce(v_case->>'category', '')));
      if v_category not in (
        'functional', 'ui', 'api', 'database', 'integration', 'e2e',
        'regression', 'security', 'performance', 'compatibility', 'smoke'
      ) then
        raise exception 'category "%" is not a testing category this system recognises', v_category;
      end if;

      -- the reason: required, 1–600 (the table's own check)
      v_reason := nullif(btrim(coalesce(v_case->>'reason', '')), '');
      if v_reason is null then
        raise exception 'reason is missing';
      end if;
      if length(v_reason) > 600 then
        raise exception 'reason is longer than 600 characters';
      end if;

      -- an optional task, on the plan's own project
      v_task := null;
      if nullif(btrim(coalesce(v_case->>'task', '')), '') is not null then
        begin
          v_task := (v_case->>'task')::uuid;
        exception when invalid_text_representation then
          raise exception 'task "%" is not a task id', v_case->>'task';
        end;
        if not exists (
          select 1 from projects.tasks t
           where t.id = v_task and t.project_id = v_project and t.organization_id = v_org
        ) then
          raise exception 'task % is not on this project', v_task;
        end if;
      end if;

      insert into qa.test_plan_items (
        organization_id, plan_id, scope_item_id, category, reason, critical_path,
        preconditions, steps, expected_result, task_id
      )
      values (
        v_org, p_plan_id, v_scope_item, v_category, v_reason,
        coalesce((v_case->>'critical_path')::boolean, false),
        nullif(btrim(coalesce(v_case->>'preconditions', '')), ''),
        nullif(btrim(coalesce(v_case->>'steps', '')), ''),
        nullif(btrim(coalesce(v_case->>'expected_result', '')), ''),
        v_task
      )
      on conflict (plan_id, scope_item_id, category) do nothing
      returning qa.test_plan_items.id into v_new;

      if v_new is null then
        raise exception 'requirement "%" already has a % case planned (one case per requirement and category)', v_ref, v_category;
      end if;

      v_count := v_count + 1;
      v_ids := v_ids || v_new;
    end loop;
  exception
    when others then
      -- Every insert above is rolled back with this block. Postgres's own
      -- wording for a constraint it refused is kept — it is the reason.
      get stacked diagnostics v_message = message_text;
      return query select 'invalid_row'::text, 0, v_row, v_message;
      return;
  end;

  perform core.record_audit(
    v_org, 'test_case.imported', 'test_plan', p_plan_id,
    null,
    jsonb_build_object('count', v_count, 'item_ids', to_jsonb(v_ids))
  );

  return query select 'imported'::text, v_count, null::int, null::text;
end;
$$;

comment on function qa.import_test_cases(uuid, jsonb) is
  'SCR-045: imports a batch of test cases into a draft plan in ONE transaction. Each case names a scope item of the plan''s baseline (id or exact title), a category and a reason; preconditions, steps, expected_result, critical_path and a task are optional. The first invalid row refuses the whole batch (invalid_row, with row_number and detail) and nothing is written. can_manage_delivery(). Refuses plan_approved. Audits test_case.imported with the count.';

revoke all on function qa.import_test_cases(uuid, jsonb) from public, anon;
grant execute on function qa.import_test_cases(uuid, jsonb) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. evidence is a list, appended and never edited
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.defect_evidence (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  defect_id       uuid not null references qa.defects(id) on delete cascade,
  kind            text not null check (kind in ('url', 'note')),
  value           text not null check (length(btrim(value)) between 1 and 2000),
  added_by        uuid references core.users(id) on delete set null,
  added_at        timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table qa.defect_evidence is
  'SCR-047: what shows the bug is real, and later what shows it is fixed — a link (url) or words (note) per row, appended by whoever has it and never edited or deleted. The defect''s own evidence_url is the first of these and stays where it is.';

create index if not exists defect_evidence_defect_idx
  on qa.defect_evidence (organization_id, defect_id, added_at);

drop trigger if exists set_updated_at on qa.defect_evidence;
create trigger set_updated_at before update on qa.defect_evidence
  for each row execute function core.set_updated_at();

alter table qa.defect_evidence enable row level security;
alter table qa.defect_evidence force row level security;

drop policy if exists defect_evidence_select on qa.defect_evidence;
create policy defect_evidence_select on qa.defect_evidence
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- can_write(): owner, ops_admin, delivery_lead, member — the developer who
-- submits the fix is a member, and their screenshot is the evidence.
drop policy if exists defect_evidence_insert on qa.defect_evidence;
create policy defect_evidence_insert on qa.defect_evidence
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop trigger if exists org_match_defect_evidence_defect on qa.defect_evidence;
create trigger org_match_defect_evidence_defect
  before insert or update of defect_id, organization_id on qa.defect_evidence
  for each row execute function core.enforce_parent_org('defect_id', 'qa.defects');

drop trigger if exists freeze_org_defect_evidence on qa.defect_evidence;
create trigger freeze_org_defect_evidence
  before update of organization_id on qa.defect_evidence
  for each row execute function core.freeze_organization_id();

grant select, insert on qa.defect_evidence to authenticated, service_role;

create or replace function qa.add_defect_evidence(
  p_defect_id uuid,
  p_kind      text,
  p_value     text
)
returns table (
  -- 'added'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'bad_kind' | 'bad_value'
  outcome text,
  id      uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_value text := btrim(coalesce(p_value, ''));
  v_new   uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  if p_kind not in ('url', 'note') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;

  if length(v_value) = 0 or length(v_value) > 2000
     or (p_kind = 'url' and v_value !~* '^https?://[^[:space:]]+$') then
    return query select 'bad_value'::text, null::uuid; return;
  end if;

  select d.organization_id into v_org
    from qa.defects d
   where d.id = p_defect_id
     and d.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  insert into qa.defect_evidence (organization_id, defect_id, kind, value, added_by)
  values (v_org, p_defect_id, p_kind, v_value, v_actor)
  returning qa.defect_evidence.id into v_new;

  perform core.record_audit(
    v_org, 'defect.evidence_added', 'defect', p_defect_id,
    null,
    jsonb_build_object('evidence_id', v_new, 'kind', p_kind)
  );

  return query select 'added'::text, v_new;
end;
$$;

comment on function qa.add_defect_evidence(uuid, text, text) is
  'SCR-047: appends one piece of evidence (a http(s) url, or a note of at most 2000 characters) to a defect. can_write() — the developer submitting the fix is a member. Never edits or removes. Audits defect.evidence_added.';

revoke all on function qa.add_defect_evidence(uuid, text, text) from public, anon;
grant execute on function qa.add_defect_evidence(uuid, text, text) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. a defect names the build its fix lands in
-- ═══════════════════════════════════════════════════════════════════════════

alter table qa.defects
  add column if not exists build_id uuid references projects.deliverables(id) on delete set null;

comment on column qa.defects.build_id is
  'SCR-047: the build (a projects.deliverables row of kind build, same project) the fix for this defect lands in, linked through qa.link_defect_build. Distinct from deliverable_id, which is the version the bug was FOUND on and is what the section 4.8 gate reads.';

create index if not exists defects_build_idx
  on qa.defects (organization_id, build_id) where build_id is not null;

drop trigger if exists org_match_defects_build on qa.defects;
create trigger org_match_defects_build
  before insert or update of build_id, organization_id on qa.defects
  for each row execute function core.enforce_parent_org('build_id', 'projects.deliverables');

create or replace function qa.link_defect_build(
  p_defect_id uuid,
  p_build_id  uuid default null
)
returns table (
  -- 'linked' | 'unlinked'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_a_build' | 'wrong_project' | 'settled'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_defect  qa.defects;
  v_kind    text;
  v_project uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;

  select * into v_defect
    from qa.defects d
   where d.id = p_defect_id
     and d.organization_id = (select core.current_organization_id())
     for update;

  if v_defect.id is null then
    return query select 'not_found'::text; return;
  end if;

  -- A settled defect is not re-triaged (the same rule triageDefect holds).
  if v_defect.status in ('verified', 'wontfix') then
    return query select 'settled'::text; return;
  end if;

  if p_build_id is not null then
    select d.kind, d.project_id into v_kind, v_project
      from projects.deliverables d
     where d.id = p_build_id
       and d.organization_id = v_defect.organization_id;

    if v_kind is null then
      return query select 'not_found'::text; return;
    end if;
    if v_kind <> 'build' then
      return query select 'not_a_build'::text; return;
    end if;
    if v_project <> v_defect.project_id then
      return query select 'wrong_project'::text; return;
    end if;
  end if;

  update qa.defects
     set build_id = p_build_id, updated_at = now()
   where id = v_defect.id;

  perform core.record_audit(
    v_defect.organization_id,
    case when p_build_id is null then 'defect.build_unlinked' else 'defect.build_linked' end,
    'defect', v_defect.id,
    jsonb_build_object('build_id', v_defect.build_id),
    jsonb_build_object('build_id', p_build_id)
  );

  return query select (case when p_build_id is null then 'unlinked' else 'linked' end)::text;
end;
$$;

comment on function qa.link_defect_build(uuid, uuid) is
  'SCR-047: links a defect to the build its fix lands in (null unlinks). can_manage_delivery() — the roles defects_write names. Refuses not_a_build (a design is reviewed, not built), wrong_project, and settled. Audits defect.build_linked / defect.build_unlinked.';

revoke all on function qa.link_defect_build(uuid, uuid) from public, anon;
grant execute on function qa.link_defect_build(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
