# Phases 5-9, round 4: gap-closure log (2026-10-07)

Scope: the PARTIAL / MISSING rows of Phases 5-9 that need no outside account. Everything here is deterministic: no model, no provider, no deployment host, nothing sent, no human gate bypassed. One migration (additive; no table, column or constraint changed): `20261205000000`. Verifier `scripts/verify-p5r-round4.sql` (in the `db:verify:phase4` chain), red-proofs `scripts/redproof/p5r-round4.py`, text pins `tests/p5r-round4.test.ts`.

## Closed

| Row | What now exists | Evidence |
|---|---|---|
| Phase 8A SUP-TST-005 / "answer only from approved knowledge" | `projects.advance_support_ticket` closes a HOW-TO only when the ticket has a citation (`ticket_knowledge_citations`) of an article that is still `approved`. No answer -> `answer_and_source_required` (unchanged code); no citation -> `approved_knowledge_citation_required`; citation of a retired article -> `cited_knowledge_no_longer_approved`; a citation on another ticket does not count; free-text evidence no longer substitutes. The Support UI shows what to do (`phase-eight-actions.ts`). The verifier that pinned the old behaviour was changed with it: `verify-phase-eight-a.sql` (now asserts the new refusals and the close after a citation), and the closing fixtures in `verify-phase-eight-d.sql`, `verify-phase-eight-a-gaps2.sql`, `verify-phase-eight-a-gaps-1.sql` cite an approved article first (helper `pg_temp.p5r_cite_approved`) | V5R section 1 (through the real propose / approve / cite / retire doors); red-proofs for the citation, still-approved, ticket-scope, free-text and answer controls; `phase-eight-a.py` case re-pointed at the new control (red) |
| Phase 8A P8-GATE-008 handoff package | `package.preferences` of the Phase 8 intake carries preferred channel, avoided channels, language, preferred contact, note, source and time from `client_contact_preferences`, or says that none is recorded. Advice only, never a gate (the intake stays ready or incomplete exactly as before); refreshed with the intake until the workspace starts. Patched into the LIVE `p8_build_intake` (raises if the expected text is missing) through an internal-only reader `projects.p5r_intake_preferences` | V5R section 2; red-proofs for the package wiring, client scoping and the avoided channels |
| Phase 9 P9-AG-09 completion output | `finance.p5r_finance_agent_completion_report(request)`: derived on read, nothing stored; Admin/Finance of the request's own organization only. Ids, agent, state (`no_output` / `awaiting_decision` / `decided`), each proposal with evidence refs, the person's decision and note, the audit actions naming it, the agent's policy reference, the handoff statement and the blockers. Shown on `/finance/close/[projectId]` through a guarded read (`listFinanceAgentRunReports`, every read `unreadable`) | V5R section 3; five red-proofs (role check, organization scope, undecided blocker, no-output blocker, decision hidden); page wiring pinned in `tests/p5r-round4.test.ts` |
| Phase 8A Developer task from a support follow-up (consumer) | RECONCILED, not built: the queue of acknowledged Developer requests with no task and the button that makes it are already on `/projects/customer-success/p789-governance` (`followup_task`). A person makes the task, by design; an agent consumer was deliberately not built | traceability row updated |

## Reconciled without a build (stale or already done)

- Wiring "for the lead" lines in the earlier logs are done on main: the Phase 7/8/9 panels are mounted on the project page, the p789 sweeps are in `src/modules/orchestrator/sweeps.ts`, and `src/lib/events/catalog.ts` is a handler subscription catalog (not an event-type list), so the new event types need no entry there.
- Phase 8A dashboard charts: the charts page and the reconciliation charts exist; what remains (churn reasons, utilisation, a rendered check) has no data source or needs a browser run. Not touched.

## Left open, and why

| Item | Why |
|---|---|
| Phase 5/6 depth rows (P5-AGENT-02 real runs, P5-BUILD-02 executor, P5-INTEG-02 real provider, P6-CAT-02 test agents, P6-ADMINUI-01 / P5-ADMIN-01 rendered check, P5-E2E-01 / P6-E2E-01 agent-executed steps) | need a funded model, a repository / CI binding, a build executor, devices or a headless browser: MANUAL_EXTERNAL / environment_missing, stated honestly in their rows |
| Phase 7 P7-READY-01, P7-AG-03, P7-DEP-04 execution, P7-DEP-08 / P7-PM-08 / P7-ADMIN-01 rendered checks | production access, a funded model or a browser |
| 8B testing rows (browser / E2E / performance / compatibility), E2E-15 provider failure | need a browser, real providers or load tooling; the SQL and stub-model coverage that can run already does |
| Phase 9 P9-M008, P9-M010, P9-DOD-05 (invoice correction), P9-API-06 payment-account snapshot | owner decisions; not decided here |
| Phase 9 P9-DOD-11..14, P9-AG-* live behaviour | stub-proven only; a funded model and the `.mjs` finance verifiers (PostgREST) are needed |
| Creator != approver for handover | owner decided: no such rule |
| Browser rendering of the finance close page section and the Support error text | nothing was rendered; typechecked, linted and text-pinned only |
| Existing red-proof `phase-eight-a.py` case "opportunity: agent key check removed" | already a NO-OP before this change (the opportunity door was redefined later); not touched, 43/44 red-proved, the 44th unchanged |

## Verification

- 588 migrations apply on a plain scratch Postgres 16.14 (port 55475). The whole `db:verify:phase4` chain (52 scripts, with the changed 8A / 8D / gaps verifiers and the new one) ran in ONE psql session with `ON_ERROR_STOP` and exited 0; `verify-p5r-round4.sql` prints "verified OK".
- `scripts/redproof/p5r-round4.py`: 13/13 red-proved (each control removed from the live definition; a no-op mutation raises). `scripts/redproof/phase-eight-a.py`: 43/44 (the one non-red is the pre-existing NO-OP above).
- Not verified: anything in a browser; a non-superuser CI server (the verifier writes fixtures as the table owner, like the existing 8A fixtures, and uses no `session_replication_role`); a real model.

## Traps found

- A verifier that pinned a refusal (`answer_and_source_required` with a free-text source) had to change together with the door; four verifiers closed a how-to through a fixture and each needed the citation first.
- Inside one SQL statement a sub-select cannot see what a function in the same statement wrote (the existing trap): the "another client does not inherit" check had to split the intake fill from the read.
- The intake is frozen once a workspace starts, so preference tests need a project whose workspace has NOT been started, while ticket tests need one that has.
