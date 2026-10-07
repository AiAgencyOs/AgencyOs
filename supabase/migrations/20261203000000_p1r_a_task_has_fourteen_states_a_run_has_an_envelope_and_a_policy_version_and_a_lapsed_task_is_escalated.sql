-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Orchestrator and Coordination, round 4 (traceability: docs/phase-1-orchestrator-quotation-round4-log.md).
-- Rows: P1-COORD-017 (the 14-state task machine), P1-HANDOFF-012 (the unified result envelope), P1-ORCH-021 (policy version on every agent run),
--       P1-COORD-020/P1-ORCH-014 (timeout and permission-conflict escalations raised by a sweep, not only by hand).
--
-- ai.handoffs.status keeps its ten legacy states and its guard (ai.handoffs_guard) untouched: that is what every existing flow reads. Beside it, a second column
-- carries the Coordination Agent's 14 states and its six exceptions (Coordination s17):
--
--   CREATED → VALIDATING → READY → DISPATCHED → ACKNOWLEDGED → IN_PROGRESS → WAITING_FOR_RESULT → RESULT_RECEIVED → VALIDATING_RESULT → ACCEPTED →
--   HANDOFF_READY → HANDED_OFF → VERIFIED → CLOSED;   exceptions: BLOCKED, RETRYING, FAILED, EXPIRED, CANCELLED, ESCALATED.
--
--   * a move the legacy status makes (accepted, running, needs_input, completed, ...) is mirrored by a trigger, so no existing writer has to change and none can
--     be blocked by this machine: the status guard stays the authority for those edges;
--   * a move made directly on the new column (a person or a worker advancing a task through the finer steps) must be an edge of the machine; anything else is
--     refused by the same trigger, and the door ai.p1r_advance_handoff additionally takes only the NEXT step and checks the legacy status agrees;
--   * VERIFIED and CLOSED are a person's: the door refuses the service role there (a human gate is never an agent's);
--   * every change writes one ai.p1r_handoff_transitions row: from, to, who (a person, or the system), when and why. That table cannot be edited or deleted.
-- Nothing here sends anything to anyone.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the vocabulary and the edges ───────────────────────────────────────────
create or replace function ai.p1r_main_line()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['created', 'validating', 'ready', 'dispatched', 'acknowledged', 'in_progress', 'waiting_for_result', 'result_received',
               'validating_result', 'accepted', 'handoff_ready', 'handed_off', 'verified', 'closed']::text[]
$$;

create or replace function ai.p1r_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_from is null or p_to is null or p_from = p_to then false
    when p_from in ('closed', 'failed', 'expired', 'cancelled') then false           -- no exits from a settled task
    when p_to in ('blocked', 'failed', 'expired', 'cancelled', 'escalated') then true  -- an exception is reachable from any live state
    when p_to = 'retrying' then p_from in ('dispatched', 'acknowledged', 'in_progress', 'waiting_for_result', 'result_received', 'validating_result', 'blocked', 'escalated')
    when p_from in ('blocked', 'retrying', 'escalated')
      then p_to in ('created', 'validating', 'ready', 'dispatched', 'acknowledged', 'in_progress', 'waiting_for_result', 'result_received', 'validating_result')
    else coalesce(array_position(ai.p1r_main_line(), p_to) > array_position(ai.p1r_main_line(), p_from), false)  -- the main line only goes forward
  end
$$;

-- A move made directly on the column, or through the door, is a STEP: the next state on the main line (WAITING_FOR_RESULT may be skipped), or an exception.
-- The moves the legacy status makes are mirrored by the trigger and may jump, because the status guard has already judged that edge.
create or replace function ai.p1r_step_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when not ai.p1r_transition_allowed(p_from, p_to) then false
    when p_from = any (ai.p1r_main_line()) and p_to = any (ai.p1r_main_line())
      then array_position(ai.p1r_main_line(), p_to) = array_position(ai.p1r_main_line(), p_from) + 1
           or (p_from = 'in_progress' and p_to = 'result_received')
    else true
  end
$$;

alter table ai.handoffs
  add column if not exists task_state text not null default 'created';
alter table ai.handoffs drop constraint if exists p1r_handoffs_task_state;
alter table ai.handoffs add constraint p1r_handoffs_task_state check (task_state in (
  'created', 'validating', 'ready', 'dispatched', 'acknowledged', 'in_progress', 'waiting_for_result', 'result_received', 'validating_result', 'accepted',
  'handoff_ready', 'handed_off', 'verified', 'closed', 'blocked', 'retrying', 'failed', 'expired', 'cancelled', 'escalated'));
comment on column ai.handoffs.task_state is 'P1-COORD-017. The Coordination Agent''s 14-state machine plus six exceptions. Mirrors the legacy status (ai.p1r_state_for_status) and is advanced through ai.p1r_advance_handoff; every change is in ai.p1r_handoff_transitions.';

-- The state the legacy columns imply. Existing rows are brought in line once, below.
create or replace function ai.p1r_state_for_status(p_status text, p_criteria jsonb, p_paused boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status = 'completed' then 'accepted'
    when p_status = 'cancelled' then 'cancelled'
    when p_status in ('failed_permanent', 'rejected') then 'failed'
    when p_paused then 'blocked'
    when p_status = 'needs_input' then 'blocked'
    when p_status = 'awaiting_approval' then 'waiting_for_result'
    when p_status = 'failed_retryable' then 'retrying'
    when p_status = 'running' then 'in_progress'
    when p_status = 'accepted' then 'acknowledged'
    else case when jsonb_typeof(p_criteria) = 'array' and jsonb_array_length(p_criteria) > 0 then 'ready' else 'created' end
  end
$$;

update ai.handoffs h
   set task_state = ai.p1r_state_for_status(h.status, h.acceptance_criteria, h.paused_at is not null)
 where h.task_state is distinct from ai.p1r_state_for_status(h.status, h.acceptance_criteria, h.paused_at is not null);

-- ── the history: from, to, who, when, why ──────────────────────────────────
create table if not exists ai.p1r_handoff_transitions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  handoff_id      uuid not null references ai.handoffs(id) on delete restrict,
  from_state      text,
  to_state        text not null,
  actor_user_id   uuid references core.users(id) on delete set null,
  actor_kind      text not null check (actor_kind in ('person', 'system')),
  source          text not null check (source in ('status_sync', 'door', 'sweep')),
  note            text check (note is null or length(note) <= 500),
  at              timestamptz not null default clock_timestamp()
);
create index if not exists p1r_handoff_transitions_idx on ai.p1r_handoff_transitions (handoff_id, at);
alter table ai.p1r_handoff_transitions enable row level security;
drop policy if exists p1r_handoff_transitions_select on ai.p1r_handoff_transitions;
create policy p1r_handoff_transitions_select on ai.p1r_handoff_transitions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1r_org_match_transitions_handoff on ai.p1r_handoff_transitions;
create trigger p1r_org_match_transitions_handoff
  before insert or update of handoff_id, organization_id on ai.p1r_handoff_transitions
  for each row execute function core.enforce_parent_org('handoff_id', 'ai.handoffs');
drop trigger if exists p1r_freeze_org_transitions on ai.p1r_handoff_transitions;
create trigger p1r_freeze_org_transitions before update of organization_id on ai.p1r_handoff_transitions for each row execute function core.freeze_organization_id();
drop trigger if exists p1r_transitions_reject_delete on ai.p1r_handoff_transitions;
create trigger p1r_transitions_reject_delete before delete on ai.p1r_handoff_transitions for each row execute function core.reject_end_user_delete();
drop trigger if exists p1r_transitions_no_truncate on ai.p1r_handoff_transitions;
create trigger p1r_transitions_no_truncate before truncate on ai.p1r_handoff_transitions for each statement execute function crm.reject_truncate();
-- history is read, not edited
create or replace function ai.p1r_transitions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a task''s transition history is append-only' using errcode = 'check_violation';
end $$;
drop trigger if exists p1r_transitions_append_only on ai.p1r_handoff_transitions;
create trigger p1r_transitions_append_only before update on ai.p1r_handoff_transitions for each row execute function ai.p1r_transitions_append_only();
revoke all on ai.p1r_handoff_transitions from public, anon, authenticated;
grant select on ai.p1r_handoff_transitions to authenticated;
grant all on ai.p1r_handoff_transitions to service_role;

-- ── the trigger that keeps the two machines in step ────────────────────────
create or replace function ai.p1r_handoff_state_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target text;
  v_force  text := nullif(current_setting('p1r.force_state', true), '');
  v_status_moved boolean;
begin
  if tg_op = 'INSERT' then
    new.task_state := ai.p1r_state_for_status(new.status, new.acceptance_criteria, new.paused_at is not null);
    return new;
  end if;

  v_status_moved := new.status is distinct from old.status
                    or new.paused_at is distinct from old.paused_at
                    or new.escalated_at is distinct from old.escalated_at;

  -- nothing the machine reads has moved: a direct move on the new column must be an edge of the machine
  if not v_status_moved then
    if new.task_state is distinct from old.task_state and not ai.p1r_step_allowed(old.task_state, new.task_state) then
      raise exception 'a task does not go from % to %: the machine has no such edge', old.task_state, new.task_state using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- a settled task is not moved by a late column change (an escalation raised after a permanent failure, for example)
  if old.task_state in ('closed', 'failed', 'expired', 'cancelled') then
    new.task_state := old.task_state;
    return new;
  end if;

  if v_force is not null then
    v_target := v_force;
  elsif new.status is distinct from old.status then
    v_target := case
      when new.status = 'completed' then 'accepted'
      when new.status = 'cancelled' then 'cancelled'
      when new.status in ('failed_permanent', 'rejected') then 'failed'
      when new.escalated_at is not null and old.escalated_at is null then 'escalated'
      else ai.p1r_state_for_status(new.status, new.acceptance_criteria, new.paused_at is not null)
    end;
  elsif new.paused_at is distinct from old.paused_at then
    v_target := ai.p1r_state_for_status(new.status, new.acceptance_criteria, new.paused_at is not null);
  elsif new.escalated_at is not null and old.escalated_at is null then
    v_target := 'escalated';
  else
    v_target := old.task_state;  -- an escalation was cleared: the resolution trigger puts the task back
  end if;
  new.task_state := v_target;
  return new;
end $$;

drop trigger if exists p1r_handoff_state_sync on ai.handoffs;
create trigger p1r_handoff_state_sync
  before insert or update of status, paused_at, escalated_at, task_state on ai.handoffs
  for each row execute function ai.p1r_handoff_state_sync();

create or replace function ai.p1r_handoff_state_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_source text := coalesce(nullif(current_setting('p1r.source', true), ''), 'status_sync');
  v_note text := nullif(current_setting('p1r.note', true), '');
begin
  if tg_op = 'UPDATE' and new.task_state is not distinct from old.task_state then
    return new;
  end if;
  insert into ai.p1r_handoff_transitions (organization_id, handoff_id, from_state, to_state, actor_user_id, actor_kind, source, note)
  values (new.organization_id, new.id, case when tg_op = 'UPDATE' then old.task_state end, new.task_state, v_uid,
          case when v_uid is null then 'system' else 'person' end, v_source, left(v_note, 500));
  return new;
end $$;

drop trigger if exists p1r_handoff_state_log on ai.handoffs;
create trigger p1r_handoff_state_log
  after insert or update on ai.handoffs
  for each row execute function ai.p1r_handoff_state_log();

-- a resolved escalation puts the task back where its status says it is
create or replace function ai.p1r_escalation_resolved_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'resolved' and old.state is distinct from 'resolved' then
    update ai.handoffs h
       set task_state = ai.p1r_state_for_status(h.status, h.acceptance_criteria, h.paused_at is not null)
     where h.id = new.handoff_id and h.task_state = 'escalated'
       and ai.p1r_transition_allowed('escalated', ai.p1r_state_for_status(h.status, h.acceptance_criteria, h.paused_at is not null))
       and not exists (select 1 from ai.p1o_handoff_escalations o where o.handoff_id = h.id and o.state = 'open' and o.id <> new.id);
  end if;
  return new;
end $$;

drop trigger if exists p1r_escalation_resolved_state on ai.p1o_handoff_escalations;
create trigger p1r_escalation_resolved_state
  after update of state on ai.p1o_handoff_escalations
  for each row execute function ai.p1r_escalation_resolved_state();

-- ── the door: a worker or a person advances a task through the finer steps ─
create or replace function ai.p1r_advance_handoff(p_handoff_id uuid, p_to_state text, p_note text default null)
returns table (outcome text, task_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
  v_needs_status text[];
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text, null::text; return; end if;
  if p_to_state not in ('validating', 'ready', 'dispatched', 'waiting_for_result', 'result_received', 'validating_result', 'handoff_ready', 'handed_off', 'verified', 'closed') then
    return query select 'not_a_door_state'::text, v_h.task_state; return;
  end if;
  -- VERIFIED and CLOSED are a person's decision: the service role is refused, a person must be signed in and be an administrator
  if p_to_state in ('verified', 'closed') then
    if (select auth.uid()) is null then return query select 'person_required'::text, v_h.task_state; return; end if;
    v_refusal := ai.p1o_door_refusal(v_h.organization_id, true);
  else
    v_refusal := ai.p1o_door_refusal(v_h.organization_id, false);
  end if;
  if v_refusal is not null then return query select v_refusal, v_h.task_state; return; end if;
  if v_h.paused_at is not null then return query select 'paused'::text, v_h.task_state; return; end if;

  if not (v_h.task_state = any (ai.p1r_main_line())) then return query select 'not_on_the_main_line'::text, v_h.task_state; return; end if;
  if not ai.p1r_step_allowed(v_h.task_state, p_to_state) then return query select 'not_the_next_step'::text, v_h.task_state; return; end if;

  v_needs_status := case
    when p_to_state in ('validating', 'ready', 'dispatched') then array['queued']
    when p_to_state in ('waiting_for_result', 'result_received', 'validating_result') then array['running', 'awaiting_approval']
    else array['completed']
  end;
  if not (v_h.status = any (v_needs_status)) then
    return query select 'status_disagrees'::text, v_h.task_state; return;
  end if;
  if p_to_state = 'ready' and jsonb_array_length(v_h.acceptance_criteria) = 0 then
    return query select 'no_acceptance_criteria'::text, v_h.task_state; return;
  end if;

  perform set_config('p1r.source', 'door', true);
  perform set_config('p1r.note', coalesce(left(btrim(p_note), 500), ''), true);
  update ai.handoffs set task_state = p_to_state where id = v_h.id;
  perform set_config('p1r.source', '', true);
  perform set_config('p1r.note', '', true);
  perform core.record_audit(v_h.organization_id, 'handoff.state_advanced', 'handoff', v_h.id, null,
    jsonb_build_object('from', v_h.task_state, 'to', p_to_state), v_h.correlation_id);
  return query select 'advanced'::text, p_to_state;
end $$;

-- the history of one task (internal readers of the organisation)
create or replace function ai.p1r_handoff_history(p_handoff_id uuid)
returns table (from_state text, to_state text, actor_kind text, actor_user_id uuid, source text, note text, at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  select t.from_state, t.to_state, t.actor_kind, t.actor_user_id, t.source, t.note, t.at
    from ai.p1r_handoff_transitions t
   where t.handoff_id = p_handoff_id and t.organization_id = (select core.current_organization_id())
   order by t.at, t.id;
end $$;

-- ── the policy version on every agent run (and on a handoff that was given none) ──
alter table ai.agent_runs add column if not exists policy_version text;
comment on column ai.agent_runs.policy_version is 'P1-ORCH-021. The governed policies in force when the run started, e.g. approval:2;data:1;routing:3 ("none" when the organisation has activated none). Stamped by ai.p1r_stamp_policy_version on insert; never changed afterwards. Runs before 2026-12-03 carry null.';

create or replace function ai.p1r_active_policy_stamp(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select string_agg(p.policy_kind || ':' || p.version, ';' order by p.policy_kind)
                     from core.p13_policy_versions p
                    where p.organization_id = p_organization_id and p.status = 'active' and p.policy_kind in ('routing', 'approval', 'data')), 'none')
$$;

create or replace function ai.p1r_stamp_policy_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.policy_version is null or btrim(new.policy_version) = '' then
      new.policy_version := ai.p1r_active_policy_stamp(new.organization_id);
    end if;
    return new;
  end if;
  if old.policy_version is not null and new.policy_version is distinct from old.policy_version then
    raise exception 'the policy version a run started under is part of its record and does not change' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists p1r_stamp_policy_version on ai.agent_runs;
create trigger p1r_stamp_policy_version
  before insert or update of policy_version on ai.agent_runs
  for each row execute function ai.p1r_stamp_policy_version();

create or replace function ai.p1r_stamp_handoff_policy_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.policy_version is null or btrim(new.policy_version) = '' then
    new.policy_version := ai.p1r_active_policy_stamp(new.organization_id);
  end if;
  return new;
end $$;
drop trigger if exists p1r_stamp_handoff_policy_version on ai.handoffs;
create trigger p1r_stamp_handoff_policy_version
  before insert on ai.handoffs
  for each row execute function ai.p1r_stamp_handoff_policy_version();

-- ── the unified result envelope: one object, whichever table the facts live in ──
create or replace function ai.p1r_run_result_envelope(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r ai.agent_runs;
  a ai.agents;
  h ai.handoffs;
  v_validation text;
  v_attempt int;
  v_warnings jsonb := '[]'::jsonb;
  v_next text;
  v_error text;
begin
  select x.* into r from ai.agent_runs x where x.id = p_run_id;
  if r.id is null then return null; end if;
  if (select auth.uid()) is not null then
    if r.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.is_internal()), false) then return null; end if;
  elsif (select auth.role()) is distinct from 'service_role' then
    return null;
  end if;

  select x.* into a from ai.agents x where x.key = r.agent_key;
  select x.* into h from ai.handoffs x
   where x.organization_id = r.organization_id and x.correlation_id = r.correlation_id and x.to_agent = r.agent_key and r.correlation_id is not null
   order by x.created_at desc limit 1;
  select count(*)::int into v_attempt from ai.agent_runs y
   where y.organization_id = r.organization_id and y.agent_key = r.agent_key and y.correlation_id is not distinct from r.correlation_id and y.created_at <= r.created_at;

  v_validation := case
    when h.id is not null and h.verification->>'outcome' = 'verified' then 'verified'
    when h.id is not null and h.status in ('failed_permanent', 'rejected') then 'failed'
    when r.status = 'succeeded' then 'not_validated'
    else 'pending'
  end;
  v_error := case r.status when 'budget_exceeded' then 'budget_exceeded' when 'failed' then coalesce(nullif(r.output->>'errorClass', ''), 'unclassified') end;

  if r.status = 'budget_exceeded' then v_warnings := v_warnings || jsonb_build_array('the run stopped at its cost or step ceiling'); end if;
  if a.key is not null and r.cost_minor > a.max_cost_minor then v_warnings := v_warnings || jsonb_build_array('the run cost more than the agent''s ceiling'); end if;
  if r.status = 'succeeded' and v_validation <> 'verified' then v_warnings := v_warnings || jsonb_build_array('the result has not been verified against its acceptance criteria'); end if;
  if r.policy_version is null then v_warnings := v_warnings || jsonb_build_array('this run predates policy version stamping'); end if;

  v_next := case r.status
    when 'queued' then 'wait'
    when 'running' then 'wait'
    when 'awaiting_approval' then 'approve'
    when 'succeeded' then case v_validation when 'verified' then 'proceed' else 'validate' end
    when 'failed' then case when h.status = 'failed_retryable' then 'retry' when h.status = 'failed_permanent' then 'escalate' else 'retry_or_escalate' end
    when 'budget_exceeded' then 'raise_budget_or_escalate'
    else 'none'
  end;

  return jsonb_build_object(
    'runId', r.id,
    'handoffId', h.id,
    'agent', r.agent_key,
    'status', r.status,
    'validationStatus', v_validation,
    'warnings', v_warnings,
    'errorClass', v_error,
    'attempt', v_attempt,
    'provider', r.provider_id,
    'model', r.model,
    'usage', jsonb_build_object('inputTokens', r.input_tokens, 'outputTokens', r.output_tokens, 'cacheReadTokens', r.cache_read_tokens, 'cacheWriteTokens', r.cache_write_tokens),
    'costMinor', r.cost_minor,
    'nextAction', v_next,
    'dodEvidence', coalesce(h.verification->'evidence', '[]'::jsonb),
    'policyVersion', r.policy_version,
    'taskState', h.task_state
  );
end $$;

-- ── timeout and permission-conflict escalations, raised by a sweep ─────────
-- A task past its SLA, or one whose receiving agent was switched off or is no longer a declared target of the sender, is escalated to a person with the cause
-- and a recommendation. The sweep never changes the work itself: the status stays, the task_state moves to ESCALATED, and a person decides. EXPIRED is reached
-- only when the caller passes a deadline; no deadline is built in (the owner decides the maximum wait, so the runner passes none).
create or replace function ai.p1r_sweep_handoff_escalations(p_organization_id uuid, p_expire_after interval default null)
returns table (timed_out int, permission_conflicts int, expired int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t int := 0;
  v_p int := 0;
  v_x int := 0;
  v_h record;
  v_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'ai.p1r_sweep_handoff_escalations is a runner door' using errcode = 'insufficient_privilege';
  end if;

  for v_h in
    select h.* from ai.handoffs h
     where h.organization_id = p_organization_id
       and h.status in ('queued', 'accepted', 'needs_input', 'awaiting_approval', 'running', 'failed_retryable')
       and h.sla_at is not null and h.sla_at < now() and h.paused_at is null
     order by h.sla_at
     limit 200
  loop
    v_id := null;
    insert into ai.p1o_handoff_escalations (organization_id, handoff_id, cause, recommendation)
    values (v_h.organization_id, v_h.id, 'timeout',
            'This task passed its deadline (' || to_char(v_h.sla_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC) while ' || v_h.status || '. Decide whether to wait, reassign, change the task or cancel it.')
    on conflict (handoff_id, cause) where state = 'open' do nothing
    returning id into v_id;
    if v_id is not null then
      update ai.handoffs set escalated_at = coalesce(escalated_at, now()), blocker = coalesce(blocker, 'escalated: timeout') where id = v_h.id;
      perform core.record_audit(v_h.organization_id, 'handoff.escalated', 'handoff', v_h.id, null, jsonb_build_object('cause', 'timeout', 'escalationId', v_id, 'by', 'sweep'), v_h.correlation_id);
      perform core.emit_event(v_h.organization_id, 'handoff.escalated', 'handoff', v_h.id, jsonb_build_object('handoffId', v_h.id, 'cause', 'timeout', 'to', v_h.to_agent), v_h.correlation_id);
      v_t := v_t + 1;
    end if;
    if p_expire_after is not null and v_h.sla_at + p_expire_after < now() then
      perform set_config('p1r.force_state', 'expired', true);
      perform set_config('p1r.source', 'sweep', true);
      perform set_config('p1r.note', 'passed its deadline by more than the allowed wait', true);
      update ai.handoffs set status = 'cancelled', blocker = 'expired: past its deadline by more than the allowed wait' where id = v_h.id and status <> 'cancelled';
      perform set_config('p1r.force_state', '', true);
      perform set_config('p1r.source', '', true);
      perform set_config('p1r.note', '', true);
      v_x := v_x + 1;
    end if;
  end loop;

  for v_h in
    select h.*, a.enabled as target_enabled,
           exists (select 1 from ai.agent_handoff_targets t where t.from_agent = h.from_agent and t.to_agent = h.to_agent) as edge_declared
      from ai.handoffs h
      join ai.agents a on a.key = h.to_agent
     where h.organization_id = p_organization_id
       and h.status in ('queued', 'accepted', 'needs_input', 'awaiting_approval', 'running')
       and h.paused_at is null
       and (not a.enabled or not exists (select 1 from ai.agent_handoff_targets t where t.from_agent = h.from_agent and t.to_agent = h.to_agent))
     order by h.created_at
     limit 200
  loop
    v_id := null;
    insert into ai.p1o_handoff_escalations (organization_id, handoff_id, cause, attempted_routes, recommendation)
    values (v_h.organization_id, v_h.id, 'permission_conflict',
            jsonb_build_array(jsonb_build_object('agent', v_h.to_agent, 'enabled', v_h.target_enabled, 'declaredTarget', v_h.edge_declared)),
            case when not v_h.target_enabled
                 then 'The receiving agent ' || v_h.to_agent || ' is switched off, so this task cannot be dispatched. Switch it on, reassign the task or cancel it.'
                 else v_h.to_agent || ' is no longer a declared target of ' || v_h.from_agent || '. Restore the edge, reassign the task or cancel it.' end)
    on conflict (handoff_id, cause) where state = 'open' do nothing
    returning id into v_id;
    if v_id is not null then
      update ai.handoffs set escalated_at = coalesce(escalated_at, now()), blocker = coalesce(blocker, 'escalated: permission_conflict') where id = v_h.id;
      perform core.record_audit(v_h.organization_id, 'handoff.escalated', 'handoff', v_h.id, null, jsonb_build_object('cause', 'permission_conflict', 'escalationId', v_id, 'by', 'sweep'), v_h.correlation_id);
      perform core.emit_event(v_h.organization_id, 'handoff.escalated', 'handoff', v_h.id, jsonb_build_object('handoffId', v_h.id, 'cause', 'permission_conflict', 'to', v_h.to_agent), v_h.correlation_id);
      v_p := v_p + 1;
    end if;
  end loop;
  return query select v_t, v_p, v_x;
end $$;

-- ── grants: a door is callable by the roles that may use it, nothing else ──
revoke all on function ai.p1r_advance_handoff(uuid, text, text) from public, anon;
grant execute on function ai.p1r_advance_handoff(uuid, text, text) to authenticated, service_role;
revoke all on function ai.p1r_handoff_history(uuid) from public, anon;
grant execute on function ai.p1r_handoff_history(uuid) to authenticated, service_role;
revoke all on function ai.p1r_run_result_envelope(uuid) from public, anon;
grant execute on function ai.p1r_run_result_envelope(uuid) to authenticated, service_role;
revoke all on function ai.p1r_sweep_handoff_escalations(uuid, interval) from public, anon, authenticated;
grant execute on function ai.p1r_sweep_handoff_escalations(uuid, interval) to service_role;
revoke all on function ai.p1r_active_policy_stamp(uuid) from public, anon, authenticated;
grant execute on function ai.p1r_active_policy_stamp(uuid) to service_role;
