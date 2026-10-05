-- ═══════════════════════════════════════════════════════════════════════════
-- Lead routing — Audit 1.3 (docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json),
-- Implementation Plan Phase 1 item 1: "no lead-routing algorithm exists —
-- all leads land on one queue, no load balancing."
--
-- `crm.leads.assigned_to` has existed since the first CRM migration and has
-- always been a manual field. This adds the algorithm, driven by an
-- admin-configurable rule set rather than a hardcoded business policy — the
-- same posture `core.set_organization_setting` takes for the owner's
-- negotiation limits (20260904120000): the NUMBERS are the owner's, the
-- MECHANISM is this repository's.
--
-- ── what a rule matches on, and why these seven and not fewer ─────────────
--
-- Audit 1.3 names seven signals: service/product type, lead source, language,
-- sales-rep availability, priority, region, and existing relationship
-- (repeat client). `crm.leads` carries `source` as a real column; service
-- type, language and region live in the free-form `requirements` jsonb
-- (Feature 6's own schema-on-read choice, stated in that column's comment) —
-- there is no structured field for any of the three yet, anywhere in this
-- schema, so a rule reads them out of the same jsonb the AI qualifier writes
-- into. "Priority" has no column of its own either; `score` (0-100, written
-- by the Lead Qualifier agent) is the closest existing proxy and is used as
-- a minimum-priority threshold rather than inventing a second field for the
-- same idea. "Existing relationship" reads `crm.contacts.client_account_id`
-- directly — a lead's contact already being tied to a client account IS the
-- repeat-client fact, with no new column needed.
--
-- "Sales-rep availability" is the one signal with no existing concept at
-- all: nothing in `core.memberships` distinguishes a rep who is currently
-- taking leads from one who is on leave. Rather than inventing an
-- availability calendar this migration cannot honestly populate, a rule's
-- named rep is skipped when their membership is not `active` — the
-- membership status this schema already tracks — and the router falls back
-- to round-robin among active members. A real per-rep on/off switch is
-- future work the JSON's `blocker` field for this step should keep naming
-- until an admin surface asks for one.
--
-- ── never overrides a human's own assignment ───────────────────────────────
--
-- `route_lead` refuses outright when `assigned_to` is already set. A staff
-- member who assigns a lead by hand a second before the router runs must not
-- have that choice silently replaced — the same discipline
-- `sales.set_approved_offer` applies to a concession nobody asked to have
-- picked for them.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.lead_assignment_rules (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,

  label                 text not null check (length(btrim(label)) > 0),
  priority              integer not null default 100,
  active                boolean not null default true,

  -- Every match_* column is a whitelist: null or empty means "any value
  -- matches this dimension." A rule with every column null matches
  -- everything, which is a deliberate, ordinary way to write a catch-all.
  match_source          text[],
  match_service_type    text[],
  match_language        text[],
  match_region          text[],
  match_min_score       smallint check (match_min_score is null or match_min_score between 0 and 100),
  match_repeat_client   boolean,

  assigned_to           uuid not null references core.users(id) on delete cascade,

  created_by            uuid references core.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists lead_assignment_rules_org_priority_idx
  on crm.lead_assignment_rules (organization_id, priority, id) where active;

comment on table crm.lead_assignment_rules is
  'Audit 1.3. The owner''s own routing policy: one row per rule, evaluated in priority order by crm.route_lead. Every match_* column is a whitelist (null/empty = matches anything). Config only — writable by owner/ops_admin, never by the router itself.';

drop trigger if exists set_updated_at on crm.lead_assignment_rules;
create trigger set_updated_at before update on crm.lead_assignment_rules
  for each row execute function core.set_updated_at();

drop trigger if exists lead_assignment_rules_freeze_org on crm.lead_assignment_rules;
create trigger lead_assignment_rules_freeze_org
  before update of organization_id on crm.lead_assignment_rules
  for each row execute function core.freeze_organization_id();

alter table crm.lead_assignment_rules enable row level security;
alter table crm.lead_assignment_rules force row level security;

drop policy if exists lead_assignment_rules_select on crm.lead_assignment_rules;
create policy lead_assignment_rules_select on crm.lead_assignment_rules
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- Config, not casework: only the two roles that may already set operational
-- policy (core.set_organization_setting's own gate) may write a routing
-- rule. A member who could assign leads to themselves by writing the rule
-- book is not a rule the door should have.
drop policy if exists lead_assignment_rules_write on crm.lead_assignment_rules;
create policy lead_assignment_rules_write on crm.lead_assignment_rules
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'))
  with check (organization_id = (select core.current_organization_id())
              and (select core.current_user_role()) in ('owner', 'ops_admin'));

grant select on crm.lead_assignment_rules to authenticated, service_role;
grant insert, update, delete on crm.lead_assignment_rules to authenticated;

-- ── the audit trail on the write itself ─────────────────────────────────
alter table crm.leads
  add column if not exists assignment_reason text,
  add column if not exists assignment_rule_id uuid references crm.lead_assignment_rules(id) on delete set null;

comment on column crm.leads.assignment_reason is
  'Why crm.route_lead assigned this lead: the matched rule''s label, "fallback_round_robin", or null when assigned_to was set by a person rather than the router.';

comment on column crm.leads.assignment_rule_id is
  'The crm.lead_assignment_rules row that matched, when the router assigned this lead. Null for a manual assignment or a round-robin fallback.';

drop trigger if exists org_match_leads_assignment_rule on crm.leads;
create trigger org_match_leads_assignment_rule
  before insert or update of assignment_rule_id, organization_id on crm.leads
  for each row execute function core.enforce_parent_org('assignment_rule_id', 'crm.lead_assignment_rules');

-- ═══════════════════════════════════════════════════════════════════════════
-- The router itself.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.route_lead(p_lead_id uuid)
returns table (
  -- 'assigned' | 'already_assigned' | 'unknown_lead' | 'no_actor' | 'forbidden'
  -- | 'no_eligible_rep'
  outcome        text,
  assigned_to    uuid,
  rule_id        uuid,
  reason         text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_lead        crm.leads;
  v_is_repeat   boolean;
  v_service     text;
  v_language    text;
  v_region      text;
  v_rule        crm.lead_assignment_rules;
  v_rep_active  boolean;
  v_fallback    uuid;
begin
  -- Event-driven (crm:routeLead) or a manual re-run after a repair — the same
  -- two-caller shape projects.start_phase_two already established.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid, null::uuid, null::text; return;
  end if;

  select l.* into v_lead from crm.leads l where l.id = p_lead_id for update;
  if v_lead.id is null or v_lead.deleted_at is not null then
    return query select 'unknown_lead'::text, null::uuid, null::uuid, null::text; return;
  end if;

  if v_actor is not null
     and (v_lead.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::text; return;
  end if;

  -- Never override a human's own assignment (or a previous routing run —
  -- idempotent, so a replayed event cannot reassign a lead a second time).
  if v_lead.assigned_to is not null then
    return query select 'already_assigned'::text, v_lead.assigned_to, v_lead.assignment_rule_id, v_lead.assignment_reason;
    return;
  end if;

  select (c.client_account_id is not null) into v_is_repeat
    from crm.contacts c
   where c.id = v_lead.contact_id;
  v_is_repeat := coalesce(v_is_repeat, false);

  v_service  := nullif(lower(btrim(v_lead.requirements->>'serviceType')), '');
  v_language := nullif(lower(btrim(v_lead.requirements->>'language')), '');
  v_region   := nullif(lower(btrim(v_lead.requirements->>'region')), '');

  for v_rule in
    select r.* from crm.lead_assignment_rules r
     where r.organization_id = v_lead.organization_id
       and r.active
       and (r.match_source is null or cardinality(r.match_source) = 0
            or v_lead.source = any (r.match_source))
       and (r.match_service_type is null or cardinality(r.match_service_type) = 0
            or v_service = any (r.match_service_type))
       and (r.match_language is null or cardinality(r.match_language) = 0
            or v_language = any (r.match_language))
       and (r.match_region is null or cardinality(r.match_region) = 0
            or v_region = any (r.match_region))
       and (r.match_min_score is null or v_lead.score >= r.match_min_score)
       and (r.match_repeat_client is null or r.match_repeat_client = v_is_repeat)
     order by r.priority asc, r.id asc
  loop
    -- Availability, as far as this schema can honestly answer it: an active
    -- membership. A rule naming a suspended or departed rep is skipped
    -- rather than assigning a lead nobody will see.
    select exists (
      select 1 from core.memberships m
       where m.user_id = v_rule.assigned_to
         and m.organization_id = v_lead.organization_id
         and m.status = 'active'
    ) into v_rep_active;

    if v_rep_active then
      update crm.leads
         set assigned_to = v_rule.assigned_to,
             assignment_reason = v_rule.label,
             assignment_rule_id = v_rule.id
       where id = v_lead.id;

      perform core.record_audit(
        v_lead.organization_id, 'lead.assigned', 'lead', v_lead.id, null,
        jsonb_build_object('assignedTo', v_rule.assigned_to, 'ruleId', v_rule.id, 'reason', v_rule.label)
      );

      return query select 'assigned'::text, v_rule.assigned_to, v_rule.id, v_rule.label;
      return;
    end if;
  end loop;

  -- No rule matched, or every matching rule's rep is unavailable: round-robin
  -- among active internal staff, least-loaded first — the load-balancing the
  -- audit's own risk line names ("all leads land on one queue"). Contractors
  -- are excluded; they are not the standing sales queue.
  select m.user_id into v_fallback
    from core.memberships m
   where m.organization_id = v_lead.organization_id
     and m.status = 'active'
     and m.role in ('owner', 'ops_admin', 'delivery_lead', 'member')
   order by (
     select count(*) from crm.leads l2
      where l2.organization_id = v_lead.organization_id
        and l2.assigned_to = m.user_id
        and l2.deleted_at is null
   ) asc, m.user_id asc
   limit 1;

  if v_fallback is null then
    return query select 'no_eligible_rep'::text, null::uuid, null::uuid, null::text; return;
  end if;

  update crm.leads
     set assigned_to = v_fallback,
         assignment_reason = 'fallback_round_robin',
         assignment_rule_id = null
   where id = v_lead.id;

  perform core.record_audit(
    v_lead.organization_id, 'lead.assigned', 'lead', v_lead.id, null,
    jsonb_build_object('assignedTo', v_fallback, 'ruleId', null, 'reason', 'fallback_round_robin')
  );

  return query select 'assigned'::text, v_fallback, null::uuid, 'fallback_round_robin'::text;
end;
$$;

comment on function crm.route_lead(uuid) is
  'Audit 1.3. Assigns crm.leads.assigned_to from the organization''s own crm.lead_assignment_rules, first match by priority wins, skipping a matched rule whose rep has no active membership. Falls back to round-robin among active internal staff when no rule matches or every match is unavailable. Refuses outright when assigned_to is already set - never overrides a human''s own assignment or a previous run.';

revoke all on function crm.route_lead(uuid) from public, anon;
grant execute on function crm.route_lead(uuid) to authenticated, service_role;
