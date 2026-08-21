-- ═══════════════════════════════════════════════════════════════════════════
-- The agent registry reaches production.
--
-- Found by auditing the running system against the documentation. Every piece
-- of agent governance this repository proves in CI is proved against a
-- database that is not production, because the rows those proofs read live in
-- `supabase/seed.sql`, and seed.sql is applied only by `supabase db reset`.
-- Production is migrated with `db push`, which does not run it. It never has.
--
-- Read from the production database, 2026-08-21:
--
--     ai.agents                 lead_qualifier, proposal_drafter,
--                               requirement_collector      (3 of the 4 seeded)
--     quality_assurance         ABSENT
--     ai.agent_handoff_targets  0 rows
--     ai.agent_verifiers        0 rows
--     definition_version        NULL on every row
--     last_validated_at         NULL on every row
--
-- Each line is a guarantee that does not hold where it matters:
--
--   * `quality_assurance` is the independent verifier ADM-82 makes mandatory —
--     *"QA is the independent verifier and no other agent may declare another
--     agent's work complete"*. On production it does not exist, so
--     `verdictFor` would refuse every verdict as coming from an undefined
--     agent, and the completion contract cannot be exercised at all.
--   * `agent_handoff_targets` is the table the trigger on `ai.handoffs` reads
--     to decide whether a handoff is permitted. Empty, it authorises nothing —
--     the boundary is not enforced there, it is simply absent.
--   * `agent_verifiers` is the producer-cannot-verify-itself binding. Empty,
--     no producer has a declared verifier, so no work can be completed through
--     a handoff.
--
-- WHY IT WAS SEEDED RATHER THAN MIGRATED, and why that reasoning does not
-- hold. Both seed.sql and check-record §16 give the same justification:
-- *"agent_handoff_targets references ai.agents(key), and migrations run before
-- this file, so an insert in the migration fails the foreign key against an
-- empty table."* That is true of a migration written **before** the agents
-- exist, and only of that. Inside one migration the order is ours to choose:
-- agents first, then the pairs that reference them. The foreign key is
-- satisfied three statements later.
--
-- Doc 21 §45 names the class this data belongs to — *"Seed & Reference Data:
-- roles/permissions, supported project states, payment states, defect
-- severities, **agent types**, model/provider catalog, policy defaults"* — and
-- states the requirement it must meet: *"Reference data is versioned and
-- environment-safe."* seed.sql is neither. A migration is both.
--
-- IDEMPOTENT ON PURPOSE. `on conflict do nothing` everywhere, so the three
-- rows already live on production keep the descriptions and disabled_reasons
-- they carry; only what is missing is added. Re-running changes nothing.
--
-- ACTIVATION IS NOT GRANTED HERE. `quality_assurance` arrives DISABLED, with
-- the reason it has always carried. ADM-82 granted which agents exist and
-- withheld their implementation; Phase 5 remains a separate decision. This
-- migration moves reference data to where it can be relied on. It turns
-- nothing on.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the roster ────────────────────────────────────────────────────────
--
-- Reproduced from supabase/seed.sql, which stops carrying it in the same
-- change. Model ids and cost caps per ARCHITECTURE.md §6.2 / §6.4;
-- max_cost_minor is in paise (500 = ₹5.00).

insert into ai.agents (key, display_name, description, autonomy_level, enabled,
                       default_model, default_effort, max_steps, max_cost_minor,
                       disabled_reason)
values
  -- Disabled by ADM-82: folded into the sales agent, which is layer 2 and not
  -- yet built. The definition is preserved rather than deleted, per the same
  -- decision, and `disabled_reason` is required by the constraint added in
  -- 20260814120002 — an agent off for an unrecorded reason is one somebody
  -- turns back on.
  ('lead_qualifier', 'Lead Qualifier',
   'Scores and tags inbound leads. Writes only to lead records; never contacts a client.',
   'L2', false, 'claude-sonnet-5', 'medium', 6, 500,
   'Folded into the sales agent by ADM-82; not an independent runtime agent. Definition preserved rather than deleted, per the same decision.'),

  -- The one agent that actually runs: reachable through AGENT_KEY in
  -- app/api/jobs/run/route.ts, and defined in src/modules/agents/registry.ts.
  ('requirement_collector', 'Requirement Collector',
   'Interviews a lead to gather structured project requirements. Proposes; a human sends.',
   'L1', true, 'claude-sonnet-5', 'medium', 20, 2000, null),

  -- Defined in the registry since F4 so the verification contract can exist:
  -- verdictFor refuses a verdict from an undefined agent, so with no QA
  -- definition the contract could not be exercised even in a test. Seeded
  -- DISABLED because a definition is not an activation — ADM-82 granted which
  -- agents exist and withheld implementation, and Phase 5 is a separate
  -- decision. This is the row production did not have.
  ('quality_assurance', 'QA',
   'Decides whether submitted work amounts to completion. Rejects a claim that lacks evidence, and may not write the work it reviews.',
   'L2', false, 'claude-sonnet-5', 'high', 12, 2000,
   'Defined for the verification contract (ADM-83). Activation is Phase 5 and a separate decision under ADM-82.'),

  -- Disabled by ADM-82, and its description corrected. It read "Drafts scope,
  -- timeline, and pricing" — and ADM-22 with business rules 08 section 5.1
  -- forbid an agent inventing a price at ANY level, stating that approval does
  -- not make it permissible. "Requires owner approval" did not rescue it. A
  -- disabled row still misinforms an Admin reading the registry, so the text is
  -- corrected whatever the agent's state.
  ('proposal_drafter', 'Proposal Drafter',
   'Drafts scope and timeline from a qualified lead. Pricing is never an agent''s: ADM-22 and business rules 08 section 5.1 forbid an agent inventing a price at any level, and approval does not make it permissible.',
   'L1', false, 'claude-opus-5', 'high', 12, 3000,
   'Folded into the sales agent by ADM-82; not an independent runtime agent. Definition preserved rather than deleted, per the same decision.')
on conflict (key) do nothing;

-- ── 2. who may hand work to whom ─────────────────────────────────────────
--
-- Mirrored from `handoffTargets` in src/modules/agents/registry.ts, because
-- Postgres cannot read TypeScript (ADM-83). check-record §16 proves the two
-- agree, and the trigger on ai.handoffs refuses any pair not listed here.
--
-- One pair. A verdict returns through the handoff it was given, so there is no
-- quality_assurance → requirement_collector pair and the trigger refuses one.
--
-- The foreign key that was said to make this impossible in a migration is
-- satisfied by the insert above.

insert into ai.agent_handoff_targets (from_agent, to_agent)
values ('requirement_collector', 'quality_assurance')
on conflict (from_agent, to_agent) do nothing;

-- ── 3. who may declare whose work complete ───────────────────────────────
--
-- Mirrored from `verification.verifiedBy` in the same registry, under the same
-- discipline: the handoff completion guard reads this table, and
-- scripts/verify-agent-definitions.mjs compares it to the registry. QA has no
-- row — nothing verifies the verifier (ADM-83), and an agent absent here
-- cannot have its work completed through a handoff at all.

insert into ai.agent_verifiers (producer, verifier)
values ('requirement_collector', 'quality_assurance')
on conflict (producer) do nothing;

-- ── 4. say so on the tables themselves ───────────────────────────────────
--
-- Both comments told a reader the rows were seeded, and one told them the
-- table was empty. Neither is true after this migration, and a comment that
-- describes a state the table has left is how the next person reaches the
-- wrong conclusion quickly.

comment on table ai.agent_handoff_targets is
  'Which agent may hand work to which, mirrored from src/modules/agents/registry.ts because Postgres cannot read TypeScript (ADM-83). check-record section 16 proves the mirror matches the definitions, and the trigger on ai.handoffs refuses any pair absent here. Installed by migration rather than seed since 20260821150000: seed.sql runs only under `supabase db reset`, so production had none of these rows and the boundary was absent rather than enforced.';

comment on table ai.agent_verifiers is
  'Who may declare a producer''s work complete - verification.verifiedBy from src/modules/agents/registry.ts, mirrored the way agent_handoff_targets mirrors handoffTargets (G-125, ADM-82). An agent absent here has no declared verifier and its work cannot be completed through a handoff at all. Installed by migration rather than seed since 20260821150000, for the reason recorded there; drift-checked by scripts/verify-agent-definitions.mjs.';
