# Phase 5 implementation traceability

Source: the 15 PDFs in `phase 5/` (not committed; local). Status legend: EXISTS · PARTIAL · MISSING · NOT_REQUIRED · MANUAL_EXTERNAL. Evidence is a migration/test/script that was run, never a claim. Last updated 2026-10-06 (this session's slice).

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P5-GATE-01 | 01 | Phase 5 cannot start before Phase 4 complete + M2 Admin-verified | EXISTS | `20261031100000`, `20261031150000` (`start_phase_five`, `start_task`); `scripts/verify-phase-five-gate.sql`, `verify-phase-four-e2e.sql` (red-proven) |
| P5-GATE-02 | 01 | `invoice.paid` → Phase 5 ready (event-driven, idempotent) | EXISTS | `projects:startPhaseFive` handler + catalog + job route; `tests/phase-five-foundation.test.ts`. Handler itself not run end-to-end (needs the job runner) |
| P5-BASE-01 | 01 | Development baseline: exact locked UI version, approved prototype build, active scope; never "latest"; immutable | EXISTS | `projects.development_baselines` + freeze trigger; E2E asserts v4 / build 4 |
| P5-BASE-02 | 01 | Baseline names repository + base commit | PARTIAL | `repository_id` linked when a repo exists, `base_commit` nullable and never invented; nothing populates `base_commit` yet |
| P5-PLAN-01 | 01/03 | Technical development plan, task graph, parallel-safe detection, per-task acceptance criteria | PARTIAL | `projects.tasks` + `task_dependencies` + `start_task` (requirement + dependencies + baseline). No plan entity, no file-conflict detection, no acceptance-criteria column. **Not built.** |
| P5-AGENT-01 | 04–14 | Eleven specialists defined | EXISTS (definitions) | `src/modules/agents/registry.ts`, `20261031190000` (installed DISABLED, verified by QA only); `tests/agent-registry.test.ts` |
| P5-AGENT-02 | 04–14 | Specialists actually run (workflows, repo binding, tools) | MISSING | no `development.*` job kind, no tool bound. Needs a funded model key + repo/CI binding (MANUAL_EXTERNAL) |
| P5-ORCH-01 | 03 | Orchestrator Phase 5 routing, execution envelope, tool gating | MISSING | only Task 2 routing exists (`src/modules/orchestrator`) |
| P5-BUILD-01 | 09 | Build = deliverable kind `build` with exact commit; no production target | EXISTS | `20261031160000` (`target_env` CHECK, `no_commit`); E2E |
| P5-BUILD-02 | 09 | Build pipeline, environment fingerprint, artifact hash, logs | PARTIAL | `environment_fingerprint` column exists; no pipeline, no hashing, no logs. **Not built** |
| P5-BUILD-03 | 09 | Shared build never rewritten | EXISTS | `deliverables_guard` (artifact immutable) + `freeze_build_lineage`; E2E |
| P5-REVIEW-01 | 11 | Independent review of the exact commit; developer cannot approve own code | EXISTS | `20261031170000`; E2E (self_review) red-proven |
| P5-REVIEW-02 | 11 | Critical/high finding blocks; stale after a new commit; reviewer who edits needs a second reviewer | EXISTS | `blocking_finding`, `stale`, `needs_second`; E2E red-proven |
| P5-QA-01 | 10 | Independent development QA of the exact build; creator ≠ validator | EXISTS | `record_build_qa_verdict` (`self_review`); E2E red-proven |
| P5-QA-02 | 10 | Machine-readable test results, flaky tracking, coverage mapping | PARTIAL | `qa.test_runs` exists; no flaky table, no requirement→test map. **Not built** |
| P5-DEFECT-01 | 12 | FIX_READY ≠ VERIFIED; fixer cannot verify; fix claim keeps a blocker blocking | EXISTS | `20261031140000`; `scripts/verify-phase-five-defects.sql` (11 checks, 2 red-proofs) |
| P5-DEFECT-02 | 12 | NOT_REPRODUCED / NEEDS_EVIDENCE explicit | EXISTS | same |
| P5-DEFECT-03 | 12 | Defect ↔ build/task lineage, fix-build link, S0–S4 | PARTIAL | `qa.defects.build_id/task_id/deliverable_id` exist; severities remain blocker/major/minor/trivial |
| P5-INTEG-01 | 08 | Six health states; CONFIGURED ≠ VERIFIED; mock ≠ verified; adapter-only verification | EXISTS (data + doors) | `20261031200000`; `scripts/verify-phase-five-integrations.sql` |
| P5-INTEG-02 | 08 | Real adapter checks that call `record_integration_check` | MISSING | no adapter calls the door yet (MANUAL_EXTERNAL credentials) |
| P5-COND-01 | 07/13 | Mobile / Refactor NOT_REQUIRED with recorded reason | EXISTS | `phase_five_agent_state` seeded at start; E2E |
| P5-FEED-01 | 01/02 | Client feedback on a build in 7 categories; BUG→defect; NEW_FEATURE→Change Request, never a defect | EXISTS | `20261031180000`; E2E (+ CHECK) |
| P5-FEED-02 | 01 | AI classification of feedback (PM agent) | MISSING | classification is a person's door; the classifier workflow for builds is not built |
| P5-APPR-01 | 01 | Client final approval bound to the exact build; later builds invalidate it | EXISTS | `phase_readiness(…,5)`: approved build must be the newest; E2E |
| P5-DOD-01 | 01 | Phase 5 DoD: baseline, approved final build, no unverified blocker/major, tasks done, M2 | EXISTS | `phase_readiness` rewrite; E2E |
| P5-HAND-01 | 14/01 | Phase 6 QA intake: exact build/commit, reviews, tests, defects, integrations, limitations, high-risk areas | EXISTS | `20261031210000`; E2E (frozen, independent-verification flag) |
| P5-DOC-01 | 14 | Documentation agent continuously, stale detection, doc-status vocabulary | MISSING | `docs/phase-5-*` written by hand this session; no agent, no doc table |
| P5-PM-01 | 02 | PM5-M01…M07 messages with delivery history | PARTIAL | M01 (Task 3 start), M02 (build shared), M03 (feedback received), M04 (final build approved) and the pre-existing Task 3 complete, via `crm:announce*` handlers (`20261031220000`, `tests/phase-five-foundation.test.ts`). Internal-channel only, like PM4 (staff relay to the client, ADM-08d). Revision-ready / change-request / Phase 6 hand-off messages and the stored template-version record are not built; handlers not run through the job runner here |
| P5-FIN-01 | 15 | M3 30% invoice on Phase5Completed, GST/non-GST, duplicate-safe | EXISTS (pre-existing) | `finance:generateM3Invoice`; E2E asserts duplicate M3 invoice refused |
| P5-FIN-02 | 15 | Claim/proof/match/verify separation; only Admin verification unlocks | EXISTS (shared with M2) | `verify_payment*` owner-only; E2E (underpayment) |
| P5-FIN-03 | 15 | `M3PaymentVerified` gates Phase 6 server-side | PARTIAL | `projects.m3_verified_paid` gates `phase_readiness(…,6)`; no Phase 6 workspace/`start_phase_six` yet (Phase 6 work) and no `M3PaymentVerified` event |
| P5-ADMIN-01 | 01/06 | Admin Panel surfaces: plan, tasks, builds, reviews, QA, feedback, handoff, gate | PARTIAL | read-only Phase 5 Overview on the project page (`phase-five-panel.tsx`, `phase-five-queries.ts`): baseline, builds with QA/review/Admin state, defects, feedback + routing, integrations, specialists, DoD blockers, M3 gate, intake. Typechecked and unit-tested only: not rendered (the local dev database is 47 migrations behind). No action forms yet; no plan/task-graph screen |
| P5-E2E-01 | 01 | 57-step Phase 5 E2E | PARTIAL | steps 1–10 (gate, baseline), 29–57 core (build QA/review/Admin/client/feedback/DoD/M3/gate) run in SQL (`verify-phase-four-e2e.sql`, 118 checks); agent-executed steps (planning, specialists coding, real builds) not runnable |
