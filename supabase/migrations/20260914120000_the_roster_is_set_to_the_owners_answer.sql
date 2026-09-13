-- ═══════════════════════════════════════════════════════════════════════════
-- The roster is set to the owner's answer — ADM-82's activation, BLK-002
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADM-82 granted WHICH agents exist and left activation as a separate decision
-- per layer. BLK-002 has waited since for one sentence: which are enabled, and
-- at what autonomy level. The owner answered it on 2026-09-13:
--
--   L1  requirement_collector, sales, customer_success, support, handover
--   L2  quality_assurance, project_manager, ui_designer, ui_prototype
--   off orchestrator, developer, finance, upsell
--
-- Three rows move. Everything else already matched, which is worth stating
-- plainly because the guide the owner answered from said "(already)" against
-- two rows that were not:
--
--   · ui_prototype   disabled → ENABLED
--   · handover       L2 → L1
--   · project_manager L1 → L2
--
-- ── what this does NOT do, said before anybody infers it ──────────────────
--
-- **It changes no behaviour.** Not one job runs differently after this
-- migration, and the honest reason is worth writing down rather than
-- discovering later:
--
--   · `ui_prototype` has no workflow. `AGENT_WORKFLOWS` binds eight agent
--     keys and that is not one of them, so enabling it makes a row say
--     `would run` about work that does not exist yet.
--   · `handover`'s only workflow is `handover.package`, work class `draft`.
--     `mayAgentRun` permits `draft` at L1 and at L2 alike.
--   · `project_manager`'s only workflow is `plan.breakdown`, work class
--     `breakdown`. Permitted at L1 and at L2 alike.
--
-- So "activation" as a SWITCH was already done — eight agents have been
-- enabled and running since 2026-08-24. What BLK-002 actually blocks is a
-- BUILD: the Sales agent's conversational loop, the client-facing proposal and
-- confirmation messages of Scheduler §6.1 and §6.4, and the consumer of
-- `meeting.analysed`. None of those arrives by setting a column.
--
-- ── the inversion, recorded because it is a trap ──────────────────────────
--
-- `src/lib/ai/autonomy.ts` reads: **L1 permits every work class**; L2 permits
-- only ADM-61 §2's four (read, draft, internal_plan, breakdown) and refuses
-- client_facing, money and delivery_approval by name. At this gate L1 is
-- therefore the MORE permissive level, not the less.
--
-- That is the opposite of what "autonomy level" suggests, and it is why
-- `handover` moving L2 → L1 is written here as widening rather than tightening
-- — it has no effect today only because its work class is permitted at both.
-- An owner who lowers an agent from L2 to L1 believing they are restraining it
-- is doing the reverse. Raised as G-247 rather than fixed here: changing what
-- the levels mean is a decision, not a migration.
--
-- What L1 *does* mean is that the RUN is permitted and whether a human sees
-- the result is a property of the workflow. For `sales` that is not uniform:
-- `followup.compose` and `reply.compose` are `client_facing` and reach the
-- client unread, by ADM-11 and ADM-91 — the owner's own grants, recorded in
-- those workflows. This migration does not change that and does not hide it.
--
-- Idempotent: each statement names the row and the value it sets.

-- ── ui_prototype: enabled, with nothing to run yet ───────────────────────

update ai.agents
   set enabled         = true,
       disabled_reason = null
 where key = 'ui_prototype';

comment on table ai.agents is
  'The agent registry (ADM-82). Activation answered 2026-09-13 (BLK-002): requirement_collector, sales, customer_success, support and handover at L1; quality_assurance, project_manager, ui_designer and ui_prototype at L2; orchestrator, developer, finance and upsell off. lead_qualifier and proposal_drafter are NOT independent agents under ADM-82 - their definitions are preserved and disabled. Note that L1 permits every work class and L2 only ADM-61 section 2''s four, so L1 is the more permissive level at ai.agent_runs_autonomy_guard and in mayAgentRun - see G-247.';

-- ── handover: L1, the owner's answer ─────────────────────────────────────
--
-- Widening, not tightening — see the note above. No effect today: its one
-- workflow is a draft, which L2 permits.

update ai.agents
   set autonomy_level = 'L1'
 where key = 'handover';

-- ── project_manager: L2, the owner's answer ──────────────────────────────
--
-- Tightening: at L2 a future client-facing or delivery-approval workflow under
-- this key would be refused by name rather than permitted. Its present work,
-- a breakdown, is permitted at both.

update ai.agents
   set autonomy_level = 'L2'
 where key = 'project_manager';

-- ── what the answer leaves off, restated on the rows themselves ──────────
--
-- Each of these was already disabled. The reason text is replaced so it names
-- the owner's answer rather than "a separate decision under the same grant",
-- which was true until there was an answer and is now stale.

update ai.agents
   set enabled = false,
       disabled_reason = 'OFF by the owner''s activation answer (2026-09-13, ADM-82 / BLK-002): the orchestrator waits until the loop below it is trusted.'
 where key = 'orchestrator';

update ai.agents
   set enabled = false,
       disabled_reason = 'OFF by the owner''s activation answer (2026-09-13, ADM-82 / BLK-002): out of Phase 1. There is also no developer workflow, repository binding or tool.'
 where key = 'developer';

update ai.agents
   set enabled = false,
       disabled_reason = 'OFF by the owner''s activation answer (2026-09-13, ADM-82 / BLK-002): money stays human (ADM-07).'
 where key = 'finance';

update ai.agents
   set enabled = false,
       disabled_reason = 'OFF by the owner''s activation answer (2026-09-13, ADM-82 / BLK-002): out of Phase 1.'
 where key = 'upsell';

notify pgrst, 'reload schema';
