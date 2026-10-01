-- Meeting-note upload also accepts recordings, images, PDF and Word files
-- (round 3, owner decision Q-D3 of 2026-10-01: "Meeting-note upload also
-- accepts recordings, images, PDF and Word under the project-file rules").
--
-- Until now only text could be kept as meeting evidence, because the evidence
-- door stores text and a reference and no signed store existed for a file
-- (G-229). The project-files bucket is that store now. A recording, an image,
-- a PDF or a Word file is stored under the tenant's own folder:
--
--     <organization_id>/meetings/<meeting id>/<safe file name>
--
-- and its evidence row carries the PATH (storage_path) and the file's name
-- (file_name); the existing artifact_ref, media_type and byte_size say what it
-- is. Text files are unchanged: their text stays the row's body, verbatim.
--
-- `crm.add_meeting_evidence_file` is the one door for a stored file. It files
-- the row THROUGH `crm.add_meeting_evidence` (so the role, the tenant, the
-- kind vocabulary and the meeting.evidence_added audit row are the same ones
-- every other evidence takes) and then records where the object is. It holds
-- the project-file rules itself: 50 MB, a credentials-looking name refused,
-- the extension must suit the kind, the path must be this tenant's and this
-- meeting's.
--
-- Additive and idempotent.

alter table crm.meeting_evidence add column if not exists storage_path text;
alter table crm.meeting_evidence add column if not exists file_name text;

alter table crm.meeting_evidence drop constraint if exists meeting_evidence_path_is_tenant_scoped;
alter table crm.meeting_evidence add constraint meeting_evidence_path_is_tenant_scoped check (
  storage_path is null
  or (length(storage_path) <= 600
      and split_part(storage_path, '/', 1) = organization_id::text
      and split_part(storage_path, '/', 2) = 'meetings'
      and split_part(storage_path, '/', 3) = meeting_id::text)
);

alter table crm.meeting_evidence drop constraint if exists meeting_evidence_stored_file_is_named;
alter table crm.meeting_evidence add constraint meeting_evidence_stored_file_is_named check (
  storage_path is null or (file_name is not null and length(btrim(file_name)) between 1 and 200)
);

comment on column crm.meeting_evidence.storage_path is
  'Q-D3: object key of an uploaded recording, image, PDF or Word file in the project-files bucket (<organization>/meetings/<meeting>/<name>). Null for typed notes and for a text file, whose text is the body.';

create or replace function crm.add_meeting_evidence_file(
  p_meeting_id   uuid,
  p_kind         text,
  p_visibility   text,
  p_storage_path text,
  p_file_name    text,
  p_media_type   text default null,
  p_byte_size    bigint default null
)
returns table (outcome text, evidence_id uuid, lead_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_org     uuid := (select core.current_organization_id());
  v_name    text := btrim(coalesce(p_file_name, ''));
  v_meeting uuid;
  v_filed   text;
  v_evid    uuid;
  v_lead    uuid;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, null::uuid, null::uuid; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid, null::uuid; return;
  end if;
  select m.id into v_meeting from crm.meetings m where m.id = p_meeting_id and m.organization_id = v_org;
  if v_meeting is null then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;

  -- Only a stored file comes through here; typed notes and text files use the
  -- evidence door directly.
  if p_kind is null or p_kind not in ('recording', 'image', 'document') then
    return query select 'invalid_kind'::text, null::uuid, null::uuid; return;
  end if;
  if length(v_name) = 0 or length(v_name) > 200 or v_name ~ '[/\\]' then
    return query select 'bad_name'::text, null::uuid, null::uuid; return;
  end if;
  if v_name ~* '(^|[/\\])\.env(\.[a-z0-9_.-]+)?$'
     or v_name ~* '\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk)$'
     or v_name ~* '^(credentials|secrets?|passwords?)(\.[a-z0-9]+)?$'
     or v_name ~* '^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$'
     or v_name ~* 'service[-_]?account.*\.json$' then
    return query select 'credential_name'::text, null::uuid, null::uuid; return;
  end if;
  if not (case p_kind
            when 'recording' then lower(v_name) ~ '\.(mp3|m4a|wav|ogg|aac|mp4|m4v|mov|webm)$'
            when 'image'     then lower(v_name) ~ '\.(png|jpe?g|gif|webp|heic)$'
            else                  lower(v_name) ~ '\.(pdf|docx?)$'
          end) then
    return query select 'bad_type'::text, null::uuid, null::uuid; return;
  end if;
  if p_byte_size is null or p_byte_size <= 0 then
    return query select 'invalid_size'::text, null::uuid, null::uuid; return;
  end if;
  if p_byte_size > 52428800 then
    return query select 'too_big'::text, null::uuid, null::uuid; return;
  end if;
  if p_storage_path is null
     or length(p_storage_path) > 600
     or split_part(p_storage_path, '/', 1) <> v_org::text
     or split_part(p_storage_path, '/', 2) <> 'meetings'
     or split_part(p_storage_path, '/', 3) <> p_meeting_id::text
     or split_part(p_storage_path, '/', 4) = '' then
    return query select 'bad_path'::text, null::uuid, null::uuid; return;
  end if;

  select e.outcome, e.evidence_id, e.lead_id into v_filed, v_evid, v_lead
    from crm.add_meeting_evidence(p_meeting_id, p_kind, null, p_visibility, 'uploaded file: ' || left(v_name, 200), p_media_type, p_byte_size) e;
  if v_filed is distinct from 'attached' then
    return query select coalesce(v_filed, 'refused'), null::uuid, v_lead; return;
  end if;

  update crm.meeting_evidence set storage_path = p_storage_path, file_name = v_name where id = v_evid;

  return query select 'attached'::text, v_evid, v_lead;
end;
$$;

revoke all on function crm.add_meeting_evidence_file(uuid, text, text, text, text, text, bigint) from public, anon;
grant execute on function crm.add_meeting_evidence_file(uuid, text, text, text, text, text, bigint) to authenticated, service_role;

comment on function crm.add_meeting_evidence_file(uuid, text, text, text, text, text, bigint) is
  'Q-D3: files an uploaded recording, image, PDF or Word file as meeting evidence. Same role, tenant, kind vocabulary and meeting.evidence_added audit as crm.add_meeting_evidence (it files through it), plus the project-file rules: 50 MB, no credentials-looking name, an extension that suits the kind, and a path under <organization>/meetings/<meeting>/. Records the object path on the row.';

notify pgrst, 'reload schema';
