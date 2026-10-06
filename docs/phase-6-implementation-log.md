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

## Independent review (2026-10-06)

Two read-only reviews (TypeScript wiring, SQL authorization) found real defects; each confirmed one was fixed.

Fixed (migration `20261101180000`, TypeScript, verifier red-proven):
- `qa.invalidate_stale_results` was a SECURITY DEFINER door with no organization check (cross-tenant write). It now refuses a foreign project.
- `projects.tasks` and `qa.defects` had FOR ALL write policies, so a direct UPDATE walked around `start_task` / triage. Guard triggers now refuse a direct (non-door) start, plan change, severity/class/duplicate change, or a defect inserted already verified. `start_task` became a definer door that checks the organization itself.
- `qa.mark_duplicate` could hide an open blocker behind a closed canonical defect.
- Handlers now prove an event-payload id belongs to the job's organization; `reopenOnSourceChange` and the build announcers only spend a job on `kind = build`.
- Form inputs (`days`, severity) are validated; an Admin "Start Phase 5" door exists for when the one-shot payment event did not start it; duplicate React keys fixed.

Open from the SQL review (not fixed, recorded): QA/Admin approval of a build is not bound to a commit (item 6); a code reviewer who changed the code can also record an independent review (7); several gates pass vacuously when the project has no baseline / derived documents / plan categories (8); `ingest_test_report` accepts un-evidenced person reports (9); quarantine can be renewed indefinitely and some check-then-act races (10); new tables lack an explicit `revoke from public, anon, authenticated` (11); payment booleans are readable by portal clients (12).

### Second round (migration `20261101190000`)

Closed, each red-proven in `scripts/verify-phase-four-e2e.sql`: a changed `commit_ref` un-approves the build's QA and Admin verdicts (6); a reviewer who recorded "I changed the code" is never the independent second reviewer on that commit (7); a person's test-report ingest needs https evidence like a runner's (9); anon is revoked from the internal Phase 5/6 tables (11); portal clients get false from `m3_verified_paid`, `m4_verified_paid` and `phase_seven_candidate_current` (12).

Still open from the review: vacuous gates on projects with no baseline/derived documents/plan categories (8) and the quarantine-renewal and check-then-act races (10).
