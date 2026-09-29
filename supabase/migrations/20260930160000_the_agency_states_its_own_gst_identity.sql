-- ═══════════════════════════════════════════════════════════════════════════
-- The agency states its own GST identity — bucket E5 (owner decision
-- 2026-09-30: GSTR-1 / GSTR-3B exports, no filing API).
--
-- Finance › GST & tax (SCR-056) reports the register and exports a CSV, and
-- has said all along that it "generates no return". The owner has asked for
-- the two return files the GST portal's offline tool accepts. Those files
-- need four facts the schema never held, because until now nothing had to
-- state who the SUPPLIER is or WHERE a supply was made:
--
--   1. the agency's own GSTIN and the state it is registered in
--      (core.organizations.gstin, gst_state_code) — the file's header and
--      the intra/inter-state decision on every line;
--   2. the agency's default SAC (core.organizations.default_sac) — the HSN
--      summary table classifies every line, and IT services are one code;
--   3. the place of supply per invoice as a CODE, not a name
--      (finance.billing_profiles.billing_state_code) — the profile holds the
--      state as free text; the return needs the GSTN's two digits.
--
-- The intra/inter split (same state code → CGST+SGST halves, else IGST) and
-- the B2B/B2C split (recipient GSTIN present or not) are DERIVED in code
-- (src/modules/finance/gstr.ts), never stored.
--
-- What is NOT done here, on purpose: no state code is guessed. The backfill
-- below fills billing_state_code only where the free text IS a state name
-- the GSTN lists (or one of its well-known former names); everything else
-- stays null and the export lists that invoice under "unresolved" with
-- where to fix it, rather than filing a place of supply nobody stated.
--
-- Deviation from the plan's "the four columns, the door, and nothing else",
-- stated: finance.record_billing_details and finance.confirm_billing_mode
-- write NEW profile versions carrying billing_state as text and know nothing
-- of the code column. Without the small before-insert trigger at §4 every
-- profile written after this migration would stay unresolved forever. The
-- trigger applies the same name→code map the backfill uses, and only when
-- the code is null; it invents nothing a person did not type.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the supplier's identity ──────────────────────────────────────────────

alter table core.organizations
  add column if not exists gstin text;

alter table core.organizations
  add column if not exists gst_state_code text;

alter table core.organizations
  add column if not exists default_sac text;

-- The same shape check finance.billing_profiles.gstin carries; the GSTN check
-- character is verified in src/modules/finance/gstin.ts (arithmetic, not a
-- CHECK's job).
alter table core.organizations drop constraint if exists organizations_gstin_shape;
alter table core.organizations add constraint organizations_gstin_shape
  check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$');

alter table core.organizations drop constraint if exists organizations_gst_state_code_shape;
alter table core.organizations add constraint organizations_gst_state_code_shape
  check (gst_state_code is null or gst_state_code ~ '^[0-9]{2}$');

-- A GSTIN begins with the registration state. Holding the two apart would let
-- the header say one state and every line be split against another.
alter table core.organizations drop constraint if exists organizations_gstin_names_its_state;
alter table core.organizations add constraint organizations_gstin_names_its_state
  check (gstin is null or gst_state_code is null or left(gstin, 2) = gst_state_code);

-- SAC/HSN codes are 4 to 8 digits. No default: 998314 (IT design and
-- development services) is what the Settings form SUGGESTS, and a
-- classification the owner has not confirmed is not one the return should
-- carry (see 20260920040000_a_default_is_not_a_decision.sql).
alter table core.organizations drop constraint if exists organizations_default_sac_shape;
alter table core.organizations add constraint organizations_default_sac_shape
  check (default_sac is null or default_sac ~ '^[0-9]{4,8}$');

comment on column core.organizations.gstin is
  'Settings › Finance › GST identity: the agency''s OWN GSTIN, the supplier on every GST invoice and the header of GSTR-1/3B. Shape-checked here, check character verified in code. Null until the owner states it; the exports refuse until then.';
comment on column core.organizations.gst_state_code is
  'Settings › Finance › GST identity: the two-digit GSTN state code the agency is registered in (= the first two characters of its GSTIN). Decides intra-state (CGST+SGST) vs inter-state (IGST) on every exported line.';
comment on column core.organizations.default_sac is
  'Settings › Finance › GST identity: the SAC every invoice line is classified under in the GSTR-1 HSN summary until a per-line code exists. 998314 is IT services; suggested, never defaulted.';

-- ── 2. the owner-only, audited door ────────────────────────────────────────

-- Mirrors core.set_invoice_reminder_policy: SECURITY INVOKER, so
-- organizations_update (owner, own org) decides again in RLS; the function
-- re-checks in-DB and audits old and new in the same transaction. Owner
-- ONLY — a registration number is the agency's legal identity on every
-- return it files, not an operational switch.
create or replace function core.set_gst_identity(
  p_organization_id uuid,
  p_gstin           text,
  p_state_code      text,
  p_default_sac     text
)
returns table (outcome text)
-- 'set' | 'forbidden' | 'not_found' | 'invalid_gstin' | 'invalid_state_code'
-- | 'state_mismatch' | 'invalid_sac'
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_before core.organizations;
  v_gstin  text := nullif(upper(regexp_replace(coalesce(p_gstin, ''), '\s', '', 'g')), '');
  v_state  text := nullif(btrim(coalesce(p_state_code, '')), '');
  v_sac    text := nullif(btrim(coalesce(p_default_sac, '')), '');
begin
  if v_actor is not null and not coalesce((select core.is_owner()), false) then
    return query select 'forbidden'::text; return;
  end if;
  if v_actor is not null and p_organization_id is distinct from (select core.current_organization_id()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$' then
    return query select 'invalid_gstin'::text; return;
  end if;
  -- The state follows the GSTIN when one is given and no state was typed.
  if v_state is null and v_gstin is not null then
    v_state := left(v_gstin, 2);
  end if;
  if v_state is not null and v_state !~ '^[0-9]{2}$' then
    return query select 'invalid_state_code'::text; return;
  end if;
  if v_gstin is not null and v_state is not null and left(v_gstin, 2) <> v_state then
    return query select 'state_mismatch'::text; return;
  end if;
  if v_sac is not null and v_sac !~ '^[0-9]{4,8}$' then
    return query select 'invalid_sac'::text; return;
  end if;

  select * into v_before from core.organizations o where o.id = p_organization_id for update;
  if v_before.id is null then
    return query select 'not_found'::text; return;
  end if;

  update core.organizations
     set gstin = v_gstin,
         gst_state_code = v_state,
         default_sac = v_sac
   where id = p_organization_id;

  perform core.record_audit(
    p_organization_id,
    'organization.gst_identity_set',
    'organization', p_organization_id,
    jsonb_build_object('gstin', v_before.gstin, 'gst_state_code', v_before.gst_state_code, 'default_sac', v_before.default_sac),
    jsonb_build_object('gstin', v_gstin, 'gst_state_code', v_state, 'default_sac', v_sac),
    null
  );

  return query select 'set'::text;
end;
$$;

comment on function core.set_gst_identity(uuid, text, text, text) is
  'Settings › Finance › GST identity: sets the agency''s own GSTIN, registration state code and default SAC. Owner only (core.is_owner) and pinned to the caller''s org in the database as well as the service; SECURITY INVOKER so organizations_update decides again. Audited with the old and new values. Empty strings clear a field; the exports refuse while the identity is incomplete.';

revoke all on function core.set_gst_identity(uuid, text, text, text) from public, anon;
grant execute on function core.set_gst_identity(uuid, text, text, text) to authenticated, service_role;

-- ── 3. the place of supply, as the GSTN's code ─────────────────────────────

alter table finance.billing_profiles
  add column if not exists billing_state_code text;

alter table finance.billing_profiles drop constraint if exists billing_profiles_state_code_shape;
alter table finance.billing_profiles add constraint billing_profiles_state_code_shape
  check (billing_state_code is null or billing_state_code ~ '^[0-9]{2}$');

comment on column finance.billing_profiles.billing_state_code is
  'The GSTN two-digit code for billing_state, the place of supply on a GSTR-1 line. Filled from the state NAME when it is one the GSTN lists (finance.indian_state_code), else null — the export then lists the invoice as unresolved rather than guessing. Mirrored in src/modules/finance/gst-states.ts; a test keeps the two maps equal.';

-- The GSTN state-code list (01–38, plus 97 other territory). Names are
-- matched after lower-casing, turning "&" into "and" and dropping everything
-- but letters, so "Jammu & Kashmir", "jammu and kashmir" and "Jammu-Kashmir"
-- all resolve. Former names people still write (Orissa, Pondicherry,
-- Uttaranchal) map to the current code;
-- Daman & Diu and Dadra & Nagar Haveli both map to their merged code 26, and
-- Andhra Pradesh to its post-bifurcation code 37. Anything else is null.
create or replace function finance.indian_state_code(p_name text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select code from (values
    ('jammuandkashmir', '01'),
    ('himachalpradesh', '02'),
    ('punjab', '03'),
    ('chandigarh', '04'),
    ('uttarakhand', '05'),
    ('uttaranchal', '05'),
    ('haryana', '06'),
    ('delhi', '07'),
    ('newdelhi', '07'),
    ('nctofdelhi', '07'),
    ('rajasthan', '08'),
    ('uttarpradesh', '09'),
    ('bihar', '10'),
    ('sikkim', '11'),
    ('arunachalpradesh', '12'),
    ('nagaland', '13'),
    ('manipur', '14'),
    ('mizoram', '15'),
    ('tripura', '16'),
    ('meghalaya', '17'),
    ('assam', '18'),
    ('westbengal', '19'),
    ('jharkhand', '20'),
    ('odisha', '21'),
    ('orissa', '21'),
    ('chhattisgarh', '22'),
    ('chattisgarh', '22'),
    ('madhyapradesh', '23'),
    ('gujarat', '24'),
    ('dadraandnagarhavelianddamananddiu', '26'),
    ('damananddiu', '26'),
    ('dadraandnagarhaveli', '26'),
    ('maharashtra', '27'),
    ('karnataka', '29'),
    ('goa', '30'),
    ('lakshadweep', '31'),
    ('kerala', '32'),
    ('tamilnadu', '33'),
    ('puducherry', '34'),
    ('pondicherry', '34'),
    ('andamanandnicobarislands', '35'),
    ('andamanandnicobar', '35'),
    ('telangana', '36'),
    ('andhrapradesh', '37'),
    ('ladakh', '38'),
    ('otherterritory', '97')
  ) as m(name, code)
  where m.name = regexp_replace(replace(lower(p_name), '&', 'and'), '[^a-z]', '', 'g')
  limit 1
$$;

comment on function finance.indian_state_code(text) is
  'The GSTN two-digit state code for a state NAME as a person might type it, or null. Reference data, matched after normalising case, "&" and punctuation. Kept equal to STATE_NAME_TO_CODE in src/modules/finance/gst-states.ts by a test.';

revoke all on function finance.indian_state_code(text) from public, anon;
grant execute on function finance.indian_state_code(text) to authenticated, service_role;

-- Backfill. freeze_billing_profile refuses EVERY update of a superseded row
-- (a superseded version is a record), and the code is not a change to what
-- was billed — it is the same state, in the GSTN's spelling. The trigger is
-- stepped around for exactly this statement and re-armed after it.
alter table finance.billing_profiles disable trigger freeze_billing_profile;
update finance.billing_profiles
   set billing_state_code = finance.indian_state_code(billing_state)
 where billing_state_code is null
   and billing_state is not null
   and finance.indian_state_code(billing_state) is not null;
alter table finance.billing_profiles enable trigger freeze_billing_profile;

-- ── 4. new versions carry the code too ─────────────────────────────────────

-- The confirm and record-details doors insert new versions with the state as
-- text. Before insert only: a profile never changes after it is written
-- (freeze_billing_profile), and the code follows the name the person typed.
create or replace function finance.derive_billing_state_code()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.billing_state_code is null and new.billing_state is not null then
    new.billing_state_code := finance.indian_state_code(new.billing_state);
  end if;
  return new;
end;
$$;

comment on function finance.derive_billing_state_code() is
  'Before insert on finance.billing_profiles: fills billing_state_code from billing_state when the name is one the GSTN lists and no code was given. Never overwrites a code, never guesses.';

drop trigger if exists derive_billing_state_code on finance.billing_profiles;
create trigger derive_billing_state_code
  before insert on finance.billing_profiles
  for each row execute function finance.derive_billing_state_code();
