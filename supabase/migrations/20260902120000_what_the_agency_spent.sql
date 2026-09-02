-- What the agency spent — G-186.
--
-- ── the finding, and it is two findings ───────────────────────────────────
--
-- `ai.cost_ledger` was created on 2026-08-07 with the comment *"nightly
-- rollup; the budget check reads this"*. **Nothing has ever written a row into
-- it and no budget check reads it.** A zero-trust audit found the table empty
-- with no producer (DB-A), which is the tables-with-no-code problem G-011
-- exists to prevent, told about a table that describes money.
--
-- The second finding is the one that makes it worth fixing rather than
-- deleting. `getAgentUsage` — the Admin Panel's spend page — reads **every**
-- `ai.agent_runs` and `ai.agent_steps` row with a 10,000-row cap and adds them
-- up in the application. Past that cap the page reports a **partial total as
-- if it were the total**, flagged only by a `capped` boolean. A spend figure
-- that silently under-reports is worse than no spend figure, and this table is
-- the shape that fixes it: one row per day, per agent, per model.
--
-- ── written when it happens, not nightly ──────────────────────────────────
--
-- The original comment says nightly, and there is no scheduler: `vercel.json`
-- has no crons, which the same audit recorded as P0-2. A rollup that waits for
-- a scheduler nobody has configured is a rollup that never runs, so this is a
-- trigger on the run itself — the row that already carries the agent, the
-- model, the tokens and the cost.
--
-- ── counted exactly once, and the transition is what guarantees it ────────
--
-- The trigger fires only on the move INTO a terminal status from a
-- non-terminal one. A run is updated several times on its way — claimed,
-- stepped, settled — and every later write to a settled row (an output
-- written, an error appended) would otherwise add its tokens a second time.
--
-- ── every terminal status, not only success ───────────────────────────────
--
-- A failed run has spent its tokens. So has one killed for its budget. The
-- ledger answers *what did this cost*, and a ledger that recorded only the
-- successes would tell an owner their worst month was their cheapest.
--
-- ── the day is the AGENCY'S day ───────────────────────────────────────────
--
-- `core.organizations.timezone`, falling back to UTC when it is unset — which
-- it ships as, deliberately (`db:verify:followup` asserts exactly that). An
-- owner in Ahmedabad reading "2 September" means their 2 September, and a
-- spend row filed against UTC midnight would put an evening's work on the
-- wrong day.

create or replace function ai.roll_up_run_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day    date;
  v_in     bigint;
  v_out    bigint;
  v_cost   bigint;
  v_steps  int;
begin
  -- The agency's own day, resolved from the organization the run belongs to.
  select ((coalesce(new.finished_at, now()) at time zone coalesce(o.timezone, 'UTC'))::date)
    into v_day
    from core.organizations o
   where o.id = new.organization_id;

  if v_day is null then
    -- The organization is gone. Its runs cascade away with it, so there is
    -- nothing to roll up and nothing to report.
    return new;
  end if;

  /**
   * The STEPS are the authority on what was spent, not the run's own columns.
   *
   * `succeedRun` writes the usage of the call it was handed, and a workflow
   * that ever made two model calls would settle with the second one's figures
   * — the first call's tokens paid for and unrecorded on the run. Every step
   * row is written as its call returns, so summing them is the same number the
   * spend page has always shown and the one an invoice would agree with.
   *
   * A settled run with NO steps falls back to its own columns: a run that died
   * before any call has zero either way, and reading the row is how a future
   * settlement path that records differently still lands here.
   */
  select count(*), coalesce(sum(greatest(s.tokens_in, 0)), 0),
         coalesce(sum(greatest(s.tokens_out, 0)), 0), coalesce(sum(greatest(s.cost_minor, 0)), 0)
    into v_steps, v_in, v_out, v_cost
    from ai.agent_steps s
   where s.run_id = new.id;

  if v_steps = 0 then
    v_in   := greatest(new.input_tokens, 0);
    v_out  := greatest(new.output_tokens, 0);
    v_cost := greatest(new.cost_minor, 0);
  end if;

  insert into ai.cost_ledger (
    organization_id, day, agent_key, model, runs, input_tokens, output_tokens, cost_minor
  )
  values (
    new.organization_id,
    v_day,
    new.agent_key,
    -- The column is NOT NULL and a run may have died before a model was
    -- chosen. 'unknown' is the honest name for that, and it keeps the
    -- spend visible rather than dropping the row.
    coalesce(new.model, 'unknown'),
    1,
    v_in,
    v_out,
    v_cost
  )
  on conflict (organization_id, day, agent_key, model) do update
     set runs          = ai.cost_ledger.runs + 1,
         input_tokens  = ai.cost_ledger.input_tokens + excluded.input_tokens,
         output_tokens = ai.cost_ledger.output_tokens + excluded.output_tokens,
         cost_minor    = ai.cost_ledger.cost_minor + excluded.cost_minor,
         updated_at    = now();

  return new;
end;
$$;

comment on function ai.roll_up_run_cost() is
  'Adds one settled run to ai.cost_ledger, once (G-186). Fires only on the transition INTO a terminal status, because a settled run is written to again and every later write would add its tokens a second time. Every terminal status counts, not only success: a failed run has spent its tokens, and a ledger of successes only would tell an owner their worst month was their cheapest.';

drop trigger if exists roll_up_run_cost on ai.agent_runs;
create trigger roll_up_run_cost
  after update on ai.agent_runs
  for each row
  when (
    new.status in ('succeeded', 'failed', 'cancelled', 'budget_exceeded')
    and old.status not in ('succeeded', 'failed', 'cancelled', 'budget_exceeded')
  )
  execute function ai.roll_up_run_cost();

-- ── the runs that already happened ────────────────────────────────────────
--
-- Backfilled rather than left out, so the page's numbers do not drop the day
-- this ships. Grouped exactly as the trigger files them, and idempotent: a
-- re-run of this migration adds nothing, because the day/agent/model key
-- already exists and the conflict clause SETS rather than adds.
insert into ai.cost_ledger (
  organization_id, day, agent_key, model, runs, input_tokens, output_tokens, cost_minor
)
select
  r.organization_id,
  ((coalesce(r.finished_at, r.created_at) at time zone coalesce(o.timezone, 'UTC'))::date) as day,
  r.agent_key,
  coalesce(r.model, 'unknown') as model,
  count(*),
  -- The same authority the trigger uses, and the same fallback: the steps when
  -- there are any, the run's own columns when there are none.
  sum(case when spent.steps > 0 then spent.tokens_in else greatest(r.input_tokens, 0) end),
  sum(case when spent.steps > 0 then spent.tokens_out else greatest(r.output_tokens, 0) end),
  sum(case when spent.steps > 0 then spent.cost_minor else greatest(r.cost_minor, 0) end)
from ai.agent_runs r
join core.organizations o on o.id = r.organization_id
cross join lateral (
  select count(*) as steps,
         coalesce(sum(greatest(s.tokens_in, 0)), 0)  as tokens_in,
         coalesce(sum(greatest(s.tokens_out, 0)), 0) as tokens_out,
         coalesce(sum(greatest(s.cost_minor, 0)), 0) as cost_minor
    from ai.agent_steps s
   where s.run_id = r.id
) spent
where r.status in ('succeeded', 'failed', 'cancelled', 'budget_exceeded')
group by 1, 2, 3, 4
on conflict (organization_id, day, agent_key, model) do update
   set runs          = excluded.runs,
       input_tokens  = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       cost_minor    = excluded.cost_minor,
       updated_at    = now();

comment on table ai.cost_ledger is
  'What the agency spent, one row per day per agent per model (G-186). Written by ai.roll_up_run_cost() as each run settles — not nightly, because there is no scheduler and a rollup waiting for one never runs. It exists so the spend page can add up a few hundred rows instead of every run and step ever recorded, which it did with a 10,000-row cap and reported a partial total as the total.';
