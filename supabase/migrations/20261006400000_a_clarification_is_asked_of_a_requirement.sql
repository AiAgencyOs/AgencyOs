-- ═══════════════════════════════════════════════════════════════════════════
-- A clarification is asked of a requirement.
--
-- PDF SCR-028/029 "Request client clarification". The only clarification that
-- existed was a plan question (projects.plan_clarifications), which needs a
-- live plan — so on a project without a plan the Requirements dashboard could
-- not ask anything, and a question never reached the requirement it was about.
--
--   projects.requirement_clarifications   one question about ONE requirement
--                                         (scope item), open until answered
--
-- Append-and-answer: a question is raised once and answered once (the answer
-- is a column on the same row, with who and when). No edit, no delete.
-- RLS enabled and forced, internal SELECT, NO write grant for authenticated.
-- Doors (security definer, role re-checked, audited):
--
--   projects.raise_requirement_clarification(scope_item, question, impact)
--   projects.answer_requirement_clarification(clarification, answer)
--
-- Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.requirement_clarifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  scope_item_id   uuid not null references projects.scope_items(id) on delete cascade,
  question        text not null check (length(btrim(question)) between 1 and 1000),
  impact          text not null check (length(btrim(impact)) between 1 and 1000),
  status          text not null default 'open' check (status in ('open', 'answered')),
  raised_by       uuid references core.users(id) on delete set null,
  raised_at       timestamptz not null default now(),
  answer          text check (answer is null or length(btrim(answer)) between 1 and 2000),
  answered_by     uuid references core.users(id) on delete set null,
  answered_at     timestamptz,
  constraint requirement_clarifications_answer_shape check ((status = 'answered') = (answer is not null and answered_at is not null))
);

comment on table projects.requirement_clarifications is
  'SCR-028/029: a question about one requirement (scope item), asked without needing a plan. Open until answered. No write grant for authenticated: only projects.raise_requirement_clarification and projects.answer_requirement_clarification write it, and both audit.';

create index if not exists requirement_clarifications_item_idx on projects.requirement_clarifications (scope_item_id, raised_at);
create index if not exists requirement_clarifications_project_idx on projects.requirement_clarifications (organization_id, project_id, status);

drop trigger if exists org_match_requirement_clarifications_item on projects.requirement_clarifications;
create trigger org_match_requirement_clarifications_item
  before insert or update of scope_item_id, organization_id on projects.requirement_clarifications
  for each row execute function core.enforce_parent_org('scope_item_id', 'projects.scope_items');

drop trigger if exists org_match_requirement_clarifications_project on projects.requirement_clarifications;
create trigger org_match_requirement_clarifications_project
  before insert or update of project_id, organization_id on projects.requirement_clarifications
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_requirement_clarifications on projects.requirement_clarifications;
create trigger freeze_org_requirement_clarifications
  before update of organization_id on projects.requirement_clarifications
  for each row execute function core.freeze_organization_id();

alter table projects.requirement_clarifications enable row level security;
alter table projects.requirement_clarifications force row level security;

drop policy if exists requirement_clarifications_select on projects.requirement_clarifications;
create policy requirement_clarifications_select on projects.requirement_clarifications
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on projects.requirement_clarifications from public, anon, authenticated;
grant select on projects.requirement_clarifications to authenticated;
grant select, insert, update, delete on projects.requirement_clarifications to service_role;

create or replace function projects.raise_requirement_clarification(p_scope_item_id uuid, p_question text, p_impact text)
returns table (outcome text, clarification_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_question text := btrim(coalesce(p_question, ''));
  v_impact   text := btrim(coalesce(p_impact, ''));
  v_project  uuid;
  v_id       uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if length(v_question) = 0 or length(v_impact) = 0 then
    return query select 'empty'::text, null::uuid; return;
  end if;
  if length(v_question) > 1000 or length(v_impact) > 1000 then
    return query select 'too_long'::text, null::uuid; return;
  end if;

  select v.project_id into v_project
    from projects.scope_items i
    join projects.scope_versions v on v.id = i.scope_version_id
   where i.id = p_scope_item_id and i.organization_id = v_org;
  if v_project is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  insert into projects.requirement_clarifications (organization_id, project_id, scope_item_id, question, impact, raised_by)
  values (v_org, v_project, p_scope_item_id, v_question, v_impact, v_actor)
  returning id into v_id;

  perform core.record_audit(v_org, 'requirement.clarification_raised', 'scope_item', p_scope_item_id, null,
    jsonb_build_object('clarification_id', v_id, 'project_id', v_project));

  return query select 'raised'::text, v_id;
end;
$$;

revoke all on function projects.raise_requirement_clarification(uuid, text, text) from public, anon;
grant execute on function projects.raise_requirement_clarification(uuid, text, text) to authenticated, service_role;

create or replace function projects.answer_requirement_clarification(p_clarification_id uuid, p_answer text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_answer text := btrim(coalesce(p_answer, ''));
  v_row    projects.requirement_clarifications%rowtype;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if length(v_answer) = 0 then
    return query select 'empty'::text; return;
  end if;
  if length(v_answer) > 2000 then
    return query select 'too_long'::text; return;
  end if;

  select * into v_row from projects.requirement_clarifications where id = p_clarification_id and organization_id = v_org for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;
  if v_row.status = 'answered' then
    return query select 'already_answered'::text; return;
  end if;

  update projects.requirement_clarifications
     set status = 'answered', answer = v_answer, answered_by = v_actor, answered_at = now()
   where id = p_clarification_id;

  perform core.record_audit(v_org, 'requirement.clarification_answered', 'scope_item', v_row.scope_item_id, null,
    jsonb_build_object('clarification_id', p_clarification_id, 'project_id', v_row.project_id));

  return query select 'answered'::text;
end;
$$;

revoke all on function projects.answer_requirement_clarification(uuid, text) from public, anon;
grant execute on function projects.answer_requirement_clarification(uuid, text) to authenticated, service_role;
