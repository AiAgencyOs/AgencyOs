-- ═══════════════════════════════════════════════════════════════════════════
-- A won deal implies a qualified lead.
--
-- Gap G-086, decision ADM-41, answered in as many words:
--
--   "A won deal implies its lead was qualified. The system fills in the
--    qualification date rather than leaving a hole in the history."
--
-- `qualified_at` is stamped in exactly one place — `setLeadStatus`, on the move
-- into `qualified` — and `leads_qualified_at_set` constrains that status alone:
--
--   check (status <> 'qualified' or qualified_at is not null)
--
-- So a lead that goes straight from `new` to `converted` is a **client with no
-- record of ever having been qualified**. The database is content; every funnel
-- report that measures qualification is wrong, and wrong in the direction that
-- flatters nobody: the qualification step looks skipped for deals that were in
-- fact won.
--
-- That path is not exotic. `createOpportunity` refuses only a *disqualified*
-- lead, so deals open routinely on `new` and `qualifying` ones — which D20
-- established and G-087 records — and `markLeadConverted` then moves the lead
-- to `converted` from wherever it was.
--
-- ── a trigger, not a service change ───────────────────────────────────────
--
-- The G-093 argument, which has now paid for itself twice in one day: a
-- trigger covers **every path** into the table — the service, a backfill, a
-- write straight through PostgREST — and this column has exactly the shape
-- that gets missed, because nothing refuses a null.
--
-- `before update` rather than `after`, because the point is to fill the column
-- on the row being written rather than to correct it afterwards.
--
-- ── what it does not do ───────────────────────────────────────────────────
--
-- **It never overwrites an existing date.** A lead qualified in March and
-- converted in June keeps March: the date records when qualification happened,
-- and moving it to the conversion would replace a fact with a guess.
--
-- **It does not touch `disqualified`.** ADM-41 speaks about a *won* deal.
-- A disqualified lead was never qualified, and stamping one would invent a
-- step that did not happen.
--
-- **It does not backfill history.** Rows already converted with a null keep
-- it. A date invented now would be indistinguishable from one recorded at the
-- time, and a report that silently gained accurate-looking history it never
-- had is worse than one with a visible hole. Whether to backfill, and with
-- what date, is a question for whoever owns the numbers — recorded as G-120.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function crm.stamp_qualified_on_conversion()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Only the arrival at `converted`, and only when the date is missing.
  -- `is distinct from` rather than `<>` so a null old status behaves.
  if new.status = 'converted'
     and old.status is distinct from 'converted'
     and new.qualified_at is null
  then
    -- coalesce, not an assignment: if the row already carried a date the
    -- condition above would not have fired, and this keeps the intent legible
    -- to the next reader — the existing fact always wins.
    new.qualified_at := coalesce(old.qualified_at, new.converted_at, now());
  end if;

  return new;
end;
$$;

comment on function crm.stamp_qualified_on_conversion() is
  'Fills qualified_at when a lead reaches converted without one (G-086, ADM-41: a won deal implies its lead was qualified). Never overwrites an existing date - a lead qualified in March and converted in June keeps March. A trigger rather than a service change, so it covers every path into the table including PostgREST.';

drop trigger if exists stamp_qualified_on_conversion on crm.leads;
create trigger stamp_qualified_on_conversion
  before update on crm.leads
  for each row execute function crm.stamp_qualified_on_conversion();

-- ── and the constraint says what is now true ──────────────────────────────
--
-- The old one bound `qualified` alone. `converted` now carries the same
-- promise, so the check states it rather than leaving it to the trigger: a
-- constraint is what makes the invariant survive a trigger somebody disables.
alter table crm.leads
  drop constraint if exists leads_qualified_at_set;

alter table crm.leads
  add constraint leads_qualified_at_set check (
    status not in ('qualified', 'converted') or qualified_at is not null
  )
  -- NOT VALID: rows converted before this migration keep their null, which is
  -- the deliberate no-backfill above. New and updated rows are checked; the
  -- history is left visibly incomplete rather than quietly invented.
  not valid;

comment on constraint leads_qualified_at_set on crm.leads is
  'A qualified or converted lead carries the date it was qualified (G-086, ADM-41). NOT VALID on purpose: rows converted before this migration keep their null rather than being backfilled with a date nobody recorded - see G-120.';
