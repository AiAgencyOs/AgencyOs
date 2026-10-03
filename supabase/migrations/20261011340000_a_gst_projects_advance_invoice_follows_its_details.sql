-- A GST project's M1 invoice follows its billing details being complete.
--
-- Found by driving the whole Phase 2 flow end to end: `confirm_billing_mode`
-- publishes `project.billing_mode_confirmed` the moment the mode is chosen, the
-- M1 job finds a GST profile with no legal name / GSTIN / address / state, and
-- (before the same change in the service) failed permanently - and recording the
-- details afterwards published nothing, so a GST project's advance invoice was
-- always a manual click. `record_billing_details` is carried forward from its live
-- body with one addition: when the profile it writes is complete it publishes the
-- same event again. The M1 job is idempotent, so a replay raises nothing twice.

CREATE OR REPLACE FUNCTION finance.record_billing_details(p_project_id uuid, p_legal_name text DEFAULT NULL::text, p_billing_address text DEFAULT NULL::text, p_billing_state text DEFAULT NULL::text, p_gstin text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, profile_id uuid, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_live    finance.billing_profiles;
  v_new     uuid;
  v_gstin   text := nullif(btrim(upper(coalesce(p_gstin, ''))), '');
  v_name    text;
  v_addr    text;
  v_state   text;
begin
  if v_actor is null then
    return query select 'needs_person'::text, null::uuid, null::int; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::int; return;
  end if;

  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  select bp.* into v_live
    from finance.billing_profiles bp
   where bp.project_id = v_project.id and bp.status = 'active';

  -- §16: "Missing billing mode — block invoice." Details before a mode would
  -- be a profile that exists without anybody having decided how this project
  -- is billed, which is the state this whole table was added to end.
  if v_live.id is null then
    return query select 'no_mode'::text, null::uuid, null::int; return;
  end if;

  -- §4.3 again, at the door this time: a GSTIN offered for a non-GST project
  -- is refused by name rather than dropped silently, because a person who
  -- typed one believes it was stored.
  if v_gstin is not null and v_live.mode <> 'gst' then
    return query select 'gstin_on_non_gst'::text, v_live.id, v_live.version; return;
  end if;

  v_name  := coalesce(nullif(btrim(coalesce(p_legal_name, '')), ''), v_live.legal_name);
  v_addr  := coalesce(nullif(btrim(coalesce(p_billing_address, '')), ''), v_live.billing_address);
  v_state := coalesce(nullif(btrim(coalesce(p_billing_state, '')), ''), v_live.billing_state);
  v_gstin := coalesce(v_gstin, v_live.gstin);

  if v_name is not distinct from v_live.legal_name
     and v_addr is not distinct from v_live.billing_address
     and v_state is not distinct from v_live.billing_state
     and v_gstin is not distinct from v_live.gstin then
    return query select 'unchanged'::text, v_live.id, v_live.version; return;
  end if;

  update finance.billing_profiles set status = 'superseded' where id = v_live.id;

  insert into finance.billing_profiles (
    organization_id, project_id, client_account_id, version, status, mode,
    legal_name, billing_address, billing_state, gstin, confirmed_by, source, note
  ) values (
    v_project.organization_id, v_project.id, v_project.client_account_id,
    v_live.version + 1, 'active', v_live.mode,
    v_name, v_addr, v_state, v_gstin, v_actor, v_live.source, v_live.note
  )
  returning id into v_new;

  perform core.record_audit(
    v_project.organization_id, 'project.billing_details_recorded', 'project', v_project.id,
    jsonb_build_object('version', v_live.version),
    jsonb_build_object('version', v_live.version + 1, 'profile_id', v_new, 'recorded_by', v_actor),
    null
  );

  -- [Phase 2 Finance §4.4] The M1 invoice follows the billing profile BEING
  -- COMPLETE. For a GST project the mode is confirmed first and the details
  -- arrive after, so the confirmation's event found an incomplete profile and
  -- the M1 job could do nothing; nothing ever fired again when the details
  -- landed, and the invoice stayed a manual click. The moment the profile
  -- becomes complete the same event is published again - the M1 job is
  -- idempotent (`already_invoiced`), so a second publication cannot raise a
  -- second invoice.
  if v_live.mode = 'gst' and v_name is not null and v_addr is not null and v_state is not null and v_gstin is not null then
    perform core.emit_event(
      v_project.organization_id, 'project.billing_mode_confirmed', 'project', v_project.id,
      jsonb_build_object('profile_id', v_new, 'mode', v_live.mode, 'version', v_live.version + 1, 'source', 'details_completed'),
      null
    );
  end if;

  return query select 'recorded'::text, v_new, v_live.version + 1;
end;
$function$;
