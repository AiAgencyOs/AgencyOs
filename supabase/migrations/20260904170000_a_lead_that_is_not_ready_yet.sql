-- ═══════════════════════════════════════════════════════════════════════════
-- A lead that is not ready yet — G-203 (Doc 09 §6 and §26, audit FU-10)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Doc 09 §6 lists NURTURE among the lead statuses and §26 gives it a whole
-- section: not ready now, budget later, waiting for a decision-maker, needs
-- more evidence — with a date to come back and a way out.
--
-- This system has five lead statuses and none of them is that. What exists is
-- a nurture RHYTHM, attached to two follow-up situations, which sends. There
-- is nowhere for the lead itself to sit.
--
-- The practical consequence, which is the whole finding: a lead that is not
-- lost and not ready either **stays `qualified` forever** — inflating the one
-- number the pipeline exists to report — **or is closed as `disqualified`
-- with a reason that is not true**. Both are the system lying about the shape
-- of the pipeline, and the second is worse: it writes a false sentence into
-- the record of why a deal was lost.
--
-- ── the shape §26 asks for, and the two things it must not become ─────────
--
-- A status, a REASON from §26's own four, and a DATE to come back. All three
-- are required together, and that is the design rather than an afterthought:
--
--   Without a reason, "nurture" is where a lead goes when nobody wants to
--   decide, and the pipeline is exactly as untrue as it was before with one
--   more state to hide in.
--
--   Without a date, it is a drawer. §26 asks for a follow-up date because a
--   lead nobody has agreed to look at again is lost with extra steps.
--
-- ── who may put a lead there ──────────────────────────────────────────────
--
-- A person. Not the agent, and not because a client went quiet: deciding that
-- somebody is not ready is a reading of their intent, and business rules §5
-- makes treating a client's word as a fact one of the five things no agent
-- may do at any level. The follow-up engine goes on deciding what to SEND
-- from the situations it already reads; this is only about where the lead
-- sits while that happens.
--
-- ── and what is deliberately not built ────────────────────────────────────
--
-- §26's *next recommended message*. The follow-up composer already writes one
-- when a situation fires, from the conversation itself; a second surface
-- holding a recommendation nothing sends would be the column-with-no-consumer
-- G-130 and G-133 both record.

alter table crm.leads drop constraint if exists leads_status_check;
alter table crm.leads add constraint leads_status_check
  check (status in ('new', 'qualifying', 'qualified', 'nurture', 'disqualified', 'converted'));

alter table crm.leads
  add column if not exists nurture_reason text
    check (nurture_reason is null or nurture_reason in (
      -- §26's own four, and no fifth without a decision.
      'not_ready_now',
      'budget_later',
      'waiting_for_decision_maker',
      'needs_more_evidence'
    ));

comment on column crm.leads.nurture_reason is
  'Doc 09 section 26''s four, and no fifth without a decision. Required while a lead is in nurture: without it, nurture is where a lead goes when nobody wants to decide, and the pipeline is as untrue as it was with one more state to hide in.';

-- ── the three travel together ─────────────────────────────────────────────
--
-- `next_follow_up_at` already exists and is what the follow-up engine reads,
-- so nurture borrows it rather than inventing a second date nobody looks at.

create or replace function crm.nurture_says_why_and_when()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'nurture' then
    if new.nurture_reason is null then
      raise exception 'a lead in nurture must say why — Doc 09 section 26 names four reasons'
        using errcode = 'check_violation';
    end if;
    if new.next_follow_up_at is null then
      raise exception 'a lead in nurture must say when to come back — a lead nobody has agreed to look at again is lost with extra steps'
        using errcode = 'check_violation';
    end if;
  elsif new.nurture_reason is not null then
    -- Leaving nurture clears the reason. A `qualified` lead carrying "budget
    -- later" is a stale sentence that reads as current, which is the defect
    -- class the audit found in two docblocks.
    new.nurture_reason := null;
  end if;

  return new;
end;
$$;

drop trigger if exists nurture_says_why_and_when on crm.leads;
create trigger nurture_says_why_and_when
  before insert or update on crm.leads
  for each row execute function crm.nurture_says_why_and_when();

comment on function crm.nurture_says_why_and_when() is
  'Doc 09 section 26: a lead in nurture carries a reason and a date to come back, and loses the reason the moment it leaves. Both are refused at the row rather than in a form, because the form is not the only door.';

-- ── the transition graph the DATABASE holds ───────────────────────────────
--
-- `LEAD_TRANSITIONS` in TypeScript is a RESTATEMENT so an illegal move is
-- refused before it reaches the database; `crm.leads_guard` is the authority.
-- Adding the status to one and not the other is how a state becomes
-- unreachable in production while every test passes — which is exactly what
-- happened here, and the live section caught it: three checks failed with
-- "a lead cannot move from qualifying to nurture" while the unit tests were
-- green.
--
-- Carried forward whole rather than patched, so the two lists can be read
-- against each other in one place. `converted` stays terminal and stays the
-- reversal this guard exists to refuse; `nurture` is reachable from anywhere
-- a lead is still alive and is a waiting room rather than a terminus.

create or replace function crm.leads_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
begin
  -- An edit that does not move the lead (a title change, a score, a note, the
  -- qualified_at the stamp trigger fills, a soft delete) is nothing to check.
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- The legal moves, as data: LEAD_TRANSITIONS ∪ markLeadConverted's convertible
  -- set. `converted` is terminal, and it is the reversal this guard exists to
  -- refuse.
  v_allowed := case old.status
    when 'new'          then array['qualifying', 'disqualified', 'converted']
    when 'qualifying'   then array['qualified', 'nurture', 'disqualified', 'converted']
    when 'qualified'    then array['converted', 'nurture', 'disqualified']
    -- G-203. Out again, which is the entire reason it is not `disqualified`.
    -- `converted` is included for the same reason the two above it are: a deal
    -- can be won straight out of a wait, and markLeadConverted is the path.
    when 'nurture'      then array['qualifying', 'qualified', 'disqualified', 'converted']
    when 'disqualified' then array['qualifying']
    when 'converted'    then array[]::text[]
    else array[]::text[]
  end;

  if not (new.status = any (v_allowed)) then
    raise exception 'a lead cannot move from % to %', old.status, new.status
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

-- ── and the pipeline stops counting it as open ────────────────────────────
--
-- `crm.sales_funnel` reads the lead's own status for the QUALIFIED stage,
-- because section 6 defines qualified as "enough information to pursue" and
-- nobody has said what enough is. A lead in nurture is not being pursued —
-- that is the whole meaning of the state — so it stops being counted there.
--
-- This is the number the finding is about: before this, the only way to stop
-- inflating "qualified" was to close the lead as lost with a reason that was
-- not true.
--
-- NO CHANGE TO THE VIEW WAS NEEDED, and that is worth saying: it already
-- reads `status in ('qualified', 'converted')`, so a lead that moves to
-- `nurture` leaves that set by itself. Nothing else in the view changes
-- either. A nurture lead still counts at every stage it genuinely reached —
-- contacted, replied, quoted — because those are facts about what happened,
-- not about where it sits now.

notify pgrst, 'reload schema';
