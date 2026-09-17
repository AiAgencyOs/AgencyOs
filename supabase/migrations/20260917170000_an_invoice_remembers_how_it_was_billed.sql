-- ═══════════════════════════════════════════════════════════════════════════
-- An invoice remembers how it was billed.
--
-- Finance §4.2, §5, §15.
--
-- §5: *"Billing data used on each issued invoice should be snapshotted/
-- versioned for audit."* §4.2 asks for the profile to be versioned, and G-255
-- built that: a change writes a new version and supersedes the old, and
-- neither can be edited afterwards.
--
-- What was missing is the other half. An invoice carried the tax it was
-- charged (G-259) and no record of WHICH VERSION decided it. A client who
-- changes their registered address between M1 and M3 leaves two invoices that
-- were correct under different profiles, and nothing on either row said which.
--
-- ── a reference, not a copy ──────────────────────────────────────────────
--
-- The obvious move is a jsonb snapshot of the legal name, the address and the
-- GSTIN on the invoice. This does **not** do that, for the reason G-250 gives:
-- the profile version is already frozen — that is the whole point of
-- `freeze_billing_profile` — so a copy would be a second source that can only
-- drift by being wrong. The reference is enough because the row it points at
-- cannot change.
--
-- The group setup's member list IS copied (G-253), and the difference is worth
-- stating: there, what matters is who was added to a group this system cannot
-- see, and nothing else holds that fact. Here the fact is a row in this
-- database that is already immutable.
--
-- ── nullable, and not backfilled ─────────────────────────────────────────
--
-- Every invoice issued before this migration has no profile to point at,
-- because none existed. Inventing one — pointing them at whatever profile the
-- project has now — would be worse than the gap: it would assert that an
-- invoice from August was billed under a mode confirmed in September. They
-- stay null, and null means "raised before this system recorded billing
-- modes", which is true.
-- ═══════════════════════════════════════════════════════════════════════════

alter table finance.invoices
  add column if not exists billing_profile_id uuid
    references finance.billing_profiles(id) on delete restrict;

create index if not exists invoices_billing_profile_idx
  on finance.invoices (billing_profile_id) where billing_profile_id is not null;

comment on column finance.invoices.billing_profile_id is
  'Finance section 5 - which version of the billing profile this invoice was raised against. A reference rather than a copy: the profile version is frozen by finance.freeze_billing_profile, so a copy could only drift by being wrong. Null on every invoice raised before billing modes were recorded, which is true rather than backfilled into a claim.';

-- `on delete restrict` above is the load-bearing half: a profile version an
-- invoice was billed under cannot be deleted while that invoice exists, which
-- is what makes the reference safe to trust.

drop trigger if exists org_match_invoices_billing_profile on finance.invoices;
create trigger org_match_invoices_billing_profile
  before insert or update of billing_profile_id, organization_id on finance.invoices
  for each row execute function core.enforce_parent_org('billing_profile_id', 'finance.billing_profiles');

-- ── the door, carried forward verbatim with three marked edits ───────────
--
-- **From `20260815290000`, not from `20260813120011`.** The first draft of this
-- migration carried the ORIGINAL definition forward and silently dropped
-- `perform set_config('finance.sanctioned_write', 'on', true)` — the capability
-- the invoices guard checks, added later, without which every authenticated
-- caller's legitimate write through this door would have been refused on
-- production.
--
-- It was caught by `tests/finance-sanctioned-write.test.ts`, which pins exactly
-- this. The mistake was searching for `create or replace function` in lower
-- case when the live definition is upper case: a carry-forward must start from
-- the LAST definition, and "last" has to be established rather than assumed.
--
-- The diff against that definition is ten lines added and three replaced, all
-- inside the marks, with the capability line intact.

-- ── the old signature has to GO, not just be replaced ────────────────────
--
-- Adding a defaulted parameter does not replace a function in PostgreSQL — it
-- creates an OVERLOAD. Both would exist, and every caller still passing twelve
-- arguments would silently bind to the OLD one, which knows nothing about
-- `billing_profile_id`. The invoice would be raised with the right tax and no
-- record of which profile decided it, which is precisely the gap this
-- migration exists to close, reopened by the mechanism meant to close it.
--
-- Found by asking the scratch database what it actually had: two rows came
-- back from `pg_proc` where one was expected.
--
-- Dropped explicitly and by full signature. No grant is lost: this function
-- has never had an explicit one, so it runs on the default EXECUTE-to-PUBLIC
-- that the recreated function receives too.

drop function if exists finance.create_milestone_invoice(
  uuid, uuid, uuid, uuid, text, character, bigint, bigint, bigint, jsonb, timestamptz, text
);

CREATE OR REPLACE FUNCTION finance.create_milestone_invoice(p_organization_id uuid, p_client_account_id uuid, p_project_id uuid, p_milestone_id uuid, p_number text, p_currency character, p_subtotal_minor bigint, p_tax_minor bigint, p_total_minor bigint, p_lines jsonb, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text,
 -- [G-260 edit 1 of 3] The billing profile version this invoice was raised against.
 -- Last, and defaulted, because a defaulted parameter must be — and because every
 -- caller that existed before this change passed none.
 p_billing_profile_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(outcome text, invoice_id uuid, number text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_invoice_id  uuid;
  v_number      text;
  v_constraint  text;
begin
  -- Declare the sanctioned-write capability the invoices guard checks
  -- (finance.invoices_write_is_sanctioned, 20260815290000). Transaction-scoped;
  -- a direct Data-API write cannot set it.
  perform set_config('finance.sanctioned_write', 'on', true);
  -- ── 1. an invoice with no lines is refused before anything is written ────
  --
  -- The old path could not check this: it inserted the invoice first and found
  -- out afterwards, which is why it needed a DELETE to undo itself.
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return query select 'no_lines'::text, null::uuid, null::text;
    return;
  end if;

  -- ── 2. the invoice ───────────────────────────────────────────────────────
  --
  -- No read-then-decide. Both refusals below come from an index rejecting the
  -- write, so a request that arrives between a check and its insert cannot slip
  -- through the gap — the shape D1, D2 and D4 all were.
  begin
    insert into finance.invoices (
      organization_id, client_account_id, project_id, milestone_id,
      number, status, currency,
      subtotal_minor, tax_minor, total_minor,
      -- [G-260 edit 2 of 3] Finance §5: "billing data used on each issued
      -- invoice should be snapshotted/versioned for audit."
      due_at, notes, billing_profile_id
    )
    values (
      p_organization_id, p_client_account_id, p_project_id, p_milestone_id,
      p_number, 'draft', p_currency,
      p_subtotal_minor, p_tax_minor, p_total_minor,
      -- [G-260 edit 3 of 3]
      p_due_at, p_notes, p_billing_profile_id
    )
    returning id into v_invoice_id;
  exception
    when unique_violation then
      -- Two indexes can raise this and they mean opposite things, so the
      -- constraint name decides. Answering the wrong one would either bill a
      -- milestone twice or refuse a numbering retry that would have succeeded.
      --
      -- Read from the diagnostics rather than matched out of SQLERRM: the
      -- message is prose, and prose is translated. A server running under a
      -- non-English lc_messages would fall through to 'number_taken' forever
      -- and the caller would exhaust its five attempts on a milestone that was
      -- already invoiced — a bug that appears only on somebody else's machine.
      get stacked diagnostics v_constraint = constraint_name;

      if v_constraint = 'invoices_milestone_live_key' then
        select i.id, i.number
          into v_invoice_id, v_number
          from finance.invoices i
         where i.milestone_id = p_milestone_id
           and i.status <> 'void'
         limit 1;

        return query select 'already_invoiced'::text, v_invoice_id, v_number;
        return;
      end if;

      return query select 'number_taken'::text, null::uuid, null::text;
      return;
  end;

  -- ── 3. its lines ─────────────────────────────────────────────────────────
  --
  -- A failure here — a quantity of zero, a negative price, a malformed row —
  -- raises, and the invoice inserted a moment ago goes with it. That is the
  -- compensating DELETE, done by the database, and it cannot be skipped by a
  -- process that died before it got there.
  insert into finance.invoice_items (
    organization_id, invoice_id, position, description,
    quantity, unit_price_minor, amount_minor, tax_rate_bp
  )
  select
    p_organization_id,
    v_invoice_id,
    (line->>'position')::int,
    line->>'description',
    (line->>'quantity')::numeric,
    (line->>'unit_price_minor')::bigint,
    (line->>'amount_minor')::bigint,
    (line->>'tax_rate_bp')::int
  from jsonb_array_elements(p_lines) as line;

  -- ── 4. the history, and the announcement ─────────────────────────────────
  --
  -- Both inside this transaction. The audit row matters more than the event:
  -- audit.audit_log is append-only by trigger, so one never written can never
  -- be repaired afterwards.
  perform core.record_audit(
    p_organization_id,
    'invoice.created',
    'invoice',
    v_invoice_id,
    null,
    jsonb_build_object(
      'number', p_number,
      'milestoneId', p_milestone_id,
      'projectId', p_project_id,
      'clientAccountId', p_client_account_id,
      'totalMinor', p_total_minor,
      'currency', p_currency
    )
  );

  perform core.emit_event(
    p_organization_id,
    'invoice.created',
    'invoice',
    v_invoice_id,
    jsonb_build_object(
      'number', p_number,
      'milestoneId', p_milestone_id,
      'projectId', p_project_id,
      'totalMinor', p_total_minor,
      'currency', p_currency
    )
  );

  return query select 'created'::text, v_invoice_id, p_number;
end;
$function$;

notify pgrst, 'reload schema';
