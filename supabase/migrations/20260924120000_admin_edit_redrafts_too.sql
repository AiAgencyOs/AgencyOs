-- ═══════════════════════════════════════════════════════════════════════════
-- Admin EDIT redrafts too, not only client_change.
--
-- Master's locked objective names TWO ways a UI version goes back to the
-- designer: "ADMIN EDIT → DESIGNER → QA → ADMIN AGAIN", and separately the
-- UI Client Revision Rule's "CLIENT → PM → DESIGNER → QA → ADMIN → PM →
-- CLIENT." `20260924100000` built the second path. It left the first one
-- unbuilt: `sync_ui_version_decision` has written `admin_edit` since
-- `20260923130000`, and nothing has ever read it to redraft anything — the
-- exact "event with no receiver" shape this repository's own audit history
-- keeps finding (G-258's note, quoted verbatim in `20260923100000`'s own
-- header).
--
-- ── one door, one counter, two entry states ───────────────────────────────
--
-- `phase_four` carries exactly one `ui_revision_count`/`ui_revision_limit`
-- pair, not two — Master's schema never named a separate budget for an
-- Admin-requested redraft versus a client-requested one, and inventing a
-- second counter here would be modelling a distinction the schema does not
-- draw. `revise_ui_version` already does everything a redraft needs
-- (advance the version, reuse `project.ui_version_drafted`, enforce the
-- limit); the only change is which status may start a round. Rather than a
-- second door with the same body, this migration `create or replace`s the
-- one door with the exit condition widened.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.revise_ui_version(
  p_phase_four_id uuid,
  p_screens       jsonb
)
returns table (
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
  v_latest     projects.ui_versions;
  v_new        uuid;
  v_next_version int;
begin
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

  select v.* into v_latest
    from projects.ui_versions v
   where v.phase_four_id = v_phase_four.id
   order by v.version desc
   limit 1;

  if v_latest.id is null then
    return query select 'no_prior_version'::text, null::uuid; return;
  end if;

  -- Widened from `client_change` alone: Master names TWO paths back to the
  -- designer, admin_edit and client_change, sharing this one door and this
  -- one revision counter (see header).
  if v_latest.status not in ('client_change', 'admin_edit') then
    return query select 'already_revised'::text, v_latest.id; return;
  end if;

  if p_screens is null or jsonb_typeof(p_screens) <> 'array' or jsonb_array_length(p_screens) = 0 then
    return query select 'empty_screens'::text, null::uuid; return;
  end if;

  if v_phase_four.ui_revision_count >= v_phase_four.ui_revision_limit then
    update projects.phase_four
       set state = 'revision_limit_escalation',
           blocked_reason = format(
             'UI revision limit reached: %s round(s) already completed against a limit of %s. Human escalation required before another round.',
             v_phase_four.ui_revision_count, v_phase_four.ui_revision_limit
           )
     where id = v_phase_four.id;

    perform core.record_audit(
      v_phase_four.organization_id, 'project.ui_revision_limit_reached', 'phase_four', v_phase_four.id, null,
      jsonb_build_object('projectId', v_phase_four.project_id, 'uiRevisionCount', v_phase_four.ui_revision_count, 'uiRevisionLimit', v_phase_four.ui_revision_limit)
    );

    return query select 'revision_limit_reached'::text, null::uuid; return;
  end if;

  v_next_version := v_latest.version + 1;

  insert into projects.ui_versions (
    organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, screens
  ) values (
    v_phase_four.organization_id, v_phase_four.project_id, v_phase_four.id,
    v_latest.source_phase_three_handoff_id, v_next_version, p_screens
  )
  returning id into v_new;

  update projects.phase_four
     set state = 'ui_design',
         ui_revision_count = ui_revision_count + 1
   where id = v_phase_four.id;

  perform core.record_audit(
    v_phase_four.organization_id, 'project.ui_version_drafted', 'ui_version', v_new, null,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id, 'version', v_next_version, 'revisionOf', v_latest.id)
  );

  perform core.emit_event(
    v_phase_four.organization_id, 'project.ui_version_drafted',
    'ui_version', v_new,
    jsonb_build_object('projectId', v_phase_four.project_id, 'phaseFourId', v_phase_four.id)
  );

  return query select 'revised'::text, v_new;
end;
$$;

comment on function projects.revise_ui_version(uuid, jsonb) is
  'UI Client Revision Rule (UID section 4) AND Master''s Admin EDIT path, sharing one door and one ui_revision_count: drafts round N+1 for a workspace whose latest UI version is client_change OR admin_edit, under the workspace''s own row lock. Enforces ui_revision_limit here rather than only displaying it. Reuses project.ui_version_drafted rather than a new event type.';

revoke all on function projects.revise_ui_version(uuid, jsonb) from public, anon;
grant execute on function projects.revise_ui_version(uuid, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
