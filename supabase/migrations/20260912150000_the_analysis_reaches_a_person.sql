-- ═══════════════════════════════════════════════════════════════════════════
-- The analysis reaches a person — G-240
--
-- Scheduler Agent Complete Responsibilities §10.4: after an analysis, "create
-- a typed Sales Agent task/event" carrying the schedule id, evidence
-- references, the grounded summary, requirement/objection references, the
-- unresolved questions and the next action — and "Sales confirms material
-- requirements before treating them as confirmed."
--
-- The Sales AGENT is not activated for that (ADM-82 / BLK-002), so the person
-- who would confirm is a person. G-239's worker already writes the proposed
-- version and the note; this declares the event the specification names and
-- the worker hands the conversation to a person through the door that
-- already exists (crm.hand_conversation_to_a_person, 20260823140000), whose
-- trigger already emits conversation.escalated and whose announcer already
-- reaches the owner's WhatsApp. No second notifier: the one that drifts is
-- the one nobody remembers exists.
--
-- `meeting.analysed` is emitted with no subscriber, on G-232's reasoning:
-- the announcement rides the escalation, and a job nothing consumes is a
-- backlog of dead work. The event is the §11.1 record (ScheduleAnalysisCompleted)
-- that the analysis happened, carrying every reference §10.4 lists, so the
-- consumer that arrives with agent activation subscribes to a type that
-- already has a history.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('meeting.analysed',
   'A completed meeting''s evidence was analysed by the requirement collector: a PROPOSED requirement version and an internal summary exist, the thread was handed to a person to confirm (Scheduler specification section 10.4, section 11.1 ScheduleAnalysisCompleted). Emitted with no subscriber: the handover rides conversation.escalated.',
   null)
on conflict (type) do nothing;
