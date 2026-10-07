-- ═══════════════════════════════════════════════════════════════════════════
-- Credit notes (traceability: P2-FIN-038, P4-FIN-021; docs/phase-1-orchestrator-quotation-gaps-log.md).
--
-- An issued invoice is immutable and the only correction was void-and-reissue: no document said "we reduced what you owe by X on invoice N, because ...".
-- A credit note is that document. This adds it as a record and three doors, and nothing here moves money or edits an invoice:
--
--   * finance.p1o_request_credit_note   an administrator or finance member asks for a credit against an ISSUED invoice (not a draft, not void). The ceiling is the
--                                       invoice total less every credit note already requested or issued, so two requests cannot both measure against the same
--                                       balance. The request raises an owner approval (subject 'credit_note'); with no policy it is refused, never left pending
--                                       against nobody.
--   * finance.p1o_issue_credit_note     issuing needs the approval to be APPROVED and a signed-in person; the service role cannot issue (a human gate). The
--                                       ceiling is re-checked under the invoice lock, the document number is allocated (CN-0001, per organisation) and the credit
--                                       note becomes immutable.
--   * finance.p1o_link_replacement_invoice   a correction by reissue links the replacement invoice to the credit note (same client account, not void).
--   * finance.p1o_invoice_net_after_credits  invoiced, credited, net.
-- A credit note does not change finance.invoices (its own guard stays whole), does not refund anything (finance.request_refund is the money door) and does not
-- touch tax filings: the tax portion is recorded on the note for the person who files, and GST-portal filing remains MANUAL_EXTERNAL.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('finance.credit_note_issued', 'A credit note was issued against an invoice after the owner approved it. Ids and the amount only; no invoice or client text.', true)
on conflict (type) do nothing;

-- 'credit_note' joins the approval subjects (the requests, and the policies that name who decides them). The live constraints are read and the one array in
-- each is extended, so another migration's additions survive.
do $$
declare
  t record;
  d text;
begin
  for t in select * from (values ('approvals.approval_requests', 'approval_requests_subject_type_check'), ('approvals.approval_policies', 'approval_policies_subject_type_check')) v(tbl, con)
  loop
    select pg_get_constraintdef(c.oid) into d from pg_constraint c where c.conrelid = t.tbl::regclass and c.conname = t.con;
    if d is null then raise exception '% not found', t.con; end if;
    if d like '%credit_note%' then continue; end if;
    execute format('alter table %s drop constraint %I', t.tbl, t.con);
    execute format('alter table %s add constraint %I %s', t.tbl, t.con, regexp_replace(d, '\]', ', ''credit_note''::text]'));
  end loop;
end $$;

create table if not exists finance.p1o_credit_notes (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  invoice_id            uuid not null references finance.invoices(id) on delete restrict,
  number                text,
  amount_minor          bigint not null check (amount_minor > 0),
  tax_minor             bigint not null default 0 check (tax_minor >= 0),
  reason                text not null check (length(btrim(reason)) between 3 and 1000),
  status                text not null default 'requested' check (status in ('requested', 'issued')),
  approval_request_id   uuid references approvals.approval_requests(id) on delete set null,
  replacement_invoice_id uuid references finance.invoices(id) on delete set null,
  requested_by          uuid references core.users(id) on delete set null,
  issued_by             uuid references core.users(id) on delete set null,
  issued_at             timestamptz,
  created_at            timestamptz not null default now(),
  constraint p1o_credit_notes_tax_within_amount check (tax_minor <= amount_minor),
  constraint p1o_credit_notes_issued_shape check ((status = 'requested' and number is null and issued_at is null) or (status = 'issued' and number is not null and issued_at is not null and issued_by is not null))
);
create unique index if not exists p1o_credit_notes_number_key on finance.p1o_credit_notes (organization_id, number) where number is not null;
create index if not exists p1o_credit_notes_invoice_idx on finance.p1o_credit_notes (invoice_id, status);

alter table finance.p1o_credit_notes enable row level security;
drop policy if exists p1o_credit_notes_select on finance.p1o_credit_notes;
create policy p1o_credit_notes_select on finance.p1o_credit_notes for select to authenticated
  using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())));
drop trigger if exists p1o_org_match_credit_notes_invoice on finance.p1o_credit_notes;
create trigger p1o_org_match_credit_notes_invoice before insert or update of invoice_id, organization_id on finance.p1o_credit_notes
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');
drop trigger if exists p1o_org_match_credit_notes_replacement on finance.p1o_credit_notes;
create trigger p1o_org_match_credit_notes_replacement before insert or update of replacement_invoice_id, organization_id on finance.p1o_credit_notes
  for each row execute function core.enforce_parent_org('replacement_invoice_id', 'finance.invoices');
drop trigger if exists p1o_org_match_credit_notes_approval on finance.p1o_credit_notes;
create trigger p1o_org_match_credit_notes_approval before insert or update of approval_request_id, organization_id on finance.p1o_credit_notes
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
drop trigger if exists p1o_freeze_org_credit_notes on finance.p1o_credit_notes;
create trigger p1o_freeze_org_credit_notes before update of organization_id on finance.p1o_credit_notes for each row execute function core.freeze_organization_id();
drop trigger if exists p1o_credit_notes_reject_delete on finance.p1o_credit_notes;
create trigger p1o_credit_notes_reject_delete before delete on finance.p1o_credit_notes for each row execute function core.reject_end_user_delete();
drop trigger if exists p1o_credit_notes_no_truncate on finance.p1o_credit_notes;
create trigger p1o_credit_notes_no_truncate before truncate on finance.p1o_credit_notes for each statement execute function crm.reject_truncate();

-- An issued credit note is a document: its amount, reason, number and invoice do not change. Only the replacement link may be set (once) afterwards.
create or replace function finance.p1o_credit_notes_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'issued' and (
       new.amount_minor is distinct from old.amount_minor or new.tax_minor is distinct from old.tax_minor or new.reason is distinct from old.reason
       or new.number is distinct from old.number or new.invoice_id is distinct from old.invoice_id or new.status is distinct from old.status
       or new.issued_at is distinct from old.issued_at or new.issued_by is distinct from old.issued_by
       or (old.replacement_invoice_id is not null and new.replacement_invoice_id is distinct from old.replacement_invoice_id)) then
    raise exception 'an issued credit note is a document and does not change' using errcode = 'restrict_violation';
  end if;
  if old.status = 'requested' and new.status = 'issued' and current_setting('finance.credit_note_door', true) is distinct from 'on' then
    raise exception 'a credit note is issued through finance.p1o_issue_credit_note' using errcode = 'restrict_violation';
  end if;
  if old.status = 'requested' and new.status = 'requested' and (new.amount_minor is distinct from old.amount_minor or new.invoice_id is distinct from old.invoice_id) then
    raise exception 'a requested credit note cannot be rewritten; the approval was asked for this amount' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p1o_credit_notes_guard on finance.p1o_credit_notes;
create trigger p1o_credit_notes_guard before update on finance.p1o_credit_notes for each row execute function finance.p1o_credit_notes_guard();
-- and a direct insert straight into 'issued' is refused the same way
create or replace function finance.p1o_credit_notes_insert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'requested' then
    raise exception 'a credit note is born requested' using errcode = 'restrict_violation';
  end if;
  if current_setting('finance.credit_note_door', true) is distinct from 'on' then
    raise exception 'a credit note is requested through finance.p1o_request_credit_note' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p1o_credit_notes_insert_guard on finance.p1o_credit_notes;
create trigger p1o_credit_notes_insert_guard before insert on finance.p1o_credit_notes for each row execute function finance.p1o_credit_notes_insert_guard();

create or replace function finance.p1o_credit_note_actor_refusal(p_organization_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return 'needs_a_person'; end if;
  if p_organization_id is distinct from (select core.current_organization_id()) then return 'forbidden'; end if;
  if not (coalesce((select core.is_admin()), false) or coalesce((select core.is_finance()), false)) then return 'forbidden'; end if;
  return null;
end $$;

create or replace function finance.p1o_request_credit_note(p_invoice_id uuid, p_amount_minor bigint, p_tax_minor bigint, p_reason text)
returns table (outcome text, credit_note_id uuid, request_id uuid, creditable_minor bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv finance.invoices;
  v_refusal text;
  v_taken bigint;
  v_room bigint;
  v_id uuid := gen_random_uuid();
  v_approval record;
  v_role text;
begin
  select i.* into v_inv from finance.invoices i where i.id = p_invoice_id for update;
  if v_inv.id is null then return query select 'not_found'::text, null::uuid, null::uuid, null::bigint; return; end if;
  v_refusal := finance.p1o_credit_note_actor_refusal(v_inv.organization_id);
  if v_refusal is not null then return query select v_refusal, null::uuid, null::uuid, null::bigint; return; end if;
  if p_amount_minor is null or p_amount_minor <= 0 then return query select 'non_positive'::text, null::uuid, null::uuid, null::bigint; return; end if;
  if p_tax_minor is null or p_tax_minor < 0 or p_tax_minor > p_amount_minor then return query select 'bad_tax_portion'::text, null::uuid, null::uuid, null::bigint; return; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then return query select 'missing_reason'::text, null::uuid, null::uuid, null::bigint; return; end if;
  if v_inv.status not in ('issued', 'partially_paid', 'paid', 'overdue') then return query select 'not_an_issued_invoice'::text, null::uuid, null::uuid, null::bigint; return; end if;

  select coalesce(sum(c.amount_minor), 0) into v_taken from finance.p1o_credit_notes c where c.invoice_id = v_inv.id;
  v_room := v_inv.total_minor - v_taken;
  if p_amount_minor > v_room then return query select 'exceeds_invoice'::text, null::uuid, null::uuid, v_room; return; end if;

  select * into v_approval from approvals.request_approval(
    v_inv.organization_id, 'credit_note', v_id, 'user', (select auth.uid()),
    'Credit note of ' || p_amount_minor || ' minor units on ' || v_inv.number || ' — ' || left(btrim(p_reason), 200),
    jsonb_build_object('invoice', v_inv.number, 'amount_minor', p_amount_minor, 'tax_minor', p_tax_minor, 'reason', left(btrim(p_reason), 500)),
    p_amount_minor, 'internal', null);
  if v_approval.outcome = 'no_policy' then return query select 'no_policy'::text, null::uuid, null::uuid, v_room; return; end if;
  select r.required_role into v_role from approvals.approval_requests r where r.id = v_approval.request_id;
  if v_role is distinct from 'owner' then
    perform approvals.cancel_request(v_approval.request_id, 'a credit note is approved by the owner');
    return query select 'policy_must_name_the_owner'::text, null::uuid, null::uuid, v_room; return;
  end if;

  perform set_config('finance.credit_note_door', 'on', true);
  insert into finance.p1o_credit_notes (id, organization_id, invoice_id, amount_minor, tax_minor, reason, approval_request_id, requested_by)
  values (v_id, v_inv.organization_id, v_inv.id, p_amount_minor, p_tax_minor, left(btrim(p_reason), 1000), v_approval.request_id, (select auth.uid()));
  perform set_config('finance.credit_note_door', 'off', true);
  perform core.record_audit(v_inv.organization_id, 'credit_note.requested', 'credit_note', v_id, null,
    jsonb_build_object('invoiceId', v_inv.id, 'amountMinor', p_amount_minor, 'approvalRequestId', v_approval.request_id));
  return query select 'requested'::text, v_id, v_approval.request_id, v_room - p_amount_minor;
end $$;

create or replace function finance.p1o_issue_credit_note(p_credit_note_id uuid)
returns table (outcome text, number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c finance.p1o_credit_notes;
  v_inv finance.invoices;
  v_refusal text;
  v_state text;
  v_taken bigint;
  v_n int;
  v_number text;
begin
  select x.* into c from finance.p1o_credit_notes x where x.id = p_credit_note_id for update;
  if c.id is null then return query select 'not_found'::text, null::text; return; end if;
  v_refusal := finance.p1o_credit_note_actor_refusal(c.organization_id);
  if v_refusal is not null then return query select v_refusal, null::text; return; end if;
  if c.status = 'issued' then return query select 'already_issued'::text, c.number; return; end if;

  select a.state into v_state from approvals.approval_requests a where a.id = c.approval_request_id;
  if v_state is distinct from 'approved' then return query select 'not_approved'::text, null::text; return; end if;

  select i.* into v_inv from finance.invoices i where i.id = c.invoice_id for update;
  if v_inv.status not in ('issued', 'partially_paid', 'paid', 'overdue') then return query select 'invoice_no_longer_issued'::text, null::text; return; end if;
  select coalesce(sum(x.amount_minor), 0) into v_taken from finance.p1o_credit_notes x where x.invoice_id = c.invoice_id and x.id <> c.id;
  if v_taken + c.amount_minor > v_inv.total_minor then return query select 'exceeds_invoice'::text, null::text; return; end if;

  perform pg_advisory_xact_lock(hashtextextended('p1o-credit-note-number:' || c.organization_id::text, 0));
  select count(*) + 1 into v_n from finance.p1o_credit_notes x where x.organization_id = c.organization_id and x.number is not null;
  v_number := 'CN-' || lpad(v_n::text, 4, '0');

  perform set_config('finance.credit_note_door', 'on', true);
  update finance.p1o_credit_notes set status = 'issued', number = v_number, issued_at = now(), issued_by = (select auth.uid()) where id = c.id;
  perform set_config('finance.credit_note_door', 'off', true);
  perform core.record_audit(c.organization_id, 'credit_note.issued', 'credit_note', c.id, null,
    jsonb_build_object('number', v_number, 'invoiceId', c.invoice_id, 'amountMinor', c.amount_minor, 'taxMinor', c.tax_minor));
  perform core.emit_event(c.organization_id, 'finance.credit_note_issued', 'credit_note', c.id,
    jsonb_build_object('creditNoteId', c.id, 'invoiceId', c.invoice_id, 'amountMinor', c.amount_minor, 'number', v_number));
  return query select 'issued'::text, v_number;
end $$;

create or replace function finance.p1o_link_replacement_invoice(p_credit_note_id uuid, p_invoice_id uuid)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c finance.p1o_credit_notes;
  v_orig finance.invoices;
  v_new finance.invoices;
  v_refusal text;
begin
  select x.* into c from finance.p1o_credit_notes x where x.id = p_credit_note_id for update;
  if c.id is null then return query select 'not_found'::text; return; end if;
  v_refusal := finance.p1o_credit_note_actor_refusal(c.organization_id);
  if v_refusal is not null then return query select v_refusal; return; end if;
  if c.status <> 'issued' then return query select 'not_issued'::text; return; end if;
  if c.replacement_invoice_id is not null then return query select 'already_linked'::text; return; end if;
  select i.* into v_orig from finance.invoices i where i.id = c.invoice_id;
  select i.* into v_new from finance.invoices i where i.id = p_invoice_id and i.organization_id = c.organization_id;
  if v_new.id is null then return query select 'unknown_invoice'::text; return; end if;
  if v_new.id = v_orig.id or v_new.client_account_id is distinct from v_orig.client_account_id or v_new.status = 'void' then
    return query select 'not_a_replacement'::text; return;
  end if;
  update finance.p1o_credit_notes set replacement_invoice_id = v_new.id where id = c.id;
  perform core.record_audit(c.organization_id, 'credit_note.replacement_linked', 'credit_note', c.id, null, jsonb_build_object('replacementInvoiceId', v_new.id));
  return query select 'linked'::text;
end $$;

create or replace function finance.p1o_invoice_net_after_credits(p_invoice_id uuid)
returns table (invoiced_minor bigint, credited_minor bigint, net_minor bigint, pending_credit_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv finance.invoices;
begin
  select i.* into v_inv from finance.invoices i where i.id = p_invoice_id;
  if v_inv.id is null then return; end if;
  if (select auth.uid()) is null or v_inv.organization_id is distinct from (select core.current_organization_id())
     or not (coalesce((select core.is_admin()), false) or coalesce((select core.is_finance()), false)) then return; end if;
  return query
  select v_inv.total_minor,
         coalesce(sum(c.amount_minor) filter (where c.status = 'issued'), 0)::bigint,
         v_inv.total_minor - coalesce(sum(c.amount_minor) filter (where c.status = 'issued'), 0)::bigint,
         coalesce(sum(c.amount_minor) filter (where c.status = 'requested'), 0)::bigint
    from finance.p1o_credit_notes c where c.invoice_id = v_inv.id;
end $$;

revoke all on function finance.p1o_credit_note_actor_refusal(uuid), finance.p1o_request_credit_note(uuid, bigint, bigint, text), finance.p1o_issue_credit_note(uuid),
  finance.p1o_link_replacement_invoice(uuid, uuid), finance.p1o_invoice_net_after_credits(uuid) from public, anon;
grant execute on function finance.p1o_request_credit_note(uuid, bigint, bigint, text), finance.p1o_issue_credit_note(uuid),
  finance.p1o_link_replacement_invoice(uuid, uuid), finance.p1o_invoice_net_after_credits(uuid) to authenticated;

notify pgrst, 'reload schema';
