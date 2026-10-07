-- ═══════════════════════════════════════════════════════════════════════════
-- P711: archive and retention.
--
--   COMPLETED -> ARCHIVING -> ARCHIVED, on the Phase 7 workspace (projects.phase_seven.archive_state; projects.p7b_archives is the record). The archive
--   state is a SEPARATE column, not two more values of phase_seven.state: every existing door that refuses work on a completed project tests that column
--   for 'completed' / 'phase8_ready', and widening it would have silently re-opened them for an archived project.
--
--   * projects.p7b_retention_policies   an Admin sets, per record class, how long it is retained (or that it is retained indefinitely) and whether the client
--       portal becomes read-only and for how long it stays open. NO duration is invented here: with no policy an archive cannot start. Append-only, versioned.
--   * projects.start_project_archive / finish_project_archive   an Admin. Starting needs the frozen completion record and a policy for every class, freezes
--       the project's tasks, modules, features and deliverables against edits (only a project with an archive row: a legacy project and a completed project
--       that is not archived are untouched) and snapshots the policy versions in force. ARCHIVE IS NOT DELETION.
--   * projects.client_completed_state   the client-safe read: completed / archived, the accepted handover VERSION and the completion date. Nothing internal.
--   * projects.sweep_retention_reviews   SERVICE ROLE ONLY. Marks a class eligible for a person's review when its Admin-set period has passed. It deletes
--       NOTHING and changes no record; disposal is a decision this system does not make.
-- ═══════════════════════════════════════════════════════════════════════════

alter table projects.phase_seven add column if not exists archive_state text check (archive_state in ('archiving', 'archived'));

insert into core.event_types (type, description, canonical) values
  ('project.archive_started', 'An Admin started archiving a completed project: its scope records are frozen and the Admin-set retention policy is snapshotted. Nothing is deleted.', true),
  ('project.archived', 'A completed project is ARCHIVED: read-only history, still searchable by authorized users. Archiving is not deletion.', true)
on conflict (type) do nothing;

-- ── the retention policy: DATA a person sets ───────────────────────────────
create table if not exists projects.p7b_retention_policies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  record_class     text not null check (record_class in ('contractual_documents', 'financial_records', 'source_build_references', 'approvals_audit',
                                                         'support_warranty_records', 'handover_packages', 'completion_records', 'client_portal_access')),
  version          int not null check (version > 0),
  indefinite       boolean not null,
  retention_days   int check (retention_days > 0),
  portal_read_only boolean,
  reason           text not null check (length(btrim(reason)) > 0 and not projects.p7_has_secret(reason)),
  set_by           uuid not null references core.users(id) on delete restrict,
  set_at           timestamptz not null default clock_timestamp(),
  unique (organization_id, record_class, version),
  -- a period is stated or it is "indefinite": never both, never neither
  check (indefinite = (retention_days is null)),
  -- the portal row says whether access becomes read-only; no other class has an opinion about the portal
  check ((record_class = 'client_portal_access') = (portal_read_only is not null))
);
comment on table projects.p7b_retention_policies is 'An Admin-set retention period per record class (or indefinite) and the client-portal after-completion policy. Versioned, append-only. The system holds no default: no policy, no archive.';
select projects.p7_harden('projects', 'p7b_retention_policies');
drop trigger if exists p7b_retention_policies_append_only on projects.p7b_retention_policies;
create trigger p7b_retention_policies_append_only before insert or update or delete on projects.p7b_retention_policies for each row execute function projects.p7_append_only();

-- ── the archive ────────────────────────────────────────────────────────────
create table if not exists projects.p7b_archives (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  phase_seven_id       uuid not null references projects.phase_seven(id) on delete restrict,
  completion_record_id uuid not null references projects.p7_completion_records(id) on delete restrict,
  state                text not null default 'archiving' check (state in ('archiving', 'archived')),
  -- the policy versions in force when archiving started, frozen: {"financial_records": {"version": 2, "indefinite": false, "days": 2555}, ...}
  policy_snapshot      jsonb not null check (jsonb_typeof(policy_snapshot) = 'object'),
  portal_read_only     boolean not null,
  started_by           uuid not null references core.users(id) on delete restrict,
  started_at           timestamptz not null default clock_timestamp(),
  archived_by          uuid references core.users(id) on delete restrict,
  archived_at          timestamptz,
  unique (project_id),
  check ((state = 'archived') = (archived_at is not null and archived_by is not null))
);
comment on table projects.p7b_archives is 'One per project: ARCHIVING then ARCHIVED, started and finished by an Admin. It freezes the project''s scope records and deletes nothing. The policy snapshot is what the portal and the retention sweep read.';

create or replace function projects.p7b_archive_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'an archive record is never deleted: archiving is not deletion' using errcode = 'restrict_violation'; end if;
  if coalesce(current_setting('projects.p7_door', true), '') <> 'on' then raise exception 'an archive is written through its Phase 7 door' using errcode = 'restrict_violation'; end if;
  if tg_op = 'UPDATE' then
    if old.state <> 'archiving' or new.state <> 'archived' then raise exception 'an archive moves ARCHIVING -> ARCHIVED once and never back' using errcode = 'restrict_violation'; end if;
    if (new.id, new.organization_id, new.project_id, new.phase_seven_id, new.completion_record_id, new.policy_snapshot, new.portal_read_only, new.started_by, new.started_at)
       is distinct from (old.id, old.organization_id, old.project_id, old.phase_seven_id, old.completion_record_id, old.policy_snapshot, old.portal_read_only, old.started_by, old.started_at) then
      raise exception 'only the move to ARCHIVED may change an archive record' using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
revoke all on function projects.p7b_archive_guard() from public, anon, authenticated, service_role;
drop trigger if exists p7b_archive_guard on projects.p7b_archives;
create trigger p7b_archive_guard before insert or update or delete on projects.p7b_archives for each row execute function projects.p7b_archive_guard();

-- a class becomes eligible for a person's review; nothing is deleted or changed by finding it
create table if not exists projects.p7b_retention_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  archive_id       uuid not null references projects.p7b_archives(id) on delete restrict,
  record_class     text not null,
  policy_version   int not null,
  eligible_at      timestamptz not null,
  found_at         timestamptz not null default clock_timestamp(),
  status           text not null default 'eligible_for_review' check (status = 'eligible_for_review'),
  unique (archive_id, record_class, policy_version)
);
comment on table projects.p7b_retention_reviews is 'A record class whose Admin-set retention period has passed, marked ELIGIBLE FOR REVIEW by the sweep. Nothing is deleted: disposal is a person''s decision and is not built.';

select projects.p7_guard_fk('p7b_archives', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p7b_archives', 'phase_seven_id', 'projects.phase_seven');
select projects.p7_guard_fk('p7b_archives', 'completion_record_id', 'projects.p7_completion_records');
select projects.p7_guard_fk('p7b_retention_reviews', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p7b_retention_reviews', 'archive_id', 'projects.p7b_archives');
select projects.p7_harden('projects', 'p7b_archives');
select projects.p7_harden('projects', 'p7b_retention_reviews');
drop trigger if exists p7b_retention_reviews_append_only on projects.p7b_retention_reviews;
create trigger p7b_retention_reviews_append_only before insert or update or delete on projects.p7b_retention_reviews for each row execute function projects.p7_append_only();

-- ── the freeze: an archived project's scope records are history ────────────
create or replace function projects.p7b_archive_freeze()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_project uuid := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
begin
  if exists (select 1 from projects.p7b_archives a where a.project_id = v_project) then
    raise exception 'this project is archived: its % are history and are not edited (new work is a change request or a new project)', tg_table_name using errcode = 'restrict_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function projects.p7b_archive_freeze() from public, anon, authenticated, service_role;
do $$
declare t text;
begin
  foreach t in array array['tasks', 'modules', 'features', 'deliverables', 'deliverable_details'] loop
    execute format('drop trigger if exists %I on projects.%I', 'p7b_archive_freeze_' || t, t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p7b_archive_freeze()', 'p7b_archive_freeze_' || t, t);
  end loop;
end $$;

-- ── the policy door ────────────────────────────────────────────────────────
create or replace function projects.set_retention_policy(p_record_class text, p_indefinite boolean, p_retention_days int, p_portal_read_only boolean, p_reason text)
returns table (outcome text, policy_version int)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_next int;
begin
  if v_actor is null then return query select 'no_actor'::text, 0; return; end if;
  -- a retention rule is an Admin's decision, never an agent's
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, 0; return; end if;
  if p_record_class not in ('contractual_documents', 'financial_records', 'source_build_references', 'approvals_audit', 'support_warranty_records', 'handover_packages', 'completion_records', 'client_portal_access') then return query select 'bad_record_class'::text, 0; return; end if;
  if p_indefinite is null or p_indefinite <> (p_retention_days is null) or (p_retention_days is not null and p_retention_days <= 0) then return query select 'period_or_indefinite'::text, 0; return; end if;
  if (p_record_class = 'client_portal_access') <> (p_portal_read_only is not null) then return query select 'portal_policy_only_for_portal_access'::text, 0; return; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then return query select 'reason_required'::text, 0; return; end if;
  if projects.p7_has_secret(p_reason) then return query select 'contains_secret'::text, 0; return; end if;
  perform pg_advisory_xact_lock(hashtext('p7b_retention:' || v_org::text || p_record_class));
  select coalesce(max(p.version), 0) + 1 into v_next from projects.p7b_retention_policies p where p.organization_id = v_org and p.record_class = p_record_class;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7b_retention_policies (organization_id, record_class, version, indefinite, retention_days, portal_read_only, reason, set_by)
  values (v_org, p_record_class, v_next, p_indefinite, p_retention_days, p_portal_read_only, btrim(p_reason), v_actor);
  perform core.record_audit(v_org, 'retention_policy.set', 'retention_policy', null, null, jsonb_build_object('class', p_record_class, 'version', v_next, 'indefinite', p_indefinite, 'days', p_retention_days));
  return query select 'set'::text, v_next;
end $$;
revoke all on function projects.set_retention_policy(text, boolean, int, boolean, text) from public, anon, service_role;
grant execute on function projects.set_retention_policy(text, boolean, int, boolean, text) to authenticated;

-- the latest policy per class for an organization, as one object (null for a class nobody has decided)
create or replace function projects.p7b_policy_snapshot(p_org uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(l.record_class, jsonb_build_object('version', l.version, 'indefinite', l.indefinite, 'days', l.retention_days, 'portalReadOnly', l.portal_read_only)), '{}'::jsonb)
    from (select distinct on (p.record_class) p.* from projects.p7b_retention_policies p where p.organization_id = p_org order by p.record_class, p.version desc) l
$$;
revoke all on function projects.p7b_policy_snapshot(uuid) from public, anon, authenticated, service_role;

-- ── start / finish the archive ─────────────────────────────────────────────
create or replace function projects.start_project_archive(p_project_id uuid)
returns table (outcome text, missing text[], archive_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_s projects.phase_seven; v_rec projects.p7_completion_records; v_a projects.p7b_archives; v_snap jsonb; v_missing text[]; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, '{}'::text[], null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, '{}'::text[], null::uuid; return; end if;
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id and s.organization_id = v_org for update;
  if v_s.id is null then return query select 'not_found'::text, '{}'::text[], null::uuid; return; end if;
  select * into v_a from projects.p7b_archives a where a.project_id = p_project_id;
  if v_a.id is not null then return query select case v_a.state when 'archived' then 'already_archived' else 'already_archiving' end::text, '{}'::text[], v_a.id; return; end if;
  -- only a COMPLETED pipeline project, evidenced by its immutable completion record, is archived
  select * into v_rec from projects.p7_completion_records r where r.project_id = p_project_id;
  if v_rec.id is null or not exists (select 1 from projects.projects p where p.id = p_project_id and p.status = 'completed') then return query select 'not_completed'::text, '{}'::text[], null::uuid; return; end if;
  -- the retention rules are validated before anything is frozen: a policy for every class, set by a person
  v_snap := projects.p7b_policy_snapshot(v_org);
  select coalesce(array_agg(c order by c), '{}') into v_missing from unnest(array['contractual_documents', 'financial_records', 'source_build_references', 'approvals_audit', 'support_warranty_records', 'handover_packages', 'completion_records', 'client_portal_access']) c where not (v_snap ? c);
  if cardinality(v_missing) > 0 then return query select 'no_retention_policy'::text, v_missing, null::uuid; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7b_archives (organization_id, project_id, phase_seven_id, completion_record_id, policy_snapshot, portal_read_only, started_by)
  values (v_org, p_project_id, v_s.id, v_rec.id, v_snap, coalesce((v_snap -> 'client_portal_access' ->> 'portalReadOnly')::boolean, false), v_actor) returning id into v_new;
  update projects.phase_seven set archive_state = 'archiving' where id = v_s.id;
  perform core.record_audit(v_org, 'project.archive_started', 'project', p_project_id, null, jsonb_build_object('archiveId', v_new, 'completionRecordId', v_rec.id));
  perform core.emit_event(v_org, 'project.archive_started', 'project', p_project_id, jsonb_build_object('projectId', p_project_id, 'archiveId', v_new));
  return query select 'started'::text, '{}'::text[], v_new;
end $$;
revoke all on function projects.start_project_archive(uuid) from public, anon, service_role;
grant execute on function projects.start_project_archive(uuid) to authenticated;

create or replace function projects.finish_project_archive(p_project_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_a projects.p7b_archives;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_a from projects.p7b_archives a where a.project_id = p_project_id and a.organization_id = v_org for update;
  if v_a.id is null then return query select 'not_archiving'::text; return; end if;
  if v_a.state = 'archived' then return query select 'already_archived'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  update projects.p7b_archives set state = 'archived', archived_at = clock_timestamp(), archived_by = v_actor where id = v_a.id;
  update projects.phase_seven set archive_state = 'archived' where project_id = p_project_id;
  perform core.record_audit(v_org, 'project.archived', 'project', p_project_id, null, jsonb_build_object('archiveId', v_a.id));
  perform core.emit_event(v_org, 'project.archived', 'project', p_project_id, jsonb_build_object('projectId', p_project_id, 'archiveId', v_a.id));
  return query select 'archived'::text;
end $$;
revoke all on function projects.finish_project_archive(uuid) from public, anon, service_role;
grant execute on function projects.finish_project_archive(uuid) to authenticated;

-- ── the client-safe completed / read-only state ────────────────────────────
-- A client reads only its own account's project; sees the lifecycle word, the accepted handover VERSION and the completion date, and whether the portal is
-- open, read-only or past its Admin-set expiry. No internal id, note, evidence, policy reason or person is exposed.
create or replace function projects.client_completed_state(p_project_id uuid)
returns table (lifecycle text, portal_access text, completed_at timestamptz, archived_at timestamptz, accepted_version int, accepted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_p projects.projects; v_rec projects.p7_completion_records; v_a projects.p7b_archives; v_acc projects.p7_client_acceptances;
  v_days int; v_access text := 'open';
begin
  select * into v_p from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_p.id is null or v_p.organization_id is distinct from v_org then return; end if;
  if coalesce((select core.is_client()), false) then
    if v_p.client_account_id is distinct from (select core.current_client_account_id()) then return; end if;
  elsif not coalesce((select core.is_internal()), false) then
    return;
  end if;
  select * into v_rec from projects.p7_completion_records r where r.project_id = p_project_id;
  if v_rec.id is null then return query select 'in_progress'::text, 'open'::text, null::timestamptz, null::timestamptz, null::int, null::timestamptz; return; end if;
  select * into v_a from projects.p7b_archives a where a.project_id = p_project_id;
  select * into v_acc from projects.p7_client_acceptances x where x.id = v_rec.acceptance_id;
  if v_a.id is not null then
    v_access := case when v_a.portal_read_only then 'read_only' else 'open' end;
    v_days := (v_a.policy_snapshot -> 'client_portal_access' ->> 'days')::int;
    if v_days is not null and v_a.archived_at is not null and v_a.archived_at + make_interval(days => v_days) <= clock_timestamp() then v_access := 'expired'; end if;
  end if;
  return query select case when v_a.state = 'archived' then 'archived' else 'completed' end::text, v_access, v_rec.completed_at, v_a.archived_at, v_acc.package_version, v_acc.recorded_at;
end $$;
revoke all on function projects.client_completed_state(uuid) from public, anon;
grant execute on function projects.client_completed_state(uuid) to authenticated;

-- ── the retention sweep (service role): marks eligibility, deletes nothing ──
create or replace function projects.sweep_retention_reviews(p_now timestamptz default null)
returns table (outcome text, marked int)
language plpgsql security definer set search_path = '' as $$
declare r record; c record; v_n int := 0; v_now timestamptz := coalesce(p_now, clock_timestamp()); v_id uuid; v_due timestamptz;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, 0; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  for r in select a.id, a.organization_id, a.project_id, a.archived_at, a.policy_snapshot from projects.p7b_archives a where a.state = 'archived' order by a.archived_at loop
    for c in select e.key as record_class, (e.value ->> 'version')::int as version, (e.value ->> 'days')::int as days, (e.value ->> 'indefinite')::boolean as indefinite
               from jsonb_each(r.policy_snapshot) e where e.key <> 'client_portal_access' loop
      if c.indefinite or c.days is null then continue; end if;
      v_due := r.archived_at + make_interval(days => c.days);
      if v_due > v_now then continue; end if;
      v_id := null;
      insert into projects.p7b_retention_reviews (organization_id, project_id, archive_id, record_class, policy_version, eligible_at)
      values (r.organization_id, r.project_id, r.id, c.record_class, c.version, v_due) on conflict (archive_id, record_class, policy_version) do nothing returning id into v_id;
      if v_id is not null then
        v_n := v_n + 1;
        perform core.record_audit(r.organization_id, 'retention.eligible_for_review', 'project', r.project_id, null, jsonb_build_object('class', c.record_class, 'policyVersion', c.version));
      end if;
    end loop;
  end loop;
  return query select 'swept'::text, v_n;
end $$;
revoke all on function projects.sweep_retention_reviews(timestamptz) from public, anon, authenticated;
grant execute on function projects.sweep_retention_reviews(timestamptz) to service_role;

notify pgrst, 'reload schema';
