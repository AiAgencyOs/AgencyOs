# Phases 5, 6 and 7: gap-closure log (2026-10-07)

Scope: every PARTIAL or MISSING row in `phase-5/6/7-implementation-traceability.md` that can be closed without a credential, a funded model, a deployment host or a provider account. Migrations `20261123000000`, `20261123100000`, `20261123200000`; verifier `scripts/verify-phase-567-gaps.sql` (125 live checks plus red-proofs, each by mutating the LIVE function definition inside a rolled-back sub-transaction; a no-op mutation raises).

## Closed

| Row | What now exists |
|---|---|
| Phase 8 hardening: data-safety gate | keys on `area = 'database'` whatever the author ticked; `sensitive` and the database area are monotonic (trigger) |
| Phase 8 hardening: `link_maintenance_invoice` | invoice total and currency must equal the accepted quote (acceptance proposal / plan quote; for a renewal the accepted renewal's quote and exact period); cycle bounded by billing model, inside the plan period, never overlapping a billed cycle |
| P6-P604-03/04/08/09 | scenario kinds, case profile (persona, environment, actual result, failure class, NOT_APPLICABLE with reason), feature exclusions, derived coverage, derived definition of done, derived Master QA handoff that cannot declare production readiness |
| P7-INC-09 | corrective actions are real tasks linked to the incident |
| P7-COMP-05 | HANDOVER_BLOCKED / CLIENT_ACTION_REQUIRED / DISPUTED derived with their sources |
| P7-CS-03 | follow-up tasks (day 0, week 1, warranty end minus 7), idempotent, never invent a date |
| P7-ARC-06 | LinkedFutureWork derived |
| P7-PM-06 | deterministic feedback classification suggestion |
| P7-QA-06 | manual health snapshot with source and age; no monitor source |
| P5-AGENT-02, P5-BUILD-02, P5-INTEG-02, P5-FEED-02, P5-DOC-01 | stale rows reconciled against code that already existed (see the traceability rows); they stay honest about what is stub-proven |

## Not done, and why

- Everything that needs a funded model, a repository or CI binding, a real build executor, deployment host, monitoring source or provider credentials stays `MANUAL_EXTERNAL` / `environment_missing`: P5-AGENT-02 (real runs), P5-BUILD-02 (executor), P5-INTEG-02 (real provider), P6-CAT-02, P7-READY-01, P7-AG-03, P7-DEP-04 execution.
- P7-INC-07 (Admin notification by policy): needs a delivery channel and a notification event type; event types live in `src/lib/events/catalog.ts` (shared wiring file, not edited). P7-QA-07 likewise (new event types).
- P7-INC-08 (provider failover), P7-NEG-01 (provider outages, audit-store failure), P7-CS-04/05, P7-P8-01 workflows: Phase 8 or runtime conditions with no executor.
- P7-ARC-01 rendered certificate document, P7-PM-07 reminders, P7-FIN-05/06 receipt file: not attempted in this pass.
- UI rows (P5-ADMIN-01, P6-ADMINUI-01, P7-ADMIN-01, P7-DEP-08, P7-PM-08): two new read-only panels exist but are not mounted and nothing was rendered or clicked in a browser. The new actions have no client form components yet.
- Deliberately NOT implemented (owner decisions pending): creator != approver for handover approve/deliver, Admin-only incident close. `close_incident` and the handover doors are unchanged.

## Wiring lines for the lead (shared files this pass did not edit)

1. `package.json` `db:verify:phase4` chain: append `-f scripts/verify-phase-567-gaps.sql` after `scripts/verify-phase-eight-d.sql`.
2. Existing verifiers broken by the (intended) price binding: their fixtures invoice an amount the client never accepted. Exact edits:
   - `scripts/verify-phase-eight-b.sql` line 270 area: the `P8B-INV-3` insert: `'paid', 7000, 7000, 0, 'service', now(), 7000, now()` becomes `'paid', 118000, 100000, 18000, 'service', now(), 118000, now()`.
   - `scripts/verify-phase-eight-c.sql`: line 87 `P8C-INV-3`: `'issued', 50000, 50000, 0` becomes `'issued', 118000, 100000, 18000`; line 371 payment `50000` becomes `118000`; line 508 `P8C-INV-4`: `'paid', 9000, 9000, 0, 'service', now(), 9000` becomes `'paid', 118000, 100000, 18000, 'service', now(), 118000`; line 509 payment `9000` becomes `118000`.
   With those edits both pass (80 and 222 checks). The data-safety change breaks nothing there.
3. `docs/roadmap/roadmap.json` derived counts after this change: migrations 555, test files 511, tables 444, tests 10496, suites 2165 (re-derive with `npm run check:record` after merging).
4. Mount on `app/(internal)/projects/[projectId]/page.tsx`: `<FunctionalTestPanel view={await loadFunctionalTestView(approvedPlanId)} />` (from `./functional-test-panel`, `@/modules/projects/functional-test-queries`) and `<PhaseSevenGapsPanel view={await loadPhaseSevenGaps(projectId)} />` (from `./phase-seven-gaps-panel`, `@/modules/projects/phase-seven-gaps-queries`).
5. Optional job: when Phase 7 completes (or in the Phase 7 sweep), call `admin.schema('projects').rpc('schedule_handover_follow_ups', { p_project_id })` (the service role is accepted and the call is idempotent).
