# Phase 8B / 9 gaps log

Branch `worktree-p8b9-gaps`. Migration `20261122100000_a_failed_smoke_check_is_recorded_decided_and_the_qa_and_exception_events_exist.sql`. Verifier `scripts/verify-phase-eight-b-smoke-and-events.sql` (reuses the 8B fixture and release flow, then drives the new doors; rolls back). Text pin `tests/phase-8b-9-gaps-migration.test.ts`.

## Closed or improved

| Id | Row | Result |
|---|---|---|
| G1 | 8B QA 6, post-deploy smoke failure | PARTIAL (improved). A person records the failure with evidence; an independent Admin records the decision. No automated smoke check and no rollback executor exist; that stays MANUAL_EXTERNAL. |
| G2 | 8B QA 7 events; P9-EV-10 | EXISTS. QAHandoffCreated, TestRunCompleted, QAPassed and FinancialExceptionCreated are emitted by triggers on the rows that change, so no existing door was edited. |
| G3 | P9-ACT-04 | EXISTS. The row was stale: Phase 7's gate already reads the Phase 9 close (migration 20261108020000). Corrected with evidence. |

## Verification (scratch Postgres 16, port 55443)

- All migrations apply; the new verifier ends `VERIFIED`.
- Red-proofs by mutating the live definition (pg_get_functiondef + replace; a no-op mutation raises): QA-passed, handoff, test-run and finance-exception event types each turned the matching check red; the smoke guard trigger (service-level write) red; the secret-in-evidence refusal red. The independence branch and the released-only branch are each held by two layers (door and table CHECK / NOT NULL), so removing the door branch turns the run red through the second layer, not through the named assertion; that is recorded as a known limit of those two proofs.
- Existing verifiers `verify-phase-eight-a/b/c/d`, `verify-phase-nine`, `verify-phase-nine-b`, `verify-phase-seven-c` re-run on the same database: no errors.

## Not closed, and why

- P9-DOD-05 invoice correction and P9-API-06 / P9-M008 payment-account snapshot, P9-M010: owner decisions, deliberately not decided.
- Phase 8C/8D rows (renewal sweep, overage, entitlement on verified payment, CR) already exist in migrations 20261105200000 and 20261109000000; the Phase 9 rows P9-EV-09, P9-P8-01 and P9-E2E-15 were not re-verified or re-worded in this pass.
- Funded-model, provider, deploy and browser/E2E/performance rows (8B testing rows, E2E-15, P9-AG-*, P9-DOD-11..14): need credentials, executors or a funded model.
- No UI panel or server action was added for the smoke failure doors; they are callable through the doors only.
- Not built in this pass: `PaymentOverdue` outbox event (P9-EV-05), OPEN_EXCEPTION button in the claims drawer (P9-UI-02, existing file), 8B routing cost evidence.

## Wiring for the lead

- `package.json` `db:verify:phase4`: append `-f scripts/verify-phase-eight-b-smoke-and-events.sql` after `-f scripts/verify-phase-eight-b.sql`.
- Event catalog `src/lib/events/catalog.ts` (if it mirrors core.event_types): add `project.maintenance_qa_handoff_created`, `project.maintenance_test_run_completed`, `project.maintenance_qa_passed`, `project.maintenance_smoke_failed`, `project.maintenance_smoke_failure_decided`, `finance.exception_created`.
