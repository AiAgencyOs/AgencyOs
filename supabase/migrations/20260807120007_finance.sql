-- ═══════════════════════════════════════════════════════════════════════════
-- 007 — finance: invoices, line items, payments
--
-- All money is BIGINT minor units (paise for INR, cents for USD) plus an ISO
-- currency. Never floating point: 0.1 + 0.2 must not be a billing question.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.invoices (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  client_account_id  uuid not null references core.client_accounts(id) on delete restrict,
  project_id         uuid references projects.projects(id) on delete set null,
  milestone_id       uuid references projects.milestones(id) on delete set null,

  number             text not null,
  status             text not null default 'draft' check (status in
                       ('draft', 'pending_approval', 'issued', 'partially_paid',
                        'paid', 'void', 'overdue')),

  currency           char(3) not null default 'INR',
  subtotal_minor     bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor          bigint not null default 0 check (tax_minor >= 0),
  total_minor        bigint not null default 0 check (total_minor >= 0),
  paid_minor         bigint not null default 0 check (paid_minor >= 0),

  notes              text,
  provider_ref       text,

  issued_at          timestamptz,
  due_at             timestamptz,
  paid_at            timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (organization_id, number),

  constraint invoices_paid_not_over_total check (paid_minor <= total_minor),
  constraint invoices_issued_at_set check (status = 'draft' or status = 'pending_approval' or issued_at is not null),
  constraint invoices_paid_at_set check (status <> 'paid' or paid_at is not null)
);

create index if not exists invoices_organization_status_idx
  on finance.invoices (organization_id, status, due_at);
create index if not exists invoices_account_idx
  on finance.invoices (client_account_id, status);
create index if not exists invoices_milestone_idx on finance.invoices (milestone_id);

create table if not exists finance.invoice_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  invoice_id       uuid not null references finance.invoices(id) on delete cascade,

  position         int not null default 0,
  description      text not null,
  quantity         numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  amount_minor     bigint not null default 0 check (amount_minor >= 0),
  tax_rate_bp      int not null default 0 check (tax_rate_bp between 0 and 10000),  -- basis points

  created_at       timestamptz not null default now()
);

create index if not exists invoice_items_invoice_idx
  on finance.invoice_items (invoice_id, position);

comment on column finance.invoice_items.tax_rate_bp is
  'Tax rate in basis points (1800 = 18% GST). Integer, so rates never round.';

create table if not exists finance.payments (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  invoice_id           uuid not null references finance.invoices(id) on delete restrict,

  provider             text not null default 'razorpay',
  provider_payment_id  text not null,

  amount_minor         bigint not null check (amount_minor > 0),
  currency             char(3) not null default 'INR',

  status               text not null check (status in
                         ('created', 'authorized', 'captured', 'failed', 'refunded')),

  captured_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Webhook idempotency: a provider payment lands at most once, enforced by
  -- the database rather than by application checks that race under concurrency.
  unique (provider, provider_payment_id)
);

create index if not exists payments_invoice_idx on finance.payments (invoice_id, status);
create index if not exists payments_organization_idx on finance.payments (organization_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['invoices','payments']
  loop
    execute format('drop trigger if exists set_updated_at on finance.%I', t);
    execute format(
      'create trigger set_updated_at before update on finance.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table finance.invoices      enable row level security;
alter table finance.invoice_items enable row level security;
alter table finance.payments      enable row level security;

-- Clients see their own invoices once issued — never drafts.
drop policy if exists invoices_select on finance.invoices;
create policy invoices_select on finance.invoices
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.is_internal())
      or (
        (select core.is_client())
        and client_account_id = (select core.current_client_account_id())
        and status not in ('draft', 'pending_approval')
      )
    )
  );

-- Only owners and ops touch money.
drop policy if exists invoices_write on finance.invoices;
create policy invoices_write on finance.invoices
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'))
  with check (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'));

drop policy if exists invoice_items_select on finance.invoice_items;
create policy invoice_items_select on finance.invoice_items
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and exists (
      select 1 from finance.invoices i
       where i.id = invoice_items.invoice_id
    )
  );

drop policy if exists invoice_items_write on finance.invoice_items;
create policy invoice_items_write on finance.invoice_items
  for all to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'))
  with check (organization_id = (select core.current_organization_id())
         and (select core.current_user_role()) in ('owner', 'ops_admin'));

-- Payments are written by the webhook handler under service_role, which
-- bypasses RLS. Humans read only.
drop policy if exists payments_select on finance.payments;
create policy payments_select on finance.payments
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (
      (select core.current_user_role()) in ('owner', 'ops_admin')
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
