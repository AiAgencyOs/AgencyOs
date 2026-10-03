-- ═══════════════════════════════════════════════════════════════════════════
-- R1 / Q-OVERRIDE (owner, round 3, 2026-10-01): a person may override the
-- Hot / Warm / Cold label with a reason; the computed label is kept and the
-- override is audited.
--
-- The computed label is derived on the spot (src/modules/crm/lead-heat.ts) and
-- never stored as a verdict. The override sits BESIDE it in five columns that
-- travel together or not at all: the label the person chose, their reason, who,
-- when, and the computed label at that moment (so the history can show what was
-- overruled even after the facts move on). Written only by
-- `crm.override_lead_heat`; a direct write to the columns is refused by a
-- guard, so no write skips the audit row.
--
-- Additive and idempotent: applies twice.
-- ═══════════════════════════════════════════════════════════════════════════

alter table crm.leads
  add column if not exists heat_override          text,
  add column if not exists heat_override_reason   text,
  add column if not exists heat_override_by       uuid references core.users(id) on delete set null,
  add column if not exists heat_override_at       timestamptz,
  add column if not exists heat_override_computed text;

alter table crm.leads drop constraint if exists leads_heat_override_carries_its_reason;
alter table crm.leads add constraint leads_heat_override_carries_its_reason
  check (
    (heat_override is null and heat_override_reason is null and heat_override_by is null
       and heat_override_at is null and heat_override_computed is null)
    or (
      heat_override in ('Hot', 'Warm', 'Cold')
      and heat_override_reason is not null and char_length(btrim(heat_override_reason)) between 1 and 500
      and heat_override_by is not null
      and heat_override_at is not null
      and heat_override_computed in ('Hot', 'Warm', 'Cold')
    )
  );

comment on column crm.leads.heat_override is
  'A person''s Hot / Warm / Cold label, recorded BESIDE the computed one and never in its place (Q-OVERRIDE). Written only by crm.override_lead_heat.';
comment on column crm.leads.heat_override_computed is
  'The computed label at the moment of the override, kept so the history shows what was overruled.';

create or replace function crm.guard_heat_override_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (new.heat_override, new.heat_override_reason, new.heat_override_by, new.heat_override_at, new.heat_override_computed)
     is distinct from
     (old.heat_override, old.heat_override_reason, old.heat_override_by, old.heat_override_at, old.heat_override_computed)
     and coalesce(current_setting('crm.heat_override_write', true), '') <> 'on' then
    raise exception 'a heat override is recorded through crm.override_lead_heat, not by writing the row'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists leads_guard_heat_override on crm.leads;
create trigger leads_guard_heat_override
  before update of heat_override, heat_override_reason, heat_override_by, heat_override_at, heat_override_computed on crm.leads
  for each row execute function crm.guard_heat_override_write();

create or replace function crm.override_lead_heat(
  p_lead_id  uuid,
  p_label    text,
  p_reason   text,
  p_computed text
)
returns table (
  -- 'overridden' | 'cleared'
  -- refusals: 'no_actor' | 'forbidden' | 'not_found' | 'no_reason' | 'bad_label'
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
  v_reason text := nullif(btrim(p_reason), '');
  v_lead   crm.leads;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if v_reason is null or char_length(v_reason) > 500 then
    return query select 'no_reason'::text; return;
  end if;
  if p_label is not null and (p_label not in ('Hot', 'Warm', 'Cold') or p_computed is null or p_computed not in ('Hot', 'Warm', 'Cold')) then
    return query select 'bad_label'::text; return;
  end if;

  select * into v_lead from crm.leads l where l.id = p_lead_id and l.organization_id = v_org and l.deleted_at is null for update;
  if v_lead.id is null then
    return query select 'not_found'::text; return;
  end if;

  perform set_config('crm.heat_override_write', 'on', true);

  if p_label is null then
    update crm.leads
       set heat_override = null, heat_override_reason = null, heat_override_by = null,
           heat_override_at = null, heat_override_computed = null
     where id = p_lead_id;
    perform set_config('crm.heat_override_write', 'off', true);
    perform core.record_audit(v_org, 'lead.heat_override_cleared', 'lead', p_lead_id,
      jsonb_build_object('heat_override', v_lead.heat_override, 'reason', v_lead.heat_override_reason),
      jsonb_build_object('clearReason', v_reason));
    return query select 'cleared'::text; return;
  end if;

  update crm.leads
     set heat_override = p_label, heat_override_reason = v_reason, heat_override_by = v_actor,
         heat_override_at = now(), heat_override_computed = p_computed
   where id = p_lead_id;
  perform set_config('crm.heat_override_write', 'off', true);

  perform core.record_audit(v_org, 'lead.heat_overridden', 'lead', p_lead_id,
    jsonb_build_object('heat_override', v_lead.heat_override),
    jsonb_build_object('heat_override', p_label, 'computed', p_computed, 'reason', v_reason));

  return query select 'overridden'::text;
end;
$$;

comment on function crm.override_lead_heat(uuid, text, text, text) is
  'Q-OVERRIDE: a person''s Hot / Warm / Cold label with a reason, beside the computed one (passed in so the audit row and the row keep what was overruled). A null label clears it. Anyone who may write leads; audited lead.heat_overridden / lead.heat_override_cleared.';

revoke all on function crm.override_lead_heat(uuid, text, text, text) from public, anon;
grant execute on function crm.override_lead_heat(uuid, text, text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
