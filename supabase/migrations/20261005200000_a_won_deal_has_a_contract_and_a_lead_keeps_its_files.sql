-- ═══════════════════════════════════════════════════════════════════════════
-- A won deal has a contract, and a lead keeps its files.
--
-- Owner decisions 10, 11 and 14 (2026-10-03), one migration because they are
-- the same shelf: what the sales side keeps about a person and a deal.
--
--   10. CONTRACTS. A simple record linked to a WON deal: title, file link,
--       signer name, signed date, status draft / sent / signed. No
--       e-signature: "signed" is a person recording that it was.
--   11. LEAD FILES. Links kept on a lead (title, url, who added it, when).
--       They carry over to the project when the deal is won — copied as
--       project file links ONCE, idempotently, by the app after the project
--       exists (the WON handoff is not redefined here; see the claim door).
--   14. HOT / NO RESPONSE. Both are read from when a lead last WROTE — the
--       newest inbound message — so this adds the one aggregate that needs.
--
-- Every write is a security-definer door that re-checks the role (owner or
-- ops admin, the lead.write set) and writes an audit row. `authenticated`
-- holds SELECT only, behind an organization policy; nothing can be inserted,
-- updated or deleted through PostgREST directly.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── contracts ──────────────────────────────────────────────────────────────

create table if not exists sales.contracts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  opportunity_id    uuid not null references sales.opportunities(id) on delete cascade,
  client_account_id uuid references core.client_accounts(id) on delete set null,
  title             text not null check (char_length(btrim(title)) between 1 and 200),
  file_url          text check (file_url is null or (file_url ~* '^https?://[^\s]+$' and char_length(file_url) <= 2000)),
  signer_name       text check (signer_name is null or char_length(btrim(signer_name)) between 1 and 200),
  signed_on         date,
  status            text not null default 'draft' check (status in ('draft', 'sent', 'signed')),
  created_by        uuid references core.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- "Signed" is a claim about a person and a day; without both it is not one.
  constraint contracts_signed_says_who_and_when
    check (status <> 'signed' or (signer_name is not null and signed_on is not null)),
  constraint contracts_only_signed_has_a_signed_date
    check (status = 'signed' or signed_on is null)
);

comment on table sales.contracts is
  'Owner decision 10. A simple contract record on a WON deal: title, file link, signer name, signed date, status draft/sent/signed. No e-signature. Written only through sales.create_contract / sales.update_contract_status.';

create index if not exists contracts_opportunity_idx on sales.contracts (opportunity_id, created_at desc);
create index if not exists contracts_organization_idx on sales.contracts (organization_id, created_at desc);
create index if not exists contracts_client_idx on sales.contracts (client_account_id) where client_account_id is not null;

alter table sales.contracts enable row level security;
alter table sales.contracts force row level security;

drop policy if exists contracts_select on sales.contracts;
create policy contracts_select on sales.contracts
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists contracts_service on sales.contracts;
create policy contracts_service on sales.contracts
  for all to service_role using (true) with check (true);

revoke all on table sales.contracts from public, anon, authenticated;
grant select on table sales.contracts to authenticated;
grant select, insert, update, delete on table sales.contracts to service_role;

drop trigger if exists set_updated_at on sales.contracts;
create trigger set_updated_at before update on sales.contracts
  for each row execute function core.set_updated_at();

drop trigger if exists freeze_org_contracts on sales.contracts;
create trigger freeze_org_contracts before update of organization_id on sales.contracts
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_contracts_opportunity_id on sales.contracts;
create trigger org_match_contracts_opportunity_id before insert or update of opportunity_id, organization_id on sales.contracts
  for each row execute function core.enforce_parent_org('opportunity_id', 'sales.opportunities');

drop trigger if exists org_match_contracts_client_account_id on sales.contracts;
create trigger org_match_contracts_client_account_id before insert or update of client_account_id, organization_id on sales.contracts
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists contracts_reject_end_user_delete on sales.contracts;
create trigger contracts_reject_end_user_delete before delete on sales.contracts
  for each row execute function core.reject_end_user_delete();

-- Only a WON deal can have a contract — said at the row as well as in the
-- door, so nothing that can reach the table can make one on an open deal.
create or replace function sales.contracts_only_on_a_won_deal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage text;
begin
  select o.stage into v_stage from sales.opportunities o where o.id = new.opportunity_id;
  if v_stage is distinct from 'won' then
    raise exception 'a contract belongs to a won deal; this deal is %', coalesce(v_stage, 'unknown')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists contracts_only_on_a_won_deal on sales.contracts;
create trigger contracts_only_on_a_won_deal before insert on sales.contracts
  for each row execute function sales.contracts_only_on_a_won_deal();

-- ── create_contract ────────────────────────────────────────────────────────

create or replace function sales.create_contract(
  p_opportunity_id uuid,
  p_title          text,
  p_file_url       text default null,
  p_signer_name    text default null,
  p_signed_on      date default null,
  p_status         text default 'draft'
)
returns table (
  -- 'created'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'not_won' | 'invalid_title'
  --           | 'invalid_url' | 'invalid_status' | 'invalid_signature'
  outcome     text,
  contract_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_title  text := btrim(coalesce(p_title, ''));
  v_url    text := nullif(btrim(coalesce(p_file_url, '')), '');
  v_signer text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_opp    record;
  v_id     uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;

  select o.id, o.stage, o.client_account_id into v_opp
    from sales.opportunities o
   where o.id = p_opportunity_id and o.organization_id = v_org;
  if not found then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if v_opp.stage <> 'won' then
    return query select 'not_won'::text, null::uuid; return;
  end if;

  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    return query select 'invalid_title'::text, null::uuid; return;
  end if;
  if v_url is not null and (v_url !~* '^https?://[^\s]+$' or char_length(v_url) > 2000) then
    return query select 'invalid_url'::text, null::uuid; return;
  end if;
  if p_status is null or p_status not in ('draft', 'sent', 'signed') then
    return query select 'invalid_status'::text, null::uuid; return;
  end if;
  if p_status = 'signed' and (v_signer is null or p_signed_on is null or p_signed_on > current_date + 1) then
    return query select 'invalid_signature'::text, null::uuid; return;
  end if;
  if p_status <> 'signed' and p_signed_on is not null then
    return query select 'invalid_signature'::text, null::uuid; return;
  end if;

  insert into sales.contracts (organization_id, opportunity_id, client_account_id, title, file_url, signer_name, signed_on, status, created_by)
  values (v_org, v_opp.id, v_opp.client_account_id, v_title, v_url, v_signer, p_signed_on, p_status, v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'contract.created', 'contract', v_id, null,
    jsonb_build_object('opportunity_id', v_opp.id, 'title', v_title, 'status', p_status, 'by', v_actor)
  );

  return query select 'created'::text, v_id;
end;
$$;

comment on function sales.create_contract(uuid, text, text, text, date, text) is
  'Owner decision 10. Records a contract on a WON deal (owner or ops admin, re-checked here). A signed contract names its signer and the day. Audited as contract.created.';

revoke all on function sales.create_contract(uuid, text, text, text, date, text) from public, anon;
grant execute on function sales.create_contract(uuid, text, text, text, date, text) to authenticated;

-- ── update_contract_status ─────────────────────────────────────────────────
--
-- draft -> sent, draft -> signed, sent -> signed, sent -> draft (recalled).
-- A signed contract is a record of what happened and does not move again.

create or replace function sales.update_contract_status(
  p_contract_id uuid,
  p_status      text,
  p_signer_name text default null,
  p_signed_on   date default null,
  p_file_url    text default null
)
returns table (
  -- 'updated' | 'unchanged'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'invalid_status'
  --           | 'invalid_transition' | 'invalid_signature' | 'invalid_url'
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
  v_row    sales.contracts%rowtype;
  v_url    text := nullif(btrim(coalesce(p_file_url, '')), '');
  v_signer text := nullif(btrim(coalesce(p_signer_name, '')), '');
  v_new_url text;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_status is null or p_status not in ('draft', 'sent', 'signed') then
    return query select 'invalid_status'::text; return;
  end if;

  select * into v_row from sales.contracts c where c.id = p_contract_id and c.organization_id = v_org for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  -- Validation first, so a bad request is refused as bad even when it names
  -- the status the contract already has.
  if v_url is not null and (v_url !~* '^https?://[^\s]+$' or char_length(v_url) > 2000) then
    return query select 'invalid_url'::text; return;
  end if;
  if p_status = 'signed' then
    v_signer := coalesce(v_signer, v_row.signer_name);
    if v_signer is null or p_signed_on is null or p_signed_on > current_date + 1 then
      return query select 'invalid_signature'::text; return;
    end if;
  elsif p_signed_on is not null then
    return query select 'invalid_signature'::text; return;
  end if;

  -- A signed contract is a record: nothing moves it, and nothing re-signs it.
  if v_row.status = 'signed' then
    return query select case when p_status = 'signed' and v_url is null and p_signed_on is not distinct from v_row.signed_on and v_signer is not distinct from v_row.signer_name then 'unchanged' else 'invalid_transition' end::text;
    return;
  end if;
  if v_row.status = p_status and v_url is null and v_signer is not distinct from v_row.signer_name then
    return query select 'unchanged'::text; return;
  end if;

  v_new_url := coalesce(v_url, v_row.file_url);

  update sales.contracts
     set status = p_status,
         signer_name = case when p_status = 'signed' then v_signer else coalesce(v_signer, signer_name) end,
         signed_on = case when p_status = 'signed' then p_signed_on else null end,
         file_url = v_new_url
   where id = v_row.id;

  perform core.record_audit(
    v_org, 'contract.status_changed', 'contract', v_row.id,
    jsonb_build_object('status', v_row.status, 'signer_name', v_row.signer_name, 'signed_on', v_row.signed_on, 'file_url', v_row.file_url),
    jsonb_build_object('status', p_status, 'signer_name', v_signer, 'signed_on', p_signed_on, 'file_url', v_new_url, 'by', v_actor)
  );

  return query select 'updated'::text;
end;
$$;

comment on function sales.update_contract_status(uuid, text, text, date, text) is
  'Owner decision 10. Moves a contract draft -> sent -> signed (or recalls sent -> draft); signing names the signer and the day and closes the record. Owner or ops admin, re-checked here. Audited as contract.status_changed with before and after.';

revoke all on function sales.update_contract_status(uuid, text, text, date, text) from public, anon;
grant execute on function sales.update_contract_status(uuid, text, text, date, text) to authenticated;

-- ── lead files ─────────────────────────────────────────────────────────────

create table if not exists crm.lead_files (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references core.organizations(id) on delete cascade,
  lead_id                uuid not null references crm.leads(id) on delete cascade,
  title                  text not null check (char_length(btrim(title)) between 1 and 200),
  url                    text not null check (url ~* '^https?://[^\s]+$' and char_length(url) <= 2000),
  added_by               uuid references core.users(id) on delete set null,
  added_at               timestamptz not null default now(),
  -- Set once, by the claim door, when the link was copied onto the project the
  -- lead's deal became. Null = not carried yet.
  carried_to_project_id  uuid references projects.projects(id) on delete set null,
  carried_at             timestamptz
);

comment on table crm.lead_files is
  'Owner decision 11. Links kept on a lead. When the lead''s deal is won and becomes a project, each is copied once as a project file link (carried_to_project_id says it was). Written only through crm.add_lead_file / remove_lead_file / claim_lead_file_carry.';

create unique index if not exists lead_files_lead_url_key on crm.lead_files (lead_id, lower(url));
create index if not exists lead_files_lead_idx on crm.lead_files (lead_id, added_at desc);

alter table crm.lead_files enable row level security;
alter table crm.lead_files force row level security;

drop policy if exists lead_files_select on crm.lead_files;
create policy lead_files_select on crm.lead_files
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists lead_files_service on crm.lead_files;
create policy lead_files_service on crm.lead_files
  for all to service_role using (true) with check (true);

revoke all on table crm.lead_files from public, anon, authenticated;
grant select on table crm.lead_files to authenticated;
grant select, insert, update, delete on table crm.lead_files to service_role;

drop trigger if exists freeze_org_lead_files on crm.lead_files;
create trigger freeze_org_lead_files before update of organization_id on crm.lead_files
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_lead_files_lead_id on crm.lead_files;
create trigger org_match_lead_files_lead_id before insert or update of lead_id, organization_id on crm.lead_files
  for each row execute function core.enforce_parent_org('lead_id', 'crm.leads');

create or replace function crm.add_lead_file(p_lead_id uuid, p_title text, p_url text)
returns table (
  -- 'added'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'invalid_title' | 'invalid_url' | 'duplicate'
  outcome text,
  file_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_title text := btrim(coalesce(p_title, ''));
  v_url   text := btrim(coalesce(p_url, ''));
  v_id    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if not exists (select 1 from crm.leads l where l.id = p_lead_id and l.organization_id = v_org and l.deleted_at is null) then
    return query select 'not_found'::text, null::uuid; return;
  end if;
  if char_length(v_title) < 1 or char_length(v_title) > 200 then
    return query select 'invalid_title'::text, null::uuid; return;
  end if;
  if v_url !~* '^https?://[^\s]+$' or char_length(v_url) > 2000 then
    return query select 'invalid_url'::text, null::uuid; return;
  end if;
  if exists (select 1 from crm.lead_files f where f.lead_id = p_lead_id and lower(f.url) = lower(v_url)) then
    return query select 'duplicate'::text, null::uuid; return;
  end if;

  insert into crm.lead_files (organization_id, lead_id, title, url, added_by)
  values (v_org, p_lead_id, v_title, v_url, v_actor)
  returning id into v_id;

  perform core.record_audit(
    v_org, 'lead_file.added', 'lead_file', v_id, null,
    jsonb_build_object('lead_id', p_lead_id, 'title', v_title, 'url', v_url, 'by', v_actor)
  );

  return query select 'added'::text, v_id;
end;
$$;

comment on function crm.add_lead_file(uuid, text, text) is
  'Owner decision 11. Keeps a link (title, https url) on a lead. Owner or ops admin, re-checked here; the same link is not kept twice. Audited as lead_file.added.';

revoke all on function crm.add_lead_file(uuid, text, text) from public, anon;
grant execute on function crm.add_lead_file(uuid, text, text) to authenticated;

create or replace function crm.remove_lead_file(p_file_id uuid)
returns table (
  -- 'removed'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   crm.lead_files%rowtype;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  select * into v_row from crm.lead_files f where f.id = p_file_id and f.organization_id = v_org for update;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  delete from crm.lead_files where id = v_row.id;

  perform core.record_audit(
    v_org, 'lead_file.removed', 'lead_file', v_row.id,
    jsonb_build_object('lead_id', v_row.lead_id, 'title', v_row.title, 'url', v_row.url),
    jsonb_build_object('by', v_actor)
  );

  return query select 'removed'::text;
end;
$$;

comment on function crm.remove_lead_file(uuid) is
  'Owner decision 11. Removes a link from a lead (a copy already made on a project stays there). Owner or ops admin, re-checked here. Audited as lead_file.removed.';

revoke all on function crm.remove_lead_file(uuid) from public, anon;
grant execute on function crm.remove_lead_file(uuid) to authenticated;

-- ── the carry: claim, then copy, then (if the copy failed) release ─────────
--
-- The WON handoff is a long-redefined function and is not touched. The app
-- copies the links after the deal's project exists (convertToProject), through
-- the ordinary project file link door. What makes that ONCE is this claim: it
-- flips carried_to_project_id from null in a single atomic update, so two
-- concurrent conversions, or a re-run, copy each link exactly one time.

create or replace function crm.claim_lead_file_carry(p_file_id uuid, p_project_id uuid)
returns table (
  -- 'claimed' (the caller now copies it) | 'already_carried'
  -- refusals: 'no_actor' | 'not_authorized' | 'not_found' | 'wrong_project'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_file  crm.lead_files%rowtype;
  v_ok    boolean;
  v_flip  integer;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  select * into v_file from crm.lead_files f where f.id = p_file_id and f.organization_id = v_org;
  if not found then
    return query select 'not_found'::text; return;
  end if;

  -- Only the project raised from THIS lead's WON deal may receive its links.
  select exists (
    select 1
      from projects.projects p
      join sales.opportunities o on o.id = p.opportunity_id
     where p.id = p_project_id
       and p.organization_id = v_org
       and o.lead_id = v_file.lead_id
       and o.stage = 'won'
  ) into v_ok;
  if not v_ok then
    return query select 'wrong_project'::text; return;
  end if;

  update crm.lead_files
     set carried_to_project_id = p_project_id, carried_at = now()
   where id = v_file.id and carried_to_project_id is null;
  get diagnostics v_flip = row_count;

  if v_flip = 0 then
    return query select 'already_carried'::text; return;
  end if;

  perform core.record_audit(
    v_org, 'lead_file.carried_to_project', 'lead_file', v_file.id, null,
    jsonb_build_object('lead_id', v_file.lead_id, 'project_id', p_project_id, 'title', v_file.title, 'by', v_actor)
  );

  return query select 'claimed'::text;
end;
$$;

comment on function crm.claim_lead_file_carry(uuid, uuid) is
  'Owner decision 11. Claims one lead link for the project its won deal became, atomically, so it is copied once. Refuses any project that is not the one raised from this lead''s won deal. Audited as lead_file.carried_to_project.';

revoke all on function crm.claim_lead_file_carry(uuid, uuid) from public, anon;
grant execute on function crm.claim_lead_file_carry(uuid, uuid) to authenticated;

-- A copy that failed hands its claim back so the next conversion tries again.
create or replace function crm.release_lead_file_carry(p_file_id uuid, p_project_id uuid)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_n     integer;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  update crm.lead_files
     set carried_to_project_id = null, carried_at = null
   where id = p_file_id and organization_id = v_org and carried_to_project_id = p_project_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return query select 'not_found'::text; return;
  end if;
  return query select 'released'::text;
end;
$$;

comment on function crm.release_lead_file_carry(uuid, uuid) is
  'Owner decision 11. Hands back a claim whose project copy failed, so the link is carried on the next conversion.';

revoke all on function crm.release_lead_file_carry(uuid, uuid) from public, anon;
grant execute on function crm.release_lead_file_carry(uuid, uuid) to authenticated;

-- ── when a lead last wrote ─────────────────────────────────────────────────
--
-- Decision 14 reads "the lead replied" and "silence" from the newest INBOUND
-- message (author_type 'client') on any of the lead's conversations. Security
-- INVOKER, so the caller's row-level security decides which leads they see.

create or replace function crm.last_inbound_by_lead()
returns table (lead_id uuid, last_inbound_at timestamptz)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.lead_id, max(m.occurred_at)
    from crm.conversations c
    join crm.conversation_messages m on m.conversation_id = c.id
   where c.lead_id is not null
     and m.author_type = 'client'
   group by c.lead_id;
$$;

comment on function crm.last_inbound_by_lead() is
  'Owner decision 14. The newest inbound (client-authored) message time per lead, across its conversations. Invoker rights: row-level security scopes it to the caller''s organization.';

revoke all on function crm.last_inbound_by_lead() from public, anon;
grant execute on function crm.last_inbound_by_lead() to authenticated;

notify pgrst, 'reload schema';
