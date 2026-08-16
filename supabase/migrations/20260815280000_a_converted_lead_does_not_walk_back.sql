-- ═══════════════════════════════════════════════════════════════════════════
-- A converted lead does not walk back into the pipeline.
--
-- `crm.leads` carries a status machine — new → qualifying → qualified →
-- converted, with disqualified off to the side — and `converted` is terminal:
-- ADM-05, "one lead per person, forever; a returning client gets a new DEAL on
-- their existing lead", and the returning-client work (20260813120025)
-- deliberately does NOT reopen the lead when a second deal arrives. The machine
-- is enforced in the service layer — `updateLeadStatus` matches LEAD_TRANSITIONS
-- (crm/schema.ts) and `markLeadConverted` is a compare-and-swap — but NOTHING in
-- the database held it. leads_write is `is_admin()` (owner OR ops_admin) with
-- UPDATE granted to authenticated, so an admin could PATCH a lead straight over
-- the Data API: `converted` → `qualifying` reverses a lead that is already a
-- client back into the active funnel, `qualified` → `new` walks the funnel
-- backward, and the `leads_converted_at_set` CHECK does not stand in the way
-- (it only requires converted_at WHEN status = 'converted', so leaving converted
-- passes it and leaves converted_at behind as a stale date on a re-opened lead).
--
-- This gives the machine a DB guard, mirroring the deliverables / handovers /
-- proposals guards: a status change is refused unless it is one the engine
-- itself would make. The allowed moves are the union of the two service writers
-- — LEAD_TRANSITIONS plus markLeadConverted's wider convertible set (new,
-- qualifying and qualified may all convert, because createOpportunity refuses
-- only a disqualified lead, so a deal can be won on a lead nobody explicitly
-- qualified). `converted` is terminal; every backward or skipping move is
-- refused.
--
-- Scope note — UPDATE only, deliberately, unlike the sibling guards which also
-- force the initial status on INSERT. A lead legitimately STARTS in more than
-- one state (import and manual entry create qualifying/qualified leads, not just
-- new), so there is no single "born" status to force; and a lead born
-- `converted` by a direct INSERT unlocks nothing — no gate reads lead.status to
-- grant money or access (convertToProject WRITES `converted`, it does not read
-- it), so the INSERT vector that mattered for a deliverable's `approved` does
-- not exist here. The reversal of an EXISTING converted lead is the whole risk,
-- and it lives on the UPDATE path.
-- ═══════════════════════════════════════════════════════════════════════════

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
    when 'qualifying'   then array['qualified', 'disqualified', 'converted']
    when 'qualified'    then array['converted', 'disqualified']
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

comment on function crm.leads_guard() is
  'Enforces the crm.leads status machine on UPDATE: the allowed moves are the union of updateLeadStatus''s LEAD_TRANSITIONS and markLeadConverted''s convertible set (new/qualifying/qualified -> converted), and converted is terminal — so a direct PATCH cannot reverse a converted lead back into the pipeline or walk the funnel backward. UPDATE only by design: a lead legitimately starts in more than one state, and a lead born converted unlocks no gate (nothing reads lead.status for authorization), so only the reversal of an existing lead is a risk.';

drop trigger if exists leads_guard on crm.leads;
create trigger leads_guard
  before update on crm.leads
  for each row execute function crm.leads_guard();
