-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 8 (part C): the maintenance plan lifecycle that no earlier part built.
--
-- WHAT THIS IS: the deterministic records and doors of a maintenance plan's life, from a catalog an Admin sets to the day it ends:
--   catalog version -> plan -> the client's acceptance (recorded by staff, with evidence) -> the first cycle's invoice paid on VERIFIED money (or an
--   owner-approved, expiring exception) -> ACTIVE -> usage ledger and overage draft -> renewal proposal -> the client's acceptance -> payment -> RENEWED
--   -> cancellation (a reason is required; the entitlement ends the day it is confirmed).
--
-- THE RULES THIS FILE KEEPS:
--   * No price is invented. A catalog version carries price lines that a PERSON enters as data; nothing here supplies a number, and nothing bills one.
--     The invoice stays the existing composer's act at the amount a human quoted on sales.proposals (ADM-22); the verified payment stays the existing
--     Admin door (finance.verify_payment). This file only READS whether the first (or renewal) cycle's invoice is paid on verified money, through the
--     gate that already exists: finance.maintenance_financial_gate (20261105530000).
--   * A plan that ENTERS this lifecycle (has a projects.maintenance_plan_lifecycle row) is held to the new rules: its status, period and acceptance change
--     only through the doors below (a table trigger holds the service role too), and it is never active before its first cycle is paid or excepted.
--     Plans that never entered the lifecycle (the legacy hand-made ones) are untouched, so the earlier verifiers and the 8B gate keep their meaning.
--   * Creator != approver wherever money or entitlement is decided: a catalog version is published by someone other than its author; a plan is activated
--     and a renewal confirmed and a cancellation confirmed by an Admin other than the person who recorded the underlying decision.
--   * A renewal NEVER silently extends. It is proposed by a person, accepted by the client (a staff-recorded decision with evidence), paid, and confirmed
--     by an independent Admin. The 8A sweep (projects.sweep_maintenance_renewals) still expires a plan whose end date passed with no recorded renewal;
--     an expired plan is never revived by a late payment: it needs a new acceptance.
--   * Usage is a ledger of what happened (hours or requests, tied to a ticket or a work item), append-only, corrected only by a reversal entry. Overage is
--     COMPUTED from entitlement minus usage and surfaced as a DRAFT line a person quotes; no invoice, quote, discount or charge is ever created here.
--   * No refund logic: a cancellation ends entitlement and records why; money back is the finance exception door's decision, not this file's.
--   * A client sees their own account only, through SECURITY DEFINER functions that return plain facts (no internal reasons, ids of work, or amounts).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── sanction helper: lifecycle plan fields move through doors only ─────────────
create or replace function projects.p8c_sanctioned()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('projects.p8c_sanctioned', true), '') = 'on' or coalesce(current_setting('projects.p8_sanctioned', true), '') = 'on';
$$;

-- evidence is a REFERENCE (a ticket, a message id, a document name): a pasted secret is refused
create or replace function projects.p8c_has_secret(p_text text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_text, '') ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-.]{12,}'
      or coalesce(p_text, '') ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})';
$$;

-- ── the catalog: versioned, Admin-set, immutable once published ────────────────
create table if not exists projects.maintenance_plan_catalog (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  name              text not null check (length(btrim(name)) > 0 and length(name) <= 200),
  version           int not null check (version >= 1),
  billing_model     text not null check (billing_model in ('monthly', 'quarterly', 'annual', 'prepaid')),
  -- the entitlement per cycle. Nothing is assumed: at least one must be stated by the Admin.
  included_hours    numeric(8,2) check (included_hours is null or included_hours > 0),
  included_requests int check (included_requests is null or included_requests > 0),
  coverage          text check (coverage is null or length(coverage) <= 4000),
  excluded_work     text check (excluded_work is null or length(excluded_work) <= 4000),
  renewal_terms     text check (renewal_terms is null or length(renewal_terms) <= 4000),
  status            text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  created_by        uuid not null references core.users(id) on delete restrict,
  created_at        timestamptz not null default clock_timestamp(),
  published_by      uuid references core.users(id) on delete restrict,
  published_at      timestamptz,
  retired_by        uuid references core.users(id) on delete restrict,
  retired_at        timestamptz,
  unique (organization_id, name, version),
  check (included_hours is not null or included_requests is not null),
  check (status = 'draft' or (published_by is not null and published_at is not null and published_by <> created_by)),
  check (status <> 'retired' or (retired_by is not null and retired_at is not null))
);

-- price lines are DATA a person enters; the system never proposes, derives or applies a number
create table if not exists projects.maintenance_plan_price_lines (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  catalog_id      uuid not null references projects.maintenance_plan_catalog(id) on delete restrict,
  label           text not null check (length(btrim(label)) > 0 and length(label) <= 200),
  per             text not null check (per in ('cycle', 'included_hour', 'overage_hour', 'overage_request')),
  amount_minor    bigint not null check (amount_minor >= 0),
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
  entered_by      uuid not null references core.users(id) on delete restrict,
  entered_at      timestamptz not null default clock_timestamp(),
  unique (catalog_id, label)
);
-- one overage rate per kind per version: an overage line is priced from exactly one entered rate, or from none
create unique index if not exists maintenance_price_one_overage_rate on projects.maintenance_plan_price_lines (catalog_id, per) where per in ('overage_hour', 'overage_request');

-- ── a plan enters the lifecycle ────────────────────────────────────────────────
create table if not exists projects.maintenance_plan_lifecycle (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  plan_id           uuid not null unique references projects.maintenance_plans(id) on delete restrict,
  catalog_id        uuid not null references projects.maintenance_plan_catalog(id) on delete restrict,
  included_hours    numeric(8,2),
  included_requests int,
  entered_by        uuid not null references core.users(id) on delete restrict,
  entered_at        timestamptz not null default clock_timestamp()
);

-- the client's decision on the plan, recorded by staff against evidence (a reference), once per plan
create table if not exists projects.maintenance_plan_acceptances (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  plan_id           uuid not null unique references projects.maintenance_plans(id) on delete restrict,
  decision          text not null check (decision in ('accepted', 'declined')),
  proposal_id       uuid references sales.proposals(id) on delete restrict,
  channel           text not null check (channel in ('email', 'whatsapp', 'signed_document', 'call_note', 'portal')),
  evidence_ref      text not null check (length(btrim(evidence_ref)) > 0 and length(evidence_ref) <= 500),
  client_contact    text not null check (length(btrim(client_contact)) > 0 and length(client_contact) <= 200),
  reason            text check (reason is null or length(reason) <= 2000),
  recorded_by       uuid not null references core.users(id) on delete restrict,
  recorded_at       timestamptz not null default clock_timestamp(),
  check (decision <> 'accepted' or proposal_id is not null),
  check (decision <> 'declined' or length(btrim(coalesce(reason, ''))) > 0)
);

-- one row per paid-for cycle: created only by activation or by a confirmed renewal, after the gate held
create table if not exists projects.maintenance_plan_cycles (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  plan_id            uuid not null references projects.maintenance_plans(id) on delete restrict,
  link_id            uuid not null unique references finance.maintenance_billing_links(id) on delete restrict,
  purpose            text not null check (purpose in ('activation', 'renewal')),
  starts_on          date not null,
  ends_on            date not null,
  entitled_hours     numeric(8,2),
  entitled_requests  int,
  created_by         uuid not null references core.users(id) on delete restrict,
  created_at         timestamptz not null default clock_timestamp(),
  unique (plan_id, starts_on),
  check (ends_on > starts_on)
);

-- the usage ledger: what happened, never edited; a correction is a reversal entry
create table if not exists projects.maintenance_usage_entries (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  plan_id            uuid not null references projects.maintenance_plans(id) on delete restrict,
  cycle_id           uuid not null references projects.maintenance_plan_cycles(id) on delete restrict,
  entry_kind         text not null check (entry_kind in ('hours', 'request')),
  entry_type         text not null default 'consumption' check (entry_type in ('consumption', 'reversal')),
  quantity           numeric(8,2) not null check (quantity > 0),
  occurred_on        date not null,
  work_item_id       uuid references projects.maintenance_work_items(id) on delete restrict,
  ticket_id          uuid references projects.maintenance_items(id) on delete restrict,
  reverses_entry_id  uuid unique references projects.maintenance_usage_entries(id) on delete restrict,
  note               text check (note is null or length(note) <= 1000),
  recorded_by        uuid not null references core.users(id) on delete restrict,
  recorded_at        timestamptz not null default clock_timestamp(),
  check (entry_kind <> 'request' or quantity = trunc(quantity)),
  check (entry_type <> 'consumption' or (reverses_entry_id is null and (work_item_id is not null or ticket_id is not null))),
  check (entry_type <> 'reversal' or (reverses_entry_id is not null and length(btrim(coalesce(note, ''))) > 0))
);
create index if not exists maintenance_usage_cycle_idx on projects.maintenance_usage_entries (cycle_id, recorded_at);

-- an overage DRAFT a person quotes. No invoice, quote or charge column exists: it cannot be billed from here.
create table if not exists projects.maintenance_overage_drafts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  plan_id            uuid not null references projects.maintenance_plans(id) on delete restrict,
  cycle_id           uuid not null references projects.maintenance_plan_cycles(id) on delete restrict,
  entry_kind         text not null check (entry_kind in ('hours', 'request')),
  overage_quantity   numeric(8,2) not null check (overage_quantity > 0),
  entitled_quantity  numeric(8,2) not null,
  used_quantity      numeric(8,2) not null,
  price_line_id      uuid references projects.maintenance_plan_price_lines(id) on delete restrict,
  unit_rate_minor    bigint check (unit_rate_minor is null or unit_rate_minor >= 0),
  currency           char(3),
  amount_minor       bigint check (amount_minor is null or amount_minor >= 0),
  status             text not null default 'draft' check (status = 'draft'),
  note               text not null default 'A draft for a person to quote. Nothing has been billed or sent.',
  created_by         uuid not null references core.users(id) on delete restrict,
  created_at         timestamptz not null default clock_timestamp(),
  unique (cycle_id, entry_kind, overage_quantity),
  check ((unit_rate_minor is null) = (amount_minor is null) and (unit_rate_minor is null) = (price_line_id is null))
);

-- renewal proposal -> client acceptance -> payment -> renewed. One live renewal per plan.
create table if not exists projects.maintenance_plan_renewals (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  plan_id            uuid not null references projects.maintenance_plans(id) on delete restrict,
  price_proposal_id  uuid not null references sales.proposals(id) on delete restrict,
  renewal_starts_on  date not null,
  renewal_ends_on    date not null,
  status             text not null default 'proposed' check (status in ('proposed', 'accepted', 'declined', 'renewed', 'withdrawn')),
  proposed_by        uuid not null references core.users(id) on delete restrict,
  proposed_at        timestamptz not null default clock_timestamp(),
  channel            text check (channel is null or channel in ('email', 'whatsapp', 'signed_document', 'call_note', 'portal')),
  evidence_ref       text check (evidence_ref is null or length(btrim(evidence_ref)) > 0),
  client_contact     text,
  decision_reason    text,
  decision_recorded_by uuid references core.users(id) on delete restrict,
  decision_recorded_at timestamptz,
  confirmed_by       uuid references core.users(id) on delete restrict,
  confirmed_at       timestamptz,
  link_id            uuid references finance.maintenance_billing_links(id) on delete restrict,
  check (renewal_ends_on > renewal_starts_on),
  check (status not in ('accepted', 'renewed') or (evidence_ref is not null and client_contact is not null and decision_recorded_by is not null)),
  check (status <> 'declined' or length(btrim(coalesce(decision_reason, ''))) > 0),
  check (status <> 'renewed' or (confirmed_by is not null and confirmed_at is not null and link_id is not null and confirmed_by <> decision_recorded_by and confirmed_by <> proposed_by))
);
create unique index if not exists maintenance_one_live_renewal on projects.maintenance_plan_renewals (plan_id) where status in ('proposed', 'accepted');

-- cancellation: requested with a reason, confirmed by an independent Admin. The churn reason lives here.
create table if not exists projects.maintenance_plan_cancellations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  plan_id            uuid not null references projects.maintenance_plans(id) on delete restrict,
  reason_code        text not null check (reason_code in ('client_request', 'non_payment', 'scope_mismatch', 'price', 'service_issue', 'project_ended', 'other')),
  reason             text not null check (length(btrim(reason)) > 0 and length(reason) <= 2000),
  evidence_ref       text check (evidence_ref is null or length(btrim(evidence_ref)) > 0),
  status             text not null default 'requested' check (status in ('requested', 'confirmed', 'withdrawn')),
  requested_by       uuid not null references core.users(id) on delete restrict,
  requested_at       timestamptz not null default clock_timestamp(),
  decided_by         uuid references core.users(id) on delete restrict,
  decided_at         timestamptz,
  effective_on       date,
  check (status <> 'confirmed' or (decided_by is not null and decided_at is not null and effective_on is not null and decided_by <> requested_by)),
  check (status <> 'withdrawn' or (decided_by is not null and decided_at is not null))
);
create unique index if not exists maintenance_one_live_cancellation on projects.maintenance_plan_cancellations (plan_id) where status = 'requested';

-- ── guards ─────────────────────────────────────────────────────────────────────
create or replace function projects.maintenance_c_history_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a % record is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end $$;

-- a catalog version's content is frozen from creation; only its status moves, through the doors
create or replace function projects.maintenance_plan_catalog_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a catalog version is never deleted: retire it' using errcode = 'restrict_violation'; end if;
  if new.name is distinct from old.name or new.version is distinct from old.version or new.billing_model is distinct from old.billing_model
     or new.included_hours is distinct from old.included_hours or new.included_requests is distinct from old.included_requests
     or new.coverage is distinct from old.coverage or new.excluded_work is distinct from old.excluded_work or new.renewal_terms is distinct from old.renewal_terms
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'a catalog version is never edited: create the next version' using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status and not projects.p8c_sanctioned() then
    raise exception 'a catalog version is published and retired through its doors' using errcode = 'restrict_violation';
  end if;
  if old.status = 'retired' then raise exception 'a retired catalog version is history' using errcode = 'restrict_violation'; end if;
  if old.status = 'published' and new.status <> 'retired' then raise exception 'a published catalog version can only be retired' using errcode = 'restrict_violation'; end if;
  return new;
end $$;
drop trigger if exists maintenance_plan_catalog_guard on projects.maintenance_plan_catalog;
create trigger maintenance_plan_catalog_guard before update or delete on projects.maintenance_plan_catalog for each row execute function projects.maintenance_plan_catalog_guard();

-- price lines are entered on a DRAFT version only; after publication the price is part of what was published
create or replace function projects.maintenance_price_line_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  select c.status into v_status from projects.maintenance_plan_catalog c where c.id = new.catalog_id;
  if v_status is distinct from 'draft' then
    raise exception 'a price line is entered on a draft catalog version only; a published version''s prices are part of what was published' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_price_line_guard on projects.maintenance_plan_price_lines;
create trigger maintenance_price_line_guard before insert on projects.maintenance_plan_price_lines for each row execute function projects.maintenance_price_line_guard();

-- a plan that entered the lifecycle changes its state, period and acceptance through the doors only (the service role too)
create or replace function projects.maintenance_plan_lifecycle_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from projects.maintenance_plan_lifecycle l where l.plan_id = old.id) then return new; end if;
  if (new.status is distinct from old.status or new.accepted_proposal_id is distinct from old.accepted_proposal_id or new.accepted_at is distinct from old.accepted_at
      or new.starts_on is distinct from old.starts_on or new.ends_on is distinct from old.ends_on or new.ended_reason is distinct from old.ended_reason
      or new.name is distinct from old.name or new.version is distinct from old.version or new.billing_model is distinct from old.billing_model)
     and not projects.p8c_sanctioned() then
    raise exception 'a lifecycle maintenance plan moves through its doors (accept, activate, renew, cancel), never by an edit' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_plan_lifecycle_guard on projects.maintenance_plans;
create trigger maintenance_plan_lifecycle_guard before update on projects.maintenance_plans for each row execute function projects.maintenance_plan_lifecycle_guard();

-- the payment gate, for plans in the lifecycle: ACTIVE and RENEWED need the cycle's invoice paid on verified money or an approved, unexpired exception.
-- 20261105530000's trigger lets an UNBILLED plan through (the legacy rule); a lifecycle plan has no such exemption.
create or replace function projects.maintenance_plan_lifecycle_payment_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_gate record;
begin
  if new.status in ('active', 'renewed') and new.status is distinct from old.status
     and exists (select 1 from projects.maintenance_plan_lifecycle l where l.plan_id = new.id) then
    select * into v_gate from finance.maintenance_financial_gate(new.id);
    if v_gate.state is null or v_gate.state not in ('verified_paid', 'exception_approved') then
      raise exception 'a maintenance plan in the lifecycle does not become % until its cycle invoice is paid on verified money or an approved exception exists (now: %)', new.status, coalesce(v_gate.state, 'no invoice') using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists maintenance_plan_lifecycle_payment_gate on projects.maintenance_plans;
create trigger maintenance_plan_lifecycle_payment_gate before update of status on projects.maintenance_plans for each row execute function projects.maintenance_plan_lifecycle_payment_gate();

-- renewals and cancellations are mutated through their doors only; identity columns never change
create or replace function projects.maintenance_plan_renewals_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a renewal record is history' using errcode = 'restrict_violation'; end if;
  if new.plan_id is distinct from old.plan_id or new.price_proposal_id is distinct from old.price_proposal_id or new.renewal_starts_on is distinct from old.renewal_starts_on
     or new.renewal_ends_on is distinct from old.renewal_ends_on or new.proposed_by is distinct from old.proposed_by or new.proposed_at is distinct from old.proposed_at then
    raise exception 'a renewal proposal is not edited: withdraw it and propose another' using errcode = 'restrict_violation';
  end if;
  if old.status in ('declined', 'renewed', 'withdrawn') then raise exception 'a % renewal is closed history', old.status using errcode = 'restrict_violation'; end if;
  if new.status is distinct from old.status and not projects.p8c_sanctioned() then
    raise exception 'a renewal moves through its doors, never by an edit' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_plan_renewals_guard on projects.maintenance_plan_renewals;
create trigger maintenance_plan_renewals_guard before update or delete on projects.maintenance_plan_renewals for each row execute function projects.maintenance_plan_renewals_guard();

create or replace function projects.maintenance_plan_cancellations_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a cancellation record is history' using errcode = 'restrict_violation'; end if;
  if new.plan_id is distinct from old.plan_id or new.reason_code is distinct from old.reason_code or new.reason is distinct from old.reason
     or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at then
    raise exception 'a cancellation''s reason is not edited after it is requested' using errcode = 'restrict_violation';
  end if;
  if old.status in ('confirmed', 'withdrawn') then raise exception 'a % cancellation is closed history', old.status using errcode = 'restrict_violation'; end if;
  if new.status is distinct from old.status and not projects.p8c_sanctioned() then
    raise exception 'a cancellation moves through its doors, never by an edit' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_plan_cancellations_guard on projects.maintenance_plan_cancellations;
create trigger maintenance_plan_cancellations_guard before update or delete on projects.maintenance_plan_cancellations for each row execute function projects.maintenance_plan_cancellations_guard();

-- ── tenancy, RLS, grants, append-only ──────────────────────────────────────────
do $$
declare r record;
begin
  for r in select * from (values
    ('maintenance_plan_price_lines', 'catalog_id', 'projects.maintenance_plan_catalog'),
    ('maintenance_plan_lifecycle', 'plan_id', 'projects.maintenance_plans'), ('maintenance_plan_lifecycle', 'catalog_id', 'projects.maintenance_plan_catalog'), ('maintenance_plan_lifecycle', 'client_account_id', 'core.client_accounts'),
    ('maintenance_plan_acceptances', 'plan_id', 'projects.maintenance_plans'), ('maintenance_plan_acceptances', 'proposal_id', 'sales.proposals'), ('maintenance_plan_acceptances', 'client_account_id', 'core.client_accounts'),
    ('maintenance_plan_cycles', 'plan_id', 'projects.maintenance_plans'), ('maintenance_plan_cycles', 'link_id', 'finance.maintenance_billing_links'), ('maintenance_plan_cycles', 'client_account_id', 'core.client_accounts'),
    ('maintenance_usage_entries', 'plan_id', 'projects.maintenance_plans'), ('maintenance_usage_entries', 'cycle_id', 'projects.maintenance_plan_cycles'), ('maintenance_usage_entries', 'work_item_id', 'projects.maintenance_work_items'),
    ('maintenance_usage_entries', 'ticket_id', 'projects.maintenance_items'), ('maintenance_usage_entries', 'reverses_entry_id', 'projects.maintenance_usage_entries'), ('maintenance_usage_entries', 'client_account_id', 'core.client_accounts'),
    ('maintenance_overage_drafts', 'plan_id', 'projects.maintenance_plans'), ('maintenance_overage_drafts', 'cycle_id', 'projects.maintenance_plan_cycles'), ('maintenance_overage_drafts', 'price_line_id', 'projects.maintenance_plan_price_lines'), ('maintenance_overage_drafts', 'client_account_id', 'core.client_accounts'),
    ('maintenance_plan_renewals', 'plan_id', 'projects.maintenance_plans'), ('maintenance_plan_renewals', 'price_proposal_id', 'sales.proposals'), ('maintenance_plan_renewals', 'link_id', 'finance.maintenance_billing_links'), ('maintenance_plan_renewals', 'client_account_id', 'core.client_accounts'),
    ('maintenance_plan_cancellations', 'plan_id', 'projects.maintenance_plans'), ('maintenance_plan_cancellations', 'client_account_id', 'core.client_accounts')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_parent_org_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I on projects.%I for each row execute function core.enforce_parent_org(%L, %L)', r.tbl || '_parent_org_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['maintenance_plan_catalog', 'maintenance_plan_price_lines', 'maintenance_plan_lifecycle', 'maintenance_plan_acceptances', 'maintenance_plan_cycles',
                               'maintenance_usage_entries', 'maintenance_overage_drafts', 'maintenance_plan_renewals', 'maintenance_plan_cancellations']) as tbl loop
    execute format('alter table projects.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on projects.%I', r.tbl || '_read', r.tbl);
    execute format($p$create policy %I on projects.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$, r.tbl || '_read', r.tbl);
    execute format('revoke all on projects.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on projects.%I from authenticated', r.tbl);
    execute format('grant select on projects.%I to authenticated', r.tbl);
    execute format('grant all on projects.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on projects.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on projects.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
  for r in select unnest(array['maintenance_plan_price_lines', 'maintenance_plan_lifecycle', 'maintenance_plan_acceptances', 'maintenance_plan_cycles', 'maintenance_usage_entries', 'maintenance_overage_drafts']) as tbl loop
    execute format('drop trigger if exists %I on projects.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on projects.%I for each row execute function projects.maintenance_c_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

-- ═════════ the catalog doors ═════════
create or replace function projects.create_maintenance_catalog_version(
  p_name text, p_billing_model text, p_included_hours numeric default null, p_included_requests int default null,
  p_coverage text default null, p_excluded_work text default null, p_renewal_terms text default null)
returns table (outcome text, catalog_id uuid, version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_next int; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, 0; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid, 0; return; end if;
  if p_name is null or length(btrim(p_name)) = 0 or length(p_name) > 200 then return query select 'name_required'::text, null::uuid, 0; return; end if;
  if p_billing_model not in ('monthly', 'quarterly', 'annual', 'prepaid') then return query select 'bad_billing_model'::text, null::uuid, 0; return; end if;
  -- the entitlement is stated by the Admin; nothing here supplies a default
  if (p_included_hours is null and p_included_requests is null) or coalesce(p_included_hours, 1) <= 0 or coalesce(p_included_requests, 1) <= 0 then return query select 'entitlement_required'::text, null::uuid, 0; return; end if;
  if projects.p8c_has_secret(coalesce(p_coverage, '') || coalesce(p_excluded_work, '') || coalesce(p_renewal_terms, '')) then return query select 'secret_in_text'::text, null::uuid, 0; return; end if;
  perform pg_advisory_xact_lock(hashtext('maintenance_catalog:' || v_org::text || btrim(p_name)));
  select coalesce(max(c.version), 0) + 1 into v_next from projects.maintenance_plan_catalog c where c.organization_id = v_org and c.name = btrim(p_name);
  insert into projects.maintenance_plan_catalog (organization_id, name, version, billing_model, included_hours, included_requests, coverage, excluded_work, renewal_terms, created_by)
  values (v_org, btrim(p_name), v_next, p_billing_model, p_included_hours, p_included_requests, nullif(btrim(coalesce(p_coverage, '')), ''), nullif(btrim(coalesce(p_excluded_work, '')), ''), nullif(btrim(coalesce(p_renewal_terms, '')), ''), v_actor)
  returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_catalog.created', 'maintenance_plan_catalog', v_id, null, jsonb_build_object('name', btrim(p_name), 'version', v_next));
  return query select 'created'::text, v_id, v_next;
end $$;
revoke all on function projects.create_maintenance_catalog_version(text, text, numeric, int, text, text, text) from public, anon;
grant execute on function projects.create_maintenance_catalog_version(text, text, numeric, int, text, text, text) to authenticated;

create or replace function projects.add_maintenance_price_line(p_catalog_id uuid, p_label text, p_per text, p_amount_minor bigint, p_currency text)
returns table (outcome text, price_line_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.maintenance_plan_catalog; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_c from projects.maintenance_plan_catalog c where c.id = p_catalog_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_c.status <> 'draft' then return query select 'not_a_draft'::text, null::uuid; return; end if;
  if p_label is null or length(btrim(p_label)) = 0 or length(p_label) > 200 then return query select 'label_required'::text, null::uuid; return; end if;
  if p_per not in ('cycle', 'included_hour', 'overage_hour', 'overage_request') then return query select 'bad_unit'::text, null::uuid; return; end if;
  -- a rate for something the version does not entitle is a rate nobody can use
  if (p_per = 'overage_hour' and v_c.included_hours is null) or (p_per = 'overage_request' and v_c.included_requests is null) then return query select 'rate_for_an_unentitled_kind'::text, null::uuid; return; end if;
  if p_amount_minor is null or p_amount_minor < 0 then return query select 'bad_amount'::text, null::uuid; return; end if;
  if p_currency is null or upper(p_currency) !~ '^[A-Z]{3}$' then return query select 'bad_currency'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_plan_price_lines l where l.catalog_id = v_c.id and (l.label = btrim(p_label) or (p_per in ('overage_hour', 'overage_request') and l.per = p_per))) then
    return query select 'already_entered'::text, null::uuid; return;
  end if;
  insert into projects.maintenance_plan_price_lines (organization_id, catalog_id, label, per, amount_minor, currency, entered_by) values (v_org, v_c.id, btrim(p_label), p_per, p_amount_minor, upper(p_currency), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_catalog.price_line_entered', 'maintenance_plan_catalog', v_c.id, null, jsonb_build_object('label', btrim(p_label), 'per', p_per));
  return query select 'entered'::text, v_id;
end $$;
revoke all on function projects.add_maintenance_price_line(uuid, text, text, bigint, text) from public, anon;
grant execute on function projects.add_maintenance_price_line(uuid, text, text, bigint, text) to authenticated;

create or replace function projects.publish_maintenance_catalog_version(p_catalog_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.maintenance_plan_catalog;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_c from projects.maintenance_plan_catalog c where c.id = p_catalog_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  -- creator != approver: the author of a version does not publish it
  if v_c.created_by = v_actor then return query select 'author_cannot_publish'::text; return; end if;
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plan_catalog set status = 'published', published_by = v_actor, published_at = now() where id = v_c.id;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'maintenance_catalog.published', 'maintenance_plan_catalog', v_c.id, null, jsonb_build_object('name', v_c.name, 'version', v_c.version));
  return query select 'published'::text;
end $$;
revoke all on function projects.publish_maintenance_catalog_version(uuid) from public, anon;
grant execute on function projects.publish_maintenance_catalog_version(uuid) to authenticated;

create or replace function projects.retire_maintenance_catalog_version(p_catalog_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.maintenance_plan_catalog;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_c from projects.maintenance_plan_catalog c where c.id = p_catalog_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status <> 'published' then return query select 'not_published'::text; return; end if;
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plan_catalog set status = 'retired', retired_by = v_actor, retired_at = now() where id = v_c.id;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'maintenance_catalog.retired', 'maintenance_plan_catalog', v_c.id, null, jsonb_build_object('name', v_c.name, 'version', v_c.version));
  return query select 'retired'::text;
end $$;
revoke all on function projects.retire_maintenance_catalog_version(uuid) from public, anon;
grant execute on function projects.retire_maintenance_catalog_version(uuid) to authenticated;

-- ═════════ open a plan from a published version ═════════
create or replace function projects.open_maintenance_plan(p_project_id uuid, p_catalog_id uuid)
returns table (outcome text, plan_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_p projects.projects; v_c projects.maintenance_plan_catalog; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_p from projects.projects p where p.id = p_project_id and p.organization_id = v_org;
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_c from projects.maintenance_plan_catalog c where c.id = p_catalog_id and c.organization_id = v_org;
  if v_c.id is null then return query select 'catalog_not_found'::text, null::uuid; return; end if;
  if v_c.status <> 'published' then return query select 'catalog_not_published'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.handovers h where h.project_id = p_project_id and h.status in ('delivered', 'accepted')) then return query select 'no_handover'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_plans m where m.project_id = p_project_id and m.status not in ('expired', 'cancelled', 'declined')) then return query select 'project_has_a_live_plan'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_plans m where m.project_id = p_project_id and m.name = v_c.name and m.version = v_c.version) then return query select 'plan_exists_for_this_version'::text, null::uuid; return; end if;
  -- the period is NOT chosen here: it is the first paid cycle's, set at activation. Nothing is assumed about dates.
  insert into projects.maintenance_plans (organization_id, client_account_id, project_id, name, version, billing_model, coverage, excluded_work, renewal_terms, status, created_by)
  values (v_org, v_p.client_account_id, p_project_id, v_c.name, v_c.version, v_c.billing_model, v_c.coverage, v_c.excluded_work, v_c.renewal_terms, 'draft', v_actor)
  returning id into v_id;
  insert into projects.maintenance_plan_lifecycle (organization_id, client_account_id, plan_id, catalog_id, included_hours, included_requests, entered_by)
  values (v_org, v_p.client_account_id, v_id, v_c.id, v_c.included_hours, v_c.included_requests, v_actor);
  perform core.record_audit(v_org, 'maintenance_plan.opened', 'maintenance_plan', v_id, null, jsonb_build_object('projectId', p_project_id, 'catalog', v_c.name, 'version', v_c.version));
  return query select 'opened'::text, v_id;
end $$;
revoke all on function projects.open_maintenance_plan(uuid, uuid) from public, anon;
grant execute on function projects.open_maintenance_plan(uuid, uuid) to authenticated;

-- ═════════ the client's acceptance, recorded by staff with evidence ═════════
create or replace function projects.record_maintenance_plan_acceptance(p_plan_id uuid, p_decision text, p_proposal_id uuid, p_channel text, p_evidence_ref text, p_client_contact text, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.maintenance_plans; v_prop sales.proposals; v_opp_account uuid;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('accepted', 'declined') then return query select 'bad_decision'::text; return; end if;
  if p_channel not in ('email', 'whatsapp', 'signed_document', 'call_note', 'portal') then return query select 'bad_channel'::text; return; end if;
  -- the acceptance is evidenced by a REFERENCE to what the client said or signed; a client's word is not recorded without one
  if length(btrim(coalesce(p_evidence_ref, ''))) = 0 or length(btrim(coalesce(p_client_contact, ''))) = 0 then return query select 'evidence_required'::text; return; end if;
  if projects.p8c_has_secret(coalesce(p_evidence_ref, '') || ' ' || coalesce(p_reason, '')) then return query select 'secret_in_text'::text; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org for update;
  if v_plan.id is null or not exists (select 1 from projects.maintenance_plan_lifecycle l where l.plan_id = v_plan.id) then return query select 'not_found'::text; return; end if;
  if v_plan.status <> 'draft' then return query select 'wrong_state'::text; return; end if;
  if exists (select 1 from projects.maintenance_plan_acceptances a where a.plan_id = v_plan.id) then return query select 'already_decided'::text; return; end if;
  if p_decision = 'declined' then
    if length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text; return; end if;
    insert into projects.maintenance_plan_acceptances (organization_id, client_account_id, plan_id, decision, channel, evidence_ref, client_contact, reason, recorded_by)
    values (v_org, v_plan.client_account_id, v_plan.id, 'declined', p_channel, btrim(p_evidence_ref), btrim(p_client_contact), btrim(p_reason), v_actor);
    perform set_config('projects.p8c_sanctioned', 'on', true);
    update projects.maintenance_plans set status = 'declined', ended_reason = btrim(p_reason) where id = v_plan.id;
    perform set_config('projects.p8c_sanctioned', 'off', true);
    perform core.record_audit(v_org, 'maintenance_plan.declined', 'maintenance_plan', v_plan.id, null, jsonb_build_object('channel', p_channel));
    return query select 'declined'::text; return;
  end if;
  -- an accepted plan names the exact quote the client accepted (the price lives there, ADM-22), for this client, already accepted through the sales doors
  select * into v_prop from sales.proposals sp where sp.id = p_proposal_id and sp.organization_id = v_org;
  if v_prop.id is null then return query select 'proposal_not_found'::text; return; end if;
  select o.client_account_id into v_opp_account from sales.opportunities o where o.id = v_prop.opportunity_id;
  if v_opp_account is distinct from v_plan.client_account_id then return query select 'proposal_is_another_clients'::text; return; end if;
  if v_prop.status <> 'accepted' then return query select 'quote_not_accepted'::text; return; end if;
  insert into projects.maintenance_plan_acceptances (organization_id, client_account_id, plan_id, decision, proposal_id, channel, evidence_ref, client_contact, reason, recorded_by)
  values (v_org, v_plan.client_account_id, v_plan.id, 'accepted', v_prop.id, p_channel, btrim(p_evidence_ref), btrim(p_client_contact), nullif(btrim(coalesce(p_reason, '')), ''), v_actor);
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plans set accepted_proposal_id = v_prop.id, accepted_at = now() where id = v_plan.id;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'maintenance_plan.acceptance_recorded', 'maintenance_plan', v_plan.id, null, jsonb_build_object('channel', p_channel, 'proposalId', v_prop.id));
  return query select 'accepted'::text;
end $$;
revoke all on function projects.record_maintenance_plan_acceptance(uuid, text, uuid, text, text, text, text) from public, anon;
grant execute on function projects.record_maintenance_plan_acceptance(uuid, text, uuid, text, text, text, text) to authenticated;

-- ═════════ the payment gate: ACTIVE only when the first cycle is paid on verified money (or an owner-approved, expiring exception) ═════════
create or replace function projects.activate_maintenance_plan(p_plan_id uuid)
returns table (outcome text, gate_state text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.maintenance_plans; v_life projects.maintenance_plan_lifecycle;
  v_acc projects.maintenance_plan_acceptances; v_link finance.maintenance_billing_links; v_gate record;
begin
  if v_actor is null then return query select 'no_actor'::text, null::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::text; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org for update;
  select * into v_life from projects.maintenance_plan_lifecycle l where l.plan_id = p_plan_id;
  if v_plan.id is null or v_life.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v_plan.status <> 'draft' then return query select 'wrong_state'::text, null::text; return; end if;
  select * into v_acc from projects.maintenance_plan_acceptances a where a.plan_id = v_plan.id;
  if v_acc.id is null or v_acc.decision <> 'accepted' then return query select 'not_accepted'::text, null::text; return; end if;
  -- creator != approver: not the person who opened the plan or recorded the client's acceptance
  if v_actor = v_life.entered_by or v_actor = v_acc.recorded_by then return query select 'approver_is_the_author'::text, null::text; return; end if;
  select * into v_link from finance.maintenance_billing_links l where l.plan_id = v_plan.id and l.purpose = 'activation' and l.organization_id = v_org order by l.cycle_start asc limit 1;
  if v_link.id is null then return query select 'first_cycle_not_billed'::text, 'not_billed'::text; return; end if;
  -- the existing gate, and it must be ABOUT the first cycle's invoice
  select * into v_gate from finance.maintenance_financial_gate(v_plan.id);
  if v_gate.link_id is distinct from v_link.id or v_gate.state is null or v_gate.state not in ('verified_paid', 'exception_approved') then
    return query select 'first_cycle_not_paid'::text, coalesce(v_gate.state, 'not_billed'); return;
  end if;
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plans set status = 'active', starts_on = v_link.cycle_start, ends_on = v_link.cycle_end where id = v_plan.id;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  insert into projects.maintenance_plan_cycles (organization_id, client_account_id, plan_id, link_id, purpose, starts_on, ends_on, entitled_hours, entitled_requests, created_by)
  values (v_org, v_plan.client_account_id, v_plan.id, v_link.id, 'activation', v_link.cycle_start, v_link.cycle_end, v_life.included_hours, v_life.included_requests, v_actor);
  perform core.record_audit(v_org, 'maintenance_plan.activated', 'maintenance_plan', v_plan.id, jsonb_build_object('status', 'draft'), jsonb_build_object('status', 'active', 'gate', v_gate.state, 'cycleStart', v_link.cycle_start, 'cycleEnd', v_link.cycle_end));
  return query select 'activated'::text, v_gate.state::text;
end $$;
revoke all on function projects.activate_maintenance_plan(uuid) from public, anon;
grant execute on function projects.activate_maintenance_plan(uuid) to authenticated;

-- ═════════ the usage ledger ═════════
create or replace function projects.record_maintenance_usage(p_plan_id uuid, p_kind text, p_quantity numeric, p_occurred_on date, p_work_item_id uuid default null, p_ticket_id uuid default null, p_note text default null)
returns table (outcome text, entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.maintenance_plans; v_cycle projects.maintenance_plan_cycles;
  v_w projects.maintenance_work_items; v_t projects.maintenance_items; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('hours', 'request') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_quantity is null or p_quantity <= 0 or (p_kind = 'request' and p_quantity <> trunc(p_quantity)) then return query select 'bad_quantity'::text, null::uuid; return; end if;
  if p_occurred_on is null or p_occurred_on > current_date then return query select 'bad_date'::text, null::uuid; return; end if;
  if p_work_item_id is null and p_ticket_id is null then return query select 'name_a_ticket_or_work_item'::text, null::uuid; return; end if;
  if projects.p8c_has_secret(p_note) then return query select 'secret_in_text'::text, null::uuid; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org;
  if v_plan.id is null or not exists (select 1 from projects.maintenance_plan_lifecycle l where l.plan_id = v_plan.id) then return query select 'not_found'::text, null::uuid; return; end if;
  -- entitlement exists only while the plan is in force; an ended, declined or unpaid plan entitles nothing
  if v_plan.status not in ('active', 'renewed', 'renewal_approaching', 'renewal_proposed') then return query select 'plan_not_in_force'::text, null::uuid; return; end if;
  select * into v_cycle from projects.maintenance_plan_cycles c where c.plan_id = v_plan.id and p_occurred_on between c.starts_on and c.ends_on;
  if v_cycle.id is null then return query select 'no_paid_cycle_covers_that_date'::text, null::uuid; return; end if;
  if (p_kind = 'hours' and v_cycle.entitled_hours is null) or (p_kind = 'request' and v_cycle.entitled_requests is null) then return query select 'kind_not_in_the_entitlement'::text, null::uuid; return; end if;
  if p_work_item_id is not null then
    select * into v_w from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org and w.project_id = v_plan.project_id;
    if v_w.id is null then return query select 'work_item_not_found'::text, null::uuid; return; end if;
    if v_w.ticket_id is not null and exists (select 1 from projects.maintenance_items t where t.id = v_w.ticket_id and t.coverage = 'warranty') then return query select 'warranty_work_is_not_plan_usage'::text, null::uuid; return; end if;
  end if;
  if p_ticket_id is not null then
    select * into v_t from projects.maintenance_items t where t.id = p_ticket_id and t.organization_id = v_org and t.project_id = v_plan.project_id;
    if v_t.id is null then return query select 'ticket_not_found'::text, null::uuid; return; end if;
    -- warranty is the agency's own cost, not the client's entitlement
    if v_t.coverage = 'warranty' then return query select 'warranty_work_is_not_plan_usage'::text, null::uuid; return; end if;
  end if;
  insert into projects.maintenance_usage_entries (organization_id, client_account_id, plan_id, cycle_id, entry_kind, entry_type, quantity, occurred_on, work_item_id, ticket_id, note, recorded_by)
  values (v_org, v_plan.client_account_id, v_plan.id, v_cycle.id, p_kind, 'consumption', p_quantity, p_occurred_on, p_work_item_id, p_ticket_id, nullif(btrim(coalesce(p_note, '')), ''), v_actor)
  returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_usage.recorded', 'maintenance_usage_entry', v_id, null, jsonb_build_object('planId', v_plan.id, 'kind', p_kind, 'quantity', p_quantity));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_maintenance_usage(uuid, text, numeric, date, uuid, uuid, text) from public, anon;
grant execute on function projects.record_maintenance_usage(uuid, text, numeric, date, uuid, uuid, text) to authenticated;

-- a correction is a reversal entry, by someone other than the person who recorded the entry, with a reason
create or replace function projects.reverse_maintenance_usage(p_entry_id uuid, p_reason text)
returns table (outcome text, entry_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_e projects.maintenance_usage_entries; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text, null::uuid; return; end if;
  if projects.p8c_has_secret(p_reason) then return query select 'secret_in_text'::text, null::uuid; return; end if;
  select * into v_e from projects.maintenance_usage_entries u where u.id = p_entry_id and u.organization_id = v_org;
  if v_e.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_e.entry_type <> 'consumption' then return query select 'only_a_consumption_is_reversed'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_usage_entries u where u.reverses_entry_id = v_e.id) then return query select 'already_reversed'::text, null::uuid; return; end if;
  if v_e.recorded_by = v_actor then return query select 'self_reversal'::text, null::uuid; return; end if;
  insert into projects.maintenance_usage_entries (organization_id, client_account_id, plan_id, cycle_id, entry_kind, entry_type, quantity, occurred_on, reverses_entry_id, note, recorded_by)
  values (v_org, v_e.client_account_id, v_e.plan_id, v_e.cycle_id, v_e.entry_kind, 'reversal', v_e.quantity, v_e.occurred_on, v_e.id, btrim(p_reason), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_usage.reversed', 'maintenance_usage_entry', v_id, null, jsonb_build_object('reverses', v_e.id));
  return query select 'reversed'::text, v_id;
end $$;
revoke all on function projects.reverse_maintenance_usage(uuid, text) from public, anon;
grant execute on function projects.reverse_maintenance_usage(uuid, text) to authenticated;

-- entitlement, usage and overage of one cycle, computed (never stored): the same function the Admin and the client read from
create or replace function projects.maintenance_cycle_usage(p_cycle_id uuid)
returns table (cycle_id uuid, entitled_hours numeric, used_hours numeric, overage_hours numeric, entitled_requests int, used_requests numeric, overage_requests numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_c projects.maintenance_plan_cycles; v_h numeric; v_r numeric;
begin
  select * into v_c from projects.maintenance_plan_cycles c where c.id = p_cycle_id;
  if v_c.id is null then return; end if;
  if coalesce((select auth.role()), '') <> 'service_role'
     and not (v_c.organization_id = (select core.current_organization_id()) and ((select core.is_internal()) or (select core.current_client_account_id()) = v_c.client_account_id)) then return; end if;
  select coalesce(sum(case u.entry_type when 'consumption' then u.quantity else -u.quantity end) filter (where u.entry_kind = 'hours'), 0),
         coalesce(sum(case u.entry_type when 'consumption' then u.quantity else -u.quantity end) filter (where u.entry_kind = 'request'), 0)
    into v_h, v_r from projects.maintenance_usage_entries u where u.cycle_id = v_c.id;
  return query select v_c.id, v_c.entitled_hours, v_h, case when v_c.entitled_hours is null then null else greatest(v_h - v_c.entitled_hours, 0) end,
                      v_c.entitled_requests, v_r, case when v_c.entitled_requests is null then null else greatest(v_r - v_c.entitled_requests, 0) end;
end $$;
revoke all on function projects.maintenance_cycle_usage(uuid) from public, anon;
grant execute on function projects.maintenance_cycle_usage(uuid) to authenticated, service_role;

-- an overage DRAFT: priced only from a rate a person entered on the plan's catalog version, or not priced at all. Never billed from here.
create or replace function projects.draft_maintenance_overage(p_cycle_id uuid, p_kind text)
returns table (outcome text, draft_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.maintenance_plan_cycles; v_u record; v_life projects.maintenance_plan_lifecycle;
  v_line projects.maintenance_plan_price_lines; v_over numeric; v_ent numeric; v_used numeric; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('hours', 'request') then return query select 'bad_kind'::text, null::uuid; return; end if;
  select * into v_c from projects.maintenance_plan_cycles c where c.id = p_cycle_id and c.organization_id = v_org;
  if v_c.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_u from projects.maintenance_cycle_usage(v_c.id);
  if p_kind = 'hours' then v_over := v_u.overage_hours; v_ent := v_u.entitled_hours; v_used := v_u.used_hours;
  else v_over := v_u.overage_requests; v_ent := v_u.entitled_requests; v_used := v_u.used_requests; end if;
  if v_over is null then return query select 'kind_not_in_the_entitlement'::text, null::uuid; return; end if;
  if v_over <= 0 then return query select 'no_overage'::text, null::uuid; return; end if;
  select * into v_life from projects.maintenance_plan_lifecycle l where l.plan_id = v_c.plan_id;
  select * into v_line from projects.maintenance_plan_price_lines l where l.catalog_id = v_life.catalog_id and l.per = case p_kind when 'hours' then 'overage_hour' else 'overage_request' end;
  insert into projects.maintenance_overage_drafts (organization_id, client_account_id, plan_id, cycle_id, entry_kind, overage_quantity, entitled_quantity, used_quantity, price_line_id, unit_rate_minor, currency, amount_minor, created_by)
  values (v_org, v_c.client_account_id, v_c.plan_id, v_c.id, p_kind, v_over, v_ent, v_used, v_line.id, v_line.amount_minor, v_line.currency, case when v_line.id is null then null else round(v_over * v_line.amount_minor)::bigint end, v_actor)
  on conflict (cycle_id, entry_kind, overage_quantity) do nothing returning id into v_id;
  if v_id is null then return query select 'already_drafted'::text, null::uuid; return; end if;
  perform core.record_audit(v_org, 'maintenance_overage.drafted', 'maintenance_overage_draft', v_id, null, jsonb_build_object('cycleId', v_c.id, 'kind', p_kind, 'overage', v_over));
  return query select 'drafted'::text, v_id;
end $$;
revoke all on function projects.draft_maintenance_overage(uuid, text) from public, anon;
grant execute on function projects.draft_maintenance_overage(uuid, text) to authenticated;

-- ═════════ renewal: proposed, accepted by the client (recorded by staff), paid, confirmed by an independent Admin ═════════
create or replace function projects.propose_maintenance_renewal(p_plan_id uuid, p_new_ends_on date, p_price_proposal_id uuid)
returns table (outcome text, renewal_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.maintenance_plans; v_prop sales.proposals; v_acct uuid; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org for update;
  if v_plan.id is null or not exists (select 1 from projects.maintenance_plan_lifecycle l where l.plan_id = v_plan.id) then return query select 'not_found'::text, null::uuid; return; end if;
  if v_plan.status not in ('active', 'renewed', 'renewal_approaching') then return query select 'wrong_state'::text, null::uuid; return; end if;
  -- an ended period is not renewed by a proposal: the plan lapses honestly and a new acceptance starts a new plan
  if v_plan.ends_on is null or v_plan.ends_on < current_date then return query select 'plan_lapsed'::text, null::uuid; return; end if;
  if p_new_ends_on is null or p_new_ends_on <= v_plan.ends_on + 1 then return query select 'bad_period'::text, null::uuid; return; end if;
  select * into v_prop from sales.proposals sp where sp.id = p_price_proposal_id and sp.organization_id = v_org;
  if v_prop.id is null then return query select 'proposal_not_found'::text, null::uuid; return; end if;
  select o.client_account_id into v_acct from sales.opportunities o where o.id = v_prop.opportunity_id;
  if v_acct is distinct from v_plan.client_account_id then return query select 'proposal_is_another_clients'::text, null::uuid; return; end if;
  if v_prop.status not in ('approved', 'sent', 'accepted') then return query select 'quote_not_approved'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_plan_renewals r where r.plan_id = v_plan.id and r.status in ('proposed', 'accepted')) then return query select 'renewal_already_open'::text, null::uuid; return; end if;
  insert into projects.maintenance_plan_renewals (organization_id, client_account_id, plan_id, price_proposal_id, renewal_starts_on, renewal_ends_on, proposed_by)
  values (v_org, v_plan.client_account_id, v_plan.id, v_prop.id, v_plan.ends_on + 1, p_new_ends_on, v_actor) returning id into v_id;
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plans set status = 'renewal_proposed' where id = v_plan.id;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'maintenance_renewal.proposed', 'maintenance_plan', v_plan.id, jsonb_build_object('status', v_plan.status), jsonb_build_object('status', 'renewal_proposed', 'renewalId', v_id));
  return query select 'proposed'::text, v_id;
end $$;
revoke all on function projects.propose_maintenance_renewal(uuid, date, uuid) from public, anon;
grant execute on function projects.propose_maintenance_renewal(uuid, date, uuid) to authenticated;

create or replace function projects.record_maintenance_renewal_decision(p_renewal_id uuid, p_decision text, p_channel text, p_evidence_ref text, p_client_contact text, p_reason text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.maintenance_plan_renewals; v_prop sales.proposals; v_plan projects.maintenance_plans;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('accepted', 'declined', 'withdrawn') then return query select 'bad_decision'::text; return; end if;
  if p_channel not in ('email', 'whatsapp', 'signed_document', 'call_note', 'portal') then return query select 'bad_channel'::text; return; end if;
  if length(btrim(coalesce(p_evidence_ref, ''))) = 0 or length(btrim(coalesce(p_client_contact, ''))) = 0 then return query select 'evidence_required'::text; return; end if;
  if projects.p8c_has_secret(coalesce(p_evidence_ref, '') || ' ' || coalesce(p_reason, '')) then return query select 'secret_in_text'::text; return; end if;
  if p_decision <> 'accepted' and length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text; return; end if;
  select * into v_r from projects.maintenance_plan_renewals r where r.id = p_renewal_id and r.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.status <> 'proposed' then return query select 'wrong_state'::text; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = v_r.plan_id for update;
  if p_decision = 'accepted' then
    select * into v_prop from sales.proposals sp where sp.id = v_r.price_proposal_id;
    if v_prop.id is null or v_prop.status <> 'accepted' then return query select 'quote_not_accepted'::text; return; end if;
    perform set_config('projects.p8c_sanctioned', 'on', true);
    update projects.maintenance_plan_renewals set status = 'accepted', channel = p_channel, evidence_ref = btrim(p_evidence_ref), client_contact = btrim(p_client_contact), decision_reason = nullif(btrim(coalesce(p_reason, '')), ''),
           decision_recorded_by = v_actor, decision_recorded_at = now() where id = v_r.id;
    perform set_config('projects.p8c_sanctioned', 'off', true);
    perform core.record_audit(v_org, 'maintenance_renewal.accepted', 'maintenance_plan', v_r.plan_id, null, jsonb_build_object('renewalId', v_r.id, 'channel', p_channel));
    return query select 'accepted'::text; return;
  end if;
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plan_renewals set status = p_decision, channel = p_channel, evidence_ref = btrim(p_evidence_ref), client_contact = btrim(p_client_contact), decision_reason = btrim(p_reason),
         decision_recorded_by = v_actor, decision_recorded_at = now() where id = v_r.id;
  -- the plan runs to its end date and then lapses honestly (the 8A sweep); nothing extends it
  if v_plan.status = 'renewal_proposed' then update projects.maintenance_plans set status = 'renewal_approaching' where id = v_plan.id; end if;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'maintenance_renewal.' || p_decision, 'maintenance_plan', v_r.plan_id, null, jsonb_build_object('renewalId', v_r.id, 'channel', p_channel));
  return query select p_decision;
end $$;
revoke all on function projects.record_maintenance_renewal_decision(uuid, text, text, text, text, text) from public, anon;
grant execute on function projects.record_maintenance_renewal_decision(uuid, text, text, text, text, text) to authenticated;

create or replace function projects.confirm_maintenance_renewal(p_renewal_id uuid)
returns table (outcome text, gate_state text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.maintenance_plan_renewals; v_plan projects.maintenance_plans;
  v_life projects.maintenance_plan_lifecycle; v_link finance.maintenance_billing_links; v_gate record;
begin
  if v_actor is null then return query select 'no_actor'::text, null::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::text; return; end if;
  select * into v_r from projects.maintenance_plan_renewals r where r.id = p_renewal_id and r.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v_r.status <> 'accepted' then return query select 'not_accepted'::text, null::text; return; end if;
  -- creator != approver: not the person who proposed it or recorded the client's acceptance
  if v_actor = v_r.proposed_by or v_actor = v_r.decision_recorded_by then return query select 'approver_is_the_author'::text, null::text; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = v_r.plan_id for update;
  select * into v_life from projects.maintenance_plan_lifecycle l where l.plan_id = v_r.plan_id;
  if v_plan.status <> 'renewal_proposed' then return query select 'plan_not_awaiting_renewal'::text, null::text; return; end if;
  -- a plan that lapsed is not revived by a late payment
  if v_plan.ends_on is null or v_plan.ends_on < current_date then return query select 'plan_lapsed'::text, null::text; return; end if;
  select * into v_link from finance.maintenance_billing_links l where l.plan_id = v_plan.id and l.purpose = 'renewal' and l.cycle_start = v_r.renewal_starts_on and l.organization_id = v_org;
  if v_link.id is null or v_link.cycle_end <> v_r.renewal_ends_on then return query select 'renewal_cycle_not_billed'::text, 'not_billed'::text; return; end if;
  select * into v_gate from finance.maintenance_financial_gate(v_plan.id);
  if v_gate.link_id is distinct from v_link.id or v_gate.state is null or v_gate.state not in ('verified_paid', 'exception_approved') then
    return query select 'renewal_not_paid'::text, coalesce(v_gate.state, 'not_billed'); return;
  end if;
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plans set status = 'renewed', ends_on = v_r.renewal_ends_on where id = v_plan.id;
  update projects.maintenance_plan_renewals set status = 'renewed', confirmed_by = v_actor, confirmed_at = now(), link_id = v_link.id where id = v_r.id;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  insert into projects.maintenance_plan_cycles (organization_id, client_account_id, plan_id, link_id, purpose, starts_on, ends_on, entitled_hours, entitled_requests, created_by)
  values (v_org, v_plan.client_account_id, v_plan.id, v_link.id, 'renewal', v_r.renewal_starts_on, v_r.renewal_ends_on, v_life.included_hours, v_life.included_requests, v_actor);
  perform core.record_audit(v_org, 'maintenance_renewal.confirmed', 'maintenance_plan', v_plan.id, jsonb_build_object('status', 'renewal_proposed', 'endsOn', v_plan.ends_on), jsonb_build_object('status', 'renewed', 'endsOn', v_r.renewal_ends_on, 'gate', v_gate.state));
  return query select 'renewed'::text, v_gate.state::text;
end $$;
revoke all on function projects.confirm_maintenance_renewal(uuid) from public, anon;
grant execute on function projects.confirm_maintenance_renewal(uuid) to authenticated;

-- ═════════ cancellation and churn ═════════
create or replace function projects.request_maintenance_plan_cancellation(p_plan_id uuid, p_reason_code text, p_reason text, p_evidence_ref text default null)
returns table (outcome text, cancellation_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.maintenance_plans; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_reason_code not in ('client_request', 'non_payment', 'scope_mismatch', 'price', 'service_issue', 'project_ended', 'other') then return query select 'bad_reason_code'::text, null::uuid; return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text, null::uuid; return; end if;
  if projects.p8c_has_secret(coalesce(p_reason, '') || ' ' || coalesce(p_evidence_ref, '')) then return query select 'secret_in_text'::text, null::uuid; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org for update;
  if v_plan.id is null or not exists (select 1 from projects.maintenance_plan_lifecycle l where l.plan_id = v_plan.id) then return query select 'not_found'::text, null::uuid; return; end if;
  if v_plan.status not in ('active', 'renewed', 'renewal_approaching', 'renewal_proposed', 'paused', 'at_risk') then return query select 'wrong_state'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_plan_cancellations c where c.plan_id = v_plan.id and c.status = 'requested') then return query select 'cancellation_already_requested'::text, null::uuid; return; end if;
  insert into projects.maintenance_plan_cancellations (organization_id, client_account_id, plan_id, reason_code, reason, evidence_ref, requested_by)
  values (v_org, v_plan.client_account_id, v_plan.id, p_reason_code, btrim(p_reason), nullif(btrim(coalesce(p_evidence_ref, '')), ''), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_plan.cancellation_requested', 'maintenance_plan', v_plan.id, null, jsonb_build_object('reasonCode', p_reason_code));
  return query select 'requested'::text, v_id;
end $$;
revoke all on function projects.request_maintenance_plan_cancellation(uuid, text, text, text) from public, anon;
grant execute on function projects.request_maintenance_plan_cancellation(uuid, text, text, text) to authenticated;

create or replace function projects.decide_maintenance_plan_cancellation(p_cancellation_id uuid, p_decision text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_c projects.maintenance_plan_cancellations; v_plan projects.maintenance_plans; v_end date;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('confirm', 'withdraw') then return query select 'bad_decision'::text; return; end if;
  select * into v_c from projects.maintenance_plan_cancellations c where c.id = p_cancellation_id and c.organization_id = v_org for update;
  if v_c.id is null then return query select 'not_found'::text; return; end if;
  if v_c.status <> 'requested' then return query select 'wrong_state'::text; return; end if;
  if p_decision = 'withdraw' then
    perform set_config('projects.p8c_sanctioned', 'on', true);
    update projects.maintenance_plan_cancellations set status = 'withdrawn', decided_by = v_actor, decided_at = now() where id = v_c.id;
    perform set_config('projects.p8c_sanctioned', 'off', true);
    perform core.record_audit(v_org, 'maintenance_plan.cancellation_withdrawn', 'maintenance_plan', v_c.plan_id, null, jsonb_build_object('cancellationId', v_c.id));
    return query select 'withdrawn'::text; return;
  end if;
  -- creator != approver: entitlement is ended by someone other than whoever asked
  if v_c.requested_by = v_actor then return query select 'requester_cannot_confirm'::text; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = v_c.plan_id for update;
  if v_plan.status not in ('active', 'renewed', 'renewal_approaching', 'renewal_proposed', 'paused', 'at_risk') then return query select 'plan_not_in_force'::text; return; end if;
  -- entitlement ends the day this is confirmed (never backdated, never refunded here): the period is cut to today, but not before it began
  v_end := least(coalesce(v_plan.ends_on, current_date), greatest(current_date, coalesce(v_plan.starts_on, current_date)));
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plans set status = 'cancelled', ended_reason = v_c.reason_code || ': ' || v_c.reason, ends_on = v_end where id = v_plan.id;
  update projects.maintenance_plan_cancellations set status = 'confirmed', decided_by = v_actor, decided_at = now(), effective_on = current_date where id = v_c.id;
  update projects.maintenance_plan_renewals set status = 'withdrawn', decision_reason = 'the plan was cancelled' where plan_id = v_plan.id and status in ('proposed', 'accepted');
  perform set_config('projects.p8c_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'maintenance_plan.cancelled', 'maintenance_plan', v_plan.id, jsonb_build_object('status', v_plan.status), jsonb_build_object('status', 'cancelled', 'reasonCode', v_c.reason_code));
  return query select 'confirmed'::text;
end $$;
revoke all on function projects.decide_maintenance_plan_cancellation(uuid, text) from public, anon;
grant execute on function projects.decide_maintenance_plan_cancellation(uuid, text) to authenticated;

-- churn reasons: confirmed cancellations and lapsed plans, counted by the reason someone recorded. Internal only.
create or replace function projects.maintenance_churn_summary(p_since date default null)
returns table (reason_code text, plans bigint)
language sql stable security definer set search_path = '' as $$
  select c.reason_code, count(*)::bigint
    from projects.maintenance_plan_cancellations c
   where c.organization_id = (select core.current_organization_id()) and (select core.is_internal()) and c.status = 'confirmed' and (p_since is null or c.effective_on >= p_since)
   group by c.reason_code order by 2 desc, 1;
$$;
revoke all on function projects.maintenance_churn_summary(date) from public, anon;
grant execute on function projects.maintenance_churn_summary(date) to authenticated;

-- ═════════ the gate keeps holding: an exception that expired while the invoice stayed unpaid takes the entitlement away ═════════
create or replace function projects.sweep_maintenance_plan_payment_gates(p_organization_id uuid default null)
returns table (checked int, flagged int)
language plpgsql security definer set search_path = '' as $$
declare r record; v_gate record; v_cur finance.maintenance_billing_links; v_checked int := 0; v_flag int := 0;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;
  for r in select m.* from projects.maintenance_plans m join projects.maintenance_plan_lifecycle l on l.plan_id = m.id
            where (p_organization_id is null or m.organization_id = p_organization_id) and m.status in ('active', 'renewed') order by m.id for update of m skip locked loop
    v_checked := v_checked + 1;
    -- the CURRENT cycle's link: a renewal invoice that is still unpaid is not a reason to doubt the cycle that is already paid
    select l.* into v_cur from finance.maintenance_billing_links l join projects.maintenance_plan_cycles c on c.link_id = l.id where c.plan_id = r.id order by c.starts_on desc limit 1;
    select * into v_gate from finance.maintenance_financial_gate(r.id);
    if v_cur.id is not null and v_gate.link_id = v_cur.id and v_gate.state not in ('verified_paid', 'exception_approved') then
      perform set_config('projects.p8c_sanctioned', 'on', true);
      update projects.maintenance_plans set status = 'at_risk' where id = r.id;
      perform set_config('projects.p8c_sanctioned', 'off', true);
      perform core.record_audit(r.organization_id, 'maintenance_plan.payment_gate_lapsed', 'maintenance_plan', r.id, jsonb_build_object('status', r.status), jsonb_build_object('status', 'at_risk', 'gate', v_gate.state));
      v_flag := v_flag + 1;
    end if;
  end loop;
  return query select v_checked, v_flag;
end $$;
revoke all on function projects.sweep_maintenance_plan_payment_gates(uuid) from public, anon, authenticated;
grant execute on function projects.sweep_maintenance_plan_payment_gates(uuid) to service_role;

create or replace function projects.reinstate_maintenance_plan(p_plan_id uuid)
returns table (outcome text, gate_state text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_plan projects.maintenance_plans; v_gate record; v_cur finance.maintenance_billing_links;
begin
  if v_actor is null then return query select 'no_actor'::text, null::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::text; return; end if;
  select * into v_plan from projects.maintenance_plans m where m.id = p_plan_id and m.organization_id = v_org for update;
  if v_plan.id is null or not exists (select 1 from projects.maintenance_plan_lifecycle l where l.plan_id = v_plan.id) then return query select 'not_found'::text, null::text; return; end if;
  if v_plan.status <> 'at_risk' then return query select 'wrong_state'::text, null::text; return; end if;
  if v_plan.ends_on is null or v_plan.ends_on < current_date then return query select 'plan_lapsed'::text, null::text; return; end if;
  select l.* into v_cur from finance.maintenance_billing_links l join projects.maintenance_plan_cycles c on c.link_id = l.id where c.plan_id = v_plan.id order by c.starts_on desc limit 1;
  select * into v_gate from finance.maintenance_financial_gate(v_plan.id);
  if v_cur.id is null or v_gate.link_id is distinct from v_cur.id or v_gate.state not in ('verified_paid', 'exception_approved') then return query select 'cycle_not_paid'::text, coalesce(v_gate.state, 'not_billed'); return; end if;
  perform set_config('projects.p8c_sanctioned', 'on', true);
  update projects.maintenance_plans set status = 'active' where id = v_plan.id;
  perform set_config('projects.p8c_sanctioned', 'off', true);
  perform core.record_audit(v_org, 'maintenance_plan.reinstated', 'maintenance_plan', v_plan.id, jsonb_build_object('status', 'at_risk'), jsonb_build_object('status', 'active', 'gate', v_gate.state));
  return query select 'reinstated'::text, v_gate.state::text;
end $$;
revoke all on function projects.reinstate_maintenance_plan(uuid) from public, anon;
grant execute on function projects.reinstate_maintenance_plan(uuid) to authenticated;

-- ═════════ reads ═════════
-- the Admin's overview of a project's lifecycle plans: stage facts, the payment gate, the current cycle's usage
create or replace function projects.maintenance_plan_overview(p_project_id uuid)
returns table (plan_id uuid, name text, version int, status text, starts_on date, ends_on date, accepted boolean, gate_state text, gate_detail text,
               cycle_id uuid, cycle_starts_on date, cycle_ends_on date, entitled_hours numeric, used_hours numeric, overage_hours numeric,
               entitled_requests int, used_requests numeric, overage_requests numeric, open_renewal_status text, open_cancellation_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare r record; v_gate record; v_cycle projects.maintenance_plan_cycles; v_ren text; v_can uuid; v_eh numeric; v_uh numeric; v_oh numeric; v_er int; v_ur numeric; v_or numeric;
begin
  if not coalesce((select core.is_internal()), false) then return; end if;
  for r in select m.* from projects.maintenance_plans m join projects.maintenance_plan_lifecycle l on l.plan_id = m.id
            where m.project_id = p_project_id and m.organization_id = (select core.current_organization_id()) order by m.created_at desc loop
    select * into v_gate from finance.maintenance_financial_gate(r.id);
    select * into v_cycle from projects.maintenance_plan_cycles c where c.plan_id = r.id order by (current_date between c.starts_on and c.ends_on) desc, c.starts_on desc limit 1;
    v_eh := null; v_uh := null; v_oh := null; v_er := null; v_ur := null; v_or := null;
    if v_cycle.id is not null then select u.entitled_hours, u.used_hours, u.overage_hours, u.entitled_requests, u.used_requests, u.overage_requests into v_eh, v_uh, v_oh, v_er, v_ur, v_or from projects.maintenance_cycle_usage(v_cycle.id) u; end if;
    select re.status into v_ren from projects.maintenance_plan_renewals re where re.plan_id = r.id and re.status in ('proposed', 'accepted') limit 1;
    select ca.id into v_can from projects.maintenance_plan_cancellations ca where ca.plan_id = r.id and ca.status = 'requested' limit 1;
    return query select r.id, r.name, r.version, r.status, r.starts_on, r.ends_on, r.accepted_at is not null, v_gate.state, v_gate.detail,
                        v_cycle.id, v_cycle.starts_on, v_cycle.ends_on, v_eh, v_uh, v_oh, v_er, v_ur, v_or, v_ren, v_can;
  end loop;
end $$;
revoke all on function projects.maintenance_plan_overview(uuid) from public, anon;
grant execute on function projects.maintenance_plan_overview(uuid) to authenticated;

-- ── client-safe reads: the caller's OWN account only, plain facts only ─────────────
-- no internal reason, work item, price, exception, draft or cancellation reason is returned
create or replace function projects.client_maintenance_plans(p_project_id uuid default null)
returns table (plan_id uuid, plan_name text, status_label text, billing_model text, starts_on date, ends_on date,
               cycle_id uuid, cycle_starts_on date, cycle_ends_on date, entitled_hours numeric, used_hours numeric, entitled_requests int, used_requests numeric,
               hours_beyond_included numeric, requests_beyond_included numeric)
language plpgsql stable security definer set search_path = '' as $$
declare v_acct uuid := (select core.current_client_account_id()); v_org uuid := (select core.current_organization_id()); r record; v_cycle projects.maintenance_plan_cycles; v_eh numeric; v_uh numeric; v_oh numeric; v_er int; v_ur numeric; v_or numeric;
begin
  if not coalesce((select core.is_client()), false) or v_acct is null or v_org is null then return; end if;
  for r in select m.* from projects.maintenance_plans m join projects.maintenance_plan_lifecycle l on l.plan_id = m.id
            where m.client_account_id = v_acct and m.organization_id = v_org and (p_project_id is null or m.project_id = p_project_id)
              and m.status not in ('draft', 'declined') order by m.created_at desc loop
    select * into v_cycle from projects.maintenance_plan_cycles c where c.plan_id = r.id order by (current_date between c.starts_on and c.ends_on) desc, c.starts_on desc limit 1;
    v_eh := null; v_uh := null; v_oh := null; v_er := null; v_ur := null; v_or := null;
    if v_cycle.id is not null then select u.entitled_hours, u.used_hours, u.overage_hours, u.entitled_requests, u.used_requests, u.overage_requests into v_eh, v_uh, v_oh, v_er, v_ur, v_or from projects.maintenance_cycle_usage(v_cycle.id) u; end if;
    return query select r.id, r.name,
      case r.status when 'active' then 'Active' when 'renewed' then 'Active' when 'renewal_approaching' then 'Active, renewal coming up' when 'renewal_proposed' then 'Renewal proposed'
                    when 'pending_client' then 'Waiting for your decision' when 'expired' then 'Ended' when 'cancelled' then 'Cancelled' when 'paused' then 'Paused'
                    when 'at_risk' then 'Your project contact is reviewing this plan' else 'In progress' end,
      r.billing_model, r.starts_on, r.ends_on, v_cycle.id, v_cycle.starts_on, v_cycle.ends_on, v_eh, v_uh, v_er, v_ur, v_oh, v_or;
  end loop;
end $$;
revoke all on function projects.client_maintenance_plans(uuid) from public, anon;
grant execute on function projects.client_maintenance_plans(uuid) to authenticated;

create or replace function projects.client_maintenance_usage(p_plan_id uuid)
returns table (occurred_on date, entry_kind text, entry_type text, quantity numeric)
language sql stable security definer set search_path = '' as $$
  select u.occurred_on, u.entry_kind, u.entry_type, u.quantity
    from projects.maintenance_usage_entries u
   where u.plan_id = p_plan_id and (select core.is_client()) and u.client_account_id = (select core.current_client_account_id()) and u.organization_id = (select core.current_organization_id())
   order by u.occurred_on desc, u.recorded_at desc limit 500;
$$;
revoke all on function projects.client_maintenance_usage(uuid) from public, anon;
grant execute on function projects.client_maintenance_usage(uuid) to authenticated;

notify pgrst, 'reload schema';
