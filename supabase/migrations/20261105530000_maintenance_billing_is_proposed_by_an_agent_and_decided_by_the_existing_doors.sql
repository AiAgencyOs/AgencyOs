-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 (part B), the Finance agent's maintenance / AMC and change-request billing flows.
--
-- THE RULE THIS FILE KEEPS: the Finance agent PROPOSES, and a person decides through the doors that already exist. It never creates or issues an invoice,
-- never records or verifies a payment, never sets a price, never sends a reminder. Concretely:
--   * No door here takes an amount. A draft invoice line is COPIED, by the database, from the sales.proposal_items of the proposal a human priced and the
--     client accepted (ADM-22: "There is no price catalog. Every price is quoted per client by a human."). The agent supplies a narrative and nothing else.
--   * A payment reminder text is refused unless its invoice is still collectible (issued / partially paid / overdue and short of VERIFIED money): reminders
--     stop at verified full payment. The balance shown beside the text is computed by the database from finance.net_verified_minor.
--   * Accepting a proposal records a decision. If the person then made the invoice through the existing composer / create_change_request_invoice and links it
--     here, the invoice's total must equal the quoted total: a different amount is refused, never coerced.
--   * Payment verification is untouched: finance.verify_payment and the payment-submission doors stay Admin-only and nothing in this file calls them.
--   * The financial gate: a maintenance plan that has been BILLED (its invoice is linked) does not go active or renewed until that invoice is paid on
--     VERIFIED money, or an owner-approved, unexpired exception exists. Plans that were never linked are untouched (the rule is for the new pipeline).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.maintenance_billing_requests (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  kind               text not null check (kind in ('maintenance_invoice', 'change_request_invoice', 'payment_reminder')),
  plan_id            uuid references projects.maintenance_plans(id) on delete restrict,
  change_request_id  uuid references projects.change_requests(id) on delete restrict,
  invoice_id         uuid references finance.invoices(id) on delete restrict,
  requested_by       uuid not null references core.users(id) on delete restrict,
  created_at         timestamptz not null default clock_timestamp(),
  check ((kind = 'maintenance_invoice') = (plan_id is not null)),
  check ((kind = 'change_request_invoice') = (change_request_id is not null)),
  check ((kind = 'payment_reminder') = (invoice_id is not null))
);

create table if not exists finance.maintenance_billing_proposals (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  request_id         uuid not null unique references finance.maintenance_billing_requests(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  kind               text not null check (kind in ('maintenance_invoice', 'change_request_invoice', 'payment_reminder')),
  plan_id            uuid references projects.maintenance_plans(id) on delete restrict,
  change_request_id  uuid references projects.change_requests(id) on delete restrict,
  invoice_id         uuid references finance.invoices(id) on delete restrict,
  -- where the price lives: the human-quoted proposal. Null for a reminder.
  price_proposal_id  uuid references sales.proposals(id) on delete restrict,
  currency           char(3),
  subtotal_minor     bigint check (subtotal_minor is null or subtotal_minor >= 0),
  tax_minor          bigint check (tax_minor is null or tax_minor >= 0),
  total_minor        bigint check (total_minor is null or total_minor >= 0),
  lines              jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  -- a reminder's balance is VERIFIED money subtracted from the invoice, computed here, never typed
  balance_minor      bigint check (balance_minor is null or balance_minor > 0),
  narrative          text check (narrative is null or length(narrative) <= 1000),
  reminder_text      text check (reminder_text is null or length(reminder_text) <= 1500),
  agent_key          text not null check (agent_key = 'finance'),
  requested_by       uuid not null references core.users(id) on delete restrict,
  status             text not null default 'proposed' check (status = 'proposed'),
  created_at         timestamptz not null default clock_timestamp(),
  check (kind = 'payment_reminder' or (price_proposal_id is not null and jsonb_array_length(lines) >= 1 and total_minor is not null and reminder_text is null)),
  check (kind <> 'payment_reminder' or (reminder_text is not null and length(btrim(reminder_text)) > 0 and balance_minor is not null and price_proposal_id is null and jsonb_array_length(lines) = 0))
);

create table if not exists finance.maintenance_billing_decisions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  proposal_id       uuid not null unique references finance.maintenance_billing_proposals(id) on delete cascade,
  decision          text not null check (decision in ('accepted', 'rejected')),
  note              text,
  acted_invoice_id  uuid references finance.invoices(id) on delete restrict,
  decided_by        uuid not null references core.users(id) on delete restrict,
  decided_at        timestamptz not null default clock_timestamp(),
  check (decision = 'accepted' or length(btrim(coalesce(note, ''))) > 0)
);

-- which invoice bills which cycle of a plan. One invoice, one cycle; the same cycle is not billed twice (a duplicate event is the same link).
create table if not exists finance.maintenance_billing_links (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.maintenance_plans(id) on delete restrict,
  invoice_id       uuid not null unique references finance.invoices(id) on delete restrict,
  purpose          text not null check (purpose in ('activation', 'renewal')),
  cycle_start      date not null,
  cycle_end        date not null,
  linked_by        uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default clock_timestamp(),
  unique (plan_id, purpose, cycle_start),
  check (cycle_end > cycle_start)
);

-- an exception to the financial gate: a person's decision, owner-approved, never the requester, with an expiry
create table if not exists finance.maintenance_gate_exceptions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.maintenance_plans(id) on delete restrict,
  link_id          uuid not null references finance.maintenance_billing_links(id) on delete restrict,
  reason           text not null check (length(btrim(reason)) > 0),
  mitigation       text not null check (length(btrim(mitigation)) > 0),
  expires_at       timestamptz not null,
  status           text not null default 'requested' check (status in ('requested', 'approved')),
  requested_by     uuid not null references core.users(id) on delete restrict,
  approved_by      uuid references core.users(id) on delete restrict,
  approved_at      timestamptz,
  created_at       timestamptz not null default clock_timestamp(),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);

create or replace function finance.maintenance_history_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a % record is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end $$;

create or replace function finance.maintenance_gate_exceptions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a gate exception is audit history' using errcode = 'restrict_violation'; end if;
  if old.status = 'approved' then raise exception 'an approved gate exception is never edited' using errcode = 'restrict_violation'; end if;
  if new.status = 'approved' and coalesce(current_setting('finance.maintenance_sanctioned', true), '') <> 'on' then
    raise exception 'a gate exception is approved by the owner through its door' using errcode = 'restrict_violation';
  end if;
  if new.plan_id is distinct from old.plan_id or new.link_id is distinct from old.link_id or new.expires_at is distinct from old.expires_at or new.requested_by is distinct from old.requested_by then
    raise exception 'a requested gate exception is not edited: request a new one' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_gate_exceptions_guard on finance.maintenance_gate_exceptions;
create trigger maintenance_gate_exceptions_guard before update or delete on finance.maintenance_gate_exceptions for each row execute function finance.maintenance_gate_exceptions_guard();

do $$
declare r record;
begin
  for r in select * from (values
    ('maintenance_billing_requests', 'project_id', 'projects.projects'), ('maintenance_billing_requests', 'client_account_id', 'core.client_accounts'), ('maintenance_billing_requests', 'plan_id', 'projects.maintenance_plans'),
    ('maintenance_billing_requests', 'change_request_id', 'projects.change_requests'), ('maintenance_billing_requests', 'invoice_id', 'finance.invoices'),
    ('maintenance_billing_proposals', 'request_id', 'finance.maintenance_billing_requests'), ('maintenance_billing_proposals', 'project_id', 'projects.projects'), ('maintenance_billing_proposals', 'plan_id', 'projects.maintenance_plans'),
    ('maintenance_billing_proposals', 'change_request_id', 'projects.change_requests'), ('maintenance_billing_proposals', 'invoice_id', 'finance.invoices'), ('maintenance_billing_proposals', 'price_proposal_id', 'sales.proposals'),
    ('maintenance_billing_decisions', 'proposal_id', 'finance.maintenance_billing_proposals'), ('maintenance_billing_decisions', 'acted_invoice_id', 'finance.invoices'),
    ('maintenance_billing_links', 'plan_id', 'projects.maintenance_plans'), ('maintenance_billing_links', 'invoice_id', 'finance.invoices'),
    ('maintenance_gate_exceptions', 'plan_id', 'projects.maintenance_plans'), ('maintenance_gate_exceptions', 'link_id', 'finance.maintenance_billing_links')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on finance.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on finance.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['maintenance_billing_requests', 'maintenance_billing_proposals', 'maintenance_billing_decisions', 'maintenance_billing_links', 'maintenance_gate_exceptions']) as tbl loop
    execute format('alter table finance.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on finance.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on finance.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on finance.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on finance.%I from authenticated', r.tbl);
    execute format('grant select on finance.%I to authenticated', r.tbl);
    execute format('grant all on finance.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on finance.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on finance.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  for r in select unnest(array['maintenance_billing_requests', 'maintenance_billing_proposals', 'maintenance_billing_decisions', 'maintenance_billing_links']) as tbl loop
    execute format('drop trigger if exists %I on finance.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on finance.%I for each row execute function finance.maintenance_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

insert into core.event_types (type, description, canonical) values
  ('finance.maintenance_billing_proposed', 'The Finance agent drafted a maintenance, change-request or reminder proposal for a person to decide. It is a draft: no invoice or reminder was created.', true)
on conflict (type) do nothing;

-- ── a person asks the Finance agent to prepare a proposal (and cannot accept it) ──
create or replace function finance.request_maintenance_billing(p_kind text, p_plan_id uuid default null, p_change_request_id uuid default null, p_invoice_id uuid default null)
returns table (outcome text, request_id uuid, project_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_plan projects.maintenance_plans; v_cr projects.change_requests; v_inv finance.invoices; v_prop sales.proposals; v_project uuid; v_account uuid; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid, null::uuid; return; end if;
  if p_kind not in ('maintenance_invoice', 'change_request_invoice', 'payment_reminder') then return query select 'bad_kind'::text, null::uuid, null::uuid; return; end if;
  if (p_kind = 'maintenance_invoice') <> (p_plan_id is not null) or (p_kind = 'change_request_invoice') <> (p_change_request_id is not null) or (p_kind = 'payment_reminder') <> (p_invoice_id is not null) then
    return query select 'name_one_subject'::text, null::uuid, null::uuid; return;
  end if;
  if p_kind = 'maintenance_invoice' then
    select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org;
    if v_plan.id is null then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
    -- billing follows ACCEPTANCE: the client accepted an exact quoted proposal for this plan
    if v_plan.accepted_proposal_id is null or v_plan.accepted_at is null then return query select 'plan_not_accepted'::text, null::uuid, null::uuid; return; end if;
    if v_plan.status in ('cancelled', 'declined', 'expired') then return query select 'plan_ended'::text, null::uuid, null::uuid; return; end if;
    select * into v_prop from sales.proposals sp where sp.id = v_plan.accepted_proposal_id and sp.organization_id = v_org;
    if v_prop.id is null or v_prop.status <> 'accepted' then return query select 'quote_not_accepted'::text, null::uuid, null::uuid; return; end if;
    v_project := v_plan.project_id; v_account := v_plan.client_account_id;
  elsif p_kind = 'change_request_invoice' then
    select * into v_cr from projects.change_requests c where c.id = p_change_request_id and c.organization_id = v_org;
    if v_cr.id is null then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
    if v_cr.classification is distinct from 'paid_change' then return query select 'not_billable'::text, null::uuid, null::uuid; return; end if;
    if v_cr.status not in ('classified', 'pending_approval', 'approved') then return query select 'wrong_state'::text, null::uuid, null::uuid; return; end if;
    if v_cr.proposal_id is null then return query select 'no_proposal'::text, null::uuid, null::uuid; return; end if;
    select * into v_prop from sales.proposals sp where sp.id = v_cr.proposal_id and sp.organization_id = v_org;
    if v_prop.id is null or v_prop.status not in ('approved', 'sent', 'accepted') then return query select 'quote_not_approved'::text, null::uuid, null::uuid; return; end if;
    if v_cr.invoice_id is not null and exists (select 1 from finance.invoices i where i.id = v_cr.invoice_id and i.status <> 'void') then return query select 'already_invoiced'::text, null::uuid, null::uuid; return; end if;
    select p.client_account_id into v_account from projects.projects p where p.id = v_cr.project_id;
    v_project := v_cr.project_id;
  else
    select * into v_inv from finance.invoices i where i.id = p_invoice_id and i.organization_id = v_org;
    if v_inv.id is null then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
    if v_inv.status not in ('issued', 'partially_paid', 'overdue') then return query select 'invoice_not_collectible'::text, null::uuid, null::uuid; return; end if;
    -- reminders stop at VERIFIED full payment
    if finance.net_verified_minor(v_inv.id) >= v_inv.total_minor then return query select 'already_paid_in_full'::text, null::uuid, null::uuid; return; end if;
    if v_inv.project_id is null then return query select 'invoice_has_no_project'::text, null::uuid, null::uuid; return; end if;
    v_project := v_inv.project_id; v_account := v_inv.client_account_id;
  end if;
  insert into finance.maintenance_billing_requests (organization_id, project_id, client_account_id, kind, plan_id, change_request_id, invoice_id, requested_by)
  values (v_org, v_project, v_account, p_kind, p_plan_id, p_change_request_id, p_invoice_id, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_billing.requested', 'maintenance_billing_request', v_id, null, jsonb_build_object('kind', p_kind, 'planId', p_plan_id, 'changeRequestId', p_change_request_id, 'invoiceId', p_invoice_id));
  return query select 'requested'::text, v_id, v_project;
end $$;
revoke all on function finance.request_maintenance_billing(text, uuid, uuid, uuid) from public, anon;
grant execute on function finance.request_maintenance_billing(text, uuid, uuid, uuid) to authenticated;

-- ── the ONE door the agent writes through: it takes NO amount ──
create or replace function finance.record_maintenance_billing_proposal(p_request_id uuid, p_organization_id uuid, p_agent_key text, p_narrative text, p_reminder_text text default null)
returns table (outcome text, proposal_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_req finance.maintenance_billing_requests; v_plan projects.maintenance_plans; v_cr projects.change_requests; v_inv finance.invoices; v_prop sales.proposals;
  v_lines jsonb; v_text text; v_id uuid; v_balance bigint; v_price uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_req from finance.maintenance_billing_requests r where r.id = p_request_id;
  if v_req.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- the organization is the JOB's, never one a payload names
  if v_req.organization_id is distinct from p_organization_id then return query select 'wrong_organization'::text, null::uuid; return; end if;
  if p_agent_key is distinct from 'finance' then return query select 'wrong_agent'::text, null::uuid; return; end if;
  if exists (select 1 from finance.maintenance_billing_proposals p where p.request_id = v_req.id) then return query select 'already_proposed'::text, null::uuid; return; end if;
  v_text := coalesce(p_narrative, '') || E'\n' || coalesce(p_reminder_text, '');
  if length(coalesce(p_narrative, '')) > 1000 or length(coalesce(p_reminder_text, '')) > 1500 then return query select 'bad_input'::text, null::uuid; return; end if;
  if v_text ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-.]{12,}' or v_text ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})' then
    return query select 'secret_in_text'::text, null::uuid; return;
  end if;

  if v_req.kind = 'payment_reminder' then
    if length(btrim(coalesce(p_reminder_text, ''))) = 0 then return query select 'reminder_text_required'::text, null::uuid; return; end if;
    select * into v_inv from finance.invoices i where i.id = v_req.invoice_id and i.organization_id = p_organization_id;
    if v_inv.id is null then return query select 'not_found'::text, null::uuid; return; end if;
    -- the state NOW, not when it was requested
    if v_inv.status not in ('issued', 'partially_paid', 'overdue') then return query select 'invoice_not_collectible'::text, null::uuid; return; end if;
    v_balance := v_inv.total_minor - finance.net_verified_minor(v_inv.id);
    if v_balance <= 0 then return query select 'already_paid_in_full'::text, null::uuid; return; end if;
    -- the text names the invoice it is about: a reminder is linked to the correct invoice
    if position(v_inv.number in p_reminder_text) = 0 then return query select 'reminder_must_name_the_invoice'::text, null::uuid; return; end if;
    insert into finance.maintenance_billing_proposals (organization_id, request_id, project_id, client_account_id, kind, invoice_id, currency, balance_minor, narrative, reminder_text, agent_key, requested_by)
    values (p_organization_id, v_req.id, v_req.project_id, v_req.client_account_id, 'payment_reminder', v_inv.id, v_inv.currency, v_balance, nullif(btrim(coalesce(p_narrative, '')), ''), btrim(p_reminder_text), 'finance', v_req.requested_by)
    returning id into v_id;
  else
    if v_req.kind = 'maintenance_invoice' then
      select * into v_plan from projects.maintenance_plans m where m.id = v_req.plan_id and m.organization_id = p_organization_id;
      if v_plan.id is null or v_plan.accepted_proposal_id is null or v_plan.status in ('cancelled', 'declined', 'expired') then return query select 'plan_not_billable'::text, null::uuid; return; end if;
      v_price := v_plan.accepted_proposal_id;
    else
      select * into v_cr from projects.change_requests c where c.id = v_req.change_request_id and c.organization_id = p_organization_id;
      if v_cr.id is null or v_cr.classification is distinct from 'paid_change' or v_cr.proposal_id is null or v_cr.status not in ('classified', 'pending_approval', 'approved') then return query select 'change_request_not_billable'::text, null::uuid; return; end if;
      v_price := v_cr.proposal_id;
    end if;
    select * into v_prop from sales.proposals sp where sp.id = v_price and sp.organization_id = p_organization_id;
    if v_prop.id is null then return query select 'quote_not_found'::text, null::uuid; return; end if;
    -- the lines and the totals are COPIED from the human-quoted proposal; the agent had no say in a figure
    select coalesce(jsonb_agg(jsonb_build_object('description', pi.description, 'quantity', pi.quantity, 'unit_price_minor', pi.unit_price_minor, 'amount_minor', pi.amount_minor) order by pi.position), '[]'::jsonb)
      into v_lines from sales.proposal_items pi where pi.proposal_id = v_prop.id and pi.organization_id = p_organization_id;
    if jsonb_array_length(v_lines) = 0 then return query select 'quote_has_no_lines'::text, null::uuid; return; end if;
    insert into finance.maintenance_billing_proposals (organization_id, request_id, project_id, client_account_id, kind, plan_id, change_request_id, price_proposal_id, currency, subtotal_minor, tax_minor, total_minor, lines, narrative, agent_key, requested_by)
    values (p_organization_id, v_req.id, v_req.project_id, v_req.client_account_id, v_req.kind, v_req.plan_id, v_req.change_request_id, v_prop.id, v_prop.currency, v_prop.subtotal_minor, v_prop.tax_minor, v_prop.total_minor, v_lines, nullif(btrim(coalesce(p_narrative, '')), ''), 'finance', v_req.requested_by)
    returning id into v_id;
  end if;
  perform core.emit_event(p_organization_id, 'finance.maintenance_billing_proposed', 'maintenance_billing_proposal', v_id, jsonb_build_object('kind', v_req.kind, 'projectId', v_req.project_id));
  return query select 'proposed'::text, v_id;
end $$;
revoke all on function finance.record_maintenance_billing_proposal(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function finance.record_maintenance_billing_proposal(uuid, uuid, text, text, text) to service_role;

-- ── an INDEPENDENT Admin decides. Accepting creates nothing; the person uses the existing doors and may link the result. ──
create or replace function finance.decide_maintenance_billing_proposal(p_proposal_id uuid, p_decision text, p_note text default null, p_invoice_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p finance.maintenance_billing_proposals; v_inv finance.invoices; v_cr projects.change_requests;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('accepted', 'rejected') then return query select 'bad_decision'::text; return; end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_note, ''))) = 0 then return query select 'note_required'::text; return; end if;
  select * into v_p from finance.maintenance_billing_proposals x where x.id = p_proposal_id and x.organization_id = v_org for update;
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if exists (select 1 from finance.maintenance_billing_decisions d where d.proposal_id = v_p.id) then return query select 'already_decided'::text; return; end if;
  if v_p.requested_by = v_actor then return query select 'self_acceptance'::text; return; end if;
  if p_invoice_id is not null then
    if p_decision <> 'accepted' or v_p.kind = 'payment_reminder' then return query select 'no_invoice_to_link'::text; return; end if;
    select * into v_inv from finance.invoices i where i.id = p_invoice_id and i.organization_id = v_org;
    if v_inv.id is null or v_inv.client_account_id is distinct from v_p.client_account_id then return query select 'invoice_not_found'::text; return; end if;
    -- the invoice the person made carries the QUOTED total: a different amount is refused, never coerced
    if v_inv.total_minor is distinct from v_p.total_minor then return query select 'amount_differs_from_the_quoted_price'::text; return; end if;
    if v_p.kind = 'change_request_invoice' then
      select * into v_cr from projects.change_requests c where c.id = v_p.change_request_id;
      if v_cr.invoice_id is distinct from v_inv.id then return query select 'invoice_is_not_the_change_requests'::text; return; end if;
    end if;
  end if;
  insert into finance.maintenance_billing_decisions (organization_id, proposal_id, decision, note, acted_invoice_id, decided_by) values (v_org, v_p.id, p_decision, nullif(btrim(coalesce(p_note, '')), ''), p_invoice_id, v_actor);
  perform core.record_audit(v_org, 'maintenance_billing.proposal_' || p_decision, 'maintenance_billing_proposal', v_p.id, null, jsonb_build_object('kind', v_p.kind, 'invoiceId', p_invoice_id));
  return query select p_decision;
end $$;
revoke all on function finance.decide_maintenance_billing_proposal(uuid, text, text, uuid) from public, anon;
grant execute on function finance.decide_maintenance_billing_proposal(uuid, text, text, uuid) to authenticated;

-- ── the financial gate for a billed plan ──────────────────────────────────
create or replace function finance.maintenance_financial_gate(p_plan_id uuid)
returns table (state text, invoice_id uuid, link_id uuid, detail text)
language plpgsql stable security definer set search_path = '' as $$
declare v_plan projects.maintenance_plans; v_link finance.maintenance_billing_links; v_inv finance.invoices;
begin
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id;
  if v_plan.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role' and v_plan.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  select * into v_link from finance.maintenance_billing_links l where l.plan_id = p_plan_id order by l.created_at desc, l.id desc limit 1;
  if v_link.id is null then return query select 'not_billed'::text, null::uuid, null::uuid, 'the plan has no linked invoice: the financial gate does not apply'::text; return; end if;
  select * into v_inv from finance.invoices i where i.id = v_link.invoice_id;
  if v_inv.status = 'paid' and v_inv.total_minor > 0 and finance.net_verified_minor(v_inv.id) >= v_inv.total_minor then
    return query select 'verified_paid'::text, v_inv.id, v_link.id, 'the invoice is paid on verified money'::text; return;
  end if;
  if exists (select 1 from finance.maintenance_gate_exceptions e where e.link_id = v_link.id and e.status = 'approved' and e.expires_at > now()) then
    return query select 'exception_approved'::text, v_inv.id, v_link.id, 'an owner-approved, unexpired exception stands in for verified payment'::text; return;
  end if;
  if v_inv.status in ('draft', 'pending_approval', 'void') then
    return query select 'invoice_not_issued'::text, v_inv.id, v_link.id, 'the invoice is ' || v_inv.status::text; return;
  end if;
  return query select 'awaiting_payment_verification'::text, v_inv.id, v_link.id, 'the invoice is not paid on verified money (a screenshot or a message is a submission, not verification)'::text;
end $$;
revoke all on function finance.maintenance_financial_gate(uuid) from public, anon;
grant execute on function finance.maintenance_financial_gate(uuid) to authenticated, service_role;

create or replace function finance.link_maintenance_invoice(p_plan_id uuid, p_invoice_id uuid, p_purpose text, p_cycle_start date, p_cycle_end date)
returns table (outcome text, link_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.maintenance_plans; v_inv finance.invoices; v_existing finance.maintenance_billing_links; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_purpose not in ('activation', 'renewal') then return query select 'bad_purpose'::text, null::uuid; return; end if;
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
  insert into finance.maintenance_billing_links (organization_id, plan_id, invoice_id, purpose, cycle_start, cycle_end, linked_by) values (v_org, p_plan_id, p_invoice_id, p_purpose, p_cycle_start, p_cycle_end, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_billing.linked', 'maintenance_billing_link', v_id, null, jsonb_build_object('planId', p_plan_id, 'invoiceId', p_invoice_id, 'purpose', p_purpose, 'cycleStart', p_cycle_start, 'cycleEnd', p_cycle_end));
  return query select 'linked'::text, v_id;
end $$;
revoke all on function finance.link_maintenance_invoice(uuid, uuid, text, date, date) from public, anon;
grant execute on function finance.link_maintenance_invoice(uuid, uuid, text, date, date) to authenticated;

create or replace function finance.request_maintenance_gate_exception(p_plan_id uuid, p_reason text, p_mitigation text, p_expires_at timestamptz)
returns table (outcome text, exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_link finance.maintenance_billing_links; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 or length(btrim(coalesce(p_mitigation, ''))) = 0 then return query select 'incomplete_request'::text, null::uuid; return; end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '90 days' then return query select 'expiry_required_within_90_days'::text, null::uuid; return; end if;
  select * into v_link from finance.maintenance_billing_links l where l.plan_id = p_plan_id and l.organization_id = v_org order by l.created_at desc, l.id desc limit 1;
  if v_link.id is null then return query select 'plan_has_no_billing'::text, null::uuid; return; end if;
  insert into finance.maintenance_gate_exceptions (organization_id, plan_id, link_id, reason, mitigation, expires_at, requested_by) values (v_org, p_plan_id, v_link.id, btrim(p_reason), btrim(p_mitigation), p_expires_at, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_gate_exception.requested', 'maintenance_gate_exception', v_id, null, jsonb_build_object('planId', p_plan_id, 'expiresAt', p_expires_at));
  return query select 'requested'::text, v_id;
end $$;
revoke all on function finance.request_maintenance_gate_exception(uuid, text, text, timestamptz) from public, anon;
grant execute on function finance.request_maintenance_gate_exception(uuid, text, text, timestamptz) to authenticated;

create or replace function finance.approve_maintenance_gate_exception(p_exception_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_e finance.maintenance_gate_exceptions;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- no silent exception: only a signed-in OWNER approves one, and never the person who asked for it
  if not coalesce((select core.is_owner()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_e from finance.maintenance_gate_exceptions e where e.id = p_exception_id and e.organization_id = v_org for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_e.status = 'approved' then return query select 'already_approved'::text; return; end if;
  if v_e.requested_by = v_actor then return query select 'requester_cannot_approve'::text; return; end if;
  if v_e.expires_at <= now() then return query select 'expired'::text; return; end if;
  perform set_config('finance.maintenance_sanctioned', 'on', true);
  update finance.maintenance_gate_exceptions set status = 'approved', approved_by = v_actor, approved_at = now() where id = v_e.id;
  perform core.record_audit(v_org, 'maintenance_gate_exception.approved', 'maintenance_gate_exception', v_e.id, null, jsonb_build_object('planId', v_e.plan_id, 'expiresAt', v_e.expires_at));
  return query select 'approved'::text;
end $$;
revoke all on function finance.approve_maintenance_gate_exception(uuid) from public, anon;
grant execute on function finance.approve_maintenance_gate_exception(uuid) to authenticated;

-- a BILLED plan is not activated or renewed before its invoice is paid on verified money (or an approved exception). Unbilled plans are untouched.
create or replace function projects.maintenance_plan_financial_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_gate record;
begin
  if new.status in ('active', 'renewed') and new.status is distinct from old.status then
    select * into v_gate from finance.maintenance_financial_gate(new.id);
    if v_gate.state is not null and v_gate.state not in ('not_billed', 'verified_paid', 'exception_approved') then
      raise exception 'a billed maintenance plan does not become % until its invoice is paid on verified money or an approved exception exists (now: %)', new.status, v_gate.state using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists maintenance_plan_financial_gate on projects.maintenance_plans;
create trigger maintenance_plan_financial_gate before update of status on projects.maintenance_plans for each row execute function projects.maintenance_plan_financial_gate();

notify pgrst, 'reload schema';
