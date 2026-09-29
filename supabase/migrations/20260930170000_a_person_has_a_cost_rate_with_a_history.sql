-- ═══════════════════════════════════════════════════════════════════════════
-- A person has a cost rate, with a history.
--
-- Bucket E, the owner's decision E2 of 2026-09-30 (docs/AGENCYOS_ADMIN_BUCKET_E_PLAN.md):
-- time on the project report is COSTED at a per-person hourly rate. The
-- first answer to this question was "keep uncosted" (20260930110000 §2 and
-- §4 say so, and margin-queries.ts said no rate column existed anywhere);
-- the owner re-decided, and this migration is the rate column.
--
-- The rule that everything here serves: a log is priced at the rate in force
-- for that person ON THE DAY OF THE LOG, never today's rate, so a rate change
-- does not rewrite history. That is why a rate is a ROW WITH A DATE rather
-- than a column on the membership, why the table is append-only, and why the
-- costing is a view that looks the rate up by `logged_on`.
--
-- 1. core.member_cost_rates — one row per (person, effective_from) change.
--    · Cost, not billing: nothing here is read by an invoice, a quotation or
--      a payment. finance.* does not reference the table; the report's
--      margin reads the projects.* views below.
--    · Private to management: SELECT is owner and ops_admin only
--      (core.is_admin()). A person does not see their own rate through this
--      table, and the report shows a per-person cost only to roles holding
--      `invoice.read`.
--    · Append-only: there is NO update policy and NO delete policy, and the
--      grant carries neither. A wrong rate is corrected by a NEW row from the
--      same date; the latest row for a date wins (the view orders by
--      effective_from desc, created_at desc). For that reason the plan's
--      unique (organization_id, user_id, effective_from) is NOT declared — it
--      would forbid the very correction the append-only rule depends on —
--      and an ordered index takes its place. Deviation from the plan text,
--      stated here on purpose.
--    · Insert only through the door: the owner-only insert policy decides
--      again under RLS, and a BEFORE INSERT trigger refuses any row the door
--      did not mark for this transaction (`core.cost_rate_door`, the same
--      transaction-local set_config pattern 20260929190000 uses for
--      unfreezing a scope version). A direct insert by an owner through
--      PostgREST is therefore refused with a sentence naming the door.
--    · user_id references core.users, which is not tenant-scoped, so
--      enforce_parent_org cannot check it; the membership trigger below does
--      the tenant check instead (an active membership of THIS organization),
--      and the door checks it again to answer with a name rather than an
--      exception. freeze_organization_id is installed as on every table,
--      though with no update grant nothing can reach it.
--
-- 2. core.set_member_cost_rate(user_id, hourly_cost_minor, effective_from, note)
--    — owner only (core.is_owner(), coalesced), security INVOKER so the
--    policy decides again and the audit row carries the caller's own
--    identity. Audits `cost_rate.set` with BEFORE = the rate that was in
--    force for that person on effective_from (or null) and AFTER = the new
--    row, so the log reads as a change, not an insert.
--
-- 3. projects.time_log_costs — every time log with the rate in force on its
--    `logged_on` (LATERAL: latest effective_from <= logged_on), `cost_minor
--    = round(hours × rate)` and `rate_missing` when no rate covers that day.
--    security_invoker: the base table's RLS decides which logs exist, and
--    member_cost_rates' RLS decides whether a rate is visible — a reader who
--    may not see rates sees every log as uncosted, never a number.
--
-- 4. The three totals views of 20260930110000 are re-created over the
--    costed view with the same columns in the same order, plus `cost_minor`
--    and `uncosted_hours` appended. Uncosted hours are REPORTED, never
--    treated as zero cost: the report says "N h uncosted — no rate on those
--    days" and the CSV carries both.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. core.member_cost_rates ─────────────────────────────────────────────

create table if not exists core.member_cost_rates (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  user_id            uuid not null references core.users(id) on delete cascade,
  hourly_cost_minor  bigint not null check (hourly_cost_minor > 0),
  currency           text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  effective_from     date not null,
  set_by             uuid not null references core.users(id),
  note               text check (note is null or length(btrim(note)) between 1 and 600),
  created_at         timestamptz not null default now()
);

comment on table core.member_cost_rates is
  'A person''s hourly COST rate (paise per hour) from a date, one row per change — decision E2 of 2026-09-30. Append-only: no update or delete; a correction is a new row from the same date and the latest row for a date wins. Cost, not billing: nothing in finance reads it. Select is owner and ops_admin only; insert is owner only and only through core.set_member_cost_rate.';

-- The lookup the costing view makes: this person's latest rate on or before a day.
create index if not exists member_cost_rates_lookup_idx
  on core.member_cost_rates (organization_id, user_id, effective_from desc, created_at desc);

alter table core.member_cost_rates enable row level security;
alter table core.member_cost_rates force row level security;

-- Management reads it. A person does not read their own rate here.
drop policy if exists member_cost_rates_select on core.member_cost_rates;
create policy member_cost_rates_select on core.member_cost_rates
  for select to authenticated
  using (organization_id = (select core.current_organization_id())
         and (select core.is_admin()));

-- Owner writes it, as themself. No update policy, no delete policy: the
-- history is the record.
drop policy if exists member_cost_rates_insert on core.member_cost_rates;
create policy member_cost_rates_insert on core.member_cost_rates
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.is_owner())
              and set_by = (select auth.uid()));

-- Deliberately no update and no delete in this grant.
revoke update, delete on core.member_cost_rates from authenticated;
grant select, insert on core.member_cost_rates to authenticated, service_role;

-- The person must be a member of this organization. core.users is global, so
-- the usual enforce_parent_org has nothing to compare; the membership is the
-- tenant fact.
create or replace function core.check_cost_rate_member()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from core.memberships m
     where m.organization_id = new.organization_id
       and m.user_id = new.user_id
       and m.status = 'active'
  ) then
    raise exception 'the person is not an active member of this organization';
  end if;
  return new;
end;
$$;

comment on function core.check_cost_rate_member() is
  'Refuses a cost rate for a person who is not an active member of the row''s organization — the tenant check for a user_id, which core.users cannot carry.';

drop trigger if exists member_cost_rates_check_member on core.member_cost_rates;
create trigger member_cost_rates_check_member
  before insert or update of user_id, organization_id on core.member_cost_rates
  for each row execute function core.check_cost_rate_member();

-- Only the door inserts. The door marks the transaction with the user_id it
-- is setting a rate for; any insert without that mark is refused by name.
create or replace function core.member_cost_rates_only_through_door()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(current_setting('core.cost_rate_door', true), '') <> new.user_id::text then
    raise exception 'a cost rate is set through core.set_member_cost_rate, not written directly';
  end if;
  return new;
end;
$$;

comment on function core.member_cost_rates_only_through_door() is
  'Refuses an insert into core.member_cost_rates that core.set_member_cost_rate did not mark for this transaction, so every rate has an audit row.';

drop trigger if exists member_cost_rates_only_through_door on core.member_cost_rates;
create trigger member_cost_rates_only_through_door
  before insert on core.member_cost_rates
  for each row execute function core.member_cost_rates_only_through_door();

drop trigger if exists freeze_org_member_cost_rates on core.member_cost_rates;
create trigger freeze_org_member_cost_rates
  before update of organization_id on core.member_cost_rates
  for each row execute function core.freeze_organization_id();

-- ── 2. The door ───────────────────────────────────────────────────────────

create or replace function core.set_member_cost_rate(
  p_user_id           uuid,
  p_hourly_cost_minor bigint,
  p_effective_from    date,
  p_note              text default null
)
returns table (
  -- 'set'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_a_member' | 'bad_rate' | 'bad_date'
  outcome text,
  rate_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_after  jsonb;
  v_id     uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  if p_hourly_cost_minor is null or p_hourly_cost_minor <= 0 then
    return query select 'bad_rate'::text, null::uuid; return;
  end if;

  if p_effective_from is null then
    return query select 'bad_date'::text, null::uuid; return;
  end if;

  if not exists (
    select 1 from core.memberships m
     where m.organization_id = v_org and m.user_id = p_user_id and m.status = 'active'
  ) then
    return query select 'not_a_member'::text, null::uuid; return;
  end if;

  -- BEFORE is the rate that was in force on the new row's date — what the
  -- change replaces from that day on — not "the most recent row".
  select to_jsonb(c) into v_before
    from core.member_cost_rates c
   where c.organization_id = v_org
     and c.user_id = p_user_id
     and c.effective_from <= p_effective_from
   order by c.effective_from desc, c.created_at desc, c.id desc
   limit 1;

  -- Mark the transaction for the only-through-the-door trigger. Local to
  -- this transaction, so no other statement inherits the permission.
  perform set_config('core.cost_rate_door', p_user_id::text, true);

  insert into core.member_cost_rates (organization_id, user_id, hourly_cost_minor, effective_from, set_by, note)
  values (v_org, p_user_id, p_hourly_cost_minor, p_effective_from, v_actor, nullif(btrim(coalesce(p_note, '')), ''))
  returning id, to_jsonb(core.member_cost_rates.*) into v_id, v_after;

  perform set_config('core.cost_rate_door', '', true);

  perform core.record_audit(
    v_org, 'cost_rate.set', 'member_cost_rate', v_id, v_before, v_after
  );

  return query select 'set'::text, v_id;
end;
$$;

comment on function core.set_member_cost_rate(uuid, bigint, date, text) is
  'Sets a person''s hourly cost rate from a date (decision E2 of 2026-09-30). Owner only, and RLS says so again (security invoker). Appends a row — never edits one — and audits cost_rate.set with the rate that was in force on that date as before.';

revoke all on function core.set_member_cost_rate(uuid, bigint, date, text) from public, anon;
grant execute on function core.set_member_cost_rate(uuid, bigint, date, text) to authenticated;

-- ── 3. projects.time_log_costs ────────────────────────────────────────────
--
-- The rate on the DAY OF THE LOG. `logged_on`, never now(): a rate set today
-- prices today's logs and later ones; every earlier log keeps the rate that
-- covered its day, and a log before the first rate is uncosted.

create or replace view projects.time_log_costs
with (security_invoker = true) as
  select l.id,
         l.organization_id,
         l.project_id,
         l.task_id,
         l.person_id,
         l.hours,
         l.logged_on,
         l.note,
         l.created_at,
         r.hourly_cost_minor,
         r.currency                                   as rate_currency,
         r.effective_from                             as rate_effective_from,
         case when r.hourly_cost_minor is null then null
              else round(l.hours * r.hourly_cost_minor)::bigint end as cost_minor,
         (r.hourly_cost_minor is null)                as rate_missing
    from projects.time_logs l
    left join lateral (
      select c.hourly_cost_minor, c.currency, c.effective_from
        from core.member_cost_rates c
       where c.organization_id = l.organization_id
         and c.user_id = l.person_id
         and c.effective_from <= l.logged_on
       order by c.effective_from desc, c.created_at desc, c.id desc
       limit 1
    ) r on true;

comment on view projects.time_log_costs is
  'Each time log with the cost rate in force for its person on logged_on (latest effective_from <= logged_on), cost_minor = round(hours × rate), and rate_missing when no rate covers that day. security_invoker: the log''s RLS and the rate''s RLS both decide.';

grant select on projects.time_log_costs to authenticated, service_role;

-- ── 4. The totals, now with cost ──────────────────────────────────────────
--
-- Same columns in the same order as 20260930110000, then cost_minor and
-- uncosted_hours appended (create or replace view allows exactly that).
-- Uncosted hours are counted, not priced at zero.

create or replace view projects.time_log_totals_by_task
with (security_invoker = true) as
  select organization_id, project_id, task_id,
         sum(hours)::numeric(10,2) as hours,
         count(*)::integer         as entries,
         max(logged_on)            as last_logged_on,
         coalesce(sum(cost_minor), 0)::bigint                                    as cost_minor,
         coalesce(sum(hours) filter (where rate_missing), 0)::numeric(10,2)      as uncosted_hours
    from projects.time_log_costs
   group by organization_id, project_id, task_id;

create or replace view projects.time_log_totals_by_project
with (security_invoker = true) as
  select organization_id, project_id,
         sum(hours)::numeric(10,2) as hours,
         count(*)::integer         as entries,
         count(distinct person_id)::integer as people,
         max(logged_on)            as last_logged_on,
         coalesce(sum(cost_minor), 0)::bigint                                    as cost_minor,
         coalesce(sum(hours) filter (where rate_missing), 0)::numeric(10,2)      as uncosted_hours
    from projects.time_log_costs
   group by organization_id, project_id;

create or replace view projects.time_log_totals_by_person
with (security_invoker = true) as
  select organization_id, project_id, person_id,
         sum(hours)::numeric(10,2) as hours,
         count(*)::integer         as entries,
         max(logged_on)            as last_logged_on,
         coalesce(sum(cost_minor), 0)::bigint                                    as cost_minor,
         coalesce(sum(hours) filter (where rate_missing), 0)::numeric(10,2)      as uncosted_hours
    from projects.time_log_costs
   group by organization_id, project_id, person_id;

comment on view projects.time_log_totals_by_task is 'Hours logged per task, with cost_minor at each log''s day-of-log rate and uncosted_hours where no rate covered the day — a sum over projects.time_log_costs under the reader''s own RLS.';
comment on view projects.time_log_totals_by_project is 'Hours logged per project, with cost_minor at each log''s day-of-log rate and uncosted_hours where no rate covered the day — a sum over projects.time_log_costs under the reader''s own RLS.';
comment on view projects.time_log_totals_by_person is 'Hours logged per person per project, with cost_minor at each log''s day-of-log rate and uncosted_hours where no rate covered the day — a sum over projects.time_log_costs under the reader''s own RLS.';

grant select on projects.time_log_totals_by_task to authenticated, service_role;
grant select on projects.time_log_totals_by_project to authenticated, service_role;
grant select on projects.time_log_totals_by_person to authenticated, service_role;
