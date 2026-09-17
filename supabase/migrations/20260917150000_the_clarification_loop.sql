-- ═══════════════════════════════════════════════════════════════════════════
-- The clarification loop.
--
-- Project Planning §4.1, §5, §10, §14, §15, PLAN-I08, PLAN-I09; PM §4, §15.
--
-- ── the sentence this is built from ──────────────────────────────────────
--
-- §10, in two lines that are really one rule:
--
--   *"Planning Agent never guesses an unclear client requirement."*
--   *"If clarification implies a new/out-of-scope requirement, route to the
--    appropriate scope/change process instead of silently adding it."*
--
-- And §5's prohibition behind them: *"must not convert an ambiguous
-- requirement into an invented requirement."*
--
-- So a question has exactly two honest endings. Either the client answers it
-- and the plan is re-versioned around the answer, or the answer turns out to
-- be **new work**, and that is a change request — priced, approved, and
-- scoped by the process that already exists for it. There is no third ending
-- where an ambiguity quietly becomes a deliverable.
--
-- ── how "never guesses" is made structural ───────────────────────────────
--
-- A plan **cannot be activated while a question is unanswered**. G-256's
-- `activate_project_plan` is carried forward verbatim with two marked edits to
-- add that gate. That is the rule as a refusal rather than as a discipline:
-- PLAN-I09 says validate ambiguity before ProjectPlanReady, and a plan that
-- went live carrying an open question would have answered it by omission.
--
-- ── the change process is not re-invented ────────────────────────────────
--
-- `projects.change_requests` already exists, with a classification, an
-- approval, a proposal and a resulting scope version. Routing a clarification
-- there means REFERENCING one — a real FK — not copying its fields into a
-- second table that would drift from it. A clarification routed to a change
-- request that does not exist is unstorable.
--
-- ── the PM owns the client, still ────────────────────────────────────────
--
-- §10's chain is Planning → PM → client → PM → Planning. Nothing here
-- messages anybody: `mark_clarification_asked` records that a person put the
-- question to the client, and `record_clarification_answer` records what came
-- back. The Planning Agent never talks to the client, and the two doors that
-- touch the client's side of the loop refuse an unattended caller.
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.event_types (type, description, canonical) values
  ('project.clarification_required',
   'Project Planning section 10 ClarificationRequired - the plan has found an ambiguity it refuses to guess at. The PM asks the client. Nothing is sent by this event.',
   true),
  ('project.clarification_resolved',
   'Project Planning section 10 ClarificationResolved - the question has an answer, or it has become a change request. Either way the plan may be re-versioned around it.',
   true)
on conflict (type) do nothing;

create table if not exists projects.plan_clarifications (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references core.organizations(id) on delete cascade,
  plan_id          uuid not null references projects.project_plans(id) on delete cascade,

  -- §14: "question, impact, PM/client response, source evidence, status".
  question         text not null check (length(btrim(question)) between 1 and 1000),

  -- What is blocked or at risk while this is unanswered. Not null: a question
  -- nobody can say the consequence of is a question nobody will prioritise,
  -- and §10 asks the PM for "concise question/context".
  impact           text not null check (length(btrim(impact)) > 0),

  -- SOURCE EVIDENCE. The ambiguity came from somewhere in the approved
  -- material, and a clarification that cannot point at what it read is the
  -- same assertion `crm.qualification_coverage` refuses to store. One of the
  -- two, enforced.
  scope_item_id    uuid references projects.scope_items(id) on delete restrict,
  deliverable_id   uuid references projects.plan_deliverables(id) on delete cascade,
  constraint plan_clarifications_has_a_source check (
    scope_item_id is not null or deliverable_id is not null
  ),

  -- §10's chain, as states. `routed_to_change_request` is the second honest
  -- ending; there is no state meaning "we decided what they probably meant".
  status           text not null default 'open' check (status in
                     ('open', 'asked', 'answered', 'resolved', 'routed_to_change_request')),

  asked_at         timestamptz,
  asked_by         uuid references core.users(id) on delete set null,

  answer           text,
  answered_at      timestamptz,
  answered_by      uuid references core.users(id) on delete set null,
  -- How the answer arrived, for the record. Free text, because a client may
  -- answer on a call, and a closed list here would make somebody lie.
  answered_via     text,

  resolved_at      timestamptz,

  -- §10's routing. A real reference to the process that already exists.
  change_request_id uuid references projects.change_requests(id) on delete restrict,
  constraint plan_clarifications_routed_names_the_request check (
    (status = 'routed_to_change_request') = (change_request_id is not null)
  ),

  -- A state and its moment travel together, as everywhere else here.
  constraint plan_clarifications_asked_shape check (
    (status in ('asked', 'answered', 'resolved', 'routed_to_change_request')) = (asked_at is not null)
  ),
  constraint plan_clarifications_answered_shape check (
    (status in ('answered', 'resolved')) = (answer is not null)
  ),
  constraint plan_clarifications_resolved_shape check (
    (status in ('resolved', 'routed_to_change_request')) = (resolved_at is not null)
  ),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists plan_clarifications_open_idx
  on projects.plan_clarifications (plan_id, status);

comment on table projects.plan_clarifications is
  'Project Planning section 10 - a question the plan refuses to guess the answer to. Two honest endings: the client answers it, or it turns out to be new work and becomes a change request. There is no state meaning "we decided what they probably meant", because section 5 forbids converting an ambiguous requirement into an invented one.';

comment on column projects.plan_clarifications.impact is
  'What is blocked or at risk while this is unanswered. Not null: a question nobody can state the consequence of is a question nobody will prioritise, and section 10 asks the PM for concise question and context.';

comment on constraint plan_clarifications_has_a_source on projects.plan_clarifications is
  'Section 14 source evidence. A clarification that cannot point at the scope item or deliverable it came from is an assertion, which is what this whole loop exists to avoid.';

-- ── an answered question is a record ─────────────────────────────────────

create or replace function projects.freeze_settled_clarification()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('resolved', 'routed_to_change_request')
     and (new.question is distinct from old.question
          or new.answer is distinct from old.answer
          or new.status is distinct from old.status) then
    raise exception 'a settled clarification is what the client said and what was done about it, not a draft'
      using errcode = 'check_violation';
  end if;
  -- The question itself never changes after it has been put to a client: they
  -- answered THAT question, and editing it afterwards makes their answer mean
  -- something they did not say.
  if old.status <> 'open' and new.question is distinct from old.question then
    raise exception 'the question was already put to the client and cannot be reworded now'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_settled_clarification on projects.plan_clarifications;
create trigger freeze_settled_clarification
  before update on projects.plan_clarifications
  for each row execute function projects.freeze_settled_clarification();

-- ── tenancy, written out so a static check can see it ────────────────────

alter table projects.plan_clarifications enable row level security;
alter table projects.plan_clarifications force row level security;

drop policy if exists plan_clarifications_select on projects.plan_clarifications;
create policy plan_clarifications_select on projects.plan_clarifications
  for select to authenticated
  using (organization_id = (select core.current_organization_id()) and (select core.is_internal()));

drop trigger if exists org_match_plan_clarifications_plan on projects.plan_clarifications;
create trigger org_match_plan_clarifications_plan
  before insert or update of plan_id, organization_id on projects.plan_clarifications
  for each row execute function core.enforce_parent_org('plan_id', 'projects.project_plans');

drop trigger if exists org_match_plan_clarifications_scope_item on projects.plan_clarifications;
create trigger org_match_plan_clarifications_scope_item
  before insert or update of scope_item_id, organization_id on projects.plan_clarifications
  for each row execute function core.enforce_parent_org('scope_item_id', 'projects.scope_items');

drop trigger if exists org_match_plan_clarifications_deliverable on projects.plan_clarifications;
create trigger org_match_plan_clarifications_deliverable
  before insert or update of deliverable_id, organization_id on projects.plan_clarifications
  for each row execute function core.enforce_parent_org('deliverable_id', 'projects.plan_deliverables');

drop trigger if exists org_match_plan_clarifications_change_request on projects.plan_clarifications;
create trigger org_match_plan_clarifications_change_request
  before insert or update of change_request_id, organization_id on projects.plan_clarifications
  for each row execute function core.enforce_parent_org('change_request_id', 'projects.change_requests');

drop trigger if exists freeze_org_plan_clarifications on projects.plan_clarifications;
create trigger freeze_org_plan_clarifications
  before update of organization_id on projects.plan_clarifications
  for each row execute function core.freeze_organization_id();

drop trigger if exists set_updated_at_plan_clarifications on projects.plan_clarifications;
create trigger set_updated_at_plan_clarifications
  before update on projects.plan_clarifications
  for each row execute function core.set_updated_at();

grant select on projects.plan_clarifications to authenticated;
grant select, insert, update on projects.plan_clarifications to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- The doors — §10's chain, one per step, each recording who and when
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function projects.raise_clarification(
  p_plan_id uuid,
  p_question text,
  p_impact text,
  p_scope_item_id uuid default null,
  p_deliverable_id uuid default null
)
returns table (
  -- 'raised' | 'not_draft' | 'unknown_plan' | 'no_source' | 'no_actor' | 'forbidden'
  outcome text,
  clarification_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_new   uuid;
begin
  -- §14's source evidence, refused before the lock and by name.
  if p_scope_item_id is null and p_deliverable_id is null then
    return query select 'no_source'::text, null::uuid; return;
  end if;

  -- The Planning Agent raises these, so the service role may. What it may not
  -- do is answer one.
  if v_actor is null and (select auth.role()) is distinct from 'service_role' then
    return query select 'no_actor'::text, null::uuid; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::uuid; return;
  end if;

  if v_actor is not null
     and (v_plan.organization_id is distinct from (select core.current_organization_id())
          or not (select core.can_write())) then
    return query select 'forbidden'::text, null::uuid; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, null::uuid; return;
  end if;

  insert into projects.plan_clarifications (
    organization_id, plan_id, question, impact, scope_item_id, deliverable_id
  ) values (
    v_plan.organization_id, v_plan.id, p_question, p_impact, p_scope_item_id, p_deliverable_id
  )
  returning id into v_new;

  perform core.emit_event(
    v_plan.organization_id, 'project.clarification_required', 'project', v_plan.project_id,
    jsonb_build_object('clarification_id', v_new, 'plan_id', v_plan.id),
    null
  );

  return query select 'raised'::text, v_new;
end;
$$;

comment on function projects.raise_clarification(uuid, text, text, uuid, uuid) is
  'Project Planning section 10 - the Planning Agent flags an ambiguity instead of guessing. Emits ClarificationRequired and sends nothing: the PM asks the client.';

-- ── the PM puts it to the client ─────────────────────────────────────────

create or replace function projects.mark_clarification_asked(p_clarification_id uuid)
returns table (
  -- 'asked' | 'already_asked' | 'unknown_clarification' | 'needs_person' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
begin
  -- A PERSON. This records that somebody asked a client a question, which is
  -- an event outside this system, and an unattended process cannot witness it.
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status <> 'open' then
    return query select 'already_asked'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'asked', asked_at = now(), asked_by = v_actor
   where id = v_row.id;

  return query select 'asked'::text;
end;
$$;

comment on function projects.mark_clarification_asked(uuid) is
  'Project Planning section 10 - a person records that the question has been put to the client. Refuses an unattended caller: asking a client something happens outside this system.';

-- ── and brings the answer back ───────────────────────────────────────────

create or replace function projects.record_clarification_answer(
  p_clarification_id uuid,
  p_answer text,
  p_answered_via text default null
)
returns table (
  -- 'answered' | 'not_asked' | 'already_settled' | 'unknown_clarification'
  -- | 'empty_answer' | 'needs_person' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
begin
  -- An empty answer is not an answer, and storing one would move the status to
  -- `answered` while leaving the question unanswered — the precise shape of
  -- the guess §10 forbids.
  if coalesce(btrim(coalesce(p_answer, '')), '') = '' then
    return query select 'empty_answer'::text; return;
  end if;

  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status in ('resolved', 'routed_to_change_request') then
    return query select 'already_settled'::text; return;
  end if;
  -- An answer to a question nobody asked is a guess wearing a client's voice.
  if v_row.status = 'open' then
    return query select 'not_asked'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'answered', answer = btrim(p_answer), answered_at = now(),
         answered_by = v_actor, answered_via = nullif(btrim(coalesce(p_answered_via, '')), '')
   where id = v_row.id;

  return query select 'answered'::text;
end;
$$;

comment on function projects.record_clarification_answer(uuid, text, text) is
  'Project Planning section 10 - the PM structures the client response. Refuses an answer to a question nobody asked, and refuses an empty one: both would move the row to answered while leaving the question unanswered, which is the guess section 10 forbids.';

-- ── the two honest endings ───────────────────────────────────────────────

create or replace function projects.resolve_clarification(p_clarification_id uuid)
returns table (
  -- 'resolved' | 'no_answer' | 'already_settled' | 'unknown_clarification'
  -- | 'needs_person' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
begin
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status in ('resolved', 'routed_to_change_request') then
    return query select 'already_settled'::text; return;
  end if;

  -- The whole rule, in one refusal: a clarification cannot be closed without
  -- the client's answer. Closing it empty is deciding what they meant.
  if v_row.status <> 'answered' then
    return query select 'no_answer'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'resolved', resolved_at = now()
   where id = v_row.id;

  perform core.emit_event(
    v_row.organization_id, 'project.clarification_resolved', 'project',
    (select pp.project_id from projects.project_plans pp where pp.id = v_row.plan_id),
    jsonb_build_object('clarification_id', v_row.id, 'ending', 'answered'),
    null
  );

  return query select 'resolved'::text;
end;
$$;

comment on function projects.resolve_clarification(uuid) is
  'Project Planning section 10 - the first honest ending. Refuses to close a question that has no answer, because closing it empty is deciding what the client meant.';

create or replace function projects.route_clarification_to_change_request(
  p_clarification_id uuid,
  p_change_request_id uuid
)
returns table (
  -- 'routed' | 'already_settled' | 'unknown_clarification' | 'unknown_change_request'
  -- | 'wrong_project' | 'needs_person' | 'forbidden'
  outcome text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_row   projects.plan_clarifications;
  v_plan  projects.project_plans;
  v_cr    projects.change_requests;
begin
  if v_actor is null then
    return query select 'needs_person'::text; return;
  end if;

  select c.* into v_row from projects.plan_clarifications c where c.id = p_clarification_id for update;
  if v_row.id is null then
    return query select 'unknown_clarification'::text; return;
  end if;

  if v_row.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text; return;
  end if;

  if v_row.status in ('resolved', 'routed_to_change_request') then
    return query select 'already_settled'::text; return;
  end if;

  select cr.* into v_cr from projects.change_requests cr where cr.id = p_change_request_id;
  if v_cr.id is null or v_cr.organization_id is distinct from v_row.organization_id then
    return query select 'unknown_change_request'::text; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = v_row.plan_id;
  -- The change request must be for THIS project. Routing a question to another
  -- project's change request would price this client's new work onto that one.
  if v_cr.project_id is distinct from v_plan.project_id then
    return query select 'wrong_project'::text; return;
  end if;

  update projects.plan_clarifications
     set status = 'routed_to_change_request',
         change_request_id = v_cr.id,
         resolved_at = now(),
         -- §10: routing is itself the ending, so the row stops being open even
         -- though no client answer was recorded. The asked_at stamp is kept.
         asked_at = coalesce(v_row.asked_at, now())
   where id = v_row.id;

  perform core.emit_event(
    v_row.organization_id, 'project.clarification_resolved', 'project', v_plan.project_id,
    jsonb_build_object('clarification_id', v_row.id, 'ending', 'change_request', 'change_request_id', v_cr.id),
    null
  );

  perform core.record_audit(
    v_row.organization_id, 'project.clarification_routed', 'project', v_plan.project_id,
    jsonb_build_object('status', v_row.status),
    jsonb_build_object('status', 'routed_to_change_request', 'clarification_id', v_row.id,
                       'change_request_id', v_cr.id, 'routed_by', v_actor),
    null
  );

  return query select 'routed'::text;
end;
$$;

comment on function projects.route_clarification_to_change_request(uuid, uuid) is
  'Project Planning section 10 - the second honest ending. New or out-of-scope work becomes a change request, priced and approved by the process that already exists, rather than being silently added to the plan. Refuses a change request belonging to another project.';

-- ── and the gate this loop exists to hold ────────────────────────────────
--
-- `projects.activate_project_plan` carried forward VERBATIM from G-256's
-- migration, with TWO MARKED EDITS and nothing else. The diff between the two
-- definitions is 18 lines added and 2 replaced, all of them inside the marks.
--
-- Carried rather than altered because the function is the whole rule for when
-- a plan may go live: a reader comparing the two files sees one definition,
-- not a base plus a patch they have to apply in their head.

create or replace function projects.activate_project_plan(p_plan_id uuid)
returns table (
  -- 'activated' | 'not_draft' | 'no_deliverables' | 'open_clarifications'
  -- | 'unknown_plan' | 'needs_person' | 'forbidden'
  -- [G-257 edit 1 of 2] 'open_clarifications' added to the documented set.
  outcome text,
  version int
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_plan  projects.project_plans;
  v_count int;
  v_open  int;
begin
  -- A person finalises a plan. §12: "actual phase transition authority remains
  -- with AgencyOS workflow/policy and responsible agents" — and a blueprint
  -- going live is what the pre-kickoff gate reads, so somebody owns it.
  if v_actor is null then
    return query select 'needs_person'::text, null::int; return;
  end if;

  select pp.* into v_plan from projects.project_plans pp where pp.id = p_plan_id for update;
  if v_plan.id is null then
    return query select 'unknown_plan'::text, null::int; return;
  end if;

  if v_plan.organization_id is distinct from (select core.current_organization_id())
     or not (select core.can_write()) then
    return query select 'forbidden'::text, null::int; return;
  end if;

  if v_plan.status <> 'draft' then
    return query select 'not_draft'::text, v_plan.version; return;
  end if;

  -- §7 requires a deliverables register. An empty plan that reads `active`
  -- would satisfy the pre-kickoff gate while containing nothing.
  select count(*) into v_count from projects.plan_deliverables d where d.plan_id = v_plan.id;
  if v_count = 0 then
    return query select 'no_deliverables'::text, v_plan.version; return;
  end if;

  -- [G-257 edit 2 of 2] Planning §10: "never guesses an unclear client
  -- requirement", and PLAN-I09 validates ambiguity before ProjectPlanReady. A
  -- plan carrying an unanswered question is a plan that guessed the answer, so
  -- it cannot go live until every clarification is resolved or routed to a
  -- change request. Checked HERE rather than by a constraint because it is a
  -- rule about a moment, not about a row.
  select count(*) into v_open
    from projects.plan_clarifications c
   where c.plan_id = v_plan.id
     and c.status not in ('resolved', 'routed_to_change_request');
  if v_open > 0 then
    return query select 'open_clarifications'::text, v_plan.version; return;
  end if;

  update projects.project_plans
     set status = 'superseded'
   where project_id = v_plan.project_id and status = 'active';

  update projects.project_plans
     set status = 'active', activated_at = now(), activated_by = v_actor
   where id = v_plan.id;

  perform core.emit_event(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('plan_id', v_plan.id, 'version', v_plan.version, 'deliverables', v_count),
    null
  );

  perform core.record_audit(
    v_plan.organization_id, 'project.plan_activated', 'project', v_plan.project_id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'active', 'plan_id', v_plan.id, 'version', v_plan.version, 'activated_by', v_actor),
    null
  );

  return query select 'activated'::text, v_plan.version;
end;
$$;

revoke all on function projects.raise_clarification(uuid, text, text, uuid, uuid) from public;
revoke all on function projects.mark_clarification_asked(uuid) from public;
revoke all on function projects.record_clarification_answer(uuid, text, text) from public;
revoke all on function projects.resolve_clarification(uuid) from public;
revoke all on function projects.route_clarification_to_change_request(uuid, uuid) from public;

-- Only the raise is the agent's; every step that touches the client's side of
-- the loop is a person's.
grant execute on function projects.raise_clarification(uuid, text, text, uuid, uuid) to authenticated, service_role;
grant execute on function projects.mark_clarification_asked(uuid) to authenticated;
grant execute on function projects.record_clarification_answer(uuid, text, text) to authenticated;
grant execute on function projects.resolve_clarification(uuid) to authenticated;
grant execute on function projects.route_clarification_to_change_request(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
