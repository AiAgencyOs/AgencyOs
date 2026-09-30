# Theme W5 — QA, release, communication: build report

Migrations: 20261006500000 (QA), 20261006500100 (release), 20261006500200 (communication). Verifier: `npm run db:verify:w5` (scripts/verify-w5-qa-release-comms.mjs, 76 checks, verify.yml step). Tests: tests/w5-qa-release-communication.test.ts (17, incl. a local fake SMTP server).

| Row | Result |
|---|---|
| SCR-044 Assign retest | BUILT earlier (AssignRetestForm on /qa); populated state needs a fixed defect |
| SCR-044 Coverage matrix category columns | UNVERIFIED: columns render from plan items; local data has 1 plan |
| SCR-044 Add Device (was a link to /projects) | BUILT: Add Device form, qa.add_device_configuration, tiles for registered devices |
| SCR-045 Test case list/edit | BUILT: edit form, search + category filter, qa.update_test_plan_item (refused on an approved plan) |
| SCR-045 Linked task | BUILT earlier (LinkTaskForm); unchanged |
| SCR-045 Requirement without a case | BUILT: Requirement coverage list, waive/restore with written rationale |
| SCR-046 Tester, environment | BUILT: test_runs.tester_id/environment on open, record, rerun; shown on rows and run page |
| SCR-046 Screenshots/logs | BUILT: qa.test_run_evidence (append-only, on closed runs too). File upload itself NOT testable locally (storage unreachable): evidence is a link |
| SCR-046 Run detail page, retest history, run filter | BUILT: /projects/[id]/qa/runs/[runId]; suite/status filter chips |
| SCR-048 Unsupported device/configuration | BUILT: qa.device_configurations, reason mandatory (CHECK + door), matrix cells say Unsupported |
| SCR-049 Rollback readiness tile, dependencies, rollback plan, smoke checklist | BUILT: projects.release_records, no handover needed; data backfilled from handovers |
| SCR-049 Record post-deploy verification | BUILT: projects.release_verifications |
| SCR-057 pending-template count | BUILT: "Waiting on a template" tile (deferred sends; submitted templates in caption) |
| SCR-057 email / client-update lane | BUILT: crm.outbound_emails, door + composer + resend-with-reason; uses the invoice-email transport. Real provider NOT testable: fake SMTP test |
| SCR-057 /leads/null | FIXED: conversationHref; group rows open the project, never /leads/null |
| SCR-059 project/client audience picker, timelines | BUILT: announcements.project_id/client_account_id; project Activity feed and Client 360 read them |
| SCR-059 reusable templates, milestone-driven | BUILT: crm.announcement_templates; met client-visible milestone drafts from the active milestone template; button for earlier ones |
| SCR-059 Send preview | BUILT: preview panel in the composer (records, sends nothing) |
| SCR-060 requeue with reason | BUILT: crm.requeue_failed_delivery + crm.delivery_retry_reasons; reason shown in history |
| SCR-060 uploader shown as id fragment | FIXED: name on meeting evidence |
| SCR-060 meeting file upload | NOT-BUILDABLE locally (storage) |

Owner questions: none raised. The email lane records only what this deployment's transport answers; configure RESEND_API_KEY or SMTP_* to send.
