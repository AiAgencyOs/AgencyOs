# Phase 6 implementation log

All proven against a real scratch Postgres; each control removed, watched to fail, restored. Journey script: `scripts/verify-phase-four-e2e.sql` (Phase 4 → 5 → 6, 390+ checks); chain: `npm run db:verify:phase4`.

## 2026-10-06
- **Security fix (P1, introduced in Phase 5)** `20261101090000`: Phase 5 internal tables were readable by a portal client of the same organization (the client carries the same organization claim). All fourteen are now `org AND is_internal()`; `scripts/verify-internal-only-reads.sql`.
- **Workspace + intake** `20261101100000`: `projects.phase_six` (the 12 states), `qa_intakes`, `start_phase_six`, `validate_qa_intake`; handlers on `Phase5Completed` / `M3PaymentVerified` / `Phase6Ready`; PM6-M01.
- **Master Test Plan** `20261101110000`: versioned plan, risk matrix that refuses low/shallow payment-auth-tenant-destructive work, cases (requirement → criterion → category → result on the exact commit), append-only history, invalidation on commit change, Admin-only approval.
- **Defects** `20261101120000`: S0–S4, classification, triage (change request routing), fix handoff, retest on the FIXED commit, reopen.
- **Release engine** `20261101130000`: candidate, category evidence, 15 hard gates, weighted readiness (a summary), human-only expiring exceptions, Admin QA review, EDIT/RETEST loop.
- **Exit** `20261101140000`: the real DoD in `phase_readiness(…,6)`, frozen Phase 7 intake (`production_deployed` CHECK false), candidate prerequisites, `M4PaymentVerified`, `phase_seven_gate_status`.
- **Specialists** `20261101150000`: nine QA agents, disabled; `quality_assurance` stays the orchestrator.
- **Admin surface**: `phase-six-queries.ts`, `phase-six-actions.ts` (a whitelist of doors), `phase-six-forms.tsx`, `phase-six-panel.tsx`.
- The older Phase 6 readiness check ("a suite ran and nothing is open") was REPLACED, not extended: it could not express an approved exact candidate.

- **Remaining tasks** `20261101160000`: QA job scheduling with safe-parallelism rules (held, never faked, while disabled), canonical-defect linking, `reopen_on_source_change` + `phase_seven_candidate_current`, intake platform + change-request history; handlers on plan approval and every new build; panel sections.

- **Part 2** `20261101170000`: declared API/data contracts on the intake; client clarification (one question per case, asked once, answered once); a client-safe defect-progress fact; two PM6 messages; panel dashboards for performance (the project's own targets), devices and the compatibility matrix.

## Not built
Any test runner or specialist actually running (needs a funded model key, runners and environments); a stored PM message-template version and delivery record beyond the generic outbound log.
