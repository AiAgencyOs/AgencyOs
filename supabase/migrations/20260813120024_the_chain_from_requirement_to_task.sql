-- ═══════════════════════════════════════════════════════════════════════════
-- The chain from a requirement to a task.
--
-- Gap G-020, decision ADM-16: *"break approved requirements into modules,
-- features and tasks — the breakdown is automatic"*, listed under what an L2
-- agent may do without asking (ADM-61).
--
-- Two things were missing, and only one of them is a table.
--
-- **The middle level.** `projects.modules` exists and `projects.tasks` carries
-- a `module_id`, so the chain runs module → task. ADM-16 names three levels,
-- and the missing one is where the work is actually described: a module is
-- "Ordering", a task is "write the cart reducer", and the thing a client
-- recognises — "a customer can save a basket" — has had nowhere to live.
--
-- **Provenance.** This is the half that matters. A task could always be
-- created; nothing recorded *why it exists*. So "which of the things the
-- client asked for is this work" and its inverse, "has everything they asked
-- for been built", were both unanswerable — and the second is the question
-- every scope dispute is made of.
--
-- ── the shape, and what it refuses ────────────────────────────────────────
--
-- One function writes the whole chain in one transaction. Not three functions
-- a caller composes: a breakdown that half-succeeded would leave modules with
-- no tasks and no way to tell them from modules whose tasks are still being
-- written.
--
-- It refuses a requirement version that is **not accepted** — directive §12
-- breaks down *approved* requirements, and a proposal an agent extracted and
-- nobody confirmed is not a scope to build against.
--
-- It refuses a requirement version belonging to **another engagement**. The
-- version is keyed to a conversation, the conversation to a CRM lead, and the
-- project reaches that lead through its opportunity. Without the check, a
-- project id and a requirement id from two different engagements produce a
-- plausible-looking breakdown of the wrong client's scope — and it would look
-- entirely correct.
--
-- **`projects.projects.lead_id` is not that lead**, and the first draft of this
-- function used it. It is a foreign key to `core.users`: the *delivery* lead,
-- a member of staff. The name reads like a CRM lead and is not one, which is
-- **G-117**. The route to the CRM lead is `opportunity_id → sales.opportunities.lead_id`.
--
-- A project with no opportunity has no traceable engagement, so a requirement
-- cannot be checked against it at all. That is refused as `unlinked_project`
-- rather than waved through: "we cannot tell" must not resolve to "go ahead"
-- on the one check standing between a plan and the wrong client's scope.
--
-- It breaks down a version **once**. `modules_requirement_version_key` makes
-- the second attempt a no-op answer rather than a duplicated plan, which
-- matters because ADM-16 makes this automatic and an agent that retries is the
-- ordinary case.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The level that was missing
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.features (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  module_id        uuid not null references projects.modules(id) on delete cascade,

  name             text not null check (length(trim(name)) > 0),
  description      text,

  -- The same vocabulary modules use. Deliberately not a richer one: a feature
  -- is done when its tasks are, and inventing states here would create a
  -- second answer to a question the tasks already answer.
  status           text not null default 'not_started' check (status in
                     ('not_started', 'in_progress', 'blocked', 'done')),
  position         int not null default 0 check (position >= 0),

  -- Which approved requirement version this came from. Null for a feature
  -- somebody added by hand, which is a real and permitted thing — the column
  -- says where it came from, not that it must have come from somewhere.
  requirement_version_id uuid references crm.requirement_versions(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (module_id, name)
);

comment on table projects.features is
  'The middle of ADM-16''s chain: a module is "Ordering", a task is "write the cart reducer", and a feature is the thing a client recognises - "a customer can save a basket". Carries the requirement version it was broken down from, so "why does this work exist" has an answer.';

create index if not exists features_module_idx on projects.features (module_id, position);
create index if not exists features_project_idx on projects.features (project_id);
create index if not exists features_requirement_idx
  on projects.features (requirement_version_id)
  where requirement_version_id is not null;

drop trigger if exists set_updated_at on projects.features;
create trigger set_updated_at
  before update on projects.features
  for each row execute function core.set_updated_at();

alter table projects.features enable row level security;

-- The same policies modules carry: internal reads, delivery writes. A client
-- sees deliverables and the portal, not the plan.
drop policy if exists features_select on projects.features;
create policy features_select on projects.features
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists features_write on projects.features;
create policy features_write on projects.features
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Provenance on the levels that already existed
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.modules
  add column if not exists requirement_version_id uuid
    references crm.requirement_versions(id) on delete set null;

alter table projects.tasks
  add column if not exists feature_id uuid
    references projects.features(id) on delete set null,
  add column if not exists requirement_version_id uuid
    references crm.requirement_versions(id) on delete set null;

comment on column projects.modules.requirement_version_id is
  'The approved requirement version this module was broken down from (G-020, ADM-16). Null for a module somebody added by hand.';
comment on column projects.tasks.feature_id is
  'The feature this task implements. Null for a task that belongs to a module directly, or to neither - both remain legal, because work exists that no requirement asked for.';
comment on column projects.tasks.requirement_version_id is
  'The approved requirement version this task traces back to. What makes "has everything the client asked for been built" answerable, which is the question every scope dispute is made of.';

-- One breakdown per requirement version, per project. The second attempt
-- answers rather than duplicating the plan — ADM-16 makes this automatic, so
-- an agent retrying is the ordinary case rather than the exotic one.
create unique index if not exists modules_requirement_version_key
  on projects.modules (project_id, requirement_version_id, name)
  where requirement_version_id is not null;

create index if not exists tasks_feature_idx
  on projects.tasks (feature_id)
  where feature_id is not null;

create index if not exists tasks_requirement_idx
  on projects.tasks (requirement_version_id)
  where requirement_version_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The breakdown
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The payload is the plan, as an array of modules each holding features each
-- holding tasks:
--
--   [{ "name": "Ordering", "description": "...", "features":
--       [{ "name": "Saved basket", "tasks":
--           [{ "title": "Cart reducer", "estimateHours": 4, "priority": "p1" }]}]}]
--
-- Validated here rather than trusted: it arrives from an agent, and a malformed
-- plan must be refused rather than half-written.

create or replace function projects.break_down_requirement(
  p_project_id             uuid,
  p_requirement_version_id uuid,
  p_breakdown              jsonb
)
returns table (
  -- 'broken_down' | 'already_broken_down' | 'project_not_found'
  -- | 'requirement_not_found' | 'not_approved' | 'wrong_project'
  -- | 'unlinked_project' | 'empty'
  outcome  text,
  modules  int,
  features int,
  tasks    int
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_project  projects.projects;
  v_version  crm.requirement_versions;
  v_lead         uuid;
  v_project_lead uuid;
  v_module   jsonb;
  v_feature  jsonb;
  v_task     jsonb;
  v_module_id  uuid;
  v_feature_id uuid;
  v_modules  int := 0;
  v_features int := 0;
  v_tasks    int := 0;
  v_existing int;
  v_mpos     int := 0;
  v_fpos     int := 0;
begin
  -- The lock is on the project, so two agents breaking down the same approved
  -- version at once serialise: the second sees the first's modules and answers
  -- `already_broken_down` rather than writing a second plan.
  select p.* into v_project
    from projects.projects p
   where p.id = p_project_id
     and p.deleted_at is null
   for update;

  if v_project.id is null then
    return query select 'project_not_found'::text, null::int, null::int, null::int;
    return;
  end if;

  select rv.* into v_version
    from crm.requirement_versions rv
   where rv.id = p_requirement_version_id
     and rv.organization_id = v_project.organization_id;

  if v_version.id is null then
    return query select 'requirement_not_found'::text, null::int, null::int, null::int;
    return;
  end if;

  -- Directive §12 breaks down *approved* requirements. A version an agent
  -- extracted and nobody confirmed is a proposal, not a scope.
  if v_version.status <> 'accepted' then
    return query select 'not_approved'::text, null::int, null::int, null::int;
    return;
  end if;

  -- The engagement, through the opportunity. NOT `v_project.lead_id`, which is
  -- a `core.users` reference — the delivery lead, a member of staff (G-117).
  select o.lead_id into v_project_lead
    from sales.opportunities o
   where o.id = v_project.opportunity_id;

  select c.lead_id into v_lead
    from crm.conversations c
   where c.id = v_version.conversation_id;

  if v_project_lead is null then
    -- No opportunity, so no traceable engagement, so nothing to check against.
    -- Refused rather than waved through: "we cannot tell" must not resolve to
    -- "go ahead" on the one check standing between a plan and the wrong
    -- client's scope.
    return query select 'unlinked_project'::text, null::int, null::int, null::int;
    return;
  end if;

  if v_lead is null or v_lead is distinct from v_project_lead then
    return query select 'wrong_project'::text, null::int, null::int, null::int;
    return;
  end if;

  select count(*) into v_existing
    from projects.modules m
   where m.project_id = p_project_id
     and m.requirement_version_id = p_requirement_version_id;

  if v_existing > 0 then
    return query select 'already_broken_down'::text, v_existing, null::int, null::int;
    return;
  end if;

  if p_breakdown is null
     or jsonb_typeof(p_breakdown) <> 'array'
     or jsonb_array_length(p_breakdown) = 0 then
    return query select 'empty'::text, null::int, null::int, null::int;
    return;
  end if;

  for v_module in select * from jsonb_array_elements(p_breakdown) loop
    -- A module with no name is a plan nobody can read. Skipped rather than
    -- refused mid-write: the transaction is all-or-nothing anyway, and a
    -- named-count that disagrees with the payload length is visible to the
    -- caller in the return.
    continue when coalesce(btrim(v_module->>'name'), '') = '';

    insert into projects.modules (
      organization_id, project_id, name, description, position, requirement_version_id
    )
    values (
      v_project.organization_id, p_project_id,
      btrim(v_module->>'name'), v_module->>'description', v_mpos, p_requirement_version_id
    )
    on conflict (project_id, name) do nothing
    returning id into v_module_id;

    -- A module of this name already exists, added by hand or by an earlier
    -- requirement. Adopted rather than duplicated: the name is the identity a
    -- person uses, and two "Ordering" modules would be worse than one shared.
    if v_module_id is null then
      select m.id into v_module_id
        from projects.modules m
       where m.project_id = p_project_id
         and m.name = btrim(v_module->>'name');
    else
      v_modules := v_modules + 1;
    end if;

    v_mpos := v_mpos + 1;
    v_fpos := 0;

    for v_feature in select * from jsonb_array_elements(coalesce(v_module->'features', '[]'::jsonb)) loop
      continue when coalesce(btrim(v_feature->>'name'), '') = '';

      insert into projects.features (
        organization_id, project_id, module_id, name, description, position,
        requirement_version_id
      )
      values (
        v_project.organization_id, p_project_id, v_module_id,
        btrim(v_feature->>'name'), v_feature->>'description', v_fpos, p_requirement_version_id
      )
      on conflict (module_id, name) do nothing
      returning id into v_feature_id;

      if v_feature_id is null then
        select f.id into v_feature_id
          from projects.features f
         where f.module_id = v_module_id
           and f.name = btrim(v_feature->>'name');
      else
        v_features := v_features + 1;
      end if;

      v_fpos := v_fpos + 1;

      for v_task in select * from jsonb_array_elements(coalesce(v_feature->'tasks', '[]'::jsonb)) loop
        continue when coalesce(btrim(v_task->>'title'), '') = '';

        insert into projects.tasks (
          organization_id, project_id, module_id, feature_id, title, description,
          priority, estimate_hours, requirement_version_id
        )
        values (
          v_project.organization_id, p_project_id, v_module_id, v_feature_id,
          btrim(v_task->>'title'), v_task->>'description',
          -- The column's own CHECK is the authority; anything unrecognised
          -- falls back rather than failing a whole plan over one word.
          case when v_task->>'priority' in ('p0','p1','p2','p3') then v_task->>'priority' else 'p2' end,
          case when jsonb_typeof(v_task->'estimateHours') = 'number'
               then (v_task->>'estimateHours')::numeric else null end,
          p_requirement_version_id
        );

        v_tasks := v_tasks + 1;
      end loop;
    end loop;
  end loop;

  if v_modules = 0 and v_features = 0 and v_tasks = 0 then
    return query select 'empty'::text, 0, 0, 0;
    return;
  end if;

  return query select 'broken_down'::text, v_modules, v_features, v_tasks;
end;
$$;

comment on function projects.break_down_requirement(uuid, uuid, jsonb) is
  'Writes the whole module → feature → task chain for one approved requirement version, in one transaction, with the version recorded on every row (G-020, ADM-16). Refuses a version that is not accepted, and one belonging to another project''s lead - which would otherwise produce a plausible breakdown of the wrong client''s scope. Breaking down the same version twice answers rather than duplicating, because ADM-16 makes this automatic and a retrying agent is the ordinary case.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. The question the provenance exists to answer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "Has everything the client asked for been built?" — side-effect free, so a
-- screen can show it without pressing anything. The same shape as
-- `start_readiness` and `production_readiness`, and for the same reason.

create or replace function projects.requirement_coverage(p_project_id uuid)
returns table (
  requirement_version_id uuid,
  version                int,
  modules                int,
  features               int,
  tasks                  int,
  tasks_done             int
)
language sql
stable
security invoker
set search_path = ''
as $$
  select rv.id,
         rv.version,
         (select count(distinct m.id)::int from projects.modules m
           where m.project_id = p_project_id and m.requirement_version_id = rv.id),
         (select count(distinct f.id)::int from projects.features f
           where f.project_id = p_project_id and f.requirement_version_id = rv.id),
         (select count(*)::int from projects.tasks t
           where t.project_id = p_project_id and t.requirement_version_id = rv.id),
         (select count(*)::int from projects.tasks t
           where t.project_id = p_project_id and t.requirement_version_id = rv.id
             and t.status = 'done')
    from crm.requirement_versions rv
   where rv.conversation_id in (
           -- Through the opportunity, for the reason break_down_requirement
           -- gives: projects.lead_id is a core.users reference, the delivery
           -- lead, and joining on it here would silently return nothing.
           select c.id from crm.conversations c
            where c.lead_id = (
              select o.lead_id
                from projects.projects p
                join sales.opportunities o on o.id = p.opportunity_id
               where p.id = p_project_id
            )
         )
     and rv.status = 'accepted'
   order by rv.version desc;
$$;

comment on function projects.requirement_coverage(uuid) is
  'Every accepted requirement version behind a project, and how much of each has been broken down and finished (G-020). The inverse of provenance, and the question every scope dispute is made of: a version with zero tasks is scope nobody has planned.';

revoke all on function projects.break_down_requirement(uuid, uuid, jsonb) from public;
revoke all on function projects.requirement_coverage(uuid) from public;

grant execute on function projects.break_down_requirement(uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function projects.requirement_coverage(uuid) to authenticated, service_role;

grant select, insert, update, delete on projects.features to authenticated, service_role;
