-- PM5: a classified piece of build feedback is announced (the event carries the project, build and category, never the client's words).
CREATE OR REPLACE FUNCTION projects.classify_build_feedback(p_feedback_id uuid, p_classification text)
 RETURNS TABLE(outcome text, defect_id uuid, change_request_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_fb    projects.build_feedback;
  v_defect uuid;
  v_cr    record;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid, null::uuid; return; end if;
  if p_classification not in ('bug', 'missed_requirement', 'ui_mismatch', 'included_small_revision', 'clarification', 'possible_scope_change', 'new_feature') then
    return query select 'bad_classification'::text, null::uuid, null::uuid; return;
  end if;
  select * into v_fb from projects.build_feedback f where f.id = p_feedback_id and f.organization_id = v_org for update;
  if v_fb.id is null then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
  if v_fb.classification is not null then
    return query select 'already_classified'::text, v_fb.defect_id, v_fb.change_request_id; return;
  end if;

  if p_classification in ('bug', 'missed_requirement', 'ui_mismatch') then
    insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by)
    values (v_fb.organization_id, v_fb.project_id, v_fb.deliverable_id,
            case p_classification when 'ui_mismatch' then 'minor' else 'major' end,
            left('Client feedback (' || p_classification || '): ' || v_fb.client_words, 200),
            v_fb.client_words, v_actor)
    returning id into v_defect;
    update projects.build_feedback set classification = p_classification, state = 'routed', defect_id = v_defect, classified_by = v_actor, classified_at = now() where id = v_fb.id;
    perform core.record_audit(v_fb.organization_id, 'build.feedback_routed_to_defect', 'build_feedback', v_fb.id, null, jsonb_build_object('classification', p_classification, 'defectId', v_defect));
    perform core.emit_event(v_fb.organization_id, 'project.build_feedback_routed', 'build_feedback', v_fb.id, jsonb_build_object('projectId', v_fb.project_id, 'deliverableId', v_fb.deliverable_id, 'classification', p_classification));
    return query select 'defect_raised'::text, v_defect, null::uuid; return;
  end if;

  if p_classification in ('possible_scope_change', 'new_feature') then
    select * into v_cr from projects.submit_change_request(v_fb.project_id, v_fb.client_words, 'client', null);
    if v_cr.outcome <> 'submitted' and v_cr.outcome <> 'created' and v_cr.change_request_id is null then
      return query select v_cr.outcome, null::uuid, null::uuid; return;
    end if;
    update projects.build_feedback set classification = p_classification, state = 'routed', change_request_id = v_cr.change_request_id, classified_by = v_actor, classified_at = now() where id = v_fb.id;
    perform core.record_audit(v_fb.organization_id, 'build.feedback_routed_to_change_request', 'build_feedback', v_fb.id, null, jsonb_build_object('classification', p_classification, 'changeRequestId', v_cr.change_request_id));
    perform core.emit_event(v_fb.organization_id, 'project.build_feedback_routed', 'build_feedback', v_fb.id, jsonb_build_object('projectId', v_fb.project_id, 'deliverableId', v_fb.deliverable_id, 'classification', p_classification));
    return query select 'change_request_raised'::text, null::uuid, v_cr.change_request_id; return;
  end if;

  update projects.build_feedback
     set classification = p_classification,
         state = case p_classification when 'clarification' then 'clarification_needed' else 'routed' end,
         classified_by = v_actor, classified_at = now()
   where id = v_fb.id;
  perform core.emit_event(v_fb.organization_id, 'project.build_feedback_routed', 'build_feedback', v_fb.id, jsonb_build_object('projectId', v_fb.project_id, 'deliverableId', v_fb.deliverable_id, 'classification', p_classification));
  return query select case p_classification when 'clarification' then 'clarification_needed' else 'revision_routed' end::text, null::uuid, null::uuid;
end $function$;

revoke all on function projects.classify_build_feedback(uuid, text) from public, anon;
grant execute on function projects.classify_build_feedback(uuid, text) to authenticated;

notify pgrst, 'reload schema';
