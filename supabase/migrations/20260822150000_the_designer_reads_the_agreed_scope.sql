-- ═══════════════════════════════════════════════════════════════════════════
-- The designer reads the agreed scope.
--
-- Doc 12 §4 gives the UI designer fourteen responsibilities and the first two
-- are *"Analyze scope and derive UI implications"* and *"Create screen
-- inventory."* Everything dangerous about doing that was built before the
-- designer existed:
--
--   · a screen may not be mapped to an **excluded** scope item — §20,
--     *"Excluded features not accidentally designed as commitments"*
--   · a design may not enter review while an included item has no screen — §20
--   · two screens may not claim one id — §9 flags duplicates, and a duplicate
--     id is not a judgement
--   · the coverage matrix reports every other §9 flag and blocks on none of
--     them, because the rest are judgements nobody has configured
--
-- This adds the producer. That the change is small is the result of building
-- the guards first, not evidence that the guards were unnecessary.
--
-- ── the first L2 agent to run, and why it may ───────────────────────────
--
-- Until the gate learned to ask which work, every L2 agent was refused by an
-- argument written about requirement extraction. Producing an inventory is
-- ADM-61 §2's *"draft anything at all"*. Filing it as a design **version** and
-- submitting it for approval is §3's `delivery_approval`, which stays with the
-- internal group — and the schema the agent answers with has no field for a
-- status or a deliverable, so it cannot express the act it may not perform.
--
-- ── it is never shown an exclusion ──────────────────────────────────────
--
-- The workflow passes the baseline's included and optional items only. An
-- agent that cannot see an exclusion cannot design one. The row rule refuses
-- the mapping anyway — that is where the rule lives; the prompt is only where
-- it is made unnecessary.
-- ═══════════════════════════════════════════════════════════════════════════

update ai.agents
   set enabled = true,
       disabled_reason = null
 where key = 'ui_designer';

notify pgrst, 'reload schema';
