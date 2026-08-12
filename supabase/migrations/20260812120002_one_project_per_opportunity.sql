-- ═══════════════════════════════════════════════════════════════════════════
-- One project per won deal, enforced where a second click cannot dodge it.
--
-- Audit finding D9. convertToProject already meant to be idempotent — it
-- reads projects.projects by opportunity_id and returns the existing one if
-- it finds it — but that read and the insert that follows are two statements
-- with a gap, and nothing in the database held the rule. Two clicks on a won
-- deal, or a double-submitted form, both read nothing and both insert: two
-- projects for one opportunity, and two client accounts, because the account
-- is created on the same path.
--
-- The same shape and the same answer as invoices_milestone_live_key
-- (20260809120002): an application check is the ordinary path and the index
-- is the one that holds under concurrency. ARCHITECTURE.md §5.4 says it
-- plainly — "enforced by unique constraints … rather than application checks,
-- because the database is the only reliable arbiter under concurrency".
--
-- Partial, on two counts. `opportunity_id is null` for a project raised
-- directly rather than converted from a deal, and there may be any number of
-- those. `deleted_at is null` because a soft-deleted project is not a
-- project — the same reasoning that makes invoices_milestone_live_key exclude
-- void invoices, so a conversion that was undone can be redone.
--
-- The caller keeps its pre-check: it is the cheap answer for the click that
-- is alone, and it returns the existing project rather than an error. What
-- changes is that the concurrent click now loses to the index instead of
-- winning a race nobody wanted it to enter, and the 23505 handler turns that
-- loss into the same answer the winner got.
-- ═══════════════════════════════════════════════════════════════════════════

create unique index if not exists projects_opportunity_key
  on projects.projects (opportunity_id)
  where opportunity_id is not null and deleted_at is null;

comment on index projects.projects_opportunity_key is
  'One live project per opportunity. Partial: a project raised without a deal has no opportunity_id, and a soft-deleted one frees the deal to be converted again.';
