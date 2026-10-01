-- ═══════════════════════════════════════════════════════════════════════════
-- R1 / Q-BAND (owner, round 3, 2026-10-01): budget bands are owner-editable (an
-- organization setting); a lead's budget shows in its band; the figure and "Not
-- recorded" stay.
--
-- One row per organization holds the bands as an ordered list of
-- {label, minMinor}: a band starts at its minMinor (paise) and runs up to the
-- next band's start; the last is open-ended; the first starts at 0 so every
-- recorded budget falls in exactly one band. No row means the application's
-- starting bands apply (src/modules/crm/budget-bands.ts).
--
-- No write grant for authenticated: `crm.set_budget_bands` is the only door
-- (owner / ops admin, audited). An empty list clears the setting back to the
-- starting bands.
--
-- Additive and idempotent: applies twice.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists crm.budget_bands (
  organization_id uuid primary key references core.organizations(id) on delete cascade,
  bands           jsonb not null,
  updated_by      uuid references core.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  constraint budget_bands_is_a_short_array check (jsonb_typeof(bands) = 'array' and jsonb_array_length(bands) between 1 and 12)
);

comment on table crm.budget_bands is
  'Q-BAND: the organization''s lead budget bands, ordered {label, minMinor}. Written only by crm.set_budget_bands.';

alter table crm.budget_bands enable row level security;
alter table crm.budget_bands force row level security;

drop policy if exists budget_bands_select on crm.budget_bands;
create policy budget_bands_select on crm.budget_bands
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on table crm.budget_bands from public, anon, authenticated;
grant select on table crm.budget_bands to authenticated;
grant select, insert, update, delete on table crm.budget_bands to service_role;

drop trigger if exists freeze_org_budget_bands on crm.budget_bands;
create trigger freeze_org_budget_bands
  before update of organization_id on crm.budget_bands
  for each row execute function core.freeze_organization_id();

create or replace function crm.set_budget_bands(p_bands jsonb)
returns table (
  -- 'set' | 'cleared'
  -- refusals: 'no_actor' | 'forbidden' | 'invalid_bands'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_before jsonb;
  v_band   jsonb;
  v_prev   numeric := null;
  v_min    numeric;
  v_labels text[] := '{}';
  v_label  text;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if p_bands is null or jsonb_typeof(p_bands) <> 'array' or jsonb_array_length(p_bands) > 12 then
    return query select 'invalid_bands'::text; return;
  end if;

  select b.bands into v_before from crm.budget_bands b where b.organization_id = v_org;

  if jsonb_array_length(p_bands) = 0 then
    delete from crm.budget_bands where organization_id = v_org;
    perform core.record_audit(v_org, 'lead_budget_bands.cleared', 'organization', v_org, jsonb_build_object('bands', v_before), null);
    return query select 'cleared'::text; return;
  end if;

  for v_band in select * from jsonb_array_elements(p_bands) loop
    v_label := btrim(coalesce(v_band ->> 'label', ''));
    if jsonb_typeof(v_band) <> 'object'
       or char_length(v_label) not between 1 and 40
       or (v_band ->> 'minMinor') is null
       or (v_band ->> 'minMinor') !~ '^[0-9]{1,15}$'
       or lower(v_label) = any (v_labels) then
      return query select 'invalid_bands'::text; return;
    end if;
    v_min := (v_band ->> 'minMinor')::numeric;
    -- the first band starts at zero; every later one starts strictly higher
    if (v_prev is null and v_min <> 0) or (v_prev is not null and v_min <= v_prev) then
      return query select 'invalid_bands'::text; return;
    end if;
    v_prev := v_min;
    v_labels := array_append(v_labels, lower(v_label));
  end loop;

  insert into crm.budget_bands (organization_id, bands, updated_by, updated_at)
  values (v_org, p_bands, v_actor, now())
  on conflict (organization_id) do update
    set bands = excluded.bands, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  perform core.record_audit(v_org, 'lead_budget_bands.updated', 'organization', v_org,
    case when v_before is null then null else jsonb_build_object('bands', v_before) end,
    jsonb_build_object('bands', p_bands));

  return query select 'set'::text;
end;
$$;

comment on function crm.set_budget_bands(jsonb) is
  'Q-BAND: sets the organization''s lead budget bands (owner / ops admin, audited). An empty list clears them to the starting bands.';

revoke all on function crm.set_budget_bands(jsonb) from public, anon;
grant execute on function crm.set_budget_bands(jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
