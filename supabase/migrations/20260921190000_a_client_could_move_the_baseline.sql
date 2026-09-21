-- ═══════════════════════════════════════════════════════════════════════════
-- A client could move the baseline.
--
-- SECURITY FIX. Found while building the Admin Panel's Scope/Change Request
-- screens (SCR-030/031) and red-proving every door before wiring a page to
-- it — the discipline that already caught three unreachable doors earlier
-- this build. This time the opposite defect: a REACHABLE door with no
-- authority check at all.
--
-- `projects.open_scope_version`, `.freeze_scope_version`,
-- `.submit_change_request`, `.classify_change_request`,
-- `.decide_change_request` and `.apply_change_request` (20260821190000) are
-- all `security definer`, all granted to `authenticated` — every signed-in
-- principal, internal staff and client portal user alike — and NONE of them
-- checks who is calling. Every other door in this family
-- (`add_scope_item`, `.remove_scope_item`, `draft_test_plan`, etc., all
-- added this build) checks `core.can_manage_delivery()` first; these six
-- were written one migration earlier and the check was never added.
--
-- Reproduced directly against Postgres before writing this fix: a
-- `client_admin` role — the client PORTAL role, not internal staff — calling
-- `open_scope_version` for their own project succeeds and returns `opened`.
-- The same session can go on to call `freeze_scope_version` and
-- `submit_change_request`. Doc 11's own words: "Internal-only, the same
-- shape projects.tasks uses." It was not.
--
-- This is exploitable from the browser alone: PostgREST exposes every
-- granted RPC to any authenticated session regardless of what the Next.js
-- app's own capability checks say, because those checks run in server
-- actions the client can simply not call — nothing stops a portal user's
-- own session token from calling the RPC directly.
--
-- Every function's signature, return shape and business logic is otherwise
-- byte-for-byte identical; only the authority check at the top changed.
-- `not_authorized` is added to each function's own outcome vocabulary,
-- following the same convention this migration's authors already used for
-- `not_found` / `not_draft` / etc.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.open_scope_version(
  p_project_id             uuid,
  p_source                 text default 'onboarding',
  p_requirement_version_id uuid default null,
  p_change_request_id      uuid default null
)
returns table (outcome text, scope_version_id uuid, version int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_next int;
  v_id   uuid;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid, null::int;
    return;
  end if;

  select pr.organization_id into v_org
    from projects.projects pr
   where pr.id = p_project_id;

  if v_org is null then
    return query select 'not_found'::text, null::uuid, null::int;
    return;
  end if;

  if exists (
    select 1 from projects.scope_versions sv
     where sv.project_id = p_project_id and sv.status = 'draft'
  ) then
    return query select 'draft_exists'::text, null::uuid, null::int;
    return;
  end if;

  select coalesce(max(sv.version), 0) + 1 into v_next
    from projects.scope_versions sv
   where sv.project_id = p_project_id;

  insert into projects.scope_versions (
    organization_id, project_id, version, status, source,
    requirement_version_id, change_request_id, created_by
  )
  values (
    v_org, p_project_id, v_next, 'draft', p_source,
    p_requirement_version_id, p_change_request_id, auth.uid()
  )
  returning id into v_id;

  return query select 'opened'::text, v_id, v_next;
end;
$$;

create or replace function projects.freeze_scope_version(p_scope_version_id uuid)
returns table (outcome text, superseded uuid, items int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_status  text;
  v_items   int;
  v_old     uuid;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid, null::int;
    return;
  end if;

  select sv.project_id, sv.status
    into v_project, v_status
    from projects.scope_versions sv
   where sv.id = p_scope_version_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::int;
    return;
  end if;

  if v_status <> 'draft' then
    return query select 'not_draft'::text, null::uuid, null::int;
    return;
  end if;

  select count(*) into v_items
    from projects.scope_items si
   where si.scope_version_id = p_scope_version_id;

  if v_items = 0 then
    return query select 'empty'::text, null::uuid, null::int;
    return;
  end if;

  select sv.id into v_old
    from projects.scope_versions sv
   where sv.project_id = v_project and sv.status = 'active'
     for update;

  if v_old is not null then
    update projects.scope_versions set status = 'superseded' where id = v_old;
  end if;

  update projects.scope_versions
     set status = 'active', frozen_at = now()
   where id = p_scope_version_id;

  perform core.record_audit(
    (select sv.organization_id from projects.scope_versions sv where sv.id = p_scope_version_id),
    'scope.frozen', 'scope_version', p_scope_version_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'active', 'items', v_items, 'superseded', v_old)
  );

  return query select 'frozen'::text, v_old, v_items;
end;
$$;

create or replace function projects.submit_change_request(
  p_project_id  uuid,
  p_requested   text,
  p_source      text default 'client',
  p_evidence_message_id uuid default null
)
returns table (outcome text, change_request_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_scope uuid;
  v_id    uuid;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid;
    return;
  end if;

  select pr.organization_id into v_org
    from projects.projects pr where pr.id = p_project_id;

  if v_org is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  select sv.id into v_scope
    from projects.scope_versions sv
   where sv.project_id = p_project_id and sv.status = 'active';

  if v_scope is null then
    return query select 'no_baseline'::text, null::uuid;
    return;
  end if;

  insert into projects.change_requests (
    organization_id, project_id, scope_version_id, source,
    requested, evidence_message_id, requested_by
  )
  values (v_org, p_project_id, v_scope, p_source,
          p_requested, p_evidence_message_id, auth.uid())
  returning id into v_id;

  return query select 'submitted'::text, v_id;
end;
$$;

create or replace function projects.classify_change_request(
  p_change_request_id uuid,
  p_classification    text,
  p_impact_notes      text default null,
  p_timeline_days     int  default null,
  p_effort_hours      numeric default null
)
returns table (outcome text, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::text;
    return;
  end if;

  select cr.status into v_status
    from projects.change_requests cr
   where cr.id = p_change_request_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_status not in ('submitted', 'analysing', 'classified') then
    return query select 'already_decided'::text, v_status;
    return;
  end if;

  update projects.change_requests
     set classification = p_classification,
         impact_notes   = coalesce(p_impact_notes, impact_notes),
         timeline_days  = coalesce(p_timeline_days, timeline_days),
         effort_hours   = coalesce(p_effort_hours, effort_hours),
         status         = 'classified',
         updated_at     = now()
   where id = p_change_request_id;

  return query select 'classified'::text, 'classified'::text;
end;
$$;

create or replace function projects.decide_change_request(
  p_change_request_id uuid,
  p_approve           boolean,
  p_proposal_id       uuid default null
)
returns table (outcome text, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_status text;
  v_class  text;
begin
  -- The decision, not just the classification: approving a change is an
  -- owner-level act the same way signing a project production-ready is
  -- (projects.mark_production_ready's project.sign_off) — is_owner() rather
  -- than can_manage_delivery(), because a delivery_lead approving their own
  -- team's change request is the review signing its own homework, the exact
  -- reasoning markProductionReady already uses one level up.
  if not coalesce((select core.is_owner()), false) then
    return query select 'not_authorized'::text, null::text;
    return;
  end if;

  select cr.organization_id, cr.status, cr.classification
    into v_org, v_status, v_class
    from projects.change_requests cr
   where cr.id = p_change_request_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_status not in ('classified', 'pending_approval') then
    return query select 'not_decidable'::text, v_status;
    return;
  end if;

  if v_class is null then
    return query select 'unclassified'::text, v_status;
    return;
  end if;

  if p_approve and v_class = 'paid_change' and coalesce(p_proposal_id, (
       select cr.proposal_id from projects.change_requests cr where cr.id = p_change_request_id
     )) is null then
    return query select 'paid_change_needs_a_proposal'::text, v_status;
    return;
  end if;

  update projects.change_requests
     set status      = case when p_approve then 'approved' else 'rejected' end,
         proposal_id = coalesce(p_proposal_id, proposal_id),
         decided_by  = auth.uid(),
         decided_at  = now(),
         updated_at  = now()
   where id = p_change_request_id;

  perform core.record_audit(
    v_org,
    case when p_approve then 'change_request.approved' else 'change_request.rejected' end,
    'change_request', p_change_request_id,
    jsonb_build_object('status', v_status),
    jsonb_build_object('status', case when p_approve then 'approved' else 'rejected' end,
                       'classification', v_class)
  );

  return query select case when p_approve then 'approved' else 'rejected' end::text,
                      case when p_approve then 'approved' else 'rejected' end::text;
end;
$$;

create or replace function projects.apply_change_request(p_change_request_id uuid)
returns table (outcome text, scope_version_id uuid, version int)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_status  text;
  v_active  uuid;
  v_new     uuid;
  v_version int;
  v_opened  record;
begin
  if not coalesce((select core.can_manage_delivery()), false) then
    return query select 'not_authorized'::text, null::uuid, null::int;
    return;
  end if;

  select cr.project_id, cr.status
    into v_project, v_status
    from projects.change_requests cr
   where cr.id = p_change_request_id
     for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::int;
    return;
  end if;

  if v_status <> 'approved' then
    return query select 'not_approved'::text, null::uuid, null::int;
    return;
  end if;

  select sv.id into v_active
    from projects.scope_versions sv
   where sv.project_id = v_project and sv.status = 'active';

  if v_active is null then
    return query select 'no_baseline'::text, null::uuid, null::int;
    return;
  end if;

  select * into v_opened
    from projects.open_scope_version(v_project, 'change_request', null, p_change_request_id);

  if v_opened.outcome <> 'opened' then
    return query select v_opened.outcome, null::uuid, null::int;
    return;
  end if;

  v_new     := v_opened.scope_version_id;
  v_version := v_opened.version;

  insert into projects.scope_items (
    organization_id, scope_version_id, feature_id, title, detail,
    inclusion, acceptance_criteria, position
  )
  select si.organization_id, v_new, si.feature_id, si.title, si.detail,
         si.inclusion, si.acceptance_criteria, si.position
    from projects.scope_items si
   where si.scope_version_id = v_active;

  update projects.change_requests
     set resulting_scope_version_id = v_new,
         status     = 'implemented',
         updated_at = now()
   where id = p_change_request_id;

  return query select 'opened'::text, v_new, v_version;
end;
$$;

comment on function projects.open_scope_version(uuid, text, uuid, uuid) is
  'Opens a draft scope baseline. can_manage_delivery() only (owner, ops_admin, delivery_lead) — added 20260921190000 after a client portal role was found able to call this directly with no authority check at all.';

comment on function projects.freeze_scope_version(uuid) is
  'Freezes a draft into the delivery baseline and supersedes whatever it replaces, under a row lock so two callers cannot both win. Refuses an empty draft. can_manage_delivery() only, added 20260921190000 for the same reason as open_scope_version.';

comment on function projects.submit_change_request(uuid, text, text, uuid) is
  'Records a request to move the delivery baseline. can_manage_delivery() only, added 20260921190000 — a client portal role could previously call this directly for their own project.';

comment on function projects.classify_change_request(uuid, text, text, int, numeric) is
  'Classifies a change request into Doc 11 section 17''s vocabulary. can_manage_delivery() only, added 20260921190000.';

comment on function projects.decide_change_request(uuid, boolean, uuid) is
  'Approves or rejects a classified change request. is_owner() only — one level stricter than the other doors in this family, matching projects.mark_production_ready''s project.sign_off reasoning: a delivery_lead approving their own team''s change is the review signing its own homework. Added 20260921190000; a paid change cannot be approved without a proposal to price it (ADM-22).';

comment on function projects.apply_change_request(uuid) is
  'Opens the next baseline by COPYING the active one, so the frozen version is never touched (Doc 11 section 29). Refuses a request that is not approved. can_manage_delivery() only, added 20260921190000.';
