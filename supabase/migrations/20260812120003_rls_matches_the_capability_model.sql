-- ═══════════════════════════════════════════════════════════════════════════
-- The database refuses what the application refuses.
--
-- Audit finding D16. AGENCYOS_SECURITY.md §3 says RLS and capabilities answer
-- different questions and that both are required — and src/lib/db/server.ts,
-- the invoices page and ARCHITECTURE.md §8.1 all say the database is the
-- backstop for an application check that is missed. For four families of table
-- that was not true: RLS was the *wider* layer, so the backstop admitted more
-- than the thing it was backing up.
--
-- The two helpers are tiers, not capabilities, and they had drifted:
--
--   core.is_internal()  owner, ops_admin, delivery_lead, member, contractor
--   core.can_write()    owner, ops_admin, delivery_lead, member
--
-- against a capability model (src/lib/authz/permissions.ts) that says:
--
--   invoice.read                 owner, ops_admin            (+ client_admin)
--   project.write, milestone.write   owner, ops_admin, delivery_lead
--   lead.write, contact.write    owner, ops_admin
--   proposal.draft, proposal.send    owner, ops_admin
--
-- So a contractor — an external collaborator — could select every invoice in
-- the organization: number, status, totals, paid_minor, client account, notes,
-- and every line item. Not through the UI, which redirects without
-- invoice.read, but straight through the Data API with their own session,
-- because the finance schema is exposed and `authenticated` holds the grant.
-- And a member could write projects, milestones, leads, contacts and the whole
-- sales pipeline while holding none of those capabilities.
--
-- Nothing here widens anything. Every policy below moves to exactly the role
-- set the capability model already publishes, so no request the application
-- would have allowed is newly refused — the service layer was already checking
-- the narrower rule on every one of these paths.
--
-- ── the one coupling, and why it needs care ──────────────────────────────
--
-- projects.replace_payment_plan (D8) is SECURITY INVOKER and reads
-- finance.invoices to refuse a plan rewrite that would orphan a live bill. It
-- runs for milestone.write, which includes delivery_lead. Narrowing
-- invoices_select without noticing would leave that lookup returning nothing
-- for a delivery_lead — the guard would find no blocking invoice, and D8 would
-- silently re-open for exactly the role most likely to edit a plan.
--
-- finance.blocking_invoice_number answers that one question behind a SECURITY
-- DEFINER boundary instead. It is deliberately the smallest possible hole: it
-- takes a project, resolves tenancy itself from the caller's own claim rather
-- than from an argument, and returns one invoice number or nothing. It cannot
-- be used to read a total, a status, or another organization's anything.
--
-- ── what is deliberately left alone ──────────────────────────────────────
--
-- projects.tasks stays on can_write(), which admits owner, ops_admin,
-- delivery_lead and member but not contractor — *narrower* than task.write,
-- which grants contractor. That fails closed, and widening a policy has no
-- place in a migration whose whole purpose is narrowing.
--
-- crm.conversations, crm.conversation_messages, core.client_accounts and
-- core.client_users also stay on can_write(): the capability model publishes
-- no capability for them, so there is no narrower answer to move to without
-- inventing one. Recorded rather than guessed.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the tier the delivery tables actually mean ───────────────────────────
create or replace function core.can_manage_delivery()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select core.current_user_role() in ('owner', 'ops_admin', 'delivery_lead');
$$;

comment on function core.can_manage_delivery() is
  'Owner, ops_admin or delivery_lead — exactly the roles holding project.write and milestone.write. Distinct from core.can_write(), which also admits member.';

-- ── finance: only the roles holding invoice.read ─────────────────────────
drop policy if exists invoices_select on finance.invoices;
create policy invoices_select on finance.invoices
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_admin())
      or (
        (select core.is_client())
        and client_account_id = (select core.current_client_account_id())
        and status <> 'draft'
        and status <> 'pending_approval'
      )
    )
  );

drop policy if exists invoice_items_select on finance.invoice_items;
create policy invoice_items_select on finance.invoice_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and exists (
      select 1 from finance.invoices i
       where i.id = invoice_id
    )
  );

-- ── delivery: only the roles holding project.write / milestone.write ─────
drop policy if exists projects_write on projects.projects;
create policy projects_write on projects.projects
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

drop policy if exists milestones_write on projects.milestones;
create policy milestones_write on projects.milestones
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()))
  with check (organization_id = (select core.current_organization_id()) and (select core.can_manage_delivery()));

-- ── crm: only the roles holding lead.write / contact.write ───────────────
drop policy if exists contacts_write on crm.contacts;
create policy contacts_write on crm.contacts
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

drop policy if exists leads_write on crm.leads;
create policy leads_write on crm.leads
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

-- ── sales: only the roles holding the proposal capabilities ──────────────
do $$
declare t text;
begin
  foreach t in array array['opportunities', 'proposals', 'proposal_items'] loop
    execute format('drop policy if exists %I on sales.%I', t || '_write', t);
    execute format($f$
      create policy %I on sales.%I
        for all to authenticated
        using (organization_id = (select core.current_organization_id())
               and (select core.is_admin()))
        with check (organization_id = (select core.current_organization_id())
               and (select core.is_admin()))
    $f$, t || '_write', t);
  end loop;
end $$;

-- ── the one lookup the narrowing would otherwise break ───────────────────
create or replace function finance.blocking_invoice_number(
  p_project_id      uuid,
  p_organization_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.number
    from finance.invoices i
    join projects.milestones m on m.id = i.milestone_id
   where m.project_id = p_project_id
     -- Only the milestones a rewrite would actually delete. An invoice on an
     -- unpriced delivery checkpoint survives the rewrite untouched, so
     -- blocking on it would refuse a plan change that harms nothing. The
     -- predicate matches the DELETE in projects.replace_payment_plan exactly;
     -- if the two ever drift, this one must stay the wider of the pair.
     and m.payment_percent is not null
     and i.status <> 'void'
     and m.organization_id = p_organization_id
     and i.organization_id = p_organization_id
     -- The organization comes from the caller, but not from the *request*:
     -- replace_payment_plan reads it off the project row it just locked under
     -- RLS, so a session caller can only ever pass an organization it could
     -- already reach. This line is what stops the function being useful to
     -- anyone calling it directly — a signed-in user may only ask about their
     -- own organization. A caller with no claim at all is the service role,
     -- which bypasses RLS everywhere by design and is trusted to scope itself
     -- (ARCHITECTURE.md §7.3).
     and (core.current_organization_id() is null
          or core.current_organization_id() = p_organization_id)
   order by i.number
   limit 1;
$$;

comment on function finance.blocking_invoice_number(uuid, uuid) is
  'The first live invoice raised against a project payment plan, or null. Definer so that a delivery_lead — who may rewrite a plan but may not read the invoice book — still cannot rewrite one out from under a bill. Answers only for an organization the caller can already reach, and returns one invoice number and nothing else.';

revoke all on function finance.blocking_invoice_number(uuid, uuid) from public, anon;
grant execute on function finance.blocking_invoice_number(uuid, uuid) to authenticated, service_role;

-- ── and the guard that depends on it ─────────────────────────────────────
--
-- Unchanged except for where the blocking invoice comes from. Still SECURITY
-- INVOKER: the plan itself is the caller's to read and write under
-- milestones_write, and only the one invoice lookup needed lifting.
create or replace function projects.replace_payment_plan(
  p_project_id uuid,
  p_milestones jsonb
)
returns table (
  outcome        text,
  milestone_count int,
  blocking_number text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_org      uuid;
  v_currency char(3);
  v_blocking text;
  v_met      int;
  v_count    int;
begin
  select p.organization_id, p.currency
    into v_org, v_currency
    from projects.projects p
   where p.id = p_project_id
     and p.deleted_at is null
     for update;

  if not found then
    return query select 'not_found'::text, null::int, null::text;
    return;
  end if;

  perform 1
     from projects.milestones m
    where m.project_id = p_project_id
      for update;

  select count(*)
    into v_met
    from projects.milestones m
   where m.project_id = p_project_id
     and m.payment_percent is not null
     and m.status = 'met';

  if v_met > 0 then
    return query select 'met'::text, null::int, null::text;
    return;
  end if;

  -- Through the definer helper, so the answer does not depend on whether this
  -- particular role may read the invoice book (audit D16). Still read after
  -- the lock above, which is what makes it true at the write below.
  v_blocking := finance.blocking_invoice_number(p_project_id, v_org);

  if v_blocking is not null then
    return query select 'billed'::text, null::int, v_blocking;
    return;
  end if;

  delete from projects.milestones m
   where m.project_id = p_project_id
     and m.payment_percent is not null;

  insert into projects.milestones (
    organization_id, project_id, name, position,
    payment_percent, amount_minor, currency, due_on
  )
  select v_org,
         p_project_id,
         item.value ->> 'name',
         (item.ordinality - 1)::int,
         (item.value ->> 'percent')::numeric,
         (item.value ->> 'amountMinor')::bigint,
         v_currency,
         nullif(item.value ->> 'dueOn', '')::date
    from jsonb_array_elements(p_milestones) with ordinality as item(value, ordinality);

  get diagnostics v_count = row_count;

  return query select 'replaced'::text, v_count, null::text;
end;
$$;

revoke all on function projects.replace_payment_plan(uuid, jsonb) from public, anon;
grant execute on function projects.replace_payment_plan(uuid, jsonb) to authenticated, service_role;
