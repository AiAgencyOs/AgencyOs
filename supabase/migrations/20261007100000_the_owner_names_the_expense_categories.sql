-- The expense categories are the owner's list (PDF gap X1, owner decision 6 of
-- 2026-10-01: "Owner-editable list, starting from infrastructure, ai, tooling,
-- vendor, contractor, other. Old expenses keep theirs.").
--
-- Until now the list was a CHECK constraint on finance.expenses.category and a
-- constant in the application, so adding "Legal" meant a migration.
--
--   finance.expense_categories   one row per category per organization.
--       key      what finance.expenses.category stores (a slug: a-z, 0-9, _).
--                Never rewritten: an expense keeps the key it was recorded with.
--       label    what people read; the owner may rename it.
--       retired_at  a retired category is not offered on a new expense, and is
--                never deleted, so every old expense still resolves to a label.
--   finance.set_expense_category(action, key, label)
--       the one door: add | rename | retire | restore. Owner or ops_admin only,
--       validated, audited with the old and the new row. The last active
--       category cannot be retired (an expense must always have somewhere to go).
--
-- The old CHECK is replaced by a guard trigger: on insert, and when the category
-- changes, the category must be one of the organization's ACTIVE categories. An
-- expense that keeps a category (even one retired since) may be edited freely.
--
-- Every organization starts with the six the owner named; a new organization is
-- seeded by a trigger. Additive and idempotent.

create table if not exists finance.expense_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  key             text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label           text not null check (length(btrim(label)) between 1 and 60),
  sort_order      integer not null default 0,
  retired_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, key)
);

create index if not exists expense_categories_org_idx on finance.expense_categories (organization_id, sort_order, label);

comment on table finance.expense_categories is
  'The owner''s list of expense categories. finance.expenses.category stores `key`; a category is retired, never deleted, so old expenses keep their label. Written only through finance.set_expense_category.';

drop trigger if exists set_updated_at on finance.expense_categories;
create trigger set_updated_at before update on finance.expense_categories
  for each row execute function core.set_updated_at();

alter table finance.expense_categories enable row level security;
alter table finance.expense_categories force row level security;

drop policy if exists expense_categories_select on finance.expense_categories;
create policy expense_categories_select on finance.expense_categories
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and ((select core.is_admin()) or (select core.is_finance()))
  );

revoke all on finance.expense_categories from public, anon;
revoke insert, update, delete on finance.expense_categories from authenticated;
grant select on finance.expense_categories to authenticated;
grant select, insert, update, delete on finance.expense_categories to service_role;

drop trigger if exists freeze_org_expense_categories on finance.expense_categories;
create trigger freeze_org_expense_categories
  before update of organization_id on finance.expense_categories
  for each row execute function core.freeze_organization_id();

-- ── the six the owner named, for every organization ────────────────────────

create or replace function finance.seed_expense_categories(p_organization_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into finance.expense_categories (organization_id, key, label, sort_order)
  values
    (p_organization_id, 'infrastructure', 'Infrastructure', 10),
    (p_organization_id, 'ai',             'AI',             20),
    (p_organization_id, 'tooling',        'Tooling',        30),
    (p_organization_id, 'vendor',         'Vendor',         40),
    (p_organization_id, 'contractor',     'Contractor',     50),
    (p_organization_id, 'other',          'Other',          60)
  on conflict (organization_id, key) do nothing;
$$;

revoke all on function finance.seed_expense_categories(uuid) from public, anon, authenticated;
grant execute on function finance.seed_expense_categories(uuid) to service_role;

select finance.seed_expense_categories(o.id) from core.organizations o;

create or replace function finance.seed_expense_categories_for_new_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform finance.seed_expense_categories(new.id);
  return new;
end;
$$;

revoke all on function finance.seed_expense_categories_for_new_org() from public, anon, authenticated;

drop trigger if exists seed_expense_categories on core.organizations;
create trigger seed_expense_categories
  after insert on core.organizations
  for each row execute function finance.seed_expense_categories_for_new_org();

-- Any category an expense already carries that the list lacks (it cannot, with
-- the old CHECK in force, but a restored backup might) is kept as a retired row.
insert into finance.expense_categories (organization_id, key, label, sort_order, retired_at)
select distinct e.organization_id, e.category, initcap(replace(e.category, '_', ' ')), 90, now()
  from finance.expenses e
 where e.category ~ '^[a-z][a-z0-9_]{0,39}$'
on conflict (organization_id, key) do nothing;

-- ── the guard that replaces the CHECK ───────────────────────────────────────

alter table finance.expenses drop constraint if exists expenses_category_check;

create or replace function finance.expense_category_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.category is not distinct from old.category then
    return new;
  end if;
  if not exists (
    select 1 from finance.expense_categories c
     where c.organization_id = new.organization_id
       and c.key = new.category
       and c.retired_at is null
  ) then
    raise exception 'expense category "%" is not an active category of this organization', new.category
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists expense_category_guard on finance.expenses;
create trigger expense_category_guard
  before insert or update of category on finance.expenses
  for each row execute function finance.expense_category_guard();

-- ── the door ────────────────────────────────────────────────────────────────

create or replace function finance.set_expense_category(
  p_action text,
  p_key    text,
  p_label  text
)
returns table (outcome text, category_key text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_key text := nullif(btrim(coalesce(p_key, '')), '');
  v_row finance.expense_categories%rowtype;
  v_active integer;
  v_next integer;
begin
  if v_org is null or (select core.current_user_role()) not in ('owner', 'ops_admin') then
    return query select 'forbidden'::text, null::text;
    return;
  end if;
  if p_action not in ('add', 'rename', 'retire', 'restore') then
    return query select 'invalid_action'::text, null::text;
    return;
  end if;

  if p_action = 'add' then
    if v_label is null or length(v_label) > 60 then
      return query select 'invalid_label'::text, null::text;
      return;
    end if;
    -- The key is the label as a slug: letters and digits, underscores between.
    v_key := regexp_replace(regexp_replace(lower(v_label), '[^a-z0-9]+', '_', 'g'), '^_+|_+$', '', 'g');
    v_key := left(v_key, 40);
    if v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' then
      return query select 'invalid_label'::text, null::text;
      return;
    end if;
    if exists (select 1 from finance.expense_categories c where c.organization_id = v_org and (c.key = v_key or lower(c.label) = lower(v_label))) then
      return query select 'exists'::text, v_key;
      return;
    end if;
    select coalesce(max(c.sort_order), 0) + 10 into v_next from finance.expense_categories c where c.organization_id = v_org;
    insert into finance.expense_categories (organization_id, key, label, sort_order)
    values (v_org, v_key, v_label, v_next)
    returning * into v_row;
    perform core.record_audit(v_org, 'finance.expense_category_added', 'expense_category', v_row.id, null,
      jsonb_build_object('key', v_row.key, 'label', v_row.label));
    return query select 'added'::text, v_row.key;
    return;
  end if;

  select * into v_row from finance.expense_categories c where c.organization_id = v_org and c.key = v_key for update;
  if not found then
    return query select 'not_found'::text, v_key;
    return;
  end if;

  if p_action = 'rename' then
    if v_label is null or length(v_label) > 60 then
      return query select 'invalid_label'::text, v_row.key;
      return;
    end if;
    if exists (select 1 from finance.expense_categories c where c.organization_id = v_org and c.key <> v_row.key and lower(c.label) = lower(v_label)) then
      return query select 'exists'::text, v_row.key;
      return;
    end if;
    update finance.expense_categories set label = v_label where id = v_row.id;
    perform core.record_audit(v_org, 'finance.expense_category_renamed', 'expense_category', v_row.id,
      jsonb_build_object('key', v_row.key, 'label', v_row.label), jsonb_build_object('key', v_row.key, 'label', v_label));
    return query select 'renamed'::text, v_row.key;
    return;
  end if;

  if p_action = 'retire' then
    if v_row.retired_at is not null then
      return query select 'unchanged'::text, v_row.key;
      return;
    end if;
    select count(*) into v_active from finance.expense_categories c where c.organization_id = v_org and c.retired_at is null;
    if v_active <= 1 then
      return query select 'last_active'::text, v_row.key;
      return;
    end if;
    update finance.expense_categories set retired_at = now() where id = v_row.id;
    perform core.record_audit(v_org, 'finance.expense_category_retired', 'expense_category', v_row.id,
      jsonb_build_object('key', v_row.key, 'label', v_row.label, 'retired', false), jsonb_build_object('key', v_row.key, 'label', v_row.label, 'retired', true));
    return query select 'retired'::text, v_row.key;
    return;
  end if;

  -- restore
  if v_row.retired_at is null then
    return query select 'unchanged'::text, v_row.key;
    return;
  end if;
  update finance.expense_categories set retired_at = null where id = v_row.id;
  perform core.record_audit(v_org, 'finance.expense_category_restored', 'expense_category', v_row.id,
    jsonb_build_object('key', v_row.key, 'label', v_row.label, 'retired', true), jsonb_build_object('key', v_row.key, 'label', v_row.label, 'retired', false));
  return query select 'restored'::text, v_row.key;
end;
$$;

revoke all on function finance.set_expense_category(text, text, text) from public, anon;
grant execute on function finance.set_expense_category(text, text, text) to authenticated, service_role;

comment on function finance.set_expense_category(text, text, text) is
  'Add, rename, retire or restore an expense category. Owner / ops_admin only; the key is the label''s slug and never changes; retire never deletes (old expenses keep theirs); the last active category cannot be retired; every change is audited with the old and new row.';

notify pgrst, 'reload schema';
