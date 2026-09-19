-- ═══════════════════════════════════════════════════════════════════════════
-- The screen baseline.
--
-- Master §7.3 and §7.4 are the two steps Phase 3 does before any design work:
--
--   *"Create/confirm the complete screen/page list required by approved
--   scope. Map every screen to source requirement/scope. Do not silently add
--   out-of-scope screens. **Version the screen list.**"*
--
--   *"For every screen, define required sections/content/components/actions at
--   the requirement level. This is a content/requirements baseline, not full
--   final visual UI."*
--
-- ── most of this already exists, and that is the point ──────────────────
--
-- `projects.screens` was built in 2026-08 for Document 12's coverage matrix
-- (G-?/`attractive_but_incomplete`), and it is already substantially Master
-- §13's ScreenDefinition contract: a stable `screen_key`, a name, a purpose,
-- the actions, the required data, the four states, and a scope mapping through
-- `projects.screen_scope_items`. It is already produced by a running agent —
-- `ui_designer:screenInventory` on `scope.frozen` — and three rules are
-- already mechanically true at the row:
--
--   a screen may not be mapped to an EXCLUDED scope item;
--   every screen maps to at least one scope item;
--   every INCLUDED scope item has at least one screen.
--
-- Those are §7.3's *"map every screen to source requirement/scope"* and *"do
-- not silently add out-of-scope screens"*, enforced before Phase 3 existed.
-- Building a second screen model would be the duplication the Phase 3 mandate
-- forbids in its own execution protocol. **This extends.**
--
-- Three things are genuinely missing, and only three:
--
--   §7.4's *required sections* — the content baseline proper;
--   §13's *dependencies* — other screens, data or client inputs;
--   §7.3's *version* — the list as a versioned, finalizable artifact.
--
-- ── why the version is a SNAPSHOT and not a per-version screen row ──────
--
-- `projects.scope_versions` versions scope by giving each version its own
-- items, and that is the shape this repository would normally reach for. It is
-- the wrong shape here, for a reason worth writing down rather than
-- discovering later: `projects.screens` is `unique (project_id, screen_key)`,
-- and that constraint is load-bearing — Doc 12 §9 asks for duplicate screens
-- to be *refused*, not flagged, and the inventory workflow reads it to decide
-- whether a project already has an inventory. Re-keying screens per version
-- would break both, and the mandate is explicit that Phase 1 and Phase 2
-- foundations must not break.
--
-- So the live screens stay the working set — editable, scope-checked, owned by
-- the project — and a baseline **freezes what the list was** at the moment it
-- was finalized. Master §8's rule is *"editing the current state must not
-- destroy the previous decision/version trail"*, and a snapshot satisfies it
-- exactly: v1 remains readable after v2 is drafted, without either version
-- fighting the other for a `screen_key`.
--
-- ── and why `finalized` is not a screen status ──────────────────────────
--
-- Master §13's screen status list is `DRAFT / REVIEW / FINALIZED / BLOCKED`;
-- the column here has carried `draft / in_review / approved / superseded`
-- since August. These are not the same list and neither contains the other.
--
-- `blocked` is added, because §22 needs a screen whose requirement is
-- ambiguous to say so and nothing could express that. `finalized` is NOT
-- added: a screen is finalized by being in a finalized baseline, which is a
-- fact about the list rather than about the row, and `approved` already means
-- something different here — it is the design-review state the coverage
-- trigger reads. Two words for one column is how a trigger starts refusing
-- the wrong rows. Recorded in the Phase 3 traceability matrix as D-1.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── §7.4's content baseline, and §13's dependencies ─────────────────────

alter table projects.screens
  add column if not exists required_sections text,
  add column if not exists dependencies      text,
  -- Which baseline this screen was last carried into. Null until a baseline is
  -- finalized, and never a foreign key the screen depends on: a screen outlives
  -- the baseline that froze it.
  add column if not exists baseline_version  int check (baseline_version is null or baseline_version > 0);

comment on column projects.screens.required_sections is
  'Master section 7.4 - what the screen must CONTAIN, at the requirement level. Not layout: section 7.4 is explicit that this is "a content/requirements baseline, not full final visual UI", and a column that invited a layout would invite Phase 4 work into Phase 3.';

comment on column projects.screens.dependencies is
  'Master section 13 - other screens, data or client inputs this one waits on. Prose, because section 13 asks for it descriptively and nothing in Phase 3 reasons about its content; the dependencies a workflow acts on live on the operational plan (G-256), which is a different register for a different purpose.';

-- §22: "screen requirement ambiguous - PM clarification; do not guess." A
-- screen nobody can specify had no way to say so. Widening a CHECK is
-- additive: every existing row still satisfies it.
alter table projects.screens drop constraint if exists screens_status_check;
alter table projects.screens add constraint screens_status_check
  check (status in ('draft', 'in_review', 'approved', 'superseded', 'blocked'));

-- ── §7.3's versioned list ───────────────────────────────────────────────

create table if not exists projects.screen_baselines (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  version          int not null check (version > 0),

  -- Master §13's status list for the LIST. `blocked` is here rather than only
  -- on the screen because §22 blocks the phase, not one row, when the baseline
  -- cannot be completed.
  status           text not null default 'draft'
                     check (status in ('draft', 'review', 'finalized', 'blocked')),

  -- The approved scope this list was built against. §7.3: "required by
  -- approved scope." A baseline that cannot name its scope version is a list
  -- nobody can check for completeness later.
  scope_version_id uuid not null references projects.scope_versions(id) on delete restrict,

  -- §15 of the Project Planning specification taught this and G-256 carries
  -- it: a second version says why it exists.
  change_reason    text check (change_reason is null or length(btrim(change_reason)) between 1 and 500),

  -- THE SNAPSHOT. What the list WAS at finalization — every screen's key,
  -- name, role, purpose, sections, actions, dependencies, states and scope
  -- mapping, as they stood. Written once by the door and frozen by a trigger.
  -- Empty until then, because a draft baseline has nothing to remember yet.
  screens          jsonb not null default '[]'::jsonb,
  screen_count     int not null default 0 check (screen_count >= 0),

  blocked_reason   text check (blocked_reason is null or length(btrim(blocked_reason)) between 1 and 500),

  finalized_at     timestamptz,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (project_id, version),

  constraint screen_baselines_finalized_is_dated
    check (status <> 'finalized' or (finalized_at is not null and screen_count > 0)),

  constraint screen_baselines_blocked_says_why
    check (status <> 'blocked'
           or (blocked_reason is not null and length(btrim(blocked_reason)) > 0))
);

-- One draft at a time, and one finalized list per version. Partial indexes for
-- the same reason G-256 used them on the operational plan: two drafts is two
-- answers to "what are we designing against".
create unique index if not exists screen_baselines_one_draft
  on projects.screen_baselines (project_id)
  where status in ('draft', 'review');

create index if not exists screen_baselines_project_idx
  on projects.screen_baselines (organization_id, project_id, version desc);

comment on table projects.screen_baselines is
  'Master section 7.3 - the screen list as a versioned artifact. The live projects.screens rows stay the working set; a finalized baseline FREEZES what the list was, because screens are unique per (project, screen_key) and re-keying them per version would break Doc 12 section 9 duplicate refusal and the inventory workflow. Section 8: editing the current state must not destroy the previous trail.';

comment on column projects.screen_baselines.screens is
  'The frozen snapshot, written once by finalize_screen_baseline and immutable afterwards. Not a view over projects.screens: a screen edited after finalization must not silently rewrite what was agreed, which is exactly what section 8 forbids.';

-- ── nothing rewrites a finalized baseline ───────────────────────────────

create or replace function projects.freeze_finalized_screen_baseline()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'finalized' then
    raise exception 'a finalized screen baseline is history; draft the next version instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_finalized_screen_baseline on projects.screen_baselines;
create trigger freeze_finalized_screen_baseline
  before update on projects.screen_baselines
  for each row execute function projects.freeze_finalized_screen_baseline();

-- ── tenancy, as every org-scoped table carries it ───────────────────────

drop trigger if exists org_match_screen_baselines_project on projects.screen_baselines;
create trigger org_match_screen_baselines_project
  before insert or update of project_id, organization_id on projects.screen_baselines
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_screen_baselines_scope on projects.screen_baselines;
create trigger org_match_screen_baselines_scope
  before insert or update of scope_version_id, organization_id on projects.screen_baselines
  for each row execute function core.enforce_parent_org('scope_version_id', 'projects.scope_versions');

drop trigger if exists freeze_org_screen_baselines on projects.screen_baselines;
create trigger freeze_org_screen_baselines
  before update of organization_id on projects.screen_baselines
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_screen_baselines on projects.screen_baselines;
create trigger set_updated_at_screen_baselines
  before update on projects.screen_baselines
  for each row execute function core.set_updated_at();

alter table projects.screen_baselines enable row level security;
alter table projects.screen_baselines force row level security;

drop policy if exists screen_baselines_select on projects.screen_baselines;
create policy screen_baselines_select on projects.screen_baselines
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.screen_baselines to authenticated, service_role;

-- ── the events Master §15 names ─────────────────────────────────────────

insert into core.event_types (type, description, canonical) values
  ('project.screen_list_drafted',
   'Master section 15 ScreenListDrafted - a screen baseline version is open for work.',
   true),
  ('project.screen_list_finalized',
   'Master section 15 ScreenListFinalized - the screen list and its content baseline are frozen, which is what opens theme generation.',
   true)
on conflict (type) do nothing;

-- ── the doors ───────────────────────────────────────────────────────────

create or replace function projects.draft_screen_baseline(
  p_project_id    uuid,
  p_change_reason text default null
)
returns table (
  -- 'drafted' | 'already_drafting' | 'no_phase_three' | 'no_scope'
  -- | 'needs_reason' | 'no_actor' | 'forbidden'
  outcome     text,
  baseline_id uuid,
  version     int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_scope    projects.scope_versions;
  v_existing projects.screen_baselines;
  v_last     int;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::int; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.project_id = p_project_id
   for update;

  if v_phase3.id is null then
    -- §3: Phase 3 must be active. A screen baseline for a project whose UI
    -- finalization has not started is work nobody asked for.
    return query select 'no_phase_three'::text, null::uuid, null::int; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  -- §7.3: "required by approved scope." The ACTIVE baseline, because a
  -- superseded one is what the project used to be.
  select sv.* into v_scope
    from projects.scope_versions sv
   where sv.project_id = p_project_id
     and sv.status = 'active'
   order by sv.version desc
   limit 1;

  if v_scope.id is null then
    return query select 'no_scope'::text, null::uuid, null::int; return;
  end if;

  select sb.* into v_existing
    from projects.screen_baselines sb
   where sb.project_id = p_project_id
     and sb.status in ('draft', 'review')
   limit 1;

  if v_existing.id is not null then
    return query select 'already_drafting'::text, v_existing.id, v_existing.version; return;
  end if;

  select coalesce(max(sb.version), 0) into v_last
    from projects.screen_baselines sb
   where sb.project_id = p_project_id;

  -- From v2 a reason is required, the same rule G-256 made for the operational
  -- plan and for the same reason: a second version with no stated cause is a
  -- rewrite wearing a version number.
  if v_last > 0 and (p_change_reason is null or length(btrim(p_change_reason)) = 0) then
    return query select 'needs_reason'::text, null::uuid, null::int; return;
  end if;

  insert into projects.screen_baselines
    (organization_id, project_id, version, scope_version_id, change_reason, created_by)
  values
    (v_phase3.organization_id, p_project_id, v_last + 1, v_scope.id,
     nullif(btrim(coalesce(p_change_reason, '')), ''), v_actor)
  returning id into v_new;

  -- §14: the phase is in screen definition while a baseline is open.
  update projects.phase_three
     set state = 'screen_definition'
   where id = v_phase3.id
     and state in ('context_loading', 'screen_definition');

  perform core.record_audit(
    v_phase3.organization_id, 'project.screen_list_drafted', 'screen_baseline', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'version', v_last + 1)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.screen_list_drafted', 'screen_baseline', v_new,
    jsonb_build_object('projectId', p_project_id, 'version', v_last + 1)
  );

  return query select 'drafted'::text, v_new, v_last + 1;
end;
$$;

comment on function projects.draft_screen_baseline(uuid, text) is
  'Master section 7.3. Opens a screen baseline version against the ACTIVE scope version, because a superseded one is what the project used to be. One draft at a time. From v2 a change reason is required: a second version with no stated cause is a rewrite wearing a version number.';

create or replace function projects.finalize_screen_baseline(p_baseline_id uuid)
returns table (
  -- 'finalized' | 'already_finalized' | 'no_screens' | 'uncovered_scope'
  -- | 'unknown_baseline' | 'no_actor' | 'forbidden'
  outcome      text,
  screen_count int,
  findings     text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_row      projects.screen_baselines;
  v_snapshot jsonb;
  v_count    int;
  v_uncovered int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::int, '{}'::text[]; return;
  end if;

  select sb.* into v_row
    from projects.screen_baselines sb
   where sb.id = p_baseline_id
   for update;

  if v_row.id is null then
    return query select 'unknown_baseline'::text, null::int, '{}'::text[]; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::int, '{}'::text[]; return;
  end if;

  if v_row.status = 'finalized' then
    return query select 'already_finalized'::text, v_row.screen_count, '{}'::text[]; return;
  end if;

  -- §7.3: "the COMPLETE screen list." An empty list is not a list.
  select count(*) into v_count
    from projects.screens s
   where s.project_id = v_row.project_id
     and s.status <> 'superseded';

  if v_count = 0 then
    return query select 'no_screens'::text, 0, '{}'::text[]; return;
  end if;

  -- §7.3's completeness, checked against the baseline's OWN scope version.
  -- The August trigger already refuses a design entering review while an
  -- included item has no screen; this is the same rule asked at a different
  -- moment, because a baseline is finalized long before any design is filed.
  select count(*) into v_uncovered
    from projects.scope_items si
   where si.scope_version_id = v_row.scope_version_id
     and si.inclusion = 'included'
     and not exists (
       select 1
         from projects.screen_scope_items ssi
         join projects.screens s on s.id = ssi.screen_id
        where ssi.scope_item_id = si.id
          and s.project_id = v_row.project_id
          and s.status <> 'superseded'
     );

  if v_uncovered > 0 then
    return query select 'uncovered_scope'::text, v_count,
      array[format('uncovered_scope_items:%s', v_uncovered)]::text[];
    return;
  end if;

  -- THE SNAPSHOT. Every field §13's contract names, as it stands right now.
  select jsonb_agg(
           jsonb_build_object(
             'screenKey', s.screen_key,
             'name', s.name,
             'userRole', s.user_role,
             'purpose', s.purpose,
             'requiredSections', s.required_sections,
             'requiredData', s.required_data,
             'actions', s.actions,
             'dependencies', s.dependencies,
             'entryPoint', s.entry_point,
             'exitAction', s.exit_action,
             'states', jsonb_build_object(
               'empty', s.has_empty_state,
               'loading', s.has_loading_state,
               'error', s.has_error_state,
               'success', s.has_success_state
             ),
             'scopeItemIds', coalesce((
               select jsonb_agg(ssi.scope_item_id)
                 from projects.screen_scope_items ssi
                where ssi.screen_id = s.id
             ), '[]'::jsonb)
           )
           order by s.screen_key
         )
    into v_snapshot
    from projects.screens s
   where s.project_id = v_row.project_id
     and s.status <> 'superseded';

  update projects.screen_baselines
     set status = 'finalized',
         screens = coalesce(v_snapshot, '[]'::jsonb),
         screen_count = v_count,
         finalized_at = now()
   where id = v_row.id;

  -- Which list each screen was last carried into. A stamp, not a reference:
  -- the screen outlives the baseline and editing it later must not reach back
  -- into the snapshot.
  update projects.screens
     set baseline_version = v_row.version
   where project_id = v_row.project_id
     and status <> 'superseded';

  -- §14: a finalized list is what opens theme generation.
  update projects.phase_three
     set state = 'theme_generation'
   where project_id = v_row.project_id
     and state = 'screen_definition';

  perform core.record_audit(
    v_row.organization_id, 'project.screen_list_finalized', 'screen_baseline', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'version', v_row.version, 'screens', v_count)
  );

  perform core.emit_event(
    v_row.organization_id, 'project.screen_list_finalized', 'screen_baseline', v_row.id,
    jsonb_build_object('projectId', v_row.project_id, 'version', v_row.version, 'screens', v_count)
  );

  return query select 'finalized'::text, v_count, '{}'::text[];
end;
$$;

comment on function projects.finalize_screen_baseline(uuid) is
  'Master section 7.3 and 7.4. Freezes what the screen list WAS, as a snapshot, because section 8 says editing the current state must not destroy the previous trail. Refuses an empty list and refuses a list that leaves an INCLUDED scope item with no screen - the same completeness rule the August coverage trigger enforces at design review, asked here at the earlier moment a baseline is actually finalized. Returns the count of uncovered items rather than a bare refusal, because a checklist refusal somebody has to investigate is a refusal nobody acts on.';

revoke all on function projects.draft_screen_baseline(uuid, text) from public, anon;
revoke all on function projects.finalize_screen_baseline(uuid) from public, anon;
grant execute on function projects.draft_screen_baseline(uuid, text) to authenticated;
grant execute on function projects.finalize_screen_baseline(uuid) to authenticated;

notify pgrst, 'reload schema';
