-- ═══════════════════════════════════════════════════════════════════════════
-- A historical-lead import that cannot duplicate, cannot cross a tenant, and
-- cannot manufacture consent.
--
-- The reactivation mandate needs 1,200+ old WhatsApp leads brought into AgencyOS
-- SAFELY. This adds the staging + commit half of that. A WhatsApp export is
-- parsed and classified off-database (src/lib/import/*, phone decides identity,
-- a name never does); the resulting candidates are STAGED here, an owner reviews
-- them, and only then are the phone-keyed ones committed to real contacts/leads.
--
-- What makes it safe is that the commit is the ONLY write path and it reuses the
-- exact idempotency the inbound ingest already relies on:
--   • a contact is insert-or-found on (organization_id, phone) — never a second
--     row for a number already known, never an overwrite of a name a human fixed;
--   • a lead is the contact's existing OPEN lead if it has one, else a new
--     source='import' lead keyed (organization_id, 'import', phone) — so one
--     person is one lead whether they came from import or a live message, and a
--     re-run finds rather than creates.
-- It writes NO communication_consent row (a historical message is data, not
-- permission), records NO message, and enqueues NO job — so an import can never
-- trigger an outbound send. Consent stays absent, which is exactly why an
-- imported lead is not yet reactivation-eligible.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── staging: a batch, and the candidate rows in it ─────────────────────────

create table if not exists crm.import_batches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  source_label     text not null check (length(trim(source_label)) > 0),
  note             text,
  created_by       uuid references core.users(id) on delete set null,
  created_at       timestamptz not null default now()
);

comment on table crm.import_batches is
  'One run of a historical-lead import. Staging only; committing its records is what touches contacts/leads. RLS: an internal role reads its own org, owner/ops_admin create.';

create table if not exists crm.import_records (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null references crm.import_batches(id) on delete cascade,
  -- Denormalized from the batch for RLS and the tenant guard below.
  organization_id      uuid not null references core.organizations(id) on delete cascade,

  -- E.164 when the export gave one; null for a name-only observation. Only a
  -- non-null phone can ever be committed (a contact needs a reachable key).
  phone                text,
  display_name         text not null check (length(trim(display_name)) > 0),
  message_count        int not null default 0 check (message_count >= 0),
  source_label         text not null,

  -- The off-database classification (src/lib/import/match.ts). Only 'exact' and
  -- 'new' are auto-importable; the rest are manual review and refuse to commit.
  classification       text not null check (classification in
                         ('exact', 'new', 'probable', 'conflict', 'unmatched')),
  auto_importable      boolean not null default false,
  matched_contact_id   uuid references crm.contacts(id) on delete set null,

  -- Set by crm.commit_import_record, never by a direct write.
  committed_at         timestamptz,
  committed_contact_id uuid references crm.contacts(id) on delete set null,
  committed_lead_id    uuid references crm.leads(id) on delete set null,

  created_at           timestamptz not null default now(),

  -- One row per phone per batch: staging the same number twice in one import is
  -- a duplicate at the door, refused before any commit can consider it.
  constraint import_records_phone_once unique (batch_id, phone)
);

create index if not exists import_records_batch_idx on crm.import_records (batch_id);

comment on table crm.import_records is
  'A staged import candidate. classification/auto_importable come from src/lib/import/match.ts (phone decides identity). committed_* are written only by crm.commit_import_record. No consent lives here — a message is not consent.';

-- ── tenant consistency: the generated guards the whole codebase uses ─────────
--
-- Every org-scoped foreign key gets core.enforce_parent_org (so a record, its
-- matched contact, and its committed contact/lead all share the record's org),
-- and organization_id is frozen on both tables (a row cannot be re-tenanted).
-- core.unguarded_org_fks() and core.unfrozen_org_tables() — enforced by
-- db:verify:tenancyguards — recognize exactly these triggers, matched by
-- function and fk column, so a hand-rolled equivalent would be invisible to them
-- and the class-completeness check would (correctly) flag this table.

create trigger org_match_import_records_batch_id
  before insert or update on crm.import_records
  for each row execute function core.enforce_parent_org('batch_id', 'crm.import_batches');

create trigger org_match_import_records_matched_contact_id
  before insert or update on crm.import_records
  for each row execute function core.enforce_parent_org('matched_contact_id', 'crm.contacts');

create trigger org_match_import_records_committed_contact_id
  before insert or update on crm.import_records
  for each row execute function core.enforce_parent_org('committed_contact_id', 'crm.contacts');

create trigger org_match_import_records_committed_lead_id
  before insert or update on crm.import_records
  for each row execute function core.enforce_parent_org('committed_lead_id', 'crm.leads');

create trigger freeze_org_import_batches
  before update on crm.import_batches
  for each row execute function core.freeze_organization_id();

create trigger freeze_org_import_records
  before update on crm.import_records
  for each row execute function core.freeze_organization_id();

-- ── RLS: read your own org; owner/ops_admin stage; nobody updates directly ──

alter table crm.import_batches enable row level security;
alter table crm.import_records enable row level security;

drop policy if exists import_batches_select on crm.import_batches;
create policy import_batches_select on crm.import_batches
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists import_batches_insert on crm.import_batches;
create policy import_batches_insert on crm.import_batches
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.current_user_role()) in ('owner', 'ops_admin'));

drop policy if exists import_records_select on crm.import_records;
create policy import_records_select on crm.import_records
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists import_records_insert on crm.import_records;
create policy import_records_insert on crm.import_records
  for insert to authenticated
  with check (organization_id = (select core.current_organization_id())
              and (select core.current_user_role()) in ('owner', 'ops_admin'));

-- No UPDATE or DELETE policy for authenticated: committed_* is written ONLY by
-- crm.commit_import_record (SECURITY DEFINER, which is not subject to RLS), so a
-- direct Data-API PATCH cannot forge a commit or rewrite a classification.

grant select, insert on crm.import_batches to authenticated;
grant select, insert on crm.import_records to authenticated;
grant select, insert, update on crm.import_batches to service_role;
grant select, insert, update on crm.import_records to service_role;

-- ── the one write path: commit a single record, idempotently ────────────────

create or replace function crm.commit_import_record(p_record_id uuid)
returns table (outcome text, contact_id uuid, lead_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_actor   uuid := (select auth.uid());
  v_rec     crm.import_records%rowtype;
  v_org     uuid;
  v_contact uuid;
  v_lead    uuid;
  v_name    text;
begin
  select * into v_rec from crm.import_records where id = p_record_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;
  v_org := v_rec.organization_id;

  -- Authority: owner/ops_admin of the record's own org. Tenant is DERIVED from
  -- the row, never trusted from the caller. The service role (jobs) is exempt.
  if v_actor is not null then
    if (select core.current_user_role()) not in ('owner', 'ops_admin') then
      return query select 'forbidden'::text, null::uuid, null::uuid; return;
    end if;
    if v_org is distinct from (select core.current_organization_id()) then
      return query select 'forbidden'::text, null::uuid, null::uuid; return;
    end if;
  end if;

  -- Idempotent: a committed record returns its existing ids and writes nothing.
  if v_rec.committed_at is not null then
    return query select 'already_committed'::text, v_rec.committed_contact_id, v_rec.committed_lead_id; return;
  end if;

  -- Only a clean phone decision may be committed. Everything else is manual
  -- review and is refused here — the database will not create from a name.
  if v_rec.classification not in ('exact', 'new') or not v_rec.auto_importable or v_rec.phone is null then
    return query select 'not_importable'::text, null::uuid, null::uuid; return;
  end if;

  -- Contact: insert-or-find on (org, phone) — the inbound-ingest idiom. A
  -- returning number is never duplicated and a corrected name is never
  -- overwritten.
  v_name := coalesce(nullif(btrim(v_rec.display_name), ''), v_rec.phone);
  insert into crm.contacts (organization_id, full_name, phone)
  values (v_org, v_name, v_rec.phone)
  on conflict (organization_id, phone) where phone is not null
  do nothing
  returning id into v_contact;
  if v_contact is null then
    select c.id into v_contact from crm.contacts c where c.organization_id = v_org and c.phone = v_rec.phone;
  end if;

  -- Lead: the contact's existing OPEN lead if it has one (one person, one lead),
  -- else a new source='import' lead keyed for idempotent re-runs.
  select l.id into v_lead
    from crm.leads l
   where l.organization_id = v_org
     and l.contact_id = v_contact
     and l.deleted_at is null
     and l.status in ('new', 'qualifying', 'qualified')
   order by l.created_at asc
   limit 1;

  if v_lead is null then
    insert into crm.leads (organization_id, contact_id, title, summary, source, source_ref, status)
    values (v_org, v_contact,
            'Imported lead — ' || v_name,
            'Imported from a WhatsApp export (' || v_rec.source_label || '). No consent implied.',
            'import', v_rec.phone, 'new')
    on conflict (organization_id, source, source_ref) where source_ref is not null
    do nothing
    returning id into v_lead;
    if v_lead is null then
      select l.id into v_lead from crm.leads l
       where l.organization_id = v_org and l.source = 'import' and l.source_ref = v_rec.phone;
    end if;
  end if;

  -- Record the commit on the staging row (DEFINER write, not subject to RLS).
  update crm.import_records
     set committed_at = now(), committed_contact_id = v_contact, committed_lead_id = v_lead
   where id = p_record_id;

  -- Audit the mutation. NOTE what is absent: no communication_consent write, no
  -- message, no job — an import cannot cause a send.
  perform core.record_audit(
    v_org, 'lead.imported', 'lead', v_lead, null,
    jsonb_build_object('contact_id', v_contact, 'phone', v_rec.phone,
                       'source_label', v_rec.source_label, 'import_record_id', p_record_id));

  return query select 'committed'::text, v_contact, v_lead;
end;
$$;

comment on function crm.commit_import_record(uuid) is
  'Commits ONE staged import record to a contact + lead, idempotently. SECURITY DEFINER; owner/ops_admin, tenant derived from the row, service role exempt. Only classification exact/new with a phone commit — a name is never enough. Reuses the (org,phone) contact key and (org,import,phone) lead key so re-runs find rather than duplicate. Writes NO consent, NO message, NO job: an import cannot trigger a send.';

revoke all on function crm.commit_import_record(uuid) from public, anon;
grant execute on function crm.commit_import_record(uuid) to authenticated, service_role;
