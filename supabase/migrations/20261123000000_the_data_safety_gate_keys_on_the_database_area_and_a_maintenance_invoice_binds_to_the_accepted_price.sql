-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 hardening (closes two review findings; nothing here widens what a person may do).
--
--   1. The data-safety gate keys on area = 'database', REGARDLESS of the sensitive flag.
--      Before: the gate (and the door that records data safety) applied only to a change the author MARKED sensitive. The author is the person the
--      control is about: leaving the box unticked removed the rollback-plan and backup-evidence requirement. Now every change that touches the
--      database needs it. The flag keeps its other meaning (a security QA result is required).
--
--   2. The sensitive flag is MONOTONIC, and so is the database area. A flag that can be cleared by an update, or an area that can be edited away from
--      'database' after the fact, is the same loophole by another route. Once a work item is sensitive it stays sensitive; once it is a database change
--      it stays one. (The table already freezes kind, authorization and emergency; these two were left editable.)
--
--   3. link_maintenance_invoice binds the invoice to the PRICE a person quoted and the client accepted, and to a BOUNDED cycle.
--      ADM-22 says there is no free-standing price: every price is quoted per client by a human on sales.proposals. So:
--        activation: the invoice total must equal the total of the proposal the plan's acceptance names (the acceptance record when the plan entered
--                    the lifecycle, otherwise the plan's accepted_proposal_id), in the same currency. No accepted quote: refused, never guessed.
--        renewal:    the cycle must be the renewal the client accepted (its exact start and end) and the invoice total must equal that renewal's quote.
--      A cycle is bounded: end after start, at most as long as the plan's billing model allows (monthly 35 days, quarterly 100, annual 380; prepaid is
--      bounded by the plan's own end date, or 1,100 days when it has none), an activation cycle inside the plan's own dates when it states them, and
--      never overlapping another cycle already billed on the same plan.
--      A mismatch is refused with its own outcome. Nothing is coerced, no amount is typed here, no invoice is created or changed.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 + 2. the data-safety gate and door read the area, not the flag; the flag and the area never move backwards ────────────────────────────────────
do $mig$
declare
  v_def text; v_new text;
begin
  v_def := pg_get_functiondef('projects.record_maintenance_data_safety(uuid,text,text,text,boolean)'::regprocedure);
  if position('if not (v_i.sensitive and v_i.area = ''database'') then return query select ''not_a_sensitive_database_change''' in v_def) = 0 then
    raise exception 'record_maintenance_data_safety: area/sensitive condition not found';
  end if;
  v_new := replace(v_def, 'if not (v_i.sensitive and v_i.area = ''database'') then return query select ''not_a_sensitive_database_change''',
                          'if v_i.area is distinct from ''database'' then return query select ''not_a_sensitive_database_change''');
  execute v_new;

  v_def := pg_get_functiondef('projects.evaluate_maintenance_gates(uuid)'::regprocedure);
  if position('if not (v_i.sensitive and v_i.area = ''database'') or v_cut is null or v_i.created_at < v_cut then' in v_def) = 0 then
    raise exception 'evaluate_maintenance_gates: data_safety condition not found';
  end if;
  v_new := replace(v_def, 'if not (v_i.sensitive and v_i.area = ''database'') or v_cut is null or v_i.created_at < v_cut then',
                          'if v_i.area is distinct from ''database'' or v_cut is null or v_i.created_at < v_cut then');
  v_new := replace(v_new, 'not a sensitive database change: no data-safety record is required', 'not a database change: no data-safety record is required');
  v_new := replace(v_new, 'a sensitive database change has no data-safety record', 'a database change has no data-safety record');
  execute v_new;
end $mig$;

create or replace function projects.maintenance_work_flags_are_monotonic()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.sensitive and not new.sensitive then
    raise exception 'a maintenance work item marked sensitive stays sensitive: the mark is never taken back' using errcode = 'restrict_violation';
  end if;
  if old.area = 'database' and new.area is distinct from 'database' then
    raise exception 'a database change stays a database change: its area is never edited away' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_work_flags_monotonic on projects.maintenance_work_items;
create trigger maintenance_work_flags_monotonic before update of sensitive, area on projects.maintenance_work_items
  for each row execute function projects.maintenance_work_flags_are_monotonic();

-- ── 3. the invoice is bound to the accepted price and to a bounded cycle ────────────────────────────────────────────────────────────────────────────
create or replace function finance.link_maintenance_invoice(p_plan_id uuid, p_invoice_id uuid, p_purpose text, p_cycle_start date, p_cycle_end date)
returns table (outcome text, link_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_plan projects.maintenance_plans; v_inv finance.invoices; v_existing finance.maintenance_billing_links; v_id uuid;
  v_prop sales.proposals; v_prop_id uuid; v_ren projects.maintenance_plan_renewals; v_max int;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_purpose is null or p_purpose not in ('activation', 'renewal') then return query select 'bad_purpose'::text, null::uuid; return; end if;
  if p_cycle_start is null or p_cycle_end is null or p_cycle_end <= p_cycle_start then return query select 'bad_cycle'::text, null::uuid; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org for update;
  if v_plan.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_inv from finance.invoices i where i.id = p_invoice_id and i.organization_id = v_org;
  if v_inv.id is null or v_inv.client_account_id is distinct from v_plan.client_account_id then return query select 'invoice_not_found'::text, null::uuid; return; end if;
  if v_inv.status = 'void' then return query select 'invoice_void'::text, null::uuid; return; end if;
  if v_inv.kind not in ('maintenance_renewal', 'service') then return query select 'invoice_is_not_maintenance_billing'::text, null::uuid; return; end if;
  select * into v_existing from finance.maintenance_billing_links l where l.plan_id = p_plan_id and l.purpose = p_purpose and l.cycle_start = p_cycle_start;
  if v_existing.id is not null then
    if v_existing.invoice_id = p_invoice_id then return query select 'already_linked'::text, v_existing.id; return; end if;
    return query select 'cycle_already_billed'::text, v_existing.id; return;
  end if;
  if exists (select 1 from finance.maintenance_billing_links l where l.invoice_id = p_invoice_id) then return query select 'invoice_already_linked'::text, null::uuid; return; end if;

  -- a bounded cycle
  v_max := case v_plan.billing_model when 'monthly' then 35 when 'quarterly' then 100 when 'annual' then 380 else null end;
  if v_max is not null and (p_cycle_end - p_cycle_start) > v_max then return query select 'cycle_too_long'::text, null::uuid; return; end if;
  if v_plan.billing_model = 'prepaid' and (p_cycle_end - p_cycle_start) > coalesce(v_plan.ends_on - v_plan.starts_on, 1100) then return query select 'cycle_too_long'::text, null::uuid; return; end if;
  if exists (select 1 from finance.maintenance_billing_links l where l.plan_id = p_plan_id and daterange(l.cycle_start, l.cycle_end) && daterange(p_cycle_start, p_cycle_end)) then
    return query select 'cycle_overlaps_a_billed_cycle'::text, null::uuid; return;
  end if;
  if p_purpose = 'activation' and ((v_plan.starts_on is not null and p_cycle_start < v_plan.starts_on) or (v_plan.ends_on is not null and p_cycle_end > v_plan.ends_on)) then
    return query select 'cycle_outside_the_plan_period'::text, null::uuid; return;
  end if;

  -- the accepted price: a person's quote the client accepted. Never a number typed here.
  if p_purpose = 'activation' then
    select a.proposal_id into v_prop_id from projects.maintenance_plan_acceptances a where a.plan_id = p_plan_id and a.decision = 'accepted';
    v_prop_id := coalesce(v_prop_id, v_plan.accepted_proposal_id);
  else
    select r.* into v_ren from projects.maintenance_plan_renewals r
     where r.plan_id = p_plan_id and r.status in ('accepted', 'renewed') order by r.proposed_at desc limit 1;
    if v_ren.id is null then return query select 'no_accepted_price'::text, null::uuid; return; end if;
    if v_ren.renewal_starts_on is distinct from p_cycle_start or v_ren.renewal_ends_on is distinct from p_cycle_end then
      return query select 'cycle_is_not_the_accepted_renewal'::text, null::uuid; return;
    end if;
    v_prop_id := v_ren.price_proposal_id;
  end if;
  if v_prop_id is null then return query select 'no_accepted_price'::text, null::uuid; return; end if;
  select * into v_prop from sales.proposals p where p.id = v_prop_id and p.organization_id = v_org;
  if v_prop.id is null then return query select 'no_accepted_price'::text, null::uuid; return; end if;
  if v_inv.total_minor is distinct from v_prop.total_minor or v_inv.currency is distinct from v_prop.currency then
    return query select 'amount_differs_from_the_accepted_price'::text, null::uuid; return;
  end if;

  insert into finance.maintenance_billing_links (organization_id, plan_id, invoice_id, purpose, cycle_start, cycle_end, linked_by) values (v_org, p_plan_id, p_invoice_id, p_purpose, p_cycle_start, p_cycle_end, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_billing.linked', 'maintenance_billing_link', v_id, null, jsonb_build_object('planId', p_plan_id, 'invoiceId', p_invoice_id, 'purpose', p_purpose, 'cycleStart', p_cycle_start, 'cycleEnd', p_cycle_end, 'priceProposalId', v_prop.id));
  return query select 'linked'::text, v_id;
end $$;
revoke all on function finance.link_maintenance_invoice(uuid, uuid, text, date, date) from public, anon;
grant execute on function finance.link_maintenance_invoice(uuid, uuid, text, date, date) to authenticated;
