-- Independent review: maintenance billing records are money records. They were readable by every internal member; they now follow the
-- invoices table (owner, ops_admin or finance). A plan is changed only through its doors, never by a raw write from a signed-in session.

do $mig$
declare t text;
begin
  foreach t in array array['maintenance_billing_requests', 'maintenance_billing_proposals', 'maintenance_billing_decisions', 'maintenance_billing_links', 'maintenance_gate_exceptions'] loop
    execute format('drop policy %I on finance.%I', t || '_read', t);
    execute format($p$create policy %I on finance.%I for select to authenticated
      using (organization_id = (select core.current_organization_id())
             and ((select core.current_user_role()) = any (array['owner', 'ops_admin']) or (select core.is_finance())))$p$, t || '_read', t);
  end loop;
end $mig$;

-- every legitimate writer is a SECURITY DEFINER door or the service role; the admin-only write policy let an Admin's raw insert skip the lifecycle
revoke insert, update, delete on projects.maintenance_plans from authenticated;
