-- ═══════════════════════════════════════════════════════════════════════════
-- An agent that cannot run says why.
--
-- Gap G-125, decisions ADM-82 and ADM-83.
--
-- `ai.agents` has always held deployment state — enabled, autonomy, model,
-- ceilings — and never held any link to what an agent *is*. `ARCHITECTURE.md`
-- §6.2 names `src/modules/agents/registry.ts` as the architectural half, and
-- until this change that file did not exist.
--
-- The consequence was live and measurable: `supabase/seed.sql` registers three
-- agents, all enabled, and the job runner reaches exactly one of them by a
-- hard-coded `AGENT_KEY`. Two were enabled and unreachable. An Admin reading
-- the registry saw three working agents and had one.
--
-- ── the three columns ADM-83 granted ──────────────────────────────────────
--
-- `definition_version` and `last_validated_at` record that a row was checked
-- against a specific revision of the registry. `disabled_reason` records why
-- an agent is off — because an agent disabled for an unrecorded reason is one
-- somebody turns back on.
--
-- The constraints are the point rather than the columns. ADM-83 asked that a
-- validation claim cannot outlive its definition and that a disabled agent must
-- explain itself, and both are cheap to state here and impossible to forget
-- later.
-- ═══════════════════════════════════════════════════════════════════════════

alter table ai.agents
  add column if not exists definition_version text,
  add column if not exists disabled_reason    text,
  add column if not exists last_validated_at  timestamptz;

comment on column ai.agents.definition_version is
  'Which revision of src/modules/agents/registry.ts this row was last validated against (ADM-83). Null means never validated, which is honest rather than alarming - check-record section 14 is what actually refuses an enabled row with no definition.';

comment on column ai.agents.disabled_reason is
  'Why this agent is off. Required when enabled is false and forbidden when it is true (ADM-83): an agent disabled for an unrecorded reason is one somebody turns back on.';

comment on column ai.agents.last_validated_at is
  'When the row was last checked against the registry. Moves with definition_version and never alone.';

-- A disabled agent explains itself; an enabled one has nothing to explain.
alter table ai.agents drop constraint if exists agents_disabled_reason_together;
alter table ai.agents add constraint agents_disabled_reason_together
  check (enabled = (disabled_reason is null));

-- A validation claim is a version *and* a time, or neither. Half of one is a
-- row claiming it was checked without saying against what, or against what
-- without saying when - and both read as validated to anybody scanning.
alter table ai.agents drop constraint if exists agents_validation_together;
alter table ai.agents add constraint agents_validation_together
  check ((definition_version is null) = (last_validated_at is null));

-- ═══════════════════════════════════════════════════════════════════════════
-- Reconciling the two agents that were enabled and unreachable
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ADM-82 folded lead qualification and proposal drafting into a single `sales`
-- agent, which is layer 2 and not yet built. So neither of these is an
-- independent runtime agent, and neither is to be *deleted*: the decision says
-- historical definitions are preserved.
--
-- Disabling with a recorded reason is the disposition that is true in both
-- directions — the row still says what it was, and now also says why it is off.
--
-- `proposal_drafter` needs one thing more. Its description reads "Drafts scope,
-- timeline, and pricing from a qualified lead. Requires owner approval." The
-- pricing clause claims an authority ADM-22 forbids and 08 §5.1 makes absolute,
-- and "requires owner approval" does not rescue it: §5.1 says these do not
-- become permissible at a higher level. **A disabled row still misinforms an
-- Admin reading the registry**, so the text is corrected whatever its state.

update ai.agents
   set enabled         = false,
       disabled_reason = 'Folded into the sales agent by ADM-82; not an independent runtime agent. '
                         'Definition preserved rather than deleted, per the same decision.'
 where key = 'lead_qualifier'
   and enabled;

update ai.agents
   set enabled         = false,
       disabled_reason = 'Folded into the sales agent by ADM-82; not an independent runtime agent. '
                         'Definition preserved rather than deleted, per the same decision.',
       description     = 'Drafts scope and timeline from a qualified lead. Pricing is never an agent''s: '
                         'ADM-22 and business rules 08 section 5.1 forbid an agent inventing a price at any '
                         'level, and approval does not make it permissible.'
 where key = 'proposal_drafter';

-- ── why this is an UPDATE and not a seed change alone ────────────────────
--
-- `seed.sql` is corrected in the same commit, which fixes every future
-- `db reset`. This statement is what fixes an environment that has already
-- been seeded — including any that is running today. Both are needed: the seed
-- alone would leave existing deployments claiming pricing authority, and the
-- update alone would be undone by the next reset.
--
-- Idempotent by construction: `lead_qualifier` is guarded on `enabled` so a
-- second run changes nothing, and `proposal_drafter`'s update is a fixed value.
