-- ═══════════════════════════════════════════════════════════════════════════
-- A requirement has nine sections, and a question is asked alone.
--
-- Bucket G, stream G-3 — SCR-029 (Requirement Set / Detail) of the screen
-- architecture. Three of the PDF's rows were still PARTIAL on the lead's
-- requirement panel:
--
--   • "Request client clarification" existed only as a WHOLE-VERSION send
--     (`crm.send_requirement_for_confirmation`, 20260904160000): the client
--     was shown the summary and every open question at once, and nothing
--     recorded which question they had been asked. The PDF lists Questions
--     as a section and the clarification as an action on it, so a single
--     open question can now be put in front of the client on its own —
--     through the SAME outbound chokepoint (`crm.send_outbound_message`:
--     consent, the 24-hour window, the kill switch, the idempotency key) —
--     and the version remembers which question went out, when, and in
--     which message. `crm.requirement_question_sends` holds that record;
--     the payload itself stays immutable (`crm.requirement_versions_guard`
--     permits status and nothing else), so the record is a row beside the
--     version rather than a rewrite of it.
--
--   • "Link to quotation/design/development task" was a read-only
--     "Cited by" list derived from foreign keys other tables carry. A person
--     could not say "this requirement is what that quotation prices" unless
--     the quotation happened to be drafted from it. `crm.requirement_links`
--     is that statement, made by a person through `crm.link_requirement`,
--     unique per (version, target), audited as `requirement.linked`. "Cited
--     by" stays as the derived list; "Linked to" is the declared one.
--
--   • Objectives, User roles, Platforms, Integrations, Business rules and
--     Non-functional requirements are jsonb keys on the version's payload
--     (`requirementPayloadSchema` in src/modules/crm/schema.ts) — no DDL,
--     because the payload has never had a database-side shape check beyond
--     "an object with a summary". Older versions keep `constraints`; the
--     panel renders it under Business rules and says so.
--
-- Both tables are org-scoped, RLS enabled and forced, internal select, a
-- role-named INSERT policy (owner and ops_admin — the same two roles
-- crm.requirement_versions' UPDATE policy admits, 20260810120003), grants,
-- `core.enforce_parent_org` for every FK to an org-scoped table, a frozen
-- organization_id, and every governed write audits through
-- core.record_audit in its own transaction. Every guard is coalesced (G-281).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── a question asked on its own ─────────────────────────────────────────────

create table if not exists crm.requirement_question_sends (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references core.organizations(id) on delete cascade,
  requirement_version_id  uuid not null references crm.requirement_versions(id) on delete cascade,
  -- The position of the question in the version's `openQuestions` payload
  -- array at the time it was sent, and the text, so a later reader does not
  -- have to trust the index alone.
  question_index          int  not null check (question_index >= 0),
  question                text not null check (length(trim(question)) > 0 and length(question) <= 500),
  conversation_id         uuid not null references crm.conversations(id) on delete cascade,
  message_id              uuid not null references crm.conversation_messages(id) on delete cascade,
  sent_by                 uuid references core.users(id) on delete set null,
  sent_at                 timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- One send per question per version: the second press finds the row.
  constraint requirement_question_sends_once unique (requirement_version_id, question_index)
);

comment on table crm.requirement_question_sends is
  'SCR-029: one open question of a requirement version put in front of the client on its own, through crm.send_outbound_message. Records which question (index and text), when, by whom and in which message. The payload itself is never rewritten.';

create index if not exists requirement_question_sends_org_version_idx
  on crm.requirement_question_sends (organization_id, requirement_version_id);

drop trigger if exists set_updated_at on crm.requirement_question_sends;
create trigger set_updated_at before update on crm.requirement_question_sends
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_requirement_question_sends on crm.requirement_question_sends;
create trigger freeze_org_requirement_question_sends
  before update of organization_id on crm.requirement_question_sends
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_requirement_question_sends_version on crm.requirement_question_sends;
create trigger org_match_requirement_question_sends_version
  before insert or update of requirement_version_id, organization_id on crm.requirement_question_sends
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');

drop trigger if exists org_match_requirement_question_sends_conversation on crm.requirement_question_sends;
create trigger org_match_requirement_question_sends_conversation
  before insert or update of conversation_id, organization_id on crm.requirement_question_sends
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists org_match_requirement_question_sends_message on crm.requirement_question_sends;
create trigger org_match_requirement_question_sends_message
  before insert or update of message_id, organization_id on crm.requirement_question_sends
  for each row execute function core.enforce_parent_org('message_id', 'crm.conversation_messages');

alter table crm.requirement_question_sends enable row level security;
alter table crm.requirement_question_sends force row level security;

drop policy if exists requirement_question_sends_select on crm.requirement_question_sends;
create policy requirement_question_sends_select on crm.requirement_question_sends
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- Owner and ops_admin: the two roles that may decide a requirement version
-- (requirement_versions_update, 20260810120003). The only door is
-- crm.send_requirement_question below; the policy is what lets its insert
-- through under SECURITY INVOKER.
drop policy if exists requirement_question_sends_insert_by_admin on crm.requirement_question_sends;
create policy requirement_question_sends_insert_by_admin on crm.requirement_question_sends
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

grant select, insert on crm.requirement_question_sends to authenticated, service_role;

create or replace function crm.send_requirement_question(
  p_version_id     uuid,
  p_question_index int,
  p_question       text,
  p_body           text
)
returns table (
  -- 'sent' | 'already_sent'
  -- refusals: 'no_actor' | 'forbidden' | 'not_found' | 'not_open' | 'question_mismatch'
  --           | whatever crm.send_outbound_message answered ('no_consent', 'outbound_paused', …)
  outcome    text,
  message_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor    uuid := (select auth.uid());
  v_row      crm.requirement_versions;
  v_existing crm.requirement_question_sends;
  v_stored   text;
  v_sent     record;
  v_id       uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- Under RLS: a version in another organisation is absent, not forbidden.
  select v.* into v_row
    from crm.requirement_versions v
   where v.id = p_version_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  -- A question is asked on a version that still stands. A superseded,
  -- rejected or failed version is history; its questions are not the
  -- client's to answer any more.
  if v_row.status not in ('proposed', 'accepted') then
    return query select 'not_open'::text, null::uuid; return;
  end if;

  -- The question the caller names must be the question the version holds at
  -- that index. The panel and the door read the same payload, so a mismatch
  -- means the version changed under the form — refused, not sent.
  v_stored := v_row.payload -> 'openQuestions' ->> p_question_index;
  if v_stored is null or btrim(v_stored) <> btrim(coalesce(p_question, '')) then
    return query select 'question_mismatch'::text, null::uuid; return;
  end if;

  -- An early exit, and NOT the control: the idempotency key handed to
  -- send_outbound_message below is derived from the version and the index,
  -- so a second press without this branch still sends once. This returns
  -- the message the client actually has.
  select s.* into v_existing
    from crm.requirement_question_sends s
   where s.requirement_version_id = p_version_id
     and s.question_index = p_question_index;
  if v_existing.id is not null then
    return query select 'already_sent'::text, v_existing.message_id; return;
  end if;

  -- Through the chokepoint, never around it: consent (ADM-70), the 24-hour
  -- window and template rule, the outbound kill switch, the sequence and
  -- the idempotency key are all its.
  select * into v_sent
    from crm.send_outbound_message(
      v_row.conversation_id,
      p_body,
      'requirement:' || p_version_id::text || ':q' || p_question_index::text,
      v_actor
    );

  if v_sent.outcome is distinct from 'created' or v_sent.message_id is null then
    return query select coalesce(v_sent.outcome, 'not_sent')::text, v_sent.message_id; return;
  end if;

  insert into crm.requirement_question_sends (
    organization_id, requirement_version_id, question_index, question, conversation_id, message_id, sent_by
  ) values (
    v_row.organization_id, p_version_id, p_question_index, btrim(p_question), v_row.conversation_id, v_sent.message_id, v_actor
  )
  returning id into v_id;

  perform core.record_audit(
    v_row.organization_id, 'requirement.question_sent', 'requirement_version', p_version_id,
    null,
    jsonb_build_object(
      'sendId', v_id,
      'version', v_row.version,
      'questionIndex', p_question_index,
      'question', btrim(p_question),
      'messageId', v_sent.message_id,
      'conversationId', v_row.conversation_id
    ),
    null
  );

  return query select 'sent'::text, v_sent.message_id;
end;
$$;

comment on function crm.send_requirement_question(uuid, int, text, text) is
  'SCR-029: puts ONE open question of a requirement version in front of the client, through crm.send_outbound_message (consent, window, kill switch, idempotency key all the chokepoint''s), and records it in crm.requirement_question_sends. Owner or ops_admin; SECURITY INVOKER so RLS decides again; audited as requirement.question_sent. It does not read the reply.';

revoke all on function crm.send_requirement_question(uuid, int, text, text) from public, anon;
grant execute on function crm.send_requirement_question(uuid, int, text, text) to authenticated, service_role;

-- ── a link a person declares ────────────────────────────────────────────────
--
-- One row per (version, target). A target is one of three org-scoped tables,
-- so it is three nullable FK columns with exactly one set — a single
-- polymorphic id could carry no foreign key and no tenancy trigger — plus a
-- generated `target_id` so the uniqueness is one index over one column.

create table if not exists crm.requirement_links (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references core.organizations(id) on delete cascade,
  requirement_version_id  uuid not null references crm.requirement_versions(id) on delete cascade,
  target_type             text not null check (target_type in ('quotation', 'design', 'task')),
  quotation_id            uuid references sales.proposals(id) on delete cascade,
  deliverable_id          uuid references projects.deliverables(id) on delete cascade,
  task_id                 uuid references projects.tasks(id) on delete cascade,
  target_id               uuid generated always as (coalesce(quotation_id, deliverable_id, task_id)) stored,
  note                    text check (note is null or length(note) <= 500),
  linked_by               uuid references core.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint requirement_links_one_target check (
    (target_type = 'quotation' and quotation_id is not null and deliverable_id is null and task_id is null)
    or (target_type = 'design' and deliverable_id is not null and quotation_id is null and task_id is null)
    or (target_type = 'task' and task_id is not null and quotation_id is null and deliverable_id is null)
  ),
  constraint requirement_links_unique_per_triple unique (requirement_version_id, target_type, target_id)
);

comment on table crm.requirement_links is
  'SCR-029: a link a person declared between a requirement version and a quotation (sales.proposals), a design deliverable (projects.deliverables, kind design or prototype) or a development task (projects.tasks). Written only through crm.link_requirement; unique per (version, target type, target); audited as requirement.linked. The derived "Cited by" list is a different thing and stays derived.';

create index if not exists requirement_links_org_version_idx
  on crm.requirement_links (organization_id, requirement_version_id);

drop trigger if exists set_updated_at on crm.requirement_links;
create trigger set_updated_at before update on crm.requirement_links
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_requirement_links on crm.requirement_links;
create trigger freeze_org_requirement_links
  before update of organization_id on crm.requirement_links
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_requirement_links_version on crm.requirement_links;
create trigger org_match_requirement_links_version
  before insert or update of requirement_version_id, organization_id on crm.requirement_links
  for each row execute function core.enforce_parent_org('requirement_version_id', 'crm.requirement_versions');

drop trigger if exists org_match_requirement_links_quotation on crm.requirement_links;
create trigger org_match_requirement_links_quotation
  before insert or update of quotation_id, organization_id on crm.requirement_links
  for each row execute function core.enforce_parent_org('quotation_id', 'sales.proposals');

drop trigger if exists org_match_requirement_links_deliverable on crm.requirement_links;
create trigger org_match_requirement_links_deliverable
  before insert or update of deliverable_id, organization_id on crm.requirement_links
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');

drop trigger if exists org_match_requirement_links_task on crm.requirement_links;
create trigger org_match_requirement_links_task
  before insert or update of task_id, organization_id on crm.requirement_links
  for each row execute function core.enforce_parent_org('task_id', 'projects.tasks');

alter table crm.requirement_links enable row level security;
alter table crm.requirement_links force row level security;

drop policy if exists requirement_links_select on crm.requirement_links;
create policy requirement_links_select on crm.requirement_links
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists requirement_links_insert_by_admin on crm.requirement_links;
create policy requirement_links_insert_by_admin on crm.requirement_links
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

grant select, insert on crm.requirement_links to authenticated, service_role;

create or replace function crm.link_requirement(
  p_requirement_version_id uuid,
  p_target_type            text,
  p_target_id              uuid,
  p_note                   text default null
)
returns table (
  -- 'linked' | 'already_linked'
  -- refusals: 'no_actor' | 'forbidden' | 'not_found' | 'bad_target_type' | 'target_not_found'
  outcome text,
  link_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor    uuid := (select auth.uid());
  v_row      crm.requirement_versions;
  v_existing uuid;
  v_target   uuid;
  v_id       uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if p_target_type is null or p_target_type not in ('quotation', 'design', 'task') then
    return query select 'bad_target_type'::text, null::uuid; return;
  end if;

  select v.* into v_row from crm.requirement_versions v where v.id = p_requirement_version_id;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  -- The target must be visible under RLS — the same organisation — and, for
  -- a design, must actually be a design or prototype deliverable.
  if p_target_type = 'quotation' then
    select p.id into v_target from sales.proposals p where p.id = p_target_id;
  elsif p_target_type = 'design' then
    select d.id into v_target from projects.deliverables d where d.id = p_target_id and d.kind in ('design', 'prototype');
  else
    select t.id into v_target from projects.tasks t where t.id = p_target_id;
  end if;
  if v_target is null then
    return query select 'target_not_found'::text, null::uuid; return;
  end if;

  select l.id into v_existing
    from crm.requirement_links l
   where l.requirement_version_id = p_requirement_version_id
     and l.target_type = p_target_type
     and l.target_id = p_target_id;
  if v_existing is not null then
    return query select 'already_linked'::text, v_existing; return;
  end if;

  insert into crm.requirement_links (
    organization_id, requirement_version_id, target_type, quotation_id, deliverable_id, task_id, note, linked_by
  ) values (
    v_row.organization_id,
    p_requirement_version_id,
    p_target_type,
    case when p_target_type = 'quotation' then p_target_id end,
    case when p_target_type = 'design'    then p_target_id end,
    case when p_target_type = 'task'      then p_target_id end,
    nullif(btrim(coalesce(p_note, '')), ''),
    v_actor
  )
  returning id into v_id;

  perform core.record_audit(
    v_row.organization_id, 'requirement.linked', 'requirement_version', p_requirement_version_id,
    null,
    jsonb_build_object(
      'linkId', v_id,
      'version', v_row.version,
      'targetType', p_target_type,
      'targetId', p_target_id,
      'note', nullif(btrim(coalesce(p_note, '')), '')
    ),
    null
  );

  return query select 'linked'::text, v_id;
end;
$$;

comment on function crm.link_requirement(uuid, text, uuid, text) is
  'SCR-029: a person links a requirement version to a quotation, a design deliverable or a development task. Owner or ops_admin; the target must be visible under RLS (same organisation); one row per (version, target); audited as requirement.linked. SECURITY INVOKER, so RLS decides again.';

revoke all on function crm.link_requirement(uuid, text, uuid, text) from public, anon;
grant execute on function crm.link_requirement(uuid, text, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
