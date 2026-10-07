-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Orchestrator / Coordination: a handoff is a task with a contract, a board and a way out (migration 20261127000000).
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1o-handoffs.sql     Rolls back. Any failed check raises.
-- Runs as a non-superuser-compatible script: no session_replication_role, every count scoped to its own organisation.
-- Red-proofs at the end mutate the LIVE function definition; a mutation that changes nothing raises.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.fails_with(text, text) to public;
-- mutate the live definition of a function; raise when the mutation changed nothing (a no-op red-proof proves nothing)
create or replace function pg_temp.mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin
  n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if;
  execute n;
end $$;
grant execute on function pg_temp.mutate(regprocedure, text, text) to public;

\set PORG '00000000-0000-4000-8000-0000000a0100'
\set POWN '00000000-0000-4000-8000-0000000a0101'
\set PMEM '00000000-0000-4000-8000-0000000a0102'
\set OTHER '00000000-0000-4000-8000-0000000a0110'
\set OTHERU '00000000-0000-4000-8000-0000000a0111'
\set C1 '00000000-0000-4000-8000-0000000a01c1'

insert into auth.users (id, email) values (:'POWN', 'p1o-owner@example.test'), (:'PMEM', 'p1o-member@example.test'), (:'OTHERU', 'p1o-other@example.test');
insert into core.users (id, email, full_name) values (:'POWN', 'p1o-owner@example.test', 'P1O Owner'), (:'PMEM', 'p1o-member@example.test', 'P1O Member'), (:'OTHERU', 'p1o-other@example.test', 'P1O Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'PORG', 'zztest p1o org', 'zztest-p1o'), (:'OTHER', 'zztest p1o other org', 'zztest-p1o-other');
insert into core.memberships (organization_id, user_id, role) values (:'PORG', :'POWN', 'owner'), (:'PORG', :'PMEM', 'member'), (:'OTHER', :'OTHERU', 'owner');

-- ── the registry routes a known task type and escalates an unknown one ────
select pg_temp.check((select routed from ai.p1o_route_task('sales.conversation')) and (select handler_key from ai.p1o_route_task('sales.conversation')) = 'sales', 'sales.conversation routes to the Sales agent');
select pg_temp.check((select handler_kind from ai.p1o_route_task('scheduling.request')) = 'service', 'scheduling routes to a service (the Scheduler is not a registry agent) and says so');
select pg_temp.check((select handler_kind from ai.p1o_route_task('approval.decision')) = 'human', 'an approval routes to a person, never to an agent');
select pg_temp.check(not (select routed from ai.p1o_route_task('nothing.known')) and (select reason from ai.p1o_route_task('nothing.known')) like 'no registered%', 'an unknown task type has no safe route and says why');
select pg_temp.check(not (select routed from ai.p1o_route_task('model.selection')) and (select reason from ai.p1o_route_task('model.selection')) like '%unavailable or disabled%', 'the Orchestrator is switched off by the owner''s activation answer, so model.selection has no route and says so (honest, not faked)');
update ai.agents set enabled = false, disabled_reason = 'zztest p1o' where key = 'sales';
select pg_temp.check(not (select routed from ai.p1o_route_task('sales.conversation')), 'a task whose agent is disabled has no route');
update ai.agents set enabled = true, disabled_reason = null where key = 'sales';

-- ── creation through the door ──────────────────────────────────────────────
select pg_temp.as_service();
select outcome, handoff_id as hid from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'verify the lead notes', gen_random_uuid(), 'p1o:a', '["notes are complete"]'::jsonb, 'high') \gset A_
select pg_temp.check(:'A_outcome' = 'created', 'a handoff is created with its contract');
select pg_temp.check((select acceptance_criteria->>0 from ai.handoffs where id = :'A_hid') = 'notes are complete' and (select priority from ai.handoffs where id = :'A_hid') = 'high', 'acceptance criteria and priority are on the row');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'PORG' and type = 'handoff.created' and subject_id = :'A_hid') = 1, 'creation writes one handoff.created event');
select pg_temp.check((select outcome from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'verify the lead notes', gen_random_uuid(), 'p1o:a', '["x"]'::jsonb)) = 'duplicate'
                     and (select handoff_id from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'again', gen_random_uuid(), 'p1o:a', '["x"]'::jsonb)) = :'A_hid', 'the same idempotency key returns the same task, not a second one');
select pg_temp.check((select count(*) from ai.handoffs where organization_id = :'PORG' and idempotency_key = 'p1o:a') = 1, 'one row for the key');
select pg_temp.check((select outcome from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'x', gen_random_uuid(), 'p1o:no-criteria', '[]'::jsonb)) = 'missing_acceptance_criteria', 'a task with no acceptance criteria is refused at intake');
select pg_temp.check((select outcome from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'x', gen_random_uuid(), '', '["x"]'::jsonb)) = 'missing_idempotency_key', 'a task with no idempotency key is refused at intake');
select pg_temp.check((select outcome from ai.p1o_create_handoff(:'PORG', 'sales', 'sales', 'x', gen_random_uuid(), 'p1o:self', '["x"]'::jsonb)) = 'refused', 'a handoff the registry forbids is refused, not raised');
select pg_temp.as_user(:'OTHERU', :'OTHER', 'owner');
select pg_temp.check((select outcome from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'x', gen_random_uuid(), 'p1o:x', '["x"]'::jsonb)) = 'forbidden', 'another organisation cannot create a task here');
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check((select outcome from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'by a person', gen_random_uuid(), 'p1o:person', '["x"]'::jsonb)) = 'created', 'a member of the organisation can create one');

-- ── prerequisites: no dispatch before they pass, no cycles ─────────────────
select pg_temp.as_service();
select handoff_id as bid from ai.p1o_create_handoff(:'PORG', 'sales', 'project_manager', 'start the project', gen_random_uuid(), 'p1o:b', '["project exists"]'::jsonb, 'normal',
                                                    null, null, null, array[:'A_hid'::uuid]) \gset B_
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set status = 'accepted' where id = %L$f$, :'B_bid'), '23514'), 'B cannot be accepted while its prerequisite has not completed');
select pg_temp.check((select count(*) from ai.p1o_workflow_task_board()) = 0, 'the board is empty to a service identity (it is a person''s screen)');
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set dependency_ids = array[%L::uuid] where id = %L$f$, :'B_bid', :'A_hid'), '23514'), 'A cannot depend on B: that is a cycle, a deadlock');
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set dependency_ids = array[id] where id = %L$f$, :'A_hid'), '23514'), 'a handoff cannot wait for itself');
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set dependency_ids = array[gen_random_uuid()] where id = %L$f$, :'A_hid'), '23514'), 'a prerequisite that does not exist is refused');

update ai.handoffs set status = 'accepted' where id = :'A_hid';
update ai.handoffs set status = 'running' where id = :'A_hid';
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set status = 'accepted' where id = %L$f$, :'B_bid'), '23514'), 'B still cannot start while A is only running');
update ai.handoffs set status = 'completed', verification = '{"outcome":"verified","verifier":"quality_assurance","evidence":[{"passed":true,"note":"notes read"}]}'::jsonb where id = :'A_hid';
update ai.handoffs set status = 'accepted' where id = :'B_bid';
select pg_temp.check((select status from ai.handoffs where id = :'B_bid') = 'accepted', 'once A has completed, B is accepted');

-- ── failure counted, summarised, bounded; an uncertain effect is not retried blind ──
update ai.handoffs set status = 'running' where id = :'B_bid';
select outcome, new_status, retry_count as rc from ai.p1o_record_handoff_failure(:'B_bid', 'the project service timed out', true, true) \gset F1_
select pg_temp.check(:'F1_outcome' = 'recorded' and :'F1_new_status' = 'failed_retryable' and :'F1_rc' = '1', 'a first failure is retryable and counted');
select pg_temp.check((select previous_failure_summary from ai.handoffs where id = :'B_bid') = 'the project service timed out' and (select side_effect_uncertain from ai.handoffs where id = :'B_bid'), 'the failure summary is kept and the side effect is flagged uncertain');
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check((select outcome from ai.p1o_retry_handoff(:'B_bid', 'try again')) = 'reconcile_first', 'a retry is refused while the effect of the last attempt is uncertain');
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set status = 'running' where id = %L$f$, :'B_bid'), '23514'), 'even a direct write cannot retry past an uncertain effect');
select pg_temp.as_user(:'PMEM', :'PORG', 'member');
select pg_temp.check((select outcome from ai.p1o_reconcile_handoff(:'B_bid', 'did_not_happen', 'checked the project list')) = 'forbidden', 'a plain member cannot reconcile an effect: it is an administrator''s call');
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check((select outcome from ai.p1o_reconcile_handoff(:'B_bid', 'did_not_happen', 'checked the project list')) = 'reconciled', 'an administrator reconciles it');
select outcome as retry_out from ai.p1o_retry_handoff(:'B_bid', 'effect checked') \gset
select pg_temp.check(:'retry_out' = 'retrying' and (select status from ai.handoffs where id = :'B_bid') = 'running', 'then the retry runs');
select pg_temp.check((select previous_failure_summary from ai.handoffs where id = :'B_bid') is not null, 'the previous failure travels with the retry');
select pg_temp.as_service();
select outcome, new_status as ns from ai.p1o_record_handoff_failure(:'B_bid', 'second failure', true, false) \gset F2_
update ai.handoffs set status = 'running' where id = :'B_bid';
select outcome, new_status as ns, retry_count as rc from ai.p1o_record_handoff_failure(:'B_bid', 'third failure', true, false) \gset F3_
select pg_temp.check(:'F2_ns' = 'failed_retryable' and :'F3_ns' = 'failed_permanent' and :'F3_rc' = '3', 'the third failure is permanent: retries are bounded, never an endless loop');
select pg_temp.check((select count(*) from ai.p1o_handoff_escalations where handoff_id = :'B_bid' and cause = 'repeated_failure' and state = 'open') = 1, 'exhaustion raises one escalation');
select pg_temp.check((select count(*) from core.outbox_events where organization_id = :'PORG' and type = 'handoff.escalated' and subject_id = :'B_bid') = 1, 'and one handoff.escalated event');
select pg_temp.check((select failures->0->>'summary' from ai.p1o_handoff_escalations where handoff_id = :'B_bid') = 'third failure' and length((select recommendation from ai.p1o_handoff_escalations where handoff_id = :'B_bid')) > 10, 'the escalation carries the failure and a recommendation');

-- ── pause / resume / reassign: a person decides ────────────────────────────
select handoff_id as cid from ai.p1o_create_handoff(:'PORG', 'sales', 'project_manager', 'second project', gen_random_uuid(), 'p1o:c', '["x"]'::jsonb) \gset C_
select pg_temp.as_user(:'PMEM', :'PORG', 'member');
select pg_temp.check((select outcome from ai.p1o_pause_handoff(:'C_cid', 'hold')) = 'forbidden', 'a plain member cannot pause');
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check((select outcome from ai.p1o_pause_handoff(:'C_cid', '')) = 'missing_reason', 'a pause needs a reason');
select pg_temp.check((select outcome from ai.p1o_pause_handoff(:'C_cid', 'client asked us to wait')) = 'paused', 'an administrator pauses');
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set status = 'accepted' where id = %L$f$, :'C_cid'), '23514'), 'a paused task cannot be accepted');
select pg_temp.check((select board_state from ai.p1o_workflow_task_board() where handoff_id = :'C_cid') = 'blocked', 'the board shows it as blocked');
select outcome as res_out from ai.p1o_resume_handoff(:'C_cid') \gset
select pg_temp.check(:'res_out' = 'resumed' and (select blocker from ai.handoffs where id = :'C_cid') is null, 'resume clears it');
select outcome as rea_out from ai.p1o_reassign_handoff(:'C_cid', 'quality_assurance', 'QA should read this first') \gset
select pg_temp.check(:'rea_out' = 'reassigned' and (select to_agent from ai.handoffs where id = :'C_cid') = 'quality_assurance', 'a queued task is reassigned to a declared target');
select pg_temp.check((select outcome from ai.p1o_reassign_handoff(:'C_cid', 'developer', 'x')) = 'not_a_declared_target', 'a reassignment the registry forbids is refused');
select pg_temp.check((select decisions->0->>'kind' from ai.handoffs where id = :'C_cid') = 'reassigned', 'the reassignment is on the row with its reason');
select pg_temp.as_service();
update ai.handoffs set status = 'accepted' where id = :'C_cid';
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check((select outcome from ai.p1o_reassign_handoff(:'C_cid', 'project_manager', 'x')) = 'not_queued', 'work already accepted is not relabelled');

-- ── conflicting results block both and ask a person ────────────────────────
select pg_temp.check((select outcome from ai.p1o_record_conflicting_results(array[:'C_cid'::uuid], 'x')) = 'needs_two_or_more', 'one result is not a conflict');
select pg_temp.check((select escalations from ai.p1o_record_conflicting_results(array[:'C_cid'::uuid, :'A_hid'::uuid], 'two summaries disagree on the budget')) = 2, 'two disagreeing results raise two escalations');
select pg_temp.check((select blocker from ai.handoffs where id = :'C_cid') like 'conflicting results%', 'the live one is blocked with the reason');

-- ── the board, the queue and the metrics ───────────────────────────────────
select pg_temp.check((select count(*) from ai.p1o_workflow_task_board() where handoff_id in (:'A_hid', :'B_bid', :'C_cid')) = 3, 'the board shows this organisation''s tasks');
select pg_temp.check((select board_state from ai.p1o_workflow_task_board() where handoff_id = :'A_hid') = 'closed', 'a completed task is closed');
select pg_temp.check((select board_state from ai.p1o_workflow_task_board() where handoff_id = :'B_bid') = 'escalated', 'a permanently failed task with an open escalation is escalated');
select pg_temp.check((select board_state from ai.p1o_workflow_task_board() where handoff_id = :'C_cid') = 'escalated', 'a conflicting task with an open escalation is escalated');
select pg_temp.check((select count(*) from ai.p1o_workflow_task_board('escalated') where handoff_id in (:'A_hid', :'B_bid', :'C_cid')) = 2, 'the state filter works');
select pg_temp.check((select count(*) from ai.p1o_workflow_task_board(null, 'quality_assurance', null) where handoff_id = :'C_cid') = 1, 'the agent filter works');
select pg_temp.check((select count(*) from ai.p1o_workflow_task_board(null, null, 'urgent')) = 0, 'the priority filter works');
update ai.handoffs set created_at = now() - interval '3 days' where id = :'C_cid';
select pg_temp.check((select stale from ai.p1o_workflow_task_board() where handoff_id = :'C_cid'), 'a task open more than a day is stale');
select pg_temp.check((select count(*) from ai.p1o_workflow_task_board(null, null, null, null, true) where handoff_id = :'C_cid') = 1, 'the stale filter finds it');
select pg_temp.check((select sum(tasks) from ai.p1o_workflow_queue_summary()) >= 3, 'the queue summary counts the board');
select pg_temp.check((select handoffs from ai.p1o_handoff_metrics(30)) >= 3 and (select completed from ai.p1o_handoff_metrics(30)) = 1 and (select escalated from ai.p1o_handoff_metrics(30)) >= 2, 'the metrics count completions and escalations');
select pg_temp.check((select (ai.p1o_handoff_packet(:'B_bid'))->'dependencies'->0->>'status') = 'completed' and (select (ai.p1o_handoff_packet(:'B_bid'))->>'retryCount') = '3', 'the packet shows prerequisites and the retry count');
select pg_temp.as_user(:'OTHERU', :'OTHER', 'owner');
select pg_temp.check((select count(*) from ai.p1o_workflow_task_board()) = 0 and ai.p1o_handoff_packet(:'B_bid') is null, 'another organisation sees none of it');
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check((select outcome from ai.p1o_resolve_handoff_escalation((select id from ai.p1o_handoff_escalations where handoff_id = :'B_bid'), 'we closed the project by hand')) = 'resolved', 'an administrator resolves an escalation with a note');
select pg_temp.check((select board_state from ai.p1o_workflow_task_board() where handoff_id = :'B_bid') = 'failed', 'the board then shows it as failed, not escalated');

-- ── work tied to an obsolete quotation is withdrawn ────────────────────────
select pg_temp.as_service();
insert into core.client_accounts (organization_id, name) values (:'PORG', 'zztest p1o client') returning id as acct \gset
insert into sales.opportunities (organization_id, client_account_id, name) values (:'PORG', :'acct', 'zztest p1o deal') returning id as opp \gset
insert into sales.proposals (organization_id, opportunity_id, title) values (:'PORG', :'opp', 'v1') returning id as prop \gset
select handoff_id as sid from ai.p1o_create_handoff(:'PORG', 'sales', 'project_manager', 'bound work', gen_random_uuid(), 'p1o:stale', '["x"]'::jsonb, 'normal',
                                                    null, null, null, '{}', :'prop') \gset S_
update sales.proposals set status = 'superseded' where id = :'prop';
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set status = 'accepted' where id = %L$f$, :'S_sid'), '23514'), 'a task bound to a superseded quotation cannot be accepted');
select withdrawn as wd from ai.p1o_invalidate_stale_handoffs(:'PORG') \gset
select pg_temp.check(:'wd' = '1' and (select status from ai.handoffs where id = :'S_sid') = 'cancelled', 'the sweep withdraws it');
select pg_temp.check((select count(*) from ai.p1o_handoff_escalations where handoff_id = :'S_sid' and cause = 'stale_version') = 1, 'and says why');
select pg_temp.as_user(:'POWN', :'PORG', 'owner');
select pg_temp.check(pg_temp.fails_with($f$select * from ai.p1o_invalidate_stale_handoffs('00000000-0000-4000-8000-0000000a0100')$f$, '42501'), 'the sweep is a runner door: a person cannot call it');

-- ── the doors are not open to anon ─────────────────────────────────────────
select pg_temp.check(not has_function_privilege('anon', 'ai.p1o_pause_handoff(uuid,text)', 'execute') and not has_function_privilege('authenticated', 'ai.p1o_invalidate_stale_handoffs(uuid)', 'execute'), 'anon cannot pause and a person cannot run the sweep');

-- ═══ red-proofs: each control, removed from the LIVE definition, makes its check fail ═══
select pg_temp.as_service();
-- 1. the dependency gate
select pg_temp.mutate('ai.p1o_handoff_dispatch_guard()', 'if v_open > 0 then', 'if false then');
select handoff_id as r1 from ai.p1o_create_handoff(:'PORG', 'sales', 'project_manager', 'red 1', gen_random_uuid(), 'p1o:r1', '["x"]'::jsonb, 'normal', null, null, null, array[:'C_cid'::uuid]) \gset R1_
select pg_temp.check(not pg_temp.fails_with(format($f$update ai.handoffs set status = 'accepted' where id = %L$f$, :'R1_r1'), '23514'), 'RED-PROOF: without the prerequisite gate an unmet prerequisite no longer blocks');
-- 2. the uncertain-effect gate
select pg_temp.mutate('ai.p1o_handoff_dispatch_guard()', 'and new.side_effect_uncertain then', 'and false then');
select pg_temp.mutate('ai.p1o_handoff_dispatch_guard()', 'if v_dead > 0 then', 'if false then');
select handoff_id as r2 from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'red 2', gen_random_uuid(), 'p1o:r2', '["x"]'::jsonb) \gset R2_
update ai.handoffs set status = 'accepted' where id = :'R2_r2';
update ai.handoffs set status = 'running' where id = :'R2_r2';
select outcome from ai.p1o_record_handoff_failure(:'R2_r2', 'red failure', true, true) \gset RF_
select pg_temp.check(pg_temp.fails_with(format($f$update ai.handoffs set status = 'running' where id = %L$f$, :'R2_r2'), '23514') is false, 'RED-PROOF: without the uncertain-effect gate a blind retry runs');
-- 3. the cycle check
select pg_temp.mutate('ai.p1o_handoff_dependency_guard()', 'if v_cycle then', 'if false then');
select pg_temp.check(not pg_temp.fails_with(format($f$update ai.handoffs set dependency_ids = array[%L::uuid] where id = %L$f$, :'B_bid', :'A_hid'), '23514'), 'RED-PROOF: without the cycle check a deadlock is accepted');
-- 4. the admin-only rule on pause
select pg_temp.mutate('ai.p1o_door_refusal(uuid,boolean)', 'if p_admin_only then', 'if false then');
select pg_temp.as_user(:'PMEM', :'PORG', 'member');
select pg_temp.check((select outcome from ai.p1o_reassign_handoff(:'R2_r2', 'quality_assurance', 'x')) <> 'forbidden', 'RED-PROOF: without the admin-only rule a plain member reaches the reassign logic');
-- 5. bounded retries
select pg_temp.as_service();
select pg_temp.mutate('ai.p1o_record_handoff_failure(uuid,text,boolean,boolean)', 'c_max_retries constant int := 3;', 'c_max_retries constant int := 99;');
select handoff_id as r5 from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'red 5', gen_random_uuid(), 'p1o:r5', '["x"]'::jsonb) \gset R5_
update ai.handoffs set status = 'accepted' where id = :'R5_r5';
update ai.handoffs set status = 'running', retry_count = 2 where id = :'R5_r5';
select new_status as r5s from ai.p1o_record_handoff_failure(:'R5_r5', 'red', true, false) \gset
select pg_temp.check(:'r5s' = 'failed_retryable', 'RED-PROOF: without the retry bound the third failure stays retryable (an endless loop)');

rollback;
\echo 'verify-p1o-handoffs: all checks passed'
