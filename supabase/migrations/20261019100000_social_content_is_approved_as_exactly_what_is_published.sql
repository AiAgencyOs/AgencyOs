-- ═══════════════════════════════════════════════════════════════════════════
-- Lead generation, slice 7 — Social content is approved as EXACTLY what is
-- published, and it is published once.
--
-- Spec §5, §79, §109, §112-§115, §210. The hard gate is
--   DRAFT -> AI REVIEW -> ADMIN REVIEW -> APPROVED -> SCHEDULED -> PUBLISHED
-- and it is tied to the exact content: approve version 1, change it to version
-- 2, and version 1's approval must not publish version 2; replay the publish
-- job and nothing is posted twice.
--
-- Slice 4 built the primitives (a SHA-256 binding, a validity window, one
-- governed execution per approval, pause re-read at execution time). This
-- slice is the first thing that USES them end to end, so the design is mostly a
-- series of decisions about what must NOT be possible:
--
--  1. THERE IS NO EDIT. A content version's words, call to action, hashtags and
--     assets are frozen the moment it exists, and its hash is computed by a
--     trigger from those fields - a caller cannot supply or forge one. Changing
--     anything creates the NEXT version, which is a different artifact with a
--     different hash and its own approval; the earlier version is superseded
--     and any approval still pending on it is withdrawn. "Material change
--     requires re-approval" is therefore not a judgement made case by case: no
--     change is non-material.
--
--  2. "AI REVIEW PASSED" AND "ADMIN APPROVED" ARE DIFFERENT THINGS (spec §115).
--     The automated quality review is deterministic rules (length per platform,
--     a call to action where the objective needs one, assets where the format
--     needs them, unsupported superlatives and statistics, manufactured
--     urgency, copying a reference, repeating a recent post). It can FAIL a
--     draft; it can never APPROVE one. Only the approval engine approves, and
--     APPROVED is DERIVED from it (crm.content_status), not stored, so it
--     cannot drift from the decision it reports.
--
--  3. PUBLISHING IS THE GOVERNED EXECUTION DOOR AND NOTHING ELSE. The only way
--     a version reaches PUBLISHING is crm.begin_content_publish, which re-reads
--     the pause state, the connector, the limits, the approval and the content
--     hash at that moment and reserves one execution per approval. A failed
--     attempt returns to SCHEDULED for the governed retry; an uncertain one
--     stays PUBLISHING and must be reconciled with the provider, never
--     re-posted.
--
--  4. REFERENCES INSPIRE; THEY ARE NOT COPY (spec §112). A reference is
--     recorded with its text, and a draft that reproduces a run of ten
--     consecutive words from one fails the review.
--
-- What is NOT here: any call to LinkedIn, Instagram or Facebook (no adapter
-- exists; publication results arrive through crm.record_publish from whatever
-- adapter is written later), and the AI that writes and plans. This is the
-- gate they will have to pass through.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. audits, strategies, references, assets ──────────────────────────────

create table if not exists crm.social_audits (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  platform         text not null check (platform in ('linkedin', 'instagram', 'facebook')),
  source           text not null check (source in ('adapter', 'assisted')),
  integration_id   uuid references crm.acquisition_integrations(id) on delete set null,
  summary          jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object' and octet_length(summary::text) <= 20000),
  findings         jsonb not null default '{}'::jsonb check (jsonb_typeof(findings) = 'object' and octet_length(findings::text) <= 20000),
  taken_at         timestamptz not null default now(),
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
comment on table crm.social_audits is
  'A snapshot of an account (spec §5): what is there, what works, what is missing. source says honestly whether a provider adapter read it or a person entered it (assisted) - an audit is only as good as the capability behind it. Append-only.';

create table if not exists crm.social_strategies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  platform         text not null check (platform in ('linkedin', 'instagram', 'facebook')),
  horizon_months   integer not null check (horizon_months in (3, 6, 9)),
  version          integer not null check (version >= 1),
  content          jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 40000),
  rationale        text check (rationale is null or length(rationale) <= 4000),
  evidence_audit_id uuid references crm.social_audits(id) on delete set null,
  status           text not null default 'draft' check (status in ('draft', 'active', 'superseded')),
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  activated_at     timestamptz,
  unique (organization_id, platform, horizon_months, version)
);
create unique index if not exists social_strategies_one_active on crm.social_strategies (organization_id, platform, horizon_months) where status = 'active';
comment on table crm.social_strategies is
  'A 3, 6 or 9 month strategy for ONE platform (spec §5), versioned (spec §177): a revision is the next version, never an overwrite. Activating one supersedes the previous active one. Its content is frozen.';

create table if not exists crm.content_references (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  kind             text not null check (kind in ('post_link', 'screenshot', 'copy_example', 'competitor_content', 'image')),
  url              text check (url is null or (length(url) <= 500 and url ~* '^https?://')),
  text_excerpt     text check (text_excerpt is null or length(text_excerpt) <= 6000),
  note             text check (note is null or length(note) <= 1000),
  analysis         jsonb not null default '{}'::jsonb check (jsonb_typeof(analysis) = 'object'),
  added_by_type    text not null check (added_by_type in ('human', 'agent')),
  added_by         uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint content_references_has_something check (url is not null or text_excerpt is not null or note is not null)
);
comment on table crm.content_references is
  'Inspiration the Admin supplies (spec §112): a link, a screenshot, a competitor post. It is analysed, never copied: a draft that reproduces ten consecutive words of a reference fails its review.';

create table if not exists crm.content_assets (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  kind             text not null check (kind in ('image', 'carousel_slide', 'infographic', 'video', 'audio', 'captions')),
  storage_ref      text not null check (length(storage_ref) between 3 and 500),
  generation_method text not null check (generation_method in ('upload', 'ai_generated', 'designed')),
  dimensions       jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions) = 'object'),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
comment on table crm.content_assets is
  'A media file a post uses (spec §113). Its hash is part of every version that uses it, so changing the image makes a new version that needs a new approval; an asset used by a published version is never overwritten. Append-only.';

-- ── 2. content: items and immutable versions ───────────────────────────────

create table if not exists crm.content_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  platform         text not null check (platform in ('linkedin', 'instagram', 'facebook')),
  objective        text not null check (objective in ('authority', 'reach', 'engagement', 'education', 'portfolio_proof', 'lead_generation')),
  format           text not null check (format in ('text', 'image', 'carousel', 'infographic', 'video', 'case_study', 'portfolio')),
  strategy_id      uuid references crm.social_strategies(id) on delete set null,
  target_service   text check (target_service is null or length(target_service) between 2 and 80),
  title            text not null check (length(btrim(title)) between 3 and 160),
  current_version_id uuid,
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
comment on table crm.content_items is 'One piece of content and the objective it exists for (spec §5): authority, reach, engagement, education, portfolio proof or lead generation. Its words live only in immutable versions.';

create table if not exists crm.content_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  item_id          uuid not null references crm.content_items(id) on delete restrict,
  version          integer not null check (version >= 1),
  body             text not null check (length(btrim(body)) between 1 and 12000),
  cta              text check (cta is null or length(cta) <= 500),
  hashtags         text[] not null default '{}' check (cardinality(hashtags) <= 30),
  asset_ids        uuid[] not null default '{}' check (cardinality(asset_ids) <= 20),
  reference_ids    uuid[] not null default '{}' check (cardinality(reference_ids) <= 20),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  state            text not null default 'DRAFT' check (state in ('DRAFT', 'AI_REVIEWED', 'AI_REVIEW_FAILED', 'ADMIN_REVIEW', 'REJECTED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'SUPERSEDED', 'CANCELLED')),
  review           jsonb check (review is null or jsonb_typeof(review) = 'object'),
  approval_request_id uuid references approvals.approval_requests(id) on delete set null,
  scheduled_for    timestamptz,
  supersedes_version_id uuid references crm.content_versions(id) on delete set null,
  created_by_type  text not null check (created_by_type in ('human', 'agent', 'rule')),
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (item_id, version)
);
create index if not exists content_versions_org_state_idx on crm.content_versions (organization_id, state, created_at desc);
create index if not exists content_versions_scheduled_idx on crm.content_versions (scheduled_for) where state = 'SCHEDULED';
comment on table crm.content_versions is
  'One immutable version of a piece of content. Words, call to action, hashtags, assets and references are frozen at creation and the hash is computed here, never supplied; only the workflow state moves, and only through the doors. APPROVED is not a stored state: it is derived from the approval engine (crm.content_status).';

alter table crm.content_items drop constraint if exists content_items_current_version_fk;
alter table crm.content_items add constraint content_items_current_version_fk
  foreign key (current_version_id) references crm.content_versions(id) on delete set null deferrable initially deferred;

-- The hash is the identity of what a person approves. Computed from the content AND the item's platform, objective and format,
-- and from each asset's own hash, so changing any of them is a different artifact.
create or replace function crm.content_version_hash(p_item uuid, p_body text, p_cta text, p_hashtags text[], p_asset_ids uuid[])
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'platform', i.platform, 'objective', i.objective, 'format', i.format,
    'body', p_body, 'cta', coalesce(p_cta, ''), 'hashtags', to_jsonb(coalesce(p_hashtags, '{}'::text[])),
    'assets', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'hash', a.content_hash) order by a.id)
                          from crm.content_assets a where a.id = any (coalesce(p_asset_ids, '{}'::uuid[]))), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
  from crm.content_items i where i.id = p_item;
$$;
revoke all on function crm.content_version_hash(uuid, text, text, text[], uuid[]) from public, anon, authenticated;

create or replace function crm.content_version_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_missing integer;
begin
  -- Assets must exist and belong to this organisation: a version cannot lean on another tenant's media.
  select count(*) into v_missing from unnest(new.asset_ids) as x(id)
   where not exists (select 1 from crm.content_assets a where a.id = x.id and a.organization_id = new.organization_id);
  if v_missing > 0 then raise exception 'a version may only use this organisation''s assets' using errcode = '23503'; end if;
  select count(*) into v_missing from unnest(new.reference_ids) as x(id)
   where not exists (select 1 from crm.content_references r where r.id = x.id and r.organization_id = new.organization_id);
  if v_missing > 0 then raise exception 'a version may only cite this organisation''s references' using errcode = '23503'; end if;
  -- Whatever a caller put in the column is discarded: the hash is derived, so it cannot be forged.
  new.content_hash := crm.content_version_hash(new.item_id, new.body, new.cta, new.hashtags, new.asset_ids);
  return new;
end;
$$;
drop trigger if exists content_version_stamp on crm.content_versions;
create trigger content_version_stamp before insert on crm.content_versions for each row execute function crm.content_version_stamp();

create or replace function crm.content_version_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'a content version is history; cancel it instead' using errcode = '42501'; end if;
  if (new.id, new.organization_id, new.item_id, new.version, new.body, new.cta, new.hashtags, new.asset_ids, new.reference_ids, new.content_hash,
      new.created_by_type, new.created_by, new.created_at)
     is distinct from
     (old.id, old.organization_id, old.item_id, old.version, old.body, old.cta, old.hashtags, old.asset_ids, old.reference_ids, old.content_hash,
      old.created_by_type, old.created_by, old.created_at) then
    raise exception 'what a version says is frozen; make the next version' using errcode = '42501';
  end if;
  if new.state is distinct from old.state then
    if coalesce(current_setting('crm.content_write', true), '') <> '1' then
      raise exception 'a version''s state moves only through the content doors' using errcode = '42501';
    end if;
    if not (
         (old.state = 'DRAFT'            and new.state in ('AI_REVIEWED', 'AI_REVIEW_FAILED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'AI_REVIEW_FAILED' and new.state in ('SUPERSEDED', 'CANCELLED'))
      or (old.state = 'AI_REVIEWED'      and new.state in ('ADMIN_REVIEW', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'ADMIN_REVIEW'     and new.state in ('SCHEDULED', 'REJECTED', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'SCHEDULED'        and new.state in ('PUBLISHING', 'SUPERSEDED', 'CANCELLED'))
      or (old.state = 'PUBLISHING'       and new.state in ('PUBLISHED', 'SCHEDULED'))) then
      raise exception 'a % version cannot become %', old.state, new.state using errcode = '23514';
    end if;
    new.state_changed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists content_version_guard on crm.content_versions;
create trigger content_version_guard before update or delete on crm.content_versions for each row execute function crm.content_version_guard();

create table if not exists crm.social_publications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  version_id       uuid not null references crm.content_versions(id) on delete restrict,
  execution_id     uuid not null references crm.governed_executions(id) on delete restrict,
  platform         text not null check (platform in ('linkedin', 'instagram', 'facebook')),
  external_ref     text not null check (length(external_ref) between 1 and 300),
  url              text check (url is null or (length(url) <= 500 and url ~* '^https?://')),
  published_at     timestamptz not null default now(),
  -- A version is published ONCE. This is a second line of defence behind the one-execution-per-approval rule.
  unique (version_id),
  unique (organization_id, platform, external_ref)
);
comment on table crm.social_publications is 'The record that a version was posted, with the provider''s reference. One per version, ever. Append-only.';

create table if not exists crm.social_metrics (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  publication_id   uuid not null references crm.social_publications(id) on delete cascade,
  -- clock_timestamp, not now(): two readings in one transaction must still have an order (the LATEST one is what performance reads).
  collected_at     timestamptz not null default clock_timestamp(),
  impressions      bigint check (impressions is null or impressions >= 0),
  reach            bigint check (reach is null or reach >= 0),
  engagements      bigint check (engagements is null or engagements >= 0),
  clicks           bigint check (clicks is null or clicks >= 0),
  profile_visits   bigint check (profile_visits is null or profile_visits >= 0)
);
create index if not exists social_metrics_pub_idx on crm.social_metrics (publication_id, collected_at desc);
comment on table crm.social_metrics is
  'Provider-reported reach and engagement over time, append-only. These are DIAGNOSTIC (spec §181): success is qualified conversations and won clients, which come from the lead records, never from this table.';

-- ── tenancy, privileges, history ───────────────────────────────────────────

create or replace function crm.social_history_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'this record is history; add a new one instead' using errcode = '42501';
end;
$$;
drop trigger if exists social_audits_immutable on crm.social_audits;
create trigger social_audits_immutable before update or delete on crm.social_audits for each row execute function crm.social_history_only();
drop trigger if exists content_references_immutable on crm.content_references;
create trigger content_references_immutable before update or delete on crm.content_references for each row execute function crm.social_history_only();
drop trigger if exists content_assets_immutable on crm.content_assets;
create trigger content_assets_immutable before update or delete on crm.content_assets for each row execute function crm.social_history_only();
drop trigger if exists social_publications_immutable on crm.social_publications;
create trigger social_publications_immutable before update or delete on crm.social_publications for each row execute function crm.social_history_only();
drop trigger if exists social_metrics_immutable on crm.social_metrics;
create trigger social_metrics_immutable before update or delete on crm.social_metrics for each row execute function crm.social_history_only();

create or replace function crm.social_strategy_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a strategy is history; supersede it instead' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.horizon_months, new.version, new.content, new.rationale, new.evidence_audit_id, new.created_by_type, new.created_at)
     is distinct from (old.organization_id, old.platform, old.horizon_months, old.version, old.content, old.rationale, old.evidence_audit_id, old.created_by_type, old.created_at) then
    raise exception 'a strategy''s content is frozen; make the next version' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not ((old.status = 'draft' and new.status = 'active') or (old.status = 'active' and new.status = 'superseded') or (old.status = 'draft' and new.status = 'superseded')) then
    raise exception 'a % strategy cannot become %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists social_strategy_guard on crm.social_strategies;
create trigger social_strategy_guard before update or delete on crm.social_strategies for each row execute function crm.social_strategy_guard();

create or replace function crm.content_item_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a content item is history' using errcode = '42501'; end if;
  if (new.organization_id, new.platform, new.objective, new.format, new.title, new.created_at) is distinct from (old.organization_id, old.platform, old.objective, old.format, old.title, old.created_at) then
    raise exception 'what an item is for is fixed; make a new item' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists content_item_guard on crm.content_items;
create trigger content_item_guard before update or delete on crm.content_items for each row execute function crm.content_item_guard();

-- freeze + parent guards + RLS + privileges, per table (written out so the scanners and a reader can see each)
drop trigger if exists freeze_org_social_audits on crm.social_audits;
create trigger freeze_org_social_audits before update of organization_id on crm.social_audits for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_social_audits_integration on crm.social_audits;
create trigger org_match_social_audits_integration before insert or update of integration_id, organization_id on crm.social_audits
  for each row execute function core.enforce_parent_org('integration_id', 'crm.acquisition_integrations');
alter table crm.social_audits enable row level security;
alter table crm.social_audits force row level security;
drop policy if exists social_audits_select on crm.social_audits;
create policy social_audits_select on crm.social_audits for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.social_audits from public, anon, authenticated;
grant select on crm.social_audits to authenticated;
grant select, insert on crm.social_audits to service_role;

drop trigger if exists freeze_org_social_strategies on crm.social_strategies;
create trigger freeze_org_social_strategies before update of organization_id on crm.social_strategies for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_social_strategies_audit on crm.social_strategies;
create trigger org_match_social_strategies_audit before insert or update of evidence_audit_id, organization_id on crm.social_strategies
  for each row execute function core.enforce_parent_org('evidence_audit_id', 'crm.social_audits');
alter table crm.social_strategies enable row level security;
alter table crm.social_strategies force row level security;
drop policy if exists social_strategies_select on crm.social_strategies;
create policy social_strategies_select on crm.social_strategies for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.social_strategies from public, anon, authenticated;
grant select on crm.social_strategies to authenticated;
grant select, insert, update on crm.social_strategies to service_role;

drop trigger if exists freeze_org_content_references on crm.content_references;
create trigger freeze_org_content_references before update of organization_id on crm.content_references for each row execute function core.freeze_organization_id();
alter table crm.content_references enable row level security;
alter table crm.content_references force row level security;
drop policy if exists content_references_select on crm.content_references;
create policy content_references_select on crm.content_references for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.content_references from public, anon, authenticated;
grant select on crm.content_references to authenticated;
grant select, insert on crm.content_references to service_role;

drop trigger if exists freeze_org_content_assets on crm.content_assets;
create trigger freeze_org_content_assets before update of organization_id on crm.content_assets for each row execute function core.freeze_organization_id();
alter table crm.content_assets enable row level security;
alter table crm.content_assets force row level security;
drop policy if exists content_assets_select on crm.content_assets;
create policy content_assets_select on crm.content_assets for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.content_assets from public, anon, authenticated;
grant select on crm.content_assets to authenticated;
grant select, insert on crm.content_assets to service_role;

drop trigger if exists freeze_org_content_items on crm.content_items;
create trigger freeze_org_content_items before update of organization_id on crm.content_items for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_content_items_strategy on crm.content_items;
create trigger org_match_content_items_strategy before insert or update of strategy_id, organization_id on crm.content_items
  for each row execute function core.enforce_parent_org('strategy_id', 'crm.social_strategies');
drop trigger if exists org_match_content_items_current_version on crm.content_items;
create trigger org_match_content_items_current_version before insert or update of current_version_id, organization_id on crm.content_items
  for each row execute function core.enforce_parent_org('current_version_id', 'crm.content_versions');
alter table crm.content_items enable row level security;
alter table crm.content_items force row level security;
drop policy if exists content_items_select on crm.content_items;
create policy content_items_select on crm.content_items for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.content_items from public, anon, authenticated;
grant select on crm.content_items to authenticated;
grant select, insert, update on crm.content_items to service_role;

drop trigger if exists freeze_org_content_versions on crm.content_versions;
create trigger freeze_org_content_versions before update of organization_id on crm.content_versions for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_content_versions_item on crm.content_versions;
create trigger org_match_content_versions_item before insert or update of item_id, organization_id on crm.content_versions
  for each row execute function core.enforce_parent_org('item_id', 'crm.content_items');
drop trigger if exists org_match_content_versions_approval on crm.content_versions;
create trigger org_match_content_versions_approval before insert or update of approval_request_id, organization_id on crm.content_versions
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
drop trigger if exists org_match_content_versions_supersedes on crm.content_versions;
create trigger org_match_content_versions_supersedes before insert or update of supersedes_version_id, organization_id on crm.content_versions
  for each row execute function core.enforce_parent_org('supersedes_version_id', 'crm.content_versions');
alter table crm.content_versions enable row level security;
alter table crm.content_versions force row level security;
drop policy if exists content_versions_select on crm.content_versions;
create policy content_versions_select on crm.content_versions for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.content_versions from public, anon, authenticated;
grant select on crm.content_versions to authenticated;
grant select, insert, update on crm.content_versions to service_role;

drop trigger if exists freeze_org_social_publications on crm.social_publications;
create trigger freeze_org_social_publications before update of organization_id on crm.social_publications for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_social_publications_version on crm.social_publications;
create trigger org_match_social_publications_version before insert or update of version_id, organization_id on crm.social_publications
  for each row execute function core.enforce_parent_org('version_id', 'crm.content_versions');
drop trigger if exists org_match_social_publications_execution on crm.social_publications;
create trigger org_match_social_publications_execution before insert or update of execution_id, organization_id on crm.social_publications
  for each row execute function core.enforce_parent_org('execution_id', 'crm.governed_executions');
alter table crm.social_publications enable row level security;
alter table crm.social_publications force row level security;
drop policy if exists social_publications_select on crm.social_publications;
create policy social_publications_select on crm.social_publications for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.social_publications from public, anon, authenticated;
grant select on crm.social_publications to authenticated;
grant select, insert on crm.social_publications to service_role;

drop trigger if exists freeze_org_social_metrics on crm.social_metrics;
create trigger freeze_org_social_metrics before update of organization_id on crm.social_metrics for each row execute function core.freeze_organization_id();
drop trigger if exists org_match_social_metrics_publication on crm.social_metrics;
create trigger org_match_social_metrics_publication before insert or update of publication_id, organization_id on crm.social_metrics
  for each row execute function core.enforce_parent_org('publication_id', 'crm.social_publications');
alter table crm.social_metrics enable row level security;
alter table crm.social_metrics force row level security;
drop policy if exists social_metrics_select on crm.social_metrics;
create policy social_metrics_select on crm.social_metrics for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on table crm.social_metrics from public, anon, authenticated;
grant select on crm.social_metrics to authenticated;
grant select, insert on crm.social_metrics to service_role;

-- ── 3. the shared door guard: session callers are admins of their own organisation; the service role is the engine ──

create or replace function crm._social_caller_ok(p_org uuid, p_need_admin boolean)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null then true
    when p_org is distinct from (select core.current_organization_id()) then false
    when p_need_admin then coalesce((select core.is_admin()), false)
    else coalesce((select core.can_write()), false)
  end;
$$;
revoke all on function crm._social_caller_ok(uuid, boolean) from public, anon, authenticated;

-- ── 4. doors: audits, strategies, references, assets ───────────────────────

create or replace function crm.record_social_audit(p_organization_id uuid, p_platform text, p_source text, p_integration uuid, p_summary jsonb, p_findings jsonb, p_by_type text default 'human')
returns table (outcome text, audit_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_platform not in ('linkedin', 'instagram', 'facebook') or p_source not in ('adapter', 'assisted') or p_by_type not in ('human', 'agent', 'rule')
     or jsonb_typeof(coalesce(p_summary, '{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_findings, '{}'::jsonb)) <> 'object' then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  -- An audit that claims an adapter read the account must name a connection that has actually been verified.
  if p_source = 'adapter' and not exists (select 1 from crm.acquisition_integrations i where i.id = p_integration and i.organization_id = p_organization_id
        and i.verification in ('SANDBOX_VERIFIED', 'LIVE_VERIFIED')) then
    return query select 'integration_not_verified'::text, null::uuid; return;
  end if;
  insert into crm.social_audits (organization_id, platform, source, integration_id, summary, findings, created_by_type, created_by)
  values (p_organization_id, p_platform, p_source, p_integration, coalesce(p_summary, '{}'), coalesce(p_findings, '{}'), p_by_type, (select auth.uid())) returning id into v_id;
  perform core.record_audit(p_organization_id, 'social.audit_recorded', 'social_audit', v_id, null, jsonb_build_object('platform', p_platform, 'source', p_source));
  return query select 'recorded'::text, v_id;
end;
$$;
revoke all on function crm.record_social_audit(uuid, text, text, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function crm.record_social_audit(uuid, text, text, uuid, jsonb, jsonb, text) to authenticated, service_role;

create or replace function crm.create_social_strategy(p_organization_id uuid, p_platform text, p_horizon integer, p_content jsonb, p_rationale text, p_audit uuid, p_by_type text default 'human')
returns table (outcome text, strategy_id uuid, version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_next integer; v_id uuid;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::uuid, null::integer; return; end if;
  if p_platform not in ('linkedin', 'instagram', 'facebook') or p_horizon not in (3, 6, 9) or jsonb_typeof(coalesce(p_content, 'null'::jsonb)) <> 'object'
     or p_content = '{}'::jsonb or p_by_type not in ('human', 'agent', 'rule') or length(coalesce(p_rationale, '')) > 4000 then
    return query select 'invalid'::text, null::uuid, null::integer; return;
  end if;
  if p_audit is not null and not exists (select 1 from crm.social_audits a where a.id = p_audit and a.organization_id = p_organization_id and a.platform = p_platform) then
    return query select 'unknown_audit'::text, null::uuid, null::integer; return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('strategy:' || p_organization_id::text || ':' || p_platform || ':' || p_horizon::text, 0));
  select coalesce(max(s.version), 0) + 1 into v_next from crm.social_strategies s where s.organization_id = p_organization_id and s.platform = p_platform and s.horizon_months = p_horizon;
  insert into crm.social_strategies (organization_id, platform, horizon_months, version, content, rationale, evidence_audit_id, created_by_type, created_by)
  values (p_organization_id, p_platform, p_horizon, v_next, p_content, nullif(btrim(coalesce(p_rationale, '')), ''), p_audit, p_by_type, (select auth.uid())) returning id into v_id;
  perform core.record_audit(p_organization_id, 'social.strategy_created', 'social_strategy', v_id, null, jsonb_build_object('platform', p_platform, 'horizon', p_horizon, 'version', v_next));
  return query select 'created'::text, v_id, v_next;
end;
$$;
revoke all on function crm.create_social_strategy(uuid, text, integer, jsonb, text, uuid, text) from public, anon;
grant execute on function crm.create_social_strategy(uuid, text, integer, jsonb, text, uuid, text) to authenticated, service_role;

-- Activating a strategy is the Admin's decision: it supersedes the previous one for that platform and horizon.
create or replace function crm.activate_social_strategy(p_strategy uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org uuid := (select core.current_organization_id());
  s crm.social_strategies;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'forbidden'::text; return; end if;
  select * into s from crm.social_strategies x where x.id = p_strategy and x.organization_id = v_org for update;
  if s.id is null then return query select 'not_found'::text; return; end if;
  if s.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  update crm.social_strategies set status = 'superseded' where organization_id = v_org and platform = s.platform and horizon_months = s.horizon_months and status = 'active';
  update crm.social_strategies set status = 'active', activated_at = now() where id = s.id;
  perform core.record_audit(v_org, 'social.strategy_activated', 'social_strategy', s.id, null, jsonb_build_object('platform', s.platform, 'horizon', s.horizon_months, 'version', s.version));
  return query select 'activated'::text;
end;
$$;
revoke all on function crm.activate_social_strategy(uuid) from public, anon;
grant execute on function crm.activate_social_strategy(uuid) to authenticated;

create or replace function crm.add_content_reference(p_organization_id uuid, p_kind text, p_url text, p_excerpt text, p_note text, p_analysis jsonb default '{}', p_by_type text default 'human')
returns table (outcome text, reference_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_kind not in ('post_link', 'screenshot', 'copy_example', 'competitor_content', 'image') or p_by_type not in ('human', 'agent')
     or (p_url is null and nullif(btrim(coalesce(p_excerpt, '')), '') is null and nullif(btrim(coalesce(p_note, '')), '') is null)
     or (p_url is not null and p_url !~* '^https?://') or length(coalesce(p_excerpt, '')) > 6000 then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  insert into crm.content_references (organization_id, kind, url, text_excerpt, note, analysis, added_by_type, added_by)
  values (p_organization_id, p_kind, p_url, nullif(btrim(coalesce(p_excerpt, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_analysis, '{}'), p_by_type, (select auth.uid())) returning id into v_id;
  return query select 'recorded'::text, v_id;
end;
$$;
revoke all on function crm.add_content_reference(uuid, text, text, text, text, jsonb, text) from public, anon;
grant execute on function crm.add_content_reference(uuid, text, text, text, text, jsonb, text) to authenticated, service_role;

create or replace function crm.add_content_asset(p_organization_id uuid, p_kind text, p_storage_ref text, p_method text, p_dimensions jsonb, p_hash text, p_by_type text default 'human')
returns table (outcome text, asset_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_kind not in ('image', 'carousel_slide', 'infographic', 'video', 'audio', 'captions') or p_method not in ('upload', 'ai_generated', 'designed')
     or length(coalesce(p_storage_ref, '')) not between 3 and 500 or coalesce(p_hash, '') !~ '^[0-9a-f]{64}$' or p_by_type not in ('human', 'agent', 'rule') then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  insert into crm.content_assets (organization_id, kind, storage_ref, generation_method, dimensions, content_hash, created_by_type, created_by)
  values (p_organization_id, p_kind, p_storage_ref, p_method, coalesce(p_dimensions, '{}'), p_hash, p_by_type, (select auth.uid())) returning id into v_id;
  return query select 'recorded'::text, v_id;
end;
$$;
revoke all on function crm.add_content_asset(uuid, text, text, text, jsonb, text, text) from public, anon;
grant execute on function crm.add_content_asset(uuid, text, text, text, jsonb, text, text) to authenticated, service_role;

-- ── 5. doors: items, versions, review ──────────────────────────────────────

create or replace function crm.create_content_item(p_organization_id uuid, p_platform text, p_objective text, p_format text, p_strategy uuid, p_service text, p_title text, p_by_type text default 'human')
returns table (outcome text, item_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::uuid; return; end if;
  if p_platform not in ('linkedin', 'instagram', 'facebook') or p_objective not in ('authority', 'reach', 'engagement', 'education', 'portfolio_proof', 'lead_generation')
     or p_format not in ('text', 'image', 'carousel', 'infographic', 'video', 'case_study', 'portfolio') or length(btrim(coalesce(p_title, ''))) not between 3 and 160
     or p_by_type not in ('human', 'agent', 'rule') or (p_service is not null and length(p_service) not between 2 and 80) then
    return query select 'invalid'::text, null::uuid; return;
  end if;
  if p_strategy is not null and not exists (select 1 from crm.social_strategies s where s.id = p_strategy and s.organization_id = p_organization_id and s.platform = p_platform) then
    return query select 'unknown_strategy'::text, null::uuid; return;
  end if;
  insert into crm.content_items (organization_id, platform, objective, format, strategy_id, target_service, title, created_by_type, created_by)
  values (p_organization_id, p_platform, p_objective, p_format, p_strategy, p_service, btrim(p_title), p_by_type, (select auth.uid())) returning id into v_id;
  return query select 'created'::text, v_id;
end;
$$;
revoke all on function crm.create_content_item(uuid, text, text, text, uuid, text, text, text) from public, anon;
grant execute on function crm.create_content_item(uuid, text, text, text, uuid, text, text, text) to authenticated, service_role;

create or replace function crm._withdraw_version(p_version uuid, p_new_state text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v crm.content_versions;
begin
  select * into v from crm.content_versions x where x.id = p_version for update;
  if v.id is null or v.state in ('SUPERSEDED', 'CANCELLED', 'REJECTED', 'PUBLISHED') then return; end if;
  -- A pending approval on content that no longer exists must not stay in the queue (it could not authorise anything else, but it would mislead).
  if v.approval_request_id is not null then
    perform approvals.cancel_request(v.approval_request_id, 'the content was ' || lower(p_new_state));
  end if;
  perform set_config('crm.content_write', '1', true);
  update crm.content_versions set state = p_new_state where id = v.id;
  perform set_config('crm.content_write', '', true);
end;
$$;
revoke all on function crm._withdraw_version(uuid, text) from public, anon, authenticated;

create or replace function crm.add_content_version(
  p_organization_id uuid, p_item uuid, p_body text, p_cta text, p_hashtags text[], p_asset_ids uuid[], p_reference_ids uuid[], p_by_type text default 'human'
)
returns table (outcome text, version_id uuid, version integer, content_hash text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  i crm.content_items;
  v_next integer;
  v_id uuid;
  v_prev uuid;
  r record;
  v_limit integer;
  v_hash text;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::uuid, null::integer, null::text; return; end if;
  select * into i from crm.content_items x where x.id = p_item and x.organization_id = p_organization_id for update;
  if i.id is null then return query select 'unknown_item'::text, null::uuid, null::integer, null::text; return; end if;
  v_limit := case i.platform when 'linkedin' then 3000 when 'instagram' then 2200 else 63206 end;
  if p_by_type not in ('human', 'agent', 'rule') or length(btrim(coalesce(p_body, ''))) = 0 or length(p_body) > v_limit
     or cardinality(coalesce(p_hashtags, '{}')) > 30 then
    return query select 'invalid'::text, null::uuid, null::integer, null::text; return;
  end if;
  if exists (select 1 from crm.content_versions v where v.item_id = i.id and v.state = 'PUBLISHING') then
    return query select 'publishing_in_progress'::text, null::uuid, null::integer, null::text; return;
  end if;

  select coalesce(max(v.version), 0) + 1 into v_next from crm.content_versions v where v.item_id = i.id;
  select v.id into v_prev from crm.content_versions v where v.item_id = i.id order by v.version desc limit 1;

  begin
    insert into crm.content_versions (organization_id, item_id, version, body, cta, hashtags, asset_ids, reference_ids, content_hash, supersedes_version_id, created_by_type, created_by)
    values (p_organization_id, i.id, v_next, btrim(p_body), nullif(btrim(coalesce(p_cta, '')), ''), coalesce(p_hashtags, '{}'), coalesce(p_asset_ids, '{}'),
            coalesce(p_reference_ids, '{}'), repeat('0', 64), v_prev, p_by_type, (select auth.uid()))
    returning id, crm.content_versions.content_hash into v_id, v_hash;
  exception when foreign_key_violation then
    return query select 'unknown_asset_or_reference'::text, null::uuid, null::integer, null::text; return;
  end;

  -- Everything before it that has not been posted is superseded, and any approval still waiting on it is withdrawn.
  for r in select v.id from crm.content_versions v where v.item_id = i.id and v.id <> v_id and v.state in ('DRAFT', 'AI_REVIEWED', 'AI_REVIEW_FAILED', 'ADMIN_REVIEW', 'SCHEDULED') loop
    perform crm._withdraw_version(r.id, 'SUPERSEDED');
  end loop;
  update crm.content_items set current_version_id = v_id where id = i.id;
  perform core.record_audit(p_organization_id, 'content.version_created', 'content_item', i.id, null, jsonb_build_object('version', v_next, 'version_id', v_id, 'hash', v_hash));
  return query select 'created'::text, v_id, v_next, v_hash;
end;
$$;
revoke all on function crm.add_content_version(uuid, uuid, text, text, text[], uuid[], uuid[], text) from public, anon;
grant execute on function crm.add_content_version(uuid, uuid, text, text, text[], uuid[], uuid[], text) to authenticated, service_role;

-- The deterministic quality review. It can FAIL a draft. It can never approve one.
create or replace function crm.review_content_version(p_organization_id uuid, p_version uuid)
returns table (outcome text, passed boolean, blocking jsonb, warnings jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v crm.content_versions;
  i crm.content_items;
  v_block jsonb := '[]'::jsonb;
  v_warn jsonb := '[]'::jsonb;
  v_all text;
  v_phrase text;
  v_words text[];
  v_ref record;
  v_ref_text text;
  n integer;
  k integer;
  v_gram text;
  v_limit integer;
  v_assets integer;
  v_passed boolean;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::boolean, null::jsonb, null::jsonb; return; end if;
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::boolean, null::jsonb, null::jsonb; return; end if;
  if v.state <> 'DRAFT' then return query select 'wrong_state'::text, null::boolean, null::jsonb, null::jsonb; return; end if;
  select * into i from crm.content_items x where x.id = v.item_id;
  v_all := lower(v.body || ' ' || coalesce(v.cta, ''));

  v_limit := case i.platform when 'linkedin' then 3000 when 'instagram' then 2200 else 63206 end;
  if length(v.body) > v_limit then v_block := v_block || to_jsonb('too_long_for_platform'::text); end if;
  if i.objective = 'lead_generation' and coalesce(btrim(v.cta), '') = '' then v_block := v_block || to_jsonb('missing_cta'::text); end if;
  select count(*) into v_assets from unnest(v.asset_ids);
  if i.format in ('image', 'carousel', 'infographic', 'video') and v_assets = 0 then v_block := v_block || to_jsonb('missing_asset'::text); end if;
  if i.format = 'carousel' and v_assets < 2 then v_block := v_block || to_jsonb('carousel_needs_two_or_more_slides'::text); end if;

  -- Manufactured urgency, guarantees (spec §12, §170)
  foreach v_phrase in array array['limited time', 'act now', 'only today', 'last chance', 'offer expires', 'hurry', 'don''t miss out', 'only a few spots',
                                  'guaranteed results', '100% guarantee', 'we guarantee', 'risk-free', 'once in a lifetime'] loop
    if position(v_phrase in v_all) > 0 then v_block := v_block || to_jsonb('manufactured_urgency:' || v_phrase); end if;
  end loop;
  -- Claims with no evidence behind them: superlatives and statistics (spec §115). A person who can prove one rewrites it around the proof.
  foreach v_phrase in array array['#1', 'number one', 'best in', 'world-class', 'award-winning', 'top-rated', 'industry-leading', 'market leader'] loop
    if position(v_phrase in v_all) > 0 then v_block := v_block || to_jsonb('unsupported_claim:' || v_phrase); end if;
  end loop;
  if v.body ~* '[0-9]+(\.[0-9]+)?\s*%' then v_block := v_block || to_jsonb('unverified_statistic'::text); end if;

  -- A reference inspires; it is not copied: ten consecutive words of one is a failure.
  v_words := regexp_split_to_array(regexp_replace(lower(v.body), '[^a-z0-9\s]', ' ', 'g'), '\s+');
  v_words := array_remove(v_words, '');
  n := coalesce(array_length(v_words, 1), 0);
  if n >= 10 and cardinality(v.reference_ids) > 0 then
    for v_ref in select r.id, r.text_excerpt from crm.content_references r where r.id = any (v.reference_ids) and r.text_excerpt is not null loop
      v_ref_text := ' ' || regexp_replace(regexp_replace(lower(v_ref.text_excerpt), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g') || ' ';
      for k in 1 .. n - 9 loop
        v_gram := array_to_string(v_words[k:k + 9], ' ');
        if position(' ' || v_gram || ' ' in v_ref_text) > 0 then
          v_block := v_block || to_jsonb('copies_reference:' || v_ref.id::text);
          exit;
        end if;
      end loop;
    end loop;
  end if;

  -- Repeating something posted recently on the same platform
  if exists (select 1 from crm.content_versions o join crm.content_items oi on oi.id = o.item_id
              where o.organization_id = p_organization_id and o.id <> v.id and o.state = 'PUBLISHED' and oi.platform = i.platform
                and o.created_at > now() - interval '30 days' and lower(btrim(o.body)) = lower(btrim(v.body))) then
    v_block := v_block || to_jsonb('duplicate_of_recent_post'::text);
  end if;

  -- Warnings: worth a person's eye, not a failure
  if i.target_service is not null and position(lower(i.target_service) in v_all) = 0 then v_warn := v_warn || to_jsonb('does_not_mention_the_target_service'::text); end if;
  if v.body ~* 'http://' then v_warn := v_warn || to_jsonb('insecure_link'::text); end if;
  if cardinality(v.hashtags) = 0 and i.platform in ('instagram', 'linkedin') then v_warn := v_warn || to_jsonb('no_hashtags'::text); end if;

  v_passed := jsonb_array_length(v_block) = 0;
  perform set_config('crm.content_write', '1', true);
  update crm.content_versions
     set state = case when v_passed then 'AI_REVIEWED' else 'AI_REVIEW_FAILED' end,
         review = jsonb_build_object('passed', v_passed, 'blocking', v_block, 'warnings', v_warn, 'rules_version', 1, 'checked_at', now(), 'reviewed_hash', v.content_hash)
   where id = v.id;
  perform set_config('crm.content_write', '', true);
  perform core.record_audit(p_organization_id, 'content.ai_reviewed', 'content_item', v.item_id, null, jsonb_build_object('version', v.version, 'passed', v_passed, 'blocking', v_block));
  return query select 'reviewed'::text, v_passed, v_block, v_warn;
end;
$$;
revoke all on function crm.review_content_version(uuid, uuid) from public, anon;
grant execute on function crm.review_content_version(uuid, uuid) to authenticated, service_role;

-- ── 6. admin review, schedule ──────────────────────────────────────────────

create or replace function crm.submit_for_admin_review(p_organization_id uuid, p_version uuid)
returns table (outcome text, approval_request_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v crm.content_versions;
  i crm.content_items;
  b record;
begin
  if not crm._social_caller_ok(p_organization_id, false) then return query select 'forbidden'::text, null::uuid; return; end if;
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v.state <> 'AI_REVIEWED' then return query select 'not_reviewed'::text, null::uuid; return; end if;
  select * into i from crm.content_items x where x.id = v.item_id;

  select * into b from crm.bind_approval(p_organization_id, 'social_content', v.id, v.version, v.content_hash,
    left(i.platform || ' · ' || i.objective || ' · ' || i.title || ': ' || v.body, 480), null, 'system', null, 168);
  if b.outcome not in ('requested', 'already_pending') then return query select b.outcome::text, null::uuid; return; end if;

  perform set_config('crm.content_write', '1', true);
  update crm.content_versions set state = 'ADMIN_REVIEW', approval_request_id = b.request_id where id = v.id;
  perform set_config('crm.content_write', '', true);
  perform core.record_audit(p_organization_id, 'content.submitted_for_approval', 'content_item', v.item_id, null, jsonb_build_object('version', v.version, 'approval_request_id', b.request_id, 'hash', v.content_hash));
  return query select 'submitted'::text, b.request_id;
end;
$$;
revoke all on function crm.submit_for_admin_review(uuid, uuid) from public, anon;
grant execute on function crm.submit_for_admin_review(uuid, uuid) to authenticated, service_role;

-- The label the specification uses, DERIVED from the approval engine so it cannot disagree with the decision it reports.
create or replace function crm.content_status(p_version uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v crm.content_versions; r record; c record;
begin
  select * into v from crm.content_versions x where x.id = p_version;
  if v.id is null then return null; end if;
  if (select auth.uid()) is not null and v.organization_id is distinct from (select core.current_organization_id()) then return null; end if;
  if v.state = 'AI_REVIEWED' then return 'AI_REVIEW_PASSED'; end if;
  if v.state <> 'ADMIN_REVIEW' then return v.state; end if;
  select * into r from approvals.approval_requests a where a.id = v.approval_request_id;
  if r.id is null then return 'ADMIN_REVIEW'; end if;
  if r.state = 'approved' then
    select * into c from crm.approval_check(v.approval_request_id, 'social_content', v.id, v.content_hash);
    return case when c.covered then 'APPROVED' else 'APPROVAL_LAPSED' end;
  end if;
  return case r.state when 'pending' then 'ADMIN_REVIEW' when 'rejected' then 'REJECTED' when 'changes_requested' then 'CHANGES_REQUESTED'
                      when 'expired' then 'APPROVAL_EXPIRED' else upper(r.state) end;
end;
$$;
revoke all on function crm.content_status(uuid) from public, anon;
grant execute on function crm.content_status(uuid) to authenticated, service_role;

create or replace function crm.schedule_content(p_organization_id uuid, p_version uuid, p_when timestamptz)
returns table (outcome text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v crm.content_versions; c record;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text, null::text; return; end if;
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text; return; end if;
  if v.state <> 'ADMIN_REVIEW' then return query select 'wrong_state'::text, v.state; return; end if;
  if p_when is null or p_when < now() - interval '1 minute' then return query select 'invalid_time'::text, null::text; return; end if;
  -- SCHEDULED is reachable only by a version an admin has APPROVED, for exactly this content, within the approval's validity.
  select * into c from crm.approval_check(v.approval_request_id, 'social_content', v.id, v.content_hash);
  if not c.covered then return query select 'not_approved'::text, c.reason; return; end if;
  perform set_config('crm.content_write', '1', true);
  update crm.content_versions set state = 'SCHEDULED', scheduled_for = p_when where id = v.id;
  perform set_config('crm.content_write', '', true);
  perform core.record_audit(p_organization_id, 'content.scheduled', 'content_item', v.item_id, null, jsonb_build_object('version', v.version, 'when', p_when));
  return query select 'scheduled'::text, null::text;
end;
$$;
revoke all on function crm.schedule_content(uuid, uuid, timestamptz) from public, anon;
grant execute on function crm.schedule_content(uuid, uuid, timestamptz) to authenticated, service_role;

create or replace function crm.cancel_content_version(p_organization_id uuid, p_version uuid, p_reason text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v crm.content_versions;
begin
  if not crm._social_caller_ok(p_organization_id, true) then return query select 'forbidden'::text; return; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then return query select 'needs_reason'::text; return; end if;
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state in ('SUPERSEDED', 'CANCELLED', 'REJECTED', 'PUBLISHED') then return query select 'not_live'::text; return; end if;
  if v.state = 'PUBLISHING' then return query select 'publishing_in_progress'::text; return; end if;
  perform crm._withdraw_version(v.id, 'CANCELLED');
  perform core.record_audit(p_organization_id, 'content.cancelled', 'content_item', v.item_id, null, jsonb_build_object('version', v.version, 'reason', left(p_reason, 300)));
  return query select 'cancelled'::text;
end;
$$;
revoke all on function crm.cancel_content_version(uuid, uuid, text) from public, anon;
grant execute on function crm.cancel_content_version(uuid, uuid, text) to authenticated, service_role;

-- A rejected or lapsed approval moves the version out of the review queue (the stored state follows the engine).
create or replace function crm.sync_content_approvals(p_limit integer default 200)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare r record; n integer := 0;
begin
  for r in select v.id, a.state from crm.content_versions v join approvals.approval_requests a on a.id = v.approval_request_id
            where v.state = 'ADMIN_REVIEW' and a.state in ('rejected', 'expired', 'cancelled', 'changes_requested')
            order by v.state_changed_at limit greatest(1, least(coalesce(p_limit, 200), 1000)) for update of v skip locked loop
    perform set_config('crm.content_write', '1', true);
    update crm.content_versions set state = 'REJECTED' where id = r.id;
    perform set_config('crm.content_write', '', true);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function crm.sync_content_approvals(integer) from public, anon, authenticated;
grant execute on function crm.sync_content_approvals(integer) to service_role;

-- ── 7. publish: the governed door, once ────────────────────────────────────

create or replace function crm.begin_content_publish(p_organization_id uuid, p_version uuid, p_correlation_id uuid default null)
returns table (outcome text, reason text, execution_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v crm.content_versions;
  d record;
  g record;
begin
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text, null::text, null::uuid; return; end if;
  if v.state = 'PUBLISHED' then return query select 'already_published'::text, null::text, null::uuid; return; end if;
  if v.state not in ('SCHEDULED', 'PUBLISHING') then return query select 'not_scheduled'::text, v.state, null::uuid; return; end if;
  if v.state = 'SCHEDULED' and v.scheduled_for is not null and v.scheduled_for > now() then return query select 'not_yet_due'::text, null::text, null::uuid; return; end if;

  -- The connector, the limits and the stops are asked NOW. ADMIN_APPROVAL_REQUIRED is expected (publishing is never automatic) and is
  -- satisfied by the exact-version approval checked below; only BLOCK refuses.
  select * into d from crm.acquisition_decide(p_organization_id, 'social_publish', null, 0, 1, p_correlation_id);
  if d.decision = 'BLOCK' then return query select 'blocked'::text, d.reason, null::uuid; return; end if;

  select * into g from crm.begin_governed_execution(p_organization_id, v.approval_request_id, 'social_content', v.id, v.content_hash, 'social_publish', 'social', p_correlation_id);
  if g.outcome = 'proceed' then
    if v.state = 'SCHEDULED' then
      perform set_config('crm.content_write', '1', true);
      update crm.content_versions set state = 'PUBLISHING' where id = v.id;
      perform set_config('crm.content_write', '', true);
    end if;
    return query select 'proceed'::text, g.reason, g.execution_id; return;
  end if;
  return query select g.outcome::text, g.reason, g.execution_id;
end;
$$;
revoke all on function crm.begin_content_publish(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function crm.begin_content_publish(uuid, uuid, uuid) to service_role;

create or replace function crm.record_publish(p_organization_id uuid, p_version uuid, p_execution uuid, p_status text, p_external_ref text, p_url text, p_evidence jsonb default '{}')
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v crm.content_versions; i crm.content_items; f record;
begin
  if p_status not in ('executed', 'failed', 'unknown') then return query select 'invalid'::text; return; end if;
  select * into v from crm.content_versions x where x.id = p_version and x.organization_id = p_organization_id for update;
  if v.id is null then return query select 'not_found'::text; return; end if;
  if v.state <> 'PUBLISHING' then return query select 'wrong_state'::text; return; end if;
  if p_status = 'executed' and coalesce(btrim(p_external_ref), '') = '' then return query select 'needs_reference'::text; return; end if;
  select * into i from crm.content_items x where x.id = v.item_id;

  select * into f from crm.finish_governed_execution(p_organization_id, p_execution, p_status, p_external_ref, p_evidence);
  if f.outcome <> 'recorded' then return query select f.outcome::text; return; end if;

  if p_status = 'executed' then
    insert into crm.social_publications (organization_id, version_id, execution_id, platform, external_ref, url)
    values (p_organization_id, v.id, p_execution, i.platform, btrim(p_external_ref), p_url);
    perform set_config('crm.content_write', '1', true);
    update crm.content_versions set state = 'PUBLISHED' where id = v.id;
    perform set_config('crm.content_write', '', true);
    perform crm.record_acquisition_usage(p_organization_id, 'social', 'action', 1, 'publish:' || v.id::text);
  elsif p_status = 'failed' then
    -- Back to SCHEDULED: the governed door decides whether another attempt is allowed (at most three).
    perform set_config('crm.content_write', '1', true);
    update crm.content_versions set state = 'SCHEDULED' where id = v.id;
    perform set_config('crm.content_write', '', true);
  end if;
  -- unknown: stays PUBLISHING. It is reconciled against the provider, never re-posted.
  perform core.record_audit(p_organization_id, 'content.publish_' || p_status, 'content_item', v.item_id, null, jsonb_build_object('version', v.version, 'external_ref', left(p_external_ref, 200)));
  return query select 'recorded'::text;
end;
$$;
revoke all on function crm.record_publish(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function crm.record_publish(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

create or replace function crm.record_social_metrics(p_organization_id uuid, p_publication uuid, p_impressions bigint, p_reach bigint, p_engagements bigint, p_clicks bigint, p_profile_visits bigint)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from crm.social_publications p where p.id = p_publication and p.organization_id = p_organization_id) then return query select 'not_found'::text; return; end if;
  insert into crm.social_metrics (organization_id, publication_id, impressions, reach, engagements, clicks, profile_visits)
  values (p_organization_id, p_publication, p_impressions, p_reach, p_engagements, p_clicks, p_profile_visits);
  return query select 'recorded'::text;
exception when check_violation then return query select 'invalid'::text;
end;
$$;
revoke all on function crm.record_social_metrics(uuid, uuid, bigint, bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function crm.record_social_metrics(uuid, uuid, bigint, bigint, bigint, bigint, bigint) to service_role;

-- ── 8. performance, by what the content was FOR ────────────────────────────

create or replace function crm.social_performance()
returns table (platform text, objective text, format text, published bigint, impressions bigint, engagements bigint, clicks bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with latest as (
    select distinct on (m.publication_id) m.publication_id, m.impressions, m.engagements, m.clicks
      from crm.social_metrics m order by m.publication_id, m.collected_at desc, m.id desc)
  select i.platform, i.objective, i.format, count(p.id), coalesce(sum(l.impressions), 0)::bigint, coalesce(sum(l.engagements), 0)::bigint, coalesce(sum(l.clicks), 0)::bigint
    from crm.social_publications p
    join crm.content_versions v on v.id = p.version_id
    join crm.content_items i on i.id = v.item_id
    left join latest l on l.publication_id = p.id
   group by i.platform, i.objective, i.format
   order by count(p.id) desc;
$$;
grant execute on function crm.social_performance() to authenticated, service_role;

-- ── 9. the queue a person works, with the specification's labels (derived, never stored) ──

create or replace function crm.content_queue(p_limit integer default 50)
returns table (item_id uuid, version_id uuid, version integer, platform text, objective text, format text, title text, body_preview text,
               state text, status text, scheduled_for timestamptz, review jsonb, created_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select i.id, v.id, v.version, i.platform, i.objective, i.format, i.title, left(v.body, 240), v.state, crm.content_status(v.id), v.scheduled_for, v.review, v.created_at
    from crm.content_items i
    join crm.content_versions v on v.id = i.current_version_id
   order by case when v.state in ('ADMIN_REVIEW', 'AI_REVIEWED', 'DRAFT', 'SCHEDULED', 'PUBLISHING') then 0 else 1 end, v.created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
grant execute on function crm.content_queue(integer) to authenticated, service_role;

-- Scheduled posts that are due. Nothing is posted by this: it only says what is waiting, so the worker (or a person, where no adapter
-- exists) can act. A due post with no way to publish is ASSISTED_ACTION_REQUIRED, never silently skipped.
create or replace function crm.due_content(p_limit integer default 25)
returns table (organization_id uuid, version_id uuid, platform text, scheduled_for timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select v.organization_id, v.id, i.platform, v.scheduled_for
    from crm.content_versions v join crm.content_items i on i.id = v.item_id
   where v.state in ('SCHEDULED', 'PUBLISHING') and (v.scheduled_for is null or v.scheduled_for <= now())
   order by v.scheduled_for nulls first, v.created_at
   limit greatest(1, least(coalesce(p_limit, 25), 100));
$$;
revoke all on function crm.due_content(integer) from public, anon, authenticated;
grant execute on function crm.due_content(integer) to service_role;

notify pgrst, 'reload schema';
