-- "M2" means the SECOND PRICED milestone of a project's plan, not "position = 2".
--
-- Found by driving the whole Phase 2 flow end to end: the installer
-- (`projects.replace_payment_plan`) numbers a plan from 0, while the M1-M4
-- invoice generators and these two Phase 5 gates were written as if it were
-- numbered from 1. On a locked 30/20/30/20 plan "M1" billed 20% (the second
-- milestone), "M2" billed 30%, and the Phase 5 gate waited on the THIRD
-- milestone's invoice. The generators now pick by order in the application;
-- these two functions are carried forward from their live bodies with that one
-- change, so the gate waits on the same milestone the Phase 4 invoice bills.

CREATE OR REPLACE FUNCTION projects.m2_verified_paid(p_project_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org   uuid;
  v_actor uuid := (select auth.uid());
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
begin
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return false; end if;
  -- Tenancy: a person answers only for their own organization.
  if not v_service and (v_actor is null or v_org is distinct from (select core.current_organization_id())) then
    return false;
  end if;
  return exists (
    select 1
      from projects.milestones m
      join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
     where m.project_id = p_project_id
       and m.id = (select m2.id from projects.milestones m2 where m2.project_id = p_project_id and m2.payment_percent is not null order by m2.position, m2.created_at offset 1 limit 1)
       and i.organization_id = v_org
       and i.status = 'paid'
       and i.verified_minor >= i.total_minor
  );
end;
$function$

;

CREATE OR REPLACE FUNCTION projects.phase_five_gate_status(p_project_id uuid)
 RETURNS TABLE(outcome text, m2_invoice_id uuid, m2_invoice_status text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select
    case
      when i.status = 'paid' then 'verified'
      when i.id is not null then 'invoice_issued'
      when m.id is null then 'no_m2_milestone'
      else 'not_ready'
    end,
    i.id,
    i.status
  from projects.milestones m
  left join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
  where m.project_id = p_project_id
    and m.id = (select m2.id from projects.milestones m2 where m2.project_id = p_project_id and m2.payment_percent is not null order by m2.position, m2.created_at offset 1 limit 1)
  limit 1;
$function$

;
notify pgrst, 'reload schema';
