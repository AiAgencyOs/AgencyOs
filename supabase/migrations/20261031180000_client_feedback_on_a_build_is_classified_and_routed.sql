-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 client test loop: every piece of client feedback on a shared development build is classified into exactly one of
--   BUG | MISSED_REQUIREMENT | UI_MISMATCH | INCLUDED_SMALL_REVISION | CLARIFICATION | POSSIBLE_SCOPE_CHANGE | NEW_FEATURE
-- and routed:  BUG / MISSED_REQUIREMENT / UI_MISMATCH -> a mandatory defect (the FIX_READY != VERIFIED loop);
--              INCLUDED_SMALL_REVISION -> the controlled revision flow (no defect, no change request);
--              CLARIFICATION -> resolve before implementing;
--              POSSIBLE_SCOPE_CHANGE / NEW_FEATURE -> a CHANGE REQUEST. "Do not implement a new client feature as a bug to make it free."
--
-- Enforced here, not by prompt: the classification is written once (a routed piece of feedback cannot be re-labelled), and a scope-changing
-- classification can only ever produce a change request, never a defect.
-- Reuses projects.change_requests (submit_change_request) and qa.defects; the only new table is the feedback record itself.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.build_feedback (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  deliverable_id     uuid not null references projects.deliverables(id) on delete restrict,
  client_words       text not null check (length(btrim(client_words)) > 0 and length(client_words) <= 4000),
  evidence_ref       text,
  classification     text check (classification in ('bug', 'missed_requirement', 'ui_mismatch', 'included_small_revision',
                                                    'clarification', 'possible_scope_change', 'new_feature')),
  state              text not null default 'received' check (state in ('received', 'routed', 'clarification_needed')),
  defect_id          uuid references qa.defects(id) on delete set null,
  change_request_id  uuid references projects.change_requests(id) on delete set null,
  classified_by      uuid references core.users(id) on delete set null,
  classified_at      timestamptz,
  recorded_by        uuid references core.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  check ((state = 'received') = (classification is null)),
  -- the rule that matters: scope-changing feedback has a change request and NEVER a defect
  check (classification not in ('possible_scope_change', 'new_feature') or defect_id is null)
);
create index if not exists build_feedback_build_idx on projects.build_feedback (deliverable_id, created_at);

alter table projects.build_feedback enable row level security;
drop policy if exists build_feedback_read on projects.build_feedback;
create policy build_feedback_read on projects.build_feedback for select to authenticated
  using (organization_id = (select core.current_organization_id()));
grant select on projects.build_feedback to authenticated;
grant all on projects.build_feedback to service_role;

do $$
declare r record;
begin
  for r in select * from (values
    ('project_id', 'projects.projects'), ('deliverable_id', 'projects.deliverables'),
    ('defect_id', 'qa.defects'), ('change_request_id', 'projects.change_requests')
  ) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.build_feedback', 'build_feedback_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.build_feedback for each row execute function core.enforce_parent_org(%L, %L)',
                   'build_feedback_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_build_feedback on projects.build_feedback;
create trigger freeze_org_build_feedback before update of organization_id on projects.build_feedback for each row execute function core.freeze_organization_id();

-- the words and the classification are written once
create or replace function projects.build_feedback_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'client feedback is a record and is never deleted' using errcode = 'restrict_violation';
  end if;
  if new.client_words is distinct from old.client_words or new.deliverable_id is distinct from old.deliverable_id
     or new.project_id is distinct from old.project_id or new.created_at is distinct from old.created_at then
    raise exception 'what the client said, and about which build, is never edited' using errcode = 'restrict_violation';
  end if;
  if old.classification is not null and new.classification is distinct from old.classification then
    raise exception 'a routed piece of feedback cannot be re-labelled: a new feature does not become a bug' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists build_feedback_guard on projects.build_feedback;
create trigger build_feedback_guard before update or delete on projects.build_feedback
  for each row execute function projects.build_feedback_guard();

create or replace function projects.record_build_feedback(p_deliverable_id uuid, p_client_words text, p_evidence_ref text default null)
returns table (outcome text, feedback_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_row   projects.deliverables;
  v_new   uuid;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if p_client_words is null or length(btrim(p_client_words)) = 0 then return query select 'empty'::text, null::uuid; return; end if;
  select * into v_row from projects.deliverables d where d.id = p_deliverable_id and d.organization_id = v_org;
  if v_row.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_row.kind <> 'build' then return query select 'wrong_kind'::text, null::uuid; return; end if;
  -- feedback is about a build the client was actually given
  if v_row.status not in ('in_review', 'changes_requested', 'approved') then return query select 'not_shared'::text, null::uuid; return; end if;

  insert into projects.build_feedback (organization_id, project_id, deliverable_id, client_words, evidence_ref, recorded_by)
  values (v_row.organization_id, v_row.project_id, v_row.id, p_client_words, p_evidence_ref, v_actor)
  returning id into v_new;
  perform core.record_audit(v_row.organization_id, 'build.feedback_received', 'build_feedback', v_new, null,
    jsonb_build_object('projectId', v_row.project_id, 'deliverableId', v_row.id));
  return query select 'recorded'::text, v_new;
end $$;
revoke all on function projects.record_build_feedback(uuid, text, text) from public, anon;
grant execute on function projects.record_build_feedback(uuid, text, text) to authenticated;

create or replace function projects.classify_build_feedback(p_feedback_id uuid, p_classification text)
returns table (outcome text, defect_id uuid, change_request_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_fb    projects.build_feedback;
  v_defect uuid;
  v_cr    record;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::uuid; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text, null::uuid, null::uuid; return; end if;
  if p_classification not in ('bug', 'missed_requirement', 'ui_mismatch', 'included_small_revision', 'clarification', 'possible_scope_change', 'new_feature') then
    return query select 'bad_classification'::text, null::uuid, null::uuid; return;
  end if;
  select * into v_fb from projects.build_feedback f where f.id = p_feedback_id and f.organization_id = v_org for update;
  if v_fb.id is null then return query select 'not_found'::text, null::uuid, null::uuid; return; end if;
  if v_fb.classification is not null then
    return query select 'already_classified'::text, v_fb.defect_id, v_fb.change_request_id; return;
  end if;

  if p_classification in ('bug', 'missed_requirement', 'ui_mismatch') then
    insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, reported_by)
    values (v_fb.organization_id, v_fb.project_id, v_fb.deliverable_id,
            case p_classification when 'ui_mismatch' then 'minor' else 'major' end,
            left('Client feedback (' || p_classification || '): ' || v_fb.client_words, 200),
            v_fb.client_words, v_actor)
    returning id into v_defect;
    update projects.build_feedback set classification = p_classification, state = 'routed', defect_id = v_defect, classified_by = v_actor, classified_at = now() where id = v_fb.id;
    perform core.record_audit(v_fb.organization_id, 'build.feedback_routed_to_defect', 'build_feedback', v_fb.id, null, jsonb_build_object('classification', p_classification, 'defectId', v_defect));
    return query select 'defect_raised'::text, v_defect, null::uuid; return;
  end if;

  if p_classification in ('possible_scope_change', 'new_feature') then
    select * into v_cr from projects.submit_change_request(v_fb.project_id, v_fb.client_words, 'client', null);
    if v_cr.outcome <> 'submitted' and v_cr.outcome <> 'created' and v_cr.change_request_id is null then
      return query select v_cr.outcome, null::uuid, null::uuid; return;
    end if;
    update projects.build_feedback set classification = p_classification, state = 'routed', change_request_id = v_cr.change_request_id, classified_by = v_actor, classified_at = now() where id = v_fb.id;
    perform core.record_audit(v_fb.organization_id, 'build.feedback_routed_to_change_request', 'build_feedback', v_fb.id, null, jsonb_build_object('classification', p_classification, 'changeRequestId', v_cr.change_request_id));
    return query select 'change_request_raised'::text, null::uuid, v_cr.change_request_id; return;
  end if;

  update projects.build_feedback
     set classification = p_classification,
         state = case p_classification when 'clarification' then 'clarification_needed' else 'routed' end,
         classified_by = v_actor, classified_at = now()
   where id = v_fb.id;
  return query select case p_classification when 'clarification' then 'clarification_needed' else 'revision_routed' end::text, null::uuid, null::uuid;
end $$;
revoke all on function projects.classify_build_feedback(uuid, text) from public, anon;
grant execute on function projects.classify_build_feedback(uuid, text) to authenticated;

notify pgrst, 'reload schema';
