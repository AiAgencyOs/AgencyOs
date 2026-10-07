-- ═══════════════════════════════════════════════════════════════════════════
-- The Phase 7 -> Phase 8 SEAM (docs/phase-8a-manual-actions.md M-6).
--
-- Phase 7 freezes `projects.phase_seven_handoffs` (and `p7_completion_records`) in the same transaction that completes a pipeline project. Phase 8's intake
-- (`projects.phase_eight_intake`, filled by `projects.p8_build_intake`) was written to read the legacy `projects.completion_records`, which a pipeline project
-- never gets. This migration changes ONLY `projects.p8_build_intake`: when a frozen Phase 7 handoff exists for the project it is the source of the facts
-- (source = 'phase_seven_handoff', phase_seven_handoff_ref = the handoff id); a project without one is judged exactly as before. The gate ids, the Phase 8
-- workspace and the panel are untouched.
--
-- It patches the LIVE definition (so it composes with whatever the function is by now) and raises if any expected text is missing: a patch that silently
-- did nothing would leave the intake reading the wrong source while this file claimed otherwise.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function pg_temp.p7b_swap(p_src text, p_old text, p_new text)
returns text language plpgsql as $$
begin
  if position(p_old in p_src) = 0 then raise exception 'p8_build_intake patch: expected text not found: %', left(p_old, 90); end if;
  return replace(p_src, p_old, p_new);
end $$;

do $$
declare
  v_oid oid := 'projects.p8_build_intake(uuid, uuid)'::regprocedure;
  v_def text := pg_get_functiondef('projects.p8_build_intake(uuid, uuid)'::regprocedure);
begin
  -- 1. declarations
  v_def := pg_temp.p7b_swap(v_def, 'g record; v_w text;',
    'g record; v_w text; v_h7 projects.phase_seven_handoffs; v_cr7 projects.p7_completion_records; v_pk7 projects.p7_handover_packages; v_acc7 projects.p7_client_acceptances; v_fin7 int;');

  -- 2. when a frozen Phase 7 handoff exists it is the source of the completion facts (read, never written)
  v_def := pg_temp.p7b_swap(v_def, '  for g in select * from (values',
$p7$  -- the Phase 7 seam: the frozen handoff replaces the legacy completion record as the reader of the completion facts
  select * into v_h7 from projects.phase_seven_handoffs hh where hh.project_id = v_project.id and hh.organization_id = p_organization_id;
  if v_h7.id is not null then
    select * into v_cr7 from projects.p7_completion_records r7 where r7.id = v_h7.completion_record_id;
    select * into v_pk7 from projects.p7_handover_packages pk where pk.id = v_cr7.package_id;
    select * into v_acc7 from projects.p7_client_acceptances ac where ac.id = v_cr7.acceptance_id;
    select count(*) into v_fin7 from projects.p7_financial_clearance(v_project.id) f where not f.satisfied;
    -- an in-memory stand-in for the gates below; the intake row stores NULL as its completion_record_id (that column is the legacy table's)
    v_c.id := v_h7.id;
    v_c.completed_at := v_cr7.completed_at;
    v_c.scope_version_id := (select sv.id from projects.scope_versions sv
                              where sv.project_id = v_project.id and sv.id::text = (select ph.payload ->> 'scopeVersionId' from projects.phase_six_handoffs ph where ph.project_id = v_project.id));
    v_c.scope_version := (select sv.version from projects.scope_versions sv where sv.id = v_c.scope_version_id);
    v_c.known_limitations := case when jsonb_array_length(coalesce(v_h7.payload -> 'knownLimitations', '[]'::jsonb)) = 0
                                  then 'none: the Phase 7 handover disclosed no known limitation'
                                  else (select string_agg(e ->> 'title', '; ' order by e ->> 'title') from jsonb_array_elements(v_h7.payload -> 'knownLimitations') e) end;
    v_c.warranty_note := v_pk7.support_terms;
    -- money: the Phase 7 completion gate already required a clear financial clearance; it is re-read NOW so a later reversal shows
    if v_fin7 = 0 then
      v_c.invoiced_minor := 0; v_c.verified_minor := 0; v_unpaid := 0;
    else
      select coalesce(sum(i.total_minor), 0), coalesce(sum(i.verified_minor), 0) into v_c.invoiced_minor, v_c.verified_minor from finance.invoices i where i.project_id = v_project.id and i.status <> 'void';
    end if;
    v_verified := v_verified or exists (select 1 from projects.p7_validation_runs vr where vr.id = v_cr7.validation_run_id and vr.status = 'passed');
    v_hand.id := v_h7.id;
    v_hand.accepted_at := coalesce(v_acc7.recorded_at, v_cr7.completed_at);
    v_build := coalesce(v_build, v_h7.commit_ref);
  end if;

  for g in select * from (values$p7$);

  -- 3. the intake row names its source
  v_def := pg_temp.p7b_swap(v_def, 'values (p_organization_id, v_project.id, v_project.client_account_id, ''completion_record'', v_c.id, v_hand.id, v_c.scope_version_id, v_build,',
    'values (p_organization_id, v_project.id, v_project.client_account_id, case when v_h7.id is null then ''completion_record'' else ''phase_seven_handoff'' end, case when v_h7.id is null then v_c.id end, case when v_h7.id is null then v_hand.id end, v_h7.id::text, v_c.scope_version_id, v_build,');
  v_def := pg_temp.p7b_swap(v_def, '(organization_id, project_id, client_account_id, source, completion_record_id, handover_id, scope_version_id, build_ref,',
    '(organization_id, project_id, client_account_id, source, completion_record_id, handover_id, phase_seven_handoff_ref, scope_version_id, build_ref,');
  v_def := pg_temp.p7b_swap(v_def, 'do update set completion_record_id = excluded.completion_record_id,',
    'do update set source = excluded.source, phase_seven_handoff_ref = excluded.phase_seven_handoff_ref, completion_record_id = excluded.completion_record_id,');

  execute v_def;
  -- the function keeps its grants (create or replace preserves them); prove it did not widen
  if has_function_privilege('authenticated', v_oid, 'execute') or has_function_privilege('service_role', v_oid, 'execute') then
    raise exception 'p8_build_intake must stay reachable only through its two doors';
  end if;
end $$;

notify pgrst, 'reload schema';
