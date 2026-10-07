# Phase 4 implementation log

Spec: the 7 PDFs in `phase 4/` and the master execution prompt. Matrix: `docs/phase-4-implementation-traceability.md` (rows dated 2026-09-26 are partly stale; see its 2026-10-06 section). Readiness: `docs/phase-4-production-readiness.md`.

Every unit below was proven against a real scratch Postgres (`scripts/apply-migrations-locally.sh`), and each control was red-proven (mangled, watched fail, restored).

## 2026-10-06 — Phase 5 cannot START before M2 is verified paid
- **Existed:** `projects.m2_verified_paid` gated Phase 5 *completion* only (`phase_readiness`). A module/feature task could be started on an unpaid M2.
- **Changed:** `projects.start_task` refuses `m2_not_verified` for a development task (module or feature attached). `projects.phase_five_gate_status` (the Admin Panel's "CAN PHASE 5 START?") now delegates to `m2_verified_paid`; it used to say `verified` on `status='paid'` alone, so the panel could say yes while the gate said no.
- **Files:** `supabase/migrations/20261031100001_*`, `src/modules/projects/task-doors-service.ts`, `scripts/verify-phase-five-gate.sql`, `tests/phase-five-cannot-start-before-m2-is-verified-paid.test.ts`; `scripts/verify-r2-roles-and-gates.mjs` now builds a verified-paid M2 fixture (NOT run here: needs PostgREST).
- **Result:** 10 live checks; red-proof fails with the gate removed.

## 2026-10-06 — A person cannot review what they produced (ADM-82 in the database)
- **Existed:** creator≠validator was TypeScript-only; both verdict doors admitted any signed-in writer, including the drafter.
- **Changed:** `produced_by` stamped by trigger on `ui_versions` / `prototype_artifacts`; `record_ui_version_qa_verdict` / `record_prototype_qa_verdict` refuse `self_review`.
- **Not changed (stated):** agent-vs-agent independence stays in `src/modules/agents/verification.ts` — both agents run as the service role, which the database cannot tell apart.
- **Files:** `20261031110000_*`, `scripts/verify-phase-four-qa-independence.sql` (9 checks, red-proven).

## 2026-10-06 — A QA defect has a Designer/Prototype fix and a retest
- **Existed:** `qa_changes_required` was a dead end for both UI versions and prototype builds; only a client change or Admin edit produced a next round (E2E steps 6–8, 23–25 could not run).
- **Changed:** `revise_ui_version` / `revise_prototype_build` accept a QA-failed row; a fix is a NEW version/build reviewed from scratch (FIXED ≠ VERIFIED, no inherited verdict); its own bounded counter (`ui_qa_fix_*`, `prototype_qa_fix_*`, default 3) does not consume the client's revision budget; at the limit the workspace escalates through the existing `project.revision_limit_escalated` event. Workflows + catalog subscriptions added.
- **Files:** `20261031120000_*`, `app/api/jobs/run/workflows.ts`, `src/lib/events/catalog.ts`, `scripts/verify-phase-four-qa-fix-loop.sql` (19 checks, red-proven), `tests/a-qa-defect-has-a-designer-fix-and-a-retest.test.ts`.

## 2026-10-06 — An Admin prototype EDIT goes back to the Prototype Agent
- **Existed:** `decide_prototype_admin('changes_required')` recorded a status and stopped (no event, no subscriber): E2E steps 26–27 impossible.
- **Changed:** emits `project.prototype_admin_decided`; `revise_prototype_build` accepts an Admin EDIT (shared prototype revision budget); the Admin-rejected build's deliverable is superseded (never shown to the client); `ui_prototype:reviseBuild` subscribes.
- **Files:** `20261031130000_*`, workflows, catalog.

## 2026-10-06 — Designer activates only for a named condition
- `src/modules/orchestrator/designer-activation.ts`: conditions A–G; the nine "must not activate" triggers refused and routed to their real owner; unknown triggers refused. The Task 2 routing handler records `activationReason` / `routingReason` on the handoff. `tests/designer-activates-only-for-a-named-condition.test.ts`.

## 2026-10-06 — Phase 4 SQL end-to-end
- `scripts/verify-phase-four-e2e.sql` (71 checks): start before Phase 3 (blocked), duplicate Task2Started, UI draft → QA defect → fix → retest → Admin EDIT → revision → Admin approve → share → client revision → re-approve → exact-version lock; prototype from the locked version only, broken route → fix, Admin EDIT → revision, client correction → exact final approval → Phase 4 complete once; M2 invoice once, claim/submission/underpayment/overpay-path, member and ops_admin cannot verify, duplicate UTR refused, Phase 5 start gate closed until fully verified.
- The AI calls themselves are not run here (no model/PostgREST stack); each step is the door the workflow calls.

## Blockers / manual dependency
- Figma write remains `MANUAL_FIGMA_REQUIRED` (read-only integration; no supported write API) — unchanged and truthful.
- See the readiness doc for the list of items needing an owner decision.
