-- ═══════════════════════════════════════════════════════════════════════════
-- Maintenance is specified after all.
--
-- `20260814120010_work_that_comes_after_handover.sql` opens with a claim:
--
--   *"The business documentation defines maintenance **nowhere**. The word
--   appears exactly once in the whole of `docs/business-os`, in one arrow:
--   delivery → handover → completed → maintenance → repeat business. That is
--   the entire specification, and this migration is deliberately no larger
--   than it."*
--
-- That was the right instinct against the wrong corpus. **Document 18 is
-- twelve pages of it** — plans (§3), plan components (§4), eligibility (§5),
-- the warranty/maintenance/change-request boundary (§6), the request
-- lifecycle (§7), twelve ticket types (§8), renewals (§9) and their state
-- machine (§10). G-034 was measured against `docs/business-os` and never
-- against the specification, so the deliberate minimalism was calibrated to a
-- single arrow.
--
-- Being minimal was still correct: it added no price, no SLA, no due date, no
-- tier, and every one of those refusals holds up against Doc 18. This adds
-- only what Doc 18 states, and keeps every one of them.
--
-- ── the rule this is really about ────────────────────────────────────────
--
-- §35: **"Never classify new scope as maintenance to avoid approval."**
-- §18: **"Do not label a bug as a paid feature."**
-- §7:  *"Out-of-scope work becomes a Change Request or commercial
--      opportunity."*
--
-- Those are the same rule pointing in two directions, and both directions
-- cost somebody money. New scope filed as maintenance is work the agency does
-- for free and never quotes. A warranty defect filed as paid work is a client
-- charged for a promise already made. §6 draws the line and this makes the
-- line load-bearing: **a ticket's classification decides which exit it may
-- take, and the exits already exist.**
--
--   warranty, maintenance   →  closed inside maintenance, and may NOT name a
--                              change request. A covered defect is not a sale.
--   change_request,
--   new_project             →  may not close until it names a row in
--                              `projects.change_requests` — which Doc 11
--                              already refuses to approve as a paid change
--                              without a `sales.proposals` row behind it.
--   upsell                  →  may not close until it names a row in
--                              `sales.upsell_signals`, which is how the team
--                              is told rather than the client being sold to.
--
-- Nothing new was invented to make that true. Doc 11's change requests, Doc
-- 15's proposals and G-036's upsell signals were all already here; what was
-- missing is that a maintenance ticket had no way to say which of them it
-- belonged to, so every ticket was implicitly covered.
--
-- ── what is deliberately absent, and each has a citation ────────────────
--
-- **A plan has no price column.** Doc 18 §3 says a plan has a price. ADM-22
-- says *"There is no price catalog. Every price is quoted per client by a
-- human."* A tiered plan carrying a price IS a price catalog, so the granted
-- decision wins and the price lives where every other price in this system
-- lives — on a `sales.proposals` row referencing the plan version. Doc 11's
-- change requests were resolved the same way and for the same reason.
--
-- **There is no health score and no health status.** Doc 18 §12 lists the
-- signals and then says *"Each signal should have configurable weight."*
-- Nobody has configured any weight. §35 adds *"Never fabricate client
-- satisfaction"* and *"Never invent usage."* So `account_health_signals`
-- returns the recorded signals and refuses to grade them — §12 also asks that
-- a classification *"expose its major contributing signals"*, and exposing the
-- signals without inventing the classification is the honest half of that.
-- The third time this system has declined to invent a weight, after ADM-88
-- and Doc 14 §19.
--
-- **There is no VIP column.** §15: *"VIP status is configurable by Admin
-- policy"* and *"should not be based solely on an AI agent's subjective
-- judgment"*; §35: *"Never claim a client is VIP without configured
-- criteria."* No criteria are configured. An empty flag beside a client
-- account is the invitation ADM-88's `score` column turned out to be, and
-- this one is being declined before it is created rather than after.
--
-- **§5's eligibility list is not fully enforced.** Two of its seven conditions
-- are recorded facts — the project is completed and handover is accepted —
-- and are checked. The others (*"technical ownership/access is sufficient"*,
-- *"maintenance offering is compatible with the project"*) are judgements
-- nothing in AgencyOS records, and a check that guesses them would refuse
-- real work for a reason nobody can inspect.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── §3/§4 the plan, versioned, priced nowhere ───────────────────────────

create table if not exists projects.maintenance_plans (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,

  name              text not null check (length(trim(name)) > 0),

  -- §3: "Plan versioning is required. Client acceptance references the exact
  -- plan/version." Per (project, name), the same shape scope versions and
  -- proposals already use.
  version           int not null default 1 check (version >= 1),

  -- §3's own list of billing models. `other` is deliberately absent: a model
  -- nobody named is a model nobody agreed to bill on.
  billing_model     text not null check (billing_model in
                      ('monthly', 'quarterly', 'annual', 'prepaid')),

  -- §4's components that are not commercial. Text, because §4 asks for them in
  -- the agency's own words and nothing here reasons about their content.
  coverage          text,
  included_support  text,
  included_tasks    text,
  bug_fix_coverage  text,
  minor_change_allowance text,
  excluded_work     text,
  response_targets  text,
  support_hours     text,
  emergency_policy  text,
  monitoring        text,
  reporting         text,
  escalation        text,
  renewal_terms     text,

  -- §9: "Track plan start/end dates."
  starts_on         date,
  ends_on           date,

  -- §10's state machine, as its own words. `renewal_approaching` is included
  -- even though nothing computes it yet — the states are the vocabulary a
  -- renewal conversation happens in, and leaving one out means the
  -- conversation has nowhere to be recorded.
  status            text not null default 'draft' check (status in
                      ('draft', 'active', 'renewal_approaching', 'renewal_proposed',
                       'pending_client', 'renewed', 'expired', 'cancelled',
                       'paused', 'declined', 'at_risk')),

  -- §3: "Client acceptance references the exact plan/version." The proposal
  -- the client accepted — and, because ADM-22 puts every price on a proposal,
  -- also where this plan's price is.
  accepted_proposal_id uuid references sales.proposals(id) on delete set null,
  accepted_at       timestamptz,

  -- §9: "Record lapse/cancellation reason."
  ended_reason      text,

  created_by        uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (project_id, name, version),

  constraint maintenance_plans_period_ordered
    check (ends_on is null or starts_on is null or ends_on >= starts_on),

  -- §10: "Renewal cannot be silently assumed." A renewed or active plan names
  -- the proposal the client accepted, and the moment they accepted it. Without
  -- this, renewal is a status somebody sets.
  constraint maintenance_plans_acceptance_is_evidenced
    check (status not in ('active', 'renewed')
           or (accepted_proposal_id is not null and accepted_at is not null)),

  -- §9's last bullet, as a rule rather than a field somebody may leave blank.
  constraint maintenance_plans_ending_says_why
    check (status not in ('expired', 'cancelled', 'declined')
           or (ended_reason is not null and length(trim(ended_reason)) > 0))
);

create index if not exists maintenance_plans_account_idx
  on projects.maintenance_plans (organization_id, client_account_id, status);

comment on table projects.maintenance_plans is
  'A maintenance agreement (Doc 18 sections 3 and 4), versioned because section 3 requires it. NO PRICE COLUMN: section 3 says a plan has a price and ADM-22 says there is no price catalog and every price is quoted per client by a human - a tiered plan carrying a price IS a catalog, so the price lives on the sales.proposals row this plan references, exactly as Doc 11 resolved the same conflict for change requests. Section 10: "Renewal cannot be silently assumed" - an active or renewed plan must name the accepted proposal.';

-- ── §6/§8 what a ticket actually is ─────────────────────────────────────

alter table projects.maintenance_items
  add column if not exists coverage text
    check (coverage in ('warranty', 'maintenance', 'change_request', 'new_project', 'upsell'));

alter table projects.maintenance_items
  add column if not exists ticket_type text
    check (ticket_type in
      ('production_bug', 'security_update', 'dependency_update', 'performance',
       'content_change', 'minor_ui', 'monitoring_alert', 'backup_recovery',
       'access_support', 'new_feature', 'integration_change', 'upgrade_migration'));

alter table projects.maintenance_items
  add column if not exists plan_id uuid references projects.maintenance_plans(id) on delete set null;

alter table projects.maintenance_items
  add column if not exists change_request_id uuid references projects.change_requests(id) on delete set null;

alter table projects.maintenance_items
  add column if not exists upsell_signal_id uuid references sales.upsell_signals(id) on delete set null;

comment on column projects.maintenance_items.coverage is
  'Doc 18 section 6. Which of the five things this request actually is, and therefore which exit it may take. Doc 18 section 35: "Never classify new scope as maintenance to avoid approval"; section 18: "Do not label a bug as a paid feature." Both directions cost somebody money, and projects.refuse_miscoded_maintenance makes the line load-bearing.';

-- ── the line, as a refusal ──────────────────────────────────────────────

create or replace function projects.refuse_miscoded_maintenance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- §18: "Do not label a bug as a paid feature." A covered defect is not a
  -- sale, so it may not carry the paperwork of one. Checked on every write,
  -- because attaching a change request to a warranty ticket is the move, and
  -- it does not wait for the ticket to close.
  if new.coverage in ('warranty', 'maintenance')
     and (new.change_request_id is not null or new.upsell_signal_id is not null) then
    raise exception
      'a % ticket is covered work and cannot be turned into paid work (Doc 18 §18)',
      new.coverage
      using errcode = 'check_violation';
  end if;

  -- Everything below is about CLOSING. An open ticket is allowed to be
  -- unclassified and unrouted — §7 puts CLASSIFY after CLIENT REQUEST, so
  -- demanding it at insert would refuse the request before anybody has read it.
  if new.status not in ('resolved', 'declined') then
    return new;
  end if;

  -- A declined ticket is one nobody did, and §7's routing is about work that
  -- gets done. Declining an out-of-scope request without opening a change
  -- request is the correct outcome, not an evasion.
  if new.status = 'declined' then
    return new;
  end if;

  if new.coverage is null then
    raise exception
      'a maintenance ticket cannot be resolved without saying what it was (Doc 18 §6)'
      using errcode = 'check_violation';
  end if;

  -- §35: "Never classify new scope as maintenance to avoid approval."
  -- §7: "Out-of-scope work becomes a Change Request or commercial opportunity."
  if new.coverage in ('change_request', 'new_project') and new.change_request_id is null then
    raise exception
      'a % is out of scope and must become a change request before it is resolved (Doc 18 §7) - doing it quietly is how new scope escapes approval',
      new.coverage
      using errcode = 'check_violation';
  end if;

  if new.coverage = 'upsell' and new.upsell_signal_id is null then
    raise exception
      'an upsell is routed to Sales, not resolved inside maintenance (Doc 18 §18)'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists refuse_miscoded_maintenance on projects.maintenance_items;
create trigger refuse_miscoded_maintenance
  before insert or update on projects.maintenance_items
  for each row execute function projects.refuse_miscoded_maintenance();

-- ── a closed ticket's classification is history ─────────────────────────

create or replace function projects.freeze_closed_maintenance_coverage()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('resolved', 'declined')
     and new.coverage is distinct from old.coverage then
    raise exception
      'a closed ticket''s classification is history; re-coding it after the fact is how the record stops matching what was billed'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_closed_maintenance_coverage on projects.maintenance_items;
create trigger freeze_closed_maintenance_coverage
  before update on projects.maintenance_items
  for each row execute function projects.freeze_closed_maintenance_coverage();

-- ── §5, the two conditions that are recorded facts ──────────────────────

create or replace function projects.enforce_plan_eligibility()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from projects.handovers h
     where h.project_id = new.project_id
       and h.status in ('delivered', 'accepted')
  ) then
    raise exception
      'a maintenance plan needs a delivered handover; there is nothing to maintain yet (Doc 18 §5)'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_plan_eligibility on projects.maintenance_plans;
create trigger enforce_plan_eligibility
  before insert on projects.maintenance_plans
  for each row execute function projects.enforce_plan_eligibility();

-- ── §12's signals, and the grade this refuses to give ───────────────────

create or replace function projects.account_health_signals(p_client_account_id uuid)
returns table (
  signal text,
  value  text
)
language sql
stable
security invoker
set search_path = ''
as $$
  -- Doc 18 §12 lists the signals and then says "Each signal should have
  -- configurable weight". Nobody has configured a weight, so this returns
  -- WHAT IS RECORDED and grades nothing. §12 also asks that a classification
  -- "expose its major contributing signals"; exposing the signals without
  -- inventing the classification is the honest half of that, and §35 forbids
  -- the other half twice over — "never fabricate client satisfaction",
  -- "never invent usage".
  select 'open_maintenance_tickets'::text,
         count(*)::text
    from projects.maintenance_items m
   where m.client_account_id = p_client_account_id
     and m.status in ('open', 'in_progress')

  union all
  select 'unpaid_invoices',
         count(*)::text
    from finance.invoices i
   where i.client_account_id = p_client_account_id
     and i.status in ('issued', 'partially_paid', 'overdue')

  union all
  select 'overdue_invoices',
         count(*)::text
    from finance.invoices i
   where i.client_account_id = p_client_account_id
     and i.status = 'overdue'

  union all
  select 'active_maintenance_plans',
         count(*)::text
    from projects.maintenance_plans p
   where p.client_account_id = p_client_account_id
     and p.status in ('active', 'renewed')

  union all
  select 'projects_delivered',
         count(*)::text
    from projects.projects pr
   where pr.client_account_id = p_client_account_id
     and pr.status = 'completed'

  order by 1;
$$;

comment on function projects.account_health_signals(uuid) is
  'Doc 18 section 12''s signals, ungraded. NO SCORE AND NO STATUS: section 12 says each signal should have a configurable weight, nobody has configured one, and section 35 forbids fabricating satisfaction or inventing usage. The third time this system has declined to invent a weight, after ADM-88 and Doc 14 section 19. There is no VIP column anywhere either - section 15 makes VIP configurable by Admin policy and section 35 says never claim it without configured criteria, so the empty flag ADM-88 taught us about is being declined before it is created rather than after.';

-- ── tenancy ─────────────────────────────────────────────────────────────

alter table projects.maintenance_plans enable row level security;
alter table projects.maintenance_plans force row level security;

drop policy if exists maintenance_plans_select on projects.maintenance_plans;
create policy maintenance_plans_select on projects.maintenance_plans
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists maintenance_plans_write on projects.maintenance_plans;
create policy maintenance_plans_write on projects.maintenance_plans
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

drop trigger if exists org_match_maintenance_plans_project on projects.maintenance_plans;
create trigger org_match_maintenance_plans_project
  before insert or update of project_id, organization_id on projects.maintenance_plans
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_maintenance_plans_client on projects.maintenance_plans;
create trigger org_match_maintenance_plans_client
  before insert or update of client_account_id, organization_id on projects.maintenance_plans
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_maintenance_plans_proposal on projects.maintenance_plans;
create trigger org_match_maintenance_plans_proposal
  before insert or update of accepted_proposal_id, organization_id on projects.maintenance_plans
  for each row execute function core.enforce_parent_org('accepted_proposal_id', 'sales.proposals');

drop trigger if exists freeze_org_maintenance_plans on projects.maintenance_plans;
create trigger freeze_org_maintenance_plans
  before update of organization_id on projects.maintenance_plans
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_maintenance_items_plan on projects.maintenance_items;
create trigger org_match_maintenance_items_plan
  before insert or update of plan_id, organization_id on projects.maintenance_items
  for each row execute function core.enforce_parent_org('plan_id', 'projects.maintenance_plans');

drop trigger if exists org_match_maintenance_items_change on projects.maintenance_items;
create trigger org_match_maintenance_items_change
  before insert or update of change_request_id, organization_id on projects.maintenance_items
  for each row execute function core.enforce_parent_org('change_request_id', 'projects.change_requests');

drop trigger if exists org_match_maintenance_items_upsell on projects.maintenance_items;
create trigger org_match_maintenance_items_upsell
  before insert or update of upsell_signal_id, organization_id on projects.maintenance_items
  for each row execute function core.enforce_parent_org('upsell_signal_id', 'sales.upsell_signals');

grant select, insert, update on projects.maintenance_plans to authenticated, service_role;
grant execute on function projects.account_health_signals(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
