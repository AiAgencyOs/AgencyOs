-- ═══════════════════════════════════════════════════════════════════════════
-- The level is a level again — G-247.
--
-- `mayAgentRun` and this trigger permitted EVERY work class at L1 and only
-- ADM-61 §2's four at L2. Each half was defensible alone — L1 means the run is
-- a proposal, L2 means acting alone and §3 limits that — but together they
-- made the gate **stricter at the higher level**.
--
-- The column is presented to an owner as an autonomy LEVEL, ordered
-- L0 < L1 < L2, on the Agents page and in the guide they answered ADM-82 from.
-- So **an owner moving an agent down from L2 to L1 to restrain it widened what
-- the gate would permit it to run** — and one such move has already been made
-- and recorded as a widening (`handover`, 2026-09-14, harmless only because
-- its work is a draft).
--
-- ── the owner answered, and the answer is written here ───────────────
--
-- Asked which way to resolve it, the owner chose: **L1 stops permitting the
-- three.** So L1 and L2 now apply the same list, and the ordering is honest.
--
-- **What that means, stated rather than left to be found: at this gate L1 and
-- L2 permit exactly the same work.** The difference between them was never
-- about which work is permitted — it is whether the output is a proposal a
-- human accepts, which is the workflow's property. What the level still
-- decides here is L0 against the rest.
--
-- ── and the two paths the owner granted by name keep running ─────────
--
-- The first draft of this change would have stopped them. `followup.compose`
-- and `reply.compose` are `client_facing`, and refusing that class at L1
-- refuses both — while moving their agent to L2 does not help, because L2
-- refuses it too. **No level would have permitted them**, and both are
-- permitted by the owner's own decisions: ADM-61 §4 records the ADM-11
-- follow-ups as *"the only path in AgencyOS where something reaches a client
-- unread"*, and ADM-91 widened it (*"ai agent khud kare"*).
--
-- So the exception is a WORK CLASS, not a level: `client_direct` — reaches a
-- client without the internal group seeing it first, by a decision that names
-- the path. It is permitted at L1 and L2 alike, because the permission
-- belongs to the path rather than to the agent's autonomy. Everything else
-- that reaches a client stays `client_facing` and is refused at both.
--
-- ── what this refuses that it did not refuse yesterday ───────────────
--
-- An L1 agent running `client_facing`, `money` or `delivery_approval` work.
-- **Nothing runs those today** — the two client-facing workflows move to
-- `client_direct` in the same change, and no workflow declares `money` or
-- `delivery_approval` at all — so no behaviour changes on this deployment.
-- The refusal is for the next one somebody writes.
--
-- The trigger body below is `pg_get_functiondef` read back from a database
-- with every migration applied, with one marked edit — the lesson of G-303,
-- where a function rewritten from memory dropped a rule, an event and two
-- outcomes.
-- ═══════════════════════════════════════════════════════════════════════════

-- The class the exception needs. Added to the CHECK first: the trigger below
-- would otherwise permit a value the column refuses, which reads as a working
-- guard and fails on the first run.
alter table ai.agent_runs
  drop constraint if exists agent_runs_work_class_check;

alter table ai.agent_runs
  add constraint agent_runs_work_class_check
  check (work_class = any (array[
    'read', 'draft', 'internal_plan', 'breakdown',
    'client_direct', 'client_facing', 'money', 'delivery_approval'
  ]));

comment on column ai.agent_runs.work_class is
  'ADM-61 sections 2 and 3, in the document''s own vocabulary. client_direct is section 4''s named exception - the paths ADM-11 and ADM-91 permit to reach a client unread - and is the only client-facing class any autonomy level permits (G-247).';

CREATE OR REPLACE FUNCTION ai.agent_runs_autonomy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

  -- A run that does not say what kind of work it is cannot be checked against
  -- ADM-61 at all. Refused rather than assumed to be the safest class: the
  -- runner always sets it, so an absent one means something bypassed the
  -- runner.
  if new.work_class is null then
    raise exception
      'agent run for "%" does not say what kind of work it is (ADM-61 §2/§3)', new.agent_key
      using errcode = 'restrict_violation';
  end if;

  -- L0 is read-only by definition: an L0 agent that ran anyway would make the
  -- claim false, whatever the work.
  if v_level = 'L0' then
    raise exception 'agent "%" is L0 (read-only) and may not perform work', new.agent_key
      using errcode = 'restrict_violation';
  end if;

  -- CHANGED (G-247): L1 and L2 apply the SAME list. They used to differ, and
  -- backwards - L1 permitted every class and L2 only §2's four, so the gate
  -- was stricter at the higher level and lowering an agent widened it.
  if v_level in ('L1', 'L2') then
    -- ADM-61 §2's four, plus §4's named exception: `client_direct` is the path
    -- ADM-11 and ADM-91 permit to reach a client unread. Everything else that
    -- reaches a client is `client_facing` and comes to the internal group.
    if new.work_class in ('read', 'draft', 'internal_plan', 'breakdown', 'client_direct') then
      return new;
    end if;

    raise exception
      'agent "%" is % and "%" must come to the internal group first (ADM-61 §3)',
      new.agent_key, v_level, new.work_class
      using errcode = 'restrict_violation';
  end if;

  raise exception 'agent "%" autonomy level "%" is not recognised', new.agent_key, v_level
    using errcode = 'restrict_violation';
end;
$function$;

-- The registry's own comment said the inversion out loud (*"L1 permits every
-- work class and L2 only ADM-61 section 2's four, so L1 is the more permissive
-- level"*). It is now false, and a stale comment on the table an owner reads
-- is worse than none — G-266's lesson, applied to the thing that records it.
comment on table ai.agents is
  'The agent registry (ADM-82). Activation answered 2026-09-13 (BLK-002): requirement_collector, sales, customer_success, support and handover at L1; quality_assurance, project_manager, ui_designer and ui_prototype at L2; orchestrator, developer, finance and upsell off. lead_qualifier and proposal_drafter are NOT independent agents under ADM-82 - their definitions are preserved and disabled. G-247 is closed: L1 and L2 now permit the SAME work (ADM-61 section 2''s four, plus section 4''s named client_direct exception), so lowering an agent no longer widens it. The level still decides L0 against the rest; whether an output is a proposal is the workflow''s property, not this column''s.';

notify pgrst, 'reload schema';
