-- ═══════════════════════════════════════════════════════════════════════════
-- A payment is claimed, then verified. They are not the same act.
--
-- Document 15 splits the moment money arrives into two, and the split is the
-- whole control:
--
--   §11 **Payment Submission** — *"Client/Admin/Sales can record a payment
--       submission"*, with an ID, invoice, milestone, amount, method,
--       reference/UTR, payer, date, account, proof, submitter and timestamp.
--       Status starts at PENDING_VERIFICATION.
--
--   §12 **Payment Verification** — *"Finance/Admin verifies amount, reference,
--       receiving account, date and invoice/milestone mapping"*, and
--       *"Manual verification must record verifier and evidence."*
--
-- **AgencyOS already has the second half.** ADM-04 put `verified_by` and
-- `verified_at` on `finance.payments` with a constraint that a verification
-- names somebody, and `payments_unverified_idx` is the queue somebody works
-- through against a bank statement. Recorded and verified are already two
-- different things at the ledger.
--
-- What is missing is the FIRST half: somewhere for a claim to live before it
-- reaches the ledger at all. And that matters for a specific mechanical
-- reason, not a taxonomic one — **a payment row counts toward the invoice
-- ceiling.** A client saying *"paid, UTR 402318"* over WhatsApp has two fates
-- today: somebody types it into the ledger, where it moves `paid_minor`
-- toward `invoices_paid_not_over_total` and can then only be removed by a
-- delete the payment guards refuse; or it is lost. Doc 15 §23 names the first
-- one: **"Never mark a milestone paid from a client message alone."**
--
-- A ledger row also cannot carry what §11 asks for and §34 needs later: the
-- method, the receiving account, the payer, the proof, an agent as submitter,
-- or — the one that decides it — **a rejection with a reason**. A claim that
-- turns out to be false has to end up somewhere that is not silence, and
-- `finance.payments` has no shape for "this was checked and it was not true".
--
-- ── the rule this is really about ────────────────────────────────────────
--
-- §12: *"Agents must not fabricate verification evidence."*
-- §36: *"Do not allow agent self-approval for high-risk financial actions."*
--
-- **There is no `verified_by_agent` column.** Not a check an agent could fail
-- — a column that does not exist. Verification names a person, and the only
-- way for an agent to appear in this table at all is as the SUBMITTER, which
-- is what an agent reading a client's message legitimately is. That is
-- ADM-22's shape applied to money: the capability is absent rather than
-- guarded, because a guarded capability is one somebody argues about.
--
-- The same reason `finance.agents` do not verify in `ai.memory_records` and
-- producers do not verify in `ai.agent_verifiers`. This system has now said
-- the sentence three times in three schemas, and it is structural in all three.
--
-- ── the ledger is not moved ──────────────────────────────────────────────
--
-- Verifying a submission does not write money. It records that a person
-- checked a claim; the caller then puts it through `record_manual_payment`,
-- which still owns the invoice lock, the overpayment refusal and the
-- `invoice.paid` event. A second place money can enter is a second place the
-- ceiling can be missed, and audit finding D1 is what that costs.
--
-- ── what is deliberately not built ───────────────────────────────────────
--
-- **Reconciliation (§15, §29) is not here.** It reconciles against bank or
-- gateway statements, and AgencyOS imports neither — `paymentGateways: 0`.
-- Building a reconciliation engine with no statement source would be building
-- a screen that reconciles a submission against itself.
--
-- **The invoice-side snapshot of §9's last bullet is not here.** *"Historical
-- invoices retain the payment instructions/version used at issue time"* needs
-- the invoice to record which account it named, and invoices are issued by
-- `generate_invoice`, which nothing passes an account to. Wiring that is a
-- change to the invoice engine and belongs with the surface that chooses the
-- account. What IS here is the half that makes it possible: an account row
-- becomes immutable the moment anything references it, so the instructions a
-- past submission named cannot be edited out from under it.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── §9 payment accounts ──────────────────────────────────────────────────

create table if not exists finance.payment_accounts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Doc 15 §9's own list.
  kind             text not null check (kind in ('bank', 'upi', 'upi_qr', 'gateway', 'other')),
  label            text not null check (length(trim(label)) > 0),

  -- The instructions themselves. Deliberately jsonb rather than columns for
  -- account number / IFSC / VPA: §9 admits "other approved payment channels",
  -- and a channel added later would otherwise need a migration to be
  -- expressible at all. What the matrix never reasons about may be shaped
  -- loosely; nothing here is reasoned about, only displayed and retained.
  instructions     jsonb not null default '{}'::jsonb,

  status           text not null default 'active' check (status in ('active', 'inactive')),
  effective_from   timestamptz not null default now(),
  effective_to     timestamptz,

  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint payment_accounts_effective_window
    check (effective_to is null or effective_to > effective_from)
);

create index if not exists payment_accounts_org_idx
  on finance.payment_accounts (organization_id, status, kind);

comment on table finance.payment_accounts is
  'The agency''s receiving accounts (Doc 15 section 9). An account becomes immutable the moment a submission references it, so the instructions a past payment named cannot be edited out from under it - the half of section 9''s "historical invoices retain the payment instructions used at issue time" that does not require changing the invoice engine.';

-- ── §11 the claim ────────────────────────────────────────────────────────

create table if not exists finance.payment_submissions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  invoice_id       uuid not null references finance.invoices(id) on delete restrict,

  -- Which of the agency's accounts the payer says they paid into. Null when
  -- the claim does not say, which happens and is not a reason to refuse the
  -- claim — §12 makes the receiving account something the VERIFIER checks.
  account_id       uuid references finance.payment_accounts(id) on delete restrict,

  amount_minor     bigint not null check (amount_minor > 0),
  currency         char(3) not null default 'INR',

  method           text not null check (method in
                     ('upi', 'bank_transfer', 'card', 'cash', 'cheque', 'gateway', 'other')),

  -- §36: "Require exact references for payment matching." Nullable because
  -- cash has none; the partial unique index below refuses a repeat of one that
  -- exists, which is §12's "duplicate references are flagged".
  reference        text,

  payer_name       text,
  paid_at          timestamptz,
  proof_url        text,

  -- §11's own status vocabulary, lowercased to match every other status in
  -- this database.
  status           text not null default 'pending_verification'
                     check (status in ('pending_verification', 'verified', 'rejected',
                                       'partially_verified', 'duplicate', 'refunded')),

  -- Who made the claim. An agent may: reading "paid, UTR 402318" out of a
  -- client's message and recording it as a CLAIM is exactly what an agent
  -- should do with that sentence.
  submitted_by       uuid references core.users(id) on delete set null,
  submitted_by_agent text references ai.agents(key) on delete set null,
  submitted_at       timestamptz not null default now(),

  -- Who checked it. §12: "Manual verification must record verifier and
  -- evidence." A person, and only a person — THERE IS NO verified_by_agent
  -- COLUMN, and that absence is the control.
  verified_by      uuid references core.users(id) on delete set null,
  verified_at      timestamptz,
  -- §34's evidence list, as free text plus whatever else the verifier saw.
  -- What matters structurally is that it is NOT NULL when the status says
  -- verified.
  verification_evidence text,
  rejected_reason  text,

  -- The ledger row this became, once a verified claim was actually recorded.
  -- Null until then: verifying is not paying.
  payment_id       uuid references finance.payments(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- §12: verification records verifier AND evidence. Both, or the status may
  -- not say verified.
  constraint payment_submissions_verified_is_evidenced
    check (status <> 'verified'
           or (verified_by is not null
               and verified_at is not null
               and verification_evidence is not null
               and length(trim(verification_evidence)) > 0)),

  -- A rejection says why. An unexplained rejection is a payment the client
  -- believes they made and nobody can account for.
  constraint payment_submissions_rejection_says_why
    check (status <> 'rejected'
           or (rejected_reason is not null and length(trim(rejected_reason)) > 0)),

  -- A claim has an author. Exactly one kind of author, so "who said this"
  -- always has one answer.
  constraint payment_submissions_has_one_author
    check ((submitted_by is null) <> (submitted_by_agent is null))
);

-- §12 "Duplicate references are flagged" / §36 "Prevent duplicate
-- invoice/payment IDs." Scoped to the organization and case-folded, because a
-- UTR retyped in a different case is the same UTR. Rejected and duplicate
-- claims are excluded: those are the rows that exist precisely to record that
-- the reference was seen before.
create unique index if not exists payment_submissions_reference_key
  on finance.payment_submissions (organization_id, upper(reference))
  where reference is not null and status not in ('rejected', 'duplicate');

create index if not exists payment_submissions_invoice_idx
  on finance.payment_submissions (invoice_id, status, submitted_at desc);

comment on table finance.payment_submissions is
  'A claim that money arrived (Doc 15 section 11), before anybody has checked it. Doc 15 section 23: "Never mark a milestone paid from a client message alone" - this is where that message goes instead of into the ledger. THERE IS NO verified_by_agent COLUMN: section 12 says agents must not fabricate verification evidence and section 36 forbids agent self-approval for high-risk financial actions, so verification names a person and an agent can only appear as the submitter.';

comment on column finance.payment_submissions.verified_by is
  'A person. The absence of a verified_by_agent column beside this one is the control (Doc 15 sections 12 and 36) - the capability does not exist rather than being guarded, because a guarded capability is one somebody argues about.';

comment on column finance.payment_submissions.payment_id is
  'The ledger row this claim became, once verified AND recorded. Null until then: verifying is not paying. Money still enters only through finance.record_manual_payment, which owns the invoice lock and the overpayment refusal - a second place money can enter is a second place the ceiling can be missed.';

-- ── an account in use stops being editable ───────────────────────────────

create or replace function finance.refuse_used_account_edit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Activating and deactivating stays available; §9 asks for it by name.
  -- Everything that changes where money would GO is frozen once a claim has
  -- named this account.
  if new.kind is distinct from old.kind
     or new.label is distinct from old.label
     or new.instructions is distinct from old.instructions
     or new.effective_from is distinct from old.effective_from then
    if exists (select 1 from finance.payment_submissions s where s.account_id = old.id) then
      raise exception
        'payment account "%" has been used; deactivate it and add a new one rather than editing where money goes (Doc 15 §9)',
        old.label
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists refuse_used_account_edit on finance.payment_accounts;
create trigger refuse_used_account_edit
  before update on finance.payment_accounts
  for each row execute function finance.refuse_used_account_edit();

-- ── verification is a transition, not a column somebody sets ────────────
--
-- The CHECK above makes an *unevidenced* verified row unrepresentable. This
-- makes the transition itself the only way in, so the evidence and the actor
-- are recorded by the same statement that moves the status — and a settled
-- claim cannot be re-settled.

create or replace function finance.verify_payment_submission(
  p_submission_id uuid,
  p_verified_by   uuid,
  p_evidence      text,
  p_approve       boolean default true,
  p_reason        text default null
)
returns table (
  -- 'verified' | 'rejected' | 'not_found' | 'settled' | 'no_evidence'
  -- | 'no_verifier' | 'no_reason'
  outcome text,
  status  text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row finance.payment_submissions;
begin
  select s.* into v_row
    from finance.payment_submissions s
   where s.id = p_submission_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_row.status <> 'pending_verification' then
    return query select 'settled'::text, v_row.status;
    return;
  end if;

  -- §12: "Manual verification must record verifier and evidence."
  if p_verified_by is null then
    return query select 'no_verifier'::text, v_row.status;
    return;
  end if;

  if p_approve then
    if p_evidence is null or length(trim(p_evidence)) = 0 then
      return query select 'no_evidence'::text, v_row.status;
      return;
    end if;

    update finance.payment_submissions
       set status = 'verified',
           verified_by = p_verified_by,
           verified_at = now(),
           verification_evidence = p_evidence,
           updated_at = now()
     where id = p_submission_id;

    return query select 'verified'::text, 'verified'::text;
    return;
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    return query select 'no_reason'::text, v_row.status;
    return;
  end if;

  update finance.payment_submissions
     set status = 'rejected',
         verified_by = p_verified_by,
         verified_at = now(),
         rejected_reason = p_reason,
         updated_at = now()
   where id = p_submission_id;

  return query select 'rejected'::text, 'rejected'::text;
end;
$$;

comment on function finance.verify_payment_submission(uuid, uuid, text, boolean, text) is
  'Doc 15 section 12. Takes a verifier and evidence and moves a pending claim once. SECURITY INVOKER: the RLS policy is the authorization, and p_verified_by names a person because there is no agent form of this call - section 36 forbids agent self-approval for high-risk financial actions. Verifying does NOT write money; the caller puts a verified claim through finance.record_manual_payment, which still owns the invoice lock and the overpayment refusal.';

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table finance.payment_accounts enable row level security;
alter table finance.payment_accounts force row level security;
alter table finance.payment_submissions enable row level security;
alter table finance.payment_submissions force row level security;

drop policy if exists payment_accounts_select on finance.payment_accounts;
create policy payment_accounts_select on finance.payment_accounts
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists payment_submissions_select on finance.payment_submissions;
create policy payment_submissions_select on finance.payment_submissions
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- ── the write policies, and the guard that keeps them from being a forgery ──
--
-- `verify_payment_submission` is SECURITY INVOKER, so it writes as the person
-- calling it and RLS decides. Without these policies the function would be
-- **dead in the application and green in every service-role script**, which is
-- exactly the class `db:verify:invokerrls` exists to catch — and it caught
-- this migration, which is the only reason the policies are here rather than
-- discovered by an operator whose click did nothing.
--
-- Same roles that already record a manual payment: owner and ops_admin. Doc 15
-- §12 gives verification to Finance/Admin and this database's two names for
-- that are those.

drop policy if exists payment_submissions_insert on finance.payment_submissions;
create policy payment_submissions_insert on finance.payment_submissions
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

drop policy if exists payment_submissions_update on finance.payment_submissions;
create policy payment_submissions_update on finance.payment_submissions
  for update to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

drop policy if exists payment_accounts_write on finance.payment_accounts;
create policy payment_accounts_write on finance.payment_accounts
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) in ('owner', 'ops_admin')
  );

-- An UPDATE policy wide enough for the function is wide enough for a hand
-- written PATCH, so the rules the FUNCTION guarantees and the CHECK does not
-- have to live on the row as well.
--
-- The third one is the real forgery this prevents. §12 says verification
-- records the verifier; a policy that lets an ops_admin write `verified_by`
-- lets them write **somebody else's** id there, and the audit trail then names
-- a person who never looked. An authenticated caller may only name themselves.
-- The service role has no `auth.uid()` and is exempt, the same exemption
-- `core.reject_end_user_delete` makes and for the same reason.

create or replace function finance.payment_submissions_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  -- 1. A claim is what was claimed.
  if new.invoice_id         is distinct from old.invoice_id
     or new.amount_minor    is distinct from old.amount_minor
     or new.currency        is distinct from old.currency
     or new.method          is distinct from old.method
     or new.reference       is distinct from old.reference
     or new.submitted_by    is distinct from old.submitted_by
     or new.submitted_by_agent is distinct from old.submitted_by_agent
     or new.submitted_at    is distinct from old.submitted_at
  then
    raise exception 'a payment claim is what was claimed; record a new one rather than editing this one'
      using errcode = 'restrict_violation';
  end if;

  -- 2. A settled claim is settled.
  if old.status <> 'pending_verification' and new.status is distinct from old.status then
    raise exception 'payment claim is already %', old.status
      using errcode = 'restrict_violation';
  end if;

  -- 3. You may only say that YOU checked it.
  if v_actor is not null
     and new.verified_by is not null
     and new.verified_by is distinct from old.verified_by
     and new.verified_by <> v_actor then
    raise exception 'a verification names the person who did it (Doc 15 §12)'
      using errcode = 'restrict_violation';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payment_submissions_guard on finance.payment_submissions;
create trigger payment_submissions_guard
  before update on finance.payment_submissions
  for each row execute function finance.payment_submissions_guard();

drop trigger if exists org_match_payment_submissions_invoice on finance.payment_submissions;
create trigger org_match_payment_submissions_invoice
  before insert or update of invoice_id, organization_id on finance.payment_submissions
  for each row execute function core.enforce_parent_org('invoice_id', 'finance.invoices');

drop trigger if exists org_match_payment_submissions_account on finance.payment_submissions;
create trigger org_match_payment_submissions_account
  before insert or update of account_id, organization_id on finance.payment_submissions
  for each row execute function core.enforce_parent_org('account_id', 'finance.payment_accounts');

drop trigger if exists org_match_payment_submissions_payment on finance.payment_submissions;
create trigger org_match_payment_submissions_payment
  before insert or update of payment_id, organization_id on finance.payment_submissions
  for each row execute function core.enforce_parent_org('payment_id', 'finance.payments');

drop trigger if exists freeze_org_payment_accounts on finance.payment_accounts;
create trigger freeze_org_payment_accounts
  before update of organization_id on finance.payment_accounts
  for each row execute function core.freeze_organization_id();

drop trigger if exists freeze_org_payment_submissions on finance.payment_submissions;
create trigger freeze_org_payment_submissions
  before update of organization_id on finance.payment_submissions
  for each row execute function core.freeze_organization_id();

-- ── grants ───────────────────────────────────────────────────────────────

grant select, insert, update on finance.payment_accounts to authenticated, service_role;
grant select, insert, update on finance.payment_submissions to authenticated, service_role;
grant execute on function finance.verify_payment_submission(uuid, uuid, text, boolean, text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
