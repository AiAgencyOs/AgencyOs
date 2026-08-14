-- ═══════════════════════════════════════════════════════════════════════════
-- A sequence that cannot send twice.
--
-- Gap G-012, decision ADM-69. The state a follow-up sequence lives in, and the
-- constraints that make its guarantees structural rather than careful.
--
-- ── the guarantee this exists for ────────────────────────────────────────
--
-- ADM-69 requires idempotency, and "no duplicate client messages" is the one
-- promise that cannot be kept by a well-written handler. Two workers claiming
-- the same row a second apart both compute the same attempt number and both
-- believe they are first. A check-then-write loses that race every time it is
-- run often enough, and a follow-up scheduler runs every minute forever.
--
-- So the attempt is a **unique row**. `follow_up_sends` has
-- `unique (sequence_id, attempt)`, and a second worker inserting attempt 3
-- fails on the constraint rather than on a comparison it lost. The insert is
-- the claim.
--
-- ── one sequence per subject per situation ───────────────────────────────
--
-- `unique (organization_id, situation_key, subject_type, subject_id)`. Without
-- it, two observations of the same fact - a job retried, a webhook delivered
-- twice - start two sequences against one lead, and the client receives every
-- message twice while both sequences look correct in isolation.
--
-- ── why the subject is a pair rather than seven nullable columns ─────────
--
-- The eight situations point at four different tables: leads, proposals,
-- approval requests and projects. Seven nullable foreign keys with a CHECK
-- that exactly one is set is the alternative, and it grows a column per
-- situation forever.
--
-- The cost is real and is accepted deliberately: `subject_id` carries no
-- foreign key, so a deleted subject leaves a sequence pointing at nothing. The
-- handler must re-read the subject before sending anyway — ADM-69's sixth step
-- is "state unchanged in any way that cancels the sequence" — so a missing
-- subject is a stop condition it already has to handle. A foreign key would
-- add referential tidiness to a row that is checked on every use regardless.
--
-- ── escalation exactly once ──────────────────────────────────────────────
--
-- ADM-69 requires it. `escalated_at` is a timestamp rather than a flag and is
-- constrained to move with the status, so "escalate if not already escalated"
-- is a single conditional UPDATE that a second worker cannot repeat.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.follow_up_sequences (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- One of the eight ADM-69 names. Not a CHECK against a literal list: the
  -- list lives in src/modules/crm/follow-up-situations.ts, and a second copy
  -- here would be a second thing to keep in step. `check-record` compares the
  -- two rather than the database duplicating them.
  situation_key    text not null check (length(trim(situation_key)) > 0),

  -- What the sequence is about. See the header for why this is a pair.
  subject_type     text not null check (subject_type in ('lead', 'proposal', 'approval_request', 'project')),
  subject_id       uuid not null,

  -- Where a send would go. Null for a sequence whose thread does not exist
  -- yet; the handler refuses to send rather than inventing one.
  conversation_id  uuid references crm.conversations(id) on delete set null,

  -- Day 0. The observable fact that started it, and never itself an attempt.
  triggered_at     timestamptz not null,

  attempts_sent    int not null default 0 check (attempts_sent >= 0),
  next_due_at      timestamptz,
  last_sent_at     timestamptz,

  status           text not null default 'active'
                     check (status in ('active', 'stopped', 'exhausted', 'escalated')),

  -- Why it ended. Required when it ended, forbidden while it runs - the same
  -- rule the payment verification and the validation stamps already follow,
  -- because half a claim reads as finished to anybody scanning.
  stop_reason      text,

  escalated_at     timestamptz,

  -- Ties every job, send and audit row of one sequence together.
  correlation_id   uuid not null default gen_random_uuid(),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- The idempotency backbone. Two observations of one fact cannot start two
  -- sequences against the same subject.
  constraint follow_up_sequences_once
    unique (organization_id, situation_key, subject_type, subject_id),

  constraint follow_up_sequences_reason_with_end
    check ((status = 'active') = (stop_reason is null)),

  constraint follow_up_sequences_escalated_together
    check ((status = 'escalated') = (escalated_at is not null))
);

comment on table crm.follow_up_sequences is
  'A running follow-up sequence (G-012, ADM-69). One per subject per situation, enforced by a unique constraint rather than by handler caution: two observations of one fact - a retried job, a webhook delivered twice - would otherwise start two sequences and the client would receive every message twice while both looked correct in isolation. subject_id deliberately carries NO foreign key, because the eight situations point at four tables and the handler must re-read the subject before every send anyway (ADM-69 step 6).';

comment on column crm.follow_up_sequences.stop_reason is
  'Why the sequence ended. Required when it has ended and forbidden while it runs: half a claim reads as finished to anybody scanning, which is the same rule the payment verification and the agent validation stamps follow.';

create index if not exists follow_up_sequences_due_idx
  on crm.follow_up_sequences (organization_id, next_due_at)
  where status = 'active';

create index if not exists follow_up_sequences_subject_idx
  on crm.follow_up_sequences (organization_id, subject_type, subject_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Every attempt is a row, and the row is the claim
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Recorded whether or not the send succeeded, because ADM-69's tenth step
-- requires the *decision* to be audited and not only the delivery. A
-- suppression with no record is indistinguishable from a scheduler that
-- silently stopped working.

create table if not exists crm.follow_up_sends (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  sequence_id      uuid not null references crm.follow_up_sequences(id) on delete cascade,

  -- 1-based. Day 0 is the trigger, so attempt 1 is the first message.
  attempt          int not null check (attempt >= 1),

  -- What the contract decided. `suppressed` carries a reason and is not a
  -- failure: a follow-up correctly not sent is a successful decision.
  outcome          text not null check (outcome in ('sent', 'suppressed', 'failed')),
  suppression_reason text,

  -- The message this produced, when it produced one. Null for a suppression.
  message_id       uuid references crm.conversation_messages(id) on delete set null,

  scheduled_for    timestamptz not null,
  decided_at       timestamptz not null default now(),

  created_at       timestamptz not null default now(),

  -- The guarantee. A second worker inserting attempt 3 fails here rather than
  -- losing a comparison, so the insert is the claim rather than the result of
  -- one.
  constraint follow_up_sends_once unique (sequence_id, attempt),

  constraint follow_up_sends_reason_when_suppressed
    check ((outcome = 'suppressed') = (suppression_reason is not null)),

  constraint follow_up_sends_message_only_when_sent
    check (outcome = 'sent' or message_id is null)
);

comment on table crm.follow_up_sends is
  'One row per follow-up attempt, sent or not (G-012, ADM-69 step 10). unique (sequence_id, attempt) is the no-duplicate-messages guarantee: two workers computing the same attempt number both insert, and the second fails on the constraint rather than on a comparison it lost. A suppression is recorded rather than dropped, because a suppression with no record is indistinguishable from a scheduler that silently stopped working.';

comment on column crm.follow_up_sends.outcome is
  'sent, suppressed or failed. suppressed is not a failure - a follow-up correctly not sent is a successful decision, and it carries the reason the contract gave.';

create index if not exists follow_up_sends_sequence_idx
  on crm.follow_up_sends (sequence_id, attempt);

-- ── tenancy ──────────────────────────────────────────────────────────────
--
-- Internal read, internal write. No client policy at all: a follow-up
-- sequence is the agency's record of chasing somebody, and the somebody being
-- chased has no business reading it.

alter table crm.follow_up_sequences enable row level security;
alter table crm.follow_up_sends enable row level security;

drop policy if exists follow_up_sequences_select on crm.follow_up_sequences;
create policy follow_up_sequences_select on crm.follow_up_sequences
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists follow_up_sequences_write on crm.follow_up_sequences;
create policy follow_up_sequences_write on crm.follow_up_sequences
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists follow_up_sends_select on crm.follow_up_sends;
create policy follow_up_sends_select on crm.follow_up_sends
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists follow_up_sends_write on crm.follow_up_sends;
create policy follow_up_sends_write on crm.follow_up_sends
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists set_updated_at on crm.follow_up_sequences;
create trigger set_updated_at
  before update on crm.follow_up_sequences
  for each row execute function core.set_updated_at();

-- ── a send belongs to its sequence's tenant, and RLS cannot see that ─────
--
-- Both rows carry `organization_id`, and RLS checks each against the caller
-- independently. Neither checks them against *each other*, so a caller inside
-- one organization could file a send against a sequence belonging to another
-- of its own rows - or, with a forged sequence id, against a tenant it can
-- write to but should not be linking.
--
-- The tenancy chain ADM-69 requires runs organization → subject → sequence →
-- send, and this is the link RLS cannot express.

create or replace function crm.enforce_follow_up_send_tenancy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence_org uuid;
begin
  select s.organization_id into v_sequence_org
    from crm.follow_up_sequences s
   where s.id = new.sequence_id;

  if v_sequence_org is null then
    raise exception 'follow-up send refused: sequence % does not exist', new.sequence_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_sequence_org <> new.organization_id then
    raise exception
      'follow-up send refused: the send names organization % and its sequence belongs to % (G-012).',
      new.organization_id, v_sequence_org
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function crm.enforce_follow_up_send_tenancy() is
  'Refuses a send whose organization differs from its sequence (G-012). RLS checks each row against the caller and neither against the other, so this is the link in the organization-subject-sequence-send chain that policies cannot express.';

drop trigger if exists enforce_follow_up_send_tenancy on crm.follow_up_sends;
create trigger enforce_follow_up_send_tenancy
  before insert or update of organization_id, sequence_id on crm.follow_up_sends
  for each row execute function crm.enforce_follow_up_send_tenancy();
