-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 rest-gaps round 4, step 1 (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-BLUEPRINT-031 / P1-QUOTE-018 / P1-QUOTE-008   the quoting and discount engine reads the policy version in force
--
-- Round 1 (20261128100000) made pricing and discount policies VERSIONED records, and said honestly that the engine did not read them: editing a version
-- changed nothing it enforced. This closes that. THE RULE, stated once:
--
--   For each of three limits, an ACTIVE policy version that carries the field is the authority; with no such version the organization setting that has
--   always been the authority still is. Nothing changes for an organization that has activated no version.
--
--     negotiation_max_discount_pct             <- discount policy  .max_discount_pct          (percent)
--     negotiation_min_price_rupees             <- pricing policy   .minimum_price_minor / 100
--     negotiation_max_autonomous_quote_rupees  <- pricing policy   .autonomous_max_minor / 100
--
-- It is read at the three places that enforce the limit today (record_discount_decision, set_approved_offer, apply_approved_offer) and at the place
-- that records a breach for the approver (p1o_limit_breaches). Those four function bodies are PATCHED from their live definitions (pg_get_functiondef +
-- regexp_replace; a patch that changes nothing raises), not rewritten, so whichever migration defined them last is the body that is patched and no
-- other builder's change to them is overwritten. A discount decision records the version it was judged by; a quote's policy snapshot lists the versions
-- in force when it entered review (and is unchanged, key for key, when none is in force).
--
-- Nothing here approves, sends or moves money. The functions below grant nothing to anon; the org-parameterised ones are callable only by the definer
-- functions that already hold the organization (service_role); p1s_limit_in_force is also callable by a signed-in user (an invoker function asks it for them)
-- and answers 'unset' for any organization but their own, so one organization cannot ask for another's limits.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the limit in force ──────────────────────────────────────────────────────
create or replace function sales.p1s_limit_in_force(p_organization_id uuid, p_key text, p_at timestamptz default clock_timestamp())
returns table (value numeric, source text, policy_version_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text; v_field text; v_div numeric; v_pv uuid; v_raw jsonb; v_setting text;
begin
  -- set_approved_offer is a SECURITY INVOKER function and asks this on a signed-in user's behalf: a signed-in user is answered for their own organization only
  if (select auth.uid()) is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select null::numeric, 'unset'::text, null::uuid;
    return;
  end if;
  select m.kind, m.field, m.div into v_kind, v_field, v_div
    from (values
      ('negotiation_max_discount_pct', 'discount', 'max_discount_pct', 1::numeric),
      ('negotiation_min_price_rupees', 'pricing', 'minimum_price_minor', 100::numeric),
      ('negotiation_max_autonomous_quote_rupees', 'pricing', 'autonomous_max_minor', 100::numeric)
    ) as m(key, kind, field, div) where m.key = p_key;
  if v_kind is null then
    return query select null::numeric, 'unknown_key'::text, null::uuid;
    return;
  end if;

  v_pv := core.p13_policy_version_in_force(p_organization_id, v_kind, p_at);
  if v_pv is not null then
    select b.body -> v_field into v_raw from core.p13_policy_versions b where b.id = v_pv;
    if v_raw is not null and jsonb_typeof(v_raw) = 'number' then
      return query select ((v_raw #>> '{}')::numeric / v_div), 'policy_version'::text, v_pv;
      return;
    end if;
  end if;

  select nullif(o.settings ->> p_key, '') into v_setting from core.organizations o where o.id = p_organization_id;
  if v_setting is not null and v_setting ~ '^[0-9]+(\.[0-9]+)?$' then
    return query select v_setting::numeric, 'setting'::text, null::uuid;
  else
    return query select null::numeric, 'unset'::text, null::uuid;
  end if;
end $$;
revoke all on function sales.p1s_limit_in_force(uuid, text, timestamptz) from public, anon;
grant execute on function sales.p1s_limit_in_force(uuid, text, timestamptz) to authenticated, service_role;

-- the versions in force, as a jsonb object; null when there are none (so a snapshot without them is byte-for-byte the old snapshot)
create or replace function sales.p1s_policy_versions_in_force(p_organization_id uuid, p_at timestamptz default clock_timestamp())
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(coalesce(jsonb_object_agg(k.kind, jsonb_build_object('id', v.id, 'version', v.version)) filter (where v.id is not null), '{}'::jsonb), '{}'::jsonb)
    from (values ('discount'), ('pricing')) as k(kind)
    left join lateral (select pv.id, pv.version from core.p13_policy_versions pv where pv.id = core.p13_policy_version_in_force(p_organization_id, k.kind, p_at)) v on true;
$$;
revoke all on function sales.p1s_policy_versions_in_force(uuid, timestamptz) from public, anon, authenticated;
grant execute on function sales.p1s_policy_versions_in_force(uuid, timestamptz) to service_role;

-- the breaches recorded for the approver: a total under the minimum price, over the autonomous maximum, or at/over the high-value threshold. Only a policy
-- VERSION produces these (the setting-based limits already refuse at their own doors). It refuses nothing.
create or replace function sales.p1s_policy_breaches(p_organization_id uuid, p_total_minor bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pv uuid; v_out jsonb := '[]'::jsonb; v_min numeric; v_max numeric; v_high numeric; v_d uuid;
begin
  v_pv := core.p13_policy_version_in_force(p_organization_id, 'pricing');
  if v_pv is not null then
    select (b.body ->> 'minimum_price_minor')::numeric, (b.body ->> 'autonomous_max_minor')::numeric into v_min, v_max from core.p13_policy_versions b where b.id = v_pv;
    if v_min is not null and p_total_minor < v_min then
      v_out := v_out || jsonb_build_array(jsonb_build_object('limit', 'policy_minimum_price_minor', 'allowed', v_min, 'actual', p_total_minor, 'policyVersionId', v_pv));
    end if;
    if v_max is not null and p_total_minor > v_max then
      v_out := v_out || jsonb_build_array(jsonb_build_object('limit', 'policy_autonomous_max_minor', 'allowed', v_max, 'actual', p_total_minor, 'policyVersionId', v_pv));
    end if;
  end if;
  v_d := core.p13_policy_version_in_force(p_organization_id, 'discount');
  if v_d is not null then
    select (b.body ->> 'high_value_threshold_minor')::numeric into v_high from core.p13_policy_versions b where b.id = v_d;
    if v_high is not null and p_total_minor >= v_high then
      v_out := v_out || jsonb_build_array(jsonb_build_object('limit', 'policy_high_value_threshold_minor', 'allowed', v_high, 'actual', p_total_minor, 'policyVersionId', v_d));
    end if;
  end if;
  return v_out;
end $$;
revoke all on function sales.p1s_policy_breaches(uuid, bigint) from public, anon, authenticated;
grant execute on function sales.p1s_policy_breaches(uuid, bigint) to service_role;

-- ── a discount decision records the version it was judged by ────────────────
alter table sales.discount_decisions add column if not exists policy_version_id uuid references core.p13_policy_versions(id) on delete restrict;
comment on column sales.discount_decisions.policy_version_id is
  'P1-QUOTE-018. The policy version whose max_discount_pct bounded this decision, when one was in force and carried that field; null when the organization setting was the authority.';
drop trigger if exists org_match_discount_decisions_policy_version on sales.discount_decisions;
create trigger org_match_discount_decisions_policy_version before insert or update of policy_version_id, organization_id on sales.discount_decisions
  for each row execute function core.enforce_parent_org('policy_version_id', 'core.p13_policy_versions');

create or replace function sales.p1s_stamp_discount_policy_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.policy_version_id is null then
    select l.policy_version_id into new.policy_version_id from sales.p1s_limit_in_force(new.organization_id, 'negotiation_max_discount_pct') l;
  end if;
  return new;
end $$;
revoke all on function sales.p1s_stamp_discount_policy_version() from public, anon, authenticated;
drop trigger if exists p1s_stamp_discount_policy_version on sales.discount_decisions;
create trigger p1s_stamp_discount_policy_version before insert on sales.discount_decisions for each row execute function sales.p1s_stamp_discount_policy_version();

-- ── the patches: the live definitions, with the setting read replaced by the limit in force ─────────────
create or replace function pg_temp.p1s_patch(p_proc regprocedure, p_pattern text, p_replacement text, p_flags text default 'g')
returns void language plpgsql as $$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef(p_proc);
  v_new := regexp_replace(v_def, p_pattern, p_replacement, p_flags);
  if v_new = v_def then raise exception 'p1s patch changed nothing in %: the live definition no longer has the shape this patch expects', p_proc; end if;
  execute v_new;
end $$;

-- the discount cap (record_discount_decision, set_approved_offer): same statement, different organization expression
select pg_temp.p1s_patch(
  p.oid::regprocedure,
  $re$select\s+nullif\(o\.settings->>'negotiation_max_discount_pct',\s*''\)::numeric\s+into\s+v_cap\s+from\s+core\.organizations\s+o\s+where\s+o\.id\s*=\s*([a-z_\.]+);$re$,
  $rp$select l.value into v_cap from sales.p1s_limit_in_force(\1, 'negotiation_max_discount_pct') l;$rp$)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'sales' and p.proname in ('record_discount_decision', 'set_approved_offer');

-- the minimum price and the autonomous ceiling (apply_approved_offer): both in minor units
select pg_temp.p1s_patch(
  'sales.apply_approved_offer(uuid)'::regprocedure,
  $re$select\s+nullif\(o\.settings->>'negotiation_min_price_rupees',\s*''\)::numeric\s*\*\s*100,\s+nullif\(o\.settings->>'negotiation_max_autonomous_quote_rupees',\s*''\)::numeric\s*\*\s*100\s+into\s+v_min_price,\s+v_autonomous_cap\s+from\s+core\.organizations\s+o\s+where\s+o\.id\s*=\s*([a-z_\.]+);$re$,
  $rp$select (select l.value * 100 from sales.p1s_limit_in_force(\1, 'negotiation_min_price_rupees') l),
         (select l.value * 100 from sales.p1s_limit_in_force(\1, 'negotiation_max_autonomous_quote_rupees') l)
    into v_min_price, v_autonomous_cap;$rp$);

-- the breach list for the approver: the policy-version breaches are added on both exits
select pg_temp.p1s_patch(
  'sales.p1o_limit_breaches(uuid, bigint, bigint, jsonb)'::regprocedure,
  $re$if l\.organization_id is null then return v_out; end if;$re$,
  $rp$if l.organization_id is null then return sales.p1s_policy_breaches(p_organization_id, p_total_minor); end if;$rp$);
select pg_temp.p1s_patch(
  'sales.p1o_limit_breaches(uuid, bigint, bigint, jsonb)'::regprocedure,
  $re$return v_out;$re$,
  $rp$return v_out || sales.p1s_policy_breaches(p_organization_id, p_total_minor);$rp$);

-- the snapshot a quote carries lists the versions in force; absent (the old snapshot, unchanged) when none is
select pg_temp.p1s_patch(
  'sales.p1o_policy_snapshot(uuid)'::regprocedure,
  $re$(from sales\.p1o_negotiation_limits l where l\.organization_id = p_organization_id\))\s*\n\s*\);$re$,
  $rp$\1
  ) || jsonb_strip_nulls(jsonb_build_object('policyVersions', sales.p1s_policy_versions_in_force(p_organization_id)));$rp$);

-- ── what the Negotiation workspace and Lead 360 show: the limits in force, each with where it came from ─────
create or replace function sales.p1s_limits_in_force()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_o jsonb; r record;
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then return null; end if;
  v_o := '{}'::jsonb;
  for r in select k.key from (values ('negotiation_max_discount_pct'), ('negotiation_min_price_rupees'), ('negotiation_max_autonomous_quote_rupees')) as k(key) loop
    v_o := v_o || jsonb_build_object(r.key, (select jsonb_build_object('value', l.value, 'source', l.source, 'policyVersionId', l.policy_version_id,
                                                                         'policyVersion', (select pv.version from core.p13_policy_versions pv where pv.id = l.policy_version_id))
                                               from sales.p1s_limit_in_force(v_org, r.key) l));
  end loop;
  return jsonb_build_object(
    'limits', v_o,
    'maxRounds', (select nullif(o.settings ->> 'negotiation_max_rounds', '') from core.organizations o where o.id = v_org),
    'maxDiscountMinor', (select l.max_discount_minor from sales.p1o_negotiation_limits l where l.organization_id = v_org),
    'minAdvancePct', (select l.min_advance_pct from sales.p1o_negotiation_limits l where l.organization_id = v_org));
end $$;
revoke all on function sales.p1s_limits_in_force() from public, anon;
grant execute on function sales.p1s_limits_in_force() to authenticated, service_role;
