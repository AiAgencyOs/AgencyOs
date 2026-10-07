-- ═══════════════════════════════════════════════════════════════════════════
-- 8B Developer spec §7 outgoing handoffs BuildCreated and MigrationPrepared.
-- AgencyOS builds nothing and writes no migration for a maintenance change. A PERSON who did (elsewhere) records the build or the prepared migration
-- against the change's EXACT submitted commit, with a reference; that record is the handoff, and the event announces it. A record never moves a
-- gate, approves a release or applies a migration. Append-only history.
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.event_types (type, description, canonical) values
  ('project.maintenance_build_created', 'A person recorded a build of the exact commit of a maintenance change. AgencyOS built nothing.', true),
  ('project.maintenance_migration_prepared', 'A person recorded a prepared (not applied) database migration for a maintenance change. AgencyOS applied nothing.', true)
on conflict (type) do nothing;

create table if not exists projects.maintenance_build_records (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  work_item_id    uuid not null references projects.maintenance_work_items(id) on delete restrict,
  kind            text not null check (kind in ('build', 'migration')),
  commit_ref      text not null check (commit_ref ~ '^[0-9a-f]{40}$'),
  ref             text not null check (length(btrim(ref)) between 1 and 500),
  note            text check (note is null or length(note) <= 2000),
  recorded_by     uuid not null references core.users(id) on delete restrict,
  recorded_at     timestamptz not null default clock_timestamp(),
  unique (work_item_id, kind, ref)
);
create index if not exists maintenance_build_records_project_idx on projects.maintenance_build_records (project_id, recorded_at desc);

create or replace function projects.maintenance_build_records_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a build record is history and is never edited or deleted' using errcode = 'restrict_violation'; end $$;
drop trigger if exists maintenance_build_records_append_only on projects.maintenance_build_records;
create trigger maintenance_build_records_append_only before update or delete on projects.maintenance_build_records for each row execute function projects.maintenance_build_records_append_only();
drop trigger if exists maintenance_build_records_parent_org_work_item on projects.maintenance_build_records;
create trigger maintenance_build_records_parent_org_work_item before insert or update of work_item_id on projects.maintenance_build_records
  for each row execute function core.enforce_parent_org('work_item_id', 'projects.maintenance_work_items');
drop trigger if exists maintenance_build_records_parent_org_project on projects.maintenance_build_records;
create trigger maintenance_build_records_parent_org_project before insert or update of project_id on projects.maintenance_build_records
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_maintenance_build_records on projects.maintenance_build_records;
create trigger freeze_org_maintenance_build_records before update of organization_id on projects.maintenance_build_records
  for each row execute function core.freeze_organization_id();

alter table projects.maintenance_build_records enable row level security;
drop policy if exists maintenance_build_records_read on projects.maintenance_build_records;
create policy maintenance_build_records_read on projects.maintenance_build_records for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.maintenance_build_records from public, anon;
revoke insert, update, delete on projects.maintenance_build_records from authenticated;
grant select on projects.maintenance_build_records to authenticated;
grant all on projects.maintenance_build_records to service_role;

create or replace function projects.record_maintenance_build(p_work_item_id uuid, p_kind text, p_commit_ref text, p_ref text, p_note text default null)
returns table (outcome text, record_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_i projects.maintenance_work_items; v_id uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not (coalesce((select core.can_manage_delivery()), false) or coalesce((select core.is_admin()), false)) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_kind not in ('build', 'migration') then return query select 'invalid_kind'::text, null::uuid; return; end if;
  if length(btrim(coalesce(p_ref, ''))) = 0 then return query select 'reference_required'::text, null::uuid; return; end if;
  if projects.p8c_has_secret(p_ref) or projects.p8c_has_secret(p_note) then return query select 'secret_refused'::text, null::uuid; return; end if;
  select * into v_i from projects.maintenance_work_items w where w.id = p_work_item_id and w.organization_id = v_org for update;
  if v_i.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_i.status in ('open', 'released', 'cancelled') then return query select 'not_in_progress'::text, null::uuid; return; end if;
  if p_commit_ref is distinct from v_i.commit_ref then return query select 'commit_mismatch'::text, null::uuid; return; end if;
  if exists (select 1 from projects.maintenance_build_records b where b.work_item_id = v_i.id and b.kind = p_kind and b.ref = btrim(p_ref)) then return query select 'already_recorded'::text, null::uuid; return; end if;
  insert into projects.maintenance_build_records (organization_id, project_id, work_item_id, kind, commit_ref, ref, note, recorded_by)
    values (v_org, v_i.project_id, v_i.id, p_kind, v_i.commit_ref, btrim(p_ref), nullif(btrim(coalesce(p_note, '')), ''), v_actor) returning id into v_id;
  perform core.record_audit(v_org, 'maintenance_work.' || p_kind || '_recorded', 'maintenance_work_item', v_i.id, null, jsonb_build_object('commit', v_i.commit_ref, 'recordId', v_id));
  perform core.emit_event(v_org, case p_kind when 'build' then 'project.maintenance_build_created' else 'project.maintenance_migration_prepared' end,
    'maintenance_work_item', v_i.id, jsonb_build_object('projectId', v_i.project_id, 'commit', v_i.commit_ref, 'recordId', v_id));
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_maintenance_build(uuid, text, text, text, text) from public, anon;
grant execute on function projects.record_maintenance_build(uuid, text, text, text, text) to authenticated;
