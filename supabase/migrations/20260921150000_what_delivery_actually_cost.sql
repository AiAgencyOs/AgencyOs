-- ═══════════════════════════════════════════════════════════════════════════
-- What delivery actually cost.
--
-- SCR-055's Expenses & Profitability screen had no table to read: the schema
-- audit behind the Admin Panel rebuild found `finance.invoices` (what was
-- billed) and `ai.cost_ledger` (what AI usage cost) but nothing recording an
-- infrastructure bill, a contractor invoice, or a tool subscription — the
-- other half of "what did this project actually cost to deliver", which is
-- what turns revenue into a margin.
--
-- ── why project_id is nullable ─────────────────────────────────────────────
--
-- Not every cost belongs to one delivery: a shared Vercel plan or a company-
-- wide Figma seat is overhead, not a project expense. Nullable rather than a
-- synthetic "overhead" project keeps that distinction a fact about the
-- expense (it has no project) rather than a row in `projects.projects` that
-- exists only to be pointed at.
--
-- ── why this is never client-visible ───────────────────────────────────────
--
-- Business rules §19 (and the brief this Admin Panel rebuild was scoped
-- against): "client pricing separate from internal delivery cost; margins
-- restricted to authorized internal roles." `expenses_select` has no client
-- branch at all — compare `finance.invoices_select`, which does — and
-- `core.is_finance()` (G-314, 20260921120000) is exactly "reads money,
-- nothing else", so the finance role reads this the same way it reads
-- invoices without being able to write either.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists finance.expenses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- Nullable: overhead has no one project to charge. See note above.
  project_id       uuid references projects.projects(id) on delete set null,

  category         text not null check (category in
                      ('infrastructure', 'ai', 'tooling', 'vendor', 'contractor', 'other')),
  vendor           text,
  description      text not null check (length(trim(description)) > 0),

  currency         char(3) not null default 'INR',
  amount_minor     bigint not null check (amount_minor >= 0),

  incurred_on      date not null,

  recorded_by      uuid references core.users(id) on delete set null,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists expenses_organization_idx
  on finance.expenses (organization_id, incurred_on desc);
create index if not exists expenses_project_idx
  on finance.expenses (project_id) where project_id is not null;
create index if not exists expenses_category_idx
  on finance.expenses (organization_id, category);

comment on table finance.expenses is
  'Internal cost tracking by project, category and vendor — SCR-055. Never client-visible (business rules §19): internal delivery cost is restricted to owner, ops_admin and the finance role, the same three that may read finance.invoices, and only owner/ops_admin may write here.';

comment on column finance.expenses.project_id is
  'Null for overhead not tied to one delivery (a shared infrastructure bill, a company-wide tool seat) — nullable rather than a synthetic project row, so "has no project" stays a fact about the expense.';

drop trigger if exists set_updated_at on finance.expenses;
create trigger set_updated_at before update on finance.expenses
  for each row execute function core.set_updated_at();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table finance.expenses enable row level security;
alter table finance.expenses force row level security;

drop policy if exists expenses_select on finance.expenses;
create policy expenses_select on finance.expenses
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and ((select core.is_admin()) or (select core.is_finance()))
  );

drop policy if exists expenses_write on finance.expenses;
create policy expenses_write on finance.expenses
  for all to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_admin()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_admin()));

drop trigger if exists org_match_expenses_project on finance.expenses;
create trigger org_match_expenses_project
  before insert or update of project_id, organization_id on finance.expenses
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_expenses on finance.expenses;
create trigger freeze_org_expenses
  before update of organization_id on finance.expenses
  for each row execute function core.freeze_organization_id();
