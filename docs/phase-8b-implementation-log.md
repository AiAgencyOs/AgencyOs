# Phase 8 part B: implementation log

## What was built

Migrations (all additive, all in the reserved range):

- `20261105500000` tables: maintenance work items, commits, post-launch QA results, release decisions, SLA policies, routing decisions, agent requests/proposals/decisions.
- `20261105510000` gates and doors: open, submit exact commit, independent QA result, request/decide release, record release, cancel.
- `20261105520000` SLA policy door, service-only routing door, agent request / proposal / decision doors.
- `20261105530000` finance: billing requests, proposals (amounts copied from the human quote), decisions, invoice-to-cycle links, the financial gate function and its trigger on `projects.maintenance_plans`, owner-approved expiring exceptions.

TypeScript: `src/modules/orchestrator/maintenance-route.ts` (priority, SLA state, routing, queue order; pure), `src/modules/projects/maintenance-engineering.ts` (agent schemas and checkers; pure), `app/api/jobs/run/phase-eight-eng-workflows.ts` (`PHASE_EIGHT_ENG_WORKFLOWS`, three draft workflows), `src/modules/projects/phase-eight-b-{queries,actions}.ts` and the panel and forms under `app/(internal)/projects/[projectId]/`.

Not edited: registry, workflows.ts, route.ts, catalog.ts, page.tsx, package.json, roadmap.

## Decisions

- **No new agents.** Every agent the four specs name (developer, quality_assurance, finance, orchestrator and the specialists) is already registered and installed disabled. Inventing maintenance-only agents would have been duplication.
- **No invented numbers.** No SLA hours, no prices. The earlier maintenance migration declined SLA numbers because no document makes a commitment; the Phase 8 spec asks for SLA-aware scheduling, so the policy is an Admin's versioned choice and is empty until set. Priority is a derived class, not a promise.
- **A defect-linked fix reuses the Phase 6 loop** (`qa.record_retest`, `qa.unresolved_product_defects`) and a failed post-launch QA result opens a real `qa.defects` row.
- **The release approval is not a deployment.** `released` is an Admin's recorded fact with a deployment reference and smoke evidence.
- **The financial gate only binds plans that were billed through this pipeline** (a linked invoice), so legacy plans and the existing verifiers are unaffected.

## Verification

- `scripts/verify-phase-eight-b.sql` on a scratch Postgres (all migrations applied): passes.
- **Red-proof**: 22 controls were removed one at a time in a temporary copy of the live definition and the verifier was re-run; each made it fail. Controls: author cannot be QA; creator != approver; stale-commit evidence refused; unauthorized work; feature ticket as maintenance; enhancement needs a change request; status moves only through doors; defect-verified gate; Admin-only release decision; approved commit frozen; builder never routed as QA; routing door service-only; proposal organization is the job's (both layers); requester cannot accept a proposal; quoted amount never coerced; financial gate trigger; owner exception requester != approver; reminder must name its invoice; reminder refused when not collectible (state now); billing follows acceptance; gate reads verified money not a paid status; billing agent door service-only. The first pass found four controls the verifier did not actually test; tests were added and the controls re-proven.
- Unit/stub tests: `tests/maintenance-route.test.ts`, `tests/maintenance-engineering.test.ts`, `tests/phase-eight-eng-workflows.test.ts`, `tests/phase-eight-b-migrations.test.ts`.

## Known limits

Stub-proven only for the agents. No browser/UI run of the panel was done. No automated smoke, rollback, SLA sweep, deadlock detection or announcers. Renewal does not auto-extend plan dates on payment verification.
