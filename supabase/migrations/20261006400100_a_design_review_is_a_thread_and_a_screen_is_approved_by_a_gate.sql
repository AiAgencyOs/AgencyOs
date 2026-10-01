-- ═══════════════════════════════════════════════════════════════════════════
-- A design review is a thread, a screen is approved through a gate, and a
-- brand kit holds what the brand is.
--
-- PDF SCR-033..038. What was missing, and what this adds:
--
--   projects.design_review_comments   a comment thread on a theme option or a
--                                     design deliverable (append-only; door
--                                     projects.comment_on_design_review)
--   projects.record_design_share      only a delivery role (owner, ops admin,
--                                     delivery lead — the PM) records what was
--                                     sent to the client; the rule that every
--                                     option be Admin-approved is unchanged
--   projects.screens.category         the inventory's grouping (door
--                                     projects.set_screen_category)
--   projects.screens.qa_confirmed_*   QA confirmed the required sections,
--                                     buttons, components and navigation
--                                     (door projects.confirm_screen_qa,
--                                     owner / ops admin — project.sign_off)
--   projects.approve_screen           refuses while any of the four states is
--                                     missing or QA has not confirmed
--   projects.design_assets            kinds logo, icon, font; font media
--                                     types; a licence on an upload
--   projects.brand_rules              a written brand rule (doors
--                                     add_brand_rule, remove_brand_rule)
--
-- Every new table has RLS enabled and forced, an internal SELECT policy and
-- no write grant for authenticated; every door is security definer, re-checks
-- the role and writes an audit row. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── comments on a design ───────────────────────────────────────────────────
create table if not exists projects.design_review_comments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  subject_type    text not null check (subject_type in ('theme_option', 'deliverable')),
  subject_id      uuid not null,
  author_id       uuid references core.users(id) on delete set null,
  body            text not null check (length(btrim(body)) between 1 and 2000),
  created_at      timestamptz not null default now()
);
comment on table projects.design_review_comments is
  'SCR-036: the comment thread on a design option or design deliverable under review. Append-only; written only through projects.comment_on_design_review.';
create index if not exists design_review_comments_subject_idx on projects.design_review_comments (subject_type, subject_id, created_at);
create index if not exists design_review_comments_project_idx on projects.design_review_comments (organization_id, project_id, created_at desc);

drop trigger if exists org_match_design_review_comments_project on projects.design_review_comments;
create trigger org_match_design_review_comments_project
  before insert or update of project_id, organization_id on projects.design_review_comments
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_design_review_comments on projects.design_review_comments;
create trigger freeze_org_design_review_comments
  before update of organization_id on projects.design_review_comments
  for each row execute function core.freeze_organization_id();

alter table projects.design_review_comments enable row level security;
alter table projects.design_review_comments force row level security;
drop policy if exists design_review_comments_select on projects.design_review_comments;
create policy design_review_comments_select on projects.design_review_comments
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.design_review_comments from public, anon, authenticated;
grant select on projects.design_review_comments to authenticated;
grant select, insert, update, delete on projects.design_review_comments to service_role;

create or replace function projects.comment_on_design_review(p_subject_type text, p_subject_id uuid, p_body text)
returns table (outcome text, comment_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_body    text := btrim(coalesce(p_body, ''));
  v_project uuid;
  v_id      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if length(v_body) = 0 then
    return query select 'empty'::text, null::uuid; return;
  end if;
  if length(v_body) > 2000 then
    return query select 'too_long'::text, null::uuid; return;
  end if;
  if p_subject_type = 'theme_option' then
    select t.project_id into v_project from projects.theme_options t where t.id = p_subject_id and t.organization_id = v_org;
  elsif p_subject_type = 'deliverable' then
    select d.project_id into v_project from projects.deliverables d where d.id = p_subject_id and d.organization_id = v_org and d.kind in ('design', 'prototype');
  else
    return query select 'bad_subject'::text, null::uuid; return;
  end if;
  if v_project is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  insert into projects.design_review_comments (organization_id, project_id, subject_type, subject_id, author_id, body)
  values (v_org, v_project, p_subject_type, p_subject_id, v_actor, v_body)
  returning id into v_id;

  perform core.record_audit(v_org, 'design.review_commented', p_subject_type, p_subject_id, null,
    jsonb_build_object('comment_id', v_id, 'project_id', v_project, 'length', length(v_body)));
  return query select 'commented'::text, v_id;
end;
$$;
revoke all on function projects.comment_on_design_review(text, uuid, text) from public, anon;
grant execute on function projects.comment_on_design_review(text, uuid, text) to authenticated, service_role;

-- ── PM sends to the client, after Admin approval ───────────────────────────
-- The body below is projects.record_design_share as it stood, with ONE change:
-- the role check is core.can_manage_delivery() (owner, ops admin, delivery
-- lead — the PM) instead of core.can_write(), which also admitted `member`.
CREATE OR REPLACE FUNCTION projects.record_design_share(p_project_id uuid, p_theme_option_ids uuid[], p_channel text, p_evidence_ref text, p_conversation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, share_id uuid, findings text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_evidence text := nullif(btrim(coalesce(p_evidence_ref, '')), '');
  v_bad      text[];
  v_snapshot jsonb;
  v_count    int;
  v_next     int;
  v_new      uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, '{}'::text[]; return;
  end if;

  -- Argument-only refusals first, before any row is read: a caller who sent no
  -- options or no evidence has made a mistake about the request, not about
  -- this project.
  if p_theme_option_ids is null or array_length(p_theme_option_ids, 1) is null then
    return query select 'no_options'::text, null::uuid, '{}'::text[]; return;
  end if;

  if p_channel is null or p_channel not in ('whatsapp', 'email', 'other') then
    return query select 'bad_channel'::text, null::uuid, '{}'::text[]; return;
  end if;

  if v_evidence is null then
    return query select 'no_evidence'::text, null::uuid, '{}'::text[]; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.project_id = p_project_id
   for update;

  if v_phase3.id is null then
    return query select 'no_phase_three'::text, null::uuid, '{}'::text[]; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid, '{}'::text[]; return;
  end if;

  -- ── THE RULE ───────────────────────────────────────────────────────────
  --
  -- §7.9 and PM §4.4. Every option must be Admin-approved, and the refusal
  -- names the ones that are not: a PM told "one of these is not approved" has
  -- to go and find out which.
  select array_agg(format('not_approved:%s', t.name) order by t.name) into v_bad
    from projects.theme_options t
   where t.id = any(p_theme_option_ids)
     and t.project_id = p_project_id
     and t.admin_status <> 'approved';

  if v_bad is not null then
    return query select 'not_approved'::text, null::uuid, v_bad; return;
  end if;

  -- An id that belongs to another project, or to nothing, is also not
  -- approved — counted rather than trusted, because `= any()` silently
  -- ignores what it cannot find.
  select count(*) into v_count
    from projects.theme_options t
   where t.id = any(p_theme_option_ids)
     and t.project_id = p_project_id
     and t.admin_status = 'approved';

  if v_count <> array_length(p_theme_option_ids, 1) then
    return query select 'not_approved'::text, null::uuid,
      array['not_approved:one or more options do not belong to this project']::text[];
    return;
  end if;

  -- An option with neither a Figma reference nor a preview is an option the
  -- client cannot look at. Master §5 permits a preview as a SECONDARY
  -- artifact, so either satisfies this; what is refused is having neither.
  select array_agg(format('nothing_to_show:%s', t.name) order by t.name) into v_bad
    from projects.theme_options t
   where t.id = any(p_theme_option_ids)
     and t.figma_node_id is null
     and t.preview_asset_url is null;

  if v_bad is not null then
    return query select 'nothing_to_show'::text, null::uuid, v_bad; return;
  end if;

  -- THE SNAPSHOT. What the client is being shown, as it stands right now,
  -- with each option's approved palettes carried alongside it — §12 makes a
  -- colour belong to a direction, and a palette shared without its direction
  -- is a swatch.
  select jsonb_agg(
           jsonb_build_object(
             'themeOptionId', t.id,
             'name', t.name,
             'optionIndex', t.option_index,
             'version', t.version,
             'directionSummary', t.direction_summary,
             'figmaFileKey', t.figma_file_key,
             'figmaNodeId', t.figma_node_id,
             'figmaVersion', t.figma_version,
             'previewAssetUrl', t.preview_asset_url,
             'colors', coalesce((
               select jsonb_agg(
                        jsonb_build_object(
                          'colorOptionId', c.id,
                          'paletteName', c.palette_name,
                          'primaryHex', c.primary_hex,
                          'optionIndex', c.option_index
                        ) order by c.option_index
                      )
                 from projects.color_options c
                where c.theme_option_id = t.id
             ), '[]'::jsonb)
           ) order by t.option_index
         )
    into v_snapshot
    from projects.theme_options t
   where t.id = any(p_theme_option_ids);

  select coalesce(max(s.share_number), 0) + 1 into v_next
    from projects.client_design_shares s
   where s.project_id = p_project_id;

  insert into projects.client_design_shares (
    organization_id, project_id, phase_three_id, share_number,
    shared_options, option_count, channel, evidence_ref, conversation_id, shared_by
  ) values (
    v_phase3.organization_id, p_project_id, v_phase3.id, v_next,
    v_snapshot, v_count, p_channel, v_evidence, p_conversation_id, v_actor
  )
  returning id into v_new;

  -- The options now say they have been shown. Nothing else about them moves:
  -- the client has seen them and has not answered, which is a different fact
  -- from having chosen.
  update projects.theme_options
     set client_status = 'shared'
   where id = any(p_theme_option_ids)
     and client_status = 'not_shared';

  update projects.color_options
     set client_status = 'shared'
   where theme_option_id = any(p_theme_option_ids)
     and client_status = 'not_shared';

  update projects.phase_three
     set state = 'waiting_client'
   where id = v_phase3.id
     and state in ('client_review', 'admin_review', 'revision');

  perform core.record_audit(
    v_phase3.organization_id, 'project.design_options_shared', 'client_design_share', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'shareNumber', v_next,
                       'optionCount', v_count, 'channel', p_channel, 'evidenceRef', v_evidence)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.design_options_shared', 'client_design_share', v_new,
    jsonb_build_object('projectId', p_project_id, 'shareNumber', v_next, 'optionCount', v_count)
  );

  return query select 'shared'::text, v_new, '{}'::text[];
end;
$function$;

-- ── screens: category, QA confirmation, approval through a gate ────────────
alter table projects.screens add column if not exists category text;
alter table projects.screens add column if not exists qa_confirmed_at timestamptz;
alter table projects.screens add column if not exists qa_confirmed_by uuid references core.users(id) on delete set null;
alter table projects.screens drop constraint if exists screens_category_shape;
alter table projects.screens add constraint screens_category_shape check (category is null or length(btrim(category)) between 1 and 60);

comment on column projects.screens.category is 'SCR-034: the inventory grouping (Auth, Dashboard, Settings…) — free text, written by projects.set_screen_category.';
comment on column projects.screens.qa_confirmed_at is 'SCR-035: when QA confirmed the required sections, buttons, components and navigation — written by projects.confirm_screen_qa; approve_screen refuses without it.';

CREATE OR REPLACE FUNCTION projects.refuse_screen_write_after_finalized_baseline()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_project uuid;
  v_closed  text;
begin
  -- W4 (SCR-035): a status-only move between live states (draft, in review,
  -- approved, blocked) is a review decision, not an edit of the screen list,
  -- so it stays possible after the baseline is finalized. Superseding a screen
  -- and every content column remain refused.
  -- (nested: PL/pgSQL does not short-circuit `and`, and `new.status` does not exist on screen_scope_items)
  if tg_table_name = 'screens' then
    if tg_op = 'UPDATE'
     and new.status is distinct from old.status
       and old.status <> 'superseded' and new.status <> 'superseded'
       and (new.project_id, new.screen_key, new.name, new.user_role, new.purpose, new.entry_point, new.exit_action, new.required_data, new.actions, new.validation, new.required_sections, new.dependencies, new.has_empty_state, new.has_loading_state, new.has_error_state, new.has_success_state, new.permission_behaviour, new.responsive_behaviour, new.accessibility_notes, new.superseded_by)
         is not distinct from (old.project_id, old.screen_key, old.name, old.user_role, old.purpose, old.entry_point, old.exit_action, old.required_data, old.actions, old.validation, old.required_sections, old.dependencies, old.has_empty_state, old.has_loading_state, old.has_error_state, old.has_success_state, old.permission_behaviour, old.responsive_behaviour, old.accessibility_notes, old.superseded_by) then
      return new;
    end if;
  end if;

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
$function$;

create or replace function projects.set_screen_category(p_screen_id uuid, p_category text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_cat   text := nullif(btrim(coalesce(p_category, '')), '');
  v_row   projects.screens;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if v_cat is not null and length(v_cat) > 60 then
    return query select 'too_long'::text; return;
  end if;
  select * into v_row from projects.screens s where s.id = p_screen_id and s.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.category is not distinct from v_cat then
    return query select 'unchanged'::text; return;
  end if;
  update projects.screens set category = v_cat where id = v_row.id;
  perform core.record_audit(v_org, 'project.screen_category_set', 'screen', v_row.id,
    jsonb_build_object('category', v_row.category), jsonb_build_object('category', v_cat, 'projectId', v_row.project_id));
  return query select 'set'::text;
end;
$$;
revoke all on function projects.set_screen_category(uuid, text) from public, anon;
grant execute on function projects.set_screen_category(uuid, text) to authenticated, service_role;

create or replace function projects.confirm_screen_qa(p_screen_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.screens;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  -- QA sign-off is the ops admin's (ADM-19): a delivery lead confirming their
  -- own screen would be the review signing its own homework.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  select * into v_row from projects.screens s where s.id = p_screen_id and s.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.status = 'superseded' then
    return query select 'superseded'::text; return;
  end if;
  if v_row.qa_status <> 'submitted' then
    return query select 'not_submitted'::text; return;
  end if;
  if v_row.qa_confirmed_at is not null then
    return query select 'already_confirmed'::text; return;
  end if;
  update projects.screens set qa_confirmed_at = now(), qa_confirmed_by = v_actor where id = v_row.id;
  perform core.record_audit(v_org, 'project.screen_qa_confirmed', 'screen', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id));
  return query select 'confirmed'::text;
end;
$$;
revoke all on function projects.confirm_screen_qa(uuid) from public, anon;
grant execute on function projects.confirm_screen_qa(uuid) to authenticated, service_role;

create or replace function projects.approve_screen(p_screen_id uuid)
returns table (outcome text, detail text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_row     projects.screens;
  v_missing text;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::text; return;
  end if;
  select * into v_row from projects.screens s where s.id = p_screen_id and s.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::text; return;
  end if;
  if v_row.status = 'superseded' then
    return query select 'superseded'::text, null::text; return;
  end if;
  if v_row.status = 'approved' then
    return query select 'already_approved'::text, null::text; return;
  end if;

  -- PDF SCR-034: "Missing states block design completeness."
  v_missing := array_to_string(array_remove(array[
    case when not v_row.has_empty_state   then 'empty'   end,
    case when not v_row.has_loading_state then 'loading' end,
    case when not v_row.has_error_state   then 'error'   end,
    case when not v_row.has_success_state then 'success' end
  ], null), ', ');
  if v_missing <> '' then
    return query select 'missing_states'::text, v_missing; return;
  end if;

  -- PDF SCR-035: "QA must confirm all required sections/buttons/components/
  -- navigation before design approval."
  if v_row.qa_confirmed_at is null then
    return query select 'qa_not_confirmed'::text, null::text; return;
  end if;

  update projects.screens set status = 'approved' where id = v_row.id;
  perform core.record_audit(v_org, 'project.screen_approved', 'screen', v_row.id,
    jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'approved', 'projectId', v_row.project_id));
  return query select 'approved'::text, null::text;
end;
$$;
revoke all on function projects.approve_screen(uuid) from public, anon;
grant execute on function projects.approve_screen(uuid) to authenticated, service_role;

-- ── the brand kit: more asset kinds, a licence, written brand rules ────────
alter table projects.design_assets drop constraint if exists design_assets_kind_check;
alter table projects.design_assets add constraint design_assets_kind_check
  check (kind = any (array['illustration', 'reference', 'texture', 'mood_board', 'visual_asset', 'logo', 'icon', 'font']));
alter table projects.design_assets drop constraint if exists design_assets_media_type_check;
alter table projects.design_assets add constraint design_assets_media_type_check
  check (media_type = any (array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf',
                                 'font/woff2', 'font/woff', 'font/ttf', 'font/otf']));

-- Replaces the 7-argument upload door with one that takes the licence. The old
-- signature is dropped so PostgREST never sees two candidates.
drop function if exists projects.record_uploaded_design_asset(uuid, text, text, text, text, bigint, uuid);
create or replace function projects.record_uploaded_design_asset(
  p_project_id uuid, p_kind text, p_title text, p_storage_path text, p_media_type text, p_size_bytes bigint,
  p_parent_asset_id uuid default null, p_licence text default null
)
returns table (outcome text, asset_id uuid, version integer)
language plpgsql
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid;
  v_phase   uuid;
  v_parent  projects.design_assets;
  v_version int := 1;
  v_id      uuid;
  v_licence text := nullif(btrim(coalesce(p_licence, '')), '');
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null or v_org is distinct from (select core.current_organization_id()) then
    return query select 'not_found'::text, null::uuid, null::int; return;
  end if;
  select p3.id into v_phase from projects.phase_three p3 where p3.project_id = p_project_id;
  if v_phase is null then
    return query select 'no_phase_three'::text, null::uuid, null::int; return;
  end if;
  if p_kind not in ('illustration', 'reference', 'texture', 'mood_board', 'visual_asset', 'logo', 'icon', 'font') then
    return query select 'bad_kind'::text, null::uuid, null::int; return;
  end if;
  if v_licence is not null and length(v_licence) > 500 then
    return query select 'licence_too_long'::text, null::uuid, null::int; return;
  end if;

  if p_parent_asset_id is not null then
    select * into v_parent from projects.design_assets d where d.id = p_parent_asset_id for update;
    if v_parent.id is null or v_parent.project_id is distinct from p_project_id then
      return query select 'parent_not_found'::text, null::uuid, null::int; return;
    end if;
    if v_parent.parent_asset_id is not null then
      return query select 'parent_is_a_version'::text, null::uuid, null::int; return;
    end if;
    select coalesce(max(d.version), 1) + 1 into v_version
      from projects.design_assets d
     where d.id = p_parent_asset_id or d.parent_asset_id = p_parent_asset_id;
  end if;

  insert into projects.design_assets (
    organization_id, project_id, phase_three_id, kind, origin, status, version, parent_asset_id,
    title, storage_path, media_type, size_bytes, uploaded_by,
    source_context_version, rights_note
  ) values (
    v_org, p_project_id, v_phase, p_kind, 'uploaded', 'draft', v_version, p_parent_asset_id,
    btrim(p_title), p_storage_path, p_media_type, p_size_bytes, v_actor,
    'upload:' || gen_random_uuid()::text,
    coalesce(v_licence, 'Uploaded by a person; rights as the uploader holds them.')
  )
  returning id into v_id;

  perform core.record_audit(
    v_org, case when p_parent_asset_id is null then 'project.design_asset_uploaded' else 'project.design_asset_replaced' end,
    'design_asset', v_id, null,
    jsonb_build_object('projectId', p_project_id, 'kind', p_kind, 'title', btrim(p_title), 'version', v_version,
                       'parentAssetId', p_parent_asset_id, 'storagePath', p_storage_path, 'licenceRecorded', v_licence is not null)
  );
  return query select 'recorded'::text, v_id, v_version;
end;
$$;
revoke all on function projects.record_uploaded_design_asset(uuid, text, text, text, text, bigint, uuid, text) from public, anon;
grant execute on function projects.record_uploaded_design_asset(uuid, text, text, text, text, bigint, uuid, text) to authenticated, service_role;

create table if not exists projects.brand_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 120),
  rule            text not null check (length(btrim(rule)) between 1 and 2000),
  created_by      uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
comment on table projects.brand_rules is 'SCR-038: a written brand rule of the project''s brand kit. Written only through projects.add_brand_rule / remove_brand_rule.';
create index if not exists brand_rules_project_idx on projects.brand_rules (organization_id, project_id, created_at);
drop trigger if exists org_match_brand_rules_project on projects.brand_rules;
create trigger org_match_brand_rules_project
  before insert or update of project_id, organization_id on projects.brand_rules
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_brand_rules on projects.brand_rules;
create trigger freeze_org_brand_rules
  before update of organization_id on projects.brand_rules
  for each row execute function core.freeze_organization_id();
alter table projects.brand_rules enable row level security;
alter table projects.brand_rules force row level security;
drop policy if exists brand_rules_select on projects.brand_rules;
create policy brand_rules_select on projects.brand_rules
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.brand_rules from public, anon, authenticated;
grant select on projects.brand_rules to authenticated;
grant select, insert, update, delete on projects.brand_rules to service_role;

create or replace function projects.add_brand_rule(p_project_id uuid, p_title text, p_rule text)
returns table (outcome text, rule_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_title text := btrim(coalesce(p_title, ''));
  v_rule  text := btrim(coalesce(p_rule, ''));
  v_id    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if length(v_title) = 0 or length(v_rule) = 0 then
    return query select 'empty'::text, null::uuid; return;
  end if;
  if length(v_title) > 120 or length(v_rule) > 2000 then
    return query select 'too_long'::text, null::uuid; return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  insert into projects.brand_rules (organization_id, project_id, title, rule, created_by)
  values (v_org, p_project_id, v_title, v_rule, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'project.brand_rule_added', 'brand_rule', v_id, null,
    jsonb_build_object('projectId', p_project_id, 'title', v_title));
  return query select 'added'::text, v_id;
end;
$$;
revoke all on function projects.add_brand_rule(uuid, text, text) from public, anon;
grant execute on function projects.add_brand_rule(uuid, text, text) to authenticated, service_role;

create or replace function projects.remove_brand_rule(p_rule_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.brand_rules;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  select * into v_row from projects.brand_rules r where r.id = p_rule_id and r.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  delete from projects.brand_rules where id = v_row.id;
  perform core.record_audit(v_org, 'project.brand_rule_removed', 'brand_rule', v_row.id,
    jsonb_build_object('title', v_row.title), null);
  return query select 'removed'::text;
end;
$$;
revoke all on function projects.remove_brand_rule(uuid) from public, anon;
grant execute on function projects.remove_brand_rule(uuid) to authenticated, service_role;
