-- ═══════════════════════════════════════════════════════════════════════════
-- P7-CS-05 (migration 20261129200000): a Customer Success feedback-signal draft cites the feedback it read; a person reviews it. Real doors, then
-- RED-PROOFS by mutating the LIVE definitions (a no-op mutation raises). Rolls back. No model ran: the draft is a fixture call of the service-role door.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
create or replace function pg_temp.mutate(p_fn regprocedure, p_from text, p_to text) returns text language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_from in v_def) = 0 then raise exception 'RED-PROOF NO-OP: % does not contain %', p_fn, p_from; end if;
  execute replace(v_def, p_from, p_to);
  return v_def;
end $$;
create or replace function pg_temp.restore(p_def text) returns void language plpgsql as $$ begin execute p_def; end $$;
create or replace function pg_temp.red(p_what text, p_fn regprocedure, p_from text, p_to text, p_probe text) returns void language plpgsql as $$
declare v_def text; v_ok boolean := true;
begin
  v_def := pg_temp.mutate(p_fn, p_from, p_to);
  begin
    execute p_probe into v_ok;
    raise exception 'p789_probe_rollback';
  exception when others then
    if sqlerrm <> 'p789_probe_rollback' then v_ok := false; end if;
  end;
  perform pg_temp.restore(v_def);
  if v_ok then raise exception 'RED-PROOF STAYED GREEN: %', p_what; end if;
  raise notice 'red %', p_what;
end $$;

\set ORG '00000000-0000-4000-8000-000000789e01'
\set ORGB '00000000-0000-4000-8000-000000789f01'
\set DL '00000000-0000-4000-8000-00000789a903'
\set UB '00000000-0000-4000-8000-00000789a905'
insert into core.organizations (id, name, slug) values (:'ORG', 'P789C Agency', 'p789c-agency'), (:'ORGB', 'P789C Other', 'p789c-other');
insert into auth.users (id, email) values (:'DL','p789c-d@example.test'),(:'UB','p789c-b@example.test');
insert into core.memberships (organization_id, user_id, role) values (:'ORG',:'DL','delivery_lead'),(:'ORGB',:'UB','owner');
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p789c client') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORGB', 'zztest p789c other client') returning id \gset AB_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p789c shop', 'ZP789C-1') returning id \gset P_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p789c other project', 'ZP789C-2') returning id \gset P2_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORGB', :'AB_id', 'zztest p789c foreign', 'ZP789C-3') returning id \gset PB_
set local session_replication_role = replica;
insert into projects.client_feedback (organization_id, client_account_id, project_id, kind, source, entered_by, sentiment, body, recorded_by) values (:'ORG', :'A_id', :'P_id', 'feedback', 'call', 'staff', 'negative', 'checkout was confusing and slow', :'DL') returning id \gset FN_
insert into projects.client_feedback (organization_id, client_account_id, project_id, kind, source, entered_by, sentiment, body, recorded_by) values (:'ORG', :'A_id', :'P_id', 'feedback', 'call', 'staff', 'positive', 'the new catalogue is lovely', :'DL') returning id \gset FP_
insert into projects.client_feedback (organization_id, client_account_id, project_id, kind, source, entered_by, body, recorded_by) values (:'ORG', :'A_id', :'P_id', 'goal', 'call', 'staff', 'we want a loyalty programme next year', :'DL') returning id \gset FG_
insert into projects.client_feedback (organization_id, client_account_id, project_id, kind, source, entered_by, sentiment, body, recorded_by) values (:'ORG', :'A_id', :'P2_id', 'feedback', 'call', 'staff', 'negative', 'a different project''s complaint', :'DL') returning id \gset FO_
insert into projects.client_feedback (organization_id, client_account_id, project_id, kind, source, entered_by, sentiment, body, recorded_by) values (:'ORGB', :'AB_id', :'PB_id', 'feedback', 'call', 'staff', 'negative', 'another tenant''s complaint', :'DL') returning id \gset FB_
set local session_replication_role = origin;
select set_config('projects.p789_door', 'off', true);

select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'The client found checkout confusing and slow.', array[:'FN_id'::uuid])) = 'not_service', 'a person cannot write a draft: the door is the agent''s alone');
select pg_temp.check(not has_function_privilege('authenticated', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])', 'execute') and not has_function_privilege('anon', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])', 'execute'), 'only the service role can execute it');
select pg_temp.as_service();
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'support', 'complaint', 'The client found checkout confusing and slow.', array[:'FN_id'::uuid])) = 'not_the_customer_success_agent', 'only the Customer Success agent');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'rumour', 'The client found checkout confusing and slow.', array[:'FN_id'::uuid])) = 'bad_signal', 'signal vocabulary is closed');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'short', array[:'FN_id'::uuid])) = 'bad_summary', 'a summary of substance');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'We should offer a 20% off discount to calm the client.', array[:'FN_id'::uuid])) = 'names_a_price', 'a draft that names a price or a discount is refused');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'password=hunter2hunter2 was in the feedback body.', array[:'FN_id'::uuid])) = 'contains_secret', 'a secret is refused');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'The client found checkout confusing and slow.', '{}')) = 'cite_the_feedback', 'it must cite feedback');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'The client found checkout confusing and slow.', array[:'FO_id'::uuid])) = 'cited_feedback_not_this_projects', 'it cannot cite another project''s feedback');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'The client found checkout confusing and slow.', array[:'FB_id'::uuid])) = 'cited_feedback_not_this_projects', 'nor another organization''s');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'The client found checkout confusing and slow.', array[:'FG_id'::uuid])) = 'cited_feedback_not_this_projects', 'a goal is not feedback');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'complaint', 'The client praised the new catalogue a lot.', array[:'FP_id'::uuid])) = 'a_complaint_cites_negative_feedback', 'a complaint cannot rest on positive feedback');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'praise', 'The client praised the catalogue and the checkout.', array[:'FP_id'::uuid, :'FN_id'::uuid])) = 'praise_cites_no_negative_feedback', 'praise cannot cite a complaint');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'mixed', 'The client liked the catalogue but not the checkout.', array[:'FP_id'::uuid])) = 'mixed_cites_both_kinds', 'mixed must cite both kinds');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'PB_id', 'customer_success', 'complaint', 'The client found checkout confusing and slow.', array[:'FN_id'::uuid])) = 'not_found', 'the project must be in the claimed organization');
select outcome as "D_out", draft_id as "D_id" from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'mixed', 'The client liked the catalogue but found checkout confusing and slow.', array[:'FP_id'::uuid, :'FN_id'::uuid, :'FN_id'::uuid]) \gset
select pg_temp.check(:'D_out' = 'drafted' and (select cardinality(cited_feedback_ids) = 2 and status = 'draft' from projects.p789_feedback_signal_drafts where id = :'D_id'), 'a draft is recorded citing each distinct feedback row once');
select pg_temp.check((select outcome from projects.p789_record_feedback_signal_draft(:'ORG', :'P_id', 'customer_success', 'mixed', 'The client liked the catalogue but found checkout confusing and slow.', array[:'FN_id'::uuid, :'FP_id'::uuid])) = 'already_recorded', 'the same draft again, cited in another order, records nothing new');
select pg_temp.check((select count(*) from projects.support_tickets where project_id = :'P_id') = 0 and (select count(*) from projects.cs_check_ins where project_id = :'P_id') = 0, 'and it opened no ticket and no check-in');

select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from projects.p789_review_feedback_signal_draft(:'D_id', 'reviewed', 'not my draft')) = 'not_found', 'another organization cannot review it');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_feedback_signal_drafts) = 0, 'nor read it');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_review_feedback_signal_draft(:'D_id', 'approved', 'reads right to me')) = 'bad_decision', 'decision vocabulary is closed');
select pg_temp.check((select outcome from projects.p789_review_feedback_signal_draft(:'D_id', 'reviewed', 'ok')) = 'note_required', 'a note is required');
select pg_temp.check((select outcome from projects.p789_review_feedback_signal_draft(:'D_id', 'reviewed', 'reads right to me')) = 'reviewed', 'a person reviews it');
select pg_temp.check((select outcome from projects.p789_review_feedback_signal_draft(:'D_id', 'dismissed', 'changed my mind')) = 'already_settled', 'once');
select set_config('projects.p789_door', 'off', true);
select pg_temp.check(pg_temp.refused(format('update projects.p789_feedback_signal_drafts set summary = %L where id = %L', 'rewritten history of the draft', :'D_id'), 'door'), 'a draft is not edited directly');
select set_config('projects.p789_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p789_feedback_signal_drafts set summary = %L where id = %L', 'rewritten history of the draft', :'D_id'), 'decision columns'), 'and through the door only its decision columns can move');
select set_config('projects.p789_door', 'off', true);

-- RED-PROOFS
select pg_temp.as_service();
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('door: service role only (probed as a person)', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, 'if coalesce((select auth.role()), '''') <> ''service_role'' then return query select ''not_service''::text, null::uuid; return; end if;', '',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'customer_success', 'complaint', 'A fresh complaint about a slow checkout flow.', array[%L::uuid])) = 'not_service'$q$, :'ORG', :'P_id', :'FN_id'));
select pg_temp.as_service();
select pg_temp.red('door: only the Customer Success agent', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, 'if p_agent_key is distinct from ''customer_success'' then', 'if false then',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'support', 'complaint', 'A fresh complaint about a slow checkout flow.', array[%L::uuid])) = 'not_the_customer_success_agent'$q$, :'ORG', :'P_id', :'FN_id'));
select pg_temp.red('door: no price or discount', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, '|discount|refund|% off', '|zzz',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'customer_success', 'complaint', 'We should offer a discount to calm the client down.', array[%L::uuid])) = 'names_a_price'$q$, :'ORG', :'P_id', :'FN_id'));
select pg_temp.red('door: the project belongs to the claimed organization', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, 'where p.id = p_project_id and p.organization_id = p_organization_id and p.deleted_at is null', 'where p.id = p_project_id and p.deleted_at is null',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'customer_success', 'complaint', 'Another tenant''s complaint about a slow checkout.', array[%L::uuid])) = 'not_found'$q$, :'ORG', :'PB_id', :'FB_id'));
select pg_temp.red('door: cited feedback must be this project''s', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, 'f.id = any (v_ids) and f.project_id = p_project_id and f.organization_id = p_organization_id', 'f.id = any (v_ids) and f.organization_id = p_organization_id',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'customer_success', 'complaint', 'A different project''s complaint about the checkout.', array[%L::uuid])) = 'cited_feedback_not_this_projects'$q$, :'ORG', :'P_id', :'FO_id'));
select pg_temp.red('door: a complaint cites negative feedback', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, 'if p_signal = ''complaint'' and v_neg = 0 then', 'if false then',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'customer_success', 'complaint', 'The client praised the new catalogue a lot.', array[%L::uuid])) = 'a_complaint_cites_negative_feedback'$q$, :'ORG', :'P_id', :'FP_id'));
select pg_temp.red('door: praise cites no complaint', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, 'if p_signal = ''praise'' and v_neg > 0 then', 'if false then',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'customer_success', 'praise', 'The client praised the catalogue and the checkout.', array[%L::uuid, %L::uuid])) = 'praise_cites_no_negative_feedback'$q$, :'ORG', :'P_id', :'FP_id', :'FN_id'));
select pg_temp.red('door: idempotent on the digest', 'projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[])'::regprocedure, 'if v_id is not null then return query select ''already_recorded''::text, v_id; return; end if;', '',
  format($q$select (select outcome from projects.p789_record_feedback_signal_draft(%L, %L, 'customer_success', 'mixed', 'The client liked the catalogue but found checkout confusing and slow.', array[%L::uuid, %L::uuid])) = 'already_recorded'$q$, :'ORG', :'P_id', :'FP_id', :'FN_id'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('review: a note is required', 'projects.p789_review_feedback_signal_draft(uuid, text, text)'::regprocedure, 'if p_note is null or length(btrim(p_note)) < 5 then return query select ''note_required''::text; return; end if;', '',
  format($q$select (select outcome from projects.p789_review_feedback_signal_draft(%L, 'dismissed', 'x')) = 'note_required'$q$, :'D_id'));
select pg_temp.red('review: once settled, settled', 'projects.p789_review_feedback_signal_draft(uuid, text, text)'::regprocedure, 'if v_d.status <> ''draft'' then return query select ''already_settled''::text; return; end if;', '',
  format($q$select (select outcome from projects.p789_review_feedback_signal_draft(%L, 'dismissed', 'changed my mind')) = 'already_settled'$q$, :'D_id'));
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.red('review: only inside the organization', 'projects.p789_review_feedback_signal_draft(uuid, text, text)'::regprocedure, 'where x.id = p_draft_id and x.organization_id = v_org for update', 'where x.id = p_draft_id for update',
  format($q$select (select outcome from projects.p789_review_feedback_signal_draft(%L, 'dismissed', 'changed my mind')) = 'not_found'$q$, :'D_id'));

select 'feedback signal verified OK' as result;
rollback;
