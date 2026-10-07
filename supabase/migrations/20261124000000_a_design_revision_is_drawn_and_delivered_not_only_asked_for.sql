-- ═══════════════════════════════════════════════════════════════════════════
-- P3-UID-015 / P3-PM-014 (traceability: docs/phase-1-3-implementation-traceability.md).
--
-- Phase 3's revision loop could OPEN a round (projects.open_design_revision, client origin only) but nothing could ANSWER it: no door wrote the
-- revised direction, `theme_options.version`/`revision_of` had no writer, `design_revisions.to_theme_option_id` was never set, and an Admin EDIT or an
-- internal changes_required returned an option to the designer without leaving any revision record at all. The PM's "revision ready, share again"
-- path could therefore never trigger.
--
-- This migration adds the two missing doors and nothing else is loosened:
--
--   * projects.open_internal_design_revision(option)  an Admin EDIT or an internal changes_required becomes a design_revisions row (origin admin_edit /
--     internal_review). It spends NO client round (PM section 9: only a client round is counted), cites the review/decision it came from, and is
--     idempotent per option while one is still open.
--   * projects.deliver_design_revision(revision, ...)  the designer's answer: a NEW theme_options row (version + 1, revision_of = the old option, the old
--     row untouched - Designer section 20), its colour options copied as drafts, every gate reset to the start (internal review is first again - Master
--     section 16's order), and the revision marked delivered with to_theme_option_id. Refused for a locked option, a cancelled revision, an escalated phase.
--
-- Two constraints had to move so a revision can exist at all: the "two or three and not one more" ceiling counts DIRECTIONS (revision_of is null), and
-- the (project, context, option_index) uniqueness gains the version, so a revised direction keeps its index. Nothing is sent to the client from here.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.design_revision_delivered',
   'Master section 19 DesignRevision, answered. The designer delivered a revised theme direction (a new version; the earlier one is untouched). It restarts at internal review. Nothing was sent to the client.',
   true)
on conflict (type) do nothing;

-- a revision is not a fourth direction
create or replace function projects.enforce_theme_option_ceiling()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_limit int;
  v_count int;
begin
  if new.revision_of is not null then
    return new;
  end if;

  select p3.theme_option_limit into v_limit
    from projects.phase_three p3
   where p3.id = new.phase_three_id;

  select count(*) into v_count
    from projects.theme_options t
   where t.project_id = new.project_id
     and t.source_context_version = new.source_context_version
     and t.revision_of is null
     and t.id is distinct from new.id;

  if v_count >= coalesce(v_limit, 3) then
    raise exception
      'this project already has % theme directions for this design context; the policy is % (Master section 18)',
      v_count, coalesce(v_limit, 3)
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

alter table projects.theme_options drop constraint if exists theme_options_project_id_source_context_version_option_inde_key;
alter table projects.theme_options drop constraint if exists theme_options_one_row_per_option_version;
alter table projects.theme_options
  add constraint theme_options_one_row_per_option_version unique (project_id, source_context_version, option_index, version);

-- ── an Admin EDIT / internal changes_required becomes a revision record ────
create or replace function projects.open_internal_design_revision(p_theme_option_id uuid)
returns table (outcome text, revision_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor   uuid := (select auth.uid());
  v_option  projects.theme_options;
  v_phase3  projects.phase_three;
  v_origin  text;
  v_changes text;
  v_review  uuid;
  v_admin   uuid;
  v_existing uuid;
  v_new     uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  select t.* into v_option from projects.theme_options t where t.id = p_theme_option_id;
  if v_option.id is null then return query select 'unknown_option'::text, null::uuid; return; end if;
  select p3.* into v_phase3 from projects.phase_three p3 where p3.id = v_option.phase_three_id for update;
  if v_actor is not null
     and (v_phase3.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_phase3.state in ('revision_limit_escalation', 'scope_escalation', 'completed', 'locked') or v_option.client_status = 'locked' then
    return query select 'phase_stopped'::text, null::uuid; return;
  end if;

  -- what came back: the Admin's EDIT outranks the internal review that preceded it
  if v_option.admin_status = 'edit_requested' then
    v_origin := 'admin_edit';
    select d.id, d.reason, d.design_review_id into v_admin, v_changes, v_review
      from projects.admin_design_decisions d
     where d.theme_option_id = v_option.id and d.decision = 'edit' order by d.created_at desc, d.id desc limit 1;
  elsif v_option.internal_review_status = 'changes_required' then
    v_origin := 'internal_review';
    select r.id, r.comments into v_review, v_changes
      from projects.design_reviews r
     where r.theme_option_id = v_option.id and r.result = 'changes_required' order by r.created_at desc, r.id desc limit 1;
  else
    return query select 'not_returned'::text, null::uuid; return;
  end if;
  if v_changes is null or length(btrim(v_changes)) = 0 then
    return query select 'no_requested_changes'::text, null::uuid; return;
  end if;

  -- one open revision per option: a redelivered event returns the round it already opened
  select r.id into v_existing from projects.design_revisions r
   where r.from_theme_option_id = v_option.id and r.status in ('open', 'in_progress');
  if v_existing is not null then return query select 'exists'::text, v_existing; return; end if;

  insert into projects.design_revisions (organization_id, project_id, phase_three_id, origin, from_theme_option_id, requested_changes,
                                         design_review_id, admin_decision_id, round_number, opened_by)
  values (v_phase3.organization_id, v_option.project_id, v_phase3.id, v_origin, v_option.id, left(btrim(v_changes), 4000),
          v_review, v_admin, null, v_actor)
  returning id into v_new;

  update projects.phase_three set state = 'revision'
   where id = v_phase3.id and state in ('waiting_designer', 'admin_review', 'internal_review', 'revision');

  perform core.record_audit(v_phase3.organization_id, 'design_revision.opened', 'design_revision', v_new, null,
    jsonb_build_object('projectId', v_option.project_id, 'origin', v_origin, 'fromThemeOptionId', v_option.id, 'round', null));
  perform core.emit_event(v_phase3.organization_id, 'project.design_revision_opened', 'design_revision', v_new,
    jsonb_build_object('projectId', v_option.project_id, 'origin', v_origin, 'round', null));
  return query select 'opened'::text, v_new;
end $$;
revoke all on function projects.open_internal_design_revision(uuid) from public, anon;
grant execute on function projects.open_internal_design_revision(uuid) to authenticated, service_role;

-- ── the designer's answer: a new version, never an edit of the old one ─────
create or replace function projects.deliver_design_revision(p_revision_id uuid, p_name text, p_direction_summary text, p_metadata jsonb default '{}'::jsonb)
returns table (outcome text, theme_option_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor   uuid := (select auth.uid());
  v_rev     projects.design_revisions;
  v_from    projects.theme_options;
  v_phase3  projects.phase_three;
  v_name    text := nullif(btrim(coalesce(p_name, '')), '');
  v_summary text := nullif(btrim(coalesce(p_direction_summary, '')), '');
  v_new     uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  select r.* into v_rev from projects.design_revisions r where r.id = p_revision_id for update;
  if v_rev.id is null then return query select 'unknown_revision'::text, null::uuid; return; end if;
  select p3.* into v_phase3 from projects.phase_three p3 where p3.id = v_rev.phase_three_id for update;
  if v_actor is not null
     and (v_phase3.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_rev.status = 'delivered' then return query select 'already_delivered'::text, v_rev.to_theme_option_id; return; end if;
  if v_rev.status = 'cancelled' then return query select 'cancelled'::text, null::uuid; return; end if;
  if v_phase3.state in ('revision_limit_escalation', 'scope_escalation', 'completed', 'locked') then
    return query select 'phase_stopped'::text, null::uuid; return;
  end if;
  if v_name is null or length(v_name) > 120 then return query select 'bad_name'::text, null::uuid; return; end if;
  if v_summary is null or length(v_summary) > 2000 then return query select 'bad_summary'::text, null::uuid; return; end if;

  select t.* into v_from from projects.theme_options t where t.id = v_rev.from_theme_option_id;
  -- Master section 16: a final selection cannot be overwritten silently - and a locked option is the one the client chose
  if v_from.client_status = 'locked' then return query select 'option_locked'::text, null::uuid; return; end if;

  insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, direction_metadata,
                                      source_context_version, origin, revision_of, version, created_by)
  values (v_from.organization_id, v_from.project_id, v_from.phase_three_id, v_from.option_index, v_name, v_summary,
          coalesce(p_metadata, '{}'::jsonb), v_from.source_context_version, v_rev.origin, v_from.id, v_from.version + 1, v_actor)
  returning id into v_new;

  -- the palette carries over as a DRAFT of the new version; the designer may change it, nobody has shared it
  insert into projects.color_options (organization_id, theme_option_id, option_index, palette_name, primary_hex, secondary_hex, accent_hex, background_hex,
                                      surface_hex, text_primary_hex, text_secondary_hex, success_hex, warning_hex, error_hex, contrast_notes, brand_source)
  select c.organization_id, v_new, c.option_index, c.palette_name, c.primary_hex, c.secondary_hex, c.accent_hex, c.background_hex,
         c.surface_hex, c.text_primary_hex, c.text_secondary_hex, c.success_hex, c.warning_hex, c.error_hex, c.contrast_notes, c.brand_source
    from projects.color_options c where c.theme_option_id = v_from.id;

  update projects.design_revisions set status = 'delivered', to_theme_option_id = v_new where id = v_rev.id;

  -- Master section 16's order again: a revised direction has not been reviewed, so internal review is the first gate it meets
  update projects.phase_three set state = 'internal_review'
   where id = v_phase3.id and state in ('revision', 'waiting_designer', 'theme_generation', 'internal_review');

  perform core.record_audit(v_phase3.organization_id, 'design_revision.delivered', 'design_revision', v_rev.id, null,
    jsonb_build_object('projectId', v_from.project_id, 'origin', v_rev.origin, 'fromThemeOptionId', v_from.id, 'toThemeOptionId', v_new, 'version', v_from.version + 1));
  perform core.emit_event(v_phase3.organization_id, 'project.design_revision_delivered', 'design_revision', v_rev.id,
    jsonb_build_object('projectId', v_from.project_id, 'origin', v_rev.origin, 'toThemeOptionId', v_new));
  return query select 'delivered'::text, v_new;
end $$;
revoke all on function projects.deliver_design_revision(uuid, text, text, jsonb) from public, anon;
grant execute on function projects.deliver_design_revision(uuid, text, text, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
