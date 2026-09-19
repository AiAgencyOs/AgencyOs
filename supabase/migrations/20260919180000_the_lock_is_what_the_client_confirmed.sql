-- ═══════════════════════════════════════════════════════════════════════════
-- The lock is what the client confirmed.
--
-- Master §7.11, §7.12, §16, §19; PM §4.10; Designer §4.9 and UI3-I10.
--
-- G-283 recorded the client's confirmation and emitted
-- `project.client_final_design_confirmed`. **Nothing consumed it.** This is
-- what does, and the unit is one design decision with a lot of validation
-- behind it.
--
-- ── the door takes no argument about what to lock ──────────────────────
--
-- `lockPhase3Direction(projectId, themeId, colorId, figmaVersion)` is the
-- signature Master §22's tool list sketches. It is not the signature here, and
-- the difference is the whole point.
--
-- Designer §4.9: *"Do not silently overwrite the chosen version."*
-- Master §16: *"Final selection cannot be overwritten silently."*
-- PM §4.9: *"Do not rely on an informal assumption that the client 'seems
-- okay'."*
--
-- A door that accepts a theme id and a colour id can lock something the client
-- never confirmed. Not through malice — through a stale variable, a retried
-- job carrying last round's ids, an agent filling arguments from context. The
-- rule would then be held by **whoever computed the arguments**, which is to
-- say by nobody a reader can check.
--
-- So this door takes the phase, and reads the `final_confirmed`
-- `client_design_decisions` row to learn what to lock. G-283 already refuses a
-- confirmation that does not name an exact theme **and** colour, and already
-- refuses one naming anything the client was not shown. **All of that
-- guarantee is inherited here for free, and none of it could be inherited by a
-- door that took the ids as arguments.**
--
-- ── what is validated before the phase is called complete ──────────────
--
-- Master §7.12 lists it: *"Validate screen list, screen-content baseline,
-- selected theme, selected colors and approval evidence."* Each missing piece
-- gets its **own** refusal rather than a single `not_ready`, because a PM told
-- "not ready" has to go and find out which — the same reason G-282's share
-- names the offending options.
--
-- ── Figma is canonical, and a missing one is not faked ─────────────────
--
-- Master §5: *"the Figma artifact is the canonical source of truth for Phase 3
-- design direction and the Phase 4 handoff"*, and §6: *"Phase 4 must consume
-- the locked Figma direction rather than recreating the visual decision from
-- scratch."*
--
-- This deployment has no Figma credential. Designer §26 is the instruction for
-- exactly that case: *"Surface manual/config blocker; **do not fake
-- completion**."*
--
-- So the two facts are kept apart instead of being collapsed into one:
--
--   **Phase 3 is complete.** The client confirmed a direction. That happened,
--   and recording otherwise would be a different lie.
--
--   **The handoff is not Phase 4 ready.** `phase_four_ready` is false and
--   `readiness_note` says which artifact is missing. Master §22's recovery
--   table gives Phase 4 its instruction — *"Phase 4 start attempted early →
--   block until Phase 3 final selection/handoff is complete"* — and this flag
--   is the thing it blocks on.
--
-- `project.phase_three_completed` is therefore emitted always and
-- `project.phase_four_ready` **only when it is true**. An event that fired
-- regardless would be the faked completion §26 forbids, wearing a name.
--
-- ── the handoff is a snapshot, for the reason PM §4.10 gives ───────────
--
-- *"Client should not need to reselect the visual direction in Phase 4."*
--
-- A handoff that joined live rows would answer what the direction is **now**.
-- The same argument G-282 made for the share, one step further down the flow:
-- the payload freezes the screen baseline, the theme, the palette, the Figma
-- references and the approval evidence as they stood at the lock.
--
-- ── what this door does not do ─────────────────────────────────────────
--
-- **It does not start Phase 4.** PM §5: *"Must not start Phase 4 before Phase
-- 3 completion gate passes."* Emitting readiness is not starting; a Phase 4
-- unit consumes it, and that unit does not exist yet.
--
-- **It cannot be run twice.** A second lock is refused, not merged.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.phase_three_handoffs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- One handoff per phase. The idempotency key AND §16's no-silent-overwrite,
  -- in one constraint: a second lock cannot be written at all.
  phase_three_id   uuid not null unique references projects.phase_three(id) on delete cascade,

  -- §19's "locked screens/theme/colors/Figma refs/approval evidence".
  screen_baseline_id  uuid not null references projects.screen_baselines(id) on delete restrict,
  theme_option_id     uuid not null references projects.theme_options(id) on delete restrict,
  color_option_id     uuid not null references projects.color_options(id) on delete restrict,

  -- The approval evidence: the exact confirmation that authorised this lock.
  -- `restrict`, because a handoff that cannot point at the confirmation behind
  -- it is the informal assumption PM §4.9 forbids.
  client_decision_id  uuid not null references projects.client_design_decisions(id) on delete restrict,

  -- Recorded as found, never invented (Master §20, Designer §24).
  figma_file_key   text,
  figma_node_id    text,
  figma_version    text,

  -- THE SNAPSHOT Phase 4 consumes. PM §4.10: the client should not need to
  -- reselect the direction, and a live join would answer what it is now.
  payload          jsonb not null,

  -- Master §22: "Phase 4 start attempted early → block until Phase 3 final
  -- selection/handoff is complete." This is the flag it blocks on.
  phase_four_ready boolean not null,
  readiness_note   text check (readiness_note is null or length(btrim(readiness_note)) between 1 and 500),

  locked_at        timestamptz not null default now(),
  locked_by        uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Designer §26: do not fake completion. A handoff that is not ready must say
  -- which artifact is missing, or "not ready" is a shrug.
  constraint phase_three_handoffs_not_ready_says_why
    check (phase_four_ready or (readiness_note is not null and length(btrim(readiness_note)) > 0)),

  -- Master §5 and §6: Figma is the canonical source Phase 4 consumes. Ready
  -- without one would be the claim §26 forbids.
  constraint phase_three_handoffs_ready_has_figma
    check (not phase_four_ready or figma_node_id is not null),

  constraint phase_three_handoffs_payload_is_an_object
    check (jsonb_typeof(payload) = 'object')
);

comment on table projects.phase_three_handoffs is
  'Master section 19 Phase3Handoff. The locked direction Phase 4 consumes, frozen: screen baseline, theme, palette, Figma references and the approval evidence as they stood at the lock. PM section 4.10 is the reason it is a snapshot - the client should not need to reselect the visual direction in Phase 4, and a live join would answer what the direction is NOW. phase_four_ready is false when the canonical Figma artifact is missing, with the reason named: Phase 3 IS complete because the client confirmed, and the handoff is NOT ready because the artifact Phase 4 consumes does not exist. Collapsing those two facts into one would be the faked completion Designer section 26 forbids.';

comment on column projects.phase_three_handoffs.client_decision_id is
  'The approval evidence (Master section 7.11). The lock reads this row to learn WHAT to lock rather than taking it as an argument: a door accepting a theme id can lock something the client never confirmed, and the rule would then be held by whoever computed the arguments.';

create index if not exists phase_three_handoffs_project_idx
  on projects.phase_three_handoffs (project_id, locked_at desc);

create trigger phase_three_handoffs_parent_org_project
  before insert or update of project_id on projects.phase_three_handoffs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger phase_three_handoffs_parent_org_phase
  before insert or update of phase_three_id on projects.phase_three_handoffs
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');

create trigger phase_three_handoffs_parent_org_baseline
  before insert or update of screen_baseline_id on projects.phase_three_handoffs
  for each row execute function core.enforce_parent_org('screen_baseline_id', 'projects.screen_baselines');

create trigger phase_three_handoffs_parent_org_theme
  before insert or update of theme_option_id on projects.phase_three_handoffs
  for each row execute function core.enforce_parent_org('theme_option_id', 'projects.theme_options');

create trigger phase_three_handoffs_parent_org_color
  before insert or update of color_option_id on projects.phase_three_handoffs
  for each row execute function core.enforce_parent_org('color_option_id', 'projects.color_options');

create trigger phase_three_handoffs_parent_org_decision
  before insert or update of client_decision_id on projects.phase_three_handoffs
  for each row execute function core.enforce_parent_org('client_decision_id', 'projects.client_design_decisions');

create trigger freeze_org_phase_three_handoffs
  before update of organization_id on projects.phase_three_handoffs
  for each row execute function core.freeze_organization_id();

-- Master §16, Designer §4.9: the locked direction cannot be overwritten
-- silently. It cannot be overwritten at all — a later change is a new version
-- and a new change process, which is a different door than this one.
create or replace function projects.freeze_phase_three_handoff()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'a phase 3 handoff is the locked direction; a later change is a new version, not an edit';
end;
$$;

create trigger freeze_phase_three_handoff
  before update on projects.phase_three_handoffs
  for each row execute function projects.freeze_phase_three_handoff();

alter table projects.phase_three_handoffs enable row level security;
alter table projects.phase_three_handoffs force row level security;

drop policy if exists phase_three_handoffs_select on projects.phase_three_handoffs;
create policy phase_three_handoffs_select on projects.phase_three_handoffs
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.phase_three_handoffs to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.phase_three_completed',
   'Master section 7.12 Phase3Completed. The client confirmed a direction and it is locked. Emitted on every successful lock, because the confirmation happened whether or not the canonical Figma artifact exists.',
   true),
  ('project.phase_four_ready',
   'Master section 7.12 Phase4Ready. The locked handoff carries everything Phase 4 consumes. Emitted ONLY when phase_four_ready is true - an event that fired regardless would be the faked completion Designer section 26 forbids, wearing a name.',
   true)
on conflict (type) do nothing;

-- ── the door ────────────────────────────────────────────────────────────

create or replace function projects.lock_phase_three_direction(
  p_phase_three_id uuid
)
returns table (
  -- 'locked'              the direction is locked and Phase 4 may start
  -- 'locked_not_ready'    locked, but the canonical Figma artifact is missing
  -- refusals: 'no_actor' | 'forbidden' | 'unknown_phase' | 'already_locked'
  --           | 'blocked' | 'not_confirmed' | 'no_screen_baseline'
  --           | 'theme_not_approved'
  outcome    text,
  handoff_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_decision projects.client_design_decisions;
  v_theme    projects.theme_options;
  v_color    projects.color_options;
  v_baseline projects.screen_baselines;
  v_ready    boolean;
  v_note     text;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.id = p_phase_three_id
   for update;

  if v_phase3.id is null then
    return query select 'unknown_phase'::text, null::uuid; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- §16 and Designer §4.9. Checked here as well as by the unique constraint:
  -- a refusal a caller can read beats a constraint violation they cannot.
  if exists (select 1 from projects.phase_three_handoffs h
              where h.phase_three_id = v_phase3.id) then
    return query select 'already_locked'::text, null::uuid; return;
  end if;

  -- A phase waiting on a person is not a phase to complete.
  if v_phase3.state in ('blocked_requirement', 'scope_escalation', 'revision_limit_escalation') then
    return query select 'blocked'::text, null::uuid; return;
  end if;

  -- ── §7.11's approval evidence, read rather than taken as an argument ──

  select d.* into v_decision
    from projects.client_design_decisions d
   where d.phase_three_id = v_phase3.id
     and d.decision = 'final_confirmed'
   order by d.created_at desc
   limit 1;

  if v_decision.id is null then
    return query select 'not_confirmed'::text, null::uuid; return;
  end if;

  -- G-283 already refuses a confirmation that does not name BOTH, and one
  -- naming anything the client was not shown. Both guarantees are inherited.
  select t.* into v_theme from projects.theme_options t
   where t.id = v_decision.selected_theme_option_id;
  select c.* into v_color from projects.color_options c
   where c.id = v_decision.selected_color_option_id;

  -- Defence in depth: `theme_options_locked_was_selected` refuses the update
  -- below anyway, but a named refusal is readable and a check violation is not.
  if v_theme.admin_status <> 'approved' then
    return query select 'theme_not_approved'::text, null::uuid; return;
  end if;

  -- ── §7.12's "validate screen list, screen-content baseline" ───────────

  select b.* into v_baseline
    from projects.screen_baselines b
   where b.project_id = v_phase3.project_id
     and b.status = 'finalized'
   order by b.version desc
   limit 1;

  if v_baseline.id is null then
    return query select 'no_screen_baseline'::text, null::uuid; return;
  end if;

  -- ── Figma: recorded as found, and its absence named ───────────────────

  v_ready := v_theme.figma_node_id is not null;
  v_note  := case when v_ready then null else
    'Locked without the canonical Figma artifact: the selected theme has no Figma node reference. '
    || 'Master section 5 makes Figma the source of truth Phase 4 consumes, so Phase 4 is blocked until it exists.'
  end;

  insert into projects.phase_three_handoffs (
    organization_id, project_id, phase_three_id, screen_baseline_id,
    theme_option_id, color_option_id, client_decision_id,
    figma_file_key, figma_node_id, figma_version,
    payload, phase_four_ready, readiness_note, locked_by
  ) values (
    v_phase3.organization_id, v_phase3.project_id, v_phase3.id, v_baseline.id,
    v_theme.id, v_color.id, v_decision.id,
    v_theme.figma_file_key, v_theme.figma_node_id, v_theme.figma_version,
    jsonb_build_object(
      'screenBaseline', jsonb_build_object(
        'id', v_baseline.id, 'version', v_baseline.version,
        'screenCount', v_baseline.screen_count, 'screens', v_baseline.screens),
      'theme', jsonb_build_object(
        'id', v_theme.id, 'name', v_theme.name, 'version', v_theme.version,
        'directionSummary', v_theme.direction_summary,
        'directionMetadata', v_theme.direction_metadata,
        'figmaFileKey', v_theme.figma_file_key, 'figmaNodeId', v_theme.figma_node_id,
        'figmaVersion', v_theme.figma_version, 'previewAssetUrl', v_theme.preview_asset_url),
      'colors', jsonb_build_object(
        'id', v_color.id, 'paletteName', v_color.palette_name,
        'primaryHex', v_color.primary_hex, 'secondaryHex', v_color.secondary_hex,
        'accentHex', v_color.accent_hex, 'backgroundHex', v_color.background_hex,
        'surfaceHex', v_color.surface_hex, 'textPrimaryHex', v_color.text_primary_hex,
        'textSecondaryHex', v_color.text_secondary_hex, 'successHex', v_color.success_hex,
        'warningHex', v_color.warning_hex, 'errorHex', v_color.error_hex,
        'contrastNotes', v_color.contrast_notes),
      'approvalEvidence', jsonb_build_object(
        'clientDecisionId', v_decision.id, 'clientWords', v_decision.client_words,
        'evidenceRef', v_decision.evidence_ref, 'confirmedAt', v_decision.created_at),
      'revisionRounds', v_phase3.client_revision_count),
    v_ready, v_note, v_actor
  )
  returning id into v_new;

  -- §16: the selection becomes `locked`. G-279's row rule refuses this unless
  -- Admin approved it, which is why the gate cannot be walked around here.
  update projects.theme_options set client_status = 'locked' where id = v_theme.id;
  update projects.color_options set client_status = 'locked' where id = v_color.id;

  update projects.phase_three
     set state = 'completed', completed_at = now()
   where id = v_phase3.id;

  perform core.record_audit(
    v_phase3.organization_id, 'phase_three.locked', 'phase_three_handoff', v_new, null,
    jsonb_build_object('projectId', v_phase3.project_id, 'themeOptionId', v_theme.id,
                       'colorOptionId', v_color.id, 'phaseFourReady', v_ready)
  );

  -- §7.12's pair. The first is always true; the second is emitted only when it
  -- IS true, because an event that fired regardless would be a faked
  -- completion with a name on it.
  perform core.emit_event(
    v_phase3.organization_id, 'project.phase_three_completed',
    'phase_three_handoff', v_new,
    jsonb_build_object('projectId', v_phase3.project_id, 'phaseFourReady', v_ready)
  );

  if v_ready then
    perform core.emit_event(
      v_phase3.organization_id, 'project.phase_four_ready',
      'phase_three_handoff', v_new,
      jsonb_build_object('projectId', v_phase3.project_id, 'handoffId', v_new)
    );
    return query select 'locked'::text, v_new; return;
  end if;

  return query select 'locked_not_ready'::text, v_new;
end;
$$;

comment on function projects.lock_phase_three_direction(uuid) is
  'Master sections 7.11, 7.12 and 16; PM section 4.10; Designer section 4.9. IT TAKES NO ARGUMENT ABOUT WHAT TO LOCK: it reads the final_confirmed client_design_decisions row. A door accepting a theme id can lock something the client never confirmed - through a stale variable or a retried job carrying last round ids - and the no-silent-overwrite rule would then be held by whoever computed the arguments. Reading the confirmation inherits every guarantee G-283 already enforces on it. Validates section 7.12 list with a NAMED refusal each, because a PM told "not ready" has to go and find out which. THE TWO FACTS ARE KEPT APART: Phase 3 is complete because the client confirmed, and the handoff is NOT Phase 4 ready when the canonical Figma artifact is missing - phase_four_ready is false, the note says which artifact, and project.phase_four_ready is NOT emitted. Collapsing them would be the faked completion Designer section 26 forbids. The payload is a snapshot, not a join: PM section 4.10 says the client should not need to reselect the direction in Phase 4, and a join would answer what it is now.';

revoke all on function projects.lock_phase_three_direction(uuid) from public, anon;
grant execute on function projects.lock_phase_three_direction(uuid) to authenticated;

notify pgrst, 'reload schema';
