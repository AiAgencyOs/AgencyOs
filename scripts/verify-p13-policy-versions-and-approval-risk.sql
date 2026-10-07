-- ═══════════════════════════════════════════════════════════════════════════
-- P1-BLUEPRINT-044/030/031, P1-QUOTE-018, P1-API-024, P1-BLUEPRINT-019/020: policy versions and approval risk / executed / verified.
-- Real doors, real triggers, scratch Postgres; rolls back.
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p13-policy-versions-and-approval-risk.sql
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
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;
create or replace function pg_temp.refused(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when restrict_violation then return true; end $$;
grant execute on function pg_temp.refused(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORG2 '00000000-0000-4000-8000-0000000013c2'
\set ADM '00000000-0000-4000-8000-000000013b01'
\set MEM '00000000-0000-4000-8000-000000013b02'

insert into auth.users (id, email) values (:'ADM', 'p13b-adm@example.test'), (:'MEM', 'p13b-mem@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'ADM', 'p13b-adm@example.test', 'P13B Admin'), (:'MEM', 'p13b-mem@example.test', 'P13B Member') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'ADM', 'ops_admin'), (:'ORG', :'MEM', 'member') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p13b other org', 'zztest-p13b-other') on conflict do nothing;

-- ═════════ policy versions ═════════
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;

select pg_temp.check((select outcome from core.p13_save_policy_draft('approval', '{"risk_thresholds_minor":{"medium":100000,"high":1000000,"critical":10000000}}', 'first approval policy')) = 'saved', 'an admin saves a draft');
select pg_temp.check((select version from core.p13_save_policy_draft('approval', '{"risk_thresholds_minor":{"medium":100000,"high":1000000,"critical":10000000}}', 'first approval policy, edited')) = 1, 'saving again edits the SAME draft (one draft per kind)');
select pg_temp.check((select count(*) from core.p13_policy_versions where policy_kind = 'approval' and status = 'draft') = 1, 'there is one draft');
select pg_temp.check((select outcome from core.p13_save_policy_draft('approval', '{"risk_thresholds_minor":{"medium":900,"high":100}}', 'bad')) like 'invalid_body%', 'NEGATIVE: thresholds that fall are refused');
select pg_temp.check((select outcome from core.p13_save_policy_draft('discount', '{"max_discount_pct":140}', 'bad')) like 'invalid_body%', 'NEGATIVE: a discount cap over 100 is refused');
select pg_temp.check((select outcome from core.p13_save_policy_draft('pricing', '{"minimum_price_minor":500,"autonomous_max_minor":100}', 'bad')) like 'invalid_body%', 'NEGATIVE: an autonomous maximum below the minimum price is refused');
select pg_temp.check((select outcome from core.p13_save_policy_draft('weather', '{}', 'x')) = 'invalid_kind', 'NEGATIVE: an unknown kind is refused');
select pg_temp.check((select outcome from core.p13_save_policy_draft('approval', '{}', '  ')) = 'summary_required', 'NEGATIVE: a summary is required');
select pg_temp.check((select outcome from core.p13_save_policy_draft('approval', '[]', 'x')) like 'invalid_body%', 'NEGATIVE: a body that is not an object is refused');
select id as v1 from core.p13_policy_versions where policy_kind = 'approval' and status = 'draft' \gset

select pg_temp.check((select outcome from core.p13_activate_policy_version(:'v1', '')) = 'reason_required', 'NEGATIVE: activation needs a reason');
select pg_temp.check((select outcome from core.p13_activate_policy_version(:'v1', 'agreed with the owner')) = 'activated', 'an admin activates it');
select pg_temp.check((select outcome from core.p13_activate_policy_version(:'v1', 'again')) = 'not_a_draft', 'NEGATIVE: an active version cannot be activated again');
select pg_temp.check((select count(*) from audit.audit_log where action = 'policy.version_activated' and subject_id = :'v1') = 1, 'activation is audited');
select pg_temp.check((select count(*) from core.outbox_events where type = 'policy.version_activated' and subject_id = :'v1') = 1, 'and announced as an event');

-- a second version supersedes the first; the first stays answerable for the moments it was in force
select pg_temp.check((select version from core.p13_save_policy_draft('approval', '{"risk_thresholds_minor":{"medium":5000,"high":50000,"critical":500000}}', 'tighter')) = 2, 'the next draft is version 2');
select id as v2 from core.p13_policy_versions where policy_kind = 'approval' and status = 'draft' \gset
select pg_temp.check((select superseded_id from core.p13_activate_policy_version(:'v2', 'tightening')) = :'v1', 'activation reports the version it superseded');
select pg_temp.check((select status from core.p13_policy_versions where id = :'v1') = 'superseded' and (select status from core.p13_policy_versions where id = :'v2') = 'active', 'one superseded, one active');
select pg_temp.check((select count(*) from core.p13_policy_versions where policy_kind = 'approval' and status = 'active') = 1, 'exactly one active per kind');
select pg_temp.check(core.p13_policy_version_in_force(:'ORG', 'approval') = :'v2', 'the version in force now is version 2');
select pg_temp.check(core.p13_policy_version_in_force(:'ORG', 'approval', (select activated_at - interval '1 microsecond' from core.p13_policy_versions where id = :'v2')) = :'v1',
  'a moment before version 2, version 1 was in force (history is answerable)');
select pg_temp.check(core.p13_policy_version_in_force(:'ORG', 'approval', (select activated_at - interval '1 day' from core.p13_policy_versions where id = :'v1')) is null, 'before any version there was none');

-- history is immutable
reset role;
select pg_temp.check(pg_temp.refused($q$update core.p13_policy_versions set body = '{"x":1}' where policy_kind = 'approval' and version = 1$q$), 'NEGATIVE: a superseded version''s body cannot be edited, even by the service role');
select pg_temp.check(pg_temp.refused($q$update core.p13_policy_versions set status = 'active' where policy_kind = 'approval' and version = 1$q$)
  or (select count(*) from core.p13_policy_versions where policy_kind = 'approval' and status = 'active') = 1, 'NEGATIVE: a superseded version cannot be re-activated by an update');
select pg_temp.check(pg_temp.refused($q$delete from core.p13_policy_versions where policy_kind = 'approval' and version = 2$q$), 'NEGATIVE: an active version cannot be deleted');
select pg_temp.check(pg_temp.refused($q$update core.p13_policy_versions set summary = 'rewritten' where policy_kind = 'approval' and version = 2$q$), 'NEGATIVE: an active version''s summary cannot be rewritten');

-- who may
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from core.p13_save_policy_draft('trust', '{}', 'x')) = 'not_authorized', 'NEGATIVE: a plain member cannot draft a policy');
select pg_temp.check((select count(*) from core.p13_policy_versions where policy_kind = 'approval') = 2, 'a member of the organization can read the history');
reset role;
select pg_temp.as_user(:'ADM', :'ORG2', 'ops_admin');
set local role authenticated;
select pg_temp.check((select count(*) from core.p13_policy_versions) = 0, 'NEGATIVE: another organization sees none of it');
reset role;
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.denied($q$select * from core.p13_save_policy_draft('trust', '{}', 'x')$q$), 'NEGATIVE: an agent / service principal (no user) holds no grant on the policy doors');
reset role;

-- discard a draft
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from core.p13_save_policy_draft('trust', '{"note":"x"}', 'a trust policy')) = 'saved', 'a trust draft is saved');
select id as vt from core.p13_policy_versions where policy_kind = 'trust' and status = 'draft' \gset
select pg_temp.check(core.p13_discard_policy_draft(:'vt') = 'discarded', 'a draft can be discarded');
select pg_temp.check(core.p13_discard_policy_draft(:'v2') = 'not_a_draft', 'NEGATIVE: an active version cannot be discarded');
reset role;

-- ═════════ approvals: risk, policy version, executed, verified ═════════
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p13b client') returning id \gset A_
-- amounts judged by version 2: medium 5000, high 50000, critical 500000
insert into approvals.approval_requests (organization_id, subject_type, subject_id, required_role, requested_by_type, state, amount_minor, sla_due_at)
  values (:'ORG', 'invoice', gen_random_uuid(), 'ops_admin', 'system', 'pending', 600000, now() + interval '1 day') returning id \gset R1_
insert into approvals.approval_requests (organization_id, subject_type, subject_id, required_role, requested_by_type, state, amount_minor, sla_due_at)
  values (:'ORG', 'invoice', gen_random_uuid(), 'ops_admin', 'system', 'pending', 100, now() + interval '1 day') returning id \gset R2_
insert into approvals.approval_requests (organization_id, subject_type, subject_id, required_role, requested_by_type, state, sla_due_at)
  values (:'ORG', 'agent_action', gen_random_uuid(), 'ops_admin', 'system', 'pending', now() + interval '1 day') returning id \gset R3_
select pg_temp.check((select risk_level from approvals.p13_approval_annotations where approval_request_id = :'R1_id') = 'critical', 'a 6,000 rupee request is critical under version 2');
select pg_temp.check((select policy_version_id from approvals.p13_approval_annotations where approval_request_id = :'R1_id') = :'v2', 'and records the policy version it was judged by');
select pg_temp.check((select risk_level from approvals.p13_approval_annotations where approval_request_id = :'R2_id') = 'low', 'a tiny request is low');
select pg_temp.check((select risk_level from approvals.p13_approval_annotations where approval_request_id = :'R3_id') = 'low', 'a request with no amount and no subject rule is low');

-- an org with no approval policy is honestly unrated
insert into approvals.approval_requests (organization_id, subject_type, subject_id, required_role, requested_by_type, state, amount_minor, sla_due_at)
  values (:'ORG2', 'invoice', gen_random_uuid(), 'ops_admin', 'system', 'pending', 600000, now() + interval '1 day') returning id \gset R4_
select pg_temp.check((select risk_level from approvals.p13_approval_annotations where approval_request_id = :'R4_id') = 'unrated'
                     and (select policy_version_id from approvals.p13_approval_annotations where approval_request_id = :'R4_id') is null, 'with no approval policy the risk is unrated, not invented');

-- a later policy does not rewrite an earlier judgement
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select version from core.p13_save_policy_draft('approval', '{"risk_thresholds_minor":{"medium":1,"high":2,"critical":3}}', 'v3')) = 3, 'version 3 is drafted');
select id as v3 from core.p13_policy_versions where policy_kind = 'approval' and status = 'draft' \gset
select pg_temp.check((select outcome from core.p13_activate_policy_version(:'v3', 'strict')) = 'activated', 'and activated');
reset role;
select pg_temp.check((select policy_version_id from approvals.p13_approval_annotations where approval_request_id = :'R1_id') = :'v2', 'the earlier request still names version 2');

-- a version scheduled for the future leaves the current one in force until it takes effect
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from core.p13_save_policy_draft('follow_up', '{"a":1}', 'fu v1')) = 'saved', 'a follow_up draft');
select id as f1 from core.p13_policy_versions where policy_kind = 'follow_up' and status = 'draft' \gset
select pg_temp.check((select outcome from core.p13_activate_policy_version(:'f1', 'first')) = 'activated', 'follow_up v1 active');
select pg_temp.check((select outcome from core.p13_save_policy_draft('follow_up', '{"a":2}', 'fu v2', now() + interval '3 days')) = 'saved', 'a follow_up v2 drafted for three days ahead');
select id as f2 from core.p13_policy_versions where policy_kind = 'follow_up' and status = 'draft' \gset
select pg_temp.check((select outcome from core.p13_activate_policy_version(:'f2', 'scheduled')) = 'activated', 'and activated now');
select pg_temp.check(core.p13_policy_version_in_force(:'ORG', 'follow_up') = :'f1', 'until its date, version 1 is still the one in force (no gap)');
select pg_temp.check(core.p13_policy_version_in_force(:'ORG', 'follow_up', now() + interval '4 days') = :'f2', 'after its date, version 2 is');
reset role;

-- risk override
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check(approvals.p13_set_approval_risk(:'R2_id', 'high', '') = 'reason_required', 'NEGATIVE: an override needs a reason');
select pg_temp.check(approvals.p13_set_approval_risk(:'R2_id', 'severe', 'x') = 'invalid_risk', 'NEGATIVE: an unknown level is refused');
select pg_temp.check(approvals.p13_set_approval_risk(:'R2_id', 'high', 'client is on a watch list') = 'set', 'an admin can raise the risk of a pending request');
select pg_temp.check((select risk_source from approvals.p13_approval_annotations where approval_request_id = :'R2_id') = 'admin', 'and the source says an admin did');

-- executed / verified
select pg_temp.check(approvals.p13_mark_approval_executed(:'R1_id', 'x') = 'not_approved', 'NEGATIVE: a pending request cannot be marked executed');
reset role;
update approvals.approval_requests set state = 'approved', decided_at = now() where id = :'R1_id';
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check(approvals.p13_set_approval_risk(:'R1_id', 'low', 'because') = 'already_decided', 'NEGATIVE: the risk of a decided request is frozen');
select pg_temp.check(approvals.p13_mark_approval_verified(:'R1_id', 'x') = 'not_executed', 'NEGATIVE: nothing can be verified before it is executed');
select pg_temp.check(approvals.p13_mark_approval_executed(:'R1_id', 'invoice issued by hand') = 'executed', 'an approved request can be marked executed');
select pg_temp.check(approvals.p13_mark_approval_executed(:'R1_id') = 'already_executed', 'NEGATIVE: not twice');
select pg_temp.check(approvals.p13_mark_approval_verified(:'R1_id', 'matches the approval') = 'verified', 'and then verified');
select pg_temp.check(approvals.p13_mark_approval_verified(:'R1_id') = 'already_verified', 'NEGATIVE: not twice');
select pg_temp.check((select count(*) from core.outbox_events where subject_id = :'R1_id' and type in ('approval.executed', 'approval.verified')) = 2, 'both are announced');
reset role;
select pg_temp.check((select executed_at is not null and verified_at >= executed_at from approvals.p13_approval_annotations where approval_request_id = :'R1_id'), 'the stamps are ordered');
select pg_temp.check((select executed_at is null from approvals.p13_approval_annotations where approval_request_id = :'R3_id'), 'approving or raising one never sets executed on another');
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check(approvals.p13_mark_approval_executed(:'R3_id') = 'not_authorized', 'NEGATIVE: a plain member cannot mark executed');
reset role;
select pg_temp.as_user(:'ADM', :'ORG2', 'ops_admin');
set local role authenticated;
select pg_temp.check(approvals.p13_mark_approval_executed(:'R1_id') = 'not_found', 'NEGATIVE: another organization cannot reach the request');
reset role;

rollback;
\echo 'verify-p13-policy-versions-and-approval-risk: all checks passed'
