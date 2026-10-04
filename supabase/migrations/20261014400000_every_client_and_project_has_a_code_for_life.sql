-- Every client has one identifier for life, and every project's identifier is built from its client's.
--
--   client   CL-000042          assigned when the client is created, never edited, never reused (the counter only goes up, so a
--                               deleted or archived client's code is not handed to somebody else)
--   project  CL-000042-P03      the client's code, then the client's own 3rd project - assigned when the project is created, never edited
--
-- The existing `projects.code` stays what it was: an optional, hand-typed reference. These two are the system's, so a person cannot
-- mistype one, two people cannot pick the same, and nothing the business does (a rename, a re-assignment, an archive) changes them.
-- Assigned by the database on insert whatever path creates the row; a value supplied by the caller is ignored.

create table if not exists core.client_code_counters (
  organization_id uuid primary key references core.organizations(id) on delete cascade,
  last_number     int not null default 0 check (last_number >= 0)
);
comment on table core.client_code_counters is 'The last client number issued per organization. Only ever increases: a client code is never reissued.';
alter table core.client_code_counters enable row level security;
alter table core.client_code_counters force row level security;
revoke all on core.client_code_counters from public, anon, authenticated;
grant select, insert, update on core.client_code_counters to service_role;

alter table core.client_accounts add column if not exists client_code text;
alter table core.client_accounts add column if not exists project_seq int not null default 0 check (project_seq >= 0);
alter table projects.projects add column if not exists project_code text;

-- ── backfill, oldest first, so numbers follow the order the clients and projects actually came ──

do $$
declare
  r record;
  n int;
begin
  for r in select id, organization_id from core.client_accounts where client_code is null order by organization_id, created_at, id loop
    insert into core.client_code_counters (organization_id, last_number) values (r.organization_id, 1)
    on conflict (organization_id) do update set last_number = core.client_code_counters.last_number + 1
    returning last_number into n;
    update core.client_accounts set client_code = 'CL-' || lpad(n::text, 6, '0') where id = r.id;
  end loop;

  for r in select p.id, p.client_account_id, c.client_code from projects.projects p join core.client_accounts c on c.id = p.client_account_id
            where p.project_code is null order by p.client_account_id, p.created_at, p.id loop
    update core.client_accounts set project_seq = project_seq + 1 where id = r.client_account_id returning project_seq into n;
    update projects.projects set project_code = r.client_code || '-P' || lpad(n::text, 2, '0') where id = r.id;
  end loop;
end
$$;

alter table core.client_accounts alter column client_code set not null;
alter table projects.projects alter column project_code set not null;
create unique index if not exists client_accounts_org_client_code_key on core.client_accounts (organization_id, client_code);
create unique index if not exists projects_org_project_code_key on projects.projects (organization_id, project_code);
alter table core.client_accounts drop constraint if exists client_accounts_client_code_shape;
alter table core.client_accounts add constraint client_accounts_client_code_shape check (client_code ~ '^CL-[0-9]{6,}$');
alter table projects.projects drop constraint if exists projects_project_code_shape;
alter table projects.projects add constraint projects_project_code_shape check (project_code ~ '^CL-[0-9]{6,}-P[0-9]{2,}$');

-- ── assigned by the database on insert ──

create or replace function core.assign_client_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  insert into core.client_code_counters (organization_id, last_number) values (new.organization_id, 1)
  on conflict (organization_id) do update set last_number = core.client_code_counters.last_number + 1
  returning last_number into n;
  new.client_code := 'CL-' || lpad(n::text, 6, '0');
  new.project_seq := 0;
  return new;
end;
$$;
drop trigger if exists assign_client_code on core.client_accounts;
create trigger assign_client_code before insert on core.client_accounts for each row execute function core.assign_client_code();

create or replace function projects.assign_project_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n    int;
  code text;
begin
  -- Locking the client's row serialises two projects created for one client at the same moment: each gets its own number.
  update core.client_accounts set project_seq = project_seq + 1 where id = new.client_account_id returning project_seq, client_code into n, code;
  if code is null then raise exception 'a project needs a client with a code' using errcode = 'foreign_key_violation'; end if;
  new.project_code := code || '-P' || lpad(n::text, 2, '0');
  return new;
end;
$$;
drop trigger if exists assign_project_code on projects.projects;
create trigger assign_project_code before insert on projects.projects for each row execute function projects.assign_project_code();

-- ── immutable: nobody edits an identifier, and the counter on the client only moves forward ──

create or replace function core.client_code_is_for_life()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_code is distinct from old.client_code then
    raise exception 'a client code is for life and cannot be changed' using errcode = 'P0001';
  end if;
  if new.project_seq < old.project_seq then
    raise exception 'the project counter of a client only moves forward' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists client_code_is_for_life on core.client_accounts;
create trigger client_code_is_for_life before update on core.client_accounts for each row execute function core.client_code_is_for_life();

create or replace function projects.project_code_is_for_life()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_code is distinct from old.project_code then
    raise exception 'a project code is for life and cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists project_code_is_for_life on projects.projects;
create trigger project_code_is_for_life before update on projects.projects for each row execute function projects.project_code_is_for_life();

comment on column core.client_accounts.client_code is 'The client''s identifier for life (CL-000042). Assigned on insert, never edited, never reused.';
comment on column projects.projects.project_code is 'The project''s identifier for life, built from its client''s code (CL-000042-P03). Assigned on insert, never edited. `code` stays the optional hand-typed reference.';

notify pgrst, 'reload schema';
