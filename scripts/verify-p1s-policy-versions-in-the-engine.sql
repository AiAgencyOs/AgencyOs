-- ═══════════════════════════════════════════════════════════════════════════
-- P1-BLUEPRINT-031 / P1-QUOTE-018 / P1-QUOTE-008: the quoting and discount engine reads the policy version in force (migration 20261204000000).
-- Real doors, real triggers, scratch Postgres; rolls back. Table-wide counts are scoped to this verifier's own organization.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1s-policy-versions-in-the-engine.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p1s_check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.p1s_check(boolean, text) to public;
create or replace function pg_temp.p1s_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
grant execute on function pg_temp.p1s_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p1s_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.p1s_as_service() to public;
create or replace function pg_temp.p1s_denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.p1s_denied(text) to public;
create or replace function pg_temp.p1s_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if; execute n; end $$;
grant execute on function pg_temp.p1s_mutate(regprocedure, text, text) to public;

\set PORG '00000000-0000-4000-8000-0000000b0400'
\set POWN '00000000-0000-4000-8000-0000000b0401'
\set PMEM '00000000-0000-4000-8000-0000000b0402'
\set POTH '00000000-0000-4000-8000-0000000b0410'
\set POTHU '00000000-0000-4000-8000-0000000b0411'

insert into auth.users (id, email) values (:'POWN', 'p1s-eng-owner@example.test'), (:'PMEM', 'p1s-eng-member@example.test'), (:'POTHU', 'p1s-eng-other@example.test');
insert into core.users (id, email, full_name) values (:'POWN', 'p1s-eng-owner@example.test', 'P1S Owner'), (:'PMEM', 'p1s-eng-member@example.test', 'P1S Member'), (:'POTHU', 'p1s-eng-other@example.test', 'P1S Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'PORG', 'zztest p1s engine', 'zztest-p1s-engine'), (:'POTH', 'zztest p1s engine other', 'zztest-p1s-engine-other');
insert into core.memberships (organization_id, user_id, role) values (:'PORG', :'POWN', 'owner'), (:'PORG', :'PMEM', 'member'), (:'POTH', :'POTHU', 'owner');
insert into approvals.approval_policies (organization_id, subject_type, min_amount_minor, required_role, sla_hours) values (:'PORG', 'proposal', 0, 'owner', 24), (:'PORG', 'discount_decision', 0, 'owner', 24);
insert into core.client_accounts (organization_id, name) values (:'PORG', 'zztest p1s client') returning id as acct \gset
insert into sales.opportunities (organization_id, client_account_id, name) values (:'PORG', :'acct', 'zztest p1s deal') returning id as opp \gset

create or replace function pg_temp.p1s_draft(p_org uuid, p_opp uuid, p_subtotal bigint) returns uuid language plpgsql as $$
declare v_id uuid; v_opp uuid;
begin
  -- one live quotation per deal: each draft gets its own deal (p_opp is kept for call-site readability)
  insert into sales.opportunities (organization_id, client_account_id, name) select p_org, o.client_account_id, 'zztest p1s deal ' || gen_random_uuid() from sales.opportunities o where o.id = p_opp returning id into v_opp;
  insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor)
    values (p_org, v_opp, 1, 'p1s quote', p_subtotal, 0, p_subtotal) returning id into v_id;
  insert into sales.proposal_items (organization_id, proposal_id, position, description, quantity, unit_price_minor, amount_minor)
    values (p_org, v_id, 0, 'build', 1, p_subtotal, p_subtotal);
  return v_id;
end $$;
grant execute on function pg_temp.p1s_draft(uuid, uuid, bigint) to public;

-- the organization's own setting, as the owner has always set it
update core.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"negotiation_max_discount_pct":"10"}'::jsonb where id = :'PORG';

-- ═══ 1. with NO policy version the setting is the authority, exactly as before ═══
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = 'setting' and (select value from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = 10,
  'no version in force: the discount cap is the organization setting (10)');
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'PORG', 'negotiation_min_price_rupees')) = 'unset', 'an unset limit is reported as unset, not as zero');
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'PORG', 'not_a_limit')) = 'unknown_key', 'an unknown key is named, not guessed');
select pg_temp.p1s_check(sales.p1s_policy_versions_in_force(:'PORG') is null, 'no version in force: the snapshot addition is null (the old snapshot, unchanged)');
select pg_temp.p1s_check(not (sales.p1o_policy_snapshot(:'PORG') ? 'policyVersions'), 'no version in force: the policy snapshot has no policyVersions key');
select pg_temp.p1s_check(sales.p1o_limit_breaches(:'PORG', 0, 700000, null) = '[]'::jsonb, 'no version, no p1o limits: no breach is recorded');

select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select sales.p1s_limits_in_force() as lim0 \gset
select pg_temp.p1s_check((:'lim0'::jsonb -> 'limits' -> 'negotiation_max_discount_pct' ->> 'source') = 'setting', 'the workspace read says the cap comes from the setting');
reset role;
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q1 \gset
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select status from sales.record_discount_decision(:'q1', 80000, 'a loyal client', 'human')) = 'autonomous', '8% under a 10% setting is autonomous');
select pg_temp.p1s_check((select policy_version_id is null from sales.discount_decisions where proposal_id = :'q1'), 'and records no policy version (the setting decided)');
reset role;
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q2 \gset
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select status from sales.record_discount_decision(:'q2', 120000, 'a big ask', 'human')) = 'pending_approval', '12% over a 10% setting goes to approval');

-- ═══ 2. an ACTIVE discount version tightens it: the version is the authority ═══
select pg_temp.p1s_check((select outcome from core.p13_save_policy_draft('discount', '{"max_discount_pct":5,"stacking":"none"}', 'tighter cap')) = 'saved', 'an admin drafts a 5% discount policy');
select id as dv1 from core.p13_policy_versions where organization_id = :'PORG' and policy_kind = 'discount' and status = 'draft' \gset
reset role;
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = 'setting', 'a DRAFT version changes nothing: the setting still decides');
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select outcome from core.p13_activate_policy_version(:'dv1', 'owner agreed')) = 'activated', 'the version is activated');
reset role;
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = 'policy_version'
  and (select value from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = 5
  and (select policy_version_id from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = :'dv1', 'an active version is the authority: 5, from version 1');

select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q3 \gset
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select status from sales.record_discount_decision(:'q3', 80000, 'same 8% as before', 'human')) = 'pending_approval', '8% was autonomous under the setting; under the 5% version it goes to approval');
reset role;
select pg_temp.p1s_check((select policy_version_id from sales.discount_decisions where proposal_id = :'q3') = :'dv1', 'the decision records the version that judged it');
select pg_temp.p1s_check((select policy_version_id is null from sales.discount_decisions where proposal_id = :'q1'), 'the earlier decision keeps its null (history is not rewritten)');
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q4 \gset
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select status from sales.record_discount_decision(:'q4', 40000, 'inside the new cap', 'human')) = 'autonomous', 'POSITIVE twin: 4% is inside the 5% version and is autonomous');
reset role;
select pg_temp.p1s_check((select policy_version_id from sales.discount_decisions where proposal_id = :'q4') = :'dv1', 'and carries version 1');

-- a version can also LOOSEN: the setting is not a ceiling over the governed policy
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select outcome from core.p13_save_policy_draft('discount', '{"max_discount_pct":20}', 'looser cap')) = 'saved', 'version 2 drafted at 20%');
select id as dv2 from core.p13_policy_versions where organization_id = :'PORG' and policy_kind = 'discount' and status = 'draft' \gset
select pg_temp.p1s_check((select outcome from core.p13_activate_policy_version(:'dv2', 'growth push')) = 'activated', 'and activated');
reset role;
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q5 \gset
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select status from sales.record_discount_decision(:'q5', 150000, 'within 20%', 'human')) = 'autonomous', '15% is autonomous under the 20% version');
select pg_temp.p1s_check((select outcome from sales.record_discount_decision(:'q5', 150000, 'again', 'human')) is not null, 'a second decision on the same quote is still answered');
reset role;
select pg_temp.p1s_check((select policy_version_id from sales.discount_decisions where proposal_id = :'q5' order by created_at limit 1) = :'dv2', 'recorded against version 2, not version 1');
-- the agent lane is untouched by any version: an agent-requested discount is never autonomous
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q6 \gset
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select status from sales.record_discount_decision(:'q6', 10000, 'agent asked for 1%', 'agent', 'sales')) = 'pending_approval', 'NEGATIVE: an agent discount is never autonomous, whatever the version says');
reset role;

-- a version that does not carry the field leaves the setting in charge
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select sales.p1s_limits_in_force() as lim1 \gset
select pg_temp.p1s_check((:'lim1'::jsonb -> 'limits' -> 'negotiation_max_discount_pct' ->> 'source') = 'policy_version'
  and (:'lim1'::jsonb -> 'limits' -> 'negotiation_max_discount_pct' ->> 'policyVersion') = '2', 'the workspace read now says: policy version 2');
select pg_temp.p1s_check((:'lim1'::jsonb -> 'limits' -> 'negotiation_min_price_rupees' ->> 'source') = 'unset', 'and the minimum price is still unset');
reset role;

-- ═══ 3. a PRICING version: minimum price and autonomous ceiling, in minor units, read by apply_approved_offer ═══
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select outcome from sales.set_approved_offer(:'PORG', 'Launch offer', 'pay in advance', 10)) = 'set', 'the owner authorises a 10% standing offer');
reset role;
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q7 \gset
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select outcome from sales.apply_approved_offer(:'q7')) not in ('below_minimum_price', 'above_autonomous_ceiling'), 'with no pricing version the offer is not stopped by a floor or a ceiling');
reset role;
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select outcome from core.p13_save_policy_draft('pricing', '{"minimum_price_minor":950000,"autonomous_max_minor":5000000}', 'floor')) = 'saved', 'a pricing draft with a floor of 9,500');
select id as pv1 from core.p13_policy_versions where organization_id = :'PORG' and policy_kind = 'pricing' and status = 'draft' \gset
select pg_temp.p1s_check((select outcome from core.p13_activate_policy_version(:'pv1', 'floor agreed')) = 'activated', 'activated');
reset role;
select pg_temp.p1s_check((select value from sales.p1s_limit_in_force(:'PORG', 'negotiation_min_price_rupees')) = 9500, 'the floor reads back in rupees: 9,500');
select pg_temp.p1s_check((select value from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_autonomous_quote_rupees')) = 50000, 'and the ceiling: 50,000');
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q8 \gset
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select outcome from sales.apply_approved_offer(:'q8')) = 'below_minimum_price', 'a 10% offer on 10,000 lands at 9,000: under the 9,500 floor, refused');
reset role;
select pg_temp.p1s_check((select discount_minor from sales.proposals where id = :'q8') = 0, 'and nothing was written to the quotation');
-- ceiling
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select outcome from core.p13_save_policy_draft('pricing', '{"minimum_price_minor":100000,"autonomous_max_minor":800000}', 'ceiling')) = 'saved', 'pricing version 2: ceiling of 8,000');
select id as pv2 from core.p13_policy_versions where organization_id = :'PORG' and policy_kind = 'pricing' and status = 'draft' \gset
select pg_temp.p1s_check((select outcome from core.p13_activate_policy_version(:'pv2', 'ceiling')) = 'activated', 'activated');
reset role;
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q9 \gset
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select outcome from sales.apply_approved_offer(:'q9')) = 'above_autonomous_ceiling', 'a 9,000 total is over the 8,000 autonomous ceiling: refused');
reset role;

-- ═══ 4. breaches recorded for the approver, and the snapshot a quote carries ═══
select pg_temp.p1s_check(sales.p1o_limit_breaches(:'PORG', 0, 50000, null) @> '[{"limit":"policy_minimum_price_minor","allowed":100000}]'::jsonb, 'a total under version 2''s floor is recorded as a breach, with the limit and the policy version');
select pg_temp.p1s_check(sales.p1o_limit_breaches(:'PORG', 0, 900000, null) @> '[{"limit":"policy_autonomous_max_minor","allowed":800000}]'::jsonb, 'a total over the autonomous maximum is recorded');
select pg_temp.p1s_check(sales.p1o_limit_breaches(:'PORG', 0, 500000, null) = '[]'::jsonb, 'POSITIVE twin: a total between the floor and the ceiling records nothing');
select pg_temp.p1s_check((sales.p1o_limit_breaches(:'PORG', 0, 50000, null) -> 0 ->> 'policyVersionId')::uuid = :'pv2', 'the breach names the version that was in force');
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select outcome from core.p13_save_policy_draft('discount', '{"max_discount_pct":20,"high_value_threshold_minor":600000}', 'high value')) = 'saved', 'a discount version with a high-value threshold');
select id as dv3 from core.p13_policy_versions where organization_id = :'PORG' and policy_kind = 'discount' and status = 'draft' \gset
select pg_temp.p1s_check((select outcome from core.p13_activate_policy_version(:'dv3', 'high value')) = 'activated', 'activated');
reset role;
select pg_temp.p1s_check(sales.p1o_limit_breaches(:'PORG', 0, 700000, null) @> '[{"limit":"policy_high_value_threshold_minor"}]'::jsonb, 'a total at or over the high-value threshold is flagged for the approver');
select pg_temp.p1s_check(not (sales.p1o_limit_breaches(:'PORG', 0, 500000, null) @> '[{"limit":"policy_high_value_threshold_minor"}]'::jsonb), 'and one under it is not');

select pg_temp.p1s_check((sales.p1o_policy_snapshot(:'PORG') -> 'policyVersions' -> 'discount' ->> 'version') = '3'
  and (sales.p1o_policy_snapshot(:'PORG') -> 'policyVersions' -> 'pricing' ->> 'version') = '2', 'the quote''s policy snapshot lists discount v3 and pricing v2');
select pg_temp.p1s_check((sales.p1o_policy_snapshot(:'PORG') -> 'settings' ->> 'negotiation_max_discount_pct') = '10', 'and still carries the settings it always carried');

-- ═══ 5. isolation and grants ═══
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'POTH', 'negotiation_max_discount_pct')) = 'unset', 'another organization has no version and no setting: unset');
select pg_temp.p1s_check(sales.p1s_policy_versions_in_force(:'POTH') is null, 'and no versions in force');
select pg_temp.p1s_as_user(:'POTHU', :'POTH', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force('00000000-0000-4000-8000-0000000b0400', 'negotiation_max_discount_pct')) = 'unset', 'NEGATIVE: a signed-in user asking for another organization''s limit is told "unset", not the value');
select pg_temp.p1s_check(pg_temp.p1s_denied($q$select * from sales.p1s_policy_breaches('00000000-0000-4000-8000-0000000b0400', 1)$q$), 'NEGATIVE: nor for its breaches');
select pg_temp.p1s_check((sales.p1s_limits_in_force() -> 'limits' -> 'negotiation_max_discount_pct' ->> 'source') = 'unset', 'the workspace read shows the caller''s own organization only');
reset role;
select pg_temp.p1s_as_user(:'PMEM', :'PORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((sales.p1s_limits_in_force() -> 'limits' -> 'negotiation_max_discount_pct' ->> 'source') = 'policy_version', 'a plain internal member can read the limits in force');
select pg_temp.p1s_check((select outcome from core.p13_save_policy_draft('discount', '{"max_discount_pct":50}', 'x')) = 'not_authorized', 'NEGATIVE: but cannot change the policy that sets them');
reset role;
select pg_temp.p1s_as_user('00000000-0000-4000-8000-0000000b09ff', :'PORG', 'client_admin');
set local role authenticated;
select pg_temp.p1s_check(sales.p1s_limits_in_force() is null, 'NEGATIVE: a user who is not internal reads nothing');
reset role;

-- ═══ 6. red-proofs: break the live control, the check must go red ═══
select pg_temp.p1s_mutate('sales.p1s_limit_in_force(uuid, text, timestamptz)'::regprocedure, 'if v_pv is not null then', 'if false then');
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = 'setting', 'RED-PROOF: with the version read disabled the limit falls back to the setting (the version check above would fail)');
select pg_temp.p1s_mutate('sales.p1s_limit_in_force(uuid, text, timestamptz)'::regprocedure, 'if false then', 'if v_pv is not null then');
select pg_temp.p1s_check((select source from sales.p1s_limit_in_force(:'PORG', 'negotiation_max_discount_pct')) = 'policy_version', 'RED-PROOF restored');

select pg_temp.p1s_mutate((select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'sales' and p.proname = 'record_discount_decision'),
  $m$select l.value into v_cap from sales.p1s_limit_in_force(v_row.organization_id, 'negotiation_max_discount_pct') l;$m$,
  $m$select nullif(o.settings->>'negotiation_max_discount_pct', '')::numeric into v_cap from core.organizations o where o.id = v_row.organization_id;$m$);
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q10 \gset
select pg_temp.p1s_as_user(:'POWN', :'PORG', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select status from sales.record_discount_decision(:'q10', 150000, 'proof', 'human')) = 'pending_approval', 'RED-PROOF: with the engine reading the setting again, 15% is NOT autonomous under a 10% setting (so the version-reading checks above depend on the patch)');
reset role;
select pg_temp.p1s_mutate((select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'sales' and p.proname = 'apply_approved_offer'),
  $m$select (select l.value * 100 from sales.p1s_limit_in_force(v_row.organization_id, 'negotiation_min_price_rupees') l),$m$,
  $m$select null::numeric,$m$);
select pg_temp.p1s_draft(:'PORG', :'opp', 1000000) as q11 \gset
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select outcome from sales.apply_approved_offer(:'q11')) <> 'below_minimum_price', 'RED-PROOF: with the floor read removed, the below-minimum refusal disappears (the floor check depends on the patch)');
reset role;

rollback;
\echo 'verify-p1s-policy-versions-in-the-engine: ALL CHECKS PASSED'
