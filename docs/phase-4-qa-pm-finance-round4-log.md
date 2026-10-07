# Phase 4 QA / PM / Finance / Orchestrator, round 4 (2026-12-02)

Scope: the buildable PARTIAL and MISSING rows left open by `docs/phase-4-qa-pm-finance-gaps-log.md` after the 2026-11-26 build and the 2026-11-30 wiring. Rows closed carry `Closed 2026-12-02 (round 4)` in `docs/phase-4-implementation-traceability.md`. Owner-side steps are in `docs/phase-4-manual-actions.md`.

## What was built

One migration, `20261202000000_prototype_qa_has_retest_and_deferred_states_uploaded_evidence_and_a_traceability_read_an_agent_log_is_masked_and_a_delivery_may_be_unknown.sql` (additive; every new object is prefixed `p4s_`; `core.unguarded_org_fks()` returns 0), its live verifier `scripts/verify-p4s-qa-pm-finance-round4.sql` (85 checks, 15 red-proofs; added to `db:verify:phase4`), and the application half, pinned by `tests/p4s-qa-pm-finance-round4.test.ts` (32 tests).

| Row | What now exists |
|---|---|
| P4-QAP-019 | `QA_RETEST` and `DEFERRED` as defect states. `p4s_defect_lifecycle` derives open / fix_ready / qa_retest / retest_passed / verified / deferred / wont_fix from `qa.defects` and the p4q record (so no state can disagree with its source). `p4s_request_defect_retest` (person or service; needs a claimed fix, refuses a deferred defect), `p4s_defer_defect` / `p4s_undefer_defect` (owner or ops admin only, never the service role, reason of 10+ characters, no credential, only an open defect). Deferring edits neither the defect status nor the QA run: a build QA did not pass is still not passed. The Phase 4 records page has a defect board with the controls. |
| P4-QAP-043 / 093 | `projects.p4s_prototype_qa_evidence`: an uploaded screenshot, recording, log or report on a QA run (optionally on one of its checks or a defect it raised). The object is in the project-files bucket under `<organization>/evidence/<run id>/`; the row is written only by `p4s_attach_qa_evidence`, which re-checks tenant, run, kind, size, path, credential-looking name and note, and is append-only. `evidence-service.ts` stores first and records second. |
| P4-QAP-004 | `p4s_prototype_traceability(artifact)`: scope item -> feature -> screen -> designed states -> built screen -> the QA coverage check, with the gap named (`no screen covers this requirement`, `the screen is not in the locked UI version`, `the screen is not built in this prototype`, `QA has not run on this build`). Excluded scope items are not part of it. Shown on the records page. |
| P4-QAP-046 | Subscribers for the QA events (below). QAStarted stays absent on purpose: a QA run is one atomic record. |
| P4-PM-036 | `unknown` delivery state on `crm.conversation_messages` (below). |
| P4-FIN-042 / 057 | `/finance/receipts/[receiptId]` renders the receipt document and the delivery state per channel from `finance.p4s_receipt_page`; the payment page links to it. |
| P4-FIN-079 | Verified, no code: the PDF, WhatsApp and email renderers already read the issued snapshot's account list (W-F3, 2026-11-30). |
| P4-ORCH-026 | The fallback for a disabled specialist is considered and recorded (below). |
| P4-ORCH-T11 | `ai.agent_runs` and `ai.agent_steps` are masked by a before-write trigger over every log column, per JSON string leaf. |
| P4-ORCH-T09 | Its missing piece (an explicit UNKNOWN reconciliation state) is the P4-PM-036 state. |

## Wiring done (one connection at a time, each with a test that fails if it is removed)

1. **W-Q2 blocked QA**: `project.p4q_prototype_qa_blocked` -> `crm:announcePrototypeQaBlocked` (catalog `SUBSCRIPTIONS`, `HANDLERS`, `HANDLER_JOB_KIND`; `app/api/jobs/run/route.ts` `runEventJobs` block and summary). Internal channel only (`announceToInternalChannel`), keyed by the QA run and the event, template `prototype-qa-blocked` = `PM4-QA-BLOCKED` version 1 added to `PM4_TEMPLATES`. The wording is neutral and factual, and is marked **pending owner approval** in `docs/phase-4-manual-actions.md` and in the schema comment. `tests/p4q-handlers.test.ts` now expects nine PM4 templates.
2. **W-Q2 fix ready**: `project.p4q_prototype_fix_ready` -> `projects:requestDefectRetest` (`src/modules/p4q/retest-request.ts`). A state on the record only: no model, nothing verified or approved.
3. **P4-ORCH-026**: in `runWithEnvelope`'s `agent_disabled` branch (the specialist is still held, not dead, and the work does not run), `considerFallbackForDisabledSpecialist` judges every registered agent with `validateFallback`, and records the accepted fallback (same family, no wider authority, itself enabled) or the closest rejection with reasons through the service-only `p4s_record_agent_fallback` (task-less `projects.fallback_records`, one per day per pair). It never hands the work over. Best effort: a failure to record changes nothing about the hop.
4. **P4-PM-036**: `send.ts` marks `uncertain` on a timeout or transport failure after a request may have gone out and on a 200 with no message id (never on a refusal, a missing configuration or a media upload); `deliveryStatusOf` maps it to `unknown`; all 14 WhatsApp delivery writes (text, template, document, announcers, follow-ups, invoice delivery, the agent send) use it. `crm.mark_outbound_delivery` accepts `unknown` only with a note (spliced into the LIVE definition, so the sanctioned-write line is untouched), settles it to sent or failed later, and `sent` stays terminal. The chat bubble draws unknown as unknown (never a tick), Operations lists unknown beside failed with a warning, and a person may retry it knowingly.
5. **Receipt page**: `payment-detail-queries.ts` returns the receipt id; the payment page links to `/finance/receipts/[receiptId]`.

## Lessons from earlier rounds, applied

No circuit breaker or delay is in the agent runner's path; a disabled specialist still settles as held; the verifier's counts are scoped to its own rows and rolled back; the pg_temp helpers are `p4s_`-prefixed; nothing sets `session_replication_role` in a function or DO block (the verifier uses `set local` at top level, as the existing ones do); the migration is idempotent (re-applying is a no-op, including the spliced delivery function).

## What stays open, and why

| Row(s) | Why |
|---|---|
| P4-FIN-020 | Stays PARTIAL on an owner decision: the issued snapshot is masked by design, so the exact unmasked instructions at issue are not reproducible; the documents print the current details of the same accounts. |
| P4-QAP-010, 011, 012, 078, 079, 023 (render) | Rendered layout and visual fidelity need a headless browser or a funded vision model; recorded `not_verifiable`, never a pass. |
| P4-PM-010 / ORCH real classification | Needs a funded model. |
| P4-PM-005 direct client send | WhatsApp credentials and an owner decision. |
| P4-FIN-019, 021, 049, 072 | Owner decisions and provider accounts. |
| P4-FIN-068, 071, QAP-015 and the E2E rows (QAP-097, PM-051, FIN-105, ORCH-047) | Not taken in this round; the E2E rows need PostgREST, Next and a stub model stood up. |
| A fallback agent actually taking over | By design not done: it would route work without a human choosing. The record and the open escalation are the hand-off. |
| An unknown delivery being resent | Unchanged: a retry sends again, exactly as a failed one did; the person is told to check first. A reconciliation screen that asks the provider is not built (no provider status API is wired). |

## Verification evidence

- Scratch Postgres 16.14 on port 55472: every migration applies from scratch (588 files, 530 of 530 tables with RLS, 0 invoker writes without a policy); `core.unguarded_org_fks()` = 0.
- The whole `db:verify:phase4` chain (53 files) in ONE psql session with `ON_ERROR_STOP`, exit 0; the new verifier is last and passes with 85 `ok` checks and 15 `red` proofs (each red-proof mutates the live function definition inside a rolled-back sub-block and raises if the mutation changed nothing).
- `npm run typecheck`, `npm run lint`, full `npm test` (11,300+ tests), `npm run scan:secrets`, `npm run check:record` pass (derived counts in `docs/roadmap/roadmap.json` updated last).
- Wiring red-proof by removal: with the envelope call, the catalog subscription and the runner block each deleted, four tests of `tests/p4s-qa-pm-finance-round4.test.ts` fail; restored, they pass.

## Honest limits

- Verified on a plain Postgres 16 with a stub of `auth` and the three roles, not on Supabase/PostgREST. The role `postgres` is a superuser there; grant behaviour was exercised with `set local role` for the refusals that depend on it.
- The page changes (defect board, traceability, evidence form, receipt page, unknown mark) are typechecked, linted and pinned as source; they were not opened in a browser.
- The evidence upload was not run against real Storage (unreachable locally); the order (object first, row second) is pinned by a test, the database half is live-verified.
- The `unknown` state is recorded where the sender can tell the request may have gone out. A webhook that later proves delivery already updates the wire status; it does not (and should not) rewrite `unknown` to `sent`.
- No funded model, WhatsApp provider or Figma access was used or faked.
