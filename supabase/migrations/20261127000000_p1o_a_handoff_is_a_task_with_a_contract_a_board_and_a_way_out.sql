-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 Orchestrator and Coordination gap closure, part 1 (traceability: docs/phase-1-orchestrator-quotation-gaps-log.md).
-- Rows: P1-COORD-003/004/017/018/021/023/025/026/027, P1-ORCH-005/006/004/009/010/016/018/019/021/023, P1-HANDOFF-005/006/008/012/034/040/046,
--       P1-BLUEPRINT-022.
--
-- ai.handoffs already plays the Coordination Agent's CoordinationTask and HandoffRecord. What it lacked was the rest of the task contract (acceptance criteria,
-- priority, retry count, the failure the last attempt left behind, an idempotency key, policy and approval references, prerequisites), any way to hold or move a
-- task a person has decided about (pause, resume, reassign), a way out when a task cannot finish (an escalation that names the routes tried, the failures and a
-- recommendation), and a board that reads all of it. This adds exactly those, and nothing here lets an agent decide something a person owns:
--
--   * the new columns are written through ai.p1o_create_handoff (idempotent on the key), and the doors below. The existing status machine (ai.handoffs_guard) is
--     untouched; two NEW triggers sit beside it:
--       - p1o_handoff_dependency_guard   prerequisites exist, belong to this organisation, are not itself, and do not form a cycle.
--       - p1o_handoff_dispatch_guard     nothing is accepted or run while it is paused, while a prerequisite has not completed, while a prerequisite failed for
--                                        good, while the quotation it is bound to has been superseded or withdrawn, or (on a retry) while the effect of the last
--                                        attempt is uncertain and has not been reconciled by a person.
--   * a retry is never a blind retry of an uncertain side effect (ORCH s17): ai.p1o_record_handoff_failure can mark the effect uncertain, and the retry door
--     refuses until a person reconciles it.
--   * exhausted retries do not loop: the third failure is permanent and raises an escalation (Coordination s20 "Repeated failure").
--   * a capability registry (ai.p1o_capabilities) is the routing map the documents describe: a task type resolves to an agent, a service or a person, with a
--     version and its input and output schemas; an unknown or unavailable task type has no safe route and is escalated rather than guessed at.
-- Nothing is sent to anyone from here. Stage ids and agent keys only; no client words are copied into an event.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('handoff.created', 'A handoff (a Coordination task) was created with its contract: who hands what to whom, the acceptance criteria and the priority. Ids and agent keys only.', true),
  ('handoff.blocked', 'A handoff was blocked: a prerequisite failed or went stale, a person paused it, or its results conflict. The blocker is on the row.', true),
  ('handoff.escalated', 'A handoff could not finish by itself and was escalated to a person, with the routes tried, the failures and a recommendation.', true)
on conflict (type) do nothing;

-- ── the rest of the task contract ──────────────────────────────────────────
alter table ai.handoffs
  add column if not exists acceptance_criteria     jsonb not null default '[]'::jsonb,
  add column if not exists required_output_schema  jsonb,
  add column if not exists priority                text not null default 'normal',
  add column if not exists retry_count             int not null default 0,
  add column if not exists previous_failure_summary text,
  add column if not exists idempotency_key         text,
  add column if not exists policy_decision_ref     text,
  add column if not exists policy_version          text,
  add column if not exists approval_request_id     uuid references approvals.approval_requests(id) on delete set null,
  add column if not exists dependency_ids          uuid[] not null default '{}'::uuid[],
  add column if not exists bound_proposal_id       uuid references sales.proposals(id) on delete set null,
  add column if not exists blocker                 text,
  add column if not exists side_effect_uncertain   boolean not null default false,
  add column if not exists paused_at               timestamptz,
  add column if not exists paused_by               uuid references core.users(id) on delete set null,
  add column if not exists pause_reason            text,
  add column if not exists escalated_at            timestamptz;

alter table ai.handoffs drop constraint if exists p1o_handoffs_contract_shape;
alter table ai.handoffs add constraint p1o_handoffs_contract_shape check (
  jsonb_typeof(acceptance_criteria) = 'array'
  and (required_output_schema is null or jsonb_typeof(required_output_schema) = 'object')
  and priority in ('low', 'normal', 'high', 'urgent')
  and retry_count between 0 and 10
  and (idempotency_key is null or length(btrim(idempotency_key)) between 1 and 200)
  and cardinality(dependency_ids) <= 20
  and not (id = any (dependency_ids))
  and (paused_at is null) = (pause_reason is null)
);

create unique index if not exists p1o_handoffs_idempotency_key
  on ai.handoffs (organization_id, idempotency_key) where idempotency_key is not null;
create index if not exists p1o_handoffs_board_idx
  on ai.handoffs (organization_id, priority, created_at) where status not in ('completed', 'rejected', 'failed_permanent', 'cancelled');
create index if not exists p1o_handoffs_bound_proposal_idx
  on ai.handoffs (bound_proposal_id) where bound_proposal_id is not null;

drop trigger if exists p1o_org_match_handoffs_approval_request_id on ai.handoffs;
create trigger p1o_org_match_handoffs_approval_request_id
  before insert or update of approval_request_id, organization_id on ai.handoffs
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
drop trigger if exists p1o_org_match_handoffs_bound_proposal_id on ai.handoffs;
create trigger p1o_org_match_handoffs_bound_proposal_id
  before insert or update of bound_proposal_id, organization_id on ai.handoffs
  for each row execute function core.enforce_parent_org('bound_proposal_id', 'sales.proposals');

comment on column ai.handoffs.acceptance_criteria is 'P1-COORD-003 / P1-HANDOFF-005. What must be true for this task to count as done. The completion verdict (verification.evidence) answers it.';
comment on column ai.handoffs.dependency_ids is 'P1-COORD-018. Prerequisite handoff ids. Nothing is accepted or run before they have completed; a cycle is refused.';
comment on column ai.handoffs.side_effect_uncertain is 'P1-ORCH-016. The last attempt may have had a real-world effect. Not retried until a person reconciles it (ai.p1o_reconcile_handoff).';

-- ── prerequisites: they exist, they are this organisation''s, and they do not loop ──
create or replace function ai.p1o_handoff_dependency_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bad int;
  v_cycle boolean;
begin
  if cardinality(new.dependency_ids) = 0 then
    return new;
  end if;
  if new.id = any (new.dependency_ids) then
    raise exception 'a handoff cannot wait for itself' using errcode = 'check_violation';
  end if;
  select count(*) into v_bad
    from unnest(new.dependency_ids) d(id)
   where not exists (select 1 from ai.handoffs h where h.id = d.id and h.organization_id = new.organization_id);
  if v_bad > 0 then
    raise exception 'a prerequisite handoff does not exist in this organisation (% unknown)', v_bad using errcode = 'check_violation';
  end if;
  -- a cycle: following prerequisites from the new ones reaches this handoff again
  with recursive walk(id, depth) as (
    select d.id, 1 from unnest(new.dependency_ids) d(id)
    union
    select x.id, w.depth + 1
      from walk w
      join ai.handoffs h on h.id = w.id
      cross join lateral unnest(h.dependency_ids) x(id)
     where w.depth < 25
  )
  select exists (select 1 from walk where id = new.id) into v_cycle;
  if v_cycle then
    raise exception 'these prerequisites form a cycle: the handoff would wait for itself (deadlock)' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists p1o_handoff_dependency_guard on ai.handoffs;
create trigger p1o_handoff_dependency_guard
  before insert or update of dependency_ids on ai.handoffs
  for each row execute function ai.p1o_handoff_dependency_guard();

-- ── dispatch: what must be true before a task is accepted or run ───────────
create or replace function ai.p1o_handoff_dispatch_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open int;
  v_dead int;
  v_prop text;
begin
  if new.status is not distinct from old.status or new.status not in ('accepted', 'running') then
    return new;
  end if;

  if new.paused_at is not null then
    raise exception 'handoff is paused (%): resume it before it is accepted or run', new.pause_reason using errcode = 'check_violation';
  end if;

  if cardinality(new.dependency_ids) > 0 then
    select count(*) filter (where h.status <> 'completed'),
           count(*) filter (where h.status in ('failed_permanent', 'rejected', 'cancelled'))
      into v_open, v_dead
      from ai.handoffs h
     where h.id = any (new.dependency_ids);
    if v_dead > 0 then
      raise exception 'a prerequisite handoff failed or was withdrawn: this one cannot start' using errcode = 'check_violation';
    end if;
    if v_open > 0 then
      raise exception '% prerequisite handoff(s) have not completed: nothing is dispatched before its prerequisites pass', v_open using errcode = 'check_violation';
    end if;
  end if;

  if new.bound_proposal_id is not null then
    select p.status into v_prop from sales.proposals p where p.id = new.bound_proposal_id;
    if v_prop in ('superseded', 'rejected', 'lapsed', 'cancelled') then
      raise exception 'the quotation this handoff is bound to is % and the work is stale: never mix versions in one active handoff', v_prop using errcode = 'check_violation';
    end if;
  end if;

  if new.status = 'running' and old.status = 'failed_retryable' and new.side_effect_uncertain then
    raise exception 'the last attempt may have had a real effect: reconcile it before retrying (a retry is never blind)' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists p1o_handoff_dispatch_guard on ai.handoffs;
create trigger p1o_handoff_dispatch_guard
  before update of status on ai.handoffs
  for each row execute function ai.p1o_handoff_dispatch_guard();

-- ── handoff.created ────────────────────────────────────────────────────────
create or replace function ai.p1o_emit_handoff_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform core.emit_event(
    new.organization_id, 'handoff.created', 'handoff', new.id,
    jsonb_build_object('handoffId', new.id, 'from', new.from_agent, 'to', new.to_agent, 'priority', new.priority,
                       'subjectType', new.subject_type, 'subjectId', new.subject_id, 'idempotencyKey', new.idempotency_key),
    new.correlation_id
  );
  return new;
end $$;

drop trigger if exists p1o_handoffs_emit_created on ai.handoffs;
create trigger p1o_handoffs_emit_created
  after insert on ai.handoffs
  for each row execute function ai.p1o_emit_handoff_created();

-- ── the capability registry: the routing map the documents describe ────────
create table if not exists ai.p1o_capabilities (
  task_type       text primary key check (task_type ~ '^[a-z][a-z_]*\.[a-z_]+$'),
  handler_kind    text not null check (handler_kind in ('agent', 'service', 'human')),
  handler_key     text not null check (length(btrim(handler_key)) > 0),
  agent_key       text references ai.agents(key) on delete restrict,
  agent_version   text not null default '1',
  description     text not null,
  input_schema    jsonb not null default '{}'::jsonb check (jsonb_typeof(input_schema) = 'object'),
  output_schema   jsonb not null default '{}'::jsonb check (jsonb_typeof(output_schema) = 'object'),
  tools           text[] not null default '{}',
  data_classes    text[] not null default '{}',
  available       boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint p1o_capabilities_agent_has_key check (handler_kind <> 'agent' or agent_key is not null)
);
alter table ai.p1o_capabilities enable row level security;
drop policy if exists p1o_capabilities_select on ai.p1o_capabilities;
create policy p1o_capabilities_select on ai.p1o_capabilities for select to authenticated using ((select core.is_internal()));
drop trigger if exists p1o_capabilities_no_truncate on ai.p1o_capabilities;
create trigger p1o_capabilities_no_truncate before truncate on ai.p1o_capabilities for each statement execute function crm.reject_truncate();
drop trigger if exists p1o_capabilities_reject_delete on ai.p1o_capabilities;
create trigger p1o_capabilities_reject_delete before delete on ai.p1o_capabilities for each row execute function core.reject_end_user_delete();

-- The Phase 1 routing map (Orchestrator s7). Scheduler, Quotation Master and Coordination are services in this codebase, not registry agents; the map says so
-- instead of pretending otherwise.
insert into ai.p1o_capabilities (task_type, handler_kind, handler_key, agent_key, description, input_schema, output_schema, tools, data_classes) values
  ('sales.conversation', 'agent', 'sales', 'sales', 'A lead message is read and answered by the Sales agent.',
     '{"required":["conversationId","messageId"]}', '{"kind":"draft_reply"}', '{}', '{client_conversation}'),
  ('scheduling.request', 'service', 'crm.subtask_requests', null, 'A request to speak becomes one idempotent Scheduler task (crm.subtask_requests, assignee scheduler); a person books through crm.book_meeting.',
     '{"required":["leadId"]}', '{"kind":"meeting"}', '{}', '{client_contact}'),
  ('quotation.draft', 'service', 'sales.proposals', null, 'A quotation is drafted, approved by the owner and sent through sales.proposals; the Quotation Master is a service, not an agent.',
     '{"required":["opportunityId","requirementVersionId"]}', '{"kind":"proposal"}', '{}', '{commercial}'),
  ('workflow.tracking', 'service', 'ai.handoffs', null, 'Handoffs, retries, prerequisites and escalations are tracked on ai.handoffs (Coordination).',
     '{"required":["handoffId"]}', '{"kind":"task_state"}', '{}', '{}'),
  ('model.selection', 'agent', 'orchestrator', 'orchestrator', 'The model and provider for a call are chosen by the Orchestrator (ai.routing_decisions).',
     '{"required":["capability"]}', '{"kind":"routing_decision"}', '{}', '{}'),
  ('approval.decision', 'human', 'admin', null, 'An approval is decided by a person with the required role; no agent holds this route.',
     '{"required":["approvalRequestId"]}', '{"kind":"decision"}', '{}', '{commercial}')
on conflict (task_type) do nothing;

create or replace function ai.p1o_route_task(p_task_type text)
returns table (routed boolean, handler_kind text, handler_key text, agent_version text, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select true, c.handler_kind, c.handler_key, c.agent_version, null::text
    from ai.p1o_capabilities c
    left join ai.agents a on a.key = c.agent_key
   where c.task_type = p_task_type
     and c.available
     and (c.handler_kind <> 'agent' or coalesce(a.enabled, false))
  union all
  select false, null::text, null::text, null::text,
         case when exists (select 1 from ai.p1o_capabilities c where c.task_type = p_task_type)
              then 'the capable handler is unavailable or disabled'
              else 'no registered capability for this task type' end
   where not exists (
     select 1 from ai.p1o_capabilities c
       left join ai.agents a on a.key = c.agent_key
      where c.task_type = p_task_type and c.available and (c.handler_kind <> 'agent' or coalesce(a.enabled, false)));
$$;

-- ── escalations ────────────────────────────────────────────────────────────
create table if not exists ai.p1o_handoff_escalations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  handoff_id      uuid not null references ai.handoffs(id) on delete restrict,
  cause           text not null check (cause in ('no_eligible_agent', 'permission_conflict', 'repeated_failure', 'timeout', 'conflicting_result', 'stale_version', 'manual')),
  attempted_routes jsonb not null default '[]'::jsonb check (jsonb_typeof(attempted_routes) = 'array'),
  failures        jsonb not null default '[]'::jsonb check (jsonb_typeof(failures) = 'array'),
  recommendation  text not null check (length(btrim(recommendation)) between 1 and 2000),
  state           text not null default 'open' check (state in ('open', 'resolved')),
  raised_by       uuid references core.users(id) on delete set null,
  raised_at       timestamptz not null default now(),
  resolved_by     uuid references core.users(id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text check (resolution_note is null or length(resolution_note) <= 2000),
  constraint p1o_escalations_resolved_shape check (state = 'open' or (resolved_at is not null and resolution_note is not null))
);
create unique index if not exists p1o_escalations_one_open_per_cause on ai.p1o_handoff_escalations (handoff_id, cause) where state = 'open';
create index if not exists p1o_escalations_queue_idx on ai.p1o_handoff_escalations (organization_id, state, raised_at desc);

alter table ai.p1o_handoff_escalations enable row level security;
drop policy if exists p1o_escalations_select on ai.p1o_handoff_escalations;
create policy p1o_escalations_select on ai.p1o_handoff_escalations for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
drop trigger if exists p1o_org_match_escalations_handoff on ai.p1o_handoff_escalations;
create trigger p1o_org_match_escalations_handoff
  before insert or update of handoff_id, organization_id on ai.p1o_handoff_escalations
  for each row execute function core.enforce_parent_org('handoff_id', 'ai.handoffs');
drop trigger if exists p1o_freeze_org_escalations on ai.p1o_handoff_escalations;
create trigger p1o_freeze_org_escalations before update of organization_id on ai.p1o_handoff_escalations for each row execute function core.freeze_organization_id();
drop trigger if exists p1o_escalations_reject_delete on ai.p1o_handoff_escalations;
create trigger p1o_escalations_reject_delete before delete on ai.p1o_handoff_escalations for each row execute function core.reject_end_user_delete();
drop trigger if exists p1o_escalations_no_truncate on ai.p1o_handoff_escalations;
create trigger p1o_escalations_no_truncate before truncate on ai.p1o_handoff_escalations for each statement execute function crm.reject_truncate();

-- ── who may call a door ────────────────────────────────────────────────────
-- service_role (the runner), or a signed-in member of the handoff's organisation; people-only decisions (pause, resume, reassign, retry, reconcile, resolve) need
-- an administrator. Returns null when allowed, otherwise the refusal word.
create or replace function ai.p1o_door_refusal(p_organization_id uuid, p_admin_only boolean)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    if (select auth.role()) is distinct from 'service_role' then return 'no_actor'; end if;
    return null;
  end if;
  if p_organization_id is distinct from (select core.current_organization_id()) then return 'forbidden'; end if;
  if p_admin_only then
    if not coalesce((select core.is_admin()), false) then return 'forbidden'; end if;
  elsif not coalesce((select core.can_write()), false) then
    return 'forbidden';
  end if;
  return null;
end $$;

-- ── creation: idempotent, validated, with its contract ─────────────────────
create or replace function ai.p1o_create_handoff(
  p_organization_id uuid, p_from_agent text, p_to_agent text, p_objective text, p_correlation_id uuid,
  p_idempotency_key text, p_acceptance_criteria jsonb, p_priority text default 'normal',
  p_subject_type text default null, p_subject_id uuid default null, p_project_id uuid default null,
  p_dependency_ids uuid[] default '{}', p_bound_proposal_id uuid default null,
  p_policy_decision_ref text default null, p_policy_version text default null, p_approval_request_id uuid default null,
  p_required_output_schema jsonb default null, p_context jsonb default '{}'::jsonb, p_sla_at timestamptz default null
)
returns table (outcome text, handoff_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refusal text := ai.p1o_door_refusal(p_organization_id, false);
  v_existing uuid;
  v_new uuid;
begin
  if v_refusal is not null then return query select v_refusal, null::uuid; return; end if;
  -- the intake refuses a malformed envelope before anything runs (Orchestrator s4)
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then return query select 'missing_idempotency_key'::text, null::uuid; return; end if;
  if p_correlation_id is null then return query select 'missing_correlation'::text, null::uuid; return; end if;
  if p_objective is null or length(btrim(p_objective)) = 0 then return query select 'missing_objective'::text, null::uuid; return; end if;
  if p_acceptance_criteria is null or jsonb_typeof(p_acceptance_criteria) <> 'array' or jsonb_array_length(p_acceptance_criteria) = 0 then
    return query select 'missing_acceptance_criteria'::text, null::uuid; return;
  end if;
  if p_priority not in ('low', 'normal', 'high', 'urgent') then return query select 'bad_priority'::text, null::uuid; return; end if;

  select h.id into v_existing from ai.handoffs h where h.organization_id = p_organization_id and h.idempotency_key = p_idempotency_key;
  if v_existing is not null then return query select 'duplicate'::text, v_existing; return; end if;

  begin
    insert into ai.handoffs (organization_id, correlation_id, from_agent, to_agent, objective, idempotency_key, acceptance_criteria, priority,
                             subject_type, subject_id, project_id, dependency_ids, bound_proposal_id, policy_decision_ref, policy_version,
                             approval_request_id, required_output_schema, context, sla_at)
    values (p_organization_id, p_correlation_id, p_from_agent, p_to_agent, btrim(p_objective), btrim(p_idempotency_key), p_acceptance_criteria, p_priority,
            p_subject_type, p_subject_id, p_project_id, coalesce(p_dependency_ids, '{}'::uuid[]), p_bound_proposal_id, p_policy_decision_ref, p_policy_version,
            p_approval_request_id, p_required_output_schema, coalesce(p_context, '{}'::jsonb), p_sla_at)
    returning id into v_new;
  exception
    when unique_violation then
      select h.id into v_existing from ai.handoffs h where h.organization_id = p_organization_id and h.idempotency_key = p_idempotency_key;
      return query select 'duplicate'::text, v_existing; return;
    when check_violation or foreign_key_violation then
      return query select 'refused'::text, null::uuid; return;
  end;

  perform core.record_audit(p_organization_id, 'handoff.created', 'handoff', v_new, null,
    jsonb_build_object('from', p_from_agent, 'to', p_to_agent, 'priority', p_priority, 'idempotencyKey', p_idempotency_key, 'dependencies', coalesce(cardinality(p_dependency_ids), 0)),
    p_correlation_id);
  return query select 'created'::text, v_new;
end $$;

-- ── failure: counted, summarised, and never an endless loop ────────────────
create or replace function ai.p1o_record_handoff_failure(p_handoff_id uuid, p_summary text, p_retryable boolean default true, p_side_effect_uncertain boolean default false)
returns table (outcome text, new_status text, retry_count int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
  v_summary text := left(nullif(btrim(coalesce(p_summary, '')), ''), 1000);
  c_max_retries constant int := 3;
  v_status text;
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text, null::text, null::int; return; end if;
  v_refusal := ai.p1o_door_refusal(v_h.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::text, null::int; return; end if;
  if v_summary is null then return query select 'missing_summary'::text, null::text, null::int; return; end if;
  if v_h.status <> 'running' then return query select 'not_running'::text, v_h.status, v_h.retry_count; return; end if;

  v_status := case when p_retryable and v_h.retry_count + 1 < c_max_retries then 'failed_retryable' else 'failed_permanent' end;
  update ai.handoffs
     set status = v_status,
         retry_count = least(v_h.retry_count + 1, 10),
         previous_failure_summary = v_summary,
         side_effect_uncertain = coalesce(p_side_effect_uncertain, false),
         blocker = case when v_status = 'failed_permanent' then 'failed after ' || (v_h.retry_count + 1) || ' attempt(s): ' || v_summary else v_h.blocker end
   where id = v_h.id;

  perform core.record_audit(v_h.organization_id, 'handoff.failed', 'handoff', v_h.id, null,
    jsonb_build_object('status', v_status, 'retryCount', v_h.retry_count + 1, 'uncertainSideEffect', coalesce(p_side_effect_uncertain, false)), v_h.correlation_id);

  if v_status = 'failed_permanent' then
    insert into ai.p1o_handoff_escalations (organization_id, handoff_id, cause, failures, recommendation)
    values (v_h.organization_id, v_h.id, 'repeated_failure',
            jsonb_build_array(jsonb_build_object('attempt', v_h.retry_count + 1, 'summary', v_summary)),
            'Retries are exhausted or the failure is permanent: a person should decide whether to reassign, change the task or close it.')
    on conflict do nothing;
    update ai.handoffs set escalated_at = now() where id = v_h.id and escalated_at is null;
    perform core.emit_event(v_h.organization_id, 'handoff.escalated', 'handoff', v_h.id,
      jsonb_build_object('handoffId', v_h.id, 'cause', 'repeated_failure', 'to', v_h.to_agent), v_h.correlation_id);
  end if;
  return query select 'recorded'::text, v_status, v_h.retry_count + 1;
end $$;

-- ── a person retries; the previous failure travels with the retry ──────────
create or replace function ai.p1o_retry_handoff(p_handoff_id uuid, p_reason text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_h.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'missing_reason'::text; return; end if;
  if v_h.status <> 'failed_retryable' then return query select 'not_retryable'::text; return; end if;
  if v_h.side_effect_uncertain then return query select 'reconcile_first'::text; return; end if;
  if v_h.paused_at is not null then return query select 'paused'::text; return; end if;
  begin
    update ai.handoffs set status = 'running', blocker = null where id = v_h.id;
  exception when check_violation then
    return query select 'blocked'::text; return;
  end;
  perform core.record_audit(v_h.organization_id, 'handoff.retried', 'handoff', v_h.id, null,
    jsonb_build_object('reason', left(btrim(p_reason), 500), 'retryCount', v_h.retry_count, 'previousFailure', v_h.previous_failure_summary), v_h.correlation_id);
  return query select 'retrying'::text;
end $$;

create or replace function ai.p1o_reconcile_handoff(p_handoff_id uuid, p_effect text, p_note text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_h.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_effect not in ('happened', 'did_not_happen') then return query select 'bad_effect'::text; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'missing_note'::text; return; end if;
  if not v_h.side_effect_uncertain then return query select 'nothing_to_reconcile'::text; return; end if;
  update ai.handoffs
     set side_effect_uncertain = false,
         decisions = decisions || jsonb_build_array(jsonb_build_object('kind', 'reconciled', 'effect', p_effect, 'note', left(btrim(p_note), 500), 'at', now()))
   where id = v_h.id;
  perform core.record_audit(v_h.organization_id, 'handoff.reconciled', 'handoff', v_h.id, null,
    jsonb_build_object('effect', p_effect, 'note', left(btrim(p_note), 500)), v_h.correlation_id);
  return query select 'reconciled'::text;
end $$;

-- ── pause / resume / reassign: a person decides, and the row says who and why
create or replace function ai.p1o_pause_handoff(p_handoff_id uuid, p_reason text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_h.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'missing_reason'::text; return; end if;
  if v_h.status in ('completed', 'rejected', 'failed_permanent', 'cancelled') then return query select 'settled'::text; return; end if;
  if v_h.paused_at is not null then return query select 'already_paused'::text; return; end if;
  update ai.handoffs set paused_at = now(), paused_by = (select auth.uid()), pause_reason = left(btrim(p_reason), 500),
                         blocker = 'paused: ' || left(btrim(p_reason), 500)
   where id = v_h.id;
  perform core.record_audit(v_h.organization_id, 'handoff.paused', 'handoff', v_h.id, null, jsonb_build_object('reason', left(btrim(p_reason), 500)), v_h.correlation_id);
  perform core.emit_event(v_h.organization_id, 'handoff.blocked', 'handoff', v_h.id, jsonb_build_object('handoffId', v_h.id, 'why', 'paused'), v_h.correlation_id);
  return query select 'paused'::text;
end $$;

create or replace function ai.p1o_resume_handoff(p_handoff_id uuid)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_h.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if v_h.paused_at is null then return query select 'not_paused'::text; return; end if;
  update ai.handoffs set paused_at = null, paused_by = null, pause_reason = null,
                         blocker = case when blocker like 'paused:%' then null else blocker end
   where id = v_h.id;
  perform core.record_audit(v_h.organization_id, 'handoff.resumed', 'handoff', v_h.id, null, '{}'::jsonb, v_h.correlation_id);
  return query select 'resumed'::text;
end $$;

create or replace function ai.p1o_reassign_handoff(p_handoff_id uuid, p_to_agent text, p_reason text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_h.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'missing_reason'::text; return; end if;
  -- only before anyone has started: work in flight is cancelled and re-created, not relabelled
  if v_h.status <> 'queued' then return query select 'not_queued'::text; return; end if;
  if p_to_agent = v_h.to_agent then return query select 'same_agent'::text; return; end if;
  begin
    update ai.handoffs
       set to_agent = p_to_agent,
           decisions = decisions || jsonb_build_array(jsonb_build_object('kind', 'reassigned', 'from', v_h.to_agent, 'to', p_to_agent, 'reason', left(btrim(p_reason), 500), 'at', now()))
     where id = v_h.id;
  exception when check_violation or foreign_key_violation then
    return query select 'not_a_declared_target'::text; return;
  end;
  perform core.record_audit(v_h.organization_id, 'handoff.reassigned', 'handoff', v_h.id, null,
    jsonb_build_object('from', v_h.to_agent, 'to', p_to_agent, 'reason', left(btrim(p_reason), 500)), v_h.correlation_id);
  return query select 'reassigned'::text;
end $$;

-- ── escalation: the task, the routes tried, the failures, a recommendation ─
create or replace function ai.p1o_escalate_handoff(p_handoff_id uuid, p_cause text, p_recommendation text, p_attempted_routes jsonb default '[]'::jsonb)
returns table (outcome text, escalation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_h ai.handoffs;
  v_refusal text;
  v_id uuid;
begin
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then return query select 'unknown_handoff'::text, null::uuid; return; end if;
  v_refusal := ai.p1o_door_refusal(v_h.organization_id, false);
  if v_refusal is not null then return query select v_refusal, null::uuid; return; end if;
  if p_cause not in ('no_eligible_agent', 'permission_conflict', 'repeated_failure', 'timeout', 'conflicting_result', 'stale_version', 'manual') then
    return query select 'bad_cause'::text, null::uuid; return;
  end if;
  if p_recommendation is null or length(btrim(p_recommendation)) = 0 then return query select 'missing_recommendation'::text, null::uuid; return; end if;
  if p_attempted_routes is null or jsonb_typeof(p_attempted_routes) <> 'array' then return query select 'bad_routes'::text, null::uuid; return; end if;

  insert into ai.p1o_handoff_escalations (organization_id, handoff_id, cause, attempted_routes, failures, recommendation, raised_by)
  values (v_h.organization_id, v_h.id, p_cause, p_attempted_routes,
          case when v_h.previous_failure_summary is null then '[]'::jsonb
               else jsonb_build_array(jsonb_build_object('attempt', v_h.retry_count, 'summary', v_h.previous_failure_summary)) end,
          left(btrim(p_recommendation), 2000), (select auth.uid()))
  on conflict (handoff_id, cause) where state = 'open' do nothing
  returning id into v_id;
  if v_id is null then
    select e.id into v_id from ai.p1o_handoff_escalations e where e.handoff_id = v_h.id and e.cause = p_cause and e.state = 'open';
    return query select 'already_open'::text, v_id; return;
  end if;
  update ai.handoffs set escalated_at = coalesce(escalated_at, now()), blocker = coalesce(blocker, 'escalated: ' || p_cause) where id = v_h.id;
  perform core.record_audit(v_h.organization_id, 'handoff.escalated', 'handoff', v_h.id, null, jsonb_build_object('cause', p_cause, 'escalationId', v_id), v_h.correlation_id);
  perform core.emit_event(v_h.organization_id, 'handoff.escalated', 'handoff', v_h.id,
    jsonb_build_object('handoffId', v_h.id, 'cause', p_cause, 'to', v_h.to_agent), v_h.correlation_id);
  return query select 'escalated'::text, v_id;
end $$;

create or replace function ai.p1o_resolve_handoff_escalation(p_escalation_id uuid, p_note text)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e ai.p1o_handoff_escalations;
  v_refusal text;
begin
  select e.* into v_e from ai.p1o_handoff_escalations e where e.id = p_escalation_id for update;
  if v_e.id is null then return query select 'unknown_escalation'::text; return; end if;
  v_refusal := ai.p1o_door_refusal(v_e.organization_id, true);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 then return query select 'missing_note'::text; return; end if;
  if v_e.state = 'resolved' then return query select 'already_resolved'::text; return; end if;
  update ai.p1o_handoff_escalations set state = 'resolved', resolved_by = (select auth.uid()), resolved_at = now(), resolution_note = left(btrim(p_note), 2000) where id = v_e.id;
  update ai.handoffs h set blocker = null
   where h.id = v_e.handoff_id and h.status not in ('failed_permanent')
     and not exists (select 1 from ai.p1o_handoff_escalations o where o.handoff_id = h.id and o.state = 'open');
  perform core.record_audit(v_e.organization_id, 'handoff.escalation_resolved', 'handoff', v_e.handoff_id, null, jsonb_build_object('escalationId', v_e.id), null);
  return query select 'resolved'::text;
end $$;

-- two results for one question: block both and ask the authoritative owner (Coordination s20 "Conflicting results")
create or replace function ai.p1o_record_conflicting_results(p_handoff_ids uuid[], p_summary text)
returns table (outcome text, escalations int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_refusal text;
  v_id uuid;
  v_n int := 0;
  v_summary text := left(nullif(btrim(coalesce(p_summary, '')), ''), 500);
begin
  if p_handoff_ids is null or cardinality(p_handoff_ids) < 2 then return query select 'needs_two_or_more'::text, 0; return; end if;
  if v_summary is null then return query select 'missing_summary'::text, 0; return; end if;
  select h.organization_id into v_org from ai.handoffs h where h.id = any (p_handoff_ids) limit 1;
  if (select count(distinct h.organization_id) from ai.handoffs h where h.id = any (p_handoff_ids)) <> 1
     or (select count(*) from ai.handoffs h where h.id = any (p_handoff_ids)) <> cardinality(p_handoff_ids) then
    return query select 'unknown_or_mixed'::text, 0; return;
  end if;
  v_refusal := ai.p1o_door_refusal(v_org, false);
  if v_refusal is not null then return query select v_refusal, 0; return; end if;
  for v_id in select h.id from ai.handoffs h where h.id = any (p_handoff_ids) order by h.id loop
    update ai.handoffs set blocker = 'conflicting results: ' || v_summary where id = v_id and status not in ('completed', 'rejected', 'failed_permanent', 'cancelled');
    insert into ai.p1o_handoff_escalations (organization_id, handoff_id, cause, recommendation, raised_by)
    values (v_org, v_id, 'conflicting_result', 'Two results disagree: ' || v_summary || '. Decide which is authoritative; neither proceeds meanwhile.', (select auth.uid()))
    on conflict (handoff_id, cause) where state = 'open' do nothing;
    update ai.handoffs set escalated_at = coalesce(escalated_at, now()) where id = v_id;
    v_n := v_n + 1;
  end loop;
  perform core.record_audit(v_org, 'handoff.conflicting_results', 'handoff', p_handoff_ids[1], null, jsonb_build_object('handoffIds', to_jsonb(p_handoff_ids), 'summary', v_summary), null);
  perform core.emit_event(v_org, 'handoff.blocked', 'handoff', p_handoff_ids[1], jsonb_build_object('handoffIds', to_jsonb(p_handoff_ids), 'why', 'conflicting_results'), null);
  return query select 'blocked'::text, v_n;
end $$;

-- the sweep the runner calls: work tied to an obsolete quotation is withdrawn, work behind a dead prerequisite is marked blocked (service-role only)
create or replace function ai.p1o_invalidate_stale_handoffs(p_organization_id uuid)
returns table (withdrawn int, blocked int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w int := 0;
  v_b int := 0;
  v_id uuid;
begin
  if (select auth.role()) is distinct from 'service_role' and (select auth.uid()) is not null then
    raise exception 'ai.p1o_invalidate_stale_handoffs is a runner door' using errcode = 'insufficient_privilege';
  end if;
  for v_id in
    select h.id from ai.handoffs h join sales.proposals p on p.id = h.bound_proposal_id
     where h.organization_id = p_organization_id and h.status in ('queued', 'accepted', 'needs_input', 'awaiting_approval', 'running', 'failed_retryable')
       and p.status in ('superseded', 'rejected', 'lapsed', 'cancelled')
  loop
    update ai.handoffs set status = 'cancelled', blocker = 'withdrawn: the quotation it was bound to is no longer live' where id = v_id;
    insert into ai.p1o_handoff_escalations (organization_id, handoff_id, cause, recommendation)
    select h.organization_id, h.id, 'stale_version', 'The quotation this task was bound to changed. Re-create the task against the current version if it is still wanted.'
      from ai.handoffs h where h.id = v_id
    on conflict do nothing;
    v_w := v_w + 1;
  end loop;
  update ai.handoffs h set blocker = 'a prerequisite failed or was withdrawn'
   where h.organization_id = p_organization_id and h.status in ('queued', 'accepted') and h.blocker is null
     and exists (select 1 from ai.handoffs d where d.id = any (h.dependency_ids) and d.status in ('failed_permanent', 'rejected', 'cancelled'));
  get diagnostics v_b = row_count;
  return query select v_w, v_b;
end $$;

-- ── the reads: the board, the queue, the metrics and the packet ────────────
create or replace function ai.p1o_workflow_task_board(
  p_state text default null, p_agent text default null, p_priority text default null,
  p_older_than_minutes int default null, p_stale_only boolean default false, p_limit int default 200
)
returns table (
  handoff_id uuid, board_state text, status text, priority text, from_agent text, to_agent text, objective text, subject_type text, subject_id uuid,
  project_id uuid, age_minutes int, stale boolean, retry_count int, blocker text, paused boolean, waiting_on int, sla_at timestamptz, correlation_id uuid, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then
    return;
  end if;
  return query
  with b as (
    select h.*,
           (select count(*)::int from ai.handoffs d where d.id = any (h.dependency_ids) and d.status <> 'completed') as unmet,
           exists (select 1 from ai.p1o_handoff_escalations e where e.handoff_id = h.id and e.state = 'open') as has_open_escalation
      from ai.handoffs h
     where h.organization_id = v_org
  ), s as (
    select b.*,
           case
             when b.status in ('completed', 'cancelled') then 'closed'
             when b.status in ('failed_permanent', 'rejected') and b.has_open_escalation then 'escalated'
             when b.status in ('failed_permanent', 'rejected') then 'failed'
             when b.has_open_escalation then 'escalated'
             when b.paused_at is not null or b.unmet > 0 or b.blocker is not null then 'blocked'
             when b.status = 'failed_retryable' then 'retrying'
             when b.status in ('needs_input', 'awaiting_approval') then 'waiting'
             when b.status = 'running' then 'in_progress'
             when b.status = 'accepted' then 'ready'
             else 'created'
           end as bs
      from b
  )
  select s.id, s.bs, s.status, s.priority, s.from_agent, s.to_agent, s.objective, s.subject_type, s.subject_id, s.project_id,
         (extract(epoch from (now() - s.created_at)) / 60)::int,
         (s.bs not in ('closed', 'failed') and (coalesce(s.sla_at < now(), false) or s.created_at < now() - interval '1 day')),
         s.retry_count, s.blocker, s.paused_at is not null, s.unmet, s.sla_at, s.correlation_id, s.created_at
    from s
   where (p_state is null or s.bs = p_state)
     and (p_agent is null or s.to_agent = p_agent or s.from_agent = p_agent)
     and (p_priority is null or s.priority = p_priority)
     and (p_older_than_minutes is null or s.created_at < now() - make_interval(mins => p_older_than_minutes))
     and (not coalesce(p_stale_only, false) or (s.bs not in ('closed', 'failed') and (coalesce(s.sla_at < now(), false) or s.created_at < now() - interval '1 day')))
   order by case s.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, s.created_at
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

create or replace function ai.p1o_workflow_queue_summary()
returns table (board_state text, tasks int, oldest_age_minutes int, stale int)
language sql
stable
security definer
set search_path = ''
as $$
  select t.board_state, count(*)::int, max(t.age_minutes), count(*) filter (where t.stale)::int
    from ai.p1o_workflow_task_board(null, null, null, null, false, 500) t
   group by t.board_state
   order by array_position(array['created','ready','in_progress','waiting','blocked','retrying','failed','escalated','closed'], t.board_state);
$$;

create or replace function ai.p1o_handoff_metrics(p_days int default 30)
returns table (handoffs int, completed int, failed int, retried int, escalated int, blocked_now int, median_minutes_to_complete numeric, p90_minutes_to_complete numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then
    return;
  end if;
  return query
  select count(*)::int,
         (count(*) filter (where h.status = 'completed'))::int,
         (count(*) filter (where h.status in ('failed_permanent', 'rejected')))::int,
         (count(*) filter (where h.retry_count > 0))::int,
         (count(*) filter (where h.escalated_at is not null))::int,
         (count(*) filter (where h.blocker is not null and h.status not in ('completed', 'rejected', 'failed_permanent', 'cancelled')))::int,
         round((percentile_cont(0.5) within group (order by extract(epoch from (h.completed_at - h.created_at)) / 60) filter (where h.status = 'completed'))::numeric, 1),
         round((percentile_cont(0.9) within group (order by extract(epoch from (h.completed_at - h.created_at)) / 60) filter (where h.status = 'completed'))::numeric, 1)
    from ai.handoffs h
   where h.organization_id = v_org and h.created_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
end $$;

-- the task detail (Admin Panel A17): the envelope, its prerequisites, its escalations and the failure the last attempt left
create or replace function ai.p1o_handoff_packet(p_handoff_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_h ai.handoffs;
begin
  if (select auth.uid()) is null or not coalesce((select core.is_internal()), false) or v_org is null then
    return null;
  end if;
  select h.* into v_h from ai.handoffs h where h.id = p_handoff_id and h.organization_id = v_org;
  if v_h.id is null then return null; end if;
  return jsonb_build_object(
    'id', v_h.id, 'status', v_h.status, 'priority', v_h.priority, 'from', v_h.from_agent, 'to', v_h.to_agent, 'objective', v_h.objective,
    'acceptanceCriteria', v_h.acceptance_criteria, 'requiredOutputSchema', v_h.required_output_schema, 'idempotencyKey', v_h.idempotency_key,
    'policyDecisionRef', v_h.policy_decision_ref, 'policyVersion', v_h.policy_version, 'approvalRequestId', v_h.approval_request_id,
    'retryCount', v_h.retry_count, 'previousFailure', v_h.previous_failure_summary, 'sideEffectUncertain', v_h.side_effect_uncertain,
    'blocker', v_h.blocker, 'paused', v_h.paused_at is not null, 'pauseReason', v_h.pause_reason, 'correlationId', v_h.correlation_id,
    'boundProposalId', v_h.bound_proposal_id, 'verification', v_h.verification, 'decisions', v_h.decisions,
    'dependencies', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'status', d.status, 'to', d.to_agent) order by d.created_at)
                                from ai.handoffs d where d.id = any (v_h.dependency_ids) and d.organization_id = v_org), '[]'::jsonb),
    'escalations', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'cause', e.cause, 'state', e.state, 'recommendation', e.recommendation,
                                                                   'attemptedRoutes', e.attempted_routes, 'failures', e.failures, 'raisedAt', e.raised_at) order by e.raised_at)
                              from ai.p1o_handoff_escalations e where e.handoff_id = v_h.id), '[]'::jsonb)
  );
end $$;

-- ── grants ─────────────────────────────────────────────────────────────────
revoke all on function
  ai.p1o_route_task(text), ai.p1o_door_refusal(uuid, boolean),
  ai.p1o_create_handoff(uuid, text, text, text, uuid, text, jsonb, text, text, uuid, uuid, uuid[], uuid, text, text, uuid, jsonb, jsonb, timestamptz),
  ai.p1o_record_handoff_failure(uuid, text, boolean, boolean), ai.p1o_retry_handoff(uuid, text), ai.p1o_reconcile_handoff(uuid, text, text),
  ai.p1o_pause_handoff(uuid, text), ai.p1o_resume_handoff(uuid), ai.p1o_reassign_handoff(uuid, text, text),
  ai.p1o_escalate_handoff(uuid, text, text, jsonb), ai.p1o_resolve_handoff_escalation(uuid, text), ai.p1o_record_conflicting_results(uuid[], text),
  ai.p1o_invalidate_stale_handoffs(uuid),
  ai.p1o_workflow_task_board(text, text, text, int, boolean, int), ai.p1o_workflow_queue_summary(), ai.p1o_handoff_metrics(int), ai.p1o_handoff_packet(uuid)
  from public, anon;
grant execute on function
  ai.p1o_route_task(text), ai.p1o_door_refusal(uuid, boolean),
  ai.p1o_create_handoff(uuid, text, text, text, uuid, text, jsonb, text, text, uuid, uuid, uuid[], uuid, text, text, uuid, jsonb, jsonb, timestamptz),
  ai.p1o_record_handoff_failure(uuid, text, boolean, boolean), ai.p1o_retry_handoff(uuid, text), ai.p1o_reconcile_handoff(uuid, text, text),
  ai.p1o_pause_handoff(uuid, text), ai.p1o_resume_handoff(uuid), ai.p1o_reassign_handoff(uuid, text, text),
  ai.p1o_escalate_handoff(uuid, text, text, jsonb), ai.p1o_resolve_handoff_escalation(uuid, text), ai.p1o_record_conflicting_results(uuid[], text),
  ai.p1o_workflow_task_board(text, text, text, int, boolean, int), ai.p1o_workflow_queue_summary(), ai.p1o_handoff_metrics(int), ai.p1o_handoff_packet(uuid)
  to authenticated, service_role;
grant execute on function ai.p1o_invalidate_stale_handoffs(uuid) to service_role;

notify pgrst, 'reload schema';
