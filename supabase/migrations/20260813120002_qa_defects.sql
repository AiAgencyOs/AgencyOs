-- ═══════════════════════════════════════════════════════════════════════════
-- What is wrong with what we are about to show them.
--
-- Phase 12, gap G-030. Directive §19 asks for 360° QA and lists what every bug
-- must carry: id, severity, reproduction, expected result, actual result,
-- environment, evidence, assignee, status, resolution, verification. None of
-- it existed — a bug lived in somebody's head or in a WhatsApp message, and
-- "production ready" meant whoever was asked felt reasonably good about it.
--
-- ── the rule here already existed, so it is followed rather than invented ──
--
-- ARCHITECTURE.md §4.8: *"projects.deliverables cannot transition to
-- submitted_to_client while an open blocker or major defect exists."* That is
-- a stated product rule, not a guess, which is why this migration may build
-- the gate while the payment gates (G-100, ADM-13/ADM-14) stay unbuilt.
--
-- The severity and status vocabularies are ARCHITECTURE's own — blocker,
-- major, minor, trivial; open, fixed, wontfix, verified — kept rather than
-- improved, because a design document that is followed except where somebody
-- preferred otherwise is not a design document.
--
-- ── the gate is scoped to the version being submitted, and that matters ────
--
-- The obvious reading — "no open blocker on this project" — is a trap. Bugs
-- are found against a version; the *fix* is the next version. If a blocker on
-- design v2 blocked submitting design v3, the fix could never be shown to
-- anybody and the only way out would be to close the bug dishonestly.
--
-- So an open blocker or major defect blocks the **version it was found on**.
-- A defect with no version named is project-wide and blocks everything, which
-- is the deliberate stop-everything case: somebody has decided this project
-- should not be showing the client anything.
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists qa;

comment on schema qa is
  'Quality: what is wrong with what we are about to show the client, and whether it has been checked (ARCHITECTURE.md §4.8, directive §19).';

-- The same appending block the approvals schema needed (G-097). A schema
-- created by a migration is not in pgrst.db_schemas, and the failure mode is
-- every call answering 406 in production. Additive, so it cannot drop a schema
-- somebody else added; a warning rather than a failure if the role cannot be
-- altered, with the dashboard toggle documented in AGENCYOS_OPERATIONS.md §2.4.
do $$
declare v_list text;
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then return; end if;

  select split_part(cfg, '=', 2) into v_list
    from pg_roles r, unnest(r.rolconfig) as cfg
   where r.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%';

  if v_list is null or position('qa' in v_list) > 0 then return; end if;

  execute format('alter role authenticator set pgrst.db_schemas = %L', v_list || ', qa');
  notify pgrst, 'reload config';
exception
  when insufficient_privilege then
    raise warning 'could not expose the qa schema (%). Add it in Dashboard -> Project Settings -> API -> Exposed schemas.', sqlerrm;
end;
$$;

create table if not exists qa.defects (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  project_id       uuid not null references projects.projects(id) on delete cascade,

  -- The version it was found on. Null means project-wide: it blocks every
  -- submission rather than one, which is the stop-everything case.
  deliverable_id   uuid references projects.deliverables(id) on delete set null,

  -- ARCHITECTURE.md §4.8's vocabulary, kept as written.
  severity         text not null check (severity in ('blocker', 'major', 'minor', 'trivial')),
  status           text not null default 'open' check (status in ('open', 'fixed', 'wontfix', 'verified')),

  title            text not null check (length(trim(title)) > 0),

  -- Directive §19. Reproduction is required because a bug nobody can reproduce
  -- is a rumour, and the cost of writing it down is paid once by the finder
  -- rather than repeatedly by whoever picks it up.
  reproduction     text not null check (length(trim(reproduction)) > 0),
  expected         text,
  actual           text,
  environment      text,
  evidence_url     text,

  assignee_id      uuid references core.users(id) on delete set null,
  reported_by      uuid references core.users(id) on delete set null,

  -- How it ended. Required to leave 'open', which is what stops a bug being
  -- closed by silence.
  resolution       text,

  verified_by      uuid references core.users(id) on delete set null,
  verified_at      timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- A verified defect was checked by somebody, at a time. Anything else is a
  -- status nobody stands behind.
  constraint defects_verification_shape check (
    status <> 'verified' or (verified_by is not null and verified_at is not null)
  ),

  -- Leaving 'open' says why.
  constraint defects_resolution_shape check (
    status = 'open' or (resolution is not null and length(trim(resolution)) > 0)
  )
);

comment on table qa.defects is
  'One row per bug, carrying what directive §19 asks of every one: severity, reproduction, expected and actual, environment, evidence, assignee, status, resolution and verification. An open blocker or major defect stops the version it was found on from reaching the client.';

create index if not exists defects_project_idx on qa.defects (project_id, status, severity);
create index if not exists defects_open_idx
  on qa.defects (organization_id, severity) where status = 'open';
create index if not exists defects_deliverable_idx on qa.defects (deliverable_id) where status = 'open';

drop trigger if exists set_updated_at on qa.defects;
create trigger set_updated_at
  before update on qa.defects
  for each row execute function core.set_updated_at();

-- ── the transitions ──────────────────────────────────────────────────────
--
--   open → fixed → verified      the ordinary path
--   open → wontfix               a decision, and it carries a reason
--   fixed → open                 verification failed; it is not fixed
--
-- `verified` and `wontfix` are terminal. A verified defect that can be
-- reopened would make "verified" mean "verified for now", and the whole point
-- of the state is that somebody checked.
create or replace function qa.defects_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
     or new.project_id   is distinct from old.project_id
     or new.created_at   is distinct from old.created_at
  then
    raise exception 'a defect may not change tenancy, project or creation time'
      using errcode = 'restrict_violation';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('verified', 'wontfix') then
      raise exception 'defect % is already %; raise a new one', old.id, old.status
        using errcode = 'restrict_violation';
    end if;

    if not (
      (old.status = 'open'  and new.status in ('fixed', 'wontfix'))
      or (old.status = 'fixed' and new.status in ('verified', 'open'))
    ) then
      raise exception 'a defect does not move from % to %', old.status, new.status
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists defects_guard on qa.defects;
create trigger defects_guard
  before update on qa.defects
  for each row execute function qa.defects_guard();

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — internal only. A client is told what was fixed, not what is broken.
-- ═══════════════════════════════════════════════════════════════════════════

alter table qa.defects enable row level security;

drop policy if exists defects_select on qa.defects;
create policy defects_select on qa.defects
  for select to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.is_internal())
  );

drop policy if exists defects_write on qa.defects;
create policy defects_write on qa.defects
  for all to authenticated
  using (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  )
  with check (
    organization_id = (select core.current_organization_id())
    and (select core.can_manage_delivery())
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- The gate — ARCHITECTURE.md §4.8
-- ═══════════════════════════════════════════════════════════════════════════

/**
 * What stops this version reaching the client.
 *
 * Returns the blocking defects, so a caller can say *which* rather than
 * "something". Scoped to the version and to project-wide defects, for the
 * reason in the header: a blocker on v2 must not stop v3, because v3 is how
 * v2 gets fixed.
 */
create or replace function qa.blocking_defects(p_deliverable_id uuid)
returns table (id uuid, severity text, title text)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.severity, d.title
    from qa.defects d
    join projects.deliverables dv on dv.id = p_deliverable_id
   where d.project_id = dv.project_id
     and d.status = 'open'
     and d.severity in ('blocker', 'major')
     and (d.deliverable_id = p_deliverable_id or d.deliverable_id is null)
   order by case d.severity when 'blocker' then 0 else 1 end, d.created_at;
$$;

comment on function qa.blocking_defects(uuid) is
  'The open blocker and major defects that stop this version reaching the client (ARCHITECTURE.md §4.8). Scoped to the version and to project-wide defects: a blocker found on v2 must not stop v3, because v3 is the fix.';

/** Counts for the project page, and the input a readiness gate will need. */
create or replace function qa.project_quality(p_project_id uuid)
returns table (
  open_blockers bigint,
  open_majors   bigint,
  open_minors   bigint,
  unverified    bigint,
  total         bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    count(*) filter (where status = 'open' and severity = 'blocker'),
    count(*) filter (where status = 'open' and severity = 'major'),
    count(*) filter (where status = 'open' and severity in ('minor', 'trivial')),
    count(*) filter (where status = 'fixed'),
    count(*)
  from qa.defects
 where project_id = p_project_id;
$$;

comment on function qa.project_quality(uuid) is
  'Defect counts for one project. `unverified` is the fixed-but-unchecked pile, which is the number that matters before anybody says production ready — G-031 and ADM-19 decide what the threshold is; this only counts.';

-- ── the gate itself, inside the submission ───────────────────────────────
--
-- Added to projects.submit_deliverable rather than enforced by a trigger on
-- the table: the caller gets a named outcome and the list of what is blocking,
-- where a trigger could only raise. Belt and braces is what ARCHITECTURE asks
-- for, and the braces here are that the function is the only way in — the
-- table's own write policy admits delivery roles, but nothing else moves a
-- deliverable to in_review.
create or replace function projects.submit_deliverable(
  p_deliverable_id uuid,
  p_requested_by   uuid default null,
  p_summary        text default null
)
returns table (
  -- 'submitted' | 'already_in_review' | 'not_found' | 'settled' | 'no_policy'
  -- | 'blocked'
  outcome    text,
  request_id uuid,
  status     text
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row      projects.deliverables;
  v_approval record;
  v_blocking int;
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

  return query select 'submitted'::text, v_approval.request_id, 'in_review'::text;
end;
$$;

revoke all on function qa.blocking_defects(uuid) from public;
revoke all on function qa.project_quality(uuid) from public;

grant usage on schema qa to authenticated, service_role;
grant execute on function qa.blocking_defects(uuid) to authenticated, service_role;
grant execute on function qa.project_quality(uuid) to authenticated, service_role;
grant select, insert, update on qa.defects to authenticated, service_role;
