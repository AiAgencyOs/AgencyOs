-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 2 — one person, one identity, across channels.
--
-- Drives the spec's mandatory scenario (§78): a person found by EMAIL, then on
-- LINKEDIN, then arriving in WHATSAPP through the REAL ingest function, must
-- remain ONE contact with all three in its history. Plus: uncertain matches
-- open a review and merge nothing; first touch survives later channels; two
-- agents cannot both own a conversation; another tenant sees nothing.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-identity.sql
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

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b2'

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency', 'other-agency') on conflict do nothing;
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test'),
  ('00000000-0000-4000-8000-00000000a003', 'lg-member@example.test'),
  ('00000000-0000-4000-8000-00000000a004', 'lg-other-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values
  ('00000000-0000-4000-8000-00000000a002', 'lg-admin@example.test', 'LG Admin'),
  ('00000000-0000-4000-8000-00000000a003', 'lg-member@example.test', 'LG Member'),
  ('00000000-0000-4000-8000-00000000a004', 'lg-other-owner@example.test', 'LG Other') on conflict do nothing;
update core.organizations set settings = settings || '{"whatsapp_phone_number_id":"pnid-verify-1"}'::jsonb where id = :'ORG';

-- ── 0. the normalisers never guess ─────────────────────────────────────────
select pg_temp.check(crm.norm_phone('+91 98765-43210') = '+919876543210', 'a formatted E.164 phone normalises');
select pg_temp.check(crm.norm_phone('9876543210') is null, 'a national number with no country is NOT guessed');
select pg_temp.check(crm.norm_email('  Priya@Acme.IO ') = 'priya@acme.io', 'email is trimmed and lower-cased');
select pg_temp.check(crm.norm_email('not-an-email') is null, 'a non-email is not a key');
select pg_temp.check(crm.norm_domain('https://www.Acme.io/about?x=1') = 'acme.io', 'a URL reduces to its company domain');
select pg_temp.check(crm.norm_domain('someone@gmail.com') is null, 'a free-mail domain is not a company signal');
select pg_temp.check(crm.norm_social('linkedin', 'https://www.linkedin.com/in/Priya-Shah/?trk=x') = 'in/priya-shah', 'a LinkedIn URL reduces to its profile path');
select pg_temp.check(crm.norm_social('linkedin', 'in/priya-shah') = 'in/priya-shah', '…and the bare path is the same key');
select pg_temp.check(crm.norm_social('instagram', '@Priya.Shah') = 'priya.shah', 'an Instagram handle drops the @');
select pg_temp.check(crm.norm_social('facebook', 'https://facebook.com/profile.php?id=12345') = 'id/12345', 'a Facebook numeric profile is an id');

-- ── 1. the mandatory scenario (§78): EMAIL → LINKEDIN → WHATSAPP ───────────
set local role service_role;
select set_config('request.jwt.claims', '', true);
create temp table fx (k text primary key, v uuid);
grant all on fx to public;

insert into fx select 'person', contact_id from crm.resolve_identity(:'ORG', '{"name":"Priya Shah","email":"Priya@Acme.io","company":"Acme"}', 'email');
select pg_temp.check((select outcome from crm.resolve_identity(:'ORG', '{"name":"Priya Shah","email":"priya@acme.io"}', 'email')) = 'matched', 'EMAIL: the same address again is a match, not a second person');
select pg_temp.check((select count(*) from crm.contacts where organization_id = :'ORG' and lower(email) = 'priya@acme.io') = 1, 'EMAIL: one contact');

select pg_temp.check((select (outcome = 'matched' and contact_id = (select v from fx where k = 'person') and not created)
                        from crm.resolve_identity(:'ORG', '{"name":"Priya Shah","email":"priya@acme.io","linkedin":"https://www.linkedin.com/in/priya-shah"}', 'linkedin')), 'LINKEDIN: found by the known email, same contact, linkedin key attached');
select pg_temp.check((select count(*) from crm.identity_keys where contact_id = (select v from fx where k = 'person')) = 2, '…the contact now holds an email key and a linkedin key');

select pg_temp.check((select (outcome = 'matched' and contact_id = (select v from fx where k = 'person'))
                        from crm.resolve_identity(:'ORG', '{"phone":"+1 415 555 0142","linkedin":"in/priya-shah"}', 'whatsapp')), 'WHATSAPP: found by the linkedin key, same contact, phone attached');
select pg_temp.check((select phone from crm.contacts where id = (select v from fx where k = 'person')) = '+14155550142', '…and the contact''s empty phone column was filled');

-- Now the REAL WhatsApp ingest, from that number, must land on the same person.
insert into fx select 'lead', lead_id from crm.ingest_whatsapp_message('pnid-verify-1', '14155550142', 'wamid.verify.1', 'Hi, I would like a website', 'Priya S');
select pg_temp.check((select contact_id from crm.leads where id = (select v from fx where k = 'lead')) = (select v from fx where k = 'person'), 'WHATSAPP INGEST: the real ingest function attached the lead to the SAME contact');
select pg_temp.check((select count(*) from crm.contacts where organization_id = :'ORG' and (phone = '+14155550142' or lower(email) = 'priya@acme.io')) = 1, 'ONE durable contact across email, LinkedIn and WhatsApp');
select pg_temp.check((select count(*) from crm.duplicate_reviews where organization_id = :'ORG') = 0, '…and no duplicate review was needed');
select pg_temp.check((select count(distinct kind) from crm.identity_keys where contact_id = (select v from fx where k = 'person')) = 3, '…carrying all three keys: email, linkedin, phone');

-- The history: email outreach first, a LinkedIn touch, then WhatsApp. First touch must stay EMAIL.
select pg_temp.check((select outcome from crm.record_touchpoint(:'ORG', (select v from fx where k = 'lead'), 'email', null, 'outreach_sent',
    '{"sequence_id":"seq-1"}', '{}', 'email:msg-1', now() - interval '10 days')) = 'recorded', 'a touchpoint is recorded');
select pg_temp.check((select outcome from crm.record_touchpoint(:'ORG', (select v from fx where k = 'lead'), 'social', 'linkedin', 'content_interaction',
    '{"content_item_id":"c-9"}', '{}', 'li:evt-1', now() - interval '5 days')) = 'recorded', 'a LinkedIn touchpoint is recorded');
select pg_temp.check((select outcome from crm.record_touchpoint(:'ORG', (select v from fx where k = 'lead'), 'email', null, 'outreach_sent',
    '{"sequence_id":"seq-1"}', '{}', 'email:msg-1', now())) = 'duplicate', 'the same external ref again is idempotent (duplicate, not a second touch)');
select pg_temp.check((select count(*) from crm.lead_touchpoints where lead_id = (select v from fx where k = 'lead')) = 3, 'three touches: email, linkedin, and the WhatsApp lead creation');
select pg_temp.check((select first_channel from crm.lead_attribution((select v from fx where k = 'lead'))) = 'email', 'FIRST touch is email - later channels did not overwrite it');
select pg_temp.check((select last_channel from crm.lead_attribution((select v from fx where k = 'lead'))) = 'whatsapp', 'LAST touch is whatsapp');
select pg_temp.check((select channels from crm.lead_attribution((select v from fx where k = 'lead'))) = array['email', 'social', 'whatsapp'], 'the touched channels are all kept');
select pg_temp.check((select (first_campaign ->> 'sequence_id') = 'seq-1' from crm.lead_attribution((select v from fx where k = 'lead'))), 'first-touch campaign context is preserved');

-- ── 2. uncertain matches review, and merge nothing ─────────────────────────
insert into fx select 'other', contact_id from crm.resolve_identity(:'ORG', '{"name":"Rohan Mehta","email":"rohan@globex.com","company":"Globex"}', 'email');
select pg_temp.check((select outcome from crm.resolve_identity(:'ORG', '{"name":"Rohan Mehta","email":"r.mehta@globex.com","linkedin":"in/rohan-m"}', 'linkedin')) = 'created_pending_review', 'same name + same company domain, different email: a NEW contact and a review - not a match');
select pg_temp.check((select count(*) from crm.contacts where organization_id = :'ORG' and full_name = 'Rohan Mehta') = 2, 'nothing was merged: both contacts exist');
select pg_temp.check((select reason from crm.duplicate_reviews where organization_id = :'ORG' and status = 'open') = 'name_and_domain', 'the review says why');
select pg_temp.check((select outcome from crm.resolve_identity(:'ORG', '{"name":"Rohan Mehta","email":"rohan.m@gmail.com"}', 'email')) = 'created', 'the same name on a FREE-MAIL address is not even suspicious');
select pg_temp.check((select outcome from crm.resolve_identity(:'ORG', '{"name":"Rohan Mehta","email":"rohan.other@initech.com"}', 'email')) = 'created', 'the same name at another company is a different person');
select pg_temp.check((select count(*) from crm.duplicate_reviews where organization_id = :'ORG' and status = 'open') = 1, 'only the one genuine suspicion is queued');

-- Two different people each hold one of the keys in a signal set: conflict, nothing attached, nothing moved.
insert into fx select 'p1', contact_id from crm.resolve_identity(:'ORG', '{"name":"Anil K","email":"anil@one.example.org"}', 'email');
insert into fx select 'p2', contact_id from crm.resolve_identity(:'ORG', '{"name":"A Kumar","linkedin":"in/anil-kumar"}', 'linkedin');
select pg_temp.check((select outcome from crm.resolve_identity(:'ORG', '{"email":"anil@one.example.org","linkedin":"in/anil-kumar"}', 'b2b')) = 'conflict', 'a signal set that links two people is a CONFLICT');
select pg_temp.check((select contact_id from crm.identity_keys where organization_id = :'ORG' and kind = 'linkedin' and value = 'in/anil-kumar') = (select v from fx where k = 'p2'), '…the key stayed with its owner (no last-write-wins)');
select pg_temp.check((select count(*) from crm.duplicate_reviews where organization_id = :'ORG' and reason = 'shared_key' and status = 'open') = 1, '…and a shared_key review is open');
select pg_temp.check((select outcome from crm.resolve_identity(:'ORG', '{"name":"x"}', 'email')) = 'no_signals', 'a name alone is never enough to resolve');
select pg_temp.check((select outcome from crm.resolve_identity(:'ORG', '[]', 'email')) = 'invalid', 'a non-object signal set is refused');

-- ── 3. a person decides; nothing is merged by deciding ─────────────────────
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a003', :'ORG', 'member');
set local role authenticated;
select pg_temp.check((select outcome from crm.decide_duplicate_review((select id from crm.duplicate_reviews where status = 'open' limit 1), 'kept_separate', 'x')) = 'forbidden', 'a member cannot decide a duplicate review');
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', :'ORG', 'ops_admin');
select pg_temp.check((select outcome from crm.decide_duplicate_review((select id from crm.duplicate_reviews where status = 'open' limit 1), 'kept_separate', '')) = 'needs_note', 'keeping two apart needs a reason');
select pg_temp.check((select outcome from crm.decide_duplicate_review((select id from crm.duplicate_reviews where status = 'open' order by created_at limit 1), 'kept_separate', 'different people, same employer')) = 'decided', 'an admin decides');
select pg_temp.check((select count(*) from crm.contacts where organization_id = :'ORG' and email like '%@globex.com') = 2, '…and deciding merged nothing (both Globex contacts remain)');
select pg_temp.check((select outcome from crm.decide_duplicate_review((select id from crm.duplicate_reviews where status = 'kept_separate' limit 1), 'dismissed', null)) = 'already_decided', 'a decided review cannot be decided twice');
select pg_temp.check((select outcome from crm.decide_duplicate_review(gen_random_uuid(), 'dismissed', null)) = 'not_found', 'an unknown review is not found');
select pg_temp.check((select outcome from crm.decide_duplicate_review((select id from crm.duplicate_reviews where status = 'open' limit 1), 'merge_now', 'x')) = 'invalid', 'there is no "merge" decision to take');

-- ── 4. touchpoints are history ─────────────────────────────────────────────
reset role;
do $$
begin
  begin update crm.lead_touchpoints set channel = 'manual'; raise exception 'FAILED: a touchpoint was updated';
  exception when insufficient_privilege then raise notice 'ok  a touchpoint cannot be updated'; end;
  begin delete from crm.lead_touchpoints; raise exception 'FAILED: a touchpoint was deleted';
  exception when insufficient_privilege then raise notice 'ok  a touchpoint cannot be deleted'; end;
end $$;

-- A Click-to-WhatsApp lead: the ad is the EARLIER, true first touch.
set local role service_role;
select set_config('request.jwt.claims', '', true);
insert into fx select 'ctwa', lead_id from crm.ingest_whatsapp_message('pnid-verify-1', '14155550143', 'wamid.verify.2', 'Saw your ad', 'Dev');
reset role;
update crm.leads set campaign_source_type = 'ad', campaign_source_id = 'ad-777', campaign_source_url = 'https://fb.example/ad/777', campaign_headline = 'Websites that sell'
 where id = (select v from fx where k = 'ctwa');
set local role service_role;
select pg_temp.check((select first_channel from crm.lead_attribution((select v from fx where k = 'ctwa'))) = 'meta_ads', 'a Click-to-WhatsApp lead''s FIRST touch is the Meta ad');
select pg_temp.check((select (first_campaign ->> 'ad_id') = 'ad-777' from crm.lead_attribution((select v from fx where k = 'ctwa'))), '…with the ad id');
select pg_temp.check((select last_channel from crm.lead_attribution((select v from fx where k = 'ctwa'))) = 'whatsapp', '…and WhatsApp is the last touch (the closing channel)');

-- ── 5. exactly one owner; a race has a loser ───────────────────────────────
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), null, 'email_outreach', 'lead came from an outreach sequence')) = 'transferred', 'the first owner is assigned (expected = none)');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), null, 'social_media', 'a second agent that believed nobody owned it')) = 'stale', 'a second agent working from stale belief LOSES');
select pg_temp.check((select owner from crm.lead_conversation_owner where lead_id = (select v from fx where k = 'lead')) = 'email_outreach', '…and the owner did not change');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), 'email_outreach', 'sales', 'prospect moved to WhatsApp', 'handoff_consumed', '{"handoff":"h-1"}')) = 'transferred', 'a correct handoff transfers to Sales');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), 'email_outreach', 'social_media', 'late agent still thinks email owns it')) = 'stale', 'the previous owner can no longer take it back by acting on old state');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), 'sales', 'sales', 'no-op')) = 'unchanged', 'transferring to the current owner is unchanged');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), 'sales', 'scheduler', 'x y z')) = 'invalid', 'the Scheduler is not a conversation owner');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), 'sales', 'quotation_master', 'x y z')) = 'invalid', 'nor is the Quotation Master');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), 'sales', 'email_outreach', '')) = 'invalid', 'a transfer needs a reason');
select pg_temp.check((select count(*) from crm.conversation_owner_transfers where lead_id = (select v from fx where k = 'lead')) = 2, 'both transfers are in the history (previous owner, new owner, reason, state)');
select pg_temp.check((select (from_owner, to_owner, workflow_state) = ('email_outreach', 'sales', 'handoff_consumed') from crm.conversation_owner_transfers where lead_id = (select v from fx where k = 'lead') order by created_at desc, id desc limit 1), '…carrying who, to whom, and the workflow state');
select pg_temp.check((select version from crm.lead_conversation_owner where lead_id = (select v from fx where k = 'lead')) = 2, 'the owner row is versioned');

-- ── 6. the outcome is derived from the lifecycle that already exists ──────
select pg_temp.check(crm.lead_outcome((select v from fx where k = 'lead')) = 'OPEN', 'a new lead is OPEN');
reset role;
update crm.leads set status = 'disqualified', disqualified_reason = 'out of scope' where id = (select v from fx where k = 'ctwa');
set local role service_role;
select pg_temp.check(crm.lead_outcome((select v from fx where k = 'ctwa')) = 'DISQUALIFIED', 'a disqualified lead is DISQUALIFIED');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'ctwa'), null, 'sales', 'try to own a closed lead')) = 'closed', 'a closed lead cannot be given an owner');
reset role;
insert into sales.opportunities (organization_id, lead_id, name, stage, closed_at, lost_reason, lost_category)
  values (:'ORG', (select v from fx where k = 'lead'), 'Priya website', 'lost', now(), 'went elsewhere', 'chose_competitor');
set local role service_role;
select pg_temp.check(crm.lead_outcome((select v from fx where k = 'lead')) = 'LOST', 'a lead whose opportunity was lost is LOST');
select pg_temp.check((select outcome from crm.transfer_conversation_owner(:'ORG', (select v from fx where k = 'lead'), 'sales', 'human', 'try after lost')) = 'closed', 'a LOST lead cannot change owner');

-- ── 7. who may call what, and tenant isolation ─────────────────────────────
reset role;
select pg_temp.as_user('00000000-0000-4000-8000-00000000a002', :'ORG', 'ops_admin');
set local role authenticated;
do $$
begin
  begin perform * from crm.resolve_identity('00000000-0000-4000-8000-000000000001', '{"email":"x@y.example.org"}', 'x');
    raise exception 'FAILED: a session called resolve_identity';
  exception when insufficient_privilege then raise notice 'ok  resolve_identity is the engines'' door: a session cannot call it'; end;
  begin perform * from crm.record_touchpoint('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'email', null, 'discovered');
    raise exception 'FAILED: a session recorded a touchpoint';
  exception when insufficient_privilege then raise notice 'ok  record_touchpoint is service-only'; end;
end $$;
select pg_temp.check((select count(*) from crm.identity_keys) > 0 and (select count(*) from crm.lead_touchpoints) > 0, 'an admin of the org can read keys and touchpoints');
select pg_temp.check((select outcome from crm.transfer_conversation_owner('00000000-0000-4000-8000-0000000000b2', (select v from fx where k = 'lead'), null, 'sales', 'wrong org')) = 'forbidden', 'a session cannot transfer in another organisation');
select pg_temp.check(crm.lead_outcome((select v from fx where k = 'lead')) = 'LOST', 'an admin can read an outcome in their own org');

select pg_temp.as_user('00000000-0000-4000-8000-00000000a004', :'ORGB', 'owner');
select pg_temp.check((select count(*) from crm.identity_keys) = 0, 'org B sees none of org A''s identity keys');
select pg_temp.check((select count(*) from crm.duplicate_reviews) = 0, '…duplicate reviews');
select pg_temp.check((select count(*) from crm.lead_touchpoints) = 0, '…touchpoints');
select pg_temp.check((select count(*) from crm.lead_conversation_owner) = 0, '…conversation owners');
select pg_temp.check((select count(*) from crm.conversation_owner_transfers) = 0, '…owner history');
select pg_temp.check(crm.lead_outcome((select v from fx where k = 'lead')) is null, '…and cannot read another org''s outcome');
select pg_temp.check((select outcome from crm.transfer_conversation_owner('00000000-0000-4000-8000-0000000000b2', (select v from fx where k = 'lead'), null, 'sales', 'cross tenant')) = 'unknown_lead', 'org B cannot take over org A''s lead');

-- ── 8. audit ───────────────────────────────────────────────────────────────
reset role;
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'identity.created') >= 3, 'creating an identity is audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'identity.matched') >= 3, 'a match is audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'identity.duplicate_review_opened') >= 2, 'opening a review is audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'identity.duplicate_review_kept_separate') = 1, 'a decision is audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action = 'identity.conversation_owner_transferred') = 2, 'each owner transfer is audited');
select pg_temp.check((select count(*) from audit.audit_log where created_at >= now() and action in ('identity.key_sync_failed', 'identity.touch_failed')) = 0, 'no bookkeeping trigger failed silently during all of this');

do $$ begin raise notice 'ALL CHECKS PASSED'; end $$;
rollback;
