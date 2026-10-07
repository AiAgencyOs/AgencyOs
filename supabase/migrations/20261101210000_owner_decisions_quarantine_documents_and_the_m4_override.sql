-- Owner decisions (2026-10-06), review items 8 and 10 and the M4 conflict:
--  * a flaky-test quarantine is STARTED by a member but RENEWED only by an Admin, and at most twice: then the test is fixed or removed;
--  * "documentation current" fails a project that has a build but never derived a document;
--  * the owner's release-payment override no longer applies to a project that is under the Phase 6 M4 gate: M4 is verified paid or it is not.

alter table qa.flaky_tests add column if not exists renewals int not null default 0 check (renewals >= 0);

do $m$
declare d text; n text;
begin
  d := pg_get_functiondef('qa.resolve_flaky_test(uuid,text,text,timestamp with time zone)'::regprocedure);
  n := replace(d, '    update qa.flaky_tests set status = ''quarantined'', owner_id = v_actor, expires_at = p_expires_at where id = v_row.id;',
'    if v_row.status = ''quarantined'' then
      -- a RENEWAL: an Admin decision, and the third one is refused
      if not coalesce((select core.is_admin()), false) then return query select ''renewal_needs_admin''::text; return; end if;
      if v_row.renewals >= 2 then return query select ''renewal_limit_reached_fix_or_remove_the_test''::text; return; end if;
      update qa.flaky_tests set owner_id = v_actor, expires_at = p_expires_at, renewals = renewals + 1 where id = v_row.id;
      return query select ''renewed''::text; return;
    end if;
    update qa.flaky_tests set status = ''quarantined'', owner_id = v_actor, expires_at = p_expires_at, renewals = 0 where id = v_row.id;');
  if n = d then raise exception 'resolve_flaky_test: expected text not found'; end if;
  execute n;

  d := pg_get_functiondef('projects.final_payment_state(uuid)'::regprocedure);
  n := replace(d, 'if exists (select 1 from projects.release_payment_overrides o where o.project_id = p_project_id) then',
    'if exists (select 1 from projects.release_payment_overrides o where o.project_id = p_project_id)
     and not exists (select 1 from projects.phase_six ps where ps.project_id = p_project_id) then');
  if n = d then raise exception 'final_payment_state: expected text not found'; end if;
  execute n;

  d := pg_get_functiondef('projects.override_release_payment(uuid,text)'::regprocedure);
  n := replace(d, '  select s.state into v_state from projects.final_payment_state(p_project_id) s;',
'  if exists (select 1 from projects.phase_six ps where ps.project_id = p_project_id) then
    return query select ''m4_gate_has_no_override''::text, null::uuid; return;
  end if;
  select s.state into v_state from projects.final_payment_state(p_project_id) s;');
  if n = d then raise exception 'override_release_payment: expected text not found'; end if;
  execute n;
end $m$;

create or replace function projects.stale_documents(p_project_id uuid)
returns table (document_id uuid, title text)
language sql stable set search_path = '' as $$
  select d.id, d.title
    from projects.technical_documents d
   where d.project_id = p_project_id and d.derived and d.status <> 'deprecated'
     and d.source_commit is distinct from (
       select dd.commit_ref
         from projects.deliverables b join projects.deliverable_details dd on dd.deliverable_id = b.id
        where b.project_id = p_project_id and b.kind = 'build' and b.status <> 'superseded'
        order by b.version desc limit 1)
  union all
  -- a build with no derived documentation at all is not "current": there is nothing that describes it
  select null::uuid, 'No documentation has been derived from the build'::text
   where exists (select 1 from projects.deliverables b where b.project_id = p_project_id and b.kind = 'build' and b.status <> 'superseded')
     and not exists (select 1 from projects.technical_documents d where d.project_id = p_project_id and d.derived and d.status <> 'deprecated')
$$;
revoke all on function projects.stale_documents(uuid) from public, anon;
grant execute on function projects.stale_documents(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
