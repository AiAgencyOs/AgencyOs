-- ═══════════════════════════════════════════════════════════════════════════
-- A screen is written by a person.
--
-- Four element-level gaps from docs/AGENCYOS_ADMIN_REMAINING_GAPS.md, the
-- Design & Prototype rows the bucket A build had to leave open:
--
--   SCR-032/034/035  Add, merge, split a screen; mark its design state;
--                    attach the Figma link; map it to a requirement; submit
--                    it for QA. `projects.screens` and `screen_scope_items`
--                    were SELECT-only for staff (20260821230000 built them
--                    for the designer agent, which writes as service_role),
--                    there was no Figma column, no design state and no QA
--                    transition on the row.
--   SCR-038          Link a reference asset to a screen or a UI version.
--                    `projects.design_assets` had no join table, so the
--                    asset folders could only show what was generated.
--
-- ── the rule this relaxes, and the rule it keeps ─────────────────────────
--
-- Staff gain INSERT/UPDATE on `projects.screens` and INSERT/DELETE on
-- `projects.screen_scope_items`, for `core.can_manage_delivery()` — the same
-- roles `handovers_write` admits and the roles holding `project.write`.
--
-- What they may NOT do is rewrite a list that was already agreed. Master
-- §7.3 versions the screen list and 20260918150000 freezes a finalized
-- baseline as a snapshot; the live `screens` rows stayed editable because
-- nothing but the agent could write them. Now a person can, so the row
-- itself refuses: `refuse_screen_write_after_finalized_baseline` fires on
-- every content column of a screen and on every mapping row, and raises
-- when the project's LATEST screen baseline is finalized (or blocked) with
-- no draft open. Draft the next version (`draft_screen_baseline`) and the
-- list opens again. A project with NO baseline yet is open — that is the
-- moment the inventory agent writes its first rows and nothing has been
-- agreed to protect.
--
-- `baseline_version` and `deliverable_id` are deliberately outside the
-- trigger's column list: `finalize_screen_baseline` stamps the former on
-- the very rows it has just frozen, and the latter is set by the act of
-- filing a design, which is a different register. So are `design_state`,
-- `figma_url` and `qa_status`: drawing a screen, linking its Figma frame
-- and handing it to QA are what happens AFTER the list is agreed, and a
-- finalized list is exactly when they must stay writable. The baseline
-- freezes WHICH screens exist and what they cover — add, merge, split and
-- the scope mapping — and nothing else.
--
-- ── merge and split keep the trail ───────────────────────────────────────
--
-- A merged or split screen is not deleted: it becomes `superseded` and
-- `superseded_by` names the row that replaced it (the first part, for a
-- split). Master §8: editing the current state must not destroy the
-- previous trail. Because a superseded row keeps its `screen_key`, the
-- replacement needs a key of its own — the (project, screen_key) unique
-- constraint is load-bearing for Doc 12 §9 and is not loosened.
--
-- ── the coverage matrix stops seeing superseded rows ─────────────────────
--
-- `projects.ui_coverage` counted every screen. A superseded screen with no
-- mapping would flag `screen_has_no_scope_mapping` and a superseded
-- screen's old mapping would count as coverage for an item the replacement
-- no longer covers. It is re-emitted excluding `status = 'superseded'` in
-- all four branches — the same exclusion `finalize_screen_baseline` already
-- makes. `refuse_uncovered_design` reads `ui_coverage`, so the gate follows.
--
-- ── every governed write is audited ──────────────────────────────────────
--
-- add, merge, split, a design-state change and a QA submission are doors
-- (plpgsql, security definer, `can_manage_delivery()`, audit.audit_log from
-- inside the transaction). The Figma link, a scope mapping and an asset link
-- are plain row writes under the new policies: none of them is a decision,
-- and the triggers decide for them.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the columns SCR-034/035 draw ─────────────────────────────────────────

alter table projects.screens
  add column if not exists figma_url     text,
  add column if not exists design_state  text not null default 'not_started',
  add column if not exists qa_status     text not null default 'not_submitted',
  add column if not exists superseded_by uuid references projects.screens(id) on delete set null;

alter table projects.screens drop constraint if exists screens_figma_url_is_https;
alter table projects.screens add constraint screens_figma_url_is_https
  check (figma_url is null or figma_url ~ '^https://');

alter table projects.screens drop constraint if exists screens_design_state_check;
alter table projects.screens add constraint screens_design_state_check
  check (design_state in ('not_started', 'in_progress', 'drawn', 'reviewed'));

alter table projects.screens drop constraint if exists screens_qa_status_check;
alter table projects.screens add constraint screens_qa_status_check
  check (qa_status in ('not_submitted', 'submitted'));

alter table projects.screens drop constraint if exists screens_superseded_by_is_another_screen;
alter table projects.screens add constraint screens_superseded_by_is_another_screen
  check (superseded_by is null or superseded_by <> id);

-- A row that names its replacement IS superseded; the two facts cannot drift.
alter table projects.screens drop constraint if exists screens_superseded_by_means_superseded;
alter table projects.screens add constraint screens_superseded_by_means_superseded
  check (superseded_by is null or status = 'superseded');

create index if not exists screens_superseded_by_idx
  on projects.screens (superseded_by)
  where superseded_by is not null;

comment on column projects.screens.figma_url is
  'SCR-035 - the Figma frame a person attached to this screen. A link, not a sync: figma_verified_at on theme_options is the verified fact, this is what somebody typed.';
comment on column projects.screens.design_state is
  'SCR-034 - how far the drawing has got: not_started, in_progress, drawn, reviewed. Distinct from status (the coverage/review state the August trigger reads) and from the baseline (a fact about the list).';
comment on column projects.screens.qa_status is
  'SCR-035 - not_submitted until submit_screen_for_qa, then submitted. The test-plan item it may create lives in qa.test_plan_items through qa.add_test_plan_item; this column only says the screen was handed over.';
comment on column projects.screens.superseded_by is
  'The screen that replaced this one after a merge or a split. The superseded row keeps its key and its mappings as history (Master section 8).';

drop trigger if exists org_match_screens_superseded_by on projects.screens;
create trigger org_match_screens_superseded_by
  before insert or update of superseded_by, organization_id on projects.screens
  for each row execute function core.enforce_parent_org('superseded_by', 'projects.screens');

drop trigger if exists set_updated_at_screens on projects.screens;
create trigger set_updated_at_screens
  before update on projects.screens
  for each row execute function core.set_updated_at();

-- ── is the list open? ────────────────────────────────────────────────────
--
-- Null when the list may be edited (no baseline yet, or a draft/review
-- baseline is open). Otherwise the sentence the refusal carries.

create or replace function projects.screen_list_closed_by(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when sb.id is null then null
           when sb.status in ('draft', 'review') then null
           else format('screen baseline v%s is %s', sb.version, sb.status)
         end
    from (select 1) as one
    left join lateral (
      select b.id, b.version, b.status
        from projects.screen_baselines b
       where b.project_id = p_project_id
       order by b.version desc
       limit 1
    ) sb on true;
$$;

comment on function projects.screen_list_closed_by(uuid) is
  'Null while the screen list may be edited: no screen baseline exists yet, or the latest one is draft/review. Otherwise "screen baseline vN is finalized" (or blocked) - the sentence the row-level refusal and the panel both show.';

revoke all on function projects.screen_list_closed_by(uuid) from public, anon;
grant execute on function projects.screen_list_closed_by(uuid) to authenticated, service_role;

create or replace function projects.refuse_screen_write_after_finalized_baseline()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project uuid;
  v_closed  text;
begin
  if tg_table_name = 'screens' then
    v_project := coalesce(new.project_id, old.project_id);
  else
    -- screen_scope_items: the project is the screen's.
    select s.project_id into v_project
      from projects.screens s
     where s.id = coalesce(new.screen_id, old.screen_id);
  end if;

  v_closed := projects.screen_list_closed_by(v_project);
  if v_closed is not null then
    raise exception '%; draft the next screen baseline before changing the screen list', v_closed
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function projects.refuse_screen_write_after_finalized_baseline() is
  'Master section 7.3/8: a finalized screen list is what was agreed. Refuses any write to the LIST - a screen''s definition columns, its status/superseded_by, and any change to projects.screen_scope_items - while the project''s latest screen baseline is finalized or blocked with no draft open. Outside the column list on purpose: baseline_version (finalize_screen_baseline stamps it on the rows it has just frozen), deliverable_id (filing a design), and design_state / figma_url / qa_status (drawing, linking and handing to QA happen after the list is agreed).';

drop trigger if exists refuse_screen_write_after_finalized_baseline on projects.screens;
create trigger refuse_screen_write_after_finalized_baseline
  before insert or update of
    project_id, screen_key, name, user_role, purpose, entry_point, exit_action,
    required_data, actions, validation, required_sections, dependencies,
    has_empty_state, has_loading_state, has_error_state, has_success_state,
    permission_behaviour, responsive_behaviour, accessibility_notes,
    status, superseded_by
  on projects.screens
  for each row execute function projects.refuse_screen_write_after_finalized_baseline();

drop trigger if exists refuse_screen_mapping_after_finalized_baseline on projects.screen_scope_items;
create trigger refuse_screen_mapping_after_finalized_baseline
  before insert or update or delete on projects.screen_scope_items
  for each row execute function projects.refuse_screen_write_after_finalized_baseline();

-- ── the policies this relaxes ────────────────────────────────────────────

drop policy if exists screens_insert on projects.screens;
create policy screens_insert on projects.screens
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

drop policy if exists screens_update on projects.screens;
create policy screens_update on projects.screens
  for update to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

drop policy if exists screen_scope_items_insert on projects.screen_scope_items;
create policy screen_scope_items_insert on projects.screen_scope_items
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

drop policy if exists screen_scope_items_delete on projects.screen_scope_items;
create policy screen_scope_items_delete on projects.screen_scope_items
  for delete to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

grant select, insert, update on projects.screens to authenticated, service_role;
grant select, insert, delete on projects.screen_scope_items to authenticated, service_role;

-- ── the coverage matrix, without superseded rows ─────────────────────────

create or replace function projects.ui_coverage(p_project_id uuid)
returns table (
  flag        text,
  blocking    boolean,
  subject_id  uuid,
  subject     text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with baseline as (
    select sv.id
      from projects.scope_versions sv
     where sv.project_id = p_project_id
       and sv.status = 'active'
     limit 1
  )
  -- §20 "All major features represented." Blocks.
  select 'included_scope_item_has_no_screen'::text, true, si.id, si.title
    from projects.scope_items si
    join baseline b on b.id = si.scope_version_id
   where si.inclusion = 'included'
     and not exists (
       select 1 from projects.screen_scope_items m
         join projects.screens s on s.id = m.screen_id
        where m.scope_item_id = si.id and s.project_id = p_project_id
          and s.status <> 'superseded'
     )

  union all
  -- §20 "All screens have feature/requirement mapping." Blocks.
  select 'screen_has_no_scope_mapping', true, s.id, s.name
    from projects.screens s
   where s.project_id = p_project_id
     and s.status <> 'superseded'
     and not exists (select 1 from projects.screen_scope_items m where m.screen_id = s.id)

  union all
  -- §9 "flag missing error/empty/loading states." Does NOT block.
  select 'screen_missing_states', false, s.id,
         s.name || ' — missing ' || array_to_string(array_remove(array[
           case when not s.has_empty_state   then 'empty'   end,
           case when not s.has_loading_state then 'loading' end,
           case when not s.has_error_state   then 'error'   end,
           case when not s.has_success_state then 'success' end
         ], null), ', ')
    from projects.screens s
   where s.project_id = p_project_id
     and s.status <> 'superseded'
     and not (s.has_empty_state and s.has_loading_state and s.has_error_state and s.has_success_state)

  union all
  -- §20 "Optional features": worth seeing, not a failure.
  select 'optional_scope_item_has_no_screen', false, si.id, si.title
    from projects.scope_items si
    join baseline b on b.id = si.scope_version_id
   where si.inclusion = 'optional'
     and not exists (
       select 1 from projects.screen_scope_items m
         join projects.screens s on s.id = m.screen_id
        where m.scope_item_id = si.id and s.project_id = p_project_id
          and s.status <> 'superseded'
     )

  order by 2 desc, 1, 4;
$$;

comment on function projects.ui_coverage(uuid) is
  'Doc 12 section 9''s screen coverage matrix, as rows. Reports every flag the document names; `blocking` marks the three that are mechanically exact (Doc 12 section 20) and are refused by projects.refuse_uncovered_design. Superseded screens (merged or split away) are neither coverage nor a gap - the same exclusion finalize_screen_baseline makes.';

-- ── the doors ────────────────────────────────────────────────────────────

create or replace function projects.add_screen(
  p_project_id        uuid,
  p_screen_key        text,
  p_name              text,
  p_user_role         text,
  p_purpose           text    default null,
  p_required_sections text    default null,
  p_actions           text    default null,
  p_required_data     text    default null,
  p_dependencies      text    default null,
  p_entry_point       text    default null,
  p_exit_action       text    default null,
  p_has_empty_state   boolean default false,
  p_has_loading_state boolean default false,
  p_has_error_state   boolean default false,
  p_has_success_state boolean default false,
  p_scope_item_ids    uuid[]  default '{}'
)
returns table (
  -- 'added'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'list_closed' |
  --           'bad_key' | 'duplicate_key' | 'unknown_scope_item' |
  --           'excluded_scope_item'
  outcome   text,
  screen_id uuid,
  detail    text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid;
  v_closed text;
  v_new    uuid;
  v_bad    int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid, null::text; return;
  end if;

  select p.organization_id into v_org
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = (select core.current_organization_id());

  if v_org is null then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;

  v_closed := projects.screen_list_closed_by(p_project_id);
  if v_closed is not null then
    return query select 'list_closed'::text, null::uuid, v_closed; return;
  end if;

  if p_screen_key is null or p_screen_key !~ '^[a-z][a-z0-9_.-]{1,62}$' then
    return query select 'bad_key'::text, null::uuid, null::text; return;
  end if;

  if exists (select 1 from projects.screens s where s.project_id = p_project_id and s.screen_key = p_screen_key) then
    return query select 'duplicate_key'::text, null::uuid, p_screen_key; return;
  end if;

  -- A scope item outside this project is not a requirement of it, and an
  -- excluded one is refused here with a name rather than by the row trigger
  -- with a uuid.
  select count(*) into v_bad
    from unnest(coalesce(p_scope_item_ids, '{}')) as ids(id)
   where not exists (
     select 1 from projects.scope_items si
       join projects.scope_versions sv on sv.id = si.scope_version_id
      where si.id = ids.id and sv.project_id = p_project_id
   );
  if v_bad > 0 then
    return query select 'unknown_scope_item'::text, null::uuid, null::text; return;
  end if;

  select string_agg(si.title, ', ') into v_closed
    from projects.scope_items si
   where si.id = any (coalesce(p_scope_item_ids, '{}'))
     and si.inclusion = 'excluded';
  if v_closed is not null then
    return query select 'excluded_scope_item'::text, null::uuid, v_closed; return;
  end if;

  insert into projects.screens (
    organization_id, project_id, screen_key, name, user_role, purpose,
    required_sections, actions, required_data, dependencies, entry_point, exit_action,
    has_empty_state, has_loading_state, has_error_state, has_success_state, created_by
  ) values (
    v_org, p_project_id, p_screen_key, btrim(p_name), btrim(p_user_role),
    nullif(btrim(coalesce(p_purpose, '')), ''),
    nullif(btrim(coalesce(p_required_sections, '')), ''),
    nullif(btrim(coalesce(p_actions, '')), ''),
    nullif(btrim(coalesce(p_required_data, '')), ''),
    nullif(btrim(coalesce(p_dependencies, '')), ''),
    nullif(btrim(coalesce(p_entry_point, '')), ''),
    nullif(btrim(coalesce(p_exit_action, '')), ''),
    coalesce(p_has_empty_state, false), coalesce(p_has_loading_state, false),
    coalesce(p_has_error_state, false), coalesce(p_has_success_state, false),
    v_actor
  )
  returning id into v_new;

  insert into projects.screen_scope_items (organization_id, screen_id, scope_item_id)
  select v_org, v_new, ids.id
    from unnest(coalesce(p_scope_item_ids, '{}')) as ids(id)
  on conflict do nothing;

  perform core.record_audit(
    v_org, 'project.screen_added', 'screen', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'screenKey', p_screen_key, 'scopeItemIds', to_jsonb(coalesce(p_scope_item_ids, '{}')))
  );

  return query select 'added'::text, v_new, null::text;
end;
$$;

comment on function projects.add_screen(uuid, text, text, text, text, text, text, text, text, text, text, boolean, boolean, boolean, boolean, uuid[]) is
  'SCR-034 - a person adds a screen to the working list, with the Doc 12 section 9 fields the table has and the scope items it covers. can_manage_delivery(). Refuses list_closed while the latest screen baseline is finalized, duplicate_key (Doc 12 section 9 refuses duplicates), and an excluded scope item by name. Audited.';

revoke all on function projects.add_screen(uuid, text, text, text, text, text, text, text, text, text, text, boolean, boolean, boolean, boolean, uuid[]) from public, anon;
grant execute on function projects.add_screen(uuid, text, text, text, text, text, text, text, text, text, text, boolean, boolean, boolean, boolean, uuid[]) to authenticated;

create or replace function projects.merge_screens(
  p_source_ids uuid[],
  p_screen_key text,
  p_name       text,
  p_user_role  text default null,
  p_purpose    text default null
)
returns table (
  -- 'merged'
  -- refusals: 'no_actor' | 'not_authorized' | 'too_few' | 'not_found' |
  --           'already_superseded' | 'list_closed' | 'bad_key' | 'duplicate_key'
  outcome   text,
  screen_id uuid,
  detail    text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_ids      uuid[] := (select array_agg(distinct x) from unnest(coalesce(p_source_ids, '{}')) as u(x));
  v_org      uuid;
  v_project  uuid;
  v_found    int;
  v_gone     int;
  v_closed   text;
  v_new      uuid;
  v_first    projects.screens;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid, null::text; return;
  end if;

  if coalesce(array_length(v_ids, 1), 0) < 2 then
    return query select 'too_few'::text, null::uuid, null::text; return;
  end if;

  -- All sources: this organization, one project, none already superseded.
  select count(*), min(s.project_id), min(s.organization_id),
         count(*) filter (where s.status = 'superseded')
    into v_found, v_project, v_org, v_gone
    from projects.screens s
   where s.id = any (v_ids)
     and s.organization_id = (select core.current_organization_id());

  if v_found <> array_length(v_ids, 1)
     or exists (select 1 from projects.screens s where s.id = any (v_ids) and s.project_id <> v_project) then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;

  if v_gone > 0 then
    return query select 'already_superseded'::text, null::uuid, null::text; return;
  end if;

  v_closed := projects.screen_list_closed_by(v_project);
  if v_closed is not null then
    return query select 'list_closed'::text, null::uuid, v_closed; return;
  end if;

  if p_screen_key is null or p_screen_key !~ '^[a-z][a-z0-9_.-]{1,62}$' then
    return query select 'bad_key'::text, null::uuid, null::text; return;
  end if;

  -- The superseded rows keep their keys as history, so the merged screen
  -- needs a key of its own.
  if exists (select 1 from projects.screens s where s.project_id = v_project and s.screen_key = p_screen_key) then
    return query select 'duplicate_key'::text, null::uuid, p_screen_key; return;
  end if;

  select s.* into v_first
    from projects.screens s
   where s.id = any (v_ids)
   order by s.screen_key
   limit 1;

  -- Prose fields are carried over joined, never dropped; a state is true
  -- only when every source had it, because a merge cannot draw a state
  -- one of its parts was missing.
  insert into projects.screens (
    organization_id, project_id, screen_key, name, user_role, purpose,
    entry_point, exit_action, required_data, actions, validation,
    required_sections, dependencies, permission_behaviour, responsive_behaviour, accessibility_notes,
    has_empty_state, has_loading_state, has_error_state, has_success_state, created_by
  )
  select v_org, v_project, p_screen_key, btrim(p_name),
         coalesce(nullif(btrim(coalesce(p_user_role, '')), ''), v_first.user_role),
         coalesce(nullif(btrim(coalesce(p_purpose, '')), ''), string_agg(s.purpose, E'\n' order by s.screen_key)),
         string_agg(s.entry_point, E'\n' order by s.screen_key),
         string_agg(s.exit_action, E'\n' order by s.screen_key),
         string_agg(s.required_data, E'\n' order by s.screen_key),
         string_agg(s.actions, E'\n' order by s.screen_key),
         string_agg(s.validation, E'\n' order by s.screen_key),
         string_agg(s.required_sections, E'\n' order by s.screen_key),
         string_agg(s.dependencies, E'\n' order by s.screen_key),
         string_agg(s.permission_behaviour, E'\n' order by s.screen_key),
         string_agg(s.responsive_behaviour, E'\n' order by s.screen_key),
         string_agg(s.accessibility_notes, E'\n' order by s.screen_key),
         bool_and(s.has_empty_state), bool_and(s.has_loading_state),
         bool_and(s.has_error_state), bool_and(s.has_success_state),
         v_actor
    from projects.screens s
   where s.id = any (v_ids)
  returning id into v_new;

  -- The union of what the sources covered.
  insert into projects.screen_scope_items (organization_id, screen_id, scope_item_id)
  select distinct v_org, v_new, m.scope_item_id
    from projects.screen_scope_items m
   where m.screen_id = any (v_ids)
  on conflict do nothing;

  update projects.screens
     set status = 'superseded', superseded_by = v_new
   where id = any (v_ids);

  perform core.record_audit(
    v_org, 'project.screens_merged', 'screen', v_new,
    jsonb_build_object('sourceIds', to_jsonb(v_ids)),
    jsonb_build_object('projectId', v_project, 'screenKey', p_screen_key)
  );

  return query select 'merged'::text, v_new, null::text;
end;
$$;

comment on function projects.merge_screens(uuid[], text, text, text, text) is
  'SCR-034 - one screen from N. The sources become superseded and name their replacement; their mappings are united onto it; a state is carried only when every source had it. The merged screen needs its own key because the superseded rows keep theirs (Master section 8 trail). can_manage_delivery(); refuses while the latest screen baseline is finalized. Audited.';

revoke all on function projects.merge_screens(uuid[], text, text, text, text) from public, anon;
grant execute on function projects.merge_screens(uuid[], text, text, text, text) to authenticated;

create or replace function projects.split_screen(
  p_source_id uuid,
  -- [{"screenKey": "...", "name": "...", "userRole"?: "...", "purpose"?: "..."}, ...]
  p_parts     jsonb
)
returns table (
  -- 'split'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'already_superseded' |
  --           'list_closed' | 'too_few' | 'bad_part' | 'duplicate_key'
  outcome    text,
  screen_ids uuid[],
  detail     text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_source projects.screens;
  v_closed text;
  v_part   jsonb;
  v_key    text;
  v_new    uuid;
  v_ids    uuid[] := '{}';
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid[], null::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid[], null::text; return;
  end if;

  select s.* into v_source
    from projects.screens s
   where s.id = p_source_id
     and s.organization_id = (select core.current_organization_id())
   for update;

  if v_source.id is null then
    return query select 'not_found'::text, null::uuid[], null::text; return;
  end if;

  if v_source.status = 'superseded' then
    return query select 'already_superseded'::text, null::uuid[], null::text; return;
  end if;

  v_closed := projects.screen_list_closed_by(v_source.project_id);
  if v_closed is not null then
    return query select 'list_closed'::text, null::uuid[], v_closed; return;
  end if;

  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) < 2 then
    return query select 'too_few'::text, null::uuid[], null::text; return;
  end if;

  -- Validate every part before writing any.
  for v_part in select * from jsonb_array_elements(p_parts) loop
    v_key := v_part ->> 'screenKey';
    if v_key is null or v_key !~ '^[a-z][a-z0-9_.-]{1,62}$'
       or length(btrim(coalesce(v_part ->> 'name', ''))) = 0 then
      return query select 'bad_part'::text, null::uuid[], v_key; return;
    end if;
    if exists (select 1 from projects.screens s where s.project_id = v_source.project_id and s.screen_key = v_key)
       or (select count(*) from jsonb_array_elements(p_parts) q where q.value ->> 'screenKey' = v_key) > 1 then
      return query select 'duplicate_key'::text, null::uuid[], v_key; return;
    end if;
  end loop;

  -- Each part inherits the role, the four states and every mapping of the
  -- source, so the split loses no coverage; a person then unmaps what a part
  -- does not cover. The prose stays on the superseded row as history.
  for v_part in select * from jsonb_array_elements(p_parts) loop
    insert into projects.screens (
      organization_id, project_id, screen_key, name, user_role, purpose,
      has_empty_state, has_loading_state, has_error_state, has_success_state, created_by
    ) values (
      v_source.organization_id, v_source.project_id, v_part ->> 'screenKey', btrim(v_part ->> 'name'),
      coalesce(nullif(btrim(coalesce(v_part ->> 'userRole', '')), ''), v_source.user_role),
      coalesce(nullif(btrim(coalesce(v_part ->> 'purpose', '')), ''), v_source.purpose),
      v_source.has_empty_state, v_source.has_loading_state, v_source.has_error_state, v_source.has_success_state,
      v_actor
    )
    returning id into v_new;

    insert into projects.screen_scope_items (organization_id, screen_id, scope_item_id)
    select v_source.organization_id, v_new, m.scope_item_id
      from projects.screen_scope_items m
     where m.screen_id = v_source.id
    on conflict do nothing;

    v_ids := v_ids || v_new;
  end loop;

  update projects.screens
     set status = 'superseded', superseded_by = v_ids[1]
   where id = v_source.id;

  perform core.record_audit(
    v_source.organization_id, 'project.screen_split', 'screen', v_source.id,
    jsonb_build_object('screenKey', v_source.screen_key),
    jsonb_build_object('projectId', v_source.project_id, 'partIds', to_jsonb(v_ids))
  );

  return query select 'split'::text, v_ids, null::text;
end;
$$;

comment on function projects.split_screen(uuid, jsonb) is
  'SCR-034 - N screens from one. Every part inherits the role, the four states and every scope mapping of the source so no coverage is lost by the split; the source becomes superseded and names the first part. can_manage_delivery(); refuses while the latest screen baseline is finalized. Audited.';

revoke all on function projects.split_screen(uuid, jsonb) from public, anon;
grant execute on function projects.split_screen(uuid, jsonb) to authenticated;

create or replace function projects.set_screen_design_state(
  p_screen_id    uuid,
  p_design_state text
)
returns table (
  -- 'set' | 'unchanged'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'superseded' |
  --           'bad_state'
  outcome text,
  detail  text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.screens;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::text; return;
  end if;

  if p_design_state not in ('not_started', 'in_progress', 'drawn', 'reviewed') then
    return query select 'bad_state'::text, null::text; return;
  end if;

  select s.* into v_row
    from projects.screens s
   where s.id = p_screen_id
     and s.organization_id = (select core.current_organization_id())
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text; return;
  end if;

  if v_row.status = 'superseded' then
    return query select 'superseded'::text, null::text; return;
  end if;

  if v_row.design_state = p_design_state then
    return query select 'unchanged'::text, null::text; return;
  end if;

  update projects.screens set design_state = p_design_state where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'project.screen_design_state_set', 'screen', v_row.id,
    jsonb_build_object('designState', v_row.design_state),
    jsonb_build_object('designState', p_design_state, 'projectId', v_row.project_id)
  );

  return query select 'set'::text, null::text;
end;
$$;

comment on function projects.set_screen_design_state(uuid, text) is
  'SCR-034 - marks how far a screen''s drawing has got (not_started / in_progress / drawn / reviewed). can_manage_delivery(); refuses a superseded screen. Not bound to the screen baseline: drawing happens after the list is agreed. Audited.';

revoke all on function projects.set_screen_design_state(uuid, text) from public, anon;
grant execute on function projects.set_screen_design_state(uuid, text) to authenticated;

create or replace function projects.submit_screen_for_qa(p_screen_id uuid)
returns table (
  -- 'submitted' | 'already_submitted'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'superseded'
  outcome        text,
  scope_item_ids uuid[],
  detail         text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_row    projects.screens;
  v_items  uuid[];
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid[], null::text; return;
  end if;

  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid[], null::text; return;
  end if;

  select s.* into v_row
    from projects.screens s
   where s.id = p_screen_id
     and s.organization_id = (select core.current_organization_id())
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid[], null::text; return;
  end if;

  if v_row.status = 'superseded' then
    return query select 'superseded'::text, null::uuid[], null::text; return;
  end if;

  select coalesce(array_agg(m.scope_item_id), '{}') into v_items
    from projects.screen_scope_items m
   where m.screen_id = v_row.id;

  if v_row.qa_status = 'submitted' then
    return query select 'already_submitted'::text, v_items, null::text; return;
  end if;

  update projects.screens set qa_status = 'submitted' where id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'project.screen_submitted_for_qa', 'screen', v_row.id,
    jsonb_build_object('qaStatus', v_row.qa_status),
    jsonb_build_object('qaStatus', 'submitted', 'projectId', v_row.project_id, 'scopeItemIds', to_jsonb(v_items))
  );

  return query select 'submitted'::text, v_items, null::text;
end;
$$;

comment on function projects.submit_screen_for_qa(uuid) is
  'SCR-035 - hands a screen to QA: qa_status becomes submitted and the scope items it covers come back so the caller can plan a ui test for each through qa.add_test_plan_item when the project has a draft test plan. This function does not write the plan itself: the plan''s own door decides wrong_baseline and plan_approved. Not bound to the screen baseline: a screen is handed to QA after the list is agreed. Audited.';

revoke all on function projects.submit_screen_for_qa(uuid) from public, anon;
grant execute on function projects.submit_screen_for_qa(uuid) to authenticated;

-- ── SCR-038: an asset linked to a screen or a UI version ─────────────────

create table if not exists projects.design_asset_links (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  asset_id        uuid not null references projects.design_assets(id) on delete cascade,
  screen_id       uuid references projects.screens(id) on delete cascade,
  ui_version_id   uuid references projects.ui_versions(id) on delete cascade,
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Exactly one target. A link to nothing is not a link and a link to both
  -- is two links.
  constraint design_asset_links_one_target
    check ((screen_id is null) <> (ui_version_id is null))
);

-- One link per (asset, target), with nulls on the other side.
create unique index if not exists design_asset_links_asset_screen_key
  on projects.design_asset_links (asset_id, screen_id)
  where screen_id is not null;

create unique index if not exists design_asset_links_asset_ui_version_key
  on projects.design_asset_links (asset_id, ui_version_id)
  where ui_version_id is not null;

create index if not exists design_asset_links_org_asset_idx
  on projects.design_asset_links (organization_id, asset_id);

create index if not exists design_asset_links_screen_idx
  on projects.design_asset_links (screen_id)
  where screen_id is not null;

comment on table projects.design_asset_links is
  'SCR-038 - which screen or which UI version a reference asset (projects.design_assets) belongs to. Exactly one target per row. The asset stays what Designer section 9 says it is - optional support, never the canonical design; the link only says where it was used.';

drop trigger if exists org_match_design_asset_links_asset on projects.design_asset_links;
create trigger org_match_design_asset_links_asset
  before insert or update of asset_id, organization_id on projects.design_asset_links
  for each row execute function core.enforce_parent_org('asset_id', 'projects.design_assets');

drop trigger if exists org_match_design_asset_links_screen on projects.design_asset_links;
create trigger org_match_design_asset_links_screen
  before insert or update of screen_id, organization_id on projects.design_asset_links
  for each row execute function core.enforce_parent_org('screen_id', 'projects.screens');

drop trigger if exists org_match_design_asset_links_ui_version on projects.design_asset_links;
create trigger org_match_design_asset_links_ui_version
  before insert or update of ui_version_id, organization_id on projects.design_asset_links
  for each row execute function core.enforce_parent_org('ui_version_id', 'projects.ui_versions');

drop trigger if exists freeze_org_design_asset_links on projects.design_asset_links;
create trigger freeze_org_design_asset_links
  before update of organization_id on projects.design_asset_links
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_design_asset_links on projects.design_asset_links;
create trigger set_updated_at_design_asset_links
  before update on projects.design_asset_links
  for each row execute function core.set_updated_at();

alter table projects.design_asset_links enable row level security;
alter table projects.design_asset_links force row level security;

drop policy if exists design_asset_links_select on projects.design_asset_links;
create policy design_asset_links_select on projects.design_asset_links
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists design_asset_links_insert on projects.design_asset_links;
create policy design_asset_links_insert on projects.design_asset_links
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

drop policy if exists design_asset_links_delete on projects.design_asset_links;
create policy design_asset_links_delete on projects.design_asset_links
  for delete to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

grant select, insert, delete on projects.design_asset_links to authenticated, service_role;

notify pgrst, 'reload schema';
