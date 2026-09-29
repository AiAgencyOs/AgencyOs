-- Client notes — SCR-017's "Client Communication, Files & Notes" (the
-- Client 360's Files and Communication halves already roll up from the
-- owning modules; Notes has never had anywhere to live at all).
--
-- `core.client_accounts` has no owning business module (ARCHITECTURE.md §2:
-- a core table with no module of its own is read directly by admin code) —
-- this is the same shape decision as that table's other children
-- (`crm.contacts`), just with an internal-only, append-only note instead of
-- a contact record. Never client-visible, matching the rest of SCR-017: a
-- note here is agency-internal, the same boundary Files and Communication
-- already keep.

create table if not exists core.client_notes (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete cascade,
  body              text not null check (length(trim(body)) > 0 and length(body) <= 5000),
  created_by        uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists client_notes_client_account_id_idx
  on core.client_notes (client_account_id, created_at desc);

create trigger set_updated_at before update on core.client_notes
  for each row execute function core.set_updated_at();

alter table core.client_notes enable row level security;
alter table core.client_notes force row level security;

drop policy if exists client_notes_select on core.client_notes;
create policy client_notes_select on core.client_notes
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

-- Notes are edited by superseding (a new note), not by rewriting history —
-- the same append-only shape `crm.lead_activities` notes already use. Write
-- reuses `project.write` rather than minting a new capability: this repo's
-- own convention (`invoice.issue` covers expenses, `lead.write` covers lead
-- notes) is to attach a new door to an existing capability that already
-- means "may add operational detail to a record I can see," not to grow the
-- capability list by one for every new note-shaped feature.
drop policy if exists client_notes_write on core.client_notes;
create policy client_notes_write on core.client_notes
  for insert to authenticated
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.can_write())
  );

drop trigger if exists org_match_client_notes_client_account_id on core.client_notes;
create trigger org_match_client_notes_client_account_id
  before insert or update of client_account_id, organization_id on core.client_notes
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists freeze_org_client_notes on core.client_notes;
create trigger freeze_org_client_notes
  before update of organization_id on core.client_notes
  for each row execute function core.freeze_organization_id();
