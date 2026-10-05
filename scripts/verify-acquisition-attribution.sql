-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 11 — Results are read from the CRM, goals are measured
-- against what the Admin set, and what is failing is loud. Reading only.
--
--   KEEP=1 scripts/apply-migrations-locally.sh
--   psql ... -v ON_ERROR_STOP=1 -f scripts/verify-acquisition-attribution.sql
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

insert into core.organizations (id, name, slug) values (:'ORGB', 'Other Agency', 'other-agency') on conflict do nothing;
insert into auth.users (id, email) values
  (:'OWNER', 'lg-owner@example.test'), (:'ADMIN', 'lg-admin@example.test'), (:'MEMBER', 'lg-member@example.test'), (:'OTHER', 'lg-other-owner@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values
  (:'OWNER', 'lg-owner@example.test', 'LG Owner'), (:'ADMIN', 'lg-admin@example.test', 'LG Admin'),
  (:'MEMBER', 'lg-member@example.test', 'LG Member'), (:'OTHER', 'lg-other-owner@example.test', 'LG Other') on conflict do nothing;
create temp table fx (k text primary key, v uuid);
grant all on fx to public;

insert into core.organizations (id, name, slug) values ('00000000-0000-4000-8000-0000000000b2', 'Other Agency', 'other-agency') on conflict do nothing;
\set CLIENT '00000000-0000-4000-8000-00000000a005'
insert into auth.users (id, email) values (:'CLIENT', 'lg-client@example.test') on conflict do nothing;
insert into core.users (id, email, full_name) values (:'CLIENT', 'lg-client@example.test', 'LG Client') on conflict do nothing;
-- the scratch database holds seed leads: assert the CHANGE the fixtures cause
create temp table base as select * from crm.acquisition_attribution_models(90) where false;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
insert into base select * from crm.acquisition_attribution_models(90);
grant all on base to public;
set local role service_role;
select pg_temp.as_service();
insert into fx select 'c' || n, contact_id from generate_series(1, 5) n, lateral crm.resolve_identity(:'ORG', jsonb_build_object('name', 'Attr ' || n, 'email', 'attr' || n || '@at.example'), 'whatsapp');
reset role;
insert into crm.leads (id, organization_id, contact_id, title, source, source_ref, status, created_at) values
  ('00000000-0000-4000-8000-0000000000b1', :'ORG', (select v from fx where k = 'c1'), 'one channel', 'whatsapp', 'wa:at1', 'new', now() - interval '20 days'),
  ('00000000-0000-4000-8000-0000000000b2', :'ORG', (select v from fx where k = 'c2'), 'two channels', 'whatsapp', 'wa:at2', 'new', now() - interval '20 days'),
  ('00000000-0000-4000-8000-0000000000b3', :'ORG', (select v from fx where k = 'c3'), 'three channels', 'whatsapp', 'wa:at3', 'new', now() - interval '20 days'),
  ('00000000-0000-4000-8000-0000000000b4', :'ORG', (select v from fx where k = 'c4'), 'same first and last', 'whatsapp', 'wa:at4', 'new', now() - interval '20 days'),
  ('00000000-0000-4000-8000-0000000000b5', :'ORG', (select v from fx where k = 'c5'), 'ancient', 'whatsapp', 'wa:at5', 'new', now() - interval '500 days');
set local role service_role;
select pg_temp.as_service();
-- b1: only the WhatsApp arrival (other). b2: google then email. b3: meta, then social, then b2b. b4: email, social, email.
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b2', 'google_ads', null, 'ad_click', '{}', '{}', 'at:2a', now() - interval '40 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b2', 'email', null, 'reply_received', '{}', '{}', 'at:2b', now() - interval '10 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b3', 'meta_ads', null, 'ad_click', '{}', '{}', 'at:3a', now() - interval '40 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b3', 'social', null, 'content_interaction', '{}', '{}', 'at:3b', now() - interval '30 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b3', 'b2b', null, 'profile_inquiry', '{}', '{}', 'at:3c', now() - interval '10 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b4', 'email', null, 'outreach_sent', '{}', '{}', 'at:4a', now() - interval '40 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b4', 'social', null, 'content_interaction', '{}', '{}', 'at:4b', now() - interval '30 days');
select crm.record_touchpoint(:'ORG', '00000000-0000-4000-8000-0000000000b4', 'email', null, 'reply_received', '{}', '{}', 'at:4c', now() - interval '10 days');
reset role;
select pg_temp.as_user(:'ADMIN', :'ORG', 'ops_admin');
set local role authenticated;
create or replace function pg_temp.d(p_ch text, p_col text) returns numeric language sql as $$
  select (to_jsonb(a) ->> p_col)::numeric - (to_jsonb(b) ->> p_col)::numeric from crm.acquisition_attribution_models(90) a join base b using (channel) where channel = p_ch $$;
grant execute on function pg_temp.d(text, text) to public;
select pg_temp.check((select sum(first_touch) from crm.acquisition_attribution_models(90)) - (select sum(first_touch) from base) = 4, 'four new leads are credited under first touch');
select pg_temp.check((select sum(last_touch) from crm.acquisition_attribution_models(90)) - (select sum(last_touch) from base) = 4 and (select round(sum(linear)) from crm.acquisition_attribution_models(90)) - (select round(sum(linear)) from base) = 4 and (select round(sum(position_based)) from crm.acquisition_attribution_models(90)) - (select round(sum(position_based)) from base) = 4, 'every model hands out exactly one credit per lead: none can invent or lose credit');
-- every lead also carries the touch of its own WhatsApp arrival ('other'), at its creation time
-- b1 other | b2 google, other, email | b3 meta, social, other, b2b | b4 email, social, other, email
select pg_temp.check(pg_temp.d('google_ads', 'first_touch') = 1 and pg_temp.d('meta_ads', 'first_touch') = 1 and pg_temp.d('email', 'first_touch') = 1 and pg_temp.d('other', 'first_touch') = 1, 'first touch: Google found b2, Meta b3, email b4, and b1 arrived on its own');
select pg_temp.check(pg_temp.d('email', 'last_touch') = 2 and pg_temp.d('b2b', 'last_touch') = 1 and pg_temp.d('other', 'last_touch') = 1, 'last touch: email closed b2 and b4, B2B closed b3');
select pg_temp.check(pg_temp.d('google_ads', 'linear') = 0.333 and pg_temp.d('email', 'linear') = 0.667 and pg_temp.d('meta_ads', 'linear') = 0.250 and pg_temp.d('b2b', 'linear') = 0.250 and pg_temp.d('social', 'linear') = 0.583 and pg_temp.d('other', 'linear') = 1.917, 'linear: every channel that touched a lead shares one credit equally');
select pg_temp.check(pg_temp.d('google_ads', 'position_based') = 0.4 and pg_temp.d('meta_ads', 'position_based') = 0.4 and pg_temp.d('b2b', 'position_based') = 0.4 and pg_temp.d('email', 'position_based') = 1.2 and pg_temp.d('social', 'position_based') = 0.2 and pg_temp.d('other', 'position_based') = 1.4, 'position-based: 40% first, 40% last, 20% shared by the middle; first = last takes 80%');
select pg_temp.check((select count(*) from crm.acquisition_trend(12) where leads > 0) >= 1 and (select sum(leads) from crm.acquisition_trend(12)) >= 4 and not exists (select 1 from crm.acquisition_trend(12) where week_start < (now() - interval '13 weeks')::date), 'the trend counts the new leads by week');
select pg_temp.check((select count(*) from crm.acquisition_trend(1000)) = (select count(*) from crm.acquisition_trend(52)), 'the window is bounded (52 weeks)');
reset role;
select pg_temp.as_user(:'CLIENT', :'ORG', 'client');
set local role authenticated;
select pg_temp.check((select coalesce(sum(first_touch + last_touch + linear + position_based), 0) from crm.acquisition_attribution_models(90)) = 0 and (select count(*) from crm.acquisition_trend(12)) = 0, 'a portal client sees nothing');
reset role;
select pg_temp.as_user(:'OTHER', :'ORGB', 'owner');
set local role authenticated;
select pg_temp.check((select coalesce(sum(first_touch), 0) from crm.acquisition_attribution_models(90)) = 0 and (select count(*) from crm.acquisition_trend(12)) = 0, 'another organisation sees none of it');
reset role;
set local role service_role;
select pg_temp.as_service();
select pg_temp.check((select coalesce(sum(first_touch), 0) from crm.acquisition_attribution_models(90)) = 0 and (select count(*) from crm.acquisition_trend(12)) = 0, 'with no session nothing is aggregated across tenants');
reset role;
select 'ALL CHECKS PASSED' as result;
rollback;
