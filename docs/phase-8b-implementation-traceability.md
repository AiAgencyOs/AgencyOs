# Phase 8 part B: implementation traceability

Scope: post-launch maintenance engineering and its governance. Sources: the Phase 8 master plan, the Developer, QA, Finance and Orchestrator/Router agent specifications.
Part A (Customer Success, Support, Upsell, Sales) is another change; this file references its tables only through the seams listed at the end.

Status words: EXISTS (reused, verified present), BUILT (built here, driven through real doors), PARTIAL, MISSING, MANUAL_EXTERNAL.
Everything agent-driven is STUB-PROVEN: no real model, repository, deployment or payment provider has run any of it.

## Master plan (the parts that touch this scope)

| Section | Status | Where / why |
|---|---|---|
| 1 Finance: "treat proof screenshot as verified payment" not allowed | BUILT | `finance.maintenance_financial_gate` reads `finance.net_verified_minor`; a status of paid with no verified payment is not the gate (verifier). Payment verification is untouched. |
| 1 Maintenance: "unlimited free development" not allowed | BUILT | `projects.maintenance_work_items` cannot exist without a defect, a covered ticket or an approved change request; an enhancement needs the change request. |
| 1 Automation: "bypass finance, approval, security or deployment gates" not allowed | BUILT | Ten gates in `projects.evaluate_maintenance_gates`; status moves only through doors (table trigger holds service role too). |
| 6 SupportTicket (fix/release/client confirmation) | PARTIAL | The ticket stays `projects.maintenance_items` (EXISTS). Work items reference it. Client confirmation and close belong to part A. |
| 6 UsageLedger, CustomerHealthSnapshot, RecoveryPlan, CustomerOpportunity, Renewal, CancellationRecord, CommunicationRecord | MISSING here | Part A. |
| 6 MaintenancePlan + PlanVersion | EXISTS, extended by part C | `projects.maintenance_plans` (20260821260000) is the plan; part C adds the Admin-set, versioned catalog (`projects.maintenance_plan_catalog`, price lines entered as data) and opens plans from a published version (`projects.open_maintenance_plan`). |
| 6 UsageLedger, Renewal, CancellationRecord (maintenance) | BUILT in part C | `maintenance_usage_entries` (append-only, reversal entries), `maintenance_overage_drafts` (a draft a person quotes), `maintenance_plan_renewals`, `maintenance_plan_cancellations`; see `docs/phase-8c-implementation-log.md`. |
| 7 Maintenance renewal states | EXISTS + BUILT (part C) | Already on `maintenance_plans.status`. Part B put the financial gate in front of `active` / `renewed` for billed plans; part C gives every state a door (accept, activate, propose, client decision, confirm, cancel, reinstate) for plans in the lifecycle. |
| 7 Critical invariant: completed project stays closed | BUILT | Work is a new record, never an edit of the completed project; requires a delivered handover. |
| 7 Financial invariant | BUILT | Billed plans do not activate before verified payment or an owner-approved, expiring exception (trigger `maintenance_plan_financial_gate`). |
| 7 Automation invariant (duplicates) | BUILT | One live work item per defect / change request / ticket; `(plan, purpose, cycle_start)` unique links; `(work_item, decision_key)` routing; `(request, kind)` proposals. |
| 8 Developer System, QA, Finance, Orchestrator agents | EXISTS | `developer`, `quality_assurance`, `finance`, `orchestrator` and their specialists (`bug_fix`, `regression_test`, development specialists) are already in `registry.ts` and `ai.agents`. None named by these four specs is missing, so no registry edit and no agent migration. |
| 9 Events: DeveloperTaskRequested..., MaintenanceTaskApproved | BUILT (part C) | Five typed events are emitted (`project.maintenance_work_opened`, `_qa_failed`, `_release_requested`, `_release_approved`, `_released`) plus `finance.maintenance_billing_proposed`; part C subscribes an internal-channel PM announcer to each (PM8-C01..C06) and adds `project.maintenance_sla_breached` and `project.maintenance_work_stalled` (PM8-C07, C08). |
| 9 Scheduled checks: SLA overdue | BUILT (part C) | `projects.sweep_maintenance_sla` (service role) records each breach once against the Admin-set target and an Admin acknowledges it; called from the cron tick via `sweepMaintenanceLifecycle`. No policy, no breach: no hours are invented. |
| 9 Outbox / DLQ / retries | EXISTS | The existing outbox and jobs queue. |
| 10 Customer 360, dashboards | MISSING here | Part A. |
| 12 SEC-001..006 | BUILT for this scope | Org-scoped tables, RLS internal-only, cross-tenant negative tests in the verifier, audit rows via `core.record_audit`, secrets refused in every agent door. |
| 13 Testing strategy | PARTIAL | Unit (pure routing/SLA, checkers), DB (verifier, red-proved), stub workflow tests. No browser/E2E, performance, compatibility or real-provider test. |
| 14 E2E-02 (defect -> Developer fix -> QA -> release -> client confirmation -> close) | PARTIAL | Defect -> fix -> independent QA -> Admin approval -> recorded release is driven in the verifier. Client confirmation and closing the ticket are part A. |
| 14 E2E-04 (plan -> invoice -> verified payment -> active) | PARTIAL | Part C drives catalog -> plan -> client acceptance -> link -> gate -> `activate_maintenance_plan` (verified money, and the owner-approved exception path) and renewal; the real payment verification stays the existing Admin door and is a fixture row in the verifier. |
| 14 E2E-06 (out of scope -> Change Request) | BUILT | Feature ticket and new-project change request are refused as maintenance. |
| 14 E2E-12 (duplicate event) | BUILT | Idempotency listed above. |
| 14 E2E-13 (cross-tenant) | BUILT | Verifier: another organization sees and decides nothing. |
| 14 E2E-15 (provider failure) | PARTIAL | Workflows fail the job with the reason; retries use the existing runner. |
| 15 P8-IMP-019/020/021 | PARTIAL | Typed workflow packets and audit are built for this scope only. |

## Developer Agent System spec

| Section | Status | Notes |
|---|---|---|
| 1 Mission, no-false-completion | BUILT | Nothing here asserts completion; `released` needs a deployment reference and smoke evidence supplied by an Admin. |
| 2 Activation: confirmed defect, approved maintenance task, approved change request | BUILT | `open_maintenance_work` bindings. Security/dependency maintenance via a covered ticket (`area = dependency`). Emergency: Admin-authorized hotfix. |
| 3 Inputs: ticket/defect, commit, scope reference, acceptance, priority, rollback | BUILT | Work item + exact 40-hex commit + rollback plan/owner + derived priority. Acceptance criteria live on the defect / change request. |
| 4 Forensic audit | BUILT (this file) | |
| 5 Responsibilities: smallest safe change, reference exact commit | BUILT | Bug Fix proposal workflow; commit submission door. Writing the code and running the tests are outside AgencyOS (no repository access). |
| 6 Unable to reproduce / scope expansion / emergency / migration / tests fail | PARTIAL | Scope expansion: `needsScopeChange` flag on proposals, refusal of unauthorized enhancement. Emergency: Admin-authorized, QA and approval still required, rollback required. Failing tests: failing QA returns the item and opens a defect. "Unable to reproduce" relies on the existing defect states. Migration/destructive safety: BUILT in part C: a sensitive change that touches the database (area = database) needs a rollback plan and a backup-confirmed evidence reference for the exact commit, recorded by someone other than the author, before release can be requested or approved (`data_safety`, the eleventh gate). Evidence is a reference only. |
| 7 Structured handoff contract | PARTIAL (improved, gaps log G6) | Typed events and records carry org/project/commit/defect/change-request IDs. `projects.record_maintenance_build` lets a person record a build or a prepared (not applied) migration against the exact submitted commit; events `project.maintenance_build_created` / `project.maintenance_migration_prepared` announce it; verified and red-proved in `scripts/verify-phase-eight-b-build-records.sql`. AgencyOS itself builds and applies nothing, so the events are records of what a person did elsewhere. `DevelopmentStarted` / `CodeChangeReady` are not separate events (CodeChangeReady is the existing QA handoff). |
| 8 Data/evidence/memory | BUILT | Actor, time, commit, reason, evidence on every record; history append-only. |
| 9 Forbidden: unapproved scope, secrets, bypass gates, claim success | BUILT | Refusals above plus secret scan in every text door. |
| 10 Failure/retry | PARTIAL | Existing job retry. Bounded escalation of a held item: `escalated` routing outcome. |
| 11 DEV-TST-001..008 | PARTIAL | See master plan testing row. |
| 12 DEV-IMP-001 | EXISTS | Registry unchanged. |
| 12 DEV-IMP-002 | BUILT | Strict Zod schemas; the doors re-check the organization. |
| 12 DEV-IMP-004 | BUILT | Gates before release; Admin-only approval. |
| 12 DEV-IMP-011 | BUILT | `phase-eight-b-panel.tsx`. |
| 13 DEV-DOD-010 (downstream accepted the handoff) | PARTIAL | QA accepts by recording a result; no deployment handoff exists. |
| 14 Manual config | MANUAL_EXTERNAL | See manual actions. |

## QA Agent spec

| Section | Status | Notes |
|---|---|---|
| 5 Independent verification, "developer self-report is not QA evidence" | BUILT | `record_maintenance_qa_result` refuses the commit's author; the gate also refuses an author-recorded result. |
| 5 Defect/retest loop | BUILT | A failing result opens a `qa.defects` row on the exact commit; a defect-linked fix needs the defect VERIFIED by `qa.record_retest` (Phase 6 loop reused). |
| 5 Regression on important changes | BUILT | `regression` QA is a mandatory gate; `security` when the change is marked sensitive. |
| 6 Critical/high unresolved defect: do not recommend release | BUILT | `no_other_s0_s1` gate reads `qa.unresolved_product_defects`. |
| 6 Post-deploy smoke failure -> incident/rollback | PARTIAL (improved, gaps log G1) | `projects.report_maintenance_smoke_failure` (delivery staff / Admin, on a RELEASED change only, evidence required, one open per change) and `projects.decide_maintenance_smoke_failure` (Admin, independent of the reporter, in the door and in a table CHECK; rollback_executed / forward_fix / false_alarm with a note). Events `project.maintenance_smoke_failed` / `_decided`. Driven and red-proved in `scripts/verify-phase-eight-b-smoke-and-events.sql`. Still open: AgencyOS runs no smoke check and rolls nothing back (no deployment executor; MANUAL_EXTERNAL). |
| 7 Events QAHandoffCreated, TestRunCompleted, QAPassed... | EXISTS (gaps log G2) | `project.maintenance_qa_handoff_created`, `project.maintenance_test_run_completed`, `project.maintenance_qa_passed`, emitted by triggers on the rows that change (migration `20261122100000`); verified once-only and red-proved in the same verifier. `project.maintenance_qa_failed` pre-existed. |
| 11 QA_-TST-001..008 | PARTIAL | UI/accessibility, performance, compatibility and real E2E not covered. |
| Regression plan agent | BUILT (stub) | `maintenance.regression_test.plan`: a proposal; it records no result. |

## Finance Agent spec

| Section | Status | Notes |
|---|---|---|
| 5/6 Plan accepted -> invoice -> pending verification, do not activate | BUILT | Proposal -> person makes the invoice with the existing composer / `create_change_request_invoice` -> link -> gate. |
| 5 Payment screenshot is a submission, not verification | EXISTS | `finance.payment_submissions` / `verify_payment`; untouched. The gate reads verified money only. |
| 5 Create Admin verification request, PaymentVerified only from authorized verification | EXISTS | Existing doors. Not rebuilt. |
| 5 Prevent activation before the gate unless an approved exception | BUILT | Trigger + owner-approved, expiring exception (requester cannot approve). |
| 5 Receipt / final financial record | EXISTS | Existing receipt doors (20260928130000). |
| 5 Reminders linked to the correct invoice, stop after verified full payment | BUILT as draft text | A reminder proposal names its invoice and is refused once the invoice is not collectible. Sending is a person's act through the existing reminder machinery. |
| 5 Reconcile provider/bank records | EXISTS | Existing reconciliation; not rebuilt. |
| 6 Partial/over/under/unmatched payment | EXISTS | Existing payment exception state; not rebuilt. |
| 6 Discount/price change needs approved revision | BUILT | The agent door takes no amount; the accepted invoice must carry the quoted total. |
| 6 Renewal payment verified -> extend exact cycle | BUILT (part C) | Never automatic: `confirm_maintenance_renewal` (an independent Admin, after the client's recorded acceptance) extends `ends_on` to the exact linked cycle only when `finance.maintenance_financial_gate` says verified money or an approved exception. A lapsed plan is not revived. |
| 7 Events MaintenancePlanAccepted, InvoiceCreated, PaymentVerified | PARTIAL | Existing events cover invoice/payment; only `finance.maintenance_billing_proposed` is new. |
| GST/non-GST billing identity | EXISTS | Existing billing profile and composer. |

## Orchestrator / Router spec

| Section | Status | Notes |
|---|---|---|
| 5 Select specialist, route under policy, validate tenant scope | BUILT | `src/modules/orchestrator/maintenance-route.ts` (pure) + `projects.record_maintenance_routing` (service-only, organization checked). |
| 5 Dependencies: finance/approval/QA gates cannot be skipped | BUILT | Held while the authorization gates are open; a builder is never routed as QA (DB and TS). |
| 5 Retry/fallback/DLQ | PARTIAL | Existing runner. A held emergency or a held item past its SLA is `escalated`. |
| 5 Deadlock detection | BUILT (part C) | `projects.maintenance_work_stall_reasons` (derived) + `projects.sweep_maintenance_stalls`: no independent approver, no independent QA, authorization no longer valid, and inactivity against an Admin-set threshold (none assumed). Recorded once per reason and state; the work item's status is unchanged. |
| 5 Record routing/cost/decision evidence | PARTIAL (honest: no model call) | Candidates, SLA and policy version are recorded; model/provider cost on routing is not (no model is called by the router). Round 2 (`docs/phase-7-8-9-round2-gaps-log.md`), migration `20261129100000`: `projects.p789_maintenance_routing_cost_evidence` returns, per routing decision, `model_call = false`, `cost_minor = null` and the statement that the router made no model call so there is no cost to record. No cost column exists and none was added; a figure will exist only when a funded model routes. `scripts/verify-p789-phase-eight-round2.sql` (75 checks, 21 red-proofs). |
| 6 Provider unavailable -> fallback | EXISTS | `src/modules/orchestrator/fallback.ts`; unchanged. |
| 14 Admin routing policy, provider limits | MANUAL_EXTERNAL | Existing Admin policy. |
| SLA-aware scheduling | BUILT | `projects.maintenance_sla_policies` (Admin-set, versioned, none seeded) and `rankMaintenanceQueue`. |

## Closed by part C (see `docs/phase-8c-implementation-log.md`)

Plan catalog and versions, client acceptance (staff-recorded, with evidence), the payment gate for activation and renewal, usage ledger, overage draft, renewal flow, cancellation and churn reasons, client-safe plan/usage reads, PM announcers for the declared 8B events, the SLA-breach sweep, stall detection and the data-safety control. Still open: see the log's "Not done" list.

## Seams with part A (documented, not built here)

- `projects.maintenance_items` is the ticket. Part A may extend it; work items hold `ticket_id` only and require `coverage in (warranty, maintenance)`.
- `qa.defects` rows opened by a failed post-launch QA result have `phase6 = false` and may be used by Support.
- `finance.maintenance_billing_links` and `finance.maintenance_financial_gate(plan)` are the only things part A needs to call for maintenance plan activation/renewal payment state.
