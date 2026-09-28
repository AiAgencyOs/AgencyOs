-- ═══════════════════════════════════════════════════════════════════════════
-- The M2 gate was reading M3.
--
-- Found driving `tests/phase4-full-pipeline-e2e.test.ts` against a real
-- scratch Postgres — the exact class of defect this repository's own
-- discipline (`scripts/apply-migrations-locally.sh`'s header, "40 review
-- defects passed every regex") exists to catch, and a live full-pipeline run
-- is what finally exercised the path that had it.
--
-- `projects.replace_payment_plan` (20260812120001) numbers milestones with
-- `jsonb_array_elements ... WITH ORDINALITY` minus one — 0-indexed. Every
-- other reader of `projects.milestones.position` in this codebase already
-- agrees: every list/detail view renders `milestone.position + 1` for the
-- human-facing number (`app/(internal)/projects/[projectId]/page.tsx`,
-- `app/(internal)/invoices/[invoiceId]/page.tsx`), and
-- `LOCKED_PAYMENT_STRUCTURE[].position` (1..4, `src/modules/projects/
-- payment-structure.ts`) is never read back from the database — it is a
-- label nobody consults, not a stored convention.
--
-- This function alone assumed the 1-indexed label instead: `m.position = 2`
-- means M3 (30%, "On development completion"), not M2 (20%, "On UI prototype
-- approval"). Confirmed live: a fresh `replace_payment_plan([M1,M2,M3,M4])`
-- call puts them at positions 0/1/2/3.
--
-- Two TypeScript readers had the identical off-by-one and are fixed
-- alongside this migration, not by it (they read the Data API, not SQL):
-- `generateFirstMilestoneInvoice`/`generateM2Invoice`
-- (`src/modules/finance/service.ts`, `.eq('position', 1)` /
-- `.eq('position', 2)` → `0` / `1`) and `announceM2PaymentVerified`
-- (`src/modules/crm/handlers.ts`, `milestone.position !== 2` → `!== 1`).
-- Before this fix, a real M2 payment verification would have announced
-- "not mine" for the actual M2 milestone and would have matched M3's row
-- instead, and `generateM2Invoice` would have silently invoiced M3's amount
-- (30% of the contract) under Task 2's completion trigger rather than M2's
-- (20%) — exactly the wrong bill at exactly the wrong milestone.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.phase_five_gate_status(
  p_project_id uuid
)
returns table (
  -- 'verified' | 'invoice_issued' | 'no_m2_milestone' | 'not_ready'
  outcome          text,
  m2_invoice_id    uuid,
  m2_invoice_status text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    case
      when i.status = 'paid' then 'verified'
      when i.id is not null then 'invoice_issued'
      when m.id is null then 'no_m2_milestone'
      else 'not_ready'
    end,
    i.id,
    i.status
  from projects.milestones m
  left join finance.invoices i on i.milestone_id = m.id and i.status <> 'void'
  where m.project_id = p_project_id
    -- Fixed: position is 0-indexed (see migration header). M2 is 1, not 2.
    and m.position = 1
  limit 1;
$$;

comment on function projects.phase_five_gate_status(uuid) is
  'Master''s own Admin Panel question, answered directly: "CAN PHASE 5 START?" Reads whether M2''s invoice has actually been marked paid by finance.verify_payment_submission (the only door that can) — Phase4Completed, an issued invoice, a payment submission or a proof upload all answer anything but ''verified''. security invoker: relies on the caller''s own RLS, the same as every other read-only helper in this schema. position = 1, not 2: projects.milestones.position is 0-indexed (20260929100000).';

revoke all on function projects.phase_five_gate_status(uuid) from public, anon;
grant execute on function projects.phase_five_gate_status(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
