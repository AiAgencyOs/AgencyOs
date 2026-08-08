-- ═══════════════════════════════════════════════════════════════════════════
-- 005 — sales: opportunities and proposals
--
-- Spine only. Quote pricing rules, versioning, and the approval join land with
-- the sales feature; this establishes the tenancy, keys, and RLS shape now so
-- later migrations are additive.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists sales.opportunities (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  lead_id            uuid references crm.leads(id) on delete set null,
  client_account_id  uuid references core.client_accounts(id) on delete set null,

  name               text not null check (length(trim(name)) > 0),
  stage              text not null default 'discovery' check (stage in
                       ('discovery', 'proposal', 'negotiation', 'won', 'lost')),

  currency           char(3) not null default 'INR',
  value_minor        bigint not null default 0 check (value_minor >= 0),

  expected_close_on  date,
  closed_at          timestamptz,
  lost_reason        text,

  owner_id           uuid references core.users(id) on delete set null,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint opportunities_closed_at_set
    check (stage not in ('won', 'lost') or closed_at is not null)
);

create index if not exists opportunities_organization_stage_idx
  on sales.opportunities (organization_id, stage, created_at desc);
create index if not exists opportunities_lead_idx on sales.opportunities (lead_id);
create index if not exists opportunities_account_idx on sales.opportunities (client_account_id);

create table if not exists sales.proposals (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  opportunity_id     uuid not null references sales.opportunities(id) on delete cascade,

  version            int not null default 1 check (version > 0),
  title              text not null,
  body               text,

  status             text not null default 'draft' check (status in
                       ('draft', 'pending_approval', 'approved', 'sent', 'accepted', 'rejected')),

  currency           char(3) not null default 'INR',
  subtotal_minor     bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor          bigint not null default 0 check (tax_minor >= 0),
  total_minor        bigint not null default 0 check (total_minor >= 0),

  -- Set when an AI agent drafted it; null when a human wrote it.
  generated_by_run_id uuid,

  sent_at            timestamptz,
  decided_at         timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (opportunity_id, version)
);

create index if not exists proposals_organization_status_idx
  on sales.proposals (organization_id, status, created_at desc);

create table if not exists sales.proposal_items (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  proposal_id      uuid not null references sales.proposals(id) on delete cascade,

  position         int not null default 0,
  description      text not null,
  quantity         numeric(12, 2) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null default 0 check (unit_price_minor >= 0),
  amount_minor     bigint not null default 0 check (amount_minor >= 0),

  created_at       timestamptz not null default now()
);

create index if not exists proposal_items_proposal_idx
  on sales.proposal_items (proposal_id, position);

do $$
declare t text;
begin
  foreach t in array array['opportunities','proposals']
  loop
    execute format('drop trigger if exists set_updated_at on sales.%I', t);
    execute format(
      'create trigger set_updated_at before update on sales.%I
         for each row execute function core.set_updated_at()', t);
  end loop;
end;
$$;

-- ── RLS ───────────────────────────────────────────────────────────────────
alter table sales.opportunities  enable row level security;
alter table sales.proposals      enable row level security;
alter table sales.proposal_items enable row level security;

-- Policy names are built as whole identifiers, not by concatenating a suffix
-- onto a %I placeholder: format('%I_select', t) quotes only `t` and yields
-- "opportunities"_select, which is a syntax error.
do $$
declare
  t text;
  select_policy text;
  write_policy text;
begin
  foreach t in array array['opportunities','proposals','proposal_items']
  loop
    select_policy := t || '_select';
    write_policy  := t || '_write';

    execute format('drop policy if exists %I on sales.%I', select_policy, t);
    execute format(
      'create policy %I on sales.%I for select to authenticated
         using (organization_id = (select core.current_organization_id())
                and (select core.is_internal()))', select_policy, t);

    execute format('drop policy if exists %I on sales.%I', write_policy, t);
    execute format(
      'create policy %I on sales.%I for all to authenticated
         using (organization_id = (select core.current_organization_id())
                and (select core.can_write()))
         with check (organization_id = (select core.current_organization_id())
                and (select core.can_write()))', write_policy, t);
  end loop;
end;
$$;
