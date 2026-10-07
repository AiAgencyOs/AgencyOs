-- P5-FEED-02: the PM agent READS a client's feedback on a build and SUGGESTS its classification. It decides nothing: the classification, the defect or
-- Change Request it opens and the routing stay a person's door (classify_build_feedback). A suggestion is a recorded proposal shown beside that door.
create table if not exists projects.build_feedback_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references core.organizations(id) on delete cascade,
  project_id         uuid not null references projects.projects(id) on delete cascade,
  feedback_id        uuid not null unique references projects.build_feedback(id) on delete cascade,
  classification     text not null check (classification in ('bug', 'missed_requirement', 'ui_mismatch', 'included_small_revision', 'clarification', 'possible_scope_change', 'new_feature')),
  reasoning          text not null check (length(btrim(reasoning)) > 0 and length(reasoning) <= 600),
  clarifying_question text check (clarifying_question is null or length(clarifying_question) <= 2000),
  agent_run_id       uuid,
  created_at         timestamptz not null default now(),
  check (classification <> 'clarification' or (clarifying_question is not null and length(btrim(clarifying_question)) > 0))
);
alter table projects.build_feedback_suggestions enable row level security;
drop policy if exists build_feedback_suggestions_read on projects.build_feedback_suggestions;
create policy build_feedback_suggestions_read on projects.build_feedback_suggestions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.build_feedback_suggestions from public, anon;
revoke insert, update, delete on projects.build_feedback_suggestions from authenticated;
grant select on projects.build_feedback_suggestions to authenticated;
grant all on projects.build_feedback_suggestions to service_role;
create trigger build_feedback_suggestions_parent_org_project before insert or update of project_id on projects.build_feedback_suggestions
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
create trigger build_feedback_suggestions_parent_org_feedback before insert or update of feedback_id on projects.build_feedback_suggestions
  for each row execute function core.enforce_parent_org('feedback_id', 'projects.build_feedback');
create trigger freeze_org_build_feedback_suggestions before update of organization_id on projects.build_feedback_suggestions
  for each row execute function core.freeze_organization_id();
create or replace function projects.build_feedback_suggestions_append_only() returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'a suggestion is a record of what the agent proposed: it is never rewritten' using errcode = 'restrict_violation'; end $$;
create trigger build_feedback_suggestions_append_only before update on projects.build_feedback_suggestions for each row execute function projects.build_feedback_suggestions_append_only();

-- the runner records it (service role only), only for feedback that is still waiting to be classified; the organization comes from the FEEDBACK
create or replace function projects.record_feedback_suggestion(p_feedback_id uuid, p_classification text, p_reasoning text, p_question text default null, p_run_id uuid default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_fb projects.build_feedback;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text; return; end if;
  select * into v_fb from projects.build_feedback f where f.id = p_feedback_id;
  if v_fb.id is null then return query select 'not_found'::text; return; end if;
  if v_fb.state <> 'received' then return query select 'already_classified'::text; return; end if;
  begin
    insert into projects.build_feedback_suggestions (organization_id, project_id, feedback_id, classification, reasoning, clarifying_question, agent_run_id)
    values (v_fb.organization_id, v_fb.project_id, v_fb.id, p_classification, left(btrim(p_reasoning), 600), nullif(btrim(coalesce(p_question, '')), ''), p_run_id)
    on conflict (feedback_id) do nothing;
  exception when check_violation then return query select 'bad_input'::text; return;
  end;
  return query select 'recorded'::text;
end $$;
revoke all on function projects.record_feedback_suggestion(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function projects.record_feedback_suggestion(uuid, text, text, text, uuid) to service_role;
notify pgrst, 'reload schema';
