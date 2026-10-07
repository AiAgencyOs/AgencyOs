-- ═════════════════════════════════════════════════════════════════
-- Phase 8A: upsell / repeat-business opportunities and the post-launch Sales handoff.
--
-- THE RULE: an agent never quotes, prices or discounts, and never decides that a client is a prospect.
--   * the table has no amount, price, quote or discount column; a text field or an evidence key that names one is refused (trigger, so a direct write fails too)
--   * an agent (upsell / customer_success) can only RECORD an opportunity as 'detected' (or 'suppressed'); a PERSON qualifies it, a person hands it to Sales
--   * the handoff reuses sales.open_renewal, which opens the CRM opportunity in discovery with value 0. From there the quotation, proposal and discount
--     doors that already exist (sales.draft_proposal, sales.set_proposal_pricing, sales.record_discount_decision; migration 20261030100000) are the only way
--     a number reaches a client, and they already refuse an agent-decided discount. Nothing in this file writes sales.proposals or a discount decision.
--   * evidence is required and must be a record of THIS project (a ticket the person classified as out of scope, a check-in, an upsell signal). A request that
--     is already covered by warranty, maintenance or the approved scope is refused as 'already_included': it is an obligation, not an opportunity.
--   * while the account is at_risk/critical, has a recovery plan open or has an unresolved P1/P2 issue, a new opportunity is recorded SUPPRESSED, and qualify /
--     handoff refuse until the service issue is resolved: recovery first.
--   * the completed project is never edited: this file only reads projects.projects. An accepted expansion is a separate change request or a separate project.
-- ═════════════════════════════════════════════════════════════════

create table if not exists sales.phase_eight_opportunities (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  client_account_id     uuid not null references core.client_accounts(id) on delete restrict,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  kind                  text not null check (kind in ('change_request', 'new_project')),
  need                  text not null check (length(btrim(need)) between 10 and 2000),
  requested_outcome     text check (requested_outcome is null or length(requested_outcome) <= 2000),
  urgency               text not null default 'normal' check (urgency in ('low', 'normal', 'high')),
  stakeholders          text check (stakeholders is null or length(stakeholders) <= 1000),
  constraints           text check (constraints is null or length(constraints) <= 2000),
  existing_plan_id      uuid references projects.maintenance_plans(id) on delete set null,
  evidence              jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) >= 1),
  dedupe_key            text not null,
  status                text not null default 'detected' check (status in ('detected', 'qualified', 'suppressed', 'handed_off', 'accepted', 'lost', 'closed_no_action')),
  detected_by_agent     text,
  created_by            uuid references core.users(id) on delete set null,
  qualified_by          uuid references core.users(id) on delete set null,
  qualified_at          timestamptz,
  qualification_note    text,
  suppressed_reason     text,
  sales_opportunity_id  uuid references sales.opportunities(id) on delete set null,
  handed_off_by         uuid references core.users(id) on delete set null,
  handed_off_at         timestamptz,
  outcome_reason        text,
  change_request_id     uuid references projects.change_requests(id) on delete set null,
  new_project_id        uuid references projects.projects(id) on delete set null,
  closed_by             uuid references core.users(id) on delete set null,
  closed_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (organization_id, project_id, dedupe_key),
  constraint p8_opp_has_an_author check (detected_by_agent is not null or created_by is not null),
  constraint p8_opp_qualified_by_a_person check (status not in ('qualified', 'handed_off', 'accepted') or (qualified_by is not null and qualified_at is not null)),
  constraint p8_opp_suppressed_says_why check (status <> 'suppressed' or length(btrim(coalesce(suppressed_reason, ''))) > 0),
  constraint p8_opp_handed_off_names_the_crm_deal check (status not in ('handed_off', 'accepted') or (sales_opportunity_id is not null and handed_off_by is not null and handed_off_at is not null)),
  constraint p8_opp_accepted_names_what_it_became check (status <> 'accepted' or (num_nonnulls(change_request_id, new_project_id) = 1)),
  constraint p8_opp_closed_says_why check (status not in ('lost', 'closed_no_action') or (length(btrim(coalesce(outcome_reason, ''))) >= 5 and closed_by is not null and closed_at is not null))
);
create index if not exists p8_opp_open_idx on sales.phase_eight_opportunities (organization_id, project_id, status) where status in ('detected', 'qualified', 'suppressed', 'handed_off');
comment on table sales.phase_eight_opportunities is
  'A post-launch expansion opportunity with its evidence (Phase 8A). NO PRICE, AMOUNT, QUOTE OR DISCOUNT COLUMN, and a text field or evidence key naming one is refused by trigger. An agent records it detected/suppressed; a person qualifies and hands it to Sales (sales.open_renewal). Quotes and discounts stay in the existing quotation doors.';

create or replace function sales.p8_opportunity_no_price()
returns trigger language plpgsql set search_path = '' as $$
declare v_re constant text := '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off';
begin
  if new.need ~* v_re or coalesce(new.requested_outcome, '') ~* v_re or coalesce(new.constraints, '') ~* v_re or coalesce(new.stakeholders, '') ~* v_re then
    raise exception 'an opportunity names no price, quote or discount: that is quoted by a person in the quotation doors' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(new.evidence) e where jsonb_typeof(e) <> 'object') then
    raise exception 'opportunity evidence is a list of records, each an object' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(new.evidence) e, jsonb_object_keys(e) k where k ~* '^(price|amount|discount|quote|quotation|total|cost|fee|value|rate)$')
     or exists (select 1 from jsonb_array_elements(new.evidence) e, jsonb_each_text(e) kv where kv.value ~* v_re) then
    raise exception 'opportunity evidence carries no price, amount, quote or discount' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists p8_opportunity_no_price on sales.phase_eight_opportunities;
create trigger p8_opportunity_no_price before insert or update on sales.phase_eight_opportunities for each row execute function sales.p8_opportunity_no_price();

-- the ticket may now name the opportunity it became
alter table projects.support_tickets drop constraint if exists support_tickets_opportunity_fk;
alter table projects.support_tickets add constraint support_tickets_opportunity_fk foreign key (opportunity_id) references sales.phase_eight_opportunities(id) on delete set null;

do $$
begin
  perform projects.p8_wire_parent('sales', 'phase_eight_opportunities', 'client_account_id', 'core.client_accounts');
  perform projects.p8_wire_parent('sales', 'phase_eight_opportunities', 'project_id', 'projects.projects');
  perform projects.p8_wire_parent('sales', 'phase_eight_opportunities', 'existing_plan_id', 'projects.maintenance_plans');
  perform projects.p8_wire_parent('sales', 'phase_eight_opportunities', 'sales_opportunity_id', 'sales.opportunities');
  perform projects.p8_wire_parent('sales', 'phase_eight_opportunities', 'change_request_id', 'projects.change_requests');
  perform projects.p8_wire_parent('sales', 'phase_eight_opportunities', 'new_project_id', 'projects.projects');
  perform projects.p8_wire_parent('projects', 'support_tickets', 'opportunity_id', 'sales.phase_eight_opportunities');
  perform projects.p8_wire_table('sales', 'phase_eight_opportunities', true, false);
end $$;

insert into core.event_types (type, description, canonical) values
  ('sales.upsell_opportunity_created', 'A post-launch expansion opportunity was recorded with evidence (by an agent as detected, or by a person). Carries the project, opportunity and status; nothing about price.', true),
  ('sales.opportunity_suppressed_for_recovery', 'A post-launch opportunity was recorded suppressed because the account needs service recovery first.', true),
  ('sales.phase_eight_handoff_created', 'A person handed a qualified post-launch opportunity to Sales: a CRM opportunity was opened in discovery with no value.', true)
on conflict (type) do nothing;

-- recovery first: the one place the rule lives (qualify and handoff re-ask it)
create or replace function sales.p8_commercial_hold(p_project_id uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare v_status text; v_reasons text[] := '{}'; v_urgent int; v_plan int;
begin
  select h.status into v_status from projects.customer_health_status(p_project_id) h;
  select count(*) into v_urgent from projects.support_tickets t where t.project_id = p_project_id and t.status not in ('closed', 'cancelled') and t.priority in ('p1', 'p2');
  select count(*) into v_plan from projects.recovery_plans rp where rp.project_id = p_project_id and rp.status in ('open', 'in_progress');
  if v_status in ('at_risk', 'critical') then v_reasons := array_append(v_reasons, 'health is ' || v_status); end if;
  if v_urgent > 0 then v_reasons := array_append(v_reasons, v_urgent || ' unresolved P1/P2 ticket(s)'); end if;
  if v_plan > 0 then v_reasons := array_append(v_reasons, 'a recovery plan is open'); end if;
  return v_reasons;
end $$;
revoke all on function sales.p8_commercial_hold(uuid) from public, anon, authenticated, service_role;

create or replace function sales.record_phase_eight_opportunity(
  p_project_id uuid, p_kind text, p_need text, p_evidence jsonb, p_requested_outcome text default null, p_urgency text default 'normal', p_stakeholders text default null,
  p_constraints text default null, p_agent_key text default null, p_organization_id uuid default null)
returns table (outcome text, opportunity_id uuid, opportunity_status text)
language plpgsql security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_actor uuid := (select auth.uid()); v_org uuid; v_p projects.projects; v_w projects.phase_eight;
  e jsonb; v_type text; v_id uuid; v_row record; v_keys text[] := '{}'; v_key text; v_hold text[]; v_status text; v_new uuid; v_need text := nullif(btrim(coalesce(p_need, '')), '');
  v_plan uuid; v_re constant text := '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off';
begin
  if v_service then
    v_org := p_organization_id;
    if p_agent_key not in ('upsell', 'customer_success') then return query select 'not_an_opportunity_agent'::text, null::uuid, null::text; return; end if;
  else
    if v_actor is null or not coalesce((select core.is_internal()), false) or not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid, null::text; return; end if;
    if p_agent_key is not null then return query select 'agent_key_is_for_the_runner'::text, null::uuid, null::text; return; end if;
    v_org := (select core.current_organization_id());
    if p_organization_id is not null and p_organization_id is distinct from v_org then return query select 'not_authorized'::text, null::uuid, null::text; return; end if;
  end if;
  if v_org is null then return query select 'no_actor'::text, null::uuid, null::text; return; end if;
  if p_kind not in ('change_request', 'new_project') then return query select 'bad_kind'::text, null::uuid, null::text; return; end if;
  if p_urgency not in ('low', 'normal', 'high') then return query select 'bad_urgency'::text, null::uuid, null::text; return; end if;
  if v_need is null or length(v_need) < 10 then return query select 'need_required'::text, null::uuid, null::text; return; end if;
  if v_need ~* v_re or coalesce(p_requested_outcome, '') ~* v_re or coalesce(p_constraints, '') ~* v_re or coalesce(p_stakeholders, '') ~* v_re then return query select 'no_price_here'::text, null::uuid, null::text; return; end if;
  if p_evidence is null or jsonb_typeof(p_evidence) <> 'array' or jsonb_array_length(p_evidence) = 0 then return query select 'evidence_required'::text, null::uuid, null::text; return; end if;
  select * into v_p from projects.projects pr where pr.id = p_project_id and pr.organization_id = v_org and pr.deleted_at is null;
  if v_p.id is null then return query select 'not_found'::text, null::uuid, null::text; return; end if;
  select * into v_w from projects.phase_eight w where w.project_id = p_project_id;
  if v_w.id is null then return query select 'no_phase_eight'::text, null::uuid, null::text; return; end if;

  for e in select * from jsonb_array_elements(p_evidence) loop
    if jsonb_typeof(e) <> 'object' or (e ->> 'type') is null or (e ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return query select 'bad_evidence'::text, null::uuid, null::text; return; end if;
    if exists (select 1 from jsonb_object_keys(e) k where k ~* '^(price|amount|discount|quote|quotation|total|cost|fee|value|rate)$') or exists (select 1 from jsonb_each_text(e) kv where kv.value ~* v_re) then
      return query select 'no_price_here'::text, null::uuid, null::text; return;
    end if;
    v_type := e ->> 'type'; v_id := (e ->> 'id')::uuid;
    if v_type = 'ticket' then
      select t.classification, t.coverage_decision into v_row from projects.support_tickets t where t.id = v_id and t.organization_id = v_org and t.project_id = p_project_id;
      if not found then return query select 'evidence_not_found'::text, null::uuid, null::text; return; end if;
      if v_row.classification is null then return query select 'evidence_not_classified'::text, null::uuid, null::text; return; end if;
      if v_row.classification not in ('change_request', 'new_project') then return query select 'already_included'::text, null::uuid, null::text; return; end if;
    elsif v_type = 'check_in' then
      if not exists (select 1 from projects.cs_check_ins c where c.id = v_id and c.organization_id = v_org and c.project_id = p_project_id and c.status = 'completed') then return query select 'evidence_not_found'::text, null::uuid, null::text; return; end if;
    elsif v_type = 'upsell_signal' then
      if not exists (select 1 from sales.upsell_signals s where s.id = v_id and s.organization_id = v_org and s.project_id = p_project_id) then return query select 'evidence_not_found'::text, null::uuid, null::text; return; end if;
    else return query select 'bad_evidence'::text, null::uuid, null::text; return;
    end if;
    v_keys := array_append(v_keys, v_type || ':' || v_id::text);
  end loop;
  select array_agg(k order by k) into v_keys from unnest(v_keys) k;
  v_key := md5(p_kind || '|' || array_to_string(v_keys, ','));
  -- a retried event or a repeated run is the same opportunity
  select o.id, o.status into v_new, v_status from sales.phase_eight_opportunities o where o.organization_id = v_org and o.project_id = p_project_id and o.dedupe_key = v_key;
  if v_new is not null then return query select 'duplicate'::text, v_new, v_status; return; end if;

  select pl.id into v_plan from projects.maintenance_plans pl where pl.project_id = p_project_id and pl.status in ('active', 'renewed', 'renewal_approaching', 'renewal_proposed', 'pending_client') order by pl.starts_on desc nulls last limit 1;
  v_hold := sales.p8_commercial_hold(p_project_id);
  v_status := case when cardinality(v_hold) > 0 then 'suppressed' else 'detected' end;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into sales.phase_eight_opportunities (organization_id, client_account_id, project_id, kind, need, requested_outcome, urgency, stakeholders, constraints, existing_plan_id, evidence, dedupe_key, status,
                                               detected_by_agent, created_by, suppressed_reason)
  values (v_org, v_p.client_account_id, p_project_id, p_kind, left(v_need, 2000), p_requested_outcome, p_urgency, p_stakeholders, p_constraints, v_plan, p_evidence, v_key, v_status,
          p_agent_key, v_actor, case when v_status = 'suppressed' then 'recovery first: ' || array_to_string(v_hold, '; ') end)
  returning id into v_new;
  perform core.record_audit(v_org, 'opportunity.p8_recorded', 'phase_eight_opportunity', v_new, null, jsonb_build_object('projectId', p_project_id, 'kind', p_kind, 'status', v_status, 'agent', p_agent_key));
  perform core.emit_event(v_org, 'sales.upsell_opportunity_created', 'phase_eight_opportunity', v_new, jsonb_build_object('projectId', p_project_id, 'opportunityId', v_new, 'status', v_status));
  if v_status = 'suppressed' then
    perform core.emit_event(v_org, 'sales.opportunity_suppressed_for_recovery', 'phase_eight_opportunity', v_new, jsonb_build_object('projectId', p_project_id, 'opportunityId', v_new));
  end if;
  return query select 'recorded'::text, v_new, v_status;
end $$;
revoke all on function sales.record_phase_eight_opportunity(uuid, text, text, jsonb, text, text, text, text, text, uuid) from public, anon;
grant execute on function sales.record_phase_eight_opportunity(uuid, text, text, jsonb, text, text, text, text, text, uuid) to authenticated, service_role;

create or replace function sales.qualify_phase_eight_opportunity(p_opportunity_id uuid, p_decision text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_o sales.phase_eight_opportunities; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_hold text[]; v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('qualify', 'close_no_action') then return query select 'bad_decision'::text; return; end if;
  if v_note is null or length(v_note) < 5 then return query select 'note_required'::text; return; end if;
  select * into v_o from sales.phase_eight_opportunities o where o.id = p_opportunity_id and o.organization_id = v_org for update;
  if v_o.id is null then return query select 'not_found'::text; return; end if;
  if v_o.status not in ('detected', 'suppressed') then return query select 'wrong_state'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  if p_decision = 'close_no_action' then
    update sales.phase_eight_opportunities set status = 'closed_no_action', outcome_reason = left(v_note, 1000), closed_by = v_actor, closed_at = v_now where id = v_o.id;
    return query select 'closed'::text; return;
  end if;
  v_hold := sales.p8_commercial_hold(v_o.project_id);
  if cardinality(v_hold) > 0 then return query select 'recovery_first'::text; return; end if;
  update sales.phase_eight_opportunities set status = 'qualified', qualified_by = v_actor, qualified_at = v_now, qualification_note = left(v_note, 1000), suppressed_reason = null where id = v_o.id;
  perform core.record_audit(v_org, 'opportunity.p8_qualified', 'phase_eight_opportunity', v_o.id, jsonb_build_object('status', v_o.status), jsonb_build_object('status', 'qualified'));
  return query select 'qualified'::text;
end $$;
revoke all on function sales.qualify_phase_eight_opportunity(uuid, text, text) from public, anon, service_role;
grant execute on function sales.qualify_phase_eight_opportunity(uuid, text, text) to authenticated;

create or replace function sales.hand_off_phase_eight_opportunity(p_opportunity_id uuid)
returns table (outcome text, sales_opportunity_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_o sales.phase_eight_opportunities; v_hold text[]; v_open record;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_o from sales.phase_eight_opportunities o where o.id = p_opportunity_id and o.organization_id = v_org for update;
  if v_o.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_o.status = 'handed_off' then return query select 'already_handed_off'::text, v_o.sales_opportunity_id; return; end if;
  if v_o.status <> 'qualified' then return query select 'not_qualified'::text, null::uuid; return; end if;
  v_hold := sales.p8_commercial_hold(v_o.project_id);
  if cardinality(v_hold) > 0 then return query select 'recovery_first'::text, null::uuid; return; end if;
  -- the existing door: a CRM opportunity in discovery with value 0. The price is a person's, in the quotation doors, from here.
  select * into v_open from sales.open_renewal(v_o.client_account_id, v_o.project_id, 'upsell', left('Expansion (' || replace(v_o.kind, '_', ' ') || '): ' || v_o.need, 200), 0);
  if v_open.outcome <> 'opened' then return query select v_open.outcome, null::uuid; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update sales.phase_eight_opportunities set status = 'handed_off', sales_opportunity_id = v_open.opportunity_id, handed_off_by = v_actor, handed_off_at = clock_timestamp() where id = v_o.id;
  perform core.record_audit(v_org, 'opportunity.p8_handed_off', 'phase_eight_opportunity', v_o.id, null, jsonb_build_object('salesOpportunityId', v_open.opportunity_id));
  perform core.emit_event(v_org, 'sales.phase_eight_handoff_created', 'phase_eight_opportunity', v_o.id, jsonb_build_object('projectId', v_o.project_id, 'opportunityId', v_o.id, 'salesOpportunityId', v_open.opportunity_id));
  return query select 'handed_off'::text, v_open.opportunity_id;
end $$;
revoke all on function sales.hand_off_phase_eight_opportunity(uuid) from public, anon, service_role;
grant execute on function sales.hand_off_phase_eight_opportunity(uuid) to authenticated;

create or replace function sales.close_phase_eight_opportunity(p_opportunity_id uuid, p_outcome text, p_reason text, p_change_request_id uuid default null, p_new_project_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_o sales.phase_eight_opportunities; v_r text := nullif(btrim(coalesce(p_reason, '')), ''); v_now timestamptz := clock_timestamp();
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_outcome not in ('accepted', 'lost', 'closed_no_action') then return query select 'bad_outcome'::text; return; end if;
  select * into v_o from sales.phase_eight_opportunities o where o.id = p_opportunity_id and o.organization_id = v_org for update;
  if v_o.id is null then return query select 'not_found'::text; return; end if;
  if v_o.status in ('accepted', 'lost', 'closed_no_action') then return query select 'closed'::text; return; end if;
  if p_outcome = 'accepted' then
    if v_o.status <> 'handed_off' then return query select 'not_handed_off'::text; return; end if;
    if num_nonnulls(p_change_request_id, p_new_project_id) <> 1 then return query select 'name_what_it_became'::text; return; end if;
    if p_change_request_id is not null and not exists (select 1 from projects.change_requests c where c.id = p_change_request_id and c.organization_id = v_org and c.project_id = v_o.project_id) then return query select 'wrong_project'::text; return; end if;
    -- a new project is a different project of the same client, never the completed one
    if p_new_project_id is not null and (p_new_project_id = v_o.project_id or not exists (select 1 from projects.projects pr where pr.id = p_new_project_id and pr.organization_id = v_org and pr.client_account_id = v_o.client_account_id)) then return query select 'wrong_project'::text; return; end if;
    perform set_config('projects.p8_sanctioned', 'on', true);
    update sales.phase_eight_opportunities set status = 'accepted', change_request_id = p_change_request_id, new_project_id = p_new_project_id, outcome_reason = left(v_r, 1000), closed_by = v_actor, closed_at = v_now where id = v_o.id;
  else
    if v_r is null or length(v_r) < 5 then return query select 'reason_required'::text; return; end if;
    if p_outcome = 'lost' and v_o.status <> 'handed_off' then return query select 'not_handed_off'::text; return; end if;
    perform set_config('projects.p8_sanctioned', 'on', true);
    update sales.phase_eight_opportunities set status = p_outcome, outcome_reason = left(v_r, 1000), closed_by = v_actor, closed_at = v_now where id = v_o.id;
  end if;
  perform core.record_audit(v_org, 'opportunity.p8_closed', 'phase_eight_opportunity', v_o.id, jsonb_build_object('status', v_o.status), jsonb_build_object('status', p_outcome));
  return query select p_outcome;
end $$;
revoke all on function sales.close_phase_eight_opportunity(uuid, text, text, uuid, uuid) from public, anon, service_role;
grant execute on function sales.close_phase_eight_opportunity(uuid, text, text, uuid, uuid) to authenticated;

-- the Admin's account overview (it reads the opportunities, so it lives here, after them): one row per live Phase 8 project, health DERIVED on read
create or replace function projects.customer_success_overview(p_now timestamptz default clock_timestamp())
returns table (project_id uuid, project_name text, client_name text, workspace_state text, warranty_ends_on date, health_status text, open_tickets int, sla_breached int, open_recovery_plans int, due_check_ins int,
               renewals_in_flight int, open_opportunities int)
language sql stable security invoker set search_path = '' as $$
  select w.project_id, p.name, ca.name, w.state, w.warranty_ends_on,
         (select h.status from projects.customer_health_status(w.project_id, p_now) h),
         (select count(*)::int from projects.support_tickets t where t.project_id = w.project_id and t.status not in ('closed', 'cancelled')),
         (select count(*)::int from projects.support_tickets t where t.project_id = w.project_id and t.status not in ('closed', 'cancelled') and (t.response_breached_at is not null or t.resolution_breached_at is not null)),
         (select count(*)::int from projects.recovery_plans r where r.project_id = w.project_id and r.status in ('open', 'in_progress')),
         (select count(*)::int from projects.cs_check_ins c where c.project_id = w.project_id and c.status = 'due' and c.due_on <= (p_now at time zone 'UTC')::date),
         (select count(*)::int from projects.maintenance_plans m where m.project_id = w.project_id and m.status in ('renewal_approaching', 'renewal_proposed', 'pending_client')),
         (select count(*)::int from sales.phase_eight_opportunities o where o.project_id = w.project_id and o.status in ('detected', 'qualified', 'suppressed', 'handed_off'))
    from projects.phase_eight w
    join projects.projects p on p.id = w.project_id
    join core.client_accounts ca on ca.id = w.client_account_id
   where w.state <> 'closed'
   order by case (select h.status from projects.customer_health_status(w.project_id, p_now) h) when 'critical' then 0 when 'at_risk' then 1 when 'watch' then 2 when 'stable' then 3 else 4 end, p.name
   limit 500;
$$;
revoke all on function projects.customer_success_overview(timestamptz) from public, anon;
grant execute on function projects.customer_success_overview(timestamptz) to authenticated, service_role;

-- the shared DDL helpers were only for the four Phase 8A migrations
drop function if exists projects.p8_wire_table(text, text, boolean, boolean);
drop function if exists projects.p8_wire_parent(text, text, text, text);

notify pgrst, 'reload schema';
