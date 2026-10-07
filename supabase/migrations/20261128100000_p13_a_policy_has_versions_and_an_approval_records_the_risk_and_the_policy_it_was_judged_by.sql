-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 rest-gaps, governance (traceability: docs/phase-1-3-implementation-traceability.md):
--   P1-BLUEPRINT-044 / 030 / 031   a policy has versions: draft -> active -> superseded, activated by an admin with a reason, history never mutated
--   P1-QUOTE-018                   the policy version in force at a moment can be asked for (so a decision records the version it was judged by)
--   P1-API-024 / BLUEPRINT-019/020 an approval carries a RISK level and the POLICY VERSION it was judged by, and can be marked EXECUTED and VERIFIED
--                                  separately from being approved (approving is not doing; doing is not checking)
--
-- Nothing here approves anything, sends anything or moves money. An agent has no auth.uid() and holds no grant on these doors, so an agent cannot edit policy.
-- ═══════════════════════════════════════════════════════════════════════════
insert into core.event_types (type, description, canonical) values
  ('policy.version_activated', 'An admin activated a policy version; the previous active version of that kind was superseded.', false),
  ('approval.executed', 'A person recorded that an approved action was carried out. Approval alone does not execute anything.', false),
  ('approval.verified', 'A person recorded that the executed action was checked against what was approved.', false)
on conflict (type) do nothing;

-- ── policy versions ─────────────────────────────────────────────────────────
create table if not exists core.p13_policy_versions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  policy_kind       text not null check (policy_kind in ('pricing', 'discount', 'payment', 'approval', 'trust', 'negotiation', 'follow_up', 'routing', 'data')),
  version           integer not null check (version > 0),
  status            text not null default 'draft' check (status in ('draft', 'active', 'superseded')),
  summary           text not null check (length(btrim(summary)) between 1 and 300),
  body              jsonb not null check (jsonb_typeof(body) = 'object' and length(body::text) <= 20000),
  effective_from    timestamptz,
  created_by        uuid not null references core.users(id) on delete restrict,
  created_at        timestamptz not null default clock_timestamp(),
  activated_by      uuid references core.users(id) on delete restrict,
  activated_at      timestamptz,
  activation_reason text check (activation_reason is null or length(btrim(activation_reason)) between 1 and 500),
  superseded_at     timestamptz,
  superseded_by_id  uuid references core.p13_policy_versions(id) on delete restrict,
  unique (organization_id, policy_kind, version),
  constraint p13_policy_active_says_who check (status = 'draft' or (activated_by is not null and activated_at is not null and activation_reason is not null and effective_from is not null)),
  constraint p13_policy_superseded_says_when check (status <> 'superseded' or (superseded_at is not null and superseded_by_id is not null))
);
comment on table core.p13_policy_versions is
  'P1-BLUEPRINT-044. A governed policy of one kind: draft, active, superseded. One draft and one active per kind. After a version leaves draft its kind, number, summary and body never change and it is never deleted; history is read, not edited. Written only through core.p13_save_policy_draft / p13_activate_policy_version / p13_discard_policy_draft.';
create unique index if not exists p13_policy_versions_one_active on core.p13_policy_versions (organization_id, policy_kind) where status = 'active';
create unique index if not exists p13_policy_versions_one_draft on core.p13_policy_versions (organization_id, policy_kind) where status = 'draft';
create index if not exists p13_policy_versions_history_idx on core.p13_policy_versions (organization_id, policy_kind, version desc);

drop trigger if exists org_match_p13_policy_superseded_by on core.p13_policy_versions;
create trigger org_match_p13_policy_superseded_by before insert or update of superseded_by_id, organization_id on core.p13_policy_versions
  for each row execute function core.enforce_parent_org('superseded_by_id', 'core.p13_policy_versions');
drop trigger if exists freeze_org_p13_policy_versions on core.p13_policy_versions;
create trigger freeze_org_p13_policy_versions before update of organization_id on core.p13_policy_versions
  for each row execute function core.freeze_organization_id();

create or replace function core.p13_policy_versions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'a policy version that was ever active is history and is never deleted' using errcode = 'restrict_violation'; end if;
    return old;
  end if;
  if old.status <> 'draft' then
    if new.policy_kind is distinct from old.policy_kind or new.version is distinct from old.version or new.body is distinct from old.body
       or new.summary is distinct from old.summary or new.effective_from is distinct from old.effective_from or new.activated_at is distinct from old.activated_at
       or new.activated_by is distinct from old.activated_by or new.created_at is distinct from old.created_at then
      raise exception 'a policy version is immutable once activated' using errcode = 'restrict_violation';
    end if;
    if not (old.status = 'active' and new.status = 'superseded') and new.status is distinct from old.status then
      raise exception 'a policy version only moves draft -> active -> superseded' using errcode = 'restrict_violation';
    end if;
  elsif new.status not in ('draft', 'active') then
    raise exception 'a draft becomes active or stays a draft' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
drop trigger if exists p13_policy_versions_guard on core.p13_policy_versions;
create trigger p13_policy_versions_guard before update or delete on core.p13_policy_versions for each row execute function core.p13_policy_versions_guard();

alter table core.p13_policy_versions enable row level security;
alter table core.p13_policy_versions force row level security;
drop policy if exists p13_policy_versions_read on core.p13_policy_versions;
create policy p13_policy_versions_read on core.p13_policy_versions for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on core.p13_policy_versions from public, anon, authenticated;
grant select on core.p13_policy_versions to authenticated;
grant all on core.p13_policy_versions to service_role;

-- the shape each kind's body must have. Unknown extra keys are allowed (a policy may carry notes); the keys named here are validated when present.
create or replace function core.p13_policy_body_problem(p_kind text, p_body jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare v_m numeric; v_h numeric; v_c numeric; v_x text;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'object' then return 'the body must be a JSON object'; end if;
  if p_kind = 'discount' then
    if p_body ? 'max_discount_pct' and (jsonb_typeof(p_body->'max_discount_pct') <> 'number' or (p_body->>'max_discount_pct')::numeric not between 0 and 100) then return 'max_discount_pct must be a number from 0 to 100'; end if;
    if p_body ? 'stacking' and (p_body->>'stacking') not in ('none', 'additive', 'capped') then return 'stacking must be none, additive or capped'; end if;
    if p_body ? 'high_value_threshold_minor' and (jsonb_typeof(p_body->'high_value_threshold_minor') <> 'number' or (p_body->>'high_value_threshold_minor')::numeric < 0) then return 'high_value_threshold_minor must be a non-negative number'; end if;
  elsif p_kind = 'pricing' then
    if p_body ? 'minimum_price_minor' and (jsonb_typeof(p_body->'minimum_price_minor') <> 'number' or (p_body->>'minimum_price_minor')::numeric < 0) then return 'minimum_price_minor must be a non-negative number'; end if;
    if p_body ? 'autonomous_max_minor' and (jsonb_typeof(p_body->'autonomous_max_minor') <> 'number' or (p_body->>'autonomous_max_minor')::numeric < 0) then return 'autonomous_max_minor must be a non-negative number'; end if;
    if p_body ? 'minimum_price_minor' and p_body ? 'autonomous_max_minor' and (p_body->>'autonomous_max_minor')::numeric < (p_body->>'minimum_price_minor')::numeric then return 'the autonomous maximum cannot be below the minimum price'; end if;
  elsif p_kind = 'approval' then
    if p_body ? 'risk_thresholds_minor' then
      if jsonb_typeof(p_body->'risk_thresholds_minor') <> 'object' then return 'risk_thresholds_minor must be an object'; end if;
      for v_x in select jsonb_object_keys(p_body->'risk_thresholds_minor') loop
        if v_x not in ('medium', 'high', 'critical') then return 'risk_thresholds_minor may only name medium, high and critical'; end if;
        if jsonb_typeof(p_body->'risk_thresholds_minor'->v_x) <> 'number' or (p_body->'risk_thresholds_minor'->>v_x)::numeric < 0 then return 'every risk threshold must be a non-negative number'; end if;
      end loop;
      v_m := (p_body->'risk_thresholds_minor'->>'medium')::numeric; v_h := (p_body->'risk_thresholds_minor'->>'high')::numeric; v_c := (p_body->'risk_thresholds_minor'->>'critical')::numeric;
      if (v_m is not null and v_h is not null and v_m > v_h) or (v_h is not null and v_c is not null and v_h > v_c) or (v_m is not null and v_c is not null and v_m > v_c) then return 'thresholds must rise: medium <= high <= critical'; end if;
    end if;
    if p_body ? 'risk_by_subject' then
      if jsonb_typeof(p_body->'risk_by_subject') <> 'object' then return 'risk_by_subject must be an object'; end if;
      for v_x in select jsonb_object_keys(p_body->'risk_by_subject') loop
        if (p_body->'risk_by_subject'->>v_x) not in ('low', 'medium', 'high', 'critical') then return 'risk_by_subject values must be low, medium, high or critical'; end if;
      end loop;
    end if;
  end if;
  return null;
end $$;

create or replace function core.p13_save_policy_draft(p_kind text, p_body jsonb, p_summary text, p_effective_from timestamptz default null)
returns table (outcome text, policy_id uuid, version integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_draft core.p13_policy_versions; v_next integer; v_id uuid; v_problem text;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid, null::integer; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid, null::integer; return; end if;
  if p_kind not in ('pricing', 'discount', 'payment', 'approval', 'trust', 'negotiation', 'follow_up', 'routing', 'data') then return query select 'invalid_kind'::text, null::uuid, null::integer; return; end if;
  if length(btrim(coalesce(p_summary, ''))) = 0 then return query select 'summary_required'::text, null::uuid, null::integer; return; end if;
  v_problem := core.p13_policy_body_problem(p_kind, p_body);
  if v_problem is not null then return query select ('invalid_body: ' || v_problem)::text, null::uuid, null::integer; return; end if;
  if p_effective_from is not null and p_effective_from < clock_timestamp() - interval '1 minute' then return query select 'effective_in_the_past'::text, null::uuid, null::integer; return; end if;

  select * into v_draft from core.p13_policy_versions d where d.organization_id = v_org and d.policy_kind = p_kind and d.status = 'draft' for update;
  if v_draft.id is not null then
    update core.p13_policy_versions set body = p_body, summary = btrim(p_summary), effective_from = p_effective_from where id = v_draft.id;
    v_id := v_draft.id; v_next := v_draft.version;
  else
    -- serialise per kind so two admins cannot take the same number
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || p_kind, 13));
    select coalesce(max(d.version), 0) + 1 into v_next from core.p13_policy_versions d where d.organization_id = v_org and d.policy_kind = p_kind;
    insert into core.p13_policy_versions (organization_id, policy_kind, version, status, summary, body, effective_from, created_by)
      values (v_org, p_kind, v_next, 'draft', btrim(p_summary), p_body, p_effective_from, v_actor) returning id into v_id;
  end if;
  perform core.record_audit(v_org, 'policy.draft_saved', 'policy_version', v_id, null, jsonb_build_object('kind', p_kind, 'version', v_next));
  return query select 'saved'::text, v_id, v_next;
end $$;
revoke all on function core.p13_save_policy_draft(text, jsonb, text, timestamptz) from public, anon;
grant execute on function core.p13_save_policy_draft(text, jsonb, text, timestamptz) to authenticated;

create or replace function core.p13_discard_policy_draft(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_row core.p13_policy_versions;
begin
  if (select auth.uid()) is null then return 'no_actor'; end if;
  if not coalesce((select core.is_admin()), false) then return 'not_authorized'; end if;
  select * into v_row from core.p13_policy_versions d where d.id = p_id and d.organization_id = v_org for update;
  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'draft' then return 'not_a_draft'; end if;
  delete from core.p13_policy_versions where id = v_row.id;
  perform core.record_audit(v_org, 'policy.draft_discarded', 'policy_version', v_row.id, jsonb_build_object('kind', v_row.policy_kind, 'version', v_row.version), null);
  return 'discarded';
end $$;
revoke all on function core.p13_discard_policy_draft(uuid) from public, anon;
grant execute on function core.p13_discard_policy_draft(uuid) to authenticated;

create or replace function core.p13_activate_policy_version(p_id uuid, p_reason text)
returns table (outcome text, superseded_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
  v_new core.p13_policy_versions; v_old core.p13_policy_versions; v_now timestamptz := clock_timestamp(); v_problem text; v_eff timestamptz;
begin
  if v_actor is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.is_admin()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return query select 'reason_required'::text, null::uuid; return; end if;
  select * into v_new from core.p13_policy_versions d where d.id = p_id and d.organization_id = v_org for update;
  if v_new.id is null then return query select 'not_found'::text, null::uuid; return; end if;
  if v_new.status <> 'draft' then return query select 'not_a_draft'::text, null::uuid; return; end if;
  -- the body is re-validated at activation: a draft written under an older rule does not slip through
  v_problem := core.p13_policy_body_problem(v_new.policy_kind, v_new.body);
  if v_problem is not null then return query select ('invalid_body: ' || v_problem)::text, null::uuid; return; end if;
  select * into v_old from core.p13_policy_versions d where d.organization_id = v_org and d.policy_kind = v_new.policy_kind and d.status = 'active' for update;

  v_eff := greatest(coalesce(v_new.effective_from, v_now), v_now);
  -- supersede first, so the one-active unique index is never violated. The old version stays IN FORCE until the new one takes effect (superseded_at = the
  -- new version's effective_from), so a scheduled activation leaves no gap.
  if v_old.id is not null then
    update core.p13_policy_versions set status = 'superseded', superseded_at = v_eff, superseded_by_id = v_new.id where id = v_old.id;
  end if;
  update core.p13_policy_versions
     set status = 'active', activated_by = v_actor, activated_at = v_now, activation_reason = left(btrim(p_reason), 500), effective_from = v_eff
   where id = v_new.id;
  perform core.record_audit(v_org, 'policy.version_activated', 'policy_version', v_new.id,
    case when v_old.id is null then null else jsonb_build_object('version', v_old.version) end,
    jsonb_build_object('kind', v_new.policy_kind, 'version', v_new.version, 'reason', left(btrim(p_reason), 500)));
  perform core.emit_event(v_org, 'policy.version_activated', 'policy_version', v_new.id, jsonb_build_object('kind', v_new.policy_kind, 'version', v_new.version, 'supersedes', v_old.id));
  return query select 'activated'::text, v_old.id;
end $$;
revoke all on function core.p13_activate_policy_version(uuid, text) from public, anon;
grant execute on function core.p13_activate_policy_version(uuid, text) to authenticated;

-- The version in force at a moment (default: now). A superseded version answers for the moments it WAS in force, so a decision made last month still
-- resolves to the version it was judged by.
create or replace function core.p13_policy_version_in_force(p_organization_id uuid, p_kind text, p_at timestamptz default clock_timestamp())
returns uuid language sql stable security definer set search_path = '' as $$
  select v.id from core.p13_policy_versions v
   where v.organization_id = p_organization_id and v.policy_kind = p_kind and v.status in ('active', 'superseded')
     and v.activated_at <= p_at and v.effective_from <= p_at
   order by v.version desc limit 1;      -- the newest version already in effect; an older one is in force until a newer one takes effect
$$;
revoke all on function core.p13_policy_version_in_force(uuid, text, timestamptz) from public, anon;
grant execute on function core.p13_policy_version_in_force(uuid, text, timestamptz) to authenticated, service_role;

-- ── approval annotations ────────────────────────────────────────────────────
create table if not exists approvals.p13_approval_annotations (
  approval_request_id uuid primary key references approvals.approval_requests(id) on delete cascade,
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  risk_level          text not null check (risk_level in ('low', 'medium', 'high', 'critical', 'unrated')),
  risk_source         text not null check (risk_source in ('policy', 'admin', 'no_policy')),
  policy_version_id   uuid references core.p13_policy_versions(id) on delete restrict,
  task_ref            uuid,
  executed_at         timestamptz,
  executed_by         uuid references core.users(id) on delete set null,
  execution_note      text check (execution_note is null or length(execution_note) <= 1000),
  verified_at         timestamptz,
  verified_by         uuid references core.users(id) on delete set null,
  verification_note   text check (verification_note is null or length(verification_note) <= 1000),
  created_at          timestamptz not null default clock_timestamp(),
  constraint p13_annotation_verified_after_executed check (verified_at is null or (executed_at is not null and verified_at >= executed_at)),
  constraint p13_annotation_policy_when_policy_rated check (risk_source <> 'policy' or policy_version_id is not null)
);
comment on table approvals.p13_approval_annotations is
  'P1-API-024. What the approval engine does not carry: the risk level, the policy version the request was judged by, and the executed / verified stamps. One row per approval request, written by the AFTER INSERT trigger on approvals.approval_requests and by the doors below. Approving never sets executed.';
create index if not exists p13_approval_annotations_org_idx on approvals.p13_approval_annotations (organization_id, risk_level);

drop trigger if exists org_match_p13_annotation_request on approvals.p13_approval_annotations;
create trigger org_match_p13_annotation_request before insert or update of approval_request_id, organization_id on approvals.p13_approval_annotations
  for each row execute function core.enforce_parent_org('approval_request_id', 'approvals.approval_requests');
drop trigger if exists org_match_p13_annotation_policy on approvals.p13_approval_annotations;
create trigger org_match_p13_annotation_policy before insert or update of policy_version_id, organization_id on approvals.p13_approval_annotations
  for each row execute function core.enforce_parent_org('policy_version_id', 'core.p13_policy_versions');
drop trigger if exists freeze_org_p13_approval_annotations on approvals.p13_approval_annotations;
create trigger freeze_org_p13_approval_annotations before update of organization_id on approvals.p13_approval_annotations
  for each row execute function core.freeze_organization_id();

alter table approvals.p13_approval_annotations enable row level security;
alter table approvals.p13_approval_annotations force row level security;
drop policy if exists p13_approval_annotations_read on approvals.p13_approval_annotations;
create policy p13_approval_annotations_read on approvals.p13_approval_annotations for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));
revoke all on approvals.p13_approval_annotations from public, anon, authenticated;
grant select on approvals.p13_approval_annotations to authenticated;
grant all on approvals.p13_approval_annotations to service_role;

-- Risk from the approval policy in force: by amount (thresholds) or by subject type; with no policy it is honestly 'unrated'.
create or replace function approvals.p13_derive_risk(p_organization_id uuid, p_amount_minor bigint, p_subject_type text, p_at timestamptz default clock_timestamp())
returns table (risk_level text, risk_source text, policy_version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_pv uuid; v_body jsonb; v_t jsonb; v_level text;
begin
  v_pv := core.p13_policy_version_in_force(p_organization_id, 'approval', p_at);
  if v_pv is null then return query select 'unrated'::text, 'no_policy'::text, null::uuid; return; end if;
  select b.body into v_body from core.p13_policy_versions b where b.id = v_pv;
  v_t := v_body->'risk_thresholds_minor';
  if p_amount_minor is not null and v_t is not null then
    v_level := case
      when v_t ? 'critical' and p_amount_minor >= (v_t->>'critical')::numeric then 'critical'
      when v_t ? 'high' and p_amount_minor >= (v_t->>'high')::numeric then 'high'
      when v_t ? 'medium' and p_amount_minor >= (v_t->>'medium')::numeric then 'medium'
      else 'low' end;
  end if;
  v_level := coalesce(v_level, v_body->'risk_by_subject'->>p_subject_type, 'low');
  return query select v_level, 'policy'::text, v_pv;
end $$;
revoke all on function approvals.p13_derive_risk(uuid, bigint, text, timestamptz) from public, anon;
grant execute on function approvals.p13_derive_risk(uuid, bigint, text, timestamptz) to authenticated, service_role;

create or replace function approvals.p13_annotate_new_request()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  select * into r from approvals.p13_derive_risk(new.organization_id, new.amount_minor, new.subject_type, clock_timestamp());
  insert into approvals.p13_approval_annotations (approval_request_id, organization_id, risk_level, risk_source, policy_version_id)
    values (new.id, new.organization_id, r.risk_level, r.risk_source, r.policy_version_id) on conflict (approval_request_id) do nothing;
  return new;
end $$;
drop trigger if exists p13_annotate_new_request on approvals.approval_requests;
create trigger p13_annotate_new_request after insert on approvals.approval_requests for each row execute function approvals.p13_annotate_new_request();

-- requests that already exist are annotated honestly: judged by whatever policy was in force when they were raised (usually none)
insert into approvals.p13_approval_annotations (approval_request_id, organization_id, risk_level, risk_source, policy_version_id)
select r.id, r.organization_id, d.risk_level, d.risk_source, d.policy_version_id
  from approvals.approval_requests r
  cross join lateral approvals.p13_derive_risk(r.organization_id, r.amount_minor, r.subject_type, r.created_at) d
on conflict (approval_request_id) do nothing;

create or replace function approvals.p13_set_approval_risk(p_request_id uuid, p_risk text, p_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_req approvals.approval_requests; v_before text;
begin
  if (select auth.uid()) is null then return 'no_actor'; end if;
  if not coalesce((select core.is_admin()), false) then return 'not_authorized'; end if;
  if p_risk not in ('low', 'medium', 'high', 'critical') then return 'invalid_risk'; end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then return 'reason_required'; end if;
  select * into v_req from approvals.approval_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_req.id is null then return 'not_found'; end if;
  if v_req.state <> 'pending' then return 'already_decided'; end if;   -- a decision is judged by the risk it was made under
  select a.risk_level into v_before from approvals.p13_approval_annotations a where a.approval_request_id = v_req.id for update;
  update approvals.p13_approval_annotations set risk_level = p_risk, risk_source = 'admin' where approval_request_id = v_req.id;
  perform core.record_audit(v_org, 'approval.risk_set', 'approval_request', v_req.id, jsonb_build_object('risk', v_before), jsonb_build_object('risk', p_risk, 'reason', left(btrim(p_reason), 500)));
  return 'set';
end $$;
revoke all on function approvals.p13_set_approval_risk(uuid, text, text) from public, anon;
grant execute on function approvals.p13_set_approval_risk(uuid, text, text) to authenticated;

create or replace function approvals.p13_mark_approval_executed(p_request_id uuid, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_req approvals.approval_requests; v_a approvals.p13_approval_annotations;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not coalesce((select core.is_admin()), false) then return 'not_authorized'; end if;
  select * into v_req from approvals.approval_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_req.id is null then return 'not_found'; end if;
  if v_req.state <> 'approved' then return 'not_approved'; end if;          -- only an approval can be carried out
  select * into v_a from approvals.p13_approval_annotations a where a.approval_request_id = v_req.id for update;
  if v_a.approval_request_id is null then return 'not_annotated'; end if;
  if v_a.executed_at is not null then return 'already_executed'; end if;
  update approvals.p13_approval_annotations set executed_at = clock_timestamp(), executed_by = v_actor, execution_note = nullif(left(btrim(coalesce(p_note, '')), 1000), '') where approval_request_id = v_req.id;
  perform core.record_audit(v_org, 'approval.executed', 'approval_request', v_req.id, null, jsonb_build_object('subject', v_req.subject_type, 'subjectId', v_req.subject_id));
  perform core.emit_event(v_org, 'approval.executed', 'approval_request', v_req.id, jsonb_build_object('subjectType', v_req.subject_type, 'subjectId', v_req.subject_id));
  return 'executed';
end $$;
revoke all on function approvals.p13_mark_approval_executed(uuid, text) from public, anon;
grant execute on function approvals.p13_mark_approval_executed(uuid, text) to authenticated;

create or replace function approvals.p13_mark_approval_verified(p_request_id uuid, p_note text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_req approvals.approval_requests; v_a approvals.p13_approval_annotations;
begin
  if v_actor is null then return 'no_actor'; end if;
  if not coalesce((select core.is_admin()), false) then return 'not_authorized'; end if;
  select * into v_req from approvals.approval_requests r where r.id = p_request_id and r.organization_id = v_org for update;
  if v_req.id is null then return 'not_found'; end if;
  select * into v_a from approvals.p13_approval_annotations a where a.approval_request_id = v_req.id for update;
  if v_a.approval_request_id is null then return 'not_annotated'; end if;
  if v_a.executed_at is null then return 'not_executed'; end if;            -- nothing to check yet
  if v_a.verified_at is not null then return 'already_verified'; end if;
  update approvals.p13_approval_annotations set verified_at = clock_timestamp(), verified_by = v_actor, verification_note = nullif(left(btrim(coalesce(p_note, '')), 1000), '') where approval_request_id = v_req.id;
  perform core.record_audit(v_org, 'approval.verified', 'approval_request', v_req.id, null, jsonb_build_object('subject', v_req.subject_type, 'subjectId', v_req.subject_id));
  perform core.emit_event(v_org, 'approval.verified', 'approval_request', v_req.id, jsonb_build_object('subjectType', v_req.subject_type, 'subjectId', v_req.subject_id));
  return 'verified';
end $$;
revoke all on function approvals.p13_mark_approval_verified(uuid, text) from public, anon;
grant execute on function approvals.p13_mark_approval_verified(uuid, text) to authenticated;

notify pgrst, 'reload schema';
