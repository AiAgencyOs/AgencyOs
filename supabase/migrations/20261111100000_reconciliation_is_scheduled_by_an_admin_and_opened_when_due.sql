-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 9B - part 1: ReconciliationDue. A bank reconciliation period is OPENED on a schedule an Admin sets; it is never closed by the schedule.
--
--   * finance.reconciliation_schedules   - cadence DATA an Admin chose (unit, count, anchor date, source, optional receiving account). There is no default
--                                          cadence: an organization that never sets one is never scheduled. One schedule per organization and account.
--   * finance.reconciliation_due_items   - the ReconciliationDue item: one row per (schedule, period). 'waiting' = the period is due but that account already
--                                          has an OPEN reconciliation (one open period per account is an existing rule), 'opened' = the reconciliation exists.
--                                          History: never deleted; the only edit is waiting -> opened.
--   * finance.reconciliation_latest_due_period - pure, immutable: the most recent period that has ENDED on or before a given day. The sweep injects the day.
--   * finance.set_reconciliation_schedule - Admin only (owner / ops_admin). finance.sweep_reconciliation_due - service role only; idempotent; it OPENS a due
--                                          period and never closes one, never touches a payment, an invoice or a statement line.
--
-- Half-open periods [start, end), UTC, like reconciliation itself. Only the LATEST ended period is opened (no back-fill of history nobody asked for).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function finance.reconciliation_latest_due_period(p_unit text, p_count integer, p_anchor date, p_today date)
returns table (period_start date, period_end date)
language plpgsql immutable set search_path = '' as $$
declare k integer; v_step interval;
begin
  if p_unit is null or p_unit not in ('day', 'week', 'month') or p_count is null or p_count < 1 or p_anchor is null or p_today is null then return; end if;
  v_step := case p_unit when 'day' then make_interval(days => p_count) when 'week' then make_interval(days => 7 * p_count) else make_interval(months => p_count) end;
  if p_unit = 'month' then
    k := ((extract(year from age(p_today, p_anchor)) * 12 + extract(month from age(p_today, p_anchor)))::integer) / p_count;
    while (p_anchor + (k + 1) * v_step)::date <= p_today loop k := k + 1; end loop;
    while k > 0 and (p_anchor + k * v_step)::date > p_today loop k := k - 1; end loop;
  else
    if p_today < p_anchor then return; end if;
    k := (p_today - p_anchor) / (p_count * case p_unit when 'week' then 7 else 1 end);
  end if;
  -- period k-1 ended on the boundary anchor + k*step; before the first boundary nothing has ended
  if k < 1 then return; end if;
  return query select (p_anchor + (k - 1) * v_step)::date, (p_anchor + k * v_step)::date;
end $$;
revoke all on function finance.reconciliation_latest_due_period(text, integer, date, date) from public, anon;
grant execute on function finance.reconciliation_latest_due_period(text, integer, date, date) to authenticated, service_role;

create table if not exists finance.reconciliation_schedules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  account_id      uuid references finance.payment_accounts(id) on delete restrict,
  cadence_unit    text not null check (cadence_unit in ('day', 'week', 'month')),
  cadence_count   integer not null check (cadence_count between 1 and 366),
  anchor_date     date not null,
  source          text not null check (length(btrim(source)) between 1 and 200),
  enabled         boolean not null default true,
  set_by          uuid not null references core.users(id) on delete restrict,
  set_at          timestamptz not null default clock_timestamp(),
  check (cadence_unit <> 'month' or cadence_count <= 24)
);
create unique index if not exists reconciliation_schedules_one_per_account
  on finance.reconciliation_schedules (organization_id, coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists finance.reconciliation_due_items (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  schedule_id       uuid not null references finance.reconciliation_schedules(id) on delete restrict,
  period_start      date not null,
  period_end        date not null,
  state             text not null default 'waiting' check (state in ('waiting', 'opened')),
  reconciliation_id uuid references finance.reconciliations(id) on delete restrict,
  created_at        timestamptz not null default clock_timestamp(),
  opened_at         timestamptz,
  check (period_end > period_start),
  check ((state = 'opened') = (reconciliation_id is not null and opened_at is not null)),
  unique (schedule_id, period_start)
);

create or replace function finance.reconciliation_due_items_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a reconciliation-due item is history and is never deleted' using errcode = 'restrict_violation'; end if;
  if old.state = 'opened' then raise exception 'an opened reconciliation-due item is history and is never edited' using errcode = 'restrict_violation'; end if;
  if (new.id, new.organization_id, new.schedule_id, new.period_start, new.period_end, new.created_at) is distinct from (old.id, old.organization_id, old.schedule_id, old.period_start, old.period_end, old.created_at)
     or new.state <> 'opened' then
    raise exception 'a waiting reconciliation-due item may only become opened' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists reconciliation_due_items_guard on finance.reconciliation_due_items;
create trigger reconciliation_due_items_guard before update or delete on finance.reconciliation_due_items for each row execute function finance.reconciliation_due_items_guard();

do $$
declare r record;
begin
  for r in select * from (values
    ('reconciliation_schedules', 'account_id', 'finance.payment_accounts'),
    ('reconciliation_due_items', 'schedule_id', 'finance.reconciliation_schedules'), ('reconciliation_due_items', 'reconciliation_id', 'finance.reconciliations')
  ) as t(tbl, col, parent) loop
    execute format('drop trigger if exists %I on finance.%I', 'org_match_' || r.tbl || '_' || r.col, r.tbl);
    execute format('create trigger %I before insert or update of %I, organization_id on finance.%I for each row execute function core.enforce_parent_org(%L, %L)', 'org_match_' || r.tbl || '_' || r.col, r.col, r.tbl, r.col, r.parent);
  end loop;
  for r in select unnest(array['reconciliation_schedules', 'reconciliation_due_items']) as tbl loop
    execute format('alter table finance.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on finance.%I', r.tbl || '_select', r.tbl);
    execute format($p$create policy %I on finance.%I for select to authenticated using (organization_id = (select core.current_organization_id()) and ((select core.is_admin()) or (select core.is_finance())))$p$, r.tbl || '_select', r.tbl);
    execute format('revoke all on finance.%I from public, anon', r.tbl);
    execute format('revoke insert, update, delete on finance.%I from authenticated', r.tbl);
    execute format('grant select on finance.%I to authenticated', r.tbl);
    execute format('grant all on finance.%I to service_role', r.tbl);
    execute format('drop trigger if exists %I on finance.%I', 'freeze_org_' || r.tbl, r.tbl);
    execute format('create trigger %I before update of organization_id on finance.%I for each row execute function core.freeze_organization_id()', 'freeze_org_' || r.tbl, r.tbl);
  end loop;
end $$;

-- ── an Admin sets (or switches off) the cadence; nobody else, and the runner never ──
create or replace function finance.set_reconciliation_schedule(p_account_id uuid, p_cadence_unit text, p_cadence_count integer, p_anchor_date date, p_source text, p_enabled boolean default true)
returns table (outcome text, schedule_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_kind text := finance.phase9_caller_kind(); v_actor uuid := (select auth.uid()); v_org uuid := (select core.current_organization_id()); v_id uuid; v_existing uuid;
begin
  if v_kind <> 'admin' or v_org is null then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_cadence_unit is null or p_cadence_unit not in ('day', 'week', 'month') or p_cadence_count is null or p_cadence_count < 1
     or p_cadence_count > (select (case p_cadence_unit when 'month' then 24 else 366 end)) or p_anchor_date is null or p_enabled is null then
    return query select 'bad_cadence'::text, null::uuid; return;
  end if;
  if p_source is null or length(btrim(p_source)) = 0 or length(p_source) > 200 or finance.phase9_has_secret(p_source) then return query select 'bad_input'::text, null::uuid; return; end if;
  if p_account_id is not null and not exists (select 1 from finance.payment_accounts a where a.id = p_account_id and a.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;

  perform pg_advisory_xact_lock(hashtextextended('finance.reconciliation_schedule:' || v_org::text, 0));
  select s.id into v_existing from finance.reconciliation_schedules s
   where s.organization_id = v_org and coalesce(s.account_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_account_id, '00000000-0000-0000-0000-000000000000'::uuid);
  if v_existing is null then
    insert into finance.reconciliation_schedules (organization_id, account_id, cadence_unit, cadence_count, anchor_date, source, enabled, set_by)
    values (v_org, p_account_id, p_cadence_unit, p_cadence_count, p_anchor_date, btrim(p_source), p_enabled, v_actor) returning id into v_id;
    perform core.record_audit(v_org, 'finance.reconciliation_schedule_set', 'reconciliation_schedule', v_id, null, jsonb_build_object('unit', p_cadence_unit, 'count', p_cadence_count, 'anchor', p_anchor_date, 'enabled', p_enabled));
    return query select 'set'::text, v_id; return;
  end if;
  update finance.reconciliation_schedules set cadence_unit = p_cadence_unit, cadence_count = p_cadence_count, anchor_date = p_anchor_date, source = btrim(p_source), enabled = p_enabled, set_by = v_actor, set_at = clock_timestamp()
   where id = v_existing;
  perform core.record_audit(v_org, 'finance.reconciliation_schedule_changed', 'reconciliation_schedule', v_existing, null, jsonb_build_object('unit', p_cadence_unit, 'count', p_cadence_count, 'anchor', p_anchor_date, 'enabled', p_enabled));
  return query select 'updated'::text, v_existing;
end $$;
revoke all on function finance.set_reconciliation_schedule(uuid, text, integer, date, text, boolean) from public, anon;
grant execute on function finance.set_reconciliation_schedule(uuid, text, integer, date, text, boolean) to authenticated;

-- ── the runner: record what is due and OPEN it (idempotent; never closes; the day is injected) ──
create or replace function finance.sweep_reconciliation_due(p_limit integer default 100, p_today date default null)
returns table (due_recorded integer, opened integer, waiting integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'UTC')::date); v_due int := 0; v_open int := 0; v_wait int := 0;
  s record; v_p record; v_item uuid; v_rec uuid; v_new boolean; r record;
begin
  if (select auth.uid()) is not null or coalesce((select auth.role()), '') <> 'service_role' then return query select 0, 0, 0; return; end if;

  for s in select * from finance.reconciliation_schedules x where x.enabled order by x.set_at limit greatest(p_limit, 1) loop
    select * into v_p from finance.reconciliation_latest_due_period(s.cadence_unit, s.cadence_count, s.anchor_date, v_today);
    if v_p.period_start is null then continue; end if;
    insert into finance.reconciliation_due_items (organization_id, schedule_id, period_start, period_end)
    values (s.organization_id, s.id, v_p.period_start, v_p.period_end) on conflict (schedule_id, period_start) do nothing returning id into v_item;
    if v_item is not null then v_due := v_due + 1; end if;
    v_item := null;
  end loop;

  -- every waiting item of an enabled schedule tries to open its period; one open period per account is an existing rule, so a busy account keeps it waiting
  for r in select i.id as item_id, i.organization_id, i.period_start, i.period_end, sc.account_id, sc.source, sc.id as schedule_id
             from finance.reconciliation_due_items i join finance.reconciliation_schedules sc on sc.id = i.schedule_id
            where i.state = 'waiting' and sc.enabled order by i.period_start, i.created_at limit greatest(p_limit, 1) loop
    v_rec := null;
    begin
      insert into finance.reconciliations (organization_id, period_start, period_end, account_id, source, opened_by)
      values (r.organization_id, r.period_start, r.period_end, r.account_id, r.source, null) returning id into v_rec;
    exception when unique_violation then v_rec := null;
    end;
    if v_rec is null then v_wait := v_wait + 1; continue; end if;
    update finance.reconciliation_due_items set state = 'opened', reconciliation_id = v_rec, opened_at = clock_timestamp() where id = r.item_id;
    perform core.record_audit(r.organization_id, 'reconciliation.opened_when_due', 'reconciliation', v_rec, null,
      jsonb_build_object('periodStart', r.period_start, 'periodEnd', r.period_end, 'scheduleId', r.schedule_id, 'dueItemId', r.item_id));
    v_open := v_open + 1;
  end loop;
  return query select v_due, v_open, v_wait;
end $$;
revoke all on function finance.sweep_reconciliation_due(integer, date) from public, anon, authenticated;
grant execute on function finance.sweep_reconciliation_due(integer, date) to service_role;

notify pgrst, 'reload schema';
