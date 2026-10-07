-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 7 round two (migration 20261129000000), driven through the REAL doors on a scratch Postgres, then RED-PROVEN: each control is removed from the LIVE
-- function definition (pg_get_functiondef + replace), the check is watched to fail, and the definition is restored. A no-op mutation raises.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p789-phase-seven-round2.sql        (rolls back)
--
-- No model, deployment host, monitor, payment provider or client ran. Every payment, acceptance and outage here is a fixture row; no e-mail or message is sent.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
create or replace function pg_temp.as_client(p_sub uuid, p_org uuid, p_account uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', 'client_member', 'client_account_id', p_account))::text, true); end $$;
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('role','service_role')::text, true); end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;
grant execute on function pg_temp.as_client(uuid, uuid, uuid) to public;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.door_off() returns void language plpgsql as $$
begin perform set_config('projects.p789_door', 'off', true); perform set_config('projects.p7_door', 'off', true); end $$;
create or replace function pg_temp.refused(stmt text, needle text) returns boolean language plpgsql as $$
begin execute stmt; return false;
exception when restrict_violation or check_violation then return position(needle in sqlerrm) > 0; end $$;
-- red-proof helpers
create or replace function pg_temp.mutate(p_fn regprocedure, p_from text, p_to text) returns text language plpgsql as $$
declare v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_from in v_def) = 0 then raise exception 'RED-PROOF NO-OP: % does not contain %', p_fn, p_from; end if;
  execute replace(v_def, p_from, p_to);
  return v_def;
end $$;
create or replace function pg_temp.expect_red(ok boolean, what text) returns void language plpgsql as $$
begin if ok is true then raise exception 'RED-PROOF STAYED GREEN: %', what; end if; raise notice 'red %', what; end $$;
grant execute on function pg_temp.expect_red(boolean, text) to public;
create or replace function pg_temp.restore(p_def text) returns void language plpgsql as $$ begin execute p_def; end $$;
-- run p_probe (a boolean expression that is TRUE while the control holds) with the control removed; it must come back false. Side effects of the probe are rolled back.
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

\set ORG '00000000-0000-4000-8000-000000789a01'
\set ORGB '00000000-0000-4000-8000-000000789b01'
\set OWNER '00000000-0000-4000-8000-00000789f901'
\set ADM '00000000-0000-4000-8000-00000789f902'
\set DL '00000000-0000-4000-8000-00000789f903'
\set MEM '00000000-0000-4000-8000-00000789f904'
\set FIN '00000000-0000-4000-8000-00000789f905'
\set UB '00000000-0000-4000-8000-00000789f906'
\set CL '00000000-0000-4000-8000-00000789f907'
\set CL2 '00000000-0000-4000-8000-00000789f908'
\set C1 '1111111111111111111111111111111111111111'
insert into core.organizations (id, name, slug) values (:'ORG', 'P789 Agency', 'p789-agency'), (:'ORGB', 'P789 Other', 'p789-other');
insert into auth.users (id, email) values (:'OWNER','p789-o@example.test'),(:'ADM','p789-a@example.test'),(:'DL','p789-d@example.test'),(:'MEM','p789-m@example.test'),(:'FIN','p789-f@example.test'),(:'UB','p789-b@example.test'),(:'CL','p789-c@example.test'),(:'CL2','p789-c2@example.test');
insert into core.memberships (organization_id, user_id, role) values (:'ORG',:'OWNER','owner'),(:'ORG',:'ADM','ops_admin'),(:'ORG',:'DL','delivery_lead'),(:'ORG',:'MEM','member'),(:'ORG',:'FIN','finance'),(:'ORGB',:'UB','owner');
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p789 client <Acme & "Co">') returning id \gset A_
insert into core.client_accounts (organization_id, name) values (:'ORG', 'zztest p789 other client') returning id \gset A2_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p789 <b>shop</b> & "store"', 'ZP789-1') returning id \gset PC_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p789 not completed', 'ZP789-2') returning id \gset PN_
insert into projects.projects (organization_id, client_account_id, name, project_code) values (:'ORG', :'A_id', 'zztest p789 incidents', 'ZP789-3') returning id \gset PI_

set local session_replication_role = replica;
insert into projects.phase_seven (organization_id, project_id, phase_six_handoff_id, candidate_id, commit_ref, artifact_sha256, state) values (:'ORG', :'PC_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('a', 64), 'completed') returning id \gset PSC_
insert into projects.phase_seven (organization_id, project_id, phase_six_handoff_id, candidate_id, commit_ref, artifact_sha256, state) values (:'ORG', :'PI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('a', 64), 'handover_preparing') returning id \gset PSI_
insert into projects.p7_handover_packages (organization_id, project_id, phase_seven_id, version, status, deployment_id, validation_run_id, candidate_id, commit_ref, artifact_sha256, warranty_ends_on, admin_approved_by, admin_approved_at, delivered_by, delivered_at)
  values (:'ORG', :'PC_id', :'PSC_id', 2, 'delivered', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'C1', repeat('a', 64), '2027-06-30', :'OWNER', now(), :'OWNER', now()) returning id \gset PKC_
insert into projects.p7_completion_records (organization_id, project_id, phase_seven_id, package_id, deployment_id, validation_run_id, candidate_id, commit_ref, payload, completed_at)
  values (:'ORG', :'PC_id', :'PSC_id', :'PKC_id', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), :'C1',
  '{"release":{"version":"1.4.0"},"production":{"deployedAt":"2026-12-01T09:00:00Z"},"handover":{"version":2},"acceptance":{"client":"Priya <Client>","evidenceKind":"signed_email"},"finance":{"status":"closed"},"support":{"warrantyEndsOn":"2027-06-30"},"knownLimitations":[{"title":"a"},{"title":"b"}]}',
  '2026-12-01 10:00:00+00');
-- finance: three invoices of the client (issued / draft / another client), payments, receipts
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'PC_id', 'P789-INV-1', 'issued', 118000, 100000, 18000, 'service', now()) returning id \gset I1_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A2_id', null, 'P789-INV-2', 'issued', 50000, 50000, 0, 'service', now()) returning id \gset I2_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind) values (:'ORG', :'A_id', :'PC_id', 'P789-INV-3', 'draft', 9000, 9000, 0, 'service') returning id \gset I3_
insert into finance.invoices (organization_id, client_account_id, project_id, number, status, total_minor, subtotal_minor, tax_minor, kind, issued_at) values (:'ORG', :'A_id', :'PC_id', 'P789-INV-4', 'issued', 7000, 7000, 0, 'service', now()) returning id \gset I4_
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, captured_at, verified_at, verified_by) values (:'ORG', :'I1_id', 'p789-pay-1', 118000, 'captured', now(), now(), :'OWNER') returning id \gset Y1_
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, captured_at, verified_at, verified_by) values (:'ORG', :'I2_id', 'p789-pay-2', 50000, 'captured', now(), now(), :'OWNER') returning id \gset Y2_
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, captured_at, verified_at, verified_by) values (:'ORG', :'I3_id', 'p789-pay-3', 9000, 'captured', now(), now(), :'OWNER') returning id \gset Y3_
insert into finance.payments (organization_id, invoice_id, provider_payment_id, amount_minor, status, captured_at) values (:'ORG', :'I4_id', 'p789-pay-4', 7000, 'captured', now()) returning id \gset Y4_
insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency) values (:'ORG', :'I1_id', :'Y1_id', 'RCT-P789-1', 118000, 'INR') returning id \gset R1_
insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency) values (:'ORG', :'I2_id', :'Y2_id', 'RCT-P789-2', 50000, 'INR') returning id \gset R2_
insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency) values (:'ORG', :'I3_id', :'Y3_id', 'RCT-P789-3', 9000, 'INR') returning id \gset R3_
insert into finance.receipts (organization_id, invoice_id, payment_id, number, amount_minor, currency) values (:'ORG', :'I4_id', :'Y4_id', 'RCT-P789-4', 7000, 'INR') returning id \gset R4_
-- client action requests
insert into projects.p7c_client_action_requests (organization_id, project_id, client_account_id, kind, title, instructions, due_at) values (:'ORG', :'PC_id', :'A_id', 'dns_change', 'req soon', 'set the A record', '2026-12-12 00:00:00+00') returning id \gset Q1_
insert into projects.p7c_client_action_requests (organization_id, project_id, client_account_id, kind, title, instructions, due_at) values (:'ORG', :'PC_id', :'A_id', 'store_account', 'req later', 'create the account', '2026-12-20 00:00:00+00') returning id \gset Q2_
insert into projects.p7c_client_action_requests (organization_id, project_id, client_account_id, kind, title, instructions, due_at) values (:'ORG', :'PC_id', :'A_id', 'account_access', 'req late', 'share access', '2026-12-05 00:00:00+00') returning id \gset Q3_
insert into projects.p7c_client_action_requests (organization_id, project_id, client_account_id, kind, title, instructions, due_at) values (:'ORG', :'PC_id', :'A_id', 'content_supply', 'req cancelled soon', 'send the logo', '2026-12-11 00:00:00+00') returning id \gset Q4_
insert into projects.p7c_client_action_requests (organization_id, project_id, client_account_id, kind, title, instructions, due_at, status, cancelled_by, cancelled_at, cancel_reason) values (:'ORG', :'PC_id', :'A_id', 'other', 'req cancelled never swept', 'not needed any more', '2026-12-01 00:00:00+00', 'cancelled', :'OWNER', now(), 'no longer needed') returning id \gset Q5_
-- deployment + incidents (the incident trigger is switched on for replica mode so the notification trigger fires on fixture rows)
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (:'ORG', :'PI_id', :'PSI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('a', 64), 'production', 1, 'p789-dep') returning id \gset DEP_
alter table projects.p7_incidents enable always trigger p789_incident_notifies_admin;
insert into projects.p7_incidents (organization_id, project_id, phase_seven_id, deployment_id, candidate_id, commit_ref, incident_type, severity, state, impact, opened_at) values (:'ORG', :'PI_id', :'PSI_id', :'DEP_id', gen_random_uuid(), :'C1', 'runtime_failure', 'sev3', 'open', 'slow checkout', '2026-12-02 10:00:00+00') returning id \gset INCA_
insert into projects.p7_incidents (organization_id, project_id, phase_seven_id, deployment_id, candidate_id, commit_ref, incident_type, severity, state, impact, opened_at) values (:'ORG', :'PI_id', :'PSI_id', :'DEP_id', gen_random_uuid(), :'C1', 'provider_outage', 'sev2', 'open', 'host unreachable', '2026-12-02 10:00:00+00') returning id \gset INCP_
set local session_replication_role = origin;
select pg_temp.door_off();

-- ═════════ 1. P7-ARC-01 the certificate ═════════
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.check((select outcome from projects.render_completion_certificate(:'PC_id')) = 'not_authorized', 'a plain member cannot render the certificate');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from projects.render_completion_certificate(:'PC_id')) = 'not_authorized', 'another organization cannot render it');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.render_completion_certificate(:'PN_id')) = 'not_completed', 'a project that has not completed has no certificate');
select pg_temp.check((select outcome from projects.render_completion_certificate(gen_random_uuid())) = 'not_found', 'an unknown project is not found');
select outcome as "CERT_out", certificate_id as "CERT_id" from projects.render_completion_certificate(:'PC_id') \gset
select pg_temp.check(:'CERT_out' = 'rendered', 'a delivery lead renders the certificate of a completed project');
select pg_temp.check((select outcome from projects.render_completion_certificate(:'PC_id')) = 'already_rendered' and (select certificate_id from projects.render_completion_certificate(:'PC_id')) = :'CERT_id'::uuid, 'rendering again returns the same certificate: one per completion record');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.completion_certificate_rendered' and subject_id = :'PC_id'::uuid) = 1, 'one rendered event, not two');
select body_html as "CERT_html" from projects.p789_completion_certificate(:'PC_id') \gset
select pg_temp.check(position('&lt;b&gt;shop&lt;/b&gt; &amp; &quot;store&quot;' in :'CERT_html') > 0 and position('<b>shop</b>' in :'CERT_html') = 0, 'the project name is HTML-escaped: markup in a name cannot inject into the document');
select pg_temp.check(position('Priya &lt;Client&gt;' in :'CERT_html') > 0 and position('1.4.0' in :'CERT_html') > 0 and position('2027-06-30' in :'CERT_html') > 0 and position('-20261201</td>' in :'CERT_html') > 0 and position('<td>CERT-' in :'CERT_html') > 0, 'client acceptance, release version, warranty end and the number come from the completion record');
select pg_temp.check(position('not signed' in :'CERT_html') > 0, 'the document says it is not signed');
select pg_temp.check((select intact and content_sha256 = encode(sha256(convert_to(body_html, 'UTF8')), 'hex') from projects.p789_completion_certificate(:'PC_id')), 'the stored SHA-256 matches the body');
select pg_temp.as_client(:'CL', :'ORG', :'A_id');
select pg_temp.check((select count(*) from projects.p789_completion_certificate(:'PC_id')) = 1, 'the owning client reads its certificate');
select pg_temp.as_client(:'CL2', :'ORG', :'A2_id');
select pg_temp.check((select count(*) from projects.p789_completion_certificate(:'PC_id')) = 0, 'another client of the same agency reads none');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_completion_certificate(:'PC_id')) = 0 and (select count(*) from projects.p789_completion_certificates) = 0, 'another organization reads none (door and table)');
reset role;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p789_completion_certificates set body_html = %L where id = %L', repeat('x', 300), :'CERT_id'), 'door'), 'a certificate is not edited by a direct statement');
select pg_temp.check(pg_temp.refused(format('delete from projects.p789_completion_certificates where id = %L', :'CERT_id'), 'never deleted'), 'and never deleted');
select set_config('projects.p789_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p789_completion_certificates set body_html = %L where id = %L', repeat('x', 300), :'CERT_id'), 'decision columns'), 'even through the door, the body of a certificate cannot change');
select pg_temp.door_off();

-- ═════════ 2. P7-FIN-05/06 the receipt file ═════════
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.check((select outcome from finance.p789_render_receipt_documents(:'R1_id')) = 'not_authorized', 'a plain member cannot render a receipt');
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.check((select outcome from finance.p789_render_receipt_documents(null)) = 'a_receipt_is_required', 'a person renders one receipt, never a sweep');
select pg_temp.check((select outcome from finance.p789_render_receipt_documents(:'R1_id')) = 'rendered', 'a finance user renders the receipt of a verified payment');
select pg_temp.check((select outcome from finance.p789_render_receipt_documents(:'R1_id')) = 'nothing_to_render', 'rendering again writes nothing');
select pg_temp.check((select outcome from finance.p789_render_receipt_documents(:'R4_id')) = 'nothing_to_render' and not exists (select 1 from finance.p789_receipt_documents where receipt_id = :'R4_id'), 'a receipt whose payment was never verified gets no document');
select pg_temp.check(position('INR 1,180.00' in (select body_html from finance.p789_receipt_documents where receipt_id = :'R1_id')) > 0
   and position('RCT-P789-1' in (select body_html from finance.p789_receipt_documents where receipt_id = :'R1_id')) > 0
   and position('Acme &amp; &quot;Co&quot;' in (select body_html from finance.p789_receipt_documents where receipt_id = :'R1_id')) > 0
   and position('<Acme' in (select body_html from finance.p789_receipt_documents where receipt_id = :'R1_id')) = 0, 'the document states the amount, number and escaped client name from the rows');
select pg_temp.as_service();
select pg_temp.check((select rendered from finance.p789_render_receipt_documents(null)) = 2, 'the service-role sweep renders the rest (the two verified ones), not the unverified one');
select pg_temp.check((select count(*) from finance.p789_receipt_documents where organization_id = :'ORG') = 3, 'three documents exist');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from finance.p789_render_receipt_documents(:'R1_id')) = 'nothing_to_render', 'another organization''s Admin renders none of this organization''s receipts');
set local role authenticated;
select pg_temp.check((select count(*) from finance.p789_receipt_documents) = 0, 'and reads none of its documents');
reset role;
select pg_temp.as_client(:'CL', :'ORG', :'A_id');
select pg_temp.check((select count(*) from projects.p789_client_receipt_document(:'Y1_id')) = 1, 'the client reads the receipt of its own verified payment');
select pg_temp.check((select count(*) from projects.p789_client_receipt_document(:'Y2_id')) = 0, 'but not another client''s');
select pg_temp.check((select count(*) from projects.p789_client_receipt_document(:'Y3_id')) = 0, 'nor a receipt on an invoice that is still a draft');
select pg_temp.check((select count(*) from projects.p789_client_receipt_document(:'Y4_id')) = 0, 'nor one for a payment not yet verified');
set local role authenticated;
select pg_temp.check((select count(*) from finance.p789_receipt_documents) = 0, 'a client has no direct read of the finance table');
reset role;
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update finance.p789_receipt_documents set body_html = %L where receipt_id = %L', repeat('x', 300), :'R1_id'), 'door'), 'a receipt document is not edited by a direct statement');

-- ═════════ 3. P7-PM-07 reminders ═════════
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p789_sweep_client_action_reminders()) = 'not_authorized', 'a plain member cannot schedule reminders');
select pg_temp.as_service();
select pg_temp.check((select scheduled from projects.p789_sweep_client_action_reminders(:'ORG', '2026-12-10 00:00:00+00')) = 3, 'at Dec 10: the overdue one and the two due within 3 days get a reminder; the later one does not');
select pg_temp.check((select kind from projects.p789_client_action_reminders where request_id = :'Q3_id') = 'overdue' and (select kind from projects.p789_client_action_reminders where request_id = :'Q1_id') = 'due_soon'
                     and not exists (select 1 from projects.p789_client_action_reminders where request_id = :'Q2_id'), 'kinds are decided by the injected clock');
select pg_temp.check((select scheduled from projects.p789_sweep_client_action_reminders(:'ORG', '2026-12-10 00:00:00+00')) = 0, 'a second sweep schedules nothing: one reminder per request per kind');
select pg_temp.check((select scheduled from projects.p789_sweep_client_action_reminders(:'ORG', '2026-12-13 00:00:00+00')) = 2, 'three days later the first and the fourth requests are overdue (a second kind each)');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.client_action_reminder_due' and (payload ->> 'projectId')::uuid = :'PC_id'::uuid) = 5, 'one event per reminder');
select pg_temp.check((select outcome from projects.p789_sweep_client_action_reminders(:'ORG', null, 0)) = 'bad_window', 'a zero-day window is refused');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select scheduled from projects.p789_sweep_client_action_reminders(null, now() + interval '400 days')) = 0, 'a person cannot move the clock: the passed time is ignored');
select reminder_id as "REM_id" from projects.p789_pending_client_action_reminders(:'PC_id') where request_id = :'Q1_id' and kind = 'due_soon' \gset
select pg_temp.check((select count(*) from projects.p789_pending_client_action_reminders(:'PC_id')) = 5, 'five reminders wait for a person');
select pg_temp.check((select outcome from projects.p789_record_client_action_reminder_sent(:'REM_id', 'pigeon', 'told the client by phone today')) = 'bad_channel', 'channel must be one we know');
select pg_temp.check((select outcome from projects.p789_record_client_action_reminder_sent(:'REM_id', 'call', 'short')) = 'note_required', 'a note of substance is required');
select pg_temp.check((select outcome from projects.p789_record_client_action_reminder_sent(:'REM_id', 'call', 'password=hunter2hunter2 told them')) = 'contains_secret', 'a secret in the note is refused');
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p789_record_client_action_reminder_sent(:'REM_id', 'call', 'told the client by phone today')) = 'not_authorized', 'a plain member cannot record a reminder');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_record_client_action_reminder_sent(:'REM_id', 'call', 'told the client by phone today')) = 'recorded', 'a delivery lead records that they reminded the client');
select pg_temp.check((select outcome from projects.p789_record_client_action_reminder_sent(:'REM_id', 'call', 'told the client by phone today')) = 'already_recorded', 'recorded once');
select pg_temp.check((select count(*) from projects.p789_pending_client_action_reminders(:'PC_id')) = 4, 'it leaves the waiting list');
select pg_temp.as_service();
set local session_replication_role = replica;
update projects.p7c_client_action_requests set status = 'cancelled', cancelled_by = :'OWNER', cancelled_at = now(), cancel_reason = 'no longer needed' where id = :'Q4_id';
set local session_replication_role = origin;
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check(not exists (select 1 from projects.p789_pending_client_action_reminders(:'PC_id') where request_id = :'Q4_id'), 'a request that is no longer open drops out of the waiting list (derived, not stored)');
select pg_temp.check(not exists (select 1 from projects.p789_pending_client_action_reminders(:'PC_id') where reminder_id = :'REM_id'::uuid), 'and so does a delivered one');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_pending_client_action_reminders()) = 0 and (select count(*) from projects.p789_client_action_reminders) = 0, 'another organization sees none');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('delete from projects.p789_client_action_reminders where id = %L', :'REM_id'), 'never deleted'), 'a reminder is never deleted');
select set_config('projects.p789_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p789_client_action_reminders set kind = %L where id = %L', 'overdue', :'REM_id'), 'decision columns'), 'what a reminder was about is never rewritten');
select pg_temp.door_off();

-- ═════════ 4. P7-INC-07 Admin notification policy ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_set_admin_notification_policy('sev1', 'email', 30, 'tell the owner fast')) = 'not_authorized', 'a delivery lead cannot set the policy');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.p789_set_admin_notification_policy('sev9', 'email', 30, 'tell the owner fast')) = 'bad_severity', 'severity must be sev1..3');
select pg_temp.check((select outcome from projects.p789_set_admin_notification_policy('sev1', 'carrier_pigeon', 30, 'tell the owner fast')) = 'bad_channel', 'channel must be known');
select pg_temp.check((select outcome from projects.p789_set_admin_notification_policy('sev1', 'email', 0, 'tell the owner fast')) = 'bad_minutes', 'minutes must be positive');
select pg_temp.check((select outcome from projects.p789_set_admin_notification_policy('sev1', 'email', 30, 'x')) = 'reason_required', 'a reason is required');
select pg_temp.check((select version from projects.p789_set_admin_notification_policy('sev1', 'whatsapp', 45, 'whatsapp first')) = 1 and (select version from projects.p789_set_admin_notification_policy('sev1', 'email', 30, 'tell the owner fast')) = 2, 'policies are versioned: the highest wins');
-- a sev1 incident now opens: the notification follows policy version 2
set local session_replication_role = replica;
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (:'ORG', :'PI_id', :'PSI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('b', 64), 'production', 2, 'p789-dep2') returning id \gset DEP2_
insert into projects.p7_incidents (organization_id, project_id, phase_seven_id, deployment_id, candidate_id, commit_ref, incident_type, severity, state, impact, opened_at) values (:'ORG', :'PI_id', :'PSI_id', :'DEP2_id', gen_random_uuid(), :'C1', 'security_incident', 'sev1', 'open', 'suspicious logins', '2026-12-02 11:00:00+00') returning id \gset INC1_
set local session_replication_role = origin;
select pg_temp.check((select channel from projects.p789_admin_notifications where incident_id = :'INC1_id') = 'email' and (select delivery from projects.p789_admin_notifications where incident_id = :'INC1_id') = 'relay_by_person_required'
                     and (select due_by from projects.p789_admin_notifications where incident_id = :'INC1_id') = '2026-12-02 11:30:00+00'::timestamptz, 'a sev1 incident notifies by policy version 2 (email, 30 minutes); an e-mail is a person''s relay, not delivered by existing');
select pg_temp.check((select policy_id is null and channel = 'internal_inbox' and delivery = 'inbox' and due_by = '2026-12-02 11:00:00+00'::timestamptz from projects.p789_admin_notifications where incident_id = :'INCA_id'), 'with no policy for its severity the internal inbox applies within 60 minutes, and the row says there was no policy');
select pg_temp.check(position('security_incident' in client_safe_text) = 0 and position(:'C1' in client_safe_text) = 0 and position('suspicious' in client_safe_text) = 0 and position('security_incident' in technical_summary) > 0 and position('suspicious logins' in technical_summary) > 0,
                     'the client-safe wording carries none of the technical detail, which stays in the internal summary') from projects.p789_admin_notifications where incident_id = :'INC1_id';
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.incident_admin_notification_due' and subject_id = :'INC1_id'::uuid) = 1, 'a notification event was emitted');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select count(*) from projects.p789_admin_notification_queue()) = 0, 'the queue is for Admins only');
select pg_temp.check((select outcome from projects.p789_acknowledge_admin_notification((select id from projects.p789_admin_notifications where incident_id = :'INC1_id'), 'seen and on it')) = 'not_authorized', 'a delivery lead cannot acknowledge an Admin notification');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select count(*) from projects.p789_admin_notification_queue()) = 3 and (select count(*) from projects.p789_admin_notification_queue('2027-01-01 00:00:00+00') where overdue) = 3
                     and (select count(*) from projects.p789_admin_notification_queue('2026-12-02 11:15:00+00') where overdue) = 2, 'the queue lists them and derives overdue from the clock it is handed');
select id as "NOT_id" from projects.p789_admin_notifications where incident_id = :'INC1_id' \gset
select pg_temp.check((select outcome from projects.p789_acknowledge_admin_notification(:'NOT_id', 'ok')) = 'note_required', 'a note is required');
select pg_temp.check((select outcome from projects.p789_acknowledge_admin_notification(:'NOT_id', 'seen and on it')) = 'acknowledged', 'an Admin acknowledges');
select pg_temp.check((select outcome from projects.p789_acknowledge_admin_notification(:'NOT_id', 'seen and on it')) = 'already_acknowledged', 'once');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
select pg_temp.check((select outcome from projects.p789_acknowledge_admin_notification(:'NOT_id', 'seen and on it')) = 'not_authorized' or (select outcome from projects.p789_acknowledge_admin_notification(:'NOT_id', 'seen and on it')) = 'not_found', 'another organization''s Admin cannot touch it');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_admin_notification_queue()) = 0 and (select count(*) from projects.p789_admin_notifications) = 0, 'nor read it');
reset role;
select pg_temp.door_off();
select pg_temp.check(pg_temp.refused(format('update projects.p789_admin_notifications set client_safe_text = %L where id = %L', repeat('x', 40), :'NOT_id'), 'door'), 'a notification is not edited directly');

-- ═════════ 5. P7-INC-08 provider-outage decisions ═════════
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCA_id', 'hosting', 'HostCo', 'wait', 'status page', now() + interval '1 hour')) = 'not_a_provider_incident', 'only a provider incident takes a provider decision');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'wait', 'status page', null)) = 'next_check_in_the_future_required', 'waiting names when to look again');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'retry', 'status page', now() - interval '1 hour')) = 'next_check_in_the_future_required', 'and that time is in the future');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'failover', 'status page', null, null)) = 'failover_target_required', 'a fail-over names its target');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'stop', 'status page', null, 'OtherHost')) = 'target_only_for_failover', 'only a fail-over has a target');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'stop', '  ')) = 'evidence_required', 'evidence is required');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'stop', 'password=hunter2hunter2')) = 'contains_secret', 'a secret is refused');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'shrug', 'status page')) = 'bad_decision', 'decision vocabulary is closed');
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'stop', 'status page')) = 'not_authorized', 'a plain member cannot record a provider decision');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'wait', 'status page', now() + interval '1 hour')) = 'recorded', 'wait is recorded');
select record_id as "FO_id" from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'failover', 'status page shows 3h outage', null, 'StandbyHost') \gset
select pg_temp.check(:'FO_id' is not null, 'a fail-over decision is recorded (and nothing is failed over)');
select pg_temp.check((select outcome from projects.p789_record_provider_decision(:'INCP_id', 'hosting', 'HostCo', 'failover', 'again', null, 'StandbyHost')) = 'a_failover_is_already_pending', 'one pending fail-over per incident');
select pg_temp.check((select outcome from projects.p789_approve_provider_failover(:'FO_id', 'approved by me')) = 'self_approval', 'the person who recorded a fail-over cannot approve it');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_approve_provider_failover(:'FO_id', 'approved by dl')) = 'not_authorized', 'only an Admin approves');
select pg_temp.check((select outcome from projects.p789_record_provider_failover_executed(:'FO_id', 'ran the runbook, ticket 42')) = 'not_approved', 'an unapproved fail-over cannot be recorded as executed');
select pg_temp.as_user(:'OWNER', :'ORG', 'owner');
select pg_temp.check((select outcome from projects.p789_approve_provider_failover((select id from projects.p789_provider_failover_records where decision = 'wait' and incident_id = :'INCP_id'), 'approve a wait')) = 'not_a_failover', 'only a fail-over is approved');
select pg_temp.check((select outcome from projects.p789_approve_provider_failover(:'FO_id', 'ok')) = 'note_required', 'the approval carries a note');
select pg_temp.check((select outcome from projects.p789_approve_provider_failover(:'FO_id', 'independent Admin approval')) = 'approved', 'an independent Admin approves');
select pg_temp.check((select outcome from projects.p789_approve_provider_failover(:'FO_id', 'independent Admin approval')) = 'already_approved', 'once');
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_record_provider_failover_executed(:'FO_id', 'ran the runbook, ticket 42')) = 'recorded', 'after approval a person records the execution with evidence');
select pg_temp.check((select outcome from projects.p789_record_provider_failover_executed(:'FO_id', 'ran the runbook, ticket 42')) = 'already_recorded', 'once');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_provider_failover_records) = 0, 'another organization reads none');
reset role;
select pg_temp.door_off();
select set_config('projects.p789_door', 'on', true);
select pg_temp.check(pg_temp.refused(format('update projects.p789_provider_failover_records set approved_by = recorded_by where id = %L', :'FO_id'), 'decision columns') or pg_temp.refused(format('update projects.p789_provider_failover_records set decision = %L where id = %L', 'wait', :'FO_id'), 'decision columns'), 'a recorded decision is never rewritten');
select pg_temp.door_off();

-- ═════════ 6. P7-NEG-01 outage cases ═════════
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.check((select outcome from projects.p789_record_outage_case('meteor', 'waited', now() - interval '1 hour', 'a long enough summary')) = 'bad_kind', 'kind vocabulary is closed');
select pg_temp.check((select outcome from projects.p789_record_outage_case('audit_store_failure', 'work_held', now() - interval '1 hour', 'audit store unreachable for a while')) = 'audit_gap_must_be_stated', 'an audit-store failure must state the audit gap');
select pg_temp.check((select outcome from projects.p789_record_outage_case('provider_outage', 'failed_over', now() - interval '1 hour', 'moved to the standby host', null, :'INCA_id')) = 'no_recorded_failover_execution', 'failed_over needs a recorded, executed fail-over');
select pg_temp.check((select outcome from projects.p789_record_outage_case('provider_outage', 'failed_over', now() - interval '2 hours', 'moved to the standby host', :'PI_id', :'INCP_id')) = 'recorded', 'it is accepted once the fail-over execution is on record');
select case_id as "OC_id" from projects.p789_record_outage_case('audit_store_failure', 'work_held', now() - interval '3 hours', 'audit store unreachable for a while', :'PI_id', null, true) \gset
select pg_temp.check((select outcome from projects.p789_resolve_outage_case(:'OC_id', now() - interval '1 hour', 'audit store restored, gap noted')) = 'admin_required_for_audit_gap', 'an audit gap is accepted only by an Admin');
select pg_temp.check((select outcome from projects.p789_record_outage_case('cloud_timeout', 'retried', now() + interval '2 days', 'timeouts talking to the cloud')) = 'bad_observed_time', 'an outage cannot start in the future');
select case_id as "OC2_id" from projects.p789_record_outage_case('cloud_timeout', 'retried', now() - interval '3 hours', 'timeouts talking to the cloud') \gset
select pg_temp.check((select outcome from projects.p789_resolve_outage_case(:'OC2_id', now() - interval '4 hours', 'timeouts stopped on their own')) = 'bad_end_time', 'the end cannot precede the start');
select pg_temp.check((select outcome from projects.p789_resolve_outage_case(:'OC2_id', now() - interval '1 hour', 'timeouts stopped on their own')) = 'resolved', 'a delivery lead resolves an ordinary case');
select pg_temp.check((select outcome from projects.p789_resolve_outage_case(:'OC2_id', now() - interval '1 hour', 'timeouts stopped on their own')) = 'already_resolved', 'once');
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from projects.p789_resolve_outage_case(:'OC_id', now() - interval '1 hour', 'audit store restored, gap noted')) = 'resolved', 'an Admin accepts the audit gap');
select pg_temp.as_user(:'UB', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select count(*) from projects.p789_outage_cases) = 0, 'another organization reads none');
reset role;

-- ═════════ 7. P7-QA-07 events from the rows that change ═════════
select pg_temp.as_service();
set local session_replication_role = replica;
insert into projects.p7_validation_runs (organization_id, project_id, deployment_id, candidate_id, commit_ref, kind, status, started_by) values (:'ORG', :'PI_id', :'DEP_id', gen_random_uuid(), :'C1', 'smoke', 'running', :'OWNER') returning id \gset V1_
insert into projects.p7_validation_runs (organization_id, project_id, deployment_id, candidate_id, commit_ref, kind, status, started_by) values (:'ORG', :'PI_id', :'DEP2_id', gen_random_uuid(), :'C1', 'smoke', 'running', :'OWNER') returning id \gset V2_
insert into projects.p7_validation_runs (organization_id, project_id, deployment_id, candidate_id, commit_ref, kind, status, started_by) values (:'ORG', :'PI_id', :'DEP2_id', gen_random_uuid(), :'C1', 'live_journey', 'running', :'OWNER') returning id \gset V3_
set local session_replication_role = origin;
alter table projects.p7_validation_runs enable always trigger p789_validation_runs_events;
alter table projects.p7_deployments enable always trigger p789_deployments_rollback_event;
set local session_replication_role = replica;
update projects.p7_validation_runs set status = 'passed', finished_at = now() where id = :'V1_id';
update projects.p7_validation_runs set status = 'failed', finished_at = now() where id = :'V2_id';
update projects.p7_validation_runs set status = 'passed', finished_at = now() where id = :'V3_id';
update projects.p7_deployments set status = 'rolled_back' where id = :'DEP2_id';
set local session_replication_role = origin;
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.production_smoke_passed' and subject_id = :'DEP_id'::uuid) = 1, 'SmokePassed is emitted when a smoke run passes');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.production_smoke_failed' and subject_id = :'DEP2_id'::uuid) = 1, 'SmokeFailed is emitted when a smoke run fails');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.production_smoke_passed' and subject_id = :'DEP2_id'::uuid) = 0, 'a live-journey run is not a smoke event');
select pg_temp.check((select count(*) from core.outbox_events where type = 'project.production_rollback_completed' and subject_id = :'DEP2_id'::uuid) = 1, 'RollbackCompleted is emitted when a deployment is recorded rolled back');

-- ═════════ 7b. grants: nothing here is callable by anon; the person doors are not callable by the service role ═════════
select pg_temp.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.proname like 'p789\_%' and n.nspname in ('projects', 'finance') and has_function_privilege('anon', p.oid, 'execute') and p.proname <> 'p789_html_escape' and p.prorettype <> 'trigger'::regtype), 'anon can execute no p789 door');
select pg_temp.check(not has_function_privilege('service_role', 'projects.p789_set_admin_notification_policy(text, text, int, text)', 'execute') and not has_function_privilege('service_role', 'projects.p789_acknowledge_admin_notification(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'projects.p789_approve_provider_failover(uuid, text)', 'execute'), 'the service role cannot set a policy, acknowledge or approve: an agent has no door to a human gate');
select pg_temp.check(has_function_privilege('service_role', 'projects.p789_sweep_client_action_reminders(uuid, timestamptz, int)', 'execute') and has_function_privilege('service_role', 'finance.p789_render_receipt_documents(uuid, int)', 'execute'), 'the two sweeps are callable by the runner');

-- ═════════ 8. RED-PROOFS: each control is removed from the LIVE definition, the check is watched to go red, the definition is restored ═════════
create or replace function pg_temp.p_cert(p_project uuid, p_user uuid, p_org uuid) returns text language plpgsql as $$
declare v_body text;
begin
  alter table projects.p789_completion_certificates disable trigger p789_completion_certificates_guard;
  delete from projects.p789_completion_certificates where project_id = p_project;
  alter table projects.p789_completion_certificates enable trigger p789_completion_certificates_guard;
  perform pg_temp.as_user(p_user, p_org, 'delivery_lead');
  perform projects.render_completion_certificate(p_project);
  select c.body_html into v_body from projects.p789_completion_certificates c where c.project_id = p_project;
  return v_body;
end $$;
create or replace function pg_temp.p_sweep_q5(p_org uuid, p_q5 uuid) returns boolean language plpgsql as $$
begin
  perform pg_temp.as_service();
  perform projects.p789_sweep_client_action_reminders(p_org, '2026-12-14 00:00:00+00');
  return not exists (select 1 from projects.p789_client_action_reminders where request_id = p_q5);
end $$;
create or replace function pg_temp.p_new_failover(p_inc uuid, p_admin uuid, p_org uuid) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_user(p_admin, p_org, 'ops_admin');
  select record_id into v from projects.p789_record_provider_decision(p_inc, 'hosting', 'HostCo', 'failover', 'status page again', null, 'StandbyHost2');
  return v;
end $$;
create or replace function pg_temp.p_self_approval(p_inc uuid, p_admin uuid, p_org uuid) returns text language plpgsql as $$
declare v uuid := pg_temp.p_new_failover(p_inc, p_admin, p_org); o text;
begin select outcome into o from projects.p789_approve_provider_failover(v, 'approved by the same person'); return o; end $$;
create or replace function pg_temp.p_unapproved_execution(p_inc uuid, p_admin uuid, p_dl uuid, p_org uuid) returns text language plpgsql as $$
declare v uuid := pg_temp.p_new_failover(p_inc, p_admin, p_org); o text;
begin perform pg_temp.as_user(p_dl, p_org, 'delivery_lead'); select outcome into o from projects.p789_record_provider_failover_executed(v, 'ran the runbook'); return o; end $$;
create or replace function pg_temp.p_audit_gap_by_lead(p_dl uuid, p_org uuid) returns text language plpgsql as $$
declare v uuid; o text;
begin
  perform pg_temp.as_user(p_dl, p_org, 'delivery_lead');
  select case_id into v from projects.p789_record_outage_case('audit_store_failure', 'work_held', now() - interval '3 hours', 'audit store unreachable again', null, null, true);
  select outcome into o from projects.p789_resolve_outage_case(v, now() - interval '1 hour', 'audit store restored, gap noted');
  return o;
end $$;
grant execute on function pg_temp.p_cert(uuid, uuid, uuid), pg_temp.p_sweep_q5(uuid, uuid), pg_temp.p_new_failover(uuid, uuid, uuid), pg_temp.p_self_approval(uuid, uuid, uuid), pg_temp.p_unapproved_execution(uuid, uuid, uuid, uuid), pg_temp.p_audit_gap_by_lead(uuid, uuid) to public;

select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.red('certificate: the delivery-rights check', 'projects.render_completion_certificate(uuid)'::regprocedure, 'or not coalesce((select core.can_manage_delivery()), false) then', 'or false then',
  format($q$select (select outcome from projects.render_completion_certificate(%L)) = 'not_authorized'$q$, :'PN_id'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('certificate: HTML escaping function', 'projects.p789_html_escape(text)'::regprocedure, '''<'', ''&lt;''', '''<'', ''<''',
  $q$select projects.p789_html_escape('<b>x</b>') = '&lt;b&gt;x&lt;/b&gt;'$q$);
select pg_temp.red('certificate: the door escapes the project name', 'projects.render_completion_certificate(uuid)'::regprocedure, 'projects.p789_html_escape(v_p.name)', 'v_p.name',
  format($q$select position('<b>shop</b>' in pg_temp.p_cert(%L, %L, %L)) = 0$q$, :'PC_id', :'DL', :'ORG'));
select pg_temp.red('certificate: only a completed project', 'projects.render_completion_certificate(uuid)'::regprocedure, 'if v_rec.id is null then return query select ''not_completed''::text, null::uuid; return; end if;', '',
  format($q$select (select outcome from projects.render_completion_certificate(%L)) = 'not_completed'$q$, :'PN_id'));
select pg_temp.red('certificate: one per completion record', 'projects.render_completion_certificate(uuid)'::regprocedure, 'if v_existing is not null then return query select ''already_rendered''::text, v_existing; return; end if;', '',
  format($q$select (select outcome from projects.render_completion_certificate(%L)) = 'already_rendered'$q$, :'PC_id'));
select pg_temp.as_user(:'MEM', :'ORG', 'member');
select pg_temp.red('receipt: the finance/Admin gate', 'finance.p789_render_receipt_documents(uuid, int)'::regprocedure, 'if not (coalesce((select core.is_admin()), false) or coalesce((select core.is_finance()), false)) then', 'if false then',
  format($q$select (select outcome from finance.p789_render_receipt_documents(%L)) = 'not_authorized'$q$, :'R1_id'));
select pg_temp.as_user(:'FIN', :'ORG', 'finance');
select pg_temp.red('receipt: only a verified payment gets a document', 'finance.p789_render_receipt_documents(uuid, int)'::regprocedure, 'and y.verified_at is not null', '',
  format($q$select (select outcome from finance.p789_render_receipt_documents(%L)) = 'nothing_to_render'$q$, :'R4_id'));
-- the client-side receipt controls: the proof needs the unverified/draft receipts to HAVE documents, so render them under the probe's rollback
select pg_temp.as_client(:'CL', :'ORG', :'A_id');
select pg_temp.red('receipt: the client reads only its own account''s receipt', 'projects.p789_client_receipt_document(uuid)'::regprocedure, 'and i.client_account_id = v_acct', '',
  format($q$select (select count(*) from projects.p789_client_receipt_document(%L)) = 0$q$, :'Y2_id'));
select pg_temp.red('receipt: a draft invoice''s receipt is not shown to the client', 'projects.p789_client_receipt_document(uuid)'::regprocedure, 'and i.status not in (''draft'', ''pending_approval'')', '',
  format($q$select (select count(*) from projects.p789_client_receipt_document(%L)) = 0$q$, :'Y3_id'));
select pg_temp.as_client(:'CL2', :'ORG', :'A2_id');
select pg_temp.red('certificate: another client reads nothing', 'projects.p789_completion_certificate(uuid)'::regprocedure, 'if projects.p7b_portal_project(p_project_id) is null then return; end if;', '',
  format($q$select (select count(*) from projects.p789_completion_certificate(%L)) = 0$q$, :'PC_id'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('reminders: a person cannot move the clock', 'projects.p789_sweep_client_action_reminders(uuid, timestamptz, int)'::regprocedure, 'v_now := clock_timestamp();   -- a person cannot move the clock', 'v_now := coalesce(p_now, clock_timestamp());',
  $q$select (select scheduled from projects.p789_sweep_client_action_reminders(null, now() + interval '400 days')) = 0$q$);
select pg_temp.red('reminders: only an open request is reminded', 'projects.p789_sweep_client_action_reminders(uuid, timestamptz, int)'::regprocedure, 'where q.status = ''open'' and', 'where',
  format($q$select pg_temp.p_sweep_q5(%L, %L)$q$, :'ORG', :'Q5_id'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('reminders: a note of substance', 'projects.p789_record_client_action_reminder_sent(uuid, text, text)'::regprocedure, 'or length(btrim(p_note)) < 10', 'or false',
  format($q$select (select outcome from projects.p789_record_client_action_reminder_sent(%L, 'call', 'short')) = 'note_required'$q$, :'REM_id'));
select pg_temp.red('reminders: recorded only once', 'projects.p789_record_client_action_reminder_sent(uuid, text, text)'::regprocedure, 'if v_r.state = ''delivered'' then return query select ''already_recorded''::text; return; end if;', '',
  format($q$select (select outcome from projects.p789_record_client_action_reminder_sent(%L, 'call', 'told the client by phone today')) = 'already_recorded'$q$, :'REM_id'));
select pg_temp.red('policy: Admin-only', 'projects.p789_set_admin_notification_policy(text, text, int, text)'::regprocedure, 'if not coalesce((select core.is_admin()), false) then return query select ''not_authorized''::text, null::int; return; end if;', '',
  $q$select (select outcome from projects.p789_set_admin_notification_policy('sev2', 'email', 30, 'tell the owner fast')) = 'not_authorized'$q$);
select pg_temp.red('acknowledge: a delivery lead is not an Admin', 'projects.p789_acknowledge_admin_notification(uuid, text)'::regprocedure, 'if not coalesce((select core.is_admin()), false) then return query select ''not_authorized''::text; return; end if;', '',
  format($q$select (select outcome from projects.p789_acknowledge_admin_notification(%L, 'seen and on it')) = 'not_authorized'$q$, (select id from projects.p789_admin_notifications where incident_id = :'INCP_id')));
select pg_temp.as_user(:'ADM', :'ORG', 'ops_admin');
select pg_temp.red('provider: only a provider incident', 'projects.p789_record_provider_decision(uuid, text, text, text, text, timestamptz, text)'::regprocedure, 'if v_i.incident_type <> ''provider_outage'' and v_i.recovery_path <> ''provider'' then return query select ''not_a_provider_incident''::text, null::uuid; return; end if;', '',
  format($q$select (select outcome from projects.p789_record_provider_decision(%L, 'hosting', 'HostCo', 'stop', 'status page')) = 'not_a_provider_incident'$q$, :'INCA_id'));
select pg_temp.red('provider: waiting names a future time', 'projects.p789_record_provider_decision(uuid, text, text, text, text, timestamptz, text)'::regprocedure, 'if p_decision in (''wait'', ''retry'') and (p_next_check_at is null or p_next_check_at <= clock_timestamp()) then', 'if false then',
  format($q$select (select outcome from projects.p789_record_provider_decision(%L, 'hosting', 'HostCo', 'wait', 'status page', null)) = 'next_check_in_the_future_required'$q$, :'INCP_id'));
select pg_temp.red('provider: independent approval of a fail-over (door)', 'projects.p789_approve_provider_failover(uuid, text)'::regprocedure, 'if v_f.recorded_by = v_actor then return query select ''self_approval''::text; return; end if;', '',
  format($q$select pg_temp.p_self_approval(%L, %L, %L) = 'self_approval'$q$, :'INCP_id', :'ADM', :'ORG'));
select pg_temp.red('provider: execution needs approval', 'projects.p789_record_provider_failover_executed(uuid, text)'::regprocedure, 'if v_f.approved_by is null then return query select ''not_approved''::text; return; end if;', '',
  format($q$select pg_temp.p_unapproved_execution(%L, %L, %L, %L) = 'not_approved'$q$, :'INCP_id', :'ADM', :'DL', :'ORG'));
select pg_temp.as_user(:'DL', :'ORG', 'delivery_lead');
select pg_temp.red('outage: an audit-store failure states its gap', 'projects.p789_record_outage_case(text, text, timestamptz, text, uuid, uuid, boolean)'::regprocedure, 'if p_kind = ''audit_store_failure'' and not coalesce(p_audit_gap, false) then return query select ''audit_gap_must_be_stated''::text, null::uuid; return; end if;', '',
  $q$select (select outcome from projects.p789_record_outage_case('audit_store_failure', 'work_held', now() - interval '1 hour', 'audit store unreachable for a while')) = 'audit_gap_must_be_stated'$q$);
select pg_temp.red('outage: an audit gap is accepted by an Admin', 'projects.p789_resolve_outage_case(uuid, timestamptz, text)'::regprocedure, 'if v_c.kind = ''audit_store_failure'' and not coalesce((select core.is_admin()), false) then return query select ''admin_required_for_audit_gap''::text; return; end if;', '',
  format($q$select pg_temp.p_audit_gap_by_lead(%L, %L) = 'admin_required_for_audit_gap'$q$, :'DL', :'ORG'));
select pg_temp.red('outage: failed_over needs a recorded execution', 'projects.p789_record_outage_case(text, text, timestamptz, text, uuid, uuid, boolean)'::regprocedure, 'if p_handling = ''failed_over'' and not exists', 'if false and not exists',
  format($q$select (select outcome from projects.p789_record_outage_case('provider_outage', 'failed_over', now() - interval '1 hour', 'moved to the standby host', null, %L)) = 'no_recorded_failover_execution'$q$, :'INCA_id'));

-- trigger controls: the mutation is applied at the top level, a fresh row is written, the result is checked, the definition is restored
select pg_temp.as_service();
set local session_replication_role = replica;
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (:'ORG', :'PI_id', :'PSI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('c', 64), 'production', 3, 'p789-dep3') returning id \gset DEP3_
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (:'ORG', :'PI_id', :'PSI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('d', 64), 'production', 4, 'p789-dep4') returning id \gset DEP4_
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (:'ORG', :'PI_id', :'PSI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('e', 64), 'production', 5, 'p789-dep5') returning id \gset DEP5_
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (:'ORG', :'PI_id', :'PSI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('f', 64), 'production', 6, 'p789-dep6') returning id \gset DEP6_
insert into projects.p7_deployments (organization_id, project_id, phase_seven_id, plan_id, candidate_id, commit_ref, artifact_sha256, environment, attempt, idempotency_key) values (:'ORG', :'PI_id', :'PSI_id', gen_random_uuid(), gen_random_uuid(), :'C1', repeat('9', 64), 'production', 7, 'p789-dep7') returning id \gset DEP7_
insert into projects.p7_validation_runs (organization_id, project_id, deployment_id, candidate_id, commit_ref, kind, status, started_by) values (:'ORG', :'PI_id', :'DEP3_id', gen_random_uuid(), :'C1', 'smoke', 'running', :'OWNER') returning id \gset V4_
insert into projects.p7_validation_runs (organization_id, project_id, deployment_id, candidate_id, commit_ref, kind, status, started_by) values (:'ORG', :'PI_id', :'DEP4_id', gen_random_uuid(), :'C1', 'smoke', 'running', :'OWNER') returning id \gset V5_
set local session_replication_role = origin;
alter table projects.p7_validation_runs enable always trigger p789_validation_runs_events;
alter table projects.p7_deployments enable always trigger p789_deployments_rollback_event;
set local session_replication_role = replica;

select pg_temp.mutate('projects.p789_emit_validation_events()'::regprocedure, '''project.production_smoke_passed''', '''project.production_smoke_failed''') as "DEF" \gset
update projects.p7_validation_runs set status = 'passed', finished_at = now() where id = :'V4_id';
select pg_temp.expect_red(exists (select 1 from core.outbox_events where type = 'project.production_smoke_passed' and subject_id = :'DEP3_id'::uuid), 'events: SmokePassed type');
select pg_temp.restore(:'DEF');
select pg_temp.mutate('projects.p789_emit_validation_events()'::regprocedure, 'new.status in (''failed'', ''blocked'')', 'new.status in (''blocked'')') as "DEF" \gset
update projects.p7_validation_runs set status = 'failed', finished_at = now() where id = :'V5_id';
select pg_temp.expect_red(exists (select 1 from core.outbox_events where type = 'project.production_smoke_failed' and subject_id = :'DEP4_id'::uuid), 'events: SmokeFailed on a failed run');
select pg_temp.restore(:'DEF');
select pg_temp.mutate('projects.p789_emit_rollback_event()'::regprocedure, 'if new.status = ''rolled_back'' and old.status is distinct from ''rolled_back'' then', 'if false then') as "DEF" \gset
update projects.p7_deployments set status = 'rolled_back' where id = :'DEP5_id';
select pg_temp.expect_red(exists (select 1 from core.outbox_events where type = 'project.production_rollback_completed' and subject_id = :'DEP5_id'::uuid), 'events: RollbackCompleted');
select pg_temp.restore(:'DEF');
set local session_replication_role = origin;

-- the notification trigger: channel from policy, client-safe wording without technical detail
select pg_temp.mutate('projects.p789_notify_admin_on_incident()'::regprocedure, 'v_channel := coalesce(v_pol.channel, ''internal_inbox'')', 'v_channel := ''internal_inbox''') as "DEF" \gset
set local session_replication_role = replica;
insert into projects.p7_incidents (organization_id, project_id, phase_seven_id, deployment_id, candidate_id, commit_ref, incident_type, severity, state, impact, opened_at) values (:'ORG', :'PI_id', :'PSI_id', :'DEP6_id', gen_random_uuid(), :'C1', 'config_failure', 'sev1', 'open', 'bad config', '2026-12-03 10:00:00+00') returning id \gset INC6_
set local session_replication_role = origin;
select pg_temp.expect_red((select channel from projects.p789_admin_notifications where incident_id = :'INC6_id') = 'email', 'notification: the policy channel is used');
select pg_temp.restore(:'DEF');
select pg_temp.mutate('projects.p789_notify_admin_on_incident()'::regprocedure, 'when ''sev2'' then ''We found a problem with your live system and our team is looking into it. We will update you shortly.''', 'when ''sev2'' then ''Incident '' || new.incident_type') as "DEF" \gset
set local session_replication_role = replica;
insert into projects.p7_incidents (organization_id, project_id, phase_seven_id, deployment_id, candidate_id, commit_ref, incident_type, severity, state, impact, opened_at) values (:'ORG', :'PI_id', :'PSI_id', :'DEP7_id', gen_random_uuid(), :'C1', 'migration_failure', 'sev2', 'open', 'bad migration', '2026-12-03 10:00:00+00') returning id \gset INC7_
set local session_replication_role = origin;
select pg_temp.expect_red((select position('migration_failure' in client_safe_text) = 0 from projects.p789_admin_notifications where incident_id = :'INC7_id'), 'notification: the client-safe wording carries no technical detail');
select pg_temp.restore(:'DEF');

-- the approver CHECK: held by the door AND the table. Remove the CHECK, watch a self-approving row land, put it back
select pg_temp.p_new_failover(:'INCP_id', :'ADM', :'ORG') as "NF" \gset
select set_config('projects.p789_door', 'on', true);
alter table projects.p789_provider_failover_records drop constraint p789_pf_approver_is_independent;
select pg_temp.expect_red(pg_temp.refused(format('update projects.p789_provider_failover_records set approved_by = recorded_by, approved_at = now(), approval_note = %L where id = %L', 'self approval by table', :'NF'), 'approver_is_independent'), 'table: the approver CHECK');
update projects.p789_provider_failover_records set approved_by = null, approved_at = null, approval_note = null where id = :'NF';
alter table projects.p789_provider_failover_records add constraint p789_pf_approver_is_independent check (approved_by is null or approved_by <> recorded_by);
select pg_temp.check(pg_temp.refused(format('update projects.p789_provider_failover_records set approved_by = recorded_by, approved_at = now(), approval_note = %L where id = %L', 'self approval by table', :'NF'), 'approver_is_independent'), 'table: the approver CHECK is back and holds');
select pg_temp.door_off();

select 'phase 7 round two verified OK' as result;
rollback;
