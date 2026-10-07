-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Quotation Master gap closure (traceability: docs/phase-1-orchestrator-quotation-gaps-log.md).
-- Rows: P1-QUOTE-012/014/018/019/023/024/025/031/034/036/039/040/042/052/053/054/056/059/078/080/081/083/084, P1-COORD-014, P1-HANDOFF-024/027/028/043.
--
-- What was missing, in the order the quotation lives:
--   * which policy a quote was judged under. Nothing recorded the limits, the approver ladder, the payment terms or the tax set-up in force when a quote went to
--     the owner; a changed setting could not be told apart from an old quote. sales.proposals.policy_snapshot / policy_version are stamped when the quote enters
--     review and never change; the snapshot also lists any negotiation limit the quote breaches (recorded for the approver, who is always the owner (ADM-07)).
--   * tax from configuration, not a hand-keyed number: sales.p1o_quote_tax_config (set by an administrator) and sales.p1o_apply_quote_tax. An unconfigured or
--     uncertain treatment is never guessed: it raises a flag, and a quote with an open tax flag cannot enter review until an administrator resolves it.
--   * readiness before drafting: sales.p1o_quote_readiness names what is missing instead of letting a draft guess.
--   * an approval that expired and was escalated could never move the quote. approvals.expire_overdue raises a NEW request (escalated_from) but
--     sales.proposals.approval_request_id kept pointing at the expired one, and sync_proposal_decision read only that row, so the owner's approval of the
--     escalation left the quote in pending_approval for ever (reproduced in scripts/verify-p1o-quotation.sql before the fix). The sync now follows the chain.
--   * acceptance is evidence, not just a status: sales.p1o_record_acceptance requires the client contact, the channel and the evidence, ties it to one exact
--     version (a stated version that is not this one is refused), and when several versions are open and the client did not say which, it records a clarification
--     and changes nothing (never inferred). The accepted terms are snapshotted at the moment of acceptance by whichever door accepted. The older staff door
--     (sales.record_proposal_response) is unchanged and still accepts without evidence; the switch-over is a wiring step (see the log).
--   * a quote can be cancelled (status 'cancelled'; draft, in review, approved or sent), only through sales.p1o_cancel_proposal, which withdraws a pending
--     approval and leaves the history.
--   * a typed client response (price, scope, feature, timeline, payment-term, trust, clarification, change request, needs more time, no response, ambiguous) is
--     recorded apart from the objection and never counts as an acceptance.
--   * the negotiation read (sales.p1o_negotiation_rounds), what changed between versions (sales.p1o_version_change_summary), the audit timeline of one quote
--     (sales.p1o_quote_timeline) and the invoices that trace back to an accepted version (sales.p1o_quote_trace) are reads over rows that already exist.
-- Nothing is sent to anyone and no human gate is relaxed: approval, the send and the client's answer keep their doors.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('proposal.cancelled', 'A quotation was cancelled by an administrator (draft, in review, approved or sent). Any pending approval was withdrawn.', true),
  ('proposal.acceptance_ambiguous', 'A client reply read as acceptance but did not name which of several open quotation versions; nothing was accepted and a person must ask which.', true)
on conflict (type) do nothing;

-- ── new columns on the quotation ───────────────────────────────────────────
alter table sales.proposals
  add column if not exists policy_version text,
  add column if not exists policy_snapshot jsonb,
  add column if not exists tax_basis jsonb,
  add column if not exists acceptance_channel text,
  add column if not exists acceptance_evidence_ref text,
  add column if not exists acceptance_message_ref text,
  add column if not exists acceptance_terms jsonb,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text;

alter table sales.proposals drop constraint if exists proposals_status_check;
alter table sales.proposals add constraint proposals_status_check
  check (status = any (array['draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected', 'superseded', 'lapsed', 'cancelled']));
alter table sales.proposals drop constraint if exists p1o_proposals_acceptance_shape;
alter table sales.proposals add constraint p1o_proposals_acceptance_shape check (
  (acceptance_channel is null or acceptance_channel in ('staff_recorded', 'whatsapp', 'email', 'call', 'meeting', 'portal', 'other'))
  and (acceptance_terms is null or jsonb_typeof(acceptance_terms) = 'object')
  and (status <> 'cancelled' or (cancelled_at is not null and cancel_reason is not null))
);

-- The guard has an `else` that refuses every status it does not know; 'cancelled' is reached only through the cancel door, which declares itself with a
-- transaction-local flag a Data-API write cannot set. The existing definition is patched in place (the live text is read, two anchors are replaced, and the
-- migration fails if either anchor is missing) rather than copied, so no other branch of the guard can drift.
do $$
declare
  d text := pg_get_functiondef('sales.proposals_guard()'::regprocedure);
  n text;
begin
  if position('p1o.cancel_door' in d) > 0 then return; end if;
  n := replace(d, $a$    elsif new.status = 'superseded' then$a$,
$b$    elsif new.status = 'cancelled' then
      -- P1-QUOTE-084. Only sales.p1o_cancel_proposal reaches here.
      if current_setting('p1o.cancel_door', true) is distinct from 'on' then
        raise exception 'a proposal is cancelled through sales.p1o_cancel_proposal, not by a direct write'
          using errcode = 'restrict_violation';
      end if;
      if old.status not in ('draft', 'pending_approval', 'approved', 'sent') then
        raise exception 'a proposal that is % cannot be cancelled', old.status using errcode = 'restrict_violation';
      end if;

    elsif new.status = 'superseded' then$b$);
  if n = d then raise exception 'proposals_guard anchor 1 not found'; end if;
  d := n;
  n := replace(d, $a$  if old.status in ('accepted', 'rejected', 'superseded')$a$, $b$  if old.status in ('accepted', 'rejected', 'superseded', 'cancelled')$b$);
  if n = d then raise exception 'proposals_guard anchor 2 not found'; end if;
  execute n;
end $$;

-- ── the standing policy tables ─────────────────────────────────────────────
create table if not exists sales.p1o_negotiation_limits (
  organization_id    uuid primary key references core.organizations(id) on delete cascade,
  max_discount_minor bigint check (max_discount_minor is null or max_discount_minor > 0),
  min_advance_pct    numeric(5, 2) check (min_advance_pct is null or (min_advance_pct > 0 and min_advance_pct <= 100)),
  updated_by         uuid references core.users(id) on delete set null,
  updated_at         timestamptz not null default now()
);
create table if not exists sales.p1o_quote_tax_config (
  organization_id uuid primary key references core.organizations(id) on delete cascade,
  mode            text not null check (mode in ('gst', 'non_gst')),
  rate_bp         int not null check (rate_bp between 0 and 4000),
  note            text check (note is null or length(note) <= 500),
  updated_by      uuid references core.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  constraint p1o_tax_mode_rate check ((mode = 'non_gst' and rate_bp = 0) or (mode = 'gst' and rate_bp > 0))
);
create table if not exists sales.p1o_quote_flags (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  proposal_id     uuid not null references sales.proposals(id) on delete cascade,
  kind            text not null check (kind in ('tax_uncertain')),
  note            text not null check (length(btrim(note)) between 1 and 1000),
  state           text not null default 'open' check (state in ('open', 'resolved')),
  raised_by       uuid references core.users(id) on delete set null,
  raised_at       timestamptz not null default now(),
  resolved_by     uuid references core.users(id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text check (resolution_note is null or length(resolution_note) <= 1000),
  constraint p1o_quote_flags_resolved_shape check (state = 'open' or (resolved_at is not null and resolution_note is not null))
);
create unique index if not exists p1o_quote_flags_one_open on sales.p1o_quote_flags (proposal_id, kind) where state = 'open';
create table if not exists sales.p1o_acceptance_clarifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  opportunity_id  uuid not null references sales.opportunities(id) on delete cascade,
  proposal_ids    uuid[] not null check (cardinality(proposal_ids) >= 2),
  contact_id      uuid references crm.contacts(id) on delete set null,
  message_ref     text,
  state           text not null default 'open' check (state in ('open', 'resolved')),
  raised_by       uuid references core.users(id) on delete set null,
  raised_at       timestamptz not null default now(),
  resolved_by     uuid references core.users(id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text check (resolution_note is null or length(resolution_note) <= 1000),
  constraint p1o_clarifications_resolved_shape check (state = 'open' or (resolved_at is not null and resolution_note is not null))
);
create unique index if not exists p1o_clarifications_one_open on sales.p1o_acceptance_clarifications (opportunity_id) where state = 'open';
create table if not exists sales.p1o_quote_responses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  proposal_id     uuid not null references sales.proposals(id) on delete cascade,
  response_class  text not null check (response_class in ('rejected', 'price_objection', 'scope_objection', 'feature_objection', 'timeline_objection',
                                                          'payment_term_objection', 'trust_objection', 'clarification', 'change_request', 'needs_more_time',
                                                          'no_response', 'ambiguous')),
  message_ref     text,
  note            text check (note is null or length(note) <= 1000),
  recorded_by     uuid references core.users(id) on delete set null,
  recorded_at     timestamptz not null default now()
);
create index if not exists p1o_quote_responses_proposal on sales.p1o_quote_responses (proposal_id, recorded_at);

do $$
declare t text;
begin
  foreach t in array array['p1o_negotiation_limits', 'p1o_quote_tax_config', 'p1o_quote_flags', 'p1o_acceptance_clarifications', 'p1o_quote_responses']
  loop
    execute format('alter table sales.%I enable row level security', t);
    execute format('drop policy if exists %I on sales.%I', t || '_select', t);
    execute format('create policy %I on sales.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))', t || '_select', t);
    execute format('drop trigger if exists %I on sales.%I', t || '_freeze_org', t);
    execute format('create trigger %I before update of organization_id on sales.%I for each row execute function core.freeze_organization_id()', t || '_freeze_org', t);
    execute format('drop trigger if exists %I on sales.%I', t || '_reject_delete', t);
    execute format('create trigger %I before delete on sales.%I for each row execute function core.reject_end_user_delete()', t || '_reject_delete', t);
    execute format('drop trigger if exists %I on sales.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on sales.%I for each statement execute function crm.reject_truncate()', t || '_no_truncate', t);
  end loop;
end $$;

drop trigger if exists p1o_org_match_quote_flags_proposal on sales.p1o_quote_flags;
create trigger p1o_org_match_quote_flags_proposal before insert or update of proposal_id, organization_id on sales.p1o_quote_flags
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');
drop trigger if exists p1o_org_match_clarifications_opportunity on sales.p1o_acceptance_clarifications;
create trigger p1o_org_match_clarifications_opportunity before insert or update of opportunity_id, organization_id on sales.p1o_acceptance_clarifications
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');
drop trigger if exists p1o_org_match_clarifications_contact on sales.p1o_acceptance_clarifications;
create trigger p1o_org_match_clarifications_contact before insert or update of contact_id, organization_id on sales.p1o_acceptance_clarifications
  for each row execute function core.enforce_parent_org('contact_id', 'crm.contacts');
drop trigger if exists p1o_org_match_quote_responses_proposal on sales.p1o_quote_responses;
create trigger p1o_org_match_quote_responses_proposal before insert or update of proposal_id, organization_id on sales.p1o_quote_responses
  for each row execute function core.enforce_parent_org('proposal_id', 'sales.proposals');

-- ── limits: set by an administrator, checked against a quote ───────────────
create or replace function sales.p1o_set_negotiation_limits(p_organization_id uuid, p_max_discount_minor bigint, p_min_advance_pct numeric)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text := ai.p1o_door_refusal(p_organization_id, true);
begin
  if v_refusal is not null then return query select v_refusal; return; end if;
  begin
    insert into sales.p1o_negotiation_limits as l (organization_id, max_discount_minor, min_advance_pct, updated_by, updated_at)
    values (p_organization_id, p_max_discount_minor, p_min_advance_pct, (select auth.uid()), now())
    on conflict (organization_id) do update set max_discount_minor = excluded.max_discount_minor, min_advance_pct = excluded.min_advance_pct,
                                                updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  exception when check_violation then
    return query select 'refused'::text; return;
  end;
  perform core.record_audit(p_organization_id, 'negotiation_limits.set', 'organization', p_organization_id, null,
    jsonb_build_object('maxDiscountMinor', p_max_discount_minor, 'minAdvancePct', p_min_advance_pct));
  return query select 'set'::text;
end $$;

-- which configured limits does a quote's content breach? (recorded for the approver; it refuses nothing)
create or replace function sales.p1o_limit_breaches(p_organization_id uuid, p_discount_minor bigint, p_total_minor bigint, p_document jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l sales.p1o_negotiation_limits;
  v_first numeric;
  v_out jsonb := '[]'::jsonb;
begin
  select x.* into l from sales.p1o_negotiation_limits x where x.organization_id = p_organization_id;
  if l.organization_id is null then return v_out; end if;
  if l.max_discount_minor is not null and p_discount_minor > l.max_discount_minor then
    v_out := v_out || jsonb_build_array(jsonb_build_object('limit', 'max_discount_minor', 'allowed', l.max_discount_minor, 'actual', p_discount_minor));
  end if;
  if l.min_advance_pct is not null then
    -- the structure frozen onto the quote, else the corpus family the document would print (under 1,00,000 rupees: 40, else 30)
    v_first := coalesce((p_document -> 'paymentStructure' -> 'milestones' -> 0 ->> 'pct')::numeric,
                        case when p_total_minor < 10000000 then 40 else 30 end);
    if v_first < l.min_advance_pct then
      v_out := v_out || jsonb_build_array(jsonb_build_object('limit', 'min_advance_pct', 'allowed', l.min_advance_pct, 'actual', v_first));
    end if;
  end if;
  return v_out;
end $$;

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
  return sales.p1o_limit_breaches(v.organization_id, v.discount_minor, v.total_minor, v.document);
end $$;

-- ── the policy a quote was judged under ────────────────────────────────────
create or replace function sales.p1o_policy_snapshot(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'settings', (select jsonb_strip_nulls(jsonb_build_object(
        'negotiation_max_rounds', o.settings -> 'negotiation_max_rounds',
        'negotiation_min_price_rupees', o.settings -> 'negotiation_min_price_rupees',
        'negotiation_max_discount_pct', o.settings -> 'negotiation_max_discount_pct',
        'negotiation_max_autonomous_quote_rupees', o.settings -> 'negotiation_max_autonomous_quote_rupees',
        'quotation_validity_days', o.settings -> 'quotation_validity_days',
        'pricing_day_rate_rupees', o.settings -> 'pricing_day_rate_rupees',
        'pricing_multiplier_min', o.settings -> 'pricing_multiplier_min',
        'pricing_multiplier_target', o.settings -> 'pricing_multiplier_target',
        'pricing_multiplier_max', o.settings -> 'pricing_multiplier_max',
        'gst_registration_type', o.settings -> 'gst_registration_type')) from core.organizations o where o.id = p_organization_id),
    'gstRegistered', (select o.gstin is not null from core.organizations o where o.id = p_organization_id),
    'approvalPolicies', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'minAmountMinor', a.min_amount_minor, 'requiredRole', a.required_role,
                                                                      'slaHours', a.sla_hours, 'updatedAt', a.updated_at) order by a.min_amount_minor, a.id)
                                   from approvals.approval_policies a where a.organization_id = p_organization_id and a.subject_type = 'proposal' and a.active), '[]'::jsonb),
    'paymentStructures', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'updatedAt', s.updated_at) order by s.name, s.id)
                                     from sales.payment_structures s where s.organization_id = p_organization_id and s.active), '[]'::jsonb),
    'tax', (select jsonb_build_object('mode', c.mode, 'rateBp', c.rate_bp, 'updatedAt', c.updated_at) from sales.p1o_quote_tax_config c where c.organization_id = p_organization_id),
    'limits', (select jsonb_build_object('maxDiscountMinor', l.max_discount_minor, 'minAdvancePct', l.min_advance_pct, 'updatedAt', l.updated_at)
                 from sales.p1o_negotiation_limits l where l.organization_id = p_organization_id)
  );
$$;

-- ── stamping and guarding the new columns ──────────────────────────────────
create or replace function sales.p1o_proposals_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snap jsonb;
begin
  -- once written, a record of what was in force and what was agreed does not change
  if tg_op = 'UPDATE' then
    if (old.policy_snapshot is not null and new.policy_snapshot is distinct from old.policy_snapshot)
       or (old.policy_version is not null and new.policy_version is distinct from old.policy_version) then
      raise exception 'the policy a quotation was judged under is a record of what was in force, and does not change' using errcode = 'restrict_violation';
    end if;
    if (old.acceptance_terms is not null and new.acceptance_terms is distinct from old.acceptance_terms)
       or (old.acceptance_evidence_ref is not null and new.acceptance_evidence_ref is distinct from old.acceptance_evidence_ref)
       or (old.acceptance_channel is not null and new.acceptance_channel is distinct from old.acceptance_channel and old.acceptance_channel <> 'staff_recorded')
       or (old.acceptance_message_ref is not null and new.acceptance_message_ref is distinct from old.acceptance_message_ref) then
      raise exception 'what the client accepted, and the evidence of it, does not change' using errcode = 'restrict_violation';
    end if;
    if new.status <> 'accepted' and (new.acceptance_evidence_ref is not null or new.acceptance_message_ref is not null) then
      raise exception 'acceptance evidence belongs to an accepted quotation' using errcode = 'restrict_violation';
    end if;
    if old.tax_basis is not null and old.status <> 'draft' and new.tax_basis is distinct from old.tax_basis then
      raise exception 'the tax basis of a quotation outside draft does not change' using errcode = 'restrict_violation';
    end if;
  end if;

  -- entering review: stamp the policy in force, and refuse while a tax question is open
  if tg_op = 'UPDATE' and new.status = 'pending_approval' and old.status = 'draft' then
    if exists (select 1 from sales.p1o_quote_flags f where f.proposal_id = new.id and f.kind = 'tax_uncertain' and f.state = 'open') then
      raise exception 'tax treatment of this quotation is flagged as uncertain: an administrator must resolve the flag before it goes for approval'
        using errcode = 'restrict_violation';
    end if;
    v_snap := sales.p1o_policy_snapshot(new.organization_id)
              || jsonb_build_object('breaches', sales.p1o_limit_breaches(new.organization_id, new.discount_minor, new.total_minor, new.document));
    new.policy_snapshot := v_snap;
    new.policy_version := 'pv-' || left(md5(v_snap::text), 12);
  end if;

  -- accepted by whichever door: freeze the terms that were accepted
  if tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    new.acceptance_terms := jsonb_build_object(
      'version', new.version, 'currency', new.currency, 'subtotalMinor', new.subtotal_minor, 'discountMinor', new.discount_minor,
      'taxMinor', new.tax_minor, 'totalMinor', new.total_minor, 'validUntil', new.valid_until,
      'paymentStructure', new.document -> 'paymentStructure',
      'itemsDigest', (select md5(coalesce(string_agg(i.description || '|' || i.quantity || '|' || i.amount_minor, ';' order by i.position, i.created_at), ''))
                        from sales.proposal_items i where i.proposal_id = new.id),
      'policyVersion', new.policy_version);
    new.acceptance_channel := coalesce(new.acceptance_channel, 'staff_recorded');
  end if;
  return new;
end $$;

drop trigger if exists p1o_proposals_guard on sales.proposals;
create trigger p1o_proposals_guard
  before update on sales.proposals
  for each row execute function sales.p1o_proposals_guard();

-- ── an escalated approval moves the quote it was raised for ────────────────
-- Replaces sales.sync_proposal_decision (20261011100000) with one change: when the request the quote points at has EXPIRED and was escalated, follow
-- escalated_from forward to the live request, re-point the quote at it, and read that one. Everything else is the earlier body.
create or replace function sales.sync_proposal_decision(p_proposal_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_row      sales.proposals;
  v_state    text;
  v_status   text;
  v_decider  uuid;
  v_note     text;
  v_at       timestamptz;
  v_name     text;
  v_role     text;
  v_req      uuid;
  v_next     uuid;
  v_hops     int := 0;
begin
  select p.* into v_row from sales.proposals p where p.id = p_proposal_id for update;
  if v_row.id is null then return 'not_found'; end if;
  if v_row.approval_request_id is null then return v_row.status; end if;

  v_req := v_row.approval_request_id;
  loop
    select r.state into v_state from approvals.approval_requests r where r.id = v_req;
    exit when v_state is distinct from 'expired' or v_hops >= 5;
    select r2.id into v_next from approvals.approval_requests r2
     where r2.escalated_from = v_req and r2.subject_type = 'proposal' and r2.subject_id = v_row.id
     order by r2.created_at desc limit 1;
    exit when v_next is null;
    v_req := v_next;
    v_hops := v_hops + 1;
  end loop;

  if v_req is distinct from v_row.approval_request_id and v_row.status = 'pending_approval' then
    update sales.proposals set approval_request_id = v_req where sales.proposals.id = v_row.id;
    v_row.approval_request_id := v_req;
  end if;

  select r.state, r.decided_by, nullif(btrim(r.decision_note), ''), r.decided_at
    into v_state, v_decider, v_note, v_at
    from approvals.approval_requests r
   where r.id = v_row.approval_request_id;

  v_status := case v_state
    when 'approved' then 'approved'
    when 'rejected' then 'draft'
    when 'changes_requested' then 'draft'
    else null
  end;

  if v_status is null or v_row.status <> 'pending_approval' then
    return v_row.status;
  end if;

  if v_status = 'approved' and v_decider is not null then
    select nullif(btrim(u.full_name), ''), m.role
      into v_name, v_role
      from core.users u
      left join core.memberships m on m.user_id = u.id and m.organization_id = v_row.organization_id
     where u.id = v_decider;
  end if;

  update sales.proposals
     set status = v_status,
         approval_request_id = case when v_status = 'draft' then null else v_row.approval_request_id end,
         approved_by_name = case when v_status = 'approved' then v_name else sales.proposals.approved_by_name end,
         approved_by_role = case when v_status = 'approved' then v_role else sales.proposals.approved_by_role end,
         sent_back_note = case when v_status = 'draft' then v_note else sales.proposals.sent_back_note end,
         sent_back_at   = case when v_status = 'draft' then coalesce(v_at, now()) else sales.proposals.sent_back_at end
   where sales.proposals.id = v_row.id;

  return v_status;
end $$;

-- ── tax from configuration ─────────────────────────────────────────────────
create or replace function sales.p1o_set_quote_tax_config(p_organization_id uuid, p_mode text, p_rate_bp int, p_note text default null)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text := ai.p1o_door_refusal(p_organization_id, true);
begin
  if v_refusal is not null then return query select v_refusal; return; end if;
  begin
    insert into sales.p1o_quote_tax_config as c (organization_id, mode, rate_bp, note, updated_by, updated_at)
    values (p_organization_id, p_mode, p_rate_bp, p_note, (select auth.uid()), now())
    on conflict (organization_id) do update set mode = excluded.mode, rate_bp = excluded.rate_bp, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  exception when check_violation then
    return query select 'refused'::text; return;
  end;
  perform core.record_audit(p_organization_id, 'quote_tax_config.set', 'organization', p_organization_id, null, jsonb_build_object('mode', p_mode, 'rateBp', p_rate_bp));
  return query select 'set'::text;
end $$;

create or replace function sales.p1o_apply_quote_tax(p_proposal_id uuid)
returns table (outcome text, tax_minor bigint, total_minor bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v sales.proposals;
  c sales.p1o_quote_tax_config;
  v_org record;
  v_refusal text;
  v_base bigint;
  v_tax bigint;
  v_note text;
begin
  select p.* into v from sales.proposals p where p.id = p_proposal_id for update;
  if v.id is null then return query select 'not_found'::text, null::bigint, null::bigint; return; end if;
  v_refusal := ai.p1o_door_refusal(v.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::bigint, null::bigint; return; end if;
  if v.status <> 'draft' then return query select 'not_draft'::text, v.tax_minor, v.total_minor; return; end if;
  select x.* into c from sales.p1o_quote_tax_config x where x.organization_id = v.organization_id;
  select o.gstin into v_org from core.organizations o where o.id = v.organization_id;

  v_note := case when c.organization_id is null then 'No tax configuration is set: the tax treatment cannot be decided by the system.'
                 when c.mode = 'gst' and v_org.gstin is null then 'The tax mode is GST but the organisation has no GSTIN on record.'
                 else null end;
  if v_note is not null then
    insert into sales.p1o_quote_flags (organization_id, proposal_id, kind, note, raised_by)
    values (v.organization_id, v.id, 'tax_uncertain', v_note, (select auth.uid()))
    on conflict (proposal_id, kind) where state = 'open' do nothing;
    perform core.record_audit(v.organization_id, 'quote.tax_flagged', 'proposal', v.id, null, jsonb_build_object('note', v_note));
    return query select 'tax_uncertain'::text, v.tax_minor, v.total_minor; return;
  end if;

  v_base := v.subtotal_minor - v.discount_minor;
  v_tax := round(v_base * c.rate_bp / 10000.0)::bigint;
  update sales.proposals
     set tax_minor = v_tax, total_minor = v_base + v_tax,
         tax_basis = jsonb_build_object('mode', c.mode, 'rateBp', c.rate_bp, 'baseMinor', v_base, 'configUpdatedAt', c.updated_at, 'appliedAt', now())
   where id = v.id;
  perform core.record_audit(v.organization_id, 'quote.tax_applied', 'proposal', v.id, null, jsonb_build_object('mode', c.mode, 'rateBp', c.rate_bp, 'taxMinor', v_tax));
  return query select 'applied'::text, v_tax, v_base + v_tax;
end $$;

create or replace function sales.p1o_resolve_quote_flag(p_flag_id uuid, p_note text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  f sales.p1o_quote_flags;
  v_refusal text;
begin
  select x.* into f from sales.p1o_quote_flags x where x.id = p_flag_id for update;
  if f.id is null then return query select 'unknown_flag'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(f.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'missing_note'::text; return; end if;
  if f.state = 'resolved' then return query select 'already_resolved'::text; return; end if;
  update sales.p1o_quote_flags set state = 'resolved', resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = left(btrim(p_note), 1000) where id = f.id;
  perform core.record_audit(f.organization_id, 'quote.flag_resolved', 'proposal', f.proposal_id, null, jsonb_build_object('flagId', f.id, 'kind', f.kind));
  return query select 'resolved'::text;
end $$;

-- ── readiness before drafting ──────────────────────────────────────────────
create or replace function sales.p1o_quote_readiness(p_opportunity_id uuid)
returns table (check_name text, ok boolean, detail text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o sales.opportunities;
begin
  select x.* into o from sales.opportunities x where x.id = p_opportunity_id;
  if o.id is null then return; end if;
  if (select auth.uid()) is not null and o.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  return query select 'accepted_requirements'::text,
    exists (select 1 from crm.requirement_versions rv join crm.conversations c on c.id = rv.conversation_id
             where c.lead_id = o.lead_id and rv.organization_id = o.organization_id and rv.status = 'accepted'),
    'A quote is built from an accepted requirement version, never from a guess.'::text;
  return query select 'client_account'::text, o.client_account_id is not null, 'The quote names a client account.'::text;
  return query select 'estimated_value'::text, o.value_minor > 0, 'A budget or value signal exists to price against.'::text;
  return query select 'tax_configuration'::text, exists (select 1 from sales.p1o_quote_tax_config c where c.organization_id = o.organization_id),
    'The tax mode and rate are configured; the system does not guess them.'::text;
  return query select 'approval_policy'::text,
    exists (select 1 from approvals.approval_policies a where a.organization_id = o.organization_id and a.subject_type = 'proposal' and a.active),
    'An approval policy names who decides a quote; without one it cannot be submitted.'::text;
  return query select 'payment_structure'::text,
    exists (select 1 from sales.payment_structures s where s.organization_id = o.organization_id and s.active),
    'At least one payment structure is available to freeze onto the quote.'::text;
  return query select 'no_open_tax_question'::text,
    not exists (select 1 from sales.p1o_quote_flags f join sales.proposals p on p.id = f.proposal_id
                 where p.opportunity_id = o.id and f.state = 'open' and f.kind = 'tax_uncertain'),
    'No quote on this deal has an unresolved tax question.'::text;
end $$;

-- ── acceptance is evidence ─────────────────────────────────────────────────
create or replace function sales.p1o_record_acceptance(
  p_proposal_id uuid, p_contact_id uuid, p_channel text, p_evidence_ref text,
  p_stated_version int default null, p_message_ref text default null, p_note text default null
)
returns table (outcome text, status text, decided_at timestamptz, clarification_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v sales.proposals;
  v_refusal text;
  v_open uuid[];
  v_clar uuid;
  r record;
begin
  select p.* into v from sales.proposals p where p.id = p_proposal_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::timestamptz, null::uuid; return; end if;
  v_refusal := ai.p1o_door_refusal(v.organization_id, true);
  if v_refusal is not null then return query select v_refusal, null::text, null::timestamptz, null::uuid; return; end if;
  if (select auth.uid()) is null then return query select 'needs_a_person'::text, null::text, null::timestamptz, null::uuid; return; end if;
  if p_channel is null or p_channel not in ('whatsapp', 'email', 'call', 'meeting', 'portal', 'other') then
    return query select 'bad_channel'::text, null::text, null::timestamptz, null::uuid; return;
  end if;
  if p_evidence_ref is null or length(btrim(p_evidence_ref)) = 0 then return query select 'evidence_required'::text, null::text, null::timestamptz, null::uuid; return; end if;
  if p_contact_id is null or not exists (select 1 from crm.contacts c where c.id = p_contact_id and c.organization_id = v.organization_id) then
    return query select 'client_identity_required'::text, null::text, null::timestamptz, null::uuid; return;
  end if;
  if v.status not in ('sent', 'lapsed') then return query select 'not_answerable'::text, v.status, null::timestamptz, null::uuid; return; end if;

  -- which version? Several open versions and no stated one is a question, not an answer.
  select coalesce(array_agg(x.id order by x.version), '{}') into v_open
    from sales.proposals x where x.opportunity_id = v.opportunity_id and x.status = 'sent';
  if p_stated_version is not null and p_stated_version <> v.version then
    return query select 'version_mismatch'::text, v.status, null::timestamptz, null::uuid; return;
  end if;
  if p_stated_version is null and cardinality(v_open) > 1 then
    insert into sales.p1o_acceptance_clarifications (organization_id, opportunity_id, proposal_ids, contact_id, message_ref, raised_by)
    values (v.organization_id, v.opportunity_id, v_open, p_contact_id, p_message_ref, (select auth.uid()))
    on conflict (opportunity_id) where state = 'open' do nothing
    returning id into v_clar;
    if v_clar is null then select c.id into v_clar from sales.p1o_acceptance_clarifications c where c.opportunity_id = v.opportunity_id and c.state = 'open'; end if;
    perform core.emit_event(v.organization_id, 'proposal.acceptance_ambiguous', 'proposal', v.id,
      jsonb_build_object('opportunityId', v.opportunity_id, 'candidateProposalIds', to_jsonb(v_open), 'clarificationId', v_clar));
    return query select 'needs_clarification'::text, v.status, null::timestamptz, v_clar; return;
  end if;

  select * into r from sales.record_proposal_response(v.id, 'accepted', p_contact_id, p_note);
  if r.outcome <> 'recorded' then return query select r.outcome, r.status, r.decided_at, null::uuid; return; end if;

  update sales.proposals set acceptance_channel = p_channel, acceptance_evidence_ref = left(btrim(p_evidence_ref), 500),
                             acceptance_message_ref = left(nullif(btrim(coalesce(p_message_ref, '')), ''), 200)
   where id = v.id;
  update sales.p1o_acceptance_clarifications set state = 'resolved', resolved_by = (select auth.uid()), resolved_at = now(),
         resolution_note = 'resolved by an explicit acceptance of version ' || v.version
   where opportunity_id = v.opportunity_id and state = 'open';
  perform core.record_audit(v.organization_id, 'quote.acceptance_evidenced', 'proposal', v.id, null,
    jsonb_build_object('channel', p_channel, 'contactId', p_contact_id, 'evidenceRef', left(btrim(p_evidence_ref), 200), 'version', v.version));
  return query select 'recorded'::text, 'accepted'::text, r.decided_at, null::uuid;
end $$;

-- An agent that reads a bare "okay" with several versions open can RAISE the question for a person (it can never accept): this door records it, the person asks the
-- client which version, and the evidenced acceptance resolves it. The service role may call it; recording an acceptance stays a person's act.
create or replace function sales.p1o_raise_acceptance_clarification(p_opportunity_id uuid, p_message_ref text default null, p_contact_id uuid default null)
returns table (outcome text, clarification_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  o sales.opportunities;
  v_refusal text;
  v_open uuid[];
  v_id uuid;
begin
  select x.* into o from sales.opportunities x where x.id = p_opportunity_id;
  if o.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  v_refusal := ai.p1o_door_refusal(o.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::uuid; return; end if;
  select coalesce(array_agg(x.id order by x.version), '{}') into v_open from sales.proposals x where x.opportunity_id = o.id and x.status = 'sent';
  if cardinality(v_open) < 2 then return query select 'not_ambiguous'::text, null::uuid; return; end if;
  if p_contact_id is not null and not exists (select 1 from crm.contacts c where c.id = p_contact_id and c.organization_id = o.organization_id) then
    return query select 'unknown_contact'::text, null::uuid; return;
  end if;
  insert into sales.p1o_acceptance_clarifications (organization_id, opportunity_id, proposal_ids, contact_id, message_ref, raised_by)
  values (o.organization_id, o.id, v_open, p_contact_id, left(nullif(btrim(coalesce(p_message_ref, '')), ''), 200), (select auth.uid()))
  on conflict (opportunity_id) where state = 'open' do nothing
  returning id into v_id;
  if v_id is null then
    select c.id into v_id from sales.p1o_acceptance_clarifications c where c.opportunity_id = o.id and c.state = 'open';
    return query select 'already_open'::text, v_id; return;
  end if;
  perform core.emit_event(o.organization_id, 'proposal.acceptance_ambiguous', 'proposal', v_open[1],
    jsonb_build_object('opportunityId', o.id, 'candidateProposalIds', to_jsonb(v_open), 'clarificationId', v_id));
  return query select 'raised'::text, v_id;
end $$;

create or replace function sales.p1o_resolve_acceptance_clarification(p_clarification_id uuid, p_note text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c sales.p1o_acceptance_clarifications;
  v_refusal text;
begin
  select x.* into c from sales.p1o_acceptance_clarifications x where x.id = p_clarification_id for update;
  if c.id is null then return query select 'unknown_clarification'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(c.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'missing_note'::text; return; end if;
  if c.state = 'resolved' then return query select 'already_resolved'::text; return; end if;
  update sales.p1o_acceptance_clarifications set state = 'resolved', resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = left(btrim(p_note), 1000) where id = c.id;
  return query select 'resolved'::text;
end $$;

-- ── cancel ─────────────────────────────────────────────────────────────────
create or replace function sales.p1o_cancel_proposal(p_proposal_id uuid, p_reason text)
returns table (outcome text, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v sales.proposals;
  v_refusal text;
begin
  select p.* into v from sales.proposals p where p.id = p_proposal_id for update;
  if v.id is null then return query select 'not_found'::text, null::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v.organization_id, true);
  if v_refusal is not null then return query select v_refusal, null::text; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'missing_reason'::text, v.status; return; end if;
  if v.status = 'cancelled' then return query select 'already_cancelled'::text, v.status; return; end if;
  if v.status not in ('draft', 'pending_approval', 'approved', 'sent') then return query select 'not_cancellable'::text, v.status; return; end if;
  if v.plan_set_id is not null then return query select 'plan_set_member'::text, v.status; return; end if;

  if v.status = 'pending_approval' and v.approval_request_id is not null then
    perform approvals.cancel_request(v.approval_request_id, 'quotation cancelled: ' || left(btrim(p_reason), 200));
  end if;
  perform set_config('p1o.cancel_door', 'on', true);
  update sales.proposals set status = 'cancelled', cancelled_at = now(), cancel_reason = left(btrim(p_reason), 500) where id = v.id;
  perform set_config('p1o.cancel_door', 'off', true);
  perform core.record_audit(v.organization_id, 'proposal.cancelled', 'proposal', v.id, jsonb_build_object('status', v.status), jsonb_build_object('reason', left(btrim(p_reason), 500)));
  perform core.emit_event(v.organization_id, 'proposal.cancelled', 'proposal', v.id,
    jsonb_build_object('opportunityId', v.opportunity_id, 'version', v.version, 'wasStatus', v.status));
  return query select 'cancelled'::text, 'cancelled'::text;
end $$;

-- ── a typed client response (never an acceptance) ──────────────────────────
create or replace function sales.p1o_record_quote_response(p_proposal_id uuid, p_class text, p_message_ref text default null, p_note text default null)
returns table (outcome text, response_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v sales.proposals;
  v_refusal text;
  v_id uuid;
begin
  select p.* into v from sales.proposals p where p.id = p_proposal_id;
  if v.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  v_refusal := ai.p1o_door_refusal(v.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::uuid; return; end if;
  if p_class = 'accepted' then return query select 'use_the_acceptance_door'::text, null::uuid; return; end if;
  if p_class is null or p_class not in ('rejected', 'price_objection', 'scope_objection', 'feature_objection', 'timeline_objection', 'payment_term_objection',
                                        'trust_objection', 'clarification', 'change_request', 'needs_more_time', 'no_response', 'ambiguous') then
    return query select 'bad_class'::text, null::uuid; return;
  end if;
  insert into sales.p1o_quote_responses (organization_id, proposal_id, response_class, message_ref, note, recorded_by)
  values (v.organization_id, v.id, p_class, left(nullif(btrim(coalesce(p_message_ref, '')), ''), 200), left(nullif(btrim(coalesce(p_note, '')), ''), 1000), (select auth.uid()))
  returning id into v_id;
  perform core.record_audit(v.organization_id, 'quote.response_classified', 'proposal', v.id, null, jsonb_build_object('class', p_class, 'responseId', v_id));
  return query select 'recorded'::text, v_id;
end $$;

-- ── reads ──────────────────────────────────────────────────────────────────
create or replace function sales.p1o_negotiation_rounds(p_opportunity_id uuid)
returns table (
  round int, kind text, concern text, response text, outcome text, next_action text, objection_at timestamptz,
  proposal_id uuid, proposal_version int, proposal_status text, total_minor bigint, discount_minor bigint, applied_offer_id uuid,
  discount_decisions jsonb, approval_state text, client_responses jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  o sales.opportunities;
begin
  select x.* into o from sales.opportunities x where x.id = p_opportunity_id;
  if o.id is null or o.lead_id is null then return; end if;
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or o.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  return query
  select ob.round, ob.kind, ob.concern, ob.response, ob.outcome, ob.next_action, ob.created_at,
         p.id, p.version, p.status, p.total_minor, p.discount_minor, p.applied_offer_id,
         coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'discountMinor', d.discount_minor, 'pct', d.discount_pct, 'status', d.status, 'finalAmountMinor', d.final_amount_minor) order by d.created_at)
                     from sales.discount_decisions d where d.proposal_id = p.id), '[]'::jsonb),
         (select r.state from approvals.approval_requests r where r.id = p.approval_request_id),
         coalesce((select jsonb_agg(jsonb_build_object('class', q.response_class, 'at', q.recorded_at, 'note', q.note) order by q.recorded_at)
                     from sales.p1o_quote_responses q where q.proposal_id = p.id), '[]'::jsonb)
    from sales.objections ob
    left join sales.proposals p on p.id = ob.proposal_id
   where ob.lead_id = o.lead_id and ob.organization_id = o.organization_id
   order by ob.round, ob.created_at;
end $$;

create or replace function sales.p1o_version_change_summary(p_proposal_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cur sales.proposals;
  prev sales.proposals;
  v_changes jsonb := '[]'::jsonb;
begin
  select p.* into cur from sales.proposals p where p.id = p_proposal_id;
  if cur.id is null then return null; end if;
  if (select auth.uid()) is not null and cur.organization_id is distinct from (select core.current_organization_id()) then return null; end if;
  select p.* into prev from sales.proposals p
   where p.opportunity_id = cur.opportunity_id and p.version < cur.version and coalesce(p.plan_slot, 0) = coalesce(cur.plan_slot, 0)
   order by p.version desc limit 1;
  if prev.id is null then return jsonb_build_object('version', cur.version, 'previousVersion', null, 'changes', '[]'::jsonb); end if;
  if cur.subtotal_minor is distinct from prev.subtotal_minor then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', 'subtotal', 'from', prev.subtotal_minor, 'to', cur.subtotal_minor)); end if;
  if cur.discount_minor is distinct from prev.discount_minor then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', 'discount', 'from', prev.discount_minor, 'to', cur.discount_minor)); end if;
  if cur.tax_minor is distinct from prev.tax_minor then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', 'tax', 'from', prev.tax_minor, 'to', cur.tax_minor)); end if;
  if cur.total_minor is distinct from prev.total_minor then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', 'total', 'from', prev.total_minor, 'to', cur.total_minor)); end if;
  if cur.valid_until is distinct from prev.valid_until then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', 'valid_until', 'from', prev.valid_until, 'to', cur.valid_until)); end if;
  if cur.requirement_version_id is distinct from prev.requirement_version_id then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', 'requirement_version', 'from', prev.requirement_version_id, 'to', cur.requirement_version_id)); end if;
  if cur.document -> 'paymentStructure' is distinct from prev.document -> 'paymentStructure' then v_changes := v_changes || jsonb_build_array(jsonb_build_object('field', 'payment_structure', 'from', prev.document -> 'paymentStructure' ->> 'name', 'to', cur.document -> 'paymentStructure' ->> 'name')); end if;
  v_changes := v_changes || coalesce((
    select jsonb_agg(jsonb_build_object('field', 'line', 'change', case when pi.id is null then 'added' when ci.id is null then 'removed' else 'changed' end,
                                        'description', coalesce(ci.description, pi.description), 'fromAmountMinor', pi.amount_minor, 'toAmountMinor', ci.amount_minor))
      from (select * from sales.proposal_items where proposal_id = cur.id) ci
      full join (select * from sales.proposal_items where proposal_id = prev.id) pi on pi.description = ci.description
     where pi.id is null or ci.id is null or pi.amount_minor is distinct from ci.amount_minor or pi.quantity is distinct from ci.quantity), '[]'::jsonb);
  return jsonb_build_object('version', cur.version, 'previousVersion', prev.version, 'changes', v_changes);
end $$;

create or replace function sales.p1o_quote_timeline(p_proposal_id uuid)
returns table (occurred_at timestamptz, action text, actor_type text, actor_id uuid, subject_type text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v sales.proposals;
begin
  select p.* into v from sales.proposals p where p.id = p_proposal_id;
  if v.id is null then return; end if;
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  return query
  select a.created_at, a.action, a.actor_type, a.actor_id, a.subject_type
    from audit.audit_log a
   where a.organization_id = v.organization_id
     and (a.subject_id = v.id
          or a.subject_id in (select r.id from approvals.approval_requests r where r.subject_type = 'proposal' and r.subject_id = v.id)
          or a.subject_id in (select d.id from sales.discount_decisions d where d.proposal_id = v.id)
          or a.subject_id in (select q.id from sales.p1o_quote_responses q where q.proposal_id = v.id))
   order by a.created_at, a.id;
end $$;

create or replace function sales.p1o_quote_trace(p_proposal_id uuid)
returns table (project_id uuid, invoice_id uuid, invoice_number text, invoice_status text, total_minor bigint, accepted_version int)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v sales.proposals;
begin
  select p.* into v from sales.proposals p where p.id = p_proposal_id;
  if v.id is null then return; end if;
  if (select auth.uid()) is null or v.organization_id is distinct from (select core.current_organization_id()) then return; end if;
  if not coalesce((select core.is_admin()), false) and not coalesce((select core.is_finance()), false) then return; end if;
  return query
  select pr.id, i.id, i.number, i.status, i.total_minor, v.version
    from projects.projects pr
    join finance.invoices i on i.project_id = pr.id and i.organization_id = v.organization_id
   where pr.proposal_id = v.id and pr.organization_id = v.organization_id and v.status = 'accepted'
   order by i.created_at;
end $$;

-- ── grants ─────────────────────────────────────────────────────────────────
revoke all on function
  sales.p1o_set_negotiation_limits(uuid, bigint, numeric), sales.p1o_limit_breaches(uuid, bigint, bigint, jsonb), sales.p1o_check_negotiation_limits(uuid),
  sales.p1o_policy_snapshot(uuid), sales.p1o_set_quote_tax_config(uuid, text, int, text), sales.p1o_apply_quote_tax(uuid), sales.p1o_resolve_quote_flag(uuid, text),
  sales.p1o_quote_readiness(uuid), sales.p1o_record_acceptance(uuid, uuid, text, text, int, text, text), sales.p1o_resolve_acceptance_clarification(uuid, text),
  sales.p1o_cancel_proposal(uuid, text), sales.p1o_record_quote_response(uuid, text, text, text), sales.p1o_negotiation_rounds(uuid),
  sales.p1o_version_change_summary(uuid), sales.p1o_quote_timeline(uuid), sales.p1o_quote_trace(uuid), sales.p1o_raise_acceptance_clarification(uuid, text, uuid)
  from public, anon;
grant execute on function
  sales.p1o_set_negotiation_limits(uuid, bigint, numeric), sales.p1o_check_negotiation_limits(uuid),
  sales.p1o_policy_snapshot(uuid), sales.p1o_set_quote_tax_config(uuid, text, int, text), sales.p1o_apply_quote_tax(uuid), sales.p1o_resolve_quote_flag(uuid, text),
  sales.p1o_quote_readiness(uuid), sales.p1o_record_acceptance(uuid, uuid, text, text, int, text, text), sales.p1o_resolve_acceptance_clarification(uuid, text),
  sales.p1o_cancel_proposal(uuid, text), sales.p1o_record_quote_response(uuid, text, text, text), sales.p1o_negotiation_rounds(uuid),
  sales.p1o_version_change_summary(uuid), sales.p1o_quote_timeline(uuid), sales.p1o_quote_trace(uuid), sales.p1o_raise_acceptance_clarification(uuid, text, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';
