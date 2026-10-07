-- ═══════════════════════════════════════════════════════════════════════════
-- M3PaymentVerified (Phase 5 Finance spec, "PHASE 6 GATE"): the fact Phase 6's financial gate stands on. It is emitted ONCE, only when the
-- third priced milestone's invoice is Admin-verified paid IN FULL (the same `projects.m3_verified_paid` the gate reads), never from a claim, a
-- proof, a submission or a match. The runner holds the door (service role); a person cannot emit it, and replaying the verified-payment event
-- emits nothing a second time.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function projects.record_m3_verified(p_project_id uuid)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare v_org uuid;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then
    return query select 'runner_only'::text; return;
  end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return query select 'not_found'::text; return; end if;
  if not projects.m3_verified_paid(p_project_id) then return query select 'not_verified'::text; return; end if;
  perform 1 from projects.projects p where p.id = p_project_id for update;
  if exists (select 1 from core.outbox_events e where e.type = 'project.m3_payment_verified' and e.subject_id = p_project_id) then
    return query select 'already_recorded'::text; return;
  end if;
  perform core.record_audit(v_org, 'project.m3_payment_verified', 'project', p_project_id, null, jsonb_build_object('projectId', p_project_id));
  perform core.emit_event(v_org, 'project.m3_payment_verified', 'project', p_project_id, jsonb_build_object('projectId', p_project_id));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_m3_verified(uuid) from public, anon, authenticated;
grant execute on function projects.record_m3_verified(uuid) to service_role;

notify pgrst, 'reload schema';
