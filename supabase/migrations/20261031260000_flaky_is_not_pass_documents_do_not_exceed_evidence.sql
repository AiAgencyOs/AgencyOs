-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 remaining governance records.
--
--  1. Flaky tests (Test Automation spec, "FLAKY != PASS"): a flaky test is tracked, owned and either fixed or quarantined WITH an owner and an
--     expiry. An open one, or a quarantine past its expiry, blocks Phase 5 completion. Retrying until green is not a resolution.
--  2. Technical documents (Documentation spec): a status vocabulary (IMPLEMENTED / PARTIAL / NOT_IMPLEMENTED / NOT_REQUIRED / MANUAL_EXTERNAL /
--     BLOCKED / DEPRECATED). "Implemented" needs evidence; an integration document cannot say IMPLEMENTED unless that integration is VERIFIED
--     (configured with a mock is not documentation of a working integration); no secret value may be written into a document.
--  3. M3PaymentVerified: the fact Phase 6's financial gate is read from, emitted ONCE when the third priced milestone's invoice is verified paid.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.flaky_tests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  test_key         text not null check (length(btrim(test_key)) > 0),
  suite            text,
  occurrences      int not null default 1 check (occurrences >= 1),
  suspected_cause  text,
  status           text not null default 'open' check (status in ('open', 'quarantined', 'resolved')),
  owner_id         uuid references core.users(id) on delete set null,
  expires_at       timestamptz,
  resolution       text,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, test_key),
  -- quarantine is a time-boxed decision with an owner; resolution says what was fixed
  check (status <> 'quarantined' or (owner_id is not null and expires_at is not null)),
  check (status <> 'resolved' or (resolution is not null and length(btrim(resolution)) > 0))
);
alter table qa.flaky_tests enable row level security;
drop policy if exists flaky_tests_read on qa.flaky_tests;
create policy flaky_tests_read on qa.flaky_tests for select to authenticated using (organization_id = (select core.current_organization_id()));
grant select on qa.flaky_tests to authenticated;
grant all on qa.flaky_tests to service_role;
drop trigger if exists flaky_tests_parent_org_project_id on qa.flaky_tests;
create trigger flaky_tests_parent_org_project_id before insert or update of project_id on qa.flaky_tests for each row execute function core.enforce_parent_org('project_id', 'projects.projects');
drop trigger if exists freeze_org_flaky_tests on qa.flaky_tests;
create trigger freeze_org_flaky_tests before update of organization_id on qa.flaky_tests for each row execute function core.freeze_organization_id();
drop trigger if exists flaky_tests_updated_at on qa.flaky_tests;
create trigger flaky_tests_updated_at before update on qa.flaky_tests for each row execute function core.set_updated_at();

create or replace function qa.record_flaky_test(p_project_id uuid, p_test_key text, p_suite text default null, p_suspected_cause text default null)
returns table (outcome text, flaky_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_service boolean := coalesce((select auth.role()), '') = 'service_role'; v_id uuid; v_row qa.flaky_tests;
begin
  if (select auth.uid()) is null and not v_service then return query select 'no_actor'::text, null::uuid; return; end if;
  if v_service then
    select p.organization_id into v_org from projects.projects p where p.id = p_project_id;
  elsif not coalesce((select core.can_write()), false) then
    return query select 'not_authorized'::text, null::uuid; return;
  end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  select * into v_row from qa.flaky_tests f where f.project_id = p_project_id and f.test_key = p_test_key for update;
  if v_row.id is not null then
    -- seen again: the count rises; a resolved test that flakes again REOPENS
    update qa.flaky_tests set occurrences = occurrences + 1, status = case when status = 'resolved' then 'open' else status end,
           resolution = case when status = 'resolved' then null else resolution end, suspected_cause = coalesce(p_suspected_cause, suspected_cause) where id = v_row.id;
    return query select 'seen_again'::text, v_row.id; return;
  end if;
  insert into qa.flaky_tests (organization_id, project_id, test_key, suite, suspected_cause) values (v_org, p_project_id, p_test_key, p_suite, p_suspected_cause) returning id into v_id;
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function qa.record_flaky_test(uuid, text, text, text) from public, anon;
grant execute on function qa.record_flaky_test(uuid, text, text, text) to authenticated, service_role;

create or replace function qa.resolve_flaky_test(p_flaky_id uuid, p_action text, p_resolution text default null, p_expires_at timestamptz default null)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_actor uuid := (select auth.uid()); v_row qa.flaky_tests;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_row from qa.flaky_tests f where f.id = p_flaky_id and f.organization_id = v_org for update;
  if v_row.id is null then return query select 'not_found'::text; return; end if;
  if p_action = 'quarantine' then
    if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '30 days' then return query select 'expiry_required_within_30_days'::text; return; end if;
    update qa.flaky_tests set status = 'quarantined', owner_id = v_actor, expires_at = p_expires_at where id = v_row.id;
    return query select 'quarantined'::text; return;
  elsif p_action = 'resolve' then
    if p_resolution is null or length(btrim(p_resolution)) = 0 then return query select 'resolution_required'::text; return; end if;
    update qa.flaky_tests set status = 'resolved', resolution = p_resolution where id = v_row.id;
    return query select 'resolved'::text; return;
  end if;
  return query select 'bad_action'::text;
end $$;
revoke all on function qa.resolve_flaky_test(uuid, text, text, timestamptz) from public, anon;
grant execute on function qa.resolve_flaky_test(uuid, text, text, timestamptz) to authenticated;

create table if not exists projects.technical_documents (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references core.organizations(id) on delete cascade,
  project_id        uuid not null references projects.projects(id) on delete cascade,
  kind              text not null check (kind in ('architecture', 'api', 'database', 'integration', 'build_run', 'test', 'known_limitations', 'handoff', 'other')),
  title             text not null check (length(btrim(title)) > 0),
  status            text not null check (status in ('implemented', 'partial', 'not_implemented', 'not_required', 'manual_external', 'blocked', 'deprecated')),
  evidence_ref      text,
  integration_id    uuid references projects.integration_connections(id) on delete restrict,
  body              text,
  updated_by        uuid references core.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (project_id, kind, title),
  -- "document what exists": an IMPLEMENTED claim names the evidence it was derived from
  check (status <> 'implemented' or (evidence_ref is not null and length(btrim(evidence_ref)) > 0)),
  check (kind <> 'integration' or integration_id is not null)
);
alter table projects.technical_documents enable row level security;
drop policy if exists technical_documents_read on projects.technical_documents;
create policy technical_documents_read on projects.technical_documents for select to authenticated using (organization_id = (select core.current_organization_id()));
grant select on projects.technical_documents to authenticated;
grant all on projects.technical_documents to service_role;
do $$
declare r record;
begin
  for r in select * from (values ('project_id', 'projects.projects'), ('integration_id', 'projects.integration_connections')) as t(col, parent) loop
    execute format('drop trigger if exists %I on projects.technical_documents', 'technical_documents_parent_org_' || r.col);
    execute format('create trigger %I before insert or update of %I on projects.technical_documents for each row execute function core.enforce_parent_org(%L, %L)',
                   'technical_documents_parent_org_' || r.col, r.col, r.col, r.parent);
  end loop;
end $$;
drop trigger if exists freeze_org_technical_documents on projects.technical_documents;
create trigger freeze_org_technical_documents before update of organization_id on projects.technical_documents for each row execute function core.freeze_organization_id();

create or replace function projects.technical_documents_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_health text; v_mock boolean;
begin
  -- no secret value is ever written into a document (name the variable, never its value)
  if coalesce(new.body, '') ~* '(api[_-]?key|secret|token|passwd|password|authorization|bearer)["'' ]*[:=]\s*["'']?[A-Za-z0-9_\-\.]{12,}'
     or coalesce(new.body, '') ~ '(sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})' then
    raise exception 'a document must not carry a secret value: name the variable, never its value' using errcode = 'restrict_violation';
  end if;
  -- documentation never exceeds the evidence: an integration is IMPLEMENTED only when that integration is VERIFIED
  if new.kind = 'integration' and new.status = 'implemented' then
    select c.health, c.is_mock into v_health, v_mock from projects.integration_connections c where c.id = new.integration_id;
    if v_health is distinct from 'verified' or coalesce(v_mock, true) then
      raise exception 'an integration cannot be documented as implemented while it is % (configured is not verified; a mock is not an integration)', coalesce(v_health, 'unknown')
        using errcode = 'restrict_violation';
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  return new;
end $$;
drop trigger if exists technical_documents_guard on projects.technical_documents;
create trigger technical_documents_guard before insert or update on projects.technical_documents for each row execute function projects.technical_documents_guard();

create or replace function projects.record_technical_document(p_project_id uuid, p_kind text, p_title text, p_status text, p_evidence_ref text default null, p_integration_id uuid default null, p_body text default null)
returns table (outcome text, document_id uuid)
language plpgsql security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id()); v_id uuid;
begin
  if (select auth.uid()) is null then return query select 'no_actor'::text, null::uuid; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'not_authorized'::text, null::uuid; return; end if;
  if not exists (select 1 from projects.projects p where p.id = p_project_id and p.organization_id = v_org) then return query select 'not_found'::text, null::uuid; return; end if;
  begin
    insert into projects.technical_documents (organization_id, project_id, kind, title, status, evidence_ref, integration_id, body)
    values (v_org, p_project_id, p_kind, p_title, p_status, p_evidence_ref, p_integration_id, p_body)
    on conflict (project_id, kind, title) do update
      set status = excluded.status, evidence_ref = excluded.evidence_ref, integration_id = excluded.integration_id, body = excluded.body
    returning id into v_id;
  exception
    when restrict_violation then return query select 'refused'::text, null::uuid; return;
    when check_violation then return query select 'invalid'::text, null::uuid; return;
  end;
  return query select 'recorded'::text, v_id;
end $$;
revoke all on function projects.record_technical_document(uuid, text, text, text, text, uuid, text) from public, anon;
grant execute on function projects.record_technical_document(uuid, text, text, text, text, uuid, text) to authenticated;

-- M3PaymentVerified: emitted once, from the same verified-payment event that carries every milestone
insert into core.event_types (type, description, canonical) values
  ('project.m3_payment_verified',
   'The third priced milestone (M3, 30%) was verified paid IN FULL by an Admin. Phase 6''s financial gate reads this fact; a claim, a proof, a submission or a match recommendation never produces it.',
   true),
  ('project.build_feedback_routed',
   'Client feedback on a development build was classified and routed (defect, change request, revision or clarification).',
   true)
on conflict (type) do nothing;

CREATE OR REPLACE FUNCTION projects.phase_readiness(p_project_id uuid, p_phase integer)
 RETURNS TABLE(outcome text, missing text[], facts jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_org      uuid;
  v_missing  text[] := '{}';
  v_total    int;
  v_open     int;
  v_runs     int;
  v_failing  int;
  v_blockers int;
  v_m2       boolean;
begin
  if p_phase not in (5, 6) then
    return query select 'invalid_phase'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  select p.organization_id into v_org
    from projects.projects p
   where p.id = p_project_id and p.deleted_at is null;
  if v_org is null then
    return query select 'not_found'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  if exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = p_phase) then
    return query select 'completed'::text, '{}'::text[], '{}'::jsonb; return;
  end if;

  -- T1-1: a cancelled or archived task is not outstanding work and does not block.
  select count(*), count(*) filter (where t.status not in ('done', 'completed'))
    into v_total, v_open
    from projects.tasks t
   where t.project_id = p_project_id
     and (t.module_id is not null or t.feature_id is not null)
     and t.status <> 'cancelled'
     and t.archived_at is null;

  if p_phase = 5 then
    if v_total = 0 then
      v_missing := array_append(v_missing, 'No development task exists yet (a task attached to a module or a feature).');
    elsif v_open > 0 then
      v_missing := array_append(v_missing, format('%s of %s development task%s not done yet.', v_open, v_total, case when v_total = 1 then ' is' else 's are' end));
    end if;
    -- R1-3: the M2 invoice must be verified paid (the verified basis).
    -- Phase 5 Definition of Done: a locked baseline, no unverified blocker/major defect, and the FINAL development build is the
    -- client-approved one (a newer build that nobody approved means the approved one is no longer the final one).
    if exists (select 1 from projects.phase_four p4 where p4.project_id = p_project_id)
       and not exists (select 1 from projects.development_baselines b where b.project_id = p_project_id) then
      v_missing := array_append(v_missing, 'No locked development baseline.');
    end if;
    if not exists (select 1 from projects.deliverables d where d.project_id = p_project_id and d.kind = 'build' and d.status = 'approved') then
      v_missing := array_append(v_missing, 'No client-approved development build.');
    elsif exists (
      select 1 from projects.deliverables d
       where d.project_id = p_project_id and d.kind = 'build' and d.status not in ('superseded')
         and d.version > (select max(a.version) from projects.deliverables a where a.project_id = p_project_id and a.kind = 'build' and a.status = 'approved')
    ) then
      v_missing := array_append(v_missing, 'A newer development build exists than the one the client approved.');
    end if;
    select count(*) into v_blockers
      from qa.defects d
     where d.project_id = p_project_id and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced') and d.severity in ('blocker', 'major');
    if v_blockers > 0 then
      v_missing := array_append(v_missing, format('%s blocker or major defect%s not verified fixed.', v_blockers, case when v_blockers = 1 then ' is' else 's are' end));
    end if;
    -- FLAKY != PASS: a flaky test is quarantined only with an owner and an expiry; an open or expired one is unresolved work.
    if exists (select 1 from qa.flaky_tests f where f.project_id = p_project_id and (f.status = 'open' or (f.status = 'quarantined' and f.expires_at <= now()))) then
      v_missing := array_append(v_missing, format('%s flaky test%s unresolved (open or quarantine expired).',
        (select count(*) from qa.flaky_tests f where f.project_id = p_project_id and (f.status = 'open' or (f.status = 'quarantined' and f.expires_at <= now()))),
        case when (select count(*) from qa.flaky_tests f where f.project_id = p_project_id and (f.status = 'open' or (f.status = 'quarantined' and f.expires_at <= now()))) = 1 then ' is' else 's are' end));
    end if;
    -- A document that claims more than the evidence is not documentation; none may be overclaimed at completion.
    if exists (select 1 from projects.technical_documents t where t.project_id = p_project_id and t.status = 'blocked') then
      v_missing := array_append(v_missing, 'A technical document is blocked.');
    end if;
    v_m2 := projects.m2_verified_paid(p_project_id);
    if not v_m2 then
      v_missing := array_append(v_missing, 'M2 not verified paid');
    end if;
    return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                        v_missing,
                        jsonb_build_object('developmentTasks', v_total, 'openDevelopmentTasks', v_open, 'm2VerifiedPaid', v_m2, 'unverifiedBlockingDefects', v_blockers);
    return;
  end if;

  -- Phase 6
  if not exists (select 1 from projects.phase_completions c where c.project_id = p_project_id and c.phase = 5) then
    v_missing := array_append(v_missing, 'Phase 5 is not complete yet.');
  end if;
  -- Phase 6 is financially available ONLY when M3 is Admin-verified paid in full.
  if not projects.m3_verified_paid(p_project_id) then
    v_missing := array_append(v_missing, 'M3 not verified paid');
  end if;

  select count(*) into v_runs from qa.test_runs r where r.project_id = p_project_id;
  if v_runs = 0 then
    v_missing := array_append(v_missing, 'No test run has been recorded.');
  end if;

  select count(*) into v_failing
    from (
      select distinct on (r.suite) r.suite, r.failed
        from qa.test_runs r
       where r.project_id = p_project_id
       order by r.suite, r.executed_at desc, r.created_at desc
    ) latest
   where latest.failed > 0;
  if v_failing > 0 then
    v_missing := array_append(v_missing, format('The latest run of %s suite%s has failures.', v_failing, case when v_failing = 1 then '' else 's' end));
  end if;

  select count(*) into v_blockers
    from qa.defects d
   where d.project_id = p_project_id and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced') and d.severity in ('blocker', 'major');
  if v_blockers > 0 then
    v_missing := array_append(v_missing, format('%s blocker or major defect%s not verified fixed.', v_blockers, case when v_blockers = 1 then ' is' else 's are' end));
  end if;

  return query select case when cardinality(v_missing) = 0 then 'ready' else 'not_ready' end::text,
                      v_missing,
                      jsonb_build_object('testRuns', v_runs, 'suitesWithFailures', v_failing, 'openBlockingDefects', v_blockers);
end;
$function$;

revoke all on function projects.phase_readiness(uuid, integer) from public, anon;
grant execute on function projects.phase_readiness(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
