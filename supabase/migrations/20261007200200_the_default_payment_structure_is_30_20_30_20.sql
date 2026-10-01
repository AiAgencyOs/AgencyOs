-- X2 / decision 2 (2026-10-01): the quotation's payment schedule starts as
-- 30 / 20 / 30 / 20, tied to Phases 2, 4, 5 and 6, for every organization that
-- has not configured a structure of its own.
--
-- The free plan stays: the owner can still save any structure whose milestones
-- total 100 through `sales.set_payment_structure` (checked by the deferred
-- constraint trigger `payment_milestones_sum`), and a structure with an amount
-- band still wins over this one for a quotation inside its band, because
-- `paymentStructureFor` / the composer pick the NARROWEST matching band and this
-- default has none (open on both sides = "every quotation").
--
-- Mechanism, both through the sanctioned setter flag (`sales.payment_write`),
-- never a direct write by a user:
--   * `sales.seed_default_payment_structure(org)` inserts the one structure and
--     its four milestones, only when the organization has NO payment structure
--     row at all (active or withdrawn - a withdrawn one was somebody's choice);
--   * it runs now for every existing organization, and from an AFTER INSERT
--     trigger on core.organizations for every organization created later.
-- The labels name the phase that releases each milestone, the same four triggers
-- as src/modules/projects/payment-structure.ts (LOCKED_PAYMENT_STRUCTURE).
--
-- PRECEDENCE. The default is flagged `is_default`. Any structure the owner
-- configures that matches a quotation's amount beats the default, whatever the
-- widths of their bands (an owner's catch-all would otherwise TIE with the
-- default's open band and the winner would be arbitrary). The default applies
-- only when nothing else matches - `paymentStructureFor` and the composer both
-- read the flag.
--
-- Idempotent: the second run finds a structure and does nothing.

alter table sales.payment_structures add column if not exists is_default boolean not null default false;

comment on column sales.payment_structures.is_default is
  'Owner decision 2 (round 2): true for the seeded 30/20/30/20 structure. It applies only when no other active structure matches a quotation amount.';

-- Seeding a structure for EVERY new organization means every organization that
-- is later deleted (a fixture, an offboarded tenant) cascades into these tables,
-- and the "sanctioned write" guard would refuse the cascaded DELETE. The guard is
-- carried forward from 20260904130000 with ONE addition: a DELETE is allowed when
-- the organization it belongs to is already gone (that is the cascade, and nobody
-- can reach a row of an organization that does not exist). Every other write is
-- refused exactly as before.
create or replace function sales.payment_write_is_sanctioned()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('sales.payment_write', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from core.organizations o where o.id = old.organization_id) then
    return old;
  end if;
  raise exception 'payment terms are set through sales.set_payment_structure, not by writing the row'
    using errcode = 'restrict_violation';
end;
$$;

-- Editing the default makes it the owner's own: `sales.set_payment_structure`
-- always updates the structure row, so any update clears the flag.
create or replace function sales.payment_structure_edit_is_not_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.is_default := false;
  return new;
end;
$$;

drop trigger if exists payment_structure_edit_is_not_default on sales.payment_structures;
create trigger payment_structure_edit_is_not_default
  before update on sales.payment_structures
  for each row execute function sales.payment_structure_edit_is_not_default();

create or replace function sales.seed_default_payment_structure(p_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from sales.payment_structures s where s.organization_id = p_organization_id) then
    return false;
  end if;

  perform set_config('sales.payment_write', 'on', true);

  insert into sales.payment_structures (organization_id, name, is_default)
  values (p_organization_id, 'Standard (30/20/30/20)', true)
  returning id into v_id;

  insert into sales.payment_milestones (organization_id, structure_id, position, label, pct) values
    (p_organization_id, v_id, 0, 'Advance - Phase 2 kickoff', 30),
    (p_organization_id, v_id, 1, 'On UI prototype approval - Phase 4 complete', 20),
    (p_organization_id, v_id, 2, 'On development completion - Phase 5 complete', 30),
    (p_organization_id, v_id, 3, 'On testing completion - Phase 6 complete', 20);

  perform core.record_audit(
    p_organization_id, 'payment_structure.default_seeded', 'payment_structure', v_id,
    null,
    jsonb_build_object('name', 'Standard (30/20/30/20)', 'percentages', jsonb_build_array(30, 20, 30, 20), 'phases', jsonb_build_array(2, 4, 5, 6)),
    null
  );
  return true;
end;
$$;

comment on function sales.seed_default_payment_structure(uuid) is
  'Owner decision 2 (round 2): installs the 30/20/30/20 structure (Phases 2, 4, 5, 6) for an organization that has none. Internal: not granted to any API role.';

revoke all on function sales.seed_default_payment_structure(uuid) from public, anon, authenticated;

create or replace function sales.seed_default_payment_structure_for_new_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform sales.seed_default_payment_structure(new.id);
  return new;
end;
$$;

revoke all on function sales.seed_default_payment_structure_for_new_org() from public, anon, authenticated;

drop trigger if exists seed_default_payment_structure on core.organizations;
create trigger seed_default_payment_structure
  after insert on core.organizations
  for each row execute function sales.seed_default_payment_structure_for_new_org();

select sales.seed_default_payment_structure(o.id) from core.organizations o;

notify pgrst, 'reload schema';
