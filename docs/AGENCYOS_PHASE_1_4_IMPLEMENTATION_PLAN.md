# AgencyOS — Business Phase 1–4 Implementation Plan

Companion to [`AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.md`](AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.md) / `.json`. This plan follows the mandated dependency order: **Phase 1 gaps → Phase 1 validation → Phase 2 gaps → Phase 2 validation → Phase 3 gaps → Phase 3 validation → Phase 4 gaps → Phase 4 validation**. No step here should begin until every step above it in this same phase is done and validated, and no phase should begin until the prior phase's validation is green.

This plan is **not yet authorized for execution** — Mode A (audit) is complete; implementation begins only after "PROCEED."

---

## Step 0 — Before any phase work: land the already-known financial fix

This isn't new work — it's six existing, reviewed, unmerged PRs (#524–#530) already sitting in this repo, three of which (via #530) fix a live financial-correctness bug and a payment-verification outage on `main`. Merging these has no dependency on the rest of this plan and should not wait for it.

- **Files/modules:** `src/modules/finance/service.ts`, `src/modules/crm/handlers.ts`, two migrations in #530, plus the orchestrator/admin/test work in #524–#529.
- **Database changes:** two additive migrations already written and live-tested (`20260929100000_the_gate_read_the_wrong_milestone.sql`, `20260929110000_a_receipt_needs_a_grant_too.sql`).
- **Security risks:** none new — these are correctness fixes to existing logic, not new surface.
- **Action before merging:** audit real production invoice records for any M1/M2 invoices already issued under the buggy position-index logic, and correct them if wrong. This is a financial decision for a human, not something to automate.

---

## PHASE 1 — Lead-to-Close

### Dependency-ordered gap list

1. **Lead routing (1.3)** — build first; nothing downstream depends on it, but qualification/first-response quality benefits from correct assignment existing early.
   - *Files:* new `src/modules/crm/routing.ts`; extend `crm.leads.assigned_to` writer.
   - *DB:* none required if `assigned_to` is reused; consider an `assignment_reason` column for audit.
   - *Tests:* real behavioral test per routing signal (service/source/language/availability/priority/region).

2. **Inbound channel expansion (1.1)** — web-form, email, Facebook Lead Ads ingestion routes.
   - *API changes:* new `app/api/webhooks/{web-form,email,facebook-leads}/route.ts`, mirroring the WhatsApp webhook's dedupe/identity-mapping pattern.
   - *DB:* `crm.leads.source` CHECK already allows these values — no migration needed, just wire the missing producers.
   - *Tests:* one real behavioral test per channel, mirroring `tests/crm-ingest.test.ts`'s pattern (not regex).

3. **Identity resolution / dedup classifier (1.2)** — depends on nothing above, but should land before routing is trusted for existing clients.
   - *DB changes:* new `crm.identity_resolutions` table or extend `crm.leads` with a resolution-outcome column (NEW_IDENTITY/EXISTING_LEAD/EXISTING_CLIENT/REACTIVATED_LEAD/POSSIBLE_DUPLICATE_REVIEW).
   - *Security risk:* never auto-merge — this constraint is already respected by the codebase's existing manual-merge-only design; preserve it.

4. **Extend LEAD_INTENTS / objection kinds (1.7, 1.22)** — additive enum extensions, low risk.
   - *DB:* extend the CHECK constraints on `crm.conversation_messages.intent` and `sales.objections.kind`.
   - *Agent changes:* extend the closed vocabulary in the relevant job workflow's schema and prompt.

5. **Discount audit trail + negotiation limit enforcement (1.27, 1.32)**.
   - *DB:* new `sales.discount_decisions` table (original amount/discount/reason/approver/expiry/final amount).
   - *Backend:* wire `negotiation_max_rounds` to actually stop the loop, not just store the config.
   - *Admin Panel:* discount history view.

6. **Payment structure catalog (1.28)** — depends on the Phase 2 payment-structure model (`src/modules/projects/payment-structure.ts`) already existing; extend it to be negotiable pre-WON, not just Phase-2-locked.

7. **Structured commercial-strategy capture (1.15), value-negotiation schema (1.24), feature/timeline objection feasibility checks (1.29, 1.30)** — lower priority, prompt/schema refinements rather than new architecture.

### Phase 1 validation gate

Run before starting Phase 2:
- UNIT: routing, identity-resolution, discount-audit-trail logic.
- INTEGRATION: each new inbound channel end-to-end (webhook → lead created → visible in queue).
- AGENT: sales job workflows still pass schema validation with extended enums.
- POLICY/PERMISSION: discount decisions respect `negotiation_max_discount_pct`.
- E2E: at least one full lead→WON path exercised live (extends the existing `tests/lead-conversion.test.ts` pattern), covering the new routing/dedup/discount pieces.

---

## PHASE 2 — Onboarding + M1 + Kickoff

**Do not start until Step 0 (PR #530) is merged** — Phase 2's own financial steps (2.7, 2.10) are broken until then.

### Dependency-ordered gap list

1. **PM assignment (2.13)** — foundational; steps 14, 22 depend on knowing who the PM is.
   - *DB:* add `project_manager_id uuid references core.users(id)` to `projects.projects` (additive).
   - *Backend:* set at onboarding-record creation (2.3); surface in onboarding checklist (2.21).

2. **Specialist agent assignment (2.14)** — depends on PM assignment existing as a precedent pattern.
   - *DB:* new `projects.project_members` table (role, agent/user reference, restricted-access scope) — replacing the current retroactive `listProjectTeam()` derivation.
   - *Security risk:* ensure RLS scopes each specialist's visibility correctly; this is a new access-control surface, review carefully.

3. **Invoice-to-client communication (2.8)** — depends on nothing above; can land any time after Step 0.
   - *Events/Jobs:* new subscriber on `invoice.issued`, following the exact pattern of the 8 existing PM milestone-announce handlers in `src/modules/crm/handlers.ts`.
   - *WhatsApp:* blocked in practice by BLK-003/BLK-007 (no production channel) — build the code path now, verify it fires correctly once a channel exists; don't fake a channel.

4. **Kickoff package composer (2.22)** — depends on requirements/scope/payment-plan already being importable (already true).
   - *Backend:* new `composeKickoffPackage(projectId)` assembling the fields named in the business spec from existing tables — presentation-layer only, no new tables needed beyond maybe a `projects.kickoff_packages` snapshot table for audit history.

5. **Onboarding checklist "required" configuration (ADM-108, 2.3/2.21)** — this is a business-policy decision, not a code gap: someone needs to decide which of the 17 checklist items are actually required per project type, then configure it. Flag to the user rather than guessing.

6. **Client identity dedup at onboarding (2.2), asset-collection vocabulary alignment (2.16), scope 'future' category (2.19), kickoff-gate/payment-exception interplay (2.11)** — smaller, independent fixes.

### Phase 2 validation gate

- DATABASE: confirm `phase_five_gate_status`/`generateFirstMilestoneInvoice`/`generateM2Invoice` (post-#530) against a live-Postgres run for a full M1 cycle.
- API/PERMISSION: PM/specialist assignment RLS reviewed.
- E2E: full onboarding→kickoff flow driven live, extending `tests/phase4-full-pipeline-e2e.test.ts`'s harness backward to cover onboarding, not just Phase 4.

---

## PHASE 3 — UI Theme/Color Lock

**Do not start until Phase 2's PM/specialist assignment exists** — Phase 3 steps reference "PM presents to client," which currently has no enforced role check.

### Dependency-ordered gap list

1. **Fix the design revision loop (3.13)** — highest priority in this phase; it's a broken, not just missing, mechanism.
   - *Events/Jobs:* add a subscriber for `project.design_revision_opened` that re-invokes the `DESIGN_DIRECTIONS` workflow with a revision-aware idempotency key (not the unchanged `design_context_version` hash).
   - *Tests:* a real behavioral test proving a revision request produces a genuinely new `theme_options` row (red-proof: confirm it fails today first).

2. **Wire screen-content-definition writers (3.3)** — connect the existing `required_sections`/`dependencies` columns to either the `SCREEN_INVENTORY` job or a new admin form.

3. **User flow mapping (3.4)** — new capability, no existing scaffolding.
   - *DB:* new `projects.user_flows` table (screen sequence, flow type: primary/alternate/edge, permission scope).
   - *Agent:* extend the UI Designer's input package (see #6 below) to produce this.

4. **UI/UX direction analysis as a distinct, recorded step (3.5)** — depends on #6 (input package) to have real content to analyze.

5. **Assemble the real UI input package (3.1)** — feed `qualification_coverage`'s platform/design_expectations/existing_assets content into the model prompt, not just its hash. This unblocks #3 and #4 doing a better job.

6. **Color-option alternatives (3.7)** — extend `DESIGN_DIRECTIONS` (or a follow-up job) to produce 2–3 palettes per direction, not one; add the missing write path.

7. **Client-facing design/theme portal page (3.11)** and **PM-role enforcement on client presentation (3.11)** — depends on Phase 2's PM assignment (#1 above).

8. **Structured internal-review checklist (3.9)** — replace/augment the binary passed/changes_required with the 6 named dimensions.

### Phase 3 validation gate

- UNIT: revision-loop subscriber, color-alternatives generator.
- INTEGRATION: full theme-generate → revise → re-generate cycle, live.
- E2E: screen inventory → theme/color options → internal review → admin review → client presentation → client selection → lock, driven end to end against a live database.

---

## PHASE 4 — Full UI + Prototype + M2

**Do not start until Step 0 is merged** (4.25/4.26 depend on it) **and Phase 3's revision loop is fixed** (4.13's UI revision loop reuses the same class of event-subscription pattern that's broken in Phase 3).

### Dependency-ordered gap list

1. **Confirm Step 0's fix resolves 4.25/4.26** — validation-only, no new code (assuming PR #530 merges as-is).

2. **Responsive-variant tracking (4.6)** — foundational for both design (4.4) and prototype (4.16/4.17) states; build once, reuse.
   - *DB:* extend `UI_VERSION_SCREEN_STATES`-adjacent schema with a `responsiveVariant` dimension, or a parallel `projects.screen_responsive_coverage` table.

3. **Accessibility criteria (4.7)** — depends on nothing above; can land in parallel with #2.
   - *DB/Schema:* extend Design QA and Prototype QA verdict schemas with an accessibility checklist.

4. **Expand screen states beyond the current 5 (4.5)** — this is a deliberate scope decision (documented in the schema), not obviously a bug. Flag to the user: does the business actually want the full 12+ state list tracked, or is the 5-state MVP intentional? Don't expand this without confirming it's wanted, since it was a documented, reasoned narrowing.

5. **Requirement/feature-to-screen traceability (4.8)** — extend `buildUiCoverageMatrix` with a `projects.scope_item_screen_links` junction table.

6. **Named lifecycle events (4.14, 4.24, and the P4-INFRA-04 mapping already built in unmerged PR #527)** — low-risk, additive; reuse #527's mapping-table pattern instead of duplicating it.

7. **Prototype feedback classification (4.22)** — mirror the UI-version classifier (4.12) for prototypes instead of reusing the coarser generic deliverable status.

8. **Development handoff package (4.27)** — the capstone artifact; depends on everything above being real, since it bundles scope/UI/design-system/prototype/approvals/M2-gate state. Build last in this phase.

9. **APK/native prototype pipeline (4.16)** — flag as a genuine external dependency (Apple/Google developer accounts, signing credentials) requiring the user's action before any code here is useful; don't build blind.

10. **Figma write capability (4.2)** — flag as a genuine platform limitation (no supported write API the way the business spec assumes); a Figma plugin or their MCP server would be new infrastructure, not a config step. Needs a product decision on whether to pursue this at all before more work goes here.

### Phase 4 validation gate

- Full DB/API/AGENT/POLICY/PERMISSION/EVENT/E2E suite per the original spec.
- The full Phase 1→4 E2E test (below) is the actual gate for declaring Phase 4 done — not this phase's validation alone.

---

## FULL AUTOMATED PHASE 1→4 E2E TEST

Only after all four phases pass their own validation gates: extend the existing live-Postgres harness (`tests/support/live-postgres.ts`, currently only covering Phase 4's pipeline in unmerged PR #530) backward to cover the entire Business Phase 1→4 journey in one continuous session — lead capture → qualification → quotation → negotiation → WON → onboarding → M1 → kickoff → theme/color lock → full UI → prototype → M2 → handoff. This is a substantial harness-extension effort, not a quick addition; scope it as its own work item once Phase 4's validation gate is green.

## MANUAL TESTING PACKAGE FOR OWNER

Once the automated E2E passes, produce a manual test script for the owner covering exactly the points this audit found the system does **not** or **cannot** verify itself: the two external blockers (WhatsApp/email channel activation for kickoff and invoice messages — BLK-003/BLK-007; Figma write capability), the ADM-108 checklist-required-items configuration decision, and a visual/UX walkthrough of the client-facing surfaces (portal, prototype view) that no automated test in this repo currently exercises.

**Phase 1–4 must not receive FINAL COMPLETE status until this manual package has been run and its blocking findings resolved**, per the original instructions.
