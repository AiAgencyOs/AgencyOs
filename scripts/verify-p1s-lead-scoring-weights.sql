-- ═══════════════════════════════════════════════════════════════════════════
-- P1-CRM-019 / P1-CRM-020: lead-scoring weights are versioned data an administrator sets (migration 20261204100000).
-- Real door, real triggers, scratch Postgres; rolls back. Counts are scoped to this verifier's own organizations.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1s-lead-scoring-weights.sql
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
create or replace function pg_temp.p1s_refused(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when restrict_violation then return true; end $$;
grant execute on function pg_temp.p1s_refused(text) to public;
create or replace function pg_temp.p1s_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if; execute n; end $$;
grant execute on function pg_temp.p1s_mutate(regprocedure, text, text) to public;

\set WORG '00000000-0000-4000-8000-0000000b0500'
\set WADM '00000000-0000-4000-8000-0000000b0501'
\set WMEM '00000000-0000-4000-8000-0000000b0502'
\set WOTH '00000000-0000-4000-8000-0000000b0510'
\set WOTHU '00000000-0000-4000-8000-0000000b0511'
\set WCLI '00000000-0000-4000-8000-0000000b0503'

insert into auth.users (id, email) values (:'WADM', 'p1s-w-adm@example.test'), (:'WMEM', 'p1s-w-mem@example.test'), (:'WOTHU', 'p1s-w-oth@example.test'), (:'WCLI', 'p1s-w-cli@example.test');
insert into core.users (id, email, full_name) values (:'WADM', 'p1s-w-adm@example.test', 'W Admin'), (:'WMEM', 'p1s-w-mem@example.test', 'W Member'), (:'WOTHU', 'p1s-w-oth@example.test', 'W Other'), (:'WCLI', 'p1s-w-cli@example.test', 'W Client') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'WORG', 'zztest p1s weights', 'zztest-p1s-weights'), (:'WOTH', 'zztest p1s weights other', 'zztest-p1s-weights-other');
insert into core.memberships (organization_id, user_id, role) values (:'WORG', :'WADM', 'ops_admin'), (:'WORG', :'WMEM', 'member'), (:'WOTH', :'WOTHU', 'owner');

\set DEFAULTS '{"coverage_max":25,"budget_known":15,"decision_maker":15,"timeline_stated":10,"engagement_some":8,"engagement_many":15,"recency_fresh":10,"recency_recent":5,"deal_value":5,"referral":5,"stale_penalty":10}'
\set HEAVY '{"coverage_max":20,"budget_known":25,"decision_maker":15,"timeline_stated":5,"engagement_some":8,"engagement_many":15,"recency_fresh":10,"recency_recent":5,"deal_value":5,"referral":5,"stale_penalty":10}'

-- ═══ the code defaults add up (so the validator and the model agree) ═══
select pg_temp.p1s_check(crm.p1s_lead_score_weights_problem(:'DEFAULTS'::jsonb) is null, 'the weights the model has always used pass the validator');

-- ═══ 1. nothing set: the defaults apply ═══
select pg_temp.p1s_as_user(:'WADM', :'WORG', 'ops_admin');
set local role authenticated;
select pg_temp.p1s_check((crm.p1s_lead_score_weights() ->> 'version') = '0' and (crm.p1s_lead_score_weights() -> 'weights') = 'null'::jsonb, 'before anything is set: version 0, weights null (the defaults in code apply)');

-- ═══ 2. an admin sets, with a reason ═══
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights(:'HEAVY'::jsonb, '')) = 'reason_required', 'NEGATIVE: a reason is required');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights(:'HEAVY'::jsonb, 'budget matters more to us')) = 'set', 'an admin saves a set');
select pg_temp.p1s_check((select version from crm.p1s_set_lead_score_weights(:'HEAVY'::jsonb, 'again')) = 1 and (select outcome from crm.p1s_set_lead_score_weights(:'HEAVY'::jsonb, 'again')) = 'unchanged', 'saving the same set again records nothing new');
select pg_temp.p1s_check((select count(*) from crm.p1s_lead_score_weight_sets where organization_id = :'WORG') = 1, 'one version exists');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights(:'DEFAULTS'::jsonb, 'back to the defaults')) = 'set', 'a different set is saved');
select pg_temp.p1s_check((crm.p1s_lead_score_weights() ->> 'version') = '2', 'and is version 2');
select pg_temp.p1s_check((crm.p1s_lead_score_weights() #>> '{weights,budget_known}') = '15' and (crm.p1s_lead_score_weights() ->> 'reason') = 'back to the defaults', 'the read returns the newest set and why');
select pg_temp.p1s_check((select weights ->> 'budget_known' from crm.p1s_lead_score_weight_sets where organization_id = :'WORG' and version = 1) = '25', 'POSITIVE twin: version 1 still reads as it was saved');

-- ═══ 3. negatives: the set must be a whole, well-formed, 100-point set ═══
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"budget_known":30}', 'x')) like 'invalid_weights: the positive weights add up to 105%', 'NEGATIVE: weights adding up to 105 are refused');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) - 'referral', 'x')) like 'invalid_weights: weight "referral" is missing%', 'NEGATIVE: a set with a missing weight is refused (a set is complete)');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"vibes":1}', 'x')) like 'invalid_weights: unknown weight%', 'NEGATIVE: an unknown weight is refused');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"budget_known":25.5}', 'x')) like 'invalid_weights: weight "budget_known" must be a whole number', 'NEGATIVE: a fractional weight is refused');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"budget_known":-5}', 'x')) like 'invalid_weights:%', 'NEGATIVE: a negative weight is refused');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"engagement_some":16}', 'x')) like 'invalid_weights: a few replies%', 'NEGATIVE: a few replies worth more than many is refused');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"recency_recent":11}', 'x')) like 'invalid_weights: a week-old reply%', 'NEGATIVE: an older reply worth more than a fresh one is refused');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"stale_penalty":60}', 'x')) like 'invalid_weights: the stale penalty%', 'NEGATIVE: a stale penalty over 50 is refused');
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights('[1,2]'::jsonb, 'x')) like 'invalid_weights:%', 'NEGATIVE: a body that is not an object is refused');
select pg_temp.p1s_check((select count(*) from crm.p1s_lead_score_weight_sets where organization_id = :'WORG') = 2, 'and none of the refused sets was stored');
reset role;

-- ═══ 4. audited and announced ═══
select pg_temp.p1s_check((select count(*) from audit.audit_log where organization_id = :'WORG' and action = 'lead_scoring.weights_set') = 2, 'both saves are audited');
select pg_temp.p1s_check((select count(*) from core.outbox_events where organization_id = :'WORG' and type = 'lead_scoring.weights_set') = 2, 'and announced as events');

-- ═══ 5. history is history ═══
select pg_temp.p1s_check(pg_temp.p1s_refused($q$update crm.p1s_lead_score_weight_sets set weights = '{}' where organization_id = '00000000-0000-4000-8000-0000000b0500'$q$), 'NEGATIVE: a saved set cannot be edited, even by the service role');
select pg_temp.p1s_check(pg_temp.p1s_refused($q$delete from crm.p1s_lead_score_weight_sets where organization_id = '00000000-0000-4000-8000-0000000b0500'$q$), 'NEGATIVE: nor deleted');

-- ═══ 6. who may ═══
select pg_temp.p1s_as_user(:'WMEM', :'WORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights(:'HEAVY'::jsonb, 'x')) = 'not_authorized', 'NEGATIVE: a plain member cannot change the weights');
select pg_temp.p1s_check((crm.p1s_lead_score_weights() ->> 'version') = '2', 'but can read the ones in force');
select pg_temp.p1s_check((select count(*) from crm.p1s_lead_score_weight_sets) = 2, 'and the history');
reset role;
select pg_temp.p1s_as_user(:'WCLI', :'WORG', 'client_admin');
set local role authenticated;
select pg_temp.p1s_check(crm.p1s_lead_score_weights() is null, 'NEGATIVE: a client user reads nothing');
select pg_temp.p1s_check((select count(*) from crm.p1s_lead_score_weight_sets) = 0, 'NEGATIVE: and sees no history');
reset role;
select pg_temp.p1s_as_user(:'WOTHU', :'WOTH', 'owner');
set local role authenticated;
select pg_temp.p1s_check((crm.p1s_lead_score_weights() ->> 'version') = '0', 'NEGATIVE: another organization sees its own (empty) state, not this one''s');
select pg_temp.p1s_check((select count(*) from crm.p1s_lead_score_weight_sets) = 0, 'NEGATIVE: and none of this one''s history');
reset role;
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check(pg_temp.p1s_denied($q$select * from crm.p1s_set_lead_score_weights('{}'::jsonb, 'x')$q$), 'NEGATIVE: an agent / service principal holds no grant on the door');
reset role;

-- ═══ 7. red-proofs ═══
select pg_temp.p1s_mutate('crm.p1s_lead_score_weights_problem(jsonb)'::regprocedure, 'if v_sum <> 100 then', 'if false then');
select pg_temp.p1s_check(crm.p1s_lead_score_weights_problem((:'HEAVY'::jsonb) || '{"budget_known":30}') is null, 'RED-PROOF: with the sum rule removed, a 105-point set passes (the sum check above depends on it)');
select pg_temp.p1s_mutate('crm.p1s_lead_score_weights_problem(jsonb)'::regprocedure, 'if false then', 'if v_sum <> 100 then');
select pg_temp.p1s_check(crm.p1s_lead_score_weights_problem((:'HEAVY'::jsonb) || '{"budget_known":30}') is not null, 'RED-PROOF restored');
select pg_temp.p1s_mutate('crm.p1s_set_lead_score_weights(jsonb, text)'::regprocedure, 'not coalesce((select core.is_admin()), false)', 'false');
select pg_temp.p1s_as_user(:'WMEM', :'WORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select outcome from crm.p1s_set_lead_score_weights((:'HEAVY'::jsonb) || '{"deal_value":3,"referral":7}', 'proof')) = 'set', 'RED-PROOF: with the admin check removed a member can write (the not_authorized check above depends on it)');
reset role;

rollback;
\echo 'verify-p1s-lead-scoring-weights: ALL CHECKS PASSED'
