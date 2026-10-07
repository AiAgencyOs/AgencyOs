# Phase 1-3 rest-gaps log (2026-11-28)

Scope: the buildable PARTIAL / MISSING rows of `docs/phase-1-3-implementation-traceability.md` that are NOT in the Orchestrator, Quotation Master, Coordination or Scheduler clusters: Blueprint screens, Technical API / data contract, CRM, Final Gap-Closure and Definition-of-Done, and the Phase 2 / 3 PM, Planning and UI Designer rows. Everything here was built against a scratch Postgres 16 and a stand-in model; nothing was run against a funded model, a WhatsApp number, an email provider or a payment gateway.

All new objects are prefixed `p13_`. No shared wiring file was edited (`app/api/jobs/run/route.ts`, `workflows.ts`, `src/lib/events/catalog.ts`, project `page.tsx`, `package.json`, `roadmap.json`, existing verifiers). Two existing files were edited in place because they are the thing being fixed, not wiring: `app/api/sales/pipeline/export/route.ts` (logs before the file) and `docs/phase-1-3-implementation-traceability.md` (rows).

## Rows closed (EXISTS) and rows moved

| Row | New status | What exists |
|---|---|---|
| P1-MP3-030, P1-API-018 | EXISTS [wiring W5] | `core.p13_webhook_events`, `core.p13_record_webhook_event`, `core.p13_finish_webhook_event`, `src/lib/p13/webhook-ledger.ts` |
| P1-MP3-035, P1-API-021 | EXISTS [wiring W5] | `core.p13_circuit_breakers`, `p13_circuit_admit / record / force`, `src/lib/p13/circuit-breaker.ts` |
| P1-MP3-038, P1-API-022 | EXISTS [wiring W5] | `src/lib/p13/canonical-errors.ts` (12 codes of spec section 21; the matrix row said 14) |
| P1-BLUEPRINT-044, -030 | EXISTS | `core.p13_policy_versions` + three doors, `/settings/policy-versions` with impact preview |
| P1-BLUEPRINT-032 | EXISTS [wiring W8] | `core.p13_notification_rules`, `p13_set_notification_rule`, `p13_notification_decision`, `/settings/notification-rules`, `notificationVerdict()` |
| P1-BLUEPRINT-013, P1-MP3-135 | EXISTS | `/requirements/compare`, `src/modules/crm/requirement-diff.ts` |
| P2-PLAN-020, P2-PLAN-027, P2-FLOW-028 | EXISTS | four planning events by trigger; `/operations/phase-blockers` |
| P3-PM-005, P3-PM-006 [W9], P3-PM-030 [W10] | EXISTS | design clarification loop, `blocked_requirement` writer + `guardDesignContext`, design-share reminders + `sweepDesignShareReminders` |
| P1-CRM-057, -040, -051 | EXISTS | CRM export log (route wired), lost-deal snapshot trigger, do-not-contact door |
| P1-DOD-095, P1-DOD-117 | EXISTS | defect priority; `scripts/phase1-verdict.mjs` |
| P1-BLUEPRINT-031, P1-QUOTE-018, P1-API-024, P1-BLUEPRINT-019/020/022/046, P1-DOD-061 | PARTIAL, evidence updated | each row says what moved and what is still open |

39 rows now say "Closed 2026-11-28 (p13)" in the summary table; the status counts are recomputed (EXISTS 809 -> 831, PARTIAL 456 -> 442, MISSING 27 -> 19). The matrix total is unchanged at 1307 rows.

## What stays open, and why

- **Built and not yet reachable (wiring below).** The webhook ledger, circuit breaker and canonical error map exist and are proved, but no webhook route or adapter calls them yet. The notification gate exists but no sender asks it. The design-context guard and the share-reminder sweep exist but nothing subscribes or schedules them. These rows say `[wiring pending]`.
- **Needs a funded model:** none of this work calls a model. `guardDesignContext` is deterministic by design.
- **Needs provider credentials:** the share reminder needs the WhatsApp sender (BLK-003); the sweep records a reminder only when the injected sender confirms, so an unconfigured sender produces `not_sent` and records nothing.
- **Owner decisions, not code:** role set (Auditor / Sales / Operations), the 14-state lead vocabulary (P1-CRM-011), ROUTE_SCORE, client-specific pricing (P1-QUOTE-017), data-classification vocabulary (P1-HANDOFF-010), per-owner calendars. Not touched.
- **Left as BUILDABLE and not done here:** REST `/api/v1` (P1-MP3-027, P1-API-003/008/026, an architecture decision first); task-contract columns on `ai.handoffs` (acceptance criteria, retry budget, idempotency; the Orchestrator / Coordination builder owns `ai.handoffs`); policy versions read by the quoting / discount engine (P1-BLUEPRINT-031, P1-QUOTE-018 remainder); Lead 360 Negotiation / Tasks / Audit tabs and the Negotiation workspace (A15) and Incidents queue (A29); scoring weights as data (P1-CRM-019/020); the 14 other CRM analytics rows; P2-FLOW-031 Phase 2 runbook and the other docs-only rows; the remaining Phase 2 PM template-editing rows (owner decision on who edits client wording); preview-render and Figma rows (P3-UID-007 and friends need Figma / credentials).
- **P1-DOD-061 is a ratchet, not a closure:** 33 of 42 routes still answer with ad-hoc JSON errors; they are pinned in `tests/p13-route-errors-and-crm-export.test.ts` and may only shrink.
- **Not checked in a browser:** `/settings/policy-versions`, `/settings/notification-rules`, `/operations/task-board`, `/operations/phase-blockers`, `/requirements/compare`, `/projects/[projectId]/design-clarifications` were type-checked, linted and covered by source-level and model tests, not rendered.
- **`src/lib/db/types.ts` is stale** for every p13_ object (Docker is needed for `npm run db:types`); the new callers go through `src/lib/p13/loose-client.ts`, a narrow explicitly-loose view, and validate what comes back.

## Wiring the lead must add

> **Status 2026-11-30:** W5 (webhook ledger on the three inbound routes, circuit breaker on the model call), W6 (links), W7 (approval detail), W8 (notification gate in the internal announcers and the follow-up worker) and W10 (design-share reminders on the cron tick) are wired; W9 was wired earlier. Proofs: `tests/p13-webhook-wiring.test.ts`, `p13-model-circuit-wiring.test.ts`, `p13-notification-and-approval-wiring.test.ts`, `p13-design-share-reminder-wiring.test.ts`, `p13-links-wiring.test.ts`. Not done: the ledger is fail-open by decision (an unreachable ledger never stops a customer message), and the deployment-wide backlog alert (`alertOnBacklog`) has no organization, so no per-organization notification rule applies to it.

**W5 - webhook ledger, circuit breaker, canonical errors** (`app/api/webhooks/{whatsapp,email,facebook-leads}/route.ts` and the adapters; not edited here)

```ts
import { finishWebhookDelivery, httpStatusForOutcome, recordWebhookDelivery } from '@/lib/p13/webhook-ledger';
// after the signature check, before any state change:
const decision = await recordWebhookDelivery(admin, { organizationId, provider: 'whatsapp', eventKey: providerMessageId, signatureStatus: 'valid', eventAt, body: rawBody });
if (decision.outcome !== 'accepted') return new Response(null, { status: httpStatusForOutcome(decision.outcome) });
// ... process ... then:
await finishWebhookDelivery(admin, decision.eventId, { ok: true }); // or { ok: false, errorClass: classifyFailure(...) }
```

Call `recordWebhookDelivery` for a bad signature too (`signatureStatus: 'invalid'`, `organizationId: null`) so the rejection is on record. For adapters: `withCircuit(admin, organizationId, 'openrouter', async () => { ... return { ok: false, errorClass: classifyFailure({ status }) } })`, and translate `{ ran: false }` into a PROVIDER_UNAVAILABLE refusal with `retryAfterSeconds`.

**W6 - links** (new pages live under their parents so the rail test holds; no `nav-config.ts` edit)

- `app/(internal)/settings/settings-tabs.tsx`: add `Policies` -> `/settings/policy-versions` and `Notification rules` -> `/settings/notification-rules`.
- `app/(internal)/operations/page.tsx`: add links to `/operations/task-board` and `/operations/phase-blockers`.
- requirement set panel: a Compare link to `/requirements/compare?conversation=<id>&a=<n>&b=<m>`.
- project page: a link to `/projects/<id>/design-clarifications`.

**W7 - approval detail** (`app/(internal)/approvals/[requestId]/page.tsx`): `readApprovalAnnotation(requestId)` from `@/modules/approvals/p13-annotation` for the risk badge and policy version; two small forms posting `requestId` and `note` to `markApprovalExecutedAction` and `markApprovalVerifiedAction` from `@/modules/approvals/p13-annotation-actions` (admin only; execute shows only on an approved request, verify only after execute).

**W8 - notification gate:** in each sender (meeting reminder, approval announcement, follow-up, incident alert), before sending: `const v = await notificationVerdict(admin, { organizationId, eventClass: 'meeting_reminder', channel: 'whatsapp', severity, lastSentAt }); if (!v.allowed) return held`. For client-facing sends treat `v.degraded` as hold.

**W9 - design-context guard**

- `src/lib/events/catalog.ts`: `HANDLERS` add `'ui_designer:p13GuardDesignContext'`; `HANDLER_JOB_KIND`: `'ui_designer:p13GuardDesignContext': 'design.context_guard'`; `SUBSCRIPTIONS`: `'project.screen_list_finalized': ['ui_designer:designDirections', 'ui_designer:p13GuardDesignContext']`.
- `app/api/jobs/run/route.ts`: `import { guardDesignContext } from '@/modules/projects/design-context-guard';` and `runEventJobs(admin, HANDLER_JOB_KIND['ui_designer:p13GuardDesignContext'], guardDesignContext, 'runDesignContextGuardJobs')`, exactly as `announceMeetingBooked` is drained.

**W10 - design-share reminders:** from the cron route, for each organization: `sweepDesignShareReminders(admin, { organizationId }, send)` from `@/modules/projects/design-share-followups`, where `send` wraps the existing outbound WhatsApp path (returns `{ sent: false, reason: 'WHATSAPP_NOT_CONFIGURED' }` until BLK-003 is done).

**Also**

- `package.json` `db:verify:phase4` chain (and `.github/workflows/verify.yml` if it lists them): append `-f scripts/verify-p13-webhook-ledger-and-circuit.sql -f scripts/verify-p13-policy-versions-and-approval-risk.sql -f scripts/verify-p13-notifications-planning-and-design-clarification.sql -f scripts/verify-p13-crm-export-lost-snapshot-and-defect-priority.sql`. Each rolls back.
- `docs/roadmap/roadmap.json` counts: `npm run check:record` reports six disagreements, all counts: migrations 567 -> 571, test files 522 -> 531 (this change adds 9 `tests/p13-*.test.ts`), tables 463 -> 472, tables with RLS 324 -> 333, tests 10639 -> the number `npm test` prints. Re-run `check:record` after merging with the other builder, because their counts add to these.
- Master-plan change log (section 10): not touched.

## Files

Migrations: `20261128000000` (ledger, breaker), `20261128100000` (policy versions, approval annotations), `20261128200000` (notification rules, planning events, design clarification, blocked_requirement, share reminders), `20261128300000` (CRM export log, lost snapshot, do-not-contact, defect priority).

SQL verifiers (psql `-v ON_ERROR_STOP=1`, each rolls back): `scripts/verify-p13-webhook-ledger-and-circuit.sql`, `scripts/verify-p13-policy-versions-and-approval-risk.sql`, `scripts/verify-p13-notifications-planning-and-design-clarification.sql`, `scripts/verify-p13-crm-export-lost-snapshot-and-defect-priority.sql`; red-proof helper `scripts/p13-red-proof.sh`; `scripts/phase1-verdict.mjs`.

Code: `src/lib/p13/*` (canonical-errors, webhook-ledger, circuit-breaker, loose-client, notification-gate, notification-rules, task-board(+queries), phase-blockers(+queries)); `src/modules/approvals/p13-*`; `src/modules/crm/{requirement-diff,requirement-compare-queries,export-log}.ts`; `src/modules/projects/{design-context-guard,design-share-followups,p13-design-clarifications,p13-design-clarification-actions}.ts`; `src/ui/primitives/version-diff.tsx`; pages under `app/(internal)/{settings/policy-versions,settings/notification-rules,operations/task-board,operations/phase-blockers,requirements/compare,projects/[projectId]/design-clarifications}`.

Tests (9 files, `tests/p13-*.test.ts`): platform contracts, policy versions, notifications and follow-ups, design-context guard, requirement diff, task board, route errors and CRM export, phase 1 verdict, phase blockers.

## Verification

- **Scratch Postgres 16, port 55454, all 571 migrations applied** (`KEEP=1` copy of `scripts/apply-migrations-locally.sh`); `core.unguarded_org_fks()` returns 0 rows after the new tables (the two self-referencing foreign keys needed their own `enforce_parent_org` triggers; found and fixed by that check).
- **229 live SQL checks** across the four verifiers (56 + 64 + 69 + 40), all green, each including negatives (a plain member refused, another organization sees nothing, wrong state refused, forged or stale input rejected).
- **About 60 red-proofs**: each control was broken by rewriting the live function through `pg_get_functiondef` + `replace` (a mutation that changed nothing raised `NO-OP MUTATION`), the verifier had to go red, and the migration was re-applied to restore it. Four mutations first came back NOT-RED and were fixed before being counted: a redundant clause in `p13_policy_version_in_force` was removed (no test could tell it from the ordering), and three missing assertions were added (critical notice not held by the minimum interval, newest quotation version chosen, a contact with no consent row). Several controls go red through a CHECK constraint or a foreign key rather than an assertion; those are defence in depth, and the assertion-level red is the one counted where both exist.
- **Gates in this worktree:** `npm run typecheck` clean, `npm run lint` clean (ignoring untracked `.agencyos/`), `npm test` 10700+ passing / 0 failing, `npm run scan:secrets` clean. `npm run check:record` fails only on the six roadmap counts listed above.
- **Not verified:** any rendered page; any real webhook, WhatsApp, email or model call; the four SQL verifiers on the CI Postgres (they were run as a superuser on the scratch server; the new functions use no `session_replication_role`, but the verifiers' fixtures set it `local`, exactly as the existing phase 4 verifiers do).
