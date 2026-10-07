-- ═══════════════════════════════════════════════════════════════════════════
-- P2-PM-006 / P2-FLOW-026: PM client-message templates are edited as versions and live only when an Admin approves (migration 20261204200000).
-- Real doors, real triggers, scratch Postgres; rolls back. Counts are scoped to this verifier's own organizations.
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-p1s-pm-templates.sql
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.p1s_check(ok boolean, what text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAILED: %', what; end if; raise notice 'ok  %', what; end $$;
grant execute on function pg_temp.p1s_check(boolean, text) to public;
create or replace function pg_temp.p1s_as_user(p_sub uuid, p_org uuid, p_role text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', jsonb_build_object('sub', p_sub, 'role', 'authenticated',
  'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true); end $$;
grant execute on function pg_temp.p1s_as_user(uuid, uuid, text) to public;
create or replace function pg_temp.p1s_as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.p1s_as_service() to public;
create or replace function pg_temp.p1s_denied(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when insufficient_privilege then return true; end $$;
grant execute on function pg_temp.p1s_denied(text) to public;
create or replace function pg_temp.p1s_refused(stmt text) returns boolean language plpgsql as $$
begin execute stmt; return false; exception when restrict_violation then return true; end $$;
grant execute on function pg_temp.p1s_refused(text) to public;
create or replace function pg_temp.p1s_mutate(fn regprocedure, from_text text, to_text text) returns void language plpgsql as $$
declare d text := pg_get_functiondef(fn); n text;
begin n := replace(d, from_text, to_text);
  if n = d then raise exception 'RED-PROOF MUTATION CHANGED NOTHING: % / %', fn, from_text; end if; execute n; end $$;
grant execute on function pg_temp.p1s_mutate(regprocedure, text, text) to public;

\set TORG '00000000-0000-4000-8000-0000000b0600'
\set TADM '00000000-0000-4000-8000-0000000b0601'
\set TMEM '00000000-0000-4000-8000-0000000b0602'
\set TOTH '00000000-0000-4000-8000-0000000b0610'
\set TOTHU '00000000-0000-4000-8000-0000000b0611'

insert into auth.users (id, email) values (:'TADM', 'p1s-t-adm@example.test'), (:'TMEM', 'p1s-t-mem@example.test'), (:'TOTHU', 'p1s-t-oth@example.test');
insert into core.users (id, email, full_name) values (:'TADM', 'p1s-t-adm@example.test', 'T Admin'), (:'TMEM', 'p1s-t-mem@example.test', 'T Member'), (:'TOTHU', 'p1s-t-oth@example.test', 'T Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'TORG', 'zztest p1s templates', 'zztest-p1s-templates'), (:'TOTH', 'zztest p1s templates other', 'zztest-p1s-templates-other');
insert into core.memberships (organization_id, user_id, role) values (:'TORG', :'TADM', 'ops_admin'), (:'TORG', :'TMEM', 'member'), (:'TOTH', :'TOTHU', 'owner');

-- ═══ 1. the rules a body must keep (the same ones pm-messages.ts states) ═══
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_registry()) = 11, 'eleven templates are registered');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('welcome', 'en', 'Welcome to {agencyName}, we will look after {projectName} together.') is null, 'a plain welcome with its placeholders is a valid body');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('billing_question', 'hindi', 'बिलिंग के लिए कृपया बताएँ कि आपको GST इनवॉइस चाहिए या नहीं।') is null, 'a Hindi body (Devanagari) is valid');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('welcome', 'en', 'Welcome, never send passwords or keys in this chat.') is null, 'the word "password" is fine: the welcome itself says it');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('weather', 'en', 'Some perfectly fine text here') like 'unknown template%', 'NEGATIVE: an unknown template is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('welcome', 'fr', 'Some perfectly fine text here') like 'the language%', 'NEGATIVE: an unknown language is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('welcome', 'en', 'Hi') like 'the message is too short%', 'NEGATIVE: a one-word body is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('welcome', 'en', repeat('a', 1501)) like 'the message is longer%', 'NEGATIVE: a 1501-character body is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('welcome', 'en', 'Welcome to {agencyName} and {nobody}.') like 'the placeholder {nobody}%', 'NEGATIVE: a placeholder the template does not offer is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('welcome', 'en', 'Welcome to {agencyName and the rest') like 'a brace is left open%', 'NEGATIVE: an unclosed brace is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('payment_verified', 'en', 'Your payment was verified, thank you.') like 'this template must use {invoiceNumber}', 'NEGATIVE: a template that must name the invoice and does not is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('payment_verified', 'en', 'Invoice {invoiceNumber} is verified, thank you.') is null, 'POSITIVE twin: with {invoiceNumber} it passes');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now and the first payment of Rs 5000 is done') like 'a client message states no amount%', 'NEGATIVE: an amount (Rs 5000) is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now, and you save ₹500 on this') like 'a client message states no amount%', 'NEGATIVE: an amount (₹) is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now with 20% off for you') like 'a client message states no amount%', 'NEGATIVE: a percentage is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now and we promise delivery on time') like 'a client message makes no promise%', 'NEGATIVE: a promise is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now, a discount applies to you') like 'a client message makes no promise%', 'NEGATIVE: a discount is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now, read https://example.test/x first') like 'a client message carries no link', 'NEGATIVE: a link is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now, our Claude assistant will help') like 'a client message says nothing about which model%', 'NEGATIVE: naming the model is refused');
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now, the amount of care you get is high') is null, 'POSITIVE twin: ordinary words that contain "amount" or "ai" are fine');

-- ═══ 2. a member drafts and submits; the draft is private to the one open slot ═══
select pg_temp.p1s_as_user(:'TMEM', :'TORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('kickoff', 'en', 'Your advance is verified and setup is done. We are starting your project now.')) = 'saved', 'a member saves a draft');
select id as t1 from projects.p1s_pm_template_versions where organization_id = :'TORG' and template_key = 'kickoff' and language = 'en' \gset
select pg_temp.p1s_check((select version from projects.p1s_save_pm_template_draft('kickoff', 'en', 'Setup is done and your advance is verified. We are starting your project now.')) = 1, 'saving again edits the SAME open draft');
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_versions where organization_id = :'TORG') = 1, 'one row');
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('kickoff', 'en', 'We promise to finish fast, starting now.')) like 'invalid_body%', 'NEGATIVE: a draft that breaks the rules is not saved');
select pg_temp.p1s_check((select body from projects.p1s_pm_template_versions where id = :'t1') like 'Setup is done%', 'and the stored draft is unchanged by it');
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t1') = 'submitted', 'the member submits it');
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('kickoff', 'en', 'A later edit while it is being reviewed, honestly.')) = 'under_review', 'NEGATIVE: a version in review is not edited under the reviewer');
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t1') = 'not_a_draft', 'NEGATIVE: it cannot be submitted twice');
select pg_temp.p1s_check((select outcome from projects.p1s_decide_pm_template(:'t1', 'approve', 'looks fine')) = 'not_authorized', 'NEGATIVE: a member cannot approve');
reset role;
select pg_temp.p1s_check((select status from projects.p1s_pm_template_versions where id = :'t1') = 'pending_review', 'still pending');

-- ═══ 3. nothing is live until an Admin approves ═══
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_approved(:'TORG', 'kickoff', 'en')) = 0, 'a pending version is NOT what the sender reads');
reset role;
select pg_temp.p1s_as_user(:'TADM', :'TORG', 'ops_admin');
set local role authenticated;
select pg_temp.p1s_check((select outcome from projects.p1s_decide_pm_template(:'t1', 'reject', '')) = 'reason_required', 'NEGATIVE: a rejection needs a reason');
select pg_temp.p1s_check((select outcome from projects.p1s_decide_pm_template(:'t1', 'maybe', 'x')) = 'invalid_decision', 'NEGATIVE: only approve or reject');
select pg_temp.p1s_check((select outcome from projects.p1s_decide_pm_template(:'t1', 'approve', 'agreed with the owner')) = 'approved', 'an Admin approves');
select pg_temp.p1s_check((select outcome from projects.p1s_decide_pm_template(:'t1', 'approve', 'again')) = 'not_pending', 'NEGATIVE: it cannot be approved twice');
reset role;
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select body from projects.p1s_pm_template_approved(:'TORG', 'kickoff', 'en')) like 'Setup is done%', 'now the sender reads the approved body');
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_approved(:'TORG', 'kickoff', 'hinglish')) = 0, 'POSITIVE twin: another language of the same template has no override');
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_approved(:'TOTH', 'kickoff', 'en')) = 0, 'NEGATIVE: another organization has no override');
reset role;
select pg_temp.p1s_check((select count(*) from audit.audit_log where organization_id = :'TORG' and action = 'pm_template.approved' and subject_id = :'t1') = 1, 'the approval is audited');
select pg_temp.p1s_check((select count(*) from core.outbox_events where organization_id = :'TORG' and type = 'pm_template.approved') = 1, 'and announced');

-- ═══ 4. a second version supersedes; a rejected one is kept with its reason ═══
select pg_temp.p1s_as_user(:'TMEM', :'TORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select version from projects.p1s_save_pm_template_draft('kickoff', 'en', 'Your advance is verified. Setup is complete and your project starts now.')) = 2, 'the next draft is version 2');
select id as t2 from projects.p1s_pm_template_versions where organization_id = :'TORG' and template_key = 'kickoff' and language = 'en' and version = 2 \gset
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t2') = 'submitted', 'submitted');
select pg_temp.p1s_check(projects.p1s_withdraw_pm_template(:'t2') = 'withdrawn', 'the author can take it back to draft');
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t2') = 'submitted', 'and submit again');
reset role;
select pg_temp.p1s_as_user(:'TADM', :'TORG', 'ops_admin');
set local role authenticated;
select pg_temp.p1s_check((select superseded_id from projects.p1s_decide_pm_template(:'t2', 'approve', 'clearer')) = :'t1', 'approving version 2 reports it superseded version 1');
reset role;
select pg_temp.p1s_check((select status from projects.p1s_pm_template_versions where id = :'t1') = 'superseded' and (select status from projects.p1s_pm_template_versions where id = :'t2') = 'approved', 'one superseded, one approved');
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_versions where organization_id = :'TORG' and template_key = 'kickoff' and language = 'en' and status = 'approved') = 1, 'exactly one approved per slot');
select pg_temp.p1s_as_user(:'TMEM', :'TORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('welcome', 'en', 'Welcome to {agencyName}. We will guide you through {projectName}.')) = 'saved', 'a welcome draft');
select id as t3 from projects.p1s_pm_template_versions where organization_id = :'TORG' and template_key = 'welcome' \gset
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t3') = 'submitted', 'submitted');
reset role;
select pg_temp.p1s_as_user(:'TADM', :'TORG', 'ops_admin');
set local role authenticated;
select pg_temp.p1s_check((select outcome from projects.p1s_decide_pm_template(:'t3', 'reject', 'tone is too casual for our clients')) = 'rejected', 'an Admin rejects it with a reason');
reset role;
select pg_temp.p1s_check((select status || ':' || decision_note from projects.p1s_pm_template_versions where id = :'t3') = 'rejected:tone is too casual for our clients', 'the rejection is kept with the reason');
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_approved(:'TORG', 'welcome', 'en')) = 0, 'a rejected version is never sent');
reset role;

-- ═══ 5. history is history ═══
select pg_temp.p1s_check(pg_temp.p1s_refused($q$update projects.p1s_pm_template_versions set body = 'rewritten after the fact, honestly' where template_key = 'kickoff' and version = 1 and organization_id = '00000000-0000-4000-8000-0000000b0600'$q$), 'NEGATIVE: a superseded version''s body cannot be rewritten');
select pg_temp.p1s_check(pg_temp.p1s_refused($q$update projects.p1s_pm_template_versions set body = 'rewritten after the fact, honestly' where template_key = 'kickoff' and version = 2 and organization_id = '00000000-0000-4000-8000-0000000b0600'$q$), 'NEGATIVE: nor the approved one''s');
select pg_temp.p1s_check(pg_temp.p1s_refused($q$update projects.p1s_pm_template_versions set status = 'approved' where template_key = 'welcome' and organization_id = '00000000-0000-4000-8000-0000000b0600'$q$), 'NEGATIVE: a rejected version cannot be revived by an update');
select pg_temp.p1s_check(pg_temp.p1s_refused($q$delete from projects.p1s_pm_template_versions where template_key = 'kickoff' and version = 1 and organization_id = '00000000-0000-4000-8000-0000000b0600'$q$), 'NEGATIVE: a version that left draft is never deleted');
select pg_temp.p1s_check(pg_temp.p1s_refused($q$update projects.p1s_pm_template_versions set status = 'approved' where template_key = 'kickoff' and version = 1 and organization_id = '00000000-0000-4000-8000-0000000b0600'$q$), 'NEGATIVE: a superseded version cannot be re-approved by an update');

-- ═══ 6. who may, and who sees ═══
select pg_temp.p1s_as_user(:'TOTHU', :'TOTH', 'owner');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_versions) = 0, 'NEGATIVE: another organization sees none of these versions');
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t2') = 'not_found', 'NEGATIVE: nor can it act on them');
select pg_temp.p1s_check(projects.p1s_discard_pm_template_draft(:'t2') = 'not_found', 'NEGATIVE: nor discard');
reset role;
select pg_temp.p1s_as_user('00000000-0000-4000-8000-0000000b09fe', :'TORG', 'client_admin');
set local role authenticated;
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_versions) = 0, 'NEGATIVE: a client user sees no template versions');
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('kickoff', 'en', 'We start your project right away today.')) = 'not_authorized', 'NEGATIVE: and cannot write one');
reset role;
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check(pg_temp.p1s_denied($q$select * from projects.p1s_save_pm_template_draft('kickoff', 'en', 'We start your project right away today.')$q$), 'NEGATIVE: an agent / service principal holds no grant on the authoring doors');
select pg_temp.p1s_check(pg_temp.p1s_denied($q$select * from projects.p1s_decide_pm_template('00000000-0000-4000-8000-000000000000', 'approve', 'x')$q$), 'NEGATIVE: nor on the approval door');
reset role;
select pg_temp.p1s_as_user(:'TMEM', :'TORG', 'member');
set local role authenticated;
select pg_temp.p1s_check(pg_temp.p1s_denied($q$select * from projects.p1s_pm_template_approved('00000000-0000-4000-8000-0000000b0600', 'kickoff', 'en')$q$), 'NEGATIVE: a signed-in user cannot call the sender''s read');
reset role;

-- discard
select pg_temp.p1s_as_user(:'TMEM', :'TORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('follow_up_billing', 'en', 'A gentle reminder about your billing preference please.')) = 'saved', 'a draft to discard');
select id as t4 from projects.p1s_pm_template_versions where organization_id = :'TORG' and template_key = 'follow_up_billing' \gset
select pg_temp.p1s_check(projects.p1s_discard_pm_template_draft(:'t4') = 'discarded', 'its author discards it');
select pg_temp.p1s_check(projects.p1s_discard_pm_template_draft(:'t2') = 'not_a_draft', 'NEGATIVE: an approved version cannot be discarded, even by its author');
reset role;

-- ═══ 7. red-proofs ═══
select pg_temp.p1s_mutate('projects.p1s_decide_pm_template(uuid, text, text)'::regprocedure, 'not coalesce((select core.is_admin()), false)', 'false');
select pg_temp.p1s_as_user(:'TMEM', :'TORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('gst_details_request', 'en', 'For the GST invoice please send the details in one message.')) = 'saved', 'RED-PROOF set-up: a draft');
select id as t5 from projects.p1s_pm_template_versions where organization_id = :'TORG' and template_key = 'gst_details_request' \gset
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t5') = 'submitted', 'RED-PROOF set-up: submitted');
select pg_temp.p1s_check((select outcome from projects.p1s_decide_pm_template(:'t5', 'approve', 'proof')) = 'approved', 'RED-PROOF: with the Admin check removed a member approves (the not_authorized check above depends on it)');
reset role;
select pg_temp.p1s_mutate('projects.p1s_pm_template_problem(text, text, text)'::regprocedure, $m$~* '₹|[$]|$m$, $m$~* '¤|[$]|$m$);
select pg_temp.p1s_check(projects.p1s_pm_template_problem('kickoff', 'en', 'We start now, you save ₹500 on this') is null, 'RED-PROOF: with the amount rule weakened a ₹ amount passes (the amount checks above depend on it)');
select pg_temp.p1s_mutate('projects.p1s_pm_template_approved(uuid, text, text)'::regprocedure, $m$v.status = 'approved'$m$, $m$v.status in ('approved', 'pending_review')$m$);
select pg_temp.p1s_as_user(:'TMEM', :'TORG', 'member');
set local role authenticated;
select pg_temp.p1s_check((select outcome from projects.p1s_save_pm_template_draft('payment_received', 'en', 'We have received your payment details and are checking them.')) = 'saved', 'RED-PROOF set-up: another draft');
select id as t6 from projects.p1s_pm_template_versions where organization_id = :'TORG' and template_key = 'payment_received' \gset
select pg_temp.p1s_check(projects.p1s_submit_pm_template(:'t6') = 'submitted', 'RED-PROOF set-up: submitted');
reset role;
select pg_temp.p1s_as_service();
set local role service_role;
select pg_temp.p1s_check((select count(*) from projects.p1s_pm_template_approved(:'TORG', 'payment_received', 'en')) = 1, 'RED-PROOF: with the status filter widened, an UNAPPROVED version is read by the sender (the "pending is not live" check above depends on it)');
reset role;

rollback;
\echo 'verify-p1s-pm-templates: ALL CHECKS PASSED'
