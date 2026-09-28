-- ═══════════════════════════════════════════════════════════════════════════
-- A routing decision is a record, not a side effect of writing a handoff.
--
-- P4-ORCH-ENTITIES: the Orchestrator spec names eight entities
-- (AgentCapability, RoutingDecision, ExecutionEnvelope, ExecutionRecord,
-- RouteFailure, FallbackRecord, OrchestratorEscalation, UsageCostRecord).
-- `src/modules/orchestrator/handlers.ts`'s `handleRouteTask2Design` already
-- makes a real routing decision (`decideAgentForTask`, `src/modules/
-- orchestrator/route.ts`) and writes its OUTCOME as an `ai.handoffs` row —
-- but the decision itself (which candidates existed, which guards were
-- evaluated, why the loser lost, why a guard blocked the route) evaporates
-- the moment the function returns. `ai.agent_runs` tracks run identity;
-- `ai.handoffs` tracks accepted work. Neither answers "why was this agent
-- chosen, and what did the Orchestrator check before choosing it" — which is
-- exactly what an Admin auditing a routing failure needs and cannot get
-- today from either table.
--
-- ── scope: one table, not eight ───────────────────────────────────────────
--
-- This migration deliberately builds ONLY `ai.routing_decisions` — an audit
-- trail of the routing act itself (chosen agent, evaluated guards, pass/fail,
-- a reference to the resulting handoff if one was created). It does NOT
-- build:
--   - ExecutionEnvelope / ExecutionRecord: there is no retry/resume machinery
--     for a routed hop yet (a handoff is accepted or it is not); an envelope
--     with nothing to resume would be a column nobody reads.
--   - RouteFailure / FallbackRecord: there is no fallback candidate ranking
--     (`route.ts`'s own docblock: "no cost/quality/latency ranking... a
--     ranking policy would be a knob nothing turns" — the same argument
--     applies to a fallback table with nothing to fall back TO).
--   - OrchestratorEscalation: Task 2's OWN escalation path already exists and
--     is real (`phase_four.state` → `scope_escalation`/`revision_limit_
--     escalation`, surfaced by `listPhaseFourEscalations`); a second,
--     Orchestrator-specific escalation entity would duplicate it for no new
--     fact.
--   - UsageCostRecord: `ai.agent_runs`/`ai.cost_ledger` (`20260807120008_
--     ai.sql`) already own per-run token/cost accounting; routing a task
--     costs nothing by itself (no model call happens inside `decideAgentForTask`),
--     so a routing-decision-scoped cost record would always be zero.
--   - AgentCapability as a table: it already exists, in code, as
--     `AgentDefinition.capabilities` (`src/modules/agents/registry.ts`),
--     mirrored into `ai.agent_handoff_targets` and proven to match by
--     `check-record` §16. A duplicate database copy of the same enum would be
--     the second source of truth this repository's own discipline forbids.
--
-- ── guards: what actually exists to check today ───────────────────────────
--
-- `handleRouteTask2Design` now evaluates two named guards before writing the
-- handoff:
--   - `activation`: the chosen agent (`to_agent`) must be `ai.agents.enabled`.
--     This is a REAL, pre-existing column (`20260807120008_ai.sql`) — no new
--     activation concept is invented here, only a routing-time read of one
--     that already governs whether an agent may run at all.
--   - `finance_gate`: Task 2's UI-design routing hop never touches payment
--     verification (no invoice, no `finance.verify_payment_submission` call
--     anywhere on this path), so the guard is evaluated and recorded as
--     not applicable rather than silently omitted — an Admin reading the
--     audit trail sees that the check was considered, not forgotten. This
--     migration does not touch any finance/moneyAuthority code path.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists ai.routing_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Same coordinates `ai.handoffs` uses for the row this decision produced,
  -- so the two tables join on the identical key an Admin would already
  -- recognize from the Automations page.
  project_id       uuid references projects.projects(id) on delete cascade,
  subject_type     text,
  subject_id       uuid,

  from_agent       text not null references ai.agents(key) on delete restrict,
  -- Null when no candidate was selected (no_candidate / unknown_agent /
  -- a guard blocked the route before a handoff could exist).
  to_agent         text references ai.agents(key) on delete restrict,

  -- Mirrors route.ts's own RouteOutcome union, plus the two outcomes that
  -- happen AFTER a candidate is selected but before a handoff is written.
  outcome          text not null check (outcome in
                     ('selected', 'no_candidate', 'unknown_agent', 'guard_failed', 'already_routed')),

  required_capabilities text[] not null default '{}',
  candidates            text[] not null default '{}',
  reason                text not null check (length(trim(reason)) > 0),

  -- One entry per guard actually evaluated: {"name": "activation", "passed": true, "detail": "..."}.
  -- An empty array is honest for the outcomes where no guard was reached
  -- (no_candidate, unknown_agent) rather than padded with placeholders.
  guards           jsonb not null default '[]'::jsonb,

  -- The handoff this decision produced, if any. ON DELETE SET NULL: a
  -- decision record documents what the Orchestrator did at the time, and
  -- outlives the handoff row it referenced.
  handoff_id       uuid references ai.handoffs(id) on delete set null,

  created_at       timestamptz not null default now()
);

comment on table ai.routing_decisions is
  'P4-ORCH-ENTITIES (partial: RoutingDecision only — see this migration''s header for the other 7 spec entities and why each is deliberately not built). One row per routing act the Orchestrator performs: which agent was chosen, which guards were evaluated and their pass/fail, and a reference to the ai.handoffs row the decision produced, if any. Written exclusively by the job runner under service_role, the same discipline ai.agent_runs already keeps — no INSERT/UPDATE policy exists for authenticated users.';

comment on column ai.routing_decisions.guards is
  'One object per guard actually evaluated for this decision: {name, passed, detail}. Today: "activation" (ai.agents.enabled for the chosen agent) and "finance_gate" (recorded not-applicable for Task 2 design routing, which never touches payment verification — evaluated and documented, not silently skipped).';

create index if not exists routing_decisions_org_created_idx
  on ai.routing_decisions (organization_id, created_at desc);

create index if not exists routing_decisions_subject_idx
  on ai.routing_decisions (subject_type, subject_id);

-- ── tenancy, the same shape ai.agent_runs already carries ─────────────────

drop trigger if exists org_match_routing_decisions_project on ai.routing_decisions;
create trigger org_match_routing_decisions_project
  before insert or update of project_id, organization_id on ai.routing_decisions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_routing_decisions_handoff on ai.routing_decisions;
create trigger org_match_routing_decisions_handoff
  before insert or update of handoff_id, organization_id on ai.routing_decisions
  for each row execute function core.enforce_parent_org('handoff_id', 'ai.handoffs');

drop trigger if exists freeze_org_routing_decisions on ai.routing_decisions;
create trigger freeze_org_routing_decisions
  before update of organization_id on ai.routing_decisions
  for each row execute function core.freeze_organization_id();

-- ── RLS ────────────────────────────────────────────────────────────────────

alter table ai.routing_decisions enable row level security;
alter table ai.routing_decisions force row level security;

drop policy if exists routing_decisions_select on ai.routing_decisions;
create policy routing_decisions_select on ai.routing_decisions
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- No write policy, deliberately — same as ai.agent_runs/ai.agent_steps:
-- written exclusively by the job runner under service_role, which bypasses
-- RLS. A routing trace nobody can forge is the point.

grant select on ai.routing_decisions to authenticated, service_role;
grant insert on ai.routing_decisions to service_role;

notify pgrst, 'reload schema';
