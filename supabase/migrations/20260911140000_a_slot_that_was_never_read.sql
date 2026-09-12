-- ═══════════════════════════════════════════════════════════════════════════
-- A slot that was never read — G-226
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The Scheduler specification opens its "must not" list with one line:
-- **"Invent availability."** §5.3 restates it from the other side — "Never
-- represent an unavailable slot as pending/confirmed unless the provider
-- actually created it" — and §14 requires a provider outage to produce "No
-- false success."
--
-- G-225 built the domain. Nothing in it stopped a row being written with
-- `status = 'proposed'` and three times in it that came from nowhere.
--
-- ── making the rule a fact about the row ──────────────────────────────────
--
-- "Do not invent availability" sounds like a rule about behaviour, which is
-- the kind of rule that lives in a comment and is enforced by whoever
-- remembers it. It becomes a rule about DATA with one move: record WHERE the
-- answer came from and WHEN it was read, and refuse a proposal that has
-- neither.
--
--   availability_source   the adapter and calendar that answered — never a
--                         credential, and null until one is chosen (BLK-005)
--   availability_read_at  the moment it answered
--
-- `meetings_proposal_was_read` then says: a meeting cannot be `proposed` or
-- `booked` unless both are set. An agent that skipped the calendar has
-- nothing to put in them, so the row refuses — and the refusal does not
-- depend on the agent being honest about it, which is the difference between
-- this and a prompt.
--
-- ── what this deliberately does NOT claim ─────────────────────────────────
--
-- The database cannot check that the recorded slot was in the answer; it
-- never saw the answer. It can only check that an answer was recorded at all.
-- That is a floor, not a ceiling: the subset rule lives in
-- `src/lib/scheduling/availability.ts`, where `proposableSlots()` returns
-- slots for a `read` answer and refuses for the other two — and the type is
-- what carries it, because only the `read` member has a `slots` field.
--
-- Said plainly so nobody reads more into the constraint than it holds:
-- **the row proves something was asked; the port proves the offer came from
-- the reply.**
--
-- ── staleness, and why it is a column rather than a rule ──────────────────
--
-- §5.1 ends with "Re-check availability immediately before committing the
-- booking", and §14 has "Slot changes during booking | Provider conflict |
-- Recheck + alternatives". That re-check is G-227's, because it is a fact
-- about the moment of booking rather than about this row. What this migration
-- owes G-227 is the timestamp it will compare against, which is why
-- `availability_read_at` is stored rather than merely required.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.meetings
  add column if not exists availability_source text,
  add column if not exists availability_read_at timestamptz;

comment on column crm.meetings.availability_source is
  'Which adapter and calendar answered — for example google:primary. Never a credential. Null until a provider is chosen (BLK-005), which is why nothing can currently reach proposed or booked: that is the refusal working, not a missing feature.';

comment on column crm.meetings.availability_read_at is
  'When that answer was read. Stored rather than merely required because G-227 re-checks availability immediately before committing a booking (Scheduler specification section 5.1) and needs something to compare against.';

alter table crm.meetings
  drop constraint if exists meetings_proposal_was_read;

alter table crm.meetings
  add constraint meetings_proposal_was_read check (
    status not in ('proposed', 'booked')
    or (availability_source is not null and availability_read_at is not null)
  ) not valid;

comment on constraint meetings_proposal_was_read on crm.meetings is
  'Scheduler specification section 5: "Invent availability" is the first thing the Scheduler must not do. A meeting cannot be proposed or booked without recording which source answered and when. An agent that skipped the calendar has nothing to put in these columns, so the row refuses - and the refusal does not depend on the agent being honest. NOT VALID because G-225 shipped hours earlier and any row written between the two migrations predates the rule; it binds every new and changed row, which is the same choice opportunities_lost_says_why made and for the same reason (ADM-76).';

-- The index G-227 will read: the booked meetings whose availability answer is
-- oldest are the ones most likely to have gone stale under a client.
create index if not exists meetings_availability_age_idx
  on crm.meetings (organization_id, availability_read_at)
  where status in ('proposed', 'booked');
