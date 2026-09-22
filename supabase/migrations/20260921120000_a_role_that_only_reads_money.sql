-- A role that only reads money — Doc 09 §35, closing a granular gap.
--
-- "Finance sees necessary billing info, not unrestricted sales notes" names a
-- role this repository never had. `finance.invoices_select` was already
-- correctly narrower than the general internal gate — `core.is_admin()`,
-- owner or ops_admin, not `core.is_internal()`'s five — but nobody holding
-- `invoice.read` was ever narrower than owner or ops_admin, and both of those
-- roles ALSO carry blanket internal read of every lead, contact, conversation
-- and sales note via `core.is_internal()`. There was no role for which
-- "reads necessary billing info" and "does not read unrestricted sales
-- notes" could BOTH be true at once, because the only two roles that could
-- read money were the two roles that could read everything else too.
--
-- ── the shape of the fix, and why it needs no 30-policy migration ─────────
--
-- `core.is_internal()` gates the CRM and sales schemas' SELECT policies —
-- crm.leads, crm.contacts, crm.lead_activities, crm.conversations,
-- sales.objections, sales.proposals and roughly two dozen more, across as
-- many migrations. Narrowing every one of those individually to exclude a
-- new role, correctly and without missing one, is a change this migration
-- deliberately does NOT attempt — the blast radius of getting even one wrong
-- is a silent CRM-read refusal for an unrelated role, and there is a safer
-- way to reach the same guarantee.
--
-- `finance` is added to `core.memberships.role` and to the two TypeScript
-- lists that gate the general internal app shell (`ROLES`, `INTERNAL_ROLES`
-- in src/lib/auth/claims.ts) — so a finance member is recognised as agency
-- staff rather than redirected to the client portal, exactly the distinction
-- claims.ts's own header draws between "routing and UI decisions" and "the
-- security boundary, which is Row Level Security". It is DELIBERATELY NOT
-- added to `core.is_internal()`, the SQL predicate every CRM/sales SELECT
-- policy actually reads. That single omission is the whole guarantee: a
-- finance member's read of crm.leads, sales.objections, or anything else
-- gated by `core.is_internal()` is refused by a predicate that already
-- exists and is already proven correct for the other five roles, with zero
-- new policies to get wrong. `finance` reads exactly what this migration
-- explicitly grants it and nothing `core.is_internal()` already covers.
--
-- ── what this does grant ───────────────────────────────────────────────────
--
-- `invoice.read`, matched here at the row: `finance.invoices_select` and
-- `finance.payments_select` admit `core.is_admin() OR core.is_finance()`.
-- `finance.invoice_items_select` needs no change — it already defers to
-- `finance.invoices_select` through its own subquery, so a finance member
-- reading line items follows the same rule automatically.
--
-- ── what is deliberately left undone ───────────────────────────────────────
--
-- `finance` is not added to `core.membership_roles.role` (the multirole
-- table, G-310) or to `sales.grant_secondary_role`'s allowed list — granting
-- it as a SECONDARY role to someone already `core.is_admin()` would be a
-- no-op (they already hold invoice.read), and granting it to a narrower role
-- like `member` is a real feature this migration does not build, rather than
-- built half-finished. `invoice.create`/`invoice.issue` are not granted
-- either: Doc 09 §35 says "sees", and a role that can read money without
-- being able to move it is the narrower, safer default until asked for more.

alter table core.memberships
  drop constraint if exists memberships_role_check;
alter table core.memberships
  add constraint memberships_role_check
  check (role in ('owner', 'ops_admin', 'delivery_lead', 'member', 'contractor', 'finance'));

comment on column core.memberships.role is
  'owner, ops_admin, delivery_lead, member, contractor, or finance (G-314). finance is internal staff (core.custom_access_token_hook stamps audience=internal for any membership) but is deliberately NOT one of core.is_internal()''s five roles, so every CRM/sales SELECT policy gated on that predicate already refuses a finance member without needing its own change.';

-- ── the narrow read finance actually gets ───────────────────────────────────

create or replace function core.is_finance()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select core.current_user_role() = 'finance';
$$;

comment on function core.is_finance() is
  'True only for the finance role — G-314. Deliberately not part of core.is_internal(): the CRM/sales schemas'' SELECT policies read that predicate, and finance holding it would grant the exact "unrestricted sales notes" access Doc 09 §35 refuses.';

drop policy if exists invoices_select on finance.invoices;
create policy invoices_select on finance.invoices
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_admin())
      or (select core.is_finance())
      or (
        (select core.is_client())
        and client_account_id = (select core.current_client_account_id())
        and status <> 'draft'
        and status <> 'pending_approval'
      )
    )
  );

drop policy if exists payments_select on finance.payments;
create policy payments_select on finance.payments
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.current_user_role()) in ('owner', 'ops_admin')
      or (select core.is_finance())
      or (
        (select core.is_client())
        and exists (
          select 1 from finance.invoices i
           where i.id = payments.invoice_id
             and i.client_account_id = (select core.current_client_account_id())
        )
      )
    )
  );

notify pgrst, 'reload schema';
