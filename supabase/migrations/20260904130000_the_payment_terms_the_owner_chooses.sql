-- ═══════════════════════════════════════════════════════════════════════════
-- The payment terms the owner chooses — G-196 (Doc 07 §11, QM-22/PR-09)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every quotation this system has ever drawn carried one of two payment
-- schedules, chosen by amount: 40/30/30 under a lakh, 30/30/25/15 at or above
-- it. Those two are not arbitrary — they are OBSERVED, ten of the corpus's
-- forty-five quotations each, and they are the only two families that ever
-- really appeared. That is why they were hard-coded, and it was the right
-- default to start from.
--
-- Doc 07 §11 asks for something else: *configurable* milestones and a minimum
-- advance. An agency that wants 50% up front from a new client, or four
-- milestones instead of three, or the word "Advance" to read "Booking amount",
-- had to change a TypeScript file and deploy.
--
-- ── what this adds, and what it deliberately does not change ──────────────
--
-- A structure is a NAME and an ordered list of milestones whose percentages
-- sum to a hundred, optionally bounded to an amount band. Configure none and
-- nothing changes at all: `paymentScheduleFor` still returns the two corpus
-- families, byte for byte, and every quotation drawn before this migration
-- renders exactly as it did.
--
-- The sum is enforced by the database rather than by the form, and DEFERRED,
-- because milestones arrive one row at a time and a schedule is only wrong
-- once it is finished. Part L of the corpus study is the reason it is
-- enforced at all: *Σ milestones = total*. A schedule that does not sum is a
-- quotation whose own numbers disagree, which is the defect class G-167 found
-- five times in forty-five real documents.
--
-- ── and the schedule is FROZEN onto the quotation ─────────────────────────
--
-- Like the production cost (G-179), the client's budget (G-193) and the
-- approver's name (G-194): what binds is what was in front of the person who
-- approved it. An owner who changes their terms in March must not change the
-- payment schedule inside a quotation a client accepted in January.

create table if not exists sales.payment_structures (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- What the owner calls it. Shown to them, never to a client: the client
  -- reads the milestones themselves.
  name             text not null check (length(btrim(name)) between 1 and 60),

  -- The band this structure is the default for, in minor units. Null on
  -- either side is open: (null, 1000000) is "under ten thousand rupees" and
  -- (null, null) is "every quotation".
  min_amount_minor bigint check (min_amount_minor is null or min_amount_minor >= 0),
  max_amount_minor bigint check (max_amount_minor is null or max_amount_minor > 0),

  active           boolean not null default true,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A band that cannot contain anything is a configuration mistake, not a
  -- structure nobody matches.
  constraint payment_structures_band_is_real
    check (min_amount_minor is null or max_amount_minor is null or min_amount_minor < max_amount_minor)
);

comment on table sales.payment_structures is
  'Doc 07 section 11''s configurable payment terms. A named, ordered set of milestones summing to 100%, optionally bounded to an amount band. NONE configured is the ordinary state and changes nothing: the two corpus families (40/30/30 and 30/30/25/15) remain the default, because they are what forty-five real quotations actually used.';

comment on column sales.payment_structures.min_amount_minor is
  'The bottom of the band this structure is the default for, inclusive. Null is open below.';

comment on column sales.payment_structures.max_amount_minor is
  'The top of the band, EXCLUSIVE - the same shape the hard-coded families use, where a quotation at exactly one lakh belongs to the larger family.';

create table if not exists sales.payment_milestones (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  structure_id     uuid not null references sales.payment_structures(id) on delete cascade,

  position         int not null check (position >= 0),

  -- What the client reads on the quotation. The corpus's own labels say what
  -- TRIGGERS the payment - "Working-core demo", "Design approval" - rather
  -- than when it falls due, because a date in a schedule is a promise about a
  -- calendar and a demo is a promise about work.
  label            text not null check (length(btrim(label)) between 1 and 120),

  -- Two decimal places, because a four-milestone split of a hundred does not
  -- always land on whole numbers and rounding the CONFIGURATION would make
  -- the sum check unsatisfiable for schedules a person can plainly write.
  pct              numeric(5,2) not null check (pct > 0 and pct <= 100),

  created_at       timestamptz not null default now(),

  unique (structure_id, position)
);

comment on table sales.payment_milestones is
  'The ordered milestones of one payment structure. Percentages sum to exactly 100, enforced by a DEFERRED constraint trigger - milestones arrive one row at a time, and a schedule is only wrong once it is finished.';

create index if not exists payment_structures_org_idx
  on sales.payment_structures (organization_id, active);
create index if not exists payment_milestones_structure_idx
  on sales.payment_milestones (structure_id, position);

-- ── the sum is a hundred, checked when the schedule is finished ────────────

create or replace function sales.payment_milestones_sum_to_a_hundred()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_structure uuid := coalesce(new.structure_id, old.structure_id);
  v_total     numeric;
  v_count     int;
begin
  select coalesce(sum(m.pct), 0), count(*)
    into v_total, v_count
    from sales.payment_milestones m
   where m.structure_id = v_structure;

  -- A structure with no milestones left is one being deleted, and deleting a
  -- structure deletes its milestones: refusing here would make a structure
  -- undeletable, which is the failure G-190 records one schema along.
  if v_count = 0 then
    return null;
  end if;

  if v_total <> 100 then
    raise exception 'a payment structure''s milestones must sum to 100 per cent, not %', v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

drop trigger if exists payment_milestones_sum on sales.payment_milestones;
create constraint trigger payment_milestones_sum
  after insert or update or delete on sales.payment_milestones
  deferrable initially deferred
  for each row execute function sales.payment_milestones_sum_to_a_hundred();

-- ── tenancy, the pair every org-scoped table in this schema carries ────────

drop trigger if exists freeze_org_payment_structures on sales.payment_structures;
create trigger freeze_org_payment_structures
  before update on sales.payment_structures
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at on sales.payment_structures;
create trigger set_updated_at
  before update on sales.payment_structures
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_payment_milestones on sales.payment_milestones;
create trigger freeze_org_payment_milestones
  before update on sales.payment_milestones
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_payment_milestones_structure_id on sales.payment_milestones;
create trigger org_match_payment_milestones_structure_id
  before insert or update on sales.payment_milestones
  for each row execute function core.enforce_parent_org('structure_id', 'sales.payment_structures');

-- ── who may read and who may write ────────────────────────────────────────

alter table sales.payment_structures enable row level security;
alter table sales.payment_milestones enable row level security;

drop policy if exists payment_structures_select on sales.payment_structures;
create policy payment_structures_select on sales.payment_structures
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

drop policy if exists payment_milestones_select on sales.payment_milestones;
create policy payment_milestones_select on sales.payment_milestones
  for select using (
    core.is_internal() and organization_id = core.current_organization_id()
  );

/**
 * Writable only through the function below, and the trigger is what makes
 * that true rather than merely intended.
 *
 * The same shape `approved_offers` uses: an owner may write, but only inside
 * the setter, which sets a transaction-local flag first. A direct PostgREST
 * write by the same owner is refused, so the audit row and the 100% rule
 * cannot be sidestepped by the person most able to sidestep them.
 */
create or replace function sales.payment_write_is_sanctioned()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('sales.payment_write', true), '') <> 'on' then
    raise exception 'payment terms are set through sales.set_payment_structure, not by writing the row'
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$$;

drop policy if exists payment_structures_write on sales.payment_structures;
create policy payment_structures_write on sales.payment_structures
  for all using (
    core.is_owner() and organization_id = core.current_organization_id()
  ) with check (
    core.is_owner() and organization_id = core.current_organization_id()
  );

drop policy if exists payment_milestones_write on sales.payment_milestones;
create policy payment_milestones_write on sales.payment_milestones
  for all using (
    core.is_owner() and organization_id = core.current_organization_id()
  ) with check (
    core.is_owner() and organization_id = core.current_organization_id()
  );

drop trigger if exists payment_structures_sanctioned on sales.payment_structures;
create trigger payment_structures_sanctioned
  before insert or update or delete on sales.payment_structures
  for each row execute function sales.payment_write_is_sanctioned();

drop trigger if exists payment_milestones_sanctioned on sales.payment_milestones;
create trigger payment_milestones_sanctioned
  before insert or update or delete on sales.payment_milestones
  for each row execute function sales.payment_write_is_sanctioned();

grant select on sales.payment_structures to authenticated, service_role;
grant select on sales.payment_milestones to authenticated, service_role;
grant insert, update, delete on sales.payment_structures to authenticated, service_role;
grant insert, update, delete on sales.payment_milestones to authenticated, service_role;

-- ── setting one ───────────────────────────────────────────────────────────

/**
 * One structure, replaced whole.
 *
 * Whole rather than edited row by row because a payment schedule is only ever
 * valid as a set: an interface that let somebody change one milestone from 30
 * to 40 would be an interface whose intermediate state is a schedule summing
 * to 110, and the deferred trigger would refuse the transaction with an error
 * about a number nobody typed.
 *
 * Named structures replace by NAME within an organization, so saving the same
 * name twice edits rather than accumulates — which is what a settings form
 * does when somebody presses Save twice.
 */
create or replace function sales.set_payment_structure(
  p_organization_id uuid,
  p_name text,
  p_milestones jsonb,
  p_min_amount_minor bigint default null,
  p_max_amount_minor bigint default null
)
returns table (outcome text, structure_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_id     uuid;
  v_total  numeric := 0;
  v_count  int;
  v_row    jsonb;
  v_pos    int := 0;
begin
  if v_actor is not null and not (select core.is_owner()) then
    return query select 'forbidden'::text, null::uuid;
    return;
  end if;

  if jsonb_typeof(p_milestones) <> 'array' then
    return query select 'invalid_milestones'::text, null::uuid;
    return;
  end if;

  select count(*) into v_count from jsonb_array_elements(p_milestones);
  if v_count < 1 or v_count > 8 then
    -- One is a real schedule — "everything up front" — and eight is past any
    -- schedule a client will read. Both bounds are here rather than in the
    -- form so a direct call cannot write a thirty-milestone document.
    return query select 'invalid_milestones'::text, null::uuid;
    return;
  end if;

  for v_row in select * from jsonb_array_elements(p_milestones) loop
    if jsonb_typeof(v_row->'pct') <> 'number'
       or coalesce(btrim(v_row->>'label'), '') = ''
       or length(btrim(v_row->>'label')) > 120
       or (v_row->>'pct')::numeric <= 0
       or (v_row->>'pct')::numeric > 100 then
      return query select 'invalid_milestones'::text, null::uuid;
      return;
    end if;
    v_total := v_total + (v_row->>'pct')::numeric;
  end loop;

  -- Reported as its own outcome rather than left to the deferred trigger: a
  -- person who typed 30/30/30 deserves to be told the total is ninety, not to
  -- be handed a constraint violation at commit.
  if v_total <> 100 then
    return query select 'does_not_sum'::text, null::uuid;
    return;
  end if;

  if p_min_amount_minor is not null and p_max_amount_minor is not null
     and p_min_amount_minor >= p_max_amount_minor then
    return query select 'invalid_band'::text, null::uuid;
    return;
  end if;

  perform set_config('sales.payment_write', 'on', true);

  select s.id into v_id
    from sales.payment_structures s
   where s.organization_id = p_organization_id and s.name = btrim(p_name);

  if v_id is null then
    insert into sales.payment_structures (
      organization_id, name, min_amount_minor, max_amount_minor, created_by
    )
    values (p_organization_id, btrim(p_name), p_min_amount_minor, p_max_amount_minor, v_actor)
    returning id into v_id;
  else
    update sales.payment_structures
       set min_amount_minor = p_min_amount_minor,
           max_amount_minor = p_max_amount_minor,
           active = true
     where id = v_id;
    -- Qualified, because this function's own OUT parameter is called
    -- `structure_id`: an unqualified reference is ambiguous and PL/pgSQL
    -- refuses it at CALL time, not at creation — so the first save worked and
    -- every later one answered 42702.
    delete from sales.payment_milestones m where m.structure_id = v_id;
  end if;

  for v_row in select * from jsonb_array_elements(p_milestones) loop
    insert into sales.payment_milestones (organization_id, structure_id, position, label, pct)
    values (p_organization_id, v_id, v_pos, btrim(v_row->>'label'), (v_row->>'pct')::numeric);
    v_pos := v_pos + 1;
  end loop;

  perform core.record_audit(
    p_organization_id, 'payment_structure.set', 'payment_structure', v_id,
    null,
    jsonb_build_object('name', btrim(p_name), 'milestones', p_milestones,
                       'min_amount_minor', p_min_amount_minor, 'max_amount_minor', p_max_amount_minor),
    null
  );

  return query select 'set'::text, v_id;
end;
$$;

comment on function sales.set_payment_structure(uuid, text, jsonb, bigint, bigint) is
  'Doc 07 section 11''s configurable payment terms, replaced whole rather than edited row by row - a schedule is only valid as a set, and an interface that let one milestone change alone would have an intermediate state summing to 110. Owner only. Refuses a set that does not sum to 100 as its own outcome, so a person who typed 30/30/30 is told the total is ninety rather than handed a constraint violation.';

/**
 * Withdrawing one. Deactivated rather than deleted, for the reason every
 * other retired thing in this schema is: the terms a client agreed to in
 * January are part of the record of what this agency offered.
 */
create or replace function sales.clear_payment_structure(
  p_organization_id uuid,
  p_name text
)
returns table (outcome text)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is not null and not (select core.is_owner()) then
    return query select 'forbidden'::text; return;
  end if;

  select s.id into v_id
    from sales.payment_structures s
   where s.organization_id = p_organization_id and s.name = btrim(p_name) and s.active;

  if v_id is null then
    return query select 'no_structure'::text; return;
  end if;

  perform set_config('sales.payment_write', 'on', true);
  update sales.payment_structures set active = false where id = v_id;

  perform core.record_audit(
    p_organization_id, 'payment_structure.withdrawn', 'payment_structure', v_id,
    jsonb_build_object('name', btrim(p_name)), null, null
  );

  return query select 'cleared'::text;
end;
$$;

revoke all on function sales.set_payment_structure(uuid, text, jsonb, bigint, bigint) from public;
revoke all on function sales.clear_payment_structure(uuid, text) from public;
grant execute on function sales.set_payment_structure(uuid, text, jsonb, bigint, bigint) to authenticated, service_role;
grant execute on function sales.clear_payment_structure(uuid, text) to authenticated, service_role;
