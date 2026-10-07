-- ═════════════════════════════════════════════════════════════════
-- Phase 8D: value reports as DRAFTS of cited facts. Nothing here sends, and nothing here invents a metric.
--
-- A value report tells a client what was done for them in a period. It is assembled from FACTS ONLY, every fact citing the source row it came from:
--
--   ticket_resolved          projects.support_tickets      closed in the period (one fact per ticket)
--   change_released          projects.maintenance_work_items  released in the period, with the deployment reference a person recorded
--   hours_logged             projects.time_logs            hours a person logged on the client's projects, per project, citing every log row
--   production_verification  projects.release_verifications  a person's dated post-deploy check of a production release, with its evidence link
--
-- There is NO uptime fact: AgencyOS measures no uptime. The nearest recorded evidence is the production verification above, and the report says so rather
-- than stating a percentage. There is no satisfaction score, no savings figure, no "value delivered" number.
--
--   projects.value_report_facts(client, start, end)   the SQL read: (facts jsonb, digest). The facts are immutable once stored.
--   projects.value_report_drafts                      the draft: facts (frozen), the sentence-template VERSION that rendered the body, and the body a person edits.
--   store / edit / approve / discard doors            a person (or an agent, as a draft) stores; a person edits, approves or discards. Approving sends nothing:
--                                                     it marks the wording a person stands behind. The wording is rendered in TypeScript from the facts
--                                                     (src/modules/projects/value-report.ts); the door recomputes the facts and refuses a body rendered from
--                                                     facts that have since changed (digest mismatch).
-- ═════════════════════════════════════════════════════════════════

create or replace function projects.value_facts_all_cited(p_facts jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_facts) = 'array' and jsonb_array_length(p_facts) > 0
     and not exists (
       select 1 from jsonb_array_elements(p_facts) f
        where jsonb_typeof(f -> 'sources') is distinct from 'array' or jsonb_array_length(coalesce(f -> 'sources', '[]'::jsonb)) = 0
           or coalesce(f ->> 'type', '') = '' or coalesce(f ->> 'label', '') = '');
$$;

create table if not exists projects.value_report_drafts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete restrict,
  period_start      date not null,
  period_end        date not null,
  template_version  int not null check (template_version >= 1),
  facts             jsonb not null,
  facts_digest      text not null check (length(facts_digest) = 32),
  body              text not null check (length(btrim(body)) between 20 and 8000),
  status            text not null default 'draft' check (status in ('draft', 'approved', 'discarded')),
  built_by          uuid references core.users(id) on delete restrict,
  built_by_agent    text check (built_by_agent is null or length(btrim(built_by_agent)) between 1 and 80),
  built_at          timestamptz not null default clock_timestamp(),
  edited_by         uuid references core.users(id) on delete restrict,
  edited_at         timestamptz,
  approved_by       uuid references core.users(id) on delete restrict,
  approved_at       timestamptz,
  discarded_by      uuid references core.users(id) on delete restrict,
  discarded_at      timestamptz,
  discard_reason    text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint value_report_period_is_forward check (period_end >= period_start and period_end - period_start <= 400),
  constraint value_report_facts_are_cited check (projects.value_facts_all_cited(facts)),
  constraint value_report_has_one_author check ((built_by is not null) <> (built_by_agent is not null)),
  constraint value_report_approved_is_a_persons check ((status = 'approved') = (approved_by is not null and approved_at is not null)),
  constraint value_report_discard_says_why check ((status = 'discarded') = (discarded_by is not null and discarded_at is not null and length(btrim(coalesce(discard_reason, ''))) >= 5)),
  constraint value_report_body_names_no_price check (body !~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off')
);
create index if not exists value_report_drafts_client_idx on projects.value_report_drafts (client_account_id, period_end desc, created_at desc);
comment on table projects.value_report_drafts is 'A value report DRAFT: frozen cited facts, the template version that rendered the body, and a body a person edits, approves or discards. Facts only; no uptime, score or savings figure exists. Nothing here sends.';

-- the facts, the period, the client and the template version never change; once approved or discarded nothing does
create or replace function projects.value_report_drafts_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.client_account_id is distinct from old.client_account_id or new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end
       or new.facts is distinct from old.facts or new.facts_digest is distinct from old.facts_digest or new.template_version is distinct from old.template_version
       or new.built_by is distinct from old.built_by or new.built_by_agent is distinct from old.built_by_agent or new.built_at is distinct from old.built_at then
      raise exception 'the facts, period, client and template version of a value report draft are frozen' using errcode = 'restrict_violation';
    end if;
    if old.status <> 'draft' then
      raise exception 'a % value report is final', old.status using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;

do $$
begin
  execute 'alter table projects.value_report_drafts enable row level security';
  execute 'drop policy if exists value_report_drafts_read on projects.value_report_drafts';
  execute $p$create policy value_report_drafts_read on projects.value_report_drafts for select to authenticated using (organization_id = (select core.current_organization_id()) and (select core.is_internal()))$p$;
  execute 'revoke all on projects.value_report_drafts from public, anon';
  execute 'revoke insert, update, delete on projects.value_report_drafts from authenticated';
  execute 'grant select on projects.value_report_drafts to authenticated';
  execute 'grant all on projects.value_report_drafts to service_role';
  execute 'drop trigger if exists freeze_org_value_report_drafts on projects.value_report_drafts';
  execute 'create trigger freeze_org_value_report_drafts before update of organization_id on projects.value_report_drafts for each row execute function core.freeze_organization_id()';
  execute 'drop trigger if exists value_report_drafts_updated_at on projects.value_report_drafts';
  execute 'create trigger value_report_drafts_updated_at before update on projects.value_report_drafts for each row execute function core.set_updated_at()';
  execute 'drop trigger if exists value_report_drafts_p8_guard on projects.value_report_drafts';
  execute 'create trigger value_report_drafts_p8_guard before update or delete on projects.value_report_drafts for each row execute function projects.p8_guard_updates()';
  execute 'drop trigger if exists value_report_drafts_frozen on projects.value_report_drafts';
  execute 'create trigger value_report_drafts_frozen before update on projects.value_report_drafts for each row execute function projects.value_report_drafts_frozen()';
  execute 'drop trigger if exists org_match_value_report_drafts_client_account_id on projects.value_report_drafts';
  execute $p$create trigger org_match_value_report_drafts_client_account_id before insert or update on projects.value_report_drafts for each row execute function core.enforce_parent_org('client_account_id', 'core.client_accounts')$p$;
end $$;

-- ── the facts read ──────────────────────────────────────────────────────────

create or replace function projects.value_report_facts(p_client_account_id uuid, p_start date, p_end date)
returns table (facts jsonb, digest text)
language plpgsql stable security invoker set search_path = '' as $$
declare v_org uuid; v_from timestamptz; v_to timestamptz; v_facts jsonb;
begin
  if coalesce((select auth.role()), '') <> 'service_role' and not coalesce((select core.is_internal()), false) then return; end if;
  if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 400 then return; end if;
  select a.organization_id into v_org from core.client_accounts a where a.id = p_client_account_id;
  if v_org is null then return; end if;
  v_from := p_start::timestamp at time zone 'UTC'; v_to := (p_end + 1)::timestamp at time zone 'UTC';

  select coalesce(jsonb_agg(f.fact order by f.type_rank, f.on_date, f.source_id), '[]'::jsonb) into v_facts from (
    select 1 as type_rank, (t.closed_at at time zone 'UTC')::date as on_date, t.id as source_id,
           jsonb_build_object('type', 'ticket_resolved', 'label', t.ticket_ref || ' ' || t.title, 'value', 1, 'unit', 'ticket', 'on', (t.closed_at at time zone 'UTC')::date,
                              'projectId', t.project_id, 'sources', jsonb_build_array(jsonb_build_object('table', 'projects.support_tickets', 'id', t.id))) as fact
      from projects.support_tickets t
     where t.organization_id = v_org and t.client_account_id = p_client_account_id and t.status = 'closed' and t.closed_at >= v_from and t.closed_at < v_to
    union all
    select 2, (w.released_at at time zone 'UTC')::date, w.id,
           jsonb_build_object('type', 'change_released', 'label', w.kind || ': ' || w.title, 'value', 1, 'unit', 'release', 'on', (w.released_at at time zone 'UTC')::date,
                              'projectId', w.project_id, 'evidence', w.deployment_ref, 'sources', jsonb_build_array(jsonb_build_object('table', 'projects.maintenance_work_items', 'id', w.id)))
      from projects.maintenance_work_items w
     where w.organization_id = v_org and w.client_account_id = p_client_account_id and w.status = 'released' and w.released_at >= v_from and w.released_at < v_to
    union all
    select 3, max(l.logged_on), (array_agg(l.id order by l.logged_on, l.id))[1],
           jsonb_build_object('type', 'hours_logged', 'label', 'Hours logged on ' || p.name, 'value', sum(l.hours), 'unit', 'hours', 'on', max(l.logged_on), 'projectId', p.id,
                              'sources', jsonb_agg(jsonb_build_object('table', 'projects.time_logs', 'id', l.id) order by l.logged_on, l.id))
      from projects.time_logs l join projects.projects p on p.id = l.project_id
     where l.organization_id = v_org and p.client_account_id = p_client_account_id and l.logged_on between p_start and p_end
     group by p.id, p.name
    union all
    select 4, (v.verified_at at time zone 'UTC')::date, v.id,
           jsonb_build_object('type', 'production_verification', 'label', 'Production release check: ' || v.outcome, 'value', v.outcome, 'unit', 'outcome', 'on', (v.verified_at at time zone 'UTC')::date,
                              'projectId', v.project_id, 'evidence', v.evidence_url, 'sources', jsonb_build_array(jsonb_build_object('table', 'projects.release_verifications', 'id', v.id)))
      from projects.release_verifications v join projects.projects p on p.id = v.project_id
     where v.organization_id = v_org and p.client_account_id = p_client_account_id and v.environment = 'production' and v.verified_at >= v_from and v.verified_at < v_to
  ) f;
  return query select v_facts, md5(v_facts::text);
end $$;
revoke all on function projects.value_report_facts(uuid, date, date) from public, anon;
grant execute on function projects.value_report_facts(uuid, date, date) to authenticated, service_role;

-- ── doors ───────────────────────────────────────────────────────────────────

-- the one store path; reachable only through the two doors below
create or replace function projects.p8d_store_value_report(
  p_org uuid, p_actor uuid, p_agent text, p_client_account_id uuid, p_start date, p_end date, p_template_version int, p_body text, p_facts_digest text)
returns table (outcome text, report_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_body text := nullif(btrim(coalesce(p_body, '')), ''); v_facts jsonb; v_digest text; v_id uuid;
begin
  if p_template_version is null or p_template_version < 1 then return query select 'bad_template_version'::text, null::uuid; return; end if;
  if p_start is null or p_end is null or p_end < p_start or p_end - p_start > 400 then return query select 'bad_period'::text, null::uuid; return; end if;
  if v_body is null or length(v_body) < 20 then return query select 'body_required'::text, null::uuid; return; end if;
  if v_body ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' then return query select 'names_a_price'::text, null::uuid; return; end if;
  if not exists (select 1 from core.client_accounts a where a.id = p_client_account_id and a.organization_id = p_org) then return query select 'not_found'::text, null::uuid; return; end if;
  select f.facts, f.digest into v_facts, v_digest from projects.value_report_facts(p_client_account_id, p_start, p_end) f;
  if v_facts is null or jsonb_array_length(v_facts) = 0 then return query select 'nothing_to_report'::text, null::uuid; return; end if;
  if p_facts_digest is null or p_facts_digest <> v_digest then return query select 'facts_changed'::text, null::uuid; return; end if;
  insert into projects.value_report_drafts (organization_id, client_account_id, period_start, period_end, template_version, facts, facts_digest, body, built_by, built_by_agent)
  values (p_org, p_client_account_id, p_start, p_end, p_template_version, v_facts, v_digest, left(v_body, 8000), p_actor, case when p_actor is null then left(p_agent, 80) end)
  returning id into v_id;
  perform core.record_audit(p_org, 'value_report.drafted', 'value_report', v_id, null, jsonb_build_object('clientAccountId', p_client_account_id, 'periodStart', p_start, 'periodEnd', p_end, 'templateVersion', p_template_version, 'agent', p_agent));
  return query select 'drafted'::text, v_id;
end $$;
revoke all on function projects.p8d_store_value_report(uuid, uuid, text, uuid, date, date, int, text, text) from public, anon, authenticated, service_role;

create or replace function projects.store_value_report_draft(p_client_account_id uuid, p_start date, p_end date, p_template_version int, p_body text, p_facts_digest text)
returns table (outcome text, report_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid());
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  return query select * from projects.p8d_store_value_report(v_org, v_actor, null, p_client_account_id, p_start, p_end, p_template_version, p_body, p_facts_digest);
end $$;
revoke all on function projects.store_value_report_draft(uuid, date, date, int, text, text) from public, anon, service_role;
grant execute on function projects.store_value_report_draft(uuid, date, date, int, text, text) to authenticated;

create or replace function projects.store_value_report_draft_as_agent(p_organization_id uuid, p_client_account_id uuid, p_start date, p_end date, p_template_version int, p_body text, p_facts_digest text, p_agent text)
returns table (outcome text, report_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then return query select 'not_authorized'::text, null::uuid; return; end if;
  if nullif(btrim(coalesce(p_agent, '')), '') is null then return query select 'agent_required'::text, null::uuid; return; end if;
  return query select * from projects.p8d_store_value_report(p_organization_id, null, p_agent, p_client_account_id, p_start, p_end, p_template_version, p_body, p_facts_digest);
end $$;
revoke all on function projects.store_value_report_draft_as_agent(uuid, uuid, date, date, int, text, text, text) from public, anon, authenticated;
grant execute on function projects.store_value_report_draft_as_agent(uuid, uuid, date, date, int, text, text, text) to service_role;

create or replace function projects.edit_value_report_draft(p_report_id uuid, p_body text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.value_report_drafts; v_body text := nullif(btrim(coalesce(p_body, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_body is null or length(v_body) < 20 then return query select 'body_required'::text; return; end if;
  if v_body ~* '(₹|€|\$)\s*[0-9]|\m(rs\.?|inr|usd|eur)\s*[0-9]|[0-9]\s*(rupees|dollars|inr|usd)\M|discount|% off' then return query select 'names_a_price'::text; return; end if;
  select * into v_r from projects.value_report_drafts d where d.id = p_report_id and d.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.value_report_drafts set body = left(v_body, 8000), edited_by = v_actor, edited_at = clock_timestamp() where id = v_r.id;
  perform core.record_audit(v_org, 'value_report.edited', 'value_report', v_r.id, null, null);
  return query select 'edited'::text;
end $$;
revoke all on function projects.edit_value_report_draft(uuid, text) from public, anon, service_role;
grant execute on function projects.edit_value_report_draft(uuid, text) to authenticated;

create or replace function projects.approve_value_report_draft(p_report_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.value_report_drafts;
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_r from projects.value_report_drafts d where d.id = p_report_id and d.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.value_report_drafts set status = 'approved', approved_by = v_actor, approved_at = clock_timestamp() where id = v_r.id;
  perform core.record_audit(v_org, 'value_report.approved', 'value_report', v_r.id, null, jsonb_build_object('templateVersion', v_r.template_version, 'factsDigest', v_r.facts_digest));
  return query select 'approved'::text;
end $$;
revoke all on function projects.approve_value_report_draft(uuid) from public, anon, service_role;
grant execute on function projects.approve_value_report_draft(uuid) to authenticated;

create or replace function projects.discard_value_report_draft(p_report_id uuid, p_reason text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_r projects.value_report_drafts; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor is null or v_org is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) or not coalesce((select core.is_internal()), false) then return query select 'not_authorized'::text; return; end if;
  if v_reason is null or length(v_reason) < 5 then return query select 'reason_required'::text; return; end if;
  select * into v_r from projects.value_report_drafts d where d.id = p_report_id and d.organization_id = v_org for update;
  if v_r.id is null then return query select 'not_found'::text; return; end if;
  if v_r.status <> 'draft' then return query select 'not_a_draft'::text; return; end if;
  perform set_config('projects.p8_sanctioned', 'on', true);
  update projects.value_report_drafts set status = 'discarded', discarded_by = v_actor, discarded_at = clock_timestamp(), discard_reason = left(v_reason, 500) where id = v_r.id;
  perform core.record_audit(v_org, 'value_report.discarded', 'value_report', v_r.id, null, null);
  return query select 'discarded'::text;
end $$;
revoke all on function projects.discard_value_report_draft(uuid, text) from public, anon, service_role;
grant execute on function projects.discard_value_report_draft(uuid, text) to authenticated;

notify pgrst, 'reload schema';
