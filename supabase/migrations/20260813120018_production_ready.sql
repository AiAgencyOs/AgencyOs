-- G-031 — what "production ready" is allowed to mean.
--
-- ADM-19, and the answer is narrower than directive §20 sketches. Exactly two
-- conditions:
--
--   1. **zero open Blocker and zero open Major defects**
--   2. the **client has approved the final build**
--
-- Payment state and an owner sign-off were offered and **deliberately excluded**.
-- That is worth recording, because §20 lists both and somebody reading the
-- directive later will wonder why they are missing. They are missing because
-- the Admin left them out: a project can be production ready and unpaid, and
-- nobody has to countersign the numbers.
--
-- ── why this can be answered now and could not before ─────────────────────
--
-- The decision document said so in as many words: until this week the question
-- was unanswerable, because there was no defect table, no versioned
-- deliverables and no handover. Four of §20's conditions — the client's build,
-- its deployment, its security checks, its documentation — are facts this
-- system has never held, and inventing a column for each would have produced a
-- gate that lies.
--
-- ── the severity vocabulary needed no work ────────────────────────────────
--
-- ADM-17 chose Blocker / Major / Minor / Trivial. `qa.defects` has used exactly
-- those words since it was built, so the decision confirmed the schema rather
-- than changing it. Noted because a reader comparing the two would otherwise
-- look for the migration that renamed them.

alter table projects.projects
  add column if not exists production_ready_at timestamptz;

comment on column projects.projects.production_ready_at is
  'When the project was marked production ready (ADM-19): zero open blockers, zero open majors, and a client-approved build. Null until then. Payment state is deliberately not a condition.';

-- ── what is still in the way ──────────────────────────────────────────────
--
-- Separate and side-effect free, so a screen can show the three answers before
-- anybody presses anything — the same shape as projects.start_readiness, and
-- for the same reason: "not ready" tells nobody what to do next.

create or replace function projects.production_readiness(p_project_id uuid)
returns table (
  no_open_blockers boolean,
  no_open_majors   boolean,
  build_approved   boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    not exists (
      select 1 from qa.defects d
       where d.project_id = p_project_id
         and d.status = 'open'
         and d.severity = 'blocker'
    ),
    not exists (
      select 1 from qa.defects d
       where d.project_id = p_project_id
         and d.status = 'open'
         and d.severity = 'major'
    ),
    exists (
      select 1 from projects.deliverables dl
       where dl.project_id = p_project_id
         and dl.kind = 'build'
         and dl.status = 'approved'
    );
$$;

comment on function projects.production_readiness(uuid) is
  'The two conditions ADM-19 sets, as three answers a screen can show: no open blockers, no open majors, and a client-approved build. Reads qa.defects and projects.deliverables directly rather than a cached flag, because a cached readiness is a copy that disagrees with the defect somebody raised a minute ago.';

-- ── marking it ────────────────────────────────────────────────────────────

create or replace function projects.mark_production_ready(p_project_id uuid)
returns table (
  -- 'ready' | 'already_ready' | 'not_found' | 'not_ready'
  outcome text,
  unmet   text[]
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_ready_at timestamptz;
  v_state    record;
  v_unmet    text[] := '{}';
begin
  select p.production_ready_at into v_ready_at
    from projects.projects p
   where p.id = p_project_id
     for update;

  if not found then
    return query select 'not_found'::text, '{}'::text[];
    return;
  end if;

  -- Marking a marked project is the answer, not an error, and it must not move
  -- the date: the moment it became ready is the moment it first did.
  if v_ready_at is not null then
    return query select 'already_ready'::text, '{}'::text[];
    return;
  end if;

  select * into v_state from projects.production_readiness(p_project_id);

  if not v_state.no_open_blockers then
    v_unmet := v_unmet || 'open_blockers'::text;
  end if;
  if not v_state.no_open_majors then
    v_unmet := v_unmet || 'open_majors'::text;
  end if;
  if not v_state.build_approved then
    v_unmet := v_unmet || 'no_approved_build'::text;
  end if;

  -- No override. ADM-19 gave two conditions and did not offer a way past them,
  -- and unlike a project start — which the owner may force because a client is
  -- waiting — nothing downstream is blocked by a project that is not yet
  -- production ready. Adding an escape hatch nobody asked for would be
  -- inventing policy.
  if array_length(v_unmet, 1) is not null then
    return query select 'not_ready'::text, v_unmet;
    return;
  end if;

  update projects.projects
     set production_ready_at = now(),
         updated_at          = now()
   where id = p_project_id;

  -- The audit row is written by the G-093 trigger, from inside this
  -- transaction, and records the whole row.

  return query select 'ready'::text, '{}'::text[];
end;
$$;

comment on function projects.mark_production_ready(uuid) is
  'Marks a project production ready under ADM-19: zero open blockers, zero open majors, a client-approved build. Refuses otherwise, naming which of the three is in the way. No override, because ADM-19 offered none and nothing downstream waits on this - unlike a project start, where a client is waiting and the owner may force it. Decides under the project row lock; marking twice is answered and does not move the date.';

revoke all on function projects.mark_production_ready(uuid) from public, anon;
grant execute on function projects.mark_production_ready(uuid) to authenticated, service_role;
revoke all on function projects.production_readiness(uuid) from public, anon;
grant execute on function projects.production_readiness(uuid) to authenticated, service_role;
