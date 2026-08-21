-- ═══════════════════════════════════════════════════════════════════════════
-- Moving a baseline is a transition, not an UPDATE.
--
-- 20260821180000 gave AgencyOS a scope baseline and made it immutable once
-- frozen. That is half of Doc 11: the half that says what a baseline IS. This
-- is the half that says how it legitimately MOVES.
--
-- Every one of these is a SECURITY DEFINER function rather than a policy that
-- lets a caller write the rows, for the reason the rest of this schema already
-- follows: a transition has invariants that span several rows — supersede the
-- old version, activate the new one, link the change request that authorised
-- it — and a caller doing that in three PATCHes can stop after the first.
--
-- ── the rule that shapes all of them ─────────────────────────────────────
--
-- Doc 11 §29: *"Old versions remain read-only history."* So nothing here edits
-- a frozen version. `apply_change_request` COPIES the active baseline into a
-- new draft, applies the change to the copy, freezes it, and supersedes the
-- original. The old rows are never touched, which is why the immutability
-- trigger from the previous migration never has to be worked around.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. open a draft baseline ─────────────────────────────────────────────
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
  select pr.organization_id into v_org
    from projects.projects pr
   where pr.id = p_project_id;

  if v_org is null then
    return query select 'not_found'::text, null::uuid, null::int;
    return;
  end if;

  -- One draft at a time. Two open drafts is two people assembling different
  -- baselines for the same project, and whichever freezes last wins silently.
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

-- ── 2. freeze it, and retire whatever it replaces ────────────────────────
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
  -- Read under a lock: the decision and the write must see the same row, or
  -- two callers both freeze and the partial unique index picks a winner
  -- neither of them chose.
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

  -- Doc 11 §14's checklist has ten items; this is the one that can be
  -- mechanically checked. A baseline with nothing in it is not a baseline, and
  -- freezing one would make every later "is this in scope?" answer no.
  if v_items = 0 then
    return query select 'empty'::text, null::uuid, null::int;
    return;
  end if;

  -- Retire the incumbent first. The partial unique index would refuse two
  -- actives, so the order is not cosmetic.
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

-- ── 3. a request against the active baseline ─────────────────────────────
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
  select pr.organization_id into v_org
    from projects.projects pr where pr.id = p_project_id;

  if v_org is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  select sv.id into v_scope
    from projects.scope_versions sv
   where sv.project_id = p_project_id and sv.status = 'active';

  -- Doc 11 §15: a change request is a request to move a baseline. With no
  -- baseline there is nothing to move, and recording one anyway would let a
  -- project accumulate "changes" to a scope that was never agreed.
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

-- ── 4. classify it — deterministically, by a person, for now ─────────────
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
  select cr.status into v_status
    from projects.change_requests cr
   where cr.id = p_change_request_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- Classifying a decided request would rewrite the reason a decision was
  -- made. Doc 11 §22 lets a request move back to clarification before final
  -- approval and nowhere after it.
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

-- ── 5. decide it ─────────────────────────────────────────────────────────
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

  -- ADM-22, as a refusal rather than a convention. A paid change is approved
  -- against a priced proposal or it is not approved; there is nowhere else in
  -- this system for that number to live, and there must not be.
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

-- ── 6. apply it — by copying, never by editing ───────────────────────────
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

  -- The copy. Doc 11 §29: each version "contains complete active scope",
  -- so the next baseline starts as the whole of the last one and the change
  -- is applied to the copy by the caller before freezing.
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

-- ── 7. permissions ───────────────────────────────────────────────────────
--
-- service_role for the runner; authenticated because these are the sanctioned
-- path a staff action takes. The functions themselves refuse anything the
-- state machine forbids, which is the point of routing writes through them.

do $$
declare fn text;
begin
  foreach fn in array array[
    'projects.open_scope_version(uuid, text, uuid, uuid)',
    'projects.freeze_scope_version(uuid)',
    'projects.submit_change_request(uuid, text, text, uuid)',
    'projects.classify_change_request(uuid, text, text, int, numeric)',
    'projects.decide_change_request(uuid, boolean, uuid)',
    'projects.apply_change_request(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $$;

comment on function projects.freeze_scope_version(uuid) is
  'Freezes a draft into the delivery baseline and supersedes whatever it replaces, under a row lock so two callers cannot both win. Refuses an empty draft: a baseline with nothing in it would answer "no" to every later question about what is in scope.';

comment on function projects.apply_change_request(uuid) is
  'Opens the next baseline by COPYING the active one, so the frozen version is never touched (Doc 11 §29). The caller applies the change to the copy and freezes it. Refuses a request that is not approved.';

comment on function projects.decide_change_request(uuid, boolean, uuid) is
  'Approves or rejects a classified change request. A paid change cannot be approved without a proposal to price it - ADM-22 as a refusal rather than a convention, because there is nowhere else in AgencyOS for that number to live.';

notify pgrst, 'reload schema';
