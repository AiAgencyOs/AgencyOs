-- ═══════════════════════════════════════════════════════════════════════════
-- The window belongs to a number, not to a thread — G-214
-- ═══════════════════════════════════════════════════════════════════════════
--
-- G-213 taught this system that WhatsApp carries free text only within 24
-- hours of the contact's last message, and taught it in exactly one place:
-- `deliverFollowUp`. Nine other send sites never ask.
--
-- ── the one that has already failed in production ─────────────────────────
--
-- ADM-95 made the internal announcement channel A PERSON — the owner's own
-- WhatsApp, one to one, because Meta refused this WABA the Groups API
-- (#131215). So an approval announcement is a business-initiated message to
-- an individual, and the window governs it exactly as it governs a client's.
-- On this deployment it has already been refused: Meta accepted the call,
-- returned a real message id, and then reported the send failed.
--
-- The approved quotation is the other one, and it is worse. Owner review
-- takes hours or days, so by the time `dispatchApprovedQuotation` runs, the
-- client has usually been silent past 24 hours. The proposal is marked
-- approved, the money message is refused on the wire, and nothing anywhere
-- says so.
--
-- ── and the modelling error underneath both ───────────────────────────────
--
-- `window_open_until` read ONE CONVERSATION'S messages. Meta's window is not
-- a property of a conversation row; it is a property of a PHONE NUMBER
-- talking to a business number. On this very deployment the owner's number
-- holds two conversation rows — `internal:+91…` for announcements and
-- `wa:+91…` from testing — and a message on either one opens the same window
-- at Meta. Asking one row gave the wrong answer for the other.
--
-- So the window is computed per counterpart number, across every thread the
-- organization holds with it. That is both more correct and more permissive:
-- it stops this system suppressing a send Meta would have carried.
--
-- ── what is deliberately NOT here ─────────────────────────────────────────
--
-- No guess. If a number has never written, the window is `never` — not
-- `closed` with a hopeful timestamp — because those two facts lead to
-- different decisions and a caller should be able to tell them apart.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the counterpart of a thread, as a comparable number ───────────────────
--
-- The rule is `send_outbound_message`'s own, restated: a group is addressed
-- by its external ref, an internal_direct thread by the number inside its
-- ref, and everything else by its contact's phone. Digits only, because the
-- same number is written `+919…` on a contact and `internal:+919…` on a
-- channel, and a window that depended on punctuation would be a bug nobody
-- could see.
create or replace function crm.conversation_counterpart_digits(p_conversation_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           -- A group has no single counterpart, so it has no window. Null is
           -- the honest answer, and the caller must not read it as 'closed'.
           when c.kind in ('project_group', 'internal_group') then null
           when c.kind = 'internal_direct'
             then nullif(regexp_replace(c.external_ref, '\D', '', 'g'), '')
           else nullif(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g'), '')
         end
    from crm.conversations c
    left join crm.contacts ct on ct.id = c.contact_id
   where c.id = p_conversation_id
$$;

comment on function crm.conversation_counterpart_digits(uuid) is
  'The number on the other end of a thread, digits only, so a contact phone (+919…) and an internal channel ref (internal:+919…) compare equal. Null for a group, which has no single counterpart and therefore no 24-hour window (G-214).';

-- ── when the window shuts, for that number, across every thread ───────────
--
-- Written as plpgsql rather than as one SQL statement, and the reason is
-- measurable: the first version joined `conversations` to itself and called
-- `conversation_counterpart_digits` once PER PEER ROW, which is a query per
-- conversation in the organization, three times over, on every send. The
-- counterpart is one value — resolve it once, then look for the peers that
-- share it.
create or replace function crm.window_open_until(p_conversation_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_digits text;
  v_last   timestamptz;
begin
  select c.organization_id, crm.conversation_counterpart_digits(c.id)
    into v_org, v_digits
    from crm.conversations c
   where c.id = p_conversation_id;

  -- No counterpart is not a shut window; it is a thread the question does not
  -- apply to. Null, and `window_state` says which of the two it is.
  if v_digits is null then
    return null;
  end if;

  -- EDIT (G-214): was the newest inbound message on THIS conversation. It is
  -- now the newest inbound message from this COUNTERPART, in this
  -- organization, on any thread — because that is what Meta measures. On this
  -- deployment the owner's own number holds two rows, and asking one of them
  -- gave the wrong answer for the other.
  select max(m.occurred_at)
    into v_last
    from crm.conversations peer
    left join crm.contacts ct on ct.id = peer.contact_id
    join crm.conversation_messages m
      on m.conversation_id = peer.id
     and m.author_type = 'client'
   where peer.organization_id = v_org
     and case
           when peer.kind in ('project_group', 'internal_group') then null
           when peer.kind = 'internal_direct'
             then nullif(regexp_replace(peer.external_ref, '\D', '', 'g'), '')
           else nullif(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g'), '')
         end = v_digits;

  if v_last is null then
    return null;
  end if;

  return v_last + interval '24 hours';
end;
$$;

comment on function crm.window_open_until(uuid) is
  'When WhatsApp stops carrying free text to this thread''s counterpart: 24 hours after their newest inbound message anywhere in this organization (G-213, widened to the number by G-214). Null when the counterpart has never written, or when the thread is a group.';

-- The peers are found by number, so the number is what has to be indexable.
-- Without this the lookup is a sequential scan of every contact the
-- organization holds, on every send.
create index if not exists contacts_counterpart_digits_idx
  on crm.contacts (organization_id, (regexp_replace(coalesce(phone, ''), '\D', '', 'g')));

/**
 * What the window is, in the four words a caller has to tell apart.
 *
 *   open   — free text is carried.
 *   closed — they have written before, and more than 24 hours ago.
 *   never  — they have never written. Every imported lead is here.
 *   group  — the question does not apply.
 *
 * `never` and `closed` both forbid free text, so a careless caller that
 * treats anything other than 'open' as shut is still correct. They differ in
 * what a HUMAN should do about it, which is why they are not one value.
 */
create or replace function crm.window_state(p_conversation_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  -- Asked once each, not three times: the SQL version below re-evaluated
  -- `window_open_until` in every branch it tested.
  if crm.conversation_counterpart_digits(p_conversation_id) is null then
    return 'group';
  end if;

  v_until := crm.window_open_until(p_conversation_id);

  if v_until is null then return 'never'; end if;
  if v_until > now() then return 'open'; end if;
  return 'closed';
end;
$$;

comment on function crm.window_state(uuid) is
  'open | closed | never | group — the four states a sender has to tell apart (G-214). Only ''open'' permits free text; ''never'' and ''closed'' both require an approved template, and differ in what a person should do about it.';

create or replace function crm.window_is_open(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- EDIT (G-214): derived from window_state so the two can never disagree.
  select crm.window_state(p_conversation_id) = 'open'
$$;

comment on function crm.window_is_open(uuid) is
  'Whether WhatsApp will carry free text to this thread right now. Derived from crm.window_state so the boolean and the four-state answer cannot drift apart (G-213, G-214).';

-- ── the situations a business-initiated message can be about ──────────────
--
-- G-213's vocabulary was ADM-11's eight follow-up situations, because the
-- follow-up handler was the only caller. The announcers are callers now, and
-- each needs a situation of its own — an approved quotation is not a nudge,
-- and an owner being told a decision is waiting is not a client follow-up.
alter table crm.whatsapp_templates
  drop constraint if exists whatsapp_templates_situation_key_check;

alter table crm.whatsapp_templates
  add constraint whatsapp_templates_situation_key_check check (situation_key in (
    'no_response_after_quotation',
    'no_response_after_requirements',
    'no_response_after_proposal',
    'abandoned_conversation',
    'pending_approval',
    'inactive_lead',
    'post_project',
    'internal_approval',
    -- G-214: the announcers.
    'quotation_approved',
    'internal_notice',
    'agent_message'
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- A send that is waiting for the window
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When the window is shut and no approved template answers the situation,
-- there are three things a system can do and only one of them is honest.
--
--   Send anyway    — Meta refuses it. This is what happened until now.
--   Give up        — the client never receives their approved quotation, and
--                    the proposal sits marked `approved` saying otherwise.
--   Wait           — hold the job until the counterpart writes, then send.
--
-- Waiting is what a person does, and it is what this table records. The job
-- itself is left `queued` with a far `run_at`; this row is what lets an
-- inbound message find it again, and what lets an Admin see that a quotation
-- is waiting on a client rather than lost.
create table if not exists crm.deferred_sends (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  job_id            uuid not null references core.jobs(id) on delete cascade,
  conversation_id   uuid not null references crm.conversations(id) on delete cascade,

  -- Denormalized on purpose: the wake-up is keyed by number, and reading it
  -- back through the conversation at wake time would make the lookup depend
  -- on a contact row that may have been edited since.
  counterpart_digits text not null check (length(counterpart_digits) between 6 and 20),

  -- Why this could not go. Free text from the caller, shown to an Admin.
  reason            text not null check (length(btrim(reason)) between 1 and 500),

  deferred_at       timestamptz not null default now(),
  woken_at          timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One live deferral per job. A job that defers twice updates its reason
-- rather than accumulating rows nobody clears.
create unique index if not exists deferred_sends_job_key
  on crm.deferred_sends (job_id);

create index if not exists deferred_sends_wake_idx
  on crm.deferred_sends (organization_id, counterpart_digits)
  where woken_at is null;

alter table crm.deferred_sends enable row level security;

drop policy if exists deferred_sends_select on crm.deferred_sends;
create policy deferred_sends_select on crm.deferred_sends
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

comment on table crm.deferred_sends is
  'A send that WhatsApp would refuse right now, waiting for its counterpart to write (G-214). The job stays queued with a far run_at; this row is how an inbound message finds it and how an Admin sees that a quotation is waiting rather than lost. Read-only to members: only the job runner defers and only an inbound message wakes.';

-- Both parents are org-scoped, so both get the guard a foreign key does not
-- give: the child and its parent share an organization, on insert and on any
-- update that could re-parent or re-tenant the row.
drop trigger if exists org_match_deferred_sends_job on crm.deferred_sends;
create trigger org_match_deferred_sends_job
  before insert or update of job_id, organization_id on crm.deferred_sends
  for each row execute function core.enforce_parent_org('job_id', 'core.jobs');

drop trigger if exists org_match_deferred_sends_conversation on crm.deferred_sends;
create trigger org_match_deferred_sends_conversation
  before insert or update of conversation_id, organization_id on crm.deferred_sends
  for each row execute function core.enforce_parent_org('conversation_id', 'crm.conversations');

drop trigger if exists freeze_org_deferred_sends on crm.deferred_sends;
create trigger freeze_org_deferred_sends
  before update on crm.deferred_sends
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on crm.deferred_sends;
create trigger set_updated_at
  before update on crm.deferred_sends
  for each row execute function core.set_updated_at();

grant select on crm.deferred_sends to authenticated, service_role;
-- Deliberately not granted to `authenticated`: a person does not defer a send
-- and does not wake one. The runner does, through the functions below.
grant insert, update, delete on crm.deferred_sends to service_role;

-- ── deferring ─────────────────────────────────────────────────────────────
--
-- Leaves the job QUEUED rather than failing it, and pushes `run_at` over the
-- horizon so the runner stops picking it up until something wakes it. The
-- attempt this claim spent is given back: it was spent discovering the window
-- was shut, not on a delivery, and a send that waits three weeks for a client
-- must not exhaust `max_attempts` doing so.
create or replace function crm.defer_send(
  p_job_id uuid,
  p_conversation_id uuid,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job         core.jobs;
  v_digits      text;
begin
  select * into v_job from core.jobs where id = p_job_id;
  if v_job.id is null then
    return 'no_job';
  end if;

  select c.id into v_digits
    from crm.conversations c
   where c.id = p_conversation_id
     and c.organization_id = v_job.organization_id;
  if v_digits is null then
    -- The conversation is absent or belongs to another tenant. Deferring
    -- across the tenant line would let one organization park another's job.
    return 'wrong_tenant';
  end if;

  v_digits := crm.conversation_counterpart_digits(p_conversation_id);
  if v_digits is null then
    -- A group has no counterpart to wait for. Nothing would ever wake it.
    return 'no_counterpart';
  end if;

  update core.jobs
     set status     = 'queued',
         run_at     = now() + interval '30 days',
         locked_at  = null,
         locked_by  = null,
         attempts   = greatest(attempts - 1, 0),
         last_error = left(p_reason, 500),
         updated_at = now()
   where id = p_job_id;

  insert into crm.deferred_sends (
    organization_id, job_id, conversation_id, counterpart_digits, reason
  )
  values (
    v_job.organization_id, p_job_id, p_conversation_id, v_digits, left(p_reason, 500)
  )
  on conflict (job_id) do update
    set reason          = excluded.reason,
        conversation_id = excluded.conversation_id,
        counterpart_digits = excluded.counterpart_digits,
        deferred_at     = now(),
        woken_at        = null,
        updated_at      = now();

  return 'deferred';
end;
$$;

comment on function crm.defer_send(uuid, uuid, text) is
  'Parks an outbound job until its counterpart writes (G-214): the job stays queued with run_at over the horizon, the attempt it spent discovering the shut window is given back, and a deferred_sends row records why. Refuses a conversation outside the job''s organization. SECURITY DEFINER; service role only.';

revoke all on function crm.defer_send(uuid, uuid, text) from public, anon, authenticated;
grant execute on function crm.defer_send(uuid, uuid, text) to service_role;

-- ── waking ────────────────────────────────────────────────────────────────
--
-- Called when a message arrives FROM a number. Everything parked waiting for
-- that number becomes runnable at once, in the order it was deferred, because
-- the window Meta just opened is the same window all of them were waiting on.
create or replace function crm.wake_deferred_sends(
  p_organization_id uuid,
  p_digits text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_woken integer;
begin
  if p_digits is null or btrim(p_digits) = '' then
    return 0;
  end if;

  with due as (
    update crm.deferred_sends d
       set woken_at = now(), updated_at = now()
     where d.organization_id = p_organization_id
       and d.counterpart_digits = regexp_replace(p_digits, '\D', '', 'g')
       and d.woken_at is null
    returning d.job_id
  )
  update core.jobs j
     set run_at = now(), updated_at = now()
    from due
   where j.id = due.job_id
     -- Only a job still waiting. One that was cancelled, or that somebody
     -- already ran by hand, is left exactly as it is.
     and j.status = 'queued';

  get diagnostics v_woken = row_count;
  return v_woken;
end;
$$;

comment on function crm.wake_deferred_sends(uuid, text) is
  'Makes every send parked on this number runnable now, because an inbound message just opened its 24-hour window (G-214). Returns how many jobs were woken. Idempotent: a second call finds nothing unwoken. SECURITY DEFINER; service role only.';

revoke all on function crm.wake_deferred_sends(uuid, text) from public, anon, authenticated;
grant execute on function crm.wake_deferred_sends(uuid, text) to service_role;
