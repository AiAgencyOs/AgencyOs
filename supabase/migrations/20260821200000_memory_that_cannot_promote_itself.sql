-- ═══════════════════════════════════════════════════════════════════════════
-- Memory that cannot promote itself.
--
-- Document 05 — AI Agent Memory & Context System — is thirteen pages and had
-- **no tables at all**. Doc 21 §41 names `memory_records` among the canonical
-- entities; nothing created it.
--
-- What existed instead is the thing Doc 05 §1 says memory must not be confused
-- with: authoritative business state. Leads, conversations, requirement
-- versions, approvals and payments are all recorded, and they are the truth.
-- Memory is the layer that lets an agent *find and use* that truth without
-- re-reading everything — and, crucially, the layer where a model's guess can
-- turn into a client fact if nobody stops it.
--
-- ── the rule this table exists to make true ──────────────────────────────
--
-- Doc 05 §35: **"Never store a model-generated assumption as a verified client
-- fact without provenance."** And §18 defines what the words mean:
--
--   EXPLICIT   directly stated by client, Admin or system
--   VERIFIED   confirmed by an authoritative business process
--   INFERRED   model-derived and not directly confirmed
--   TEMPORARY  useful only for the current task or stage
--   STALE      previously valid, due for review
--   CONFLICTED multiple sources disagree
--
-- followed by the sentence that makes it a rule rather than a taxonomy:
-- *"Only EXPLICIT/VERIFIED information should normally drive important
-- business decisions without additional validation."*
--
-- So two constraints, both structural:
--
--   1. **explicit and verified require provenance.** A fact claiming to come
--      from somewhere must say where. A row with no source cannot claim to be
--      anything better than an inference.
--
--   2. **an agent may not write `verified`.** Verification is an authoritative
--      business process, and an agent confirming its own inference is the
--      memory version of a producer verifying its own work — the thing ADM-82
--      forbids everywhere else in this system. An agent-authored row is capped
--      at `inferred`.
--
-- Neither is a prompt instruction. Doc 19 §38 is explicit that authority must
-- not be reachable through language, and a memory row is language.
--
-- ── history, not overwriting ─────────────────────────────────────────────
--
-- Doc 05 §32: *"Do not overwrite an important fact without preserving
-- history."* A correction supersedes; it does not edit. `superseded_by` makes
-- the chain readable, and a superseded row is never returned by recall.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists ai.memory_records (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,

  -- Doc 05 §22's visibility model, as a column. A memory belongs to exactly
  -- one scope, and retrieval is filtered by it — Doc 21 §27: "retrieval must
  -- apply the same authorization scope as the underlying data."
  scope           text not null
                    check (scope in ('organization', 'client', 'project', 'agent', 'task')),
  -- Null only for organization scope, where the organization_id IS the subject.
  scope_id        uuid,

  -- What kind of fact this is. Deliberately open text rather than an enum:
  -- Doc 05 lists categories per agent and per stage, and a closed vocabulary
  -- here would have to be widened by migration every time a new agent needs a
  -- new kind of note.
  kind            text not null check (length(trim(kind)) > 0),

  fact            text not null check (length(trim(fact)) > 0),

  confidence      text not null default 'inferred'
                    check (confidence in
                      ('explicit', 'verified', 'inferred', 'temporary', 'stale', 'conflicted')),

  -- Provenance. Doc 05 §17: "Store source/evidence for important memories."
  -- `source_kind` names the table or event class; `source_id` the row.
  source_kind     text,
  source_id       uuid,

  -- Who wrote it. An agent key, or null when a human or the system did.
  authored_by_agent text references ai.agents(key) on delete set null,
  created_by      uuid,

  -- Doc 05 §17: "Support memory expiration/review for facts that can change."
  review_at       timestamptz,
  expires_at      timestamptz,

  -- A correction supersedes rather than edits (Doc 05 §32).
  superseded_by   uuid references ai.memory_records(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Organization scope is the organization; every other scope names its subject.
  constraint memory_scope_id_matches_scope
    check ((scope = 'organization') = (scope_id is null)),

  -- 1. A claim to come from somewhere must say where.
  constraint memory_claimed_provenance_is_recorded
    check (confidence not in ('explicit', 'verified')
           or (source_kind is not null and source_id is not null)),

  -- 2. An agent may not confirm its own inference. Verification is an
  --    authoritative business process, not a thing a model decides it did.
  constraint memory_agent_cannot_verify
    check (authored_by_agent is null or confidence <> 'verified'),

  -- A row cannot supersede itself into a loop of length one.
  constraint memory_not_self_superseding
    check (superseded_by is null or superseded_by <> id)
);

create index if not exists memory_records_scope_idx
  on ai.memory_records (organization_id, scope, scope_id, created_at desc)
  where superseded_by is null;

create index if not exists memory_records_review_idx
  on ai.memory_records (organization_id, review_at)
  where superseded_by is null and review_at is not null;

comment on table ai.memory_records is
  'The context layer over authoritative state (Doc 05). Two rules are structural rather than advisory: a memory claiming explicit or verified confidence must carry provenance (Doc 05 §35), and an AGENT may never write `verified` - confirmation is an authoritative business process, and an agent confirming its own inference is the memory version of a producer verifying its own work. Corrections supersede rather than overwrite (Doc 05 §32).';

comment on column ai.memory_records.confidence is
  'Doc 05 §18. "Only EXPLICIT/VERIFIED information should normally drive important business decisions without additional validation." The two constraints on this table are what stop a model-derived guess from arriving in that category.';

-- ── superseding is a one-way door ────────────────────────────────────────
--
-- Without this, a correction can be un-corrected by clearing one column, and
-- the history Doc 05 §32 asks for is a field somebody can blank.

create or replace function ai.refuse_memory_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a memory is superseded, never deleted (Doc 05 §32)'
      using errcode = 'check_violation';
  end if;

  if old.superseded_by is not null then
    if new.superseded_by is distinct from old.superseded_by then
      raise exception 'a superseded memory stays superseded (Doc 05 §32)'
        using errcode = 'check_violation';
    end if;

    if new.fact is distinct from old.fact
       or new.confidence is distinct from old.confidence
       or new.source_kind is distinct from old.source_kind
       or new.source_id   is distinct from old.source_id then
      raise exception 'a superseded memory is history; write a new one instead (Doc 05 §32)'
        using errcode = 'check_violation';
    end if;
  end if;

  -- An agent cannot raise its own row's confidence after the fact either. The
  -- CHECK covers `verified`; this covers the walk upward through the others.
  if old.authored_by_agent is not null
     and new.confidence = 'explicit' and old.confidence <> 'explicit' then
    raise exception 'an agent-authored memory cannot become explicit; a client or Admin states a fact, an agent infers one'
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists refuse_memory_rewrite on ai.memory_records;
create trigger refuse_memory_rewrite
  before update or delete on ai.memory_records
  for each row execute function ai.refuse_memory_rewrite();

-- ── recall, scoped ───────────────────────────────────────────────────────
--
-- Doc 05 §19: "Agents should receive relevant context dynamically rather than
-- dumping all historical information into every model call." And Doc 21 §27
-- makes the boundary explicit: retrieval applies the same authorization scope
-- as the underlying data.
--
-- SECURITY INVOKER on purpose. The RLS policy below is the authorization, and
-- a definer function here would be a way around it — which is exactly the
-- class `db:verify:invokerrls` exists to catch.

create or replace function ai.recall(
  p_scope    text,
  p_scope_id uuid default null,
  p_limit    int  default 50
)
returns setof ai.memory_records
language sql
stable
security invoker
set search_path = ''
as $$
  select m.*
    from ai.memory_records m
   where m.scope = p_scope
     and m.scope_id is not distinct from p_scope_id
     and m.superseded_by is null
     and (m.expires_at is null or m.expires_at > now())
   order by
     -- Doc 05 §18's ordering, as an ordering. What a client actually said
     -- outranks what a process confirmed, which outranks what a model guessed.
     case m.confidence
       when 'explicit'   then 0
       when 'verified'   then 1
       when 'conflicted' then 2
       when 'inferred'   then 3
       when 'temporary'  then 4
       when 'stale'      then 5
       else 6
     end,
     m.created_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

comment on function ai.recall(text, uuid, int) is
  'Relevant memory for one scope, newest first within confidence order - what a client said outranks what a process confirmed, which outranks what a model guessed (Doc 05 §18). Superseded and expired rows are never returned. SECURITY INVOKER: the RLS policy is the authorization, and a definer function here would be a way around it.';

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table ai.memory_records enable row level security;
alter table ai.memory_records force row level security;

drop policy if exists memory_records_select on ai.memory_records;
create policy memory_records_select on ai.memory_records
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_memory_records_agent on ai.memory_records;
create trigger org_match_memory_records_agent
  before insert or update of superseded_by, organization_id on ai.memory_records
  for each row execute function core.enforce_parent_org('superseded_by', 'ai.memory_records');

drop trigger if exists freeze_org_memory_records on ai.memory_records;
create trigger freeze_org_memory_records
  before update of organization_id on ai.memory_records
  for each row execute function core.freeze_organization_id();

notify pgrst, 'reload schema';
