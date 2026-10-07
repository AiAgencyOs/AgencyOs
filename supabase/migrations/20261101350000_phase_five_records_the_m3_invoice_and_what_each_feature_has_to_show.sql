-- PM5 / Admin Panel spec: the M3 invoice and payment state a staff member can read without being Finance, and feature coverage (requirement ->
-- feature -> task -> build -> test). Both are reads: neither writes, neither grants anything, and a portal client reads neither.

create or replace function projects.m3_invoice_summary(p_project_id uuid)
returns table (invoice_number text, status text, total_minor bigint, verified_minor bigint, verified_paid boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if not coalesce((select core.is_internal()), false) then return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return; end if;
  return query
    select i.number, i.status, i.total_minor, i.verified_minor, projects.m3_verified_paid(p_project_id)
      from finance.invoices i
     where i.organization_id = v_org and i.status <> 'void'
       and i.milestone_id = (select m.id from projects.milestones m where m.project_id = p_project_id and m.amount_minor is not null order by m.position, m.created_at offset 2 limit 1);
end $$;
revoke all on function projects.m3_invoice_summary(uuid) from public, anon;
grant execute on function projects.m3_invoice_summary(uuid) to authenticated;

create or replace function projects.feature_coverage(p_project_id uuid)
returns table (feature_id uuid, feature text, tasks integer, tasks_done integer, tasks_with_passing_evidence integer, build_commit text)
language sql stable set search_path = '' as $$
  select f.id, f.name,
         count(t.id)::int,
         (count(t.id) filter (where t.status = 'done'))::int,
         (count(t.id) filter (where t.id is not null and not exists (select 1 from projects.task_test_gaps(p_project_id) g where g.task_id = t.id)))::int,
         (select dd.commit_ref from projects.deliverables b join projects.deliverable_details dd on dd.deliverable_id = b.id
           where b.project_id = p_project_id and b.kind = 'build' and b.status <> 'superseded' order by b.version desc limit 1)
    from projects.features f
    left join projects.tasks t on t.feature_id = f.id and t.status <> 'cancelled' and t.archived_at is null
   where f.project_id = p_project_id and (select core.is_internal())
   group by f.id, f.name, f.position
   order by f.position, f.name
$$;
revoke all on function projects.feature_coverage(uuid) from public, anon;
grant execute on function projects.feature_coverage(uuid) to authenticated;
notify pgrst, 'reload schema';
