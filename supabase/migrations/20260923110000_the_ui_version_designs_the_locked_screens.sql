-- ═══════════════════════════════════════════════════════════════════════════
-- The UI version designs the locked screens, and nothing else.
--
-- UID §4, §6, §19; Impl §7.2, §8. `docs/phase-4-gap-analysis.md` step 3:
-- "UI Designer Agent against the real Phase 3 baseline."
--
-- ── it REFERENCES the Phase 3 handoff, exactly like phase_four does ──────
--
-- Every screen a UI version may design already exists, frozen, in
-- `phase_three_handoffs.payload.screenBaseline.screens` — UID §19: *"Phase 4
-- receives design tokens/primitives rather than recreating them"*, and the
-- SAME argument applies to the screen list itself. This table does not carry
-- a second copy of the screens it designs against; it carries a
-- `source_phase_three_handoff_id` and the workflow reads the frozen list
-- through it.
--
-- ── the state machine is Impl §7.2's, scoped to what exists so far ───────
--
-- Impl §7.2 names a UIVersion lifecycle from DRAFT to LOCKED, running through
-- Design QA and Admin/client review. Every name in that lifecycle is
-- expressible here — the same discipline `projects.phase_four` used for its
-- own state machine — but only the DRAFT transition has a door in this
-- migration. Design QA, Admin review and client review are later, independent
-- units of work (gap analysis steps 3's own QA increment, then Admin/client
-- review), and building their doors before their callers exist would be
-- exactly the "correct-looking code with nowhere to attach" this repository's
-- audit history warns against.
--
-- ── why `screens` is one jsonb column, not one row per screen ────────────
--
-- `design_token_sets` refused a jsonb catch-all because it holds ONE
-- direction's own fixed, named primitives. A UI version is the opposite
-- shape: a variable-length list of screens, which is exactly the problem
-- `projects.screen_baselines.screens` already solved with one jsonb column
-- (`20260918150000_the_screen_baseline.sql`) rather than a child table. This
-- table follows that established precedent rather than inventing a third
-- shape for the same kind of data.
--
-- ── one draft per workspace, for now ──────────────────────────────────────
--
-- `unique (phase_four_id)`: Task 2's revision loop (UI Client Revision Rule,
-- "approximately 2-3 rounds") is a LATER unit of work this migration does not
-- build. Today, a second `record_ui_version_draft` call for the same
-- workspace answers `already_drafted` with the existing row, the same
-- idempotent-replay shape every door in this repository uses for "duplicate
-- event/job" (Master §22). `version` is carried as a column from day one so
-- the revision loop, when it exists, extends this table rather than
-- migrating it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.ui_versions (
  id                            uuid primary key default gen_random_uuid(),
  organization_id               uuid not null references core.organizations(id) on delete cascade,
  project_id                    uuid not null references projects.projects(id) on delete cascade,

  -- One draft per Task 2 workspace, for now — see header.
  phase_four_id                 uuid not null unique references projects.phase_four(id) on delete cascade,

  -- The locked baseline this version was designed FROM, referenced rather
  -- than copied — same argument `design_token_sets.theme_option_id` makes.
  source_phase_three_handoff_id uuid not null references projects.phase_three_handoffs(id) on delete restrict,

  version   int not null default 1 check (version > 0),

  -- Impl §7.2's UIVersion lifecycle, named in full; only DRAFT is reachable
  -- by a door in this migration (see header).
  status    text not null default 'draft' check (status in (
              'draft',
              'qa_review',
              'qa_changes_required',
              'qa_pass',
              'admin_review',
              'admin_edit',
              'admin_approved',
              'client_review',
              'client_change',
              'client_approved',
              'locked'
            )),

  -- The model's structured design proposal — see `uiVersionDraftSchema`
  -- (src/modules/projects/schema.ts) for the exact shape validated before
  -- this column is ever written. One jsonb column for a variable-length list
  -- of screens; see header for why that is the established shape here, not a
  -- catch-all.
  screens   jsonb not null,

  drafted_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint ui_versions_screens_is_an_array
    check (jsonb_typeof(screens) = 'array'),

  -- A version that designs nothing is not a version. Same shape
  -- `design_token_sets_says_something` uses for the identical reason.
  constraint ui_versions_designs_something
    check (jsonb_array_length(screens) > 0)
);

comment on table projects.ui_versions is
  'Impl section 7.2 UIVersion, UID sections 4/6/19. One draft per phase_four workspace (the revision loop is not built yet - see the migration header). REFERENCES source_phase_three_handoff_id rather than copying the locked screen list: UID section 19''s "Phase 4 receives... rather than recreating" applies to the screen list exactly as it does to the design tokens. screens is one jsonb column because a UI version is a variable-length list of screens, the same shape projects.screen_baselines already solved that way rather than a catch-all.';

comment on column projects.ui_versions.screens is
  'The model''s structured design proposal, validated against uiVersionDraftSchema (src/modules/projects/schema.ts) before this column is written. A layout SPECIFICATION per screen - component list, layout approach, states addressed - at design_token_sets own boundary: "a direction a reviewer can judge, not a production spec." Not pixel/Figma output; the master prompt''s own rule is never to claim a capability (real Figma write) this codebase does not have.';

create index if not exists ui_versions_project_idx
  on projects.ui_versions (organization_id, project_id, version desc);

create trigger ui_versions_parent_org_project
  before insert or update of project_id on projects.ui_versions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger ui_versions_parent_org_phase_four
  before insert or update of phase_four_id on projects.ui_versions
  for each row execute function core.enforce_parent_org('phase_four_id', 'projects.phase_four');

create trigger ui_versions_parent_org_handoff
  before insert or update of source_phase_three_handoff_id on projects.ui_versions
  for each row execute function core.enforce_parent_org('source_phase_three_handoff_id', 'projects.phase_three_handoffs');

create trigger freeze_org_ui_versions
  before update of organization_id on projects.ui_versions
  for each row execute function core.freeze_organization_id();

create trigger ui_versions_updated_at
  before update on projects.ui_versions
  for each row execute function core.set_updated_at();

alter table projects.ui_versions enable row level security;
alter table projects.ui_versions force row level security;

drop policy if exists ui_versions_select on projects.ui_versions;
create policy ui_versions_select on projects.ui_versions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- No write policy, deliberately. Every mutation goes through the door below.

grant select on projects.ui_versions to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.ui_version_drafted',
   'Impl section 7.2 / UID section 19. A UI Designer produced a structured design proposal for a Task 2 workspace, from the locked Phase 3 baseline. Not yet reviewed - Design QA, Admin review and client review are later stages.',
   true)
on conflict (type) do nothing;

-- ── the door ───────────────────────────────────────────────────────────────

create or replace function projects.record_ui_version_draft(
  p_phase_four_id uuid,
  p_screens       jsonb
)
returns table (
  -- 'drafted' | 'already_drafted' | 'unknown_workspace' | 'wrong_state'
  -- | 'empty_screens' | 'no_actor' | 'forbidden'
  outcome       text,
  ui_version_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor      uuid := (select auth.uid());
  v_phase_four projects.phase_four;
  v_existing   projects.ui_versions;
  v_new        uuid;
begin
  -- The service role drafts because the trigger is the ui_designer WORKFLOW
  -- reacting to an event, the same shape `start_phase_four` and
  -- `record_theme_option` both use for the identical reason. A person may
  -- also record one, which is why the actor path exists at all.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p4.* into v_phase_four
    from projects.phase_four p4
   where p4.id = p_phase_four_id
   for update;

  if v_phase_four.id is null then
    return query select 'unknown_workspace'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_phase_four.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select v.* into v_existing
    from projects.ui_versions v
   where v.phase_four_id = v_phase_four.id;

  if v_existing.id is not null then
    -- Master §22: "duplicate event/job - return existing artifact/version
    -- idempotently."
    return query select 'already_drafted'::text, v_existing.id; return;
  end if;

  if v_phase_four.state <> 'task2_started' then
    return query select 'wrong_state'::text, null::uuid; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'empty_screens'::text, null::uuid; return;
  end if;

  insert into projects.ui_versions (
    organization_id, project_id, phase_four_id, source_phase_three_handoff_id, screens
  ) values (
    v_phase_four.organization_id, v_phase_four.project_id, v_phase_four.id,
    v_phase_four.phase_three_handoff_id, p_screens
  )
  returning id into v_new;

  update projects.phase_four
     set state = 'ui_design'
   where id = v_phase_four.id;

  perform core.record_audit(
    v_phase_four.organization_id, 'project.ui_version_drafted', 'ui_version', v_new, null,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id)
  );

  perform core.emit_event(
    v_phase_four.organization_id, 'project.ui_version_drafted',
    'ui_version', v_new,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id)
  );

  return query select 'drafted'::text, v_new;
end;
$$;

comment on function projects.record_ui_version_draft(uuid, jsonb) is
  'UID section 19, Impl section 7.2. Records the ui_designer workflow''s draft for a Task 2 workspace and advances phase_four to ui_design, under the workspace''s own row lock. One draft per workspace: a replay answers already_drafted with the existing id (Master section 22). Refuses wrong_state rather than silently drafting twice from two different macro-stages.';

revoke all on function projects.record_ui_version_draft(uuid, jsonb) from public, anon;
grant execute on function projects.record_ui_version_draft(uuid, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
