-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 QA / Prototype Validation (traceability: docs/phase-4-implementation-traceability.md, rows P4-QAP-002..054, 056, 058..062, 064, 067..069, 071..073, 075..078, 080, 082..086, 090).
--
-- Until now a prototype's QA was a verdict on one jsonb column (`prototype_artifacts.qa_findings`): three ad hoc arrays, no run, no check rows, no blocker, no
-- statement of what was and was not tested, no link between a defect and the build that fixes it. This adds the RECORD, and nothing that decides authority:
--
--   * projects.p4q_prototype_intakes / p4q_prototype_limitations   what the Prototype Agent (or a person) declares BEFORE QA: critical screens, target viewports,
--                                                                  mock-data note, Figma refs, self-check, the defects this build claims to fix, known limitations.
--   * projects.p4q_evaluate_prototype(...)                         a PURE function: the deterministic check set (smoke, coverage incl. blank/placeholder/extra
--                                                                  screens, navigation incl. unreachable screens and reviewer traps, decorative CTAs, forms without
--                                                                  a submit, states, secrets in EVERY string field, real-looking contact data, another project's
--                                                                  ids, text-overflow risk, limitation accuracy). Checks it cannot make from structured JSON
--                                                                  (rendered layout, visual fidelity, role behaviour) come back `not_verifiable`: never a fake pass.
--   * projects.p4q_run_prototype_qa(artifact)                      the one door: records the run + every check, raises qa.defects for failed P0/P1/P2 checks
--                                                                  (atomically with the verdict: no best-effort loss), records the verdict through the EXISTING
--                                                                  record_prototype_qa_verdict (so self-review, tenancy and idempotency stay where they were), and
--                                                                  retests every defect whose declared fix build is this build. BLOCKED_EXTERNAL and INVALID_INTAKE
--                                                                  are recorded as a run + a blocker with an owner and a resume condition; they are not a pass.
--   * projects.p4q_link_fix_build / p4q_retest_prototype_defect    FIX_READY is a claim linked to an exact fix build; VERIFIED needs a QA run of THAT build in
--                                                                  which the originating check passes; a person who produced the fix build cannot verify it.
--   * an Admin cannot APPROVE a prototype build QA has not passed (decide_prototype_admin writes admin_status; a trigger now refuses `approved` without qa_pass).
--   * projects.p4q_prototype_admin_handoff / p4q_prototype_qa_overview   the Admin handoff package and the build history with the reason.
--
-- Nothing here approves, verifies payment, edits scope or builds. QA still cannot emit an approval.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.p4q_prototype_qa_blocked', 'Prototype QA could not reach a verdict (BLOCKED_EXTERNAL or INVALID_INTAKE). A blocker with an owner and a resume condition was recorded; it is not a pass.', true),
  ('project.p4q_prototype_fix_ready', 'A prototype build declared it fixes a QA defect (FIX_READY). It is a claim: QA retests that exact build before anything is VERIFIED.', true),
  ('project.p4q_prototype_defect_verified', 'QA retested the exact fix build and the originating check now passes; the defect was verified.', true)
on conflict (type) do nothing;

-- ── the door-only discipline for the p4q tables ────────────────────────────
create or replace function projects.p4q_door_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- the one replaceable record is an intake, before QA has run, inside its own door
    if tg_table_name = 'p4q_prototype_intakes' and coalesce(current_setting('projects.p4q_intake_edit', true), '') = 'on' then return old; end if;
    raise exception '% is QA history and is never deleted', tg_table_name using errcode = 'restrict_violation';
  end if;
  if coalesce(current_setting('projects.p4q_door', true), '') <> 'on' then
    raise exception '% is written through its prototype-QA door, never by a direct statement', tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
revoke all on function projects.p4q_door_only() from public, anon, authenticated, service_role;

-- ── intake: what the build declares before QA ──────────────────────────────
create table if not exists projects.p4q_prototype_intakes (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references core.organizations(id) on delete cascade,
  project_id          uuid not null references projects.projects(id) on delete cascade,
  artifact_id         uuid not null unique references projects.prototype_artifacts(id) on delete cascade,
  critical_screen_keys text[] not null default '{}',
  target_viewports    text[] not null default '{}',
  mock_data_note      text check (mock_data_note is null or (length(btrim(mock_data_note)) between 1 and 1000 and not projects.p7_has_secret(mock_data_note))),
  figma_refs          text[] not null default '{}',
  self_check          jsonb check (self_check is null or jsonb_typeof(self_check) = 'object'),
  revision_origin     text not null default 'initial' check (revision_origin in ('initial', 'admin_edit', 'client_change', 'qa_correction')),
  claimed_fix_defects uuid[] not null default '{}',
  declared_by         uuid references core.users(id) on delete set null,
  declared_at         timestamptz not null default clock_timestamp(),
  constraint p4q_intake_viewports_known check (target_viewports <@ array['mobile', 'tablet', 'desktop']::text[])
);
comment on table projects.p4q_prototype_intakes is 'QAP section 3-4: what a prototype build declares before QA (critical screens, target viewports, mock-data note, Figma refs, self-check, revision origin, the defects it claims to fix). Written only by p4q_declare_prototype_intake.';

create table if not exists projects.p4q_prototype_limitations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  artifact_id      uuid not null references projects.prototype_artifacts(id) on delete cascade,
  screen_key       text check (screen_key is null or screen_key ~ '^[a-z][a-z0-9_.-]{1,62}$'),
  statement        text not null check (length(btrim(statement)) between 5 and 500 and not projects.p7_has_secret(statement)),
  declared_by      uuid references core.users(id) on delete set null,
  declared_at      timestamptz not null default clock_timestamp(),
  qa_accuracy      text check (qa_accuracy is null or qa_accuracy in ('accurate', 'refers_to_unknown_screen', 'hides_required_screen')),
  qa_assessed_at   timestamptz
);
comment on table projects.p4q_prototype_limitations is 'PROTO-042 / QAP-014: a declared limitation of a build. QA assesses each: a limitation that names a required screen the build lacks is a defect, not an excuse.';

-- ── the run and its checks ─────────────────────────────────────────────────
create table if not exists projects.p4q_prototype_qa_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  artifact_id      uuid not null references projects.prototype_artifacts(id) on delete restrict,
  deliverable_id   uuid not null references projects.deliverables(id) on delete restrict,
  ui_version_id    uuid not null references projects.ui_versions(id) on delete restrict,
  outcome          text not null check (outcome in ('qa_pass', 'qa_changes_required', 'blocked_external', 'invalid_intake')),
  run_by           uuid references core.users(id) on delete set null,
  run_actor        text not null check (run_actor in ('person', 'agent')),
  started_at       timestamptz not null default clock_timestamp(),
  completed_at     timestamptz,
  environment      jsonb not null default '{}'::jsonb,
  checks_total     integer not null default 0 check (checks_total >= 0),
  checks_failed    integer not null default 0 check (checks_failed >= 0),
  checks_not_verifiable integer not null default 0 check (checks_not_verifiable >= 0),
  changed_screens  text[] not null default '{}',
  previous_run_id  uuid references projects.p4q_prototype_qa_runs(id) on delete set null,
  constraint p4q_run_blocked_has_no_checks_failed check (outcome in ('qa_pass', 'qa_changes_required') or checks_failed = 0)
);
comment on table projects.p4q_prototype_qa_runs is 'QAP-039: one QA run of one exact prototype build. A build has at most ONE verdict run (qa_pass / qa_changes_required); blocked_external / invalid_intake runs are not verdicts and may repeat once the blocker is resolved. Old PASS is never inherited: a new build is a new artifact and needs its own run.';
create unique index if not exists p4q_one_verdict_per_build on projects.p4q_prototype_qa_runs (artifact_id) where outcome in ('qa_pass', 'qa_changes_required');
create index if not exists p4q_runs_project_idx on projects.p4q_prototype_qa_runs (project_id, started_at desc);

create table if not exists projects.p4q_prototype_qa_checks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  run_id           uuid not null references projects.p4q_prototype_qa_runs(id) on delete restrict,
  check_key        text not null check (length(check_key) between 3 and 200),
  category         text not null check (category in ('intake', 'smoke', 'coverage', 'navigation', 'interaction', 'states', 'visual', 'layout', 'data', 'limitation', 'role')),
  target           text not null,
  expected         text not null,
  actual           text not null,
  result           text not null check (result in ('pass', 'fail', 'not_verifiable')),
  severity         text not null check (severity in ('P0', 'P1', 'P2', 'P3')),
  disposition      text check (disposition is null or disposition in ('must_fix', 'admin_decides', 'documented')),
  unique (run_id, check_key),
  constraint p4q_check_failure_has_disposition check ((result = 'fail') = (disposition is not null))
);
comment on table projects.p4q_prototype_qa_checks is 'QAP-040: every check one run made, with category, target, expected, actual, result and severity. `not_verifiable` is recorded where the structured build cannot answer (rendered layout, visual fidelity, role behaviour): never a pass. Disposition: P0/P1 must_fix, P2 admin_decides, P3 documented (QAP-017).';

create table if not exists projects.p4q_prototype_qa_blockers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  run_id           uuid not null references projects.p4q_prototype_qa_runs(id) on delete restrict,
  artifact_id      uuid not null references projects.prototype_artifacts(id) on delete restrict,
  kind             text not null check (kind in ('blocked_external', 'invalid_intake')),
  reason           text not null check (length(btrim(reason)) between 5 and 1000 and not projects.p7_has_secret(reason)),
  owner            text not null check (owner in ('admin', 'client', 'prototype_agent', 'ui_designer', 'finance', 'external_provider')),
  resume_condition text not null check (length(btrim(resume_condition)) between 5 and 500),
  created_at       timestamptz not null default clock_timestamp(),
  resolved_at      timestamptz,
  resolved_by      uuid references core.users(id) on delete set null,
  resolution_note  text check (resolution_note is null or length(btrim(resolution_note)) between 5 and 1000),
  constraint p4q_blocker_resolution_shape check ((resolved_at is null) = (resolved_by is null and resolution_note is null) or (resolved_at is not null and resolution_note is not null))
);
comment on table projects.p4q_prototype_qa_blockers is 'QAP-044: why QA could not reach a verdict, who owns the unblocking and what resumes it. A person resolves it (p4q_resolve_qa_blocker); resolving does not pass the build.';
create unique index if not exists p4q_one_open_blocker_per_build on projects.p4q_prototype_qa_blockers (artifact_id) where resolved_at is null;

-- a prototype defect: the qa.defects row plus the screen/route reference, source UI version, priority, check, fix build and retest
create table if not exists projects.p4q_prototype_defects (
  defect_id        uuid primary key references qa.defects(id) on delete restrict,
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,
  artifact_id      uuid not null references projects.prototype_artifacts(id) on delete restrict,
  source_ui_version_id uuid not null references projects.ui_versions(id) on delete restrict,
  run_id           uuid not null references projects.p4q_prototype_qa_runs(id) on delete restrict,
  check_key        text not null,
  screen_key       text,
  priority         text not null check (priority in ('P0', 'P1', 'P2')),
  reappears_defect_id uuid references qa.defects(id) on delete set null,
  fix_artifact_id  uuid references projects.prototype_artifacts(id) on delete restrict,
  fix_declared_by  uuid references core.users(id) on delete set null,
  fix_declared_at  timestamptz,
  retest_run_id    uuid references projects.p4q_prototype_qa_runs(id) on delete set null,
  retest_result    text check (retest_result is null or retest_result in ('pass', 'still_failing')),
  retested_at      timestamptz,
  constraint p4q_defect_fix_is_dated check ((fix_artifact_id is null) = (fix_declared_at is null)),
  constraint p4q_defect_retest_is_dated check ((retest_result is null) = (retested_at is null and retest_run_id is null) or (retest_result is not null and retested_at is not null and retest_run_id is not null))
);
comment on table projects.p4q_prototype_defects is 'QAP-018/020/054: the prototype side of a qa.defects row - the build it was found on, source UI version, screen/route, priority, the check that found it, the exact fix build that claims to fix it (FIX_READY) and the retest of that build. A retest of a build that is not the declared fix build is refused.';

-- tenancy guards (every FK on a new org-scoped table) and the hardening
select projects.p7_guard_fk('p4q_prototype_intakes', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_prototype_intakes', 'artifact_id', 'projects.prototype_artifacts');
select projects.p7_guard_fk('p4q_prototype_limitations', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_prototype_limitations', 'artifact_id', 'projects.prototype_artifacts');
select projects.p7_guard_fk('p4q_prototype_qa_runs', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_prototype_qa_runs', 'artifact_id', 'projects.prototype_artifacts');
select projects.p7_guard_fk('p4q_prototype_qa_runs', 'deliverable_id', 'projects.deliverables');
select projects.p7_guard_fk('p4q_prototype_qa_runs', 'ui_version_id', 'projects.ui_versions');
select projects.p7_guard_fk('p4q_prototype_qa_checks', 'run_id', 'projects.p4q_prototype_qa_runs');
select projects.p7_guard_fk('p4q_prototype_qa_blockers', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_prototype_qa_blockers', 'run_id', 'projects.p4q_prototype_qa_runs');
select projects.p7_guard_fk('p4q_prototype_qa_blockers', 'artifact_id', 'projects.prototype_artifacts');
select projects.p7_guard_fk('p4q_prototype_defects', 'project_id', 'projects.projects');
select projects.p7_guard_fk('p4q_prototype_defects', 'artifact_id', 'projects.prototype_artifacts');
select projects.p7_guard_fk('p4q_prototype_defects', 'source_ui_version_id', 'projects.ui_versions');
select projects.p7_guard_fk('p4q_prototype_defects', 'run_id', 'projects.p4q_prototype_qa_runs');
select projects.p7_guard_fk('p4q_prototype_defects', 'fix_artifact_id', 'projects.prototype_artifacts');
select projects.p7_harden('projects', 'p4q_prototype_intakes');
select projects.p7_harden('projects', 'p4q_prototype_limitations');
select projects.p7_harden('projects', 'p4q_prototype_qa_runs');
select projects.p7_harden('projects', 'p4q_prototype_qa_checks');
select projects.p7_harden('projects', 'p4q_prototype_qa_blockers');
select projects.p7_harden('projects', 'p4q_prototype_defects');
do $$ declare t text; begin
  foreach t in array array['p4q_prototype_intakes', 'p4q_prototype_limitations', 'p4q_prototype_qa_runs', 'p4q_prototype_qa_checks', 'p4q_prototype_qa_blockers', 'p4q_prototype_defects'] loop
    execute format('drop trigger if exists %I on projects.%I', t || '_door_only', t);
    execute format('create trigger %I before insert or update or delete on projects.%I for each row execute function projects.p4q_door_only()', t || '_door_only', t);
  end loop;
end $$;

-- a run and its checks are history: after the door wrote them they never change
create or replace function projects.p4q_history_is_final()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is a QA record and is never edited after it was written', tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
revoke all on function projects.p4q_history_is_final() from public, anon, authenticated, service_role;
drop trigger if exists p4q_runs_final on projects.p4q_prototype_qa_runs;
create trigger p4q_runs_final before update on projects.p4q_prototype_qa_runs for each row execute function projects.p4q_history_is_final();
drop trigger if exists p4q_checks_final on projects.p4q_prototype_qa_checks;
create trigger p4q_checks_final before update on projects.p4q_prototype_qa_checks for each row execute function projects.p4q_history_is_final();

-- ── the pure check set ─────────────────────────────────────────────────────
-- p_design: the locked UI version's screens ([{screenKey, statesAddressed, ...}]); p_build: the prototype's screens ([{screenKey, elements:[{type,label,navigatesTo}]}]);
-- p_critical: screens declared critical (empty = every designed screen); p_limitations: [{id, screen_key, statement}].
create or replace function projects.p4q_evaluate_prototype(p_project_id uuid, p_design jsonb, p_build jsonb, p_critical text[], p_limitations jsonb)
returns table (check_key text, category text, target text, expected text, actual text, result text, severity text)
language plpgsql stable set search_path = '' as $$
declare
  v_dkeys text[] := '{}';
  v_bkeys text[] := '{}';
  v_crit  text[];
  v_first text;
  v_scr   jsonb;
  v_el    jsonb;
  v_key   text;
  v_idx   int;
  v_ok    boolean;
  v_state text;
  v_from  text[] := '{}';
  v_to    text[] := '{}';
  v_reach text[];
  v_back  text[];
  v_grew  boolean;
  v_i     int;
  v_broken int := 0;
  v_m     text;
  v_lim   jsonb;
  v_text  text;
  v_uuid  text;
  v_found boolean;
  v_pattern text;
begin
  if p_design is null or jsonb_typeof(p_design) <> 'array' then p_design := '[]'::jsonb; end if;
  if p_build is null or jsonb_typeof(p_build) <> 'array' then p_build := '[]'::jsonb; end if;
  select coalesce(array_agg(x ->> 'screenKey'), '{}') into v_dkeys from jsonb_array_elements(p_design) x where x ->> 'screenKey' is not null;
  select coalesce(array_agg(x ->> 'screenKey'), '{}') into v_bkeys from jsonb_array_elements(p_build) x where x ->> 'screenKey' is not null;
  v_crit := case when coalesce(array_length(p_critical, 1), 0) = 0 then v_dkeys else p_critical end;
  v_first := v_bkeys[1];

  -- smoke: the artifact opens - a non-empty list of screens, each with elements (QAP-023/050/073)
  v_ok := jsonb_array_length(p_build) > 0 and not exists (
    select 1 from jsonb_array_elements(p_build) x
     where jsonb_typeof(x -> 'elements') is distinct from 'array' or jsonb_array_length(x -> 'elements') = 0 or x ->> 'screenKey' is null);
  return query select 'smoke:opens', 'smoke', 'prototype build', 'the build opens: at least one screen and every screen draws at least one element',
    case when v_ok then 'every screen has elements' else 'the build has no screens, or a screen draws nothing' end, case when v_ok then 'pass' else 'fail' end, 'P0';

  -- coverage: every designed screen is built; critical ones are P0, the rest P1 (QAP-006)
  foreach v_key in array v_dkeys loop
    v_ok := v_key = any (v_bkeys);
    return query select 'coverage:screen:' || v_key, 'coverage', v_key, 'screen "' || v_key || '" of the locked UI version is built',
      case when v_ok then 'present' else 'missing from the build' end, case when v_ok then 'pass' else 'fail' end,
      case when v_key = any (v_crit) then 'P0' else 'P1' end;
  end loop;
  -- a screen the locked UI never designed (a state variant "<screen>.<state>" is not an extra screen)
  foreach v_key in array v_bkeys loop
    if v_key <> all (v_dkeys) and not exists (
         select 1 from unnest(v_dkeys) d where v_key ~ ('^' || regexp_replace(d, '([.\-])', '\\\1', 'g') || '[._-](default|empty|loading|error|success)$')) then
      return query select 'coverage:extra:' || v_key, 'coverage', v_key, 'the build contains only screens the locked UI designed',
        'screen "' || v_key || '" was never designed', 'fail', 'P1';
    end if;
  end loop;
  -- blank / placeholder screens
  for v_scr in select x from jsonb_array_elements(p_build) x loop
    v_key := v_scr ->> 'screenKey';
    continue when v_key is null or jsonb_typeof(v_scr -> 'elements') is distinct from 'array';
    v_ok := not (
      exists (select 1 from jsonb_array_elements(v_scr -> 'elements') e where e ->> 'label' ~* 'lorem ipsum')
      or (jsonb_array_length(v_scr -> 'elements') > 0 and not exists (
            select 1 from jsonb_array_elements(v_scr -> 'elements') e where e ->> 'label' !~* '^(todo|tbd|placeholder|coming soon|\.\.\.|xxx)')));
    return query select 'coverage:blank:' || v_key, 'coverage', v_key, 'the screen shows real content, not placeholder text',
      case when v_ok then 'real content' else 'placeholder or blank content' end, case when v_ok then 'pass' else 'fail' end, 'P1';
  end loop;

  -- navigation: broken targets, unreachable screens, reviewer traps (QAP-007, T008)
  for v_scr in select x from jsonb_array_elements(p_build) x loop
    v_key := v_scr ->> 'screenKey';
    continue when v_key is null or jsonb_typeof(v_scr -> 'elements') is distinct from 'array';
    for v_el in select e from jsonb_array_elements(v_scr -> 'elements') e where e ->> 'navigatesTo' is not null loop
      if (v_el ->> 'navigatesTo') = any (v_bkeys) then
        v_from := v_from || v_key; v_to := v_to || (v_el ->> 'navigatesTo');
      else
        v_broken := v_broken + 1;
        return query select 'navigation:route:' || v_key || '->' || (v_el ->> 'navigatesTo'), 'navigation', v_key || ' -> ' || (v_el ->> 'navigatesTo'),
          'the navigation target resolves to a real screen of this build', '"' || (v_el ->> 'navigatesTo') || '" does not match any screen', 'fail', 'P1';
      end if;
    end loop;
  end loop;
  return query select 'navigation:routes', 'navigation', 'all routes', 'every navigation target resolves',
    case when v_broken = 0 then 'every target resolves' else v_broken || ' broken target(s)' end, case when v_broken = 0 then 'pass' else 'fail' end, 'P1';

  if v_first is not null and cardinality(v_bkeys) > 1 then
    v_reach := array[v_first];
    loop
      v_grew := false;
      for v_i in 1 .. coalesce(cardinality(v_from), 0) loop
        if v_from[v_i] = any (v_reach) and v_to[v_i] <> all (v_reach) then v_reach := v_reach || v_to[v_i]; v_grew := true; end if;
      end loop;
      exit when not v_grew;
    end loop;
    v_back := array[v_first];
    loop
      v_grew := false;
      for v_i in 1 .. coalesce(cardinality(v_from), 0) loop
        if v_to[v_i] = any (v_back) and v_from[v_i] <> all (v_back) then v_back := v_back || v_from[v_i]; v_grew := true; end if;
      end loop;
      exit when not v_grew;
    end loop;
    foreach v_key in array v_bkeys loop
      continue when v_key = v_first;
      -- a state variant is reached by the state, not by a link
      continue when v_key ~ '[._-](default|empty|loading|error|success)$';
      if v_key <> all (v_reach) then
        return query select 'navigation:unreachable:' || v_key, 'navigation', v_key, 'the reviewer can reach the screen from the first screen',
          'no route from "' || v_first || '" leads here', 'fail', 'P2';
      elsif v_key <> all (v_back) then
        return query select 'navigation:trap:' || v_key, 'navigation', v_key, 'the reviewer can leave the screen and get back to "' || v_first || '"',
          'every way out of this screen is a dead end or a loop that never returns', 'fail', 'P2';
      end if;
    end loop;
  end if;

  -- interactions: a control the client is expected to test is not decorative; a form can be submitted (QAP-008, T009)
  for v_scr in select x from jsonb_array_elements(p_build) x loop
    v_key := v_scr ->> 'screenKey';
    continue when v_key is null or jsonb_typeof(v_scr -> 'elements') is distinct from 'array';
    v_idx := 0;
    for v_el in select e from jsonb_array_elements(v_scr -> 'elements') e loop
      if (v_el ->> 'type') in ('button', 'link') and (v_el ->> 'navigatesTo') is null then
        return query select 'interaction:decorative:' || v_key || ':' || v_idx, 'interaction', v_key || ' / ' || coalesce(v_el ->> 'label', '?'),
          'a button or link leads somewhere', 'the control has no target: it is decorative', 'fail', 'P2';
      end if;
      v_idx := v_idx + 1;
    end loop;
    if exists (select 1 from jsonb_array_elements(v_scr -> 'elements') e where e ->> 'type' = 'input')
       and not exists (select 1 from jsonb_array_elements(v_scr -> 'elements') e where e ->> 'type' in ('button', 'link')) then
      return query select 'interaction:form:' || v_key, 'interaction', v_key, 'a screen that collects input offers a way to submit or leave it',
        'inputs with no button or link on the screen', 'fail', 'P2';
    end if;
  end loop;

  -- states: every state the locked UI designed for a screen is represented (QAP-009)
  for v_scr in select x from jsonb_array_elements(p_design) x loop
    v_key := v_scr ->> 'screenKey';
    continue when v_key is null or not (v_key = any (v_bkeys));
    if jsonb_typeof(v_scr -> 'statesAddressed') = 'array' then
      for v_state in select s from jsonb_array_elements_text(v_scr -> 'statesAddressed') s where s <> 'default' loop
        v_pattern := case v_state when 'empty' then 'empty|no results|nothing' when 'loading' then 'loading|spinner' when 'error' then 'error|failed|went wrong'
                                  when 'success' then 'success|saved|done|thank' else v_state end;
        v_ok := (v_key || '.' || v_state) = any (v_bkeys) or (v_key || '_' || v_state) = any (v_bkeys) or (v_key || '-' || v_state) = any (v_bkeys)
          or exists (select 1 from jsonb_array_elements(p_build) b, jsonb_array_elements(case when jsonb_typeof(b -> 'elements') = 'array' then b -> 'elements' else '[]'::jsonb end) e
                      where b ->> 'screenKey' = v_key and e ->> 'label' ~* v_pattern);
        return query select 'states:' || v_key || ':' || v_state, 'states', v_key || ' / ' || v_state, 'the "' || v_state || '" state the UI designed is shown in the build',
          case when v_ok then 'represented' else 'not represented' end, case when v_ok then 'pass' else 'fail' end, 'P2';
      end loop;
    end if;
  end loop;

  -- data safety: EVERY string field of the build (QAP-013/015, T016/T017)
  v_text := p_build::text;
  v_ok := not projects.p7_has_secret(v_text);
  return query select 'data:secrets', 'data', 'every string in the build', 'no credential, key or token appears in the build',
    case when v_ok then 'none found' else 'a string matches a credential shape' end, case when v_ok then 'pass' else 'fail' end, 'P0';
  v_found := false;
  for v_m in select m[1] from regexp_matches(v_text, '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})', 'g') m loop
    if v_m !~* '@([A-Za-z0-9-]+\.)?(example\.(com|org|net)|example|test|invalid|localhost)$' then v_found := true; end if;
  end loop;
  return query select 'data:real_contact', 'data', 'every string in the build', 'mock data uses reserved example addresses, not real-looking contacts',
    case when v_found then 'a real-looking email address appears' else 'only reserved example addresses' end, case when v_found then 'fail' else 'pass' end, 'P2';
  v_found := false;
  for v_uuid in select m[1] from regexp_matches(v_text, '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m loop
    if exists (select 1 from projects.projects p where p.id = v_uuid::uuid and p.id <> p_project_id) then v_found := true; end if;
  end loop;
  return query select 'data:cross_project', 'data', 'every string in the build', 'no identifier of another project appears in the build',
    case when v_found then 'another project''s identifier appears' else 'none found' end, case when v_found then 'fail' else 'pass' end, 'P0';

  -- layout: text that cannot fit its container (a structural proxy; a rendered check is not_verifiable below) (QAP-011)
  for v_scr in select x from jsonb_array_elements(p_build) x loop
    v_key := v_scr ->> 'screenKey';
    continue when v_key is null or jsonb_typeof(v_scr -> 'elements') is distinct from 'array';
    v_idx := 0;
    for v_el in select e from jsonb_array_elements(v_scr -> 'elements') e loop
      if length(coalesce(v_el ->> 'label', '')) > 160 or coalesce(v_el ->> 'label', '') ~ '\S{40,}' then
        return query select 'layout:overflow:' || v_key || ':' || v_idx, 'layout', v_key || ' / element ' || v_idx, 'text fits a mobile control (no unbroken run over 40 characters, no label over 160)',
          'the label is long enough to overflow', 'fail', 'P2';
      end if;
      v_idx := v_idx + 1;
    end loop;
  end loop;
  return query select 'layout:render', 'layout', 'target viewports', 'the build is rendered at each target viewport and nothing is clipped',
    'cannot be answered from the structured build: needs a headless browser run (environment_missing)', 'not_verifiable', 'P3';
  return query select 'visual:fidelity', 'visual', 'theme and tokens', 'the build matches the locked theme, tokens, components and typography',
    'cannot be answered from the structured build: needs a vision model or a rendered comparison (environment_missing)', 'not_verifiable', 'P3';
  return query select 'role:behaviour', 'role', 'approved roles', 'role-specific behaviour matches the approved scope',
    'the build vocabulary has no role variants, so there is nothing to test', 'not_verifiable', 'P3';

  -- declared limitations must be true and must not hide a required feature (QAP-014, section 13)
  if p_limitations is not null and jsonb_typeof(p_limitations) = 'array' then
    for v_lim in select x from jsonb_array_elements(p_limitations) x loop
      v_key := v_lim ->> 'screen_key';
      if v_key is null then
        return query select 'limitation:' || (v_lim ->> 'id'), 'limitation', coalesce(v_lim ->> 'statement', '?'), 'a declared limitation is accurate and hides no required screen',
          'names no screen: recorded as declared', 'pass', 'P3';
      elsif v_key <> all (v_dkeys) then
        return query select 'limitation:' || (v_lim ->> 'id'), 'limitation', v_key, 'a declared limitation names a screen the UI designed',
          'names a screen that was never designed', 'fail', 'P2';
      elsif v_key <> all (v_bkeys) then
        return query select 'limitation:' || (v_lim ->> 'id'), 'limitation', v_key, 'a declared limitation does not stand in for a required screen',
          'the limitation names a required screen that is missing: a limitation is not an excuse', 'fail', 'P1';
      else
        return query select 'limitation:' || (v_lim ->> 'id'), 'limitation', v_key, 'a declared limitation is accurate and hides no required screen',
          'the named screen is built', 'pass', 'P3';
      end if;
    end loop;
  end if;
end $$;
revoke all on function projects.p4q_evaluate_prototype(uuid, jsonb, jsonb, text[], jsonb) from public, anon;
grant execute on function projects.p4q_evaluate_prototype(uuid, jsonb, jsonb, text[], jsonb) to authenticated, service_role;
comment on function projects.p4q_evaluate_prototype(uuid, jsonb, jsonb, text[], jsonb) is
  'QAP section 5/11: the deterministic prototype check set, pure over (locked UI screens, build screens, critical screens, limitations). Checks the structured build cannot answer are returned not_verifiable, never as a pass.';

-- ── intake and limitations: written before QA, by the build's author or a person ─────
create or replace function projects.p4q_declare_prototype_intake(
  p_artifact_id uuid, p_critical_screen_keys text[] default '{}', p_target_viewports text[] default '{}', p_mock_data_note text default null,
  p_figma_refs text[] default '{}', p_self_check jsonb default null, p_revision_origin text default 'initial', p_claimed_fix_defects uuid[] default '{}')
returns table (outcome text, intake_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_art   projects.prototype_artifacts;
  v_id    uuid;
  v_d     uuid;
  v_ui    projects.ui_versions;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid; return; end if;
  select a.* into v_art from projects.prototype_artifacts a where a.id = p_artifact_id for update;
  if v_art.id is null then return query select 'unknown_artifact'::text, null::uuid; return; end if;
  if v_actor is not null and (v_art.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_art.qa_reviewed_at is not null then return query select 'already_reviewed'::text, null::uuid; return; end if;
  if p_revision_origin not in ('initial', 'admin_edit', 'client_change', 'qa_correction') then return query select 'bad_origin'::text, null::uuid; return; end if;
  if coalesce(p_target_viewports, '{}') <@ array['mobile', 'tablet', 'desktop']::text[] is not true then return query select 'bad_viewport'::text, null::uuid; return; end if;
  select u.* into v_ui from projects.ui_versions u where u.id = v_art.ui_version_id;
  if exists (select 1 from unnest(coalesce(p_critical_screen_keys, '{}')) k where not exists (select 1 from jsonb_array_elements(v_ui.screens) s where s ->> 'screenKey' = k)) then
    return query select 'unknown_critical_screen'::text, null::uuid; return;
  end if;
  -- a claimed fix must be a prototype defect of THIS project, found on an earlier build, still open
  foreach v_d in array coalesce(p_claimed_fix_defects, '{}') loop
    if not exists (select 1 from projects.p4q_prototype_defects pd join qa.defects d on d.id = pd.defect_id
                    where pd.defect_id = v_d and pd.project_id = v_art.project_id and pd.artifact_id <> v_art.id and d.status = 'open') then
      return query select 'unknown_defect'::text, null::uuid; return;
    end if;
  end loop;
  perform set_config('projects.p4q_door', 'on', true);
  perform set_config('projects.p4q_intake_edit', 'on', true);
  delete from projects.p4q_prototype_intakes where artifact_id = v_art.id;
  insert into projects.p4q_prototype_intakes (organization_id, project_id, artifact_id, critical_screen_keys, target_viewports, mock_data_note, figma_refs, self_check, revision_origin, claimed_fix_defects, declared_by)
  values (v_art.organization_id, v_art.project_id, v_art.id, coalesce(p_critical_screen_keys, '{}'), coalesce(p_target_viewports, '{}'), p_mock_data_note, coalesce(p_figma_refs, '{}'), p_self_check, p_revision_origin, coalesce(p_claimed_fix_defects, '{}'), v_actor)
  returning id into v_id;
  -- FIX_READY for each claimed defect: a claim tied to this exact build
  foreach v_d in array coalesce(p_claimed_fix_defects, '{}') loop
    perform projects.p4q_link_fix_build(v_d, v_art.id);
  end loop;
  perform core.record_audit(v_art.organization_id, 'project.p4q_prototype_intake_declared', 'prototype_artifact', v_art.id, null,
    jsonb_build_object('projectId', v_art.project_id, 'criticalScreens', coalesce(p_critical_screen_keys, '{}'), 'viewports', coalesce(p_target_viewports, '{}'), 'origin', p_revision_origin));
  return query select 'declared'::text, v_id;
end $$;
revoke all on function projects.p4q_declare_prototype_intake(uuid, text[], text[], text, text[], jsonb, text, uuid[]) from public, anon;
grant execute on function projects.p4q_declare_prototype_intake(uuid, text[], text[], text, text[], jsonb, text, uuid[]) to authenticated, service_role;

create or replace function projects.p4q_declare_prototype_limitation(p_artifact_id uuid, p_statement text, p_screen_key text default null)
returns table (outcome text, limitation_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_art   projects.prototype_artifacts;
  v_id    uuid;
  v_text  text := nullif(btrim(coalesce(p_statement, '')), '');
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid; return; end if;
  select a.* into v_art from projects.prototype_artifacts a where a.id = p_artifact_id for update;
  if v_art.id is null then return query select 'unknown_artifact'::text, null::uuid; return; end if;
  if v_actor is not null and (v_art.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;
  if v_art.qa_reviewed_at is not null then return query select 'already_reviewed'::text, null::uuid; return; end if;
  if v_text is null or length(v_text) < 5 or length(v_text) > 500 then return query select 'bad_statement'::text, null::uuid; return; end if;
  if projects.p7_has_secret(v_text) then return query select 'contains_secret'::text, null::uuid; return; end if;
  if p_screen_key is not null and p_screen_key !~ '^[a-z][a-z0-9_.-]{1,62}$' then return query select 'bad_screen_key'::text, null::uuid; return; end if;
  select l.id into v_id from projects.p4q_prototype_limitations l where l.artifact_id = v_art.id and lower(l.statement) = lower(v_text) and l.screen_key is not distinct from p_screen_key;
  if v_id is not null then return query select 'already_declared'::text, v_id; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  insert into projects.p4q_prototype_limitations (organization_id, project_id, artifact_id, screen_key, statement, declared_by)
  values (v_art.organization_id, v_art.project_id, v_art.id, p_screen_key, v_text, v_actor) returning id into v_id;
  return query select 'declared'::text, v_id;
end $$;
revoke all on function projects.p4q_declare_prototype_limitation(uuid, text, text) from public, anon;
grant execute on function projects.p4q_declare_prototype_limitation(uuid, text, text) to authenticated, service_role;

-- the intake is replaced by delete + insert inside its door only; a direct delete is still refused by the door-only trigger (it checks the flag)

-- ── FIX_READY: a claim tied to one exact fix build ─────────────────────────
create or replace function projects.p4q_link_fix_build(p_defect_id uuid, p_fix_artifact_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_pd    projects.p4q_prototype_defects;
  v_fix   projects.prototype_artifacts;
  v_def   qa.defects;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text; return; end if;
  select * into v_pd from projects.p4q_prototype_defects where defect_id = p_defect_id for update;
  if v_pd.defect_id is null then return query select 'unknown_defect'::text; return; end if;
  select a.* into v_fix from projects.prototype_artifacts a where a.id = p_fix_artifact_id;
  if v_fix.id is null then return query select 'unknown_build'::text; return; end if;
  if v_actor is not null and (v_pd.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text; return;
  end if;
  if v_fix.organization_id is distinct from v_pd.organization_id or v_fix.project_id is distinct from v_pd.project_id then return query select 'wrong_project'::text; return; end if;
  if v_fix.id = v_pd.artifact_id then return query select 'same_build'::text; return; end if;
  if v_fix.created_at <= (select a.created_at from projects.prototype_artifacts a where a.id = v_pd.artifact_id) then return query select 'not_a_later_build'::text; return; end if;
  if v_pd.fix_artifact_id = v_fix.id then return query select 'already_linked'::text; return; end if;
  select * into v_def from qa.defects where id = p_defect_id for update;
  if v_def.status <> 'open' then return query select 'not_open'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_prototype_defects set fix_artifact_id = v_fix.id, fix_declared_by = v_actor, fix_declared_at = clock_timestamp(), retest_run_id = null, retest_result = null, retested_at = null where defect_id = p_defect_id;
  -- FIX_READY is recorded on the defect itself as 'fixed' (a claim, never a verification); the guard stamps who claimed it
  update qa.defects set status = 'fixed', resolution = 'FIX_READY: the build ' || v_fix.id || ' claims to fix this; QA retests that exact build' where id = p_defect_id;
  perform core.record_audit(v_pd.organization_id, 'project.p4q_prototype_fix_ready', 'qa_defect', p_defect_id, null, jsonb_build_object('projectId', v_pd.project_id, 'fixArtifactId', v_fix.id));
  perform core.emit_event(v_pd.organization_id, 'project.p4q_prototype_fix_ready', 'qa_defect', p_defect_id, jsonb_build_object('projectId', v_pd.project_id, 'fixArtifactId', v_fix.id));
  return query select 'linked'::text;
end $$;
revoke all on function projects.p4q_link_fix_build(uuid, uuid) from public, anon;
grant execute on function projects.p4q_link_fix_build(uuid, uuid) to authenticated, service_role;

-- ── retest: VERIFIED only by a QA run of the exact fix build ───────────────
create or replace function projects.p4q_retest_prototype_defect(p_defect_id uuid, p_artifact_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_pd    projects.p4q_prototype_defects;
  v_run   projects.p4q_prototype_qa_runs;
  v_art   projects.prototype_artifacts;
  v_failed boolean;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text; return; end if;
  select * into v_pd from projects.p4q_prototype_defects where defect_id = p_defect_id for update;
  if v_pd.defect_id is null then return query select 'unknown_defect'::text; return; end if;
  if v_actor is not null and (v_pd.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text; return;
  end if;
  if v_pd.fix_artifact_id is null then return query select 'no_fix_build'::text; return; end if;
  if v_pd.fix_artifact_id is distinct from p_artifact_id then return query select 'wrong_build'::text; return; end if;
  select a.* into v_art from projects.prototype_artifacts a where a.id = p_artifact_id;
  -- the person who produced the fix build cannot be the one who verifies it
  if v_actor is not null and v_actor is not distinct from v_art.produced_by then return query select 'self_review'::text; return; end if;
  select r.* into v_run from projects.p4q_prototype_qa_runs r where r.artifact_id = p_artifact_id and r.outcome in ('qa_pass', 'qa_changes_required');
  if v_run.id is null then return query select 'fix_build_not_tested'::text; return; end if;
  if v_pd.retest_result = 'pass' and (select d.status from qa.defects d where d.id = p_defect_id) = 'verified' then return query select 'already_verified'::text; return; end if;
  if v_pd.retest_result = 'pass' and v_actor is null then return query select 'retest_passed'::text; return; end if;
  v_failed := exists (select 1 from projects.p4q_prototype_qa_checks c where c.run_id = v_run.id and c.check_key = v_pd.check_key and c.result = 'fail');
  perform set_config('projects.p4q_door', 'on', true);
  if v_failed then
    -- the fix did not hold: it goes back to open (a failed retest REOPENS it)
    update qa.defects set status = 'open' where id = p_defect_id and status = 'fixed';
    update projects.p4q_prototype_defects set retest_run_id = v_run.id, retest_result = 'still_failing', retested_at = clock_timestamp(), fix_artifact_id = null, fix_declared_by = null, fix_declared_at = null where defect_id = p_defect_id;
    perform core.record_audit(v_pd.organization_id, 'project.p4q_prototype_retest_failed', 'qa_defect', p_defect_id, null, jsonb_build_object('projectId', v_pd.project_id, 'runId', v_run.id));
    return query select 'still_failing'::text; return;
  end if;
  -- qa.defects will not call a defect verified unless a NAMED PERSON stands behind it (defects_verification_shape). An agent run records that the exact fix
  -- build passed the originating check (retest_result = pass) and leaves the defect at FIX_READY; a person then verifies it through p4q_verify_retested_defect.
  update projects.p4q_prototype_defects set retest_run_id = v_run.id, retest_result = 'pass', retested_at = clock_timestamp() where defect_id = p_defect_id;
  if v_actor is null then
    perform core.record_audit(v_pd.organization_id, 'project.p4q_prototype_retest_passed', 'qa_defect', p_defect_id, null, jsonb_build_object('projectId', v_pd.project_id, 'runId', v_run.id));
    return query select 'retest_passed'::text; return;
  end if;
  update qa.defects set status = 'verified', verified_by = v_actor, verified_at = clock_timestamp(),
         retest_evidence = 'QA run ' || v_run.id || ' of the exact fix build ' || p_artifact_id || ': check ' || v_pd.check_key || ' passes'
   where id = p_defect_id and status = 'fixed';
  perform core.record_audit(v_pd.organization_id, 'project.p4q_prototype_defect_verified', 'qa_defect', p_defect_id, null, jsonb_build_object('projectId', v_pd.project_id, 'runId', v_run.id));
  perform core.emit_event(v_pd.organization_id, 'project.p4q_prototype_defect_verified', 'qa_defect', p_defect_id, jsonb_build_object('projectId', v_pd.project_id, 'runId', v_run.id));
  return query select 'verified'::text;
end $$;
revoke all on function projects.p4q_retest_prototype_defect(uuid, uuid) from public, anon;
grant execute on function projects.p4q_retest_prototype_defect(uuid, uuid) to authenticated, service_role;

-- a person verifies a defect whose exact fix build passed the retest (the person stands behind it; they cannot be the one who built the fix)
create or replace function projects.p4q_verify_retested_defect(p_defect_id uuid)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_pd    projects.p4q_prototype_defects;
  v_art   projects.prototype_artifacts;
  v_def   qa.defects;
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  select * into v_pd from projects.p4q_prototype_defects where defect_id = p_defect_id and organization_id = (select core.current_organization_id()) for update;
  if v_pd.defect_id is null then return query select 'unknown_defect'::text; return; end if;
  if not coalesce((select core.can_write()), false) then return query select 'forbidden'::text; return; end if;
  select * into v_def from qa.defects where id = p_defect_id for update;
  if v_def.status = 'verified' then return query select 'already_verified'::text; return; end if;
  if v_pd.retest_result is distinct from 'pass' or v_def.status <> 'fixed' then return query select 'not_retested'::text; return; end if;
  select a.* into v_art from projects.prototype_artifacts a where a.id = v_pd.fix_artifact_id;
  if v_actor is not distinct from v_art.produced_by or v_actor is not distinct from v_def.fixed_by then return query select 'self_review'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update qa.defects set status = 'verified', verified_by = v_actor, verified_at = clock_timestamp(),
         retest_evidence = 'QA run ' || v_pd.retest_run_id || ' of the exact fix build ' || v_pd.fix_artifact_id || ': check ' || v_pd.check_key || ' passes'
   where id = p_defect_id and status = 'fixed';
  perform core.record_audit(v_pd.organization_id, 'project.p4q_prototype_defect_verified', 'qa_defect', p_defect_id, null, jsonb_build_object('projectId', v_pd.project_id, 'runId', v_pd.retest_run_id));
  perform core.emit_event(v_pd.organization_id, 'project.p4q_prototype_defect_verified', 'qa_defect', p_defect_id, jsonb_build_object('projectId', v_pd.project_id, 'runId', v_pd.retest_run_id));
  return query select 'verified'::text;
end $$;
revoke all on function projects.p4q_verify_retested_defect(uuid) from public, anon, service_role;
grant execute on function projects.p4q_verify_retested_defect(uuid) to authenticated;

-- ── the run ────────────────────────────────────────────────────────────────
create or replace function projects.p4q_run_prototype_qa(p_artifact_id uuid, p_blocked_reason text default null, p_blocked_owner text default 'admin', p_resume_condition text default null)
returns table (outcome text, run_id uuid, verdict text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor  uuid := (select auth.uid());
  v_art    projects.prototype_artifacts;
  v_ui     projects.ui_versions;
  v_intake projects.p4q_prototype_intakes;
  v_run    uuid := gen_random_uuid();
  v_prev   projects.p4q_prototype_qa_runs;
  v_prevart projects.prototype_artifacts;
  v_lims   jsonb;
  v_checks jsonb;
  v_verdict text;
  v_total  int; v_failed int; v_nv int; v_blocking int;
  v_changed text[] := '{}';
  v_c      record;
  v_def    uuid;
  v_sev    text;
  v_screen text;
  v_reappear uuid;
  v_vd     record;
  v_blocker_kind text;
  v_blocker_reason text;
  v_owner  text := coalesce(p_blocked_owner, 'admin');
  v_existing projects.p4q_prototype_qa_runs;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then return query select 'no_actor'::text, null::uuid, null::text; return; end if;
  select a.* into v_art from projects.prototype_artifacts a where a.id = p_artifact_id for update;
  if v_art.id is null then return query select 'unknown_artifact'::text, null::uuid, null::text; return; end if;
  if v_actor is not null and (v_art.organization_id is distinct from (select core.current_organization_id()) or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid, null::text; return;
  end if;
  -- ADM-82: a person who produced this build cannot review it
  if v_actor is not null and v_actor is not distinct from v_art.produced_by then return query select 'self_review'::text, null::uuid, null::text; return; end if;
  select r.* into v_existing from projects.p4q_prototype_qa_runs r where r.artifact_id = v_art.id and r.outcome in ('qa_pass', 'qa_changes_required');
  if v_existing.id is not null or v_art.qa_reviewed_at is not null then
    return query select 'already_reviewed'::text, v_existing.id, v_existing.outcome; return;
  end if;
  if v_owner not in ('admin', 'client', 'prototype_agent', 'ui_designer', 'finance', 'external_provider') then return query select 'bad_owner'::text, null::uuid, null::text; return; end if;

  select u.* into v_ui from projects.ui_versions u where u.id = v_art.ui_version_id;
  select i.* into v_intake from projects.p4q_prototype_intakes i where i.artifact_id = v_art.id;
  select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'screen_key', l.screen_key, 'statement', l.statement) order by l.declared_at), '[]'::jsonb) into v_lims
    from projects.p4q_prototype_limitations l where l.artifact_id = v_art.id;

  perform set_config('projects.p4q_door', 'on', true);

  -- INVALID_INTAKE / BLOCKED_EXTERNAL: no verdict, a blocker with an owner and a resume condition
  if v_ui.id is null or v_ui.status <> 'locked' or jsonb_typeof(v_ui.screens) is distinct from 'array' or jsonb_array_length(v_ui.screens) = 0 then
    v_blocker_kind := 'invalid_intake';
    v_blocker_reason := 'the source UI version is not a locked UI with designed screens, so there is nothing to validate the build against';
    v_owner := 'ui_designer';
  elsif nullif(btrim(coalesce(p_blocked_reason, '')), '') is not null then
    v_blocker_kind := 'blocked_external';
    v_blocker_reason := btrim(p_blocked_reason);
  end if;
  if v_blocker_kind is not null then
    if projects.p7_has_secret(v_blocker_reason) then return query select 'contains_secret'::text, null::uuid, null::text; return; end if;
    if exists (select 1 from projects.p4q_prototype_qa_blockers b where b.artifact_id = v_art.id and b.resolved_at is null) then
      return query select 'already_blocked'::text, null::uuid, null::text; return;
    end if;
    insert into projects.p4q_prototype_qa_runs (id, organization_id, project_id, artifact_id, deliverable_id, ui_version_id, outcome, run_by, run_actor, completed_at)
    values (v_run, v_art.organization_id, v_art.project_id, v_art.id, v_art.deliverable_id, v_art.ui_version_id, v_blocker_kind, v_actor, case when v_actor is null then 'agent' else 'person' end, clock_timestamp());
    insert into projects.p4q_prototype_qa_blockers (organization_id, project_id, run_id, artifact_id, kind, reason, owner, resume_condition)
    values (v_art.organization_id, v_art.project_id, v_run, v_art.id, v_blocker_kind, v_blocker_reason, v_owner,
            coalesce(nullif(btrim(coalesce(p_resume_condition, '')), ''), case v_blocker_kind when 'invalid_intake' then 'A locked UI version exists for this build' else 'The external dependency is available and QA is run again' end));
    perform core.record_audit(v_art.organization_id, 'project.p4q_prototype_qa_blocked', 'prototype_artifact', v_art.id, null, jsonb_build_object('projectId', v_art.project_id, 'kind', v_blocker_kind, 'runId', v_run));
    perform core.emit_event(v_art.organization_id, 'project.p4q_prototype_qa_blocked', 'prototype_artifact', v_art.id, jsonb_build_object('projectId', v_art.project_id, 'kind', v_blocker_kind, 'runId', v_run, 'deliverableId', v_art.deliverable_id));
    return query select 'blocked'::text, v_run, v_blocker_kind; return;
  end if;

  -- the checks (pure) -> a temp list the rest of this call reads
  select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) into v_checks
    from projects.p4q_evaluate_prototype(v_art.project_id, v_ui.screens, v_art.screens, coalesce(v_intake.critical_screen_keys, '{}'), v_lims) e;
  -- the intake itself
  v_checks := v_checks || jsonb_build_array(
    jsonb_build_object('check_key', 'intake:declared', 'category', 'intake', 'target', 'intake record', 'expected', 'the build declared its critical screens, viewports and mock-data note',
      'actual', case when v_intake.id is null then 'no intake declared: every designed screen is treated as critical' else 'declared' end, 'result', case when v_intake.id is null then 'not_verifiable' else 'pass' end, 'severity', 'P3'),
    jsonb_build_object('check_key', 'intake:viewports', 'category', 'intake', 'target', 'target viewports', 'expected', 'target viewports are declared',
      'actual', case when coalesce(cardinality(v_intake.target_viewports), 0) = 0 then 'none declared' else array_to_string(v_intake.target_viewports, ', ') end,
      'result', case when coalesce(cardinality(v_intake.target_viewports), 0) = 0 then 'not_verifiable' else 'pass' end, 'severity', 'P3'));

  -- limitation accuracy is written back on the limitation rows
  update projects.p4q_prototype_limitations l set qa_accuracy = case
      when l.screen_key is null then 'accurate'
      when not exists (select 1 from jsonb_array_elements(v_ui.screens) s where s ->> 'screenKey' = l.screen_key) then 'refers_to_unknown_screen'
      when not exists (select 1 from jsonb_array_elements(v_art.screens) s where s ->> 'screenKey' = l.screen_key) then 'hides_required_screen'
      else 'accurate' end, qa_assessed_at = clock_timestamp()
   where l.artifact_id = v_art.id;

  select count(*), count(*) filter (where result = 'fail'), count(*) filter (where result = 'not_verifiable'), count(*) filter (where result = 'fail' and severity in ('P0', 'P1'))
    into v_total, v_failed, v_nv, v_blocking from (select distinct on (t.check_key) t.* from jsonb_to_recordset(v_checks) as t(check_key text, category text, target text, expected text, actual text, result text, severity text) order by t.check_key) p4q_checks_tmp;
  v_verdict := case when v_blocking > 0 then 'qa_changes_required' else 'qa_pass' end;

  -- changed-area scope: which screens differ from the previous build of this project (QAP-024)
  select a.* into v_prevart from projects.prototype_artifacts a where a.project_id = v_art.project_id and a.id <> v_art.id and a.created_at < v_art.created_at order by a.created_at desc limit 1;
  if v_prevart.id is not null then
    select coalesce(array_agg(distinct k), '{}') into v_changed from (
      select s ->> 'screenKey' as k from jsonb_array_elements(v_art.screens) s where not exists (select 1 from jsonb_array_elements(v_prevart.screens) o where o = s)
      union
      select s ->> 'screenKey' from jsonb_array_elements(v_prevart.screens) s where not exists (select 1 from jsonb_array_elements(v_art.screens) o where o = s)) q where k is not null;
    select r.* into v_prev from projects.p4q_prototype_qa_runs r where r.artifact_id = v_prevart.id and r.outcome in ('qa_pass', 'qa_changes_required');
  end if;

  insert into projects.p4q_prototype_qa_runs (id, organization_id, project_id, artifact_id, deliverable_id, ui_version_id, outcome, run_by, run_actor, completed_at, environment,
                                              checks_total, checks_failed, checks_not_verifiable, changed_screens, previous_run_id)
  values (v_run, v_art.organization_id, v_art.project_id, v_art.id, v_art.deliverable_id, v_art.ui_version_id, v_verdict, v_actor, case when v_actor is null then 'agent' else 'person' end, clock_timestamp(),
          jsonb_build_object('platform', v_art.platform, 'viewports', coalesce(v_intake.target_viewports, '{}'), 'revisionOrigin', coalesce(v_intake.revision_origin, 'initial'), 'method', 'deterministic structured-build checks'),
          v_total, v_failed, v_nv, v_changed, v_prev.id);

  insert into projects.p4q_prototype_qa_checks (organization_id, run_id, check_key, category, target, expected, actual, result, severity, disposition)
  select v_art.organization_id, v_run, c.check_key, c.category, c.target, c.expected, c.actual, c.result, c.severity,
         case when c.result <> 'fail' then null when c.severity in ('P0', 'P1') then 'must_fix' when c.severity = 'P2' then 'admin_decides' else 'documented' end
    from (select distinct on (t.check_key) t.* from jsonb_to_recordset(v_checks) as t(check_key text, category text, target text, expected text, actual text, result text, severity text) order by t.check_key) c;

  -- defects: raised in the SAME transaction as the verdict, so a verdict never exists without its defects (QAP-053)
  for v_c in select t.* from jsonb_to_recordset(v_checks) as t(check_key text, category text, target text, expected text, actual text, result text, severity text) where t.result = 'fail' and t.severity in ('P0', 'P1', 'P2') loop
    v_sev := case v_c.severity when 'P0' then 'blocker' when 'P1' then 'major' else 'minor' end;
    v_screen := case when v_c.category in ('coverage', 'navigation', 'interaction', 'states', 'layout', 'limitation') then split_part(split_part(v_c.target, ' ', 1), '/', 1) else null end;
    -- a previously VERIFIED defect with the same check on this project that reappears is a regression
    select pd.defect_id into v_reappear from projects.p4q_prototype_defects pd join qa.defects d on d.id = pd.defect_id
     where pd.project_id = v_art.project_id and pd.check_key = v_c.check_key and d.status = 'verified' order by d.verified_at desc limit 1;
    insert into qa.defects (organization_id, project_id, deliverable_id, severity, title, reproduction, expected, actual, environment)
    values (v_art.organization_id, v_art.project_id, v_art.deliverable_id, v_sev,
            case when v_reappear is not null then 'Regression: ' else '' end || v_c.category || ': ' || v_c.target,
            'Run ' || v_run || ', check ' || v_c.check_key || ' on the exact build ' || v_art.id,
            v_c.expected, v_c.actual, coalesce(v_art.platform, 'prototype'))
    returning id into v_def;
    insert into projects.p4q_prototype_defects (defect_id, organization_id, project_id, artifact_id, source_ui_version_id, run_id, check_key, screen_key, priority, reappears_defect_id)
    values (v_def, v_art.organization_id, v_art.project_id, v_art.id, v_art.ui_version_id, v_run, v_c.check_key, v_screen, v_c.severity, v_reappear);
  end loop;

  -- the verdict goes through the existing door (tenancy, self-review, idempotency stay where they were)
  select r.outcome into v_vd from projects.record_prototype_qa_verdict(
    v_art.id, v_verdict,
    jsonb_build_object(
      'runId', v_run,
      'missingScreens', coalesce((select jsonb_agg(substr(check_key, 17)) from (select distinct on (t.check_key) t.* from jsonb_to_recordset(v_checks) as t(check_key text, category text, target text, expected text, actual text, result text, severity text) order by t.check_key) p4q_checks_tmp where check_key like 'coverage:screen:%' and result = 'fail'), '[]'::jsonb),
      'brokenRoutes', coalesce((select jsonb_agg(target) from (select distinct on (t.check_key) t.* from jsonb_to_recordset(v_checks) as t(check_key text, category text, target text, expected text, actual text, result text, severity text) order by t.check_key) p4q_checks_tmp where check_key like 'navigation:route:%' and result = 'fail'), '[]'::jsonb),
      'secretFindings', case when exists (select 1 from (select distinct on (t.check_key) t.* from jsonb_to_recordset(v_checks) as t(check_key text, category text, target text, expected text, actual text, result text, severity text) order by t.check_key) p4q_checks_tmp where check_key = 'data:secrets' and result = 'fail') then '[{"screenKey":"*","elementIndex":0,"pattern":"credential shape"}]'::jsonb else '[]'::jsonb end,
      'checksTotal', v_total, 'checksFailed', v_failed, 'checksNotVerifiable', v_nv,
      'verdictReasons', coalesce((select jsonb_agg(check_key) from (select distinct on (t.check_key) t.* from jsonb_to_recordset(v_checks) as t(check_key text, category text, target text, expected text, actual text, result text, severity text) order by t.check_key) p4q_checks_tmp where result = 'fail' and severity in ('P0', 'P1')), '[]'::jsonb))) r;
  if v_vd.outcome is distinct from 'recorded' then
    raise exception 'the prototype verdict door answered %, so the QA run is not kept', coalesce(v_vd.outcome, 'nothing') using errcode = 'restrict_violation';
  end if;

  -- retest every defect whose declared fix build is THIS build (independent retest of the exact fix)
  for v_c in select pd.defect_id from projects.p4q_prototype_defects pd where pd.fix_artifact_id = v_art.id and pd.retest_result is null loop
    perform projects.p4q_retest_prototype_defect(v_c.defect_id, v_art.id);
  end loop;

  perform core.record_audit(v_art.organization_id, 'project.p4q_prototype_qa_run', 'prototype_artifact', v_art.id, null,
    jsonb_build_object('projectId', v_art.project_id, 'runId', v_run, 'outcome', v_verdict, 'checks', v_total, 'failed', v_failed));
  return query select 'recorded'::text, v_run, v_verdict;
end $$;
revoke all on function projects.p4q_run_prototype_qa(uuid, text, text, text) from public, anon;
grant execute on function projects.p4q_run_prototype_qa(uuid, text, text, text) to authenticated, service_role;
comment on function projects.p4q_run_prototype_qa(uuid, text, text, text) is
  'The prototype QA door: records the run, every check, the defects and the verdict in one transaction, retests the defects this build claims to fix, and records BLOCKED_EXTERNAL / INVALID_INTAKE as a run + blocker, never a pass. It cannot approve, verify payment or certify Phase 6.';

-- a person resolves a blocker; resolving does not pass the build, it allows QA to run again
create or replace function projects.p4q_resolve_qa_blocker(p_blocker_id uuid, p_note text)
returns table (outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_b     projects.p4q_prototype_qa_blockers;
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_actor is null then return query select 'no_actor'::text; return; end if;
  if not coalesce((select core.can_manage_delivery()), false) then return query select 'not_authorized'::text; return; end if;
  select * into v_b from projects.p4q_prototype_qa_blockers where id = p_blocker_id and organization_id = (select core.current_organization_id()) for update;
  if v_b.id is null then return query select 'not_found'::text; return; end if;
  if v_b.resolved_at is not null then return query select 'already_resolved'::text; return; end if;
  if v_note is null or length(v_note) < 5 then return query select 'note_required'::text; return; end if;
  perform set_config('projects.p4q_door', 'on', true);
  update projects.p4q_prototype_qa_blockers set resolved_at = clock_timestamp(), resolved_by = v_actor, resolution_note = v_note where id = v_b.id;
  perform core.record_audit(v_b.organization_id, 'project.p4q_prototype_qa_blocker_resolved', 'prototype_artifact', v_b.artifact_id, null, jsonb_build_object('projectId', v_b.project_id, 'blockerId', v_b.id));
  return query select 'resolved'::text;
end $$;
revoke all on function projects.p4q_resolve_qa_blocker(uuid, text) from public, anon, service_role;
grant execute on function projects.p4q_resolve_qa_blocker(uuid, text) to authenticated;

-- ── an Admin cannot APPROVE a build QA has not passed (QAP-021) ────────────
create or replace function projects.p4q_admin_approval_needs_qa_pass()
returns trigger language plpgsql set search_path = '' as $$
declare v_status text;
begin
  if new.admin_status = 'approved' and new.admin_status is distinct from old.admin_status then
    select a.status into v_status from projects.prototype_artifacts a where a.deliverable_id = new.deliverable_id;
    if v_status is not null and v_status <> 'qa_pass' then
      raise exception 'the Admin receives only a QA-passed build: this build''s QA state is %', v_status using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end $$;
revoke all on function projects.p4q_admin_approval_needs_qa_pass() from public, anon, authenticated, service_role;
drop trigger if exists p4q_admin_approval_needs_qa_pass on projects.deliverable_details;
create trigger p4q_admin_approval_needs_qa_pass before update of admin_status on projects.deliverable_details for each row execute function projects.p4q_admin_approval_needs_qa_pass();

-- ── reads (internal staff only) ────────────────────────────────────────────
create or replace function projects.p4q_prototype_admin_handoff(p_artifact_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := (select core.current_organization_id());
  v_art projects.prototype_artifacts;
  v_run projects.p4q_prototype_qa_runs;
  v_intake projects.p4q_prototype_intakes;
  v_ui projects.ui_versions;
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return null; end if;
  select a.* into v_art from projects.prototype_artifacts a where a.id = p_artifact_id and a.organization_id = v_org;
  if v_art.id is null then return null; end if;
  select r.* into v_run from projects.p4q_prototype_qa_runs r where r.artifact_id = v_art.id order by r.started_at desc, r.id desc limit 1;
  select i.* into v_intake from projects.p4q_prototype_intakes i where i.artifact_id = v_art.id;
  select u.* into v_ui from projects.ui_versions u where u.id = v_art.ui_version_id;
  return jsonb_build_object(
    'build', jsonb_build_object('artifactId', v_art.id, 'deliverableId', v_art.deliverable_id, 'status', v_art.status, 'platform', v_art.platform, 'builtAt', v_art.created_at),
    'sourceUi', jsonb_build_object('uiVersionId', v_ui.id, 'version', v_ui.version, 'status', v_ui.status),
    'viewports', coalesce(to_jsonb(v_intake.target_viewports), '[]'::jsonb),
    'revisionOrigin', coalesce(v_intake.revision_origin, 'initial'),
    'qa', case when v_run.id is null then null else jsonb_build_object('runId', v_run.id, 'outcome', v_run.outcome, 'runBy', v_run.run_by, 'runActor', v_run.run_actor, 'completedAt', v_run.completed_at,
            'checksTotal', v_run.checks_total, 'checksFailed', v_run.checks_failed, 'checksNotVerifiable', v_run.checks_not_verifiable, 'changedScreens', v_run.changed_screens) end,
    'coverageSummary', coalesce((select jsonb_object_agg(category, jsonb_build_object('pass', p, 'fail', f, 'notVerifiable', n)) from (
        select c.category, count(*) filter (where c.result = 'pass') p, count(*) filter (where c.result = 'fail') f, count(*) filter (where c.result = 'not_verifiable') n
          from projects.p4q_prototype_qa_checks c where c.run_id = v_run.id group by c.category) q), '{}'::jsonb),
    'openDefectsBySeverity', coalesce((select jsonb_object_agg(severity, n) from (
        select d.severity, count(*) n from qa.defects d join projects.p4q_prototype_defects pd on pd.defect_id = d.id
         where pd.artifact_id = v_art.id and d.status in ('open', 'fixed', 'needs_evidence', 'not_reproduced') group by d.severity) q), '{}'::jsonb),
    'limitations', coalesce((select jsonb_agg(jsonb_build_object('statement', l.statement, 'screen', l.screen_key, 'qaAccuracy', l.qa_accuracy) order by l.declared_at) from projects.p4q_prototype_limitations l where l.artifact_id = v_art.id), '[]'::jsonb),
    'fixAndRetest', coalesce((select jsonb_agg(jsonb_build_object('defectId', pd.defect_id, 'checkKey', pd.check_key, 'fixBuild', pd.fix_artifact_id, 'retestResult', pd.retest_result, 'retestRun', pd.retest_run_id) order by pd.defect_id)
        from projects.p4q_prototype_defects pd where pd.fix_artifact_id = v_art.id or pd.retest_run_id = v_run.id), '[]'::jsonb),
    'regressions', coalesce((select jsonb_agg(jsonb_build_object('defectId', pd.defect_id, 'reappearsDefectId', pd.reappears_defect_id, 'checkKey', pd.check_key))
        from projects.p4q_prototype_defects pd where pd.artifact_id = v_art.id and pd.reappears_defect_id is not null), '[]'::jsonb),
    'openBlockers', coalesce((select jsonb_agg(jsonb_build_object('kind', b.kind, 'reason', b.reason, 'owner', b.owner, 'resumeCondition', b.resume_condition)) from projects.p4q_prototype_qa_blockers b where b.artifact_id = v_art.id and b.resolved_at is null), '[]'::jsonb));
end $$;
revoke all on function projects.p4q_prototype_admin_handoff(uuid) from public, anon, service_role;
grant execute on function projects.p4q_prototype_admin_handoff(uuid) to authenticated;

create or replace function projects.p4q_prototype_qa_overview(p_project_id uuid)
returns table (artifact_id uuid, deliverable_id uuid, ui_version integer, built_at timestamptz, qa_state text, owner text, blocker text, blocker_id uuid, latest_run_id uuid, latest_run_at timestamptz, checks_failed integer, why text)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query
  select a.id, a.deliverable_id, u.version, a.created_at,
         case when b.id is not null then b.kind when r.outcome is not null then r.outcome else 'not_run' end,
         case when b.id is not null then b.owner when r.outcome is null then 'quality_assurance' when r.outcome = 'qa_changes_required' then 'ui_prototype' else 'admin' end,
         b.reason, b.id, r.id, r.started_at, r.checks_failed,
         (select string_agg(c.check_key, ', ' order by c.check_key) from projects.p4q_prototype_qa_checks c where c.run_id = r.id and c.result = 'fail' and c.severity in ('P0', 'P1'))
    from projects.prototype_artifacts a
    join projects.ui_versions u on u.id = a.ui_version_id
    left join lateral (select x.* from projects.p4q_prototype_qa_runs x where x.artifact_id = a.id order by x.started_at desc, x.id desc limit 1) r on true
    left join projects.p4q_prototype_qa_blockers b on b.artifact_id = a.id and b.resolved_at is null
   where a.project_id = p_project_id and a.organization_id = v_org
   order by a.created_at desc;
end $$;
revoke all on function projects.p4q_prototype_qa_overview(uuid) from public, anon, service_role;
grant execute on function projects.p4q_prototype_qa_overview(uuid) to authenticated;

-- fixes whose exact build passed the retest and which wait for a person to verify them
create or replace function projects.p4q_defects_awaiting_verification(p_project_id uuid)
returns table (defect_id uuid, title text, check_key text, fix_artifact_id uuid, retest_run_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := (select core.current_organization_id());
begin
  if v_org is null or not coalesce((select core.is_internal()), false) then return; end if;
  return query select pd.defect_id, d.title, pd.check_key, pd.fix_artifact_id, pd.retest_run_id
    from projects.p4q_prototype_defects pd join qa.defects d on d.id = pd.defect_id
   where pd.project_id = p_project_id and pd.organization_id = v_org and pd.retest_result = 'pass' and d.status = 'fixed' order by d.created_at;
end $$;
revoke all on function projects.p4q_defects_awaiting_verification(uuid) from public, anon, service_role;
grant execute on function projects.p4q_defects_awaiting_verification(uuid) to authenticated;

notify pgrst, 'reload schema';
