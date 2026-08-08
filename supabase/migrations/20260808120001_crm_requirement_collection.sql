-- ═══════════════════════════════════════════════════════════════════════════
-- 012 — crm: requirement collection (conversations, messages, requirements)
--
-- Backs Feature 6 (AI Requirement Collection), which migration 004 already
-- named as a consumer of the crm schema. The `requirement_collector` agent is
-- already registered in ai.agents by the seed; this migration gives it
-- somewhere to read from and somewhere to write to.
--
-- Why these are new tables rather than reuse:
--   • crm.lead_activities is a mixed lead timeline (notes, status changes,
--     assignments). It has no thread grouping, no intra-thread ordering, and
--     no channel, so it cannot serve as a transcript. It is left untouched.
--   • crm.leads.requirements is a single unversioned jsonb blob, documented as
--     "schema-on-read for now". It is left untouched; requirement_versions is
--     the versioned successor and the two do not fight over one row.
--
-- Vocabularies are reused verbatim rather than reinvented:
--   • conversations.channel  ⊂ crm.leads.source
--   • conversation_messages.author_type = crm.lead_activities.actor_type
--   • requirement_versions   mirrors sales.proposals: `version` + unique
--     (parent, version) + an FK-less `generated_by_run_id`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── conversations ─────────────────────────────────────────────────────────
create table if not exists crm.conversations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  lead_id            uuid not null references crm.leads(id) on delete cascade,
  -- Denormalised from the lead so a conversation can name the specific person
  -- spoken to, which may differ from the lead's primary contact.
  contact_id         uuid references crm.contacts(id) on delete set null,

  channel            text not null default 'manual' check (channel in
                       ('manual', 'whatsapp', 'web_form', 'email')),

  status             text not null default 'active' check (status in
                       ('active', 'completed', 'abandoned')),

  -- Provider-side thread id (e.g. WhatsApp conversation id) for ingest
  -- idempotency. Mirrors crm.leads.source_ref.
  external_ref       text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists conversations_organization_status_idx
  on crm.conversations (organization_id, status, created_at desc);
create index if not exists conversations_lead_idx
  on crm.conversations (lead_id, created_at desc);
create index if not exists conversations_contact_idx
  on crm.conversations (contact_id) where contact_id is not null;

-- Ingest idempotency: one conversation per provider thread per channel.
create unique index if not exists conversations_external_ref_key
  on crm.conversations (organization_id, channel, external_ref)
  where external_ref is not null;

comment on table crm.conversations is
  'A requirement-gathering thread with a lead. The transcript lives in crm.conversation_messages; extracted requirements in crm.requirement_versions.';

-- ── conversation_messages ─────────────────────────────────────────────────
create table if not exists crm.conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  conversation_id  uuid not null references crm.conversations(id) on delete cascade,

  -- Ordering within the thread. Explicit rather than timestamp-derived so two
  -- messages in the same millisecond still have a defined order. Mirrors
  -- ai.agent_steps.seq.
  seq              int not null check (seq >= 0),

  -- Same vocabulary as crm.lead_activities.actor_type: 'client' is the
  -- customer, 'user' a staff member, 'agent' the AI.
  author_type      text not null check (author_type in ('user', 'agent', 'system', 'client')),
  author_id        uuid,

  body             text not null check (length(trim(body)) > 0),

  -- Room for future AI processing (token counts, extraction markers, provider
  -- message ids) without a migration per field.
  metadata         jsonb not null default '{}'::jsonb,

  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  unique (conversation_id, seq)
);

create index if not exists conversation_messages_thread_idx
  on crm.conversation_messages (conversation_id, seq);
create index if not exists conversation_messages_organization_idx
  on crm.conversation_messages (organization_id, occurred_at desc);

comment on table crm.conversation_messages is
  'Append-only transcript. There is deliberately no UPDATE or DELETE policy: a record of what a customer actually said is not something the app should be able to rewrite.';

-- ── requirement_versions ──────────────────────────────────────────────────
create table if not exists crm.requirement_versions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  conversation_id     uuid not null references crm.conversations(id) on delete cascade,

  version             int not null check (version > 0),

  source              text not null check (source in ('agent', 'human')),

  -- The requirement_collector agent is L1 (propose), so an extraction lands as
  -- 'proposed' and a human decides. Editing means inserting the next version,
  -- not mutating this row — see the guard trigger below.
  status              text not null default 'proposed' check (status in
                        ('proposed', 'accepted', 'rejected', 'superseded')),

  payload             jsonb not null default '{}'::jsonb,

  -- Set when an AI agent produced it; null when a human wrote it. FK-less by
  -- the same reasoning as sales.proposals.generated_by_run_id: crm should not
  -- take a hard dependency on the ai schema.
  generated_by_run_id uuid,
  created_by          uuid,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (conversation_id, version)
);

create index if not exists requirement_versions_conversation_idx
  on crm.requirement_versions (conversation_id, version desc);
create index if not exists requirement_versions_organization_idx
  on crm.requirement_versions (organization_id, created_at desc);
create index if not exists requirement_versions_status_idx
  on crm.requirement_versions (organization_id, status, created_at desc);

comment on table crm.requirement_versions is
  'Structured requirements extracted from a conversation. Append-only history: a correction is version N+1, so what the agent originally proposed stays auditable.';

-- ── triggers ──────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['conversations','requirement_versions']
  loop
    execute format('drop trigger if exists set_updated_at on crm.%I', t);
    execute format(
      'create trigger set_updated_at before update on crm.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- Versioning is only real if the versioned bytes cannot be edited in place.
create or replace function crm.requirement_versions_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organization_id     is distinct from old.organization_id
     or new.conversation_id  is distinct from old.conversation_id
     or new.version          is distinct from old.version
     or new.source           is distinct from old.source
     or new.payload          is distinct from old.payload
     or new.generated_by_run_id is distinct from old.generated_by_run_id
     or new.created_by       is distinct from old.created_by
     or new.created_at       is distinct from old.created_at
  then
    raise exception
      'crm.requirement_versions is append-only except for status; insert version % instead',
      old.version + 1
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists requirement_versions_guard on crm.requirement_versions;
create trigger requirement_versions_guard
  before update on crm.requirement_versions
  for each row execute function crm.requirement_versions_guard();

-- ── RLS: internal staff only, same shape as the rest of crm ───────────────
alter table crm.conversations         enable row level security;
alter table crm.conversation_messages enable row level security;
alter table crm.requirement_versions  enable row level security;

drop policy if exists conversations_select on crm.conversations;
create policy conversations_select on crm.conversations
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists conversations_write on crm.conversations;
create policy conversations_write on crm.conversations
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

drop policy if exists conversation_messages_select on crm.conversation_messages;
create policy conversation_messages_select on crm.conversation_messages
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

-- Insert only. See the table comment: the transcript is not rewritable.
drop policy if exists conversation_messages_insert on crm.conversation_messages;
create policy conversation_messages_insert on crm.conversation_messages
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write()));

drop policy if exists requirement_versions_select on crm.requirement_versions;
create policy requirement_versions_select on crm.requirement_versions
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists requirement_versions_insert on crm.requirement_versions;
create policy requirement_versions_insert on crm.requirement_versions
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write()));

-- UPDATE is permitted so a human can accept/reject/supersede a proposal. The
-- guard trigger above is what keeps that from becoming an in-place edit.
drop policy if exists requirement_versions_update on crm.requirement_versions;
create policy requirement_versions_update on crm.requirement_versions
  for update to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_write()));

-- ── Enqueueing an extraction ──────────────────────────────────────────────
-- core.jobs had no INSERT policy: jobs were runner-written only. Requirement
-- extraction is user-initiated, so internal staff need to enqueue exactly one
-- kind of job for their own organization — and nothing else. The `kind`
-- predicate is the point of this policy, not incidental to it.
drop policy if exists jobs_insert_requirement_extract on core.jobs;
create policy jobs_insert_requirement_extract on core.jobs
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.can_write())
              and kind = 'requirement.extract');
