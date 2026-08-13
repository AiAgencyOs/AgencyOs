-- ═══════════════════════════════════════════════════════════════════════════
-- A deal can be repriced, and a reopened one forgets how it closed.
--
-- Gaps G-092 and the open half of G-089, decision ADM-43:
--
--   "An open deal's value may be changed by the owner or an ops admin. Every
--    change is written to the audit log with the old and new amount."
--
-- Two halves of one surface, which is why they are one migration: a deal had
-- **no update path at all**. `value_minor`, `name` and `expected_close_on`
-- were written once at insert and never again, and the fields that record how
-- a deal ended were cleared by exactly one function.
--
-- ── the money half (G-092) ────────────────────────────────────────────────
--
-- A deal lost at one value and re-won at another still converted into a
-- project budgeted at the old one — and since G-017, that number is also what
-- the accepted quotation is measured against. There was no way to correct it
-- short of writing SQL by hand.
--
-- "An **open** deal's" is taken literally: a settled deal is history, and
-- repricing one would rewrite what was agreed. `won` in particular has already
-- become a project's budget and possibly an invoice.
--
-- ── the hygiene half (G-089) ──────────────────────────────────────────────
--
-- `setOpportunityStage` clears `closed_at` and `lost_reason` when a deal
-- leaves a terminal stage — correct, and **service-only**. A reopen written
-- any other way left a `discovery` deal carrying the day it closed and why it
-- was lost, which every report of "why do we lose deals" then counted as a
-- live loss.
--
-- Moved into a trigger for the G-093 reason, which has now paid for itself
-- three times: it covers every path, including a write straight through
-- PostgREST. The service keeps its own clearing — harmless, and removing it
-- would make the service read as though it had forgotten the rule.
--
-- ── what is deliberately absent ───────────────────────────────────────────
--
-- **No audit call.** `audit.record_row_change` already names
-- `opportunity.value_changed` from the column diff (G-093), so ADM-43's "every
-- change is written to the audit log with the old and new amount" is satisfied
-- by the trigger that already exists. Writing a second one here would be the
-- two-mechanism state G-093 removed.
--
-- **No role check in the function.** `opportunities_write` is already
-- `core.is_admin()` — owner and ops_admin, exactly who ADM-43 names — so the
-- rule is enforced by RLS on a SECURITY INVOKER function. A check here would
-- be a second copy of that rule, free to drift.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. A reopened deal forgets how it closed, on every path
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sales.clear_settlement_on_reopen()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Leaving a terminal stage is the only way a deal reopens. Written against
  -- "was terminal, now is not" rather than against `lost` specifically, so
  -- opening `won` later is a change to the transition map alone.
  if old.stage in ('won', 'lost')
     and new.stage not in ('won', 'lost')
  then
    new.closed_at   := null;
    new.lost_reason := null;
  end if;

  return new;
end;
$$;

comment on function sales.clear_settlement_on_reopen() is
  'Clears closed_at and lost_reason when a deal leaves a terminal stage (G-089). setOpportunityStage already did this; the trigger covers every other path, including a write straight through PostgREST, which would otherwise leave a discovery deal carrying the day it closed and why it was lost - counted by every report of why deals are lost.';

drop trigger if exists clear_settlement_on_reopen on sales.opportunities;
create trigger clear_settlement_on_reopen
  before update on sales.opportunities
  for each row execute function sales.clear_settlement_on_reopen();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. An open deal's terms can be corrected
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function sales.set_opportunity_terms(
  p_opportunity_id   uuid,
  p_value_minor      bigint default null,
  p_name             text   default null,
  p_expected_close_on date  default null
)
returns table (
  -- 'updated' | 'not_found' | 'settled' | 'nothing_to_change'
  outcome            text,
  value_minor        bigint,
  name               text,
  expected_close_on  date
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row   sales.opportunities;
  v_value bigint;
  v_name  text;
  v_date  date;
begin
  -- Locked, so two people correcting the same deal serialise rather than one
  -- silently overwriting the other's number. A price is exactly the field
  -- where that matters.
  select o.* into v_row
    from sales.opportunities o
   where o.id = p_opportunity_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::bigint, null::text, null::date;
    return;
  end if;

  -- ADM-43 says "an OPEN deal's value". A settled deal is history: a won one
  -- has already become a project's budget and possibly an invoice, and a lost
  -- one records what was on the table when it was lost.
  if v_row.stage in ('won', 'lost') then
    return query select 'settled'::text, v_row.value_minor, v_row.name, v_row.expected_close_on;
    return;
  end if;

  -- Null means "leave alone" rather than "set to null", which is what lets one
  -- function correct a price without also clearing a name.
  v_value := coalesce(p_value_minor, v_row.value_minor);
  v_name  := coalesce(nullif(btrim(p_name), ''), v_row.name);
  v_date  := coalesce(p_expected_close_on, v_row.expected_close_on);

  if v_value = v_row.value_minor
     and v_name = v_row.name
     and v_date is not distinct from v_row.expected_close_on
  then
    -- Answered rather than written. An update that changes nothing would still
    -- move updated_at, and audit.record_row_change deliberately drops a diff
    -- that is only updated_at — so the write would be invisible in the log
    -- while looking like an edit to anything watching the row.
    return query select 'nothing_to_change'::text, v_row.value_minor, v_row.name, v_row.expected_close_on;
    return;
  end if;

  update sales.opportunities
     set value_minor       = v_value,
         name              = v_name,
         expected_close_on = v_date
   where sales.opportunities.id = p_opportunity_id
     -- The predicate the decision was made under, restated in the write: a
     -- deal settled between the read above and this line must not be repriced.
     and sales.opportunities.stage not in ('won', 'lost')
  returning * into v_row;

  if v_row.id is null then
    return query select 'settled'::text, null::bigint, null::text, null::date;
    return;
  end if;

  -- No audit call: audit.record_row_change already names
  -- 'opportunity.value_changed' from the diff, with the old and new row, which
  -- is what ADM-43 asks for.
  return query select 'updated'::text, v_row.value_minor, v_row.name, v_row.expected_close_on;
end;
$$;

comment on function sales.set_opportunity_terms(uuid, bigint, text, date) is
  'Corrects an open deal''s value, name or expected close date (G-092, ADM-43). Refuses a settled deal, because a won one has already become a project''s budget and a lost one records what was on the table. A null argument means leave alone, not set to null. No role check and no audit call: opportunities_write is already core.is_admin(), exactly who ADM-43 names, and audit.record_row_change already logs the change from the column diff.';

revoke all on function sales.set_opportunity_terms(uuid, bigint, text, date) from public;
grant execute on function sales.set_opportunity_terms(uuid, bigint, text, date) to authenticated, service_role;
