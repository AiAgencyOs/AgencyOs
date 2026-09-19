-- ═══════════════════════════════════════════════════════════════════════════
-- The order is the control.
--
-- Master §16's first three lines, and PM §7's whole section, are one rule
-- stated twice:
--
--   FIGMA DESIGNER → INTERNAL REVIEW → ADMIN REVIEW → PM → CLIENT
--
--   *"Internal review happens before Admin review. Admin approval happens
--   before client receives an option. Admin EDIT always returns to Designer
--   and then internal review before Admin again."*
--
-- PM §7 adds the sentence that makes it non-negotiable: *"PM is not allowed to
-- collapse or skip gates merely to speed up communication."*
--
-- This is the most load-bearing rule in Phase 3, and everything about it is a
-- refusal rather than an instruction. An order enforced by asking people to
-- follow it is an order that gets skipped the first time somebody is in a
-- hurry.
--
-- ── two gates, two tables, and why not one ──────────────────────────────
--
-- Master §19 lists `DesignReview` and `AdminDesignDecision` separately, and
-- they are genuinely different things:
--
--   internal review answers PASS / CHANGES_REQUIRED, and is about quality —
--     §7.7's requirement alignment, consistency, hierarchy, usability;
--   Admin review answers CONFIRM / EDIT, and is about authority — §21's
--     *"only authorized Admin can perform Admin approval/edit decisions."*
--
-- Folding them into one table with a `gate` column would make *"who approved
-- this"* ambiguous, which is the one question §8 says the Admin Panel must
-- always be able to answer. Recorded as D-4 in the traceability matrix.
--
-- ── who may run each gate, and a capability that already exists ─────────
--
-- **The internal reviewer is the assigned person, and only them.** Master §4
-- names *"Internal Design Reviewer"* as an actor, and G-277 put
-- `phase_three.reviewer_user_id` on the workspace precisely so an unassigned
-- gate would be visible rather than defaulted. That column is now
-- load-bearing: a review by anybody else is refused as `not_the_reviewer`,
-- and a project with no reviewer answers `no_reviewer_assigned` rather than
-- letting the first person through.
--
-- **The Admin gate is `core.is_admin()`** — owner or ops_admin, which is
-- exactly what the capability list calls `project.sign_off`. That capability
-- exists for a reason written down in its own comment:
--
--   *"`project.write` would have been the obvious reuse and is wrong by one
--   role: it includes delivery_lead, and a delivery lead declaring their own
--   work production ready is the review signing its own homework."*
--
-- The same sentence is true here, and it is the gate separation §16 is asking
-- for: the delivery lead who can run an internal design review must not also
-- be the authority who approves it. The capability was written for this shape
-- before this phase existed, so it is reused rather than reinvented.
--
-- ── the rule that makes the order real ──────────────────────────────────
--
-- `submit_admin_design_decision` refuses an option whose internal review has
-- not passed. Not a warning, not a flag: `not_internally_passed`, and nothing
-- happens. That single refusal is what stops §16's order being advice.
--
-- And **Admin EDIT sends it all the way back.** §16: *"Admin EDIT always
-- returns to Designer and then internal review before Admin again."* PM §8
-- repeats it: *"never skip internal re-review."* So an edit does not merely
-- mark the Admin gate — it also returns the internal gate to
-- `changes_required`, because an option that has been revised has not been
-- reviewed.
--
-- ── what is deliberately NOT here ───────────────────────────────────────
--
-- **The client share gate.** §7.9 and PM §4.4 say only Admin-approved options
-- reach a client, and that refusal belongs to the door that does the sharing,
-- which is the next unit. It is named here so its absence reads as a sequence
-- rather than an omission — and `theme_options.client_status` already cannot
-- reach `locked` without `admin_status = 'approved'` (G-279), so the end of
-- the chain is guarded even before its middle is built.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Master §19's DesignReview ───────────────────────────────────────────

create table if not exists projects.design_reviews (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  theme_option_id  uuid not null references projects.theme_options(id) on delete cascade,

  -- §14 of the Designer specification: "reviewer receives exact
  -- artifact/version." A review of "the theme" is a review of whatever the
  -- theme happens to be when somebody reads the row later.
  option_version   int not null check (option_version > 0),

  -- §7.7's two answers, and no third. There is no 'approved' here: approving
  -- is the Admin's word and this gate does not hold that authority.
  result           text not null check (result in ('passed', 'changes_required')),

  -- A person. Master §4 lists the reviewer as a human actor, and there is no
  -- agent form of this column — the same absence that makes ADM-82's
  -- producer-is-not-verifier rule structural elsewhere in this database.
  reviewer_user_id uuid not null references core.users(id) on delete restrict,

  comments         text,

  created_at       timestamptz not null default now(),

  -- §7.7: "failed direction returns to Figma Designer for correction." A
  -- correction nobody described is a correction nobody can make.
  constraint design_reviews_changes_say_what
    check (result <> 'changes_required'
           or (comments is not null and length(btrim(comments)) > 0))
);

create index if not exists design_reviews_option_idx
  on projects.design_reviews (organization_id, theme_option_id, created_at desc);

comment on table projects.design_reviews is
  'Master section 7.7 and Designer section 14 - the internal quality gate, which runs BEFORE Admin review. Two results and no third: there is no approved here, because approving is the Admin word and this gate does not hold that authority. The reviewer is a PERSON and there is no agent form of the column. Append-only in practice: a re-review is a new row, so section 8s decision trail survives.';

-- ── Master §19's AdminDesignDecision ────────────────────────────────────

create table if not exists projects.admin_design_decisions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  theme_option_id  uuid not null references projects.theme_options(id) on delete cascade,

  option_version   int not null check (option_version > 0),

  -- §7.8's two actions. EDIT is not a rejection: the option comes back.
  decision         text not null check (decision in ('confirm', 'edit')),

  -- §7.8: "if EDIT: structured reason." An edit with no reason is a round trip
  -- the designer cannot act on.
  reason           text,

  decided_by       uuid not null references core.users(id) on delete restrict,
  created_at       timestamptz not null default now(),

  -- The internal review this decision was taken on top of. Not decorative:
  -- §16 requires Admin to see the review evidence, and a decision that cannot
  -- name the review it followed is a decision somebody has to reconstruct.
  design_review_id uuid references projects.design_reviews(id) on delete set null,

  constraint admin_design_decisions_edit_says_why
    check (decision <> 'edit'
           or (reason is not null and length(btrim(reason)) > 0))
);

create index if not exists admin_design_decisions_option_idx
  on projects.admin_design_decisions (organization_id, theme_option_id, created_at desc);

comment on table projects.admin_design_decisions is
  'Master section 7.8 - the authority gate, which runs only after internal review has PASSED. EDIT is not a rejection: the option returns to the designer and then to internal review before Admin sees it again (section 16, PM section 8). It names the design review it followed, because a decision that cannot say what evidence it was taken on is a decision somebody has to reconstruct.';

-- ── tenancy and RLS ─────────────────────────────────────────────────────

drop trigger if exists org_match_design_reviews_option on projects.design_reviews;
create trigger org_match_design_reviews_option
  before insert or update of theme_option_id, organization_id on projects.design_reviews
  for each row execute function core.enforce_parent_org('theme_option_id', 'projects.theme_options');

drop trigger if exists freeze_org_design_reviews on projects.design_reviews;
create trigger freeze_org_design_reviews
  before update of organization_id on projects.design_reviews
  for each row execute function core.freeze_organization_id();

drop trigger if exists org_match_admin_decisions_option on projects.admin_design_decisions;
create trigger org_match_admin_decisions_option
  before insert or update of theme_option_id, organization_id on projects.admin_design_decisions
  for each row execute function core.enforce_parent_org('theme_option_id', 'projects.theme_options');

drop trigger if exists org_match_admin_decisions_review on projects.admin_design_decisions;
create trigger org_match_admin_decisions_review
  before insert or update of design_review_id, organization_id on projects.admin_design_decisions
  for each row execute function core.enforce_parent_org('design_review_id', 'projects.design_reviews');

drop trigger if exists freeze_org_admin_decisions on projects.admin_design_decisions;
create trigger freeze_org_admin_decisions
  before update of organization_id on projects.admin_design_decisions
  for each row execute function core.freeze_organization_id();

alter table projects.design_reviews enable row level security;
alter table projects.design_reviews force row level security;
alter table projects.admin_design_decisions enable row level security;
alter table projects.admin_design_decisions force row level security;

drop policy if exists design_reviews_select on projects.design_reviews;
create policy design_reviews_select on projects.design_reviews
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop policy if exists admin_design_decisions_select on projects.admin_design_decisions;
create policy admin_design_decisions_select on projects.admin_design_decisions
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

grant select on projects.design_reviews to authenticated, service_role;
grant select on projects.admin_design_decisions to authenticated, service_role;

-- ── the events Master §15 names ─────────────────────────────────────────

insert into core.event_types (type, description, canonical) values
  ('project.internal_design_passed',
   'Master section 15 InternalDesignPassed - a theme option cleared the internal quality gate and may now go to Admin. Nothing reaches a client on this event.',
   true),
  ('project.internal_design_changes_required',
   'Master section 15 InternalDesignChangesRequired - the internal reviewer returned a theme option to the designer with structured comments.',
   true),
  ('project.admin_design_approved',
   'Master section 15 AdminDesignApproved - the authority gate passed. This is the ONLY state from which an option may be shared with a client.',
   true),
  ('project.admin_design_edit_requested',
   'Master section 15 AdminDesignEditRequested - Admin asked for a change. The option returns to the designer and then to internal review before Admin sees it again.',
   true)
on conflict (type) do nothing;

-- ── gate one: internal review ───────────────────────────────────────────

create or replace function projects.submit_internal_design_review(
  p_theme_option_id uuid,
  p_result          text,
  p_comments        text default null
)
returns table (
  -- 'recorded' | 'unknown_option' | 'no_reviewer_assigned' | 'not_the_reviewer'
  -- | 'needs_comments' | 'bad_result' | 'already_approved' | 'no_actor'
  outcome   text,
  review_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_theme  projects.theme_options;
  v_phase3 projects.phase_three;
  v_new    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  -- Refused on the ARGUMENT, before the row is read: a result nobody defined
  -- is a mistake about the vocabulary, not about this option.
  if p_result not in ('passed', 'changes_required') then
    return query select 'bad_result'::text, null::uuid; return;
  end if;

  if p_result = 'changes_required'
     and (p_comments is null or length(btrim(p_comments)) = 0) then
    return query select 'needs_comments'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t where t.id = p_theme_option_id for update;
  if v_theme.id is null then
    return query select 'unknown_option'::text, null::uuid; return;
  end if;

  if v_theme.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.can_write()), false) then
    return query select 'not_the_reviewer'::text, null::uuid; return;
  end if;

  select p3.* into v_phase3 from projects.phase_three p3 where p3.id = v_theme.phase_three_id;

  -- Master §4: the Internal Design Reviewer is a named actor. G-277 left the
  -- column nullable precisely so an unassigned gate would be VISIBLE; this is
  -- where that becomes load-bearing rather than decorative.
  if v_phase3.reviewer_user_id is null then
    return query select 'no_reviewer_assigned'::text, null::uuid; return;
  end if;

  -- Designer §5: "must not bypass Internal Design Reviewer." The assigned
  -- reviewer, and only them — a capability check would let any delivery lead
  -- stand in for the person §4 names.
  if v_phase3.reviewer_user_id is distinct from v_actor then
    return query select 'not_the_reviewer'::text, null::uuid; return;
  end if;

  -- An option Admin has already approved is settled at this gate. Reviewing it
  -- again would silently un-approve it, and §16 says a settled decision is not
  -- overwritten — a change creates a new version.
  if v_theme.admin_status = 'approved' then
    return query select 'already_approved'::text, null::uuid; return;
  end if;

  insert into projects.design_reviews
    (organization_id, theme_option_id, option_version, result, reviewer_user_id, comments)
  values
    (v_theme.organization_id, v_theme.id, v_theme.version, p_result, v_actor,
     nullif(btrim(coalesce(p_comments, '')), ''))
  returning id into v_new;

  update projects.theme_options
     set internal_review_status = case when p_result = 'passed' then 'passed' else 'changes_required' end,
         -- A passed option is waiting on Admin; a returned one is waiting on
         -- the designer. Neither is a client state, and this door never
         -- touches `client_status`.
         admin_status = case when p_result = 'passed' then 'in_review' else 'not_submitted' end
   where id = v_theme.id;

  -- §14 of the Master flow: the phase follows the artifact.
  update projects.phase_three
     set state = case when p_result = 'passed' then 'admin_review' else 'waiting_designer' end
   where id = v_phase3.id
     and state in ('theme_generation', 'internal_review', 'admin_review', 'waiting_designer');

  perform core.record_audit(
    v_theme.organization_id,
    case when p_result = 'passed' then 'project.internal_design_passed'
         else 'project.internal_design_changes_required' end,
    'theme_option', v_theme.id, null,
    jsonb_build_object('reviewId', v_new, 'result', p_result, 'optionVersion', v_theme.version)
  );

  perform core.emit_event(
    v_theme.organization_id,
    case when p_result = 'passed' then 'project.internal_design_passed'
         else 'project.internal_design_changes_required' end,
    'theme_option', v_theme.id,
    jsonb_build_object('reviewId', v_new, 'result', p_result, 'projectId', v_theme.project_id)
  );

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function projects.submit_internal_design_review(uuid, text, text) is
  'Master section 7.7 - gate one. Only the ASSIGNED reviewer may run it: Master section 4 names the Internal Design Reviewer as an actor and a capability check would let any delivery lead stand in for that person. A project with no reviewer answers no_reviewer_assigned rather than letting the first caller through. Two results and no third - approving is the Admin word. A changes_required with no comments is refused, because a correction nobody described is a correction nobody can make. This door never touches client_status.';

-- ── gate two: the Admin ─────────────────────────────────────────────────

create or replace function projects.submit_admin_design_decision(
  p_theme_option_id uuid,
  p_decision        text,
  p_reason          text default null
)
returns table (
  -- 'recorded' | 'unknown_option' | 'not_internally_passed' | 'needs_reason'
  -- | 'bad_decision' | 'not_admin' | 'no_actor'
  outcome     text,
  decision_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_theme  projects.theme_options;
  v_review projects.design_reviews;
  v_new    uuid;
begin
  if v_actor is null then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  if p_decision not in ('confirm', 'edit') then
    return query select 'bad_decision'::text, null::uuid; return;
  end if;

  if p_decision = 'edit' and (p_reason is null or length(btrim(p_reason)) = 0) then
    return query select 'needs_reason'::text, null::uuid; return;
  end if;

  select t.* into v_theme from projects.theme_options t where t.id = p_theme_option_id for update;
  if v_theme.id is null then
    return query select 'unknown_option'::text, null::uuid; return;
  end if;

  -- Master §21: "only authorized Admin can perform Admin approval/edit
  -- decisions." core.is_admin() is owner or ops_admin, which is exactly the
  -- role set `project.sign_off` was created for — and its comment says why
  -- delivery_lead is excluded: the review must not sign its own homework.
  if v_theme.organization_id is distinct from (select core.current_organization_id())
     -- `coalesce`, and it matters: core.current_user_role() reads the role
     -- from the token, so a token without one makes is_admin() NULL — and
     -- `not NULL` is NULL, which an `if` does not execute. The guard would
     -- fail OPEN. The auth hook writes organization_id and role together or
     -- not at all, so the org check above catches that case today; this does
     -- not depend on a distant invariant staying true. Raised for the other
     -- 52 call sites as G-281.
     or not coalesce((select core.is_admin()), false) then
    return query select 'not_admin'::text, null::uuid; return;
  end if;

  -- ── THE RULE THAT MAKES THE ORDER REAL ─────────────────────────────────
  --
  -- §16: "internal review happens before Admin review." Not a warning and not
  -- a flag. Without this single refusal the order is advice.
  if v_theme.internal_review_status <> 'passed' then
    return query select 'not_internally_passed'::text, null::uuid; return;
  end if;

  -- The review this decision is taken on top of — §16 requires Admin to see
  -- the review evidence, so the decision records which one it saw.
  select r.* into v_review
    from projects.design_reviews r
   where r.theme_option_id = v_theme.id
     and r.result = 'passed'
   order by r.created_at desc
   limit 1;

  insert into projects.admin_design_decisions
    (organization_id, theme_option_id, option_version, decision, reason, decided_by, design_review_id)
  values
    (v_theme.organization_id, v_theme.id, v_theme.version, p_decision,
     nullif(btrim(coalesce(p_reason, '')), ''), v_actor, v_review.id)
  returning id into v_new;

  if p_decision = 'confirm' then
    update projects.theme_options set admin_status = 'approved' where id = v_theme.id;
  else
    -- §16: "Admin EDIT always returns to Designer and then internal review
    -- before Admin again." PM §8: "never skip internal re-review." So the
    -- internal gate is returned too — an option that has been revised has not
    -- been reviewed, and leaving it `passed` would let the next Admin call
    -- straight through.
    update projects.theme_options
       set admin_status = 'edit_requested',
           internal_review_status = 'changes_required'
     where id = v_theme.id;
  end if;

  update projects.phase_three
     set state = case when p_decision = 'confirm' then 'client_review' else 'waiting_designer' end
   where id = v_theme.phase_three_id
     -- `client_review` is in the list deliberately: an Admin who approves and
     -- then changes their mind BEFORE the client has been shown anything is
     -- not overwriting a final selection — §16's rule is about the client's
     -- choice, and the client has not made one. Found by driving it: without
     -- this the phase stayed at client_review while the option had gone back
     -- to the designer, which is a screen telling somebody the wrong thing.
     and state in ('admin_review', 'theme_generation', 'internal_review',
                   'waiting_designer', 'client_review');

  perform core.record_audit(
    v_theme.organization_id,
    case when p_decision = 'confirm' then 'project.admin_design_approved'
         else 'project.admin_design_edit_requested' end,
    'theme_option', v_theme.id, null,
    jsonb_build_object('decisionId', v_new, 'decision', p_decision, 'reviewId', v_review.id)
  );

  perform core.emit_event(
    v_theme.organization_id,
    case when p_decision = 'confirm' then 'project.admin_design_approved'
         else 'project.admin_design_edit_requested' end,
    'theme_option', v_theme.id,
    jsonb_build_object('decisionId', v_new, 'decision', p_decision, 'projectId', v_theme.project_id)
  );

  return query select 'recorded'::text, v_new;
end;
$$;

comment on function projects.submit_admin_design_decision(uuid, text, text) is
  'Master section 7.8 - gate two, and the refusal that makes section 16s order real: an option whose internal review has not PASSED is answered not_internally_passed and nothing happens. Admin is core.is_admin() - owner or ops_admin, exactly the role set project.sign_off was created for, whose own comment explains why delivery_lead is excluded. EDIT is not a rejection: it returns the option to the designer AND returns the internal gate to changes_required, because an option that has been revised has not been reviewed and leaving it passed would let the next Admin call straight through.';

-- ── assigning the reviewer, because the gate needs an owner ─────────────

create or replace function projects.assign_design_reviewer(
  p_project_id uuid,
  p_user_id    uuid
)
returns table (
  -- 'assigned' | 'unchanged' | 'no_phase_three' | 'unknown_user' | 'not_admin' | 'no_actor'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor  uuid := (select auth.uid());
  v_phase3 projects.phase_three;
begin
  if v_actor is null then
    return query select 'no_actor'::text; return;
  end if;

  select p3.* into v_phase3 from projects.phase_three p3 where p3.project_id = p_project_id for update;
  if v_phase3.id is null then
    return query select 'no_phase_three'::text; return;
  end if;

  -- Who reviews is an authority decision, not routine design work: naming the
  -- reviewer is choosing who holds a gate.
  if v_phase3.organization_id is distinct from (select core.current_organization_id())
     or not coalesce((select core.is_admin()), false) then
    return query select 'not_admin'::text; return;
  end if;

  if not exists (
    select 1 from core.memberships m
     where m.user_id = p_user_id
       and m.organization_id = v_phase3.organization_id
  ) then
    -- Somebody outside the agency cannot hold an internal gate.
    return query select 'unknown_user'::text; return;
  end if;

  if v_phase3.reviewer_user_id is not distinct from p_user_id then
    return query select 'unchanged'::text; return;
  end if;

  update projects.phase_three set reviewer_user_id = p_user_id where id = v_phase3.id;

  perform core.record_audit(
    v_phase3.organization_id, 'phase_three.reviewer_assigned', 'phase_three', v_phase3.id,
    jsonb_build_object('reviewerUserId', v_phase3.reviewer_user_id),
    jsonb_build_object('reviewerUserId', p_user_id)
  );

  return query select 'assigned'::text;
end;
$$;

comment on function projects.assign_design_reviewer(uuid, uuid) is
  'Master section 4. Naming the Internal Design Reviewer is choosing who holds a gate, so it takes core.is_admin() rather than ordinary write access. The user must be a member of the same organization: somebody outside the agency cannot hold an internal gate. The audit carries the previous reviewer as well as the new one, so a reassignment is visible rather than silent.';

revoke all on function projects.submit_internal_design_review(uuid, text, text) from public, anon;
revoke all on function projects.submit_admin_design_decision(uuid, text, text) from public, anon;
revoke all on function projects.assign_design_reviewer(uuid, uuid) from public, anon;
grant execute on function projects.submit_internal_design_review(uuid, text, text) to authenticated;
grant execute on function projects.submit_admin_design_decision(uuid, text, text) to authenticated;
grant execute on function projects.assign_design_reviewer(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
