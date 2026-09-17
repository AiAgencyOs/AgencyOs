-- ═══════════════════════════════════════════════════════════════════════════
-- Required is not the same as done.
--
-- Master §5.4, §5.10; PM §4.3. And a conflict with **ADM-06** that G-258
-- introduced without noticing, raised here as **ADM-108**.
--
-- ── §5.4 lists six values, and they are two axes ─────────────────────────
--
--   *"Track each item as REQUIRED / OPTIONAL / RECEIVED / VERIFIED /
--    WAITING_CLIENT / NOT_APPLICABLE."*
--
-- Written as one enum those six are nonsense: an item is `required` **and**
-- `verified`, not one or the other. So they are two columns — a `requirement`
-- (is this needed at all) and a `status` (where it has got to) — and the
-- checklist gains the four states it was missing. `done` becomes `verified`,
-- which is what somebody marking an item complete has always meant.
--
-- ── the conflict, and why the column that fixes it is NULLABLE ───────────
--
-- **ADM-06, granted 2026-08-13:** *"The onboarding checklist blocks nothing —
-- every item is a reminder."* The table's own comment says so.
--
-- **Master §5.10, locked 2026-09-16:** the pre-kickoff gate must *"verify
-- required onboarding data"*.
--
-- Those contradict, and G-258 shipped the second without noticing the first:
-- its gate refuses a kickoff while any checklist item is `pending`, which is
-- precisely the blocking ADM-06 forbade. That is a defect of G-258, recorded
-- rather than quietly corrected.
--
-- `requirement` is therefore **nullable, and defaults to nothing**. Null means
-- *nobody has said whether this item is required* — which is the truth today,
-- because nobody has been asked. The gate counts only items explicitly marked
-- `required`, so:
--
--   * until the owner marks any, **the checklist blocks nothing** — ADM-06
--     holds, and G-258's overreach is undone;
--   * the moment they mark some, **those become the gate** — §5.10 holds, and
--     with exactly the items they chose.
--
-- Neither document is overruled and no business decision is invented. The
-- question that remains is genuinely the owner's, and is **ADM-108**.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the second axis ──────────────────────────────────────────────────────

alter table projects.onboarding_items
  add column if not exists requirement text
    check (requirement is null or requirement in ('required', 'optional'));

alter table projects.onboarding_baseline
  add column if not exists requirement text
    check (requirement is null or requirement in ('required', 'optional'));

comment on column projects.onboarding_items.requirement is
  'Master section 5.4 REQUIRED / OPTIONAL. NULLABLE on purpose: null means nobody has said, which is true until the owner configures it. The pre-kickoff gate counts only items explicitly marked required, so an unconfigured checklist blocks nothing (ADM-06) and a configured one blocks exactly what the owner chose (Master section 5.10). ADM-108 asks which.';

comment on column projects.onboarding_baseline.requirement is
  'The default requirement a new project''s checklist inherits. Null until the owner configures it - see projects.onboarding_items.requirement and ADM-108.';

-- ── the four states §5.4 asks for ────────────────────────────────────────
--
-- `done` is migrated to `verified` before the constraint changes, because a
-- person who marked an item done meant it was settled, and `received` would
-- claim a distinction nobody drew at the time.

alter table projects.onboarding_items
  drop constraint if exists onboarding_items_status_check;

update projects.onboarding_items set status = 'verified' where status = 'done';

alter table projects.onboarding_items
  add constraint onboarding_items_status_check check (status in (
    'pending', 'waiting_client', 'received', 'verified', 'not_applicable'
  ));

-- The completion shape, restated for the wider vocabulary. `received` carries
-- a moment too: somebody recorded that a thing arrived, and when.
alter table projects.onboarding_items
  drop constraint if exists onboarding_items_completion_shape;

alter table projects.onboarding_items
  add constraint onboarding_items_completion_shape check (
    case
      when status in ('pending', 'waiting_client') then completed_at is null and completed_by is null
      else completed_at is not null
    end
  );

comment on column projects.onboarding_items.status is
  'Master section 5.4 RECEIVED / VERIFIED / WAITING_CLIENT / NOT_APPLICABLE, plus pending. The old value `done` was migrated to `verified`: somebody who marked an item done meant it was settled, and calling it `received` would claim a distinction they never drew.';

-- ── the setter and the gate, carried forward ────────────────────────────
--
-- Both from their latest definitions — `set_onboarding_item` from
-- 20260813120020 and `pre_kickoff_readiness` from 20260917160000, each
-- established by searching for the LAST migration that defines it rather than
-- the first. G-260 learned that at the cost of nearly dropping a capability.

create or replace function projects.set_onboarding_item(
  p_item_id uuid,
  p_status  text,
  p_note    text default null,
  p_actor   uuid default null
)
returns table (
  -- 'set' | 'not_found' | 'invalid_status'
  outcome text,
  status  text,
  done    int,
  total   int
)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_row     projects.onboarding_items;
  v_project uuid;
  v_done    int;
  v_total   int;
begin
  -- [G-261 edit 1 of 3] Master §5.4's four states, plus pending. `done` is
  -- gone: it was migrated to `verified`, and still accepting it would let a
  -- caller write a value the check constraint now refuses.
  if p_status not in ('pending', 'waiting_client', 'received', 'verified', 'not_applicable') then
    return query select 'invalid_status'::text, null::text, null::int, null::int;
    return;
  end if;

  select i.* into v_row
    from projects.onboarding_items i
   where i.id = p_item_id
   for update;

  if v_row.id is null then
    return query select 'not_found'::text, null::text, null::int, null::int;
    return;
  end if;

  v_project := v_row.project_id;

  -- Un-ticking is allowed, and clears the answer with it: an item back in
  -- `pending` that still carried who ticked it and when would be a record of
  -- a decision that no longer holds. `onboarding_items_completion_shape`
  -- refuses the half-state outright.
  update projects.onboarding_items
     set status       = p_status,
         note         = coalesce(p_note, projects.onboarding_items.note),
         -- [G-261 edit 2 of 3] `waiting_client` joins `pending` as a state
         -- that has NOT completed: somebody waiting on a client has not
         -- received anything, and stamping a completion moment would say they
         -- had.
         completed_by = case when p_status in ('pending', 'waiting_client') then null else p_actor end,
         completed_at = case when p_status in ('pending', 'waiting_client') then null else clock_timestamp() end
   where projects.onboarding_items.id = p_item_id;

  -- [G-261 edit 3 of 3] `waiting_client` is not progress. A checklist reading
  -- "9 of 10" because nine items are waiting on the client would be a progress
  -- bar measuring how much has been ASKED rather than how much is settled.
  select count(*) filter (where i.status not in ('pending', 'waiting_client')), count(*)
    into v_done, v_total
    from projects.onboarding_items i
   where i.project_id = v_project;

  return query select 'set'::text, p_status, v_done, v_total;
end;
$$;

create or replace function projects.pre_kickoff_readiness(p_project_id uuid)
returns table (
  ready                boolean,
  unmet                text[],
  onboarding_settled   boolean,
  group_ready          boolean,
  payment_verified     boolean,
  plan_ready           boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_onboarding boolean;
  v_group      boolean;
  v_payment    boolean;
  v_plan       boolean;
  v_unmet      text[] := '{}';
  v_start      record;
begin
  -- Every checklist item except the three the kickoff itself settles.
  --
  -- The checklist must EXIST as well as be settled. `not exists (... pending)`
  -- alone is true for a project with no checklist at all, so a project nobody
  -- ever onboarded would sail through the gate that exists to check it was —
  -- the absence-only assertion this repository has been caught by before.
  -- Found by driving it: a bare fixture reported `onboarding_settled` true.
  -- [G-261 edit 1 of 1] Only items the owner has explicitly marked REQUIRED.
  --
  -- G-258 blocked on EVERY pending item, which contradicted ADM-06 — granted
  -- 2026-08-13: "the onboarding checklist blocks nothing; every item is a
  -- reminder." Master §5.10 asks the gate to verify "required onboarding
  -- data", and until this migration nothing recorded which items were
  -- required, so "every item" was the only reading available and it was the
  -- wrong one.
  --
  -- Now: `requirement = 'required'` is the gate. Nothing is marked required
  -- yet, so today this blocks nothing and ADM-06 holds; the moment the owner
  -- marks some, those become the gate and §5.10 holds. ADM-108 asks which.
  --
  -- The existence check is gone with it: a project with no checklist now
  -- passes, because it has no REQUIRED items — which is the same answer
  -- ADM-06 gives for a project with a checklist nobody configured.
  select not exists (
    select 1
      from projects.onboarding_items oi
     where oi.project_id = p_project_id
       and oi.requirement = 'required'
       and oi.status not in ('verified', 'not_applicable')
       and oi.key not in ('kickoff_sent', 'project_activated', 'whatsapp_group_mapped')
  )
  into v_onboarding;

  -- "WhatsApp mapping IF REQUIRED": required exactly when a card was raised
  -- for this project. A project whose Phase 2 began before G-253 has no card,
  -- and demanding a state that nothing can produce would block it forever.
  select coalesce(
    (select gs.state in ('mapped', 'verified') from projects.group_setups gs where gs.project_id = p_project_id),
    true
  ) into v_group;

  -- Reused, not re-derived. `start_readiness.advance_verified` already follows
  -- `verified_minor` rather than `paid_minor` (G-007), which is the rule
  -- Finance §6 states as "proof never auto-verifies".
  select * into v_start from projects.start_readiness(p_project_id);
  v_payment := v_start.advance_verified;

  select exists (
    select 1 from projects.project_plans pp
     where pp.project_id = p_project_id and pp.status = 'active'
  ) into v_plan;

  -- THERE IS DELIBERATELY NO OPEN-QUESTION GATE HERE, and its absence was
  -- found by driving this rather than by reading it.
  --
  -- The first version of this function counted unresolved clarifications on
  -- the active plan. That count can never be anything but zero: a
  -- clarification may only be raised against a DRAFT plan (the door refuses
  -- `not_draft`, and `refuse_write_to_settled_plan` refuses the direct write),
  -- and G-257 already refuses to activate a plan carrying one. So the gate
  -- could not fail, while reading as though the kickoff checked for open
  -- questions — an absence-only assertion, one layer too late.
  --
  -- The rule is held where it can actually bite. If clarifications are ever
  -- made raisable against a live plan, this gate has to come back.

  if not v_onboarding then v_unmet := v_unmet || 'onboarding_incomplete'::text; end if;
  if not v_group     then v_unmet := v_unmet || 'whatsapp_group_not_mapped'::text; end if;
  if not v_payment   then v_unmet := v_unmet || 'advance_not_verified'::text; end if;
  if not v_plan      then v_unmet := v_unmet || 'no_active_plan'::text; end if;

  return query select
    array_length(v_unmet, 1) is null,
    v_unmet, v_onboarding, v_group, v_payment, v_plan;
end;
$$;

notify pgrst, 'reload schema';
