-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Quotation Master, round 4 (traceability: docs/phase-1-orchestrator-quotation-round4-log.md).
-- Rows: P1-QUOTE-014 / P1-QUOTE-070 (per-line discount and catalogue reference), P1-QUOTE-069 (Delivered / Viewed events and a delivery record),
--       P1-QUOTE-036 (a direct quotation column on invoices), P1-QUOTE-057 (the timeline objection is recalculated).
--
--   * LINE PRICING. A quote line can carry its own discount (taken off the line's amount, so every total stays arithmetic) and say where its price came from
--     (source kind and a catalogue / reference key). Written only by a SIGNED-IN ADMINISTRATOR through sales.p1r_set_line_pricing, on a draft, with a reason for any
--     discount: an agent never discounts a line. The negotiation limit (max discount) now counts the line discounts too, or a discount could be hidden in a
--     line. There is no catalogue table in this codebase and none is invented: the reference is a key a person types, kept with the line.
--   * DELIVERED / VIEWED. The wire receipts the WhatsApp provider already sends for the message that carried a quotation (crm.record_delivery_receipt stamps the
--     message) now also stamp a delivery record per quotation and emit proposal.delivered, proposal.viewed and proposal.delivery_failed, once each.
--   * INVOICES. finance.invoices gains proposal_id: stamped when the invoice is created from the project's quotation, immutable once set, and back-filled for the
--     invoices that already exist. The trace no longer has to go through the project.
--   * TIMELINE OBJECTION. A client who objects to the timeline gets a recalculation recorded for the owner: does the asked time fit the estimate, only at its short
--     end, or not at all, and the options. It changes no price and no quote; any faster-delivery cost is the owner's decision and is not guessed.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('proposal.delivered', 'The provider reported the message that carried a quotation as delivered to the client''s phone. Fired once per quotation.', true),
  ('proposal.viewed', 'The provider reported the message that carried a quotation as read by the client. Fired once per quotation. Read receipts are the client''s setting and may never arrive.', true),
  ('proposal.delivery_failed', 'The provider reported that the message that carried a quotation failed on the wire. A person should resend it.', true)
on conflict (type) do nothing;

-- ── line pricing ───────────────────────────────────────────────────────────
alter table sales.proposal_items
  add column if not exists line_discount_minor bigint not null default 0,
  add column if not exists source_kind text,
  add column if not exists catalogue_ref text,
  add column if not exists line_discount_reason text;
alter table sales.proposal_items drop constraint if exists p1r_line_pricing_shape;
alter table sales.proposal_items add constraint p1r_line_pricing_shape check (
  line_discount_minor >= 0
  and (source_kind is null or source_kind in ('manual', 'pricing_reference', 'approved_offer', 'catalogue', 'plan_slot'))
  and (catalogue_ref is null or length(btrim(catalogue_ref)) between 1 and 200)
  and (line_discount_reason is null or length(btrim(line_discount_reason)) between 1 and 500)
  and (line_discount_minor = 0 or line_discount_reason is not null)
);
comment on column sales.proposal_items.line_discount_minor is 'P1-QUOTE-014. A discount on this line alone, taken off its amount. Set only by sales.p1r_set_line_pricing (a person, on a draft, with a reason).';
comment on column sales.proposal_items.catalogue_ref is 'P1-QUOTE-070. Where this line''s price came from, as a key a person recorded (a price-list entry, an approved offer, a plan slot). No catalogue table exists; none is invented.';

-- amount = quantity x unit price, less the line's own discount; the discount can never exceed the gross
create or replace function sales.proposal_item_amount()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_gross bigint;
begin
  -- round() and not trunc(): a quantity of 1.5 at a unit price of 333 is 500 rather than 499, which is what an invoice for the same line would say.
  v_gross := round(new.quantity * new.unit_price_minor);
  if coalesce(new.line_discount_minor, 0) > v_gross then
    raise exception 'a line discount (%) cannot exceed the line itself (%)', new.line_discount_minor, v_gross using errcode = 'check_violation';
  end if;
  new.amount_minor := v_gross - coalesce(new.line_discount_minor, 0);
  return new;
end;
$$;

create or replace function sales.p1r_line_discount_total(p_proposal_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from sales.proposals p where p.id = p_proposal_id;
  if v_org is null then return 0; end if;
  if (select auth.uid()) is not null and v_org is distinct from (select core.current_organization_id()) then return 0; end if;
  return coalesce((select sum(i.line_discount_minor) from sales.proposal_items i where i.proposal_id = p_proposal_id and i.organization_id = v_org), 0)::bigint;
end $$;

-- A person sets what one line's price rested on and any discount on that line alone.
create or replace function sales.p1r_set_line_pricing(p_item_id uuid, p_discount_minor bigint, p_source_kind text, p_catalogue_ref text, p_reason text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_i sales.proposal_items;
  v_p sales.proposals;
  v_refusal text;
  v_ref text := nullif(btrim(coalesce(p_catalogue_ref, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select i.* into v_i from sales.proposal_items i where i.id = p_item_id for update;
  if v_i.id is null then return query select 'unknown_line'::text; return; end if;
  if (select auth.uid()) is null then return query select 'person_required'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_i.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  select p.* into v_p from sales.proposals p where p.id = v_i.proposal_id;
  if v_p.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  if p_discount_minor is null or p_discount_minor < 0 then return query select 'bad_discount'::text; return; end if;
  if p_source_kind is not null and p_source_kind not in ('manual', 'pricing_reference', 'approved_offer', 'catalogue', 'plan_slot') then return query select 'bad_source'::text; return; end if;
  if p_discount_minor > 0 and v_reason is null then return query select 'missing_reason'::text; return; end if;
  if p_discount_minor > round(v_i.quantity * v_i.unit_price_minor) then return query select 'discount_exceeds_line'::text; return; end if;
  begin
    update sales.proposal_items
       set line_discount_minor = p_discount_minor, source_kind = p_source_kind, catalogue_ref = v_ref,
           line_discount_reason = case when p_discount_minor > 0 then left(v_reason, 500) else null end
     where id = v_i.id;
  exception when check_violation then
    return query select 'refused'::text; return;
  end;
  perform core.record_audit(v_i.organization_id, 'proposal.line_pricing_set', 'proposal', v_p.id,
    jsonb_build_object('lineId', v_i.id, 'discountMinor', v_i.line_discount_minor, 'sourceKind', v_i.source_kind, 'catalogueRef', v_i.catalogue_ref),
    jsonb_build_object('lineId', v_i.id, 'discountMinor', p_discount_minor, 'sourceKind', p_source_kind, 'catalogueRef', v_ref, 'reason', left(v_reason, 500)));
  return query select 'set'::text;
end $$;

-- the lines of one quotation as they were priced: gross, line discount, net, and where each came from (internal readers)
create or replace function sales.p1r_quote_lines(p_proposal_id uuid)
returns table (line_id uuid, line_position int, description text, quantity numeric, unit_price_minor bigint, gross_minor bigint, line_discount_minor bigint, net_minor bigint,
               source_kind text, catalogue_ref text, line_discount_reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return; end if;
  return query
  select i.id, i."position", i.description, i.quantity, i.unit_price_minor, round(i.quantity * i.unit_price_minor)::bigint, i.line_discount_minor, i.amount_minor,
         i.source_kind, i.catalogue_ref, i.line_discount_reason
    from sales.proposal_items i
   where i.proposal_id = p_proposal_id and i.organization_id = v_org
   order by i."position", i.created_at;
end $$;

-- A line discount counts toward the negotiation limit: otherwise a discount could be hidden in a line. (Replaces the read; the stamp on entering review is patched below.)
create or replace function sales.p1o_check_negotiation_limits(p_proposal_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v sales.proposals;
begin
  select p.* into v from sales.proposals p where p.id = p_proposal_id;
  if v.id is null then return null; end if;
  if (select auth.uid()) is not null and v.organization_id is distinct from (select core.current_organization_id()) then return null; end if;
  return sales.p1o_limit_breaches(v.organization_id, v.discount_minor + sales.p1r_line_discount_total(v.id), v.total_minor, v.document);
end $$;

do $$
declare
  d text := pg_get_functiondef('sales.p1o_proposals_guard()'::regprocedure);
  n text;
begin
  if position('p1r_line_discount_total' in d) > 0 then return; end if;
  n := replace(d, 'sales.p1o_limit_breaches(new.organization_id, new.discount_minor, new.total_minor, new.document)',
                  'sales.p1o_limit_breaches(new.organization_id, new.discount_minor + sales.p1r_line_discount_total(new.id), new.total_minor, new.document)');
  if n = d then
    raise exception 'sales.p1o_proposals_guard() no longer has the negotiation-limit anchor this migration patches; update the migration';
  end if;
  execute n;
end $$;

-- ── Delivered / Viewed: the delivery record of a quotation ─────────────────
create table if not exists sales.p1r_quote_delivery (
  proposal_id     uuid primary key references sales.proposals(id) on delete cascade,
  organization_id uuid not null references core.organizations(id) on delete cascade,
  message_id      uuid not null,
  delivered_at    timestamptz,
  viewed_at       timestamptz,
  failed_at       timestamptz,
  updated_at      timestamptz not null default now()
);
alter table sales.p1r_quote_delivery enable row level security;
drop policy if exists p1r_quote_delivery_select on sales.p1r_quote_delivery;
create policy p1r_quote_delivery_select on sales.p1r_quote_delivery for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1r_org_match_quote_delivery_proposal on sales.p1r_quote_delivery;
create trigger p1r_org_match_quote_delivery_proposal before insert or update of proposal_id, organization_id on sales.p1r_quote_delivery
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');
drop trigger if exists p1r_freeze_org_quote_delivery on sales.p1r_quote_delivery;
create trigger p1r_freeze_org_quote_delivery before update of organization_id on sales.p1r_quote_delivery for each row execute function core.freeze_organization_id();
drop trigger if exists p1r_quote_delivery_reject_delete on sales.p1r_quote_delivery;
create trigger p1r_quote_delivery_reject_delete before delete on sales.p1r_quote_delivery for each row execute function core.reject_end_user_delete();
drop trigger if exists p1r_quote_delivery_no_truncate on sales.p1r_quote_delivery;
create trigger p1r_quote_delivery_no_truncate before truncate on sales.p1r_quote_delivery for each statement execute function crm.reject_truncate();
revoke all on sales.p1r_quote_delivery from public, anon, authenticated;
grant select on sales.p1r_quote_delivery to authenticated;
grant all on sales.p1r_quote_delivery to service_role;

create index if not exists p1r_proposals_sent_message_ref_idx on sales.proposals (sent_message_ref) where sent_message_ref is not null;

create or replace function sales.p1r_quote_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wire text := new.metadata ->> 'wire_status';
  v_p record;
  v_row sales.p1r_quote_delivery;
  v_at timestamptz;
begin
  if v_wire is null or v_wire is not distinct from (old.metadata ->> 'wire_status') or v_wire not in ('delivered', 'read', 'failed') then return new; end if;
  for v_p in select p.id, p.organization_id from sales.proposals p where p.sent_message_ref = new.id::text and p.organization_id = new.organization_id loop
    v_at := coalesce((new.metadata ->> (v_wire || '_at'))::timestamptz, now());
    insert into sales.p1r_quote_delivery (proposal_id, organization_id, message_id) values (v_p.id, v_p.organization_id, new.id)
      on conflict (proposal_id) do nothing;
    select d.* into v_row from sales.p1r_quote_delivery d where d.proposal_id = v_p.id for update;
    if v_wire in ('delivered', 'read') and v_row.delivered_at is null then
      update sales.p1r_quote_delivery set delivered_at = v_at, updated_at = now() where proposal_id = v_p.id;
      perform core.emit_event(v_p.organization_id, 'proposal.delivered', 'proposal', v_p.id, jsonb_build_object('proposalId', v_p.id, 'at', v_at));
    end if;
    if v_wire = 'read' and v_row.viewed_at is null then
      update sales.p1r_quote_delivery set viewed_at = v_at, updated_at = now() where proposal_id = v_p.id;
      perform core.emit_event(v_p.organization_id, 'proposal.viewed', 'proposal', v_p.id, jsonb_build_object('proposalId', v_p.id, 'at', v_at));
    end if;
    if v_wire = 'failed' and v_row.failed_at is null then
      update sales.p1r_quote_delivery set failed_at = v_at, updated_at = now() where proposal_id = v_p.id;
      perform core.emit_event(v_p.organization_id, 'proposal.delivery_failed', 'proposal', v_p.id, jsonb_build_object('proposalId', v_p.id, 'at', v_at));
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists p1r_quote_receipt on crm.conversation_messages;
create trigger p1r_quote_receipt
  after update on crm.conversation_messages
  for each row when (old.metadata is distinct from new.metadata)
  execute function sales.p1r_quote_receipt();

create or replace function sales.p1r_quote_delivery_for(p_proposal_id uuid)
returns table (delivered_at timestamptz, viewed_at timestamptz, failed_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or (select core.current_organization_id()) is null then return; end if;
  return query
  select d.delivered_at, d.viewed_at, d.failed_at from sales.p1r_quote_delivery d
   where d.proposal_id = p_proposal_id and d.organization_id = (select core.current_organization_id());
end $$;

-- ── a direct quotation column on invoices ──────────────────────────────────
alter table finance.invoices add column if not exists proposal_id uuid references sales.proposals(id) on delete set null;
comment on column finance.invoices.proposal_id is 'P1-QUOTE-036. The exact quotation version this invoice bills against. Stamped at creation from the project''s quotation; never changed once set.';
create index if not exists p1r_invoices_proposal_idx on finance.invoices (proposal_id) where proposal_id is not null;

drop trigger if exists p1r_org_match_invoices_proposal on finance.invoices;
create trigger p1r_org_match_invoices_proposal
  before insert or update of proposal_id, organization_id on finance.invoices
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');

create or replace function finance.p1r_stamp_invoice_proposal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.proposal_id is null and new.project_id is not null then
      select pr.proposal_id into new.proposal_id from projects.projects pr where pr.id = new.project_id and pr.organization_id = new.organization_id;
    end if;
    return new;
  end if;
  if old.proposal_id is not null and new.proposal_id is distinct from old.proposal_id then
    raise exception 'the quotation an invoice bills against does not change' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p1r_stamp_invoice_proposal on finance.invoices;
create trigger p1r_stamp_invoice_proposal
  before insert or update of proposal_id on finance.invoices
  for each row execute function finance.p1r_stamp_invoice_proposal();

-- the invoices that already exist: from the project's quotation (user triggers off for this one statement; the data is derived, not decided)
alter table finance.invoices disable trigger user;
update finance.invoices i set proposal_id = pr.proposal_id
  from projects.projects pr
 where i.proposal_id is null and i.project_id = pr.id and pr.organization_id = i.organization_id and pr.proposal_id is not null;
alter table finance.invoices enable trigger user;

-- the invoices that bill against one quotation (finance and administrators)
create or replace function finance.p1r_invoices_for_proposal(p_proposal_id uuid)
returns table (invoice_id uuid, invoice_number text, invoice_status text, total_minor bigint, kind text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or (select core.current_organization_id()) is null then return; end if;
  if not coalesce((select core.is_admin()), false) and not coalesce((select core.is_finance()), false) then return; end if;
  return query
  select i.id, i.number, i.status, i.total_minor, i.kind, i.created_at
    from finance.invoices i
   where i.proposal_id = p_proposal_id and i.organization_id = (select core.current_organization_id())
   order by i.created_at;
end $$;

-- ── the timeline objection is recalculated ─────────────────────────────────
create table if not exists sales.p1r_timeline_recalcs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  objection_id    uuid not null references sales.objections(id) on delete cascade,
  proposal_id     uuid references sales.proposals(id) on delete set null,
  asked_weeks     int not null check (asked_weeks between 1 and 104),
  estimate_min_weeks int not null check (estimate_min_weeks between 1 and 104),
  estimate_max_weeks int not null check (estimate_max_weeks between 1 and 104),
  verdict         text not null check (verdict in ('fits', 'tight', 'does_not_fit')),
  options         jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 1 and 6),
  recorded_by     uuid references core.users(id) on delete set null,
  recorded_at     timestamptz not null default now(),
  constraint p1r_recalc_estimate_order check (estimate_min_weeks <= estimate_max_weeks),
  constraint p1r_recalc_verdict_agrees check (
    (verdict = 'fits' and asked_weeks >= estimate_max_weeks)
    or (verdict = 'tight' and asked_weeks >= estimate_min_weeks and asked_weeks < estimate_max_weeks)
    or (verdict = 'does_not_fit' and asked_weeks < estimate_min_weeks))
);
create index if not exists p1r_timeline_recalcs_idx on sales.p1r_timeline_recalcs (objection_id, recorded_at desc);
alter table sales.p1r_timeline_recalcs enable row level security;
drop policy if exists p1r_timeline_recalcs_select on sales.p1r_timeline_recalcs;
create policy p1r_timeline_recalcs_select on sales.p1r_timeline_recalcs for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1r_org_match_recalcs_objection on sales.p1r_timeline_recalcs;
create trigger p1r_org_match_recalcs_objection before insert or update of objection_id, organization_id on sales.p1r_timeline_recalcs
  for each row execute function core.enforce_parent_org('objection_id', 'sales.objections');
drop trigger if exists p1r_org_match_recalcs_proposal on sales.p1r_timeline_recalcs;
create trigger p1r_org_match_recalcs_proposal before insert or update of proposal_id, organization_id on sales.p1r_timeline_recalcs
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');
drop trigger if exists p1r_freeze_org_recalcs on sales.p1r_timeline_recalcs;
create trigger p1r_freeze_org_recalcs before update of organization_id on sales.p1r_timeline_recalcs for each row execute function core.freeze_organization_id();
drop trigger if exists p1r_recalcs_reject_delete on sales.p1r_timeline_recalcs;
create trigger p1r_recalcs_reject_delete before delete on sales.p1r_timeline_recalcs for each row execute function core.reject_end_user_delete();
drop trigger if exists p1r_recalcs_no_truncate on sales.p1r_timeline_recalcs;
create trigger p1r_recalcs_no_truncate before truncate on sales.p1r_timeline_recalcs for each statement execute function crm.reject_truncate();
revoke all on sales.p1r_timeline_recalcs from public, anon, authenticated;
grant select on sales.p1r_timeline_recalcs to authenticated;
grant all on sales.p1r_timeline_recalcs to service_role;

-- Records a recalculation. It changes no price and no quotation. The verdict must agree with the numbers (the table's own check), and only a timeline objection is recalculated.
create or replace function sales.p1r_record_timeline_recalc(p_objection_id uuid, p_asked_weeks int, p_estimate_min int, p_estimate_max int, p_verdict text, p_options jsonb, p_proposal_id uuid default null)
returns table (outcome text, recalc_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o sales.objections;
  v_refusal text;
  v_id uuid;
begin
  select o.* into v_o from sales.objections o where o.id = p_objection_id;
  if v_o.id is null then return query select 'unknown_objection'::text, null::uuid; return; end if;
  v_refusal := ai.p1o_door_refusal(v_o.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::uuid; return; end if;
  if v_o.kind <> 'timeline' then return query select 'not_a_timeline_objection'::text, null::uuid; return; end if;
  begin
    insert into sales.p1r_timeline_recalcs (organization_id, objection_id, proposal_id, asked_weeks, estimate_min_weeks, estimate_max_weeks, verdict, options, recorded_by)
    values (v_o.organization_id, v_o.id, coalesce(p_proposal_id, v_o.proposal_id), p_asked_weeks, p_estimate_min, p_estimate_max, p_verdict, p_options, (select auth.uid()))
    returning id into v_id;
  exception when check_violation or foreign_key_violation then
    return query select 'refused'::text, null::uuid; return;
  end;
  perform core.record_audit(v_o.organization_id, 'objection.timeline_recalculated', 'objection', v_o.id, null,
    jsonb_build_object('askedWeeks', p_asked_weeks, 'estimate', jsonb_build_array(p_estimate_min, p_estimate_max), 'verdict', p_verdict));
  return query select 'recorded'::text, v_id;
end $$;

-- the timeline objections of one deal with their latest recalculation (internal readers)
create or replace function sales.p1r_timeline_objections(p_opportunity_id uuid)
returns table (objection_id uuid, round int, concern text, proposal_id uuid, recalc_id uuid, asked_weeks int, estimate_min_weeks int, estimate_max_weeks int, verdict text, options jsonb, recorded_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return; end if;
  return query
  select o.id, o.round, o.concern, o.proposal_id, r.id, r.asked_weeks, r.estimate_min_weeks, r.estimate_max_weeks, r.verdict, r.options, r.recorded_at
    from sales.objections o
    join sales.opportunities op on op.lead_id = o.lead_id and op.organization_id = o.organization_id and op.id = p_opportunity_id
    left join lateral (select x.* from sales.p1r_timeline_recalcs x where x.objection_id = o.id order by x.recorded_at desc limit 1) r on true
   where o.organization_id = v_org and o.kind = 'timeline'
   order by o.round;
end $$;

-- ── grants ─────────────────────────────────────────────────────────────────
revoke all on function sales.p1r_line_discount_total(uuid), sales.p1r_set_line_pricing(uuid, bigint, text, text, text), sales.p1r_quote_lines(uuid), sales.p1r_quote_delivery_for(uuid),
  finance.p1r_invoices_for_proposal(uuid), sales.p1r_record_timeline_recalc(uuid, int, int, int, text, jsonb, uuid), sales.p1r_timeline_objections(uuid) from public, anon;
grant execute on function sales.p1r_line_discount_total(uuid), sales.p1r_set_line_pricing(uuid, bigint, text, text, text), sales.p1r_quote_lines(uuid), sales.p1r_quote_delivery_for(uuid),
  finance.p1r_invoices_for_proposal(uuid), sales.p1r_record_timeline_recalc(uuid, int, int, int, text, jsonb, uuid), sales.p1r_timeline_objections(uuid) to authenticated, service_role;
revoke all on function sales.p1r_quote_receipt(), finance.p1r_stamp_invoice_proposal() from public, anon, authenticated;

notify pgrst, 'reload schema';
