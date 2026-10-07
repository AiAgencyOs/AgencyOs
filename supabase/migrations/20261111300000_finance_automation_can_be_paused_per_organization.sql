-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9B - part 3: a finance-specific automation PAUSE, per organization.
--
-- Why a new table and not the generic switch: the generic controls are not reusable for this. core.kill_switches 'agents_paused' stops EVERY agent of the
-- organization and is owner-only; ai.set_agent_status enables or disables an agent in the global registry (ai.agents has no organization), so neither
-- lets an Admin stop the three Phase 9 finance agents for ONE organization. The generic pause still applies on top (the runner honours it at claim time
-- and between steps); this adds the finer one.
--
--   * finance.finance_automation_controls - the CURRENT state per (organization, agent): one of the three finance agents or 'all'. Written only by the door.
--   * finance.finance_automation_changes  - append-only history: who paused or resumed what, and why.
--   * finance.set_finance_automation_paused - Admin only (owner / ops_admin); a reason is required both ways.
--   * finance.finance_automation_is_paused  - service role only; the runner / workflow asks it. 'all' pauses every finance agent.
--   * finance.request_finance_agent_run now refuses 'automation_paused' while the agent (or 'all') is paused (a person is told, nothing is queued).
-- It only ever STOPS agent runs. Resuming does not run anything; a pause never edits, verifies, refunds, or messages anyone.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.finance_automation_controls (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  agent_key       text not null check (agent_key in ('all', 'finance_reconciliation', 'finance_communication', 'finance_close')),
  paused          boolean not null,
  reason          text not null check (length(btrim(reason)) between 1 and 500),
  set_by          uuid not null references core.users(id) on delete restrict,
  set_at          timestamptz not null default clock_timestamp(),
  unique (organization_id, agent_key)
);

create table if not exists finance.finance_automation_changes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  agent_key       text not null check (agent_key in ('all', 'finance_reconciliation', 'finance_communication', 'finance_close')),
  paused          boolean not null,
  reason          text not null check (length(btrim(reason)) between 1 and 500),
  changed_by      uuid not null references core.users(id) on delete restrict,
  changed_at      timestamptz not null default clock_timestamp()
);

do $$
declare r record;
begin
  for r in select unnest(array['finance_automation_controls', 'finance_automation_changes']) as tbl loop
    execute format('alter table finance.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on finance.%I', r.tbl || '_select', r.tbl);
    execute format($p$create policy %I on finance.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())))$p$, r.tbl || '_select', r.tbl);
    execute format('revoke all on finance.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on finance.%I from authenticated', r.tbl);
    execute format('grant select on finance.%I to authenticated', r.tbl);
    execute format('grant all on finance.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on finance.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on finance.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  -- the history is append-only; the current-state row is changed only through the door and never deleted
  drop trigger if exists finance_automation_changes_append_only on finance.finance_automation_changes;
  create trigger finance_automation_changes_append_only before update or delete on finance.finance_automation_changes for each row execute function finance.phase9_history_append_only();
  drop trigger if exists finance_automation_controls_no_delete on finance.finance_automation_controls;
  create trigger finance_automation_controls_no_delete before delete on finance.finance_automation_controls for each row execute function finance.phase9_history_append_only();
end $$;

create or replace function finance.set_finance_automation_paused(p_agent_key text, p_paused boolean, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id()); v_cur boolean;
begin
  if v_kind <> 'admin' or v_org is null then return query select 'not_authorized'::text; return; end if;
  if p_agent_key is null or p_agent_key not in ('all', 'finance_reconciliation', 'finance_communication', 'finance_close') or p_paused is null then return query select 'bad_agent'::text; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 500 or finance.phase9_has_secret(p_reason) then return query select 'reason_required'::text; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('finance.automation:' || v_org::text || ':' || p_agent_key, 0));
  select c.paused into v_cur from finance.finance_automation_controls c where c.organization_id = v_org and c.agent_key = p_agent_key;
  if coalesce(v_cur, false) = p_paused then return query select 'unchanged'::text; return; end if;
  insert into finance.finance_automation_controls (organization_id, agent_key, paused, reason, set_by) values (v_org, p_agent_key, p_paused, btrim(p_reason), v_actor)
  on conflict (organization_id, agent_key) do update set paused = excluded.paused, reason = excluded.reason, set_by = excluded.set_by, set_at = clock_timestamp();
  insert into finance.finance_automation_changes (organization_id, agent_key, paused, reason, changed_by) values (v_org, p_agent_key, p_paused, btrim(p_reason), v_actor);
  perform core.record_audit(v_org, case when p_paused then 'finance.automation_paused' else 'finance.automation_resumed' end, 'finance_automation', null, null, jsonb_build_object('agent', p_agent_key));
  return query select case when p_paused then 'paused' else 'resumed' end;
end $$;
revoke all on function finance.set_finance_automation_paused(text, boolean, text) from public, anon;
grant execute on function finance.set_finance_automation_paused(text, boolean, text) to authenticated;

-- the runner / workflow asks (service role only): is this agent, or every finance agent, paused for this organization?
create or replace function finance.finance_automation_is_paused(p_organization_id uuid, p_agent_key text)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return false; end if;
  return exists (select 1 from finance.finance_automation_controls c where c.organization_id = p_organization_id and c.paused and c.agent_key in ('all', p_agent_key));
end $$;
revoke all on function finance.finance_automation_is_paused(uuid, text) from public, anon, authenticated;
grant execute on function finance.finance_automation_is_paused(uuid, text) to service_role;

-- ── the request door honours the pause (otherwise identical to 20261106500000) ──
create or replace function finance.request_finance_agent_run(p_agent_key text, p_project_id uuid, p_invoice_id uuid default null)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id()); v_inv finance.invoices; v_id uuid;
begin
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_agent_key is null or p_agent_key not in ('finance_reconciliation', 'finance_communication', 'finance_close') then return query select 'bad_agent'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.deleted_at is null) then return query select 'not_found'::text, null::uuid; return; end if;
  if p_invoice_id is not null then
    select * into v_inv from finance.invoices i where i.id = p_invoice_id and i.organization_id = v_org;
    if v_inv.id is null or v_inv.project_id is distinct from p_project_id then return query select 'not_found'::text, null::uuid; return; end if;
  end if;
  if p_agent_key = 'finance_communication' and p_invoice_id is null then return query select 'name_an_invoice'::text, null::uuid; return; end if;
  -- an Admin paused finance automation: nothing is queued while it stands
  if exists (select 1 from finance.finance_automation_controls c where c.organization_id = v_org and c.paused and c.agent_key in ('all', p_agent_key)) then
    return query select 'automation_paused'::text, null::uuid; return;
  end if;
  insert into finance.finance_agent_requests (organization_id, project_id, invoice_id, agent_key, requested_by) values (v_org, p_project_id, p_invoice_id, p_agent_key, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'finance.agent_run_requested', 'finance_agent_request', v_id, null, jsonb_build_object('agent', p_agent_key, 'projectId', p_project_id, 'invoiceId', p_invoice_id));
  return query select 'requested'::text, v_id;
end $$;
revoke all on function finance.request_finance_agent_run(text, uuid, uuid) from public, anon;
grant execute on function finance.request_finance_agent_run(text, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
