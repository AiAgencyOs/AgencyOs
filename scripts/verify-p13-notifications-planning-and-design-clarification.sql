-- ═══════════════════════════════════════════════════════════════════════════
-- P1-BLUEPRINT-032, P2-PLAN-020, P3-PM-005, P3-PM-006, P3-PM-030: notification rules, planning events, the design clarification loop, the
-- blocked_requirement writer and the design-share reminders. Real doors and triggers on a scratch Postgres; rolls back.
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p13-notifications-planning-and-design-clarification.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000013d2'
\set ADM '00000000-0000-4000-8000-000000013c01'
\set LEAD '00000000-0000-4000-8000-000000013c02'
\set MEM '00000000-0000-4000-8000-000000013c03'

insert into auth.users (id, email) values (:'ADM', 'p13c-adm@example.test'), (:'LEAD', 'p13c-lead@example.test'), (:'MEM', 'p13c-mem@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'ADM', 'p13c-adm@example.test', 'A'), (:'LEAD', 'p13c-lead@example.test', 'L'), (:'MEM', 'p13c-mem@example.test', 'M') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'ADM', 'ops_admin'), (:'ORG', :'LEAD', 'delivery_lead'), (:'ORG', :'MEM', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p13c other org', 'zztest-p13c-other') on conflict do nothing;

-- ═════════ A26 notification rules ═════════
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select allowed from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp')) is true
                     and (select reason from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp')) = 'no_rule', 'with no rule the module default applies and the decision says so');
select pg_temp.check(core.p13_set_notification_rule('sales', 'whatsapp', true, 600, '22:00', '08:00', 'Asia/Kolkata', true) = 'set', 'an admin sets a rule: quiet 22:00-08:00 IST, ten minutes apart');
select pg_temp.check(core.p13_set_notification_rule('sales', 'whatsapp', true, 0, '22:00', null) = 'quiet_hours_need_both_ends', 'NEGATIVE: quiet hours need both ends');
select pg_temp.check(core.p13_set_notification_rule('sales', 'whatsapp', true, 0, '22:00', '22:00') = 'quiet_hours_empty', 'NEGATIVE: an empty quiet window is refused');
select pg_temp.check(core.p13_set_notification_rule('sales', 'whatsapp', true, 0, null, null, 'Mars/Olympus') = 'invalid_timezone', 'NEGATIVE: an unknown timezone is refused');
select pg_temp.check(core.p13_set_notification_rule('gossip', 'whatsapp', true) = 'invalid_event_class', 'NEGATIVE: an unknown event class is refused');
select pg_temp.check(core.p13_set_notification_rule('sales', 'pigeon', true) = 'invalid_channel', 'NEGATIVE: an unknown channel is refused');
select pg_temp.check(core.p13_set_notification_rule('sales', 'whatsapp', true, -5) = 'invalid_interval', 'NEGATIVE: a negative interval is refused');
select pg_temp.check((select count(*) from audit.audit_log where action = 'notification_rule.set' and organization_id = :'ORG') >= 1, 'setting a rule is audited');
-- 23:30 IST = 18:00 UTC; 12:00 IST = 06:30 UTC
select pg_temp.check((select reason from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp', 'normal', '2026-11-28 18:00:00+00')) = 'quiet_hours', 'NEGATIVE: 23:30 in Kolkata is inside the quiet window (it crosses midnight)');
select pg_temp.check((select reason from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp', 'normal', '2026-11-28 01:00:00+00')) = 'quiet_hours', 'NEGATIVE: 06:30 in Kolkata is still inside it');
select pg_temp.check((select allowed from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp', 'normal', '2026-11-28 06:30:00+00')) is true, '12:00 in Kolkata is outside it');
select pg_temp.check((select allowed from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp', 'critical', '2026-11-28 18:00:00+00')) is true, 'a critical notice passes quiet hours when the rule lets it');
select pg_temp.check((select reason from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp', 'normal', '2026-11-28 06:30:00+00', '2026-11-28 06:25:00+00')) = 'too_soon', 'NEGATIVE: a second notice five minutes after the last is too soon');
select pg_temp.check((select allowed from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp', 'normal', '2026-11-28 06:30:00+00', '2026-11-28 06:10:00+00')) is true, 'and twenty minutes after is fine');
select pg_temp.check((select allowed from core.p13_notification_decision(:'ORG', 'sales', 'whatsapp', 'critical', '2026-11-28 06:30:00+00', '2026-11-28 06:29:00+00')) is true, 'a critical notice is not held back by the minimum interval');
select pg_temp.check(core.p13_set_notification_rule('incident', 'email', false) = 'set', 'a rule can switch a class off');
select pg_temp.check((select reason from core.p13_notification_decision(:'ORG', 'incident', 'email', 'critical')) = 'disabled', 'NEGATIVE: an off switch is not bypassed even by a critical notice');
select pg_temp.check((select allowed from core.p13_notification_decision(:'ORG2', 'sales', 'whatsapp', 'normal', '2026-11-28 18:00:00+00')) is true, 'another organization''s rules do not apply here');
reset role;
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(core.p13_set_notification_rule('sales', 'email', true) = 'not_authorized', 'NEGATIVE: a plain member cannot set a rule');
reset role;

-- ═════════ fixtures: project, plan, phase three, a share ═════════
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p13c client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p13c', 'ZP13-C') returning id \gset P_

-- ═════════ P2-PLAN-020 planning events ═════════
insert into projects.project_plans (organization_id, project_id, version, status) values (:'ORG', :'P_id', 1, 'draft') returning id \gset PL1_
select pg_temp.check((select count(*) from core.outbox_events where type = 'planning.context_loaded' and subject_id = :'PL1_id') = 1, 'opening a draft plan writes PlanningContextLoaded');
insert into projects.plan_dependencies (organization_id, plan_id, kind, description, needed_by_phase, owner_role) values (:'ORG', :'PL1_id', 'client_access', 'domain registrar login', 'phase_4', 'project_manager') returning id \gset D1_
insert into projects.plan_dependencies (organization_id, plan_id, kind, description, needed_by_phase, owner_role) values (:'ORG', :'PL1_id', 'internal_output', 'copy deck', 'phase_3', 'designer') returning id \gset D2_
select pg_temp.check((select count(*) from core.outbox_events where type = 'planning.client_dependency_identified' and subject_id = :'D1_id') = 1, 'a client-side dependency writes ClientDependencyIdentified');
select pg_temp.check((select count(*) from core.outbox_events where type = 'planning.client_dependency_identified' and subject_id = :'D2_id') = 0, 'NEGATIVE: an internal dependency does not');
update projects.plan_dependencies set status = 'blocked' where id = :'D2_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'planning.blocker_identified' and subject_id = :'D2_id') = 1, 'a dependency that becomes blocked writes PlanningBlockerIdentified');
update projects.plan_dependencies set description = 'copy deck v2' where id = :'D2_id';
update projects.plan_dependencies set status = 'blocked' where id = :'D2_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'planning.blocker_identified' and subject_id = :'D2_id') = 1, 'NEGATIVE: a no-change update writes no second blocker event');
update projects.project_plans set status = 'active', activated_at = now(), approved_at = now() where id = :'PL1_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'planning.plan_updated' and subject_id = :'PL1_id') = 0, 'NEGATIVE: activating version 1 is not an update');
insert into projects.project_plans (organization_id, project_id, version, status, change_reason) values (:'ORG', :'P_id', 2, 'draft', 'client added a booking module') returning id \gset PL2_
update projects.project_plans set status = 'superseded' where id = :'PL1_id';
update projects.project_plans set status = 'active', activated_at = now(), approved_at = now() where id = :'PL2_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'planning.plan_updated' and subject_id = :'PL2_id') = 1
                     and (select payload->>'reason' from core.outbox_events where type = 'planning.plan_updated' and subject_id = :'PL2_id') = 'client added a booking module', 'activating version 2 writes ProjectPlanUpdated with the reason');

-- ═════════ phase three fixtures ═════════
set local session_replication_role = replica;
insert into projects.phase_two (organization_id, project_id, handoff_id) values (:'ORG', :'P_id', gen_random_uuid()) returning id \gset T2_
insert into projects.phase_three (organization_id, project_id, phase_two_id, state) values (:'ORG', :'P_id', :'T2_id', 'screen_definition') returning id \gset F_
insert into projects.phase_three (organization_id, project_id, phase_two_id, state, blocked_reason) values (:'ORG', gen_random_uuid(), :'T2_id', 'admin_review', null) returning id \gset FR_
set local session_replication_role = origin;

-- ═════════ P3-PM-006 blocked_requirement ═════════
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(projects.p13_block_design_requirement(:'F_id', 'no brand colours') = 'not_authorized', 'NEGATIVE: a plain member cannot block a phase');
reset role;
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check(projects.p13_block_design_requirement(:'F_id', '  ') = 'reason_required', 'NEGATIVE: blocking needs a stated reason');
select pg_temp.check(projects.p13_block_design_requirement(:'F_id', 'the client has not told us the brand colours') = 'blocked', 'a delivery lead blocks a phase that lacks design context');
reset role;
select pg_temp.check((select state from projects.phase_three where id = :'F_id') = 'blocked_requirement' and (select blocked_reason from projects.phase_three where id = :'F_id') like 'the client has not%', 'it is in blocked_requirement and says why');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.design_requirement_blocked' and subject_id = :'F_id') = 1, 'and the event was written');
select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check(projects.p13_block_design_requirement(:'F_id', 'again') = 'already_blocked', 'NEGATIVE: not twice');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(projects.p13_block_design_requirement(:'FR_id', 'designer needs input') = 'wrong_state', 'NEGATIVE: a phase in admin review is never interrupted');
reset role;
-- the existing governed resolution still gets it out
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.resolve_phase_three_stop(:'F_id', 'requirement_supplied', 'colours received')) = 'resolved', 'the existing admin resolution releases a blocked phase');
reset role;
select pg_temp.check((select state from projects.phase_three where id = :'F_id') = 'screen_definition', 'back to screen definition');

-- ═════════ P3-PM-005 clarification loop ═════════
select pg_temp.as_service();
set local role service_role;
select outcome as o1, clarification_id as c1 from projects.p13_raise_design_clarification(:'F_id', 'checkout', 'Should the checkout take guest orders?') \gset
select pg_temp.check(:'o1' = 'raised', 'the designer workflow (service role) raises a clarification');
select pg_temp.check((select outcome from projects.p13_raise_design_clarification(:'F_id', 'checkout', '  should the checkout take guest orders?  ')) = 'already_open', 'the same question again returns the open one (idempotent)');
select pg_temp.check((select raised_by_type from projects.p13_design_clarifications where id = :'c1') = 'designer_agent', 'it is recorded as raised by the designer agent');
select pg_temp.check((select outcome from projects.p13_raise_design_clarification(:'F_id', null, '')) = 'question_required', 'NEGATIVE: a blank question is refused');
reset role;
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.screen_clarification_required' and subject_id = :'F_id') = 1, 'one ScreenClarificationRequired event, not two');

select pg_temp.as_user(:'LEAD', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check(projects.p13_answer_design_clarification(:'c1', 'yes, guests can order', null, 'wa:msg-1') = 'not_asked', 'NEGATIVE: an unasked question cannot be answered');
select pg_temp.check(projects.p13_mark_clarification_asked(:'c1', 'whatsapp', '') = 'evidence_required', 'NEGATIVE: "I asked" needs a reference');
select pg_temp.check(projects.p13_mark_clarification_asked(:'c1', 'carrier pigeon', 'x') = 'invalid_channel', 'NEGATIVE: an unknown channel is refused');
select pg_temp.check(projects.p13_mark_clarification_asked(:'c1', 'whatsapp', 'wa:out-77') = 'asked', 'a person records that the client was asked');
select pg_temp.check(projects.p13_mark_clarification_asked(:'c1', 'whatsapp', 'wa:out-78') = 'not_open', 'NEGATIVE: not twice');
select pg_temp.check(projects.p13_answer_design_clarification(:'c1', '', null, 'wa:msg-1') = 'answer_required', 'NEGATIVE: an empty answer is refused');
select pg_temp.check(projects.p13_answer_design_clarification(:'c1', 'yes', null, '') = 'evidence_required', 'NEGATIVE: an answer without where to read it is refused');
select pg_temp.check(projects.p13_answer_design_clarification(:'c1', 'yes', '[1]'::jsonb, 'wa:msg-1') = 'fields_must_be_an_object', 'NEGATIVE: structured fields must be an object');
select pg_temp.check(projects.p13_answer_design_clarification(:'c1', 'yes, guests can order', '{"guest_checkout": true}', 'wa:msg-1') = 'answered', 'the client''s answer is recorded with its source');
reset role;
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.screen_clarification_answered' and subject_id = :'F_id') = 1, 'it returns to design as an event');
select pg_temp.check((select answer_fields->>'guest_checkout' from projects.p13_design_clarifications where id = :'c1') = 'true', 'with the structured field');
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(projects.p13_mark_clarification_asked(:'c1', 'whatsapp', 'x') = 'not_authorized', 'NEGATIVE: a plain member cannot record asking');
reset role;
select pg_temp.as_user(:'ADM', :'ORG2', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p13_design_clarifications) = 0, 'NEGATIVE: another organization reads none of it');
reset role;

-- ═════════ P3-PM-030 design share reminders ═════════
set local session_replication_role = replica;
update projects.phase_three set state = 'client_review' where id = :'F_id';
insert into projects.client_design_shares (organization_id, project_id, phase_three_id, share_number, shared_options, option_count, channel, evidence_ref, shared_by, shared_at)
  values (:'ORG', :'P_id', :'F_id', 1, '[{"id":"x"}]', 1, 'whatsapp', 'wa:share-1', :'ADM', now() - interval '3 days') returning id \gset S1_
set local session_replication_role = origin;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select count(*) from projects.p13_design_shares_awaiting_decision(:'ORG')) = 1, 'a three-day-old share with no decision is due a reminder');
select pg_temp.check((select next_reminder_number from projects.p13_design_shares_awaiting_decision(:'ORG')) = 1, 'the first');
select pg_temp.check((select count(*) from projects.p13_design_shares_awaiting_decision(:'ORG', 96)) = 0, 'NEGATIVE: not before the configured window');
select pg_temp.check((select outcome from projects.p13_record_design_share_reminder(:'S1_id', 'whatsapp', '')) = 'evidence_required', 'NEGATIVE: a reminder needs its message reference');
select pg_temp.check((select reminder_number from projects.p13_record_design_share_reminder(:'S1_id', 'whatsapp', 'wa:rem-1')) = 1, 'reminder one is recorded');
select pg_temp.check((select count(*) from projects.p13_design_shares_awaiting_decision(:'ORG')) = 0, 'NEGATIVE: not again until the spacing has passed');
reset role;
update projects.p13_design_share_reminders set recorded_at = now() - interval '3 days' where share_id = :'S1_id';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select next_reminder_number from projects.p13_design_shares_awaiting_decision(:'ORG')) = 2, 'after the spacing, the second is due');
select pg_temp.check((select reminder_number from projects.p13_record_design_share_reminder(:'S1_id', 'email', 'em:rem-2')) = 2, 'reminder two is recorded');
reset role;
update projects.p13_design_share_reminders set recorded_at = now() - interval '9 days' where share_id = :'S1_id';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select count(*) from projects.p13_design_shares_awaiting_decision(:'ORG')) = 0, 'NEGATIVE: never a third reminder is due');
select pg_temp.check((select outcome from projects.p13_record_design_share_reminder(:'S1_id', 'email', 'em:rem-3')) = 'reminder_limit_reached', 'NEGATIVE: and a third cannot be recorded');
reset role;
-- an answered share is never chased
set local session_replication_role = replica;
insert into projects.client_design_shares (organization_id, project_id, phase_three_id, share_number, shared_options, option_count, channel, evidence_ref, shared_by, shared_at)
  values (:'ORG', :'P_id', :'F_id', 2, '[{"id":"y"}]', 1, 'whatsapp', 'wa:share-2', :'ADM', now() - interval '5 days') returning id \gset S2_
select pg_temp.as_service();
select pg_temp.check((select count(*) from projects.client_design_shares where phase_three_id = :'F_id') = 2, 'a second share exists');
insert into projects.client_design_decisions (organization_id, project_id, phase_three_id, share_id, decision, client_words, recorded_by)
  values (:'ORG', :'P_id', :'F_id', :'S2_id', 'clarification_required', 'which one is cheaper?', :'ADM');
set local session_replication_role = origin;
set local role service_role;
select pg_temp.check((select count(*) from projects.p13_design_shares_awaiting_decision(:'ORG')) = 0, 'NEGATIVE: a share the client answered is not chased');
select pg_temp.check((select outcome from projects.p13_record_design_share_reminder(:'S2_id', 'email', 'em:late')) = 'already_answered', 'NEGATIVE: a reminder for an answered share is refused');
reset role;

rollback;
\echo 'verify-p13-notifications-planning-and-design-clarification: all checks passed'
