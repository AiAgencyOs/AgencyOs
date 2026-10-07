# Phase 9B implementation log (the open gaps of the Finance Agent phase)

Scope: only what the Phase 9 traceability marked NOT built and that needs no owner decision. P9-M008 (payment-account snapshot at issue), P9-M009 (the service-role exemption in `finance.verify_payment*`) and P9-M010 (invoice correction) stay owner decisions and were not touched. An agent still never verifies a payment, changes an amount, refunds or messages a client; no Phase 9B door can.

Proven on a real scratch Postgres 16 (`scripts/apply-migrations-locally.sh` with every migration, then the verifier). No model ran: workflow behaviour is stub-proven.

## 2026-10-07

### Migrations (`20261111100000` to `20261111400000`)
- **`...100000` ReconciliationDue.** `finance.reconciliation_schedules` (cadence data an Admin sets; unit day/week/month, count, anchor date, source, optional receiving account; one per account; no default cadence), `finance.reconciliation_due_items` (one per schedule and period; waiting or opened; only waiting to opened ever changes), pure `reconciliation_latest_due_period` (UTC, half-open, month boundaries stepped from the anchor), Admin-only `set_reconciliation_schedule`, runner-only `sweep_reconciliation_due(limit, today)` (the day is injected). It opens the latest ended period once, waits while the account already has an open period (an existing rule), and never closes anything.
- **`...200000` lifecycle and wrong account.** `milestone_financial_lifecycle(project)` and `milestone_financial_state(milestone)`: derived, never stored (not_invoiced, invoiced, partially_verified, fully_verified, waived, refunded, overdue, disputed), built on the close position's own invoice rows so unverified money moves nothing. `payment_account_checks` (once per submission, append-only, `client_account_id` tenancy trigger): a payer sharing no significant word with the client account, or a receiving account not active when paid, opens a blocking `wrong_account` exception (or links one a person already opened). Door `check_payment_account`, runner `sweep_payment_account_checks`. Nothing about the payment or submission is changed.
- **`...300000` pause.** The generic controls could not be reused (the kill switch is owner-only and org-wide; `ai.set_agent_status` is global). `finance_automation_controls` plus an append-only `finance_automation_changes`, Admin-only `set_finance_automation_paused` (reason both ways; one agent or `all`), runner-only `finance_automation_is_paused`; `request_finance_agent_run` now answers `automation_paused`.
- **`...400000` handoff.** `finance_proposals.handoff jsonb`, the shape CHECK `phase9b_handoff_shape_ok`, and `record_finance_proposal` (new trailing optional `p_handoff`, old signature dropped) which refuses `automation_paused` and re-reads the rows to refuse a payload that disagrees with them.

### Code
- `src/modules/finance/phase-nine-handoff.ts` (the Zod type and builder), `phase-nine-verification-packet.ts` + `phase-nine-packet-queries.ts` + NEW component `app/(internal)/invoices/verify/verification-packet.tsx` (read only), `phase-nine-b-doors.ts` / `-actions.ts` / `-queries.ts` / `-view.ts`, panels `app/(internal)/finance/close/phase-nine-b-panels.tsx` + `phase-nine-b-form.tsx`, `app/(internal)/projects/[projectId]/phase-nine-lifecycle-line.tsx`.
- `app/api/jobs/run/phase-nine-workflows.ts`: asks the pause first (an unreadable pause fails closed; a paused agent throws `AgentsPaused` so the runner requeues the job), builds one handoff per proposal, and treats `automation_paused` from the door as a requeue. It selects `requested_by` and the project's `client_account_id` now.
- `src/modules/orchestrator/sweeps.ts` gains `sweepFinancePhaseNineB`; `app/api/jobs/run/route.ts` gets its import and ONE call line after `sweepFinanceExceptions`.
- `src/lib/events/catalog.ts` and `src/modules/crm/*` were not touched.

### Verification
- `scripts/verify-phase-nine-b.sql`: 161 checks, rolls back; every SQL verifier (`scripts/verify-*.sql`) passes on the same database except `verify-discount-and-payment-structure-local.sql`, which fails by design as it did before.
- Red-proofs: 87 mutations of live definitions (and triggers, policies, grants, constraints), each raising on a no-op mutation, each watched to fail the verifier. One further mutation (the "an amount needs an invoice" test in the handoff door) was dropped as an equivalent mutant: the other branch refuses the same input.
- `scripts/verify-phase-nine-concurrency.sh`: two real sessions; session B waited 3.00 s for A, answered `already_closed`; one snapshot, one audit row, one evaluation. Red-proved by removing the two `for update` locks (B then fails on the unique index instead of being refused cleanly).
- Tests: `tests/phase-nine-b.test.ts` (pure parts and migration structure), `tests/phase-nine-b-workflows.test.ts` (pause, handoff, sweep). `tests/phase-nine-workflows.test.ts` was updated: ids are real UUIDs now (the handoff schema needs them), the request/project fixtures carry `requested_by` / `client_account_id`, and the pinned list of rpcs gained `finance_automation_is_paused`.

### Defects found by driving it
1. A plpgsql `IF` containing `CASE ... THEN` stops parsing at the first `THEN`; the cadence bound was moved into a subselect.
2. The first red-proofs were green for six controls: a month-end boundary case, a waiting item of a switched-off schedule, the unique index behind the one-per-account door, a non-dispute exception on a milestone, a payment before an account's window, and a handoff evidence mutation that was itself invalid SQL. A test was added for each, then each went red.
3. A fixture helper must not print `set_config` rows when its output is read back (the concurrency script's fixture read the wrong line).

### Not built (and why)
- The owner decisions above (invoice correction, payment-account snapshot, entity ownership of an account, the verification exemption).
- A gateway, reconcile-before-retry, Phase 7's read of the close, Phase 8's billing rules.
- No page was edited: the wiring lines are in the manual actions (P9-M017). The Phase 9B verifier is not in the CI chain (P9-M018) and the concurrency script cannot be (P9-M020).
- The `sweep_finance_exceptions` call is still unwired (P9-M004).
