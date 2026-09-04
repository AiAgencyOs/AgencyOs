-- ═══════════════════════════════════════════════════════════════════════════
-- A charge nobody wrote down — G-207 (audit QM-20)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- G-178 thought hard about third-party services and got the important half
-- right: `whoPays` is an enum, because whose bill it is causes the argument,
-- and there is no numeric price field, because *"a figure printed inside a
-- fixed-price quotation becomes a commitment the agency cannot keep and did
-- not make."*
--
-- What it left is the other half. `charge` is FREE TEXT the model writes, and
-- `quotation-standards.ts` prints it verbatim into a client-facing document:
--
--     Razorpay — payment collection. Billed to you directly by the provider,
--     and not part of this price. 2% per transaction
--
-- That two per cent came from a language model. Not from the client, not from
-- Razorpay, not from anybody at this agency. It is the one number in the whole
-- quotation with no row behind it, in a system whose central rule is that
-- every price belongs to somebody who wrote it down — `crm.refuse_unread_price`
-- refuses exactly this at the row for a WhatsApp message, and the quotation
-- had no equivalent.
--
-- ── the shape, and it is ADM-12's ─────────────────────────────────────────
--
-- Business rules §5.3 solved this once already for samples and demos: *"only
-- from a list the Admin maintains… the list is empty until the Admin fills
-- it."* The same answer fits, for the same reason — an agent may repeat what
-- a person recorded and may not invent the thing itself.
--
-- Empty list means NO CHARGES PRINTED AT ALL, which is not a degraded mode:
-- G-178 already calls that *"the honest answer and the common one"*. Naming
-- the service and saying whose bill it is has always been the load-bearing
-- part.
--
-- ── and `checked_on`, which is what QM-20 actually asked for ──────────────
--
-- The finding says *current and reliable*, not merely *recorded*. A gateway's
-- percentage moves. So a charge carries the date somebody last confirmed it,
-- and a stale one warns the APPROVER rather than blocking the draft — the
-- same posture G-168 took about price and G-177 about the timeline. Blocking
-- would mean a quotation cannot be drafted because somebody did not revisit a
-- fee page, which trades a real deal for a tidy record.

create table if not exists crm.third_party_charges (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- What the service is called, as it will appear in the quotation.
  service          text not null check (length(btrim(service)) between 2 and 60),

  -- The Admin's own words, and deliberately text rather than a number: real
  -- charges are "2% + ₹3 per transaction" and "₹8,300 a year, billed by
  -- Apple", which no numeric column can hold without losing what it means.
  charge           text not null check (length(btrim(charge)) between 2 and 160),

  -- Where they got it. Provenance, on the same principle `ai.memory_records`
  -- applies to a claim: a fee with no source is a fee somebody remembers.
  source           text check (source is null or length(btrim(source)) between 2 and 300),

  -- The date somebody last confirmed it against that source. QM-20 asks for
  -- CURRENT, and a list with no dates is a list that silently ages.
  checked_on       date not null default current_date,

  active           boolean not null default true,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table crm.third_party_charges is
  'The third-party fees AgencyOS may print in a quotation, and the only ones - ADM-12''s shape (business rules 5.3) applied to money instead of samples. Empty until the Admin fills it, and an empty list means no charges are printed at all, which G-178 already calls the honest and common answer. Before this, the figure in "2% per transaction" came from a language model and was the one number in the quotation with no row behind it.';

comment on column crm.third_party_charges.charge is
  'The Admin''s own words. Text rather than a number because real charges are "2% + rupees 3 per transaction" and "rupees 8,300 a year, billed by Apple", which no numeric column holds without losing what it means.';

comment on column crm.third_party_charges.checked_on is
  'When somebody last confirmed this against its source. QM-20 asks for CURRENT and reliable, not merely recorded - a gateway''s percentage moves. A stale charge warns the approver and never blocks the draft.';

-- One row per service per organization. Case-insensitive, because "Razorpay"
-- and "razorpay" are one service and two rows would make the resolver choose.
create unique index if not exists third_party_charges_service_key
  on crm.third_party_charges (organization_id, lower(btrim(service)));

create index if not exists third_party_charges_org_idx
  on crm.third_party_charges (organization_id, active);

drop trigger if exists freeze_org_third_party_charges on crm.third_party_charges;
create trigger freeze_org_third_party_charges
  before update on crm.third_party_charges
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on crm.third_party_charges;
create trigger set_updated_at
  before update on crm.third_party_charges
  for each row execute function core.set_updated_at();

alter table crm.third_party_charges enable row level security;

drop policy if exists third_party_charges_select on crm.third_party_charges;
create policy third_party_charges_select on crm.third_party_charges
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

/**
 * Written only through the function below.
 *
 * The same shape `sales.payment_structures` and `sales.approved_offers` use,
 * and for the same reason: a policy without the guard is a direct-write
 * forgery surface, where the person most trusted to maintain the list is also
 * the one who can write a row nobody recorded deciding.
 */
create or replace function crm.charge_write_is_sanctioned()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('crm.charge_write', true), '') <> 'on' then
    raise exception 'third-party charges are set through crm.set_third_party_charge, not by writing the row'
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop policy if exists third_party_charges_write on crm.third_party_charges;
create policy third_party_charges_write on crm.third_party_charges
  for all using (
    core.is_admin() and organization_id = core.current_organization_id()
  ) with check (
    core.is_admin() and organization_id = core.current_organization_id()
  );

drop trigger if exists third_party_charges_sanctioned on crm.third_party_charges;
create trigger third_party_charges_sanctioned
  before insert or update or delete on crm.third_party_charges
  for each row execute function crm.charge_write_is_sanctioned();

grant select on crm.third_party_charges to authenticated, service_role;
grant insert, update, delete on crm.third_party_charges to authenticated, service_role;

-- ── maintaining the list ──────────────────────────────────────────────────

create or replace function crm.set_third_party_charge(
  p_organization_id uuid,
  p_service text,
  p_charge text,
  p_source text default null,
  p_checked_on date default null
)
returns table (outcome text, charge_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id    uuid;
  v_when  date := coalesce(p_checked_on, current_date);
begin
  if v_actor is not null and not (select core.is_admin()) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  if coalesce(btrim(p_service), '') = '' or coalesce(btrim(p_charge), '') = '' then
    return query select 'incomplete'::text, null::uuid;
    return;
  end if;

  -- A date in the future is somebody confirming a fee they have not seen yet,
  -- which is the one input that makes the staleness warning lie.
  if v_when > current_date then
    return query select 'not_yet'::text, null::uuid;
    return;
  end if;

  perform set_config('crm.charge_write', 'on', true);

  select c.id into v_id
    from crm.third_party_charges c
   where c.organization_id = p_organization_id
     and lower(btrim(c.service)) = lower(btrim(p_service));

  if v_id is null then
    insert into crm.third_party_charges (
      organization_id, service, charge, source, checked_on, created_by
    )
    values (p_organization_id, btrim(p_service), btrim(p_charge), nullif(btrim(p_source), ''), v_when, v_actor)
    returning crm.third_party_charges.id into v_id;
  else
    update crm.third_party_charges c
       set charge = btrim(p_charge),
           source = nullif(btrim(p_source), ''),
           checked_on = v_when,
           active = true
     where c.id = v_id;
  end if;

  perform core.record_audit(
    p_organization_id, 'third_party_charge.set', 'third_party_charge', v_id,
    null,
    jsonb_build_object('service', btrim(p_service), 'charge', btrim(p_charge), 'checkedOn', v_when),
    null
  );

  return query select 'set'::text, v_id;
end;
$$;

create or replace function crm.clear_third_party_charge(
  p_organization_id uuid,
  p_service text
)
returns table (outcome text)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not (select core.is_admin()) then
    return query select 'forbidden'::text; return;
  end if;

  select c.id into v_id
    from crm.third_party_charges c
   where c.organization_id = p_organization_id
     and lower(btrim(c.service)) = lower(btrim(p_service))
     and c.active;

  if v_id is null then
    return query select 'no_charge'::text; return;
  end if;

  -- Retired rather than deleted, so a quotation already sent still points at
  -- something. The same reason `crm.portfolio_items.is_active` exists.
  perform set_config('crm.charge_write', 'on', true);
  update crm.third_party_charges set active = false where id = v_id;

  perform core.record_audit(
    p_organization_id, 'third_party_charge.withdrawn', 'third_party_charge', v_id,
    jsonb_build_object('service', btrim(p_service)), null, null
  );

  return query select 'cleared'::text;
end;
$$;

revoke all on function crm.set_third_party_charge(uuid, text, text, text, date) from public;
revoke all on function crm.clear_third_party_charge(uuid, text) from public;
grant execute on function crm.set_third_party_charge(uuid, text, text, text, date) to authenticated, service_role;
grant execute on function crm.clear_third_party_charge(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
