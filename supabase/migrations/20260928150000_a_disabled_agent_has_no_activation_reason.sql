-- ═══════════════════════════════════════════════════════════════════════════
-- A disabled agent has no activation reason.
--
-- Phase 4 Orchestrator spec §10, §21 (P4-ORCH-GUARDS): "Routing guards: block
-- Designer without activation reason." `ai.enforce_handoff_target`
-- (20260814120003) already refuses a handoff whose receiver is not a
-- declared target in the sender's registry definition (ADM-83) — but a
-- declared target and a LIVE one are different facts. `ai.agents.enabled` is
-- the per-agent kill switch (20260807120008's own comment: "so demoting a
-- misbehaving agent to L0 or killing it is an UPDATE, not a deploy"), and
-- nothing before this migration ever consulted it before recording a
-- handoff. An admin flipping `ui_designer.enabled` to false in the Admin
-- Panel intends that to mean "stop giving this agent work" — the trigger is
-- extended, rather than a new one added, because refusing where a handoff
-- goes is already this trigger's exact job.
--
-- ── application-side guard is the first layer, this is the second ─────────
--
-- `src/modules/orchestrator/route.ts`'s `checkDesignerActivation` and
-- `src/modules/orchestrator/handlers.ts`'s `handleRouteTask2Design` re-read
-- both `ai.agents.enabled` and the Phase 3 baseline's `phase_four_ready`
-- before ever attempting an insert, and refuse permanently before reaching
-- this trigger at all. This migration is defense-in-depth: the same
-- two-layer arrangement `ai.enforce_handoff_target`'s declared-target check
-- already keeps beside `mayHandOff` in TypeScript. A caller that skipped the
-- application check — a future workflow, a manual repair script, a bug — is
-- still refused here.
--
-- ── additive only ───────────────────────────────────────────────────────
--
-- `create or replace function`: no table changes, no column rename, no
-- narrowed CHECK. The trigger definition (`before insert or update of
-- from_agent, to_agent`) is unchanged; only the function body gains a second
-- check.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function ai.enforce_handoff_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to_enabled boolean;
begin
  if not exists (
    select 1
      from ai.agent_handoff_targets t
     where t.from_agent = new.from_agent
       and t.to_agent   = new.to_agent
  ) then
    raise exception
      'handoff refused: % may not hand work to %. The receiver must be a declared target in the sender''s registry definition (ADM-83).',
      new.from_agent, new.to_agent
      using errcode = 'check_violation';
  end if;

  -- ORCH §10/§21's Designer-activation guard, generalized to every agent
  -- rather than named for ui_designer alone: a disabled receiver has no
  -- activation reason to receive ANY handoff, not only a Task 2 design one.
  select a.enabled into v_to_enabled from ai.agents a where a.key = new.to_agent;

  if coalesce(v_to_enabled, false) is not true then
    raise exception
      'handoff refused: % is disabled in ai.agents and has no activation reason to receive work from %.',
      new.to_agent, new.from_agent
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function ai.enforce_handoff_target() is
  'Refuses a handoff whose receiver is not a declared target of the sender (ADM-83, G-125 condition 6), AND refuses one whose receiver is currently disabled in ai.agents (ORCH §10/§21''s Designer-activation guard, generalized to every agent). Runs on UPDATE as well as INSERT, because a handoff redirected after creation, or an agent disabled after a handoff was queued but before it is acted on, would otherwise escape the rule.';

notify pgrst, 'reload schema';
