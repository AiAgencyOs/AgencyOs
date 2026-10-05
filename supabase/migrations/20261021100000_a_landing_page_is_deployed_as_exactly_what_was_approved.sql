-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 9 — A landing page is deployed as exactly what was
-- approved, and a Google ad may only point at one that is deployed AND verified.
--
-- WHAT THE AUDIT FOUND. Google Ads needs a destination the agency controls
-- (spec §60): a landing page whose only job is to move a visitor to WhatsApp,
-- with the visit still attributable. Nothing existed: no page content, no
-- approval of a page, no deployment record, no check that a deployed page is
-- the page that was approved, and a Google plan could name any "landing page".
--
-- WHAT THIS ADDS.
--  1. Landing pages and IMMUTABLE versions. The hash is derived by a trigger
--     from the slug, the content, the WhatsApp number the page will use, the
--     public URL and the tracking fields, so a caller cannot approve one thing
--     and deploy another.
--  2. Rules that fail a page and never approve one: required sections, no
--     manufactured urgency, no unsupported claim, no unsourced statistic, and
--     NO PROOF WITHOUT A SOURCE - every proof item must reference one of the
--     agency's own portfolio items, read at check time. A testimonial nobody
--     can trace is a fabricated testimonial.
--  3. Deploy is the existing governed door (`landing_page_deploy`, never
--     automatic, needs the Hostinger connector ACTIVE). Deployed is not
--     verified: VERIFIED is a separate step that records what was actually
--     found at the public URL (reachable, carries the approved version's hash,
--     links to the approved WhatsApp number, carries the tracking capture).
--  4. A Google ad launch is refused unless its landing page version is
--     VERIFIED, read at execution time (`begin_ad_apply` and `check_ad_version`
--     carried forward from slice 8 with that one edit).
--  5. A visit that becomes a WhatsApp message stays attributable: the page's
--     button prefills a tag (LP-<version>-<ad campaign id>), and
--     `record_landing_arrival` turns it into a Google first touch for the lead
--     the message created. The tag is a CLAIM about where someone came from,
--     not authority: it can only add a touchpoint, never change a lead.
--
-- NOT BUILT: the Hostinger deployer (nothing reaches a host), the page builder
-- UI beyond a structured form, A/B testing, and rollback as a one-click act
-- (redeploying an older version is a new governed execution).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. pages and immutable versions ────────────────────────────────────────

create table if not exists crm.landing_pages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 3 and 120),
  slug             text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 60),
  target_service   text check (target_service is null or length(target_service) between 2 and 80),
  status           text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  current_version_id uuid,
  live_version_id  uuid,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (organization_id, slug)
);
comment on table crm.landing_pages is 'A page the agency owns as an ad destination. Its content lives only in immutable versions; live_version_id is the version most recently deployed.';

create table if not exists crm.landing_page_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  page_id          uuid not null references crm.landing_pages(id) on delete restrict,
  version          integer not null check (version >= 1),
  content          jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 60000),
  whatsapp_number  text not null check (whatsapp_number ~ '^\+[0-9]{8,15}$'),
  public_url       text not null check (public_url ~ '^https://[a-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$' and length(public_url) <= 300),
  tracking         jsonb not null default '{"capture":["utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid"]}'::jsonb
                     check (jsonb_typeof(tracking) = 'object'),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  state            text not null default 'DRAFT' check (state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW', 'REJECTED', 'DEPLOYING', 'DEPLOYED', 'VERIFIED', 'VERIFY_FAILED', 'SUPERSEDED', 'RETIRED', 'CANCELLED')),
  review           jsonb check (review is null or jsonb_typeof(review) = 'object'),
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,
  supersedes_version_id uuid references crm.landing_page_versions(id) on delete set null,
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (page_id, version)
);
create index if not exists landing_versions_org_state_idx on crm.landing_page_versions (organization_id, state, created_at desc);
create index if not exists landing_versions_prefix_idx on crm.landing_page_versions (organization_id, (left(id::text, 8)));
create unique index if not exists landing_versions_one_deploying_key on crm.landing_page_versions (page_id) where state = 'DEPLOYING';
create unique index if not exists landing_versions_one_live_key on crm.landing_page_versions (page_id) where state in ('DEPLOYED', 'VERIFIED', 'VERIFY_FAILED');
comment on table crm.landing_page_versions is 'One immutable version of a landing page. The hash is derived by a trigger from the slug, content, WhatsApp number, public URL and tracking fields; only the workflow state moves, only through the doors.';

alter table crm.landing_pages drop constraint if exists landing_pages_current_fk;
alter table crm.landing_pages add constraint landing_pages_current_fk foreign key (current_version_id) references crm.landing_page_versions(id) on delete set null deferrable initially deferred;
alter table crm.landing_pages drop constraint if exists landing_pages_live_fk;
alter table crm.landing_pages add constraint landing_pages_live_fk foreign key (live_version_id) references crm.landing_page_versions(id) on delete set null deferrable initially deferred;

create table if not exists crm.landing_deployments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  version_id       uuid not null references crm.landing_page_versions(id) on delete restrict,
  execution_id     uuid not null references crm.governed_executions(id) on delete restrict,
  deployed_url     text not null check (deployed_url ~ '^https://'),
  deployed_html_hash text not null check (deployed_html_hash ~ '^[0-9a-f]{64}$'),
  deployed_at      timestamptz not null default now(),
  unique (version_id),
  unique (execution_id)
);
comment on table crm.landing_deployments is 'The record that a version was handed to the host, with the hash of the HTML that was sent. Append-only. Deployed is not verified.';

create table if not exists crm.landing_verifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  deployment_id    uuid not null references crm.landing_deployments(id) on delete restrict,
  checks           jsonb not null check (jsonb_typeof(checks) = 'object'),
  passed           boolean not null,
  verified_at      timestamptz not null default clock_timestamp()
);
create index if not exists landing_verifications_idx on crm.landing_verifications (deployment_id, verified_at desc);
comment on table crm.landing_verifications is 'What was actually found at the public URL after a deploy. Append-only; a re-check is a new row, and a page is VERIFIED only when the latest check passed every item.';

-- ── 2. the rules: a page can be failed, never approved, by a rule ──────────

create or replace function crm._copy_problems(p_text text)
returns jsonb language plpgsql immutable parallel safe set search_path = '' as $$
declare v jsonb := '[]'::jsonb; t text := lower(coalesce(p_text, '')); phrase text;
begin
  foreach phrase in array array['limited time', 'act now', 'only today', 'last chance', 'offer expires', 'hurry', 'don''t miss out', 'only a few spots',
                                'guaranteed results', '100% guarantee', 'we guarantee', 'risk-free', 'once in a lifetime'] loop
    if position(phrase in t) > 0 then v := v || to_jsonb('manufactured_urgency:' || phrase); end if;
  end loop;
  foreach phrase in array array['#1', 'number one', 'best in', 'world-class', 'award-winning', 'top-rated', 'industry-leading', 'market leader'] loop
    if position(phrase in t) > 0 then v := v || to_jsonb('unsupported_claim:' || phrase); end if;
  end loop;
  if t ~ '[0-9]+(\.[0-9]+)?\s*%' then v := v || to_jsonb('unverified_statistic'::text); end if;
  return v;
end;
$$;

create or replace function crm.landing_content_problems(p_content jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb := '[]'::jsonb;
  b jsonb; f jsonb; pr jsonb;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' then return '["content_is_not_an_object"]'::jsonb; end if;
  if length(coalesce(p_content ->> 'headline', '')) not between 5 and 90 then v := v || to_jsonb('headline_length'::text); end if;
  if length(coalesce(p_content ->> 'subheadline', '')) > 200 then v := v || to_jsonb('subheadline_too_long'::text); end if;
  if length(coalesce(p_content ->> 'cta_text', '')) not between 3 and 40 then v := v || to_jsonb('cta_text_length'::text); end if;
  if coalesce(p_content ->> 'privacy_url', '') !~ '^https://' then v := v || to_jsonb('needs_a_privacy_link'::text); end if;
  if coalesce(p_content ->> 'contact_email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v := v || to_jsonb('needs_a_contact_email'::text); end if;

  if jsonb_typeof(p_content -> 'benefits') <> 'array' or jsonb_array_length(p_content -> 'benefits') not between 3 and 6 then v := v || to_jsonb('benefits_count'::text); end if;
  for b in select e.value from jsonb_array_elements(case when jsonb_typeof(p_content -> 'benefits') = 'array' then p_content -> 'benefits' else '[]'::jsonb end) e loop
    if length(coalesce(b ->> 'title', '')) not between 3 and 80 or length(coalesce(b ->> 'text', '')) not between 10 and 200 then v := v || to_jsonb('benefit_length'::text); end if;
  end loop;
  if jsonb_typeof(p_content -> 'faq') = 'array' then
    if jsonb_array_length(p_content -> 'faq') > 8 then v := v || to_jsonb('too_many_faq'::text); end if;
    for f in select e.value from jsonb_array_elements(p_content -> 'faq') e loop
      if length(coalesce(f ->> 'q', '')) not between 5 and 160 or length(coalesce(f ->> 'a', '')) not between 5 and 500 then v := v || to_jsonb('faq_length'::text); end if;
    end loop;
  end if;
  -- Proof is a pointer to something the agency really did. A quote or a number with no source is how a page lies.
  if jsonb_typeof(p_content -> 'proof') = 'array' then
    for pr in select e.value from jsonb_array_elements(p_content -> 'proof') e loop
      if coalesce(pr ->> 'portfolio_item_id', '') !~* '^[0-9a-f-]{36}$' then v := v || to_jsonb('proof_without_a_source'::text); end if;
      if length(coalesce(pr ->> 'caption', '')) not between 5 and 200 then v := v || to_jsonb('proof_caption_length'::text); end if;
    end loop;
  end if;
  if p_content ? 'testimonials' or p_content ? 'reviews' or p_content ? 'logos' then v := v || to_jsonb('testimonials_are_not_supported'::text); end if;

  v := v || crm._copy_problems(p_content::text);
  return (select coalesce(jsonb_agg(distinct e.value), '[]'::jsonb) from jsonb_array_elements(v) e);
end;
$$;

-- ── 3. derived hash; frozen content; guarded state ─────────────────────────

create or replace function crm.landing_version_stamp()
returns trigger language plpgsql set search_path = '' as $$
declare p crm.landing_pages;
begin
  select * into p from crm.landing_pages x where x.id = new.page_id;
  new.content_hash := encode(sha256(convert_to(jsonb_build_object(
    'slug', p.slug, 'content', new.content, 'whatsapp', new.whatsapp_number, 'url', new.public_url, 'tracking', new.tracking)::text, 'UTF8')), 'hex');
  return new;
end;
$$;
drop trigger if exists landing_version_stamp on crm.landing_page_versions;
create trigger landing_version_stamp before insert on crm.landing_page_versions for each row execute function crm.landing_version_stamp();

create or replace function crm.landing_version_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a landing page version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.page_id, new.version, new.content, new.whatsapp_number, new.public_url, new.tracking, new.content_hash, new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.page_id, old.version, old.content, old.whatsapp_number, old.public_url, old.tracking, old.content_hash, old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a landing page version says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.landing_write', true), '') <> '1' then
      raise exception 'a version''s state moves only through the landing doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'         and new.state in ('CHECKED', 'CHECK_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECK_FAILED'  and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'CHECKED'       and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW'  and new.state in ('DEPLOYING', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'DEPLOYING'     and new.state in ('DEPLOYED', 'ADMIN_REVIEW'))
      or (old.state = 'DEPLOYED'      and new.state in ('VERIFIED', 'VERIFY_FAILED', 'SUPERSEDED', 'RETIRED'))
      or (old.state = 'VERIFY_FAILED' and new.state in ('VERIFIED', 'SUPERSEDED', 'RETIRED'))
      or (old.state = 'VERIFIED'      and new.state in ('VERIFY_FAILED', 'SUPERSEDED', 'RETIRED'))) then
      raise exception 'a % version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists landing_version_guard on crm.landing_page_versions;
create trigger landing_version_guard before update or delete on crm.landing_page_versions for each row execute function crm.landing_version_guard();

drop trigger if exists landing_deployments_immutable on crm.landing_deployments;
create trigger landing_deployments_immutable before update or delete on crm.landing_deployments for each row execute function crm.ad_history_only();
drop trigger if exists landing_verifications_immutable on crm.landing_verifications;
create trigger landing_verifications_immutable before update or delete on crm.landing_verifications for each row execute function crm.ad_history_only();

create or replace function crm.landing_page_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a landing page is history' using errcode = '42501'; end if;
  if (new.organization_id, new.slug, new.created_at) is distinct from (old.organization_id, old.slug, old.created_at) then
    raise exception 'a page''s address is fixed; make a new page' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists landing_page_guard on crm.landing_pages;
create trigger landing_page_guard before update or delete on crm.landing_pages for each row execute function crm.landing_page_guard();

-- tenancy, RLS, privileges
drop trigger if exists freeze_org_landing_pages on crm.landing_pages;
create trigger freeze_org_landing_pages before update of organization_id on crm.landing_pages for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_landing_pages_current on crm.landing_pages;
create trigger org_match_landing_pages_current before insert or update of current_version_id, organization_id on crm.landing_pages for each row execute function core.enforce_parent_org('current_version_id', 'crm.landing_page_versions');
drop trigger if exists org_match_landing_pages_live on crm.landing_pages;
create trigger org_match_landing_pages_live before insert or update of live_version_id, organization_id on crm.landing_pages for each row execute function core.enforce_parent_org('live_version_id', 'crm.landing_page_versions');
alter table crm.landing_pages enable row level security;
alter table crm.landing_pages force row level security;
drop policy if exists landing_pages_select on crm.landing_pages;
create policy landing_pages_select on crm.landing_pages for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.landing_pages from public, anon, authenticated;
grant select on crm.landing_pages to authenticated;
grant select, insert, update on crm.landing_pages to service_role;

drop trigger if exists freeze_org_landing_page_versions on crm.landing_page_versions;
create trigger freeze_org_landing_page_versions before update of organization_id on crm.landing_page_versions for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_landing_versions_page on crm.landing_page_versions;
create trigger org_match_landing_versions_page before insert or update of page_id, organization_id on crm.landing_page_versions for each row execute function core.enforce_parent_org('page_id', 'crm.landing_pages');
drop trigger if exists org_match_landing_versions_approval on crm.landing_page_versions;
create trigger org_match_landing_versions_approval before insert or update of approval_request_id, organization_id on crm.landing_page_versions for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
drop trigger if exists org_match_landing_versions_supersedes on crm.landing_page_versions;
create trigger org_match_landing_versions_supersedes before insert or update of supersedes_version_id, organization_id on crm.landing_page_versions for each row execute function core.enforce_parent_org('supersedes_version_id', 'crm.landing_page_versions');
alter table crm.landing_page_versions enable row level security;
alter table crm.landing_page_versions force row level security;
drop policy if exists landing_page_versions_select on crm.landing_page_versions;
create policy landing_page_versions_select on crm.landing_page_versions for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.landing_page_versions from public, anon, authenticated;
grant select on crm.landing_page_versions to authenticated;
grant select, insert, update on crm.landing_page_versions to service_role;

drop trigger if exists freeze_org_landing_deployments on crm.landing_deployments;
create trigger freeze_org_landing_deployments before update of organization_id on crm.landing_deployments for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_landing_deployments_version on crm.landing_deployments;
create trigger org_match_landing_deployments_version before insert or update of version_id, organization_id on crm.landing_deployments for each row execute function core.enforce_parent_org('version_id', 'crm.landing_page_versions');
drop trigger if exists org_match_landing_deployments_execution on crm.landing_deployments;
create trigger org_match_landing_deployments_execution before insert or update of execution_id, organization_id on crm.landing_deployments for each row execute function core.enforce_parent_org('execution_id', 'crm.governed_executions');
alter table crm.landing_deployments enable row level security;
alter table crm.landing_deployments force row level security;
drop policy if exists landing_deployments_select on crm.landing_deployments;
create policy landing_deployments_select on crm.landing_deployments for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.landing_deployments from public, anon, authenticated;
grant select on crm.landing_deployments to authenticated;
grant select, insert on crm.landing_deployments to service_role;

drop trigger if exists freeze_org_landing_verifications on crm.landing_verifications;
create trigger freeze_org_landing_verifications before update of organization_id on crm.landing_verifications for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_landing_verifications_deployment on crm.landing_verifications;
create trigger org_match_landing_verifications_deployment before insert or update of deployment_id, organization_id on crm.landing_verifications for each row execute function core.enforce_parent_org('deployment_id', 'crm.landing_deployments');
alter table crm.landing_verifications enable row level security;
alter table crm.landing_verifications force row level security;
drop policy if exists landing_verifications_select on crm.landing_verifications;
create policy landing_verifications_select on crm.landing_verifications for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.landing_verifications from public, anon, authenticated;
grant select on crm.landing_verifications to authenticated;
grant select, insert on crm.landing_verifications to service_role;

-- ── 4. doors ───────────────────────────────────────────────────────────────

create or replace function crm._landing_set_state(p_version uuid, p_state text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform set_config('crm.landing_write', '1', true);
  update crm.landing_page_versions set state = p_state where id = p_version;
  perform set_config('crm.landing_write', '', true);
end;
$$;
revoke all on function crm._landing_set_state(uuid, text) from public, anon, authenticated;

create or replace function crm.create_landing_page(p_organization_id uuid, p_name text, p_slug text, p_target_service text default null)
returns table (outcome text, page_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  insert into crm.landing_pages (organization_id, name, slug, target_service, created_by)
  values (p_organization_id, btrim(p_name), lower(btrim(p_slug)), nullif(btrim(coalesce(p_target_service, '')), ''), (select auth.uid())) returning id into v_id;
  perform core.record_audit(p_organization_id, 'landing.page_created', 'landing_page', v_id, null, jsonb_build_object('slug', lower(btrim(p_slug))));
  return query select 'created'::text, v_id;
exception
  when unique_violation then return query select 'slug_taken'::text, null::uuid;
  when check_violation then return query select 'invalid'::text, null::uuid;
end;
$$;
revoke all on function crm.create_landing_page(uuid, text, text, text) from public, anon;
grant execute on function crm.create_landing_page(uuid, text, text, text) to authenticated, service_role;

-- The WhatsApp number a page uses is the organisation's tracked-handoff business number AT THE TIME OF THE VERSION, and is part of
-- what is approved: changing the number later makes a new version, never a silent change to a deployed page.
create or replace function crm.add_landing_version(p_organization_id uuid, p_page uuid, p_content jsonb, p_public_url text, p_by_type text default 'human')
returns table (outcome text, version_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare pg crm.landing_pages; v_num text; v_n integer; v_id uuid; r record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_by_type not in ('human', 'agent', 'rule') then return query select 'invalid'::text, null::uuid; return; end if;
  select * into pg from crm.landing_pages x where x.id = p_page and x.organization_id = p_organization_id for update;
  if pg.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if pg.status = 'retired' then return query select 'page_retired'::text, null::uuid; return; end if;
  select s.business_number into v_num from crm.whatsapp_handoff_settings s where s.organization_id = p_organization_id;
  if v_num is null then return query select 'no_whatsapp_number'::text, null::uuid; return; end if;
  if exists (select 1 from crm.landing_page_versions v where v.page_id = pg.id and v.state = 'DEPLOYING') then
    return query select 'deploy_in_progress'::text, null::uuid; return;
  end if;
  for r in select v.id, v.approval_request_id from crm.landing_page_versions v where v.page_id = pg.id and v.state in ('DRAFT', 'CHECKED', 'CHECK_FAILED', 'ADMIN_REVIEW') loop
    if r.approval_request_id is not null then perform approvals.cancel_request(r.approval_request_id, 'a newer version of the page replaced it'); end if;
    perform crm._landing_set_state(r.id, 'SUPERSEDED');
  end loop;
  select coalesce(max(v.version), 0) + 1 into v_n from crm.landing_page_versions v where v.page_id = pg.id;
  insert into crm.landing_page_versions (organization_id, page_id, version, content, whatsapp_number, public_url, supersedes_version_id, created_by_type, created_by)
  values (p_organization_id, pg.id, v_n, p_content, v_num, p_public_url, (select v.id from crm.landing_page_versions v where v.page_id = pg.id order by v.version desc limit 1), p_by_type, (select auth.uid()))
  returning id into v_id;
  update crm.landing_pages set current_version_id = v_id where id = pg.id;
  perform core.record_audit(p_organization_id, 'landing.version_added', 'landing_page', pg.id, null, jsonb_build_object('version', v_n));
  return query select 'added'::text, v_id;
exception when check_violation or not_null_violation then return query select 'invalid'::text, null::uuid;
end;
$$;
revoke all on function crm.add_landing_version(uuid, uuid, jsonb, text, text) from public, anon;
grant execute on function crm.add_landing_version(uuid, uuid, jsonb, text, text) to authenticated, service_role;

create or replace function crm.check_landing_version(p_organization_id uuid, p_version uuid)
returns table (outcome text, problems jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.landing_page_versions; p jsonb; pr jsonb;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::jsonb; return; end if;
  select * into v from crm.landing_page_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::jsonb; return; end if;
  if v.state not in ('DRAFT', 'CHECK_FAILED') then return query select 'wrong_state'::text, null::jsonb; return; end if;
  p := crm.landing_content_problems(v.content);
  -- Every proof item must be one of THIS agency's own, active portfolio items.
  if jsonb_typeof(v.content -> 'proof') = 'array' then
    for pr in select e.value from jsonb_array_elements(v.content -> 'proof') e loop
      if coalesce(pr ->> 'portfolio_item_id', '') ~* '^[0-9a-f-]{36}$' and not exists (
           select 1 from crm.portfolio_items i where i.organization_id = p_organization_id and i.is_active and i.id::text = lower(pr ->> 'portfolio_item_id')) then
        p := p || to_jsonb('proof_is_not_a_portfolio_item'::text);
      end if;
    end loop;
  end if;
  p := (select coalesce(jsonb_agg(distinct e.value), '[]'::jsonb) from jsonb_array_elements(p) e);
  perform set_config('crm.landing_write', '1', true);
  update crm.landing_page_versions set state = case when jsonb_array_length(p) = 0 then 'CHECKED' else 'CHECK_FAILED' end,
         review = jsonb_build_object('problems', p, 'checked_at', now()) where id = v.id;
  perform set_config('crm.landing_write', '', true);
  return query select case when jsonb_array_length(p) = 0 then 'checked' else 'check_failed' end::text, p;
end;
$$;
revoke all on function crm.check_landing_version(uuid, uuid) from public, anon;
grant execute on function crm.check_landing_version(uuid, uuid) to authenticated, service_role;

create or replace function crm.submit_landing_version(p_organization_id uuid, p_version uuid)
returns table (outcome text, approval_request_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.landing_page_versions; pg crm.landing_pages; b record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v from crm.landing_page_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v.state <> 'CHECKED' then return query select 'not_checked'::text, null::uuid; return; end if;
  select * into pg from crm.landing_pages x where x.id = v.page_id;
  select * into b from crm.bind_approval(p_organization_id, 'acquisition_action', v.id, v.version, v.content_hash,
    left('Deploy landing page · ' || pg.name || ' · ' || v.public_url || ' · ' || coalesce(v.content ->> 'headline', ''), 480), null, 'system', null, 168);
  if b.outcome not in ('requested', 'already_pending') then return query select b.outcome::text, null::uuid; return; end if;
  perform set_config('crm.landing_write', '1', true);
  update crm.landing_page_versions set state = 'ADMIN_REVIEW', approval_request_id = b.request_id where id = v.id;
  perform set_config('crm.landing_write', '', true);
  perform core.record_audit(p_organization_id, 'landing.submitted_for_approval', 'landing_page', pg.id, null, jsonb_build_object('version', v.version, 'approval_request_id', b.request_id, 'hash', v.content_hash));
  return query select 'submitted'::text, b.request_id;
end;
$$;
revoke all on function crm.submit_landing_version(uuid, uuid) from public, anon;
grant execute on function crm.submit_landing_version(uuid, uuid) to authenticated, service_role;

create or replace function crm.begin_landing_deploy(p_organization_id uuid, p_version uuid, p_correlation_id uuid default null)
returns table (outcome text, reason text, execution_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.landing_page_versions; d record; g record;
begin
  select * into v from crm.landing_page_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state in ('DEPLOYED', 'VERIFIED', 'VERIFY_FAILED') then return query select 'already_deployed'::text, null::text, null::uuid; return; end if;
  if v.state not in ('ADMIN_REVIEW', 'DEPLOYING') then return query select 'not_approved_state'::text, v.state, null::uuid; return; end if;
  select * into d from crm.acquisition_decide(p_organization_id, 'landing_page_deploy', null, 0, 1, p_correlation_id);
  if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;
  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'acquisition_action', v.id, v.content_hash, 'landing_page_deploy', null, p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'ADMIN_REVIEW' then perform crm._landing_set_state(v.id, 'DEPLOYING'); end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$$;
revoke all on function crm.begin_landing_deploy(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function crm.begin_landing_deploy(uuid, uuid, uuid) to service_role;

create or replace function crm.record_landing_deploy(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_deployed_url text, p_html_hash text, p_evidence jsonb default '{}')
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.landing_page_versions; f record; prev uuid;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.landing_page_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'DEPLOYING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and (coalesce(p_deployed_url, '') !~ '^https://' or coalesce(p_html_hash, '') !~ '^[0-9a-f]{64}$') then return query select 'needs_evidence'::text; return; end if;
  -- The host may serve only the address that was approved.
  if p_status = 'executed' and p_deployed_url <> v.public_url then return query select 'url_differs_from_approved'::text; return; end if;
  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_deployed_url, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;
  if p_status = 'executed' then
    for prev in select x.id from crm.landing_page_versions x where x.page_id = v.page_id and x.state in ('DEPLOYED', 'VERIFIED', 'VERIFY_FAILED') and x.id <> v.id loop
      perform crm._landing_set_state(prev, 'SUPERSEDED');
    end loop;
    insert into crm.landing_deployments (organization_id, version_id, execution_id, deployed_url, deployed_html_hash) values (p_organization_id, v.id, p_execution, p_deployed_url, p_html_hash);
    perform crm._landing_set_state(v.id, 'DEPLOYED');
    update crm.landing_pages set status = 'active', live_version_id = v.id where id = v.page_id;
    perform crm.record_acquisition_usage(p_organization_id, 'google_ads', 'action', 1, 'landing-deploy:' || v.id::text);
  elsif p_status = 'failed' then
    perform crm._landing_set_state(v.id, 'ADMIN_REVIEW');
  end if;
  perform core.record_audit(p_organization_id, 'landing.deploy_' || p_status, 'landing_page', v.page_id, null, jsonb_build_object('version', v.version));
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_landing_deploy(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function crm.record_landing_deploy(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

-- VERIFIED is a separate claim from DEPLOYED: it records what was FOUND at the public address.
create or replace function crm.record_landing_verification(p_organization_id uuid, p_version uuid, p_checks jsonb)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.landing_page_versions; d crm.landing_deployments; k text; v_pass boolean := true;
begin
  select * into v from crm.landing_page_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state not in ('DEPLOYED', 'VERIFY_FAILED', 'VERIFIED') then return query select 'not_deployed'::text; return; end if;
  if p_checks is null or jsonb_typeof(p_checks) <> 'object' then return query select 'invalid'::text; return; end if;
  select * into d from crm.landing_deployments x where x.version_id = v.id;
  foreach k in array array['reachable', 'carries_approved_version', 'links_to_approved_whatsapp', 'captures_tracking'] loop
    if jsonb_typeof(p_checks -> k) is distinct from 'boolean' then return query select 'invalid'::text; return; end if;
    if (p_checks ->> k)::boolean is not true then v_pass := false; end if;
  end loop;
  insert into crm.landing_verifications (organization_id, deployment_id, checks, passed) values (p_organization_id, d.id, p_checks, v_pass);
  if v_pass and v.state <> 'VERIFIED' then perform crm._landing_set_state(v.id, 'VERIFIED');
  elsif not v_pass and v.state <> 'VERIFY_FAILED' then perform crm._landing_set_state(v.id, 'VERIFY_FAILED'); end if;
  perform core.record_audit(p_organization_id, case when v_pass then 'landing.verified' else 'landing.verification_failed' end, 'landing_page', v.page_id, null, jsonb_build_object('version', v.version, 'checks', p_checks));
  return query select case when v_pass then 'verified' else 'failed' end::text;
end;
$$;
revoke all on function crm.record_landing_verification(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function crm.record_landing_verification(uuid, uuid, jsonb) to service_role;

create or replace function crm.retire_landing_page(p_organization_id uuid, p_page uuid, p_reason text)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare pg crm.landing_pages;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return query select 'needs_reason'::text; return; end if;
  select * into pg from crm.landing_pages x where x.id = p_page and x.organization_id = p_organization_id for update;
  if pg.id is null then return query select 'not_found'::text; return; end if;
  if pg.status = 'retired' then return query select 'already_retired'::text; return; end if;
  if pg.live_version_id is not null then
    perform crm._landing_set_state(pg.live_version_id, 'RETIRED');
  end if;
  update crm.landing_pages set status = 'retired', live_version_id = null where id = pg.id;
  perform core.record_audit(p_organization_id, 'landing.page_retired', 'landing_page', pg.id, null, jsonb_build_object('reason', left(p_reason, 300)));
  return query select 'retired'::text;
end;
$$;
revoke all on function crm.retire_landing_page(uuid, uuid, text) from public, anon;
grant execute on function crm.retire_landing_page(uuid, uuid, text) to authenticated, service_role;

create or replace function crm.sync_landing_approvals(p_limit integer default 200)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select v.id from crm.landing_page_versions v join approvals.approval_requests a on a.id = v.approval_request_id
            where v.state = 'ADMIN_REVIEW' and a.state in ('rejected', 'expired', 'cancelled', 'changes_requested')
            order by v.state_changed_at limit greatest(1, least(coalesce(p_limit, 200), 1000)) for update of v skip locked loop
    perform crm._landing_set_state(r.id, 'REJECTED');
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function crm.sync_landing_approvals(integer) from public, anon, authenticated;
grant execute on function crm.sync_landing_approvals(integer) to service_role;

-- ── 5. a visit that becomes a WhatsApp message stays attributable ──────────
-- The page's button prefills "LP-<first 8 characters of the version id>-<the ad campaign id>". This door reads the tag out of the message
-- ITSELF (never trusting a caller to have parsed it), and adds a touchpoint. It cannot change a lead. A tag is a claim: forging one only
-- adds a touchpoint to the lead whose own message carried it.

create or replace function crm.record_landing_arrival(p_organization_id uuid, p_lead uuid, p_message text, p_message_at timestamptz default null)
returns table (outcome text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  m text[]; v_ver crm.landing_page_versions; v_n integer; v_at timestamptz; v_first timestamptz; v_other boolean;
begin
  m := regexp_match(coalesce(p_message, ''), 'LP-([0-9a-f]{8})-([A-Za-z0-9_]{1,40})');
  if m is null then return query select 'no_tag'::text; return; end if;
  if not exists (select 1 from crm.leads l where l.id = p_lead and l.organization_id = p_organization_id) then return query select 'unknown_lead'::text; return; end if;
  select count(*) into v_n from crm.landing_page_versions v where v.organization_id = p_organization_id and left(v.id::text, 8) = m[1] and v.state in ('DEPLOYED', 'VERIFIED', 'VERIFY_FAILED', 'SUPERSEDED', 'RETIRED');
  if v_n <> 1 then return query select case when v_n = 0 then 'unknown_landing' else 'ambiguous_landing' end::text; return; end if;
  select * into v_ver from crm.landing_page_versions v where v.organization_id = p_organization_id and left(v.id::text, 8) = m[1] and v.state in ('DEPLOYED', 'VERIFIED', 'VERIFY_FAILED', 'SUPERSEDED', 'RETIRED');

  select min(t.occurred_at), bool_or(t.channel <> 'whatsapp') into v_first, v_other from crm.lead_touchpoints t where t.lead_id = p_lead;
  -- If the only touches so far are the WhatsApp ones this message created, the visit came BEFORE them: it is the first touch.
  v_at := case when v_other is not true and v_first is not null then v_first - interval '1 second' else coalesce(p_message_at, now()) end;
  perform crm.record_touchpoint(p_organization_id, p_lead, 'google_ads', 'google', 'ad_click',
    jsonb_build_object('campaign_id', m[2], 'landing_page_version_id', v_ver.id, 'source', 'landing_page'),
    jsonb_build_object('utm_campaign', m[2]), 'landing:' || p_lead::text, v_at);
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_landing_arrival(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function crm.record_landing_arrival(uuid, uuid, text, timestamptz) to service_role;

-- ── 6. a Google ad may only point at a page that is deployed AND verified ──
-- crm.check_ad_version and crm.begin_ad_apply, carried forward from 20261020100000 with ONE edit each.

create or replace function crm.check_ad_version(p_organization_id uuid, p_version uuid)
returns table (outcome text, problems jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; p jsonb;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::jsonb; return; end if;
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::jsonb; return; end if;
  if v.state not in ('DRAFT', 'CHECK_FAILED') then return query select 'wrong_state'::text, null::jsonb; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id;
  p := crm.ad_plan_problems(c.platform, v.plan);
  if c.platform = 'google_ads' and not exists (
       select 1 from crm.landing_page_versions lv
        where lv.organization_id = p_organization_id and lv.id::text = (v.plan #>> '{destination,landing_page_version_id}') and lv.state = 'VERIFIED') then
    p := p || to_jsonb('landing_page_not_verified'::text);
  end if;
  -- A check can fail a plan; it never approves one. CHECKED only means "no machine-detectable problem" - a person still decides.
  perform set_config('crm.ad_write', '1', true);
  update crm.ad_campaign_versions set state = case when jsonb_array_length(p) = 0 then 'CHECKED' else 'CHECK_FAILED' end,
         review = jsonb_build_object('problems', p, 'checked_at', now()) where id = v.id;
  perform set_config('crm.ad_write', '', true);
  return query select case when jsonb_array_length(p) = 0 then 'checked' else 'check_failed' end::text, p;
end;
$$;
revoke all on function crm.check_ad_version(uuid, uuid) from public, anon;
grant execute on function crm.check_ad_version(uuid, uuid) to authenticated, service_role;

create or replace function crm.begin_ad_apply(p_organization_id uuid, p_version uuid, p_correlation_id uuid default null)
returns table (outcome text, reason text, execution_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare v crm.ad_campaign_versions; c crm.ad_campaigns; d record; g record;
begin
  select * into v from crm.ad_campaign_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state in ('LIVE', 'PAUSED') then return query select 'already_applied'::text, null::text, null::uuid; return; end if;
  if v.state not in ('ADMIN_REVIEW', 'LAUNCHING') then return query select 'not_approved_state'::text, v.state, null::uuid; return; end if;
  select * into c from crm.ad_campaigns x where x.id = v.campaign_id;
  -- A Google ad may only point at a landing page that is deployed AND verified, read NOW.
  if c.platform = 'google_ads' and not exists (
       select 1 from crm.landing_page_versions lv
        where lv.organization_id = p_organization_id and lv.id::text = (v.plan #>> '{destination,landing_page_version_id}') and lv.state = 'VERIFIED') then
    return query select 'blocked'::text, 'landing_page_not_verified'::text, null::uuid; return;
  end if;

  -- The connector, the cap and the stops are asked NOW, with the money this change adds. Approval is satisfied by the exact-version check
  -- below; only BLOCK refuses here.
  select * into d from crm.acquisition_decide(p_organization_id, crm._ad_action(v.change_kind), c.platform, v.change_amount_minor, 1, p_correlation_id);
  if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;

  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'ad_campaign', v.id, v.content_hash,
                                                    crm._ad_action(v.change_kind), c.platform, p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'ADMIN_REVIEW' then perform crm._ad_set_state(v.id, 'LAUNCHING'); end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$$;
revoke all on function crm.begin_ad_apply(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function crm.begin_ad_apply(uuid, uuid, uuid) to service_role;
notify pgrst, 'reload schema';
