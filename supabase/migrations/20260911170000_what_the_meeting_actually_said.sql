-- ═══════════════════════════════════════════════════════════════════════════
-- What the meeting actually said — G-229
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The last of the Scheduler's five units, and the one the whole branch exists
-- for. Sales Flow §7 calls it the critical trigger:
--
--   USER: upload evidence + mark completed → SYSTEM: completion event →
--   ANALYSIS JOB → structured memory → SALES AGENT → continue the conversation
--
-- Without it a call happens and the system learns nothing, so the client is
-- asked to repeat on WhatsApp what they already said on the phone — which
-- Scheduler §10.4 names directly: "Sales can continue without asking the lead
-- to repeat known information."
--
-- ── what G-225 already settled ────────────────────────────────────────────
--
-- Completion itself. `meetings_completion_is_authorized` requires an actor AND
-- a timestamp for `completed` and `no_show`, so no clock can conclude that a
-- meeting happened. §9.1's hardest rule was the first one built, and nothing
-- here loosens it.
--
-- ── evidence, and the two separations §9.2 asks for ───────────────────────
--
-- 1. **Evidence belongs to an exact meeting**, not to a lead in general.
--    "Link every artifact to the exact schedule and lead/opportunity."
--    A recording that cannot say which call it is from is a recording nobody
--    can act on.
--
-- 2. **Internal evidence is not client-visible evidence.** §9.2: "Keep
--    internal evidence separate from client-visible." A default of `internal`
--    rather than a nullable column, because the failure mode is one-directional
--    — an internal note shown to a client cannot be un-shown.
--
-- The artifact itself is a REFERENCE. Storage is not chosen (it is the same
-- shape of decision as BLK-005), and §9.2's "Do not expose sensitive evidence
-- through predictable URLs" is a property of whatever signs those references,
-- not of this table. What this table owns is WHICH meeting, WHO uploaded it,
-- WHEN, WHAT KIND, and WHO MAY SEE IT.
--
-- ── the trigger condition, which is the part that can go wrong quietly ────
--
-- §10.1 permits analysis only when the interaction is explicitly completed AND
-- relevant evidence is present, or a configured notes-only path is allowed.
-- The failure this prevents is subtle: an analysis job that runs on a meeting
-- with nothing attached produces a grounded-sounding summary of NOTHING, and
-- §10.3 is emphatic that "AI must not invent requirements or decisions".
--
-- A model asked to summarise an empty room will still answer. So the refusal
-- is here, before the job exists, rather than in a prompt.
--
-- ── and what analysis is allowed to produce ───────────────────────────────
--
-- Nothing confirmed. §10.3: "AI inference is not automatically a confirmed
-- client fact." This repository already has exactly the right shape for that
-- and does not need a new one: `crm.requirement_versions` are born `proposed`
-- and a human accepts or rejects them (the L1 autonomy the requirement
-- collector has always had). Meeting analysis joins that path rather than
-- opening a second one with different rules.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.meeting_evidence (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- The exact schedule, per §9.2. Cascade: evidence about a deleted meeting is
  -- evidence about nothing.
  meeting_id       uuid not null references crm.meetings(id) on delete cascade,
  lead_id          uuid not null references crm.leads(id) on delete cascade,

  -- §9.2's list, as a closed vocabulary. `notes` is the typed-notes path that
  -- makes the notes-only workflow possible without a recording.
  kind             text not null check (kind in
                     ('recording', 'transcript', 'image', 'chat_export',
                      'document', 'notes', 'summary')),

  -- §9.2: "Keep internal evidence separate from client-visible." Defaulted to
  -- the safe side rather than nullable, because an internal note shown to a
  -- client cannot be un-shown.
  visibility       text not null default 'internal'
                     check (visibility in ('internal', 'client_visible')),

  -- A REFERENCE, never the bytes. Which store signs it is not decided yet, and
  -- §9.2's "do not expose through predictable URLs" is a property of whatever
  -- does the signing.
  artifact_ref     text,

  -- The notes path carries its text here; every other kind carries a ref.
  body             text,

  media_type       text,
  byte_size        bigint check (byte_size is null or byte_size > 0),

  uploaded_by      uuid references core.users(id) on delete set null,
  uploaded_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  -- Something has to be there. An evidence row with neither a reference nor a
  -- body is a claim that evidence exists, which is worse than no row at all -
  -- it satisfies the analysis gate below while carrying nothing.
  constraint meeting_evidence_carries_something check (
    artifact_ref is not null or length(btrim(coalesce(body, ''))) > 0
  )
);

create index if not exists meeting_evidence_meeting_idx
  on crm.meeting_evidence (meeting_id, uploaded_at desc);

create index if not exists meeting_evidence_org_idx
  on crm.meeting_evidence (organization_id, uploaded_at desc);

alter table crm.meeting_evidence enable row level security;

drop policy if exists meeting_evidence_select on crm.meeting_evidence;
create policy meeting_evidence_select on crm.meeting_evidence
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_internal()));

drop policy if exists meeting_evidence_write on crm.meeting_evidence;
create policy meeting_evidence_write on crm.meeting_evidence
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.can_write()))
  with check (organization_id = (select core.current_organization_id())
         and (select core.can_write()));

drop trigger if exists org_match_evidence_meeting on crm.meeting_evidence;
create trigger org_match_evidence_meeting
  before insert or update of meeting_id, organization_id on crm.meeting_evidence
  for each row execute function core.enforce_parent_org('meeting_id', 'crm.meetings');

drop trigger if exists org_match_evidence_lead on crm.meeting_evidence;
create trigger org_match_evidence_lead
  before insert or update of lead_id, organization_id on crm.meeting_evidence
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

drop trigger if exists freeze_org_evidence on crm.meeting_evidence;
create trigger freeze_org_evidence
  before update on crm.meeting_evidence
  for each row execute function core.freeze_organization_id();

grant select on crm.meeting_evidence to authenticated, service_role;
grant insert, update, delete on crm.meeting_evidence to authenticated, service_role;

comment on table crm.meeting_evidence is
  'What a call or meeting left behind (G-229, Scheduler specification section 9.2). Linked to the EXACT meeting rather than to a lead in general, carrying uploader, moment and kind, and separating internal from client-visible with a default on the safe side because an internal note shown to a client cannot be un-shown. The artifact is a reference: which store signs it is not decided, and "do not expose through predictable URLs" is a property of whatever does the signing.';


-- ── the analysis gate ─────────────────────────────────────────────────────

create or replace function crm.request_meeting_analysis(p_meeting_id uuid)
returns table (
  -- 'queued' | 'already_queued' | 'not_completed' | 'no_evidence'
  -- | 'not_found' | 'forbidden'
  outcome text,
  job_id  uuid
)
language plpgsql
volatile
-- DEFINER, for the reason crm.schedule_meeting_reminder gives: core.jobs
-- admits no INSERT of this kind from an authenticated caller, so an invoker
-- function could never queue anything. Found by review.
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_meeting  crm.meetings;
  v_evidence int;
  v_key      text;
  v_job      uuid;
begin
  select m.* into v_meeting
    from crm.meetings m
   where m.id = p_meeting_id;

  if v_meeting.id is null then
    return query select 'not_found'::text, null::uuid; return;
  end if;

  -- Definer means RLS did not filter that read, so this is the tenancy guard,
  -- in the repository's idiom: an authenticated caller must own the row; the
  -- service role is the worker and is trusted.
  if v_actor is not null
     and v_meeting.organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  -- §10.1: explicitly marked completed. G-225 already made that require an
  -- actor and a timestamp, so reaching here means a person said so.
  --
  -- `no_show` is deliberately NOT eligible. There is nothing to analyse in a
  -- meeting that did not happen, and §14 gives a no-show its own workflow -
  -- a Sales follow-up, not a summary of silence.
  if v_meeting.status <> 'completed' then
    return query select 'not_completed'::text, null::uuid; return;
  end if;

  -- §10.1 again, and the refusal that matters. A model asked to summarise an
  -- empty room will still answer, and §10.3 forbids inventing requirements or
  -- decisions - so the refusal is here, before the job exists, rather than in
  -- a prompt where the model is the thing being asked to comply.
  select count(*) into v_evidence
    from crm.meeting_evidence e
   where e.meeting_id = v_meeting.id;

  if v_evidence = 0 then
    return query select 'no_evidence'::text, null::uuid; return;
  end if;

  -- Idempotent on the meeting, in ONE statement: marking a meeting complete
  -- twice, or an operator pressing the button again, must not queue a second
  -- analysis of the same call — and two operators pressing it at once must
  -- not race a probe-then-insert into a raw unique_violation. A job in any
  -- status already holds the key; an analysis that failed is re-run through
  -- core.requeue_job, where a person decides, not here.
  v_key := 'meeting.analysis:' || v_meeting.id::text;

  insert into core.jobs (organization_id, kind, payload, dedupe_key)
  values (
    v_meeting.organization_id,
    'meeting.analysis',
    jsonb_build_object(
      'meeting_id', v_meeting.id,
      'lead_id', v_meeting.lead_id,
      'opportunity_id', v_meeting.opportunity_id,
      'evidence_count', v_evidence
    ),
    v_key
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning core.jobs.id into v_job;

  if v_job is null then
    select j.id into v_job from core.jobs j where j.dedupe_key = v_key;
    return query select 'already_queued'::text, v_job; return;
  end if;

  return query select 'queued'::text, v_job;
end;
$$;
comment on function crm.request_meeting_analysis(uuid) is
  'G-229. Queues the analysis of a completed meeting, and refuses everything else. Scheduler specification section 10.1 permits analysis only when the interaction is explicitly completed AND evidence is present; a no-show is deliberately ineligible because there is nothing to analyse in a meeting that did not happen. The no-evidence refusal is the one that matters: a model asked to summarise an empty room will still answer, and section 10.3 forbids inventing requirements - so the refusal lives here rather than in a prompt, where the model is the thing being asked to comply. Idempotent on the meeting.';

revoke all on function crm.request_meeting_analysis(uuid) from public, anon;
grant execute on function crm.request_meeting_analysis(uuid) to authenticated, service_role;
