-- ═══════════════════════════════════════════════════════════════════════════
-- What was true when it was finished.
--
-- Document 17 §15 asks for a Project Completion Certificate and ends with the
-- line that decides its shape: **"Completion record should be
-- immutable/audited."**
--
-- `projects.completion_summary` already assembles the same subject — money
-- billed against work delivered, revisions, duration — and its own comment
-- says what it is: *"It reports and decides nothing."* It also **re-derives on
-- every read**, which is right for a live project and wrong for a finished
-- one. A client asking in March what was delivered in January gets January's
-- work described with March's numbers; a defect closed afterwards changes the
-- QA status of a project that ended before it was found.
--
-- So this is not a second copy of the summary. It is the one fact the summary
-- cannot hold: **what was true at the moment somebody completed it.**
--
-- ── written once, by the transition, and never again ─────────────────────
--
-- The trigger fires on `active → completed`, which is the transition
-- `refuse_undone_completion` guards one migration back — so a certificate
-- exists exactly when a completion happened, and cannot exist otherwise. Every
-- column is frozen afterwards except the two §15 fields no row in this
-- repository can answer, which a person fills in: known limitations, and the
-- warranty period.
--
-- ── and the fields nobody can answer are absent, not blank ───────────────
--
-- §15 lists thirteen. **Final release/build** and **production deployment
-- status** have no rows anywhere — Doc 13's repository and build tables do not
-- exist, deliberately, and inventing a column for a fact nothing produces is
-- what G-130 and G-133 both record. They are not here. The certificate says
-- what this system knows and stops.

create table if not exists projects.completion_records (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  client_account_id   uuid not null references core.client_accounts(id) on delete cascade,

  -- §15's scope version: the baseline that was agreed, as it stood.
  scope_version_id    uuid references projects.scope_versions(id),
  scope_version       int,

  -- §15's final payment status, as at completion. Two numbers, because ADM-04
  -- and G-007 made them mean different things and the certificate must not
  -- collapse them: what was recorded, and what a person actually confirmed.
  invoiced_minor      bigint not null default 0,
  verified_minor      bigint not null default 0,

  -- §15's QA status, counted then. A defect closed next month does not change
  -- what this project shipped with.
  open_defects        int not null default 0,
  blocking_defects    int not null default 0,

  handover_delivered_at timestamptz,
  client_accepted_at    timestamptz,

  -- §15's completion owner and timestamp. `completed_by` is null when the
  -- transition came from a system path with no `auth.uid()`, which is honest:
  -- nobody is named rather than somebody being invented.
  completed_by        uuid references core.users(id),
  completed_at        timestamptz not null,

  -- Carried from the project so the certificate says whether a human judgement
  -- stood in for a §3 condition.
  override_reason     text,

  -- §15's two fields no row here can answer. A person writes them, afterwards,
  -- and they are the only mutable part of this record.
  known_limitations   text,
  warranty_note       text,

  created_at          timestamptz not null default now()
);

create unique index if not exists completion_records_one_per_project
  on projects.completion_records (project_id);

comment on table projects.completion_records is
  'Document 17 section 15, and its last line: "Completion record should be immutable/audited." projects.completion_summary assembles the same subject and RE-DERIVES on every read, which is right for a live project and wrong for a finished one - a defect closed later would change the QA status of a project that ended before it was found. This holds what was true at the moment of completion. Section 15''s final release/build and production deployment status are absent rather than blank: no rows in this repository answer them, and a column for a fact nothing produces is what G-130 and G-133 record.';

comment on column projects.completion_records.completed_by is
  'Null when the completion came from a system path with no auth.uid(). Nobody is named rather than somebody being invented.';

-- ── the certificate is written by the transition, not by a caller ────────

create or replace function projects.record_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope   record;
  v_money   record;
  v_defects record;
  v_hand    record;
begin
  if new.status <> 'completed' or coalesce(old.status, '') = 'completed' then
    return new;
  end if;

  select s.id, s.version into v_scope
    from projects.scope_versions s
   where s.project_id = new.id and s.status = 'active'
   order by s.version desc
   limit 1;

  select coalesce(sum(i.total_minor), 0) as invoiced,
         coalesce(sum(i.verified_minor), 0) as verified
    into v_money
    from finance.invoices i
   where i.project_id = new.id
     and i.status <> 'void';

  select count(*) filter (where d.status = 'open') as open_all,
         count(*) filter (where d.status = 'open' and d.severity in ('blocker', 'major')) as blocking
    into v_defects
    from qa.defects d
   where d.project_id = new.id;

  select h.delivered_at, h.accepted_at into v_hand
    from projects.handovers h
   where h.project_id = new.id
   order by h.created_at desc
   limit 1;

  insert into projects.completion_records (
    organization_id, project_id, client_account_id,
    scope_version_id, scope_version,
    invoiced_minor, verified_minor,
    open_defects, blocking_defects,
    handover_delivered_at, client_accepted_at,
    completed_by, completed_at, override_reason
  )
  values (
    new.organization_id, new.id, new.client_account_id,
    v_scope.id, v_scope.version,
    v_money.invoiced, v_money.verified,
    coalesce(v_defects.open_all, 0), coalesce(v_defects.blocking, 0),
    v_hand.delivered_at, v_hand.accepted_at,
    auth.uid(), coalesce(new.completed_at, now()), new.completion_override_reason
  )
  on conflict (project_id) do nothing;

  return new;
end;
$$;

comment on function projects.record_completion() is
  'Writes the Document 17 section 15 certificate from the transition itself, so one exists exactly when a completion happened and cannot exist otherwise. ON CONFLICT DO NOTHING because completed is terminal in PROJECT_TRANSITIONS and a second write could only be a replay - the first record is the one that was true.';

drop trigger if exists record_completion on projects.projects;
create trigger record_completion
  after update of status on projects.projects
  for each row execute function projects.record_completion();

-- ── immutable, except the two fields a person fills in ───────────────────

create or replace function projects.freeze_completion_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id            is distinct from old.project_id
     or new.client_account_id  is distinct from old.client_account_id
     or new.scope_version_id   is distinct from old.scope_version_id
     or new.scope_version      is distinct from old.scope_version
     or new.invoiced_minor     is distinct from old.invoiced_minor
     or new.verified_minor     is distinct from old.verified_minor
     or new.open_defects       is distinct from old.open_defects
     or new.blocking_defects   is distinct from old.blocking_defects
     or new.handover_delivered_at is distinct from old.handover_delivered_at
     or new.client_accepted_at is distinct from old.client_accepted_at
     or new.completed_by       is distinct from old.completed_by
     or new.completed_at       is distinct from old.completed_at
     or new.override_reason    is distinct from old.override_reason
  then
    raise exception
      'a completion record is what was true when the project finished (Doc 17 §15) — only the limitations and warranty note are a person''s to add'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_completion_record on projects.completion_records;
create trigger freeze_completion_record
  before update on projects.completion_records
  for each row execute function projects.freeze_completion_record();

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table projects.completion_records enable row level security;
alter table projects.completion_records force row level security;

drop policy if exists completion_records_select on projects.completion_records;
create policy completion_records_select on projects.completion_records
  for select to authenticated
  using (organization_id = (select core.current_organization_id()));

drop policy if exists completion_records_annotate on projects.completion_records;
create policy completion_records_annotate on projects.completion_records
  for update to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_completion_records_project on projects.completion_records;
create trigger org_match_completion_records_project
  before insert or update of project_id, organization_id on projects.completion_records
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_completion_records_client on projects.completion_records;
create trigger org_match_completion_records_client
  before insert or update of client_account_id, organization_id on projects.completion_records
  for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts');

drop trigger if exists org_match_completion_records_scope on projects.completion_records;
create trigger org_match_completion_records_scope
  before insert or update of scope_version_id, organization_id on projects.completion_records
  for each row execute function core.enforce_parent_org('scope_version_id', 'projects.scope_versions');

drop trigger if exists freeze_org_completion_records on projects.completion_records;
create trigger freeze_org_completion_records
  before update of organization_id on projects.completion_records
  for each row execute function core.freeze_organization_id();

grant select, update on projects.completion_records to authenticated;
grant select, insert, update on projects.completion_records to service_role;

notify pgrst, 'reload schema';
