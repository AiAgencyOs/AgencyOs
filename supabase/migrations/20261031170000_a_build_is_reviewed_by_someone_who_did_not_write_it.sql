-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 Security & Code Review spec: independent review of the exact commit; DEVELOPER CANNOT APPROVE ITS OWN CODE; a reviewer who
-- materially changes the code needs a SECOND independent reviewer; critical/high findings block acceptance; a review of an older
-- commit is stale.
--
--   projects.code_reviews          one row per review of one build's commit (reviewer, findings, verdict)
--   projects.record_code_review    the only door; refuses self-review (the build's producer), a reviewer who is not named, and a "passed"
--                                  verdict that carries a critical/high finding
--   projects.build_review_status   'passed' only when a passed review names THE CURRENT commit, with a second independent reviewer when any
--                                  reviewer changed the code; otherwise missing / stale / changes_required / blocked / needs_second
--   submit_deliverable             a build is not shared with the client without a 'passed' status (no override door)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.code_reviews (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references core.organizations(id) on delete cascade,
  project_id           uuid not null references projects.projects(id) on delete cascade,
  deliverable_id       uuid not null references projects.deliverables(id) on delete restrict,
  commit_ref           text not null check (length(btrim(commit_ref)) > 0),
  reviewer_id          uuid references core.users(id) on delete set null,
  reviewer_agent       text,
  producer_id          uuid references core.users(id) on delete set null,
  verdict              text not null check (verdict in ('passed', 'changes_required', 'blocked')),
  findings             jsonb not null default '[]'::jsonb,
  reviewer_changed_code boolean not null default false,
  note                 text check (note is null or length(note) <= 2000),
  reviewed_at          timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  check ((reviewer_id is null) <> (reviewer_agent is null)),
  check (jsonb_typeof(findings) = 'array')
);
create index if not exists code_reviews_build_idx on projects.code_reviews (deliverable_id, reviewed_at desc);

alter table projects.code_reviews enable row level security;
drop policy if exists code_reviews_read on projects.code_reviews;
create policy code_reviews_read on projects.code_reviews for select to authenticated
  using (organization_id = (select core.current_organization_id()));
grant select on projects.code_reviews to authenticated;
grant all on projects.code_reviews to service_role;

do $$
declare r record;
begin
  for r in select * from (values
    ('project_id', 'projects.projects'), ('deliverable_id', 'projects.deliverables')
  ) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.code_reviews', 'code_reviews_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.code_reviews for each row execute function core.enforce_parent_org(%L, %L)',
                   'code_reviews_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_code_reviews on projects.code_reviews;
create trigger freeze_org_code_reviews before update of organization_id on projects.code_reviews for each row execute function core.freeze_organization_id();

-- A review is a record of what was judged: it is never edited or deleted. A new commit gets a NEW review.
create or replace function projects.code_reviews_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'a code review is a record; a new commit needs a new review' using errcode = 'restrict_violation';
end $$;
drop trigger if exists code_reviews_append_only on projects.code_reviews;
create trigger code_reviews_append_only before update or delete on projects.code_reviews
  for each row execute function projects.code_reviews_append_only();

create or replace function projects.record_code_review(
  p_deliverable_id uuid, p_verdict text, p_findings jsonb default '[]', p_reviewer_changed_code boolean default false, p_note text default null
)
returns table (outcome text, review_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_org    uuid := (select core.current_organization_id());
  v_row    projects.deliverables;
  v_commit text;
  v_new    uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_verdict not in ('passed', 'changes_required', 'blocked') then return query select 'bad_verdict'::text, null::uuid; return; end if;
  if p_findings is null or jsonb_typeof(p_findings) <> 'array' then return query select 'bad_findings'::text, null::uuid; return; end if;

  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org;
  if v_row.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text, null::uuid; return; end if;

  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = v_row.id;
  if nullif(btrim(coalesce(v_commit, '')), '') is null then return query select 'no_commit'::text, null::uuid; return; end if;

  -- DEVELOPER CANNOT APPROVE ITS OWN CODE
  if v_row.created_by is not null and v_row.created_by = v_actor then
    return query select 'self_review'::text, null::uuid; return;
  end if;

  -- critical / high findings block acceptance: a pass cannot carry one
  if p_verdict = 'passed' and exists (
       select 1 from jsonb_array_elements(p_findings) f where lower(f->>'severity') in ('critical', 'high')) then
    return query select 'blocking_finding'::text, null::uuid; return;
  end if;

  insert into projects.code_reviews (organization_id, project_id, deliverable_id, commit_ref, reviewer_id, producer_id, verdict, findings, reviewer_changed_code, note)
  values (v_row.organization_id, v_row.project_id, v_row.id, v_commit, v_actor, v_row.created_by, p_verdict, p_findings, coalesce(p_reviewer_changed_code, false), p_note)
  returning id into v_new;

  perform core.record_audit(v_row.organization_id, 'build.code_reviewed', 'deliverable', v_row.id, null,
    jsonb_build_object('projectId', v_row.project_id, 'commit', v_commit, 'verdict', p_verdict, 'reviewerChangedCode', coalesce(p_reviewer_changed_code, false)));
  return query select 'recorded'::text, v_new;
end $$;
revoke all on function projects.record_code_review(uuid, text, jsonb, boolean, text) from public, anon;
grant execute on function projects.record_code_review(uuid, text, jsonb, boolean, text) to authenticated;

create or replace function projects.build_review_status(p_deliverable_id uuid)
returns table (verdict text, reviewed_commit text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_commit text;
  v_latest projects.code_reviews;
  v_changed boolean;
  v_independent int;
begin
  select dd.commit_ref into v_commit from projects.deliverable_details dd where dd.deliverable_id = p_deliverable_id;
  select r.* into v_latest from projects.code_reviews r where r.deliverable_id = p_deliverable_id order by r.reviewed_at desc, r.created_at desc limit 1;
  if v_latest.id is null then return query select 'missing'::text, null::text; return; end if;
  -- a review of a different commit is stale: it said nothing about THIS code
  if v_latest.commit_ref is distinct from v_commit then return query select 'stale'::text, v_latest.commit_ref; return; end if;
  if v_latest.verdict = 'blocked' then return query select 'blocked'::text, v_latest.commit_ref; return; end if;
  if v_latest.verdict = 'changes_required' then return query select 'changes_required'::text, v_latest.commit_ref; return; end if;
  -- a reviewer who materially edited the code is no longer independent of it: a SECOND reviewer must pass the same commit
  select bool_or(r.reviewer_changed_code) into v_changed from projects.code_reviews r where r.deliverable_id = p_deliverable_id and r.commit_ref = v_commit;
  if coalesce(v_changed, false) then
    select count(distinct r.reviewer_id) into v_independent
      from projects.code_reviews r
     where r.deliverable_id = p_deliverable_id and r.commit_ref = v_commit and r.verdict = 'passed' and r.reviewer_changed_code = false and r.reviewer_id is not null;
    if v_independent = 0 then return query select 'needs_second'::text, v_commit; return; end if;
  end if;
  return query select 'passed'::text, v_commit;
end $$;
revoke all on function projects.build_review_status(uuid) from public, anon;
grant execute on function projects.build_review_status(uuid) to authenticated, service_role;

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
  -- Phase 5: a DEVELOPMENT BUILD goes to the client on the same terms, with NO override door, and only when it resolves to an exact
  -- commit ("a review/client build must always resolve back to an exact commit").
  if v_row.kind = 'build' and not exists (
       select 1 from projects.deliverable_details dd where dd.deliverable_id = v_row.id and nullif(btrim(dd.commit_ref), '') is not null) then
    return query select 'no_commit'::text, null::uuid, v_row.status;
    return;
  end if;

  -- Phase 5 Security & Code Review: the exact commit being shared has a PASSED independent review (projects.build_review_status).
  if v_row.kind = 'build' then
    select * into v_gate from projects.build_review_status(v_row.id);
    if v_gate.verdict is distinct from 'passed' then
      return query select ('review_' || coalesce(v_gate.verdict, 'missing'))::text, null::uuid, v_row.status;
      return;
    end if;
  end if;

  if (v_row.kind = 'build'
      or (v_row.kind = 'prototype' and coalesce(current_setting('app.prototype_send_override', true), '') <> 'on')) then
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

revoke all on function projects.submit_deliverable(uuid, uuid, text) from public, anon;
grant execute on function projects.submit_deliverable(uuid, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
