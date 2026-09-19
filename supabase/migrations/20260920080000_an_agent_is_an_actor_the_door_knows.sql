-- ═══════════════════════════════════════════════════════════════════════════
-- An agent is an actor the door has to know about.
--
-- G-302 gives `ui_designer` a workflow that proposes two or three directions
-- and writes them through `record_theme_option` and `record_color_option` —
-- the same doors a person uses, so every rule already built applies unchanged.
--
-- Except it could not call them at all, for two separate reasons, and neither
-- is visible by reading the workflow:
--
--   **The grant.** Both doors are `revoke … from public, anon` and
--   `grant … to authenticated`. The job runner holds the SERVICE role, so the
--   call is refused before any of the door's own logic runs — *permission
--   denied for function record_theme_option*.
--
--   **The actor.** `auth.uid()` is null for the service role, and both doors
--   open with `if v_actor is null then return 'no_actor'`. Even granted, an
--   agent would be told it is nobody.
--
-- Found by calling the door as `service_role` on a scratch database, not by
-- reading it. Nothing in the workflow's text hints at either.
--
-- ── the precedent this follows, rather than a new one ─────────────────
--
-- `start_phase_three` already answers both, and its comment says why:
--
--   *"The service role starts Phase 3 because the trigger is an EVENT: Phase 2
--   completed, and a job acts on it. A person may also start it — a repair
--   after a lost event — which is why the actor path exists at all."*
--
-- A finalized screen baseline is an event too, and a job acts on it. So these
-- doors gain the same escape, written the same way, rather than a second
-- mechanism to reason about separately.
--
-- ── this is a MINIMAL change, and that is deliberate ──────────────────
--
-- The body below is `record_theme_option` as G-279 wrote it, with two lines
-- changed: the actor check gains the service-role escape, and the authority
-- check applies only when there is a person to check. **Everything else is
-- byte-for-byte the original** — Designer §2's `no_baseline` rule, §18's
-- idempotency, the targeted `check_violation` handler around the insert, the
-- three-column return, the audit and the event.
--
-- The first draft of this migration was written from memory instead of from
-- the file. It dropped the baseline rule, dropped the event, renamed two
-- outcomes, changed the return arity, and replaced the `check_violation`
-- handler with a blanket `when others` that re-raised only when the message
-- failed a substring match — which would have swallowed unrelated errors
-- silently. None of that was intended and all of it would have shipped.
-- Rewriting a function means copying it, not remembering it.
--
-- ── what it does NOT loosen ───────────────────────────────────────────
--
-- **No tenant boundary moves.** The organisation is read from the PHASE, not
-- from the caller: a service-role call with a project id writes to that
-- project's organisation and cannot reach another. The `can_write()` check it
-- skips is about a *person's* capability, and the service role has no person.
--
-- **Nothing else is granted.** `submit_admin_design_decision`,
-- `record_design_share`, `lock_phase_three_direction` and the rest stay
-- `authenticated`-only. An agent may draft; approving, sending and locking are
-- ADM-61 §3 work, and the grant is where that boundary is cheapest to hold —
-- an agent cannot call what it was never given.
--
-- **`created_by` stays null.** No person drew it. `ai.agent_runs` records
-- which agent, which model and what it cost (G-297); that is where an agent's
-- authorship belongs.
--
-- G-281 is fixed in both, for the same reason as G-300 and G-301: a function
-- being replaced should not keep a known fail-open.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.record_theme_option(
  p_project_id       uuid,
  p_option_index     int,
  p_name             text,
  p_direction_summary text,
  p_metadata         jsonb default '{}'::jsonb
)
returns table (
  -- 'recorded' | 'already_recorded' | 'limit_reached' | 'no_phase_three'
  -- | 'no_baseline' | 'no_actor' | 'forbidden'
  outcome         text,
  theme_option_id uuid,
  context_version text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_phase3   projects.phase_three;
  v_context  text;
  v_existing projects.theme_options;
  v_new      uuid;
  v_baseline int;
begin
  -- CHANGED (G-303): the service role draws, because a finalized screen
  -- baseline is an EVENT and a job acts on it. A person may also record a
  -- direction, which is why the actor path exists at all.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::text; return;
  end if;

  select p3.* into v_phase3
    from projects.phase_three p3
   where p3.project_id = p_project_id
   for update;

  if v_phase3.id is null then
    return query select 'no_phase_three'::text, null::uuid, null::text; return;
  end if;

  -- CHANGED (G-303): applied only when there is a person to check, and
  -- coalesced against a NULL role (G-281). The organisation still comes from
  -- the PHASE, so a service-role call cannot reach another tenant.
  if v_actor is not null
     and (v_phase3.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::text; return;
  end if;

  -- Designer §2's start condition: "screen list and screen-by-screen content
  -- baseline are sufficiently defined for theme work." A theme drawn against
  -- no agreed screens is a picture, not a direction.
  select count(*) into v_baseline
    from projects.screen_baselines sb
   where sb.project_id = p_project_id and sb.status = 'finalized';

  if v_baseline = 0 then
    return query select 'no_baseline'::text, null::uuid, null::text; return;
  end if;

  v_context := projects.design_context_version(p_project_id);

  -- §18's idempotency, answered before the insert so a replay gets the row
  -- rather than a constraint violation.
  select t.* into v_existing
    from projects.theme_options t
   where t.project_id = p_project_id
     and t.source_context_version = v_context
     and t.option_index = p_option_index;

  if v_existing.id is not null then
    return query select 'already_recorded'::text, v_existing.id, v_context; return;
  end if;

  begin
    insert into projects.theme_options (
      organization_id, project_id, phase_three_id, option_index, name,
      direction_summary, direction_metadata, source_context_version, created_by
    ) values (
      v_phase3.organization_id, p_project_id, v_phase3.id, p_option_index, btrim(p_name),
      btrim(p_direction_summary), coalesce(p_metadata, '{}'::jsonb), v_context, v_actor
    )
    returning id into v_new;
  exception
    when check_violation then
      -- The ceiling trigger. Answered rather than raised, because asking for a
      -- fourth direction is a policy refusal a caller should read, not a crash.
      return query select 'limit_reached'::text, null::uuid, v_context; return;
  end;

  perform core.record_audit(
    v_phase3.organization_id, 'project.theme_options_generated', 'theme_option', v_new, null,
    jsonb_build_object('projectId', p_project_id, 'optionIndex', p_option_index, 'contextVersion', v_context)
  );

  perform core.emit_event(
    v_phase3.organization_id, 'project.theme_options_generated', 'theme_option', v_new,
    jsonb_build_object('projectId', p_project_id, 'optionIndex', p_option_index, 'contextVersion', v_context)
  );

  return query select 'recorded'::text, v_new, v_context;
end;
$$;
create or replace function projects.record_color_option(
  p_theme_option_id uuid,
  p_option_index    int,
  p_palette_name    text,
  p_primary_hex     text,
  p_tokens          jsonb default '{}'::jsonb,
  p_contrast_notes  text default null,
  p_brand_source    text default null
)
returns table (
  -- 'recorded' | 'already_recorded' | 'unknown_option' | 'bad_token'
  -- | 'no_actor' | 'forbidden'
  outcome         text,
  color_option_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_theme    projects.theme_options;
  v_existing projects.color_options;
  v_new      uuid;
begin
  -- CHANGED (G-303): the same escape, for the same event.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t where t.id = p_theme_option_id for update;
  if v_theme.id is null then
    return query select 'unknown_option'::text, null::uuid; return;
  end if;

  -- CHANGED (G-303): person-only, and coalesced against a NULL role (G-281).
  if v_actor is not null
     and (v_theme.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select c.* into v_existing
    from projects.color_options c
   where c.theme_option_id = p_theme_option_id
     and c.option_index = p_option_index;

  if v_existing.id is not null then
    return query select 'already_recorded'::text, v_existing.id; return;
  end if;

  begin
    insert into projects.color_options (
      organization_id, theme_option_id, option_index, palette_name,
      primary_hex, secondary_hex, accent_hex, background_hex, surface_hex,
      text_primary_hex, text_secondary_hex, success_hex, warning_hex, error_hex,
      contrast_notes, brand_source
    ) values (
      v_theme.organization_id, p_theme_option_id, p_option_index, btrim(p_palette_name),
      btrim(p_primary_hex),
      nullif(btrim(coalesce(p_tokens->>'secondary', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'accent', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'background', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'surface', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'textPrimary', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'textSecondary', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'success', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'warning', '')), ''),
      nullif(btrim(coalesce(p_tokens->>'error', '')), ''),
      nullif(btrim(coalesce(p_contrast_notes, '')), ''),
      nullif(btrim(coalesce(p_brand_source, '')), '')
    )
    returning id into v_new;
  exception
    when check_violation then
      -- A hex that is not a hex. Answered rather than raised: the caller
      -- mistyped a token, and Phase 4 reading an unparseable colour would
      -- re-pick it, which is the whole thing the token exists to prevent.
      return query select 'bad_token'::text, null::uuid; return;
  end;

  perform core.record_audit(
    v_theme.organization_id, 'project.color_options_generated', 'color_option', v_new, null,
    jsonb_build_object('themeOptionId', p_theme_option_id, 'optionIndex', p_option_index)
  );

  perform core.emit_event(
    v_theme.organization_id, 'project.color_options_generated', 'color_option', v_new,
    jsonb_build_object('themeOptionId', p_theme_option_id, 'optionIndex', p_option_index)
  );

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function projects.record_theme_option(uuid, int, text, text, jsonb) is
  'Master sections 11 and 18. Records one direction. THE SERVICE ROLE MAY CALL IT because a finalized screen baseline is an EVENT and a job acts on it - the same escape start_phase_three carries, for the same reason. No tenant boundary moves: the organisation is read from the phase, so there is no caller-supplied organisation to trust. created_by is null for an agent, because no person drew it and ai.agent_runs is where an agent''s authorship belongs. Its authority guard is coalesced against a NULL role (G-281).';

comment on function projects.record_color_option(uuid, int, text, text, jsonb, text, text) is
  'Master section 12. Records one palette against one direction. The service role may call it for the same reason record_theme_option accepts it: a job acts on an event. Its authority guard is coalesced against a NULL role (G-281). NOTE the token keys are camelCase - secondary, accent, background, surface, textPrimary, textSecondary, success, warning, error - and a caller sending snake_case silently records only the primary.';

grant execute on function projects.record_theme_option(uuid, int, text, text, jsonb) to service_role;
grant execute on function projects.record_color_option(uuid, int, text, text, jsonb, text, text) to service_role;

notify pgrst, 'reload schema';
