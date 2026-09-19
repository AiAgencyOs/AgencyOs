-- ═══════════════════════════════════════════════════════════════════════════
-- What Phase 3 cost.
--
-- Master §6's last line, and Designer §23's `UsageRecord`:
--
--   *"Track AI/model/API usage by **project, phase, agent and task** where
--   infrastructure supports it."*
--
-- `ai.agent_runs` already records the agent, the model, the tokens and the
-- cost. It has never recorded **which project** a run was for, or **which
-- phase** — so the spend exists, is auditable in total, and cannot be
-- attributed to the work that caused it.
--
-- ── the attribution is DERIVED, not passed in ─────────────────────────
--
-- The obvious build is an argument: every workflow tells `openRun` which
-- project it is working on. That is nineteen call sites, each of which can be
-- forgotten, and none of which can fix the runs that already happened.
--
-- A run already records **what it is about** — `subject_type` and
-- `subject_id`. The project is a fact about that subject, so it is resolved
-- here, by trigger, from the row the run already points at.
--
-- Three things follow, and all three are why this is the right shape:
--
--   **It cannot be forgotten.** A new workflow gets attribution by naming its
--   subject, which it must do anyway.
--
--   **It backfills.** Existing runs still carry their subject, so the same
--   resolver answers for history. Attribution passed as an argument could
--   never have done that — the runs that already happened do not know.
--
--   **It is deterministic.** §6: *"use deterministic code/rules for
--   orchestration, state, comparison metadata and storage; do not spend LLM
--   tokens on deterministic tasks."*
--
-- ── phase is set only where it is not a guess ─────────────────────────
--
-- Project is a fact about a subject. **Phase mostly is not.** A run about a
-- conversation could serve any phase; a scope version can be revised in
-- Phase 2 by planning and in Phase 6 by a change request. Mapping those to a
-- number would make this report confidently wrong, which is worse than empty
-- — somebody would divide by it.
--
-- So `phase` is set **only** for subjects that belong to exactly one phase by
-- construction: the Phase 3 entities, which cannot exist outside Phase 3. For
-- everything else it stays null, and the report says how much is unattributed
-- rather than folding it in.
--
-- A consequence worth naming, because driving it surfaced it: a run whose
-- subject **row is gone** keeps its phase and loses its project. The subject
-- *type* still says what kind of work it was, and that is true whether or not
-- the row survived — `theme_options` cascades from the phase, so a deleted
-- project takes its options with it. Phase 3 spend that can no longer be
-- attributed to a project is still Phase 3 spend, and saying so preserves
-- information the project column cannot.
--
-- ── and today the honest answer is zero ───────────────────────────────
--
-- No design agent has run on this deployment — ADM-82 approved thirteen, two
-- are defined, and none of them draws. This report will say so. The dimension
-- is added **now** rather than when the first agent runs, because a run that
-- happens before the column exists is one the column can still explain, while
-- a run that happens before the *subject* is recorded is gone. The resolver is
-- the thing that has to exist first.
-- ═══════════════════════════════════════════════════════════════════════════

alter table ai.agent_runs
  add column if not exists project_id uuid references projects.projects(id) on delete set null;

alter table ai.agent_runs
  add column if not exists phase smallint
    check (phase is null or phase between 1 and 8);

comment on column ai.agent_runs.project_id is
  'Master section 6. DERIVED by trigger from subject_type/subject_id, never passed in: a run already records what it is about, the project is a fact about that subject, and an argument could be forgotten at nineteen call sites and could never explain the runs that already happened.';

comment on column ai.agent_runs.phase is
  'Master section 6. Set ONLY for subjects that belong to exactly one phase by construction - the Phase 3 entities, which cannot exist outside Phase 3. A run about a conversation could serve any phase and a scope version can be revised in several, so mapping those to a number would make the report confidently wrong, which is worse than empty: somebody would divide by it.';

create index if not exists agent_runs_project_idx
  on ai.agent_runs (project_id, phase, created_at desc)
  where project_id is not null;

-- The project a subject belongs to, and the phase it can only belong to.
create or replace function ai.resolve_run_subject(
  p_subject_type text,
  p_subject_id   uuid
)
returns table (project_id uuid, phase smallint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  if p_subject_id is null then
    return query select null::uuid, null::smallint; return;
  end if;

  case p_subject_type
    -- ── project-scoped subjects that exist today, phase unknowable ──────
    when 'projects.scope_version' then
      select s.project_id into v_project from projects.scope_versions s where s.id = p_subject_id;
      return query select v_project, null::smallint; return;
    when 'projects.handover' then
      select h.project_id into v_project from projects.handovers h where h.id = p_subject_id;
      return query select v_project, null::smallint; return;
    when 'projects.maintenance_item' then
      select m.project_id into v_project from projects.maintenance_items m where m.id = p_subject_id;
      return query select v_project, null::smallint; return;

    -- ── Phase 3 subjects, which cannot exist outside Phase 3 ────────────
    when 'phase_three' then
      select p.project_id into v_project from projects.phase_three p where p.id = p_subject_id;
      return query select v_project, 3::smallint; return;
    when 'theme_option' then
      select t.project_id into v_project from projects.theme_options t where t.id = p_subject_id;
      return query select v_project, 3::smallint; return;
    when 'design_token_set' then
      select s.project_id into v_project from projects.design_token_sets s where s.id = p_subject_id;
      return query select v_project, 3::smallint; return;
    when 'representative_screen' then
      select r.project_id into v_project from projects.representative_screens r where r.id = p_subject_id;
      return query select v_project, 3::smallint; return;
    when 'design_revision' then
      select r.project_id into v_project from projects.design_revisions r where r.id = p_subject_id;
      return query select v_project, 3::smallint; return;
    when 'client_design_share' then
      select s.project_id into v_project from projects.client_design_shares s where s.id = p_subject_id;
      return query select v_project, 3::smallint; return;
    when 'client_design_decision' then
      select d.project_id into v_project from projects.client_design_decisions d where d.id = p_subject_id;
      return query select v_project, 3::smallint; return;
    when 'phase_three_handoff' then
      select h.project_id into v_project from projects.phase_three_handoffs h where h.id = p_subject_id;
      return query select v_project, 3::smallint; return;

    else
      -- A subject this resolver does not know is NOT an error. It is a run
      -- about something that has no project, or one whose type was added
      -- since — both answer "unattributed", which the report then shows as
      -- its own line rather than hiding.
      return query select null::uuid, null::smallint; return;
  end case;
end;
$$;

comment on function ai.resolve_run_subject(text, uuid) is
  'Master section 6. Answers which project a run''s subject belongs to, and which phase it can ONLY belong to. An unknown subject type answers "unattributed" rather than raising: a resolver that refused what it did not recognise would make adding a workflow a migration.';

create or replace function ai.attribute_run()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_phase   smallint;
begin
  select r.project_id, r.phase into v_project, v_phase
    from ai.resolve_run_subject(new.subject_type, new.subject_id) r;

  new.project_id := v_project;
  new.phase := v_phase;
  return new;
end;
$$;

comment on function ai.attribute_run() is
  'Sets ai.agent_runs.project_id and phase from the subject, on insert and whenever the subject changes. Derived rather than passed in, so it cannot be forgotten by a caller and applies equally to history.';

create trigger attribute_run
  before insert or update of subject_type, subject_id on ai.agent_runs
  for each row execute function ai.attribute_run();

-- Tenancy, on a column no caller sets.
--
-- `project_id` is derived, so a run can only be attributed to a project the
-- resolver found through the subject — but the guard is not redundant: it is
-- what the verifier checks, and a future resolver change that read the wrong
-- table would otherwise cross a tenant silently.
--
-- **The name matters here.** Postgres fires `before` triggers in name order,
-- and this one has to run AFTER `attribute_run` has set the column — a guard
-- named `agent_runs_...` would sort first and check a null.
create trigger enforce_run_project_org
  before insert or update of project_id on ai.agent_runs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

-- The same resolver, applied to what already happened. This is the half an
-- argument-based design could never have provided.
-- The resolver takes each row's own columns, so the lateral join lives in a
-- subquery over the table and is joined back by id: `UPDATE ... FROM LATERAL
-- f(target.col)` cannot reference the row being updated.
--
-- This UPDATE does not re-fire `attribute_run` — that trigger watches the
-- subject columns, which are untouched here. It does fire the tenancy guard,
-- which is the point: the backfill is checked by the same rule as a live write.
update ai.agent_runs r
   set project_id = a.project_id,
       phase = a.phase
  from (
    select ar.id, s.project_id, s.phase
      from ai.agent_runs ar
      cross join lateral ai.resolve_run_subject(ar.subject_type, ar.subject_id) s
  ) a
 where a.id = r.id
   and (r.project_id is distinct from a.project_id
        or r.phase is distinct from a.phase);

-- ── the report ──────────────────────────────────────────────────────────

create or replace function ai.project_usage_by_phase(
  p_project_id uuid
)
returns table (
  -- Null means "attributed to this project, phase unknowable" — shown as its
  -- own line rather than folded into a phase it might not belong to.
  phase          smallint,
  runs           bigint,
  input_tokens   bigint,
  output_tokens  bigint,
  cost_minor     bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    r.phase,
    count(*)::bigint,
    coalesce(sum(r.input_tokens), 0)::bigint,
    coalesce(sum(r.output_tokens), 0)::bigint,
    coalesce(sum(r.cost_minor), 0)::bigint
  from ai.agent_runs r
  join projects.projects p on p.id = r.project_id
  where r.project_id = p_project_id
    and p.organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  group by r.phase
  order by r.phase nulls last;
$$;

comment on function ai.project_usage_by_phase(uuid) is
  'Master section 6 and Designer section 23''s UsageRecord: what a project spent, by phase. A null phase is its own line - "attributed to this project, phase unknowable" - rather than folded into a phase it might not belong to. Joined through projects.projects so the organisation check is on a row this reader can actually see; ai.agent_runs carries an organization_id too, and reading only that would trust a column the caller cannot verify against a parent.';

revoke all on function ai.project_usage_by_phase(uuid) from public, anon;
grant execute on function ai.project_usage_by_phase(uuid) to authenticated;
revoke all on function ai.resolve_run_subject(text, uuid) from public, anon;
grant execute on function ai.resolve_run_subject(text, uuid) to authenticated;

notify pgrst, 'reload schema';
