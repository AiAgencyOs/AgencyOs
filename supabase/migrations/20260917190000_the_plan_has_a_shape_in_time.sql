-- ═══════════════════════════════════════════════════════════════════════════
-- The plan has a shape in time.
--
-- Project Planning §4.3, §7, §11, §15, PLAN-I05.
--
-- G-256 built what a project delivers and what it depends on. It did **not**
-- build the sequence those sit in, and said so: *"G-256 built deliverables and
-- dependencies, NOT an operational milestone object."* This is that object.
--
-- ── §7 asks for three maps, and they are one register ────────────────────
--
--   *"Major milestone map. Finance milestone map where relevant. Client
--    approval points."*
--
-- Three lists in a document, one shape in a database: each is a point in the
-- operational sequence with a condition attached. They differ by `kind`, not
-- by table — three tables would be three sets of triggers, policies and freeze
-- rules to keep honest for no difference anybody can act on.
--
-- ── the finance kind REFERENCES; it does not duplicate ───────────────────
--
-- `projects.milestones` is the PAYMENT milestone — ADM-105's 30/20/30/20, with
-- its own invoices and its own verification. §7 wants it *mapped onto* the
-- operational sequence, not copied into it. So a `finance_gate` row must name
-- a real payment milestone and carries no amount, no percentage and no status
-- of its own: a constraint, both ways, so a finance gate pointing at nothing
-- and an operational milestone pointing at a payment row are equally
-- unstorable.
--
-- This is the same rule G-256 stated and the reason it refused to overload
-- `projects.milestones` in the first place.
--
-- ── §11's timeline rules, as constraints ─────────────────────────────────
--
--   *"Represent uncertainty as estimates/windows/assumptions rather than false
--    certainty."*
--   *"Do not compress the timeline merely to satisfy a requested date without
--    evidence."*
--
-- A window is storable only with a stated `timing_basis` — the identical rule
-- `plan_dependencies` carries, and deliberately identical: a date on a
-- milestone is exactly as much of a promise as a date on a dependency, and two
-- different standards for the same kind of claim is how one of them rots.
--
-- ── and §15's "gate criteria" is not optional ────────────────────────────
--
-- §4.6: *"do not equate 'agent says done' with completion."* A milestone
-- nobody can say the condition for is a milestone somebody will declare met
-- because the date passed. `gate_criteria` is NOT NULL.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.plan_milestones (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.project_plans(id) on delete cascade,

  position         int not null default 0,
  name             text not null check (length(btrim(name)) between 1 and 300),

  -- §7's three maps.
  kind             text not null check (kind in ('operational', 'finance_gate', 'client_approval')),

  -- The same locked vocabulary the deliverables register uses. One list, so a
  -- deliverable and the milestone that releases it cannot disagree about which
  -- phase they are in.
  phase            text not null check (phase in (
    'phase_2', 'phase_3', 'phase_4', 'phase_5', 'phase_6', 'phase_7'
  )),

  -- §15's "gate criteria", and §4.6's rule behind it.
  gate_criteria    text not null check (length(btrim(gate_criteria)) > 0),

  -- §11. Identical to `plan_dependencies`, on purpose.
  target_window_start date,
  target_window_end   date,
  timing_basis     text,
  constraint plan_milestones_dates_need_a_basis check (
    (target_window_start is null and target_window_end is null)
    or (timing_basis is not null and length(btrim(timing_basis)) > 0)
  ),
  constraint plan_milestones_window_is_ordered check (
    target_window_start is null or target_window_end is null
    or target_window_end >= target_window_start
  ),

  -- §7's finance map, as a reference. Required for a finance gate and refused
  -- for anything else — both directions, so neither half of the claim can be
  -- made without the other.
  payment_milestone_id uuid references projects.milestones(id) on delete restrict,
  constraint plan_milestones_finance_gate_names_its_milestone check (
    (kind = 'finance_gate') = (payment_milestone_id is not null)
  ),

  -- `at_risk` and `missed` are states a person sets. Nothing here derives them
  -- from a date: a milestone is not late because the clock says so, it is late
  -- because somebody looked and decided, which is the same reason
  -- `gate_criteria` exists.
  status           text not null default 'planned' check (status in
                     ('planned', 'at_risk', 'met', 'missed', 'not_applicable')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists plan_milestones_plan_idx
  on projects.plan_milestones (plan_id, position);

comment on table projects.plan_milestones is
  'Project Planning section 7 and section 15 - the operational sequence, the finance gates mapped onto it, and the client approval points, as one register distinguished by kind. A finance_gate REFERENCES projects.milestones rather than copying it: the payment milestone owns the money, and section 7 asks for it to be mapped onto the sequence, not duplicated into it.';

comment on column projects.plan_milestones.status is
  'Set by a person. Nothing derives at_risk or missed from a date - a milestone is not late because the clock says so, it is late because somebody looked and decided, which is the same reason gate_criteria is not null.';

-- ── §15's "dependencies", as the many-to-many it actually is ─────────────
--
-- A milestone waits on several things and a dependency blocks several
-- milestones. A single FK either way would force one of those to be a lie.

create table if not exists projects.plan_milestone_dependencies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  milestone_id     uuid not null references projects.plan_milestones(id) on delete cascade,
  dependency_id    uuid not null references projects.plan_dependencies(id) on delete cascade,
  created_at       timestamptz not null default now(),
  unique (milestone_id, dependency_id)
);

comment on table projects.plan_milestone_dependencies is
  'Project Planning section 15 - which dependencies gate which operational milestones. A many-to-many because a milestone waits on several things and a dependency blocks several milestones; a single foreign key either way would force one of those to be a lie. Section 11 asks which work can proceed while something else waits, and that is this table read the other way rather than a column somebody has to keep in step.';

-- ── both tables join the plan's freeze ───────────────────────────────────
--
-- `projects.refuse_write_to_settled_plan` already exists and already says the
-- right thing; it is reused rather than copied. The join table reaches the
-- plan through its milestone, so it gets its own guard.

drop trigger if exists refuse_write_to_settled_plan_milestones on projects.plan_milestones;
create trigger refuse_write_to_settled_plan_milestones
  before insert or update or delete on projects.plan_milestones
  for each row execute function projects.refuse_write_to_settled_plan();

create or replace function projects.refuse_write_to_settled_plan_via_milestone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_ms     uuid := coalesce(new.milestone_id, old.milestone_id);
begin
  select pp.status into v_status
    from projects.plan_milestones pm
    join projects.project_plans pp on pp.id = pm.plan_id
   where pm.id = v_ms;
  if v_status is distinct from 'draft' then
    raise exception 'plan for milestone % is % — its registers change by drafting the next version', v_ms, coalesce(v_status, 'missing')
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists refuse_write_to_settled_plan_milestone_deps on projects.plan_milestone_dependencies;
create trigger refuse_write_to_settled_plan_milestone_deps
  before insert or update or delete on projects.plan_milestone_dependencies
  for each row execute function projects.refuse_write_to_settled_plan_via_milestone();

-- ── tenancy, written out so a static check can see it ────────────────────

alter table projects.plan_milestones enable row level security;
alter table projects.plan_milestones force row level security;
alter table projects.plan_milestone_dependencies enable row level security;
alter table projects.plan_milestone_dependencies force row level security;

drop policy if exists plan_milestones_select on projects.plan_milestones;
create policy plan_milestones_select on projects.plan_milestones
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists plan_milestone_dependencies_select on projects.plan_milestone_dependencies;
create policy plan_milestone_dependencies_select on projects.plan_milestone_dependencies
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists org_match_plan_milestones_plan on projects.plan_milestones;
create trigger org_match_plan_milestones_plan
  before insert or update of plan_id, organization_id on projects.plan_milestones
  for each row execute function core.enforce_parent_org('plan_id', 'projects.project_plans');

drop trigger if exists org_match_plan_milestones_payment on projects.plan_milestones;
create trigger org_match_plan_milestones_payment
  before insert or update of payment_milestone_id, organization_id on projects.plan_milestones
  for each row execute function core.enforce_parent_org('payment_milestone_id', 'projects.milestones');

drop trigger if exists org_match_plan_milestone_deps_milestone on projects.plan_milestone_dependencies;
create trigger org_match_plan_milestone_deps_milestone
  before insert or update of milestone_id, organization_id on projects.plan_milestone_dependencies
  for each row execute function core.enforce_parent_org('milestone_id', 'projects.plan_milestones');

drop trigger if exists org_match_plan_milestone_deps_dependency on projects.plan_milestone_dependencies;
create trigger org_match_plan_milestone_deps_dependency
  before insert or update of dependency_id, organization_id on projects.plan_milestone_dependencies
  for each row execute function core.enforce_parent_org('dependency_id', 'projects.plan_dependencies');

drop trigger if exists freeze_org_plan_milestones on projects.plan_milestones;
create trigger freeze_org_plan_milestones
  before update of organization_id on projects.plan_milestones
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_plan_milestone_dependencies on projects.plan_milestone_dependencies;
create trigger freeze_org_plan_milestone_dependencies
  before update of organization_id on projects.plan_milestone_dependencies
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_plan_milestones on projects.plan_milestones;
create trigger set_updated_at_plan_milestones
  before update on projects.plan_milestones
  for each row execute function core.set_updated_at();

grant select on projects.plan_milestones, projects.plan_milestone_dependencies to authenticated;
grant select, insert, update, delete on projects.plan_milestones, projects.plan_milestone_dependencies to service_role;

-- ── the doors ────────────────────────────────────────────────────────────

create or replace function projects.add_plan_milestone(
  p_plan_id uuid,
  p_name text,
  p_kind text,
  p_phase text,
  p_gate_criteria text,
  p_payment_milestone_id uuid default null,
  p_window_start date default null,
  p_window_end date default null,
  p_timing_basis text default null,
  p_position int default 0
)
returns table (
  -- 'added' | 'not_draft' | 'unknown_plan' | 'dates_need_a_basis'
  -- | 'finance_gate_needs_a_milestone' | 'only_finance_gates_name_a_milestone'
  -- | 'wrong_project' | 'needs_person' | 'forbidden'
  outcome text,
  milestone_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_pm    projects.milestones;
  v_new   uuid;
begin
  -- §11, refused before the lock and by name.
  if (p_window_start is not null or p_window_end is not null)
     and coalesce(btrim(coalesce(p_timing_basis, '')), '') = '' then
    return query select 'dates_need_a_basis'::text, null::uuid; return;
  end if;

  -- §7's finance map, both directions, named rather than left to a constraint.
  if p_kind = 'finance_gate' and p_payment_milestone_id is null then
    return query select 'finance_gate_needs_a_milestone'::text, null::uuid; return;
  end if;
  if p_kind <> 'finance_gate' and p_payment_milestone_id is not null then
    return query select 'only_finance_gates_name_a_milestone'::text, null::uuid; return;
  end if;

  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  -- A finance gate must map THIS project's payment milestone. Pointing at
  -- another project's would put that client's money in this client's plan.
  if p_payment_milestone_id is not null then
    select m.* into v_pm from projects.milestones m where m.id = p_payment_milestone_id;
    if v_pm.id is null or v_pm.project_id is distinct from v_plan.project_id then
      return query select 'wrong_project'::text, null::uuid; return;
    end if;
  end if;

  insert into projects.plan_milestones (
    organization_id, plan_id, position, name, kind, phase, gate_criteria,
    target_window_start, target_window_end, timing_basis, payment_milestone_id
  ) values (
    v_plan.organization_id, v_plan.id, coalesce(p_position, 0), p_name, p_kind, p_phase, p_gate_criteria,
    p_window_start, p_window_end, nullif(btrim(coalesce(p_timing_basis, '')), ''), p_payment_milestone_id
  )
  returning id into v_new;

  return query select 'added'::text, v_new;
end;
$$;

comment on function projects.add_plan_milestone(uuid, text, text, text, text, uuid, date, date, text, int) is
  'Project Planning section 7 and section 15. Refuses a dated window with no stated basis, a finance gate naming no payment milestone, anything else naming one, and a payment milestone belonging to another project - each by name, and each also enforced as a constraint.';

create or replace function projects.gate_plan_milestone(
  p_milestone_id uuid,
  p_dependency_id uuid
)
returns table (
  -- 'gated' | 'already_gated' | 'not_draft' | 'unknown_milestone'
  -- | 'unknown_dependency' | 'different_plan' | 'needs_person' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_ms    projects.plan_milestones;
  v_dep   projects.plan_dependencies;
  v_plan  projects.project_plans;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'needs_person'::text; return;
  end if;

  select pm.* into v_ms from projects.plan_milestones pm where pm.id = p_milestone_id;
  if v_ms.id is null then
    return query select 'unknown_milestone'::text; return;
  end if;

  select pd.* into v_dep from projects.plan_dependencies pd where pd.id = p_dependency_id;
  if v_dep.id is null then
    return query select 'unknown_dependency'::text; return;
  end if;

  -- Both must belong to the SAME plan. A milestone gated by another plan's
  -- dependency is a wait nobody will ever satisfy.
  if v_dep.plan_id is distinct from v_ms.plan_id then
    return query select 'different_plan'::text; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = v_ms.plan_id for update;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text; return;
  end if;

  insert into projects.plan_milestone_dependencies (organization_id, milestone_id, dependency_id)
  values (v_ms.organization_id, v_ms.id, v_dep.id)
  on conflict (milestone_id, dependency_id) do nothing;

  if not found then
    return query select 'already_gated'::text; return;
  end if;

  return query select 'gated'::text;
end;
$$;

comment on function projects.gate_plan_milestone(uuid, uuid) is
  'Project Planning section 15 - which dependency gates which milestone. Refuses a dependency from another plan: a milestone waiting on something outside its own plan is a wait nobody will ever satisfy.';

revoke all on function projects.add_plan_milestone(uuid, text, text, text, text, uuid, date, date, text, int) from public;
revoke all on function projects.gate_plan_milestone(uuid, uuid) from public;

grant execute on function projects.add_plan_milestone(uuid, text, text, text, text, uuid, date, date, text, int) to authenticated, service_role;
grant execute on function projects.gate_plan_milestone(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
