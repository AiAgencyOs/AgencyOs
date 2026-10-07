-- Wiring (P4-PROTO-058): `projects.prototype_send_gate` reads `projects.p4ui_build_share_eligibility`.
--
-- The gate that decides whether a prototype may go to the client on the normal path asked only "did QA pass it" and "did Admin approve it". The p4ui record
-- of the planned build knows three more reasons a build must not be shown: a prototype blocker is open, a preview artifact failed to upload or is still
-- pending, and the known limitations were never stated. `p4ui_build_share_eligibility` answered all of them and nothing asked it.
--
-- The change is one clause, applied only when QA had passed the artifact:
--   * a prototype with NO planned p4ui build is gated exactly as before (builds made before the p4ui record, or by a person outside it, are untouched);
--   * a planned build for this artifact must be share-eligible. The eligibility's first reason ("the build has not passed Prototype QA") is left out on
--     purpose: the build's status follows the artifact through `p4ui_sync_build_status`, which runs a moment after the verdict, and the artifact's own
--     verdict (read above) is the authority, not the lagging copy of it;
--   * when it is not eligible `qa_passed` is false and `qa_source` says why, so the existing `not_qa_passed` refusal in `submit_deliverable` carries the reasons.
--
-- Same signature, same return shape, security invoker as before: additive and safe to apply ahead of the code. The owner's override door
-- (`app.prototype_send_override`) is untouched and still the only way around this gate.
create or replace function projects.prototype_send_gate(p_deliverable_id uuid)
returns table (qa_passed boolean, admin_approved boolean, qa_source text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_art     projects.prototype_artifacts;
  v_qa      boolean := false;
  v_src     text;
  v_adm     boolean;
  v_reasons text[];
begin
  select * into v_art from projects.prototype_artifacts a where a.deliverable_id = p_deliverable_id;
  if v_art.id is not null and v_art.status = 'qa_pass' then
    v_qa := true;
    v_src := 'the prototype QA verdict';
  elsif exists (select 1 from projects.deliverable_details d where d.deliverable_id = p_deliverable_id and d.qa_status = 'passed') then
    v_qa := true;
    v_src := 'a QA check recorded by a person';
  elsif v_art.id is not null and v_art.status = 'qa_changes_required' then
    v_src := 'the prototype QA verdict asked for changes';
  elsif exists (select 1 from projects.deliverable_details d where d.deliverable_id = p_deliverable_id and d.qa_status = 'changes_required') then
    v_src := 'a recorded QA check asked for changes';
  else
    v_src := 'no QA evidence';
  end if;

  if v_qa and v_art.id is not null then
    select array(
             select r
               from unnest(coalesce(e.reasons, '{}'::text[])) as r
              where r not like 'the build has not passed Prototype QA%')
      into v_reasons
      from (select b.id from projects.p4ui_prototype_builds b
             where b.prototype_artifact_id = v_art.id
             order by b.build_number desc limit 1) pb
      cross join lateral projects.p4ui_build_share_eligibility(pb.id) e;
    if coalesce(cardinality(v_reasons), 0) > 0 then
      v_qa := false;
      v_src := 'the planned build is not share-eligible: ' || array_to_string(v_reasons, '; ');
    end if;
  end if;

  select coalesce((select d.admin_status = 'approved' from projects.deliverable_details d where d.deliverable_id = p_deliverable_id), false) into v_adm;
  return query select v_qa, v_adm, v_src;
end;
$$;
revoke all on function projects.prototype_send_gate(uuid) from public, anon;
grant execute on function projects.prototype_send_gate(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
