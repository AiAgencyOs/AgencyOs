## The quotation offers a choice — G-166, ADM-97

The engine modelled **one proposal = one price**, and everything downstream assumed it: one approval amount, one money-floor resolution, one dispatched total, one recorded answer. A 2–3 plan offer breaks all four. Three data models were on the table (sibling proposals, plans in the `document` jsonb, or a plan-set table above proposals). **ADM-97 chose the third**, and the reasons are the same ones that ruled the others out.

### The model
- `sales.proposal_plan_sets` sits above proposals; each plan is an **ordinary member proposal** carrying `plan_set_id`, `plan_slot` (1–3), `plan_label`.
- **2–3 cap is a CHECK** (`draft_plan_set` refuses `bad_count`); a single plan is not a choice and a fourth is refused.
- **The recommended plan is required** (`bad_recommended`) — its amount selects the approver and is the client's default.

### The three tensions, resolved
1. **Live-version collision** (killed the sibling model): `proposals_live_version_key` re-keyed to `(opportunity_id, coalesce(plan_slot, 0))` — standalone quote is slot 0, members are slots 1–3 — plus a separate `plan_sets_live_key`. One live offer per deal across both kinds, enforced under the opportunity lock in both directions (`draft_plan_set` supersedes a live standalone; `draft_proposal` supersedes a live set).
2. **Murky arithmetic** (killed the jsonb model): never arises — each plan carries its own item-summed total.
3. **One approval, not three**: `submit_plan_set` raises **one** `approvals.request_approval` on the recommended member (subject_type `proposal`, subject a real proposal row, amount its total) — reusing the existing proposal money-floor policy, so **no new subject type and no new policy to seed**.

### Acceptance is a choice
`record_plan_set_choice` makes the chosen member accepted, its siblings **superseded (never deleted)**, the set closed, and fires `plan_set.accepted` carrying the chosen plan's id and total — so the close path and the WON arrow see one winner as if a single quote had been accepted. `record_plan_set_response` takes only `rejected`, to decline the whole offer.

`proposals_guard` and `draft_proposal` were **carried forward verbatim** with every edit marked; the standalone path is byte-identical to before. Five tenancy guards + `freeze_organization_id`; three event types (`plan_set.sent/accepted/rejected`) declared in the closed `core.event_types` registry.

## Testing
- **Unit**: `tests/the-quotation-offers-a-choice.test.ts` — 43/43 (10 suites): table structure, 5 tenancy guards + the `plan_set_id` guard, membership columns, the re-keyed live index, the guard's frozen columns and plan-set branches with standalone no-regression, submit's one-approval-on-recommended and its refusals, the choice minting one winner, the whole-offer decline, event registry, supersede logic, the 2–3 cap, schema-vocabulary parity, and notify pgrst + revoke/grant coverage.
- **Live**: `scripts/verify-plan-set.mjs` (`db:verify:planset`, wired into `verify.yml`) — drafts a 2-plan and a 3-plan set on a clean DB; proves the 2–3 cap and required recommendation (**self-red-proving**: drop the control and the refusal flips to `created`, turning the run red), that a set and a standalone cannot both be live, one approval at the recommended amount, ADM-07's send gate, a choice minting one winner with siblings superseded and one `plan_set.accepted`, and the whole-offer decline.
- typecheck 0, lint 0. The live verifier runs in **CI** — no Postgres was reachable in the dev environment.

## Note on stacking
This branch is stacked on **G-222 (#395)**, which is not yet merged. Until #395 lands, this PR's diff includes G-222's commit (`28e50d7`); once #395 merges to `main`, the diff narrows to G-166 alone. Merge #395 first.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
