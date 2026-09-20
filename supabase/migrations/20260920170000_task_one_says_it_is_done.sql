-- ═══════════════════════════════════════════════════════════════════════════
-- Task 1 says it is done.
--
-- 20260919200000 built four message steps from PM §11: phase_three_start,
-- theme_review, revision_ready, final_confirmation. All four are asks or
-- announcements that happen BEFORE the client has confirmed anything. Nothing
-- tells the client Task 1 itself is over — the announcement that opened the
-- task (phase_three_start) has no matching close, and a PM reading this
-- system after `lock_phase_three_direction` succeeds has no rendered wording
-- to send, only the fact that the lock happened.
--
-- This adds the fifth and last step §11 does not name but the Phase 3 flow
-- requires: a completion message, renderable only once `projects.phase_three`
-- has actually reached `state = 'completed'` — which `lock_phase_three_direction`
-- is the only function that sets (20260920000000:577). The same rule as every
-- other step in 20260919200000 applies unchanged: a step whose claim the state
-- does not support is refused rather than rendered (PM §10), and this default
-- is likewise an organisation-replaceable default, not a hard-coded rule.
--
-- IT RENDERS; IT DOES NOT SEND (BLK-003, BLK-007) — identical constraint to
-- every other step this table already carries.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.design_message_templates
  drop constraint design_message_templates_step_key_check;

alter table projects.design_message_templates
  add constraint design_message_templates_step_key_check
    check (step_key in ('phase_three_start', 'theme_review',
                        'revision_ready', 'final_confirmation',
                        'task_one_complete'));

comment on table projects.design_message_templates is
  'PM section 11 plus the completion step section 11 does not name (G-309): an ORGANISATION OVERRIDE of the shipped wording. Section 11 says the templates are examples, not hard-coded mandatory wording, so the default lives in projects.default_design_message() and a row here replaces it. Distinct from crm.whatsapp_templates, which records what META approved and holds no body because Meta holds the body. Section 10 prohibitions that are about the WORDS are refused here; the one about WHEN the words may be said lives in the render door, because it is not a property of the text.';

create or replace function projects.default_design_message(p_step_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_step_key
    when 'phase_three_start' then
      'Your project setup is complete. We are now starting the UI finalization stage. '
      || 'We will prepare UI theme and color options for your review.'
    when 'theme_review' then
      'We have prepared the UI options for your project. Please review them carefully and let us '
      || 'know which theme and color direction you prefer. You can also share a reference if you '
      || 'have one.'
    when 'revision_ready' then
      'We have updated the design based on your feedback. Please check the revised option '
      || 'carefully and let us know if anything else needs to be changed.'
    when 'final_confirmation' then
      'Please confirm the selected UI theme and color combination so we can proceed with '
      || 'the complete UI design in the next stage.'
    when 'task_one_complete' then
      'Thank you for confirming the UI theme and color direction. Task 1 (UI finalization) is now '
      || 'complete. We are moving ahead to the next stage of the project.'
  end;
$$;

comment on function projects.default_design_message(text) is
  'PM section 11 verbatim for its four steps, plus a fifth (task_one_complete, G-309) the section does not name but Master section 7.12 requires: the close that matches phase_three_start''s open. All five are DEFAULTS. Section 11 states these are examples and not mandatory wording, so an organisation row in projects.design_message_templates replaces this. It is recorded here rather than in application code because the words are part of the specification this phase implements.';

create or replace function projects.render_design_message(
  p_phase_three_id uuid,
  p_step_key       text,
  p_language       text default 'en'
)
returns table (
  -- 'rendered'   the body, with backend state in it
  -- refusals: 'no_actor' | 'forbidden' | 'unknown_phase' | 'bad_step'
  --           | 'nothing_approved'   theme_review with nothing a client may see
  --           | 'no_revision_ready'  §10: do not claim a revision is ready
  --           | 'not_selected_yet'   nothing to confirm
  --           | 'not_locked_yet'     task_one_complete before the lock (G-309)
  outcome text,
  body    text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_project  projects.projects;
  v_client   text;
  v_body     text;
  v_names    text;
  v_count    int;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::text; return;
  end if;

  if p_step_key not in ('phase_three_start', 'theme_review', 'revision_ready',
                         'final_confirmation', 'task_one_complete') then
    return query select 'bad_step'::text, null::text; return;
  end if;

  select p3.* into v_phase3 from projects.phase_three p3 where p3.id = p_phase_three_id;
  if v_phase3.id is null then
    return query select 'unknown_phase'::text, null::text; return;
  end if;

  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.is_internal()), false) then
    return query select 'forbidden'::text, null::text; return;
  end if;

  -- §10: "Do not present rejected/internal-only designs." The names that can
  -- reach a client come only from options Admin approved — a draft cannot be
  -- named even by a template that asks for it, because it is never in the
  -- variable.
  select count(*), string_agg(t.name, ', ' order by t.option_index)
    into v_count, v_names
    from projects.theme_options t
   where t.phase_three_id = v_phase3.id
     and t.admin_status = 'approved';

  -- §10: "Do not claim a revision is ready before approved backend state."
  -- Checked per step, because the claim differs per step.
  if p_step_key = 'theme_review' and coalesce(v_count, 0) = 0 then
    return query select 'nothing_approved'::text, null::text; return;
  end if;

  if p_step_key = 'revision_ready' and not exists (
    select 1
      from projects.design_revisions r
      join projects.theme_options t on t.id = r.to_theme_option_id
     where r.phase_three_id = v_phase3.id
       and r.status = 'delivered'
       and t.admin_status = 'approved'
  ) then
    return query select 'no_revision_ready'::text, null::text; return;
  end if;

  if p_step_key = 'final_confirmation' and not exists (
    select 1 from projects.client_design_decisions d
     where d.phase_three_id = v_phase3.id
       and d.decision = 'client_selected'
  ) then
    return query select 'not_selected_yet'::text, null::text; return;
  end if;

  -- G-309: the claim "Task 1 is complete" is not supported until the lock has
  -- actually happened — the only thing that sets phase_three.state = 'completed'
  -- is projects.lock_phase_three_direction. Same §10 discipline as every
  -- other step: refused rather than rendered ahead of the state it describes.
  if p_step_key = 'task_one_complete' and v_phase3.state <> 'completed' then
    return query select 'not_locked_yet'::text, null::text; return;
  end if;

  -- The organisation's wording if it has one, the shipped default otherwise.
  select tpl.body into v_body
    from projects.design_message_templates tpl
   where tpl.organization_id = v_phase3.organization_id
     and tpl.step_key = p_step_key
     and tpl.language = coalesce(p_language, 'en');

  v_body := coalesce(v_body, projects.default_design_message(p_step_key));

  select p.* into v_project from projects.projects p where p.id = v_phase3.project_id;
  select ca.name into v_client
    from core.client_accounts ca where ca.id = v_project.client_account_id;

  -- §10: "Use actual backend state for progress updates." Every variable is
  -- read here and now; none is passed in.
  v_body := replace(v_body, '{{client_name}}', coalesce(v_client, 'there'));
  v_body := replace(v_body, '{{project_name}}', coalesce(v_project.name, 'your project'));
  v_body := replace(v_body, '{{option_names}}', coalesce(v_names, ''));
  v_body := replace(v_body, '{{option_count}}', coalesce(v_count, 0)::text);
  v_body := replace(v_body, '{{round_number}}', v_phase3.client_revision_count::text);

  return query select 'rendered'::text, v_body;
end;
$$;

comment on function projects.render_design_message(uuid, text, text) is
  'PM sections 10 and 11, plus task_one_complete (G-309, Master section 7.12''s close). Renders the wording for a step from ACTUAL BACKEND STATE - every variable is read here, none is passed in (section 10). A STEP WHOSE CLAIM THE STATE DOES NOT SUPPORT IS REFUSED RATHER THAN RENDERED: theme_review needs an Admin-approved option, revision_ready needs a delivered revision whose new version passed Admin, final_confirmation needs a selection, task_one_complete needs the lock itself (phase_three.state = ''completed'', set only by lock_phase_three_direction). The option names it interpolates come only from Admin-approved options, so a rejected or internal-only design cannot be named even by a template that asks for one. It renders; IT DOES NOT SEND (BLK-003, BLK-007).';
