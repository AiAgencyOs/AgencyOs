# Phase 8B / 9 gaps log

Branch `worktree-p8b9-gaps`. Migration `20261122100000_a_failed_smoke_check_is_recorded_decided_and_the_qa_and_exception_events_exist.sql`. Verifier `scripts/verify-phase-eight-b-smoke-and-events.sql` (reuses the 8B fixture and release flow, then drives the new doors; rolls back). Text pin `tests/phase-8b-9-gaps-migration.test.ts`.

## Closed or improved

| Id | Row | Result |
|---|---|---|
| G1 | 8B QA 6, post-deploy smoke failure | PARTIAL (improved). A person records the failure with evidence; an independent Admin records the decision. No automated smoke check and no rollback executor exist; that stays MANUAL_EXTERNAL. |
| G2 | 8B QA 7 events; P9-EV-10 | EXISTS. QAHandoffCreated, TestRunCompleted, QAPassed and FinancialExceptionCreated are emitted by triggers on the rows that change, so no existing door was edited. |
| G3 | P9-ACT-04 | EXISTS. The row was stale: Phase 7's gate already reads the Phase 9 close (migration 20261108020000). Corrected with evidence. |
| G4 | P9-EV-05 | EXISTS. `finance.payment_overdue` emitted once when the sweep opens an overdue exception (migration 20261122200000, verifier `scripts/verify-phase-nine-overdue-event.sql`, red-proved on the overdue-only branch and the event type). |
| G5 | P9-EV-09, P9-P8-01, P9-E2E-15 | EXISTS. Re-verified against the 8A/8B/8C verifiers; rows rewritten with line evidence. |
| G6 | 8B Developer 7 handoff events | PARTIAL (improved). BuildCreated and MigrationPrepared are recorded by a person against the exact commit (migration 20261122300000, verifier `scripts/verify-phase-eight-b-build-records.sql`, red-proved). |
| G7 | smoke failure UI | Server actions, guarded read and a project panel (new files, `maintenance-smoke-*`); the project page must render it (wiring below). |
| G8 | P9-UI-02 | EXISTS. OPEN_EXCEPTION form added to the claims drawer (the one existing file edited). Text-pinned; not exercised in a browser. |

## Verification (scratch Postgres 16, port 55443)

- All migrations apply; the new verifier ends `VERIFIED`.
- Red-proofs by mutating the live definition (pg_get_functiondef + replace; a no-op mutation raises): QA-passed, handoff, test-run and finance-exception event types each turned the matching check red; the smoke guard trigger (service-level write) red; the secret-in-evidence refusal red. The independence branch and the released-only branch are each held by two layers (door and table CHECK / NOT NULL), so removing the door branch turns the run red through the second layer, not through the named assertion; that is recorded as a known limit of those two proofs.
- Existing verifiers `verify-phase-eight-a/b/c/d`, `verify-phase-nine`, `verify-phase-nine-b`, `verify-phase-seven-c` re-run on the same database: no errors.

## Not closed, and why

- P9-DOD-05 invoice correction and P9-API-06 / P9-M008 payment-account snapshot, P9-M010: owner decisions, deliberately not decided.
- Phase 8C/8D rows (renewal sweep, overage, entitlement on verified payment, CR) already exist in migrations 20261105200000 and 20261109000000; the Phase 9 rows P9-EV-09, P9-P8-01 and P9-E2E-15 were not re-verified or re-worded in this pass.
- Funded-model, provider, deploy and browser/E2E/performance rows (8B testing rows, E2E-15, P9-AG-*, P9-DOD-11..14): need credentials, executors or a funded model.
- 8B routing cost evidence (orchestrator row 99): NOT built, deliberately. The router calls no model, so there is no cost to record; adding nullable cost columns with no writer would be fabricated evidence. It stays PARTIAL until a funded model routes.

## Wiring for the lead

- `package.json` `db:verify:phase4`: append `-f scripts/verify-phase-eight-b-smoke-and-events.sql -f scripts/verify-phase-eight-b-build-records.sql -f scripts/verify-phase-nine-overdue-event.sql` after `-f scripts/verify-phase-eight-b.sql`.
- Project `page.tsx`: render `<MaintenanceSmokePanel projectId={projectId} />` imported from `./maintenance-smoke-panel` (an async server component; it returns null when there is no released change and no failure).
- Event catalog `src/lib/events/catalog.ts` (if it mirrors core.event_types): add `project.maintenance_build_created`, `project.maintenance_migration_prepared`, `finance.payment_overdue`, `project.maintenance_qa_handoff_created`, `project.maintenance_test_run_completed`, `project.maintenance_qa_passed`, `project.maintenance_smoke_failed`, `project.maintenance_smoke_failure_decided`, `finance.exception_created`.
