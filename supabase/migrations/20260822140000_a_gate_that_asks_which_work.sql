-- ═══════════════════════════════════════════════════════════════════════════
-- A gate that asks which work, not only which level.
--
-- `ai.agent_runs_autonomy_guard` refuses any agent whose level is not `L1`.
-- That was correct when one agent existed and its work was one thing. It is
-- the reason **seven of the thirteen** agents cannot run: `orchestrator`,
-- `developer`, `quality_assurance`, `ui_designer`, `ui_prototype`, `handover`
-- and `upsell` are all L2, and a workflow for any of them would be dispatched
-- and then refused by a row trigger that cannot tell what the work was.
--
-- ── the policy already exists, and says this ────────────────────────────
--
-- ADM-61, granted 2026-08-13: *"L2 acts alone on internal work and asks for
-- anything client-facing or touching money."* `08-ai-agent-responsibilities.md`
-- writes out both halves:
--
--   §2 — alone: break approved requirements into modules, features and tasks
--        (automatic by ADM-16); plan, schedule, re-order and update internal
--        work; draft anything at all; read anything its organization can read.
--
--   §3 — must bring to the internal group: anything reaching a client (the
--        ADM-11 follow-ups excepted); anything touching money — a price, an
--        invoice, a refund, a payment confirmation; and delivery approvals —
--        UI designs, prototypes, builds, QA and production-ready sign-off.
--
-- So the distinction is not the level. **It is the work**, and the row had no
-- column for it.
--
-- ── what is NOT here, and why ───────────────────────────────────────────
--
-- §5's five absolutes — invent a price or discount, promise a delivery date,
-- claim work exists, write a client credential, treat a client's word as a
-- fact — are deliberately absent from this gate. They are not things a level
-- or a class permits. Each is already refused somewhere it cannot be argued
-- with: `leads_no_invented_score` and the absence of any pricing tool, the
-- unread-message price trigger, `payment_submissions` having no
-- `verified_by_agent` column. A gate that appeared to adjudicate them would
-- imply a level at which they became allowed, and there is none.
--
-- ── nothing that runs today changes ─────────────────────────────────────
--
-- All three live workflows are L1, and L1 remains permitted for every class.
-- What changes is that the database can now express ADM-61 rather than
-- approximate it — and that a run arriving with no work class is refused, for
-- the same reason an unrecognised level is: a gap must not quietly grant the
-- ability to act.
-- ═══════════════════════════════════════════════════════════════════════════

alter table ai.agent_runs
  add column if not exists work_class text
    check (work_class in
      ('read', 'draft', 'internal_plan', 'breakdown',
       'client_facing', 'money', 'delivery_approval'));

comment on column ai.agent_runs.work_class is
  'What kind of work this run is, in ADM-61''s vocabulary: the four things section 2 lets an L2 agent do alone (read, draft, internal_plan, breakdown) and the three section 3 makes it bring to the internal group (client_facing, money, delivery_approval). Nullable only for the runs recorded before this column existed - a new run without one is refused by ai.agent_runs_autonomy_guard.';

-- ── the guard learns the second question ────────────────────────────────

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

  -- L1 proposes, and everything AgencyOS runs today is L1. Unchanged.
  if v_level = 'L1' then
    return new;
  end if;

  if v_level = 'L2' then
    -- ADM-61 §2, verbatim in four words.
    if new.work_class in ('read', 'draft', 'internal_plan', 'breakdown') then
      return new;
    end if;

    raise exception
      'agent "%" is L2 and "%" must come to the internal group first (ADM-61 §3)',
      new.agent_key, new.work_class
      using errcode = 'restrict_violation';
  end if;

  raise exception 'agent "%" autonomy level "%" is not recognised', new.agent_key, v_level
    using errcode = 'restrict_violation';
end;
$$;

comment on function ai.agent_runs_autonomy_guard() is
  'Refuses an agent run for an agent that is disabled, unregistered, at an unrecognised level, or doing work its level may not do alone (ADM-61 sections 2 and 3). The database half of G-041: the runner checks the same rule through lib/ai/autonomy.ts and produces a better message, and this makes skipping that check impossible rather than merely discouraged. Section 5''s five absolutes are deliberately not adjudicated here - they are refused where they cannot be argued with, and a gate that weighed them would imply a level at which they became allowed.';

notify pgrst, 'reload schema';
