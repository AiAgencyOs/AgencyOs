-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Orchestrator depth, driven for real on a scratch Postgres: concurrency leases, the refused-tool-call audit, fallback records and
-- usage costs that say where their number came from.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase5-orchestrator.sql
-- Rolls back. Any failed check raises.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;

create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated',
      'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;

-- true when the statement raises one of the named SQLSTATEs (comma separated); false when it runs, or raises anything else
create or replace function pg_temp.raises(p_sql text, p_states text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlstate = any (string_to_array(p_states, ','));
end $$;
grant execute on function pg_temp.raises(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b5'
\set U '00000000-0000-4000-8000-00000000f5a1'
\set UC '00000000-0000-4000-8000-00000000f5a2'
\set UB '00000000-0000-4000-8000-00000000f5a3'

insert into auth.users (id, email) values (:'U', 'p5orch-owner@example.test'), (:'UC', 'p5orch-client@example.test'), (:'UB', 'p5orch-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'U', 'p5orch-owner@example.test', 'Orch Owner'), (:'UC', 'p5orch-client@example.test', 'Orch Client'),
  (:'UB', 'p5orch-b@example.test', 'Orch B') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORGB', 'Orch Other Agency', 'orch-other-agency') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'U', 'owner'), (:'ORGB', :'UB', 'owner') on conflict do nothing;

-- ── fixtures (service role) ─────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest orch client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest orch', 'ZORCH-1') returning id \gset P_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest A ui', 'todo') returning id \gset TA_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest B ui button', 'todo') returning id \gset TB_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest C api', 'todo') returning id \gset TC_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest D after A', 'todo') returning id \gset TD_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest E after D', 'todo') returning id \gset TE_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest F migration', 'todo') returning id \gset TF_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORG', :'P_id', 'zztest G migration', 'todo') returning id \gset TG_
insert into projects.task_dependencies (organization_id, task_id, depends_on_task_id) values (:'ORG', :'TD_id', :'TA_id');
insert into projects.task_dependencies (organization_id, task_id, depends_on_task_id) values (:'ORG', :'TE_id', :'TD_id');
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest orch client b') returning id \gset AB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'AB_id', 'zztest orch b', 'ZORCH-B') returning id \gset PB_
insert into projects.tasks (organization_id, project_id, title, status) values (:'ORGB', :'PB_id', 'zztest B-org task', 'todo') returning id \gset TX_
reset role;

-- ── 1. the overlap rule itself ──────────────────────────────────────────────
select pg_temp.check(projects.lease_scope_key('./src/ui/**') = 'src/ui', 'a glob is cut at its first wildcard: src/ui/** means src/ui');
select pg_temp.check(projects.lease_scope_key('src/ui/*.tsx') = 'src/ui', 'src/ui/*.tsx also means src/ui (broader is the safe error)');
select pg_temp.check(projects.lease_scope_key('supabase/migrations/20261102900001_a.sql') = 'supabase/migrations', 'a file under a high-conflict path IS that path');
select pg_temp.check(projects.lease_scope_key('**') = '', 'the whole repository is the empty key');
select pg_temp.check(projects.lease_scopes_overlap(array['src/ui'], array['src/ui/button.tsx']), 'a directory overlaps a file in it');
select pg_temp.check(not projects.lease_scopes_overlap(array['src/ui'], array['src/uikit/x.ts']), 'src/ui does not overlap src/uikit (a prefix is not a parent)');
select pg_temp.check(projects.lease_scopes_overlap(array['src/ui/button.tsx'], array['src/ui']), 'a file overlaps the directory it is in (the other direction)');
select pg_temp.check(not projects.lease_scopes_overlap(array['src/uikit/x.ts'], array['src/ui']), 'src/uikit/x.ts does not overlap src/ui (the other direction)');
select pg_temp.check(projects.lease_scopes_overlap(array['supabase/migrations/a.sql'], array['supabase/migrations/b.sql']), 'two different migration files overlap: one sequence');
select pg_temp.check(projects.lease_scopes_overlap(array['**'], array['src/api/x.ts']), 'the whole repository overlaps everything');

-- ── 2. claim: first claim, refusal, sequenced exemption, disjoint ──────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select outcome as o_a, lease_id as l_a from projects.claim_concurrency_lease(:'TA_id', 'frontend_developer', array['src/ui/**']) \gset
select pg_temp.check(:'o_a' = 'claimed', 'the first lease on src/ui/** is claimed');
select outcome as o_b, coalesce(conflicting_lease_id::text, 'none') as c_b, coalesce(conflicting_task_id::text, 'none') as ct_b from projects.claim_concurrency_lease(:'TB_id', 'frontend_developer', array['src/ui/button.tsx']) \gset
select pg_temp.check(:'o_b' = 'conflict' and :'c_b' = :'l_a' and :'ct_b' = :'TA_id', 'a second lease overlapping the same files is refused and names the holder');
select outcome as o_c from projects.claim_concurrency_lease(:'TC_id', 'backend_developer', array['src/api/x.ts']) \gset
select pg_temp.check(:'o_c' = 'claimed', 'a disjoint lease is claimed');
select outcome as o_d from projects.claim_concurrency_lease(:'TD_id', 'frontend_developer', array['src/ui/**']) \gset
select pg_temp.check(:'o_d' = 'claimed', 'a task that waits for the holder (task_dependencies) may share its files');
select outcome as o_e from projects.claim_concurrency_lease(:'TE_id', 'frontend_developer', array['src/ui/button.tsx']) \gset
select pg_temp.check(:'o_e' = 'claimed', 'the exemption follows a chain: E waits for D which waits for A');
select outcome as o_a2 from projects.claim_concurrency_lease(:'TA_id', 'frontend_developer', array['src/other/x.ts']) \gset
select pg_temp.check(:'o_a2' = 'already_leased', 'one primary agent per task: a second active lease for the same task is refused');
select pg_temp.check((select count(*) from projects.concurrency_leases where task_id = :'TA_id' and state = 'active') = 1, 'still exactly one active lease for the task');
select pg_temp.check((select outcome from projects.claim_concurrency_lease(:'TB_id', 'x', array['../etc/passwd'])) = 'bad_input', 'a path that climbs out of the repository is not a scope');
select pg_temp.check((select outcome from projects.claim_concurrency_lease(:'TB_id', 'x', array[]::text[])) = 'bad_input', 'an empty scope is not a lease');
select pg_temp.check((select outcome from projects.claim_concurrency_lease(gen_random_uuid(), 'x', array['a'])) = 'not_found', 'an unknown task is not found');

-- high-conflict paths
select outcome as o_f from projects.claim_concurrency_lease(:'TF_id', 'database_developer', array['supabase/migrations/20261102900001_a.sql']) \gset
select pg_temp.check(:'o_f' = 'claimed', 'the first migration author claims');
select outcome as o_g from projects.claim_concurrency_lease(:'TG_id', 'database_developer', array['supabase/migrations/20261102900002_b.sql']) \gset
select pg_temp.check(:'o_g' = 'conflict', 'a second migration file is refused even though its name differs (high-conflict path)');
reset role;

-- ── 3. release frees the files; expiry frees them too ──────────────────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select outcome as o_rel from projects.release_concurrency_lease(:'l_a', 'done') \gset
select pg_temp.check(:'o_rel' = 'released', 'a lease is released');
select pg_temp.check((select outcome from projects.release_concurrency_lease(:'l_a')) = 'not_active', 'releasing twice says not_active');
select pg_temp.check((select state from projects.concurrency_leases where id = :'l_a') = 'released', 'the lease row says released');
select outcome as o_b2 from projects.claim_concurrency_lease(:'TB_id', 'frontend_developer', array['src/ui/button.tsx']) \gset
select pg_temp.check(:'o_b2' = 'conflict', 'B is still refused: D and E (not sequenced with B) hold src/ui');
reset role;

-- age the F migration lease (the verifier is superuser here; now() is frozen inside one transaction, so the clock is moved on the row)
alter table projects.concurrency_leases disable trigger concurrency_leases_guard;
update projects.concurrency_leases set claimed_at = now() - interval '3 hours', expires_at = now() - interval '2 hours' where task_id = :'TF_id';
alter table projects.concurrency_leases enable trigger concurrency_leases_guard;

set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select pg_temp.check((select state from projects.concurrency_leases where task_id = :'TF_id') = 'active', 'before the sweep the stale lease is still active');
select expired as n_expired from projects.expire_concurrency_leases(:'P_id') \gset
select pg_temp.check(:n_expired = 1, 'the sweep expires exactly the one stale lease');
select pg_temp.check((select state from projects.concurrency_leases where task_id = :'TF_id') = 'expired', 'the stale lease is now expired');
select pg_temp.check((select count(*) from projects.concurrency_leases where project_id = :'P_id' and state = 'active' and expires_at <= now()) = 0, 'no active lease is past its expiry');
select outcome as o_g2 from projects.claim_concurrency_lease(:'TG_id', 'database_developer', array['supabase/migrations/20261102900002_b.sql']) \gset
select pg_temp.check(:'o_g2' = 'claimed', 'with the stale lease expired, the migration author can claim');
reset role;

-- a claim itself ignores a stale holder (no sweep needed)
alter table projects.concurrency_leases disable trigger concurrency_leases_guard;
update projects.concurrency_leases set claimed_at = now() - interval '3 hours', expires_at = now() - interval '2 hours' where task_id = :'TG_id';
alter table projects.concurrency_leases enable trigger concurrency_leases_guard;
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select outcome as o_f2 from projects.claim_concurrency_lease(:'TF_id', 'database_developer', array['supabase/migrations/20261102900003_c.sql']) \gset
select pg_temp.check(:'o_f2' = 'claimed', 'a claim expires a stale holder itself and takes the files');
reset role;

-- ── 4. guards: history, tenancy, writes ─────────────────────────────────────
select pg_temp.check(pg_temp.raises(format($q$update projects.concurrency_leases set state = 'active', released_at = null where id = %L$q$, :'l_a'), '23001'), 'an ended lease is never reopened');
select pg_temp.check(pg_temp.raises(format($q$update projects.concurrency_leases set file_scope = array['x'] where task_id = %L and state = 'active'$q$, :'TC_id'), '23001'), 'a lease''s files are fixed once claimed');
select pg_temp.check(pg_temp.raises(format($q$insert into projects.concurrency_leases (organization_id, project_id, task_id, agent_key, file_scope, expires_at) values (%L, %L, %L, 'x', array['a'], now() + interval '1 hour')$q$, :'ORG', :'P_id', :'TX_id'), '23514,P0001,23503'), 'a lease whose task belongs to another organization is refused (enforce_parent_org)');
select pg_temp.check(pg_temp.raises(format($q$update projects.concurrency_leases set organization_id = %L where task_id = %L and state = 'active'$q$, :'ORGB', :'TC_id'), '23514,P0001,42501'), 'a lease never moves to another organization (freeze_organization_id)');

select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.concurrency_leases where project_id = :'P_id') >= 5, 'an internal user reads the project''s leases');
select pg_temp.check(pg_temp.raises(format($q$insert into projects.concurrency_leases (organization_id, project_id, task_id, agent_key, file_scope, expires_at) values (%L, %L, %L, 'x', array['a'], now() + interval '1 hour')$q$, :'ORG', :'P_id', :'TB_id'), '42501'), 'an authenticated user cannot write a lease');
select pg_temp.check(pg_temp.raises(format($q$select * from projects.claim_concurrency_lease(%L, 'x', array['a'])$q$, :'TB_id'), '42501'), 'an authenticated user cannot call the claim door');
select pg_temp.check(pg_temp.raises(format($q$select * from projects.release_concurrency_lease(%L)$q$, :'l_a'), '42501'), 'an authenticated user cannot call the release door');
select pg_temp.check(pg_temp.raises($q$select * from projects.expire_concurrency_leases()$q$, '42501'), 'an authenticated user cannot call the expiry sweep');
reset role;
-- two layers hold the same rule (the grant and the role test inside the door): widen the grant and prove the door still refuses
grant execute on function projects.claim_concurrency_lease(uuid, text, text[], integer), projects.release_concurrency_lease(uuid, text), projects.expire_concurrency_leases(uuid),
  projects.record_tool_dispatch_denial(uuid, text, text, text, text, text[]), projects.record_fallback(uuid, text, text, text, jsonb, text),
  projects.record_usage_cost(uuid, text, text, numeric, uuid, text, text, bigint, bigint) to authenticated;
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.claim_concurrency_lease(:'TB_id', 'x', array['zz/only/mine'])) = 'not_authorized', 'the claim door refuses a non-service caller even if the grant were widened');
select pg_temp.check((select outcome from projects.release_concurrency_lease(:'l_a')) = 'not_authorized', 'the release door refuses a non-service caller even if the grant were widened');
select pg_temp.check((select expired from projects.expire_concurrency_leases()) = -1, 'the sweep refuses a non-service caller even if the grant were widened');
select pg_temp.check((select outcome from projects.record_tool_dispatch_denial(:'P_id', 'a', 't', 'unknown_tool')) = 'not_authorized', 'the denial door refuses a non-service caller even if the grant were widened');
select pg_temp.check((select outcome from projects.record_fallback(:'TC_id', 'a', 'b', 'r')) = 'not_authorized', 'the fallback door refuses a non-service caller even if the grant were widened');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'a', 'unknown')) = 'not_authorized', 'the usage door refuses a non-service caller even if the grant were widened');
reset role;
revoke execute on function projects.claim_concurrency_lease(uuid, text, text[], integer), projects.release_concurrency_lease(uuid, text), projects.expire_concurrency_leases(uuid),
  projects.record_tool_dispatch_denial(uuid, text, text, text, text, text[]), projects.record_fallback(uuid, text, text, text, jsonb, text),
  projects.record_usage_cost(uuid, text, text, numeric, uuid, text, text, bigint, bigint) from authenticated;

-- the table, not the door, is what holds one primary agent per task
select pg_temp.check(pg_temp.raises(format($q$insert into projects.concurrency_leases (organization_id, project_id, task_id, agent_key, file_scope, expires_at) values (%L, %L, %L, 'other', array['zz/elsewhere'], now() + interval '1 hour')$q$, :'ORG', :'P_id', :'TC_id'), '23505'), 'the table refuses a second active lease for one task');

select pg_temp.as_user(:'UC', :'ORG', 'client_member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.concurrency_leases) = 0, 'a client sees no leases (internal only)');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.concurrency_leases) = 0, 'another organization sees no leases');
reset role;

-- ── 5. the refused tool call is audited ─────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select outcome as o_den from projects.record_tool_dispatch_denial(:'P_id', 'frontend_developer', 'write_file', 'out_of_scope', 'path outside the leased files', array['path', 'content']) \gset
select pg_temp.check(:'o_den' = 'recorded', 'a denial is recorded');
select pg_temp.check((select outcome from projects.record_tool_dispatch_denial(:'P_id', 'frontend_developer', 'write_file', 'because_i_said_so')) = 'bad_code', 'a denial code outside the gate''s list is refused');
select pg_temp.check((select outcome from projects.record_tool_dispatch_denial(gen_random_uuid(), 'a', 't', 'unknown_tool')) = 'not_found', 'a denial for an unknown project is not found');
reset role;
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'orchestrator.tool_dispatch_denied' and subject_id = :'P_id'
                       and after ->> 'code' = 'out_of_scope' and after ->> 'tool' = 'write_file' and after -> 'arg_keys' = '["path", "content"]'::jsonb and actor_type = 'system') = 1,
                     'the denial is in the audit log with its code, the tool and the argument NAMES only');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'orchestrator.lease_claimed') >= 5, 'claiming a lease is audited');
select pg_temp.check((select count(*) from audit.audit_log where organization_id = :'ORG' and action = 'orchestrator.lease_expired') = 1, 'an expired lease is audited');
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.raises(format($q$select * from projects.record_tool_dispatch_denial(%L, 'a', 't', 'unknown_tool')$q$, :'P_id'), '42501'), 'an authenticated user cannot write a denial audit');
reset role;

-- ── 6. fallback records ─────────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select outcome as o_fb1, fallback_id as fb1 from projects.record_fallback(:'TC_id', 'backend_developer', 'database_developer', 'provider outage', '[]'::jsonb, 'transient_provider_error') \gset
select pg_temp.check(:'o_fb1' = 'accepted', 'a fallback with no violations is accepted');
select outcome as o_fb2 from projects.record_fallback(:'TC_id', 'backend_developer', 'quality_assurance', 'wants to verify its own work', '[{"code":"different_family"}]'::jsonb) \gset
select pg_temp.check(:'o_fb2' = 'rejected', 'a fallback with a violation is recorded as rejected');
select pg_temp.check((select outcome from projects.record_fallback(:'TC_id', 'backend_developer', 'backend_developer', 'x')) = 'same_agent', 'a fallback onto itself is refused');
select pg_temp.check((select outcome from projects.record_fallback(:'TC_id', 'a', 'b', ' ')) = 'bad_input', 'a fallback with no reason is refused');
select pg_temp.check((select outcome from projects.record_fallback(gen_random_uuid(), 'a', 'b', 'r')) = 'not_found', 'a fallback for an unknown task is not found');
reset role;
select pg_temp.check(pg_temp.raises(format($q$insert into projects.fallback_records (organization_id, project_id, task_id, primary_agent, fallback_agent, reason, violations, outcome) values (%L, %L, %L, 'a', 'b', 'r', '[{"code":"x"}]', 'accepted')$q$, :'ORG', :'P_id', :'TC_id'), '23514'), 'the table refuses an accepted fallback that carries a violation');
select pg_temp.check(pg_temp.raises(format($q$insert into projects.fallback_records (organization_id, project_id, task_id, primary_agent, fallback_agent, reason, violations, outcome) values (%L, %L, %L, 'a', 'b', 'r', '[]', 'rejected')$q$, :'ORG', :'P_id', :'TC_id'), '23514'), 'the table refuses a rejected fallback with no reason to reject it');
select pg_temp.check(pg_temp.raises(format($q$update projects.fallback_records set outcome = 'accepted' where id = %L$q$, :'fb1'), '23001'), 'a fallback record is never rewritten');
select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.fallback_records where project_id = :'P_id') = 2, 'staff read the fallback records');
select pg_temp.check(pg_temp.raises(format($q$select * from projects.record_fallback(%L, 'a', 'b', 'r')$q$, :'TC_id'), '42501'), 'an authenticated user cannot record a fallback');
reset role;
select pg_temp.as_user(:'UC', :'ORG', 'client_member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.fallback_records) = 0, 'a client sees no fallback records');
reset role;

-- ── 7. usage costs: unknown is NULL, never 0 ────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true);
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'unknown', 0)) = 'unknown_has_no_cost', 'an unknown cost with a 0 is refused by the door');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'reported')) = 'cost_required', 'a reported cost with no number is refused');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'guessed', 1)) = 'bad_input', 'a cost source outside the three is refused');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'estimated', -1)) = 'bad_input', 'a negative cost is refused');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'unknown', null, :'TX_id')) = 'task_not_in_project', 'a task from another project is refused');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'unknown', null, :'TC_id', 'openrouter', 'm', 100, 50)) = 'recorded', 'an unknown cost is recorded with NULL');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'reported', 0.25, :'TC_id', 'openrouter', 'm', 1000, 500)) = 'recorded', 'a reported cost is recorded');
select pg_temp.check((select outcome from projects.record_usage_cost(:'P_id', 'backend_developer', 'estimated', 0.125)) = 'recorded', 'an estimated cost is recorded');
reset role;
select pg_temp.check(pg_temp.raises(format($q$insert into projects.usage_cost_records (organization_id, project_id, agent_key, cost_source, cost_usd) values (%L, %L, 'a', 'unknown', 0)$q$, :'ORG', :'P_id'), '23514'), 'the table refuses unknown with a numeric cost (0 is a number)');
select pg_temp.check(pg_temp.raises(format($q$insert into projects.usage_cost_records (organization_id, project_id, agent_key, cost_source) values (%L, %L, 'a', 'reported')$q$, :'ORG', :'P_id'), '23514'), 'the table refuses reported with no cost');
select pg_temp.check((select count(*) from projects.usage_cost_records where project_id = :'P_id' and cost_source = 'unknown' and cost_usd is null) = 1, 'the unknown row stores NULL');
select pg_temp.check(pg_temp.raises(format($q$update projects.usage_cost_records set cost_usd = 0 where project_id = %L$q$, :'P_id'), '23001'), 'a usage record is never rewritten');

select pg_temp.as_user(:'U', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check((select cost_usd from projects.usage_cost_summary(:'P_id') where cost_source = 'unknown') is null, 'the summary reports the unknown group as NULL, not 0');
select pg_temp.check((select count(*) from projects.usage_cost_summary(:'P_id') where cost_source = 'unknown') = 1, 'the unknown group exists in the summary');
select pg_temp.check((select cost_usd from projects.usage_cost_summary(:'P_id') where cost_source = 'reported') = 0.25, 'the reported total is the reported cost only');
select pg_temp.check((select cost_usd from projects.usage_cost_summary(:'P_id') where cost_source = 'estimated') = 0.125, 'the estimated total is kept apart from the reported one');
select pg_temp.check(pg_temp.raises(format($q$select * from projects.record_usage_cost(%L, 'a', 'unknown')$q$, :'P_id'), '42501'), 'an authenticated user cannot record a usage cost');
reset role;
select pg_temp.as_user(:'UC', :'ORG', 'client_member');
set local role authenticated;
select pg_temp.check((select count(*) from projects.usage_cost_summary(:'P_id')) = 0, 'a client reads no usage costs');
reset role;

rollback;
\echo ALL PHASE 5 ORCHESTRATOR CHECKS PASSED
