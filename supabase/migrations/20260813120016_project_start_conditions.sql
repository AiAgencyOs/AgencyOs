-- G-026 — a project starts when it is actually ready.
--
-- ADM-13. A project becomes officially started when three things are true:
--
--   1. the **advance payment is verified** — not recorded, verified (G-007)
--   2. at least one **requirement version is approved**
--   3. the project's **WhatsApp group exists** (G-015)
--
-- The owner may start one anyway, and the reason is recorded.
--
-- ── this is not a new state machine ───────────────────────────────────────
--
-- `onboarding → active` has been the transition since the first delivery
-- migration, and its own comment already said what onboarding was for:
--
--   'planning → onboarding → active → completed. onboarding covers kickoff,
--    group setup, and advance payment, before delivery starts.'
--
-- So the conditions were written down on day one and enforced by nobody. A
-- project became active because somebody chose 'active' in a dropdown. This
-- migration makes the sentence true.
--
-- ── why each condition is checked where it is ─────────────────────────────
--
-- All three are `exists` against the tables that own the facts, evaluated
-- under the project's row lock. None of them is cached on the project, and
-- deliberately: a cached "advance_paid" flag is a second copy of a fact the
-- finance tables already hold, and the first thing it does is disagree with
-- them. The cost is three index lookups on a transition that happens once per
-- project.
--
-- The advance test is "any milestone on this project has a paid invoice". Since
-- G-007 `paid` means *confirmed* money, so this reads as ADM-13 wrote it —
-- a client's claim is not enough to start their project.

alter table projects.projects
  add column if not exists started_at timestamptz,
  add column if not exists start_override_reason text;

comment on column projects.projects.started_at is
  'When the project officially started (ADM-13). Null until the onboarding to active transition is taken.';

comment on column projects.projects.start_override_reason is
  'Why the owner started this project without meeting the conditions. Null when it started normally. Recorded rather than optional: an override nobody has to explain is not an exception, it is the rule.';

-- ── what is still missing ─────────────────────────────────────────────────
--
-- A function of its own so the caller can *show* somebody the list rather than
-- reporting "not ready". Three separate sentences beat one refusal: "the
-- advance is not confirmed" and "nobody has approved a requirement" are
-- different problems for different people.

create or replace function projects.start_readiness(p_project_id uuid)
returns table (
  advance_verified     boolean,
  requirement_approved boolean,
  group_linked         boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    exists (
      select 1
        from projects.milestones m
        join finance.invoices i on i.milestone_id = m.id
       where m.project_id = p_project_id
         and i.status = 'paid'
    ),
    exists (
      select 1
        from projects.projects pr
        join sales.opportunities o on o.id = pr.opportunity_id
        join crm.conversations c on c.lead_id = o.lead_id
        join crm.requirement_versions rv on rv.conversation_id = c.id
       where pr.id = p_project_id
         and rv.status = 'accepted'
    ),
    exists (
      select 1
        from crm.conversations c
       where c.project_id = p_project_id
         and c.kind = 'project_group'
         and c.status <> 'abandoned'
    );
$$;

comment on function projects.start_readiness(uuid) is
  'The three conditions ADM-13 sets for a project officially starting, each read from the table that owns the fact rather than from a flag on the project - a cached copy of a fact finance already holds is a copy that will disagree with it. Stable and side-effect free, so a screen can show what is still missing before anybody presses anything.';

-- ── starting one ──────────────────────────────────────────────────────────

create or replace function projects.start_project(
  p_project_id      uuid,
  p_override_reason text default null
)
returns table (
  -- 'started' | 'already_active' | 'not_found' | 'not_startable' | 'not_ready'
  outcome         text,
  project_status  text,
  -- Which conditions are unmet. Empty when it started; populated when it did
  -- not, so the caller names them rather than saying "not ready".
  unmet           text[],
  overridden      boolean
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_ready  record;
  v_unmet  text[] := '{}';
begin
  select p.status into v_status
    from projects.projects p
   where p.id = p_project_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text, '{}'::text[], false;
    return;
  end if;

  -- Starting a started project is the answer, not an error: two people pressing
  -- the same button should get the same picture.
  if v_status = 'active' then
    return query select 'already_active'::text, v_status, '{}'::text[], false;
    return;
  end if;

  -- PROJECT_TRANSITIONS admits active from onboarding and from on_hold. Only
  -- the first is *starting*; resuming a paused project is a different act and
  -- is left to setProjectStatus, which is where it already lives.
  if v_status <> 'onboarding' then
    return query select 'not_startable'::text, v_status, '{}'::text[], false;
    return;
  end if;

  select * into v_ready from projects.start_readiness(p_project_id);

  if not v_ready.advance_verified then
    v_unmet := v_unmet || 'advance_not_verified'::text;
  end if;
  if not v_ready.requirement_approved then
    v_unmet := v_unmet || 'no_approved_requirement'::text;
  end if;
  if not v_ready.group_linked then
    v_unmet := v_unmet || 'no_whatsapp_group'::text;
  end if;

  -- An override with no reason is not an override. The caller's capability
  -- check decides *who* may do it; this decides that they said why.
  if array_length(v_unmet, 1) is not null
     and (p_override_reason is null or length(trim(p_override_reason)) = 0)
  then
    return query select 'not_ready'::text, v_status, v_unmet, false;
    return;
  end if;

  update projects.projects
     set status                = 'active',
         started_at            = now(),
         start_override_reason = case
                                   when array_length(v_unmet, 1) is not null
                                     then trim(p_override_reason)
                                   else null
                                 end,
         updated_at            = now()
   where id = p_project_id;

  -- No audit call here. Since G-093 the trigger on projects.projects writes
  -- the history from inside this transaction, and it records the whole row —
  -- so the override reason lands in the trail without anybody remembering to
  -- put it there.

  return query select 'started'::text, 'active'::text, v_unmet,
                      array_length(v_unmet, 1) is not null;
end;
$$;

comment on function projects.start_project(uuid, text) is
  'Takes the onboarding to active transition, which is what officially starting a project means (ADM-13, G-026). Refuses unless the advance is verified, a requirement is approved and the WhatsApp group is linked - naming which of the three is missing rather than saying not ready - and admits an override only with a reason, which the audit trigger then records. Decides under the project row lock, the shape D1, D2, D4 and D20 all were.';

revoke all on function projects.start_project(uuid, text) from public, anon;
grant execute on function projects.start_project(uuid, text) to authenticated, service_role;
revoke all on function projects.start_readiness(uuid) from public, anon;
grant execute on function projects.start_readiness(uuid) to authenticated, service_role;
