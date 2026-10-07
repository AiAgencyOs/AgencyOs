# Phases 7, 8A, 8B and 9, round two: gap-closure log (2026-10-07)

Scope: the items earlier builders listed as "not attempted" or "open but buildable" that need no credential, no funded model, no deployment host and no provider account. Everything here is deterministic. Nothing was sent to a client, nothing was priced, no payment, deployment, fail-over or message was executed, and no human gate was bypassed: every approval, acknowledgement, resolution and decision below is a door that needs a signed-in person (and, where stated, an Admin or an independent Admin). The service role has no door to any of them.

Migrations (all inside 20261129000000-20261129990000, additive): `20261129000000` (Phase 7), `20261129100000` (Phase 8A/8B), `20261129200000` (feedback signal). Verifiers, each driven through the real doors on a scratch Postgres 16 and ending in `rollback`:

| Verifier | Checks | Red-proofs |
|---|---|---|
| `scripts/verify-p789-phase-seven-round2.sql` (V7R2) | 115 | 29 |
| `scripts/verify-p789-phase-eight-round2.sql` (V8R2) | 75 | 21 |
| `scripts/verify-p789-feedback-signal.sql` (VSIG) | 26 | 11 |

A red-proof removes one control from the LIVE function definition (`pg_get_functiondef` + `replace`, then `CREATE OR REPLACE`), runs a probe that is true while the control holds, requires it to go false, and restores the definition; a mutation that matches nothing raises `RED-PROOF NO-OP`. Trigger controls are proved at the top level (mutate, write a fresh row, expect the wrong result, restore). The approver CHECK on a fail-over is proved by dropping the constraint and watching a self-approving row land.

## Closed

| Row | What now exists | Status |
|---|---|---|
| P7-ARC-01 | `projects.render_completion_certificate`: one print-ready HTML certificate per completion record, HTML-escaped, stored with its SHA-256, never edited; client and staff read; download route. Unsigned, says so. No PDF engine is claimed | EXISTS (record and HTML document) |
| P7-PM-07 | reminder records (`due_soon`, `overdue`) from a sweep handed its clock; a person records that they reminded the client; waiting list is derived | EXISTS (nothing is sent by AgencyOS) |
| P7-FIN-05 / FIN-06 | one HTML receipt document per receipt of a VERIFIED payment; client reads only its own; download route | EXISTS (document); not a tax invoice, no PDF engine |
| P7-QA-07 | SmokePassed / SmokeFailed / RollbackCompleted events from triggers on the rows that change | EXISTS |
| P7-INC-07 | Admin notification policy (versioned, Admin-set), notification written when an incident opens, client-safe wording separate from technical detail, Admin-only acknowledgement, derived overdue queue | EXISTS / delivery of e-mail and WhatsApp is a person's relay (MANUAL_EXTERNAL) |
| P7-INC-08 | provider-outage decisions as records; a fail-over needs an independent Admin approval (door and table CHECK); execution is a fact recorded afterwards | EXISTS / executing a fail-over is MANUAL_EXTERNAL |
| P7-NEG-01 | outage cases as records (cloud timeout, provider outage, monitoring gap, audit-store failure) with the audit gap stated; an audit gap is accepted only by an Admin | EXISTS (records) / real outages are environment_missing |
| P7-CS-04 | reconciled: the post-project issue workflow, warranty window and entitlement already exist in Phase 8A (`support.propose_ticket_handling`, stub-proven) | EXISTS (evidence only, no new build) |
| P7-CS-05 | `customer_success.draft_feedback_signal` workflow (stub-proven) and its one service-only door; a person reviews | EXISTS / a real run needs a funded model (MANUAL_EXTERNAL) |
| 8A major-release activation | `p789_record_major_release` raises the existing `major_release` check-in | EXISTS |
| 8A P8-SEC-006 retention classes for ledger, feedback, value reports, opportunities, access denials | Admin-versioned decisions in their own table (the Phase 7 class list is NOT widened), plus a read of rows held and rows past the decision | PARTIAL: decisions exist, no disposal executor (by design) |
| 8A CUS-IMP-009 alerting records | Admin alert rules, alerts raised and cleared by a sweep handed its clock, Admin acknowledgement | PARTIAL: records only, nothing sent, no metrics export |
| 8A Developer task from a support follow-up | `p789_create_task_from_followup`: a person with delivery rights turns an ACKNOWLEDGED Developer request into a task built from the ticket row; one per request | EXISTS (no consumer, no agent door) |
| 8A dashboard charts | `/projects/customer-success/p789-charts` | PARTIAL: typechecked and linted only, not rendered |
| 8A VIP, scope-item comparison | already built in Gaps log 1; stale MISSING rows corrected (`SUP-TST-002`, "Compare expected vs actual"); existence verified in V8R2 section 6 | EXISTS |
| 8B routing cost evidence | `projects.p789_maintenance_routing_cost_evidence` returns `model_call = false`, `cost_minor = null`, "no model call, nothing to record". No cost column, no invented figure | PARTIAL (honest) |

## Left open, and why

| Item | Why |
|---|---|
| P9-M008, P9-M010, P9-DOD-05 (invoice correction), creator != approver for handover, Admin-only incident close | owner decisions; deliberately not built and not touched |
| PDF rendering of the certificate and receipt | no PDF engine is installed or claimed; the HTML is print-ready and self-contained, a browser prints it |
| Delivery of Admin notifications by e-mail or WhatsApp; delivery of reminders | no provider account; each row says a person relays it |
| Executing a provider fail-over, real outages, real smoke checks and rollbacks | no deployment host, monitor or provider; only the decisions and facts people record |
| Live runs of `customer_success.draft_feedback_signal` | needs a funded model key and the parent's wiring; without a key it fails honestly with `AI_PROVIDER_NOT_CONFIGURED` |
| Browser rendering, clicking and mobile layout of the three new pages, the project panel and the downloads | nothing was rendered; typechecked, linted and structure/action-tested only |
| A Developer-task consumer, automatic task creation | by design a person makes it |
| CI replay on a non-superuser server | not run; the verifiers use `set local session_replication_role` at the top level only (as the existing verifiers do) and never inside a function body; the migrations contain no `session_replication_role` |

## Wiring for the lead (shared files this change did not edit)

1. `package.json`, `db:verify:phase4` chain: append
   `-f scripts/verify-p789-phase-seven-round2.sql -f scripts/verify-p789-phase-eight-round2.sql -f scripts/verify-p789-feedback-signal.sql`
   after the last existing `-f scripts/verify-*.sql`.
2. `app/api/jobs/run/workflows.ts`: import `{ P789_FEEDBACK_SIGNAL_WORKFLOWS }` from `./p789-feedback-signal-workflow` and add `...P789_FEEDBACK_SIGNAL_WORKFLOWS` beside the other spreads (`tests/p789-feedback-signal-workflow.test.ts` accepts either absent or exactly one spread).
3. `app/api/jobs/run/route.ts` (optional crons, all idempotent; none sends anything). With the admin client: `admin.schema('projects').rpc('p789_sweep_client_action_reminders', {})`, `admin.schema('projects').rpc('p789_sweep_alerts', {})`, `admin.schema('finance').rpc('p789_render_receipt_documents', {})`. The existing optional `schedule_handover_follow_ups` job is unchanged.
4. `src/lib/events/catalog.ts`, if it mirrors `core.event_types`: add `project.production_smoke_passed`, `project.production_smoke_failed`, `project.production_rollback_completed`, `project.client_action_reminder_due`, `project.incident_admin_notification_due`, `project.completion_certificate_rendered`, `project.major_release_recorded`, `project.cs_alert_raised`, `project.support_followup_task_created`. No handler is subscribed to any of them.
5. `app/(internal)/projects/[projectId]/page.tsx`: `<P789RoundTwoPanel projectId={projectId} />` from `./p789-round2-panel`.
6. Navigation: link `/projects/p789-operations`, `/projects/customer-success/p789-governance`, `/projects/customer-success/p789-charts` from the Customer Success and projects pages.
7. A client link to the certificate and receipts: `/api/p789/certificate/{projectId}` and `/api/p789/receipt/{paymentId}` (the portal handover and statement pages are shared files; the receipt link belongs on each verified payment row of `portal/[projectId]/statement`).
8. `docs/roadmap/roadmap.json` derived counts: re-derive with `npm run check:record` after merging (3 migrations, 4 test files, 13 tables added by this change).
9. `db:push` of these migrations is safe from this branch: all three are additive (new tables, new functions, new triggers on `p7_incidents`, `p7_validation_runs`, `p7_deployments`; no column was narrowed or renamed).

## Verification

- All 570 migrations apply on a plain scratch Postgres 16.14 (a fresh full apply on port 55456, with the three verifiers re-run on it; the incremental database on 55455 was used while building); the three verifiers end in "verified OK" and roll back.
- `npm run typecheck`, `npm run lint` and `npm run scan:secrets` clean; full `npm test`: 10711 tests, 0 failures (2186 suites), including `tests/p789-round2-actions.test.ts` (26), `tests/p789-round2-migrations.test.ts` (7) and `tests/p789-feedback-signal-workflow.test.ts` (28). The action and workflow tests were red-proved once each (a control removed, the suite went red, restored).
- Not verified: anything in a browser, anything on a real model, a non-superuser CI server.

## Traps found while building (for the next builder)

- A transaction-local door flag set by an earlier door call stays on for the rest of a verifier's single transaction, so "refused when called directly" checks must reset it first (`set_config('projects.p789_door', 'off', true)`).
- Inside one SQL statement a sub-select cannot see rows a function in the same statement just wrote; a check of the form `(call door) = x and exists (read the row)` reads the old snapshot. Split it into two statements.
- `a or true` is optimised away: a "warm-up" call written that way never ran.
- An `UPDATE` of a row inserted in the same transaction re-checks its foreign keys, so fixtures that point at random uuids must be updated with triggers off (`session_replication_role = replica` plus `enable always trigger` for the trigger under test).
- `RLS` is bypassed for the table owner: a "reads none" check must switch to `authenticated` for the table read.
