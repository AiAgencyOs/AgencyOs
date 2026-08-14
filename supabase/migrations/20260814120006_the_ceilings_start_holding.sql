-- ═══════════════════════════════════════════════════════════════════════════
-- The ceilings start holding.
--
-- Gaps G-133 and G-134. The controls that bound an agent existed as columns,
-- constraints and a terminal status — and **nothing read or wrote any of
-- them**.
--
-- ── G-133: ceilings with no consumer ─────────────────────────────────────
--
-- `ai.agents.max_steps` and `max_cost_minor` are seeded per agent, carry CHECK
-- constraints, and are documented. `ai.agent_runs` records `step_count` and
-- `cost_minor` faithfully. **Nothing ever compared the two.** `ai.agent_runs`
-- even carries a `budget_exceeded` status — a terminal state named for exactly
-- this and never once set.
--
-- It is not a live defect today, and that is worth stating plainly rather than
-- dressing the finding up: the only enabled agent makes a single model call,
-- so `step_count` is always 1 and no ceiling could be reached. It is a defect
-- the moment any agent takes a second step, which is Phase 5.
--
-- ── G-134: a depth bound with no producer ────────────────────────────────
--
-- `ai.handoffs.depth` is `default 0` with `check (depth >= 0 and depth <= 8)`,
-- and **nothing derived it from anything**. The CHECK constrains the number a
-- caller writes, not the length of a chain — and the default is 0, so a caller
-- that never sets it is never bounded. `A → B → A → B` could run forever with
-- every row reading `depth = 0` and every constraint satisfied.
--
-- That is the recursion §17 of the completion mandate forbids: a workflow that
-- can theoretically recurse forever is not production ready.
--
-- ── how depth is derived, and why this shape ─────────────────────────────
--
-- `depth = max(depth in this correlation chain) + 1`, computed by trigger and
-- **ignoring whatever the caller passed**. A derived value a caller can
-- override is not a bound; it is a suggestion.
--
-- Per correlation chain rather than per parent branch, which is the stricter
-- reading and matches what `20260814120003` already recorded: *"`depth` is the
-- bound, per correlation chain, because the chain is already the unit of
-- tracing."* A consequence worth naming: parallel handoffs consume depth even
-- though they are not a chain. That is deliberate — it bounds total work in a
-- correlation rather than only the longest path, and when the choice is
-- between two readings the tighter one is the safe one. It also needs no new
-- parent column, so nothing has to be backfilled.
--
-- ── why a run is not simply refused when it exceeds ──────────────────────
--
-- Refusing the UPDATE would reject the write that records what was actually
-- spent, and unrecorded spend is a worse failure than an overspent run: the
-- money is gone either way and only one version leaves evidence.
--
-- So the usage is recorded as it truly was, and the run is forced terminal as
-- `budget_exceeded`. A run cut off at its ceiling did not succeed, and saying
-- it did would be the false-completion problem one layer down.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the run ceilings ─────────────────────────────────────────────────────

create or replace function ai.enforce_run_ceilings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_steps int;
  v_max_cost  bigint;
begin
  -- `ai.agents` is global: its primary key is `key` alone, with no
  -- organization column. Agent definitions are code, so the ceilings are the
  -- same for every tenant; runs are tenant-scoped, the agents that produce
  -- them are not.
  select a.max_steps, a.max_cost_minor
    into v_max_steps, v_max_cost
    from ai.agents a
   where a.key = new.agent_key;

  -- An agent with no row cannot be ceilinged. `ai.agent_runs` already refuses
  -- a run for an agent that may not act, so reaching here without a row means
  -- something further up is wrong - and inventing a ceiling would hide it.
  if v_max_steps is null then
    return new;
  end if;

  if coalesce(new.step_count, 0) > v_max_steps then
    new.status      := 'budget_exceeded';
    new.error       := coalesce(new.error,
      format('step ceiling exceeded: %s of %s allowed for %s',
             new.step_count, v_max_steps, new.agent_key));
    new.finished_at := coalesce(new.finished_at, now());
  elsif coalesce(new.cost_minor, 0) > v_max_cost then
    new.status      := 'budget_exceeded';
    new.error       := coalesce(new.error,
      format('cost ceiling exceeded: %s minor of %s allowed for %s',
             new.cost_minor, v_max_cost, new.agent_key));
    new.finished_at := coalesce(new.finished_at, now());
  end if;

  return new;
end;
$$;

comment on function ai.enforce_run_ceilings() is
  'Forces a run terminal as budget_exceeded when its recorded step_count or cost_minor passes the agent ceiling (G-133). The usage is recorded as it truly was rather than refused: unrecorded spend is a worse failure than overspend, because the money is gone either way and only one version leaves evidence.';

drop trigger if exists enforce_run_ceilings on ai.agent_runs;
create trigger enforce_run_ceilings
  before insert or update on ai.agent_runs
  for each row execute function ai.enforce_run_ceilings();

-- ── the handoff depth ────────────────────────────────────────────────────

create or replace function ai.derive_handoff_depth()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_depth int;
begin
  -- Ignores new.depth entirely. A derived value a caller may override is a
  -- suggestion, not a bound, and the caller here is an agent.
  select coalesce(max(h.depth), -1) + 1
    into v_depth
    from ai.handoffs h
   where h.correlation_id = new.correlation_id;

  if v_depth > 8 then
    raise exception
      'handoff refused: correlation % has reached depth %, and 8 is the bound (G-134). A chain this long is a loop, not progress.',
      new.correlation_id, v_depth
      using errcode = 'check_violation';
  end if;

  new.depth := v_depth;
  return new;
end;
$$;

comment on function ai.derive_handoff_depth() is
  'Derives ai.handoffs.depth from the correlation chain and ignores what the caller passed (G-134). The column defaulted to 0 and nothing computed it, so check (depth <= 8) bounded a number the caller chose rather than the length of a chain - A to B to A to B could run forever with every row reading depth 0.';

drop trigger if exists derive_handoff_depth on ai.handoffs;
create trigger derive_handoff_depth
  before insert on ai.handoffs
  for each row execute function ai.derive_handoff_depth();

-- The ordering matters and is worth stating: `enforce_handoff_target` also
-- runs BEFORE INSERT, and PostgreSQL fires same-timing row triggers in name
-- order — `derive_handoff_depth` before `enforce_handoff_target`. Both must
-- pass, and neither depends on the other's result, so the order is a fact to
-- record rather than a dependency to manage.
