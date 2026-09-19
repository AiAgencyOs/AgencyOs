-- ═══════════════════════════════════════════════════════════════════════════
-- A default is not a decision.
--
-- Designer §4 names the internal design reviewer as an actor, and G-280 made
-- the gate refuse until a specific person holds it — a capability check would
-- let any delivery lead stand in, and the point of the gate is that somebody
-- named looked.
--
-- That is right, and it has a cost: **on a fresh project nobody holds it**, so
-- nothing reaches Admin review until an Admin remembers to appoint a reviewer.
-- For an agency where it is always the same person, that is a dead stop with
-- no information in it.
--
-- So an organisation may name a default. What that default is **not** is a
-- rule.
--
-- ── the line this whole migration is about ────────────────────────────
--
-- A default **seeds**; it does not **govern**.
--
--   It is copied onto a Phase 3 **when the phase starts**, once.
--
--   Changing it later does **not** reach into phases that already have a
--   reviewer. If it did, one edit in Settings would silently move a gate on
--   every live project at once — including the ones where somebody
--   deliberately appointed a different person, whose decision would be
--   overwritten by a preference.
--
--   Setting it **does** seed phases where `reviewer_user_id is null`, because
--   nobody has decided there and a null is not a choice. The door reports how
--   many it seeded, so that is a visible act rather than action at a distance.
--
-- ── who may hold it ───────────────────────────────────────────────────
--
-- The person must be on this organisation's roster, refused at the row.
-- `core.users` has no `organization_id` — membership is the org-scoped fact —
-- so `core.enforce_parent_org` cannot express this and a trigger reads
-- `core.memberships` instead. Without it an Admin could name somebody from
-- another tenant and the gate would wait forever on a person who cannot see
-- the project.
--
-- ── and one repair carried in passing ─────────────────────────────────
--
-- `start_phase_three` is replaced here to copy the default, and its authority
-- guard read `not (select core.can_write())` — G-281's defect: a token with an
-- organisation but no role makes that NULL, `not NULL` is NULL, and plpgsql's
-- `if` does not execute it, so the guard **fails open**. It is not exploitable
-- today because the auth hook writes organisation and role together or
-- neither, but rewriting a function and leaving a known fail-open inside it
-- would be worse than the scope creep of fixing it. Coalesced here; the other
-- call sites remain G-281.
-- ═══════════════════════════════════════════════════════════════════════════

alter table core.organizations
  add column if not exists default_design_reviewer_id uuid
    references core.users(id) on delete set null;

comment on column core.organizations.default_design_reviewer_id is
  'Designer section 4. The person a new Phase 3 starts with as internal design reviewer. A DEFAULT SEEDS AND DOES NOT GOVERN: it is copied when the phase starts, and changing it later does not reach into phases that already have a reviewer - one edit would otherwise move a gate on every live project, overwriting decisions somebody made deliberately.';

-- The roster rule, in a trigger because `core.users` has no organization_id
-- and `core.enforce_parent_org` has nothing to compare.
create or replace function core.enforce_default_reviewer_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.default_design_reviewer_id is null then
    return new;
  end if;

  if not exists (
    select 1 from core.memberships m
     where m.user_id = new.default_design_reviewer_id
       and m.organization_id = new.id
  ) then
    raise exception
      'tenancy: the default design reviewer must be on this organisation''s roster'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger enforce_default_reviewer_membership
  before insert or update of default_design_reviewer_id on core.organizations
  for each row execute function core.enforce_default_reviewer_membership();

-- ── the door ────────────────────────────────────────────────────────────

create or replace function core.set_default_design_reviewer(
  p_user_id uuid
)
returns table (
  -- 'set' | 'cleared' | 'unchanged'
  -- refusals: 'no_actor' | 'not_admin' | 'not_a_member'
  outcome text,
  -- How many Phase 3 workspaces this seeded. Reported rather than silent,
  -- because seeding is a write to rows the caller was not looking at.
  seeded  int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_org   uuid := (select core.current_organization_id());
  v_prev  uuid;
  v_count int := 0;
begin
  if v_actor is null or v_org is null then
    return query select 'no_actor'::text, 0; return;
  end if;

  -- Appointing who holds a gate is an Admin act, the same as G-280's
  -- assign_design_reviewer. G-281: `not NULL` is NULL and an `if` does not
  -- execute it, so the guard is coalesced.
  if not coalesce((select core.is_admin()), false) then
    return query select 'not_admin'::text, 0; return;
  end if;

  if p_user_id is not null and not exists (
    select 1 from core.memberships m
     where m.user_id = p_user_id and m.organization_id = v_org
  ) then
    return query select 'not_a_member'::text, 0; return;
  end if;

  select o.default_design_reviewer_id into v_prev
    from core.organizations o where o.id = v_org for update;

  if v_prev is not distinct from p_user_id then
    return query select 'unchanged'::text, 0; return;
  end if;

  update core.organizations
     set default_design_reviewer_id = p_user_id
   where id = v_org;

  -- Seeded only where nobody has decided. A null reviewer is an absence, not
  -- a choice — and a phase that already names somebody keeps them, because a
  -- preference must not overwrite a decision.
  if p_user_id is not null then
    with seeded as (
      update projects.phase_three p3
         set reviewer_user_id = p_user_id
       where p3.organization_id = v_org
         and p3.reviewer_user_id is null
         and p3.state not in ('completed', 'blocked_requirement')
      returning 1
    )
    select count(*)::int into v_count from seeded;
  end if;

  perform core.record_audit(
    v_org, 'organization.default_design_reviewer_set', 'organization', v_org, null,
    jsonb_build_object('userId', p_user_id, 'seeded', v_count)
  );

  return query select case when p_user_id is null then 'cleared' else 'set' end, v_count;
end;
$$;

comment on function core.set_default_design_reviewer(uuid) is
  'Designer section 4. Names the person a new Phase 3 starts with. SEEDS PHASES WHERE NOBODY HAS DECIDED - reviewer_user_id is null - and reports how many, because seeding writes rows the caller was not looking at. It does NOT touch a phase that already names somebody: a preference must not overwrite a decision. Passing null clears the default and seeds nothing.';

revoke all on function core.set_default_design_reviewer(uuid) from public, anon;
grant execute on function core.set_default_design_reviewer(uuid) to authenticated;

-- ── the phase starts with it ────────────────────────────────────────────

create or replace function projects.start_phase_three(p_project_id uuid)
returns table (
  -- 'started' | 'already_started' | 'phase_two_incomplete' | 'no_phase_two'
  -- | 'unknown_project' | 'no_actor' | 'forbidden'
  outcome        text,
  phase_three_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor     uuid := (select auth.uid());
  v_project   projects.projects;
  v_phase_two projects.phase_two;
  v_existing  projects.phase_three;
  v_reviewer  uuid;
  v_new       uuid;
begin
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select p.* into v_project from projects.projects p where p.id = p_project_id for update;
  if v_project.id is null or v_project.deleted_at is not null then
    return query select 'unknown_project'::text, null::uuid; return;
  end if;

  -- G-281, fixed in passing: `not NULL` is NULL and an `if` does not execute
  -- it, so an uncoalesced guard fails OPEN for a role-less token.
  if v_actor is not null
     and (v_project.organization_id is distinct from (select core.current_organization_id())
          or not coalesce((select core.can_write()), false)) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  select p3.* into v_existing from projects.phase_three p3 where p3.project_id = v_project.id;
  if v_existing.id is not null then
    return query select 'already_started'::text, v_existing.id; return;
  end if;

  select pt.* into v_phase_two
    from projects.phase_two pt
   where pt.project_id = v_project.id;

  if v_phase_two.id is null then
    return query select 'no_phase_two'::text, null::uuid; return;
  end if;

  if v_phase_two.state <> 'completed' then
    return query select 'phase_two_incomplete'::text, null::uuid; return;
  end if;

  -- The default, read at the moment the phase starts. Read once and copied:
  -- a phase that looked the value up live would change reviewer whenever
  -- Settings changed, which is the governing behaviour this design refuses.
  --
  -- Re-checked against the roster here as well as at the setting, because a
  -- reviewer who has since left the organisation must not be copied onto a new
  -- phase — the membership can disappear after the default was named.
  select o.default_design_reviewer_id into v_reviewer
    from core.organizations o
   where o.id = v_project.organization_id
     and exists (
       select 1 from core.memberships m
        where m.user_id = o.default_design_reviewer_id
          and m.organization_id = o.id
     );

  insert into projects.phase_three (organization_id, project_id, phase_two_id, state, reviewer_user_id)
  values (v_project.organization_id, v_project.id, v_phase_two.id, 'context_loading', v_reviewer)
  returning id into v_new;

  perform core.record_audit(
    v_project.organization_id, 'phase_three.started', 'phase_three', v_new, null,
    jsonb_build_object('projectId', v_project.id, 'phaseTwoId', v_phase_two.id,
                       'reviewerUserId', v_reviewer)
  );

  perform core.emit_event(
    v_project.organization_id, 'project.phase_three_started',
    'phase_three', v_new,
    jsonb_build_object('projectId', v_project.id)
  );

  return query select 'started'::text, v_new;
end;
$$;

comment on function projects.start_phase_three(uuid) is
  'Master sections 3 and 22. One Phase 3 per project, and a replay gets already_started with the existing id rather than a constraint violation. Phase 2 must actually be complete, read from the row rather than from the event that woke it. STARTS WITH THE ORGANISATION''S DEFAULT REVIEWER when one is named and still on the roster - copied once, never looked up live, because a phase that read it live would change reviewer whenever Settings changed. Its authority guard is coalesced against a NULL role (G-281).';

revoke all on function projects.start_phase_three(uuid) from public, anon;
grant execute on function projects.start_phase_three(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
