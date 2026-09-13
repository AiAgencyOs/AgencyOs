-- ═══════════════════════════════════════════════════════════════════════════
-- A missed meeting is followed up — ADM-103, Scheduler §8 and §14
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `crm.record_no_show` recorded a no-show and queued nothing, because which
-- follow-up carried it was undecided. Every no-show since G-237 has an audit
-- row that says so in those words: `follow_up: none - ADM-103 open`.
--
-- ADM-103 is answered (2026-09-13). A **new** situation, `missed_meeting`,
-- rather than one of the eight: none of them is a missed meeting, and filing
-- it under `abandoned_conversation` would tell a client their conversation had
-- gone quiet when what actually happened is that they did not come to a call.
--
-- The cadence the owner gave is in HOURS — the first nudge two hours after the
-- agreed start, the second a day after that, and no third. Every rhythm before
-- it counts business days from a trigger date, so this one needs its own clock;
-- that arithmetic lives in TypeScript beside the other four (`follow-up-rhythms`),
-- and what this migration owes it is only a subject it can point at and a
-- sequence somebody actually starts.
--
-- Three changes at the database, and one of them is the whole point:
--
--   1. `follow_up_sequences.subject_type` admits `meeting`. The uniqueness key
--      is (organization, situation, subject_type, subject_id), so keying a
--      missed meeting on its LEAD would make a client's second no-show a
--      silent no-op — the sequence for the first one already exists.
--
--   2. `whatsapp_templates.situation_key` admits `missed_meeting`, so the
--      template the owner registers once Meta gives this deployment its own
--      number (BLK-003) has a situation to answer. Nothing here registers a
--      template: the words are approved at Meta, not in a migration.
--
--   3. `crm.record_no_show` starts the sequence — carried forward VERBATIM
--      from 20260912140000 with two marked edits, because regenerating a door
--      from memory is how `replace_payment_plan` was silently reverted.
--
-- **`triggered_at` is the agreed start, not now.** The cadence is measured
-- from the meeting the client missed; recording the no-show an hour late would
-- otherwise push the first nudge an hour later, and recording it a day late
-- would push both. The worker's sending window still governs, so a nudge owed
-- at 01:30 waits for the morning rather than arriving at night.

-- ── 1. a meeting is a thing a sequence can be about ──────────────────────

alter table crm.follow_up_sequences
  drop constraint if exists follow_up_sequences_subject_type_check;

alter table crm.follow_up_sequences
  add constraint follow_up_sequences_subject_type_check check (subject_type in (
    'lead',
    'proposal',
    'approval_request',
    'project',
    -- ADM-103: the subject of a missed-meeting follow-up is the MEETING, so a
    -- second no-show by the same lead starts a second sequence.
    'meeting'
  ));

-- ── 2. a situation a template can answer ─────────────────────────────────
--
-- Carried forward from 20260906120000 with one addition; the list is restated
-- rather than appended to because a CHECK cannot be appended to.

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
    'quotation_approved',
    'internal_notice',
    'agent_message',
    -- ADM-103. No template row is written here: the words are approved at
    -- Meta and registered by a person (BLK-003).
    'missed_meeting'
  ));

-- ── 3. the door queues what §8 asks for ──────────────────────────────────
--
-- Carried forward VERBATIM from 20260912140000 with [ADM-103 edit 1 of 2] and
-- [ADM-103 edit 2 of 2] marked in place. Everything else — the actor guard,
-- the tenancy guard, the unknown-actor guard, the state guards, the
-- not-yet-started rule, the note filed through the evidence door — is
-- unchanged and must stay that way.

create or replace function crm.record_no_show(
  p_meeting_id uuid,
  p_note       text default null
)
returns table (
  -- 'no_show' | 'already_recorded' | 'wrong_state' | 'not_yet_started'
  -- | 'note_too_long' | 'no_actor' | 'unknown_actor' | 'not_found' | 'forbidden'
  outcome     text,
  meeting_id  uuid,
  lead_id     uuid,
  evidence_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_row      crm.meetings;
  v_evidence uuid;
  v_filed    text;
  -- [ADM-103 edit 1 of 2] the sequence this no-show starts, and whether it is
  -- new. A second no-show on the same meeting cannot happen (already_recorded
  -- refuses it), so `created` false here means a sequence was started by
  -- something else for this meeting — reported rather than hidden.
  v_sequence uuid;
  v_created  boolean;
  v_triggered timestamptz;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::uuid, null::uuid; return;
  end if;
  if length(coalesce(p_note, '')) > 20000 then
    return query select 'note_too_long'::text, null::uuid, null::uuid, null::uuid; return;
  end if;
  select m.* into v_row from crm.meetings m where m.id = p_meeting_id for update;
  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid, null::uuid, null::uuid; return;
  end if;

  if not exists (select 1 from core.users u where u.id = v_actor) then
    return query select 'unknown_actor'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;

  if v_row.status = 'no_show' then
    return query select 'already_recorded'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;
  if v_row.status <> 'booked' then
    return query select 'wrong_state'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;
  -- §8: "Do not infer completion from time alone" - and the other direction:
  -- nobody has failed to attend a meeting that has not begun. Also at the row.
  if v_row.confirmed_start_at is not null and clock_timestamp() < v_row.confirmed_start_at then
    return query select 'not_yet_started'::text, v_row.id, v_row.lead_id, null::uuid; return;
  end if;

  -- completed_at / completed_by carry the MARKING's actor and moment: the
  -- constraint meetings_completion_is_authorized demands them for no_show
  -- precisely so that a no-show is somebody's statement.
  update crm.meetings
     set status       = 'no_show',
         outcome      = 'no_show',
         completed_at = clock_timestamp(),
         completed_by = v_actor
   where crm.meetings.id = v_row.id;

  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    select e.outcome, e.evidence_id into v_filed, v_evidence
      from crm.add_meeting_evidence(v_row.id, 'notes', p_note, 'internal') e;
    if v_filed is distinct from 'attached' then
      raise exception 'meeting_note: the evidence door answered %', v_filed;
    end if;
  end if;

  -- [ADM-103 edit 2 of 2] §8's follow-up, now that a situation carries it.
  -- Triggered at the AGREED START, so the cadence is measured from the
  -- meeting the client missed rather than from the moment somebody got round
  -- to recording it. The conversation and contact are carried through so the
  -- consent chokepoint has something to check; a meeting with neither still
  -- starts a sequence, and the worker stops it by name rather than sending
  -- into nothing.
  -- One reading of the trigger moment, used by both the sequence and the
  -- audit row: two calls to clock_timestamp() differ by microseconds, and a
  -- record that disagrees with the thing it records is worth avoiding.
  v_triggered := coalesce(v_row.confirmed_start_at, clock_timestamp());

  -- A follow-up is a MESSAGE, and a message needs a thread. A meeting with no
  -- conversation has nowhere to send one, so no sequence is started and the
  -- audit row says why. Starting one anyway would write a row the worker must
  -- stop on its next tick, and the audit would have claimed a follow-up that
  -- was never going to happen. Review of ADM-103 found that claim.
  if v_row.conversation_id is not null then
    select s.sequence_id, s.created into v_sequence, v_created
      from crm.start_follow_up_sequence(
        v_row.organization_id,
        'missed_meeting',
        'meeting',
        v_row.id,
        v_triggered,
        v_row.conversation_id,
        v_row.contact_id
      ) s;
  end if;

  perform core.record_audit(
    v_row.organization_id,
    'meeting.no_show',
    'meeting',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'confirmed_start_at', v_row.confirmed_start_at),
    jsonb_build_object(
      'status', 'no_show',
      'recorded_by', v_actor,
      'lead_id', v_row.lead_id,
      'evidence_id', v_evidence,
      -- [ADM-103 edit 2 of 2, continued] where the sentence saying the
      -- decision was still open used to be. The sequence id is recorded so
      -- the follow-up can be found from the no-show, and `started_here` says
      -- whether this call started it.
      'follow_up', case
        when v_row.conversation_id is null then
          jsonb_build_object('situation', 'missed_meeting', 'started', false, 'reason', 'no_conversation')
        else
          jsonb_build_object(
            'situation', 'missed_meeting',
            'sequence_id', v_sequence,
            'started_here', v_created,
            'triggered_at', v_triggered
          )
      end
    )
  );

  return query select 'no_show'::text, v_row.id, v_row.lead_id, v_evidence;
end;
$$;

comment on function crm.record_no_show(uuid, text) is
  'G-237 + ADM-103. The no-show door (Scheduler specification section 8): a person with core.can_write() marks a BOOKED meeting as not attended, never before its agreed start, never twice, with the marking''s actor and moment on the row and a typed note filed through crm.add_meeting_evidence. Audited as meeting.no_show. Queues no analysis - there is nothing to analyse in a meeting that did not happen - and STARTS the missed_meeting follow-up sequence on the meeting itself, triggered at the agreed start rather than at the moment of recording.';

-- Carried forward exactly as 20260912140000 left them: `create or replace`
-- keeps the existing grants, but restating them wrongly here would silently
-- narrow the door (the service role's execute is what a revoke-from-public
-- takes away by accident).
revoke all on function crm.record_no_show(uuid, text) from public, anon;
grant execute on function crm.record_no_show(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
