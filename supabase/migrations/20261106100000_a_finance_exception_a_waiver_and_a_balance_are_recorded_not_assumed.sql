-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9 (Finance Agent, cross-phase financial control) - part 1: exceptions, waivers and the one definition of "outstanding".
--
-- WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT TOUCH
--   * It does not verify a payment, change an amount, record a refund or send a client anything. finance.verify_payment* (owner / runner only) and the
--     refund doors are exactly as they were. The service-role exemption in them is a documented owner decision and is neither widened nor narrowed.
--   * finance.finance_exceptions  - the structured exception queue the Phase 9 plan (WS5) asks for: wrong amount / account, unclear proof, gateway
--     mismatch, overdue, overpayment, unmatched or duplicate payment, refund dispute, CHARGEBACK, tax correction, waiver request. A blocking exception
--     is resolved by someone OTHER than the person who opened it (creator != resolver). A resolved exception is history.
--   * finance.waivers             - a waiver / write-off is a governed record, never an edit of an invoice. It is requested by Finance or an Admin and
--     DECIDED by an Admin who is not the requester (a CHECK, not a convention). An approved waiver reduces the COLLECTIBLE balance and is reported on
--     its own line: it is never cash received and never revenue.
--   * finance.invoice_outstanding_minor - ONE definition of what is still owed: total - net VERIFIED money - approved waivers. Money a client merely
--     claimed (a submission, a screenshot, a captured-but-unverified payment) is not in it. The invoice row itself is never rewritten to make a
--     balance reconcile.
--   * finance.sweep_finance_exceptions - service role only. Opens OVERDUE and OVERPAYMENT exceptions from the state of the books (idempotent: at most one
--     open of each per invoice) and closes an overdue one when the invoice stopped being overdue (the state is re-checked at execution time).
--   * the invoice-reminder candidate list no longer offers an invoice whose whole balance was waived (a client must not be chased for a debt the business
--     forgave). Every other invoice is selected exactly as before.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── helpers ────────────────────────────────────────────────────────────────

create or replace function finance.phase9_history_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a % record is history and is never edited or deleted', tg_table_name using errcode = 'restrict_violation'; end $$;

-- who is calling: the runner (service role, no signed-in person), an Admin, a Finance person, or nobody who may act on money records
create or replace function finance.phase9_caller_kind()
returns text language plpgsql stable set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    return case when coalesce((select auth.role()), '') = 'service_role' then 'service' else 'none' end;
  end if;
  if coalesce((select core.is_admin()), false) then return 'admin'; end if;
  if coalesce((select core.is_finance()), false) then return 'finance'; end if;
  return 'none';
end $$;
revoke all on function finance.phase9_caller_kind() from public, anon;
grant execute on function finance.phase9_caller_kind() to authenticated, service_role;

-- a secret value in free text (the same shape the QA specialists' door refuses)
create or replace function finance.phase9_has_secret(p_text text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_text, '') ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-.]{12,}'
      or coalesce(p_text, '') ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})'
$$;
revoke all on function finance.phase9_has_secret(text) from public, anon;
grant execute on function finance.phase9_has_secret(text) to authenticated, service_role;

-- ── the exception queue ────────────────────────────────────────────────────

create table if not exists finance.finance_exceptions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid references projects.projects(id) on delete restrict,
  invoice_id         uuid references finance.invoices(id) on delete restrict,
  submission_id      uuid references finance.payment_submissions(id) on delete restrict,
  kind               text not null check (kind in ('wrong_amount', 'wrong_account', 'unclear_proof', 'gateway_mismatch', 'overdue', 'overpayment', 'unmatched_payment', 'duplicate_payment', 'refund_dispute', 'chargeback', 'tax_correction', 'waiver_request', 'other')),
  blocking           boolean not null default true,
  state              text not null default 'open' check (state in ('open', 'resolved', 'dismissed')),
  reason             text not null check (length(btrim(reason)) between 1 and 1000),
  evidence           jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  opened_by          uuid references core.users(id) on delete set null,
  opened_by_system   boolean not null default false,
  opened_at          timestamptz not null default clock_timestamp(),
  resolved_by        uuid references core.users(id) on delete set null,
  resolved_by_system boolean not null default false,
  resolution_note    text,
  resolved_at        timestamptz,
  check (project_id is not null or invoice_id is not null),
  -- a chargeback and an overpayment are never "non-blocking": zero balance with an open chargeback must not pass a close
  check (kind not in ('chargeback', 'overpayment') or blocking),
  check ((state = 'open' and resolved_at is null and resolution_note is null)
      or (state <> 'open' and resolved_at is not null and resolution_note is not null and length(btrim(resolution_note)) > 0))
);
create unique index if not exists finance_exceptions_one_open_system_kind
  on finance.finance_exceptions (invoice_id, kind) where state = 'open' and invoice_id is not null and kind in ('overdue', 'overpayment');
create index if not exists finance_exceptions_project_idx on finance.finance_exceptions (project_id, state);
create index if not exists finance_exceptions_org_open_idx on finance.finance_exceptions (organization_id, opened_at desc) where state = 'open';

create or replace function finance.finance_exceptions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a finance exception is history and is never deleted' using errcode = 'restrict_violation';
  end if;
  if old.state <> 'open' then
    raise exception 'a resolved finance exception is history and is never edited' using errcode = 'restrict_violation';
  end if;
  if (new.id, new.organization_id, new.project_id, new.invoice_id, new.submission_id, new.kind, new.blocking, new.reason, new.evidence, new.opened_by, new.opened_by_system, new.opened_at)
     is distinct from (old.id, old.organization_id, old.project_id, old.invoice_id, old.submission_id, old.kind, old.blocking, old.reason, old.evidence, old.opened_by, old.opened_by_system, old.opened_at) then
    raise exception 'only the resolution of a finance exception may change; what it was about is evidence' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists finance_exceptions_guard on finance.finance_exceptions;
create trigger finance_exceptions_guard before update or delete on finance.finance_exceptions for each row execute function finance.finance_exceptions_guard();

-- ── waivers ────────────────────────────────────────────────────────────────

create table if not exists finance.waivers (
  id                            uuid primary key default gen_random_uuid(),
  organization_id               uuid not null references core.organizations(id) on delete cascade,
  invoice_id                    uuid not null references finance.invoices(id) on delete restrict,
  project_id                    uuid references projects.projects(id) on delete restrict,
  amount_minor                  bigint not null check (amount_minor > 0),
  reason                        text not null check (length(btrim(reason)) between 1 and 1000),
  status                        text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  requested_by                  uuid not null references core.users(id) on delete restrict,
  requested_at                  timestamptz not null default clock_timestamp(),
  decided_by                    uuid references core.users(id) on delete restrict,
  decided_at                    timestamptz,
  decision_note                 text,
  outstanding_at_decision_minor bigint,
  check ((status = 'requested') = (decided_at is null and decided_by is null)),
  check (status = 'requested' or (decision_note is not null and length(btrim(decision_note)) > 0)),
  -- separation of duties in the database: whoever asked for a waiver cannot be the one who grants it
  check (decided_by is null or decided_by <> requested_by)
);
create unique index if not exists waivers_one_pending_per_invoice on finance.waivers (invoice_id) where status = 'requested';
create index if not exists waivers_invoice_idx on finance.waivers (invoice_id, status);

create or replace function finance.waivers_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a waiver is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if old.status <> 'requested' then raise exception 'a decided waiver is history and is never edited' using errcode = 'restrict_violation'; end if;
  if (new.id, new.organization_id, new.invoice_id, new.project_id, new.amount_minor, new.reason, new.requested_by, new.requested_at)
     is distinct from (old.id, old.organization_id, old.invoice_id, old.project_id, old.amount_minor, old.reason, old.requested_by, old.requested_at) then
    raise exception 'a requested waiver is decided, never rewritten' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists waivers_guard on finance.waivers;
create trigger waivers_guard before update or delete on finance.waivers for each row execute function finance.waivers_guard();

-- ── tenancy, RLS, grants (finance and admin read; nobody writes except through a door) ──
do $$
declare r record;
begin
  for r in select * from (values
    ('finance_exceptions', 'project_id', 'projects.projects'), ('finance_exceptions', 'invoice_id', 'finance.invoices'), ('finance_exceptions', 'submission_id', 'finance.payment_submissions'),
    ('waivers', 'invoice_id', 'finance.invoices'), ('waivers', 'project_id', 'projects.projects')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on finance.%I', 'org_match_' || r.tbl || '_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I, organization_id on finance.%I for each row execute function core.enforce_parent_org(%L, %L)', 'org_match_' || r.tbl || '_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['finance_exceptions', 'waivers']) as tbl loop
    execute format('alter table finance.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on finance.%I', r.tbl || '_select', r.tbl);
    execute format($p$create policy %I on finance.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())))$p$, r.tbl || '_select', r.tbl);
    execute format('revoke all on finance.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on finance.%I from authenticated', r.tbl);
    execute format('grant select on finance.%I to authenticated', r.tbl);
    execute format('grant all on finance.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on finance.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on finance.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
end $$;

-- ── one definition of "still owed" ─────────────────────────────────────────

-- verified money only (finance.net_verified_minor); a claim, a submission and a captured-but-unverified payment are not in it; waivers are separate
create or replace function finance.invoice_waived_minor(p_invoice_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(w.amount_minor), 0)::bigint from finance.waivers w where w.invoice_id = p_invoice_id and w.status = 'approved'
$$;
revoke all on function finance.invoice_waived_minor(uuid) from public, anon, authenticated;
grant execute on function finance.invoice_waived_minor(uuid) to service_role;

create or replace function finance.invoice_outstanding_minor(p_invoice_id uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select case when i.status in ('draft', 'pending_approval', 'void') then 0::bigint
              else greatest(i.total_minor - greatest(finance.net_verified_minor(i.id), 0) - finance.invoice_waived_minor(i.id), 0)::bigint end
    from finance.invoices i where i.id = p_invoice_id
$$;
revoke all on function finance.invoice_outstanding_minor(uuid) from public, anon, authenticated;
grant execute on function finance.invoice_outstanding_minor(uuid) to service_role;

-- ── open a finance exception (a person in Finance / Admin, or the runner) ──
create or replace function finance.open_finance_exception(
  p_kind text, p_reason text, p_project_id uuid default null, p_invoice_id uuid default null, p_submission_id uuid default null, p_evidence jsonb default '{}'::jsonb)
returns table (outcome text, exception_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := finance.phase9_caller_kind();
  v_actor uuid := (select auth.uid());
  v_org uuid; v_inv finance.invoices; v_sub finance.payment_submissions; v_proj projects.projects; v_id uuid; v_project uuid := p_project_id;
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
begin
  if v_kind = 'none' then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind is null or p_kind not in ('wrong_amount', 'wrong_account', 'unclear_proof', 'gateway_mismatch', 'overdue', 'overpayment', 'unmatched_payment', 'duplicate_payment', 'refund_dispute', 'chargeback', 'tax_correction', 'waiver_request', 'other') then
    return query select 'bad_kind'::text, null::uuid; return;
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 1000 or jsonb_typeof(v_evidence) <> 'object' then return query select 'bad_input'::text, null::uuid; return; end if;
  if finance.phase9_has_secret(p_reason || ' ' || v_evidence::text) then return query select 'secret_in_text'::text, null::uuid; return; end if;
  if p_invoice_id is null and p_project_id is null and p_submission_id is null then return query select 'name_a_subject'::text, null::uuid; return; end if;

  if p_submission_id is not null then
    select * into v_sub from finance.payment_submissions s where s.id = p_submission_id;
    if v_sub.id is null then return query select 'not_found'::text, null::uuid; return; end if;
    if p_invoice_id is not null and p_invoice_id is distinct from v_sub.invoice_id then return query select 'subject_mismatch'::text, null::uuid; return; end if;
    v_org := v_sub.organization_id;
  end if;
  if p_invoice_id is not null or v_sub.id is not null then
    select * into v_inv from finance.invoices i where i.id = coalesce(p_invoice_id, v_sub.invoice_id);
    if v_inv.id is null then return query select 'not_found'::text, null::uuid; return; end if;
    v_org := v_inv.organization_id;
    if v_project is not null and v_inv.project_id is distinct from v_project then return query select 'subject_mismatch'::text, null::uuid; return; end if;
    v_project := coalesce(v_project, v_inv.project_id);
  end if;
  if v_project is not null then
    select * into v_proj from projects.projects p where p.id = v_project and p.deleted_at is null;
    if v_proj.id is null then return query select 'not_found'::text, null::uuid; return; end if;
    if v_org is not null and v_proj.organization_id is distinct from v_org then return query select 'subject_mismatch'::text, null::uuid; return; end if;
    v_org := v_proj.organization_id;
  end if;
  -- a person acts only inside their own organization (guard tenancy only when a person is calling)
  if v_kind <> 'service' and v_org is distinct from (select core.current_organization_id()) then return query select 'not_found'::text, null::uuid; return; end if;

  begin
    insert into finance.finance_exceptions (organization_id, project_id, invoice_id, submission_id, kind, blocking, reason, evidence, opened_by, opened_by_system)
    values (v_org, v_project, v_inv.id, v_sub.id, p_kind, p_kind <> 'overdue', btrim(p_reason), v_evidence, v_actor, v_actor is null)
    returning id into v_id;
  exception when unique_violation then
    select e.id into v_id from finance.finance_exceptions e where e.invoice_id = v_inv.id and e.kind = p_kind and e.state = 'open';
    return query select 'already_open'::text, v_id; return;
  end;
  perform core.record_audit(v_org, 'finance.exception_opened', 'finance_exception', v_id, null, jsonb_build_object('kind', p_kind, 'projectId', v_project, 'invoiceId', v_inv.id));
  return query select 'opened'::text, v_id;
end $$;
revoke all on function finance.open_finance_exception(text, text, uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function finance.open_finance_exception(text, text, uuid, uuid, uuid, jsonb) to authenticated, service_role;

-- ── resolve (or dismiss) one - a person, never the runner; a blocking one by someone who did not open it ──
create or replace function finance.resolve_finance_exception(p_exception_id uuid, p_resolution text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_e finance.finance_exceptions;
begin
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text; return; end if;
  if p_resolution is null or p_resolution not in ('resolved', 'dismissed') then return query select 'bad_resolution'::text; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 or length(p_note) > 1000 then return query select 'reason_required'::text; return; end if;
  if finance.phase9_has_secret(p_note) then return query select 'secret_in_text'::text; return; end if;
  select * into v_e from finance.finance_exceptions e where e.id = p_exception_id and e.organization_id = (select core.current_organization_id()) for update;
  if v_e.id is null then return query select 'not_found'::text; return; end if;
  if v_e.state <> 'open' then return query select 'already_resolved'::text; return; end if;
  -- creator != resolver for anything that blocks a close
  if v_e.blocking and v_e.opened_by is not null and v_e.opened_by = v_actor then return query select 'self_resolution'::text; return; end if;
  -- a chargeback is settled by an Admin
  if v_e.kind = 'chargeback' and v_kind <> 'admin' then return query select 'admin_only'::text; return; end if;
  update finance.finance_exceptions set state = p_resolution, resolved_by = v_actor, resolution_note = btrim(p_note), resolved_at = clock_timestamp() where id = v_e.id;
  perform core.record_audit(v_e.organization_id, 'finance.exception_' || p_resolution, 'finance_exception', v_e.id, null, jsonb_build_object('kind', v_e.kind, 'projectId', v_e.project_id, 'invoiceId', v_e.invoice_id));
  return query select p_resolution;
end $$;
revoke all on function finance.resolve_finance_exception(uuid, text, text) from public, anon;
grant execute on function finance.resolve_finance_exception(uuid, text, text) to authenticated;

-- ── the runner reads the books and keeps the queue honest (idempotent; state re-checked at execution time) ──
create or replace function finance.sweep_finance_exceptions(p_limit integer default 200)
returns table (opened_overdue integer, opened_overpayment integer, resolved_overdue integer)
language plpgsql security definer set search_path = '' as $$
declare v_a int := 0; v_b int := 0; v_c int := 0;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0, 0; return; end if;

  insert into finance.finance_exceptions (organization_id, project_id, invoice_id, kind, blocking, reason, evidence, opened_by_system)
  select i.organization_id, i.project_id, i.id, 'overdue', false,
         'Invoice ' || i.number || ' is past its due date with a balance outstanding.',
         jsonb_build_object('dueAt', i.due_at, 'outstandingMinor', finance.invoice_outstanding_minor(i.id)), true
    from finance.invoices i
   where i.status in ('issued', 'partially_paid', 'overdue') and i.due_at is not null and i.due_at < now() and finance.invoice_outstanding_minor(i.id) > 0
     and not exists (select 1 from finance.finance_exceptions e where e.invoice_id = i.id and e.kind = 'overdue' and e.state = 'open')
   order by i.due_at limit greatest(p_limit, 1)
  on conflict do nothing;
  get diagnostics v_a = row_count;

  insert into finance.finance_exceptions (organization_id, project_id, invoice_id, kind, blocking, reason, evidence, opened_by_system)
  select i.organization_id, i.project_id, i.id, 'overpayment', true,
         'Invoice ' || i.number || ' has more verified money than it is for; the surplus is not absorbed or credited silently.',
         jsonb_build_object('totalMinor', i.total_minor, 'netVerifiedMinor', finance.net_verified_minor(i.id)), true
    from finance.invoices i
   where i.status <> 'void' and finance.net_verified_minor(i.id) > i.total_minor
     and not exists (select 1 from finance.finance_exceptions e where e.invoice_id = i.id and e.kind = 'overpayment' and e.state = 'open')
   limit greatest(p_limit, 1)
  on conflict do nothing;
  get diagnostics v_b = row_count;

  update finance.finance_exceptions e
     set state = 'resolved', resolved_by_system = true, resolved_at = clock_timestamp(),
         resolution_note = 'The invoice no longer has an outstanding balance (paid, waived or void); the state was re-checked when this ran.'
   where e.state = 'open' and e.kind = 'overdue'
     and exists (select 1 from finance.invoices i where i.id = e.invoice_id and (i.status in ('paid', 'void') or finance.invoice_outstanding_minor(i.id) = 0));
  get diagnostics v_c = row_count;
  return query select v_a, v_b, v_c;
end $$;
revoke all on function finance.sweep_finance_exceptions(integer) from public, anon, authenticated;
grant execute on function finance.sweep_finance_exceptions(integer) to service_role;

-- ── waivers: request (Finance / Admin) and decide (an Admin who did not ask) ──
create or replace function finance.request_waiver(p_invoice_id uuid, p_amount_minor bigint, p_reason text)
returns table (outcome text, waiver_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_inv finance.invoices; v_id uuid; v_out bigint;
begin
  if v_kind not in ('admin', 'finance') then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_amount_minor is null or p_amount_minor <= 0 then return query select 'non_positive'::text, null::uuid; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 1000 then return query select 'reason_required'::text, null::uuid; return; end if;
  if finance.phase9_has_secret(p_reason) then return query select 'secret_in_text'::text, null::uuid; return; end if;
  select * into v_inv from finance.invoices i where i.id = p_invoice_id and i.organization_id = (select core.current_organization_id()) for update;
  if v_inv.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_inv.status not in ('issued', 'partially_paid', 'overdue') then return query select 'not_collectible'::text, null::uuid; return; end if;
  v_out := finance.invoice_outstanding_minor(v_inv.id);
  if p_amount_minor > v_out then return query select 'exceeds_outstanding'::text, null::uuid; return; end if;
  begin
    insert into finance.waivers (organization_id, invoice_id, project_id, amount_minor, reason, requested_by)
    values (v_inv.organization_id, v_inv.id, v_inv.project_id, p_amount_minor, btrim(p_reason), v_actor) returning id into v_id;
  exception when unique_violation then return query select 'already_pending'::text, null::uuid; return;
  end;
  perform core.record_audit(v_inv.organization_id, 'finance.waiver_requested', 'waiver', v_id, null, jsonb_build_object('invoiceId', v_inv.id, 'amountMinor', p_amount_minor));
  return query select 'requested'::text, v_id;
end $$;
revoke all on function finance.request_waiver(uuid, bigint, text) from public, anon;
grant execute on function finance.request_waiver(uuid, bigint, text) to authenticated;

create or replace function finance.decide_waiver(p_waiver_id uuid, p_decision text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_w finance.waivers; v_inv finance.invoices; v_out bigint;
begin
  if v_kind <> 'admin' then return query select 'not_authorized'::text; return; end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then return query select 'bad_decision'::text; return; end if;
  if p_note is null or length(btrim(p_note)) = 0 or length(p_note) > 1000 then return query select 'reason_required'::text; return; end if;
  if finance.phase9_has_secret(p_note) then return query select 'secret_in_text'::text; return; end if;
  select * into v_w from finance.waivers w where w.id = p_waiver_id and w.organization_id = (select core.current_organization_id()) for update;
  if v_w.id is null then return query select 'not_found'::text; return; end if;
  if v_w.status <> 'requested' then return query select 'already_decided'::text; return; end if;
  if v_w.requested_by = v_actor then return query select 'self_approval'::text; return; end if;
  -- the invoice is locked so the amount is checked against the balance as it is NOW
  select * into v_inv from finance.invoices i where i.id = v_w.invoice_id for update;
  v_out := finance.invoice_outstanding_minor(v_inv.id);
  if p_decision = 'approved' and (v_inv.status not in ('issued', 'partially_paid', 'overdue') or v_w.amount_minor > v_out) then return query select 'stale_amount'::text; return; end if;
  update finance.waivers set status = p_decision, decided_by = v_actor, decided_at = clock_timestamp(), decision_note = btrim(p_note), outstanding_at_decision_minor = v_out where id = v_w.id;
  perform core.record_audit(v_w.organization_id, 'finance.waiver_' || p_decision, 'waiver', v_w.id, null, jsonb_build_object('invoiceId', v_w.invoice_id, 'amountMinor', v_w.amount_minor, 'outstandingMinor', v_out));
  return query select p_decision;
end $$;
revoke all on function finance.decide_waiver(uuid, text, text) from public, anon;
grant execute on function finance.decide_waiver(uuid, text, text) to authenticated;

-- ── reminders: a debt the business forgave is not chased (every other invoice is selected exactly as before) ──
create or replace function finance.observe_invoice_reminder_candidates(p_limit integer default 50)
returns table (invoice_id uuid, organization_id uuid, client_account_id uuid, project_id uuid, invoice_number text, currency text, total_minor bigint, paid_minor bigint, due_at timestamptz, interval_days integer)
language sql stable set search_path = '' as $$
  select i.id, i.organization_id, i.client_account_id, i.project_id, i.number, i.currency,
         i.total_minor::bigint, i.paid_minor::bigint, i.due_at, o.invoice_reminder_interval_days
    from finance.invoices i
    join core.organizations o on o.id = i.organization_id
   where o.invoice_reminders_enabled
     and i.status in ('issued', 'partially_paid', 'overdue')
     and i.due_at is not null
     and i.due_at < now()
     and not exists (
       select 1 from finance.invoice_sends s
        where s.invoice_id = i.id
          and s.sent_at > now() - make_interval(days => o.invoice_reminder_interval_days)
     )
     -- Phase 9: nothing left to collect once an approved waiver covers the balance
     and not (finance.invoice_waived_minor(i.id) > 0 and finance.invoice_outstanding_minor(i.id) = 0)
   order by i.due_at
   limit p_limit
$$;

notify pgrst, 'reload schema';
