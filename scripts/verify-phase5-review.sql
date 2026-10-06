-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 human doors: a person decides what an agent draft becomes. A test case draft is accepted or rejected by someone who manages delivery
-- (and that records the decision only: it never becomes a test, a run or a result); a documentation draft is promoted only by an Admin, only through
-- the existing evidence rules, and a rejected one is deprecated, never deleted.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-phase5-review.sql      (rolls back)
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
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
grant execute on function pg_temp.refused(text, text) to public;
create or replace function pg_temp.denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.denied(text) to public;
create or replace function pg_temp.draft_status(p_id uuid) returns text language sql as $$ select status from projects.test_case_drafts where id = p_id $$;
grant execute on function pg_temp.draft_status(uuid) to public;
create or replace function pg_temp.doc_status(p_id uuid) returns text language sql as $$ select status from projects.technical_documents where id = p_id $$;
grant execute on function pg_temp.doc_status(uuid) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000c7'
\set ADM '00000000-0000-4000-8000-00000000e581'
\set DL '00000000-0000-4000-8000-00000000e582'
\set MEM '00000000-0000-4000-8000-00000000e583'
\set UB '00000000-0000-4000-8000-00000000e584'
insert into core.organizations (id, name, slug) values (:'ORGB', 'P5RV Other Agency', 'p5rv-other-agency') on conflict do nothing;
insert into auth.users (id, email) values (:'ADM', 'p5rv-admin@example.test'), (:'DL', 'p5rv-lead@example.test'), (:'MEM', 'p5rv-member@example.test'), (:'UB', 'p5rv-b@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'ADM', 'p5rv-admin@example.test', 'P5RV Admin'), (:'DL', 'p5rv-lead@example.test', 'P5RV Lead'), (:'MEM', 'p5rv-member@example.test', 'P5RV Member'), (:'UB', 'p5rv-b@example.test', 'P5RV B') on conflict do nothing;
insert into core.memberships (organization_id, user_id, role) values (:'ORG', :'ADM', 'ops_admin'), (:'ORG', :'DL', 'delivery_lead'), (:'ORG', :'MEM', 'member'), (:'ORGB', :'UB', 'owner') on conflict do nothing;
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p5rv client') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest p5rv client b') returning id \gset AB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p5rv', 'ZP5-RV') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'AB_id', 'zztest p5rv other', 'ZP5-RVB') returning id \gset PB_
insert into projects.tasks (organization_id, project_id, title, status, acceptance_criteria) values (:'ORG', :'P_id', 'zztest rv t1', 'todo', 'the customer can pay') returning id \gset T1_

-- agent drafts, made through the real service-only doors
select pg_temp.as_service();
set local role service_role;
select pg_temp.check((select outcome from projects.record_test_case_draft(:'T1_id', 'pays by card', 'e2e', 'a card payment succeeds', '["open checkout","pay"]'::jsonb, 'an order exists')) = 'recorded', 'the agent leaves a test case draft');
select pg_temp.check((select outcome from projects.record_test_case_draft(:'T1_id', 'refunds', 'api', 'a refund returns money', '[]'::jsonb, 'money returns')) = 'recorded', 'a second test case draft');
select pg_temp.check((select outcome from projects.record_test_case_draft(:'T1_id', 'declines', 'api', 'a declined card shows an error', '[]'::jsonb, 'an error shows')) = 'recorded', 'a third test case draft');
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'architecture', 'zztest architecture', 'the system has a web app')) = 'recorded', 'the agent leaves a documentation draft');
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'api', 'zztest api', 'GET /orders')) = 'recorded', 'a second documentation draft');
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'database', 'zztest database', 'orders table')) = 'recorded', 'a third documentation draft');
select pg_temp.check((select outcome from projects.record_documentation_draft(:'P_id', 'handoff', 'zztest handoff', 'how to hand off')) = 'recorded', 'a fourth documentation draft');
reset role;
select id as d1 from projects.test_case_drafts where name = 'pays by card' \gset
select id as d2 from projects.test_case_drafts where name = 'refunds' \gset
select id as d3 from projects.test_case_drafts where name = 'declines' \gset
select id as c1 from projects.technical_documents where title = 'zztest architecture' \gset
select id as c2 from projects.technical_documents where title = 'zztest api' \gset
select id as c3 from projects.technical_documents where title = 'zztest database' \gset
select id as c4 from projects.technical_documents where title = 'zztest handoff' \gset
-- a derived document and a document a person wrote are not drafts
insert into projects.technical_documents (organization_id, project_id, kind, title, status, body, derived) values (:'ORG', :'P_id', 'other', 'zztest derived', 'partial', 'x', true) returning id \gset cd_
insert into projects.technical_documents (organization_id, project_id, kind, title, status, body, derived) values (:'ORG', :'P_id', 'other', 'zztest human partial', 'partial', 'written by a person', false) returning id \gset ch_

-- @@MUTATE@@

-- ═════════ 1. test case drafts ═════════
select pg_temp.as_user(:'MEM', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_test_case_draft(:'d1', 'accepted', null)) = 'not_authorized', 'a plain member cannot decide a test case draft');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_test_case_draft(:'d1', 'accepted', null)) = 'not_found', 'another organization cannot see or decide the draft');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_test_case_draft(:'d1', 'maybe', null)) = 'bad_decision', 'a decision must be accepted or rejected');
select pg_temp.check((select outcome from projects.review_test_case_draft(:'d2', 'rejected', '   ')) = 'note_required', 'a rejection says why');
select pg_temp.check((select outcome from projects.review_test_case_draft(:'d2', 'rejected', 'duplicates the card test')) = 'rejected', 'a delivery lead rejects a draft with a reason');
select pg_temp.check((select outcome from projects.review_test_case_draft(:'d1', 'accepted', null)) = 'accepted', 'a delivery lead accepts a draft');
reset role;
select pg_temp.check(pg_temp.draft_status(:'d1') = 'accepted' and pg_temp.draft_status(:'d2') = 'rejected' and pg_temp.draft_status(:'d3') = 'draft', 'each draft holds the decision made on it');
select pg_temp.check((select reviewed_by = :'DL' and reviewed_at is not null from projects.test_case_drafts where id = :'d1'), 'the decision records who and when');
select pg_temp.check(not exists (select 1 from qa.test_runs where project_id = :'P_id') and not exists (select 1 from qa.test_run_cases c where c.task_id = :'T1_id') and not exists (select 1 from qa.phase6_cases where project_id = :'P_id'), 'accepting a draft creates no test, run or result: an agent draft is never evidence');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_test_case_draft(:'d1', 'rejected', 'changed my mind')) = 'already_reviewed', 'a decision is not reopened through the door');
reset role;
select pg_temp.check(pg_temp.refused($$update projects.test_case_drafts set status = 'draft' where id = '$$ || :'d1' || $$'$$, 'never rewritten'), 'a reviewed draft cannot be rewritten even by a privileged writer');
select pg_temp.check(pg_temp.refused($$update projects.test_case_drafts set status = 'rejected', reviewed_by = '$$ || :'DL' || $$', reviewed_at = now() where id = '$$ || :'d3' || $$'$$, 'rejection_says_why'), 'a rejected draft without a reason is refused by the table too');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check(pg_temp.denied($$update projects.test_case_drafts set status = 'accepted' where id = '$$ || :'d3' || $$'$$), 'a signed-in person cannot write the draft table directly');
reset role;

-- ═════════ 2. documentation drafts ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c1', 'accepted', 'partial', null)) = 'not_authorized', 'a delivery lead is not an Admin: the document door refuses');
reset role;
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c1', 'accepted', 'partial', null)) = 'not_found', 'another organization cannot see or promote the draft');
reset role;
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_documentation_draft(:'cd_id', 'accepted', 'partial', null)) = 'not_a_draft', 'a derived document is not a draft');
select pg_temp.check((select outcome from projects.review_documentation_draft(:'ch_id', 'accepted', 'partial', null)) = 'not_a_draft', 'a document a person wrote is not a draft');
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c1', 'maybe', null, null)) = 'bad_decision', 'a decision must be accepted or rejected');
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c1', 'accepted', 'blocked', null)) = 'bad_status', 'a draft cannot be promoted to a status outside the allowed set');
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c1', 'accepted', 'implemented', '  ')) = 'evidence_required', 'an implemented document must name its evidence');
reset role;
select pg_temp.check(pg_temp.doc_status(:'c1') = 'partial' and (select body like 'DRAFT (written by the Documentation agent%' from projects.technical_documents where id = :'c1'), 'a refused promotion leaves the draft exactly as it was');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c1', 'accepted', 'implemented', 'https://example.test/evidence/architecture')) = 'accepted', 'an Admin promotes a draft to implemented with evidence');
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c2', 'accepted', 'partial', null)) = 'accepted', 'an Admin may accept a draft as partial (reviewed, still not claimed complete)');
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c3', 'rejected', null, null)) = 'rejected', 'an Admin rejects a draft');
reset role;
select pg_temp.check(pg_temp.doc_status(:'c1') = 'implemented' and (select evidence_ref = 'https://example.test/evidence/architecture' and body = 'the system has a web app' from projects.technical_documents where id = :'c1'), 'the promoted document carries its evidence and loses the DRAFT marker');
select pg_temp.check(pg_temp.doc_status(:'c2') = 'partial' and (select body not like 'DRAFT%' from projects.technical_documents where id = :'c2'), 'an accepted partial draft is marked as reviewed');
select pg_temp.check(pg_temp.doc_status(:'c3') = 'deprecated' and (select body like 'DRAFT%' from projects.technical_documents where id = :'c3'), 'a rejected draft is deprecated and still labelled a draft, never deleted');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c1', 'accepted', 'implemented', 'https://example.test/e')) = 'not_a_draft', 'a promoted document is not promoted again');
select pg_temp.check((select outcome from projects.review_documentation_draft(:'c3', 'accepted', 'partial', null)) = 'not_a_draft', 'a rejected draft is not revived through the door');
with u as (update projects.technical_documents set status = 'implemented', evidence_ref = 'x' where id = :'c4' returning 1)
select pg_temp.check((select count(*) from u) = 0, 'a signed-in person cannot write the document table directly (no write policy: zero rows change)');
reset role;
select pg_temp.check(pg_temp.doc_status(:'c4') = 'partial', 'the untouched draft is still a draft');
select pg_temp.as_service();
set local role service_role;
select pg_temp.check(pg_temp.denied('select * from projects.review_documentation_draft(''' || :'c4' || '''::uuid, ''accepted'', ''partial'', null)'), 'the service role (an agent) cannot review a documentation draft: no person, no decision');
select pg_temp.check(pg_temp.denied('select * from projects.review_test_case_draft(''' || :'d3' || '''::uuid, ''accepted'', null)'), 'the service role cannot review a test case draft either');
reset role;
select pg_temp.check(pg_temp.denied('set local role anon; select * from projects.review_test_case_draft(''' || :'d3' || '''::uuid, ''accepted'', null)'), 'anon cannot call the review doors');

\echo phase5 review doors verified: OK
rollback;
