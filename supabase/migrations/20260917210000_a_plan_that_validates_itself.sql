-- ═══════════════════════════════════════════════════════════════════════════
-- A plan that validates itself.
--
-- Project Planning §18, PLAN-I09.
--
-- §18 lists ten validation rules. **Six of them are already structural** and
-- this migration deliberately does not re-check them:
--
--   * *every deliverable has a source reference* — a CHECK on
--     `plan_deliverables` (G-256);
--   * *dependencies have owners* — `owner_role` is NOT NULL (G-256);
--   * *no unresolved ambiguity is silently converted into scope* — activation
--     already refuses a plan carrying an open clarification (G-257);
--   * *no development-level technical implementation plan is present* — the
--     schema has nowhere to put one (G-256);
--   * *plan schema validates* — the constraints are the schema;
--   * *plan is versioned and auditable* — one active, one draft, a reason from
--     v2, and a freeze (G-256).
--
-- Re-checking a rule the database already makes impossible would be a second
-- opinion that can only ever agree, and would read as protection.
--
-- ── the four that are not structural ─────────────────────────────────────
--
-- **Coverage.** *"Every approved deliverable is represented or explicitly N/A
-- with reason."* G-256 made it impossible to invent a deliverable; it did
-- **not** make it impossible to LEAVE ONE OUT. A plan can reference three of
-- a client's five approved scope items and look perfectly valid. This is the
-- rule that catches silently dropped scope, and it is the reason this unit
-- exists.
--
-- **A phase with work has a shape in time.** *"Every applicable phase has an
-- operational position."* If a deliverable is due in phase 5, phase 5 needs a
-- milestone; otherwise the sequence has a hole exactly where the work is.
--
-- **Finance gates are represented where applicable.** A project with a payment
-- plan whose operational sequence never mentions it is a plan that will be
-- surprised by an invoice.
--
-- **N/A needs its reason**, which §18 asks for in the same breath as coverage.
--
-- ── and no second event ──────────────────────────────────────────────────
--
-- PLAN-I09 says *"emit ProjectPlanReady only after validation pass"*. That
-- event already exists under the name this repository gave it:
-- `project.plan_activated`, emitted by `activate_project_plan`. Rather than
-- add a second event meaning the same thing, the **activation is gated** —
-- carried forward with one marked edit — so `plan_activated` fires only after
-- a passing validation and IS ProjectPlanReady.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.validate_project_plan(p_plan_id uuid)
returns table (
  valid    boolean,
  -- The rules that failed, by name, with the offending count where one
  -- exists. §18 is a checklist, so a refusal that says "invalid" and stops is
  -- a refusal somebody has to go and investigate.
  findings text[]
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_plan      projects.project_plans;
  v_findings  text[] := '{}';
  v_uncovered int;
  v_unreasoned int;
  v_phases    int;
  v_finance   int;
begin
  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id;
  if v_plan.id is null then
    return query select false, array['unknown_plan']::text[]; return;
  end if;

  -- COVERAGE. Every scope item in the plan's own scope version must be
  -- represented by a deliverable. Excluded items are not work, so they are not
  -- expected in the plan.
  select count(*) into v_uncovered
    from projects.scope_items si
   where si.scope_version_id = v_plan.scope_version_id
     and si.inclusion = 'included'
     and not exists (
       select 1 from projects.plan_deliverables d
        where d.plan_id = v_plan.id and d.scope_item_id = si.id
     );
  if v_uncovered > 0 then
    v_findings := v_findings || format('uncovered_scope_items:%s', v_uncovered);
  end if;

  -- "or explicitly N/A WITH REASON". A deliverable dismissed as not applicable
  -- and carrying no note is scope dropped without anybody saying why.
  select count(*) into v_unreasoned
    from projects.plan_deliverables d
   where d.plan_id = v_plan.id
     and d.status = 'not_applicable'
     and coalesce(btrim(coalesce(d.ambiguity_note, '')), '') = '';
  if v_unreasoned > 0 then
    v_findings := v_findings || format('not_applicable_without_reason:%s', v_unreasoned);
  end if;

  -- Every phase carrying a deliverable needs an operational position in the
  -- sequence. `not_applicable` deliverables are exempt: a phase that produces
  -- nothing needs no milestone.
  select count(distinct d.applicable_phase) into v_phases
    from projects.plan_deliverables d
   where d.plan_id = v_plan.id
     and d.applicable_phase <> 'not_applicable'
     and d.status <> 'not_applicable'
     and not exists (
       select 1 from projects.plan_milestones m
        where m.plan_id = v_plan.id and m.phase = d.applicable_phase
     );
  if v_phases > 0 then
    v_findings := v_findings || format('phases_without_a_milestone:%s', v_phases);
  end if;

  -- Finance gates "where applicable": applicable means the project HAS priced
  -- milestones. A project with no payment plan needs no finance gate, and
  -- demanding one would fail every project billed outside the milestone model.
  select count(*) into v_finance
    from projects.milestones pm
   where pm.project_id = v_plan.project_id
     and pm.payment_percent is not null
     and not exists (
       select 1 from projects.plan_milestones m
        where m.plan_id = v_plan.id and m.payment_milestone_id = pm.id
     );
  if v_finance > 0 then
    v_findings := v_findings || format('payment_milestones_not_mapped:%s', v_finance);
  end if;

  return query select array_length(v_findings, 1) is null, v_findings;
end;
$$;

comment on function projects.validate_project_plan(uuid) is
  'Project Planning section 18, the four rules that are not already structural: coverage of the approved scope, a reason on every not-applicable deliverable, a milestone for every phase carrying work, and a finance gate for every priced payment milestone. The other six rules are constraints and are deliberately not re-checked - a second opinion that can only ever agree reads as protection and is not.';

revoke all on function projects.validate_project_plan(uuid) from public, anon;
grant execute on function projects.validate_project_plan(uuid) to authenticated, service_role;

-- ── the activation, carried forward with its edits marked ────────────────
--
-- From 20260917150000, which is where G-257 last defined it — established by
-- searching for the last migration that defines it, not the first.

-- ── the return type CHANGES, so the old function has to go ───────────────
--
-- `create or replace` cannot add a column to a RETURNS TABLE: Postgres treats
-- those columns as OUT parameters, so the signature changes and it refuses
-- with *"cannot change return type of existing function"*. The first draft of
-- this migration did exactly that and **the apply failed** — caught because
-- `apply-migrations-locally.sh` exits non-zero and prints the hint, not
-- because the diff looked wrong.
--
-- This is the same class as G-260's overload: a change to a function's shape
-- needs an explicit drop, and the grants the drop removes need putting back.
-- `activate_project_plan` was granted to `authenticated` by G-256, so that
-- grant is restored below.

drop function if exists projects.activate_project_plan(uuid);

create or replace function projects.activate_project_plan(p_plan_id uuid)
returns table (
  -- 'activated' | 'not_draft' | 'no_deliverables' | 'open_clarifications'
  -- | 'invalid' | 'unknown_plan' | 'needs_person' | 'forbidden'
  -- [G-257 edit 1 of 2] 'open_clarifications' added to the documented set.
  -- [G-265 edit 1 of 3] 'invalid' added to the documented set, and the
  -- function gains a `findings` column carrying §18's checklist.
  --
  -- [G-265 edit 3 of 3] is not one place: adding that column changes EVERY
  -- `return query select` in this function, mechanically and identically —
  -- each gains `'{}'::text[]` between the outcome and the version. Marked here
  -- rather than left for a reader to notice, because two marks over a diff
  -- that touches nine lines would claim less change than there is.
  outcome text,
  findings text[],
  version int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_count int;
  v_open  int;
  v_check record;
begin
  -- A person finalises a plan. §12: "actual phase transition authority remains
  -- with AgencyOS workflow/policy and responsible agents" — and a blueprint
  -- going live is what the pre-kickoff gate reads, so somebody owns it.
  if v_actor is null then
    return query select 'needs_person'::text, '{}'::text[], null::int; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, '{}'::text[], null::int; return;
  end if;

  if v_plan.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, '{}'::text[], null::int; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- §7 requires a deliverables register. An empty plan that reads `active`
  -- would satisfy the pre-kickoff gate while containing nothing.
  select count(*) into v_count from projects.plan_deliverables d where d.plan_id = v_plan.id;
  if v_count = 0 then
    return query select 'no_deliverables'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- [G-257 edit 2 of 2] Planning §10: "never guesses an unclear client
  -- requirement", and PLAN-I09 validates ambiguity before ProjectPlanReady. A
  -- plan carrying an unanswered question is a plan that guessed the answer, so
  -- it cannot go live until every clarification is resolved or routed to a
  -- change request. Checked HERE rather than by a constraint because it is a
  -- rule about a moment, not about a row.
  select count(*) into v_open
    from projects.plan_clarifications c
   where c.plan_id = v_plan.id
     and c.status not in ('resolved', 'routed_to_change_request');
  if v_open > 0 then
    return query select 'open_clarifications'::text, '{}'::text[], v_plan.version; return;
  end if;

  -- [G-265 edit 2 of 3] Planning §18 / PLAN-I09: "emit ProjectPlanReady only
  -- after validation pass." `project.plan_activated` IS that event, so the
  -- pass is required here rather than by a second event meaning the same
  -- thing. The findings come back so §18's checklist can be acted on.
  select * into v_check from projects.validate_project_plan(v_plan.id);
  if not v_check.valid then
    return query select 'invalid'::text, v_check.findings, v_plan.version; return;
  end if;

  update projects.project_plans
     set status = 'superseded'
   where project_id = v_plan.project_id and status = 'active';

  update projects.project_plans
     set status = 'active', activated_at = now(), activated_by = v_actor
   where id = v_plan.id;

  perform core.emit_event(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('plan_id', v_plan.id, 'version', v_plan.version, 'deliverables', v_count),
    null
  );

  perform core.record_audit(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'active', 'plan_id', v_plan.id, 'version', v_plan.version, 'activated_by', v_actor),
    null
  );

  return query select 'activated'::text, '{}'::text[], v_plan.version;
end;
$$;

revoke all on function projects.activate_project_plan(uuid) from public;
grant execute on function projects.activate_project_plan(uuid) to authenticated;

notify pgrst, 'reload schema';
