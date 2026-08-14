-- ═══════════════════════════════════════════════════════════════════════════
-- Routing is data.
--
-- Decision ADM-84, steps R1 and R3. The two tables the routing design needs,
-- and nothing above them yet.
--
-- ── what already works, and why this is small ────────────────────────────
--
-- `resolveProvider(model)` exists, `AiProvider` is a real interface, providers
-- self-register, and **callers name a model and never a vendor**. That is the
-- part that is painful to retrofit and it is already correct. What is missing
-- sits above it: which models exist, what they can do, and which an agent
-- should prefer.
--
-- ── why these are data and the adapters are code ─────────────────────────
--
-- An adapter is code: adding a vendor is a reviewable diff. Models appear and
-- are deprecated constantly, so a migration per model release is a treadmill
-- nobody keeps up with — and a stale model list is a router choosing something
-- that no longer answers.
--
-- ── per organization, per ADM-84 ─────────────────────────────────────────
--
-- AgencyOS is tenant-scoped throughout, and one tenant's deprecation must not
-- change another's behaviour. A global catalogue is defensible and simpler;
-- the decision took the consistent option deliberately, and said a global one
-- should be introduced on purpose rather than by making the first
-- implementation global.
--
-- ── nothing is seeded, and that is the decision rather than an omission ──
--
-- ADM-84 **deferred the second provider**: OpenAI is not to be chosen merely
-- because ARCHITECTURE §6.4 mentions it for embeddings, because generation and
-- embeddings are different capabilities. Seeding model rows would mean writing
-- provider facts — context windows, prices, capabilities — that nobody has
-- established, into a table that reads as authoritative.
--
-- So both tables ship empty. An empty model registry means capability matching
-- finds no candidate, which is the honest state until somebody records real
-- models, and is exactly what `AI_PROVIDER_NOT_CONFIGURED` already does one
-- layer down: nothing is ever reported as succeeding that did not call a model.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists ai.models (
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- The id an adapter accepts, unchanged. Never translated, so a reader can
  -- match what is here against what a run actually used.
  model_id         text not null check (length(trim(model_id)) > 0),

  -- Which adapter serves it. Text rather than a foreign key: adapters are code
  -- and register themselves at runtime, so a constraint here would be a second
  -- list to keep in step with the first.
  provider         text not null check (length(trim(provider)) > 0),

  -- The same vocabulary agent definitions declare. Constrained against the
  -- literal set rather than mirrored into a table, because a CHECK is the
  -- cheapest honest enforcement and needs nothing kept in step.
  capabilities     text[] not null default '{}'::text[]
                     check (capabilities <@ array[
                       'reasoning', 'coding', 'long_context',
                       'structured_output', 'multimodal'
                     ]::text[]),

  context_tokens   int check (context_tokens is null or context_tokens > 0),

  input_cost_minor_per_mtok   bigint check (input_cost_minor_per_mtok  is null or input_cost_minor_per_mtok  >= 0),
  output_cost_minor_per_mtok  bigint check (output_cost_minor_per_mtok is null or output_cost_minor_per_mtok >= 0),

  status           text not null default 'available'
                     check (status in ('available', 'deprecated', 'retired')),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  primary key (organization_id, model_id)
);

comment on table ai.models is
  'Which models an organization may route to, and what each can do (ADM-84 R1). Data rather than code because models appear and are deprecated constantly and a migration per release is a treadmill. Ships EMPTY: ADM-84 deferred the second provider, and seeding rows would mean writing provider facts nobody has established into a table that reads as authoritative.';

comment on column ai.models.capabilities is
  'The same vocabulary agent definitions declare, so capability matching compares like with like. Constrained against the literal set rather than mirrored into a table - a CHECK needs nothing kept in step.';

create index if not exists models_available_idx
  on ai.models (organization_id, provider)
  where status = 'available';

-- ═══════════════════════════════════════════════════════════════════════════
-- What each category of agent optimises for
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADM-84 fixed the scope: **per category, not per agent**. Thirteen agents
-- would be thirteen independent knobs and no coherent policy; seven categories
-- correspond to behaviour that genuinely differs. An agent may still express a
-- model *preference* in its definition — it may never name one it cannot run
-- without, because that pins it to a vendor's release schedule.

create table if not exists ai.routing_policies (
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- The seven ADM-84 names. A new category is a decision, not a row.
  category         text not null check (category in (
                     'engineering', 'coordination', 'client_facing',
                     'extraction', 'design', 'money', 'certification'
                   )),

  optimise_for     text not null default 'quality'
                     check (optimise_for in ('quality', 'cost', 'latency')),

  -- Ordered preference. May be empty: with no preference the resolver falls
  -- back to capability matching alone, which is a weaker answer rather than a
  -- broken one.
  preferred_models text[] not null default '{}'::text[],

  -- ADM-84: an explicit Admin override wins outright. Null is the normal case.
  admin_override_model text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  primary key (organization_id, category)
);

comment on table ai.routing_policies is
  'What each category of agent optimises for, per organization (ADM-84 R3). Per CATEGORY rather than per agent: thirteen agents would be thirteen knobs and no policy. Ships empty - an organization with no policy row gets capability matching alone, which is a weaker answer rather than a broken one.';

comment on column ai.routing_policies.admin_override_model is
  'When set, wins outright over preference and signals (ADM-84). The escape hatch an Admin reaches for when a model misbehaves and nobody has time to reason about policy.';

-- ── tenant isolation, the shape every other table here uses ──────────────
--
-- Read is internal, because the resolver runs as internal. Write is
-- `core.is_admin()`: routing policy is Admin configuration, and ADM-84 put the
-- override in an Admin's hands specifically.

alter table ai.models enable row level security;
alter table ai.routing_policies enable row level security;

drop policy if exists models_select on ai.models;
create policy models_select on ai.models
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists models_write on ai.models;
create policy models_write on ai.models
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

drop policy if exists routing_policies_select on ai.routing_policies;
create policy routing_policies_select on ai.routing_policies
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists routing_policies_write on ai.routing_policies;
create policy routing_policies_write on ai.routing_policies
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_admin())
  );

drop trigger if exists set_updated_at on ai.models;
create trigger set_updated_at
  before update on ai.models
  for each row execute function core.set_updated_at();

drop trigger if exists set_updated_at on ai.routing_policies;
create trigger set_updated_at
  before update on ai.routing_policies
  for each row execute function core.set_updated_at();

-- ── what routing cannot do ───────────────────────────────────────────────
--
-- ADM-84 lists it and it is worth stating where the tables live: routing
-- cannot increase an agent's authority, bypass RLS, bypass approval, create
-- money authority, or create client-send authority. Nothing here can — these
-- two tables decide *which model answers*, and every authority question is
-- settled before a model is reached, by the registry, the tool boundary, the
-- autonomy guard and the approval engine.
--
-- That is not a comment standing in for enforcement. It is true because
-- routing has no reference to any of those mechanisms and no way to address
-- them, which is the strongest form the property can take.
