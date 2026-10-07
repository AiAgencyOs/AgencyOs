-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 PM Agent doors (migration 20261126100000): prototype feedback classification and routing, the Designer redraft gate, exact-version shares with delivery
-- evidence, one-at-a-time clarification relay, durable escalations, the revision records read. Red-proofs mutate the live definitions.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p4q-pm.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
\ir p4q-verify-prelude.sql

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000000b5'
\set OWNER '00000000-0000-4000-8000-00000000f621'
\set OWNER2 '00000000-0000-4000-8000-00000000f622'
\set MEMBER '00000000-0000-4000-8000-00000000f623'

insert into auth.users (id, email) values (:'OWNER', 'p4qpm-owner@example.test'), (:'OWNER2', 'p4qpm-owner2@example.test'), (:'MEMBER', 'p4qpm-member@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p4qpm-owner@example.test', 'PM Owner'), (:'OWNER2', 'p4qpm-owner2@example.test', 'PM Owner Two'), (:'MEMBER', 'p4qpm-member@example.test', 'PM Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner'), (:'ORG', :'MEMBER', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p4qpm other org', 'zztest-p4qpm-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p4qpm client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p4qpm', 'ZP4QPM-1') returning id \gset P_

set local session_replication_role = replica;
insert into projects.phase_three_handoffs (organization_id, project_id, phase_three_id, screen_baseline_id, theme_option_id, color_option_id, client_decision_id, payload, phase_four_ready, readiness_note)
  values (:'ORG', :'P_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '{}', false, 'fixture') returning id \gset H_
insert into projects.phase_four (organization_id, project_id, phase_three_handoff_id, state) values (:'ORG', :'P_id', :'H_id', 'ui_review') returning id \gset F_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 1, 'client_change', now(), '[{"screenKey":"home"},{"screenKey":"list"}]') returning id \gset V1_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 2, 'admin_approved', now(), '[{"screenKey":"home"},{"screenKey":"list"},{"screenKey":"detail"}]') returning id \gset V2_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 3, 'client_change', now(), '[{"screenKey":"home"}]') returning id \gset V3_
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 4, 'client_change', now(), '[{"screenKey":"home"}]') returning id \gset V4_
insert into projects.ui_version_client_decisions (organization_id, project_id, ui_version_id, decision, client_words, recorded_by) values (:'ORG', :'P_id', :'V1_id', 'change_requested', 'The header colour is wrong, please make it match the logo.', :'OWNER') returning id \gset DEC1_
insert into projects.ui_version_client_decisions (organization_id, project_id, ui_version_id, decision, client_words, recorded_by) values (:'ORG', :'P_id', :'V3_id', 'change_requested', 'Also add a whole loyalty programme with points.', :'OWNER') returning id \gset DEC3_
insert into projects.ui_version_client_decisions (organization_id, project_id, ui_version_id, decision, client_words, recorded_by) values (:'ORG', :'P_id', :'V4_id', 'change_requested', 'Not sure, something feels off.', :'OWNER') returning id \gset DEC4_
insert into projects.client_feedback_classifications (organization_id, decision_id, classification, reasoning) values (:'ORG', :'DEC1_id', 'CORRECTION', 'a colour fix'), (:'ORG', :'DEC3_id', 'POSSIBLE_SCOPE_CHANGE', 'a new feature');
-- prototype deliverables: one QA-passed and Admin-approved, one not
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 1, 'zztest build 1') returning id \gset D1_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'prototype', 2, 'zztest build 2') returning id \gset D2_
insert into projects.deliverables (organization_id, project_id, kind, version, title) values (:'ORG', :'P_id', 'document', 1, 'zztest doc') returning id \gset DD_
insert into projects.prototype_artifacts (organization_id, project_id, ui_version_id, deliverable_id, screens, status, qa_reviewed_at, created_at) values
  (:'ORG', :'P_id', :'V2_id', :'D1_id', '[{"screenKey":"home","elements":[{"type":"button","label":"Go","navigatesTo":"list"}]},{"screenKey":"list","elements":[{"type":"text","label":"x"}]}]', 'qa_pass', now(), now() - interval '2 days'),
  (:'ORG', :'P_id', :'V2_id', :'D2_id', '[{"screenKey":"home","elements":[{"type":"text","label":"x"}]}]', 'qa_changes_required', now(), now() - interval '1 day');
insert into projects.deliverable_details (deliverable_id, organization_id, project_id, admin_status, admin_decided_at) values (:'D1_id', :'ORG', :'P_id', 'approved', now()), (:'D2_id', :'ORG', :'P_id', 'approved', now());
set local session_replication_role = origin;
insert into fx values ('P', :'P_id'), ('ORG', :'ORG'), ('OWNER', :'OWNER'), ('MEMBER', :'MEMBER'), ('DEC3', :'DEC3_id'), ('DEC4', :'DEC4_id'), ('V1', :'V1_id'), ('V2', :'V2_id'), ('D1', :'D1_id'), ('D2', :'D2_id'), ('DD', :'DD_id');

-- ═══ the Designer redraft gate ═════════════════════════════════════════════
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p4q_decide_designer_revision(:'DEC4_id')) = 'awaiting_classification', 'feedback the PM has not classified does not activate the Designer');
select pg_temp.check((select allowed from projects.p4q_decide_designer_revision(:'DEC1_id', 'client_change')) is true, 'a CORRECTION activates the Designer');
select pg_temp.check((select outcome from projects.p4q_decide_designer_revision(:'DEC1_id')) = 'already_decided', 'the decision is recorded once');
select pg_temp.check((select allowed from projects.p4q_decide_designer_revision(:'DEC3_id')) is false and (select reason from projects.p4q_decide_designer_revision(:'DEC3_id')) like 'Possible new scope%', 'POSSIBLE_SCOPE_CHANGE does not reach the Designer first');
select pg_temp.check((select activation_reason from projects.p4q_designer_routing_decisions where decision_id = :'DEC1_id') = 'client_change', 'the activation reason is recorded');
select pg_temp.check((select outcome from projects.p4q_decide_designer_revision(:'DEC4_id', 'because')) = 'bad_activation_reason', 'an unnamed activation reason is refused');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select outcome from projects.p4q_decide_designer_revision(:'DEC4_id')) = 'forbidden', 'another organisation cannot route this project''s feedback');

-- ═══ prototype feedback: classified against the exact build and routed ═════
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p4q_classify_prototype_feedback(:'DD_id', 'k1', 'x', 'CORRECTION', 'y')) = 'not_a_prototype', 'only a prototype deliverable is classified here');
select pg_temp.check((select outcome from projects.p4q_classify_prototype_feedback(:'D1_id', 'k1', 'Make the Go button bigger', 'NONSENSE', 'y')) = 'bad_classification', 'an unknown label is refused');
select pg_temp.check((select routed_to from projects.p4q_classify_prototype_feedback(:'D1_id', 'k1', 'Make the Go button bigger', 'CORRECTION', 'a size fix')) = 'prototype_revision', 'a CORRECTION is routed to a prototype revision');
select pg_temp.check(projects.p4q_prototype_revision_allowed(:'D1_id', 'k1') is true and projects.p4q_prototype_revision_allowed(:'D1_id', 'never-classified') is false, 'a rebuild is allowed only for classified correction feedback');
select pg_temp.check((select outcome from projects.p4q_classify_prototype_feedback(:'D1_id', 'k1', 'again', 'CORRECTION', 'again')) = 'already_classified', 'a replayed feedback is not classified twice');
select pg_temp.check((select client_words from projects.p4q_prototype_feedback_classifications where decision_key = 'k1') = 'Make the Go button bigger', 'the client''s own words are stored verbatim');
-- scope change with NO active scope: a person is told, not silently dropped
select routed_to as r2 from projects.p4q_classify_prototype_feedback(:'D1_id', 'k2', 'Add a loyalty programme', 'POSSIBLE_SCOPE_CHANGE', 'new feature') \gset
select pg_temp.check(:'r2' = 'escalation'
  and (select count(*) from projects.p4q_escalations where project_id = :'P_id' and cause = 'scope_change_without_baseline' and state = 'open') = 1, 'possible new scope with no baseline opens an escalation instead of vanishing');
insert into projects.scope_versions (organization_id, project_id, version, status, frozen_at, source) values (:'ORG', :'P_id', 1, 'active', now(), 'onboarding');
select routed_to as r3 from projects.p4q_classify_prototype_feedback(:'D1_id', 'k3', 'Add a points system', 'POSSIBLE_SCOPE_CHANGE', 'new feature') \gset
select pg_temp.check(:'r3' = 'change_request'
  and (select count(*) from projects.change_requests where project_id = :'P_id' and requested = 'Add a points system') = 1, 'possible new scope with a baseline becomes a change request, not a rebuild');
select pg_temp.check((select revision_allowed from projects.p4q_prototype_feedback_classifications where decision_key = 'k3') is false, 'a scope change does not allow the rebuild');
select routed_to as r4 from projects.p4q_classify_prototype_feedback(:'D1_id', 'k4', 'What does Go do exactly?', 'CLARIFICATION', 'a question') \gset
select pg_temp.check(:'r4' = 'clarification'
  and (select count(*) from projects.clarification_requests where project_id = :'P_id' and question = 'What does Go do exactly?') = 1, 'a clarification becomes a clarification request');
select routed_to as r5 from projects.p4q_classify_prototype_feedback(:'D1_id', 'k5', 'Start over with another style', 'DESIGN_DIRECTION_CHANGE', 'direction') \gset
select pg_temp.check(:'r5' = 'escalation'
  and (select count(*) from projects.p4q_escalations where cause = 'design_direction_change' and project_id = :'P_id') = 1, 'a direction change is escalated to a person');

-- ═══ escalations ═══════════════════════════════════════════════════════════
select pg_temp.as_service();
select e.escalation_id as esc1 from projects.p4q_open_escalation(:'P_id', 'revision_limit', 'The client used all three UI rounds', 'admin', 'ui_version', :'V1_id', 'project_manager') e \gset
select pg_temp.check((select outcome from projects.p4q_open_escalation(:'P_id', 'revision_limit', 'The client used all three UI rounds', 'admin', 'ui_version', :'V1_id')) = 'already_open', 'one open escalation per cause and subject');
select pg_temp.check((select outcome from projects.p4q_open_escalation(:'P_id', 'revision_limit', 'x')) = 'reason_required', 'an escalation says why');
select pg_temp.check((select outcome from projects.p4q_open_escalation(:'P_id', 'nonsense', 'a reason that is long enough')) = 'invalid', 'an unknown cause is refused');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p4q_resolve_escalation(:'esc1', 'continue', 'ok then, continuing')) = 'not_authorized', 'a plain member cannot resolve an escalation');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from projects.p4q_resolve_escalation(:'esc1', 'continue', 'no')) = 'note_required', 'a resolution needs a note');
select pg_temp.check((select outcome from projects.p4q_resolve_escalation(:'esc1', 'continue', 'Owner approved one extra round, billed')) = 'resolved', 'a person resolves with a decision');
select pg_temp.check((select outcome from projects.p4q_resolve_escalation(:'esc1', 'stop', 'second try at deciding')) = 'already_settled', 'a settled escalation stays settled');
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p4q_open_escalation(:'P_id', 'revision_limit', 'Again, a new round hit the limit', 'admin', 'ui_version', :'V1_id')) = 'opened', 'a new escalation can open once the old one is settled');

-- ═══ shares: the exact approved version, with delivery evidence ═════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from projects.p4q_record_client_review_share('ui_version', :'V1_id', 'whatsapp')) = 'not_admin_approved', 'a version the Admin has not approved is not shared');
select s.share_id as sh1 from projects.p4q_record_client_review_share('ui_version', :'V2_id', 'whatsapp') s \gset
select pg_temp.check(:'sh1' is not null and (select instructions from projects.p4q_client_review_shares where id = :'sh1') like 'Please review version 2%', 'the approved version is shared with instructions naming it');
select pg_temp.check((select outcome from projects.p4q_record_client_review_share('ui_version', :'V2_id', 'whatsapp')) = 'already_shared', 'a share is recorded once per channel');
select pg_temp.check((select outcome from projects.p4q_mark_share_delivery(:'sh1', 'sent')) = 'evidence_required', 'a send without evidence is not recorded as sent');
select outcome as o1 from projects.p4q_mark_share_delivery(:'sh1', 'unknown', 'provider timed out after the request') \gset
select pg_temp.check(:'o1' = 'updated' and (select delivery_state from projects.p4q_client_review_shares where id = :'sh1') = 'unknown', 'an uncertain delivery is recorded as unknown');
select pg_temp.check((select outcome from projects.p4q_mark_share_delivery(:'sh1', 'delivered', 'message id wamid.123 confirmed by the provider')) = 'updated', 'unknown is reconciled to delivered with evidence');
select pg_temp.check((select outcome from projects.p4q_mark_share_delivery(:'sh1', 'pending')) = 'bad_transition', 'a delivered share cannot go back to pending');
select s.share_id as sh2 from projects.p4q_record_client_review_share('ui_version', :'V2_id', 'email', 'Please review the design and reply with your changes.') s \gset
select outcome as o2 from projects.p4q_mark_share_delivery(:'sh2', 'failed', 'bounced: mailbox full') \gset
select outcome as o3 from projects.p4q_mark_share_delivery(:'sh2', 'pending') \gset
select pg_temp.check(:'o2' = 'updated' and :'o3' = 'updated'
  and (select retry_count from projects.p4q_client_review_shares where id = :'sh2') = 1, 'a failed send retried counts the retry');
select pg_temp.check((select outcome from projects.p4q_record_client_review_share('prototype_build', :'D2_id', 'portal')) = 'not_qa_passed', 'a build QA has not passed is not shared');
select pb.share_id as sh3 from projects.p4q_record_client_review_share('prototype_build', :'D1_id', 'portal') pb \gset
select pg_temp.check((select instructions from projects.p4q_client_review_shares where id = :'sh3') like 'Open the prototype on the "home" screen. It has 2 screens and 1 links%', 'the prototype share carries simple test instructions built from the exact build');
select pg_temp.as_user(:'MEMBER', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p4q_record_client_review_share('ui_version', :'V2_id', 'portal')) = 'not_authorized', 'a plain member cannot record a share');

-- ═══ clarification: one at a time, in the client's words, answer returns ════
select pg_temp.as_service();
select c.clarification_id as cl1 from projects.p4q_raise_clarification(:'P_id', :'V2_id', 'Which brand colour is canonical: logo or deck?', 'Which colour should we treat as your main brand colour?', 'ui_designer') c \gset
select c.clarification_id as cl2 from projects.p4q_raise_clarification(:'P_id', :'V2_id', 'Is the detail screen for staff or clients?', 'Who will open the detail screen: your staff or your customers?', 'quality_assurance') c \gset
select pg_temp.check((select outcome from projects.p4q_raise_clarification(:'P_id', :'V2_id', 'Is the detail screen for staff or clients?', 'Who will open the detail screen: your staff or your customers?', 'quality_assurance')) = 'already_open', 'the same open question is not raised twice');
select pg_temp.check((select outcome from projects.p4q_raise_clarification(:'P_id', null, 'q?', 'a client wording here', 'finance')) = 'bad_source', 'only the Phase 4 agents raise clarifications');
select pg_temp.check((select clarification_id from projects.p4q_relay_next_clarification(:'P_id')) = :'cl1', 'the oldest question is relayed first');
select pg_temp.check((select outcome from projects.p4q_relay_next_clarification(:'P_id')) = 'one_at_a_time', 'the next question waits for the answer');
update projects.clarification_requests set status = 'answered', answer = 'The logo colour is canonical', answered_at = now() where id = :'cl1';
select pg_temp.check((select relay_state from projects.p4q_clarification_relays where clarification_id = :'cl1') = 'answered', 'the answer closes the relay');
select pg_temp.check((select payload ->> 'raisedBy' from core.outbox_events where subject_id = :'cl1' and type = 'project.p4q_clarification_answered') = 'ui_designer', 'the answer event names the agent that asked, so it goes back to it');
select pg_temp.check((select clarification_id from projects.p4q_relay_next_clarification(:'P_id')) = :'cl2', 'now the second question is relayed');

-- ═══ the revision records read ═════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select origin from projects.p4q_revision_records(:'P_id') where artifact_kind = 'ui_version' and from_version = 1) = 'CLIENT'
  and (select affected_screens from projects.p4q_revision_records(:'P_id') where artifact_kind = 'ui_version' and from_version = 1) = array['detail'], 'the UI revision names its origin and the screens it changed');
select pg_temp.check((select classification from projects.p4q_revision_records(:'P_id') where artifact_kind = 'ui_version' and from_version = 1) = 'CORRECTION', 'the revision record carries the classification');
select pg_temp.check((select count(*) from projects.p4q_revision_records(:'P_id') where artifact_kind = 'prototype_build') = 1, 'the prototype build revision is listed');
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
select pg_temp.check((select count(*) from projects.p4q_revision_records(:'P_id')) = 0, 'another organisation reads no revision records');

-- ═══ no direct writes ══════════════════════════════════════════════════════
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
set local role authenticated;
select pg_temp.check(pg_temp.direct('insert into projects.p4q_client_review_shares (organization_id, project_id, kind, ui_version_id, channel, instructions) values (gen_random_uuid(), gen_random_uuid(), ''ui_version'', gen_random_uuid(), ''portal'', ''0123456789'')') = 'refused', 'a share cannot be inserted directly');
select pg_temp.check(pg_temp.direct('update projects.p4q_escalations set state = ''resolved''') = 'refused', 'an escalation cannot be closed by a direct statement');
select pg_temp.check(pg_temp.direct('update projects.p4q_client_review_shares set delivery_state = ''delivered''') = 'refused', 'delivery cannot be edited to delivered');
select pg_temp.check((select count(*) from projects.p4q_escalations) >= 3, 'staff read the escalations');
reset role;
select pg_temp.as_nobody();

-- ═══ RED-PROOFS ════════════════════════════════════════════════════════════
set local session_replication_role = replica;
insert into projects.ui_versions (organization_id, project_id, phase_four_id, source_phase_three_handoff_id, version, status, qa_reviewed_at, screens) values
  (:'ORG', :'P_id', :'F_id', :'H_id', 5, 'client_change', now(), '[{"screenKey":"home"}]') returning id \gset V5_
insert into projects.ui_version_client_decisions (organization_id, project_id, ui_version_id, decision, client_words, recorded_by) values (:'ORG', :'P_id', :'V5_id', 'change_requested', 'Add payments and subscriptions.', :'OWNER') returning id \gset DEC5_
insert into projects.client_feedback_classifications (organization_id, decision_id, classification, reasoning) values (:'ORG', :'DEC5_id', 'POSSIBLE_SCOPE_CHANGE', 'a new feature');
set local session_replication_role = origin;
insert into fx values ('DEC5', :'DEC5_id');
select pg_temp.red('new scope reaches the Designer', 'projects.p4q_decide_designer_revision(uuid,text)', 'v_ok := v_class in (''CORRECTION'', ''INCLUDED_REVISION'');', 'v_ok := true;',
  $p$ select (pg_temp.as_service() is not null) and (select allowed from projects.p4q_decide_designer_revision(pg_temp.fx('DEC5'))) is false $p$);
select pg_temp.red('the Designer is activated before the PM classified', 'projects.p4q_decide_designer_revision(uuid,text)', 'if v_class is null then return query', 'if false then return query',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_decide_designer_revision(pg_temp.fx('DEC4'))) = 'awaiting_classification' $p$);
select pg_temp.red('a scope change allows the prototype rebuild', 'projects.p4q_classify_prototype_feedback(uuid,text,text,text,text)',
  'if p_classification in (''CORRECTION'', ''INCLUDED_REVISION'') then', 'if true then',
  $p$ select (pg_temp.as_service() is not null) and (select revision_allowed from projects.p4q_classify_prototype_feedback(pg_temp.fx('D2'), 'rp1', 'Add a chat feature', 'POSSIBLE_SCOPE_CHANGE', 'new feature')) is false $p$);
select pg_temp.red('an unapproved version is shared', 'projects.p4q_record_client_review_share(text,uuid,text,text)', 'if v_ui.status not in (''admin_approved'', ''client_review'') then', 'if false then',
  $p$ select (pg_temp.as_user(pg_temp.fx('OWNER'), pg_temp.fx('ORG'), 'owner') is not null) and (select outcome from projects.p4q_record_client_review_share('ui_version', pg_temp.fx('V1'), 'portal')) = 'not_admin_approved' $p$);
select pg_temp.red('a build QA has not passed is shared', 'projects.p4q_record_client_review_share(text,uuid,text,text)', 'if v_art.id is null or v_art.status <> ''qa_pass'' then', 'if false then',
  $p$ select (pg_temp.as_user(pg_temp.fx('OWNER'), pg_temp.fx('ORG'), 'owner') is not null) and (select outcome from projects.p4q_record_client_review_share('prototype_build', pg_temp.fx('D2'), 'portal')) = 'not_qa_passed' $p$);
select pg_temp.red('a delivery is recorded without evidence', 'projects.p4q_mark_share_delivery(uuid,text,text)', 'if p_state in (''sent'', ''delivered'', ''unknown'', ''failed'') and v_ev is null then', 'if false then',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_mark_share_delivery((select id from projects.p4q_client_review_shares where delivery_state = 'pending' limit 1), 'sent')) = 'evidence_required' $p$);
select pg_temp.red('two questions are relayed at once', 'projects.p4q_relay_next_clarification(uuid)', 'if exists (select 1 from projects.p4q_clarification_relays r where r.project_id = p_project_id and r.relay_state = ''sent'')', 'if false',
  $p$ select (pg_temp.as_service() is not null) and (select outcome from projects.p4q_relay_next_clarification(pg_temp.fx('P'))) = 'one_at_a_time' $p$);
select pg_temp.red('an agent resolves its own escalation', 'projects.p4q_resolve_escalation(uuid,text,text)', 'if not coalesce((select core.can_manage_delivery()), false) then', 'if false then',
  $p$ select (pg_temp.as_user(pg_temp.fx('MEMBER'), pg_temp.fx('ORG'), 'member') is not null) and (select outcome from projects.p4q_resolve_escalation((select id from projects.p4q_escalations where state = 'open' limit 1), 'continue', 'a long enough note')) = 'not_authorized' $p$);

rollback;
\echo ALL P4Q PM CHECKS PASSED
