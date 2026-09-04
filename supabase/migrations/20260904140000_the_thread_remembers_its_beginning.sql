-- ═══════════════════════════════════════════════════════════════════════════
-- The thread remembers its beginning — G-198 (Doc 05 §6, audit LM-07)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The sales agent answers a client with the conversation in front of it, read
-- straight out of `crm.conversation_messages`. That is the right shape and it
-- had two failures at the ends of it.
--
-- ── the one that is a bug ─────────────────────────────────────────────────
--
-- The read is `order('seq', ascending).limit(1000)`, which takes the FIRST
-- thousand messages. Past a thousand the agent is handed the beginning of the
-- thread and never sees the end of it — including the message it was queued
-- to answer. Silent, and total: it would reply to a conversation whose last
-- two hundred turns it cannot see. No thread here has reached that length
-- yet, which is why nothing has caught it, and "not yet" is the only thing
-- standing between this and a client being answered from a year-old context.
--
-- ── the one Doc 05 §6 names ───────────────────────────────────────────────
--
-- Even fixed, a window is a window: a long negotiation loses its beginning,
-- which is where the client said what they were trying to build and why. §6
-- asks for a rolling summary so the earlier part of a conversation survives
-- the window rather than falling out of it.
--
-- ── what a summary is here, and what it is not ────────────────────────────
--
-- It is INTERNAL CONTEXT and nothing else. It is never sent, never shown to a
-- client, and it is not a record of fact: it is one model's reading of a
-- conversation, which is exactly why it carries `through_seq` — the point up
-- to which it read. Everything after that point the agent reads for itself,
-- verbatim, out of the messages. So the summary can only ever be wrong about
-- the distant past, and the recent past — the part a reply actually turns on
-- — is never summarised at all.
--
-- One row per conversation, replaced as the thread grows. Not a history of
-- summaries: nobody would read the third-newest, and a table that grows a row
-- per message is a table that costs more than the feature.

create table if not exists crm.conversation_summaries (
  conversation_id  uuid primary key references crm.conversations(id) on delete cascade,
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Bounded, and the bound is the point: a summary as long as the thread is
  -- not a summary. Four thousand characters is roughly a page.
  summary          text not null check (length(btrim(summary)) between 1 and 4000),

  -- The last message this summary has read. Everything after it is handed to
  -- the agent verbatim, so this number is what keeps the two halves from
  -- either overlapping or leaving a hole.
  through_seq      int not null check (through_seq >= 0),

  written_by_agent text references ai.agents(key),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table crm.conversation_summaries is
  'Doc 05 section 6''s rolling conversation summary: what happened in this thread BEFORE the window the agent reads verbatim. Internal context, never sent and never shown to a client. One row per conversation, replaced as the thread grows - nobody reads the third-newest summary.';

comment on column crm.conversation_summaries.through_seq is
  'The last message sequence this summary has read. Everything after it reaches the agent verbatim, so this is what keeps the summarised half and the read half from overlapping or leaving a hole.';

create index if not exists conversation_summaries_org_idx
  on crm.conversation_summaries (organization_id, updated_at desc);

-- ── tenancy, the pair every org-scoped table in this schema carries ───────

alter table crm.conversation_summaries enable row level security;
alter table crm.conversation_summaries force row level security;

drop policy if exists conversation_summaries_select on crm.conversation_summaries;
create policy conversation_summaries_select on crm.conversation_summaries
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_conversation_summaries on crm.conversation_summaries;
create trigger org_match_conversation_summaries
  before insert or update of conversation_id, organization_id on crm.conversation_summaries
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists freeze_org_conversation_summaries on crm.conversation_summaries;
create trigger freeze_org_conversation_summaries
  before update of organization_id on crm.conversation_summaries
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on crm.conversation_summaries;
create trigger set_updated_at
  before update on crm.conversation_summaries
  for each row execute function core.set_updated_at();

-- ── a summary only ever moves forward ─────────────────────────────────────
--
-- Two jobs can run for one conversation — a retry and a later message — and
-- the older one finishing second would replace a summary that has read more
-- of the thread with one that has read less. The agent would then be handed a
-- summary claiming to cover everything up to message 90 while the window
-- starts at 120, and the thirty messages between would exist nowhere.
--
-- Refused rather than ordered around: the loser writes nothing and its job
-- reports success, because a summary that is already better is not a failure.

create or replace function crm.summary_only_moves_forward()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.through_seq < old.through_seq then
    raise exception 'a summary that has read less of the thread cannot replace one that has read more (% < %)',
      new.through_seq, old.through_seq
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists summary_only_moves_forward on crm.conversation_summaries;
create trigger summary_only_moves_forward
  before update on crm.conversation_summaries
  for each row execute function crm.summary_only_moves_forward();

grant select on crm.conversation_summaries to authenticated;
grant select, insert, update on crm.conversation_summaries to service_role;

notify pgrst, 'reload schema';
