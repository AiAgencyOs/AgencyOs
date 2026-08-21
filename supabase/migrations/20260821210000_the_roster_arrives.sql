-- ═══════════════════════════════════════════════════════════════════════════
-- The roster arrives.
--
-- ADM-82 grants thirteen agents in three layers. Four existed. These are the
-- other nine, and every one of them is DISABLED.
--
-- That is not hedging. ADM-82 granted **which agents exist** and withheld
-- their implementation, keeping activation as a separate decision per layer —
-- *"each layer passing its architecture and verification gates before the next
-- is activated."* A definition is not an activation. What defining them buys
-- before activation is that every boundary already built in this module —
-- tool authorization, the handoff graph, the verification contract, the
-- pricing prohibition — is exercised against the roster the system will
-- actually have, instead of against the two agents that happened to exist
-- first. Layer 1 taught that lesson directly: with two agents defined and one
-- of them not a producer, `verdictFor`'s missing half held by arithmetic.
-- Defining more agents is what ends the arithmetic.
--
-- ── autonomy, read off ADM-61 rather than chosen ──────────────────────────
--
-- *"L2 acts alone on internal work and asks for anything client-facing or
-- touching money."* Applied literally:
--
--   L1  sales, project_manager, support, customer_success   reach a client
--   L1  finance                                             touches money
--   L2  ui_designer, ui_prototype, handover, upsell         neither
--
-- `handover` is L2 despite producing something a client eventually receives,
-- because assembling the package is internal and *delivering* it is an
-- approval — which is why its only outward-facing tool is
-- `approvals.requestApproval` and it holds no way to send anything.
--
-- ── the prohibition that is expressed as an absence ───────────────────────
--
-- ADM-82 states it in capitals: **"UPSELL HAS ZERO PRICING AUTHORITY: it may
-- identify and recommend internally and must never invent a price, calculate a
-- quote, offer a discount, negotiate price or make a commercial commitment."**
--
-- So `upsell` is not client-facing, holds no message tool, and hands what it
-- finds to `sales`. There is no pricing tool anywhere in `tools.ts` for any of
-- these agents to be bound to — ADM-22 and business rules 08 §5.1, which adds
-- that such actions *"do not become permissible at a higher autonomy level"*.
-- A prohibition that depends on a sentence in a prompt is reachable through
-- language (Doc 19 §38); a capability that does not exist is not.
--
-- `sales` may draft a proposal, because ADM-82 folded proposal drafting into
-- it — scope and timeline are not a price, and the price on that proposal
-- still comes from a human through `sales.set_proposal_pricing`, which is a
-- service action and not a tool.
--
-- ── the handoff graph, and why it is small ────────────────────────────────
--
-- Fifteen edges, each one an edge the documents state. Everything a producer
-- makes reaches `quality_assurance`, because ADM-82 gives it the only
-- verification authority there is; the specialists chain design → prototype →
-- build the way Doc 12/13 sequence them; `customer_success` and `upsell` both
-- return to `sales`, because expansion is a sales conversation and neither of
-- them may hold one. `handover → customer_success` is the delivery seam.
--
-- No edge into `handover` from a producer. ADM-82's reason for it being a
-- separate agent at all is that it *"must not be the same authority that
-- produced what it certifies"*, and a producer that could hand straight to it
-- is a producer routing around QA.
--
-- Idempotent throughout.
-- ═══════════════════════════════════════════════════════════════════════════

insert into ai.agents (key, display_name, description, autonomy_level, enabled,
                       default_model, default_effort, max_steps, max_cost_minor,
                       disabled_reason)
values
  -- ── layer 2 — core delivery ────────────────────────────────────────────
  ('sales', 'Sales',
   'Answers a lead, qualifies it, discovers requirements, handles objections and drafts the scope and timeline of a quotation. Never states a price - a human does, and no tool here could.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Layer 2 of ADM-82. Defined so the client-facing boundary, the consent gate and the pricing prohibition are exercised against the agent they were written for. Activation is a separate decision under the same grant.'),

  ('project_manager', 'Project Manager',
   'Plans and sequences a project, coordinates the specialists, tracks blockers and initiates QA. Judges no work complete.',
   'L1', false, 'claude-sonnet-5', 'medium', 16, 2000,
   'Layer 2 of ADM-82. There is no project workflow binding it to anything yet. Activation is a separate decision under the same grant.'),

  ('ui_designer', 'UI Designer',
   'Designs the screens the approved scope requires and files them as a versioned deliverable for review.',
   'L2', false, 'claude-sonnet-5', 'medium', 14, 2000,
   'Layer 2 of ADM-82. Activation is a separate decision under the same grant.'),

  ('ui_prototype', 'Prototype',
   'Turns an approved design into something a client can actually use, and files the build for review.',
   'L2', false, 'claude-opus-5', 'high', 20, 3000,
   'Layer 2 of ADM-82. Activation is a separate decision under the same grant.'),

  ('handover', 'Handover',
   'Assembles the handover package from evidence other agents produced, and never exposes a credential.',
   'L2', false, 'claude-sonnet-5', 'medium', 12, 1500,
   'Layer 2 of ADM-82, separate from delivery precisely because it must not be the same authority that produced what it certifies. Activation is a separate decision under the same grant.'),

  -- ── layer 3 — operations ───────────────────────────────────────────────
  ('finance', 'Finance',
   'Generates invoices from approved milestones and tracks what is outstanding. Verifies no payment - a human does that, from a record.',
   'L1', false, 'claude-sonnet-5', 'medium', 12, 1500,
   'Layer 3 of ADM-82. Activation is a separate decision under the same grant.'),

  ('support', 'Support',
   'Answers client questions from approved knowledge and classifies what is reported. Never reclassifies new work as warranty.',
   'L1', false, 'claude-sonnet-5', 'medium', 12, 1500,
   'Layer 3 of ADM-82. Activation is a separate decision under the same grant.'),

  ('customer_success', 'Customer Success',
   'Tracks a completed client relationship from recorded signals and prepares check-ins. Fabricates no satisfaction and invents no usage.',
   'L1', false, 'claude-sonnet-5', 'medium', 12, 1500,
   'Layer 3 of ADM-82. Activation is a separate decision under the same grant.'),

  ('upsell', 'Upsell',
   'Identifies a legitimate expansion opportunity from recorded facts and tells the team. Contacts no client and never names a price.',
   'L2', false, 'claude-sonnet-5', 'medium', 10, 1000,
   'Layer 3 of ADM-82, and the agent whose prohibition is the sharpest - zero pricing authority, no client contact, no message tool. Activation is a separate decision under the same grant.')
on conflict (key) do nothing;

-- ── the graph ────────────────────────────────────────────────────────────
--
-- Mirrored from `handoffTargets` in src/modules/agents/registry.ts because
-- Postgres cannot read TypeScript (ADM-83). check-record §16 proves the two
-- sides say the same thing, and `ai.handoffs_guard` refuses any handoff that
-- is not an edge here.

insert into ai.agent_handoff_targets (from_agent, to_agent)
values
  ('sales', 'project_manager'),
  ('sales', 'quality_assurance'),
  ('project_manager', 'ui_designer'),
  ('project_manager', 'developer'),
  ('project_manager', 'quality_assurance'),
  ('ui_designer', 'ui_prototype'),
  ('ui_designer', 'quality_assurance'),
  ('ui_prototype', 'developer'),
  ('ui_prototype', 'quality_assurance'),
  ('handover', 'customer_success'),
  ('finance', 'quality_assurance'),
  ('support', 'developer'),
  ('support', 'quality_assurance'),
  ('customer_success', 'sales'),
  ('upsell', 'sales')
on conflict (from_agent, to_agent) do nothing;

-- ── who checks whose work ────────────────────────────────────────────────
--
-- `quality_assurance` for all nine, because ADM-82 gives verification
-- authority to QA alone and none of these carries `mayVerify`. The absence of
-- any row naming one of them as `verifier` is the other half of that sentence.

insert into ai.agent_verifiers (producer, verifier)
values
  ('sales', 'quality_assurance'),
  ('project_manager', 'quality_assurance'),
  ('ui_designer', 'quality_assurance'),
  ('ui_prototype', 'quality_assurance'),
  ('handover', 'quality_assurance'),
  ('finance', 'quality_assurance'),
  ('support', 'quality_assurance'),
  ('customer_success', 'quality_assurance'),
  ('upsell', 'quality_assurance')
on conflict (producer) do nothing;
