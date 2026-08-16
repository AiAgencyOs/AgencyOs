-- ═══════════════════════════════════════════════════════════════════════════
-- A refund's RLS scope matches its capability: owner only, not ops_admin.
--
-- 20260815310000 opened finance.refunds to owner AND ops_admin so the refund
-- engine could pass RLS. But `refund.issue` is an OWNER-ONLY capability
-- (src/lib/authz/permissions.ts — ops_admin holds invoice.create/issue but NOT
-- refund.issue; refunds are deliberately more restricted than invoicing), and
-- request_refund / record_refund carry NO in-body role check — they lean on the
-- app's can() gate plus RLS. The app's can() gate is client-side and bypassable
-- by calling the RPC directly over PostgREST, so with RLS admitting ops_admin an
-- ops_admin could initiate the refund workflow the capability model reserves for
-- the owner (the disbursement still needs owner APPROVAL — the money floor is
-- owner-tier — but an ops_admin should not be able to open or record the request
-- at all). Narrow both refund policies to owner, so RLS is the boundary the
-- capability describes rather than one role wider.
-- ═══════════════════════════════════════════════════════════════════════════

alter policy refunds_sanctioned_insert on finance.refunds
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) = 'owner'
  );

alter policy refunds_sanctioned_update on finance.refunds
  using (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) = 'owner'
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.current_user_role()) = 'owner'
  );
