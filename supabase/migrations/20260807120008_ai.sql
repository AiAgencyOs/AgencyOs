-- ═══════════════════════════════════════════════════════════════════════════
-- 008 — ai: agent registry, runs, steps, cost
--
-- Two things this schema exists to guarantee (ARCHITECTURE.md §6):
--   1. Every agent action is traceable to the exact prompt version that
--      produced it.
--   2. Every token is counted, so cost per lead and cost per project are
--      measurable from day one rather than discovered in a bill.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── agents (registry; global, not tenant-owned) ───────────────────────────
create table if not exists ai.agents (
  key              text primary key check (key ~ '^[a-z][a-z0-9_]{2,48}$'),
  display_name     text not null,
  description      text,

  -- L0 read-only · L1 propose (requires approval) · L2 autonomous within limits
  autonomy_level   text not null default 'L1' check (autonomy_level in ('L0', 'L1', 'L2')),

  enabled          boolean not null default true,   -- per-agent kill switch

  default_model    text not null,
  default_effort   text not null default 'medium'
                     check (default_effort in ('low', 'medium', 'high', 'xhigh', 'max')),

  max_steps        int not null default 12 check (max_steps > 0),
  max_cost_minor   bigint not null default 5000 check (max_cost_minor > 0),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table ai.agents is
  'Agent configuration as data, so demoting a misbehaving agent to L0 or killing it is an UPDATE, not a deploy.';

-- ── agent_runs ────────────────────────────────────────────────────────────
create table if not exists ai.agent_runs (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  agent_key             text not null references ai.agents(key) on delete restrict,

  trigger               text not null,      -- 'event:lead.created' | 'user:<uuid>'
  subject_type          text,
  subject_id            uuid,

  status                text not null default 'queued' check (status in
                          ('queued', 'running', 'awaiting_approval', 'succeeded',
                           'failed', 'cancelled', 'budget_exceeded')),

  input                 jsonb,
  output                jsonb,

  -- Reproducibility: the exact prompt bytes that produced this output.
  prompt_key            text,
  prompt_version        text,
  prompt_hash           text,
  model                 text,

  input_tokens          int not null default 0 check (input_tokens >= 0),
  output_tokens         int not null default 0 check (output_tokens >= 0),
  cache_read_tokens     int not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens    int not null default 0 check (cache_write_tokens >= 0),
  cost_minor            bigint not null default 0 check (cost_minor >= 0),

  step_count            int not null default 0 check (step_count >= 0),
  error                 text,
  correlation_id        uuid,

  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists agent_runs_organization_status_idx
  on ai.agent_runs (organization_id, status, created_at desc);
create index if not exists agent_runs_agent_idx
  on ai.agent_runs (organization_id, agent_key, created_at desc);
create index if not exists agent_runs_subject_idx
  on ai.agent_runs (subject_type, subject_id);
create index if not exists agent_runs_correlation_idx
  on ai.agent_runs (correlation_id) where correlation_id is not null;

-- ── agent_steps (one row per model call or tool call) ─────────────────────
create table if not exists ai.agent_steps (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  run_id           uuid not null references ai.agent_runs(id) on delete cascade,

  seq              int not null check (seq >= 0),
  kind             text not null check (kind in
                     ('model_call', 'tool_call', 'validation', 'decision')),

  request          jsonb,
  response         jsonb,

  tokens_in        int not null default 0 check (tokens_in >= 0),
  tokens_out       int not null default 0 check (tokens_out >= 0),
  cost_minor       bigint not null default 0 check (cost_minor >= 0),
  latency_ms       int check (latency_ms >= 0),

  error            text,
  created_at       timestamptz not null default now(),

  unique (run_id, seq)
);

create index if not exists agent_steps_run_idx on ai.agent_steps (run_id, seq);

comment on table ai.agent_steps is
  'One row per step. A run is resumed from its last persisted step, which is what lets an agent survive a killed serverless invocation (ARCHITECTURE.md §6.3).';

-- ── cost_ledger (nightly rollup; the budget check reads this) ─────────────
create table if not exists ai.cost_ledger (
  id               bigserial primary key,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  day              date not null,
  agent_key        text not null references ai.agents(key) on delete cascade,
  model            text not null,

  runs             int not null default 0 check (runs >= 0),
  input_tokens     bigint not null default 0 check (input_tokens >= 0),
  output_tokens    bigint not null default 0 check (output_tokens >= 0),
  cost_minor       bigint not null default 0 check (cost_minor >= 0),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, day, agent_key, model)
);

create index if not exists cost_ledger_day_idx on ai.cost_ledger (organization_id, day desc);

do $$
declare t text;
begin
  foreach t in array array['agents','agent_runs','cost_ledger']
  loop
    execute format('drop trigger if exists set_updated_at on ai.%I', t);
    execute format(
      'create trigger set_updated_at before update on ai.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table ai.agents      enable row level security;
alter table ai.agent_runs  enable row level security;
alter table ai.agent_steps enable row level security;
alter table ai.cost_ledger enable row level security;

-- Registry is readable by any signed-in staff member; only owners change it.
drop policy if exists agents_select on ai.agents;
create policy agents_select on ai.agents
  for select to authenticated
  using ((select core.is_internal()));

drop policy if exists agents_write on ai.agents;
create policy agents_write on ai.agents
  for all to authenticated
  using ((select core.is_owner()))
  with check ((select core.is_owner()));

drop policy if exists agent_runs_select on ai.agent_runs;
create policy agent_runs_select on ai.agent_runs
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists agent_steps_select on ai.agent_steps;
create policy agent_steps_select on ai.agent_steps
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists cost_ledger_select on ai.cost_ledger;
create policy cost_ledger_select on ai.cost_ledger
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'));

-- Runs and steps are written exclusively by the job runner under service_role,
-- which bypasses RLS. No INSERT/UPDATE policy exists for authenticated users:
-- an agent trace nobody can forge is the point.
