-- ═══════════════════════════════════════════════════════════════════════════
-- P710: the Phase 7 financial gate consults Phase 9 (finance.project_is_financially_closed, finance.finance_exceptions, finance.project_financial_closes).
--
-- The rule, stated once: a project that has NEVER met Phase 9 (no financial close row and no open blocking finance exception) is judged exactly as before.
-- A project that has met it is judged by it:
--   * an OPEN BLOCKING finance exception (a chargeback, a wrong amount, an overdue invoice, an unmatched payment ...) makes the clearance NOT clear: the
--     financial close is required, and one cannot be recorded while a blocker stands;
--   * a project that HAS a financial close row must still read as financially closed through finance.project_is_financially_closed (the one fact Phase 9
--     exposes to Phase 7), and a blocking exception opened after the close is not hidden by it.
-- It is folded into the existing `no_open_dispute` row: the clearance keeps its FIVE rows (the Phase 7 verifier counts them), so every honest Phase 7 flow
-- is unchanged. Patches the LIVE definition and raises if any expected text is missing.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function pg_temp.p7b_swap(p_src text, p_old text, p_new text)
returns text language plpgsql as $$
begin
  if position(p_old in p_src) = 0 then raise exception 'p7_financial_clearance patch: expected text not found: %', left(p_old, 90); end if;
  return replace(p_src, p_old, p_new);
end $$;

do $$
declare
  v_def text := pg_get_functiondef('projects.p7_financial_clearance(uuid)'::regprocedure);
begin
  v_def := pg_temp.p7b_swap(v_def, 'v_org uuid; v_m4 uuid; v_n int;', 'v_org uuid; v_m4 uuid; v_n int; v_blk int;');
  v_def := pg_temp.p7b_swap(v_def,
    $old$gate := 'no_open_dispute'; satisfied := not exists (select 1 from projects.p7_financial_exceptions e where e.project_id = p_project_id and e.status = 'open' and e.kind in ('dispute', 'chargeback', 'adjustment'));$old$,
    $new$select count(*) into v_blk from finance.finance_exceptions fx
   where fx.organization_id = v_org and fx.state = 'open' and fx.blocking and (fx.project_id = p_project_id or fx.invoice_id in (select i.id from finance.invoices i where i.project_id = p_project_id));
  gate := 'no_open_dispute';
  satisfied := not exists (select 1 from projects.p7_financial_exceptions e where e.project_id = p_project_id and e.status = 'open' and e.kind in ('dispute', 'chargeback', 'adjustment'))
    and v_blk = 0
    and (not exists (select 1 from finance.project_financial_closes c where c.project_id = p_project_id) or finance.project_is_financially_closed(p_project_id));$new$);
  v_def := pg_temp.p7b_swap(v_def,
    $old$detail := case when satisfied then 'no dispute, chargeback or adjustment is open' else 'a dispute, chargeback or adjustment is open and stays visible until resolved or waived by an Admin' end;$old$,
    $new$detail := case when satisfied and exists (select 1 from finance.project_financial_closes c where c.project_id = p_project_id) then 'no dispute, chargeback or adjustment is open, and the project is financially closed (Phase 9)'
                      when satisfied then 'no dispute, chargeback or adjustment is open'
                      when v_blk > 0 then format('%s blocking finance exception(s) are open (Phase 9): the financial close is required and cannot be recorded while one stands', v_blk)
                      else 'a dispute, chargeback or adjustment is open and stays visible until resolved or waived by an Admin' end;$new$);
  execute v_def;
end $$;

notify pgrst, 'reload schema';
