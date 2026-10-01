-- A build, a test run and a bug can carry an uploaded file (round 3, owner
-- decisions Q-C1 and Q-C6 of 2026-10-01).
--
--   Q-C1  SCR-037 "Upload build" also accepts a build file (apk / ipa / zip)
--         under the project-file limits and the credentials guard.
--   Q-C6  Test-run and bug evidence may be uploaded files (screenshots, logs)
--         under the same project-file rules.
--
-- WHERE THE BYTES ARE. In the project-files bucket the application already
-- stores project files in, under the tenant's own first folder, which is what
-- that bucket's storage policies check (20260930110000):
--
--     <organization_id>/builds/<deliverable id>/<safe file name>
--     <organization_id>/evidence/<test run or defect id>/<safe file name>
--
-- THE ROW names the object; it never holds bytes. `projects.attached_files`
-- is append-only: written only by `projects.attach_file`, never edited, never
-- deleted by a person (a test run is evidence and a closed one never changes;
-- this adds beside it). The door re-checks the role, the tenant, the kind of
-- file, the size and the path, and audits. The same limits the application
-- applies first (50 MB; a credentials-looking name is refused) are held HERE
-- as well, so a caller that skips the application cannot file what the
-- application would refuse.
--
-- Additive and idempotent.

create table if not exists projects.attached_files (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organizations(id) on delete cascade,
  project_id      uuid not null references projects.projects(id) on delete cascade,
  subject_kind    text not null check (subject_kind in ('build', 'test_run', 'defect')),
  -- The deliverable, test run or defect the file belongs to. Polymorphic, so no
  -- foreign key; the door looks the subject up in the caller's own tenant.
  subject_id      uuid not null,
  storage_path    text not null check (length(storage_path) between 1 and 600),
  file_name       text not null check (length(btrim(file_name)) between 1 and 200),
  content_type    text check (content_type is null or length(content_type) <= 150),
  size_bytes      bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  uploaded_by     uuid references core.users(id) on delete set null,
  created_at      timestamptz not null default now(),

  -- The first folder is the tenant (what the bucket policy checks), the second
  -- the kind of area, the third the subject: a path cannot name another tenant
  -- or another record.
  constraint attached_files_path_is_tenant_scoped check (
    split_part(storage_path, '/', 1) = organization_id::text
    and split_part(storage_path, '/', 2) = case subject_kind when 'build' then 'builds' else 'evidence' end
    and split_part(storage_path, '/', 3) = subject_id::text
  ),
  -- A build is an app package; evidence is a screenshot, a log, a report or a recording.
  constraint attached_files_kind_of_file check (
    case subject_kind
      when 'build' then lower(file_name) ~ '\.(apk|ipa|zip)$'
      else lower(file_name) ~ '\.(png|jpe?g|gif|webp|heic|txt|log|md|json|csv|xml|html|pdf|zip|har|mp4|mov|webm)$'
    end
  )
);

create index if not exists attached_files_subject_idx
  on projects.attached_files (organization_id, subject_kind, subject_id, created_at);
create index if not exists attached_files_project_idx
  on projects.attached_files (project_id, created_at desc);

alter table projects.attached_files enable row level security;
alter table projects.attached_files force row level security;

drop policy if exists attached_files_select on projects.attached_files;
create policy attached_files_select on projects.attached_files
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

revoke all on projects.attached_files from public, anon;
revoke insert, update, delete on projects.attached_files from authenticated;
grant select on projects.attached_files to authenticated;
grant select, insert, update, delete on projects.attached_files to service_role;

drop trigger if exists org_match_attached_files_project on projects.attached_files;
create trigger org_match_attached_files_project
  before insert or update of project_id, organization_id on projects.attached_files
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists freeze_org_attached_files on projects.attached_files;
create trigger freeze_org_attached_files
  before update of organization_id on projects.attached_files
  for each row execute function core.freeze_organization_id();

comment on table projects.attached_files is
  'Q-C1 / Q-C6: an uploaded file that belongs to a build (apk, ipa, zip), a test run or a defect (screenshots, logs). The object is in the project-files bucket under <organization>/builds|evidence/<subject>/; this row names it. Append-only, written only by projects.attach_file.';

create or replace function projects.attach_file(
  p_subject_kind text,
  p_subject_id   uuid,
  p_storage_path text,
  p_file_name    text,
  p_content_type text default null,
  p_size_bytes   bigint default null
)
returns table (outcome text, id uuid, project_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_name    text := btrim(coalesce(p_file_name, ''));
  v_project uuid;
  v_area    text;
  v_count   integer;
  v_limit   integer;
  v_id      uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;
  if p_subject_kind is null or p_subject_kind not in ('build', 'test_run', 'defect') then
    return query select 'bad_kind'::text, null::uuid, null::uuid; return;
  end if;

  -- The roles that may write the thing the file belongs to: a build or a defect
  -- is delivery work (owner, ops admin, delivery lead); a test run is recorded
  -- by anyone who may write (members included), as qa.add_run_evidence is.
  if p_subject_kind = 'test_run' then
    if not coalesce((select core.can_write()), false) then
      return query select 'forbidden'::text, null::uuid, null::uuid; return;
    end if;
  elsif not coalesce((select core.can_manage_delivery()), false) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;

  if p_subject_kind = 'build' then
    select d.project_id into v_project from projects.deliverables d
     where d.id = p_subject_id and d.organization_id = v_org and d.kind in ('build', 'prototype');
    v_area := 'builds'; v_limit := 5;
  elsif p_subject_kind = 'test_run' then
    select r.project_id into v_project from qa.test_runs r
     where r.id = p_subject_id and r.organization_id = v_org;
    v_area := 'evidence'; v_limit := 20;
  else
    select f.project_id into v_project from qa.defects f
     where f.id = p_subject_id and f.organization_id = v_org;
    v_area := 'evidence'; v_limit := 20;
  end if;
  if v_project is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;

  if length(v_name) = 0 or length(v_name) > 200 or v_name ~ '[/\\]' then
    return query select 'bad_name'::text, null::uuid, null::uuid; return;
  end if;
  -- The credentials guard's names (src/modules/projects/file-secrets-guard.ts),
  -- held here too: a credentials file is not a project file.
  if v_name ~* '(^|[/\\])\.env(\.[a-z0-9_.-]+)?$'
     or v_name ~* '\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$'
     or v_name ~* '^(credentials|secrets?|passwords?)(\.[a-z0-9]+)?$'
     or v_name ~* '^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$'
     or v_name ~* 'service[-_]?account.*\.json$' then
    return query select 'credential_name'::text, null::uuid, null::uuid; return;
  end if;
  if p_subject_kind = 'build' then
    if lower(v_name) !~ '\.(apk|ipa|zip)$' then
      return query select 'bad_type'::text, null::uuid, null::uuid; return;
    end if;
  elsif lower(v_name) !~ '\.(png|jpe?g|gif|webp|heic|txt|log|md|json|csv|xml|html|pdf|zip|har|mp4|mov|webm)$' then
    return query select 'bad_type'::text, null::uuid, null::uuid; return;
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 then
    return query select 'bad_size'::text, null::uuid, null::uuid; return;
  end if;
  if p_size_bytes > 52428800 then
    return query select 'too_big'::text, null::uuid, null::uuid; return;
  end if;
  if p_storage_path is null
     or length(p_storage_path) > 600
     or split_part(p_storage_path, '/', 1) <> v_org::text
     or split_part(p_storage_path, '/', 2) <> v_area
     or split_part(p_storage_path, '/', 3) <> p_subject_id::text
     or split_part(p_storage_path, '/', 4) = '' then
    return query select 'bad_path'::text, null::uuid, null::uuid; return;
  end if;

  select count(*) into v_count from projects.attached_files a
   where a.subject_kind = p_subject_kind and a.subject_id = p_subject_id;
  if v_count >= v_limit then
    return query select 'too_many'::text, null::uuid, null::uuid; return;
  end if;

  insert into projects.attached_files
    (organization_id, project_id, subject_kind, subject_id, storage_path, file_name, content_type, size_bytes, uploaded_by)
  values
    (v_org, v_project, p_subject_kind, p_subject_id, p_storage_path, v_name,
     nullif(btrim(coalesce(p_content_type, '')), ''), p_size_bytes, v_actor)
  returning projects.attached_files.id into v_id;

  perform core.record_audit(
    v_org, 'project.file_attached', p_subject_kind, p_subject_id, null,
    jsonb_build_object('attachment_id', v_id, 'file_name', v_name, 'size_bytes', p_size_bytes, 'project_id', v_project)
  );

  return query select 'attached'::text, v_id, v_project;
end;
$$;

revoke all on function projects.attach_file(text, uuid, text, text, text, bigint) from public, anon;
grant execute on function projects.attach_file(text, uuid, text, text, text, bigint) to authenticated, service_role;

comment on function projects.attach_file(text, uuid, text, text, text, bigint) is
  'Q-C1 / Q-C6: records an uploaded file against a build (apk, ipa, zip; delivery roles), a test run (anyone who may write) or a defect (delivery roles). Re-checks the role, the tenant, the kind of file, the 50 MB limit, a credentials-looking name and that the path is <organization>/builds|evidence/<subject>/<name>. Audits project.file_attached. The object is stored by the application first; this door never receives bytes.';

notify pgrst, 'reload schema';
