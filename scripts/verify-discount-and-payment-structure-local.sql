-- Live-Postgres behavioral verification for Business Phase 1-4 audit steps
-- 1.27 (discount audit trail) and 1.28 (payment structure catalog).
--
-- Run against the scratch database `scripts/apply-migrations-locally.sh`
-- (KEEP=1) leaves running. Drives the real SQL functions directly via psql,
-- simulating signed-in callers the way PostgREST does: one JSON GUC,
-- `request.jwt.claims`, read by auth.jwt()/auth.uid() AND by
-- core.current_organization_id()/core.current_user_role() (which read
-- app_metadata.organization_id / app_metadata.role) — see
-- 20260807120001_schemas_and_helpers.sql.

\pset pager off
\timing off

\echo '── fixtures ──'

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@demo.test'),
  ('22222222-2222-2222-2222-222222222222', 'staff@demo.test')
on conflict (id) do nothing;

insert into core.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@demo.test'),
  ('22222222-2222-2222-2222-222222222222', 'staff@demo.test')
on conflict (id) do nothing;

insert into core.memberships (organization_id, user_id, role) values
  ('00000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('00000000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222222', 'ops_admin')
on conflict do nothing;

insert into sales.opportunities (id, organization_id, name, stage)
values ('33333333-3333-3333-3333-333333333333', '00000000-0000-4000-8000-000000000001', 'Test opportunity', 'proposal')
on conflict (id) do nothing;

insert into sales.proposals (id, organization_id, opportunity_id, version, title, status)
values ('44444444-4444-4444-4444-444444444444', '00000000-0000-4000-8000-000000000001', '33333333-3333-3333-3333-333333333333', 1, 'Test quotation', 'draft')
on conflict (id) do nothing;

insert into sales.proposal_items (organization_id, proposal_id, description, quantity, unit_price_minor, amount_minor)
values ('00000000-0000-4000-8000-000000000001', '44444444-4444-4444-4444-444444444444', 'Build', 1, 100000000, 100000000)
on conflict do nothing;

update sales.proposals set subtotal_minor = 100000000, total_minor = 100000000 where id = '44444444-4444-4444-4444-444444444444';

-- ── helpers: sign in as owner / staff / nobody (service_role) ──────────────
-- `:'VAR'` is psql's auto-quoting substitution: the value is escaped and
-- wrapped as a single SQL string literal, so the raw JSON below needs none of
-- its own quoting.
\set OWNER_CLAIMS {"sub":"11111111-1111-1111-1111-111111111111","app_metadata":{"organization_id":"00000000-0000-4000-8000-000000000001","role":"owner"}}
\set STAFF_CLAIMS {"sub":"22222222-2222-2222-2222-222222222222","app_metadata":{"organization_id":"00000000-0000-4000-8000-000000000001","role":"ops_admin"}}

\echo '── A. no cap configured: a human-requested discount routes to approval, not autonomous ──'
select set_config('request.jwt.claims', :'STAFF_CLAIMS', false);
set role authenticated;
select outcome, status from sales.record_discount_decision(
  '44444444-4444-4444-4444-444444444444', 5000000, 'client asked for a break', 'human'
);
-- EXPECT: no_policy (no discount_decision approval policy configured yet, and no cap set)
reset role;

\echo '── B. configure the cap, then a within-cap human discount is autonomous ──'
select set_config('request.jwt.claims', :'OWNER_CLAIMS', false);
set role authenticated;
select outcome from core.set_organization_setting(
  '00000000-0000-4000-8000-000000000001', 'negotiation_max_discount_pct', '10'
);
reset role;

select set_config('request.jwt.claims', :'STAFF_CLAIMS', false);
set role authenticated;
select outcome, status, final_amount_minor from sales.record_discount_decision(
  '44444444-4444-4444-4444-444444444444', 5000000, 'client asked for a break', 'human'
);
-- EXPECT: autonomous | autonomous | 95000000
reset role;

\echo '── C. above the cap: a human discount routes to approval (no_policy, still no policy configured) ──'
select set_config('request.jwt.claims', :'STAFF_CLAIMS', false);
set role authenticated;
select outcome, status from sales.record_discount_decision(
  '44444444-4444-4444-4444-444444444444', 30000000, 'client wants 30 off', 'human'
);
-- EXPECT: no_policy (30% total > 10% cap, and still no discount_decision policy)
reset role;

\echo '── D. RED-PROOF: an agent-requested discount can NEVER be autonomous, even within the cap ──'
-- Directly attempt the row the constraint refuses, as service_role (which
-- bypasses RLS but NOT a CHECK constraint — a CHECK holds against every role,
-- which is the whole point of holding the rule in DDL rather than in the door).
set role service_role;
insert into sales.discount_decisions (
  organization_id, proposal_id, original_amount_minor, discount_minor, discount_pct,
  reason, requested_by_type, requested_by_agent, status
) values (
  '00000000-0000-4000-8000-000000000001', '44444444-4444-4444-4444-444444444444',
  100000000, 5000000, 5, 'agent tried to self-approve', 'agent', 'sales', 'autonomous'
);
-- EXPECT: ERROR — discount_decisions_no_autonomous_agent constraint violation
reset role;

\echo '── E. the door itself refuses an agent request from a signed-in caller ──'
select set_config('request.jwt.claims', :'STAFF_CLAIMS', false);
set role authenticated;
select outcome from sales.record_discount_decision(
  '44444444-4444-4444-4444-444444444444', 1000000, 'posing as the agent', 'agent', 'sales'
);
-- EXPECT: no_requester (a signed-in caller cannot pose as an agent request)
reset role;

\echo '── F. an agent request from an identity-less caller (service_role) always needs approval ──'
reset request.jwt.claims;
set role service_role;
select outcome, status from sales.record_discount_decision(
  '44444444-4444-4444-4444-444444444444', 1000000, 'agent proposes a small discount', 'agent', 'sales'
);
-- EXPECT: no_policy | cancelled (agent requests never take the autonomous
-- branch, so this always tries the approvals engine, which still has no
-- discount_decision policy configured)
reset role;

\echo '── G. configure a discount_decision approval policy, then an agent request raises a real approval ──'
select set_config('request.jwt.claims', :'OWNER_CLAIMS', false);
set role authenticated;
select outcome from approvals.set_policy('discount_decision', 0, 'ops_admin', 24, 'internal', null);
reset role;

reset request.jwt.claims;
set role service_role;
select outcome, status, approval_request_id from sales.record_discount_decision(
  '44444444-4444-4444-4444-444444444444', 1000000, 'agent proposes a small discount', 'agent', 'sales'
);
-- EXPECT: pending_approval | pending_approval | a non-null request id
reset role;

\echo '── H. settling the approval carries the decision onto the discount_decisions row ──'
set role service_role;
select r.id as request_id from approvals.approval_requests r
  where r.subject_type = 'discount_decision' and r.state = 'pending'
  order by r.created_at desc limit 1 \gset
reset role;

select set_config('request.jwt.claims', :'OWNER_CLAIMS', false);
set role authenticated;
select outcome, state from approvals.decide_approval(:'request_id', 'approved', 'owner approved the small discount');
reset role;

set role service_role;
select d.status, d.approved_by, d.final_amount_minor
  from sales.discount_decisions d
 where d.approval_request_id = :'request_id';
-- Still pending_approval here: carrying the decision onto the row is
-- sync_discount_decision's job (normally run by the job runner off the
-- approval.decided event). Called explicitly below, the same call
-- syncDiscountDecision (handlers.ts) makes.
select outcome, status from sales.sync_discount_decision(
  (select id from sales.discount_decisions where approval_request_id = :'request_id')
);
select d.status, (d.approved_by is not null) as has_approver, d.final_amount_minor
  from sales.discount_decisions d
 where d.approval_request_id = :'request_id';
-- EXPECT: settled | approved, then status=approved, has_approver=t, final_amount_minor=99000000
reset role;

\echo '── I. Task 2: no structure of kind lower_advance yet ──'
select set_config('request.jwt.claims', :'STAFF_CLAIMS', false);
set role authenticated;
select outcome from sales.apply_payment_structure_kind('44444444-4444-4444-4444-444444444444', 'lower_advance');
-- EXPECT: no_structure_of_kind
reset role;

\echo '── J. owner authors a lower_advance structure, then it applies by name ──'
select set_config('request.jwt.claims', :'OWNER_CLAIMS', false);
set role authenticated;
select outcome, structure_id from sales.set_payment_structure(
  '00000000-0000-4000-8000-000000000001', 'Lower advance (15/35/35/15)',
  '[{"label":"Advance","pct":15},{"label":"Milestone 1","pct":35},{"label":"Milestone 2","pct":35},{"label":"Final","pct":15}]'::jsonb,
  null, null, 'lower_advance'
);
reset role;

select set_config('request.jwt.claims', :'STAFF_CLAIMS', false);
set role authenticated;
select outcome, name from sales.apply_payment_structure_kind('44444444-4444-4444-4444-444444444444', 'lower_advance');
-- EXPECT: applied | 'Lower advance (15/35/35/15)'
select document->'paymentStructure' from sales.proposals where id = '44444444-4444-4444-4444-444444444444';
reset role;

\echo '── K. RED-PROOF: two active structures of the same kind is refused ──'
select set_config('request.jwt.claims', :'OWNER_CLAIMS', false);
set role authenticated;
select outcome, structure_id from sales.set_payment_structure(
  '00000000-0000-4000-8000-000000000001', 'A SECOND lower advance',
  '[{"label":"Advance","pct":20},{"label":"Final","pct":80}]'::jsonb,
  null, null, 'lower_advance'
);
-- EXPECT: kind_already_active
reset role;

\echo '── L. an invalid kind is refused by the DDL, not silently accepted ──'
set role service_role;
insert into sales.payment_structures (organization_id, name, kind)
values ('00000000-0000-4000-8000-000000000001', 'bogus', 'made_up_kind');
-- EXPECT: ERROR — check constraint violation
reset role;

\echo 'DONE'
