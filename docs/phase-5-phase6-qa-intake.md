# Phase 5 → Phase 6 QA intake

The intake is data, not prose: `projects.phase_five_handoffs.payload`, written in the same transaction as Phase 5's completion and frozen. It carries: the exact final build (deliverable, version, commit, build number, target environment, artifact), the locked baseline (UI version, prototype build, scope version), every independent code review of that commit, the latest run per test suite, the defect history, integration health (each non-verified integration is a named known limitation and manual dependency), high-risk areas for Phase 6 to inspect first, and `independentVerificationRequired: true` (a CHECK).

Phase 6 reads it as a claim to re-test independently. Financial entry to Phase 6 additionally needs `projects.m3_verified_paid` (Admin-verified, in full). Proven by `scripts/verify-phase-four-e2e.sql` steps 19c–21.
