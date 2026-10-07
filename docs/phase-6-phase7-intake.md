# Phase 6 → Phase 7 intake

Data, not prose: `projects.phase_six_handoffs.payload`, written in the same transaction as Phase6Completed and frozen. It carries the exact candidate (commit, build, artifact hash, approver, time), the scope and UI versions, the approved test plan, the readiness assessment (score, band, dimensions, every gate as it stood), approved exceptions with their expiry, known limitations, the deployment prerequisites (configuration version, rollback plan and owner, monitoring), manual external dependencies, and the defect summary. `production_deployed` is a CHECK that is always false: Phase 6 deploys nothing.

Phase 7 deploys exactly this candidate, or raises a new governed candidate if the source changes; if source changes after Phase6Completed, the gates show the approval no longer holds. Financial entry needs `projects.m4_verified_paid` (Admin-verified in full, runner-recorded once as `M4PaymentVerified`). Proven by `scripts/verify-phase-four-e2e.sql`.
