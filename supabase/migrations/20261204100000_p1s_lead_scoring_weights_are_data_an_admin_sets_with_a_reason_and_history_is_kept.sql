-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 rest-gaps round 4, step 2 (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-CRM-019 / P1-CRM-020 / P1-CRM-052   the weights a lead's score is computed with are DATA an administrator sets, not constants in code
--
-- src/modules/crm/lead-score.ts keeps the factors (they are the model); what moves out of code is how many points each factor is worth. A weight set is
-- an append-only VERSION: saving one never edits an earlier one, so a score stored last month can still be traced to the weights that produced it.
-- With no row the code defaults apply (they are the values the model has always used: nothing changes until an administrator sets a different set).
--
-- The score stays a prioritisation aid: the door refuses a set that does not add up to 100 (the model's own rule), and an override of a score or a
-- heat label (crm.override_lead_score / override_lead_heat) is untouched. WHICH numbers to choose is the owner's decision; this only lets them choose.
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.event_types (type, description, canonical) values
  ('lead_scoring.weights_set', 'An administrator saved a new version of the lead-scoring weights.', false)
on conflict (type) do nothing;

create table if not exists crm.p1s_lead_score_weight_sets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  version         integer not null check (version > 0),
  weights         jsonb not null check (jsonb_typeof(weights) = 'object'),
  reason          text not null check (length(btrim(reason)) between 1 and 500),
  created_by      uuid not null references core.users(id) on delete restrict,
  created_at      timestamptz not null default clock_timestamp(),
  unique (organization_id, version)
);
comment on table crm.p1s_lead_score_weight_sets is
  'P1-CRM-020. One complete set of lead-scoring weights per version, append-only: a saved set is never edited or deleted. The newest version is in force; with no row the defaults in src/modules/crm/lead-score.ts apply. Written only through crm.p1s_set_lead_score_weights.';
create index if not exists p1s_lead_score_weight_sets_latest_idx on crm.p1s_lead_score_weight_sets (organization_id, version desc);

drop trigger if exists freeze_org_p1s_lead_score_weight_sets on crm.p1s_lead_score_weight_sets;
create trigger freeze_org_p1s_lead_score_weight_sets before update of organization_id on crm.p1s_lead_score_weight_sets
  for each row execute function core.freeze_organization_id();

create or replace function crm.p1s_lead_score_weight_sets_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- a deleted organization takes its history with it (the parent is already gone by then); nothing else may change or remove a saved set
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations o where o.id = old.organization_id) then return old; end if;
  raise exception 'a saved lead-scoring weight set is history: it is never edited or deleted' using errcode = 'restrict_violation';
end $$;
drop trigger if exists p1s_lead_score_weight_sets_guard on crm.p1s_lead_score_weight_sets;
create trigger p1s_lead_score_weight_sets_guard before update or delete on crm.p1s_lead_score_weight_sets for each row execute function crm.p1s_lead_score_weight_sets_guard();

alter table crm.p1s_lead_score_weight_sets enable row level security;
alter table crm.p1s_lead_score_weight_sets force row level security;
drop policy if exists p1s_lead_score_weight_sets_read on crm.p1s_lead_score_weight_sets;
create policy p1s_lead_score_weight_sets_read on crm.p1s_lead_score_weight_sets for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on crm.p1s_lead_score_weight_sets from public, anon, authenticated;
grant select on crm.p1s_lead_score_weight_sets to authenticated;
grant all on crm.p1s_lead_score_weight_sets to service_role;

-- the shape a set must have: all eleven keys, whole numbers, adding up to 100 (the eight positive maxima), with the partial tiers not above the full ones
create or replace function crm.p1s_lead_score_weights_problem(p_weights jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  k text;
  v_keys text[] := array['coverage_max', 'budget_known', 'decision_maker', 'timeline_stated', 'engagement_some', 'engagement_many', 'recency_fresh', 'recency_recent', 'deal_value', 'referral', 'stale_penalty'];
  v_sum numeric := 0;
begin
  if p_weights is null or jsonb_typeof(p_weights) <> 'object' then return 'the weights must be a JSON object'; end if;
  for k in select jsonb_object_keys(p_weights) loop
    if not (k = any (v_keys)) then return 'unknown weight "' || left(k, 40) || '"'; end if;
  end loop;
  foreach k in array v_keys loop
    if not (p_weights ? k) then return 'weight "' || k || '" is missing: a set is complete'; end if;
    if jsonb_typeof(p_weights -> k) <> 'number' or (p_weights ->> k) !~ '^[0-9]+$' then return 'weight "' || k || '" must be a whole number'; end if;
    if (p_weights ->> k)::numeric > 100 then return 'weight "' || k || '" cannot exceed 100'; end if;
  end loop;
  if (p_weights ->> 'stale_penalty')::numeric > 50 then return 'the stale penalty cannot exceed 50'; end if;
  if (p_weights ->> 'engagement_some')::numeric > (p_weights ->> 'engagement_many')::numeric then return 'a few replies cannot be worth more than many'; end if;
  if (p_weights ->> 'recency_recent')::numeric > (p_weights ->> 'recency_fresh')::numeric then return 'a week-old reply cannot be worth more than a fresh one'; end if;
  foreach k in array array['coverage_max', 'budget_known', 'decision_maker', 'timeline_stated', 'engagement_many', 'recency_fresh', 'deal_value', 'referral'] loop
    v_sum := v_sum + (p_weights ->> k)::numeric;
  end loop;
  if v_sum <> 100 then return 'the positive weights add up to ' || v_sum || ', not 100'; end if;
  return null;
end $$;

create or replace function crm.p1s_set_lead_score_weights(p_weights jsonb, p_reason text)
returns table (outcome text, version integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_problem text; v_last crm.p1s_lead_score_weight_sets; v_next integer;
begin
  if v_actor is null then return query select 'no_actor'::text, null::integer; return; end if;
  if v_org is null or not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::integer; return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text, null::integer; return; end if;
  v_problem := crm.p1s_lead_score_weights_problem(p_weights);
  if v_problem is not null then return query select ('invalid_weights: ' || v_problem)::text, null::integer; return; end if;
  -- serialise per organization so two admins cannot take the same number
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':lead_score_weights', 13));
  select s.* into v_last from crm.p1s_lead_score_weight_sets s where s.organization_id = v_org order by s.version desc limit 1;
  if v_last.id is not null and v_last.weights = p_weights then return query select 'unchanged'::text, v_last.version; return; end if;
  v_next := coalesce(v_last.version, 0) + 1;
  insert into crm.p1s_lead_score_weight_sets (organization_id, version, weights, reason, created_by)
    values (v_org, v_next, p_weights, left(btrim(p_reason), 500), v_actor);
  perform core.record_audit(v_org, 'lead_scoring.weights_set', 'organization', v_org,
    case when v_last.id is null then null else jsonb_build_object('version', v_last.version, 'weights', v_last.weights) end,
    jsonb_build_object('version', v_next, 'weights', p_weights, 'reason', left(btrim(p_reason), 500)));
  perform core.emit_event(v_org, 'lead_scoring.weights_set', 'organization', v_org, jsonb_build_object('version', v_next));
  return query select 'set'::text, v_next;
end $$;
revoke all on function crm.p1s_set_lead_score_weights(jsonb, text) from public, anon;
grant execute on function crm.p1s_set_lead_score_weights(jsonb, text) to authenticated;

-- the set in force: {version, weights, setAt, reason}; version 0 and weights null mean "the code defaults"
create or replace function crm.p1s_lead_score_weights()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); s crm.p1s_lead_score_weight_sets;
begin
  if (select auth.uid()) is null and (select auth.role()) is distinct from 'service_role' then return null; end if;
  if (select auth.uid()) is not null and not coalesce((select core.is_internal()), false) then return null; end if;
  if v_org is null then return null; end if;
  select x.* into s from crm.p1s_lead_score_weight_sets x where x.organization_id = v_org order by x.version desc limit 1;
  if s.id is null then return jsonb_build_object('version', 0, 'weights', null); end if;
  return jsonb_build_object('version', s.version, 'weights', s.weights, 'setAt', s.created_at, 'reason', s.reason);
end $$;
revoke all on function crm.p1s_lead_score_weights() from public, anon;
grant execute on function crm.p1s_lead_score_weights() to authenticated, service_role;
