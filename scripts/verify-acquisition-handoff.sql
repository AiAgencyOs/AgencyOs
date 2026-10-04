-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 3 — the tracked WhatsApp handoff, driven for real.
--
-- A prospect found by email moves to WhatsApp through a secure opaque
-- reference. The REAL crm.ingest_whatsapp_message records their first message;
-- the result must be ONE lead (the original one, with its requirements and
-- deal), Sales as owner, and the email source preserved as the first touch.
-- Then every way it must fail safely: replay, tampered, wrong tenant, expired,
-- cancelled, closed lead, and a number that belongs to someone else.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-handoff.sql
-- Rolls back. Any failed check raises.
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

-- sha256 of the canonical reference, exactly as src/modules/acquisition/handoff-code.ts hashes it
create or replace function pg_temp.h(code text) returns text language sql as $$ select encode(sha256(convert_to(code, 'UTF8')), 'hex') $$;
grant execute on function pg_temp.h(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b2'
\set C1 'AOS-AAAA-1111-BBBB-2222'
\set C2 'AOS-CCCC-3333-DDDD-4444'
\set C3 'AOS-EEEE-5555-FFFF-6666'
\set C4 'AOS-GGGG-7777-HHHH-8888'
\set C5 'AOS-JJJJ-9999-KKKK-0000'

insert into core.organizations (id, name, slug, settings) values (:'ORGB', 'Other Agency', 'other-agency', '{"whatsapp_phone_number_id":"pnid-handoff-b"}')
  on conflict (id) do update set settings = excluded.settings;
update core.organizations set settings = settings || '{"whatsapp_phone_number_id":"pnid-handoff-a"}'::jsonb where id = :'ORG';
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test'),
  ('00000000-0000-4000-8000-00000000a003', 'lg-member@example.test'),
  ('00000000-0000-4000-8000-00000000a004', 'lg-other-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test', 'LG Admin'),
  ('00000000-0000-4000-8000-00000000a003', 'lg-member@example.test', 'LG Member'),
  ('00000000-0000-4000-8000-00000000a004', 'lg-other-owner@example.test', 'LG Other') on conflict do nothing;

create temp table fx (k text primary key, v uuid);
grant all on fx to public;

-- ── fixtures: an email-sourced lead WITH a deal and requirements ───────────
set local role service_role;
select set_config('request.jwt.claims', '', true);
insert into fx select 'c1', contact_id from crm.resolve_identity(:'ORG', '{"name":"Maya Rao","email":"maya@handoff.example.org","company":"Handoff Co"}', 'email');
reset role;
insert into crm.leads (organization_id, contact_id, title, summary, source, source_ref, status, requirements, service)
  values (:'ORG', (select v from fx where k = 'c1'), 'Maya website', 'Wants a shop site', 'email', 'outreach:maya', 'qualifying',
          '{"pages": 8, "stack": "Next.js"}', 'Website Development') returning id \gset L1_
insert into fx values ('l1', :'L1_id');
insert into sales.opportunities (organization_id, lead_id, name, stage, value_minor) values (:'ORG', (select v from fx where k = 'l1'), 'Maya deal', 'proposal', 5000000);
set local role service_role;
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'l1'), null, 'email_outreach', 'found by an outreach sequence')) = 'transferred', 'fixture: the email agent owns the lead');
insert into fx values ('h1', gen_random_uuid());

-- ── 1. creating a handoff ──────────────────────────────────────────────────
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', (select v from fx where k = 'h1'), pg_temp.h(:'C1'), (select v from fx where k = 'l1'), 'email', null, 'email_outreach', 'Ask for the launch date')) = 'created', 'a handoff is created for the lead');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C2'), (select v from fx where k = 'l1'), 'email', null, 'email_outreach')) = 'exists', 'a second creation for the same lead finds the LIVE one (no second handoff)');
select pg_temp.check((select handoff_id from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C2'), (select v from fx where k = 'l1'), 'email', null, 'email_outreach')) = (select v from fx where k = 'h1'), '…and returns the first one''s id, so the caller re-derives the same reference');
select pg_temp.check((select count(*) from crm.channel_handoffs where lead_id = (select v from fx where k = 'l1')) = 1, 'exactly one handoff row exists for the lead');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), 'not-a-hash', (select v from fx where k = 'l1'), 'email', null, 'email_outreach')) = 'invalid', 'a malformed hash is refused');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C2'), (select v from fx where k = 'l1'), 'tiktok', null, 'email_outreach')) = 'invalid', 'an unknown source channel is refused');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C2'), gen_random_uuid(), 'email', null, 'email_outreach')) = 'unknown_lead', 'an unknown lead is refused');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORGB', gen_random_uuid(), pg_temp.h(:'C2'), (select v from fx where k = 'l1'), 'email', null, 'email_outreach')) = 'unknown_lead', 'another organisation cannot create a handoff for this lead');

-- the package is built server-side from authoritative rows
select pg_temp.check((select context -> 'lead' -> 'requirements' ->> 'stack' from crm.channel_handoffs where id = (select v from fx where k = 'h1')) = 'Next.js', 'the context carries the lead''s requirements (so nobody is asked again)');
select pg_temp.check((select context ->> 'owner_at_creation' from crm.channel_handoffs where id = (select v from fx where k = 'h1')) = 'email_outreach', '…the owner at creation');
select pg_temp.check((select context -> 'opportunity' ->> 'stage' from crm.channel_handoffs where id = (select v from fx where k = 'h1')) = 'proposal', '…and the deal state');
select pg_temp.check((select context -> 'first_touch' ->> 'first_channel' from crm.channel_handoffs where id = (select v from fx where k = 'h1')) = 'email', '…and the first touch');

-- who may create
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C3'), (select v from fx where k = 'l1'), 'email', null, 'human')) = 'forbidden', 'a member cannot create a handoff');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', :'ORG', 'member');
select pg_temp.check((select outcome from crm.set_handoff_settings('+14155550100', 14)) = 'forbidden', 'a member cannot set the handoff number');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.set_handoff_settings('0415 555 0100', 14)) = 'invalid', 'a number without a country code is refused');
select pg_temp.check((select outcome from crm.set_handoff_settings('+14155550100', 0)) = 'invalid', 'a lifetime of 0 days is refused');

-- ── 2. frozen, state machine, never deleted ────────────────────────────────
reset role;
do $$
declare h uuid;
begin
  select id into h from crm.channel_handoffs limit 1;
  begin update crm.channel_handoffs set context = '{}' where id = h; raise exception 'FAILED: context was rewritten';
  exception when insufficient_privilege then raise notice 'ok  the context is frozen at creation'; end;
  begin update crm.channel_handoffs set lead_id = gen_random_uuid() where id = h; raise exception 'FAILED: the lead was re-pointed';
  exception when insufficient_privilege or foreign_key_violation then raise notice 'ok  the lead cannot be re-pointed'; end;
  begin update crm.channel_handoffs set expires_at = now() + interval '999 days' where id = h; raise exception 'FAILED: the lifetime was extended';
  exception when insufficient_privilege then raise notice 'ok  the lifetime cannot be extended'; end;
  begin update crm.channel_handoffs set status = 'CONSUMED', consumed_at = now(), consume_outcome = 'same_lead' where id = h; raise exception 'FAILED: CREATED jumped to CONSUMED';
  exception when check_violation then raise notice 'ok  CREATED cannot jump to CONSUMED'; end;
  begin delete from crm.channel_handoffs where id = h; raise exception 'FAILED: a handoff was deleted';
  exception when insufficient_privilege then raise notice 'ok  a handoff cannot be deleted'; end;
end $$;

-- ── 3. the link is followed ────────────────────────────────────────────────
set local role service_role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check((select outcome from crm.open_channel_handoff(pg_temp.h('AOS-ZZZZ-0000-ZZZZ-0000'))) = 'unknown', 'an unknown reference opens nothing');
select pg_temp.check((select outcome from crm.open_channel_handoff(pg_temp.h(:'C1'))) = 'no_number', 'with no WhatsApp number configured the link says so (and stays unused)');
select pg_temp.check((select status from crm.channel_handoffs where id = (select v from fx where k = 'h1')) = 'CREATED', '…the handoff is still CREATED');
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', :'ORG', 'ops_admin');
set local role authenticated;
select pg_temp.check((select outcome from crm.set_handoff_settings('+1 415 555 0100', 14)) = 'saved', 'an admin sets the dialable number');
reset role;
set local role service_role;
select pg_temp.check((select (outcome, business_number) = ('open', '+14155550100') from crm.open_channel_handoff(pg_temp.h(:'C1'))), 'following the link returns only the number to open');
select pg_temp.check((select status from crm.channel_handoffs where id = (select v from fx where k = 'h1')) = 'OPENED', '…and the handoff is OPENED');

-- ── 4. the first WhatsApp message: bind, then the REAL ingest ──────────────
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-b', '14155550188', pg_temp.h(:'C1'))) = 'unknown', 'ANOTHER TENANT''S number cannot resolve this organisation''s reference');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550188', pg_temp.h('AOS-AAAA-1111-BBBB-2223'))) = 'unknown', 'a TAMPERED reference resolves nothing');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-unknown', '14155550188', pg_temp.h(:'C1'))) = 'unknown', 'an unknown business number resolves nothing');
select pg_temp.check((select status from crm.channel_handoffs where id = (select v from fx where k = 'h1')) = 'OPENED', '…and none of those touched the handoff');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550188', pg_temp.h(:'C1'))) = 'bound', 'the right number and reference BIND the existing lead');
select pg_temp.check((select (source, source_ref) = ('whatsapp', 'wa:+14155550188') from crm.leads where id = (select v from fx where k = 'l1')), '…the lead is now the WhatsApp thread');
select pg_temp.check((select phone from crm.contacts where id = (select v from fx where k = 'c1')) = '+14155550188', '…and its contact holds the sender''s number');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550188', pg_temp.h(:'C1'))) = 'already_resolved', 'a REPLAY of the reference does nothing more');

insert into fx select 'ing', lead_id from crm.ingest_whatsapp_message('pnid-handoff-a', '14155550188', 'wamid.handoff.1', 'Hi, I''m following up on our earlier conversation. Ref AOS-AAAA-1111-BBBB-2222', 'Maya');
select pg_temp.check((select v from fx where k = 'ing') = (select v from fx where k = 'l1'), 'the REAL ingest continued the ORIGINAL lead');
select pg_temp.check((select count(*) from crm.leads where contact_id = (select v from fx where k = 'c1')) = 1, 'NO second lead exists for this person');
select pg_temp.check((select count(*) from crm.contacts where organization_id = :'ORG' and (phone = '+14155550188' or lower(email) = 'maya@handoff.example.org')) = 1, 'NO second contact exists either');
select pg_temp.check((select lead_id from crm.conversations where external_ref = 'wa:+14155550188') = (select v from fx where k = 'l1'), 'the WhatsApp conversation hangs off the original lead');
select pg_temp.check((select requirements ->> 'stack' from crm.leads where id = (select v from fx where k = 'l1')) = 'Next.js', 'its requirements are still there: the client is not asked again');
select pg_temp.check((select count(*) from sales.opportunities where lead_id = (select v from fx where k = 'l1') and stage = 'proposal') = 1, '…and so is the deal');

select pg_temp.check((select outcome from crm.consume_channel_handoff((select v from fx where k = 'h1'), :'ORG', (select v from fx where k = 'c1'), (select v from fx where k = 'l1'))) = 'consumed', 'the handoff is consumed');
select pg_temp.check((select (status, consume_outcome) = ('CONSUMED', 'same_lead') from crm.channel_handoffs where id = (select v from fx where k = 'h1')), '…as CONSUMED / same_lead');
select pg_temp.check((select owner from crm.lead_conversation_owner where lead_id = (select v from fx where k = 'l1')) = 'sales', 'SALES now owns the conversation');
select pg_temp.check((select (from_owner, to_owner, workflow_state) = ('email_outreach', 'sales', 'handoff_consumed') from crm.conversation_owner_transfers where lead_id = (select v from fx where k = 'l1') order by created_at desc, id desc limit 1), '…and the transfer records who, to whom and the workflow state');
select pg_temp.check((select first_channel from crm.lead_attribution((select v from fx where k = 'l1'))) = 'email', 'the FIRST touch is still email');
select pg_temp.check((select last_channel from crm.lead_attribution((select v from fx where k = 'l1'))) = 'whatsapp', '…the LAST touch is the WhatsApp handoff');
select pg_temp.check((select outcome from crm.consume_channel_handoff((select v from fx where k = 'h1'), :'ORG', (select v from fx where k = 'c1'), (select v from fx where k = 'l1'))) = 'already_consumed', 'consuming AGAIN is refused');
select pg_temp.check((select count(*) from crm.conversation_owner_transfers where lead_id = (select v from fx where k = 'l1')) = 2, '…and made no second ownership transition');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = (select v from fx where k = 'l1') and touch_type = 'handoff') = 1, '…nor a second handoff touchpoint');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550188', pg_temp.h(:'C1'))) = 'already_consumed', 'a CONSUMED reference cannot be bound again (token replay)');
select pg_temp.check((select outcome from crm.open_channel_handoff(pg_temp.h(:'C1'))) = 'consumed', '…and following the link again opens nothing');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155559999', pg_temp.h(:'C1'))) = 'already_consumed', '…even from a different phone');

-- ── 5. a number that belongs to someone else: no guess, a review ───────────
-- X is already talking to us on WhatsApp from +14155550199.
insert into fx select 'x_lead', lead_id from crm.ingest_whatsapp_message('pnid-handoff-a', '14155550199', 'wamid.handoff.x1', 'Hello', 'Existing Person');
select contact_id from crm.ingest_whatsapp_message('pnid-handoff-a', '14155550199', 'wamid.handoff.x2', 'Hello again', 'Existing Person') \gset X_
insert into fx values ('x_contact', :'X_contact_id');
-- B is an email lead who claims to be that same number's owner.
insert into fx select 'c2', contact_id from crm.resolve_identity(:'ORG', '{"name":"Ben Iyer","email":"ben@handoff.example.org"}', 'email');
reset role;
insert into crm.leads (organization_id, contact_id, title, source, source_ref, status) values (:'ORG', (select v from fx where k = 'c2'), 'Ben', 'email', 'outreach:ben', 'new') returning id \gset L2_
insert into fx values ('l2', :'L2_id');
set local role service_role;
select pg_temp.check((select outcome from crm.record_touchpoint(:'ORG', (select v from fx where k = 'l2'), 'social', 'linkedin', 'discovered', '{"post":"p-42"}', '{}', 'li:ben-1', now() - interval '20 days')) = 'recorded', 'Ben was first found on LinkedIn, 20 days ago');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C3'), (select v from fx where k = 'l2'), 'social', 'linkedin', 'social_media')) = 'created', 'a LinkedIn-sourced handoff is created for Ben');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550199', pg_temp.h(:'C3'))) = 'review_needed', 'the sender''s number belongs to ANOTHER contact: NO bind, review needed');
select pg_temp.check((select source from crm.leads where id = (select v from fx where k = 'l2')) = 'email', '…Ben''s lead was not re-keyed');
select pg_temp.check((select phone from crm.contacts where id = (select v from fx where k = 'c2')) is null, '…and no phone was taken from the other contact');
select pg_temp.check((select lead_id from crm.ingest_whatsapp_message('pnid-handoff-a', '14155550199', 'wamid.handoff.x3', 'Ref AOS-EEEE-5555-FFFF-6666', 'Existing Person')) = (select v from fx where k = 'x_lead'), 'ingest continued the EXISTING WhatsApp lead (the unchanged function)');
select pg_temp.check((select outcome from crm.consume_channel_handoff((select id from crm.channel_handoffs where token_hash = pg_temp.h(:'C3')), :'ORG', (select v from fx where k = 'x_contact'), (select v from fx where k = 'x_lead'))) = 'linked_for_review', 'the handoff is consumed as linked_for_review');
select pg_temp.check((select count(*) from crm.duplicate_reviews where reason = 'handoff_claim' and status = 'open') = 1, 'a duplicate review (handoff_claim) is open - a person decides');
select pg_temp.check((select count(*) from crm.contacts where id in ((select v from fx where k = 'c2'), (select v from fx where k = 'x_contact'))) = 2, 'nothing was merged');
select pg_temp.check((select first_channel from crm.lead_attribution((select v from fx where k = 'x_lead'))) = 'social', 'the WhatsApp lead inherited the TRUE first touch (social), copied with its original time');
select pg_temp.check((select owner from crm.lead_conversation_owner where lead_id = (select v from fx where k = 'x_lead')) = 'sales', '…and Sales owns that thread');
select pg_temp.check((select (first_campaign ->> 'post') = 'p-42' from crm.lead_attribution((select v from fx where k = 'x_lead'))), '…with the campaign context it came with');

-- A number held by a contact who has NEVER messaged us on WhatsApp (so there is no thread to collide with):
-- the contact-ownership rule must refuse on its own, not lean on the thread rule.
reset role;
insert into crm.contacts (id, organization_id, full_name, phone) values ('00000000-0000-4000-8000-0000000000e1', :'ORG', 'Phone Holder', '+14155550155');
insert into fx select 'c6', contact_id from (select * from crm.resolve_identity(:'ORG', '{"name":"Zed Pillai","email":"zed@handoff.example.org"}', 'email')) q;
insert into crm.leads (organization_id, contact_id, title, source, source_ref, status) values (:'ORG', (select v from fx where k = 'c6'), 'Zed', 'email', 'outreach:zed', 'new') returning id \gset L6_
set local role service_role;
select crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h('AOS-TTTT-1414-VVVV-1515'), :'L6_id', 'email', null, 'email_outreach') \gset
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550155', pg_temp.h('AOS-TTTT-1414-VVVV-1515'))) = 'review_needed', 'a number held by a contact with NO WhatsApp thread is still not taken (ownership rule on its own)');
select pg_temp.check((select source from crm.leads where id = :'L6_id') = 'email', '…and Zed''s lead was not re-keyed');
select pg_temp.check((select phone from crm.contacts where id = '00000000-0000-4000-8000-0000000000e1') = '+14155550155', '…and the holder kept their number');

-- ── 6. expiry, cancellation, a closed lead ─────────────────────────────────
reset role;
insert into fx select 'c3', contact_id from (select * from crm.resolve_identity(:'ORG', '{"name":"Dev Nair","email":"dev@handoff.example.org"}', 'email')) q;
insert into crm.leads (organization_id, contact_id, title, source, source_ref, status) values (:'ORG', (select v from fx where k = 'c3'), 'Dev', 'email', 'outreach:dev', 'new') returning id \gset L3_
insert into fx values ('l3', :'L3_id');
-- A marketplace's own rule decides whether a B2B handoff may exist (slice 10): with no rule it is refused, so the rule is set here.
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h('AOS-ZZZZ-0000-ZZZZ-0001'), (select v from fx where k = 'l3'), 'b2b', 'upwork', 'b2b_opportunity')) = 'offplatform_forbidden', 'a B2B handoff with no marketplace rule is refused (fail closed)');
insert into crm.b2b_platform_rules (organization_id, platform, offplatform_contact) values (:'ORG', 'upwork', 'allowed') on conflict (organization_id, platform) do update set offplatform_contact = 'allowed';
select crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C4'), (select v from fx where k = 'l3'), 'b2b', 'upwork', 'b2b_opportunity') \gset
alter table crm.channel_handoffs disable trigger channel_handoff_guard;
update crm.channel_handoffs set expires_at = now() - interval '1 hour' where token_hash = pg_temp.h(:'C4');
alter table crm.channel_handoffs enable trigger channel_handoff_guard;
set local role service_role;
select pg_temp.check((select outcome from crm.open_channel_handoff(pg_temp.h(:'C4'))) = 'expired', 'an EXPIRED reference opens nothing');
select pg_temp.check((select status from crm.channel_handoffs where token_hash = pg_temp.h(:'C4')) = 'EXPIRED', '…and is marked EXPIRED');
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550177', pg_temp.h(:'C4'))) = 'expired', '…and cannot be bound from a message either');
select pg_temp.check((select phone from crm.contacts where id = (select v from fx where k = 'c3')) is null, '…so no number was attached');
insert into fx select 'h5', handoff_id from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h(:'C5'), (select v from fx where k = 'l3'), 'b2b', 'upwork', 'b2b_opportunity');
select pg_temp.check((select status from crm.channel_handoffs where id = (select v from fx where k = 'h5')) = 'CREATED', 'after expiry a fresh handoff can be created for the lead');

reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.cancel_channel_handoff((select v from fx where k = 'h5'), 'x')) = 'forbidden', 'a member cannot cancel a handoff');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.cancel_channel_handoff((select v from fx where k = 'h5'), '')) = 'needs_reason', 'cancelling needs a reason');
select pg_temp.check((select outcome from crm.cancel_channel_handoff((select v from fx where k = 'h5'), 'prospect asked us not to')) = 'cancelled', 'an admin cancels a live handoff');
select pg_temp.check((select outcome from crm.cancel_channel_handoff((select v from fx where k = 'h5'), 'again')) = 'not_live', 'a cancelled one cannot be cancelled again');
select pg_temp.check((select outcome from crm.cancel_channel_handoff((select v from fx where k = 'h1'), 'too late')) = 'not_live', 'a consumed one cannot be cancelled');
reset role;
set local role service_role;
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550177', pg_temp.h(:'C5'))) = 'cancelled', 'a CANCELLED reference cannot be bound');

reset role;
update crm.leads set status = 'disqualified', disqualified_reason = 'out of scope' where id = (select v from fx where k = 'l3');
set local role service_role;
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h('AOS-MMMM-1212-NNNN-3434'), (select v from fx where k = 'l3'), 'b2b', 'upwork', 'b2b_opportunity')) = 'closed', 'a closed lead cannot be given a handoff');

reset role;
insert into crm.leads (organization_id, contact_id, title, source, source_ref, status) values (:'ORG', (select v from fx where k = 'c3'), 'Dev 2', 'email', 'outreach:dev2', 'new') returning id \gset L4_
set local role service_role;
select crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h('AOS-PPPP-5656-QQQQ-7878'), :'L4_id', 'email', null, 'email_outreach') \gset
reset role;
update crm.leads set status = 'disqualified', disqualified_reason = 'went silent' where id = :'L4_id';
set local role service_role;
select pg_temp.check((select outcome from crm.bind_handoff_from_message('pnid-handoff-a', '14155550166', pg_temp.h('AOS-PPPP-5656-QQQQ-7878'))) = 'invalid', 'a lead closed AFTER the link was made turns the handoff INVALID');
select pg_temp.check((select count(*) from crm.channel_handoffs where status = 'INVALID') = 1, '…and it is recorded as INVALID');

-- the sweep expires unused links, never a used one
reset role;
alter table crm.channel_handoffs disable trigger channel_handoff_guard;
update crm.channel_handoffs set status = 'RESOLVED', expires_at = now() - interval '1 day' where id = (select v from fx where k = 'h1') and false;
alter table crm.channel_handoffs enable trigger channel_handoff_guard;
set local role service_role;
select pg_temp.check(crm.expire_channel_handoffs(100) >= 0, 'the expiry sweep runs');

-- ── 7. who can call what; tenant isolation; the hash is not readable ───────
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', :'ORG', 'ops_admin');
set local role authenticated;
do $$
begin
  begin perform * from crm.open_channel_handoff('x'); raise exception 'FAILED: a session called open';
  exception when insufficient_privilege then raise notice 'ok  open_channel_handoff is not callable by a session'; end;
  begin perform * from crm.bind_handoff_from_message('a', 'b', 'c'); raise exception 'FAILED: a session called bind';
  exception when insufficient_privilege then raise notice 'ok  bind_handoff_from_message is not callable by a session'; end;
  begin perform * from crm.consume_channel_handoff(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()); raise exception 'FAILED: a session called consume';
  exception when insufficient_privilege then raise notice 'ok  consume_channel_handoff is not callable by a session'; end;
  begin perform crm.expire_channel_handoffs(1); raise exception 'FAILED: a session called the sweep';
  exception when insufficient_privilege then raise notice 'ok  the expiry sweep is not callable by a session'; end;
  begin perform token_hash from crm.channel_handoffs limit 1; raise exception 'FAILED: a session read the token hash';
  exception when insufficient_privilege then raise notice 'ok  the token hash is not readable even by an admin'; end;
end $$;
select pg_temp.check((select count(*) from crm.channel_handoffs) >= 4, 'an admin reads the handoff records (without the hash)');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a004', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.channel_handoffs) = 0, 'organisation B sees none of organisation A''s handoffs');
select pg_temp.check((select count(*) from crm.whatsapp_handoff_settings) = 0, '…nor its handoff settings');
select pg_temp.check((select outcome from crm.cancel_channel_handoff((select id from (select id from crm.channel_handoffs union all select null) q limit 1), 'x')) in ('not_found', 'forbidden'), '…and cannot cancel one');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'ORG', gen_random_uuid(), pg_temp.h('AOS-RRRR-9090-SSSS-1313'), (select v from fx where k = 'l1'), 'email', null, 'human')) = 'forbidden', 'a session of B cannot create a handoff in A');

-- every acquisition table: no anon read, no authenticated write, whatever the platform's default privileges say
select pg_temp.check(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'crm' and c.relname in ('target_services', 'icp_versions', 'acquisition_channels', 'identity_keys', 'duplicate_reviews',
     'lead_touchpoints', 'lead_conversation_owner', 'conversation_owner_transfers', 'whatsapp_handoff_settings', 'channel_handoffs')
     and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
          or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete'))
), 'no acquisition table is readable by anon or writable by authenticated (the platform default privileges were revoked)');

-- ── 8. audit ───────────────────────────────────────────────────────────────
reset role;
select pg_temp.check((select count(*) from audit.audit_log where action = 'handoff.created') >= 3, 'creation is audited');
select pg_temp.check((select count(*) from audit.audit_log where action = 'handoff.bound') = 1, 'the bind is audited');
select pg_temp.check((select count(*) from audit.audit_log where action = 'handoff.consumed') = 2, 'each consumption is audited');
select pg_temp.check((select count(*) from audit.audit_log where action = 'handoff.cancelled') = 1, 'a cancellation is audited');
select pg_temp.check((select count(*) from audit.audit_log where action = 'handoff.expired') >= 1, 'an expiry is audited');
select pg_temp.check((select count(*) from audit.audit_log where action = 'handoff.invalidated') = 1, 'an invalidation is audited');
select pg_temp.check((select count(*) from audit.audit_log where action = 'handoff.settings_changed') = 1, 'the number change is audited');
select pg_temp.check((select count(*) from audit.audit_log where action in ('identity.key_sync_failed', 'identity.touch_failed')) = 0, 'no bookkeeping trigger failed silently');
select pg_temp.check((select count(*) from audit.audit_log where (after::text like '%AOS-%' or before::text like '%AOS-%')) = 0, 'no plaintext reference appears in the audit log');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
