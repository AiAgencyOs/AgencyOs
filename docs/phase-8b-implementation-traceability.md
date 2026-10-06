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
| 6 MaintenancePlan + PlanVersion | EXISTS | `projects.maintenance_plans` (20260821260000). Not rebuilt. |
| 7 Maintenance renewal states | EXISTS | Already on `maintenance_plans.status`. This change adds the financial gate in front of `active` / `renewed` for billed plans. |
| 7 Critical invariant: completed project stays closed | BUILT | Work is a new record, never an edit of the completed project; requires a delivered handover. |
| 7 Financial invariant | BUILT | Billed plans do not activate before verified payment or an owner-approved, expiring exception (trigger `maintenance_plan_financial_gate`). |
| 7 Automation invariant (duplicates) | BUILT | One live work item per defect / change request / ticket; `(plan, purpose, cycle_start)` unique links; `(work_item, decision_key)` routing; `(request, kind)` proposals. |
| 8 Developer System, QA, Finance, Orchestrator agents | EXISTS | `developer`, `quality_assurance`, `finance`, `orchestrator` and their specialists (`bug_fix`, `regression_test`, development specialists) are already in `registry.ts` and `ai.agents`. None named by these four specs is missing, so no registry edit and no agent migration. |
| 9 Events: DeveloperTaskRequested..., MaintenanceTaskApproved | PARTIAL | Five typed events are emitted (`project.maintenance_work_opened`, `_qa_failed`, `_release_requested`, `_release_approved`, `_released`) plus `finance.maintenance_billing_proposed`. No subscribers or announcers are wired (see manual actions). |
| 9 Scheduled checks: SLA overdue | PARTIAL | SLA state is computed (pure) and shown; a scheduled sweep that escalates breaches is not wired. |
| 9 Outbox / DLQ / retries | EXISTS | The existing outbox and jobs queue. |
| 10 Customer 360, dashboards | MISSING here | Part A. |
| 12 SEC-001..006 | BUILT for this scope | Org-scoped tables, RLS internal-only, cross-tenant negative tests in the verifier, audit rows via `core.record_audit`, secrets refused in every agent door. |
| 13 Testing strategy | PARTIAL | Unit (pure routing/SLA, checkers), DB (verifier, red-proved), stub workflow tests. No browser/E2E, performance, compatibility or real-provider test. |
| 14 E2E-02 (defect -> Developer fix -> QA -> release -> client confirmation -> close) | PARTIAL | Defect -> fix -> independent QA -> Admin approval -> recorded release is driven in the verifier. Client confirmation and closing the ticket are part A. |
| 14 E2E-04 (plan -> invoice -> verified payment -> active) | PARTIAL | Quote -> proposal -> accept -> link -> gate -> activation (with exception) driven; the real payment verification stays the existing Admin door and is not driven here. |
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
| 6 Unable to reproduce / scope expansion / emergency / migration / tests fail | PARTIAL | Scope expansion: `needsScopeChange` flag on proposals, refusal of unauthorized enhancement. Emergency: Admin-authorized, QA and approval still required, rollback required. Failing tests: failing QA returns the item and opens a defect. "Unable to reproduce" relies on the existing defect states. Migration/destructive safety: `sensitive` forces a security QA result; no separate backup/approval control was built. |
| 7 Structured handoff contract | PARTIAL | Typed events and records carry org/project/commit/defect/change-request IDs. No `BuildCreated` / `MigrationPrepared` events (nothing builds here). |
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
| 6 Post-deploy smoke failure -> incident/rollback | MISSING | Smoke evidence is recorded by a person; no automated smoke check or rollback trigger. |
| 7 Events QAHandoffCreated, TestRunCompleted, QAPassed... | PARTIAL | `project.maintenance_qa_failed` only; a pass is the item state `qa_passed`. |
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
| 6 Renewal payment verified -> extend exact cycle | PARTIAL | Cycles are recorded on links; extending `ends_on` on verification is not automated. |
| 7 Events MaintenancePlanAccepted, InvoiceCreated, PaymentVerified | PARTIAL | Existing events cover invoice/payment; only `finance.maintenance_billing_proposed` is new. |
| GST/non-GST billing identity | EXISTS | Existing billing profile and composer. |

## Orchestrator / Router spec

| Section | Status | Notes |
|---|---|---|
| 5 Select specialist, route under policy, validate tenant scope | BUILT | `src/modules/orchestrator/maintenance-route.ts` (pure) + `projects.record_maintenance_routing` (service-only, organization checked). |
| 5 Dependencies: finance/approval/QA gates cannot be skipped | BUILT | Held while the authorization gates are open; a builder is never routed as QA (DB and TS). |
| 5 Retry/fallback/DLQ | PARTIAL | Existing runner. A held emergency or a held item past its SLA is `escalated`. |
| 5 Deadlock detection | MISSING | No sweep. |
| 5 Record routing/cost/decision evidence | PARTIAL | Candidates, SLA and policy version are recorded; model/provider cost on routing is not (no model is called by the router). |
| 6 Provider unavailable -> fallback | EXISTS | `src/modules/orchestrator/fallback.ts`; unchanged. |
| 14 Admin routing policy, provider limits | MANUAL_EXTERNAL | Existing Admin policy. |
| SLA-aware scheduling | BUILT | `projects.maintenance_sla_policies` (Admin-set, versioned, none seeded) and `rankMaintenanceQueue`. |

## Seams with part A (documented, not built here)

- `projects.maintenance_items` is the ticket. Part A may extend it; work items hold `ticket_id` only and require `coverage in (warranty, maintenance)`.
- `qa.defects` rows opened by a failed post-launch QA result have `phase6 = false` and may be used by Support.
- `finance.maintenance_billing_links` and `finance.maintenance_financial_gate(plan)` are the only things part A needs to call for maintenance plan activation/renewal payment state.
