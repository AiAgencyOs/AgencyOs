-- ═══════════════════════════════════════════════════════════════════════════
-- An agent's autonomy is data, and now it is obeyed.
--
-- Gap G-041. `ai.agents.autonomy_level` has existed since the schema was
-- written, with a comment stating what the levels mean — L0 read-only, L1
-- propose, L2 autonomous — and the job runner selected the column and ignored
-- it. That is worse than never reading it: the code looked as though autonomy
-- were configurable while the behaviour was L1 whatever the row said, so
-- turning an agent down was a deploy rather than an UPDATE.
--
-- ── the database refuses what the application refuses (D16's rule) ────────
--
-- The runner now checks `mayAgentRun` before doing anything, which produces a
-- settled job and a readable reason. This trigger is the other half: an
-- `ai.agent_runs` row cannot be created for an agent that is not permitted to
-- act, whatever called it. A second caller — a script, a future worker, a
-- console session — does not get to skip the check by not knowing about it.
--
-- ── L2 is refused, deliberately ───────────────────────────────────────────
--
-- For the one path that exists, autonomous would mean the agent accepting its
-- own requirement proposal with no human in it. Directive §29 forbids exactly
-- that without a stated policy and none exists, so L2 is refused rather than
-- quietly treated as L1 — an operator who sets L2 expecting autonomy should be
-- told they did not get it. What L2 means here is G-101.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function ai.agent_runs_autonomy_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_level   text;
  v_enabled boolean;
begin
  select a.autonomy_level, a.enabled into v_level, v_enabled
    from ai.agents a
   where a.key = new.agent_key;

  if v_level is null then
    raise exception 'agent "%" is not registered', new.agent_key
      using errcode = 'foreign_key_violation';
  end if;

  if not v_enabled then
    raise exception 'agent "%" is disabled', new.agent_key
      using errcode = 'restrict_violation';
  end if;

  -- L1 is the only level with defined behaviour today. L0 is read-only by
  -- definition; L2 waits on the policy that says what autonomous means here.
  if v_level <> 'L1' then
    raise exception 'agent "%" is % and may not perform work', new.agent_key, v_level
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function ai.agent_runs_autonomy_guard() is
  'Refuses an agent run for an agent that is disabled, unregistered, or at an autonomy level with no defined behaviour. The database half of G-041: the runner checks the same rule and produces a better message, and this makes skipping that check impossible rather than merely discouraged.';

drop trigger if exists agent_runs_autonomy_guard on ai.agent_runs;
create trigger agent_runs_autonomy_guard
  before insert on ai.agent_runs
  for each row execute function ai.agent_runs_autonomy_guard();
