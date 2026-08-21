-- ═══════════════════════════════════════════════════════════════════════════
-- A number the owner declined.
--
-- `crm.leads` has carried `score smallint check (score between 0 and 100)` and
-- `score_reasons jsonb` since the first CRM migration. **No code has ever
-- written either one** — not the ingest path, not qualification, not an agent,
-- not the importer, not a test.
--
-- **The seed did.** Two of its four leads carried `82` and `18`, with reasons
-- beside them: *"Budget confirmed"*, *"Decision maker engaged"*, *"Budget
-- below minimum engagement"*. So the columns were not quietly empty — they
-- were populated in every fresh environment, and the leads list renders
-- `· score 82` from them. An operator opening a new AgencyOS was being shown a
-- lead-scoring feature that does not exist, with reasoning it never did.
--
-- That is the same class as G-101 and the ADM-74 announcement: the system
-- telling an operator something untrue about itself. It was found by writing
-- the constraint below and watching `db reset` refuse the seed, which is a
-- better outcome than being told the seed was clean.
--
-- ADM-88 decided the columns must stay empty:
--
--   *"DECISION: no numeric lead score and no invented weights — the repository
--   has no approved scoring model and inventing one is out of scope."*
--
-- Granted 2026-08-17 for reactivation ordering, and stated about lead scoring
-- generally. `crm.reactivation_priority` is what was built instead: a
-- deterministic order over RECORDED FACTS — previously_quoted, then
-- previously_replied, then has_conversation, then cold — with no coefficient
-- anywhere in it.
--
-- ── why a decision needs a constraint and not just a decision ─────────────
--
-- An empty column is an invitation. The next thing to reach for it will be an
-- agent: ADM-82's sales agent qualifies leads, `score` is the obvious place to
-- put a qualification result, and it is typed, indexed, ranged 0–100 and
-- already selected by two queries — everything about it says *fill me in*. A
-- model asked to qualify a lead and offered a 0–100 column will produce a
-- number, and that number is precisely the "invented weight" ADM-88 refused.
--
-- Doc 19 §38: authority must not be reachable through language. A decision
-- recorded only in a plan is reachable through language. This one is now in
-- the DDL, where reaching for it fails.
--
-- ── retained rather than dropped, deliberately ────────────────────────────
--
-- Dropping the columns would express the same rule and lose two things: the
-- shape ADM-88 might one day be revisited with (a bounded score and a
-- structured reason for it, which is a better design than a bare number), and
-- the visible fact that somebody once intended this. A dropped column leaves
-- no trace of the decision; a constrained one carries it. Both hold zero rows
-- of data, so there is nothing to preserve either way — this is about what the
-- schema TELLS the next reader.
--
-- If ADM-88 is ever revisited, the reversal is one migration dropping two
-- constraints, and it will be reviewed as the business-rule change it is.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the rows this has to be true OF before it can be true ───────────────
--
-- **The scores are on production.** Two of its five leads carry `82` and `18`
-- with three invented reasons each — the seeded demo rows, `Northwind` and
-- `Unnamed enquiry`. So this was never only a fresh-environment problem: the
-- live leads list renders `· score 82` to an operator today, for a feature
-- that does not exist.
--
-- Found by running `supabase migration list --linked` before pushing and then
-- asking the live database whether the constraint below could hold. It could
-- not: `ALTER TABLE … ADD CONSTRAINT` is refused by existing rows, so without
-- this the push aborts here and the six migrations after it never apply.
--
-- `supabase/seed.sql` never reaches production — it is applied by `db reset`
-- and by nothing else — so how these two rows got there is not a question this
-- migration can answer. That they are there is one it has to handle.
--
-- **Cleared rather than exempted.** `payments_verified_together` carries a
-- grandfather clause for rows recorded under an older rule, and that was right
-- because inventing a verifier for them would have been a worse lie than the
-- hole. Nothing is invented by clearing a number nobody computed — and an
-- exemption here would preserve the only two rows that are actually being
-- shown to somebody.

update crm.leads
   set score = null, score_reasons = null
 where score is not null or score_reasons is not null;

alter table crm.leads drop constraint if exists leads_no_invented_score;
alter table crm.leads add constraint leads_no_invented_score
  check (score is null and score_reasons is null);

comment on column crm.leads.score is
  'Always null, by ADM-88: "no numeric lead score and no invented weights - the repository has no approved scoring model and inventing one is out of scope." Retained rather than dropped so the decision stays visible where somebody would reach for it. crm.reactivation_priority is what was built instead: an order over recorded facts, with no coefficient in it.';

comment on column crm.leads.score_reasons is
  'Always null. The justification half of the score ADM-88 declined; see crm.leads.score.';

comment on constraint leads_no_invented_score on crm.leads is
  'ADM-88 in DDL. A decision recorded only in a plan is reachable through language (Doc 19 section 38), and an empty 0-100 column beside a lead is an invitation an agent asked to qualify that lead will accept.';

notify pgrst, 'reload schema';
