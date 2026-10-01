-- ═══════════════════════════════════════════════════════════════════════════
-- Search by meaning (owner decision 14: AI / semantic search over everything
-- searchable).
--
-- What this adds, and what it deliberately does not:
--
--   core.search_embeddings     one row per (organisation, entity type, entity
--                              id): a content hash, a unit-length-comparable
--                              vector stored as real[], its norm, the model.
--                              pgvector is NOT assumed: a real[] scan over a
--                              bounded candidate set is correct and is the
--                              honest ceiling (tens of thousands of rows). The
--                              production upgrade is a pgvector column + HNSW
--                              index behind the same core.semantic_search
--                              signature. No text is stored here — only the
--                              vector — so there is nothing to leak.
--   core.semantic_search_state one row per organisation: whether the owner has
--                              turned meaning search on (the backfill), its
--                              progress, and the scan cursors the indexing job
--                              keeps between ticks.
--   core.semantic_search(...)  SECURITY DEFINER cosine ranking over the
--                              caller's own organisation, restricted to the
--                              entity types the caller's ROLES may read (the
--                              same sets as lead.read / project.read /
--                              invoice.read / audit.read in
--                              src/lib/authz/permissions.ts). The application
--                              then re-reads every hit under the caller's own
--                              row-level security, so a record a person cannot
--                              open is never returned.
--   writes                     only through service-role doors
--                              (core.upsert_search_embeddings,
--                              core.delete_search_embeddings) and the owner's
--                              two doors (core.request_semantic_backfill,
--                              core.stop_semantic_indexing, both audited).
--                              authenticated has no grant on either table.
--   embedding spend            ai.cost_ledger under the infrastructure key
--                              'semantic_indexer' (a new nullable provider
--                              column says which vendor), written by
--                              ai.record_embedding_usage, and counted by the
--                              provider and model monthly-budget functions so
--                              the existing gates refuse when a cap is reached.
--
-- Additive and idempotent: applying it twice changes nothing the second time.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the ledger learns which provider a row's spend went to ─────────────────
alter table ai.cost_ledger add column if not exists provider text;

comment on column ai.cost_ledger.provider is
  'Which vendor the spend went to, where the writer knows it (embedding spend does). Null for rows rolled up from agent runs, whose provider is on the step.';

-- The ledger key embedding spend is recorded under. Infrastructure, not an
-- agent: it has no definition in the code registry (the stamp leaves it alone,
-- as it leaves the two preserved rows), is L0 and takes no work.
insert into ai.agents (key, display_name, description, autonomy_level, enabled, disabled_reason, default_model, max_steps, max_cost_minor)
values ('semantic_indexer', 'Search indexer', 'Ledger key for the spend of turning records into search vectors (search by meaning). Infrastructure, not an agent: it takes no work and has no autonomy.', 'L0', false, 'Not an agent: this row only names the ledger key the search indexer''s embedding spend is recorded under. It is never enabled and takes no work.', 'text-embedding-3-small', 1, 1)
on conflict (key) do nothing;

-- ── the vectors ────────────────────────────────────────────────────────────
create table if not exists core.search_embeddings (
  organization_id uuid not null references core.organizations (id) on delete cascade,
  entity_type     text not null check (entity_type in ('Lead','Client','Project','Invoice','Quotation','Meeting','Task','Requirement','File','Agent','Audit')),
  entity_id       text not null check (length(entity_id) between 1 and 200),
  content_hash    text not null check (length(content_hash) between 16 and 128),
  embedding       real[] not null check (cardinality(embedding) between 8 and 3072),
  norm            real not null check (norm > 0),
  model           text not null check (length(btrim(model)) > 0),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, entity_type, entity_id)
);

comment on table core.search_embeddings is
  'Search-by-meaning vectors (decision 14). One row per record; the text they were made from is NOT stored. real[] scan over a bounded candidate set — fine for tens of thousands of rows; pgvector + an HNSW index is the production upgrade. No grant to authenticated: read only through core.semantic_search, written only through the service-role doors.';

create index if not exists search_embeddings_org_type_idx on core.search_embeddings (organization_id, entity_type, updated_at desc);

drop trigger if exists freeze_org_search_embeddings on core.search_embeddings;
create trigger freeze_org_search_embeddings
  before update of organization_id on core.search_embeddings
  for each row execute function core.freeze_organization_id();

alter table core.search_embeddings enable row level security;
alter table core.search_embeddings force row level security;
-- No policy for authenticated: row level security denies every direct read.

revoke all on core.search_embeddings from public, anon, authenticated;
grant select, insert, update, delete on core.search_embeddings to service_role;

-- ── the owner's switch, progress and the indexing job's cursors ────────────
create table if not exists core.semantic_search_state (
  organization_id uuid primary key references core.organizations (id) on delete cascade,
  enabled         boolean not null default false,
  status          text not null default 'off' check (status in ('off','requested','running','done','blocked')),
  model           text,
  total           integer not null default 0 check (total >= 0),
  done            integer not null default 0 check (done >= 0),
  cursors         jsonb not null default '{}'::jsonb,
  passes          jsonb not null default '{}'::jsonb,
  note            text,
  requested_by    uuid references core.users (id) on delete set null,
  requested_at    timestamptz,
  last_run_at     timestamptz,
  updated_at      timestamptz not null default now()
);

comment on table core.semantic_search_state is
  'Whether search by meaning is on for an organisation (set by the owner through core.request_semantic_backfill after a cost estimate was shown), the backfill progress, and the per-type scan cursors the indexing job keeps. Written only by the doors and the service role.';

drop trigger if exists set_updated_at on core.semantic_search_state;
create trigger set_updated_at before update on core.semantic_search_state
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_semantic_search_state on core.semantic_search_state;
create trigger freeze_org_semantic_search_state
  before update of organization_id on core.semantic_search_state
  for each row execute function core.freeze_organization_id();

alter table core.semantic_search_state enable row level security;
alter table core.semantic_search_state force row level security;

drop policy if exists semantic_search_state_select on core.semantic_search_state;
create policy semantic_search_state_select on core.semantic_search_state
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on core.semantic_search_state from public, anon, authenticated;
grant select on core.semantic_search_state to authenticated;
grant select, insert, update, delete on core.semantic_search_state to service_role;

-- ── who may find what: the entity types a caller's roles may read ──────────
-- Mirrors can(): lead.read, project.read, invoice.read, audit.read. Agents are
-- read with audit.read, as the keyword search reads them. A client role holds
-- none of the internal roles and so gets none.
create or replace function core.semantic_visible_types()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(t order by t), '{}'::text[])
    from (
      select unnest(array['Lead','Quotation','Meeting']) as t
       where core.holds_role('owner') or core.holds_role('ops_admin') or core.holds_role('delivery_lead') or core.holds_role('member')
      union all
      select unnest(array['Client','Project','Task','Requirement','File'])
       where core.holds_role('owner') or core.holds_role('ops_admin') or core.holds_role('delivery_lead') or core.holds_role('member') or core.holds_role('contractor')
      union all
      select 'Invoice'
       where core.holds_role('owner') or core.holds_role('ops_admin') or core.holds_role('finance')
      union all
      select unnest(array['Agent','Audit'])
       where core.holds_role('owner') or core.holds_role('ops_admin')
    ) v;
$$;

comment on function core.semantic_visible_types() is
  'The entity types the caller''s roles (primary and granted) may read — the same sets as lead.read, project.read, invoice.read and audit.read.';

revoke all on function core.semantic_visible_types() from public, anon;
grant execute on function core.semantic_visible_types() to authenticated, service_role;

-- ── the ranking ────────────────────────────────────────────────────────────
-- Cosine similarity of the query against the caller's organisation's vectors
-- of one model, over at most p_candidate_cap of the most recently indexed
-- rows of the types the caller may read. Bounded on purpose: this is the
-- real[] scan, and its cost is the cap.
create or replace function core.semantic_search(
  p_query real[],
  p_model text,
  p_types text[] default null,
  p_limit integer default 40,
  p_min_score real default 0.25,
  p_candidate_cap integer default 20000
)
returns table (entity_type text, entity_id text, score real)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org    uuid := (select core.current_organization_id());
  v_actor  uuid := (select auth.uid());
  v_types  text[];
  v_qnorm  double precision;
  v_dims   integer;
begin
  if v_actor is null or v_org is null then
    return;
  end if;
  if p_query is null or cardinality(p_query) < 8 or p_model is null then
    return;
  end if;

  v_types := core.semantic_visible_types();
  if p_types is not null then
    select coalesce(array_agg(t), '{}'::text[]) into v_types from unnest(v_types) as t where t = any(p_types);
  end if;
  if cardinality(v_types) = 0 then
    return;
  end if;

  select sqrt(sum(x::double precision * x::double precision)) into v_qnorm from unnest(p_query) as x;
  if v_qnorm is null or v_qnorm = 0 then
    return;
  end if;
  v_dims := cardinality(p_query);

  return query
    select c.entity_type, c.entity_id,
           (d.dot / (c.norm::double precision * v_qnorm))::real as score
      from (
        select e.entity_type, e.entity_id, e.embedding, e.norm
          from core.search_embeddings e
         where e.organization_id = v_org
           and e.entity_type = any(v_types)
           and e.model = p_model
           and cardinality(e.embedding) = v_dims
         order by e.updated_at desc
         limit greatest(1, least(coalesce(p_candidate_cap, 20000), 50000))
      ) c
      cross join lateral (
        select sum(a.x::double precision * a.y::double precision) as dot
          from unnest(c.embedding, p_query) as a(x, y)
      ) d
     where (d.dot / (c.norm::double precision * v_qnorm)) >= coalesce(p_min_score, 0.25)
     order by 3 desc
     limit greatest(1, least(coalesce(p_limit, 40), 200));
end;
$$;

comment on function core.semantic_search(real[], text, text[], integer, real, integer) is
  'Cosine ranking of a query vector against the caller''s organisation''s search vectors of one model, over a bounded candidate set and only the entity types the caller''s roles may read. The caller re-reads every hit under its own row-level security.';

revoke all on function core.semantic_search(real[], text, text[], integer, real, integer) from public, anon;
grant execute on function core.semantic_search(real[], text, text[], integer, real, integer) to authenticated, service_role;

-- ── service-role doors: the indexing job's writes ──────────────────────────
create or replace function core.upsert_search_embeddings(p_organization_id uuid, p_model text, p_rows jsonb)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row   jsonb;
  v_vec   real[];
  v_norm  double precision;
  v_count integer := 0;
begin
  if p_organization_id is null or p_model is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'upsert_search_embeddings: organisation, model and a row array are required';
  end if;
  for v_row in select * from jsonb_array_elements(p_rows) loop
    select array_agg((x)::real order by ord) into v_vec
      from jsonb_array_elements_text(v_row -> 'embedding') with ordinality as t(x, ord);
    select sqrt(sum(x::double precision * x::double precision)) into v_norm from unnest(v_vec) as x;
    if v_vec is null or v_norm is null or v_norm = 0 then
      continue;
    end if;
    insert into core.search_embeddings (organization_id, entity_type, entity_id, content_hash, embedding, norm, model, updated_at)
    values (p_organization_id, v_row ->> 'entity_type', v_row ->> 'entity_id', v_row ->> 'content_hash', v_vec, v_norm::real, p_model, now())
    on conflict (organization_id, entity_type, entity_id) do update
       set content_hash = excluded.content_hash, embedding = excluded.embedding, norm = excluded.norm, model = excluded.model, updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function core.upsert_search_embeddings(uuid, text, jsonb) is
  'Service-role door for the indexing job: writes vectors for [{entity_type, entity_id, content_hash, embedding}] and computes each norm. Never callable by a session.';

revoke all on function core.upsert_search_embeddings(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function core.upsert_search_embeddings(uuid, text, jsonb) to service_role;

create or replace function core.delete_search_embeddings(p_organization_id uuid, p_entity_type text, p_entity_ids text[])
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from core.search_embeddings
     where organization_id = p_organization_id and entity_type = p_entity_type and entity_id = any(p_entity_ids)
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function core.delete_search_embeddings(uuid, text, text[]) from public, anon, authenticated;
grant execute on function core.delete_search_embeddings(uuid, text, text[]) to service_role;

-- ── the embedding spend, in the ledger the budgets already read ────────────
create or replace function ai.record_embedding_usage(p_organization_id uuid, p_model text, p_provider text, p_input_tokens bigint, p_cost_minor bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_day date;
begin
  select ((now() at time zone coalesce(o.timezone, 'UTC'))::date) into v_day from core.organizations o where o.id = p_organization_id;
  if v_day is null then
    return;
  end if;
  insert into ai.cost_ledger (organization_id, day, agent_key, model, provider, runs, input_tokens, output_tokens, cost_minor)
  values (p_organization_id, v_day, 'semantic_indexer', p_model, p_provider, 1, greatest(coalesce(p_input_tokens, 0), 0), 0, greatest(coalesce(p_cost_minor, 0), 0))
  on conflict (organization_id, day, agent_key, model) do update
     set runs = ai.cost_ledger.runs + 1,
         input_tokens = ai.cost_ledger.input_tokens + excluded.input_tokens,
         cost_minor = ai.cost_ledger.cost_minor + excluded.cost_minor,
         provider = coalesce(excluded.provider, ai.cost_ledger.provider);
end;
$$;

comment on function ai.record_embedding_usage(uuid, text, text, bigint, bigint) is
  'Service-role door: adds one embedding call''s tokens and cost to the organisation''s day in ai.cost_ledger under the semantic_indexer key. Cost is what the models table''s price says, or 0 when no price is set — never estimated.';

revoke all on function ai.record_embedding_usage(uuid, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function ai.record_embedding_usage(uuid, text, text, bigint, bigint) to service_role;

-- The monthly budgets count embedding spend beside agent steps.
create or replace function ai.provider_spend_this_month(p_organization_id uuid, p_provider text)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select (
    coalesce((select sum(s.cost_minor)
                from ai.agent_steps s
               where s.organization_id = p_organization_id
                 and s.kind = 'model_call'
                 and s.request ->> 'provider' = p_provider
                 and s.created_at >= date_trunc('month', now())), 0)
    +
    coalesce((select sum(l.cost_minor)
                from ai.cost_ledger l
               where l.organization_id = p_organization_id
                 and l.agent_key = 'semantic_indexer'
                 and l.provider = p_provider
                 and l.day >= date_trunc('month', now())::date), 0)
  )::bigint;
$$;

comment on function ai.provider_spend_this_month(uuid, text) is
  'Sum of ai.agent_steps.cost_minor for one provider since the first of this month plus the provider''s embedding spend from ai.cost_ledger (semantic_indexer) — what the budget is measured against. Never estimated.';

create or replace function ai.model_spend_this_month(p_organization_id uuid, p_model_id text)
returns bigint
language sql
stable
set search_path = ''
as $$
  select (
    coalesce((select sum(s.cost_minor)
                from ai.agent_steps s
               where s.organization_id = p_organization_id
                 and s.kind = 'model_call'
                 and s.request ->> 'model' = p_model_id
                 and s.created_at >= date_trunc('month', now())), 0)
    +
    coalesce((select sum(l.cost_minor)
                from ai.cost_ledger l
               where l.organization_id = p_organization_id
                 and l.agent_key = 'semantic_indexer'
                 and l.model = p_model_id
                 and l.day >= date_trunc('month', now())::date), 0)
  )::bigint;
$$;

-- ── the owner's doors ──────────────────────────────────────────────────────
create or replace function core.request_semantic_backfill(p_total integer, p_model text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  if p_model is null or length(btrim(p_model)) = 0 or p_total is null or p_total < 0 then
    return query select 'bad_request'::text; return;
  end if;

  select to_jsonb(s.*) into v_before from core.semantic_search_state s where s.organization_id = v_org;

  insert into core.semantic_search_state (organization_id, enabled, status, model, total, done, cursors, passes, note, requested_by, requested_at)
  values (v_org, true, 'requested', p_model, p_total, 0, '{}'::jsonb, '{}'::jsonb, null, v_actor, now())
  on conflict (organization_id) do update
     set enabled = true, status = 'requested', model = excluded.model, total = excluded.total, done = 0,
         cursors = '{}'::jsonb, passes = '{}'::jsonb, note = null, requested_by = excluded.requested_by, requested_at = now()
  returning to_jsonb(core.semantic_search_state.*) into v_after;

  perform core.record_audit(v_org, 'semantic_search.backfill_requested', 'semantic_search', null, v_before,
                            jsonb_build_object('model', p_model, 'estimated_records', p_total));
  return query select 'requested'::text;
end;
$$;

comment on function core.request_semantic_backfill(integer, text) is
  'Owner only, audited: turns search by meaning on and asks the indexing job to embed every searchable record. The screen shows a cost estimate and asks for confirmation before calling it; p_total is the record count that estimate was made for.';

revoke all on function core.request_semantic_backfill(integer, text) from public, anon;
grant execute on function core.request_semantic_backfill(integer, text) to authenticated;

create or replace function core.stop_semantic_indexing()
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_was   text;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_owner'::text; return;
  end if;
  select status into v_was from core.semantic_search_state where organization_id = v_org and enabled;
  if v_was is null then
    return query select 'unchanged'::text; return;
  end if;
  update core.semantic_search_state set enabled = false, status = 'off', note = null where organization_id = v_org;
  perform core.record_audit(v_org, 'semantic_search.stopped', 'semantic_search', null, jsonb_build_object('status', v_was), null);
  return query select 'stopped'::text;
end;
$$;

comment on function core.stop_semantic_indexing() is
  'Owner only, audited: turns search by meaning off and stops the indexing job spending. Existing vectors are kept; search by meaning answers nothing while it is off.';

revoke all on function core.stop_semantic_indexing() from public, anon;
grant execute on function core.stop_semantic_indexing() to authenticated;

-- ── a person's search is one small embedding call, and it is spend too ─────
-- The budgets are readable only by owner and ops_admin, but any internal role
-- may search; so the question "may one more embedding go to this provider /
-- model this month?" is answered here, for the caller's own organisation
-- only, without handing the caller the figures.
create or replace function ai.semantic_budget_allows(p_provider text, p_model text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org  uuid := (select core.current_organization_id());
  v_cap  bigint;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then
    return false;
  end if;
  select monthly_cap_minor into v_cap from ai.provider_budgets where organization_id = v_org and provider = p_provider;
  if v_cap is not null and ai.provider_spend_this_month(v_org, p_provider) >= v_cap then
    return false;
  end if;
  v_cap := null;
  select monthly_cap_minor into v_cap from ai.model_budgets where organization_id = v_org and model_id = p_model;
  if v_cap is not null and ai.model_spend_this_month(v_org, p_model) >= v_cap then
    return false;
  end if;
  return true;
end;
$$;

comment on function ai.semantic_budget_allows(text, text) is
  'True when neither the provider''s nor the model''s monthly cap has been reached for the caller''s organisation. Lets any internal role''s search ask the gate without reading the budgets.';

revoke all on function ai.semantic_budget_allows(text, text) from public, anon;
grant execute on function ai.semantic_budget_allows(text, text) to authenticated, service_role;

create or replace function ai.record_query_embedding_usage(p_model text, p_provider text, p_input_tokens bigint, p_cost_minor bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or v_org is null or not coalesce((select core.is_internal()), false) then
    return;
  end if;
  -- Only while search by meaning is on, and clamped: a query is a few dozen
  -- tokens, so a session cannot write a large figure into the ledger.
  if not exists (select 1 from core.semantic_search_state s where s.organization_id = v_org and s.enabled) then
    return;
  end if;
  perform ai.record_embedding_usage(v_org, p_model, p_provider, least(greatest(coalesce(p_input_tokens, 0), 0), 2000), least(greatest(coalesce(p_cost_minor, 0), 0), 100));
end;
$$;

comment on function ai.record_query_embedding_usage(text, text, bigint, bigint) is
  'A person''s search by meaning embeds the query once; this puts those tokens in the ledger. Internal roles only, only while search by meaning is on, clamped to a query''s size.';

revoke all on function ai.record_query_embedding_usage(text, text, bigint, bigint) from public, anon;
grant execute on function ai.record_query_embedding_usage(text, text, bigint, bigint) to authenticated;
