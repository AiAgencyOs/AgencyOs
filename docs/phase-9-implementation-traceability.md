# Phase 9 implementation traceability (Finance Agent, cross-phase financial control)

Source: `AgencyOS_Phase_9_Implementation_Plan_Checklist_Testing.pdf` (**PLAN**) and `AgencyOS_Phase_9_Finance_Agent_Detailed_Specification.pdf` (**SPEC**), read from the repository folder `phase 9/`. Statuses: **EXISTS** (built, with the evidence named), **PARTIAL** (some of it, the gap stated), **MISSING** (not built, why), **MANUAL_EXTERNAL** (needs a person, a credential or a provider).

"Phase 9" evidence below means this change: migrations `20261106100000` to `20261106500000`, the verifier `scripts/verify-phase-nine.sql` (191 checks, every control red-proved by mutating its live definition), and the `tests/phase-nine-*.test.ts` files. Items marked "pre-existing" were built by earlier phases and are listed so the map is complete; Phase 9 did not re-prove them except where it says so. The legacy `.mjs` finance verifiers (`verify-finance-w1`, `verify-finance-x1`, `verify-milestone-invoicing`) need a PostgREST stack and were NOT run in this work; the SQL verifiers (36 of them, including `verify-phase-four-e2e.sql`) were run against the fully migrated scratch database and pass, and no Phase 9 migration defines, replaces or calls any verification, refund, issue, void or payment-recording function (a structural test pins that).

## Locked invariants (PLAN §2, §4; SPEC §1, §5)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-INV-01 | PLAN 2 | A client payment message or screenshot is not verified payment | EXISTS | pre-existing: `finance.payment_submissions` start `pending_verification`; `finance.verify_payment` is owner / runner only. Phase 9 adds: an unverified payment is never collected, never revenue, and is itself a close blocker (`unverified_money`, `payment_submission_unresolved`); verifier section 2 |
| P9-INV-02 | PLAN 2 | Operational and financial milestone completion are separate states | EXISTS (Phase 9B) | operational status stays `projects.milestones.status`; the financial state is now a DERIVED read, `finance.milestone_financial_lifecycle(project)` / `milestone_financial_state(milestone)` (migration `20261111200000`): not_invoiced, invoiced, partially_verified, fully_verified, waived, refunded, overdue, disputed, computed on every call from invoices, verified payments, waivers, refunds and open disputes, never stored (a check asserts no stored column and that the state follows the books with nothing updated). `scripts/verify-phase-nine-b.sql` (161 checks, every control red-proved) section 2 |
| P9-INV-03 | PLAN 2 | Only a VERIFIED financial state unlocks a payment-gated transition | EXISTS | pre-existing gates (`next_unlocked_milestone`, M3/M4 verified, `phase_seven_gate_status`). Phase 9 does not change them and adds no second path |
| P9-INV-04 | PLAN 2, SPEC 1 | AI assists; deterministic backend and policy control financial truth | EXISTS | every figure on the close is SQL (`phase9_compute_position`); the finance agents write proposals only (`finance.record_finance_proposal`); the amount in a reminder draft must equal the database's balance |
| P9-INV-05 | PLAN 2 | Issued financial history is not silently rewritten to make balances reconcile | EXISTS | Phase 9 never writes `finance.invoices` / `payments` / `refunds` (structural test); a waiver is its own record and reduces the COLLECTIBLE balance, not the invoice; verifier "the invoice itself is not rewritten" |
| P9-INV-06 | PLAN 2 | Refunds, waivers, overrides are not self-approved where separation is required | EXISTS | waiver: Admin who did not request it, a CHECK (`decided_by <> requested_by`) plus the door; close exception: same; blocking exception: resolver != opener; proposal: reviewer != requester. Verifier sections 3, 5, 7 |
| P9-INV-07 | PLAN 2 | Duplicate events / retries / crashes create no duplicate invoice, payment, receipt, refund, renewal | EXISTS (pre-existing) + Phase 9 | pre-existing: unique live invoice per milestone, unique payment reference, idempotent verify, refund provider key. Phase 9: unique open overdue/overpayment exception per invoice, `already_proposed`, `already_closed`, one pending waiver / close exception, one close per project, the close locks the project and its invoices |
| P9-PROH-01 | SPEC 5 | The agent never marks VERIFIED, guesses tax, edits an issued invoice, invents a discount / waiver / refund / deferral, treats operational completion as paid, rewrites payment history, retries a non-idempotent side effect blindly, exposes secrets, self-approves, or overrides a backend BLOCK | EXISTS (as structure) | the registry definitions hold no tool and `moneyAuthority: 'none'`; the proposal door refuses claims of payment, promised concessions, account-number-shaped text, secrets, uncited records; no door in the Admin whitelist verifies, refunds, edits or sends. The statement "an agent could not do X" is only as strong as the tool list: every agent is installed DISABLED and nothing has run on a real model |

## Cross-phase activation map (PLAN §3; SPEC §2)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-ACT-01 | PLAN 3 / SPEC 2 | Phase 2: M1 invoice, tracking, verification, receipt, project-start gate | EXISTS (pre-existing) | `finance:generateM1Invoice`, payment submissions, `verify_payment`, receipts (`20260928130000`), kickoff gate |
| P9-ACT-02 | PLAN 3 / SPEC 2 | Phase 3: no standard milestone, passive | EXISTS (pre-existing) | no finance gate on Phase 3; Phase 9 adds none (a close needs milestones or invoices to exist, and Phase 3 has neither of its own) |
| P9-ACT-03 | PLAN 3 / SPEC 2 | Phase 4 / 5 / 6: M2, M3, M4 invoice and verification gate the next phase | EXISTS (pre-existing) | `finance:generateM2/3/4Invoice` on `project.phase_four/five/six_completed`; `m3/m4` verified-in-full facts |
| P9-ACT-04 | PLAN 3 / SPEC 2 | Phase 7: final balance, reconciliation, zero balance or approved exception, financial close → handover eligibility | EXISTS (stale row corrected, gaps log G3) | the financial close exists (`finance.close_project_finances`, `finance.project_is_financially_closed`, event `project.financially_closed`). Phase 7's financial gate READS it: migration `20261108020000_the_phase_seven_financial_gate_reads_the_phase_nine_close.sql` (P710), exercised by `scripts/verify-phase-seven.sql` / `verify-phase-seven-b.sql`. The earlier text saying the gate did not yet read the fact was out of date. |
| P9-ACT-05 | PLAN 3 / SPEC 2 | Phase 8: maintenance, renewal, overage, CR, new project billing | PARTIAL | pre-existing: maintenance invoices (`maintenance_plan_id`, free-maintenance, change-request invoices). Phase 9 keeps them separate by construction: after a close only a milestone invoice / milestone amount change is refused; a non-milestone (CR / service / renewal) invoice on the project is still allowed. Maintenance entitlement activation on verified payment, renewal reminders that re-check "already renewed", and overage billing belong to Phase 8 (parallel agent) and are not asserted here |
| P9-ACT-06 | PLAN 3 | 30/20/30/20 is the default schedule, configurable | EXISTS (pre-existing) | `projects.milestones.payment_percent` / `amount_minor`; Phase 9 reads the plan as configured, never hard-codes percentages |

## Workstreams (PLAN §4)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-WS1 | PLAN 4 | Repository forensic audit | EXISTS | `docs/phase-9-implementation-log.md` (what existed, what was missing) |
| P9-WS2 | PLAN 4 | Commercial baseline and milestone model: accepted quote immutable, milestone linked to trigger, amount, invoice, payment state | PARTIAL | pre-existing: proposals / quotes, locked baselines (`20260821190000`), `projects.milestones`. Phase 9 reads the plan; the per-milestone financial reconciliation is in the position. Not added: a separate "commercial version" column on invoices (the existing unique live invoice per milestone is the idempotency key) |
| P9-WS3 | PLAN 4 | Invoice + GST / non-GST, numbering, account snapshot, correction flow, delivery | EXISTS (pre-existing) | `billing_profiles` (GST mode confirmed, not assumed), `set_invoice_numbering`, `invoice_sends`, `invoice_deliveries`, GST exports. **Not re-verified here**: whether payment-account instructions are snapshotted at issue; the plan asks for it and this change did not inspect or alter it (see manual actions P9-M008) |
| P9-WS4 | PLAN 4 | Payment submission + verification, matching exact / partial / over / duplicate / unmatched | EXISTS (pre-existing) | `payment_submissions` statuses, `record_manual_payment` (refuses over / duplicate), `verify_payment`, `propose_match`, bank import |
| P9-WS5 | PLAN 4 | Exceptions + refunds: wrong amount / account, unclear proof, gateway mismatch, overdue, refund, chargeback, tax correction, waiver / write-off | EXISTS | Phase 9: `finance.finance_exceptions` (13 kinds), `open_finance_exception`, `resolve_finance_exception`, `sweep_finance_exceptions` (overdue / overpayment), `finance.waivers` + `request_waiver` / `decide_waiver`. Refunds: pre-existing `request_refund` / `record_refund` with approvals, untouched; a refund is a line in the close position and a pending refund blocks the close |
| P9-WS6 | PLAN 4 | Reconciliation + reporting | EXISTS | pre-existing reconciliation (open / items / close, bank import, period reports). Phase 9: `period_close_preview`, `close_period` (frozen report), an open reconciliation item for a project's payment blocks that project's close |
| P9-WS7 | PLAN 4 | Financial close + post-project finance | EXISTS / PARTIAL | the project financial close: EXISTS (this phase). Post-project finance: see P9-ACT-05 |
| P9-WS8 | PLAN 4 | Events + automation: typed events, durable jobs, reminders, reconciliation jobs, retries, DLQ, idempotency, Admin controls | PARTIAL (improved by Phase 9B) | `project.financially_closed` is a typed, declared, subscribed event; `sweep_finance_exceptions` is runner-only and idempotent. Phase 9B: the cron tick now calls `sweepFinancePhaseNineB` (one line in `app/api/jobs/run/route.ts`) which runs `sweep_reconciliation_due` and `sweep_payment_account_checks`; a per-organization finance pause exists. The generic jobs engine's DLQ / replay is pre-existing and unchanged |
| P9-WS9 | PLAN 4 | Security + audit | EXISTS | RLS on every new table (Finance and Admin only), grants, parent-organization and frozen-organization triggers, append-only history, `core.record_audit` on every door; verifier section 8 |
| P9-WS10 | PLAN 4 | Testing + production readiness | PARTIAL | see the test matrix and DoD below. Verdict: **NOT READY for production use of the agents** (stub-proven only); the deterministic doors, gates and records are proven on a real Postgres |

## State machines (PLAN §6)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-SM-01 | PLAN 6 | Milestone financial lifecycle PLANNED … COMPLETED with PARTIAL / OVERDUE / DISPUTED / REFUNDED / WAIVED | EXISTS (derived, Phase 9B) | the lifecycle is a derived read (see P9-INV-02); each of its eight states is asserted and red-proved. Deliberately not a stored state machine (it would duplicate the invoice and payment statuses). Panel line: `app/(internal)/projects/[projectId]/phase-nine-lifecycle-line.tsx` (page wiring is the parent's, see manual actions) |
| P9-SM-02 | PLAN 6 | Payment submission lifecycle PENDING_VERIFICATION → VERIFIED / REJECTED / NEEDS_MORE_INFO / PARTIALLY_VERIFIED / DUPLICATE / REFUNDED | EXISTS (pre-existing) | `payment_submissions.status` CHECK; Phase 9 reads it |
| P9-SM-03 | PLAN 6 | Final financial close: adjustments → reconciliation → outstanding check → zero balance or authorized exception → FINANCIAL_CLOSE → Phase 7 gate | EXISTS | `finance.close_project_finances`, the evaluation history, `close_exceptions`, `project_financial_closes`; verifier section 4–5 |

## API / service checklist (PLAN §7)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-API-01 | PLAN 7 | Accepted quote retrievable as an immutable baseline | EXISTS (pre-existing) | locked baselines (`20260821190000`) |
| P9-API-02 | PLAN 7 | Milestone readiness for invoice validated against operational state | EXISTS (pre-existing) | `eligible-milestones-queries.ts`, `milestoneInvoiceability` |
| P9-API-03 | PLAN 7 | Invoice creation idempotent per milestone + version | EXISTS (pre-existing) | unique live invoice per milestone (`invoices_milestone_live_key`) |
| P9-API-04 | PLAN 7 | Issue, delivery and status changes are separate auditable actions | EXISTS (pre-existing) | `issue_invoice`, `invoice_deliveries`, `invoice_sends` |
| P9-API-05 | PLAN 7 | GST / tax explicit and versioned; no agent hard-codes a rate | EXISTS (pre-existing) + Phase 9 | the proposal prompts forbid guessing tax and Phase 9 computes no tax; the margin line is verified revenue as invoiced |
| P9-API-06 | PLAN 7 | Payment-account instructions loaded from active config and snapshotted at issue | PARTIAL | `payment_accounts` exist; snapshot-at-issue not re-verified (P9-WS3) |
| P9-API-07 | PLAN 7 | Submission captures UTR, amount, method, payer, account, proof | EXISTS (pre-existing) | `payment_submissions` columns |
| P9-API-08 | PLAN 7 | Verification needs permission and evidence; screenshot-only cannot VERIFY | EXISTS (pre-existing) | CHECK `payment_submissions_verified_is_evidenced`; owner-only door. The service-role exemption is a documented owner decision (Phase 6 manual action P6-M006) and Phase 9 neither widens nor narrows it; verifier: Finance still gets `forbidden` |
| P9-API-09 | PLAN 7 | Applying a verified payment is transactional and concurrency-safe | EXISTS (pre-existing) | `20260815180000` verify idempotent under the lock |
| P9-API-10 | PLAN 7 | Balance and milestone financial state recomputed deterministically | EXISTS | `finance.invoice_outstanding_minor` is the ONE definition (total - net verified - approved waivers, floored at 0); the position recomputes from the ledger every time |
| P9-API-11 | PLAN 7 | Receipt only after verified-payment policy passes | EXISTS (pre-existing) | `20260928130000` receipts are issued inside `verify_payment` |
| P9-API-12 | PLAN 7 | Partial / over / under / duplicate / unmatched / disputed handled explicitly | EXISTS | partial: balance + aging; over: `overpayment` exception (blocking) + blocker; duplicate: pre-existing reference uniqueness + `duplicate_payment` exception kind; unmatched: reconciliation + `unmatched_payment` kind; disputed: `chargeback` kind |
| P9-API-13 | PLAN 7 | Refund / waiver / write-off / override policy-gated and auditable | EXISTS | refund: pre-existing approvals; waiver / close exception: Phase 9 doors with `core.record_audit` |
| P9-API-14 | PLAN 7 | Reconciliation supports an authoritative source, matching, exceptions, close | EXISTS (pre-existing) | `20260822260000`, `bank_statement_lines`; no gateway exists by decision, so the "authoritative source" is a bank statement a person imports |
| P9-API-15 | PLAN 7 | Financial close cannot succeed while mandatory blocking conditions remain | EXISTS | `close_project_finances` returns `blocked` / `balance_needs_an_approved_exception`; red-proved |
| P9-API-16 | PLAN 7 | Protected endpoints enforce tenant and action-level authorization server-side | EXISTS | every door resolves the caller (`phase9_caller_kind`) and the organization inside the database; the Admin whitelist action only gates on "may read money" and the database refuses the rest |

## Admin Finance Control Center (PLAN §8)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-UI-01 | PLAN 8 | Finance dashboard: quoted, invoiced, paid, outstanding, overdue, partial, pending verification, unmatched, refunds, tax, milestone state, reconciliation | EXISTS (pre-existing) + Phase 9 | `/finance` overview (pre-existing); `/finance/close` lists every project's close state and the open exceptions / waivers; rows open the project's close view |
| P9-UI-02 | PLAN 8 | Payment verification queue (VERIFY / REJECT / NEEDS_MORE_INFO / OPEN_EXCEPTION) | PARTIAL | the queue and the first three actions are pre-existing (`/finance/payments`, claims panel). OPEN_EXCEPTION from a claim is available on the project's close view (`open_exception` takes an invoice or a submission); it is not a button inside the claims drawer, because that file belongs to earlier work and was not edited |
| P9-UI-03 | PLAN 8 | Project Finance View: value, discount, tax mode, milestones, invoices, payments, receipts, outstanding, overdue, exceptions, refunds, reconciliation | EXISTS | `/finance/close/[projectId]` (position, per-milestone table, aging, blockers with reasons, margin, exceptions, waivers, proposals); invoices / receipts stay on their own pre-existing pages |
| P9-UI-04 | PLAN 8 | Payment-account configuration; numbering / tax / terms / defaults / thresholds | EXISTS (pre-existing) | finance settings, numbering, GST setup |
| P9-UI-05 | PLAN 8 | Finance exception queue and resolution history | EXISTS | org queue on `/finance/close`; per-project queue with the resolution trail and resolve / dismiss forms |
| P9-UI-06 | PLAN 8 | Reconciliation runs and unmatched review | EXISTS (pre-existing) | `/finance/payments` reconciliation panel |
| P9-UI-07 | PLAN 8 | Automation controls: reminders, schedules, retries, queue visibility, pause, replay | PARTIAL (improved by Phase 9B) | reminder interval and enable switch are pre-existing; queue and replay are the generic jobs screens. Phase 9B adds the reconciliation schedule and the finance-specific pause (Admin doors, `finance.finance_automation_controls` plus an append-only change log, honoured by the request door, the proposal door and the three workflows); panel `app/(internal)/finance/close/phase-nine-b-panels.tsx` (page wiring is the parent's) |
| P9-UI-08 | PLAN 8 | Financial audit log and secure export | EXISTS (pre-existing) | audit log, `finance.report_exports`, export logging. Phase 9 doors write `core.record_audit` rows |
| P9-UI-09 | PLAN 8 | Dashboard numbers open the underlying records | EXISTS | each project / exception / waiver row on `/finance/close` links to the record |
| P9-UI-10 | PLAN 8 | Project page shows the close state | PARTIAL | `app/(internal)/projects/[projectId]/phase-nine-panel.tsx` is built; **the parent adds one line to the project page** (that file was off limits) |

## Agent / orchestration contract (PLAN §9; SPEC §4, §13, §19)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-AG-01 | PLAN 9 / SPEC 4 | The Finance Agent prepares invoices from approved context | EXISTS (pre-existing) | `finance` agent, `finance.generateInvoice`, `finance:generateM1..M4Invoice` handlers |
| P9-AG-02 | PLAN 9 / SPEC 4 | Tracks submissions and prepares verification packets | PARTIAL (improved by Phase 9B) | the packet is now also a read-only summary composed from existing claim data (`phase-nine-verification-packet.ts`, `phase-nine-packet-queries.ts`, NEW component `verification-packet.tsx` beside the verify page; the existing drawer is untouched; page wiring is the parent's). It is not an agent and verifies nothing. Tracking of submissions: the recorded account check sweep (P9-SPEC-8) |
| P9-AG-03 | PLAN 9 | Classifies deterministic finance exceptions with backend validation | EXISTS | deterministic: `sweep_finance_exceptions` (overdue, overpayment). Model-assisted: `finance_close` proposes an `exception_classification`; a person accepts it and the EXISTING `open_finance_exception` door opens it |
| P9-AG-04 | PLAN 9 / SPEC 4 | Generates client-safe payment / receipt / reminder communications | PARTIAL | `finance_communication` drafts a reminder (amount = the database's balance; no payment claim, concession or account number); sending stays with the existing reminder / delivery flow and a person. Receipt and payment-confirmation wording is the pre-existing flow's. Stub-proven only |
| P9-AG-05 | PLAN 9 / SPEC 4 | Coordinates reconciliation and financial-close workflow | PARTIAL | `finance_reconciliation` and `finance_close` propose findings, flags and readiness notes; the person closes. Stub-proven only |
| P9-AG-06 | PLAN 9 / SPEC 13 | Hands verified milestone state to PM / Orchestrator; escalates to a human | EXISTS (pre-existing) + Phase 9 | pre-existing verified-payment announcers; Phase 9 adds `project.financially_closed` → PM announcement |
| P9-AG-07 | PLAN 9 | Structured handoff payload (org, client, project, task, version, milestone, invoice, expected amount, state, refs, policy, approvals, evidence, priority, blockers, correlation, retry) | EXISTS (Phase 9B) | one Zod type `src/modules/finance/phase-nine-handoff.ts`, built by the three workflows and stored as validated jsonb on `finance.finance_proposals.handoff`: the shape is a CHECK (`phase9b_handoff_shape_ok`) and `record_finance_proposal` re-reads the rows and refuses a payload that disagrees (organization, project, request, agent, kind, requester, client account, invoice, milestone, evidence, an expected amount that is not the database balance, a secret). It carries `moneyAuthority: none` and a required independent review. Optional for a legacy caller (older proposals carry none). `scripts/verify-phase-nine-b.sql` (161 checks, every control red-proved) section 5 |
| P9-AG-08 | SPEC 3 | The agent requests or escalates missing mandatory context instead of inventing values | EXISTS (as refusal) | the workflow fails the job on a missing request / project / position; the door refuses a figure that is not the balance; no door lets a model supply an amount |
| P9-AG-09 | SPEC 19 | Completion output: record IDs, state, evidence, policy ref, documents, audit / correlation ref, handoff, blockers | PARTIAL | the proposal row and its decision carry ids, evidence refs, outcome, audit rows; there is no separate "completion report" object |

## Events and jobs (PLAN §10; SPEC §14, §16)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-EV-01 | PLAN 10 | QuoteAccepted / finance context ready → milestone plan / M1 readiness | EXISTS (pre-existing) | onboarding and M1 events |
| P9-EV-02 | PLAN 10 | MilestoneReadyForInvoice → one invoice | EXISTS (pre-existing) | phase-completed events → `finance:generateM*Invoice` |
| P9-EV-03 | PLAN 10 | PaymentSubmitted → verification packet / match | EXISTS (pre-existing) | `payment.submitted` |
| P9-EV-04 | PLAN 10 | PaymentVerified → apply + receipt + gate evaluation | EXISTS (pre-existing) | `invoice.paid` subscribers |
| P9-EV-05 | PLAN 10 | PaymentOverdue → policy-aware reminder / escalation, suppressed if state changed | EXISTS (gaps log G4) | reminders are pre-existing (`observe_invoice_reminder_candidates`, re-checked at send); Phase 9 never chases a fully WAIVED invoice and adds the overdue exception (re-checked, auto-closed when the invoice stops being overdue). `finance.payment_overdue` is now emitted once per opening of an overdue exception (migration `20261122200000`), ids only, never for an invoice the sweep did not find overdue and never for another exception kind; driven and red-proved in `scripts/verify-phase-nine-overdue-event.sql`. Escalation stays a person's decision. |
| P9-EV-06 | PLAN 10 | RefundRequested → authorized refund or rejection, no execution without authority | EXISTS (pre-existing) | `request_refund` / approvals / `record_refund`, untouched |
| P9-EV-07 | PLAN 10 | ReconciliationDue → matched / exception results + close | EXISTS for the due-and-open half (Phase 9B) | an Admin sets a cadence (`finance.reconciliation_schedules`, no default: an organization that never sets one is never scheduled); the runner sweep records the ReconciliationDue item (`finance.reconciliation_due_items`) and OPENS that period idempotently, never closes it, and waits while the account already has an open period. Matching and closing stay a person's work (the existing reconciliation doors). `scripts/verify-phase-nine-b.sql` (161 checks, every control red-proved) section 1 |
| P9-EV-08 | PLAN 10 | ProjectFinancialCloseRequested → FINANCIAL_CLOSE or BLOCKED reason | EXISTS | a person requests by pressing close; the door returns `closed` or `blocked` with the reasons; an evaluation row records every attempt. No separate "requested" event, because the request is synchronous |
| P9-EV-09 | PLAN 10 | MaintenanceRenewalDue → renewal billing after acceptance | EXISTS (re-verified, gaps log G5) | `maintenance.renewal_due` is emitted once per plan by `projects.sweep_maintenance_renewals` (`scripts/verify-phase-eight-a.sql` ~580-585: one check-in, one event, a second sweep adds nothing). Renewal billing follows the client's recorded acceptance only: `propose_maintenance_renewal` -> `record_maintenance_renewal_decision` (needs the accepted quote and evidence) -> `confirm_maintenance_renewal` (independent Admin, verified money through the billing link); `scripts/verify-phase-eight-c.sql` ~413-450 drives the refusals. |
| P9-EV-10 | SPEC 14 | Proposed names: InvoiceIssued, FinancialExceptionCreated, ProjectFinanciallyClosed | EXISTS (gaps log G2) | `invoice.issued` pre-exists; `project.financially_closed` added in Phase 9; `finance.exception_created` is now emitted by a trigger when a finance exception row opens (person or sweep), verified and red-proved in `scripts/verify-phase-eight-b-smoke-and-events.sql`. |
| P9-EV-11 | PLAN 10 / SPEC 14, 16 | Jobs durable, bounded retries, idempotent, DLQ, re-check state at execution, timezone-aware, uncertain side effects reconcile before retry | PARTIAL | the jobs engine is pre-existing. Phase 9's runner doors are idempotent and re-check state; periods are UTC-explicit like the existing period report. Phase 9 introduces no external side effect, so there is no uncertain outcome to reconcile |

## Matching, refund, reconciliation, close (SPEC §8–11)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-SPEC-8 | SPEC 8 | Exact / partial / over / duplicate / unmatched / reference mismatch / wrong account / gateway mismatch / unclear proof handling | PARTIAL (improved by Phase 9B) | exact, partial, over, duplicate, unmatched, unclear proof: pre-existing doors + exception kinds. Wrong account is now a RECORDED check (`finance.payment_account_checks`, once per submission): a payer sharing no significant word with the client account, or a receiving account that was not active when paid, opens a blocking `wrong_account` exception (never changing the payment). It is a flag from existing data, not a ruling: entity ownership of an account is still not modelled (P9-M011). Gateway reconcile-before-retry remains not built (no gateway) |
| P9-SPEC-9 | SPEC 9 | Refund flow, partial refunds as separate records, repeated requests do not duplicate, chargeback is not a refund, waiver is not cash | EXISTS | refund: pre-existing. Chargeback: its own exception kind, always blocking, settled by an Admin only. Waiver: separate table, reported on its own line, never in collected or revenue |
| P9-SPEC-10 | SPEC 10 | Reconciliation: read authoritative transactions, normalise, match, auto-match only high confidence, route exceptions, preserve evidence, close only when exceptions are resolved or documented | EXISTS (pre-existing) + Phase 9 | pre-existing reconciliation and bank import (statement lines frozen, matches proposed not applied). Phase 9 adds the period close that lists standing exceptions and requires them to be formally acknowledged |
| P9-SPEC-11 | SPEC 11 | Financial close: contract / invoiced / verified collected, refunds / waivers, open exceptions / disputes, reconciliation state, outstanding, zero balance or authorized exception → CLOSE or BLOCKED; the agent does not mark the project complete | EXISTS | `phase9_compute_position` and `close_project_finances`; the close says it is not completion (UI, announcement, event description) |

## Phase 8 ongoing finance (SPEC §12)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-P8-01 | SPEC 12 | Maintenance → invoice → verified payment → entitlement; renewal never silently assumed; overage; CR; repeat project | EXISTS (re-verified, gaps log G5) | entitlement only on verified money: `activate_maintenance_plan` refuses `not_accepted`, `first_cycle_not_billed`, `first_cycle_not_paid` and activates on verified money (`verify-phase-eight-c.sql` ~186-217, 298, 326-328, 519). Renewal is never silent: the sweep flags, an expired plan lapses with a reason and is not extended, a renewal needs acceptance and payment. Overage is surfaced as a draft with the price-line rate, once, reversible by a ledger reversal, never invoiced by itself (~224-264). A new feature on a maintenance ticket is refused and must be a change request (`verify-phase-eight-b.sql`: `out_of_scope_needs_a_change_request`, `new_project_is_not_maintenance`). A closed project refuses a new milestone invoice (Phase 9). |

## Permission contract (SPEC §15; PLAN §11)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-PERM-01 | SPEC 15 | Finance Agent: distinct identity, no source-code deploy, no unrestricted Admin override | EXISTS | three distinct agent keys, no tool, disabled; the proposal door is the service role's and refuses every other kind of caller, including a signed-in person |
| P9-PERM-02 | SPEC 15 | Finance / Admin Finance: operational actions, no self-approval where separation required | EXISTS | role split in the doors: Finance requests; an Admin decides a waiver and a close exception and settles a chargeback; a blocking exception is resolved by another person |
| P9-PERM-03 | SPEC 15 | PM sees gate status only; Sales / Developer / QA only necessary context; Client only own invoices / payments / receipts, no internal finance notes | EXISTS | every new table is readable by Finance and Admin only (a member, a delivery lead, a contractor and a client of the same organization read none; verifier section 8). The project-page line reads through the same RLS, so a role that reads no finance sees nothing. The one fact other roles may read is `finance.project_is_financially_closed` (internal roles only) |
| P9-PERM-04 | PLAN 11 | Every finance record organization-scoped; RLS tested for allow and deny | EXISTS | parent-organization triggers per foreign key, frozen organization, RLS; verifier tests a same-organization member and client and another organization's Admin |
| P9-PERM-05 | PLAN 11 | Payment-proof files and finance exports permission-protected | EXISTS (pre-existing) | storage path is tenant-scoped (CHECK), exports are logged |
| P9-PERM-06 | PLAN 11 | Bank / gateway / webhook secrets in secret management and never in prompts, logs, client messages | EXISTS (pre-existing) + Phase 9 | the proposal door and the Admin-facing doors refuse secret-shaped text; nothing in Phase 9 reads or stores a credential |
| P9-PERM-07 | PLAN 11 | Admin overrides need identity, reason, before / after state, permanent audit event | EXISTS | every decision door requires a reason and writes `core.record_audit`; the decision rows are append-only |

## Failure and escalation (SPEC §16)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-FAIL-01 | SPEC 16 | Transient timeout → bounded retry; permanent failure → stop; conditional wait; security anomaly → stop | EXISTS (pre-existing) | the jobs engine; a finance workflow fails the job (not the books) on a refused answer or a missing provider |
| P9-FAIL-02 | SPEC 16 | Provider / LLM outage does not corrupt deterministic finance state | EXISTS | a test drives a provider outage: the job fails and the proposal door is never called; the close and every figure are SQL |
| P9-FAIL-03 | SPEC 16 | Dead-lettered finance job preserves event, attempts, error, side-effect state, correlation | EXISTS (pre-existing) | generic engine |

## Test matrix (PLAN §12) and mandatory E2E (PLAN §13)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-T-01 | PLAN 12 | Unit: balance math, partial / over, refund / waiver effect, close eligibility, reminder eligibility, matching | EXISTS | `tests/phase-nine-proposals.test.ts`, `phase-nine-doors.test.ts`; the math itself is SQL, proved in the verifier |
| P9-T-02 | PLAN 12 | Database: uniqueness, state constraints, tenancy / RLS, concurrency, rollback, idempotency | EXISTS (Phase 9B) | uniqueness, CHECKs, triggers, RLS, idempotency: the two verifiers. Concurrency is now MEASURED: `scripts/verify-phase-nine-concurrency.sh` runs two real psql sessions against one project; the second waited 3.00 s for the first's lock, answered `already_closed`, and exactly one snapshot, one audit row and one evaluation exist. Red-proved by removing the two `for update` locks (the script then fails). It commits fixture rows, so it is a manual scratch-database proof and is not in the CI chain |
| P9-T-03 | PLAN 12 | API / Service / Policy / Agent / Events / Security | EXISTS (stub) | `tests/phase-nine-*.test.ts`; the agent tests use a stand-in model and a stand-in database |
| P9-E2E-M1 | PLAN 13 | M1 quote → invoice → proof → pending → Admin verify → receipt → start gate | EXISTS (pre-existing) | earlier phases' verifiers; Phase 9's verifier drives invoice → submission → verify (runner path) → position |
| P9-E2E-M2/3/4 | PLAN 13 | M2, M3, M4 invoice + verified payment → next gate; M4 → financial-close evaluation | EXISTS | gates pre-existing; the close evaluation is Phase 9 (verifier sections 1-4, M1-M4 on one project, 30/20/30/20) |
| P9-E2E-02 | PLAN 13 | Screenshot-only claim never reaches VERIFIED | EXISTS (pre-existing) | CHECK + owner-only door; Phase 9 verifier: a pending submission blocks the close and Finance still cannot verify |
| P9-E2E-03 | PLAN 13 | Partial payment keeps the balance and the gate closed | EXISTS | verifier: 10000 of 30000 verified, outstanding 20000 |
| P9-E2E-04 | PLAN 13 | Same UTR twice → one monetary effect | EXISTS (pre-existing) | `payments_provider_provider_payment_id_key`, reference uniqueness; not re-driven by Phase 9 |
| P9-E2E-05 | PLAN 13 | Two workers process the same invoice event → one invoice | EXISTS (pre-existing) | `invoices_milestone_live_key`; not re-driven by Phase 9 |
| P9-E2E-06 | PLAN 13 | Overpayment → structured exception, not absorbed | EXISTS | verifier section 6 (sweep opens a blocking `overpayment` exception; the position names it) |
| P9-E2E-07 | PLAN 13 | Wrong-account / unmatched → exception queue | EXISTS for detection from existing data (Phase 9B) | `sweep_payment_account_checks` and the `check_payment_account` door put a wrong payer or receiving account into the exception queue; see P9-SPEC-8 for its limits |
| P9-E2E-08 | PLAN 13 | Refund requires approval, executes once, preserves the payment, adjusts balances auditably | EXISTS (pre-existing) + Phase 9 | pre-existing refund doors; Phase 9 verifier: the original verified payment (10000) stays, the refund (4000) is its own line, net verified is 6000, the balance reopens |
| P9-E2E-09 | PLAN 13 | Zero balance with an open chargeback does not pass the close | EXISTS | verifier section 3 |
| P9-E2E-10 | PLAN 13 | Approved waiver closes the collectible balance without being reported as cash | EXISTS | verifier section 3 (collected 60000 and margin unchanged; waived 20000 on its own line) |
| P9-E2E-11 | PLAN 13 | Reconciliation identifies matched / unmatched / duplicate / discrepant without rewriting evidence | EXISTS (pre-existing) | `20260822260000` |
| P9-E2E-12 | PLAN 13 | Organization A cannot view or modify B's finance records | EXISTS | verifier sections 1, 3, 8 |
| P9-E2E-13 | PLAN 13 | The agent cannot deploy source code or self-approve | EXISTS | no tool, disabled, door refusals |
| P9-E2E-14 | PLAN 13 | Worker crash after an uncertain external side effect → reconcile before retry | MISSING / N/A | Phase 9 introduces no external financial side effect |
| P9-E2E-15 | PLAN 13 | Maintenance acceptance without verified payment does not activate entitlement; renewal re-checks; new feature after completion is a CR | EXISTS (re-verified, gaps log G5) | see P9-P8-01: acceptance without a linked invoice or without verified money does not activate (`first_cycle_not_billed` / `first_cycle_not_paid`); an unaccepted renewal is not confirmed; a feature after completion is refused as maintenance and must be a change request or a new project. SQL-level proof only; no browser E2E. |

## Definition of Done (PLAN §14; SPEC §18) and evidence (PLAN §16)

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P9-DOD-01 | PLAN 14 | Baseline and milestone plan versioned / auditable; M1-M4 gates correct and configurable | EXISTS (pre-existing) | |
| P9-DOD-02 | PLAN 14 | GST / non-GST explicit; no guessing | EXISTS (pre-existing) + Phase 9 | |
| P9-DOD-03 | PLAN 14 | Invoices deterministic, unique, controlled after issue | EXISTS (pre-existing) | |
| P9-DOD-04 | PLAN 14 | Receipts only under verified-payment policy | EXISTS (pre-existing) | |
| P9-DOD-05 | PLAN 14 | Exceptions, overdue, reminders, refunds, chargebacks, waivers / write-offs, invoice corrections governed and auditable | PARTIAL | all of these except **invoice corrections**: there is no controlled correction / amendment flow beyond void-and-reissue, and Phase 9 did not add one |
| P9-DOD-06 | PLAN 14 | Reconciliation and reporting from authoritative records | EXISTS | |
| P9-DOD-07 | PLAN 14 | Financial close enforces zero balance or approved exception and checks open disputes | EXISTS | |
| P9-DOD-08 | PLAN 14 | Phase 7 handoff and Phase 8 finance without reopening historical milestones | PARTIAL | reopening is refused (the close); Phase 7 reading the fact and Phase 8's flows are not built here |
| P9-DOD-09 | PLAN 14 | Events / jobs durable, idempotent, retry-safe, traceable, dead-letter capable | PARTIAL | pre-existing engine; see P9-EV |
| P9-DOD-10 | PLAN 14 | RBAC, tenant isolation, RLS, secrets, separation of duties pass | EXISTS | |
| P9-DOD-11 | PLAN 14 | Concurrency, duplicate event / webhook, worker-crash tests pass | PARTIAL (improved by Phase 9B) | duplicate-event idempotency of the doors: yes. A measured two-session concurrency test of the close: yes (P9-T-02). Worker-crash: no external side effect exists to crash after |
| P9-DOD-12 | PLAN 14 | Critical E2E and Phase 1-8 regression tests pass | PARTIAL | the SQL verifiers pass; the `.mjs` finance verifiers were not run (no PostgREST) |
| P9-DOD-13 | PLAN 14 | No production-critical mock / placeholder in finance / payment paths | PARTIAL | the finance agents are stub-proven and disabled; no placeholder sits in a payment path |
| P9-DOD-14 | PLAN 14 / SPEC 18 | Evidence package complete, no unresolved blocker | PARTIAL | this document, the log, the manual actions. **Production-readiness verdict: NOT READY** for relying on the three finance agents (never run on a real model); READY for the deterministic close, exception, waiver and period-close doors subject to the manual actions |
| P9-DOD-15 | SPEC 18 | Financial truth never depends only on LLM output | EXISTS | nothing an agent writes is a figure the system uses; a proposal is a note |
