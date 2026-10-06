-- PM5 spec section 16 (revised build re-share) and the ClientReviewShare record: the exact build the Admin approved, shared once for client testing.
-- A share is a fact: which build, which commit, which artifact hash (from the build's own succeeded run), where to test it, how, and how it was
-- labelled. The share DOOR refuses unless every gate holds on that exact commit. Delivery to the client is relay-only by design (ADM-08d): the
-- share row carries its own delivery state, and the client reads a share only once staff recorded it as relayed.

-- the commit the Admin actually approved: stamped by a trigger on whatever route sets admin_status = 'approved', so a commit changed after the
-- approval (a draft build may still change) is detectable at the share door
alter table projects.deliverable_details add column if not exists admin_approved_commit text;
create or replace function projects.stamp_admin_approved_commit() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.admin_status = 'approved' then
    if tg_op = 'INSERT' or old.admin_status is distinct from 'approved' or new.admin_decided_at is distinct from old.admin_decided_at then
      new.admin_approved_commit := new.commit_ref;
    end if;
  else
    new.admin_approved_commit := null;
  end if;
  return new;
end $$;
drop trigger if exists deliverable_details_stamp_approved_commit on projects.deliverable_details;
create trigger deliverable_details_stamp_approved_commit before insert or update of admin_status, admin_decided_at on projects.deliverable_details
  for each row execute function projects.stamp_admin_approved_commit();
-- builds approved before this column existed: the commit they carry now is the one that was approved (a submitted build's commit is frozen)
update projects.deliverable_details set admin_approved_commit = commit_ref where admin_status = 'approved' and admin_approved_commit is null and commit_ref is not null;

create table if not exists projects.client_build_shares (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references core.organizations(id) on delete cascade,
  project_id            uuid not null references projects.projects(id) on delete cascade,
  deliverable_id        uuid not null references projects.deliverables(id) on delete restrict,
  build_run_id          uuid not null references projects.build_runs(id) on delete restrict,
  commit_ref            text not null check (length(btrim(commit_ref)) > 0),
  artifact_sha256       text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  review_platform       text not null check (length(btrim(review_platform)) between 1 and 60),
  review_url            text not null check (review_url ~ '^https://' and length(review_url) <= 500),
  testing_instructions  text not null check (length(btrim(testing_instructions)) between 1 and 2000),
  label                 text not null default 'Development review build, not production' check (label = 'Development review build, not production'),
  shared_by             uuid references core.users(id) on delete set null,
  shared_at             timestamptz not null default now(),
  delivery_state        text not null default 'pending' check (delivery_state in ('pending', 'relayed', 'failed')),
  delivery_note         text check (delivery_note is null or length(delivery_note) <= 500),
  delivery_recorded_by  uuid references core.users(id) on delete set null,
  delivery_recorded_at  timestamptz,
  check ((delivery_state = 'pending') = (delivery_recorded_at is null)),
  unique (deliverable_id, commit_ref)
);
create index if not exists client_build_shares_project_idx on projects.client_build_shares (organization_id, project_id, shared_at desc);
alter table projects.client_build_shares enable row level security;
drop policy if exists client_build_shares_read on projects.client_build_shares;
create policy client_build_shares_read on projects.client_build_shares for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.client_build_shares from public, anon;
revoke insert, update, delete on projects.client_build_shares from authenticated;
grant select on projects.client_build_shares to authenticated;
grant all on projects.client_build_shares to service_role;
create trigger client_build_shares_parent_org_project before insert or update of project_id on projects.client_build_shares for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger client_build_shares_parent_org_deliverable before insert or update of deliverable_id on projects.client_build_shares for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');
create trigger client_build_shares_parent_org_run before insert or update of build_run_id on projects.client_build_shares for each row execute function core.enforce_parent_org('build_run_id', 'projects.build_runs');
create trigger freeze_org_client_build_shares before update of organization_id on projects.client_build_shares for each row execute function core.freeze_organization_id();

-- append-only apart from the delivery state, which only moves forward: pending -> relayed | failed, failed -> relayed
create or replace function projects.client_build_shares_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'a client build share is part of the record: it is never deleted' using errcode = 'restrict_violation'; end if;
  if (new.id, new.organization_id, new.project_id, new.deliverable_id, new.build_run_id, new.commit_ref, new.artifact_sha256, new.review_platform,
      new.review_url, new.testing_instructions, new.label, new.shared_by, new.shared_at)
     is distinct from
     (old.id, old.organization_id, old.project_id, old.deliverable_id, old.build_run_id, old.commit_ref, old.artifact_sha256, old.review_platform,
      old.review_url, old.testing_instructions, old.label, old.shared_by, old.shared_at) then
    raise exception 'a client build share is never rewritten: share the build again as a new commit' using errcode = 'restrict_violation';
  end if;
  if old.delivery_state is distinct from new.delivery_state
     and not (old.delivery_state = 'pending' and new.delivery_state in ('relayed', 'failed') or old.delivery_state = 'failed' and new.delivery_state = 'relayed') then
    raise exception 'a delivery state only moves forward' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger client_build_shares_guard before update or delete on projects.client_build_shares for each row execute function projects.client_build_shares_guard();

-- the door: Admin or delivery manager; refuses unless the build is Admin-approved AT THIS COMMIT, QA-passed, smoke-shareable, free of an open
-- blocker, and has a succeeded build run on the commit. One share per (build, commit); a retry returns the share it already made.
create or replace function projects.share_build_with_client(p_deliverable_id uuid, p_review_platform text, p_review_url text, p_testing_instructions text)
returns table (outcome text, share_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_row projects.deliverables; v_dd projects.deliverable_details; v_run projects.build_runs; v_existing uuid; v_new uuid;
  v_platform text := nullif(btrim(coalesce(p_review_platform, '')), ''); v_url text := nullif(btrim(coalesce(p_review_url, '')), '');
  v_how text := nullif(btrim(coalesce(p_testing_instructions, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if v_platform is null or length(v_platform) > 60 then return query select 'platform_required'::text, null::uuid; return; end if;
  if v_url is null or v_url !~ '^https://' or length(v_url) > 500 then return query select 'url_must_be_https'::text, null::uuid; return; end if;
  if v_how is null or length(v_how) > 2000 then return query select 'instructions_required'::text, null::uuid; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org for update;
  if v_row.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text, null::uuid; return; end if;
  if v_row.status = 'superseded' then return query select 'superseded'::text, null::uuid; return; end if;
  select * into v_dd from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  if v_dd.deliverable_id is null or nullif(btrim(coalesce(v_dd.commit_ref, '')), '') is null then return query select 'no_commit'::text, null::uuid; return; end if;
  select s.id into v_existing from projects.client_build_shares s where s.deliverable_id = v_row.id and s.commit_ref = v_dd.commit_ref;
  if v_existing is not null then return query select 'already_shared'::text, v_existing; return; end if;
  if v_dd.admin_status is distinct from 'approved' then return query select 'not_admin_approved'::text, null::uuid; return; end if;
  if v_dd.admin_approved_commit is distinct from v_dd.commit_ref then return query select 'commit_changed_since_approval'::text, null::uuid; return; end if;
  if v_dd.qa_status is distinct from 'passed' then return query select 'not_qa_passed'::text, null::uuid; return; end if;
  if not projects.build_smoke_ready(v_row.id) then return query select 'no_smoke'::text, null::uuid; return; end if;
  if exists (select 1 from projects.build_blockers b where b.deliverable_id = v_row.id and b.status = 'open') then return query select 'open_blocker'::text, null::uuid; return; end if;
  select * into v_run from projects.build_runs r
   where r.deliverable_id = v_row.id and r.commit_ref = v_dd.commit_ref and r.status = 'succeeded' and r.artifact_sha256 is not null
   order by r.created_at desc limit 1;
  if v_run.id is null then return query select 'no_build_run'::text, null::uuid; return; end if;
  insert into projects.client_build_shares (organization_id, project_id, deliverable_id, build_run_id, commit_ref, artifact_sha256, review_platform, review_url, testing_instructions, shared_by)
  values (v_org, v_row.project_id, v_row.id, v_run.id, v_dd.commit_ref, v_run.artifact_sha256, v_platform, v_url, v_how, v_actor) returning id into v_new;
  perform core.record_audit(v_org, 'build.client_share_recorded', 'deliverable', v_row.id, null, jsonb_build_object('projectId', v_row.project_id, 'shareId', v_new));
  return query select 'shared'::text, v_new;
end $$;
revoke all on function projects.share_build_with_client(uuid, text, text, text) from public, anon;
grant execute on function projects.share_build_with_client(uuid, text, text, text) to authenticated;

-- staff relay the review build to the client (ADM-08d) and record whether it reached them
create or replace function projects.record_build_share_delivery(p_share_id uuid, p_state text, p_note text default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_s projects.client_build_shares;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  if p_state not in ('relayed', 'failed') then return query select 'bad_state'::text; return; end if;
  if p_note is not null and length(p_note) > 500 then return query select 'note_too_long'::text; return; end if;
  select * into v_s from projects.client_build_shares s where s.id = p_share_id and s.organization_id = v_org for update;
  if v_s.id is null then return query select 'not_found'::text; return; end if;
  if v_s.delivery_state = 'relayed' or (v_s.delivery_state = 'failed' and p_state = 'failed') then return query select 'already_recorded'::text; return; end if;
  update projects.client_build_shares set delivery_state = p_state, delivery_note = nullif(btrim(coalesce(p_note, '')), ''), delivery_recorded_by = v_actor, delivery_recorded_at = now() where id = v_s.id;
  perform core.record_audit(v_org, 'build.client_share_delivery', 'deliverable', v_s.deliverable_id, null, jsonb_build_object('shareId', v_s.id, 'state', p_state));
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_build_share_delivery(uuid, text, text) from public, anon;
grant execute on function projects.record_build_share_delivery(uuid, text, text) to authenticated;

-- the portal client's read: what to test, where and how, with no internal id, commit, hash, log or note. A share staff have not relayed does not exist for the client.
create or replace function projects.client_build_shares_for_client(p_project_id uuid)
returns table (build_version integer, review_platform text, review_url text, testing_instructions text, label text, shared_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null then return; end if;
  if coalesce((select core.is_client()), false) then
    if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org and p.client_account_id = (select core.current_client_account_id())) then return; end if;
  elsif not coalesce((select core.is_internal()), false) then return;
  end if;
  return query
    select d.version, s.review_platform, s.review_url, s.testing_instructions, s.label, s.shared_at
      from projects.client_build_shares s join projects.deliverables d on d.id = s.deliverable_id
     where s.project_id = p_project_id and s.organization_id = v_org and s.delivery_state = 'relayed'
     order by s.shared_at desc;
end $$;
revoke all on function projects.client_build_shares_for_client(uuid) from public, anon;
grant execute on function projects.client_build_shares_for_client(uuid) to authenticated, service_role;
notify pgrst, 'reload schema';
