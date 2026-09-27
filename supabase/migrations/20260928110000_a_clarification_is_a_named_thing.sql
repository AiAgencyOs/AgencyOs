-- Phase 4 PM Agent spec §4.3/§4.6/§8: the PM Agent has no AI workflow at all
-- today — every client-communication behavior the spec names is a
-- deterministic handler that never calls a model. This migration adds the
-- data layer for the first real one: classifying a client's free-text UI
-- revision feedback (already captured verbatim as
-- ui_version_client_decisions.client_words) into the spec's 6-way
-- vocabulary, and giving the CLARIFICATION branch somewhere to land.
--
-- `ui_version_client_decisions` carries an UNCONDITIONAL no-update/no-delete
-- trigger (refuse_ui_version_client_decision_edit, 20260923140000) — "a
-- client decision is a record of what was said, never edited or removed",
-- enforced for every caller, not only an end-user. A classification computed
-- asynchronously, after the decision row already exists, cannot be added as
-- a column on that table. It is its own append-only row instead, one per
-- decision, exactly the same reasoning that table itself already applies to
-- its parent.

create table if not exists projects.client_feedback_classifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  decision_id      uuid not null unique references projects.ui_version_client_decisions(id) on delete cascade,

  -- PM Agent spec §4.6/§8's own six-way vocabulary — "the controlled bridge
  -- between internal agents and the client."
  classification   text not null check (classification in (
                      'CORRECTION',
                      'INCLUDED_REVISION',
                      'CLARIFICATION',
                      'POSSIBLE_SCOPE_CHANGE',
                      'DESIGN_DIRECTION_CHANGE',
                      'REJECTED_REQUEST'
                    )),
  reasoning        text not null check (length(btrim(reasoning)) between 1 and 500),

  created_at       timestamptz not null default now()
);

comment on table projects.client_feedback_classifications is
  'PM Agent spec §4.6/§8. One row per ui_version_client_decisions row (never updated — decisions are append-only and this rides the same discipline), classifying the client''s free-text client_words into the spec''s six categories. Additive: the binary approve/change_requested revision loop (ui_designer:reviseUIVersion) is unaffected by this table''s existence and fires whether or not a classification row exists.';

create trigger client_feedback_classifications_parent_org
  before insert or update of decision_id on projects.client_feedback_classifications
  for each row execute function core.enforce_parent_org('decision_id', 'projects.ui_version_client_decisions');

create trigger client_feedback_classifications_freeze_org
  before update of organization_id on projects.client_feedback_classifications
  for each row execute function core.freeze_organization_id();

alter table projects.client_feedback_classifications enable row level security;
alter table projects.client_feedback_classifications force row level security;

-- Internal-only, same as ui_version_client_decisions itself: a classification
-- is working detail for staff, not something shown raw to a client.
drop policy if exists client_feedback_classifications_select on projects.client_feedback_classifications;
create policy client_feedback_classifications_select on projects.client_feedback_classifications
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.client_feedback_classifications to authenticated, service_role;
grant insert on projects.client_feedback_classifications to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Clarification requests — the CLARIFICATION branch's landing spot. PM Agent
-- spec §4.3: a structured internal->PM->client->PM->requester loop with
-- stored question/answer/evidence. This is the recording half; PM §4.3's
-- full relay-and-re-ask loop is a client-facing behavior this migration does
-- not build (see Tier 1 item 4's own "do not build" finding on PM
-- client-facing delivery — a clarification is relayed by staff, same as
-- every other Task 2 announcement).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.clarification_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  ui_version_id    uuid references projects.ui_versions(id) on delete set null,

  question         text not null check (length(btrim(question)) between 1 and 2000),
  raised_by        text not null default 'project_manager' references ai.agents(key) on delete restrict,

  status           text not null default 'open' check (status in ('open', 'answered')),
  answer           text check (answer is null or length(btrim(answer)) between 1 and 2000),
  answered_at      timestamptz,

  created_at       timestamptz not null default now(),

  constraint clarification_requests_answered_is_dated
    check (status <> 'answered' or (answer is not null and answered_at is not null))
);

comment on table projects.clarification_requests is
  'PM Agent spec §4.3/§8. A clarification the PM Agent could not classify as a correction/revision/scope-change/rejection with confidence, raised for a person to answer and relay. Internal-only — see this migration''s header for why a clarification is not shown raw to the client.';

create trigger clarification_requests_parent_org_project
  before insert or update of project_id on projects.clarification_requests
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

create trigger clarification_requests_parent_org_ui_version
  before insert or update of ui_version_id on projects.clarification_requests
  for each row execute function core.enforce_parent_org('ui_version_id', 'projects.ui_versions');

create trigger clarification_requests_freeze_org
  before update of organization_id on projects.clarification_requests
  for each row execute function core.freeze_organization_id();

alter table projects.clarification_requests enable row level security;
alter table projects.clarification_requests force row level security;

drop policy if exists clarification_requests_select on projects.clarification_requests;
create policy clarification_requests_select on projects.clarification_requests
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

-- answer_clarification_request is SECURITY INVOKER and does its own
-- forbidden/already-answered checks, but RLS is forced regardless of who's
-- asking — an UPDATE with no policy here would silently touch zero rows no
-- matter what the function decided.
drop policy if exists clarification_requests_update on projects.clarification_requests;
create policy clarification_requests_update on projects.clarification_requests
  for update to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))
  with check (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.clarification_requests to authenticated, service_role;
grant insert on projects.clarification_requests to service_role;
grant update on projects.clarification_requests to authenticated;

-- Answering is a person's own act — the spec's clarification loop names a
-- human relay at both ends. security invoker, gated on can_write(), the same
-- authority level every other internal-write door in this schema uses.
create or replace function projects.answer_clarification_request(
  p_id     uuid,
  p_answer text
)
returns table (
  -- 'answered' | 'already_answered' | 'unknown_request' | 'no_answer' | 'no_actor' | 'forbidden'
  outcome                text,
  clarification_request_id uuid
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_actor   uuid := (select auth.uid());
  v_request projects.clarification_requests;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_answer is null or length(btrim(p_answer)) = 0 then
    return query select 'no_answer'::text, null::uuid; return;
  end if;

  select r.* into v_request
    from projects.clarification_requests r
   where r.id = p_id
   for update;

  if v_request.id is null then
    return query select 'unknown_request'::text, null::uuid; return;
  end if;

  if v_request.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_request.status = 'answered' then
    return query select 'already_answered'::text, v_request.id; return;
  end if;

  update projects.clarification_requests
     set status = 'answered', answer = p_answer, answered_at = now()
   where clarification_requests.id = v_request.id;

  perform core.record_audit(
    v_request.organization_id, 'project.clarification_answered', 'clarification_request', v_request.id, null,
    jsonb_build_object('projectId', v_request.project_id)
  );

  return query select 'answered'::text, v_request.id;
end;
$$;

comment on function projects.answer_clarification_request(uuid, text) is
  'PM Agent spec §4.3. A person answers a clarification the PM Agent raised; the answer is relayed to the client the same way every other Task 2 announcement is (staff over WhatsApp) — see ADM-08d.';

revoke all on function projects.answer_clarification_request(uuid, text) from public, anon;
grant execute on function projects.answer_clarification_request(uuid, text) to authenticated;
