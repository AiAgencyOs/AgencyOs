-- ═══════════════════════════════════════════════════════════════════════════
-- Layer one is complete.
--
-- ADM-82 grants a roster of thirteen agents in three layers and requires
-- *"each layer passing its architecture and verification gates before the next
-- is activated."* Layer 1 is `requirement_collector`, `orchestrator`,
-- `developer` and `qa`. Two of the four existed. Going to build the sales
-- agent — layer 2 — meant skipping the gate, and skipping it is what surfaced
-- the hole `verdictFor` had carried since F4: it checked that the *declared*
-- verifier was speaking and never that the verifier was entitled to be
-- declared. With two agents defined and only one of them not a producer, the
-- rule held by arithmetic. Defining a third is what ends the arithmetic.
--
-- So the two missing definitions arrive, and they arrive DISABLED.
--
-- ADM-82 granted which agents exist and withheld their implementation. There
-- is no orchestrator workflow, no developer workflow, no repository binding
-- and no tool. A definition is not an activation — the same distinction
-- `quality_assurance` has carried since F4, and for the same reason: the
-- contract cannot be exercised against an agent that does not exist, and
-- exercising it is the point.
--
-- ── autonomy, from ADM-61 rather than from convenience ────────────────────
--
-- *"L2 acts alone on internal work and asks for anything client-facing or
-- touching money."* Both of these are purely internal: the orchestrator routes
-- and assembles context, the developer writes code and runs tests. Neither
-- reaches a client, neither moves money, and production deployment stays
-- separately gated. L2 is the honest reading, and it matches the roster
-- already seeded — `lead_qualifier` is L2 for writing only to lead records,
-- `requirement_collector` is L1 because what it produces is meant for a client
-- once a human sends it.
--
-- ── what the orchestrator may not do ──────────────────────────────────────
--
-- ADM-82 states the prohibition in capitals: **"THE ORCHESTRATOR MUST NOT
-- judge completion, act as QA, override QA, or certify delivery."** That now
-- lives in the registry as `mayVerify: false`, is refused at build time by
-- check-record §14, and is refused at runtime by `decideVerdict`. This
-- migration adds no verifier row for it — `ai.agent_verifiers` records who
-- verifies a producer, and the orchestrator appears there only as a producer
-- whose work QA checks, never as the verifier of anybody.
--
-- ── the one handoff edge, because three documents state it ────────────────
--
-- `developer → quality_assurance`. Document 03 §9 (*"DEVELOPER WORKFLOW → QA
-- HANDOFF"*), Document 13 §31 (*"DEVELOPER → STRUCTURED HANDOFF → QA"*) and
-- Document 23 §28 (*"Developer Agent → QA Agent: build artifact + commit +
-- test evidence"*) each say it independently. The orchestrator gets none: it
-- routes to agents that layers 2 and 3 activate, and naming those now would be
-- inventing a graph the documents do not specify. An empty target list means
-- no handoff can be created at all, which is the state QA has held since F3.
--
-- Idempotent throughout. Re-running changes nothing, and rows already present
-- keep the text they carry.
-- ═══════════════════════════════════════════════════════════════════════════

insert into ai.agents (key, display_name, description, autonomy_level, enabled,
                       default_model, default_effort, max_steps, max_cost_minor,
                       disabled_reason)
values
  ('orchestrator', 'Orchestrator',
   'Routes work to the responsible agent, assembles the context it needs, and coordinates handoffs. Decides nothing about whether work is complete.',
   'L2', false, 'claude-sonnet-5', 'medium', 12, 1000,
   'Layer 1 of ADM-82, defined so the verification contract has a third agent to be exercised against. Activation is a separate decision under the same grant.'),

  ('developer', 'Developer',
   'Implements approved scope in controlled tasks and submits evidence of it. Never decides that its own work is done.',
   'L2', false, 'claude-opus-5', 'high', 20, 3000,
   'Layer 1 of ADM-82, defined so QA has a producer to verify. There is no developer workflow, repository binding or tool. Activation is a separate decision under the same grant.')
on conflict (key) do nothing;

-- The edge three documents state independently.
insert into ai.agent_handoff_targets (from_agent, to_agent)
values ('developer', 'quality_assurance')
on conflict (from_agent, to_agent) do nothing;

-- Who checks each producer's work. QA verifies both new agents; neither
-- verifies anything, which is what `mayVerify: false` says in the registry and
-- what the absence of a row with either as `verifier` says here.
insert into ai.agent_verifiers (producer, verifier)
values
  ('orchestrator', 'quality_assurance'),
  ('developer', 'quality_assurance')
on conflict (producer) do nothing;
