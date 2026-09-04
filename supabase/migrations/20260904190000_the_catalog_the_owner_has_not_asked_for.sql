-- ═══════════════════════════════════════════════════════════════════════════
-- The catalog the owner has not asked for — G-206 (audit CN-10)
--
-- NO SCHEMA CHANGE. This migration writes down a refusal, in the place a
-- person about to build the thing would look.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The zero-trust audit filed CN-10 against `sales.approved_offers`: the table
-- holds a label, a condition, a percentage, an expiry and an active flag, and
-- has no eligibility rules, no quantity limit, no applicable project types,
-- no payment requirement and no versioning. Read as a gap in a data model,
-- that is a fair description of what is missing.
--
-- Read against the decisions this table was built under, it is a description
-- of the boundary, and the boundary is the feature.
--
-- ── what the owner actually decided ───────────────────────────────────────
--
-- ADM-22 (2026-08-13): *"There is no price catalog. Every price is quoted per
-- client by a human."* G-035 was closed by that decision rather than by code
-- — the thing it asked for must not exist.
--
-- ADM-98 (2026-09-02) overrode part of it, and named its own limit in the
-- same breath:
--
--   *"ONE active offer per organization (several would make the agent choose
--   between concessions, which is the judgement ADM-22 protected)."*
--
-- And what ADM-22 keeps: *"there is no price catalog and no list the agent
-- may quote from."*
--
-- ── so what CN-10 asks for is the override extending itself ───────────────
--
-- Eligibility rules, applicable types and quantity limits are not extra
-- columns on one offer. They are the machinery for HAVING SEVERAL and picking
-- between them, which is the exact judgement both decisions reserve for a
-- person — and the one ADM-98 named when it drew its own line.
--
-- An agent widening that boundary because a gap analysis called it a missing
-- field would be an agent granting itself the authority the owner declined to
-- grant. This one is not a task. It is ADM-100, and it is open.
--
-- ── the shape of the answer, if the owner says yes ────────────────────────
--
-- Recorded so the decision can be taken on something concrete rather than in
-- the abstract, and DELIBERATELY NOT BUILT:
--
--   * several live offers, with the agent choosing — needs a rule for which
--     one wins when two match, and that rule is commercial policy
--   * eligibility by project type or client history — needs the taxonomy
--     neither the documents nor the corpus provides
--   * a quantity limit across clients ("first ten") — needs a counter whose
--     race behaviour matters, because two clients can qualify at once
--   * versioning — the current design retires rather than deletes, so the
--     record of what was offered already survives; what versioning would add
--     is applying an OLD offer, which nobody has asked for
--
-- ── and the positive twin ─────────────────────────────────────────────────
--
-- An absence recorded and never checked is a comment. The test beside this
-- asserts the columns are gone AND that the one offer still works end to end,
-- because a feature deleted by accident also has no eligibility column.

comment on table sales.approved_offers is
  'The ONE concession an owner authored in advance (G-184, ADM-98). Deliberately not a catalog: ADM-98 grants exactly one active offer per organization because "several would make the agent choose between concessions, which is the judgement ADM-22 protected", and ADM-22 survives as "there is no price catalog and no list the agent may quote from". Eligibility rules, applicable project types, quantity limits and offer selection are NOT missing fields - they are the machinery for having several, which is an owner decision (ADM-100, open) and not a schema change. See migration 20260904190000.';

comment on column sales.approved_offers.discount_pct is
  'One percentage, capped 1-50 in DDL. Not a tier, not a band, and not one of several: the agent applies this or nothing. A second offer to choose between is ADM-100, which is open.';

comment on column sales.approved_offers.active is
  'Retired rather than deleted, so the record of what this agency once offered survives. This is ALSO why versioning is not a gap: what versioning would add beyond this is the ability to apply an OLD offer, which nobody has asked for.';
