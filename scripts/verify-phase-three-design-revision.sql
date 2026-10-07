-- ═══════════════════════════════════════════════════════════════════════════
-- P3-UID-015 / P3-PM-014: a Phase 3 design revision is OPENED for an Admin EDIT / internal changes_required, then DELIVERED as a new version.
-- Driven through the real doors (open_internal_design_revision, deliver_design_revision) on a scratch Postgres; rolls back.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase-three-design-revision.sql
--
-- Fixture rows (a phase_three, theme options, a review and an Admin decision) are inserted directly with FK checks relaxed for that statement only: this
-- file tests the two new doors, not the earlier ones. Everything is scoped to one project of one organization.
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
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.fails_with(text, text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set OWNER '00000000-0000-4000-8000-00000000f531'
\set ORG2 '00000000-0000-4000-8000-0000000000b2'
\set OWNER2 '00000000-0000-4000-8000-00000000f532'

insert into auth.users (id, email) values (:'OWNER', 'p3rev-owner@example.test'), (:'OWNER2', 'p3rev-owner2@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OWNER', 'p3rev-owner@example.test', 'P3 Rev Owner'), (:'OWNER2', 'p3rev-owner2@example.test', 'P3 Rev Owner Two') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'OWNER', 'owner') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'ORG2', 'zztest p3rev other org', 'zztest-p3rev-other') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG2', :'OWNER2', 'owner') on conflict do nothing;

insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p3rev client') returning id \gset A_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p3rev', 'ZP3-REV') returning id \gset P_

set local session_replication_role = replica;
insert into projects.phase_two (organization_id, project_id, handoff_id) values (:'ORG', :'P_id', gen_random_uuid()) returning id \gset T2_
insert into projects.phase_three (organization_id, project_id, phase_two_id, state) values (:'ORG', :'P_id', :'T2_id', 'waiting_designer') returning id \gset F_
insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version, admin_status, internal_review_status)
  values (:'ORG', :'P_id', :'F_id', 1, 'Calm', 'quiet and airy', 'ctx-1', 'edit_requested', 'changes_required') returning id \gset O1_
insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version)
  values (:'ORG', :'P_id', :'F_id', 2, 'Bold', 'loud and warm', 'ctx-1') returning id \gset O2_
insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version, admin_status, client_status, internal_review_status)
  values (:'ORG', :'P_id', :'F_id', 3, 'Mono', 'black and white', 'ctx-1', 'in_review', 'not_shared', 'changes_required') returning id \gset O3_
insert into projects.color_options (organization_id, theme_option_id, option_index, palette_name, primary_hex) values (:'ORG', :'O1_id', 1, 'Calm blue', '#336699');
insert into projects.design_reviews (organization_id, theme_option_id, option_version, result, reviewer_user_id, comments)
  values (:'ORG', :'O1_id', 1, 'changes_required', :'OWNER', 'headings too light') returning id \gset REV_
insert into projects.admin_design_decisions (organization_id, theme_option_id, option_version, decision, reason, decided_by, design_review_id)
  values (:'ORG', :'O1_id', 1, 'edit', 'darken the headings and enlarge the logo', :'OWNER', :'REV_id') returning id \gset DEC_
insert into projects.design_reviews (organization_id, theme_option_id, option_version, result, reviewer_user_id, comments)
  values (:'ORG', :'O3_id', 1, 'changes_required', :'OWNER', 'too stark for a children''s brand');
set local session_replication_role = origin;
select set_config('rev.p', :'P_id', false);
select set_config('rev.f', :'F_id', false);

-- 1. an Admin EDIT becomes a revision record, spends no client round, cites its source
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.open_internal_design_revision(:'O1_id')) = 'opened', 'an Admin EDIT opens a design revision');
reset role;
select id as "R1_id" from projects.design_revisions where from_theme_option_id = :'O1_id' \gset
select pg_temp.check((select origin from projects.design_revisions where id = :'R1_id') = 'admin_edit', 'its origin is admin_edit');
select pg_temp.check((select requested_changes from projects.design_revisions where id = :'R1_id') = 'darken the headings and enlarge the logo', 'it carries the Admin''s own words');
select pg_temp.check((select admin_decision_id from projects.design_revisions where id = :'R1_id') = :'DEC_id' and (select design_review_id from projects.design_revisions where id = :'R1_id') = :'REV_id', 'it cites the decision and the review it came from');
select pg_temp.check((select round_number from projects.design_revisions where id = :'R1_id') is null and (select client_revision_count from projects.phase_three where id = :'F_id') = 0, 'no client round was spent (PM section 9)');
select pg_temp.check((select state from projects.phase_three where id = :'F_id') = 'revision', 'the phase follows: revision');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.design_revision_opened' and subject_id = :'R1_id'), 'DesignRevisionOpened was emitted');

-- 2. a redelivered event returns the round it already opened
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.open_internal_design_revision(:'O1_id')) = 'exists', 'a replay returns the open round');
select pg_temp.check((select outcome from projects.open_internal_design_revision(:'O2_id')) = 'not_returned', 'an option nobody sent back opens no revision');
reset role;
select pg_temp.check((select count(*) from projects.design_revisions where phase_three_id = :'F_id') = 1, 'exactly one revision exists');

-- 3. another organization cannot open or deliver
select pg_temp.as_user(:'OWNER2', :'ORG2', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.open_internal_design_revision(:'O3_id')) = 'forbidden', 'NEGATIVE: another organization is forbidden');
select pg_temp.check((select outcome from projects.deliver_design_revision(:'R1_id', 'Calm 2', 'darker headings')) = 'forbidden', 'NEGATIVE: another organization cannot deliver');
reset role;

-- 4. the designer delivers: a NEW version, the old one untouched, no fourth direction
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.deliver_design_revision(:'R1_id', '   ', 'x')) = 'bad_name', 'a nameless direction is refused');
select pg_temp.check((select outcome from projects.deliver_design_revision(:'R1_id', 'Calm, darker', 'quiet and airy with darker headings and a larger logo', '{"typography":"serif"}')) = 'delivered', 'the designer delivers the revision');
reset role;
select to_theme_option_id as "N1_id" from projects.design_revisions where id = :'R1_id' \gset
select pg_temp.check((select status from projects.design_revisions where id = :'R1_id') = 'delivered' and :'N1_id' is not null, 'the revision is delivered and names its answer');
select pg_temp.check((select version from projects.theme_options where id = :'N1_id') = 2 and (select revision_of from projects.theme_options where id = :'N1_id') = :'O1_id' and (select origin from projects.theme_options where id = :'N1_id') = 'admin_edit', 'the answer is version 2 of option 1, origin admin_edit');
select pg_temp.check((select option_index from projects.theme_options where id = :'N1_id') = 1, 'it keeps its option index');
select pg_temp.check((select version from projects.theme_options where id = :'O1_id') = 1 and (select name from projects.theme_options where id = :'O1_id') = 'Calm' and (select admin_status from projects.theme_options where id = :'O1_id') = 'edit_requested', 'the earlier version is untouched (Designer section 20)');
select pg_temp.check((select internal_review_status || '/' || admin_status || '/' || client_status from projects.theme_options where id = :'N1_id') = 'draft/not_submitted/not_shared', 'every gate restarts on the new version');
select pg_temp.check((select count(*) from projects.theme_options where phase_three_id = :'F_id' and revision_of is null) = 3, 'a revision is not a fourth direction');
select pg_temp.check((select count(*) from projects.color_options where theme_option_id = :'N1_id' and primary_hex = '#336699' and client_status = 'not_shared') = 1, 'the palette carries over as an unshared draft');
select pg_temp.check((select state from projects.phase_three where id = :'F_id') = 'internal_review', 'the phase restarts at internal review');
select pg_temp.check(exists (select 1 from core.outbox_events where type = 'project.design_revision_delivered' and subject_id = :'R1_id'), 'DesignRevisionDelivered was emitted');

-- 5. replays and refusals
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome || ':' || theme_option_id::text from projects.deliver_design_revision(:'R1_id', 'Again', 'again')) = 'already_delivered:' || :'N1_id', 'a replayed delivery returns the first answer');
reset role;
select pg_temp.check((select count(*) from projects.theme_options where revision_of = :'O1_id') = 1, 'the replay created nothing');

-- the ceiling still holds for directions: a fourth ORIGINAL direction is refused
select pg_temp.check(pg_temp.fails_with(format($q$insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version)
  values (%L, %L, %L, 4, 'Fourth', 'one too many', 'ctx-1')$q$, :'ORG', :'P_id', :'F_id'), '23514'), 'NEGATIVE: a fourth original direction is still refused');

-- the ceiling counts DIRECTIONS only: two directions plus one revision of the first leave room for a third direction (context ctx-2)
insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version)
  values (:'ORG', :'P_id', :'F_id', 1, 'C2-A', 'a', 'ctx-2') returning id \gset C2A_
insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version)
  values (:'ORG', :'P_id', :'F_id', 2, 'C2-B', 'b', 'ctx-2');
insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version, revision_of, version)
  values (:'ORG', :'P_id', :'F_id', 1, 'C2-A v2', 'a2', 'ctx-2', :'C2A_id', 2);
create or replace function pg_temp.succeeds(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return true; exception when others then return false; end $$;
grant execute on function pg_temp.succeeds(text) to public;
select pg_temp.check(pg_temp.succeeds(format($q$insert into projects.theme_options (organization_id, project_id, phase_three_id, option_index, name, direction_summary, source_context_version)
  values (%L, %L, %L, 3, 'C2-C', 'c', 'ctx-2')$q$, :'ORG', :'P_id', :'F_id')), 'two directions and a revision leave room for the third direction');

-- a locked option cannot be revised away
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.open_internal_design_revision(:'O3_id')) = 'opened', 'option 3 (internal changes_required) opens an internal revision');
reset role;
select id as "R3_id" from projects.design_revisions where from_theme_option_id = :'O3_id' \gset
update projects.theme_options set admin_status = 'approved', client_status = 'locked' where id = :'O3_id';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.deliver_design_revision(:'R3_id', 'Mono 2', 'x again')) = 'option_locked', 'NEGATIVE: a locked option cannot be overwritten by a revision');
reset role;

-- an escalated phase answers nothing
update projects.phase_three set state = 'revision_limit_escalation', blocked_reason = 'verifier: the limit was reached' where id = :'F_id';
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.open_internal_design_revision(:'O2_id')) = 'phase_stopped', 'NEGATIVE: an escalated phase opens no revision');
select pg_temp.check((select outcome from projects.deliver_design_revision(:'R3_id', 'Mono 3', 'again please')) = 'phase_stopped', 'NEGATIVE: an escalated phase delivers no revision');
reset role;

-- an anonymous caller is nobody
select set_config('request.jwt.claims', '{}', true);
set local role anon;
select pg_temp.check(pg_temp.fails_with($q$select * from projects.open_internal_design_revision('00000000-0000-4000-8000-000000000099')$q$, '42501'), 'NEGATIVE: anon has no execute on the opening door');
reset role;

rollback;
\echo 'verify-phase-three-design-revision: all checks passed'
