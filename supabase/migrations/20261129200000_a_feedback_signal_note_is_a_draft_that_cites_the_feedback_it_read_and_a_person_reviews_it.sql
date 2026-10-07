-- ═══════════════════════════════════════════════════════════════════════════
-- P7-CS-05 (feedback, adoption signals, complaints): the Customer Success agent may DRAFT a signal note about one project from the client feedback already
-- recorded, citing each feedback row it read. A person reviews or dismisses it. The note changes nothing else: it opens no ticket, no check-in, no
-- opportunity, contacts nobody and prices nothing. The only writer is a service-role door; the only reviewer is a person. Idempotent on a digest of what was
-- said and what it cited. (P7-CS-04, issue classification and routing, is the existing support.propose_ticket_handling workflow and needs nothing here.)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists projects.p789_feedback_signal_drafts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  agent_key           text not null check (agent_key = 'customer_success'),
  signal              text not null check (signal in ('adoption', 'complaint', 'praise', 'mixed')),
  summary             text not null check (length(btrim(summary)) between 20 and 2000 and not projects.p7_has_secret(summary)),
  cited_feedback_ids  uuid[] not null check (cardinality(cited_feedback_ids) between 1 and 20),
  digest              text not null check (digest ~ '^[0-9a-f]{32}$'),
  status              text not null default 'draft' check (status in ('draft', 'reviewed', 'dismissed')),
  reviewed_by         uuid references core.users(id) on delete restrict,
  reviewed_at         timestamptz,
  review_note         text check (review_note is null or (length(btrim(review_note)) between 5 and 1000 and not projects.p7_has_secret(review_note))),
  created_at          timestamptz not null default clock_timestamp(),
  unique (project_id, digest),
  constraint p789_fs_review_is_a_persons check ((status = 'draft') = (reviewed_by is null and reviewed_at is null and review_note is null))
);
comment on table projects.p789_feedback_signal_drafts is 'A Customer Success agent DRAFT about client feedback, citing the feedback rows it read. A person reviews or dismisses it. It changes nothing else.';

drop trigger if exists p789_feedback_signal_drafts_parent_org_project_id on projects.p789_feedback_signal_drafts;
create trigger p789_feedback_signal_drafts_parent_org_project_id before insert or update of project_id, organization_id on projects.p789_feedback_signal_drafts for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
alter table projects.p789_feedback_signal_drafts enable row level security;
drop policy if exists p789_feedback_signal_drafts_read on projects.p789_feedback_signal_drafts;
create policy p789_feedback_signal_drafts_read on projects.p789_feedback_signal_drafts for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on projects.p789_feedback_signal_drafts from public, anon;
revoke insert, update, delete on projects.p789_feedback_signal_drafts from authenticated;
grant select on projects.p789_feedback_signal_drafts to authenticated;
grant all on projects.p789_feedback_signal_drafts to service_role;
drop trigger if exists freeze_org_p789_feedback_signal_drafts on projects.p789_feedback_signal_drafts;
create trigger freeze_org_p789_feedback_signal_drafts before update of organization_id on projects.p789_feedback_signal_drafts for each row execute function core.freeze_organization_id();
drop trigger if exists p789_feedback_signal_drafts_guard on projects.p789_feedback_signal_drafts;
create trigger p789_feedback_signal_drafts_guard before insert or update or delete on projects.p789_feedback_signal_drafts for each row execute function projects.p789_guard('status', 'reviewed_by', 'reviewed_at', 'review_note');

create or replace function projects.p789_record_feedback_signal_draft(p_organization_id uuid, p_project_id uuid, p_agent_key text, p_signal text, p_summary text, p_cited_feedback_ids uuid[])
returns table (outcome text, draft_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_sum text := nullif(btrim(coalesce(p_summary, '')), ''); v_ids uuid[]; v_n int; v_neg int; v_pos int; v_digest text; v_id uuid;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_service'::text, null::uuid; return; end if;
  if p_agent_key is distinct from 'customer_success' then return query select 'not_the_customer_success_agent'::text, null::uuid; return; end if;
  if p_signal is null or p_signal not in ('adoption', 'complaint', 'praise', 'mixed') then return query select 'bad_signal'::text, null::uuid; return; end if;
  if v_sum is null or length(v_sum) < 20 or length(v_sum) > 2000 then return query select 'bad_summary'::text, null::uuid; return; end if;
  if v_sum ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|refund|% off' then return query select 'names_a_price'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_sum) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = p_organization_id and p.deleted_at is null) then return query select 'not_found'::text, null::uuid; return; end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_ids from unnest(coalesce(p_cited_feedback_ids, '{}')) x;
  if cardinality(v_ids) = 0 or cardinality(v_ids) > 20 then return query select 'cite_the_feedback'::text, null::uuid; return; end if;
  select count(*), count(*) filter (where f.sentiment = 'negative'), count(*) filter (where f.sentiment = 'positive') into v_n, v_neg, v_pos
    from projects.client_feedback f where f.id = any (v_ids) and f.project_id = p_project_id and f.organization_id = p_organization_id and f.kind = 'feedback';
  if v_n <> cardinality(v_ids) then return query select 'cited_feedback_not_this_projects'::text, null::uuid; return; end if;
  -- a signal cannot say more than the cited rows do
  if p_signal = 'complaint' and v_neg = 0 then return query select 'a_complaint_cites_negative_feedback'::text, null::uuid; return; end if;
  if p_signal = 'praise' and v_neg > 0 then return query select 'praise_cites_no_negative_feedback'::text, null::uuid; return; end if;
  if p_signal = 'mixed' and (v_neg = 0 or v_pos = 0) then return query select 'mixed_cites_both_kinds'::text, null::uuid; return; end if;
  v_digest := md5(p_signal || '|' || v_sum || '|' || array_to_string(v_ids, ','));
  select d.id into v_id from projects.p789_feedback_signal_drafts d where d.project_id = p_project_id and d.digest = v_digest;
  if v_id is not null then return query select 'already_recorded'::text, v_id; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  insert into projects.p789_feedback_signal_drafts (organization_id, project_id, agent_key, signal, summary, cited_feedback_ids, digest)
  values (p_organization_id, p_project_id, p_agent_key, p_signal, v_sum, v_ids, v_digest) returning id into v_id;
  perform core.record_audit(p_organization_id, 'feedback_signal.drafted', 'project', p_project_id, null, jsonb_build_object('draftId', v_id, 'signal', p_signal));
  return query select 'drafted'::text, v_id;
end $$;
revoke all on function projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[]) from public, anon, authenticated;
grant execute on function projects.p789_record_feedback_signal_draft(uuid, uuid, text, text, text, uuid[]) to service_role;

create or replace function projects.p789_review_feedback_signal_draft(p_draft_id uuid, p_decision text, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_d projects.p789_feedback_signal_drafts;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.is_internal()), false) or not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  if p_decision is null or p_decision not in ('reviewed', 'dismissed') then return query select 'bad_decision'::text; return; end if;
  if p_note is null or length(btrim(p_note)) < 5 then return query select 'note_required'::text; return; end if;
  if projects.p7_has_secret(p_note) then return query select 'contains_secret'::text; return; end if;
  select * into v_d from projects.p789_feedback_signal_drafts x where x.id = p_draft_id and x.organization_id = v_org for update;
  if v_d.id is null then return query select 'not_found'::text; return; end if;
  if v_d.status <> 'draft' then return query select 'already_settled'::text; return; end if;
  perform set_config('projects.p789_door', 'on', true);
  update projects.p789_feedback_signal_drafts set status = p_decision, reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_note = btrim(p_note) where id = v_d.id;
  perform core.record_audit(v_org, 'feedback_signal.' || p_decision, 'project', v_d.project_id, null, jsonb_build_object('draftId', v_d.id));
  return query select p_decision::text;
end $$;
revoke all on function projects.p789_review_feedback_signal_draft(uuid, text, text) from public, anon, service_role;
grant execute on function projects.p789_review_feedback_signal_draft(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
