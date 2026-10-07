-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1-3 rest-gaps, notifications / planning / design clarification (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-BLUEPRINT-032 (A26)   central notification rules: channel, frequency, quiet hours, per event class, with a pure decision function every sender can ask
--   P2-PLAN-020              the four planning events exist: PlanningContextLoaded, ClientDependencyIdentified, PlanningBlockerIdentified, ProjectPlanUpdated
--   P3-PM-005                the design clarification loop: raised, asked of the client by a person, answered with the client's own words, returned to design
--   P3-PM-006                a Phase 3 that lacks design context ENTERS blocked_requirement (nothing wrote that state before) with a stated reason
--   P3-PM-030                a design share that gets no client decision is chased: at most two reminders, spaced, recorded; nothing is sent from here
--
-- No door here sends a message, decides a design or answers for a client. The clarification answer is the client's words as a person recorded them,
-- with where to read them; the reminder is a record that a person (or the sender) reminded the client.
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.event_types (type, description, canonical) values
  ('planning.context_loaded', 'A draft plan was opened: the approved scope, requirements and onboarding were loaded as its context.', false),
  ('planning.client_dependency_identified', 'The plan names something only the client can supply (information or access).', false),
  ('planning.blocker_identified', 'A plan dependency is blocked.', false),
  ('planning.plan_updated', 'A new version of the project plan became the live plan.', false),
  ('project.screen_clarification_required', 'Design needs an answer about a screen or design requirement before it can continue.', false),
  ('project.screen_clarification_answered', 'A person recorded the client''s answer to a design clarification; it returns to design.', false),
  ('project.design_requirement_blocked', 'Phase 3 stopped in blocked_requirement because design context is incomplete.', false)
on conflict (type) do nothing;

-- ── A26 notification rules ──────────────────────────────────────────────────
create table if not exists core.p13_notification_rules (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references core.organizations(id) on delete cascade,
  event_class             text not null check (event_class in ('admin_alert', 'sales', 'approval', 'meeting_reminder', 'escalation', 'incident', 'client_followup')),
  channel                 text not null check (channel in ('in_app', 'email', 'whatsapp')),
  enabled                 boolean not null default true,
  min_interval_seconds    integer not null default 0 check (min_interval_seconds between 0 and 604800),
  quiet_start             time,
  quiet_end               time,
  timezone                text not null default 'Asia/Kolkata' check (length(timezone) between 3 and 64),
  critical_bypasses_quiet boolean not null default true,
  updated_by              uuid references core.users(id) on delete set null,
  updated_at              timestamptz not null default clock_timestamp(),
  unique (organization_id, event_class, channel),
  constraint p13_notification_quiet_hours_are_a_pair check ((quiet_start is null) = (quiet_end is null))
);
comment on table core.p13_notification_rules is
  'P1-BLUEPRINT-032. One central rule per (event class, channel): on/off, minimum interval and quiet hours. Senders ask core.p13_notification_decision instead of keeping their own rule, so the modules cannot drift apart. No rule means the module default applies and the decision says so.';
drop trigger if exists freeze_org_p13_notification_rules on core.p13_notification_rules;
create trigger freeze_org_p13_notification_rules before update of organization_id on core.p13_notification_rules
  for each row execute function core.freeze_organization_id();
alter table core.p13_notification_rules enable row level security;
alter table core.p13_notification_rules force row level security;
drop policy if exists p13_notification_rules_read on core.p13_notification_rules;
create policy p13_notification_rules_read on core.p13_notification_rules for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on core.p13_notification_rules from public, anon, authenticated;
grant select on core.p13_notification_rules to authenticated;
grant all on core.p13_notification_rules to service_role;

create or replace function core.p13_set_notification_rule(
  p_event_class text, p_channel text, p_enabled boolean, p_min_interval_seconds integer default 0,
  p_quiet_start time default null, p_quiet_end time default null, p_timezone text default 'Asia/Kolkata', p_critical_bypasses_quiet boolean default true)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_before jsonb;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not coalesce((select core.is_admin()), false) then return 'not_authorized'; end if;
  if p_event_class not in ('admin_alert', 'sales', 'approval', 'meeting_reminder', 'escalation', 'incident', 'client_followup') then return 'invalid_event_class'; end if;
  if p_channel not in ('in_app', 'email', 'whatsapp') then return 'invalid_channel'; end if;
  if p_min_interval_seconds is null or p_min_interval_seconds < 0 or p_min_interval_seconds > 604800 then return 'invalid_interval'; end if;
  if (p_quiet_start is null) <> (p_quiet_end is null) then return 'quiet_hours_need_both_ends'; end if;
  if p_quiet_start is not null and p_quiet_start = p_quiet_end then return 'quiet_hours_empty'; end if;
  if not exists (select 1 from pg_timezone_names n where n.name = p_timezone) then return 'invalid_timezone'; end if;
  select to_jsonb(r) - 'id' - 'organization_id' into v_before from core.p13_notification_rules r where r.organization_id = v_org and r.event_class = p_event_class and r.channel = p_channel;
  insert into core.p13_notification_rules as r (organization_id, event_class, channel, enabled, min_interval_seconds, quiet_start, quiet_end, timezone, critical_bypasses_quiet, updated_by)
    values (v_org, p_event_class, p_channel, coalesce(p_enabled, true), p_min_interval_seconds, p_quiet_start, p_quiet_end, p_timezone, coalesce(p_critical_bypasses_quiet, true), v_actor)
  on conflict (organization_id, event_class, channel) do update
    set enabled = excluded.enabled, min_interval_seconds = excluded.min_interval_seconds, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
        timezone = excluded.timezone, critical_bypasses_quiet = excluded.critical_bypasses_quiet, updated_by = v_actor, updated_at = clock_timestamp();
  perform core.record_audit(v_org, 'notification_rule.set', 'notification_rule', null, v_before,
    jsonb_build_object('eventClass', p_event_class, 'channel', p_channel, 'enabled', p_enabled, 'minIntervalSeconds', p_min_interval_seconds, 'quietStart', p_quiet_start, 'quietEnd', p_quiet_end));
  return 'set';
end $$;
revoke all on function core.p13_set_notification_rule(text, text, boolean, integer, time, time, text, boolean) from public, anon;
grant execute on function core.p13_set_notification_rule(text, text, boolean, integer, time, time, text, boolean) to authenticated;

-- The one question every sender asks. Pure given the rule row: severity 'critical' passes quiet hours and the interval when the rule lets it, never an off switch.
create or replace function core.p13_notification_decision(
  p_organization_id uuid, p_event_class text, p_channel text, p_severity text default 'normal',
  p_at timestamptz default clock_timestamp(), p_last_sent_at timestamptz default null)
returns table (allowed boolean, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare r core.p13_notification_rules; v_local time; v_quiet boolean; v_critical boolean := coalesce(p_severity, 'normal') = 'critical';
begin
  select * into r from core.p13_notification_rules x where x.organization_id = p_organization_id and x.event_class = p_event_class and x.channel = p_channel;
  if r.id is null then return query select true, 'no_rule'::text; return; end if;
  if not r.enabled then return query select false, 'disabled'::text; return; end if;
  if r.quiet_start is not null then
    v_local := (p_at at time zone r.timezone)::time;
    v_quiet := case when r.quiet_start < r.quiet_end then v_local >= r.quiet_start and v_local < r.quiet_end
                    else v_local >= r.quiet_start or v_local < r.quiet_end end;
    if v_quiet and not (v_critical and r.critical_bypasses_quiet) then return query select false, 'quiet_hours'::text; return; end if;
  end if;
  if r.min_interval_seconds > 0 and p_last_sent_at is not null and p_at < p_last_sent_at + make_interval(secs => r.min_interval_seconds) and not v_critical then
    return query select false, 'too_soon'::text; return;
  end if;
  return query select true, 'ok'::text;
end $$;
revoke all on function core.p13_notification_decision(uuid, text, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function core.p13_notification_decision(uuid, text, text, text, timestamptz, timestamptz) to authenticated, service_role;

-- ── P2-PLAN-020 planning events ─────────────────────────────────────────────
create or replace function projects.p13_plan_events()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform core.emit_event(new.organization_id, 'planning.context_loaded', 'project_plan', new.id, jsonb_build_object('projectId', new.project_id, 'version', new.version, 'status', new.status));
  elsif new.status = 'active' and old.status is distinct from 'active' and new.version > 1 then
    perform core.emit_event(new.organization_id, 'planning.plan_updated', 'project_plan', new.id, jsonb_build_object('projectId', new.project_id, 'version', new.version, 'reason', new.change_reason));
  end if;
  return new;
end $$;
drop trigger if exists p13_plan_events_ins on projects.project_plans;
create trigger p13_plan_events_ins after insert on projects.project_plans for each row execute function projects.p13_plan_events();
drop trigger if exists p13_plan_events_upd on projects.project_plans;
create trigger p13_plan_events_upd after update of status on projects.project_plans for each row execute function projects.p13_plan_events();

create or replace function projects.p13_dependency_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  select p.project_id into v_project from projects.project_plans p where p.id = new.plan_id;
  if tg_op = 'INSERT' and new.kind in ('client_information', 'client_access') then
    perform core.emit_event(new.organization_id, 'planning.client_dependency_identified', 'plan_dependency', new.id,
      jsonb_build_object('projectId', v_project, 'planId', new.plan_id, 'kind', new.kind, 'neededByPhase', new.needed_by_phase));
  end if;
  if new.status = 'blocked' and (tg_op = 'INSERT' or old.status is distinct from 'blocked') then
    perform core.emit_event(new.organization_id, 'planning.blocker_identified', 'plan_dependency', new.id,
      jsonb_build_object('projectId', v_project, 'planId', new.plan_id, 'kind', new.kind, 'neededByPhase', new.needed_by_phase));
  end if;
  return new;
end $$;
drop trigger if exists p13_dependency_events_ins on projects.plan_dependencies;
create trigger p13_dependency_events_ins after insert on projects.plan_dependencies for each row execute function projects.p13_dependency_events();
drop trigger if exists p13_dependency_events_upd on projects.plan_dependencies;
create trigger p13_dependency_events_upd after update of status on projects.plan_dependencies for each row execute function projects.p13_dependency_events();

-- ── P3-PM-006 blocked_requirement writer ────────────────────────────────────
create or replace function projects.p13_block_design_requirement(p_phase_three_id uuid, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_actor uuid := (select auth.uid()); v_p projects.phase_three; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not v_service then
    if v_actor is null then return 'no_actor'; end if;
    if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return 'not_authorized'; end if;
  end if;
  if length(v_reason) = 0 then return 'reason_required'; end if;
  select * into v_p from projects.phase_three p where p.id = p_phase_three_id for update;
  if v_p.id is null then return 'not_found'; end if;
  if not v_service and v_p.organization_id is distinct from (select core.current_organization_id()) then return 'not_found'; end if;
  if v_p.state = 'blocked_requirement' then return 'already_blocked'; end if;
  if v_p.state not in ('context_loading', 'screen_definition', 'theme_generation', 'waiting_designer') then return 'wrong_state'; end if;   -- never interrupts a review, a lock or a client round
  update projects.phase_three set state = 'blocked_requirement', blocked_reason = left(v_reason, 500) where id = v_p.id;
  perform core.record_audit(v_p.organization_id, 'phase_three.blocked_requirement', 'phase_three', v_p.id, jsonb_build_object('state', v_p.state), jsonb_build_object('reason', left(v_reason, 500)));
  perform core.emit_event(v_p.organization_id, 'project.design_requirement_blocked', 'phase_three', v_p.id, jsonb_build_object('projectId', v_p.project_id, 'fromState', v_p.state, 'reason', left(v_reason, 500)));
  return 'blocked';
end $$;
revoke all on function projects.p13_block_design_requirement(uuid, text) from public, anon;
grant execute on function projects.p13_block_design_requirement(uuid, text) to authenticated, service_role;

-- ── P3-PM-005 the design clarification loop ─────────────────────────────────
create table if not exists projects.p13_design_clarifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  phase_three_id  uuid not null references projects.phase_three(id) on delete cascade,
  screen_ref      text check (screen_ref is null or length(btrim(screen_ref)) between 1 and 200),
  question        text not null check (length(btrim(question)) between 1 and 1000),
  raised_by_type  text not null check (raised_by_type in ('designer_agent', 'user')),
  raised_by       uuid references core.users(id) on delete set null,
  status          text not null default 'open' check (status in ('open', 'asked', 'answered', 'cancelled')),
  asked_at        timestamptz,
  asked_via       text check (asked_via is null or asked_via in ('whatsapp', 'email', 'call', 'other')),
  asked_by        uuid references core.users(id) on delete set null,
  asked_evidence  text check (asked_evidence is null or length(btrim(asked_evidence)) between 1 and 300),
  answer          text check (answer is null or length(btrim(answer)) between 1 and 4000),
  answer_fields   jsonb check (answer_fields is null or (jsonb_typeof(answer_fields) = 'object' and length(answer_fields::text) <= 4000)),
  answer_evidence text check (answer_evidence is null or length(btrim(answer_evidence)) between 1 and 300),
  answered_at     timestamptz,
  answered_by     uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default clock_timestamp(),
  constraint p13_clarification_asked_shape check (status not in ('asked', 'answered') or (asked_at is not null and asked_via is not null and asked_evidence is not null)),
  constraint p13_clarification_answered_shape check ((status = 'answered') = (answer is not null and answer_evidence is not null and answered_at is not null))
);
comment on table projects.p13_design_clarifications is
  'P3-PM-005. A question design cannot proceed without answering. A person asks the client (this table sends nothing) and records the client''s own words with where to read them; the answer returns to design as a structured record. Written only through the p13_ clarification doors.';
create index if not exists p13_design_clarifications_phase_idx on projects.p13_design_clarifications (phase_three_id, status);
create unique index if not exists p13_design_clarifications_one_open_question on projects.p13_design_clarifications (phase_three_id, md5(lower(btrim(question)))) where status in ('open', 'asked');

drop trigger if exists org_match_p13_clarification_project on projects.p13_design_clarifications;
create trigger org_match_p13_clarification_project before insert or update of project_id, organization_id on projects.p13_design_clarifications
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists org_match_p13_clarification_phase on projects.p13_design_clarifications;
create trigger org_match_p13_clarification_phase before insert or update of phase_three_id, organization_id on projects.p13_design_clarifications
  for each row execute function core.enforce_parent_org('phase_three_id', 'projects.phase_three');
drop trigger if exists freeze_org_p13_design_clarifications on projects.p13_design_clarifications;
create trigger freeze_org_p13_design_clarifications before update of organization_id on projects.p13_design_clarifications
  for each row execute function core.freeze_organization_id();
alter table projects.p13_design_clarifications enable row level security;
alter table projects.p13_design_clarifications force row level security;
drop policy if exists p13_design_clarifications_read on projects.p13_design_clarifications;
create policy p13_design_clarifications_read on projects.p13_design_clarifications for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.p13_design_clarifications from public, anon, authenticated;
grant select on projects.p13_design_clarifications to authenticated;
grant all on projects.p13_design_clarifications to service_role;

create or replace function projects.p13_raise_design_clarification(p_phase_three_id uuid, p_screen_ref text, p_question text)
returns table (outcome text, clarification_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role';
  v_actor uuid := (select auth.uid()); v_p projects.phase_three; v_id uuid; v_q text := btrim(coalesce(p_question, ''));
begin
  if not v_service then
    if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
    if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return query select 'not_authorized'::text, null::uuid; return; end if;
  end if;
  if length(v_q) = 0 then return query select 'question_required'::text, null::uuid; return; end if;
  select * into v_p from projects.phase_three p where p.id = p_phase_three_id;
  if v_p.id is null or (not v_service and v_p.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, null::uuid; return; end if;
  if v_p.state in ('locked', 'completed') then return query select 'phase_closed'::text, null::uuid; return; end if;
  select c.id into v_id from projects.p13_design_clarifications c
   where c.phase_three_id = v_p.id and c.status in ('open', 'asked') and md5(lower(btrim(c.question))) = md5(lower(v_q));
  if v_id is not null then return query select 'already_open'::text, v_id; return; end if;   -- a repeat returns the existing question (idempotent)
  insert into projects.p13_design_clarifications (organization_id, project_id, phase_three_id, screen_ref, question, raised_by_type, raised_by)
    values (v_p.organization_id, v_p.project_id, v_p.id, nullif(btrim(coalesce(p_screen_ref, '')), ''), v_q, case when v_service then 'designer_agent' else 'user' end, v_actor)
    returning id into v_id;
  perform core.emit_event(v_p.organization_id, 'project.screen_clarification_required', 'phase_three', v_p.id,
    jsonb_build_object('projectId', v_p.project_id, 'clarificationId', v_id, 'screenRef', p_screen_ref));
  return query select 'raised'::text, v_id;
end $$;
revoke all on function projects.p13_raise_design_clarification(uuid, text, text) from public, anon;
grant execute on function projects.p13_raise_design_clarification(uuid, text, text) to authenticated, service_role;

create or replace function projects.p13_mark_clarification_asked(p_id uuid, p_via text, p_evidence text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_c projects.p13_design_clarifications;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return 'not_authorized'; end if;
  if p_via not in ('whatsapp', 'email', 'call', 'other') then return 'invalid_channel'; end if;
  if length(btrim(coalesce(p_evidence, ''))) = 0 then return 'evidence_required'; end if;   -- "I asked" needs a reference, because nothing here sends
  select * into v_c from projects.p13_design_clarifications c where c.id = p_id and c.organization_id = (select core.current_organization_id()) for update;
  if v_c.id is null then return 'not_found'; end if;
  if v_c.status <> 'open' then return 'not_open'; end if;
  update projects.p13_design_clarifications set status = 'asked', asked_at = clock_timestamp(), asked_via = p_via, asked_by = v_actor, asked_evidence = left(btrim(p_evidence), 300) where id = v_c.id;
  perform core.record_audit(v_c.organization_id, 'design_clarification.asked', 'design_clarification', v_c.id, null, jsonb_build_object('via', p_via));
  return 'asked';
end $$;
revoke all on function projects.p13_mark_clarification_asked(uuid, text, text) from public, anon;
grant execute on function projects.p13_mark_clarification_asked(uuid, text, text) to authenticated;

create or replace function projects.p13_answer_design_clarification(p_id uuid, p_answer text, p_answer_fields jsonb, p_evidence text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_c projects.p13_design_clarifications;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return 'not_authorized'; end if;
  if length(btrim(coalesce(p_answer, ''))) = 0 then return 'answer_required'; end if;
  if length(btrim(coalesce(p_evidence, ''))) = 0 then return 'evidence_required'; end if;   -- the client's words, and where to read them
  if p_answer_fields is not null and jsonb_typeof(p_answer_fields) <> 'object' then return 'fields_must_be_an_object'; end if;
  select * into v_c from projects.p13_design_clarifications c where c.id = p_id and c.organization_id = (select core.current_organization_id()) for update;
  if v_c.id is null then return 'not_found'; end if;
  if v_c.status <> 'asked' then return 'not_asked'; end if;   -- an answer to a question nobody asked is not an answer
  update projects.p13_design_clarifications
     set status = 'answered', answer = left(btrim(p_answer), 4000), answer_fields = p_answer_fields, answer_evidence = left(btrim(p_evidence), 300),
         answered_at = clock_timestamp(), answered_by = v_actor
   where id = v_c.id;
  perform core.record_audit(v_c.organization_id, 'design_clarification.answered', 'design_clarification', v_c.id, null, jsonb_build_object('evidence', left(btrim(p_evidence), 300)));
  perform core.emit_event(v_c.organization_id, 'project.screen_clarification_answered', 'phase_three', v_c.phase_three_id,
    jsonb_build_object('projectId', v_c.project_id, 'clarificationId', v_c.id, 'screenRef', v_c.screen_ref));
  return 'answered';
end $$;
revoke all on function projects.p13_answer_design_clarification(uuid, text, jsonb, text) from public, anon;
grant execute on function projects.p13_answer_design_clarification(uuid, text, jsonb, text) to authenticated;

-- ── P3-PM-030 design-share reminders ────────────────────────────────────────
create table if not exists projects.p13_design_share_reminders (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  share_id        uuid not null references projects.client_design_shares(id) on delete cascade,
  reminder_number integer not null check (reminder_number in (1, 2)),
  channel         text not null check (channel in ('whatsapp', 'email', 'other')),
  evidence_ref    text not null check (length(btrim(evidence_ref)) between 1 and 300),
  recorded_by     uuid references core.users(id) on delete set null,
  recorded_at     timestamptz not null default clock_timestamp(),
  unique (share_id, reminder_number)
);
comment on table projects.p13_design_share_reminders is
  'P3-PM-030. A design share that drew no client decision is chased at most twice. A row says a reminder WAS sent (by a person, or by the sender with its message reference); this table sends nothing.';
drop trigger if exists org_match_p13_reminder_project on projects.p13_design_share_reminders;
create trigger org_match_p13_reminder_project before insert or update of project_id, organization_id on projects.p13_design_share_reminders
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists org_match_p13_reminder_share on projects.p13_design_share_reminders;
create trigger org_match_p13_reminder_share before insert or update of share_id, organization_id on projects.p13_design_share_reminders
  for each row execute function core.enforce_parent_org('share_id', 'projects.client_design_shares');
drop trigger if exists freeze_org_p13_design_share_reminders on projects.p13_design_share_reminders;
create trigger freeze_org_p13_design_share_reminders before update of organization_id on projects.p13_design_share_reminders
  for each row execute function core.freeze_organization_id();
alter table projects.p13_design_share_reminders enable row level security;
alter table projects.p13_design_share_reminders force row level security;
drop policy if exists p13_design_share_reminders_read on projects.p13_design_share_reminders;
create policy p13_design_share_reminders_read on projects.p13_design_share_reminders for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.p13_design_share_reminders from public, anon, authenticated;
grant select on projects.p13_design_share_reminders to authenticated;
grant all on projects.p13_design_share_reminders to service_role;

-- Shares that still await the client: the LATEST share of a phase that has no decision recorded against it, whose phase is waiting on the client, old enough
-- and not yet reminded twice nor reminded within the spacing. The sender must still honour consent / quiet hours before it sends (core.p13_notification_decision).
create or replace function projects.p13_design_shares_awaiting_decision(p_organization_id uuid, p_after_hours integer default 48, p_between_hours integer default 48)
returns table (share_id uuid, project_id uuid, phase_three_id uuid, share_number integer, shared_at timestamptz, reminders_sent integer, next_reminder_number integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid;
begin
  if coalesce((select auth.role()), '') = 'service_role' then v_org := p_organization_id;
  else v_org := (select core.current_organization_id()); end if;
  if p_after_hours < 1 or p_between_hours < 1 then raise exception 'p13_design_shares_awaiting_decision: hours must be positive'; end if;
  return query
  select s.id, s.project_id, s.phase_three_id, s.share_number, s.shared_at,
         (select count(*)::integer from projects.p13_design_share_reminders r where r.share_id = s.id),
         (select count(*)::integer + 1 from projects.p13_design_share_reminders r where r.share_id = s.id)
    from projects.client_design_shares s
    join projects.phase_three p on p.id = s.phase_three_id
   where s.organization_id = v_org
     and p.state in ('client_review', 'waiting_client')
     and s.share_number = (select max(x.share_number) from projects.client_design_shares x where x.phase_three_id = s.phase_three_id)
     and not exists (select 1 from projects.client_design_decisions d where d.share_id = s.id)
     and s.shared_at <= clock_timestamp() - make_interval(hours => p_after_hours)
     and (select count(*) from projects.p13_design_share_reminders r where r.share_id = s.id) < 2
     and coalesce((select max(r.recorded_at) from projects.p13_design_share_reminders r where r.share_id = s.id), '-infinity'::timestamptz) <= clock_timestamp() - make_interval(hours => p_between_hours);
end $$;
revoke all on function projects.p13_design_shares_awaiting_decision(uuid, integer, integer) from public, anon;
grant execute on function projects.p13_design_shares_awaiting_decision(uuid, integer, integer) to authenticated, service_role;

create or replace function projects.p13_record_design_share_reminder(p_share_id uuid, p_channel text, p_evidence text)
returns table (outcome text, reminder_number integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_actor uuid := (select auth.uid()); v_s projects.client_design_shares; v_n integer;
begin
  if not v_service then
    if v_actor is null then return query select 'no_actor'::text, null::integer; return; end if;
    if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return query select 'not_authorized'::text, null::integer; return; end if;
  end if;
  if p_channel not in ('whatsapp', 'email', 'other') then return query select 'invalid_channel'::text, null::integer; return; end if;
  if length(btrim(coalesce(p_evidence, ''))) = 0 then return query select 'evidence_required'::text, null::integer; return; end if;
  select * into v_s from projects.client_design_shares s where s.id = p_share_id for update;
  if v_s.id is null or (not v_service and v_s.organization_id is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, null::integer; return; end if;
  if exists (select 1 from projects.client_design_decisions d where d.share_id = v_s.id) then return query select 'already_answered'::text, null::integer; return; end if;
  select count(*)::integer + 1 into v_n from projects.p13_design_share_reminders r where r.share_id = v_s.id;
  if v_n > 2 then return query select 'reminder_limit_reached'::text, null::integer; return; end if;
  insert into projects.p13_design_share_reminders (organization_id, project_id, share_id, reminder_number, channel, evidence_ref, recorded_by)
    values (v_s.organization_id, v_s.project_id, v_s.id, v_n, p_channel, left(btrim(p_evidence), 300), v_actor);
  return query select 'recorded'::text, v_n;
end $$;
revoke all on function projects.p13_record_design_share_reminder(uuid, text, text) from public, anon;
grant execute on function projects.p13_record_design_share_reminder(uuid, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
