-- ═══════════════════════════════════════════════════════════════════════════
-- Billing mode is confirmed, not assumed.
--
-- Finance §4.1–§4.3, §5, §14, §16; Master §5.6.
--
-- ── what this deployment has been doing until now ────────────────────────
--
-- Every quotation this system has ever sent carries one line, from
-- `quotation-standards.ts` Part G: **"All amounts are exclusive of GST; 18%
-- GST extra."** And `finance.invoice_items.tax_rate_bp` has existed since the
-- first finance migration, defaulting to **0**.
--
-- So the quotation promises the client that GST will be added, and every
-- invoice this system has issued has added none. Not by decision — by silence.
-- There was no place to record which it should be, so the default won, and the
-- default disagrees with the document the client accepted.
--
-- Finance §4.1 is the fix, and its wording is the point: *"Do not infer GST
-- preference from old messages when explicit confirmation is required."* The
-- mode is not derived from the quotation, not derived from whether the agency
-- happens to have GST configured, and not defaulted. It is **confirmed, by
-- somebody, at a moment, and the row says who and when** — or it is absent,
-- and §16 blocks the invoice.
--
-- ── versioned, because a profile outlives one invoice ────────────────────
--
-- §4.2: *"persist a versioned billing profile for later milestones"*; §5:
-- *"billing data used on each issued invoice should be snapshotted/versioned
-- for audit."* A client who changes their registered address between M1 and M3
-- has not made M1 wrong. So a change writes a NEW version and supersedes the
-- old one; nothing is edited in place, and an invoice can point at the version
-- it was raised against.
--
-- ── what is NOT here ─────────────────────────────────────────────────────
--
-- **No tax arithmetic.** This records what mode applies and the details that
-- mode requires. Computing a tax amount belongs with the invoice that charges
-- it, and putting a rate here would give the system two places to decide what
-- 18% means.
--
-- **No GST portal check.** A GSTIN's checksum is verified in code
-- (`src/modules/finance/gstin.ts`) because it is arithmetic; whether that
-- registration exists, is current, and belongs to this client is knowledge
-- only the portal has, and this deployment has no integration with it. The
-- column is `gstin`, never `gstin_verified`.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.billing_mode_confirmed',
   'Finance section 4.1 BillingModeConfirmed - a person or a client confirmation has settled whether this project is billed with GST or without it. Finance may not start the billing flow before this exists.',
   true),
  ('project.billing_details_required',
   'Finance section 4.2 GSTDetailsRequired - a GST profile is missing fields the invoice cannot be issued without. Carries exactly which fields, so the PM asks for those and not for everything again.',
   true)
on conflict (type) do nothing;

create table if not exists finance.billing_profiles (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,

  -- §14: "client/project". The project, because the confirmation is obtained
  -- for a project and §4.3 says to preserve it "for later milestone invoices"
  -- — the client account is carried too, so a second project for the same
  -- client can be prepared from the last one without inheriting it silently.
  project_id       uuid not null references projects.projects(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,

  version          int not null check (version > 0),

  -- One live profile per project; older ones stay, superseded, because an
  -- invoice raised against version 1 must still be able to say what version 1
  -- said.
  status           text not null default 'active' check (status in ('active', 'superseded')),

  -- §4.1. NOT NULL and no default: a profile row exists only because somebody
  -- confirmed a mode, and a nullable column with a default is how "unknown"
  -- becomes "non_gst" three months later.
  mode             text not null check (mode in ('gst', 'non_gst')),

  -- §14's minimum fields.
  legal_name       text,
  billing_address  text,
  billing_state    text,

  -- §14: "GSTIN if applicable". Shape-checked here so a direct write cannot
  -- store something that is not a GSTIN; the checksum is verified in code,
  -- because a check digit is arithmetic and a CHECK constraint is not where
  -- arithmetic wants to live.
  gstin            text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$'),

  -- §4.3: "do not add GST merely because the agency has GST configuration."
  -- The converse is the one worth making structural — a profile that is not
  -- GST cannot carry a GSTIN at all, so the number cannot sit there waiting to
  -- be picked up by a later reader who forgets to check the mode.
  constraint billing_profiles_non_gst_carries_no_gstin check (
    mode = 'gst' or gstin is null
  ),

  -- §4.1's "confirmed": who settled it and when. Both or neither — half a
  -- confirmation is the thing this table exists to prevent.
  confirmed_by     uuid references core.users(id) on delete set null,
  confirmed_at     timestamptz not null default now(),

  -- How it was settled. 'client_confirmation' is the client answering the PM's
  -- question; 'internal' is a person recording what is already agreed. Neither
  -- is an inference, which is why there is no third value for one.
  source           text not null check (source in ('client_confirmation', 'internal')),

  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (project_id, version)
);

-- One ACTIVE profile per project. A partial unique index rather than a check,
-- for the same reason G-015 used one for the project group: two live answers
-- to "how is this billed" is the ambiguity, and a constraint is the only thing
-- that makes it impossible rather than unlikely.
create unique index if not exists billing_profiles_one_active
  on finance.billing_profiles (project_id) where status = 'active';

comment on table finance.billing_profiles is
  'Finance section 4.1 to 4.3 and section 14 - the project billing mode and the details it requires, versioned. The mode is CONFIRMED and never inferred: section 4.1 forbids reading a preference out of old messages, and every quotation this system sends already says GST is extra while every invoice it has issued has added none, which is exactly what a default does to a decision nobody made.';

comment on column finance.billing_profiles.gstin is
  'Shape-checked here; the GSTN check character is verified in src/modules/finance/gstin.ts. Never gstin_verified: whether a registration exists, is current and belongs to this client is knowledge only the GST portal has, and this deployment has no integration with it.';

comment on column finance.billing_profiles.mode is
  'Finance section 4.1. Not null and not defaulted - a nullable column with a default is how "nobody has told us" becomes "non_gst" three months later.';

-- ── a version is a record, so it does not change under an invoice ────────

create or replace function finance.freeze_billing_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Superseding is the only update a profile accepts. Everything else is a new
  -- version, because an invoice raised against version 1 must still be able to
  -- say what version 1 said.
  if old.status = 'superseded' then
    raise exception 'a superseded billing profile is a record of what was billed, not a draft'
      using errcode = 'check_violation';
  end if;
  if new.mode is distinct from old.mode
     or new.gstin is distinct from old.gstin
     or new.legal_name is distinct from old.legal_name
     or new.billing_address is distinct from old.billing_address
     or new.billing_state is distinct from old.billing_state then
    raise exception 'billing details change by writing a new version, never by editing one'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_billing_profile on finance.billing_profiles;
create trigger freeze_billing_profile
  before update on finance.billing_profiles
  for each row execute function finance.freeze_billing_profile();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table finance.billing_profiles enable row level security;
alter table finance.billing_profiles force row level security;

drop policy if exists billing_profiles_select on finance.billing_profiles;
create policy billing_profiles_select on finance.billing_profiles
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_billing_profiles_project on finance.billing_profiles;
create trigger org_match_billing_profiles_project
  before insert or update of project_id, organization_id on finance.billing_profiles
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_billing_profiles_client on finance.billing_profiles;
create trigger org_match_billing_profiles_client
  before insert or update of client_account_id, organization_id on finance.billing_profiles
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists freeze_org_billing_profiles on finance.billing_profiles;
create trigger freeze_org_billing_profiles
  before update of organization_id on finance.billing_profiles
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_billing_profiles on finance.billing_profiles;
create trigger set_updated_at_billing_profiles
  before update on finance.billing_profiles
  for each row execute function core.set_updated_at();

grant select on finance.billing_profiles to authenticated;
grant select, insert, update on finance.billing_profiles to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- The doors
-- ═══════════════════════════════════════════════════════════════════════════

-- ── confirm the mode ─────────────────────────────────────────────────────
--
-- §4.1. A person records it, because §4.1's whole instruction is that this is
-- a confirmation rather than a reading. `client_confirmation` means the client
-- answered the PM's question and a person is recording the answer; the agent
-- that read the reply is not the one that settles it, for the same reason
-- ADM-74 keeps an approval in AgencyOS rather than in a WhatsApp reply.

create or replace function finance.confirm_billing_mode(
  p_project_id uuid,
  p_mode text,
  p_source text default 'client_confirmation',
  p_note text default null
)
returns table (
  -- 'confirmed' | 'unchanged' | 'superseded' | 'unknown_project'
  -- | 'invalid_mode' | 'invalid_source' | 'needs_person' | 'forbidden'
  outcome    text,
  profile_id uuid,
  version    int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_live    finance.billing_profiles;
  v_new     uuid;
  v_version int;
begin
  -- Arguments this function cannot act on are refused before any row is
  -- locked: a caller who passed 'GST ' learns that without holding a lock on
  -- somebody's project.
  if p_mode is null or p_mode not in ('gst', 'non_gst') then
    return query select 'invalid_mode'::text, null::uuid, null::int; return;
  end if;
  if p_source is null or p_source not in ('client_confirmation', 'internal') then
    return query select 'invalid_source'::text, null::uuid, null::int; return;
  end if;

  -- A PERSON. §4.1 says this must not be inferred, and an unattended process
  -- confirming a billing mode is precisely an inference wearing a record's
  -- clothes.
  if v_actor is null then
    return query select 'needs_person'::text, null::uuid, null::int; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::int; return;
  end if;

  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  select bp.* into v_live
    from finance.billing_profiles bp
   where bp.project_id = v_project.id and bp.status = 'active';

  -- Confirming what is already confirmed is not a new version. §4.3 asks that
  -- the preference be preserved "unless legitimately changed", and a repeated
  -- click is not a change.
  if v_live.id is not null and v_live.mode = p_mode then
    return query select 'unchanged'::text, v_live.id, v_live.version; return;
  end if;

  v_version := coalesce(v_live.version, 0) + 1;

  if v_live.id is not null then
    update finance.billing_profiles set status = 'superseded' where id = v_live.id;
  end if;

  insert into finance.billing_profiles (
    organization_id, project_id, client_account_id, version, status, mode,
    -- A mode change carries the details it can still legitimately carry: the
    -- legal name and address do not stop being true because the mode changed.
    -- The GSTIN does not come across to a non-GST profile — the constraint
    -- refuses it, and that refusal is the §4.3 rule made structural.
    legal_name, billing_address, billing_state,
    gstin,
    confirmed_by, source, note
  ) values (
    v_project.organization_id, v_project.id, v_project.client_account_id, v_version, 'active', p_mode,
    v_live.legal_name, v_live.billing_address, v_live.billing_state,
    case when p_mode = 'gst' then v_live.gstin end,
    v_actor, p_source, p_note
  )
  returning id into v_new;

  perform core.emit_event(
    v_project.organization_id, 'project.billing_mode_confirmed', 'project', v_project.id,
    jsonb_build_object('profile_id', v_new, 'mode', p_mode, 'version', v_version, 'source', p_source),
    null
  );

  perform core.record_audit(
    v_project.organization_id, 'project.billing_mode_confirmed', 'project', v_project.id,
    case when v_live.id is not null then jsonb_build_object('mode', v_live.mode, 'version', v_live.version) end,
    jsonb_build_object('mode', p_mode, 'version', v_version, 'profile_id', v_new, 'confirmed_by', v_actor),
    null
  );

  return query select
    case when v_live.id is null then 'confirmed' else 'superseded' end,
    v_new, v_version;
end;
$$;

comment on function finance.confirm_billing_mode(uuid, text, text, text) is
  'Finance section 4.1 - store GST or NON_GST as the project billing preference, from an explicit confirmation. Refuses an unattended caller: section 4.1 forbids inferring the preference, and a process confirming it is an inference wearing a record''s clothes.';

-- ── fill in what the mode requires ───────────────────────────────────────
--
-- §4.2. A new version each time, because §5 wants the data on each issued
-- invoice snapshotted — which only means anything if the row an invoice points
-- at cannot change afterwards.

create or replace function finance.record_billing_details(
  p_project_id uuid,
  p_legal_name text default null,
  p_billing_address text default null,
  p_billing_state text default null,
  p_gstin text default null
)
returns table (
  -- 'recorded' | 'unchanged' | 'no_mode' | 'unknown_project'
  -- | 'gstin_on_non_gst' | 'needs_person' | 'forbidden'
  outcome    text,
  profile_id uuid,
  version    int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_project projects.projects;
  v_live    finance.billing_profiles;
  v_new     uuid;
  v_gstin   text := nullif(btrim(upper(coalesce(p_gstin, ''))), '');
  v_name    text;
  v_addr    text;
  v_state   text;
begin
  if v_actor is null then
    return query select 'needs_person'::text, null::uuid, null::int; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid, null::int; return;
  end if;

  if v_project.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::uuid, null::int; return;
  end if;

  select bp.* into v_live
    from finance.billing_profiles bp
   where bp.project_id = v_project.id and bp.status = 'active';

  -- §16: "Missing billing mode — block invoice." Details before a mode would
  -- be a profile that exists without anybody having decided how this project
  -- is billed, which is the state this whole table was added to end.
  if v_live.id is null then
    return query select 'no_mode'::text, null::uuid, null::int; return;
  end if;

  -- §4.3 again, at the door this time: a GSTIN offered for a non-GST project
  -- is refused by name rather than dropped silently, because a person who
  -- typed one believes it was stored.
  if v_gstin is not null and v_live.mode <> 'gst' then
    return query select 'gstin_on_non_gst'::text, v_live.id, v_live.version; return;
  end if;

  v_name  := coalesce(nullif(btrim(coalesce(p_legal_name, '')), ''), v_live.legal_name);
  v_addr  := coalesce(nullif(btrim(coalesce(p_billing_address, '')), ''), v_live.billing_address);
  v_state := coalesce(nullif(btrim(coalesce(p_billing_state, '')), ''), v_live.billing_state);
  v_gstin := coalesce(v_gstin, v_live.gstin);

  if v_name is not distinct from v_live.legal_name
     and v_addr is not distinct from v_live.billing_address
     and v_state is not distinct from v_live.billing_state
     and v_gstin is not distinct from v_live.gstin then
    return query select 'unchanged'::text, v_live.id, v_live.version; return;
  end if;

  update finance.billing_profiles set status = 'superseded' where id = v_live.id;

  insert into finance.billing_profiles (
    organization_id, project_id, client_account_id, version, status, mode,
    legal_name, billing_address, billing_state, gstin, confirmed_by, source, note
  ) values (
    v_project.organization_id, v_project.id, v_project.client_account_id,
    v_live.version + 1, 'active', v_live.mode,
    v_name, v_addr, v_state, v_gstin, v_actor, v_live.source, v_live.note
  )
  returning id into v_new;

  perform core.record_audit(
    v_project.organization_id, 'project.billing_details_recorded', 'project', v_project.id,
    jsonb_build_object('version', v_live.version),
    jsonb_build_object('version', v_live.version + 1, 'profile_id', v_new, 'recorded_by', v_actor),
    null
  );

  return query select 'recorded'::text, v_new, v_live.version + 1;
end;
$$;

comment on function finance.record_billing_details(uuid, text, text, text, text) is
  'Finance section 4.2 - the fields a GST invoice cannot be issued without. Writes a new version rather than editing one, so an invoice raised against version 1 can still say what version 1 said. Refuses a GSTIN on a non-GST project by name (section 4.3).';

revoke all on function finance.confirm_billing_mode(uuid, text, text, text) from public;
revoke all on function finance.record_billing_details(uuid, text, text, text, text) from public;

grant execute on function finance.confirm_billing_mode(uuid, text, text, text) to authenticated;
grant execute on function finance.record_billing_details(uuid, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';
