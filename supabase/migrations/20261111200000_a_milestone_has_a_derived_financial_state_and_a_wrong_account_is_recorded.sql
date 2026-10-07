-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9B - part 2: (a) the per-milestone financial lifecycle as a DERIVED read, (b) wrong-account validation as a RECORDED check.
--
-- (a) finance.milestone_financial_lifecycle(project) / finance.milestone_financial_state(milestone) compute, on every call, where each milestone stands
--     financially from the invoices, verified payments, waivers, refunds and open disputes. NOTHING IS STORED: there is no column to drift from the
--     invoice and payment statuses it is computed from (the reason Phase 9 refused a stored state machine). Precedence, most urgent first:
--       not_invoiced (no issued invoice) | disputed (an open chargeback / refund dispute on its invoices) | refunded (money was verified, then all of it
--       was refunded) | fully_verified (net verified money covers what was invoiced) | waived (nothing left to collect because an approved waiver covers
--       the rest) | overdue (a balance is owed past a due date) | partially_verified (some verified money, a balance remains) | invoiced.
--     Money is VERIFIED money only (the same definition as the close position): a payment a client claimed, or one nobody verified, moves nothing.
--
-- (b) finance.payment_account_checks records, ONCE per payment submission, whether the submission is consistent with the books it names: the payer it
--     names against the invoice's client account (a shared significant word in their names), and the receiving account it names against the agency's
--     accounts (active, inside its effective window). A difference opens a finance exception of kind wrong_account through the same table the existing
--     door writes (blocking, so a person looks), and NEVER changes the submission or the payment. Existing data only: no entity ownership is modelled
--     (owner decision P9-M011 stays open), so this is a flag for a person, not a ruling. Runner sweep + a door a Finance person / Admin may call.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── (a) the derived lifecycle ──────────────────────────────────────────────

create or replace function finance.phase9b_lifecycle_rows(p_project_id uuid)
returns table (milestone_id uuid, milestone_name text, milestone_position integer, state text, planned_minor bigint, invoiced_minor bigint, verified_net_minor bigint,
               waived_minor bigint, outstanding_minor bigint, refunded_minor bigint)
language sql stable security definer set search_path = '' as $$
  select q.id, q.name, q.position,
         case
           when q.n_inv = 0 then 'not_invoiced'
           when q.disputed then 'disputed'
           when q.collected > 0 and q.vnet = 0 and q.refunded > 0 then 'refunded'
           when q.invoiced > 0 and q.vnet >= q.invoiced then 'fully_verified'
           when q.outstanding = 0 and q.waived > 0 then 'waived'
           when q.past_due then 'overdue'
           when q.vnet > 0 then 'partially_verified'
           else 'invoiced' end,
         q.amount_minor::bigint, q.invoiced::bigint, q.vnet::bigint, q.waived::bigint, q.outstanding::bigint, q.refunded::bigint
    from (select m.id, m.name, m.position, m.amount_minor, m.created_at,
                 count(x.invoice_id) as n_inv,
                 coalesce(sum(x.total_minor), 0) as invoiced, coalesce(sum(x.collected_minor), 0) as collected, coalesce(sum(x.refunded_minor), 0) as refunded,
                 coalesce(sum(x.verified_net_minor), 0) as vnet, coalesce(sum(x.waived_minor), 0) as waived, coalesce(sum(x.outstanding_minor), 0) as outstanding,
                 coalesce(bool_or(x.outstanding_minor > 0 and x.due_at is not null and x.due_at < now()), false) as past_due,
                 coalesce(bool_or(exists (select 1 from finance.finance_exceptions e where e.invoice_id = x.invoice_id and e.state = 'open' and e.kind in ('chargeback', 'refund_dispute'))), false) as disputed
            from projects.milestones m
            left join finance.phase9_invoice_rows(p_project_id) x on x.milestone_id = m.id
           where m.project_id = p_project_id group by m.id) q
   order by q.position, q.created_at
$$;
revoke all on function finance.phase9b_lifecycle_rows(uuid) from public, anon, authenticated;
grant execute on function finance.phase9b_lifecycle_rows(uuid) to service_role;

create or replace function finance.milestone_financial_lifecycle(p_project_id uuid)
returns table (milestone_id uuid, milestone_name text, milestone_position integer, state text, planned_minor bigint, invoiced_minor bigint, verified_net_minor bigint,
               waived_minor bigint, outstanding_minor bigint, refunded_minor bigint)
language plpgsql stable security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_org uuid;
begin
  if v_kind = 'none' then return; end if;
  select p.organization_id into v_org from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then return; end if;
  if v_kind <> 'service' and v_org is distinct from (select core.current_organization_id()) then return; end if;
  return query select * from finance.phase9b_lifecycle_rows(p_project_id);
end $$;
revoke all on function finance.milestone_financial_lifecycle(uuid) from public, anon;
grant execute on function finance.milestone_financial_lifecycle(uuid) to authenticated, service_role;

create or replace function finance.milestone_financial_state(p_milestone_id uuid)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_project uuid; v_org uuid; v_state text;
begin
  if v_kind = 'none' then return null; end if;
  select m.project_id, m.organization_id into v_project, v_org from projects.milestones m where m.id = p_milestone_id;
  if v_project is null then return null; end if;
  if v_kind <> 'service' and v_org is distinct from (select core.current_organization_id()) then return null; end if;
  select l.state into v_state from finance.phase9b_lifecycle_rows(v_project) l where l.milestone_id = p_milestone_id;
  return v_state;
end $$;
revoke all on function finance.milestone_financial_state(uuid) from public, anon;
grant execute on function finance.milestone_financial_state(uuid) to authenticated, service_role;

-- ── (b) wrong-account validation, recorded ─────────────────────────────────

-- the significant words of a name: lower case, letters and digits only, three or more characters, minus corporate filler
create or replace function finance.phase9b_name_tokens(p_name text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct t.w), '{}'::text[])
    from (select unnest(string_to_array(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g')), ' ')) as w) t
   where length(t.w) >= 3 and t.w not in ('pvt', 'ltd', 'llp', 'inc', 'llc', 'the', 'and', 'private', 'limited', 'company', 'corp', 'corporation', 'co', 'sir', 'mrs', 'shri', 'smt')
$$;
revoke all on function finance.phase9b_name_tokens(text) from public, anon;
grant execute on function finance.phase9b_name_tokens(text) to authenticated, service_role;

create table if not exists finance.payment_account_checks (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  submission_id      uuid not null unique references finance.payment_submissions(id) on delete restrict,
  invoice_id         uuid not null references finance.invoices(id) on delete restrict,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  payment_account_id uuid references finance.payment_accounts(id) on delete restrict,
  outcome            text not null check (outcome in ('consistent', 'payer_differs', 'account_not_active', 'both')),
  payer_name         text,
  client_name        text not null,
  exception_id       uuid references finance.finance_exceptions(id) on delete restrict,
  checked_by         uuid references core.users(id) on delete set null,
  checked_by_system  boolean not null default false,
  checked_at         timestamptz not null default clock_timestamp(),
  -- a difference always leaves an exception for a person; a clean check leaves none
  check ((outcome = 'consistent') = (exception_id is null))
);

do $$
declare r record;
begin
  for r in select * from (values
    ('payment_account_checks', 'submission_id', 'finance.payment_submissions'), ('payment_account_checks', 'invoice_id', 'finance.invoices'),
    ('payment_account_checks', 'client_account_id', 'core.client_accounts'), ('payment_account_checks', 'payment_account_id', 'finance.payment_accounts'),
    ('payment_account_checks', 'exception_id', 'finance.finance_exceptions')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on finance.%I', 'org_match_' || r.tbl || '_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I, organization_id on finance.%I for each row execute function core.enforce_parent_org(%L, %L)', 'org_match_' || r.tbl || '_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['payment_account_checks']) as tbl loop
    execute format('alter table finance.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on finance.%I', r.tbl || '_select', r.tbl);
    execute format($p$create policy %I on finance.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())))$p$, r.tbl || '_select', r.tbl);
    execute format('revoke all on finance.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on finance.%I from authenticated', r.tbl);
    execute format('grant select on finance.%I to authenticated', r.tbl);
    execute format('grant all on finance.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on finance.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on finance.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
    execute format('drop trigger if exists %I on finance.%I', r.tbl || '_append_only', r.tbl);
    execute format('create trigger %I before update or delete on finance.%I for each row execute function finance.phase9_history_append_only()', r.tbl || '_append_only', r.tbl);
  end loop;
end $$;

-- the one check of one submission (no authorization of its own: the sweep and the door below call it)
create or replace function finance.phase9b_check_submission(p_submission_id uuid)
returns table (outcome text, check_id uuid, exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid()); v_s finance.payment_submissions; v_i finance.invoices; v_client text; v_acct finance.payment_accounts;
  v_payer_differs boolean := false; v_acct_bad boolean := false; v_outcome text; v_exc uuid; v_id uuid; v_reason text; v_at timestamptz; v_existing uuid;
begin
  select * into v_s from finance.payment_submissions s where s.id = p_submission_id;
  if v_s.id is null then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
  select c.id into v_existing from finance.payment_account_checks c where c.submission_id = v_s.id;
  if v_existing is not null then return query select 'already_checked'::text, v_existing, null::uuid; return; end if;
  select * into v_i from finance.invoices i where i.id = v_s.invoice_id;
  select a.name into v_client from core.client_accounts a where a.id = v_i.client_account_id;
  v_at := coalesce(v_s.paid_at, v_s.submitted_at);

  -- the payer it names against the client account (only when a payer is named: an unnamed payer is not a difference)
  if nullif(btrim(coalesce(v_s.payer_name, '')), '') is not null
     and not (finance.phase9b_name_tokens(v_s.payer_name) && finance.phase9b_name_tokens(v_client)) then
    v_payer_differs := true;
  end if;
  -- the receiving account it names against the agency's accounts (only when one is named)
  if v_s.account_id is not null then
    select * into v_acct from finance.payment_accounts a where a.id = v_s.account_id;
    if v_acct.id is null or v_acct.organization_id is distinct from v_s.organization_id or v_acct.status <> 'active' or v_at < v_acct.effective_from or (v_acct.effective_to is not null and v_at >= v_acct.effective_to) then
      v_acct_bad := true;
    end if;
  end if;
  v_outcome := case when v_payer_differs and v_acct_bad then 'both' when v_payer_differs then 'payer_differs' when v_acct_bad then 'account_not_active' else 'consistent' end;

  if v_outcome <> 'consistent' then
    -- a person may already have recorded this very difference: link it rather than duplicate it
    select e.id into v_exc from finance.finance_exceptions e where e.submission_id = v_s.id and e.kind = 'wrong_account' and e.state = 'open' limit 1;
    if v_exc is null then
      v_reason := 'Payment submission on invoice ' || v_i.number || ' does not line up with the books: '
        || case when v_payer_differs then 'the payer it names ("' || btrim(v_s.payer_name) || '") shares no word with the client account ("' || v_client || '")' else '' end
        || case when v_payer_differs and v_acct_bad then '; ' else '' end
        || case when v_acct_bad then 'the receiving account it names is not an active account of this agency at the time of payment' else '' end
        || '. The payment was not changed; a person decides.';
      insert into finance.finance_exceptions (organization_id, project_id, invoice_id, submission_id, kind, blocking, reason, evidence, opened_by, opened_by_system)
      values (v_s.organization_id, v_i.project_id, v_i.id, v_s.id, 'wrong_account', true, left(v_reason, 1000),
              jsonb_build_object('check', 'phase9b_payment_account', 'outcome', v_outcome, 'payerName', v_s.payer_name, 'clientName', v_client, 'paymentAccountId', v_s.account_id), v_actor, v_actor is null)
      returning id into v_exc;
    end if;
  end if;

  insert into finance.payment_account_checks (organization_id, submission_id, invoice_id, client_account_id, payment_account_id, outcome, payer_name, client_name, exception_id, checked_by, checked_by_system)
  values (v_s.organization_id, v_s.id, v_i.id, v_i.client_account_id, v_s.account_id, v_outcome, v_s.payer_name, v_client, v_exc, v_actor, v_actor is null)
  returning id into v_id;
  perform core.record_audit(v_s.organization_id, 'finance.payment_account_checked', 'payment_submission', v_s.id, null, jsonb_build_object('outcome', v_outcome, 'exceptionId', v_exc));
  return query select v_outcome, v_id, v_exc;
end $$;
revoke all on function finance.phase9b_check_submission(uuid) from public, anon, authenticated;
grant execute on function finance.phase9b_check_submission(uuid) to service_role;

-- a Finance person or Admin (or the runner) checks one submission now
create or replace function finance.check_payment_account(p_submission_id uuid)
returns table (outcome text, check_id uuid, exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_org uuid;
begin
  if v_kind = 'none' then return query select 'not_authorized'::text, null::uuid, null::uuid; return; end if;
  select s.organization_id into v_org from finance.payment_submissions s where s.id = p_submission_id;
  if v_org is null or (v_kind <> 'service' and v_org is distinct from (select core.current_organization_id())) then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
  return query select * from finance.phase9b_check_submission(p_submission_id);
end $$;
revoke all on function finance.check_payment_account(uuid) from public, anon;
grant execute on function finance.check_payment_account(uuid) to authenticated, service_role;

-- the runner checks every unresolved submission that has not been checked yet (idempotent: a submission is checked once)
create or replace function finance.sweep_payment_account_checks(p_limit integer default 200)
returns table (checked integer, flagged integer)
language plpgsql security definer set search_path = '' as $$
declare v_checked int := 0; v_flagged int := 0; r record; o record;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0; return; end if;
  for r in select s.id from finance.payment_submissions s
            where s.status in ('pending_verification', 'evidence_requested', 'mismatch')
              and not exists (select 1 from finance.payment_account_checks c where c.submission_id = s.id)
            order by s.submitted_at limit greatest(p_limit, 1) loop
    select * into o from finance.phase9b_check_submission(r.id);
    if o.outcome in ('consistent', 'payer_differs', 'account_not_active', 'both') then
      v_checked := v_checked + 1;
      if o.outcome <> 'consistent' then v_flagged := v_flagged + 1; end if;
    end if;
  end loop;
  return query select v_checked, v_flagged;
end $$;
revoke all on function finance.sweep_payment_account_checks(integer) from public, anon, authenticated;
grant execute on function finance.sweep_payment_account_checks(integer) to service_role;

notify pgrst, 'reload schema';
