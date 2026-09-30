-- Every finance export is logged, and invoice numbering / terms are the
-- owner's to set (PDF gap W1; SCR-056 "Export history", §7 "Invoice
-- numbering/terms").
--
-- 1. `finance.report_exports` — who exported what, for which period, how many
--    rows, when. The GSTR files already had `finance.gst_exports`; the CSV and
--    PDF downloads (tax register, invoices, payments, expenses) logged nothing.
--    Written only by `finance.log_report_export`; readable by owner, ops_admin
--    and the finance role.
--
-- 2. `finance.set_invoice_numbering` — three keys of core.organizations.settings
--    with their own door rather than the shared whitelist, so this migration
--    cannot collide with another that redefines core.set_organization_setting:
--      invoice_number_prefix   1-8 of A-Z 0-9 (default INV)
--      invoice_terms_days      whole days, 0-365 (default: none — a milestone's
--                              own due date, else no due date)
--      invoice_terms_note      free text printed on the invoice, <= 500 chars
--    Owner / ops_admin only; an empty value clears a key; every change is
--    audited with the old and the new value.
--
-- Additive and idempotent.

create table if not exists finance.report_exports (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  kind            text not null check (kind in ('tax_register_csv', 'tax_report_pdf', 'invoices_csv', 'payments_csv', 'expenses_csv', 'gstr1', 'gstr3b')),
  period_label    text not null check (length(btrim(period_label)) between 1 and 120),
  row_count       integer not null default 0 check (row_count >= 0),
  exported_by     uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists report_exports_org_idx on finance.report_exports (organization_id, created_at desc);

alter table finance.report_exports enable row level security;
alter table finance.report_exports force row level security;

drop policy if exists report_exports_select on finance.report_exports;
create policy report_exports_select on finance.report_exports
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and ((select core.is_admin()) or (select core.is_finance()))
  );

revoke all on finance.report_exports from public, anon;
revoke insert, update, delete on finance.report_exports from authenticated;
grant select on finance.report_exports to authenticated;

drop trigger if exists freeze_org_report_exports on finance.report_exports;
create trigger freeze_org_report_exports
  before update of organization_id on finance.report_exports
  for each row execute function core.freeze_organization_id();

comment on table finance.report_exports is
  'Every finance report somebody downloaded: who, when, which period, how many rows. Written only through finance.log_report_export.';

create or replace function finance.log_report_export(
  p_kind text,
  p_period_label text,
  p_row_count integer
)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_id uuid;
begin
  if v_org is null or not (coalesce((select core.is_admin()), false) or coalesce((select core.is_finance()), false)) then
    return query select 'forbidden'::text;
    return;
  end if;
  if p_kind not in ('tax_register_csv', 'tax_report_pdf', 'invoices_csv', 'payments_csv', 'expenses_csv', 'gstr1', 'gstr3b') then
    return query select 'invalid_kind'::text;
    return;
  end if;

  insert into finance.report_exports (organization_id, kind, period_label, row_count, exported_by)
  values (v_org, p_kind, left(coalesce(nullif(btrim(p_period_label), ''), 'All time'), 120), greatest(coalesce(p_row_count, 0), 0), (select auth.uid()))
  returning id into v_id;

  perform core.record_audit(v_org, 'finance.report_exported', 'report_export', v_id, null,
    jsonb_build_object('kind', p_kind, 'period', p_period_label, 'rows', p_row_count));

  return query select 'logged'::text;
end;
$$;

revoke all on function finance.log_report_export(text, text, integer) from public, anon;
grant execute on function finance.log_report_export(text, text, integer) to authenticated, service_role;

comment on function finance.log_report_export(text, text, integer) is
  'Logs a finance export (who/when/period/rows) and audits it. Owner, ops_admin or finance.';

-- ── numbering and terms ─────────────────────────────────────────────────────

create or replace function finance.set_invoice_numbering(
  p_prefix text,
  p_terms_days text,
  p_terms_note text
)
returns table (outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_prefix text := nullif(upper(btrim(coalesce(p_prefix, ''))), '');
  v_days text := nullif(btrim(coalesce(p_terms_days, '')), '');
  v_note text := nullif(btrim(coalesce(p_terms_note, '')), '');
  v_old jsonb;
  v_new jsonb;
begin
  if v_org is null or (select core.current_user_role()) not in ('owner', 'ops_admin') then
    return query select 'forbidden'::text;
    return;
  end if;
  if v_prefix is not null and v_prefix !~ '^[A-Z0-9]{1,8}$' then
    return query select 'invalid_prefix'::text;
    return;
  end if;
  if v_days is not null and (v_days !~ '^[0-9]{1,3}$' or v_days::int > 365) then
    return query select 'invalid_days'::text;
    return;
  end if;
  if v_note is not null and length(v_note) > 500 then
    return query select 'invalid_note'::text;
    return;
  end if;

  select jsonb_build_object(
           'invoice_number_prefix', o.settings->>'invoice_number_prefix',
           'invoice_terms_days', o.settings->>'invoice_terms_days',
           'invoice_terms_note', o.settings->>'invoice_terms_note')
    into v_old
    from core.organizations o where o.id = v_org for update;
  if not found then
    return query select 'not_found'::text;
    return;
  end if;

  update core.organizations
     set settings = (coalesce(settings, '{}'::jsonb) - 'invoice_number_prefix' - 'invoice_terms_days' - 'invoice_terms_note')
       || case when v_prefix is null then '{}'::jsonb else jsonb_build_object('invoice_number_prefix', v_prefix) end
       || case when v_days   is null then '{}'::jsonb else jsonb_build_object('invoice_terms_days', v_days) end
       || case when v_note   is null then '{}'::jsonb else jsonb_build_object('invoice_terms_note', v_note) end
   where id = v_org;

  v_new := jsonb_build_object('invoice_number_prefix', v_prefix, 'invoice_terms_days', v_days, 'invoice_terms_note', v_note);
  perform core.record_audit(v_org, 'organization.invoice_numbering_set', 'organization', v_org, v_old, v_new);

  return query select 'set'::text;
end;
$$;

revoke all on function finance.set_invoice_numbering(text, text, text) from public, anon;
grant execute on function finance.set_invoice_numbering(text, text, text) to authenticated, service_role;

comment on function finance.set_invoice_numbering(text, text, text) is
  'The owner''s numbering prefix (default INV), default payment terms in days and a terms note printed on invoices. Owner / ops_admin only, validated, audited with old and new. Empty clears a key.';

notify pgrst, 'reload schema';
