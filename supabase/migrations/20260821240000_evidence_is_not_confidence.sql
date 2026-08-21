-- ═══════════════════════════════════════════════════════════════════════════
-- Evidence is not confidence.
--
-- Document 14 §31 is a list of nine ways a system lies to itself about being
-- ready. Three of them are about the same missing thing:
--
--   *"Never use agent confidence as evidence."*
--   *"Skipped tests are not passes."*
--   *"Do not approve a build different from the tested build."*
--
-- AgencyOS has `qa.defects` and `projects.production_readiness`, and **no test
-- evidence at all**. So "critical tests pass" — Doc 14 §21's second hard gate —
-- has never had any data behind it, and a build reaches `approved` on the
-- strength of somebody, or something, saying it works. §31 names that exact
-- state twice more: *"Compilation is not functional correctness"* and
-- *"Prototype success is not production readiness."*
--
-- ── what is deliberately NOT built, and why it is not an omission ────────
--
-- **There is no readiness score.** Doc 14 §19 describes a weighted aggregate
-- across ten dimensions and then says where the weights come from: *"The
-- scoring model and weights are configurable in the Admin Policy Engine."*
-- §20's bands (90–100, 80–89, 70–79) are labelled *Suggested*. Nobody has
-- configured any of it, and a weight invented here would be the business rule
-- being invented rather than implemented — the same refusal ADM-88 made about
-- lead scoring, for the same reason.
--
-- §31 also makes the score the least interesting part: *"A high score cannot
-- override a hard safety or quality gate"* and *"Critical defects cannot be
-- hidden inside an average score."* The gates are what decide. So this builds
-- the gates, reports the ones nobody has configured as **undecided rather than
-- passing**, and computes no number at all.
--
-- ── and what is NOT changed ─────────────────────────────────────────────
--
-- ADM-19 already settled what *production ready* is allowed to mean — zero
-- open blockers, zero open majors, an approved build — and
-- `projects.production_readiness` answers exactly that. Doc 14 §21's eleven
-- gates are about DEPLOYMENT, which AgencyOS has no engine for. Folding
-- eleven gates into ADM-19's three would be re-deciding a granted decision
-- from a document that is talking about something else. `qa.release_gates`
-- is a separate reading, beside it.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists qa.test_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- **The whole point of the table.** Doc 14 §31: "Do not approve a build
  -- different from the tested build." Evidence that does not name what it was
  -- run against is evidence for anything, and `projects.deliverables` is
  -- unique per (project, kind, version) — so naming the row names the version,
  -- and a new build starts with no evidence rather than inheriting the last
  -- one's. NOT NULL for that reason: a floating test run is the defect.
  deliverable_id   uuid not null references projects.deliverables(id) on delete cascade,

  -- Doc 14 §6's 360° model, as its own words. Closed set: a free-text suite
  -- name lets "critical tests pass" be satisfied by a suite somebody invented
  -- for the occasion.
  suite            text not null check (suite in
                     ('functional', 'ui', 'api', 'integration', 'e2e',
                      'regression', 'smoke', 'security', 'performance', 'compatibility')),

  total            int not null check (total >= 0),
  passed           int not null check (passed >= 0),
  failed           int not null check (failed >= 0),
  -- Doc 14 §31: "Skipped tests are not passes." A separate column, never
  -- folded into either of the others, because the fold is the lie.
  skipped          int not null default 0 check (skipped >= 0),

  -- Where the output actually is — a CI run, a report, a log. Doc 14 §31:
  -- "Never use agent confidence as evidence." A claim with nothing behind it
  -- is confidence; a claim with a re-checkable artefact behind it is evidence,
  -- and the difference is this column.
  evidence_url     text,

  executed_at      timestamptz not null default now(),
  executed_by      uuid references core.users(id) on delete set null,
  executed_by_agent text references ai.agents(key) on delete set null,

  created_at       timestamptz not null default now(),

  -- The arithmetic has to close. Without this a run can report 100 passed of
  -- 100 while 30 were skipped, which is precisely the sentence §31 forbids
  -- written as a row.
  constraint test_runs_counts_add_up
    check (passed + failed + skipped = total),

  -- Doc 14 §31: "Never use agent confidence as evidence." An agent-authored
  -- run must point at something a human can open. A person recording a manual
  -- run may not have a URL, and Doc 14 §18 admits manual testing explicitly —
  -- so the rule binds the author who cannot be asked afterwards.
  constraint test_runs_agent_evidence_is_external
    check (executed_by_agent is null
           or (evidence_url is not null and length(trim(evidence_url)) > 0))
);

create index if not exists test_runs_deliverable_idx
  on qa.test_runs (deliverable_id, suite, executed_at desc);

comment on table qa.test_runs is
  'One execution of one suite against one build (Doc 14). Three of Doc 14 section 31''s nine rules are structural here: a run names the exact deliverable it was run against ("do not approve a build different from the tested build"), skipped is its own column and the counts must add up ("skipped tests are not passes"), and an agent-authored run must carry a re-checkable artefact ("never use agent confidence as evidence").';

comment on column qa.test_runs.skipped is
  'Doc 14 section 31: "Skipped tests are not passes." Never folded into passed or failed - the fold IS the lie, and qa.release_gates counts a suite as passing only when failed = 0 AND skipped = 0.';

-- ── evidence is not editable ─────────────────────────────────────────────
--
-- A run that can be corrected afterwards is a claim, not a record. The same
-- discipline `ai.memory_records` and `projects.scope_versions` carry: if the
-- numbers were wrong, the honest repair is another run.
--
-- **UPDATE and DELETE are not the same rule, and a first draft treated them as
-- one.** Refusing every DELETE row-by-row also refuses the `on delete cascade`
-- from `projects.projects` — so a project that had ever been tested could not
-- be deleted at all, and the verification script's own cleanup failed silently
-- on every run while the script reported all checks passed. Thirty-five rows
-- were sitting in the database before anybody looked.
--
-- So: UPDATE is always wrong and is always refused. DELETE goes through
-- `core.reject_end_user_delete`, the helper this repository already has for
-- exactly this — it refuses an authenticated end-user and leaves the
-- identity-less callers alone, which is what a cascade is. A project ceasing
-- to exist is not somebody rewriting evidence.
--
-- **Which means the two rules are not equally strong, and saying so matters
-- more than the rule reading well.** UPDATE is refused by the trigger for
-- everybody. DELETE is refused by the trigger only for an authenticated
-- end-user; a service-role caller has no `auth.uid()` and is exempt by
-- design, so what actually stops it is the grant below — there is no DELETE
-- privilege to use. Red-proving this is what surfaced it: granting DELETE
-- back, with the trigger still in place, let a run be deleted. The claim
-- "evidence is never deleted" is true of every path AgencyOS has, and it is
-- true because of the grant, not because of the trigger.

create or replace function qa.refuse_test_run_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a test run is evidence and is never edited; record another run (Doc 14 §31)'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists refuse_test_run_rewrite on qa.test_runs;
create trigger refuse_test_run_rewrite
  before update on qa.test_runs
  for each row execute function qa.refuse_test_run_rewrite();

drop trigger if exists test_runs_reject_end_user_delete on qa.test_runs;
create trigger test_runs_reject_end_user_delete
  before delete on qa.test_runs
  for each row execute function core.reject_end_user_delete();

-- ── a test run is run against a build ────────────────────────────────────

create or replace function qa.refuse_non_build_test_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_kind       text;
  v_project_id uuid;
begin
  select d.kind, d.project_id into v_kind, v_project_id
    from projects.deliverables d
   where d.id = new.deliverable_id;

  if v_kind is distinct from 'build' then
    raise exception
      'test evidence names a % deliverable; a design is reviewed and a build is tested (Doc 14 §2)',
      coalesce(v_kind, 'missing')
      using errcode = 'check_violation';
  end if;

  if v_project_id is distinct from new.project_id then
    raise exception 'the test run and the build it names belong to different projects'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists refuse_non_build_test_run on qa.test_runs;
create trigger refuse_non_build_test_run
  before insert on qa.test_runs
  for each row execute function qa.refuse_non_build_test_run();

-- ── Doc 14 §21's gates, as answers rather than as a score ───────────────
--
-- Side-effect free, so a screen can show it without pressing anything — the
-- same shape as `production_readiness`, `start_readiness` and `ui_coverage`.
--
-- **`state` has three values, and the third is the important one.** A gate
-- nobody has configured reports `undecided`, never `pass`. Doc 14 §31 exists
-- because a readiness report that resolves the unknown in its own favour is
-- how false production readiness happens; a gate with no data has not been
-- met, it has not been asked.

create or replace function qa.release_gates(p_project_id uuid)
returns table (
  gate    text,
  state   text,   -- 'pass' | 'fail' | 'undecided'
  detail  text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with build as (
    select d.id, d.version
      from projects.deliverables d
     where d.project_id = p_project_id
       and d.kind = 'build'
       and d.status <> 'superseded'
     order by d.version desc
     limit 1
  ),
  runs as (
    select t.suite,
           sum(t.failed)  as failed,
           sum(t.skipped) as skipped,
           sum(t.total)   as total
      from qa.test_runs t
      join build b on b.id = t.deliverable_id
     group by t.suite
  )
  -- §21 "Build succeeds." A build deliverable exists for this project at all.
  select 'build_exists'::text,
         case when exists (select 1 from build) then 'pass' else 'fail' end,
         coalesce((select 'v' || b.version::text from build b), 'no build deliverable')

  union all
  -- §21 "Critical tests pass." Doc 14 §31: "Skipped tests are not passes", so
  -- a suite counts only when nothing failed AND nothing was skipped.
  select 'critical_tests_pass',
         case
           when not exists (select 1 from build) then 'undecided'
           when not exists (select 1 from runs)  then 'undecided'
           when exists (select 1 from runs r where r.failed > 0 or r.skipped > 0) then 'fail'
           else 'pass'
         end,
         coalesce(
           (select string_agg(r.suite || ' ' || (r.total - r.failed - r.skipped) || '/' || r.total, ', ' order by r.suite)
              from runs r),
           'no test evidence for this build')

  union all
  -- §21 "No unresolved S0/S1 defects." blocker and major are this system's
  -- two names for those, and ADM-19 already treats both as blocking.
  select 'no_unresolved_s0_s1',
         case when exists (
           select 1 from qa.defects d
            where d.project_id = p_project_id
              and d.status = 'open'
              and d.severity in ('blocker', 'major')
         ) then 'fail' else 'pass' end,
         coalesce((
           select string_agg(d.severity, ', ' order by d.severity)
             from qa.defects d
            where d.project_id = p_project_id and d.status = 'open'
              and d.severity in ('blocker', 'major')
         ), 'none open')

  union all
  -- §21 "Release artifact is uniquely identified." The artifact has to have a
  -- location, not just a row saying it exists.
  select 'artifact_identified',
         case
           when not exists (select 1 from build) then 'undecided'
           when exists (select 1 from projects.deliverables d join build b on b.id = d.id
                         where coalesce(trim(d.artifact_url), '') <> '') then 'pass'
           else 'fail'
         end,
         'Doc 14 §21'

  union all
  -- §21 "Required Admin/PM approval exists."
  select 'approval_exists',
         case
           when not exists (select 1 from build) then 'undecided'
           when exists (select 1 from projects.deliverables d join build b on b.id = d.id
                         where d.status = 'approved') then 'pass'
           else 'fail'
         end,
         'Doc 14 §21'

  union all
  -- The gates Doc 14 §21 names that nothing in AgencyOS records yet. Reported
  -- as `undecided` rather than omitted: a gate that disappears from the report
  -- reads as met, and §31 is a list of exactly that kind of mistake.
  select g, 'undecided', 'no configuration and no evidence source in AgencyOS (Doc 14 §21)'
    from unnest(array[
      'security_gates',
      'performance_gates',
      'migration_validation',
      'deployment_config_valid',
      'rollback_plan',
      'client_acceptance'
    ]) as g

  order by 2, 1;
$$;

comment on function qa.release_gates(uuid) is
  'Doc 14 section 21''s hard deployment gates, as answers. NO SCORE IS COMPUTED: section 19 says the scoring model and weights are configurable in the Admin Policy Engine and nobody has configured them, so a weight invented here would be the business rule being invented rather than implemented. A gate with no evidence reports `undecided`, never `pass` - section 31 exists because a readiness report that resolves the unknown in its own favour is how false production readiness happens. This is a reading beside projects.production_readiness, not a replacement: ADM-19 settled what production ready means, and these gates are about deployment, which AgencyOS has no engine for.';

-- ── tenancy ──────────────────────────────────────────────────────────────

alter table qa.test_runs enable row level security;
alter table qa.test_runs force row level security;

drop policy if exists test_runs_select on qa.test_runs;
create policy test_runs_select on qa.test_runs
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop trigger if exists org_match_test_runs_project on qa.test_runs;
create trigger org_match_test_runs_project
  before insert or update of project_id, organization_id on qa.test_runs
  for each row execute function core.enforce_parent_org('project_id', 'projects.projects');

drop trigger if exists org_match_test_runs_deliverable on qa.test_runs;
create trigger org_match_test_runs_deliverable
  before insert or update of deliverable_id, organization_id on qa.test_runs
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.deliverables');

drop trigger if exists freeze_org_test_runs on qa.test_runs;
create trigger freeze_org_test_runs
  before update of organization_id on qa.test_runs
  for each row execute function core.freeze_organization_id();

-- ── grants ───────────────────────────────────────────────────────────────
--
-- No UPDATE and no DELETE, to anybody. The triggers refuse both, and a grant
-- that has to be refused by a trigger is a grant nobody needed — evidence is
-- appended, never revised.

-- SELECT and INSERT only. This grant is not a convenience: it is what makes
-- "a test run is never deleted" true of the service role, which the DELETE
-- trigger deliberately exempts.
grant select, insert on qa.test_runs to authenticated, service_role;
grant execute on function qa.release_gates(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
