-- Two things the finance screens needed (PDF gap X1; owner decisions 5 and 7
-- of 2026-10-01).
--
-- 1. UPLOADED PROOF AND RECEIPTS (decision 5). A payment claim's proof and an
--    expense's receipt may now be a file, kept in the same private bucket as
--    project files (so under the same size limit, the same credentials guard
--    and the same tenant-folder storage policy), as well as the link they
--    always could be. The row records WHERE the object is, never its bytes:
--      finance.payment_submissions.proof_storage_path / proof_file_name
--      finance.expenses.receipt_storage_path / receipt_file_name
--    The first folder of a path is the organization, which the bucket policy
--    checks; a CHECK here refuses a path that names another tenant.
--
-- 2. THE FINANCE ROLE READS A CLIENT'S NAME, AND ONLY THAT (decision 7).
--    core.client_accounts stays closed to it (G-314: contacts, billing
--    e-mail and notes are not money). `finance.client_names(ids)` is the
--    one narrow reader: security definer, owner / ops_admin / finance only,
--    scoped to the caller's organization, returning (id, name) and nothing
--    else (no ids = every client of the organization, names only, at most 1000). No contact, no e-mail, no notes, no other client data.
--
-- Additive and idempotent.

alter table finance.payment_submissions add column if not exists proof_storage_path text;
alter table finance.payment_submissions add column if not exists proof_file_name text;
alter table finance.expenses add column if not exists receipt_storage_path text;
alter table finance.expenses add column if not exists receipt_file_name text;

alter table finance.payment_submissions drop constraint if exists payment_submissions_proof_path_is_tenant_scoped;
alter table finance.payment_submissions add constraint payment_submissions_proof_path_is_tenant_scoped
  check (proof_storage_path is null or (split_part(proof_storage_path, '/', 1) = organization_id::text and length(proof_storage_path) <= 600));

alter table finance.expenses drop constraint if exists expenses_receipt_path_is_tenant_scoped;
alter table finance.expenses add constraint expenses_receipt_path_is_tenant_scoped
  check (receipt_storage_path is null or (split_part(receipt_storage_path, '/', 1) = organization_id::text and length(receipt_storage_path) <= 600));

comment on column finance.payment_submissions.proof_storage_path is
  'Object key of an uploaded proof in the project-files bucket (<organization>/finance/claim-proof/<id>/<name>). The link in proof_url may stand beside it.';
comment on column finance.expenses.receipt_storage_path is
  'Object key of an uploaded receipt in the project-files bucket (<organization>/finance/expense-receipt/<id>/<name>). The link in receipt_url may stand beside it.';

create or replace function finance.client_names(p_ids uuid[] default null)
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.name
    from core.client_accounts c
   where (p_ids is null or c.id = any (p_ids))
     and c.organization_id = (select core.current_organization_id())
     and ((select core.is_admin()) or (select core.is_finance()))
   order by c.name
   limit 1000;
$$;

revoke all on function finance.client_names(uuid[]) from public, anon;
grant execute on function finance.client_names(uuid[]) to authenticated, service_role;

comment on function finance.client_names(uuid[]) is
  'The one thing the finance role may read of a client: its name (id, name). Owner, ops_admin and finance only, inside the caller''s organization. No contacts, no e-mail, no notes.';

notify pgrst, 'reload schema';
