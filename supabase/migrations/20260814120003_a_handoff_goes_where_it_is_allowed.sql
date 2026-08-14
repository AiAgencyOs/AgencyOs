-- ═══════════════════════════════════════════════════════════════════════════
-- A handoff goes where it is allowed, and not one hop further.
--
-- Gap G-125 conditions 6 and 7, gap G-128, decision ADM-83.
--
-- ── the constraint the owner added ────────────────────────────────────────
--
-- ADM-83 kept the handoff shape and added one rule I had not proposed: **the
-- receiver must be an allowed handoff target in the SENDER's registry
-- definition.** That turns the handoff graph into an authorization boundary
-- rather than a routing convenience — an agent cannot reach one it has no
-- declared relationship with, even by naming it.
--
-- Enforcing that in Postgres needs the registry here, because the registry is
-- TypeScript and the database cannot read it. `ai.agent_handoff_targets` is
-- that mirror, and `check-record` §16 proves the two agree — the same
-- arrangement `LIVE_PROPOSAL_STATUSES` has with `proposals_live_version_key`
-- and `SETTLED_OPPORTUNITY_STAGES` with `opportunities_open_lead_key`.
--
-- A mirror nobody checks is worse than no mirror, because it looks
-- authoritative. The check is the load-bearing half.
--
-- ── G-128: how far, not only where ───────────────────────────────────────
--
-- ADM-83 bounds where a handoff may go and says nothing about how far a chain
-- runs. `A → B → A → B` is legal under every rule recorded: each hop a valid
-- target, each agent within its autonomy, each step audited. `max_cost_minor`
-- bounds the damage in money rather than time, and only after the budget is
-- spent — while a loop inside one correlation chain reads as progress, because
-- it produces new handoffs, new runs and new steps.
--
-- `depth` is the bound, per correlation chain, because the chain is already
-- the unit of tracing in `ai.agent_runs`.
--
-- **Eight is an engineering decision and is recorded as one.** The longest
-- legitimate chain the approved roster implies is requirement → PM → design →
-- prototype → build → QA → handover, which is seven. Eight leaves one hop of
-- headroom and still stops a two-agent loop on its fourth round trip. It is a
-- number to be revised against a real chain, not a constant anybody should
-- treat as meaningful.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the registry, mirrored ───────────────────────────────────────────────
--
-- Global rather than per-organization: agent definitions are code, so the
-- targets are identical for every tenant. Handoffs themselves are tenant
-- scoped; who may hand to whom is not.

create table if not exists ai.agent_handoff_targets (
  from_agent  text not null references ai.agents(key) on delete cascade,
  to_agent    text not null references ai.agents(key) on delete cascade,
  primary key (from_agent, to_agent),
  constraint agent_handoff_targets_not_self check (from_agent <> to_agent)
);

comment on table ai.agent_handoff_targets is
  'Which agent may hand work to which, mirrored from src/modules/agents/registry.ts because Postgres cannot read TypeScript (ADM-83). check-record section 16 proves the mirror matches the definitions. Empty today: the one defined agent declares no targets, so no handoff can be created at all - which is correct while there is one agent.';

alter table ai.agent_handoff_targets enable row level security;

drop policy if exists agent_handoff_targets_select on ai.agent_handoff_targets;
create policy agent_handoff_targets_select on ai.agent_handoff_targets
  for select to authenticated
  using ((select core.is_internal()));

-- ── the handoffs themselves ──────────────────────────────────────────────

create table if not exists ai.handoffs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  correlation_id   uuid not null,

  from_agent       text not null references ai.agents(key) on delete restrict,
  to_agent         text not null references ai.agents(key) on delete restrict,

  status           text not null default 'queued' check (status in
                     ('queued', 'accepted', 'running', 'needs_input',
                      'awaiting_approval', 'rejected',
                      'failed_retryable', 'failed_permanent',
                      'completed', 'cancelled')),

  -- How many hops precede this one in its correlation chain. G-128.
  depth            int not null default 0 check (depth >= 0 and depth <= 8),

  project_id       uuid references projects.projects(id) on delete cascade,
  task_id          uuid,
  subject_type     text,
  subject_id       uuid,

  objective        text not null check (length(trim(objective)) > 0),

  -- References, never copied prose. A receiver reads current facts through its
  -- own RLS rather than a sender's snapshot - which also means a handoff
  -- cannot carry data across a tenant or project boundary, because every
  -- reference is re-read under the receiver's policies.
  context          jsonb not null default '{}'::jsonb,
  requirements     jsonb not null default '[]'::jsonb,
  artifacts        jsonb not null default '[]'::jsonb,
  decisions        jsonb not null default '[]'::jsonb,
  constraints      jsonb not null default '[]'::jsonb,
  state            jsonb not null default '{}'::jsonb,

  -- Evidence, not a claim. ADM-83: completion is a verdict.
  verification     jsonb,
  unresolved       jsonb not null default '[]'::jsonb,

  requested_action text,
  sla_at           timestamptz,

  created_at       timestamptz not null default now(),
  accepted_at      timestamptz,
  completed_at     timestamptz,

  -- An agent cannot hand work to itself, at any depth.
  constraint handoffs_not_self check (from_agent <> to_agent),

  -- ADM-83, and the rule this table exists to make structural: a handoff
  -- claiming completion with no verification is exactly the false claim the
  -- verification contract forbids. `rejected` carries no verification, because
  -- a rejection is a verdict about the absence of one.
  constraint handoffs_completed_needs_verification
    check (status <> 'completed' or verification is not null)
);

comment on table ai.handoffs is
  'Work passed between agents (ADM-83). One table for every layer, because the correlation model is shared and cross-layer tracing needs it. A completed handoff carries verification or the constraint refuses it, and the receiver must be an allowed target in the SENDER definition - enforced by trigger against ai.agent_handoff_targets.';

comment on column ai.handoffs.depth is
  'Hops before this one in the correlation chain (G-128). Bounded at 8: the longest chain the approved roster implies is seven, so eight leaves one hop of headroom and stops a two-agent loop on its fourth round trip. An engineering decision, to be revised against a real chain.';

comment on column ai.handoffs.verification is
  'Evidence that the work is done, not a claim that it is. Null until a verifier - never the producer - records a verdict.';

create index if not exists handoffs_org_status_idx
  on ai.handoffs (organization_id, status, created_at desc);

create index if not exists handoffs_correlation_idx
  on ai.handoffs (correlation_id, depth);

create index if not exists handoffs_to_agent_idx
  on ai.handoffs (organization_id, to_agent, status)
  where status in ('queued', 'accepted', 'running');

-- ── tenant isolation, the same shape as every other table here ───────────

alter table ai.handoffs enable row level security;

drop policy if exists handoffs_select on ai.handoffs;
create policy handoffs_select on ai.handoffs
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists handoffs_write on ai.handoffs;
create policy handoffs_write on ai.handoffs
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- The receiver must be a declared target
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A CHECK cannot reach another table, so this is a trigger. It runs BEFORE
-- INSERT and BEFORE any UPDATE that changes either end, because a handoff
-- redirected after creation would otherwise escape the rule that governed its
-- creation.
--
-- It refuses rather than corrects. A handoff aimed at an agent the sender may
-- not reach is not a routing mistake to be fixed silently; it is the boundary
-- doing its job, and the caller needs to know.

create or replace function ai.enforce_handoff_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from ai.agent_handoff_targets t
     where t.from_agent = new.from_agent
       and t.to_agent   = new.to_agent
  ) then
    raise exception
      'handoff refused: % may not hand work to %. The receiver must be a declared target in the sender''s registry definition (ADM-83).',
      new.from_agent, new.to_agent
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function ai.enforce_handoff_target() is
  'Refuses a handoff whose receiver is not a declared target of the sender (ADM-83, G-125 condition 6). A CHECK cannot reach another table, so the rule lives here - and it runs on UPDATE as well, because a handoff redirected after creation would otherwise escape the rule that governed its creation.';

drop trigger if exists enforce_handoff_target on ai.handoffs;
create trigger enforce_handoff_target
  before insert or update of from_agent, to_agent on ai.handoffs
  for each row execute function ai.enforce_handoff_target();

-- ── nothing is seeded ────────────────────────────────────────────────────
--
-- `requirement_collector` declares no handoff targets, so the mirror is empty
-- and no handoff can be created by anybody. That is the honest state with one
-- agent, and it means the boundary is proven before the first real handoff
-- rather than after it.
