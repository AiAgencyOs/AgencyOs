-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 round 4, Orchestrator and Coordination (migration 20261203000000): the 14-state task machine, the unified result envelope, the policy version on
-- every agent run, and timeout / permission-conflict escalations raised by a sweep.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1r-orchestrator.sql     Rolls back. Any failed check raises.
-- No replication-role switch; every count is scoped to this script's own organisation; helper names are prefixed p1r_ so chained verifiers cannot collide.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p1r_check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.p1r_check(boolean, text) to public;
create or replace function pg_temp.p1r_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.p1r_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p1r_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.p1r_as_service() to public;
create or replace function pg_temp.p1r_fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.p1r_fails_with(text, text) to public;
create or replace function pg_temp.p1r_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin
  n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if;
  execute n;
end $$;
grant execute on function pg_temp.p1r_mutate(regprocedure, text, text) to public;

\set PORG '00000000-0000-4000-8000-0000000b0100'
\set POWN '00000000-0000-4000-8000-0000000b0101'
\set PMEM '00000000-0000-4000-8000-0000000b0102'
\set OTHER '00000000-0000-4000-8000-0000000b0110'
\set OTHERU '00000000-0000-4000-8000-0000000b0111'

insert into auth.users (id, email) values (:'POWN', 'p1r-owner@example.test'), (:'PMEM', 'p1r-member@example.test'), (:'OTHERU', 'p1r-other@example.test');
insert into core.users (id, email, full_name) values (:'POWN', 'p1r-owner@example.test', 'P1R Owner'), (:'PMEM', 'p1r-member@example.test', 'P1R Member'), (:'OTHERU', 'p1r-other@example.test', 'P1R Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'PORG', 'zztest p1r org', 'zztest-p1r'), (:'OTHER', 'zztest p1r other org', 'zztest-p1r-other');
insert into core.memberships (organization_id, user_id, role) values (:'PORG', :'POWN', 'owner'), (:'PORG', :'PMEM', 'member'), (:'OTHER', :'OTHERU', 'owner');

-- ── the machine: edges ─────────────────────────────────────────────────────
select pg_temp.p1r_check(array_length(ai.p1r_main_line(), 1) = 14, 'the main line has the fourteen states');
select pg_temp.p1r_check(ai.p1r_transition_allowed('ready', 'dispatched') and ai.p1r_transition_allowed('in_progress', 'blocked') and ai.p1r_transition_allowed('blocked', 'in_progress'), 'forward, into an exception and back out are edges');
select pg_temp.p1r_check(not ai.p1r_transition_allowed('accepted', 'in_progress') and not ai.p1r_transition_allowed('closed', 'ready') and not ai.p1r_transition_allowed('failed', 'retrying'), 'the main line does not go backward and a settled task has no exits');
select pg_temp.p1r_check(ai.p1r_step_allowed('ready', 'dispatched') and not ai.p1r_step_allowed('ready', 'accepted') and ai.p1r_step_allowed('in_progress', 'result_received'), 'a direct move is the next step (WAITING_FOR_RESULT may be skipped), never a leap');
select pg_temp.p1r_check(ai.p1r_state_for_status('running', '[]', false) = 'in_progress' and ai.p1r_state_for_status('needs_input', '[]', false) = 'blocked'
  and ai.p1r_state_for_status('queued', '["x"]', false) = 'ready' and ai.p1r_state_for_status('queued', '[]', false) = 'created' and ai.p1r_state_for_status('queued', '["x"]', true) = 'blocked', 'the legacy status maps onto the machine');

-- ── a task is born ready when it has a contract, and every move is recorded ──
select pg_temp.p1r_as_service();
select handoff_id as hid from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'verify the lead notes', gen_random_uuid(), 'p1r:a', '["notes are complete"]'::jsonb, 'high') \gset A_
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'A_hid') = 'ready', 'a task with acceptance criteria is born READY');
select pg_temp.p1r_check((select count(*) from ai.p1r_handoff_transitions where handoff_id = :'A_hid' and from_state is null and to_state = 'ready' and actor_kind = 'system') = 1, 'its birth is one history row, by the system');
update ai.handoffs set status = 'accepted' where id = :'A_hid';
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'A_hid') = 'acknowledged', 'the legacy accept is mirrored as ACKNOWLEDGED');
update ai.handoffs set status = 'running' where id = :'A_hid';
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'A_hid') = 'in_progress', 'running is IN_PROGRESS');
select pg_temp.p1r_check((select count(*) from ai.p1r_handoff_transitions where handoff_id = :'A_hid') = 3, 'three moves, three history rows');

-- ── a direct leap is refused; the door takes the next step ────────────────
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update ai.handoffs set task_state = 'closed' where id = %L$f$, :'A_hid'), '23514'), 'a direct write cannot leap to CLOSED');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update ai.handoffs set task_state = 'accepted' where id = %L$f$, :'A_hid'), '23514'), 'nor to ACCEPTED: acceptance is the verified completion');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'handed_off')) = 'not_the_next_step', 'the door refuses a leap');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'bogus')) = 'not_a_door_state', 'and an unknown state');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'result_received', 'worker returned')) = 'advanced', 'RESULT_RECEIVED follows IN_PROGRESS');
select pg_temp.p1r_check((select note from ai.p1r_handoff_transitions where handoff_id = :'A_hid' and to_state = 'result_received') = 'worker returned' and (select source from ai.p1r_handoff_transitions where handoff_id = :'A_hid' and to_state = 'result_received') = 'door', 'the note and the door are in the history');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'validating_result')) = 'advanced', 'VALIDATING_RESULT follows');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'handoff_ready')) in ('not_the_next_step', 'status_disagrees'), 'HANDOFF_READY cannot be reached before the task is accepted');
update ai.handoffs set status = 'completed', verification = '{"outcome":"verified","verifier":"quality_assurance","evidence":[{"passed":true,"note":"notes read"}]}'::jsonb where id = :'A_hid';
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'A_hid') = 'accepted', 'a verified completion is ACCEPTED');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'handoff_ready')) = 'advanced', 'HANDOFF_READY');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'handed_off')) = 'advanced', 'HANDED_OFF');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'verified')) = 'person_required', 'VERIFIED is a person''s decision: the service role is refused');
select pg_temp.p1r_as_user(:'PMEM', :'PORG', 'member');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'verified')) = 'forbidden', 'a plain member is refused too');
select pg_temp.p1r_as_user(:'OTHERU', :'OTHER', 'owner');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'verified')) = 'forbidden', 'and so is another organisation');
select pg_temp.p1r_as_user(:'POWN', :'PORG', 'owner');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'verified')) = 'advanced', 'an administrator verifies');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'A_hid', 'closed', 'delivered')) = 'advanced', 'and closes');
select pg_temp.p1r_check((select actor_kind from ai.p1r_handoff_transitions where handoff_id = :'A_hid' and to_state = 'closed') = 'person'
  and (select actor_user_id from ai.p1r_handoff_transitions where handoff_id = :'A_hid' and to_state = 'closed') = :'POWN', 'the history names the person who closed it');
select pg_temp.p1r_check((select count(*) from ai.p1r_handoff_history(:'A_hid')) = 10, 'the history reads in order: ten moves');
select pg_temp.p1r_check((select to_state from ai.p1r_handoff_history(:'A_hid') limit 1) = 'ready', 'and begins at the birth');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update ai.handoffs set task_state = 'in_progress' where id = %L$f$, :'A_hid'), '23514'), 'a closed task has no way back');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update ai.p1r_handoff_transitions set note = 'edited' where handoff_id = %L$f$, :'A_hid'), '23514'), 'the history cannot be edited');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$delete from ai.p1r_handoff_transitions where handoff_id = %L$f$, :'A_hid'), '23001'), 'nor deleted');
select pg_temp.p1r_as_user(:'OTHERU', :'OTHER', 'owner');
select pg_temp.p1r_check((select count(*) from ai.p1r_handoff_history(:'A_hid')) = 0, 'another organisation reads none of it');
select pg_temp.p1r_as_service();
select pg_temp.p1r_check((select count(*) from ai.p1r_handoff_history(:'A_hid')) = 0, 'and the history is a person''s screen: the service identity reads none');

-- ── exceptions: pause, retry, permanent failure ────────────────────────────
select handoff_id as bid from ai.p1o_create_handoff(:'PORG', 'sales', 'project_manager', 'start the project', gen_random_uuid(), 'p1r:b', '["project exists"]'::jsonb) \gset B_
update ai.handoffs set status = 'accepted' where id = :'B_bid';
select pg_temp.p1r_as_user(:'POWN', :'PORG', 'owner');
select pg_temp.p1r_check((select outcome from ai.p1o_pause_handoff(:'B_bid', 'client asked us to wait')) = 'paused', 'a task is paused by a person');
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'B_bid') = 'blocked', 'PAUSED is BLOCKED');
select pg_temp.p1r_check((select outcome from ai.p1r_advance_handoff(:'B_bid', 'dispatched')) = 'paused', 'the door does not move a paused task');
select outcome as resumed from ai.p1o_resume_handoff(:'B_bid') \gset
select pg_temp.p1r_check(:'resumed' = 'resumed' and (select task_state from ai.handoffs where id = :'B_bid') = 'acknowledged', 'resume puts it back where its status says');
select pg_temp.p1r_as_service();
update ai.handoffs set status = 'running' where id = :'B_bid';
select new_status as nf1 from ai.p1o_record_handoff_failure(:'B_bid', 'service timed out', true, false) \gset
select pg_temp.p1r_check(:'nf1' = 'failed_retryable' and (select task_state from ai.handoffs where id = :'B_bid') = 'retrying', 'a retryable failure is RETRYING');
update ai.handoffs set status = 'running' where id = :'B_bid';
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'B_bid') = 'in_progress', 'the retry is IN_PROGRESS again');
select pg_temp.p1r_check((select new_status from ai.p1o_record_handoff_failure(:'B_bid', 'second', true, false)) = 'failed_retryable', 'a second retryable failure');
update ai.handoffs set status = 'running' where id = :'B_bid';
select pg_temp.p1r_check((select new_status from ai.p1o_record_handoff_failure(:'B_bid', 'third', true, false)) = 'failed_permanent', 'the third is permanent');
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'B_bid') = 'failed', 'and the task is FAILED, not pulled to ESCALATED by the escalation raised after it');
select pg_temp.p1r_check((select count(*) from ai.p1r_handoff_transitions where handoff_id = :'B_bid' and to_state = 'escalated') = 0, 'no escalated row appears on a settled task');

-- ── timeout escalation ─────────────────────────────────────────────────────
select handoff_id as cid from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'late task', gen_random_uuid(), 'p1r:c', '["x"]'::jsonb, 'normal', null, null, null, '{}', null, null, null, null, null, '{}'::jsonb, now() - interval '2 hours') \gset C_
select handoff_id as did from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'on time task', gen_random_uuid(), 'p1r:d', '["x"]'::jsonb, 'normal', null, null, null, '{}', null, null, null, null, null, '{}'::jsonb, now() + interval '2 hours') \gset D_
select pg_temp.p1r_as_user(:'POWN', :'PORG', 'owner');
select pg_temp.p1r_check(pg_temp.p1r_fails_with($f$select * from ai.p1r_sweep_handoff_escalations('00000000-0000-4000-8000-0000000b0100')$f$, '42501'), 'a person cannot run the sweep: it is a runner door');
select pg_temp.p1r_as_service();
select timed_out as t1 from ai.p1r_sweep_handoff_escalations(:'PORG') \gset S1_
select pg_temp.p1r_check(:'S1_t1' = 1, 'the sweep escalates exactly the one task past its deadline');
select pg_temp.p1r_check((select count(*) from ai.p1o_handoff_escalations where handoff_id = :'C_cid' and cause = 'timeout' and state = 'open') = 1 and (select count(*) from ai.p1o_handoff_escalations where handoff_id = :'D_did') = 0, 'a timeout escalation exists for the late task and none for the on-time one');
select pg_temp.p1r_check((select recommendation from ai.p1o_handoff_escalations where handoff_id = :'C_cid' and cause = 'timeout') like '%passed its deadline%', 'it carries a recommendation');
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'C_cid') = 'escalated' and (select status from ai.handoffs where id = :'C_cid') = 'queued', 'the task is ESCALATED and its work is untouched');
select pg_temp.p1r_check((select count(*) from core.outbox_events where organization_id = :'PORG' and type = 'handoff.escalated' and subject_id = :'C_cid') = 1, 'one handoff.escalated event');
select timed_out as t2 from ai.p1r_sweep_handoff_escalations(:'PORG') \gset S2_
select pg_temp.p1r_check(:'S2_t2' = 0, 'a second sweep raises nothing: one open escalation per cause');
select pg_temp.p1r_as_user(:'POWN', :'PORG', 'owner');
select escalation_id as eid from ai.p1o_escalate_handoff(:'C_cid', 'manual', 'looked at it') \gset E_
select pg_temp.p1r_check((select outcome from ai.p1o_resolve_handoff_escalation((select id from ai.p1o_handoff_escalations where handoff_id = :'C_cid' and cause = 'timeout'), 'client is fine with the delay')) = 'resolved', 'the timeout escalation is resolved');
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'C_cid') = 'escalated', 'while another escalation is open the task stays ESCALATED');
select outcome as resolved2 from ai.p1o_resolve_handoff_escalation(:'E_eid', 'done') \gset
select pg_temp.p1r_check(:'resolved2' = 'resolved' and (select task_state from ai.handoffs where id = :'C_cid') = 'ready', 'when the last is resolved the task returns to READY');

-- ── permission conflict ────────────────────────────────────────────────────
select pg_temp.p1r_as_service();
update ai.agents set enabled = false, disabled_reason = 'zztest p1r' where key = 'quality_assurance';
select permission_conflicts as pc from ai.p1r_sweep_handoff_escalations(:'PORG') \gset S3_
select pg_temp.p1r_check(:'S3_pc' >= 2, 'tasks queued for a switched-off agent are escalated as permission conflicts');
select pg_temp.p1r_check((select count(*) from ai.p1o_handoff_escalations where handoff_id = :'D_did' and cause = 'permission_conflict' and state = 'open') = 1
  and (select recommendation from ai.p1o_handoff_escalations where handoff_id = :'D_did' and cause = 'permission_conflict') like '%switched off%', 'with the reason in words');
select pg_temp.p1r_check((select status from ai.handoffs where id = :'D_did') = 'queued', 'and the work is held, not killed');
update ai.agents set enabled = true, disabled_reason = null where key = 'quality_assurance';
select permission_conflicts as pc2 from ai.p1r_sweep_handoff_escalations(:'PORG') \gset S4_
select pg_temp.p1r_check(:'S4_pc2' = 0, 'with the agent back on, nothing new is raised');

-- a deadline is only applied when the caller passes one
select expired as nx0 from ai.p1r_sweep_handoff_escalations(:'PORG') \gset
select pg_temp.p1r_check(:'nx0' = 0 and (select status from ai.handoffs where id = :'C_cid') = 'queued', 'with no deadline passed nothing expires: the maximum wait is the owner''s to set');
select handoff_id as xid from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'long overdue', gen_random_uuid(), 'p1r:x', '["x"]'::jsonb, 'normal', null, null, null, '{}', null, null, null, null, null, '{}'::jsonb, now() - interval '10 days') \gset X_
select expired as nx from ai.p1r_sweep_handoff_escalations(:'PORG', interval '1 day') \gset
select pg_temp.p1r_check(:'nx' >= 1 and (select task_state from ai.handoffs where id = :'X_xid') = 'expired', 'with a deadline passed, an overdue task is EXPIRED');
select pg_temp.p1r_check((select status from ai.handoffs where id = :'X_xid') = 'cancelled' and (select blocker from ai.handoffs where id = :'X_xid') like 'expired:%', 'and withdrawn so it cannot run');

-- ── the policy version on every agent run ──────────────────────────────────
insert into ai.agent_runs (organization_id, agent_key, trigger, work_class, status) values (:'PORG', 'sales', 'p1r-test', 'read', 'queued') returning id as run0 \gset
select pg_temp.p1r_check((select policy_version from ai.agent_runs where id = :'run0') = 'none', 'a run started with no active policy is stamped none, never left empty');
insert into core.p13_policy_versions (organization_id, policy_kind, version, status, summary, body, effective_from, created_by, activated_by, activated_at, activation_reason)
  values (:'PORG', 'routing', 3, 'active', 'zztest routing', '{}'::jsonb, now(), :'POWN', :'POWN', now(), 'test'),
         (:'PORG', 'approval', 2, 'active', 'zztest approval', '{}'::jsonb, now(), :'POWN', :'POWN', now(), 'test'),
         (:'PORG', 'pricing', 9, 'active', 'zztest pricing', '{}'::jsonb, now(), :'POWN', :'POWN', now(), 'test');
insert into ai.agent_runs (organization_id, agent_key, trigger, work_class, status) values (:'PORG', 'sales', 'p1r-test', 'read', 'queued') returning id as run1 \gset
select pg_temp.p1r_check((select policy_version from ai.agent_runs where id = :'run1') = 'approval:2;routing:3', 'a new run is stamped with the policies in force (routing, approval, data), not unrelated kinds');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update ai.agent_runs set policy_version = 'approval:1' where id = %L$f$, :'run1'), '23514'), 'the stamp cannot be rewritten');
update ai.agent_runs set status = 'running' where id = :'run1';
select pg_temp.p1r_check((select policy_version from ai.agent_runs where id = :'run1') = 'approval:2;routing:3', 'a status update leaves it alone');
select pg_temp.p1r_check((select policy_version from ai.agent_runs where id = :'run0') = 'none', 'and a later policy does not rewrite an earlier run');
select handoff_id as pid from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'stamped', gen_random_uuid(), 'p1r:p', '["x"]'::jsonb) \gset P_
select pg_temp.p1r_check((select policy_version from ai.handoffs where id = :'P_pid') = 'approval:2;routing:3', 'a handoff given no policy version is stamped too');
select handoff_id as qid from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'explicit', gen_random_uuid(), 'p1r:q', '["x"]'::jsonb, 'normal', null, null, null, '{}', null, null, 'routing:7') \gset Q_
select pg_temp.p1r_check((select policy_version from ai.handoffs where id = :'Q_qid') = 'routing:7', 'a version the caller names is kept');

-- ── the unified result envelope ────────────────────────────────────────────
insert into ai.agent_runs (organization_id, agent_key, trigger, work_class, status, model, provider_id, input_tokens, output_tokens, cost_minor, correlation_id)
  select :'PORG', 'quality_assurance', 'p1r-test', 'read', 'succeeded', 'claude-test', 'anthropic', 120, 40, 7, correlation_id from ai.handoffs where id = :'A_hid' returning id as runok \gset
insert into ai.agent_runs (organization_id, agent_key, trigger, work_class, status, output, correlation_id)
  select :'PORG', 'project_manager', 'p1r-test', 'read', 'failed', '{"errorClass":"provider_unavailable"}'::jsonb, correlation_id from ai.handoffs where id = :'B_bid' returning id as runbad \gset
insert into ai.agent_runs (organization_id, agent_key, trigger, work_class, status) values (:'PORG', 'sales', 'p1r-test', 'read', 'budget_exceeded') returning id as runbud \gset
select pg_temp.p1r_as_user(:'POWN', :'PORG', 'owner');
select ai.p1r_run_result_envelope(:'runok') as env \gset
select pg_temp.p1r_check((:'env'::jsonb)->>'status' = 'succeeded' and (:'env'::jsonb)->>'validationStatus' = 'verified' and (:'env'::jsonb)->>'nextAction' = 'proceed', 'a verified run: status, validation and next action');
select pg_temp.p1r_check((:'env'::jsonb)->>'provider' = 'anthropic' and (:'env'::jsonb)->>'model' = 'claude-test' and ((:'env'::jsonb)->'usage'->>'inputTokens')::int = 120 and ((:'env'::jsonb)->>'costMinor')::int = 7, 'provider, model, usage and cost');
select pg_temp.p1r_check(jsonb_array_length((:'env'::jsonb)->'dodEvidence') = 1 and (:'env'::jsonb)->>'handoffId' = :'A_hid', 'the definition-of-done evidence comes from the task it served');
select pg_temp.p1r_check((:'env'::jsonb)->>'policyVersion' = 'approval:2;routing:3' and (:'env'::jsonb)->>'attempt' = '1', 'the policy version and attempt number');
select ai.p1r_run_result_envelope(:'runbad') as env2 \gset
select pg_temp.p1r_check((:'env2'::jsonb)->>'errorClass' = 'provider_unavailable' and (:'env2'::jsonb)->>'validationStatus' = 'failed' and (:'env2'::jsonb)->>'nextAction' = 'escalate', 'a failed run carries its error class, a failed validation and the next action');
select ai.p1r_run_result_envelope(:'runbud') as env3 \gset
select pg_temp.p1r_check((:'env3'::jsonb)->>'errorClass' = 'budget_exceeded' and jsonb_array_length((:'env3'::jsonb)->'warnings') >= 1 and (:'env3'::jsonb)->>'nextAction' = 'raise_budget_or_escalate', 'a budget stop is named and warned about');
select pg_temp.p1r_as_user(:'OTHERU', :'OTHER', 'owner');
select pg_temp.p1r_check(ai.p1r_run_result_envelope(:'runok') is null, 'another organisation reads no envelope');
select pg_temp.p1r_check(ai.p1r_run_result_envelope(gen_random_uuid()) is null, 'an unknown run is null, not an error');

-- ── tenancy ────────────────────────────────────────────────────────────────
select pg_temp.p1r_check((select count(*) from core.unguarded_org_fks() u where u.child = 'ai.p1r_handoff_transitions') = 0, 'TENANCY: the transitions table''s organisation-scoped foreign key is guarded');

-- ── red-proofs: remove each control from the LIVE definition and see the check fail ──
select pg_temp.p1r_as_service();
-- 1. the edge check on a direct write
select pg_temp.p1r_mutate('ai.p1r_handoff_state_sync()'::regprocedure, 'not ai.p1r_step_allowed(old.task_state, new.task_state)', 'false');
select handoff_id as r1 from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'red 1', gen_random_uuid(), 'p1r:r1', '["x"]'::jsonb) \gset R1_
update ai.handoffs set task_state = 'closed' where id = :'R1_r1';
select pg_temp.p1r_check((select task_state from ai.handoffs where id = :'R1_r1') = 'closed', 'RED-PROOF: without the edge check a direct write leaps to CLOSED (the control is what refuses it)');
select pg_temp.p1r_mutate('ai.p1r_handoff_state_sync()'::regprocedure, 'and false then', 'and not ai.p1r_step_allowed(old.task_state, new.task_state) then');
select handoff_id as r1b from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'red 1b', gen_random_uuid(), 'p1r:r1b', '["x"]'::jsonb) \gset R1B_
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update ai.handoffs set task_state = 'closed' where id = %L$f$, :'R1B_r1b'), '23514'), 'the restored control refuses the leap again');
-- 2. a person is required to verify
select pg_temp.p1r_mutate('ai.p1r_advance_handoff(uuid,text,text)'::regprocedure, 'if (select auth.uid()) is null then return query select ''person_required''::text, v_h.task_state; return; end if;', 'null;');
update ai.handoffs set status = 'accepted' where id = :'R1B_r1b';
update ai.handoffs set status = 'running' where id = :'R1B_r1b';
update ai.handoffs set status = 'completed', verification = '{"outcome":"verified","verifier":"quality_assurance","evidence":[{"passed":true,"note":"ok"}]}'::jsonb where id = :'R1B_r1b';
select outcome from ai.p1r_advance_handoff(:'R1B_r1b', 'handoff_ready') \gset
select outcome from ai.p1r_advance_handoff(:'R1B_r1b', 'handed_off') \gset
select outcome as red2 from ai.p1r_advance_handoff(:'R1B_r1b', 'verified') \gset
select pg_temp.p1r_check(:'red2' = 'advanced' and (select task_state from ai.handoffs where id = :'R1B_r1b') = 'verified', 'RED-PROOF: without the person check the service role reaches the human gate VERIFIED (the control is what refuses it)');
-- 3. the sweep's deadline test
select pg_temp.p1r_mutate('ai.p1r_sweep_handoff_escalations(uuid,interval)'::regprocedure, 'h.sla_at < now() and h.paused_at is null', 'false');
select handoff_id as r3 from ai.p1o_create_handoff(:'PORG', 'sales', 'quality_assurance', 'red 3', gen_random_uuid(), 'p1r:r3', '["x"]'::jsonb, 'normal', null, null, null, '{}', null, null, null, null, null, '{}'::jsonb, now() - interval '3 hours') \gset R3_
select timed_out as nr3 from ai.p1r_sweep_handoff_escalations(:'PORG') \gset
select pg_temp.p1r_check(:'nr3' = 0 and (select count(*) from ai.p1o_handoff_escalations where handoff_id = :'R3_r3') = 0, 'RED-PROOF: without the deadline test the late task is not escalated (the sweep is what raises it)');
-- 4. the policy stamp
select pg_temp.p1r_mutate('ai.p1r_stamp_policy_version()'::regprocedure, 'new.policy_version := ai.p1r_active_policy_stamp(new.organization_id);', 'null;');
insert into ai.agent_runs (organization_id, agent_key, trigger, work_class, status) values (:'PORG', 'sales', 'p1r-test', 'read', 'queued') returning id as run4 \gset
select pg_temp.p1r_check((select policy_version from ai.agent_runs where id = :'run4') is null, 'RED-PROOF: without the stamp a new run carries no policy version');

rollback;
\echo 'verify-p1r-orchestrator: all checks passed'
