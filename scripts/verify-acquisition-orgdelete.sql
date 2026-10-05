-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, follow-up — Results are read from the CRM, goals are measured
-- against what the Admin set, and what is failing is loud. Reading only.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-orgdelete.sql
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
create or replace function pg_temp.as_service() returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', '{"role":"service_role"}', true); end $$;
grant execute on function pg_temp.as_service() to public;
create or replace function pg_temp.sha(t text) returns text language sql as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
grant execute on function pg_temp.sha(text) to public;

\set ORG '00000000-0000-4000-8000-000000000001'
\set ORGB '00000000-0000-4000-8000-0000000000b2'
\set OWNER '00000000-0000-4000-8000-00000000a001'
\set ADMIN '00000000-0000-4000-8000-00000000a002'
\set MEMBER '00000000-0000-4000-8000-00000000a003'
\set OTHER '00000000-0000-4000-8000-00000000a004'

-- A throwaway organisation accumulates data in every engine, then is deleted. The history triggers must refuse deleting history while its
-- organisation exists, and must let the organisation's own delete remove it. (Found by the first CI run: the tenancy probe could not delete.)
\set OTHER '00000000-0000-4000-8000-00000000a004'
insert into auth.users (id, email) values (:'OTHER', 'lg-other-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'OTHER', 'lg-other-owner@example.test', 'LG Other') on conflict do nothing;
insert into core.organizations (id, name, slug, settings) values ('00000000-0000-4000-8000-0000000000c7', 'Doomed Agency', 'doomed-agency', '{"whatsapp_phone_number_id":"pnid-doomed"}');
\set DOOMED '00000000-0000-4000-8000-0000000000c7'
create temp table fx (k text primary key, v uuid);
grant all on fx to public;
select pg_temp.as_user(:'OTHER', :'DOOMED', 'owner');
set local role authenticated;
select crm.ensure_acquisition_defaults();
select crm.set_handoff_settings('+14155550100', 14);
select crm.ensure_b2b_defaults();
select crm.set_channel_settings('google_ads', true, 5, 500000000, 50);
select crm.set_channel_settings('b2b', true, 5, null, 50);
insert into fx select 'ca', campaign_id from crm.create_ad_campaign(:'DOOMED', 'meta_ads', 'Doomed campaign');
insert into fx select 'va', version_id from crm.add_ad_version(:'DOOMED', (select v from fx where k = 'ca'), '{"destination":{"type":"whatsapp"},"adsets":[{"name":"a","audience":{"locations":["IN"],"age_min":25},"placements":["feed"]}],"creatives":[{"headline":"Fast sites","primary_text":"We build fast, accessible websites for growing retailers. Message us.","cta":"WHATSAPP_MESSAGE"}]}'::jsonb, 100000, null, null, null);
insert into fx select 'pg', page_id from crm.create_landing_page(:'DOOMED', 'Doomed page', 'doomed-page');
insert into fx select 'lv', version_id from crm.add_landing_version(:'DOOMED', (select v from fx where k = 'pg'), '{"headline":"Doomed headline here","benefits":[{"title":"One","text":"A benefit text."},{"title":"Two","text":"Another benefit."},{"title":"Three","text":"A third benefit."}],"cta_text":"Chat now","privacy_url":"https://example.com/p","contact_email":"a@example.com"}'::jsonb, 'https://lp.example.com/doomed');
insert into fx select 'bo', opportunity_id from crm.record_b2b_opportunity(:'DOOMED', 'upwork', 'doomed-1', null, 'Website Development for a shop', 'A request.', 100, 200, 'USD', null, null);
select crm.decide_b2b_opportunity(:'DOOMED', (select v from fx where k = 'bo'), 'shortlist');
insert into fx select 'bp', version_id from crm.add_b2b_proposal_version(:'DOOMED', (select v from fx where k = 'bo'), repeat('We would build this storefront with you, starting from how customers buy. ', 2), 150000, 21, 0, '{}');
insert into fx select 'ia', item_id from crm.create_content_item(:'DOOMED', 'linkedin', 'reach', 'text', null, null, 'Doomed post');
select crm.create_social_strategy(:'DOOMED', 'linkedin', 3, '{"pillars":["a"]}', null, null);
select crm.save_qualification_model('{"need_clarity":50}', 'x');
reset role;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'ct', contact_id from crm.resolve_identity(:'DOOMED', '{"name":"Doomed Person","email":"doomed@d.example","phone":"+14155550777"}', 'email');
insert into fx select 'sv', version_id from crm.add_content_version(:'DOOMED', (select v from fx where k = 'ia'), 'Here is how a small retailer can plan the first ninety days of a new storefront, week by week.', null, '{}', '{}', '{}');
select crm.record_acquisition_usage(:'DOOMED', 'meta_ads', 'spend_minor', 100, 'doomed-usage');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status) values ('00000000-0000-4000-8000-0000000000c8', :'DOOMED', (select v from fx where k = 'ct'), 'Doomed lead', 'email', 'o:d', 'new');
set local role service_role;
select pg_temp.as_service();
select crm.record_touchpoint(:'DOOMED', '00000000-0000-4000-8000-0000000000c8', 'email', null, 'outreach_sent', '{}', '{}', 'doomed:1', now() - interval '3 days');
select pg_temp.check((select outcome from crm.create_channel_handoff(:'DOOMED', gen_random_uuid(), pg_temp.sha('doomed-hash'), '00000000-0000-4000-8000-0000000000c8', 'email', null, 'email_outreach')) = 'created', 'the throwaway organisation has a lead, touches, a handoff, campaigns, pages, proposals and posts');
reset role;
do $$
declare t text; n integer; total integer := 0;
begin
  -- history inside a LIVE organisation is still refused
  begin delete from crm.lead_touchpoints where organization_id = '00000000-0000-4000-8000-0000000000c7'; raise exception 'FAILED: a touchpoint was deleted while its organisation exists';
  exception when insufficient_privilege then raise notice 'ok  history is still refused while its organisation exists'; end;
  begin delete from crm.ad_campaigns where organization_id = '00000000-0000-4000-8000-0000000000c7'; raise exception 'FAILED: a campaign was deleted while its organisation exists';
  exception when insufficient_privilege then raise notice 'ok  a campaign is still refused while its organisation exists'; end;
  begin delete from crm.channel_handoffs where organization_id = '00000000-0000-4000-8000-0000000000c7'; raise exception 'FAILED: a handoff was deleted while its organisation exists';
  exception when insufficient_privilege then raise notice 'ok  a handoff is still refused while its organisation exists'; end;
  -- a lead (and the touch its own creation recorded) can be deleted on its own, as the app's fixtures do
  begin
    insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000c6', 'Lead Delete Agency', 'lead-delete-agency') on conflict do nothing;
    insert into crm.leads (id, organization_id, title, source, source_ref, status) values ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-0000000000c6', 'Lonely lead', 'manual', 'o:lonely', 'new');
    if (select count(*) from crm.lead_touchpoints where lead_id = '00000000-0000-4000-8000-0000000000c5') = 0 then raise exception 'FAILED: the lead recorded no touch (fixture)'; end if;
    delete from crm.leads where id = '00000000-0000-4000-8000-0000000000c5';
    if exists (select 1 from crm.lead_touchpoints where lead_id = '00000000-0000-4000-8000-0000000000c5') then raise exception 'FAILED: a deleted lead left its touchpoints'; end if;
    raise notice 'ok  deleting a lead removes its touchpoints (a live organisation can still clean up its own fixtures)';
  end;
  -- and the organisation's own delete removes it all
  delete from core.organizations where id = '00000000-0000-4000-8000-0000000000c7';
  for t in select c.table_name from information_schema.columns c join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
            where c.table_schema = 'crm' and c.column_name = 'organization_id' loop
    execute format('select count(*) from crm.%I where organization_id = %L', t, '00000000-0000-4000-8000-0000000000c7') into n;
    total := total + n;
    if n > 0 then raise exception 'FAILED: crm.% still holds % rows of a deleted organisation', t, n; end if;
  end loop;
  raise notice 'ok  deleting the organisation removed its rows from every crm table (checked each)';
end $$;

select 'ALL CHECKS PASSED' as result;
rollback;
