-- ═══════════════════════════════════════════════════════════════════════════
-- A build has details, a prototype goes to the client through a gate, a plan
-- is approved before it is activated, and a repository has a policy.
--
-- PDF SCR-037, 040, 042, 043. Added here:
--
--   projects.deliverable_details   one row per prototype or build deliverable:
--                                  platform, Admin status (+ who, when, why),
--                                  commit ref, build number, rollback target
--                                  and note. No write grant for authenticated.
--     projects.set_deliverable_details(...)        delivery roles
--     projects.decide_prototype_admin(...)         owner / ops admin
--   projects.prototype_send_gate(deliverable)      QA passed? Admin approved?
--   projects.submit_deliverable                    a prototype is refused
--                                                  (not_qa_passed / not_admin_approved)
--   projects.send_prototype_for_client_review      the door the page calls; the
--                                                  owner may override with a reason
--   projects.project_plans.approved_*              internal plan approval
--     projects.approve_project_plan(plan, note)
--   projects.repository_links.access_level / merge_min_approvals / merge_role
--     projects.set_repository_policy(...)          owner / ops admin
--
-- Idempotent. Every door is security definer (except the two that wrap
-- submit_deliverable, which keeps its caller's rights), re-checks the role and
-- audits.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.deliverable_details (
  deliverable_id     uuid primary key references projects.deliverables(id) on delete cascade,
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  platform           text check (platform is null or platform in ('web', 'ios', 'android', 'desktop', 'cross_platform')),
  admin_status       text not null default 'pending' check (admin_status in ('pending', 'approved', 'changes_required')),
  admin_decided_by   uuid references core.users(id) on delete set null,
  admin_decided_at   timestamptz,
  admin_note         text check (admin_note is null or length(btrim(admin_note)) between 1 and 1000),
  commit_ref         text check (commit_ref is null or length(btrim(commit_ref)) between 1 and 200),
  build_number       text check (build_number is null or length(btrim(build_number)) between 1 and 60),
  rollback_target_id uuid references projects.deliverables(id) on delete set null,
  rollback_note      text check (rollback_note is null or length(btrim(rollback_note)) between 1 and 1000),
  updated_at         timestamptz not null default now(),
  constraint deliverable_details_admin_shape check ((admin_status = 'pending') = (admin_decided_at is null))
);
comment on table projects.deliverable_details is
  'SCR-037/043: what a prototype or build deliverable needs beyond its title and link — platform, Admin status, commit ref, build number and rollback target. Written only through projects.set_deliverable_details and projects.decide_prototype_admin.';
create index if not exists deliverable_details_project_idx on projects.deliverable_details (organization_id, project_id);

drop trigger if exists org_match_deliverable_details_deliverable on projects.deliverable_details;
create trigger org_match_deliverable_details_deliverable
  before insert or update of deliverable_id, organization_id on projects.deliverable_details
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');
drop trigger if exists org_match_deliverable_details_rollback on projects.deliverable_details;
create trigger org_match_deliverable_details_rollback
  before insert or update of rollback_target_id, organization_id on projects.deliverable_details
  for each row execute function core.enforce_parent_org('rollback_target_id', 'projects.deliverables');
drop trigger if exists org_match_deliverable_details_project on projects.deliverable_details;
create trigger org_match_deliverable_details_project
  before insert or update of project_id, organization_id on projects.deliverable_details
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_deliverable_details on projects.deliverable_details;
create trigger freeze_org_deliverable_details
  before update of organization_id on projects.deliverable_details
  for each row execute function core.freeze_organization_id();

alter table projects.deliverable_details enable row level security;
alter table projects.deliverable_details force row level security;
drop policy if exists deliverable_details_select on projects.deliverable_details;
create policy deliverable_details_select on projects.deliverable_details
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.deliverable_details from public, anon, authenticated;
grant select on projects.deliverable_details to authenticated;
grant select, insert, update, delete on projects.deliverable_details to service_role;

-- QA on a prototype. A test run cannot name a prototype (Doc 14 §2: "a design
-- is reviewed and a build is tested"), so a prototype's QA is a verdict: the
-- Prototype Agent's (prototype_artifacts.status) or a person's, recorded here.
alter table projects.deliverable_details add column if not exists qa_status text not null default 'not_reviewed';
alter table projects.deliverable_details add column if not exists qa_decided_by uuid references core.users(id) on delete set null;
alter table projects.deliverable_details add column if not exists qa_decided_at timestamptz;
alter table projects.deliverable_details add column if not exists qa_note text;
alter table projects.deliverable_details add column if not exists qa_evidence_url text;
alter table projects.deliverable_details drop constraint if exists deliverable_details_qa_status_check;
alter table projects.deliverable_details add constraint deliverable_details_qa_status_check check (qa_status in ('not_reviewed', 'passed', 'changes_required'));
alter table projects.deliverable_details drop constraint if exists deliverable_details_qa_shape;
alter table projects.deliverable_details add constraint deliverable_details_qa_shape check ((qa_status = 'not_reviewed') = (qa_decided_at is null));
alter table projects.deliverable_details drop constraint if exists deliverable_details_qa_evidence_https;
alter table projects.deliverable_details add constraint deliverable_details_qa_evidence_https check (qa_evidence_url is null or qa_evidence_url ~ '^https://');
alter table projects.deliverable_details drop constraint if exists deliverable_details_qa_note_len;
alter table projects.deliverable_details add constraint deliverable_details_qa_note_len check (qa_note is null or length(btrim(qa_note)) between 1 and 1000);

create or replace function projects.record_prototype_qa_check(p_deliverable_id uuid, p_outcome text, p_note text default null, p_evidence_url text default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.deliverables;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_url   text := nullif(btrim(coalesce(p_evidence_url, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_outcome not in ('passed', 'changes_required') then
    return query select 'bad_outcome'::text; return;
  end if;
  if p_outcome = 'changes_required' and v_note is null then
    return query select 'note_required'::text; return;
  end if;
  if (v_note is not null and length(v_note) > 1000) or (v_url is not null and v_url !~ '^https://') then
    return query select 'invalid'::text; return;
  end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.kind <> 'prototype' then
    return query select 'wrong_kind'::text; return;
  end if;
  insert into projects.deliverable_details as dd (deliverable_id, organization_id, project_id, qa_status, qa_decided_by, qa_decided_at, qa_note, qa_evidence_url)
  values (v_row.id, v_org, v_row.project_id, p_outcome, v_actor, now(), v_note, v_url)
  on conflict (deliverable_id) do update
    set qa_status = excluded.qa_status, qa_decided_by = excluded.qa_decided_by, qa_decided_at = excluded.qa_decided_at,
        qa_note = excluded.qa_note, qa_evidence_url = excluded.qa_evidence_url, updated_at = now();
  perform core.record_audit(v_org, 'deliverable.prototype_qa_recorded', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'outcome', p_outcome));
  return query select 'recorded'::text;
end;
$$;
revoke all on function projects.record_prototype_qa_check(uuid, text, text, text) from public, anon;
grant execute on function projects.record_prototype_qa_check(uuid, text, text, text) to authenticated, service_role;

create or replace function projects.set_deliverable_details(
  p_deliverable_id uuid, p_platform text, p_commit_ref text, p_build_number text,
  p_rollback_target_id uuid default null, p_rollback_note text default null
)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_org      uuid := (select core.current_organization_id());
  v_row      projects.deliverables;
  v_platform text := nullif(btrim(coalesce(p_platform, '')), '');
  v_commit   text := nullif(btrim(coalesce(p_commit_ref, '')), '');
  v_number   text := nullif(btrim(coalesce(p_build_number, '')), '');
  v_note     text := nullif(btrim(coalesce(p_rollback_note, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.kind not in ('prototype', 'build') then
    return query select 'wrong_kind'::text; return;
  end if;
  if v_platform is not null and v_platform not in ('web', 'ios', 'android', 'desktop', 'cross_platform') then
    return query select 'bad_platform'::text; return;
  end if;
  if (v_commit is not null and length(v_commit) > 200) or (v_number is not null and length(v_number) > 60) or (v_note is not null and length(v_note) > 1000) then
    return query select 'too_long'::text; return;
  end if;
  if p_rollback_target_id is not null then
    if p_rollback_target_id = p_deliverable_id
       or not exists (select 1 from projects.deliverables t
                       where t.id = p_rollback_target_id and t.project_id = v_row.project_id and t.kind = 'build' and t.organization_id = v_org) then
      return query select 'bad_rollback_target'::text; return;
    end if;
  end if;

  insert into projects.deliverable_details as dd (deliverable_id, organization_id, project_id, platform, commit_ref, build_number, rollback_target_id, rollback_note)
  values (v_row.id, v_org, v_row.project_id, v_platform, v_commit, v_number, p_rollback_target_id, v_note)
  on conflict (deliverable_id) do update
    set platform = excluded.platform,
        commit_ref = excluded.commit_ref,
        build_number = excluded.build_number,
        rollback_target_id = excluded.rollback_target_id,
        rollback_note = excluded.rollback_note,
        updated_at = now();

  perform core.record_audit(v_org, 'deliverable.details_set', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'kind', v_row.kind, 'platform', v_platform, 'commitRef', v_commit,
                       'buildNumber', v_number, 'rollbackTargetId', p_rollback_target_id));
  return query select 'set'::text;
end;
$$;
revoke all on function projects.set_deliverable_details(uuid, text, text, text, uuid, text) from public, anon;
grant execute on function projects.set_deliverable_details(uuid, text, text, text, uuid, text) to authenticated, service_role;

create or replace function projects.decide_prototype_admin(p_deliverable_id uuid, p_decision text, p_note text default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.deliverables;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  -- Admin confirm/edit is the Admin's (owner, ops admin): the delivery lead
  -- who built it does not approve their own build.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_decision not in ('approved', 'changes_required') then
    return query select 'bad_decision'::text; return;
  end if;
  if p_decision = 'changes_required' and v_note is null then
    return query select 'note_required'::text; return;
  end if;
  if v_note is not null and length(v_note) > 1000 then
    return query select 'too_long'::text; return;
  end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_row.kind <> 'prototype' then
    return query select 'wrong_kind'::text; return;
  end if;

  insert into projects.deliverable_details as dd (deliverable_id, organization_id, project_id, admin_status, admin_decided_by, admin_decided_at, admin_note)
  values (v_row.id, v_org, v_row.project_id, p_decision, v_actor, now(), v_note)
  on conflict (deliverable_id) do update
    set admin_status = excluded.admin_status, admin_decided_by = excluded.admin_decided_by,
        admin_decided_at = excluded.admin_decided_at, admin_note = excluded.admin_note, updated_at = now();

  perform core.record_audit(v_org, 'deliverable.prototype_admin_decided', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'decision', p_decision, 'noted', v_note is not null));
  return query select 'decided'::text;
end;
$$;
revoke all on function projects.decide_prototype_admin(uuid, text, text) from public, anon;
grant execute on function projects.decide_prototype_admin(uuid, text, text) to authenticated, service_role;

-- Where a prototype stands against the normal path to the client.
create or replace function projects.prototype_send_gate(p_deliverable_id uuid)
returns table (qa_passed boolean, admin_approved boolean, qa_source text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_art  projects.prototype_artifacts;
  v_qa   boolean := false;
  v_src  text;
  v_adm  boolean;
begin
  select * into v_art from projects.prototype_artifacts a where a.deliverable_id = p_deliverable_id;
  if v_art.id is not null and v_art.status = 'qa_pass' then
    v_qa := true;
    v_src := 'the prototype QA verdict';
  elsif exists (select 1 from projects.deliverable_details d where d.deliverable_id = p_deliverable_id and d.qa_status = 'passed') then
    v_qa := true;
    v_src := 'a QA check recorded by a person';
  elsif v_art.id is not null and v_art.status = 'qa_changes_required' then
    v_src := 'the prototype QA verdict asked for changes';
  elsif exists (select 1 from projects.deliverable_details d where d.deliverable_id = p_deliverable_id and d.qa_status = 'changes_required') then
    v_src := 'a recorded QA check asked for changes';
  else
    v_src := 'no QA evidence';
  end if;
  select coalesce((select d.admin_status = 'approved' from projects.deliverable_details d where d.deliverable_id = p_deliverable_id), false) into v_adm;
  return query select v_qa, v_adm, v_src;
end;
$$;
revoke all on function projects.prototype_send_gate(uuid) from public, anon;
grant execute on function projects.prototype_send_gate(uuid) to authenticated, service_role;

-- submit_deliverable as it stood, with the prototype gate added.
CREATE OR REPLACE FUNCTION projects.submit_deliverable(p_deliverable_id uuid, p_requested_by uuid DEFAULT NULL::uuid, p_summary text DEFAULT NULL::text)
 RETURNS TABLE(outcome text, request_id uuid, status text)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_row      projects.deliverables;
  v_approval record;
  v_blocking int;
  v_gate     record;
begin
  select d.* into v_row
    from projects.deliverables d
   where d.id = p_deliverable_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_row.status in ('approved', 'superseded') then
    return query select 'settled'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  if v_row.status = 'in_review' then
    return query select 'already_in_review'::text, v_row.approval_request_id, v_row.status;
    return;
  end if;

  -- W4 (PDF SCR-037): a prototype build goes to the client on the normal path
  -- only when QA passed it AND Admin approved it. `send_prototype_for_client_review`
  -- is the one door that may override, and it does so as the owner with a reason
  -- on the audit trail.
  if v_row.kind = 'prototype' and coalesce(current_setting('app.prototype_send_override', true), '') <> 'on' then
    select * into v_gate from projects.prototype_send_gate(v_row.id);
    if not coalesce(v_gate.qa_passed, false) then
      return query select 'not_qa_passed'::text, null::uuid, v_row.status;
      return;
    end if;
    if not coalesce(v_gate.admin_approved, false) then
      return query select 'not_admin_approved'::text, null::uuid, v_row.status;
      return;
    end if;
  end if;

  -- ARCHITECTURE.md §4.8. Checked under the same lock that will write the
  -- status, so a blocker raised while somebody was clicking submit still
  -- stops it.
  select count(*) into v_blocking from qa.blocking_defects(p_deliverable_id);

  if v_blocking > 0 then
    return query select 'blocked'::text, null::uuid, v_row.status;
    return;
  end if;

  select * into v_approval
    from approvals.request_approval(
      v_row.organization_id, 'deliverable', v_row.id,
      case when p_requested_by is null then 'system' else 'user' end,
      p_requested_by,
      coalesce(p_summary, v_row.kind || ' v' || v_row.version || ' — ' || v_row.title),
      jsonb_build_object(
        'kind', v_row.kind, 'version', v_row.version, 'title', v_row.title,
        'artifact_url', v_row.artifact_url, 'known_issues', v_row.known_issues
      ),
      null, 'client', null
    );

  if v_approval.outcome = 'no_policy' then
    return query select 'no_policy'::text, null::uuid, v_row.status;
    return;
  end if;

  update projects.deliverables
     set status = 'in_review',
         approval_request_id = v_approval.request_id
   where projects.deliverables.id = v_row.id;

  perform core.record_audit(
    v_row.organization_id, 'deliverable.submitted', 'deliverable', v_row.id,
    to_jsonb(v_row),
    jsonb_build_object('status', 'in_review', 'approval_request_id', v_approval.request_id)
  );

  -- ── the one addition: a generic, kind-agnostic event ────────────────────
  perform core.emit_event(
    v_row.organization_id, 'project.deliverable_submitted', 'deliverable', v_row.id,
    jsonb_build_object('kind', v_row.kind, 'version', v_row.version, 'projectId', v_row.project_id)
  );

  return query select 'submitted'::text, v_approval.request_id, 'in_review'::text;
end;
$function$;

create or replace function projects.send_prototype_for_client_review(p_deliverable_id uuid, p_override_reason text default null, p_summary text default null)
returns table (outcome text, request_id uuid, status text)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_reason   text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_row      projects.deliverables;
  v_gate     record;
  v_overrode boolean := false;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid, null::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid, null::text; return;
  end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id;
  if v_row.id is null or v_row.kind <> 'prototype' then
    return query select 'not_found'::text, null::uuid, null::text; return;
  end if;

  if v_reason is not null then
    -- The explicit override path: only the owner, and only with a reason.
    if not coalesce((select core.is_owner()), false) then
      return query select 'override_not_allowed'::text, null::uuid, null::text; return;
    end if;
    select * into v_gate from projects.prototype_send_gate(p_deliverable_id);
    if not (coalesce(v_gate.qa_passed, false) and coalesce(v_gate.admin_approved, false)) then
      perform set_config('app.prototype_send_override', 'on', true);
      v_overrode := true;
    end if;
  end if;

  return query select s.outcome, s.request_id, s.status
    from projects.submit_deliverable(p_deliverable_id, v_actor, p_summary) s;

  if v_overrode then
    perform core.record_audit(v_row.organization_id, 'deliverable.prototype_send_overridden', 'deliverable', v_row.id, null,
      jsonb_build_object('projectId', v_row.project_id, 'reason', v_reason));
  end if;
end;
$$;
revoke all on function projects.send_prototype_for_client_review(uuid, text, text) from public, anon;
grant execute on function projects.send_prototype_for_client_review(uuid, text, text) to authenticated, service_role;

-- ── plan approval ──────────────────────────────────────────────────────────
alter table projects.project_plans add column if not exists approved_by uuid references core.users(id) on delete set null;
alter table projects.project_plans add column if not exists approved_at timestamptz;
alter table projects.project_plans add column if not exists approval_note text;
alter table projects.project_plans drop constraint if exists project_plans_approval_shape;
alter table projects.project_plans add constraint project_plans_approval_shape check ((approved_by is null) or (approved_at is not null));

create or replace function projects.approve_project_plan(p_plan_id uuid, p_note text default null)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_plan  projects.project_plans;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if v_note is not null and length(v_note) > 1000 then
    return query select 'too_long'::text; return;
  end if;
  select * into v_plan from projects.project_plans p where p.id = p_plan_id and p.organization_id = v_org for update;
  if v_plan.id is null then
    return query select 'not_found'::text; return;
  end if;
  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text; return;
  end if;
  if not exists (select 1 from projects.plan_deliverables d where d.plan_id = v_plan.id) then
    return query select 'empty_plan'::text; return;
  end if;
  if v_plan.approved_at is not null then
    return query select 'already_approved'::text; return;
  end if;
  update projects.project_plans set approved_by = v_actor, approved_at = now(), approval_note = v_note where id = v_plan.id;
  perform core.record_audit(v_org, 'project.plan_approved', 'project_plan', v_plan.id, null,
    jsonb_build_object('projectId', v_plan.project_id, 'version', v_plan.version));
  return query select 'approved'::text;
end;
$$;
revoke all on function projects.approve_project_plan(uuid, text) from public, anon;
grant execute on function projects.approve_project_plan(uuid, text) to authenticated, service_role;

-- ── repository policy ──────────────────────────────────────────────────────
alter table projects.repository_links add column if not exists access_level text not null default 'full';
alter table projects.repository_links add column if not exists merge_min_approvals smallint not null default 0;
alter table projects.repository_links add column if not exists merge_role text not null default 'delivery';
alter table projects.repository_links drop constraint if exists repository_links_access_level_check;
alter table projects.repository_links add constraint repository_links_access_level_check check (access_level in ('read_only', 'branch_and_review', 'full'));
alter table projects.repository_links drop constraint if exists repository_links_merge_min_approvals_check;
alter table projects.repository_links add constraint repository_links_merge_min_approvals_check check (merge_min_approvals between 0 and 5);
alter table projects.repository_links drop constraint if exists repository_links_merge_role_check;
alter table projects.repository_links add constraint repository_links_merge_role_check check (merge_role in ('owner', 'admin', 'delivery'));

comment on column projects.repository_links.access_level is 'SCR-042 least privilege: what the panel may do in this repository — read_only, branch_and_review (branches, reviews, builds), full (also merge). Enforced by the git write doors.';
comment on column projects.repository_links.merge_min_approvals is 'SCR-042 merge policy: approving reviews a pull request needs before the panel merges it.';
comment on column projects.repository_links.merge_role is 'SCR-042 merge policy: who may merge — owner, admin (owner or ops admin) or delivery (plus delivery lead).';

create or replace function projects.set_repository_policy(p_project_id uuid, p_access_level text, p_merge_min_approvals integer, p_merge_role text)
returns table (outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.repository_links;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_authorized'::text; return;
  end if;
  if p_access_level not in ('read_only', 'branch_and_review', 'full') or p_merge_role not in ('owner', 'admin', 'delivery')
     or p_merge_min_approvals is null or p_merge_min_approvals < 0 or p_merge_min_approvals > 5 then
    return query select 'bad_policy'::text; return;
  end if;
  select * into v_row from projects.repository_links l where l.project_id = p_project_id and l.organization_id = v_org for update;
  if v_row.id is null then
    return query select 'not_linked'::text; return;
  end if;
  if v_row.access_level = p_access_level and v_row.merge_min_approvals = p_merge_min_approvals and v_row.merge_role = p_merge_role then
    return query select 'unchanged'::text; return;
  end if;
  update projects.repository_links
     set access_level = p_access_level, merge_min_approvals = p_merge_min_approvals, merge_role = p_merge_role
   where id = v_row.id;
  perform core.record_audit(v_org, 'git.repository_policy_set', 'repository_link', v_row.id,
    jsonb_build_object('accessLevel', v_row.access_level, 'mergeMinApprovals', v_row.merge_min_approvals, 'mergeRole', v_row.merge_role),
    jsonb_build_object('accessLevel', p_access_level, 'mergeMinApprovals', p_merge_min_approvals, 'mergeRole', p_merge_role, 'projectId', p_project_id));
  return query select 'set'::text;
end;
$$;
revoke all on function projects.set_repository_policy(uuid, text, integer, text) from public, anon;
grant execute on function projects.set_repository_policy(uuid, text, integer, text) to authenticated, service_role;
