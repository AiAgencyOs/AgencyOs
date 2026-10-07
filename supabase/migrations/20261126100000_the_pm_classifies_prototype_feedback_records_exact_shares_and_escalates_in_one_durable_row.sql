-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 PM Agent (traceability rows P4-PM-003, 007, 009, 011, 013, 016, 022, 028, 030, 032, 036; P4-ORCH-021, 013 (record), 035 (table)).
--
--   * projects.p4q_escalations                 ONE durable, project-scoped escalation row (type, reason, owner, decision, resolution) used by the PM (revision limit,
--                                              scope change without a baseline, design-direction change, blocked requirement, clarification nobody answered) and by the
--                                              Orchestrator (no capable agent, repeated failure, conflicting states). A person resolves it; an agent only opens it.
--   * p4q_prototype_feedback_classifications   prototype client feedback is classified against the exact build and ROUTED (revision / clarification / change request /
--                                              escalation). Until now only UI feedback was classified; prototype feedback went straight to a rebuild.
--   * p4q_designer_routing_decisions           the Designer redraft is gated on the classification (CORRECTION / INCLUDED_REVISION only). New scope, a clarification, a
--                                              direction change or a rejected request never reach the Designer first (Orchestrator spec section 20).
--   * p4q_client_review_shares                 the exact UI version / prototype build shown to the client: channel, instructions, delivery state (incl. UNKNOWN) and evidence.
--                                              A delivery is never recorded as sent without evidence.
--   * p4q_clarification_relays + trigger       an agent-raised clarification is relayed to the client ONE AT A TIME in client wording; an answer is routed back to the
--                                              agent that asked (event project.p4q_clarification_answered).
--   * projects.p4q_revision_records            the RevisionRequest read: from/to version, origin, affected screens, QA result, classification, counters; derived, never stored.
--
-- Nothing here approves, locks, verifies payment, or sends to the client by itself: shares are recorded after the act; the doors for approval and locking are unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.p4q_clarification_answered', 'A clarification an agent raised was answered. The answer goes back to the agent that asked; scope is not changed by it.', true),
  ('project.p4q_escalation_opened', 'A project-scoped escalation was opened (PM or Orchestrator). A person decides; nothing resumes automatically.', true),
  ('project.p4q_prototype_feedback_classified', 'Client feedback on an exact prototype build was classified and routed.', true)
on conflict (type) do nothing;

-- ── escalations ────────────────────────────────────────────────────────────
create table if not exists projects.p4q_escalations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  cause            text not null check (cause in ('revision_limit', 'scope_change', 'scope_change_without_baseline', 'design_direction_change', 'rejected_request', 'blocked_requirement',
                                                  'qa_blocked', 'finance_delay', 'clarification_unanswered', 'no_capable_agent', 'repeated_failure', 'conflicting_states',
                                                  'disabled_specialist', 'provider_unavailable', 'other')),
  raised_by_agent  text references ai.agents(key) on delete restrict,
  owner            text not null default 'admin' check (owner in ('admin', 'owner', 'finance', 'project_manager')),
  reason           text not null check (length(btrim(reason)) between 5 and 1000 and not projects.p7_has_secret(reason)),
  subject_type     text,
  subject_id       uuid,
  package          jsonb not null default '{}'::jsonb check (jsonb_typeof(package) = 'object'),
  state            text not null default 'open' check (state in ('open', 'resolved', 'dismissed')),
  decision         text check (decision is null or decision in ('continue', 'change_request', 'stop', 'reassign', 'fix_and_retry', 'dismissed')),
  resolution_note  text,
  resolved_by      uuid references core.users(id) on delete set null,
  resolved_at      timestamptz,
  opened_at        timestamptz not null default clock_timestamp(),
  constraint p4q_esc_resolution_shape check ((state = 'open') = (resolved_at is null and decision is null and resolution_note is null and resolved_by is null)
                                              and (state = 'open' or (resolved_by is not null and decision is not null and length(btrim(coalesce(resolution_note, ''))) >= 5)))
);
comment on table projects.p4q_escalations is 'PMEscalation / OrchestratorEscalation for Phase 4: type, reason, owner, decision, resolution. An agent opens it, a person with delivery rights resolves it with a decision and a note. One open row per (project, cause, subject).';
create unique index if not exists p4q_esc_one_open on projects.p4q_escalations (project_id, cause, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid)) where state = 'open';
create index if not exists p4q_esc_project_idx on projects.p4q_escalations (project_id, state, opened_at desc);

-- ── prototype feedback ─────────────────────────────────────────────────────
create table if not exists projects.p4q_prototype_feedback_classifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  deliverable_id   uuid not null references projects.deliverables(id) on delete restrict,
  decision_key     text not null check (length(btrim(decision_key)) between 1 and 200),
  client_words     text not null check (length(btrim(client_words)) between 1 and 4000),
  classification   text not null check (classification in ('CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST')),
  reasoning        text not null check (length(btrim(reasoning)) between 1 and 500),
  routed_to        text not null check (routed_to in ('prototype_revision', 'clarification', 'change_request', 'escalation')),
  revision_allowed boolean not null,
  change_request_id uuid references projects.change_requests(id) on delete set null,
  clarification_id uuid references projects.clarification_requests(id) on delete set null,
  escalation_id    uuid references projects.p4q_escalations(id) on delete set null,
  classified_by    uuid references core.users(id) on delete set null,
  classified_at    timestamptz not null default clock_timestamp(),
  unique (deliverable_id, decision_key)
);
comment on table projects.p4q_prototype_feedback_classifications is 'PM spec 4.10/8 for the PROTOTYPE: client feedback on an exact build, classified and routed. The client''s own words are stored verbatim. A prototype rebuild is allowed only for CORRECTION / INCLUDED_REVISION.';

-- ── the Designer redraft gate ──────────────────────────────────────────────
create table if not exists projects.p4q_designer_routing_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  decision_id      uuid not null unique references projects.ui_version_client_decisions(id) on delete cascade,
  ui_version_id    uuid not null references projects.ui_versions(id) on delete cascade,
  classification   text not null,
  activation_reason text not null check (activation_reason in ('client_change', 'admin_edit', 'qa_correction')),
  allowed          boolean not null,
  reason           text not null,
  decided_at       timestamptz not null default clock_timestamp()
);
comment on table projects.p4q_designer_routing_decisions is 'ORCH-013/021: why the Designer was, or was not, activated for a client UI change. The activation reason is recorded; feedback that is new scope, a clarification, a direction change or a rejected request is not routed to the Designer first.';

-- ── shares ─────────────────────────────────────────────────────────────────
create table if not exists projects.p4q_client_review_shares (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  kind             text not null check (kind in ('ui_version', 'prototype_build')),
  ui_version_id    uuid references projects.ui_versions(id) on delete restrict,
  deliverable_id   uuid references projects.deliverables(id) on delete restrict,
  channel          text not null check (channel in ('whatsapp', 'email', 'portal', 'internal_group', 'manual')),
  instructions     text not null check (length(btrim(instructions)) between 10 and 2000 and not projects.p7_has_secret(instructions)),
  shared_by        uuid references core.users(id) on delete set null,
  shared_at        timestamptz not null default clock_timestamp(),
  delivery_state   text not null default 'pending' check (delivery_state in ('pending', 'sent', 'delivered', 'failed', 'unknown')),
  delivery_evidence text check (delivery_evidence is null or (length(btrim(delivery_evidence)) between 3 and 500 and not projects.p7_has_secret(delivery_evidence))),
  retry_count      integer not null default 0 check (retry_count >= 0),
  updated_at       timestamptz not null default clock_timestamp(),
  constraint p4q_share_target check ((kind = 'ui_version' and ui_version_id is not null and deliverable_id is null) or (kind = 'prototype_build' and deliverable_id is not null and ui_version_id is null)),
  constraint p4q_share_delivered_has_evidence check (delivery_state not in ('sent', 'delivered') or delivery_evidence is not null)
);
comment on table projects.p4q_client_review_shares is 'PM spec 7 ClientReviewShare: the EXACT UI version or prototype build shown to the client, with channel, instructions, delivery state (pending/sent/delivered/failed/unknown) and evidence. sent/delivered need evidence; an uncertain send is `unknown`, never `sent`.';
create unique index if not exists p4q_share_once_ui on projects.p4q_client_review_shares (ui_version_id, channel) where kind = 'ui_version';
create unique index if not exists p4q_share_once_build on projects.p4q_client_review_shares (deliverable_id, channel) where kind = 'prototype_build';

-- ── clarification relays ───────────────────────────────────────────────────
create table if not exists projects.p4q_clarification_relays (
  clarification_id uuid primary key references projects.clarification_requests(id) on delete cascade,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  client_wording   text not null check (length(btrim(client_wording)) between 5 and 1000 and not projects.p7_has_secret(client_wording)),
  relay_state      text not null default 'queued' check (relay_state in ('queued', 'sent', 'answered')),
  sent_at          timestamptz,
  answered_at      timestamptz,
  created_at       timestamptz not null default clock_timestamp()
);
comment on table projects.p4q_clarification_relays is 'PM spec 4.3: an agent''s question in the CLIENT''s wording, relayed one at a time; the answer is routed back to the agent that asked without changing scope.';
create unique index if not exists p4q_one_relay_in_flight on projects.p4q_clarification_relays (project_id) where relay_state = 'sent';

select projects.p7_guard_fk('p4q_escalations', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_prototype_feedback_classifications', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_prototype_feedback_classifications', 'deliverable_id', 'projects.deliverables');
select projects.p7_guard_fk('p4q_prototype_feedback_classifications', 'escalation_id', 'projects.p4q_escalations');
select projects.p7_guard_fk('p4q_designer_routing_decisions', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_designer_routing_decisions', 'decision_id', 'projects.ui_version_client_decisions');
select projects.p7_guard_fk('p4q_designer_routing_decisions', 'ui_version_id', 'projects.ui_versions');
select projects.p7_guard_fk('p4q_client_review_shares', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_client_review_shares', 'ui_version_id', 'projects.ui_versions');
select projects.p7_guard_fk('p4q_client_review_shares', 'deliverable_id', 'projects.deliverables');
select projects.p7_guard_fk('p4q_clarification_relays', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_clarification_relays', 'clarification_id', 'projects.clarification_requests');
select projects.p7_harden('projects', 'p4q_escalations');
select projects.p7_harden('projects', 'p4q_prototype_feedback_classifications');
select projects.p7_harden('projects', 'p4q_designer_routing_decisions');
select projects.p7_harden('projects', 'p4q_client_review_shares');
select projects.p7_harden('projects', 'p4q_clarification_relays');
do $$ declare t text; begin
  foreach t in array array['p4q_escalations', 'p4q_prototype_feedback_classifications', 'p4q_designer_routing_decisions', 'p4q_client_review_shares', 'p4q_clarification_relays'] loop
    execute format('drop trigger if exists %I on projects.%I', t || '_door_only', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p4q_door_only()', t || '_door_only', t);
  end loop;
end $$;

-- ── escalation doors ───────────────────────────────────────────────────────
create or replace function projects.p4q_open_escalation(p_project_id uuid, p_cause text, p_reason text, p_owner text default 'admin', p_subject_type text default null,
                                                        p_subject_id uuid default null, p_raised_by_agent text default null, p_package jsonb default '{}'::jsonb)
returns table (outcome text, escalation_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_id    uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_actor is not null and (v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::uuid; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_reason) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if p_owner not in ('admin', 'owner', 'finance', 'project_manager') then return query select 'bad_owner'::text, null::uuid; return; end if;
  select e.id into v_id from projects.p4q_escalations e where e.project_id = p_project_id and e.cause = p_cause and e.state = 'open'
     and coalesce(e.subject_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_subject_id, '00000000-0000-0000-0000-000000000000'::uuid);
  if v_id is not null then return query select 'already_open'::text, v_id; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  begin
    insert into projects.p4q_escalations (organization_id, project_id, cause, raised_by_agent, owner, reason, subject_type, subject_id, package)
    values (v_org, p_project_id, p_cause, p_raised_by_agent, p_owner, v_reason, p_subject_type, p_subject_id, coalesce(p_package, '{}'::jsonb)) returning id into v_id;
  exception when check_violation or foreign_key_violation then
    return query select 'invalid'::text, null::uuid; return;
  end;
  perform core.record_audit(v_org, 'project.p4q_escalation_opened', 'project', p_project_id, null, jsonb_build_object('escalationId', v_id, 'cause', p_cause, 'owner', p_owner));
  perform core.emit_event(v_org, 'project.p4q_escalation_opened', 'project', p_project_id, jsonb_build_object('escalationId', v_id, 'cause', p_cause, 'owner', p_owner));
  return query select 'opened'::text, v_id;
end $$;
revoke all on function projects.p4q_open_escalation(uuid, text, text, text, text, uuid, text, jsonb) from public, anon;
grant execute on function projects.p4q_open_escalation(uuid, text, text, text, text, uuid, text, jsonb) to authenticated, service_role;

create or replace function projects.p4q_resolve_escalation(p_escalation_id uuid, p_decision text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_e     projects.p4q_escalations;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_e from projects.p4q_escalations where id = p_escalation_id and organization_id = (select core.current_organization_id()) for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_e.state <> 'open' then return query select 'already_settled'::text; return; end if;
  if p_decision not in ('continue', 'change_request', 'stop', 'reassign', 'fix_and_retry', 'dismissed') then return query select 'bad_decision'::text; return; end if;
  if v_note is null or length(v_note) < 5 then return query select 'note_required'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_escalations set state = case when p_decision = 'dismissed' then 'dismissed' else 'resolved' end, decision = p_decision, resolution_note = v_note, resolved_by = v_actor, resolved_at = clock_timestamp() where id = v_e.id;
  perform core.record_audit(v_e.organization_id, 'project.p4q_escalation_resolved', 'project', v_e.project_id, null, jsonb_build_object('escalationId', v_e.id, 'decision', p_decision));
  return query select 'resolved'::text;
end $$;
revoke all on function projects.p4q_resolve_escalation(uuid, text, text) from public, anon, service_role;
grant execute on function projects.p4q_resolve_escalation(uuid, text, text) to authenticated;

-- ── prototype feedback: classify against the exact build and route ─────────
create or replace function projects.p4q_classify_prototype_feedback(p_deliverable_id uuid, p_decision_key text, p_client_words text, p_classification text, p_reasoning text)
returns table (outcome text, routed_to text, revision_allowed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_d     projects.deliverables;
  v_words text := nullif(btrim(coalesce(p_client_words, '')), '');
  v_why   text := nullif(btrim(coalesce(p_reasoning, '')), '');
  v_key   text := nullif(btrim(coalesce(p_decision_key, '')), '');
  v_ex    projects.p4q_prototype_feedback_classifications;
  v_route text;
  v_allowed boolean := false;
  v_scope uuid;
  v_cr    uuid;
  v_cl    uuid;
  v_esc   uuid;
  v_o     text;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::text, null::boolean; return; end if;
  select d.* into v_d from projects.deliverables d where d.id = p_deliverable_id;
  if v_d.id is null or v_d.kind <> 'prototype' then return query select 'not_a_prototype'::text, null::text, null::boolean; return; end if;
  if v_actor is not null and (v_d.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::text, null::boolean; return; end if;
  if p_classification not in ('CORRECTION', 'INCLUDED_REVISION', 'CLARIFICATION', 'POSSIBLE_SCOPE_CHANGE', 'DESIGN_DIRECTION_CHANGE', 'REJECTED_REQUEST') then return query select 'bad_classification'::text, null::text, null::boolean; return; end if;
  if v_words is null or v_why is null or v_key is null or length(v_why) > 500 then return query select 'invalid'::text, null::text, null::boolean; return; end if;
  select * into v_ex from projects.p4q_prototype_feedback_classifications where deliverable_id = v_d.id and decision_key = v_key;
  if v_ex.id is not null then return query select 'already_classified'::text, v_ex.routed_to, v_ex.revision_allowed; return; end if;

  perform set_config('projects.p4q_door', 'on', true);
  if p_classification in ('CORRECTION', 'INCLUDED_REVISION') then
    v_route := 'prototype_revision'; v_allowed := true;
  elsif p_classification = 'CLARIFICATION' then
    v_route := 'clarification';
    insert into projects.clarification_requests (organization_id, project_id, question, raised_by) values (v_d.organization_id, v_d.project_id, left(v_words, 2000), 'project_manager') returning id into v_cl;
  elsif p_classification = 'POSSIBLE_SCOPE_CHANGE' then
    select sv.id into v_scope from projects.scope_versions sv where sv.project_id = v_d.project_id and sv.status = 'active';
    if v_scope is not null then
      v_route := 'change_request';
      insert into projects.change_requests (organization_id, project_id, scope_version_id, source, requested, requested_by) values (v_d.organization_id, v_d.project_id, v_scope, 'client', v_words, v_actor) returning id into v_cr;
    else
      -- the old path silently created nothing without an active scope; here a person is told
      v_route := 'escalation';
      select e.escalation_id into v_esc from projects.p4q_open_escalation(v_d.project_id, 'scope_change_without_baseline', 'The client asked for something that may be new scope on a prototype build, and the project has no active scope version to raise a change request against.', 'admin', 'deliverable', v_d.id, 'project_manager') e;
    end if;
  else
    v_route := 'escalation';
    select e.escalation_id into v_esc from projects.p4q_open_escalation(v_d.project_id,
      case p_classification when 'DESIGN_DIRECTION_CHANGE' then 'design_direction_change' else 'rejected_request' end,
      'The client''s feedback on the prototype build is ' || p_classification || ': a person decides before anything is rebuilt.', 'admin', 'deliverable', v_d.id, 'project_manager') e;
  end if;
  insert into projects.p4q_prototype_feedback_classifications (organization_id, project_id, deliverable_id, decision_key, client_words, classification, reasoning, routed_to, revision_allowed, change_request_id, clarification_id, escalation_id, classified_by)
  values (v_d.organization_id, v_d.project_id, v_d.id, v_key, v_words, p_classification, v_why, v_route, v_allowed, v_cr, v_cl, v_esc, v_actor);
  perform core.record_audit(v_d.organization_id, 'project.p4q_prototype_feedback_classified', 'deliverable', v_d.id, null, jsonb_build_object('projectId', v_d.project_id, 'classification', p_classification, 'routedTo', v_route));
  perform core.emit_event(v_d.organization_id, 'project.p4q_prototype_feedback_classified', 'deliverable', v_d.id, jsonb_build_object('projectId', v_d.project_id, 'classification', p_classification, 'routedTo', v_route, 'revisionAllowed', v_allowed));
  return query select 'classified'::text, v_route, v_allowed;
end $$;
revoke all on function projects.p4q_classify_prototype_feedback(uuid, text, text, text, text) from public, anon;
grant execute on function projects.p4q_classify_prototype_feedback(uuid, text, text, text, text) to authenticated, service_role;

-- is a prototype rebuild allowed for this feedback? (only a classified CORRECTION / INCLUDED_REVISION)
create or replace function projects.p4q_prototype_revision_allowed(p_deliverable_id uuid, p_decision_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select c.revision_allowed from projects.p4q_prototype_feedback_classifications c
                    where c.deliverable_id = p_deliverable_id and c.decision_key = p_decision_key
                      and (c.organization_id = (select core.current_organization_id()) or (select auth.role()) = 'service_role')), false)
$$;
revoke all on function projects.p4q_prototype_revision_allowed(uuid, text) from public, anon;
grant execute on function projects.p4q_prototype_revision_allowed(uuid, text) to authenticated, service_role;

-- ── the Designer redraft gate ──────────────────────────────────────────────
create or replace function projects.p4q_decide_designer_revision(p_decision_id uuid, p_activation_reason text default 'client_change')
returns table (outcome text, allowed boolean, reason text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_dec   projects.ui_version_client_decisions;
  v_class text;
  v_ok    boolean;
  v_why   text;
  v_ex    projects.p4q_designer_routing_decisions;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, false, null::text; return; end if;
  select d.* into v_dec from projects.ui_version_client_decisions d where d.id = p_decision_id;
  if v_dec.id is null then return query select 'unknown_decision'::text, false, null::text; return; end if;
  if v_actor is not null and (v_dec.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, false, null::text; return; end if;
  if p_activation_reason not in ('client_change', 'admin_edit', 'qa_correction') then return query select 'bad_activation_reason'::text, false, null::text; return; end if;
  select * into v_ex from projects.p4q_designer_routing_decisions where decision_id = p_decision_id;
  if v_ex.id is not null then return query select 'already_decided'::text, v_ex.allowed, v_ex.reason; return; end if;
  if v_dec.decision <> 'change_requested' then return query select 'not_a_change_request'::text, false, 'The client did not ask for a change'::text; return; end if;
  select c.classification into v_class from projects.client_feedback_classifications c where c.decision_id = p_decision_id;
  if v_class is null then return query select 'awaiting_classification'::text, false, 'The PM has not classified this feedback yet; the Designer is not activated before it is'::text; return; end if;
  v_ok := v_class in ('CORRECTION', 'INCLUDED_REVISION');
  v_why := case v_class
    when 'CORRECTION' then 'A correction of what was shown: the Designer drafts the next version'
    when 'INCLUDED_REVISION' then 'An included revision within the approved scope: the Designer drafts the next version'
    when 'CLARIFICATION' then 'The PM clarifies with the client first; the Designer is not activated'
    when 'POSSIBLE_SCOPE_CHANGE' then 'Possible new scope goes to a change request first; the Designer is not activated'
    when 'DESIGN_DIRECTION_CHANGE' then 'A change of design direction needs a person''s decision first; the Designer is not activated'
    else 'A rejected request is escalated to a person; the Designer is not activated' end;
  perform set_config('projects.p4q_door', 'on', true);
  insert into projects.p4q_designer_routing_decisions (organization_id, project_id, decision_id, ui_version_id, classification, activation_reason, allowed, reason)
  values (v_dec.organization_id, v_dec.project_id, v_dec.id, v_dec.ui_version_id, v_class, p_activation_reason, v_ok, v_why);
  return query select 'decided'::text, v_ok, v_why;
end $$;
revoke all on function projects.p4q_decide_designer_revision(uuid, text) from public, anon;
grant execute on function projects.p4q_decide_designer_revision(uuid, text) to authenticated, service_role;

-- ── shares ─────────────────────────────────────────────────────────────────
create or replace function projects.p4q_prototype_test_instructions(p_deliverable_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_a projects.prototype_artifacts;
  v_first text;
  v_n int;
  v_routes int;
begin
  select a.* into v_a from projects.prototype_artifacts a where a.deliverable_id = p_deliverable_id
     and (a.organization_id = (select core.current_organization_id()) or (select auth.role()) = 'service_role');
  if v_a.id is null then return null; end if;
  v_first := v_a.screens -> 0 ->> 'screenKey';
  v_n := jsonb_array_length(v_a.screens);
  select count(*) into v_routes from jsonb_array_elements(v_a.screens) s, jsonb_array_elements(s -> 'elements') e where e ->> 'navigatesTo' is not null;
  return format('Open the prototype on the "%s" screen. It has %s screens and %s links between them: follow each link, check that every screen shows what you expect, and tell us in your own words what is missing or wrong. Nothing in it is real data and nothing you enter is saved.', v_first, v_n, v_routes);
end $$;
revoke all on function projects.p4q_prototype_test_instructions(uuid) from public, anon;
grant execute on function projects.p4q_prototype_test_instructions(uuid) to authenticated, service_role;

create or replace function projects.p4q_record_client_review_share(p_kind text, p_target_id uuid, p_channel text, p_instructions text default null)
returns table (outcome text, share_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid;
  v_proj  uuid;
  v_ui    projects.ui_versions;
  v_d     projects.deliverables;
  v_art   projects.prototype_artifacts;
  v_adm   text;
  v_ins   text := nullif(btrim(coalesce(p_instructions, '')), '');
  v_id    uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid; return; end if;
  if v_actor is not null and not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('ui_version', 'prototype_build') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_channel not in ('whatsapp', 'email', 'portal', 'internal_group', 'manual') then return query select 'bad_channel'::text, null::uuid; return; end if;
  if p_kind = 'ui_version' then
    select u.* into v_ui from projects.ui_versions u where u.id = p_target_id;
    if v_ui.id is null or (v_actor is not null and v_ui.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, null::uuid; return; end if;
    -- only the exact Admin-approved version (or one already in client review) is shared
    if v_ui.status not in ('admin_approved', 'client_review') then return query select 'not_admin_approved'::text, null::uuid; return; end if;
    v_org := v_ui.organization_id; v_proj := v_ui.project_id;
    v_ins := coalesce(v_ins, format('Please review version %s of the design. Tell us in your own words what to change, or confirm explicitly that this version is approved. Nothing is final until you confirm.', v_ui.version));
  else
    select d.* into v_d from projects.deliverables d where d.id = p_target_id and d.kind = 'prototype';
    if v_d.id is null or (v_actor is not null and v_d.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, null::uuid; return; end if;
    select a.* into v_art from projects.prototype_artifacts a where a.deliverable_id = v_d.id;
    select dd.admin_status into v_adm from projects.deliverable_details dd where dd.deliverable_id = v_d.id;
    if v_art.id is null or v_art.status <> 'qa_pass' then return query select 'not_qa_passed'::text, null::uuid; return; end if;
    if v_adm is distinct from 'approved' then return query select 'not_admin_approved'::text, null::uuid; return; end if;
    v_org := v_d.organization_id; v_proj := v_d.project_id;
    v_ins := coalesce(v_ins, projects.p4q_prototype_test_instructions(v_d.id));
  end if;
  if v_ins is null or length(v_ins) < 10 or length(v_ins) > 2000 then return query select 'instructions_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_ins) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select s.id into v_id from projects.p4q_client_review_shares s where s.kind = p_kind and s.channel = p_channel
     and ((p_kind = 'ui_version' and s.ui_version_id = p_target_id) or (p_kind = 'prototype_build' and s.deliverable_id = p_target_id));
  if v_id is not null then return query select 'already_shared'::text, v_id; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  insert into projects.p4q_client_review_shares (organization_id, project_id, kind, ui_version_id, deliverable_id, channel, instructions, shared_by)
  values (v_org, v_proj, p_kind, case when p_kind = 'ui_version' then p_target_id end, case when p_kind = 'prototype_build' then p_target_id end, p_channel, v_ins, v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'project.p4q_client_review_shared', 'project', v_proj, null, jsonb_build_object('shareId', v_id, 'kind', p_kind, 'targetId', p_target_id, 'channel', p_channel));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.p4q_record_client_review_share(text, uuid, text, text) from public, anon;
grant execute on function projects.p4q_record_client_review_share(text, uuid, text, text) to authenticated, service_role;

create or replace function projects.p4q_mark_share_delivery(p_share_id uuid, p_state text, p_evidence text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_s     projects.p4q_client_review_shares;
  v_ev    text := nullif(btrim(coalesce(p_evidence, '')), '');
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text; return; end if;
  select * into v_s from projects.p4q_client_review_shares where id = p_share_id for update;
  if v_s.id is null then return query select 'not_found'::text; return; end if;
  if v_actor is not null and (v_s.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_manage_delivery()), false)) then return query select 'not_authorized'::text; return; end if;
  if p_state not in ('pending', 'sent', 'delivered', 'failed', 'unknown') then return query select 'bad_state'::text; return; end if;
  if v_s.delivery_state = p_state then return query select 'unchanged'::text; return; end if;
  if not ((v_s.delivery_state = 'pending' and p_state in ('sent', 'failed', 'unknown'))
       or (v_s.delivery_state = 'failed' and p_state = 'pending')
       or (v_s.delivery_state = 'unknown' and p_state in ('sent', 'failed', 'delivered'))
       or (v_s.delivery_state = 'sent' and p_state in ('delivered', 'unknown'))) then
    return query select 'bad_transition'::text; return;
  end if;
  -- a delivery is never recorded without something to show for it; an uncertain send says so
  if p_state in ('sent', 'delivered', 'unknown', 'failed') and v_ev is null then return query select 'evidence_required'::text; return; end if;
  if v_ev is not null and projects.p7_has_secret(v_ev) then return query select 'contains_secret'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_client_review_shares set delivery_state = p_state, delivery_evidence = coalesce(v_ev, delivery_evidence), updated_at = clock_timestamp(),
         retry_count = retry_count + case when v_s.delivery_state = 'failed' and p_state = 'pending' then 1 else 0 end where id = v_s.id;
  perform core.record_audit(v_s.organization_id, 'project.p4q_share_delivery', 'project', v_s.project_id, null, jsonb_build_object('shareId', v_s.id, 'from', v_s.delivery_state, 'to', p_state));
  return query select 'updated'::text;
end $$;
revoke all on function projects.p4q_mark_share_delivery(uuid, text, text) from public, anon;
grant execute on function projects.p4q_mark_share_delivery(uuid, text, text) to authenticated, service_role;

-- ── clarification: an agent raises, the PM relays one at a time, the answer returns ──
create or replace function projects.p4q_raise_clarification(p_project_id uuid, p_ui_version_id uuid, p_question text, p_client_wording text, p_raised_by text)
returns table (outcome text, clarification_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_org uuid;
  v_id uuid;
  v_q text := nullif(btrim(coalesce(p_question, '')), '');
  v_w text := nullif(btrim(coalesce(p_client_wording, '')), '');
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_actor is not null and (v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_raised_by not in ('ui_designer', 'quality_assurance', 'ui_prototype', 'project_manager') then return query select 'bad_source'::text, null::uuid; return; end if;
  if v_q is null or v_w is null or length(v_w) < 5 then return query select 'invalid'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_q) or projects.p7_has_secret(v_w) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if p_ui_version_id is not null and not exists (select 1 from projects.ui_versions u where u.id = p_ui_version_id and u.project_id = p_project_id) then return query select 'unknown_version'::text, null::uuid; return; end if;
  select c.id into v_id from projects.clarification_requests c where c.project_id = p_project_id and c.status = 'open' and c.raised_by = p_raised_by and lower(btrim(c.question)) = lower(v_q);
  if v_id is not null then return query select 'already_open'::text, v_id; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  insert into projects.clarification_requests (organization_id, project_id, ui_version_id, question, raised_by) values (v_org, p_project_id, p_ui_version_id, left(v_q, 2000), p_raised_by) returning id into v_id;
  insert into projects.p4q_clarification_relays (clarification_id, organization_id, project_id, client_wording) values (v_id, v_org, p_project_id, v_w);
  return query select 'raised'::text, v_id;
end $$;
revoke all on function projects.p4q_raise_clarification(uuid, uuid, text, text, text) from public, anon;
grant execute on function projects.p4q_raise_clarification(uuid, uuid, text, text, text) to authenticated, service_role;

create or replace function projects.p4q_relay_next_clarification(p_project_id uuid)
returns table (outcome text, clarification_id uuid, client_wording text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_org uuid;
  v_r   projects.p4q_clarification_relays;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid, null::text; return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  if v_org is null then return query select 'not_found'::text, null::uuid, null::text; return; end if;
  if v_actor is not null and (v_org is distinct from (select core.current_organization_id()) or not coalesce((select core.can_manage_delivery()), false)) then return query select 'not_authorized'::text, null::uuid, null::text; return; end if;
  if exists (select 1 from projects.p4q_clarification_relays r where r.project_id = p_project_id and r.relay_state = 'sent') then return query select 'one_at_a_time'::text, null::uuid, null::text; return; end if;
  select r.* into v_r from projects.p4q_clarification_relays r where r.project_id = p_project_id and r.relay_state = 'queued' order by r.created_at, r.clarification_id limit 1 for update;
  if v_r.clarification_id is null then return query select 'nothing_queued'::text, null::uuid, null::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_clarification_relays x set relay_state = 'sent', sent_at = clock_timestamp() where x.clarification_id = v_r.clarification_id;
  return query select 'relayed'::text, v_r.clarification_id, v_r.client_wording;
end $$;
revoke all on function projects.p4q_relay_next_clarification(uuid) from public, anon;
grant execute on function projects.p4q_relay_next_clarification(uuid) to authenticated, service_role;

-- an answer goes back to the agent that asked (and frees the next question)
create or replace function projects.p4q_clarification_answered_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'answered' and old.status is distinct from 'answered' then
    perform set_config('projects.p4q_door', 'on', true);
    update projects.p4q_clarification_relays set relay_state = 'answered', answered_at = clock_timestamp() where clarification_id = new.id;
    perform core.emit_event(new.organization_id, 'project.p4q_clarification_answered', 'clarification_request', new.id,
      jsonb_build_object('projectId', new.project_id, 'raisedBy', new.raised_by, 'uiVersionId', new.ui_version_id));
  end if;
  return new;
end $$;
revoke all on function projects.p4q_clarification_answered_trigger() from public, anon, authenticated, service_role;
drop trigger if exists p4q_clarification_answered on projects.clarification_requests;
create trigger p4q_clarification_answered after update of status on projects.clarification_requests for each row execute function projects.p4q_clarification_answered_trigger();

-- ── the RevisionRequest read, derived from the rows that decide it ─────────
create or replace function projects.p4q_revision_records(p_project_id uuid)
returns table (artifact_kind text, from_ref uuid, to_ref uuid, from_version integer, to_version integer, origin text, normalised_changes text, affected_screens text[], qa_result text, classification text, admin_decision text, client_decision text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return; end if;
  return query
  select 'ui_version'::text, prev.id, cur.id, prev.version, cur.version,
         case prev.status when 'client_change' then 'CLIENT' when 'admin_edit' then 'ADMIN' when 'qa_changes_required' then 'QA_CORRECTION' else 'UNKNOWN' end,
         coalesce((select left(d.client_words, 500) from projects.ui_version_client_decisions d where d.ui_version_id = prev.id and d.decision = 'change_requested' order by d.created_at desc limit 1),
                  case prev.status when 'qa_changes_required' then (select 'QA returned: ' || coalesce(string_agg(x, ', '), 'see findings') from jsonb_array_elements_text(coalesce(prev.qa_findings -> 'missingScreens', '[]'::jsonb) || coalesce(prev.qa_findings -> 'stateGaps', '[]'::jsonb)) x) end),
         coalesce((select array_agg(distinct k order by k) from (
              select s ->> 'screenKey' k from jsonb_array_elements(cur.screens) s where not exists (select 1 from jsonb_array_elements(prev.screens) o where o = s)
              union select s ->> 'screenKey' from jsonb_array_elements(prev.screens) s where not exists (select 1 from jsonb_array_elements(cur.screens) o where o = s)) q where k is not null), '{}'::text[]),
         cur.status,
         (select c.classification from projects.client_feedback_classifications c join projects.ui_version_client_decisions d on d.id = c.decision_id where d.ui_version_id = prev.id order by c.created_at desc limit 1),
         case when prev.status = 'admin_edit' then 'edit' when prev.status in ('admin_approved', 'client_review', 'client_change', 'client_approved', 'locked') then 'approved' end,
         (select d.decision from projects.ui_version_client_decisions d where d.ui_version_id = prev.id order by d.created_at desc limit 1)
    from projects.ui_versions cur
    join projects.ui_versions prev on prev.phase_four_id = cur.phase_four_id and prev.version = cur.version - 1
   where cur.project_id = p_project_id and cur.organization_id = v_org
  union all
  select 'prototype_build'::text, pa.id, ca.id, null::integer, null::integer,
         coalesce((select i.revision_origin from projects.p4q_prototype_intakes i where i.artifact_id = ca.id), 'UNKNOWN'),
         (select left(f.client_words, 500) from projects.p4q_prototype_feedback_classifications f where f.deliverable_id = pa.deliverable_id order by f.classified_at desc limit 1),
         coalesce((select array_agg(distinct k order by k) from (
              select s ->> 'screenKey' k from jsonb_array_elements(ca.screens) s where not exists (select 1 from jsonb_array_elements(pa.screens) o where o = s)
              union select s ->> 'screenKey' from jsonb_array_elements(pa.screens) s where not exists (select 1 from jsonb_array_elements(ca.screens) o where o = s)) q where k is not null), '{}'::text[]),
         ca.status,
         (select f.classification from projects.p4q_prototype_feedback_classifications f where f.deliverable_id = pa.deliverable_id order by f.classified_at desc limit 1),
         (select dd.admin_status from projects.deliverable_details dd where dd.deliverable_id = pa.deliverable_id),
         (select dv.status from projects.deliverables dv where dv.id = pa.deliverable_id)
    from projects.prototype_artifacts ca
    join lateral (select x.* from projects.prototype_artifacts x where x.project_id = ca.project_id and x.created_at < ca.created_at order by x.created_at desc limit 1) pa on true
   where ca.project_id = p_project_id and ca.organization_id = v_org;
end $$;
revoke all on function projects.p4q_revision_records(uuid) from public, anon, service_role;
grant execute on function projects.p4q_revision_records(uuid) to authenticated;

notify pgrst, 'reload schema';
