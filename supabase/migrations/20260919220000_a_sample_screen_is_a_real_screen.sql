-- ═══════════════════════════════════════════════════════════════════════════
-- A sample screen is a real screen.
--
-- Designer §7, §17, §19, §23 and UI3-I06.
--
-- §19 asks for a `RepresentativeScreen` carrying *"screenDefinition link,
-- theme link, Figma node, preview"*, and §17 states the rule that makes the
-- first of those mandatory rather than convenient:
--
--   *"Every designed screen or representative sample maps to an approved
--   ScreenDefinition or explicitly approved design requirement."*
--
-- So `screen_id` is NOT NULL and the door refuses a screen that is not
-- `approved`. A sample that maps to nothing is a designer inventing a screen —
-- §17's next line is *"may visually interpret an approved requirement but must
-- not invent new business logic"*, and a picture of a screen nobody approved
-- is the invention, whatever the caption says.
--
-- ── coverage is REPORTED, not enforced, and that is deliberate ─────────
--
-- §7 asks for *"at least one primary/home/dashboard-like screen **when
-- applicable**"* and *"at least one content/detail/form/list pattern **when
-- applicable**."*
--
-- Both are hedged, twice, in a document that elsewhere says *"must"* without
-- hedging. A tool with no dashboard has no dashboard to sample, and refusing
-- to proceed until one exists would invent a rule the specification
-- deliberately softened — and would be unanswerable, because the fix does not
-- exist.
--
-- So `projects.representative_coverage()` **answers a question**: which of
-- §7's patterns this direction has a sample for and which it does not. A
-- person reads that and decides. That is the same shape as
-- `pre_kickoff_readiness`, and for the same reason: the check belongs where
-- somebody can act on it, and a gate belongs only where the rule is absolute.
--
-- ── redundancy is refused, because §7 names its cost ──────────────────
--
-- §7: *"Do not create redundant sample screens that add cost without decision
-- value."* The same screen sampled twice for the same direction is that,
-- exactly — a second render of a decision already made. One row per
-- (theme, screen), by constraint.
--
-- ── and a locked direction's samples are what it was judged on ────────
--
-- §18 requires representative screens to *"remain available as reference"*, so
-- they are never deleted. Adding one **after** the lock is the other half of
-- the same idea and is refused: the samples are the evidence the direction was
-- judged on, and a set that can grow after the decision is no longer a record
-- of what was judged. Same doctrine as G-282's frozen share.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.representative_screens (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- §19's "theme link". A sample demonstrates one direction; the same screen
  -- drawn in two directions is two samples, which is the point of them.
  theme_option_id  uuid not null references projects.theme_options(id) on delete cascade,

  -- §17's rule, in DDL. NOT NULL, because a sample that maps to nothing is the
  -- invention §17 forbids.
  screen_id        uuid not null references projects.screens(id) on delete restrict,

  -- §7's patterns. Recorded so coverage can be answered without a person
  -- opening every sample to see what kind of screen it is.
  pattern          text not null
                     check (pattern in ('primary', 'list', 'detail', 'form',
                                        'navigation', 'state')),

  -- §19's "Figma node, preview". §8 makes Figma canonical and permits a
  -- preview as a secondary artifact; what is refused is having neither,
  -- because a sample nobody can look at demonstrates nothing.
  figma_node_id    text,
  preview_asset_url text,

  -- §7: "expose the most important visual decisions." What this sample is for,
  -- in the words of the person who chose it.
  decision_note    text check (decision_note is null or length(btrim(decision_note)) between 1 and 500),

  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- §7: "do not create redundant sample screens that add cost without decision
  -- value." The same screen twice for the same direction is that, exactly.
  unique (theme_option_id, screen_id),

  constraint representative_screens_something_to_look_at
    check (figma_node_id is not null or preview_asset_url is not null)
);

comment on table projects.representative_screens is
  'Designer section 19 RepresentativeScreen. screen_id is NOT NULL and the door refuses a screen that is not approved, because section 17 requires every sample to map to an approved ScreenDefinition - a sample that maps to nothing is the invention section 17 forbids. One row per (theme, screen): section 7 names redundant samples as cost without decision value. COVERAGE IS REPORTED, NOT ENFORCED - section 7 hedges both of its "at least one" rules with "when applicable", and a tool with no dashboard has no dashboard to sample.';

comment on column projects.representative_screens.pattern is
  'Section 7 groups samples by what they expose rather than by name, so coverage can be answered without opening every sample. primary is the home/dashboard-like screen; list, detail and form are the content patterns; navigation and state are the context section 7 asks for so a reviewer can judge the direction.';

create index if not exists representative_screens_theme_idx
  on projects.representative_screens (theme_option_id, pattern);

create trigger representative_screens_parent_org_project
  before insert or update of project_id on projects.representative_screens
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger representative_screens_parent_org_theme
  before insert or update of theme_option_id on projects.representative_screens
  for each row execute function core.enforce_parent_org('theme_option_id', 'projects.theme_options');

create trigger representative_screens_parent_org_screen
  before insert or update of screen_id on projects.representative_screens
  for each row execute function core.enforce_parent_org('screen_id', 'projects.screens');

create trigger freeze_org_representative_screens
  before update of organization_id on projects.representative_screens
  for each row execute function core.freeze_organization_id();

create trigger representative_screens_updated_at
  before update on projects.representative_screens
  for each row execute function core.set_updated_at();

-- §17 and §18: which screen a sample stands for, and which direction it
-- demonstrates, are what the whole record is. A sample repointed at a
-- different screen is a different sample.
create or replace function projects.freeze_representative_mapping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.screen_id is distinct from old.screen_id
     or new.theme_option_id is distinct from old.theme_option_id then
    raise exception 'a representative screen stands for one screen in one direction; record a new one instead';
  end if;
  return new;
end;
$$;

create trigger freeze_representative_mapping
  before update on projects.representative_screens
  for each row execute function projects.freeze_representative_mapping();

alter table projects.representative_screens enable row level security;
alter table projects.representative_screens force row level security;

drop policy if exists representative_screens_select on projects.representative_screens;
create policy representative_screens_select on projects.representative_screens
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.representative_screens to authenticated, service_role;

insert into core.event_types (type, description, canonical) values
  ('project.representative_screen_recorded',
   'Designer section 19. A sample screen was recorded against a theme direction and the approved screen definition it stands for.',
   true)
on conflict (type) do nothing;

-- ── the door ────────────────────────────────────────────────────────────

create or replace function projects.record_representative_screen(
  p_theme_option_id  uuid,
  p_screen_id        uuid,
  p_pattern          text,
  p_figma_node_id    text default null,
  p_preview_asset_url text default null,
  p_decision_note    text default null
)
returns table (
  -- 'recorded' | 'no_actor' | 'forbidden' | 'unknown_theme' | 'unknown_screen'
  -- | 'bad_pattern' | 'screen_not_approved' | 'screen_not_in_project'
  -- | 'nothing_to_show' | 'already_sampled' | 'direction_locked'
  outcome text,
  sample_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_theme  projects.theme_options;
  v_screen projects.screens;
  v_node   text := nullif(btrim(coalesce(p_figma_node_id, '')), '');
  v_url    text := nullif(btrim(coalesce(p_preview_asset_url, '')), '');
  v_new    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  -- Argument-only refusals, before any row is read.
  if p_pattern not in ('primary', 'list', 'detail', 'form', 'navigation', 'state') then
    return query select 'bad_pattern'::text, null::uuid; return;
  end if;

  -- §8: a preview is a secondary artifact and either satisfies this. What is
  -- refused is having neither, because a sample nobody can look at
  -- demonstrates nothing.
  if v_node is null and v_url is null then
    return query select 'nothing_to_show'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t where t.id = p_theme_option_id;
  if v_theme.id is null then
    return query select 'unknown_theme'::text, null::uuid; return;
  end if;

  if v_theme.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- §18: the samples are the evidence the direction was judged on. A set that
  -- can grow after the decision is no longer a record of what was judged.
  if v_theme.client_status = 'locked' then
    return query select 'direction_locked'::text, null::uuid; return;
  end if;

  select s.* into v_screen from projects.screens s where s.id = p_screen_id;
  if v_screen.id is null then
    return query select 'unknown_screen'::text, null::uuid; return;
  end if;

  -- A sample for this project's direction that stands for another project's
  -- screen is not a mapping, whatever it looks like.
  if v_screen.project_id is distinct from v_theme.project_id then
    return query select 'screen_not_in_project'::text, null::uuid; return;
  end if;

  -- §17, the rule this table exists to hold.
  if v_screen.status <> 'approved' then
    return query select 'screen_not_approved'::text, null::uuid; return;
  end if;

  -- §7's redundancy rule, answered rather than raised: a constraint violation
  -- tells a caller nothing it can act on.
  if exists (
    select 1 from projects.representative_screens r
     where r.theme_option_id = p_theme_option_id
       and r.screen_id = p_screen_id
  ) then
    return query select 'already_sampled'::text, null::uuid; return;
  end if;

  insert into projects.representative_screens (
    organization_id, project_id, theme_option_id, screen_id, pattern,
    figma_node_id, preview_asset_url, decision_note, created_by
  ) values (
    v_theme.organization_id, v_theme.project_id, p_theme_option_id, p_screen_id, p_pattern,
    v_node, v_url, nullif(btrim(coalesce(p_decision_note, '')), ''), v_actor
  )
  returning id into v_new;

  perform core.record_audit(
    v_theme.organization_id, 'representative_screen.recorded', 'representative_screen', v_new, null,
    jsonb_build_object('projectId', v_theme.project_id, 'themeOptionId', p_theme_option_id,
                       'screenId', p_screen_id, 'pattern', p_pattern)
  );

  perform core.emit_event(
    v_theme.organization_id, 'project.representative_screen_recorded',
    'representative_screen', v_new,
    jsonb_build_object('projectId', v_theme.project_id, 'themeOptionId', p_theme_option_id,
                       'pattern', p_pattern)
  );

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function projects.record_representative_screen(uuid, uuid, text, text, text, text) is
  'Designer sections 7, 17 and 19. Records a sample screen against the direction it demonstrates AND the approved screen definition it stands for. Section 17: every sample maps to an APPROVED ScreenDefinition, so a draft screen is refused - a sample that maps to nothing is the invention section 17 forbids. The same screen twice for one direction is refused as already_sampled, because section 7 names redundant samples as cost without decision value. A locked direction takes no new samples: they are the evidence it was judged on. It records; it draws nothing.';

revoke all on function projects.record_representative_screen(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function projects.record_representative_screen(uuid, uuid, text, text, text, text) to authenticated;

-- ── §7's coverage, ANSWERED rather than enforced ────────────────────────

create or replace function projects.representative_coverage(p_theme_option_id uuid)
returns table (
  sample_count   int,
  has_primary    boolean,
  has_content    boolean,
  has_context    boolean,
  -- What §7 asks for that this direction has no sample of. A LIST, not a
  -- verdict: §7 hedges both of its "at least one" rules with "when
  -- applicable", and a tool with no dashboard has no dashboard to sample.
  unmet          text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (
    select r.pattern
      from projects.representative_screens r
      join projects.theme_options t on t.id = r.theme_option_id
     where r.theme_option_id = p_theme_option_id
       and t.organization_id = (select core.current_organization_id())
       and (select core.is_internal())
  ), counted as (
    select
      count(*)::int                                                          as sample_count,
      bool_or(pattern = 'primary')                                           as has_primary,
      bool_or(pattern in ('list', 'detail', 'form'))                         as has_content,
      bool_or(pattern in ('navigation', 'state'))                            as has_context
    from mine
  )
  select
    c.sample_count,
    coalesce(c.has_primary, false),
    coalesce(c.has_content, false),
    coalesce(c.has_context, false),
    array_remove(array[
      case when not coalesce(c.has_primary, false)
        then 'no primary, home or dashboard-like screen is sampled' end,
      case when not coalesce(c.has_content, false)
        then 'no content pattern is sampled: a list, a detail view or a form' end,
      case when not coalesce(c.has_context, false)
        then 'no navigation or state context is sampled, so a reviewer sees screens without the frame around them' end
    ], null)
  from counted c;
$$;

comment on function projects.representative_coverage(uuid) is
  'Designer section 7, ANSWERED and not enforced. Reports which of section 7''s patterns a direction has a sample for and which it does not. Section 7 hedges both of its "at least one" rules with "when applicable" - twice, in a document that elsewhere says "must" without hedging - so a gate here would invent a rule the specification deliberately softened, and would be unanswerable for a product with no dashboard. Same shape as pre_kickoff_readiness: the check belongs where somebody can act on it.';

revoke all on function projects.representative_coverage(uuid) from public, anon;
grant execute on function projects.representative_coverage(uuid) to authenticated;

notify pgrst, 'reload schema';
