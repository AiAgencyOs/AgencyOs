-- ═════════════════════════════════════════════════════════════════
-- Phase 8A gaps log 1 (part 3): the Support and Customer Success rows that needed a record or a derived read, not a model or a provider.
--
--   support_knowledge_articles      the APPROVED KNOWLEDGE BASE the Support spec answers from. Versioned; a draft is proposed by a person or by the support agent, and ONLY an
--                                   Admin who is not its author approves it. An approved body never changes (a change is a new version; approving it retires the old one).
--   ticket_knowledge_citations      which approved article (and version) answers a ticket: only an approved article can be cited.
--   ticket_scope_references         the scope-item comparison (SUP-TST-002): is the reported behaviour inside scope, an explicit exclusion, outside scope or unclear, against
--                                   the APPROVED scope version the workspace was started from. The agent PROPOSES; a person confirms.
--   support_handoff_requests        DeveloperTaskRequested / QAVerificationRequested as records: built from the TICKET ROW (never from what the caller says), idempotent, and
--                                   only along the handoff edges the roster already allows. A person acknowledges and settles; no task is created and nothing is dispatched.
--   cs_next_actions                 the Customer Success next-action queue: DERIVED from the records that already exist, ordered by a fixed documented rank. Nothing is stored.
-- ═════════════════════════════════════════════════════════════════

-- ── approved knowledge base ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.support_knowledge_articles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  article_key      text not null check (article_key ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  version          int not null check (version >= 1),
  title            text not null check (length(btrim(title)) between 3 and 200 and not projects.p7_has_secret(title)),
  body             text not null check (length(btrim(body)) between 20 and 8000 and not projects.p7_has_secret(body)
                                         and body !~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off'),
  client_safe      boolean not null default false,
  status           text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  proposed_by      uuid references core.users(id) on delete restrict,
  proposed_by_agent text check (proposed_by_agent is null or length(btrim(proposed_by_agent)) between 1 and 80),
  approved_by      uuid references core.users(id) on delete restrict,
  approved_at      timestamptz,
  retired_by       uuid references core.users(id) on delete restrict,
  retired_at       timestamptz,
  retire_reason    text,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, article_key, version),
  constraint knowledge_has_one_author check (num_nonnulls(proposed_by, proposed_by_agent) = 1),
  -- approval is a person, with a time, and never the person who wrote it
  constraint knowledge_approved_by_an_independent_person check ((approved_by is not null) = (approved_at is not null) and (status = 'draft' or approved_by is not null) and (approved_by is null or approved_by is distinct from proposed_by)),
  constraint knowledge_retired_says_why check ((status = 'retired') = (retired_at is not null) and (status <> 'retired' or length(btrim(coalesce(retire_reason, ''))) >= 5))
);
create unique index if not exists knowledge_one_approved_per_key on projects.support_knowledge_articles (organization_id, article_key) where status = 'approved';
create unique index if not exists knowledge_one_draft_per_key on projects.support_knowledge_articles (organization_id, article_key) where status = 'draft';
comment on table projects.support_knowledge_articles is
  'The approved knowledge base Support answers from. A draft is proposed by a person or the support agent; only an Admin who is not the author approves it. An approved body never changes: a new version retires the old one. No price or discount in an article.';

create or replace function projects.knowledge_article_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.article_key is distinct from old.article_key or new.version is distinct from old.version or new.organization_id is distinct from old.organization_id
     or new.proposed_by is distinct from old.proposed_by or new.proposed_by_agent is distinct from old.proposed_by_agent then
    raise exception 'a knowledge article keeps its key, version and author' using errcode = 'restrict_violation';
  end if;
  if old.status in ('approved', 'retired') and (new.title is distinct from old.title or new.body is distinct from old.body or new.client_safe is distinct from old.client_safe
                                                or new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at) then
    raise exception 'an approved or retired knowledge article is never edited: propose a new version' using errcode = 'restrict_violation';
  end if;
  if old.status = 'retired' and new.status is distinct from 'retired' then
    raise exception 'a retired knowledge article stays retired' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists support_knowledge_articles_frozen on projects.support_knowledge_articles;
create trigger support_knowledge_articles_frozen before update on projects.support_knowledge_articles for each row execute function projects.knowledge_article_frozen();

create table if not exists projects.ticket_knowledge_citations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  ticket_id        uuid not null references projects.support_tickets(id) on delete cascade,
  article_id       uuid not null references projects.support_knowledge_articles(id) on delete restrict,
  article_version  int not null,
  cited_by         uuid references core.users(id) on delete restrict,
  cited_by_agent   text check (cited_by_agent is null or length(btrim(cited_by_agent)) between 1 and 80),
  cited_at         timestamptz not null default clock_timestamp(),
  unique (ticket_id, article_id),
  constraint citation_has_one_citer check (num_nonnulls(cited_by, cited_by_agent) = 1)
);
comment on table projects.ticket_knowledge_citations is 'APPEND-ONLY. Which APPROVED knowledge article answered a ticket, at which version. Only an approved article can be cited.';

-- ── scope reference ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.ticket_scope_references (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  ticket_id         uuid not null references projects.support_tickets(id) on delete cascade,
  scope_version_id  uuid not null references projects.scope_versions(id) on delete restrict,
  scope_item_id     uuid references projects.scope_items(id) on delete restrict,
  relation          text not null check (relation in ('inside_scope', 'excluded', 'outside_scope', 'unclear')),
  note              text not null check (length(btrim(note)) between 10 and 1000 and not projects.p7_has_secret(note)),
  status            text not null default 'proposed' check (status in ('proposed', 'confirmed')),
  proposed_by_agent text check (proposed_by_agent is null or length(btrim(proposed_by_agent)) between 1 and 80),
  recorded_by       uuid references core.users(id) on delete restrict,
  confirmed_by      uuid references core.users(id) on delete restrict,
  confirmed_at      timestamptz,
  created_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default now(),
  -- inside_scope and excluded name the scope item they rest on; the other two may not pretend to
  constraint scope_ref_names_its_item check ((relation in ('inside_scope', 'excluded')) = (scope_item_id is not null) or relation = 'unclear'),
  constraint scope_ref_confirmed_is_a_person check ((status = 'confirmed') = (confirmed_by is not null and confirmed_at is not null)),
  constraint scope_ref_has_an_author check (num_nonnulls(proposed_by_agent, recorded_by) = 1)
);
create unique index if not exists ticket_scope_references_once on projects.ticket_scope_references (ticket_id, relation, coalesce(scope_item_id, '00000000-0000-0000-0000-000000000000'::uuid));
comment on table projects.ticket_scope_references is
  'The scope-item comparison of a ticket against the APPROVED scope version the Phase 8 workspace started from. The support agent proposes; a person confirms. It records evidence: it does not reclassify the ticket.';

-- ── developer / QA request ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists projects.support_handoff_requests (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  ticket_id          uuid not null references projects.support_tickets(id) on delete cascade,
  target             text not null check (target in ('developer', 'quality_assurance')),
  reason             text not null check (length(btrim(reason)) between 10 and 1000 and not projects.p7_has_secret(reason)),
  payload            jsonb not null check (jsonb_typeof(payload) = 'object'),
  status             text not null default 'requested' check (status in ('requested', 'acknowledged', 'completed', 'declined')),
  requested_by       uuid references core.users(id) on delete restrict,
  requested_by_agent text check (requested_by_agent is null or length(btrim(requested_by_agent)) between 1 and 80),
  requested_at       timestamptz not null default clock_timestamp(),
  resolved_by        uuid references core.users(id) on delete restrict,
  resolved_at        timestamptz,
  resolution_note    text check (resolution_note is null or not projects.p7_has_secret(resolution_note)),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint handoff_request_has_one_requester check (num_nonnulls(requested_by, requested_by_agent) = 1),
  constraint handoff_request_settled_is_a_persons check ((status in ('completed', 'declined')) = (resolved_by is not null and resolved_at is not null and length(btrim(coalesce(resolution_note, ''))) >= 5))
);
create unique index if not exists support_handoff_requests_one_live on projects.support_handoff_requests (ticket_id, target) where status in ('requested', 'acknowledged');
comment on table projects.support_handoff_requests is
  'A ticket asked Developer or QA for something (DeveloperTaskRequested / QAVerificationRequested as a record). The payload is built from the ticket row. A person acknowledges and settles it. No task is created and nothing is dispatched.';

do $$
declare r record;
begin
  for r in select * from (values
    ('ticket_knowledge_citations', 'ticket_id', 'projects.support_tickets'), ('ticket_knowledge_citations', 'article_id', 'projects.support_knowledge_articles'),
    ('ticket_scope_references', 'ticket_id', 'projects.support_tickets'), ('ticket_scope_references', 'scope_version_id', 'projects.scope_versions'), ('ticket_scope_references', 'scope_item_id', 'projects.scope_items'),
    ('support_handoff_requests', 'ticket_id', 'projects.support_tickets')
  ) as t(tbl, col, parent) loop
    perform projects.p8g_wire_parent(r.tbl, r.col, r.parent);
  end loop;
  perform projects.p8g_wire_table('support_knowledge_articles', true, false);
  perform projects.p8g_wire_table('ticket_knowledge_citations', false, true);
  perform projects.p8g_wire_table('ticket_scope_references', true, false);
  perform projects.p8g_wire_table('support_handoff_requests', true, false);
end $$;

-- ── knowledge doors ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.p8g_propose_article(p_org uuid, p_person uuid, p_agent text, p_key text, p_title text, p_body text, p_client_safe boolean)
returns table (outcome text, article_id uuid, version int)
language plpgsql security definer set search_path = '' as $$
declare v_key text := lower(nullif(btrim(coalesce(p_key, '')), '')); v_title text := nullif(btrim(coalesce(p_title, '')), ''); v_body text := nullif(btrim(coalesce(p_body, '')), ''); v_id uuid; v_v int;
begin
  if v_key is null or v_key !~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$' then return query select 'bad_key'::text, null::uuid, null::int; return; end if;
  if v_title is null or length(v_title) < 3 or length(v_title) > 200 then return query select 'bad_title'::text, null::uuid, null::int; return; end if;
  if v_body is null or length(v_body) < 20 or length(v_body) > 8000 then return query select 'bad_body'::text, null::uuid, null::int; return; end if;
  if projects.p7_has_secret(v_title) or projects.p7_has_secret(v_body) then return query select 'contains_secret'::text, null::uuid, null::int; return; end if;
  if v_body ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' then return query select 'names_a_price'::text, null::uuid, null::int; return; end if;
  select a.id into v_id from projects.support_knowledge_articles a where a.organization_id = p_org and a.article_key = v_key and a.status = 'draft';
  if v_id is not null then return query select 'draft_exists'::text, v_id, null::int; return; end if;
  select coalesce(max(a.version), 0) + 1 into v_v from projects.support_knowledge_articles a where a.organization_id = p_org and a.article_key = v_key;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.support_knowledge_articles (organization_id, article_key, version, title, body, client_safe, proposed_by, proposed_by_agent)
  values (p_org, v_key, v_v, v_title, v_body, coalesce(p_client_safe, false), p_person, p_agent) returning id into v_id;
  perform core.record_audit(p_org, 'knowledge.proposed', 'knowledge_article', v_id, null, jsonb_build_object('key', v_key, 'version', v_v, 'byAgent', p_agent), projects.p8g_correlation());
  return query select 'proposed'::text, v_id, v_v;
end $$;
revoke all on function projects.p8g_propose_article(uuid, uuid, text, text, text, text, boolean) from public, anon, authenticated, service_role;

create or replace function projects.propose_knowledge_article(p_key text, p_title text, p_body text, p_client_safe boolean default false)
returns table (outcome text, article_id uuid, version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid, null::int; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid, null::int; return; end if;
  return query select * from projects.p8g_propose_article(v_org, v_actor, null, p_key, p_title, p_body, p_client_safe);
end $$;
revoke all on function projects.propose_knowledge_article(text, text, text, boolean) from public, anon, service_role;
grant execute on function projects.propose_knowledge_article(text, text, text, boolean) to authenticated;

create or replace function projects.propose_knowledge_article_as_agent(p_organization_id uuid, p_agent_key text, p_key text, p_title text, p_body text, p_client_safe boolean default false)
returns table (outcome text, article_id uuid, version int)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid, null::int; return; end if;
  if p_agent_key is distinct from 'support' then return query select 'not_the_support_agent'::text, null::uuid, null::int; return; end if;
  if not exists (select 1 from core.organizations o where o.id = p_organization_id) then return query select 'not_found'::text, null::uuid, null::int; return; end if;
  return query select * from projects.p8g_propose_article(p_organization_id, null, p_agent_key, p_key, p_title, p_body, p_client_safe);
end $$;
revoke all on function projects.propose_knowledge_article_as_agent(uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function projects.propose_knowledge_article_as_agent(uuid, text, text, text, text, boolean) to service_role;

create or replace function projects.approve_knowledge_article(p_article_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_a projects.support_knowledge_articles;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_a from projects.support_knowledge_articles a where a.id = p_article_id and a.organization_id = v_org for update;
  if v_a.id is null then return query select 'not_found'::text; return; end if;
  if v_a.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  if v_a.proposed_by is not distinct from v_actor then return query select 'author_cannot_approve'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_knowledge_articles set status = 'retired', retired_by = v_actor, retired_at = clock_timestamp(), retire_reason = 'superseded by version ' || v_a.version
   where organization_id = v_org and article_key = v_a.article_key and status = 'approved';
  update projects.support_knowledge_articles set status = 'approved', approved_by = v_actor, approved_at = clock_timestamp() where id = v_a.id;
  perform core.record_audit(v_org, 'knowledge.approved', 'knowledge_article', v_a.id, null, jsonb_build_object('key', v_a.article_key, 'version', v_a.version), projects.p8g_correlation());
  return query select 'approved'::text;
end $$;
revoke all on function projects.approve_knowledge_article(uuid) from public, anon, service_role;
grant execute on function projects.approve_knowledge_article(uuid) to authenticated;

create or replace function projects.retire_knowledge_article(p_article_id uuid, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_a projects.support_knowledge_articles; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;
  select * into v_a from projects.support_knowledge_articles a where a.id = p_article_id and a.organization_id = v_org for update;
  if v_a.id is null then return query select 'not_found'::text; return; end if;
  if v_a.status = 'retired' then return query select 'already_retired'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.support_knowledge_articles set status = 'retired', retired_by = v_actor, retired_at = clock_timestamp(), retire_reason = left(v_reason, 500) where id = v_a.id;
  perform core.record_audit(v_org, 'knowledge.retired', 'knowledge_article', v_a.id, null, jsonb_build_object('key', v_a.article_key, 'version', v_a.version), projects.p8g_correlation());
  return query select 'retired'::text;
end $$;
revoke all on function projects.retire_knowledge_article(uuid, text) from public, anon, service_role;
grant execute on function projects.retire_knowledge_article(uuid, text) to authenticated;

create or replace function projects.p8g_cite(p_org uuid, p_person uuid, p_agent text, p_ticket uuid, p_article uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_a projects.support_knowledge_articles; v_n int;
begin
  if not exists (select 1 from projects.support_tickets t where t.id = p_ticket and t.organization_id = p_org) then return 'ticket_not_found'; end if;
  select * into v_a from projects.support_knowledge_articles a where a.id = p_article and a.organization_id = p_org;
  if v_a.id is null then return 'article_not_found'; end if;
  if v_a.status <> 'approved' then return 'article_not_approved'; end if;
  insert into projects.ticket_knowledge_citations (organization_id, ticket_id, article_id, article_version, cited_by, cited_by_agent) values (p_org, p_ticket, p_article, v_a.version, p_person, p_agent)
  on conflict (ticket_id, article_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then return 'already_cited'; end if;
  perform core.record_audit(p_org, 'knowledge.cited', 'support_ticket', p_ticket, null, jsonb_build_object('articleId', p_article, 'version', v_a.version, 'byAgent', p_agent), projects.p8g_correlation());
  return 'cited';
end $$;
revoke all on function projects.p8g_cite(uuid, uuid, text, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function projects.cite_knowledge_for_ticket(p_ticket_id uuid, p_article_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  return query select projects.p8g_cite(v_org, v_actor, null, p_ticket_id, p_article_id);
end $$;
revoke all on function projects.cite_knowledge_for_ticket(uuid, uuid) from public, anon, service_role;
grant execute on function projects.cite_knowledge_for_ticket(uuid, uuid) to authenticated;

create or replace function projects.cite_knowledge_for_ticket_as_agent(p_organization_id uuid, p_agent_key text, p_ticket_id uuid, p_article_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text; return; end if;
  if p_agent_key is distinct from 'support' then return query select 'not_the_support_agent'::text; return; end if;
  return query select projects.p8g_cite(p_organization_id, null, p_agent_key, p_ticket_id, p_article_id);
end $$;
revoke all on function projects.cite_knowledge_for_ticket_as_agent(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function projects.cite_knowledge_for_ticket_as_agent(uuid, text, uuid, uuid) to service_role;

-- the client reads only approved articles flagged client-safe, from its own organization
create or replace function projects.client_knowledge_articles()
returns table (article_key text, title text, body text, version int, approved_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_account uuid := (select core.current_client_account_id()); v_org uuid;
begin
  if not coalesce((select core.is_client()), false) or v_account is null then return; end if;
  select a.organization_id into v_org from core.client_accounts a where a.id = v_account;
  return query select k.article_key, k.title, k.body, k.version, k.approved_at from projects.support_knowledge_articles k
   where k.organization_id = v_org and k.status = 'approved' and k.client_safe order by k.title, k.version desc limit 200;
end $$;
revoke all on function projects.client_knowledge_articles() from public, anon, service_role;
grant execute on function projects.client_knowledge_articles() to authenticated;

-- ── scope reference doors ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.p8g_scope_reference(p_org uuid, p_person uuid, p_agent text, p_ticket uuid, p_relation text, p_item uuid, p_note text)
returns table (outcome text, reference_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_t projects.support_tickets; v_sv uuid; v_inc text; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid; v_status text := case when p_person is not null then 'confirmed' else 'proposed' end;
begin
  if p_relation is null or p_relation not in ('inside_scope', 'excluded', 'outside_scope', 'unclear') then return query select 'bad_relation'::text, null::uuid; return; end if;
  if v_note is null or length(v_note) < 10 or length(v_note) > 1000 then return query select 'note_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_note) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket and t.organization_id = p_org;
  if v_t.id is null then return query select 'ticket_not_found'::text, null::uuid; return; end if;
  select i.scope_version_id into v_sv from projects.phase_eight_intake i where i.project_id = v_t.project_id and i.organization_id = p_org;
  if v_sv is null then return query select 'no_approved_scope_version'::text, null::uuid; return; end if;
  if p_relation in ('inside_scope', 'excluded') and p_item is null then return query select 'scope_item_required'::text, null::uuid; return; end if;
  if p_relation = 'outside_scope' and p_item is not null then return query select 'outside_scope_names_no_item'::text, null::uuid; return; end if;
  if p_item is not null then
    select si.inclusion into v_inc from projects.scope_items si where si.id = p_item and si.scope_version_id = v_sv and si.organization_id = p_org;
    if v_inc is null then return query select 'item_not_in_the_approved_scope'::text, null::uuid; return; end if;
    if p_relation = 'inside_scope' and v_inc <> 'included' then return query select 'item_is_not_included'::text, null::uuid; return; end if;
    if p_relation = 'excluded' and v_inc <> 'excluded' then return query select 'item_is_not_excluded'::text, null::uuid; return; end if;
  end if;
  select r.id into v_id from projects.ticket_scope_references r where r.ticket_id = p_ticket and r.relation = p_relation and r.scope_item_id is not distinct from p_item;
  if v_id is not null then return query select 'already_recorded'::text, v_id; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.ticket_scope_references (organization_id, ticket_id, scope_version_id, scope_item_id, relation, note, status, proposed_by_agent, recorded_by, confirmed_by, confirmed_at)
  values (p_org, p_ticket, v_sv, p_item, p_relation, v_note, v_status, p_agent, p_person, p_person, case when p_person is not null then clock_timestamp() end) returning id into v_id;
  perform core.record_audit(p_org, 'ticket_scope_reference.' || v_status, 'support_ticket', p_ticket, null, jsonb_build_object('relation', p_relation, 'scopeItemId', p_item, 'byAgent', p_agent), projects.p8g_correlation());
  return query select (case when p_person is not null then 'recorded' else 'proposed' end)::text, v_id;
end $$;
revoke all on function projects.p8g_scope_reference(uuid, uuid, text, uuid, text, uuid, text) from public, anon, authenticated, service_role;

create or replace function projects.record_ticket_scope_reference(p_ticket_id uuid, p_relation text, p_scope_item_id uuid, p_note text)
returns table (outcome text, reference_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  return query select * from projects.p8g_scope_reference(v_org, v_actor, null, p_ticket_id, p_relation, p_scope_item_id, p_note);
end $$;
revoke all on function projects.record_ticket_scope_reference(uuid, text, uuid, text) from public, anon, service_role;
grant execute on function projects.record_ticket_scope_reference(uuid, text, uuid, text) to authenticated;

create or replace function projects.propose_ticket_scope_reference_as_agent(p_organization_id uuid, p_agent_key text, p_ticket_id uuid, p_relation text, p_scope_item_id uuid, p_note text)
returns table (outcome text, reference_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid; return; end if;
  if p_agent_key is distinct from 'support' then return query select 'not_the_support_agent'::text, null::uuid; return; end if;
  return query select * from projects.p8g_scope_reference(p_organization_id, null, p_agent_key, p_ticket_id, p_relation, p_scope_item_id, p_note);
end $$;
revoke all on function projects.propose_ticket_scope_reference_as_agent(uuid, text, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function projects.propose_ticket_scope_reference_as_agent(uuid, text, uuid, text, uuid, text) to service_role;

create or replace function projects.confirm_ticket_scope_reference(p_reference_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.ticket_scope_references;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_r from projects.ticket_scope_references r where r.id = p_reference_id and r.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.status = 'confirmed' then return query select 'already_confirmed'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.ticket_scope_references set status = 'confirmed', confirmed_by = v_actor, confirmed_at = clock_timestamp() where id = v_r.id;
  perform core.record_audit(v_org, 'ticket_scope_reference.confirmed', 'support_ticket', v_r.ticket_id, null, jsonb_build_object('referenceId', v_r.id), projects.p8g_correlation());
  return query select 'confirmed'::text;
end $$;
revoke all on function projects.confirm_ticket_scope_reference(uuid) from public, anon, service_role;
grant execute on function projects.confirm_ticket_scope_reference(uuid) to authenticated;

create or replace function projects.ticket_scope_comparison(p_ticket_id uuid)
returns table (reference_id uuid, relation text, status text, note text, scope_version_id uuid, scope_item_id uuid, scope_item_title text, scope_item_inclusion text, proposed_by_agent text, confirmed_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select r.id, r.relation, r.status, r.note, r.scope_version_id, r.scope_item_id, si.title, si.inclusion, r.proposed_by_agent, r.confirmed_at
    from projects.ticket_scope_references r left join projects.scope_items si on si.id = r.scope_item_id
   where r.ticket_id = p_ticket_id and (coalesce((select auth.role()), '') = 'service_role' or (select core.is_internal()))
   order by r.created_at, r.id;
$$;
revoke all on function projects.ticket_scope_comparison(uuid) from public, anon;
grant execute on function projects.ticket_scope_comparison(uuid) to authenticated, service_role;

-- ── developer / QA request doors ────────────────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function projects.p8g_handoff_request(p_org uuid, p_person uuid, p_agent text, p_ticket uuid, p_target text, p_reason text)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_t projects.support_tickets; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_id uuid; v_payload jsonb;
begin
  if p_target is null or p_target not in ('developer', 'quality_assurance') then return query select 'bad_target'::text, null::uuid; return; end if;
  if v_reason is null or length(v_reason) < 10 or length(v_reason) > 1000 then return query select 'reason_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_reason) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select * into v_t from projects.support_tickets t where t.id = p_ticket and t.organization_id = p_org for update;
  if v_t.id is null then return query select 'ticket_not_found'::text, null::uuid; return; end if;
  if v_t.status in ('closed', 'cancelled') then return query select 'ticket_is_finished'::text, null::uuid; return; end if;
  -- an agent may only hand work along an edge the roster allows
  if p_agent is not null and not exists (select 1 from ai.agent_handoff_targets e where e.from_agent = p_agent and e.to_agent = p_target) then return query select 'no_handoff_edge'::text, null::uuid; return; end if;
  if p_target = 'developer' then
    -- a developer fixes a fault or does maintenance: a how-to, a change request and a new project are not developer tasks, and an unclassified ticket is not yet known to be
    if v_t.classification is null or v_t.classification not in ('warranty_bug', 'maintenance', 'minor_change') then return query select 'classification_does_not_need_a_developer'::text, null::uuid; return; end if;
  else
    if v_t.status not in ('in_progress', 'in_qa') then return query select 'nothing_to_verify_yet'::text, null::uuid; return; end if;
  end if;
  select r.id into v_id from projects.support_handoff_requests r where r.ticket_id = p_ticket and r.target = p_target and r.status in ('requested', 'acknowledged');
  if v_id is not null then return query select 'already_requested'::text, v_id; return; end if;
  -- the payload is the TICKET ROW's own facts, never the caller's claim
  v_payload := jsonb_build_object('ticketRef', v_t.ticket_ref, 'title', v_t.title, 'classification', v_t.classification, 'coverage', v_t.coverage_decision, 'priority', v_t.priority,
                                  'status', v_t.status, 'defectId', v_t.defect_id, 'maintenanceItemId', v_t.maintenance_item_id, 'projectId', v_t.project_id);
  perform set_config('projects.p8_sanctioned', 'on', true);
  insert into projects.support_handoff_requests (organization_id, ticket_id, target, reason, payload, requested_by, requested_by_agent) values (p_org, p_ticket, p_target, v_reason, v_payload, p_person, p_agent) returning id into v_id;
  perform core.record_audit(p_org, 'support_handoff.requested', 'support_ticket', p_ticket, null, jsonb_build_object('target', p_target, 'requestId', v_id, 'byAgent', p_agent), projects.p8g_correlation());
  return query select 'requested'::text, v_id;
end $$;
revoke all on function projects.p8g_handoff_request(uuid, uuid, text, uuid, text, text) from public, anon, authenticated, service_role;

create or replace function projects.request_ticket_handoff(p_ticket_id uuid, p_target text, p_reason text)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  return query select * from projects.p8g_handoff_request(v_org, v_actor, null, p_ticket_id, p_target, p_reason);
end $$;
revoke all on function projects.request_ticket_handoff(uuid, text, text) from public, anon, service_role;
grant execute on function projects.request_ticket_handoff(uuid, text, text) to authenticated;

create or replace function projects.request_ticket_handoff_as_agent(p_organization_id uuid, p_agent_key text, p_ticket_id uuid, p_target text, p_reason text)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid; return; end if;
  if p_agent_key is null or p_agent_key not in ('support', 'customer_success') then return query select 'not_a_support_or_customer_success_agent'::text, null::uuid; return; end if;
  return query select * from projects.p8g_handoff_request(p_organization_id, null, p_agent_key, p_ticket_id, p_target, p_reason);
end $$;
revoke all on function projects.request_ticket_handoff_as_agent(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function projects.request_ticket_handoff_as_agent(uuid, text, uuid, text, text) to service_role;

create or replace function projects.settle_ticket_handoff(p_request_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.support_handoff_requests; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision is null or p_decision not in ('acknowledged', 'completed', 'declined') then return query select 'bad_decision'::text; return; end if;
  select * into v_r from projects.support_handoff_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.status in ('completed', 'declined') then return query select 'already_settled'::text; return; end if;
  if p_decision = 'acknowledged' and v_r.status = 'acknowledged' then return query select 'already_acknowledged'::text; return; end if;
  if p_decision in ('completed', 'declined') and (v_note is null or length(v_note) < 5) then return query select 'note_required'::text; return; end if;
  if v_note is not null and projects.p7_has_secret(v_note) then return query select 'contains_secret'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  if p_decision = 'acknowledged' then
    update projects.support_handoff_requests set status = 'acknowledged' where id = v_r.id;
  else
    update projects.support_handoff_requests set status = p_decision, resolved_by = v_actor, resolved_at = clock_timestamp(), resolution_note = left(v_note, 1000) where id = v_r.id;
  end if;
  perform core.record_audit(v_org, 'support_handoff.' || p_decision, 'support_ticket', v_r.ticket_id, null, jsonb_build_object('requestId', v_r.id, 'target', v_r.target), projects.p8g_correlation());
  return query select p_decision::text;
end $$;
revoke all on function projects.settle_ticket_handoff(uuid, text, text) from public, anon, service_role;
grant execute on function projects.settle_ticket_handoff(uuid, text, text) to authenticated;

-- ── the next-action queue: derived, ordered by a fixed rank, stores nothing ─────────────────────────────────────────────────────────────────

create or replace function projects.cs_next_actions(p_now timestamptz default clock_timestamp())
returns table (action_kind text, rank int, project_id uuid, project_name text, client_account_id uuid, client_name text, subject_id uuid, detail text, due_at timestamptz, designation text)
language plpgsql stable security invoker set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  with items(action_kind, rank, project_id, client_account_id, subject_id, detail, due_at) as (
    select 'escalation_unacknowledged'::text, 1, t.project_id, t.client_account_id, t.id, (t.ticket_ref || ': ' || t.title || ' (escalated to ' || coalesce(t.escalated_to_role, 'a person') || ')')::text, t.escalated_at
      from projects.support_tickets t where t.organization_id = v_org and t.escalated_at is not null and t.escalation_ack_at is null and t.status not in ('closed', 'cancelled')
    union all
    select 'ticket_sla_breached', 2, t.project_id, t.client_account_id, t.id, (t.ticket_ref || ': ' || t.title)::text, coalesce(t.resolution_breached_at, t.response_breached_at)
      from projects.support_tickets t where t.organization_id = v_org and (t.response_breached_at is not null or t.resolution_breached_at is not null) and t.status not in ('closed', 'cancelled')
    union all
    select 'recovery_plan_open', 3, r.project_id, null::uuid, r.id, ('Recovery plan ' || r.status || case when r.deadline is null then ' - no deadline yet' else ' - deadline ' || r.deadline end)::text, r.deadline::timestamptz
      from projects.recovery_plans r where r.organization_id = v_org and r.status in ('open', 'in_progress')
    union all
    select 'negative_feedback_unacknowledged', 3, f.project_id, f.client_account_id, f.id, left(f.body, 140)::text, f.created_at
      from projects.client_feedback f where f.organization_id = v_org and f.sentiment = 'negative' and not exists (select 1 from projects.client_feedback_acknowledgements a where a.feedback_id = f.id)
    union all
    select 'ticket_awaiting_first_response', 4, t.project_id, t.client_account_id, t.id, (t.ticket_ref || ': ' || t.title)::text, t.response_due_at
      from projects.support_tickets t where t.organization_id = v_org and t.first_response_at is null and t.response_breached_at is null and t.status not in ('closed', 'cancelled')
    union all
    select 'check_in_due', 5, c.project_id, null::uuid, c.id, (c.kind || ' check-in')::text, c.due_on::timestamptz
      from projects.cs_check_ins c where c.organization_id = v_org and c.status = 'due' and c.due_on <= (p_now at time zone 'UTC')::date
    union all
    select 'renewal_review', 5, m.project_id, m.client_account_id, m.id, (m.name || ' (' || m.status || ')')::text, m.ends_on::timestamptz
      from projects.maintenance_plans m where m.organization_id = v_org and m.status in ('renewal_approaching', 'renewal_proposed', 'pending_client')
    union all
    select 'handoff_request_pending', 6, t.project_id, t.client_account_id, h.id, (h.target || ' requested for ' || t.ticket_ref)::text, h.requested_at
      from projects.support_handoff_requests h join projects.support_tickets t on t.id = h.ticket_id where h.organization_id = v_org and h.status = 'requested'
    union all
    select 'scope_reference_to_confirm', 6, t.project_id, t.client_account_id, s.id, (t.ticket_ref || ': ' || s.relation)::text, s.created_at
      from projects.ticket_scope_references s join projects.support_tickets t on t.id = s.ticket_id where s.organization_id = v_org and s.status = 'proposed'
    union all
    select 'client_action_overdue', 6, a.project_id, a.client_account_id, a.id, a.title::text, a.due_at
      from projects.p7c_client_action_requests a where a.organization_id = v_org and a.status = 'open' and a.due_at < p_now
    union all
    select 'opportunity_to_hand_off', 6, o.project_id, o.client_account_id, o.id, left(o.need, 140)::text, o.created_at
      from sales.phase_eight_opportunities o where o.organization_id = v_org and o.status = 'qualified'
    union all
    select 'opportunity_to_qualify', 7, o.project_id, o.client_account_id, o.id, left(o.need, 140)::text, o.created_at
      from sales.phase_eight_opportunities o where o.organization_id = v_org and o.status = 'detected'
  )
  select i.action_kind, i.rank, i.project_id, p.name, ca.id, ca.name, i.subject_id, i.detail, i.due_at, d.designation
    from items i
    left join projects.projects p on p.id = i.project_id
    join core.client_accounts ca on ca.id = coalesce(i.client_account_id, p.client_account_id) and ca.organization_id = v_org
    left join lateral (select dd.designation from projects.client_strategic_designations dd where dd.client_account_id = ca.id and dd.active order by dd.designation limit 1) d on true
   where i.project_id is null or exists (select 1 from projects.phase_eight w where w.project_id = i.project_id and w.state <> 'closed')
   order by i.rank, i.due_at nulls last, i.subject_id
   limit 300;
end $$;
revoke all on function projects.cs_next_actions(timestamptz) from public, anon, service_role;
grant execute on function projects.cs_next_actions(timestamptz) to authenticated;
comment on function projects.cs_next_actions(timestamptz) is
  'Derived next-action queue for Customer Success. Rank is a fixed ordinal by kind (1 escalation not acknowledged, 2 SLA breached, 3 recovery plan / negative feedback, 4 awaiting first response, 5 check-in / renewal, 6 requests and hand-offs, 7 opportunity to qualify), never a score. Stores nothing.';

notify pgrst, 'reload schema';
