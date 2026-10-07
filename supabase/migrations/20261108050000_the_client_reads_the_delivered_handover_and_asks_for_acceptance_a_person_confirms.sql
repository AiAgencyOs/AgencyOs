-- ═══════════════════════════════════════════════════════════════════════════
-- P707 / P708: the client-facing handover SURFACE.
--
-- What the specifications allow, implemented exactly:
--   * the CLIENT reviews the delivered handover package version (P707 §9, P708 §5) and may ask questions or request corrections;
--   * the client ACCEPTS, and STAFF RECORD it with formal evidence for the exact version (P708 §6; ADM-08d: a client decides, a person records). A click in
--     the portal is therefore NOT an acceptance. It is a REQUEST ROW (projects.p7b_portal_requests) a person with delivery rights CONFIRMS or DECLINES
--     (projects.settle_portal_handover_request); only a confirmation calls the existing record_client_acceptance door, with the evidence kind
--     'portal_confirmation' and a person's own verification as the evidence reference. The completion gate reads p7_client_acceptances, never a request.
--   * downloads and access are logged where policy requires (P707 §9): projects.p7b_handover_access_log, append-only, written by log_handover_access.
--
-- The client reads through SECURITY DEFINER functions that expose ONLY: the current DELIVERED version, its READY items, access RECEIPTS without any reference
-- value, and the acceptance state. Internal notes, evidence references, reviews, other versions, feedback routing and every other tenant are not reachable.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.handover_acceptance_requested', 'A client asked, in the portal, to accept (or to change) the delivered handover version. It is a REQUEST: a person confirms it with evidence before it is an acceptance.', true)
on conflict (type) do nothing;

-- ── tables (the client never writes them directly: only the doors below) ───
create table if not exists projects.p7b_handover_access_log (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  package_id        uuid not null references projects.p7_handover_packages(id) on delete restrict,
  package_version   int not null,
  event             text not null check (event in ('viewed', 'item_opened')),
  item_kind         text,
  actor_user        uuid not null references core.users(id) on delete restrict,
  at                timestamptz not null default clock_timestamp(),
  check ((event = 'item_opened') = (item_kind is not null))
);
comment on table projects.p7b_handover_access_log is 'Who opened the delivered handover package, and which item, when. Append-only; written only by log_handover_access.';

create table if not exists projects.p7b_portal_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  package_id        uuid not null references projects.p7_handover_packages(id) on delete restrict,
  package_version   int not null,
  commit_ref        text not null,
  kind              text not null check (kind in ('acceptance_request', 'changes_request')),
  note              text check (not projects.p7_has_secret(note)),
  requested_by      uuid not null references core.users(id) on delete restrict,
  requested_name    text not null check (length(btrim(requested_name)) > 0 and not projects.p7_has_secret(requested_name)),
  requested_at      timestamptz not null default clock_timestamp(),
  unique (package_id, requested_by, kind),
  check (kind = 'acceptance_request' or (note is not null and length(btrim(note)) > 0))
);
comment on table projects.p7b_portal_requests is 'A client''s request, made in the portal, to accept or to change the exact delivered handover version. NOT an acceptance: p7_client_acceptances (recorded by a person with evidence) is the only thing the completion gate reads.';

create table if not exists projects.p7b_portal_request_settlements (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  request_id       uuid not null unique references projects.p7b_portal_requests(id) on delete restrict,
  decision         text not null check (decision in ('confirmed', 'declined')),
  acceptance_id    uuid references projects.p7_client_acceptances(id) on delete restrict,
  note             text check (not projects.p7_has_secret(note)),
  decided_by       uuid not null references core.users(id) on delete restrict,
  decided_at       timestamptz not null default clock_timestamp(),
  check ((decision = 'confirmed') = (acceptance_id is not null)),
  check (decision = 'confirmed' or (note is not null and length(btrim(note)) > 0))
);
comment on table projects.p7b_portal_request_settlements is 'A person''s answer to a portal request: confirmed (and the formal acceptance it produced) or declined with a reason. Append-only.';

select projects.p7_guard_fk('p7b_handover_access_log', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p7b_handover_access_log', 'client_account_id', 'core.client_accounts');
select projects.p7_guard_fk('p7b_handover_access_log', 'package_id', 'projects.p7_handover_packages');
select projects.p7_guard_fk('p7b_portal_requests', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p7b_portal_requests', 'client_account_id', 'core.client_accounts');
select projects.p7_guard_fk('p7b_portal_requests', 'package_id', 'projects.p7_handover_packages');
select projects.p7_guard_fk('p7b_portal_request_settlements', 'request_id', 'projects.p7b_portal_requests');
select projects.p7_guard_fk('p7b_portal_request_settlements', 'acceptance_id', 'projects.p7_client_acceptances');
select projects.p7_harden('projects', 'p7b_handover_access_log');
select projects.p7_harden('projects', 'p7b_portal_requests');
select projects.p7_harden('projects', 'p7b_portal_request_settlements');
do $$
declare t text;
begin
  foreach t in array array['p7b_handover_access_log', 'p7b_portal_requests', 'p7b_portal_request_settlements'] loop
    execute format('drop trigger if exists %I on projects.%I', t || '_append_only', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p7_append_only()', t || '_append_only', t);
  end loop;
end $$;

-- ── who may read / act (one definition for every door) ─────────────────────
-- the portal caller's project, or null. A client sees only its own account's project; an internal user of the same organization may preview.
create or replace function projects.p7b_portal_project(p_project_id uuid)
returns projects.projects language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.projects;
begin
  select * into v_p from projects.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_p.id is null or v_p.organization_id is distinct from (select core.current_organization_id()) then return null; end if;
  if coalesce((select core.is_client()), false) then
    if v_p.client_account_id is distinct from (select core.current_client_account_id()) then return null; end if;
  elsif not coalesce((select core.is_internal()), false) then
    return null;
  end if;
  return v_p;
end $$;
revoke all on function projects.p7b_portal_project(uuid) from public, anon, authenticated, service_role;

-- 'open' | 'read_only' | 'expired' for a project's portal, from the archive's frozen policy snapshot
create or replace function projects.p7b_portal_access(p_project_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_a projects.p7b_archives; v_days int;
begin
  select * into v_a from projects.p7b_archives a where a.project_id = p_project_id;
  if v_a.id is null then return 'open'; end if;
  v_days := (v_a.policy_snapshot -> 'client_portal_access' ->> 'days')::int;
  if v_days is not null and v_a.archived_at is not null and v_a.archived_at + make_interval(days => v_days) <= clock_timestamp() then return 'expired'; end if;
  return case when v_a.portal_read_only then 'read_only' else 'open' end;
end $$;
revoke all on function projects.p7b_portal_access(uuid) from public, anon, authenticated, service_role;

-- ── the client-safe reads ──────────────────────────────────────────────────
create or replace function projects.client_handover_overview(p_project_id uuid)
returns table (package_id uuid, version int, delivered_at timestamptz, production_url text, support_terms text, warranty_ends_on date, emergency_contacts text,
               acceptance_state text, decision_recorded_at timestamptz, request_state text, portal_access text, project_completed boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p projects.projects; v_pkg projects.p7_handover_packages; v_s projects.phase_seven; v_acc projects.p7_client_acceptances; v_req projects.p7b_portal_requests; v_access text;
begin
  v_p := projects.p7b_portal_project(p_project_id);
  if v_p.id is null then return; end if;
  v_access := projects.p7b_portal_access(p_project_id);
  if v_access = 'expired' then return; end if;
  -- ONLY the current DELIVERED version: a draft, a version under review and a superseded version do not exist for the client
  select * into v_pkg from projects.p7_handover_packages k where k.project_id = p_project_id and k.status = 'delivered';
  if v_pkg.id is null then return; end if;
  select * into v_s from projects.phase_seven s where s.project_id = p_project_id;
  select * into v_acc from projects.p7_client_acceptances a where a.package_id = v_pkg.id order by a.recorded_at desc limit 1;
  select * into v_req from projects.p7b_portal_requests r where r.package_id = v_pkg.id and r.client_account_id = v_p.client_account_id
     and not exists (select 1 from projects.p7b_portal_request_settlements z where z.request_id = r.id) order by r.requested_at desc limit 1;
  return query select v_pkg.id, v_pkg.version, v_pkg.delivered_at, v_pkg.production_url, v_pkg.support_terms, v_pkg.warranty_ends_on, v_pkg.emergency_contacts,
    case when v_acc.id is not null then v_acc.decision when v_s.client_acceptance_required then 'awaiting' else 'not_required' end::text,
    v_acc.recorded_at,
    case when v_req.id is null then 'none' else 'awaiting_confirmation' end::text,
    v_access,
    exists (select 1 from projects.p7_completion_records c where c.project_id = p_project_id);
end $$;
revoke all on function projects.client_handover_overview(uuid) from public, anon;
grant execute on function projects.client_handover_overview(uuid) to authenticated;

create or replace function projects.client_handover_items(p_project_id uuid)
returns table (kind text, label text, artifact_ref text, required boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.projects; v_pkg projects.p7_handover_packages;
begin
  v_p := projects.p7b_portal_project(p_project_id);
  if v_p.id is null or projects.p7b_portal_access(p_project_id) = 'expired' then return; end if;
  select * into v_pkg from projects.p7_handover_packages k where k.project_id = p_project_id and k.status = 'delivered';
  if v_pkg.id is null then return; end if;
  -- only DELIVERED items (ready): never a pending item, an exclusion reason or an evidence reference
  return query select i.kind, i.label, i.artifact_ref, i.required from projects.p7_handover_items i where i.package_id = v_pkg.id and i.status = 'ready' order by i.kind;
end $$;
revoke all on function projects.client_handover_items(uuid) from public, anon;
grant execute on function projects.client_handover_items(uuid) to authenticated;

-- an access RECEIPT: which system, how it was handed over, whether it is done. No evidence reference, no note, no value of any kind.
create or replace function projects.client_handover_access_receipts(p_project_id uuid)
returns table (system_name text, kind text, method text, status text, from_party text, to_party text, credentials_rotated boolean, support_access_retained boolean)
language plpgsql stable security definer set search_path = '' as $$
declare v_p projects.projects; v_pkg projects.p7_handover_packages;
begin
  v_p := projects.p7b_portal_project(p_project_id);
  if v_p.id is null or projects.p7b_portal_access(p_project_id) = 'expired' then return; end if;
  select * into v_pkg from projects.p7_handover_packages k where k.project_id = p_project_id and k.status = 'delivered';
  if v_pkg.id is null then return; end if;
  return query select t.system_name, t.kind, t.method, t.status, t.from_party, t.to_party, t.temporary_credentials_rotated, t.support_access_retained
    from projects.p7_access_transfers t where t.package_id = v_pkg.id order by t.system_name;
end $$;
revoke all on function projects.client_handover_access_receipts(uuid) from public, anon;
grant execute on function projects.client_handover_access_receipts(uuid) to authenticated;

-- ── logging an access (client only) ────────────────────────────────────────
create or replace function projects.log_handover_access(p_package_id uuid, p_event text, p_item_kind text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_pkg projects.p7_handover_packages; v_p projects.projects;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  -- the log is the CLIENT's access log: staff previewing the page are not logged as the client
  if not coalesce((select core.is_client()), false) then return query select 'not_a_client'::text; return; end if;
  if p_event not in ('viewed', 'item_opened') or (p_event = 'item_opened') <> (p_item_kind is not null) then return query select 'bad_event'::text; return; end if;
  select * into v_pkg from projects.p7_handover_packages k where k.id = p_package_id;
  if v_pkg.id is null then return query select 'not_found'::text; return; end if;
  v_p := projects.p7b_portal_project(v_pkg.project_id);
  if v_p.id is null then return query select 'not_found'::text; return; end if;
  if projects.p7b_portal_access(v_pkg.project_id) = 'expired' then return query select 'portal_access_expired'::text; return; end if;
  if v_pkg.status <> 'delivered' then return query select 'not_delivered'::text; return; end if;
  if p_event = 'item_opened' and not exists (select 1 from projects.p7_handover_items i where i.package_id = v_pkg.id and i.kind = p_item_kind and i.status = 'ready') then return query select 'not_a_delivered_item'::text; return; end if;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7b_handover_access_log (organization_id, project_id, client_account_id, package_id, package_version, event, item_kind, actor_user)
  values (v_pkg.organization_id, v_pkg.project_id, v_p.client_account_id, v_pkg.id, v_pkg.version, p_event, p_item_kind, v_actor);
  return query select 'logged'::text;
end $$;
revoke all on function projects.log_handover_access(uuid, text, text) from public, anon, service_role;
grant execute on function projects.log_handover_access(uuid, text, text) to authenticated;

-- ── the client asks; it is a REQUEST ───────────────────────────────────────
create or replace function projects.request_handover_acceptance(p_package_id uuid, p_kind text, p_note text default null)
returns table (outcome text, request_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_pkg projects.p7_handover_packages; v_p projects.projects; v_name text; v_new uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_client()), false) then return query select 'not_a_client'::text, null::uuid; return; end if;
  if p_kind not in ('acceptance_request', 'changes_request') then return query select 'bad_kind'::text, null::uuid; return; end if;
  if p_kind = 'changes_request' and (p_note is null or length(btrim(p_note)) = 0) then return query select 'note_required'::text, null::uuid; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text, null::uuid; return; end if;
  select * into v_pkg from projects.p7_handover_packages k where k.id = p_package_id;
  if v_pkg.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  v_p := projects.p7b_portal_project(v_pkg.project_id);
  if v_p.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  -- a read-only or expired portal accepts no write; a completed project has its acceptance already
  if projects.p7b_portal_access(v_pkg.project_id) <> 'open' then return query select 'portal_read_only'::text, null::uuid; return; end if;
  if exists (select 1 from projects.p7_completion_records c where c.project_id = v_pkg.project_id) then return query select 'project_completed'::text, null::uuid; return; end if;
  if v_pkg.status = 'superseded' then return query select 'package_superseded'::text, null::uuid; return; end if;
  if v_pkg.status <> 'delivered' then return query select 'not_delivered'::text, null::uuid; return; end if;
  select coalesce(nullif(btrim(u.full_name), ''), u.email, 'portal user') into v_name from core.users u where u.id = v_actor;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7b_portal_requests (organization_id, project_id, client_account_id, package_id, package_version, commit_ref, kind, note, requested_by, requested_name)
  values (v_pkg.organization_id, v_pkg.project_id, v_p.client_account_id, v_pkg.id, v_pkg.version, v_pkg.commit_ref, p_kind, nullif(btrim(coalesce(p_note, '')), ''), v_actor, v_name)
  on conflict (package_id, requested_by, kind) do nothing returning id into v_new;
  if v_new is null then return query select 'already_requested'::text, null::uuid; return; end if;
  perform core.record_audit(v_pkg.organization_id, 'handover_acceptance.requested', 'handover_package', v_pkg.id, null, jsonb_build_object('projectId', v_pkg.project_id, 'version', v_pkg.version, 'kind', p_kind));
  perform core.emit_event(v_pkg.organization_id, 'project.handover_acceptance_requested', 'handover_package', v_pkg.id, jsonb_build_object('projectId', v_pkg.project_id, 'version', v_pkg.version, 'requestId', v_new));
  return query select 'requested'::text, v_new;
end $$;
revoke all on function projects.request_handover_acceptance(uuid, text, text) from public, anon, service_role;
grant execute on function projects.request_handover_acceptance(uuid, text, text) to authenticated;

-- ── a person settles it ────────────────────────────────────────────────────
-- CONFIRM: the person verifies the request really is the client's (a call, an email, the signed document) and records that verification as the evidence.
-- That calls the existing record_client_acceptance door (so every rule of it applies: exact version, delivered, not superseded, delivery rights).
create or replace function projects.settle_portal_handover_request(p_request_id uuid, p_decision text, p_verification text default null, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.p7b_portal_requests; v_out text; v_acc uuid;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision not in ('confirmed', 'declined') then return query select 'bad_decision'::text; return; end if;
  select * into v_r from projects.p7b_portal_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if exists (select 1 from projects.p7b_portal_request_settlements z where z.request_id = v_r.id) then return query select 'already_settled'::text; return; end if;
  if p_decision = 'declined' then
    if p_note is null or length(btrim(p_note)) = 0 then return query select 'note_required'::text; return; end if;
    if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
    perform set_config('projects.p7_door', 'on', true);
    insert into projects.p7b_portal_request_settlements (organization_id, request_id, decision, note, decided_by) values (v_org, v_r.id, 'declined', btrim(p_note), v_actor);
    perform core.record_audit(v_org, 'handover_acceptance.request_declined', 'handover_package', v_r.package_id, null, jsonb_build_object('requestId', v_r.id));
    return query select 'declined'::text; return;
  end if;
  -- a confirmation is a person's verification, in their own words: "the client clicked" is not evidence of who the client is
  if p_verification is null or length(btrim(p_verification)) < 10 then return query select 'verification_required'::text; return; end if;
  v_out := (select a.outcome from projects.record_client_acceptance(v_r.package_id,
              case v_r.kind when 'acceptance_request' then 'accepted' else 'changes_requested' end, 'portal_confirmation',
              'portal request ' || v_r.id::text || ': ' || btrim(p_verification), v_r.requested_name, coalesce(p_note, v_r.note)) a);
  if v_out is distinct from 'recorded' then return query select coalesce(v_out, 'not_recorded')::text; return; end if;
  select a.id into v_acc from projects.p7_client_acceptances a where a.package_id = v_r.package_id and a.recorded_by = v_actor order by a.recorded_at desc limit 1;
  perform set_config('projects.p7_door', 'on', true);
  insert into projects.p7b_portal_request_settlements (organization_id, request_id, decision, acceptance_id, note, decided_by) values (v_org, v_r.id, 'confirmed', v_acc, nullif(btrim(coalesce(p_note, '')), ''), v_actor);
  perform core.record_audit(v_org, 'handover_acceptance.request_confirmed', 'handover_package', v_r.package_id, null, jsonb_build_object('requestId', v_r.id, 'acceptanceId', v_acc));
  return query select 'confirmed'::text;
end $$;
revoke all on function projects.settle_portal_handover_request(uuid, text, text, text) from public, anon, service_role;
grant execute on function projects.settle_portal_handover_request(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
