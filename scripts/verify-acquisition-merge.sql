-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, follow-up — two contacts an administrator has judged the same person become one.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-merge.sql
-- Rolls back. Any failed check raises. Uses its own organisations, so it does not depend on what else is in the database.
-- ═══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.check(ok boolean, what text) returns void
language plpgsql as $$
begin
  if ok is not true then raise exception 'FAILED: %', what; end if;
  raise notice 'ok  %', what;
end $$;
grant execute on function pg_temp.check(boolean, text) to public;
create or replace function pg_temp.as_user(p_sub uuid, p_org uuid, p_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub, 'role', 'authenticated',
      'app_metadata', jsonb_build_object('organization_id', p_org, 'role', p_role))::text, true);
end $$;
grant execute on function pg_temp.as_user(uuid, uuid, text) to public;

\set MORG '00000000-0000-4000-8000-0000000000d1'
\set MORGB '00000000-0000-4000-8000-0000000000d2'
\set MADMIN '00000000-0000-4000-8000-00000000d101'
\set MMEMBER '00000000-0000-4000-8000-00000000d102'
\set MOTHER '00000000-0000-4000-8000-00000000d103'
insert into auth.users (id, email) values (:'MADMIN', 'lg-merge-admin@example.test'), (:'MMEMBER', 'lg-merge-member@example.test'), (:'MOTHER', 'lg-merge-other@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'MADMIN', 'lg-merge-admin@example.test', 'M Admin'), (:'MMEMBER', 'lg-merge-member@example.test', 'M Member'), (:'MOTHER', 'lg-merge-other@example.test', 'M Other') on conflict do nothing;
insert into core.organizations (id, name, slug) values (:'MORG', 'Merge Agency', 'merge-agency'), (:'MORGB', 'Merge Agency B', 'merge-agency-b');

-- fixtures: a winner with an email, a loser with a phone, leads/conversation on the loser, conflicting consent, a third contact
insert into crm.contacts (id, organization_id, full_name, email) values ('00000000-0000-4000-8000-00000000d201', :'MORG', 'Asha Rao', 'asha@merge.example');
insert into crm.contacts (id, organization_id, full_name, phone, company) values ('00000000-0000-4000-8000-00000000d202', :'MORG', 'Asha R.', '+14155550888', 'Rao Retail');
insert into crm.contacts (id, organization_id, full_name, email) values ('00000000-0000-4000-8000-00000000d203', :'MORG', 'Someone Else', 'else@merge.example');
insert into crm.contacts (id, organization_id, full_name, email) values ('00000000-0000-4000-8000-00000000d204', :'MORGB', 'Other Org Person', 'orgb@merge.example');
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values ('00000000-0000-4000-8000-00000000d301', :'MORG', '00000000-0000-4000-8000-00000000d202', 'Loser lead', 'email', 'm:1', 'new');
insert into crm.communication_consent (organization_id, contact_id, channel, status) values
  (:'MORG', '00000000-0000-4000-8000-00000000d201', 'email', 'granted'),
  (:'MORG', '00000000-0000-4000-8000-00000000d202', 'email', 'withdrawn'),
  (:'MORG', '00000000-0000-4000-8000-00000000d202', 'whatsapp', 'granted');
-- an identity key the winner does not have yet
select pg_temp.check((select count(*) from crm.identity_keys where contact_id = '00000000-0000-4000-8000-00000000d202') >= 1, 'the loser holds an identity key (its phone)');
-- open review (not yet decided) between winner and loser, plus one between loser and a third contact
insert into crm.duplicate_reviews (organization_id, contact_a, contact_b, reason, status, decided_by, decided_at, decision_note)
  values (:'MORG', '00000000-0000-4000-8000-00000000d201', '00000000-0000-4000-8000-00000000d202', 'name_and_company', 'open', null, null, null);
insert into crm.duplicate_reviews (organization_id, contact_a, contact_b, reason, status)
  values (:'MORG', '00000000-0000-4000-8000-00000000d202', '00000000-0000-4000-8000-00000000d203', 'name_and_company', 'open');

\set W '00000000-0000-4000-8000-00000000d201'
\set L '00000000-0000-4000-8000-00000000d202'
\set T '00000000-0000-4000-8000-00000000d203'
\set X '00000000-0000-4000-8000-00000000d204'

set local role authenticated;
select pg_temp.as_user(:'MADMIN', :'MORG', 'owner');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'L', 'same person')) = 'no_confirmed_review', 'no merge while the pair is only suspected (review still open)');
select pg_temp.as_user(:'MMEMBER', :'MORG', 'member');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'L', 'same person')) = 'forbidden', 'a member cannot merge');
select pg_temp.as_user(:'MOTHER', :'MORGB', 'owner');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'L', 'same person')) = 'forbidden', 'an admin of another organisation cannot merge');
select pg_temp.as_user(:'MADMIN', :'MORG', 'owner');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'W', 'same person')) = 'same_contact', 'a contact cannot be merged into itself');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'L', '  ')) = 'needs_reason', 'a merge needs a reason');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'X', 'cross')) = 'not_found', 'a contact of another organisation is not found');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'T', 'never reviewed')) = 'no_confirmed_review', 'two contacts never judged the same cannot be merged');

select pg_temp.check((select outcome from crm.decide_duplicate_review((select id from crm.duplicate_reviews where organization_id = :'MORG' and contact_a = :'W' and contact_b = :'L'), 'confirmed_same', 'same person, two channels')) = 'decided', 'the administrator confirms they are the same person');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'L', 'same person, two channels')) = 'merged', 'the merge runs');

reset role;
select pg_temp.check((select contact_id from crm.leads where id = '00000000-0000-4000-8000-00000000d301') = :'W', 'the lead followed the winner');
select pg_temp.check((select count(*) from crm.identity_keys where contact_id = :'L') = 0, 'no identity key still points at the loser');
select pg_temp.check((select count(*) from crm.identity_keys where contact_id = :'W' and kind = 'phone') = 1, '…the phone key is now the winner''s');
select pg_temp.check((select phone from crm.contacts where id = :'W') = '+14155550888', 'the winner learned the phone it lacked');
select pg_temp.check((select email from crm.contacts where id = :'W') = 'asha@merge.example', '…and kept its own email');
select pg_temp.check((select company from crm.contacts where id = :'W') = 'Rao Retail', '…and a company it lacked');
select pg_temp.check((select merged_into_contact_id from crm.contacts where id = :'L') = :'W' and (select email is null and phone is null from crm.contacts where id = :'L'), 'the loser is kept as history, marked merged, with no email or phone');
select pg_temp.check((select status from crm.communication_consent where contact_id = :'W' and channel = 'email') = 'withdrawn', 'where consent conflicted the SAFER answer (withdrawn) won');
select pg_temp.check((select status from crm.communication_consent where contact_id = :'W' and channel = 'whatsapp') = 'granted', 'a consent only the loser had was carried over');
select pg_temp.check((select count(*) from crm.communication_consent where contact_id = :'L') = 2, 'the loser''s own consent history is untouched');
select pg_temp.check((select status from crm.duplicate_reviews where organization_id = :'MORG' and contact_a = :'L' and contact_b = :'T') = 'dismissed', 'other open questions about the loser are closed by the merge');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'identity.contacts_merged') = 1, 'the merge is audited');

set local role authenticated;
select pg_temp.as_user(:'MADMIN', :'MORG', 'owner');
select pg_temp.check((select outcome from crm.merge_contacts(:'MORG', :'W', :'L', 'again')) = 'already_merged', 'merging again is refused');
reset role;
select 'ALL CHECKS PASSED' as result;
rollback;
