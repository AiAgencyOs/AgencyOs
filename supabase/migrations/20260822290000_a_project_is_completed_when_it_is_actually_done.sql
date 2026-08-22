-- ═══════════════════════════════════════════════════════════════════════════
-- A project is completed when it is actually done.
--
-- Document 17 §1, first line: *"Project completion is a controlled state
-- transition, not simply the moment development stops."* And the line that
-- makes it a rule: *"No agent can declare the project completed while mandatory
-- deliverables, payment, QA, deployment or handover evidence is missing."*
--
-- §3 lists eleven completion preconditions. **None of them was checked.**
-- `active → completed` is legal in `PROJECT_TRANSITIONS`, that array lives in
-- TypeScript, and nothing in the database asked anything at all — so a project
-- became `completed` because somebody picked `completed` from a dropdown.
--
-- That is the same shape G-026 found for `active`, and its change-log row said
-- why it was worth reading: the conditions had been written down on the first
-- delivery migration and enforced by nobody. This is the other end of the same
-- lifecycle, with the same defect, three months later.
--
-- ── four of the eleven, and only four ────────────────────────────────────
--
-- §3 asks for eleven. Four are answerable from rows that exist, and those four
-- are checked:
--
--   no blocking defect        `qa.defects` open at blocker/major — the same
--                             question `deliver_handover` already asks, at the
--                             other end of the same delivery
--   final payment verified    `finance.invoices.verified_minor` covers the
--                             issued total. **Verified**, not recorded: ADM-04
--                             and G-007 made those two different numbers, and
--                             this is the one that means a person checked the
--                             bank
--   handover delivered        `projects.handovers` reached `delivered`
--   client acceptance         and then `accepted`, which is the client's own
--                             act through `sync_handover_acceptance`
--
-- The other seven are **not invented**. *"Development tasks are accepted"* has
-- no task table; *"production deployment is successful"* has no deployment
-- record; *"required UI/design baselines are approved"* is real but a project
-- may legitimately have none. Checking a condition this repository cannot
-- observe would mean inventing the observation, which is the failure ADM-88
-- and ADM-22 are both about.
--
-- ── and an override says why, as §13 requires ────────────────────────────
--
-- §13: *"An internal Admin override requires reason and audit trail."* Same
-- shape as `start_project`: the unmet conditions are named rather than reported
-- as "not ready", an override with no reason is not an override, and the audit
-- trigger records the whole row from inside the transaction (G-093) so the
-- reason lands without anybody remembering to put it there.

alter table projects.projects
  add column if not exists completion_override_reason text;

comment on column projects.projects.completion_override_reason is
  'Document 17 section 13: "An internal Admin override requires reason and audit trail." Non-null exactly when a project was completed with a section 3 precondition unmet, and says which human judgement replaced the check. Written only by projects.complete_project; the audit trigger records it.';

create or replace function projects.completion_readiness(p_project_id uuid)
returns table (
  no_blocking_defects boolean,
  payment_verified    boolean,
  handover_delivered  boolean,
  client_accepted     boolean
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
         and d.severity in ('blocker', 'major')
    ),
    -- Verified, not recorded. G-007 split those apart precisely so that
    -- "a client said they paid" could not stand in for "somebody checked".
    -- A project with no issued invoice has nothing outstanding, which is a
    -- pass rather than a hole: not every project bills through AgencyOS.
    not exists (
      select 1 from finance.invoices i
       where i.project_id = p_project_id
         and i.status in ('issued', 'partially_paid', 'overdue')
         and i.verified_minor < i.total_minor
    ),
    exists (
      select 1 from projects.handovers h
       where h.project_id = p_project_id
         and h.status in ('delivered', 'accepted')
    ),
    exists (
      select 1 from projects.handovers h
       where h.project_id = p_project_id
         and h.status = 'accepted'
    );
$$;

comment on function projects.completion_readiness(uuid) is
  'The four of Document 17 section 3''s eleven completion preconditions that are answerable from rows this repository actually has. The other seven are not invented: there is no development-task table, no deployment record, and a project may legitimately have no design baseline. Reports; decides nothing.';

create or replace function projects.complete_project(
  p_project_id      uuid,
  p_override_reason text default null
)
returns table (
  -- 'completed' | 'already_completed' | 'not_found' | 'not_completable'
  -- | 'not_done'
  outcome        text,
  project_status text,
  -- Which conditions are unmet, named rather than counted — they are usually
  -- four different people's problems.
  unmet          text[],
  overridden     boolean
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

  -- Completing a completed project is the answer, not an error.
  if v_status = 'completed' then
    return query select 'already_completed'::text, v_status, '{}'::text[], false;
    return;
  end if;

  -- PROJECT_TRANSITIONS admits `completed` from `active` alone.
  if v_status <> 'active' then
    return query select 'not_completable'::text, v_status, '{}'::text[], false;
    return;
  end if;

  select * into v_ready from projects.completion_readiness(p_project_id);

  if not v_ready.no_blocking_defects then
    v_unmet := v_unmet || 'blocking_defects_remain'::text;
  end if;
  if not v_ready.payment_verified then
    v_unmet := v_unmet || 'payment_not_verified'::text;
  end if;
  if not v_ready.handover_delivered then
    v_unmet := v_unmet || 'handover_not_delivered'::text;
  end if;
  if not v_ready.client_accepted then
    v_unmet := v_unmet || 'client_has_not_accepted'::text;
  end if;

  -- An override with no reason is not an override.
  if array_length(v_unmet, 1) is not null
     and (p_override_reason is null or length(trim(p_override_reason)) = 0)
  then
    return query select 'not_done'::text, v_status, v_unmet, false;
    return;
  end if;

  update projects.projects
     set status                     = 'completed',
         completed_at               = now(),
         completion_override_reason = case
                                        when array_length(v_unmet, 1) is not null
                                          then trim(p_override_reason)
                                        else null
                                      end,
         updated_at                 = now()
   where id = p_project_id;

  return query select 'completed'::text, 'completed'::text, v_unmet,
                      array_length(v_unmet, 1) is not null;
end;
$$;

comment on function projects.complete_project(uuid, text) is
  'Takes the active to completed transition, which Document 17 section 1 calls "a controlled state transition, not simply the moment development stops". Refuses unless no blocking defect remains, the issued invoices are VERIFIED paid, the handover was delivered and the client accepted it - naming which is missing rather than saying not ready - and admits an override only with a reason, which the audit trigger records. Decides under the project row lock. The seven other section 3 preconditions are not checked because this repository has no rows that answer them.';

revoke all on function projects.complete_project(uuid, text) from public, anon;
grant execute on function projects.complete_project(uuid, text) to authenticated, service_role;
revoke all on function projects.completion_readiness(uuid) from public, anon;
grant execute on function projects.completion_readiness(uuid) to authenticated, service_role;

-- ── and the gate is the rule, not the function ───────────────────────────
--
-- A function nobody has to call is a suggestion. `PROJECT_TRANSITIONS` lives
-- in TypeScript, so a direct `PATCH status=completed` over the Data API set a
-- project completed with nothing asked — measured, not assumed: the probe
-- returned **200**.
--
-- So the rule goes on the row, the way `handovers_guard` does one table over,
-- and by the same means: **evidence rather than a flag**. The guard asks the
-- same four questions the function asks, so `complete_project` is not
-- privileged — it is the convenient way to satisfy a rule that holds for every
-- writer, and its advantage is that it NAMES what is missing instead of
-- raising.
--
-- **UPDATE only, and deliberately.** A project created already `completed` is
-- an import of history, not a completion event, and several fixtures and the
-- reactivation import do exactly that. Document 17 §1 is about the
-- *transition* — *"a controlled state transition, not simply the moment
-- development stops"* — which is what this guards.

create or replace function projects.refuse_undone_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ready record;
  v_unmet text[] := '{}';
begin
  if new.status <> 'completed' or coalesce(old.status, '') = 'completed' then
    return new;
  end if;

  select * into v_ready from projects.completion_readiness(new.id);

  if not v_ready.no_blocking_defects then v_unmet := v_unmet || 'blocking_defects_remain'::text; end if;
  if not v_ready.payment_verified    then v_unmet := v_unmet || 'payment_not_verified'::text;    end if;
  if not v_ready.handover_delivered  then v_unmet := v_unmet || 'handover_not_delivered'::text;  end if;
  if not v_ready.client_accepted     then v_unmet := v_unmet || 'client_has_not_accepted'::text; end if;

  if array_length(v_unmet, 1) is not null
     and coalesce(length(btrim(new.completion_override_reason)), 0) = 0
  then
    raise exception
      'this project is not done: %  (Doc 17 §3 — or complete_project with a reason, which §13 requires)',
      array_to_string(v_unmet, ', ')
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function projects.refuse_undone_completion() is
  'Document 17 section 1: "Project completion is a controlled state transition, not simply the moment development stops." PROJECT_TRANSITIONS lives in TypeScript, so a direct PATCH set a project completed with nothing asked - measured at 200 before this existed. Asks the same four questions projects.complete_project asks, so that function is not privileged: it is the convenient way to satisfy a rule that holds for every writer. UPDATE only - a project created already completed is an import of history, not a completion event.';

drop trigger if exists refuse_undone_completion on projects.projects;
create trigger refuse_undone_completion
  before update of status on projects.projects
  for each row execute function projects.refuse_undone_completion();

notify pgrst, 'reload schema';
