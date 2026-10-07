-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 round 4, Quotation Master (migration 20261203200000): per-line discount and source, Delivered / Viewed events, a direct quotation column on invoices, and the
-- recalculation of a timeline objection.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1r-quotation.sql     Rolls back. Any failed check raises.
-- No replication-role switch; every count is scoped to this script's own organisation; helper names are prefixed p1r_.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p1r_check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.p1r_check(boolean, text) to public;
create or replace function pg_temp.p1r_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.p1r_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p1r_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.p1r_as_service() to public;
create or replace function pg_temp.p1r_fails_with(stmt text, code text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when others then return sqlstate = code; end $$;
grant execute on function pg_temp.p1r_fails_with(text, text) to public;
create or replace function pg_temp.p1r_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin
  n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if;
  execute n;
end $$;
grant execute on function pg_temp.p1r_mutate(regprocedure, text, text) to public;

\set QORG '00000000-0000-4000-8000-0000000b0300'
\set QOWN '00000000-0000-4000-8000-0000000b0301'
\set QMEM '00000000-0000-4000-8000-0000000b0302'
\set QFIN '00000000-0000-4000-8000-0000000b0303'
\set QOTH '00000000-0000-4000-8000-0000000b0310'
\set QOTHU '00000000-0000-4000-8000-0000000b0311'

insert into auth.users (id, email) values (:'QOWN', 'p1r-q-owner@example.test'), (:'QMEM', 'p1r-q-member@example.test'), (:'QFIN', 'p1r-q-fin@example.test'), (:'QOTHU', 'p1r-q-other@example.test');
insert into core.users (id, email, full_name) values (:'QOWN', 'p1r-q-owner@example.test', 'Q Owner'), (:'QMEM', 'p1r-q-member@example.test', 'Q Member'), (:'QFIN', 'p1r-q-fin@example.test', 'Q Fin'), (:'QOTHU', 'p1r-q-other@example.test', 'Q Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'QORG', 'zztest p1r quote', 'zztest-p1r-quote'), (:'QOTH', 'zztest p1r quote other', 'zztest-p1r-quote-other');
insert into core.memberships (organization_id, user_id, role) values (:'QORG', :'QOWN', 'owner'), (:'QORG', :'QMEM', 'member'), (:'QORG', :'QFIN', 'finance'), (:'QOTH', :'QOTHU', 'owner');
insert into approvals.approval_policies (organization_id, subject_type, min_amount_minor, required_role, sla_hours) values (:'QORG', 'proposal', 0, 'owner', 24);
insert into core.client_accounts (organization_id, name) values (:'QORG', 'zztest p1r q client') returning id as acct \gset
insert into crm.leads (organization_id, title) values (:'QORG', 'zztest p1r quote lead') returning id as lead \gset
insert into sales.opportunities (organization_id, client_account_id, lead_id, name) values (:'QORG', :'acct', :'lead', 'zztest p1r deal') returning id as opp \gset

create or replace function pg_temp.p1r_draft(p_org uuid, p_opp uuid, p_title text, p_unit bigint) returns uuid language plpgsql as $$
declare v_id uuid; v_ver int;
begin
  select coalesce(max(version), 0) + 1 into v_ver from sales.proposals where opportunity_id = p_opp;
  insert into sales.proposals (organization_id, opportunity_id, version, title, subtotal_minor, discount_minor, total_minor) values (p_org, p_opp, v_ver, p_title, p_unit, 0, p_unit) returning id into v_id;
  insert into sales.proposal_items (organization_id, proposal_id, position, description, quantity, unit_price_minor, amount_minor) values (p_org, v_id, 0, 'build ' || p_title, 1, p_unit, p_unit);
  return v_id;
end $$;
grant execute on function pg_temp.p1r_draft(uuid, uuid, text, bigint) to public;
-- a quotation on a deal of its own (one live version per deal)
create or replace function pg_temp.p1r_draft_new(p_org uuid, p_acct uuid, p_lead uuid, p_title text, p_unit bigint) returns uuid language plpgsql as $$
declare v_opp uuid; v_lead uuid;
begin
  insert into crm.leads (organization_id, title) values (p_org, 'zztest p1r lead ' || p_title) returning id into v_lead;
  insert into sales.opportunities (organization_id, client_account_id, lead_id, name) values (p_org, p_acct, v_lead, 'zztest p1r deal ' || p_title) returning id into v_opp;
  return pg_temp.p1r_draft(p_org, v_opp, p_title, p_unit);
end $$;
grant execute on function pg_temp.p1r_draft_new(uuid, uuid, uuid, text, bigint) to public;

-- ═══ 1. a line has its own discount and says where its price came from ═══
select pg_temp.p1r_as_service();
select pg_temp.p1r_draft(:'QORG', :'opp', 'line pricing quote', 500000) as p1 \gset
select id as line1 from sales.proposal_items where proposal_id = :'p1' \gset
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 1000, 'catalogue', 'price-list:web-app', 'launch week')) = 'person_required', 'the service role cannot discount a line: an agent never does');
select pg_temp.p1r_as_user(:'QOTHU', :'QOTH', 'owner');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 1000, 'catalogue', 'price-list:web-app', 'launch week')) = 'forbidden', 'another organisation cannot');
select pg_temp.p1r_as_user(:'QMEM', :'QORG', 'member');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 1000, 'catalogue', 'price-list:web-app', 'launch week')) = 'forbidden', 'a plain member cannot');
select pg_temp.p1r_as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 1000, 'catalogue', 'price-list:web-app', '')) = 'missing_reason', 'a discount needs a reason');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 500001, 'catalogue', 'x', 'too much')) = 'discount_exceeds_line', 'a discount larger than the line is refused');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', -5, 'catalogue', 'x', 'neg')) = 'bad_discount', 'a negative discount is refused');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 1000, 'made_up', 'x', 'launch week')) = 'bad_source', 'a source kind the vocabulary does not have is refused');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 1000, 'catalogue', 'price-list:web-app', 'launch week')) = 'set', 'a person sets the discount and the reference');
select pg_temp.p1r_check((select amount_minor from sales.proposal_items where id = :'line1') = 499000, 'the line''s amount is its price less its discount');
select pg_temp.p1r_check((select subtotal_minor = 499000 and total_minor = 499000 from sales.proposals where id = :'p1'), 'the quotation''s subtotal and total follow, and stay arithmetic');
select pg_temp.p1r_check((select gross_minor = 500000 and line_discount_minor = 1000 and net_minor = 499000 and source_kind = 'catalogue' and catalogue_ref = 'price-list:web-app' and line_discount_reason = 'launch week' from sales.p1r_quote_lines(:'p1')), 'the lines read back as gross, discount, net, source, reference and reason');
select pg_temp.p1r_check((select count(*) from audit.audit_log where organization_id = :'QORG' and action = 'proposal.line_pricing_set') = 1, 'setting it is audited');
select pg_temp.p1r_check((select sales.p1r_line_discount_total(:'p1')) = 1000, 'the line discounts of a quotation add up');
select outcome as clr from sales.p1r_set_line_pricing(:'line1', 0, 'manual', null, null) \gset
select pg_temp.p1r_check(:'clr' = 'set' and (select line_discount_reason from sales.proposal_items where id = :'line1') is null, 'taking the discount off clears its reason');
select pg_temp.p1r_check((select amount_minor from sales.proposal_items where id = :'line1') = 500000, 'and the line is whole again');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update sales.proposal_items set line_discount_minor = 5 where id = %L$f$, :'line1'), '23514'), 'even a direct write cannot keep a discount without its reason');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 1000, 'catalogue', 'price-list:web-app', 'launch week')) = 'set', 'set again for the next checks');
select pg_temp.p1r_as_user(:'QMEM', :'QORG', 'member');
select pg_temp.p1r_check((select count(*) from sales.p1r_quote_lines(:'p1')) = 1, 'any internal member reads the lines');
select pg_temp.p1r_as_user(:'QOTHU', :'QOTH', 'owner');
select pg_temp.p1r_check((select count(*) from sales.p1r_quote_lines(:'p1')) = 0 and (select sales.p1r_line_discount_total(:'p1')) = 0, 'another organisation reads nothing of them');

-- the maximum discount counts the line discounts too
select pg_temp.p1r_as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.p1r_check((select outcome from sales.p1o_set_negotiation_limits(:'QORG', 500, 50)) = 'set', 'an administrator sets a maximum discount of 500');
select pg_temp.p1r_check((select (sales.p1o_check_negotiation_limits(:'p1'))->0->>'limit') = 'max_discount_minor' and ((sales.p1o_check_negotiation_limits(:'p1'))->0->>'actual')::bigint = 1000, 'a quotation whose only discount sits in a line is over the limit, and the check says by how much');
select request_id as req1 from sales.submit_proposal(:'p1', :'QOWN') \gset
select pg_temp.p1r_check((select policy_snapshot -> 'breaches' @> '[{"limit":"max_discount_minor"}]'::jsonb from sales.proposals where id = :'p1'), 'entering review stamps the breach the line discount caused: the approver is told');
select pg_temp.p1r_check((select outcome from sales.p1r_set_line_pricing(:'line1', 0, 'manual', null, null)) = 'not_a_draft', 'once a quotation is in review its lines are not re-priced');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update sales.proposal_items set line_discount_minor = 0, line_discount_reason = null where id = %L$f$, :'line1'), '23001'), 'and a direct write is refused too');

-- ═══ 2. Delivered / Viewed ═══
select pg_temp.p1r_as_service();
insert into crm.conversations (organization_id, lead_id, channel, kind, status) values (:'QORG', :'lead', 'whatsapp', 'direct', 'active') returning id as conv \gset
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata, external_ref)
  values (:'QORG', :'conv', 1, 'system', 'Your quotation', '{"direction":"outbound","delivery":"sent","provider_ref":"wamid.p1r1"}', 'p1r-quote-msg-1') returning id as msg1 \gset
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata, external_ref)
  values (:'QORG', :'conv', 2, 'system', 'Hello', '{"direction":"outbound","delivery":"sent","provider_ref":"wamid.p1r2"}', 'p1r-quote-msg-2') returning id as msg2 \gset
-- a quotation sent in the message
select pg_temp.p1r_draft_new(:'QORG', :'acct', :'lead', 'delivery quote', 300000) as p2 \gset
select opportunity_id as opp2, (select lead_id from sales.opportunities o where o.id = opportunity_id) as lead2 from sales.proposals where id = :'p2' \gset
select pg_temp.p1r_as_user(:'QOWN', :'QORG', 'owner');
select request_id as req2 from sales.submit_proposal(:'p2', :'QOWN') \gset
select outcome as dec2 from approvals.decide_approval(:'req2', 'approved', 'ok') \gset
select sales.sync_proposal_decision(:'p2') as sync2 \gset
select outcome as sent2 from sales.send_proposal(:'p2', :'conv', :'msg1') \gset
select pg_temp.p1r_check(:'sent2' = 'sent' and (select sent_message_ref from sales.proposals where id = :'p2') = :'msg1', 'the quotation is sent and names the message that carried it');
select pg_temp.p1r_as_service();
select set_config('crm.sanctioned_write', 'on', true);
update crm.conversation_messages set metadata = metadata || '{"wire_status":"sent"}' where id = :'msg1';
select pg_temp.p1r_check((select count(*) from sales.p1r_quote_delivery where proposal_id = :'p2') = 0, 'a "sent" receipt is not delivery: nothing is recorded');
update crm.conversation_messages set metadata = metadata || '{"wire_status":"delivered","delivered_at":"2026-12-01T10:00:00Z"}' where id = :'msg1';
select pg_temp.p1r_check((select delivered_at from sales.p1r_quote_delivery where proposal_id = :'p2') = timestamptz '2026-12-01 10:00:00+00' and (select viewed_at from sales.p1r_quote_delivery where proposal_id = :'p2') is null, 'delivered is recorded with the provider''s time');
select pg_temp.p1r_check((select count(*) from core.outbox_events where organization_id = :'QORG' and type = 'proposal.delivered' and subject_id = :'p2') = 1, 'and emits proposal.delivered once');
update crm.conversation_messages set metadata = metadata || '{"wire_status":"read","read_at":"2026-12-01T11:00:00Z"}' where id = :'msg1';
select pg_temp.p1r_check((select viewed_at from sales.p1r_quote_delivery where proposal_id = :'p2') = timestamptz '2026-12-01 11:00:00+00', 'read is recorded as viewed');
select pg_temp.p1r_check((select count(*) from core.outbox_events where organization_id = :'QORG' and type = 'proposal.viewed' and subject_id = :'p2') = 1 and (select count(*) from core.outbox_events where organization_id = :'QORG' and type = 'proposal.delivered' and subject_id = :'p2') = 1, 'proposal.viewed once, and delivered is not repeated');
update crm.conversation_messages set metadata = metadata || '{"note":"touched"}' where id = :'msg1';
select pg_temp.p1r_check((select count(*) from core.outbox_events where organization_id = :'QORG' and type in ('proposal.delivered', 'proposal.viewed') and subject_id = :'p2') = 2, 'an unrelated change to the message raises nothing');
update crm.conversation_messages set metadata = metadata || '{"wire_status":"read"}' where id = :'msg2';
select pg_temp.p1r_check((select count(*) from sales.p1r_quote_delivery where organization_id = :'QORG') = 1, 'a message that did not carry a quotation records nothing');
-- read straight away (no delivered receipt first): both are recorded
select pg_temp.p1r_draft_new(:'QORG', :'acct', :'lead', 'read first quote', 200000) as p3 \gset
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata)
  values (:'QORG', :'conv', 3, 'system', 'Quotation 3', '{"direction":"outbound","delivery":"sent"}') returning id as msg3 \gset
update sales.proposals set sent_message_ref = :'msg3' where id = :'p3';
update crm.conversation_messages set metadata = metadata || '{"wire_status":"read"}' where id = :'msg3';
select pg_temp.p1r_check((select delivered_at is not null and viewed_at is not null from sales.p1r_quote_delivery where proposal_id = :'p3'), 'a read with no earlier delivered receipt records both: a read message was delivered');
select pg_temp.p1r_draft_new(:'QORG', :'acct', :'lead', 'failed quote', 100000) as p4 \gset
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata)
  values (:'QORG', :'conv', 4, 'system', 'Quotation 4', '{"direction":"outbound","delivery":"sent"}') returning id as msg4 \gset
update sales.proposals set sent_message_ref = :'msg4' where id = :'p4';
update crm.conversation_messages set metadata = metadata || '{"wire_status":"failed"}' where id = :'msg4';
select pg_temp.p1r_check((select failed_at is not null and delivered_at is null from sales.p1r_quote_delivery where proposal_id = :'p4') and (select count(*) from core.outbox_events where organization_id = :'QORG' and type = 'proposal.delivery_failed' and subject_id = :'p4') = 1, 'a wire failure is recorded and emitted, and is not delivery');
select pg_temp.p1r_as_user(:'QMEM', :'QORG', 'member');
select pg_temp.p1r_check((select viewed_at is not null from sales.p1r_quote_delivery_for(:'p2')), 'an internal member reads the delivery record');
select pg_temp.p1r_as_user(:'QOTHU', :'QOTH', 'owner');
select pg_temp.p1r_check((select count(*) from sales.p1r_quote_delivery_for(:'p2')) = 0, 'another organisation reads none');

-- ═══ 3. an invoice names the quotation it bills ═══
select pg_temp.p1r_as_service();
insert into projects.projects (organization_id, client_account_id, opportunity_id, name, proposal_id, project_code) values (:'QORG', :'acct', (select opportunity_id from sales.proposals where id = :'p2'), 'zztest p1r project', :'p2', 'ZZ-P1R-1') returning id as proj \gset
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, subtotal_minor, total_minor, kind) values (:'QORG', :'acct', :'proj', 'ZZ-P1R-001', 'draft', 100000, 100000, 'service') returning id as inv1 \gset
select pg_temp.p1r_check((select proposal_id from finance.invoices where id = :'inv1') = :'p2', 'an invoice created for a project is stamped with the project''s quotation');
insert into finance.invoices (organization_id, client_account_id, number, status, subtotal_minor, total_minor, kind) values (:'QORG', :'acct', 'ZZ-P1R-002', 'draft', 50000, 50000, 'service') returning id as inv2 \gset
select pg_temp.p1r_check((select proposal_id from finance.invoices where id = :'inv2') is null, 'an invoice with no project has no quotation to name: null, never guessed');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$update finance.invoices set proposal_id = %L where id = %L$f$, :'p3', :'inv1'), '23001'), 'the quotation an invoice bills does not change once set');
update finance.invoices set proposal_id = :'p3' where id = :'inv2';
select pg_temp.p1r_check((select proposal_id from finance.invoices where id = :'inv2') = :'p3', 'an invoice with none can be given one once');
select pg_temp.p1r_check(pg_temp.p1r_fails_with(format($f$insert into finance.invoices (organization_id, client_account_id, number, status, subtotal_minor, total_minor, kind, proposal_id) values (%L, %L, 'ZZ-P1R-003', 'draft', 1, 1, 'service', %L)$f$, :'QOTH', :'acct', :'p2'), '23514')
  or pg_temp.p1r_fails_with(format($f$insert into finance.invoices (organization_id, client_account_id, number, status, subtotal_minor, total_minor, kind, proposal_id) values (%L, %L, 'ZZ-P1R-003', 'draft', 1, 1, 'service', %L)$f$, :'QOTH', :'acct', :'p2'), '23503'), 'an invoice cannot name another organisation''s quotation');
select pg_temp.p1r_as_user(:'QFIN', :'QORG', 'finance');
select pg_temp.p1r_check((select count(*) from finance.p1r_invoices_for_proposal(:'p2')) = 1 and (select invoice_number from finance.p1r_invoices_for_proposal(:'p2')) = 'ZZ-P1R-001', 'finance reads the invoices that bill one quotation');
select pg_temp.p1r_as_user(:'QMEM', :'QORG', 'member');
select pg_temp.p1r_check((select count(*) from finance.p1r_invoices_for_proposal(:'p2')) = 0, 'a plain member does not');
select pg_temp.p1r_as_user(:'QOTHU', :'QOTH', 'owner');
select pg_temp.p1r_check((select count(*) from finance.p1r_invoices_for_proposal(:'p2')) = 0, 'nor does another organisation');

-- ═══ 4. a timeline objection is recalculated ═══
select pg_temp.p1r_as_service();
insert into sales.objections (organization_id, lead_id, round, proposal_id, kind, concern) values (:'QORG', :'lead2', 1, :'p2', 'timeline', 'We need it in 3 weeks') returning id as obj_t \gset
insert into sales.objections (organization_id, lead_id, round, proposal_id, kind, concern) values (:'QORG', :'lead2', 2, :'p2', 'price', 'Too expensive') returning id as obj_p \gset
select pg_temp.p1r_check((select outcome from sales.p1r_record_timeline_recalc(:'obj_p', 3, 6, 9, 'does_not_fit', '["x"]')) = 'not_a_timeline_objection', 'only a timeline objection is recalculated');
select pg_temp.p1r_check((select outcome from sales.p1r_record_timeline_recalc(:'obj_t', 3, 6, 9, 'fits', '["x"]')) = 'refused', 'a verdict that disagrees with its own numbers is refused');
select pg_temp.p1r_check((select outcome from sales.p1r_record_timeline_recalc(:'obj_t', 3, 9, 6, 'does_not_fit', '["x"]')) = 'refused', 'an estimate whose short end is longer than its long end is refused');
select pg_temp.p1r_check((select outcome from sales.p1r_record_timeline_recalc(:'obj_t', 3, 6, 9, 'does_not_fit', '[]')) = 'refused', 'a recalculation with no options is refused: an objection is answered with something');
select pg_temp.p1r_check((select outcome from sales.p1r_record_timeline_recalc(gen_random_uuid(), 3, 6, 9, 'does_not_fit', '["x"]')) = 'unknown_objection', 'an unknown objection is named');
select outcome as rc1, recalc_id as rid1 from sales.p1r_record_timeline_recalc(:'obj_t', 3, 6, 9, 'does_not_fit', '["Phase the scope","Ask the owner","Keep the estimate"]') \gset
select pg_temp.p1r_check(:'rc1' = 'recorded' and (select proposal_id from sales.p1r_timeline_recalcs where id = :'rid1') = :'p2', 'the recalculation is recorded against the objection and the quotation it was about');
select pg_temp.p1r_check((select status from sales.proposals where id = :'p2') = 'sent' and (select total_minor from sales.proposals where id = :'p2') = 300000, 'and changes neither the quotation nor its price');
select pg_temp.p1r_check((select count(*) from audit.audit_log where organization_id = :'QORG' and action = 'objection.timeline_recalculated') = 1, 'it is audited');
select pg_temp.p1r_as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.p1r_check((select count(*) from sales.p1r_timeline_objections(:'opp2')) = 1 and (select verdict from sales.p1r_timeline_objections(:'opp2')) = 'does_not_fit' and (select asked_weeks from sales.p1r_timeline_objections(:'opp2')) = 3, 'the deal''s timeline objections read back with their latest recalculation');
select pg_temp.p1r_as_user(:'QOTHU', :'QOTH', 'owner');
select pg_temp.p1r_check((select count(*) from sales.p1r_timeline_objections(:'opp2')) = 0, 'another organisation reads none');

-- ═══ tenancy ═══
select pg_temp.p1r_check((select count(*) from core.unguarded_org_fks() u where u.child in ('sales.p1r_quote_delivery', 'sales.p1r_timeline_recalcs', 'finance.invoices')) = 0, 'TENANCY: every organisation-scoped foreign key touched here is guarded');

-- ═══ red-proofs: remove each control from the LIVE definition and see the check fail ═══
select pg_temp.p1r_as_service();
-- 1. the line discount comes off the amount
select pg_temp.p1r_mutate('sales.proposal_item_amount()'::regprocedure, 'v_gross - coalesce(new.line_discount_minor, 0)', 'v_gross');
select pg_temp.p1r_draft_new(:'QORG', :'acct', :'lead', 'red one', 100000) as pr1 \gset
select id as rl1 from sales.proposal_items where proposal_id = :'pr1' \gset
update sales.proposal_items set line_discount_minor = 2000, line_discount_reason = 'red' where id = :'rl1';
select pg_temp.p1r_check((select amount_minor from sales.proposal_items where id = :'rl1') = 100000, 'RED-PROOF: without the subtraction a discounted line still bills its full price (the control is what takes it off)');
-- 2. the negotiation limit counts line discounts
select pg_temp.p1r_mutate('sales.p1o_check_negotiation_limits(uuid)'::regprocedure, 'v.discount_minor + sales.p1r_line_discount_total(v.id)', 'v.discount_minor');
select pg_temp.p1r_as_user(:'QOWN', :'QORG', 'owner');
select pg_temp.p1r_check(not ((sales.p1o_check_negotiation_limits(:'p1')) @> '[{"limit":"max_discount_minor"}]'::jsonb), 'RED-PROOF: without counting line discounts a discount hidden in a line passes the limit');
-- 3. viewed is only recorded on a read receipt
select pg_temp.p1r_as_service();
select pg_temp.p1r_mutate('sales.p1r_quote_receipt()'::regprocedure, 'if v_wire = ''read'' and v_row.viewed_at is null then', 'if false then');
select pg_temp.p1r_draft_new(:'QORG', :'acct', :'lead', 'red three', 100000) as pr3 \gset
insert into crm.conversation_messages (organization_id, conversation_id, seq, author_type, body, metadata) values (:'QORG', :'conv', 5, 'system', 'Quotation red', '{"direction":"outbound","delivery":"sent"}') returning id as msg5 \gset
update sales.proposals set sent_message_ref = :'msg5' where id = :'pr3';
select set_config('crm.sanctioned_write', 'on', true);
update crm.conversation_messages set metadata = metadata || '{"wire_status":"read"}' where id = :'msg5';
select pg_temp.p1r_check((select viewed_at from sales.p1r_quote_delivery where proposal_id = :'pr3') is null, 'RED-PROOF: without the read branch a read receipt never becomes proposal.viewed');
-- 4. the verdict must agree with the numbers (the table''s own check is the control)
alter table sales.p1r_timeline_recalcs drop constraint p1r_recalc_verdict_agrees;
select outcome as red4 from sales.p1r_record_timeline_recalc(:'obj_t', 3, 6, 9, 'fits', '["x"]') \gset
select pg_temp.p1r_check(:'red4' = 'recorded', 'RED-PROOF: without the table''s verdict check a "fits" for a 3-week ask against 6-9 weeks is recorded');

rollback;
\echo 'verify-p1r-quotation: all checks passed'
