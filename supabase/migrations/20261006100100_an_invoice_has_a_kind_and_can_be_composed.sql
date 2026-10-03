-- An invoice says what kind of bill it is, and a person can compose one (PDF
-- gap W1; SCR-051 "milestone, change request, maintenance renewal, new
-- service, zero-amount invoices", SCR-052 "composition").
--
-- 1. `finance.invoices.kind`. The registry could not show or filter a type
--    because nothing stored one; it was only inferable for some kinds (a
--    milestone_id, a maintenance_plan_id) and only by a reader who could also
--    read projects.change_requests — which the finance role cannot. So the kind
--    is written once, at insert, by a trigger that knows the four ways an
--    invoice is born, and read like any other column:
--
--      milestone            milestone_id is set
--      change_request       projects.change_requests.invoice_id points at it
--      maintenance_renewal  maintenance_plan_id is set, total > 0
--      zero_amount          maintenance_plan_id is set, total = 0
--      service              composed by hand (the composer door below)
--
--    Existing rows are backfilled by the same rules.
--
-- 2. `finance.create_composed_invoice` — the door behind the composer. A
--    project (the client comes from it), a number, money the caller computed
--    and the door re-checks (total = subtotal + tax), the lines. It delegates
--    to create_milestone_invoice — the one place an invoice row is born — with
--    no milestone, and writes its own audit row. Owner / ops_admin only, the
--    same pair invoices_write admits. The tax the lines carry is decided by
--    the caller from the project's CONFIRMED billing profile (never inferred).
--
-- Additive and idempotent.

alter table finance.invoices add column if not exists kind text;

create or replace function finance.invoice_kind_on_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is null then
    new.kind := coalesce(
      nullif(current_setting('finance.invoice_kind', true), ''),
      case
        when new.milestone_id is not null then 'milestone'
        when new.maintenance_plan_id is not null and new.total_minor = 0 then 'zero_amount'
        when new.maintenance_plan_id is not null then 'maintenance_renewal'
        else 'service'
      end
    );
  end if;
  return new;
end;
$$;

drop trigger if exists invoice_kind_on_insert on finance.invoices;
create trigger invoice_kind_on_insert
  before insert on finance.invoices
  for each row execute function finance.invoice_kind_on_insert();

-- Backfill (no end-user identity here, so the sanctioned-write guard admits it).
update finance.invoices i
   set kind = case
     when exists (select 1 from projects.change_requests cr where cr.invoice_id = i.id) then 'change_request'
     when i.milestone_id is not null then 'milestone'
     when i.maintenance_plan_id is not null and i.total_minor = 0 then 'zero_amount'
     when i.maintenance_plan_id is not null then 'maintenance_renewal'
     else 'service'
   end
 where i.kind is null;

alter table finance.invoices alter column kind set not null;
alter table finance.invoices drop constraint if exists invoices_kind_check;
alter table finance.invoices
  add constraint invoices_kind_check
  check (kind in ('milestone', 'change_request', 'maintenance_renewal', 'zero_amount', 'service'));

comment on column finance.invoices.kind is
  'What kind of bill this is: milestone, change_request, maintenance_renewal, zero_amount or service (composed by hand). Written once at insert by finance.invoice_kind_on_insert; a change request that is invoiced later re-labels its invoice through finance.invoice_kind_follows_change_request.';

-- A change request is linked to its invoice AFTER the invoice exists
-- (create_change_request_invoice updates change_requests.invoice_id), so the
-- insert trigger cannot know. The link re-labels it, through the sanctioned
-- write the invoices guard requires.
create or replace function finance.invoice_kind_follows_change_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.invoice_id is not null and new.invoice_id is distinct from old.invoice_id then
    perform set_config('finance.sanctioned_write', 'on', true);
    update finance.invoices set kind = 'change_request' where id = new.invoice_id and kind <> 'change_request';
    perform set_config('finance.sanctioned_write', 'off', true);
  end if;
  return new;
end;
$$;

drop trigger if exists invoice_kind_follows_change_request on projects.change_requests;
create trigger invoice_kind_follows_change_request
  after update of invoice_id on projects.change_requests
  for each row execute function finance.invoice_kind_follows_change_request();

-- ── the composer's door ─────────────────────────────────────────────────────

create or replace function finance.create_composed_invoice(
  p_project_id uuid,
  p_number text,
  p_currency char(3),
  p_subtotal_minor bigint,
  p_tax_minor bigint,
  p_total_minor bigint,
  p_lines jsonb,
  p_billing_profile_id uuid default null,
  p_due_at timestamptz default null,
  p_notes text default null
)
returns table (outcome text, invoice_id uuid, number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project projects.projects%rowtype;
  v_created record;
  v_lines_sum bigint;
begin
  -- invoice.create's two roles, the pair invoices_write admits.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid, null::text;
    return;
  end if;

  select * into v_project
    from projects.projects p
   where p.id = p_project_id
     and p.organization_id = (select core.current_organization_id());
  if not found then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    return query select 'no_lines'::text, null::uuid, null::text;
    return;
  end if;

  -- The caller computed the money; the door does not trust the sum.
  select coalesce(sum((line->>'amount_minor')::bigint), 0) into v_lines_sum
    from jsonb_array_elements(p_lines) as line;
  if v_lines_sum <> p_subtotal_minor or p_subtotal_minor + p_tax_minor <> p_total_minor or p_total_minor <= 0 then
    return query select 'totals_mismatch'::text, null::uuid, null::text;
    return;
  end if;

  perform set_config('finance.invoice_kind', 'service', true);
  select * into v_created
    from finance.create_milestone_invoice(
      v_project.organization_id,
      v_project.client_account_id,
      v_project.id,
      null,
      p_number,
      p_currency,
      p_subtotal_minor,
      p_tax_minor,
      p_total_minor,
      p_lines,
      p_due_at,
      p_notes,
      p_billing_profile_id
    );
  perform set_config('finance.invoice_kind', '', true);

  if v_created.outcome <> 'created' then
    return query select v_created.outcome, v_created.invoice_id, v_created.number;
    return;
  end if;

  perform core.record_audit(
    v_project.organization_id,
    'invoice.composed',
    'invoice',
    v_created.invoice_id,
    null,
    jsonb_build_object(
      'number', v_created.number,
      'projectId', v_project.id,
      'totalMinor', p_total_minor,
      'taxMinor', p_tax_minor,
      'lines', jsonb_array_length(p_lines),
      'billingProfileId', p_billing_profile_id
    )
  );

  return query select 'created'::text, v_created.invoice_id, v_created.number;
end;
$$;

revoke all on function finance.create_composed_invoice(uuid, text, char, bigint, bigint, bigint, jsonb, uuid, timestamptz, text) from public, anon;
grant execute on function finance.create_composed_invoice(uuid, text, char, bigint, bigint, bigint, jsonb, uuid, timestamptz, text) to authenticated, service_role;

comment on function finance.create_composed_invoice(uuid, text, char, bigint, bigint, bigint, jsonb, uuid, timestamptz, text) is
  'The composer''s door: a hand-built DRAFT invoice for a project, kind = service. Owner / ops_admin only; re-checks that the lines add up to the subtotal and the subtotal plus tax to the total; delegates to create_milestone_invoice (the one place an invoice row is born); audited as invoice.composed. Issuing it is a separate step.';

notify pgrst, 'reload schema';
