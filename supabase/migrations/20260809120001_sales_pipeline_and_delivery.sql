-- ═══════════════════════════════════════════════════════════════════════════
-- 013 — Sales pipeline, delivery handoff, milestone payment plans
--
-- Covers LEAD → SALES → CLIENT WON → PROJECT CREATION → ONBOARDING.
--
-- Almost every concept in that chain already had a home, so this migration is
-- deliberately small. What already existed and is reused as-is:
--
--   crm.leads.status          new → qualifying → qualified → converted
--   sales.opportunities.stage discovery → proposal → negotiation → won / lost
--   crm.lead_activities       sales notes (kind = 'note') and the lead timeline
--   core.client_accounts      the won client
--   projects.projects         the project
--   projects.milestones       ordered, priced delivery milestones
--   audit.audit_log           the history trail for every transition
--
-- Only four things were genuinely absent, and they are added below.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Lead follow-up tracking ────────────────────────────────────────────
-- A lead that nobody has scheduled a next touch for is how deals go quiet.
alter table crm.leads add column if not exists next_follow_up_at timestamptz;

create index if not exists leads_follow_up_idx
  on crm.leads (organization_id, next_follow_up_at)
  where deleted_at is null and next_follow_up_at is not null;

comment on column crm.leads.next_follow_up_at is
  'When the next sales touch is due. Null means nothing is scheduled, which is what an overdue-leads view looks for.';

-- ── 2. Lead qualification ─────────────────────────────────────────────────
-- Distinct from crm.leads.requirements, which records *what the client wants
-- built*. This records *whether the deal is worth pursuing* — the two answer
-- different questions and change at different times.
--
-- jsonb for the same reason requirements is jsonb: the shape is still settling.
-- The authoritative shape is the Zod schema in src/modules/crm/schema.ts;
-- promote to columns once it stops moving.
alter table crm.leads add column if not exists qualification jsonb not null default '{}'::jsonb;

comment on column crm.leads.qualification is
  'Structured qualification (budget band, timeline, decision maker, fit notes). Schema-on-read; validated by requirementQualificationSchema before write.';

-- ── 3. Onboarding as an explicit project state ────────────────────────────
-- The workflow has a real gap between "we won it" and "we are building": the
-- WhatsApp group, the advance payment, the kickoff. That is a state, not a
-- pause inside 'planning', so it gets named.
alter table projects.projects drop constraint if exists projects_status_check;
alter table projects.projects add constraint projects_status_check
  check (status in ('planning', 'onboarding', 'active', 'on_hold', 'completed', 'cancelled'));

comment on column projects.projects.status is
  'planning → onboarding → active → completed. onboarding covers kickoff, group setup, and advance payment, before delivery starts.';

-- ── 4. Flexible milestone payment plans ───────────────────────────────────
-- The business uses different splits per deal (30/20/30/20, 5/10/30/20/35,
-- …), so no structure is hard-coded anywhere. A plan is simply the ordered
-- milestones of a project, each carrying its share.
--
-- Percent is stored alongside the money rather than instead of it: the
-- percentage is what was negotiated, amount_minor is what will be invoiced,
-- and keeping both means a budget change can be re-applied without guessing
-- the original split.
alter table projects.milestones add column if not exists payment_percent numeric(5, 2);

alter table projects.milestones drop constraint if exists milestones_payment_percent_range;
alter table projects.milestones add constraint milestones_payment_percent_range
  check (payment_percent is null or (payment_percent > 0 and payment_percent <= 100));

comment on column projects.milestones.payment_percent is
  'This milestone''s share of the project budget. Null for milestones that are pure delivery checkpoints with no payment attached.';

-- A plan that does not add up to 100% is a billing error waiting to happen, so
-- it is refused by the database rather than by convention.
--
-- DEFERRABLE INITIALLY DEFERRED is the point: a plan is written as several rows
-- in one transaction and is only meaningful once all of them are in, so the
-- check runs at COMMIT rather than after each row.
create or replace function projects.assert_payment_plan_totals()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_project uuid;
  v_count   int;
  v_total   numeric(6, 2);
begin
  if tg_op = 'DELETE' then
    v_project := old.project_id;
  else
    v_project := new.project_id;
  end if;

  select count(*), coalesce(sum(payment_percent), 0)
    into v_count, v_total
    from projects.milestones
   where project_id = v_project
     and payment_percent is not null;

  -- No priced milestones at all is a valid state: a project can exist before
  -- its payment plan is agreed.
  if v_count > 0 and v_total <> 100 then
    raise exception
      'payment plan for project % must total 100 percent, got %', v_project, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

drop trigger if exists milestones_payment_plan_total on projects.milestones;
create constraint trigger milestones_payment_plan_total
  after insert or update or delete on projects.milestones
  deferrable initially deferred
  for each row execute function projects.assert_payment_plan_totals();

-- ── RLS ───────────────────────────────────────────────────────────────────
-- Deliberately unchanged. Every table touched here already has policies, and
-- new columns inherit them: crm.leads, projects.projects and
-- projects.milestones are all org-scoped with can_write() gating on writes.
