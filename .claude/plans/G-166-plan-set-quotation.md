# G-166 — The 3-plan quotation (plan-set table)

Close G-166: a HIGH-complexity quote with a genuine feature ladder can offer 2–3
priced plans the client chooses between. The engine today models ONE proposal =
one price and everything downstream assumes it. This adds a **plan-set above
proposals** (the model chosen for ADM-97), threads the set through approval,
dispatch and acceptance, and records the choice by minting one winner and
superseding its siblings.

## Owner decisions locked (ADM-97, this session)
- Data model: **plan-set table above `proposals`** (not jsonb, not free siblings).
- Plan count: **hard cap 2–3** (a CHECK refuses a 4th).
- Recommended plan: **required** — every set names one; its amount selects the approver and is the client's default.
- Approval: owner approves the **set** (one request, recommended plan's amount).
- Acceptance: client **picks one** → chosen proposal `accepted`, siblings `superseded`, set closed.

## The core tension and how it is resolved
`proposals_live_version_key` (partial unique index, migration 20260813120019:176)
enforces **one live proposal per `opportunity_id`** where status in
(draft, pending_approval, approved, sent). Three plans share one opportunity, so
they would collide. Resolution:
- Re-key `proposals_live_version_key` to `(opportunity_id, coalesce(plan_slot, 0))`
  — a standalone quote is slot 0; the three plans are slots 1/2/3. A standalone
  quote and a plan-set can never both be live on one opportunity because the
  set's functions supersede the other kind first (mirroring `draft_proposal`).
- New `plan_sets_live_key` on `sales.proposal_plan_sets (opportunity_id)` where
  status in (draft, pending_approval, approved, sent) — one live SET per opportunity.

## New migration (prose-header style, matches 20260906190000)
`supabase/migrations/20260907150000_the_quotation_offers_a_choice.sql`

1. **`sales.proposal_plan_sets`** — org-scoped, above proposals:
   - `id, organization_id, opportunity_id (FK sales.opportunities), requirement_version_id (FK crm.requirement_versions on delete set null), status (draft|pending_approval|approved|sent|accepted|rejected|superseded|lapsed), recommended_proposal_id (FK sales.proposals on delete set null), approval_request_id, conversation_id, sent_at, sent_message_ref, decided_at, chosen_proposal_id, created_by, created_at, updated_at`
   - RLS enable + org-scoped select/write policies (copy the sales table pattern).
   - **Tenancy guards (required or db:verify:tenancyguards fails):**
     `enforce_parent_org('opportunity_id','sales.opportunities')` AND
     `enforce_parent_org('requirement_version_id','crm.requirement_versions')`
     (one per org-scoped FK) + `freeze_organization_id` + `set_updated_at`.
   - Grants: select to authenticated/service_role; insert/update/delete same.

2. **Alter `sales.proposals`**: add `plan_set_id uuid references sales.proposal_plan_sets(id) on delete set null`, `plan_slot int check (plan_slot between 1 and 3)`, `plan_label text`. Add `plan_set_id` to `enforce_parent_org` coverage (its parent is same-org by construction; freeze not needed as it's nullable-set-once — assert via guard). Re-key the live index (above).

3. **Re-define `sales.proposals_guard()` VERBATIM from its live definition** (20260824190000:23) with ONE marked edit: `plan_set_id`, `plan_slot`, `plan_label` join the frozen column list (frozen outside draft, like `document`). Hard project norm — carry forward, mark the edit.

4. **`sales.draft_plan_set(p_opportunity_id, p_requirement_version_id, p_plans jsonb, p_recommended_slot int, p_created_by)`** — security definer, `set search_path=''`:
   - Locks the opportunity `for update` (same serialization as `draft_proposal`).
   - Refuses `won|lost` (settled), refuses `p_plans` count < 2 or > 3, refuses `p_recommended_slot` not in the set.
   - Supersedes any live standalone proposal AND any live plan-set on the opportunity (cancel their approval requests via `approvals.cancel_request`, mirroring draft_proposal:570).
   - Inserts the set row (draft), then inserts 2–3 `sales.proposals` rows (draft, slot 1..n, sharing `requirement_version_id`), sets `recommended_proposal_id`.
   - Returns `(status, plan_set_id)`.

5. **`sales.submit_plan_set(p_plan_set_id, p_requested_by, p_summary)`** — mirrors `submit_proposal` (20260813120019:734):
   - Gates: set is draft; every plan has `total_minor > 0`; recommended plan set.
   - One `approvals.request_approval` with the **recommended plan's `total_minor`** as the approver-selecting amount; audience internal; payload carries all plan totals + recommended id.
   - Set → pending_approval; stores `approval_request_id`. (Plans stay draft, moved by the set's decision sync — or move plans to pending_approval too; decide in code to keep proposals_guard honest. Plan: move all plans to pending_approval so their documents freeze with the set.)

6. **`sales.sync_plan_set_decision(p_plan_set_id)`** — mirrors `sync_proposal_decision` (20260813120019:862): approved→set+plans approved; rejected/changes_requested→set+plans back to draft.

7. **`sales.send_plan_set(p_plan_set_id, p_conversation_id, p_message_ref)`** — mirrors `send_proposal` (925): gate status=approved; set+plans → sent; emit `plan_set.sent` with all plan totals + recommended.

8. **`sales.record_plan_set_choice(p_plan_set_id, p_chosen_proposal_id, p_contact_id, p_note)`** — the crux, extends acceptance:
   - Gate: set status=sent; chosen proposal belongs to the set; not expired (valid_until).
   - Chosen proposal → `accepted` (via the existing per-proposal path where possible), siblings → `superseded`, set → `accepted`, records `chosen_proposal_id, decided_at, responded_by_contact_id`.
   - Emits `plan_set.accepted` (chosen id + amount) so the opportunity/close path fires on the winner exactly as a single accepted proposal does today.
   - A rejection of the whole set: `record_plan_set_response(...,'rejected')` → set+plans rejected, emit `plan_set.rejected`.

9. `comment on` every function and the table. Grants: `revoke all ... from public; grant execute ... to authenticated, service_role`. `notify pgrst, 'reload schema';`

## TypeScript
- `src/modules/sales/schema.ts`: add `PLAN_SET_STATUSES`, a `planSetSchema` (2–3 plans, recommended required), extend proposal schema with `planSetId/planSlot/planLabel`. Mirror the `.nullish().catch(null)` document norms.
- Wherever the sales module reads/drafts proposals for the agent path, add the plan-set producer (draft_plan_set) — keep parity with the existing single-proposal call sites.

## Verification (discipline)
- **Unit test** `tests/the-quotation-offers-a-choice.test.ts`: migration structure (table, both guards, re-keyed live index, guard carries the new frozen columns, CHECK 2–3, recommended required, no delete-of-proposals in choice), state-machine assertions, silent-vs-present.
- **Live verifier** `scripts/verify-plan-set.mjs` (new `db:verify:planset`), wired into `.github/workflows/verify.yml`: draft a 2-plan and a 3-plan set on a clean DB; submit → one approval at the recommended amount; approve; send; client picks plan 2 → plan 2 accepted, plan 1/3 superseded, set accepted, event emitted; a 4th plan refused; a set with no recommended refused; a standalone quote and a set cannot both be live (one supersedes the other). **Red-proof**: drop the CHECK / drop the sibling-supersede and show the verifier fails.
- These run in CI (no local Postgres reachable — same constraint as G-222).

## Bookkeeping (check-record.mjs will re-derive all of it)
- `docs/roadmap/roadmap.json`: G-166 status → CLOSED (class C→A), ADM-97 → granted (blocks G-166, the plan-set decision + 2–3 cap + recommended-required); gapTotals byClass A +1 / C −1; baseline migrations +1, testFiles +1, testSuites/tests/testsPassing += new counts, liveVerificationScripts 71→72; adminDecisions granted 93→94, open 6→5.
- `AGENCYOS_MASTER_DEVELOPMENT_PLAN.md` §4.8: class A/C counts, decision count/split; §10: add G-166 "(this change)" row; convert G-222's "(this change)" to `28e50d7 (PR #395)` **only once #395 is merged** (else leave it — check-record tolerates the newest merge outstanding).
- `README.md`: gap count unchanged (211 total; class shift only).
- ADM-97 recorded in both roadmap.json and the plan (check-record §2 needs both).

## Sequence
1. Migration (table + guards + re-keyed index + guard re-def + 6 functions).
2. schema.ts additions.
3. Unit test → run in isolation (node harness, not tsx).
4. Live verifier + verify.yml wiring + package.json script.
5. typecheck + lint.
6. Bookkeeping + check:record consistency (the §5 test-run hangs locally on ai-extraction socket EPERM — CI authoritative).
7. Report what passed / what only CI can run.

## Notes / risks
- The AGENTS.md generate-agent-files block may reappear uncommitted; commit it with the work.
- `plan_set_id` on proposals is nullable (slot 0 standalone quotes keep working untouched) — zero regression to the existing single-proposal path is a hard requirement; the unit + live tests must prove a standalone quote still drafts/submits/sends/accepts exactly as before.
- Keep the whole thing on a new branch off main; one PR (G-166).
