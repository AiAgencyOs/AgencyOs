-- PM5-M03 (Phase 5 PM Agent spec): "Changes Received". The feedback door recorded the client's words and told nobody; the PM (and the person
-- who will classify it) learn of it from this fact. The event carries the project and build, never the client's words (those are read from
-- the row by whoever acts on it).
insert into core.event_types (type, description, canonical) values
  ('project.build_feedback_received',
   'The client sent feedback on a shared development build. It has been recorded verbatim and is awaiting classification (bug, missed requirement, UI mismatch, included revision, clarification, possible scope change, new feature).',
   true)
on conflict (type) do nothing;

create or replace function projects.record_build_feedback(p_deliverable_id uuid, p_client_words text, p_evidence_ref text default null)
returns table (outcome text, feedback_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.deliverables;
  v_new   uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_client_words is null or length(btrim(p_client_words)) = 0 then return query select 'empty'::text, null::uuid; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org;
  if v_row.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text, null::uuid; return; end if;
  if v_row.status not in ('in_review', 'changes_requested', 'approved') then return query select 'not_shared'::text, null::uuid; return; end if;

  insert into projects.build_feedback (organization_id, project_id, deliverable_id, client_words, evidence_ref, recorded_by)
  values (v_row.organization_id, v_row.project_id, v_row.id, p_client_words, p_evidence_ref, v_actor)
  returning id into v_new;
  perform core.record_audit(v_row.organization_id, 'build.feedback_received', 'build_feedback', v_new, null,
    jsonb_build_object('projectId', v_row.project_id, 'deliverableId', v_row.id));
  perform core.emit_event(v_row.organization_id, 'project.build_feedback_received', 'build_feedback', v_new,
    jsonb_build_object('projectId', v_row.project_id, 'deliverableId', v_row.id, 'version', v_row.version));
  return query select 'recorded'::text, v_new;
end $$;
revoke all on function projects.record_build_feedback(uuid, text, text) from public, anon;
grant execute on function projects.record_build_feedback(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
