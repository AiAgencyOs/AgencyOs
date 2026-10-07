# Phase 8A traceability: Customer Success, Support, Upsell, post-launch Sales

Scope of this part (8A): the Customer Success, Support, Upsell and Sales (post-launch) domains of the Phase 8 master plan
(`AgencyOS_Phase_8_Implementation_Plan_Checklist_Testing`) and the four agent specs (`..._Customer_Success_Agent`, `..._Support_Agent`, `..._Upsell_Agent`,
`..._Sales_Agent`). Maintenance plan CRUD/activation, the usage ledger, renewal proposal/payment, cancellation, finance for maintenance, and the Orchestrator,
Finance, Developer and QA agent specs belong to the other Phase 8 part and are marked MISSING here with that reason; they are not claimed.

Statuses: **EXISTS** (built, and proved by the verifier or a test named in the row), **PARTIAL** (some of it, the gap stated), **MISSING** (not built, the reason
stated), **MANUAL_EXTERNAL** (needs an owner, a provider or a deployment: see `phase-8a-manual-actions.md`), **NOT_APPLICABLE** (with the reason).

Evidence key: `V` = `scripts/verify-phase-eight-a.sql` (275+ checks through the real doors on a scratch Postgres), `R` = `scripts/redproof/phase-eight-a.py` (44
controls, each removed from the live definition inside the verifier's own transaction and confirmed to turn it red), `T-found` = `tests/phase-eight-a-foundation.test.ts`,
`T-wf` = `tests/phase-eight-cs-workflows.test.ts`, `T-pm` = `tests/phase-eight-pm-templates.test.ts`, `V8D` = `scripts/verify-phase-eight-d.sql`, `R8D` = `scripts/redproof/phase-eight-d.py` (Phase 8D, section 19).

## 1. Master plan, sections 1 to 4

| Section | Requirement | Status | Evidence / reason |
|---|---|---|---|
| 1 | Completed project preserved as historical truth; new work is maintenance, a change request or a new project | EXISTS | V hashes the project and its completion record before and after the whole phase; T-found asserts no migration updates `projects.projects` or `completion_records` |
| 1 | Support: classify, verify coverage, resolve/retest/release; "call a new feature a warranty bug" not allowed | EXISTS | CHECK `support_tickets_coverage_matches_classification` (a change request or new project can never be covered); V, R |
| 1 | Maintenance: versioned plans, usage, SLA, renewals | PARTIAL | plans and versions already exist (migration 20260821260000); 8A reads them for coverage and renewal hooks. Plan CRUD/Admin UI, usage, overage: MISSING (other Phase 8 part) |
| 1 | Retention without pressure or fake urgency | EXISTS | recovery plans; commercial outreach suppressed while at risk (V) |
| 1 | Upsell: evidence-based need to Sales; no fabricated problems or spam | EXISTS | evidence required and checked against this project's records (V, T-wf) |
| 1 | Finance for maintenance/renewal | MISSING | other Phase 8 part |
| 1 | Automation with events/jobs/reminders and idempotency | EXISTS (scheduling) / PARTIAL (reminders) | doors idempotent (V); the SLA sweep, the scheduled health snapshots, the due check-in notices and the late-label ticket sweep run on the cron tick (`sweepSupportAndHealth`, Phase 7c, `20261112000000`; `scripts/verify-phase-seven-c.sql` §1-2). A due check-in is NOTICED for Customer Success and nobody is contacted |
| 2 | P8-GATE-001 completed state + exact release/build | EXISTS | `projects.p8_build_intake`; build ref from the Admin-approved Phase 6 candidate for pipeline projects (V) |
| 2 | P8-GATE-002 deployment + live/smoke verification | EXISTS | requires a passed production row in `projects.release_verifications` (V) |
| 2 | P8-GATE-003 handover and acceptance evidence | EXISTS | an accepted handover (V) |
| 2 | P8-GATE-004 final payment verified or approved exception | EXISTS | completion record verified >= invoiced and no outstanding invoice; an owner waiver is the recorded exception (V, R) |
| 2 | P8-GATE-005 approved scope version locked and accessible | PARTIAL | scope version id on the completion is required; "accessible to post-project agents" is not a separate surface |
| 2 | P8-GATE-006 warranty start/end/coverage/exclusions | EXISTS | decided by a person at start; a CHECK refuses a half-defined window; or an explicit "no warranty, because" (V) |
| 2 | P8-GATE-007 known limitations disclosed | EXISTS | a person records them on the completion record (write "none" if none) (V) |
| 2 | P8-GATE-008 Customer Success handoff package | PARTIAL | package stored on the intake (client, contacts, build, scope, limitations, counts); client preferences are "none recorded" (only WhatsApp consent per contact exists); no separate handoff event |
| 2 | Phase 7 frozen completion handoff | PARTIAL | the intake reads today's completion facts; Phase 7's snapshot replaces ONE function (`p8_build_intake`), see the log |
| 3 | Master flow, completed to customer success again | PARTIAL | completed, handoff, context, warranty/support, health, support, renewal flag, retention, opportunity, sales handoff: built. Maintenance eligibility/plan/payment gate and cancellation: MISSING (other part) |
| 4 | P8-00 audit | PARTIAL | this document, the log, and the repo survey in the log; no production audit |
| 4 | P8-01 handoff and context | EXISTS | intake, workspace, first check-in and first health read created once (V) |
| 4 | P8-02 support/warranty classification | EXISTS | V |
| 4 | P8-03 maintenance system | MISSING | other part |
| 4 | P8-04 health and retention | EXISTS | derived health, history, recovery plans (V) |
| 4 | P8-05 upsell and repeat business | EXISTS | V |
| 4 | P8-06 cancellation / churn | MISSING | other part |
| 4 | P8-07 communication and follow-up | PARTIAL | eligibility, check-in records, reply drafts: built. Auto-send, caps, quiet periods, delivery/reply tracking, value reports: MISSING |
| 4 | P8-08 Customer 360 and Admin dashboard | PARTIAL | per-project panel, organization overview, and (8D) the single-client page `/clients/[id]/customer-360` and the counts-and-ages page `/projects/customer-success/observability`: tables of counts, no charts, no churn reasons or utilization (other part) |
| 4 | P8-09 orchestration, events, jobs | EXISTS | typed events and idempotent doors; the 8A sweeps are scheduled on the cron tick (Phase 7c) and `customer.check_in_due` is emitted once per due check-in |
| 4 | P8-10 security, audit, governance | PARTIAL | RLS, grants, append-only history; denial auditing and retention policy MISSING |
| 4 | P8-11 360-degree QA | PARTIAL | DB verifier and unit tests; no browser, performance or compatibility run |

## 2. Master plan, sections 5 to 18

| Section | Requirement | Status | Evidence / reason |
|---|---|---|---|
| 5 | P8-AUD-001..010 forensic audit | PARTIAL | repo survey recorded in the log; baseline suite run recorded in the log; no deployed-behaviour audit |
| 6 | CustomerSuccessAccount | PARTIAL | workspace + overview; strategic/VIP metadata MISSING by design: no criteria are configured and an agent may not decide VIP |
| 6 | MaintenancePlan + PlanVersion | PARTIAL | pre-existing; not changed |
| 6 | ClientMaintenanceSubscription | MISSING | other part |
| 6 | SupportTicket | EXISTS | `projects.support_tickets` (project/version link via project, coverage decision, priority, assignee, SLA, fix/release/client confirmation) |
| 6 | WarrantyWindow | EXISTS | on the workspace: window, coverage text, exclusions text |
| 6 | CustomerHealthSnapshot | EXISTS | derived read plus dated history |
| 6 | RecoveryPlan | EXISTS | root cause, owner, actions, deadline, outcome, post-intervention health |
| 6 | CustomerOpportunity | EXISTS | `sales.phase_eight_opportunities` with evidence, plan, outcome, urgency, stakeholders, constraints |
| 6 | Renewal | PARTIAL | flagged renewal_approaching and expired by the sweep; proposal, acceptance, payment, renewed: MISSING |
| 6 | CommunicationRecord | PARTIAL | reply drafts + "sent by a person" record, check-ins, and (8D) an append-only ledger of what a person sent or an agent drafted, with channel, purpose, author and the eligibility read at the time, plus delivery/reply events a person records and the outbound-message log joined read-only (V8D, R8D). Nothing sends; automatic delivery state from the provider is MISSING (no provider callback writes it) |
| 6 | UsageLedger, CancellationRecord | MISSING | other part |
| 7 | Maintenance renewal state machine | PARTIAL | ACTIVE to RENEWAL_APPROACHING to EXPIRED automated; the other states exist in the vocabulary but no door sets them (other part) |
| 7 | Customer health HEALTHY..CRITICAL with contributing signals | EXISTS | `customer_health`, `customer_health_status` (V, R) |
| 7 | Support resolution REQUEST..CLOSE | EXISTS | new, classified (coverage and priority decided together), assigned, in progress, in QA, release, client confirmation, closed (V) |
| 7 | Opportunity DETECTED..ACCEPTED/LOST | PARTIAL | detected, qualified, suppressed, handed off, accepted, lost; discovery/quote/negotiation live in the existing sales stages |
| 7 | Completed project stays closed | EXISTS | V |
| 7 | Financial invariant | PARTIAL | nothing in 8A marks anything paid or active; maintenance activation is the other part |
| 7 | Automation invariant (no duplicate ticket/opportunity/check-in/event) | EXISTS | V: duplicate webhook, retried agent run, retried sweep; invoices and subscriptions are the other part |
| 8 | Customer Success agent trigger and output | PARTIAL | agenda workflow (draft); health/retention are doors |
| 8 | Support agent | PARTIAL | classification proposal + reply draft workflow; Phase 7c ingests a client's `support_request` message in an ACTIVE workspace's project conversation into a ticket (`message.received` subscriber, idempotent on the message id, never replies); a post-project account thread and a message with no intent label open nothing |
| 8 | Upsell agent | EXISTS | opportunity workflow (detected only) |
| 8 | Sales agent | PARTIAL | the handoff and outcome doors; discovery, quote, negotiation are the existing sales doors; no post-launch Sales workflow, deliberately (quoting authority) |
| 8 | Orchestrator, Finance, Developer, QA | MISSING | other part / earlier phases |
| 9 | ProjectCompleted / CustomerSuccessHandoffCreated | PARTIAL | the intake door is service-role and nothing subscribes it to a completion event (none exists; Phase 7 adds it); the Admin refreshes it by hand |
| 9 | SupportTicketCreated | EXISTS | emitted once per ticket (V); no classifier job subscribed |
| 9 | CustomerHealthChanged | EXISTS | emitted per transition (V); no subscriber |
| 9 | MaintenanceRenewalDue | EXISTS | sweep + announcement (V, T-pm) |
| 9 | MaintenanceActivationRequested, CancellationRequested | MISSING | other part |
| 9 | UpsellOpportunityCreated | EXISTS | V |
| 9 | RetentionRecoveryRequired | EXISTS | V, T-pm |
| 9 | Daily/weekly/monthly jobs | EXISTS (hourly tick) / MANUAL (cadence) | `sweep_support_sla` and the scheduled health, check-in and message sweeps run on every cron tick (`sweepSupportAndHealth`); the renewal sweep already ran (`sweepMaintenanceLifecycle`). No daily/weekly/monthly cadence is configured: each door is idempotent, so the tick frequency is the deployment's choice |
| 10 | P8-ADM-001 Customer 360 | PARTIAL | project panel, and (8D) one client across projects: phase, maintenance plan and renewal dates, tickets with SLA state, health with signals, recovery, check-ins, opportunities, invoices and outstanding on the verified basis for a viewer who may read finance, contact eligibility, caps, quiet periods, ledger and value-report drafts (`tests/customer-360-queries.test.ts`). Change requests are not listed; the page is typechecked and linted, not rendered in a browser |
| 10 | P8-ADM-002 health explanation | EXISTS | signals with value, level and detail, plus history |
| 10 | P8-ADM-003 VIP, feedback, approvals, communication history | PARTIAL | opportunities and check-ins shown; communication history (the 8D ledger) shown; VIP absent by design; feedback capture MISSING |
| 10 | P8-ADM-004 dashboard | PARTIAL | `/projects/customer-success`: worst-health-first table; (8D) `/projects/customer-success/observability`: tickets by state and SLA, health distribution, recovery plans, renewals and opportunities by stage, with the age of the oldest (V8D). Tables, not charts; churn reasons and utilization are the other part |
| 10 | P8-ADM-005 Admin configuration | PARTIAL | thresholds (SLA hours, health, renewal window, check-in gap) and automation pause; plan versioning, pricing, VIP criteria, escalation rules, discounts: MISSING |
| 10 | P8-ADM-006 role-specific views | PARTIAL | clients and other tenants read nothing (V); every internal role sees all Phase 8 data |
| 11 | Operational/relationship/commercial policy | PARTIAL | eligibility per category (consent withdrawal, minimum gap, recovery first, open P1/P2); nothing auto-sends |
| 11 | Anti-spam: gap, caps, cadence, quiet periods, preferences | PARTIAL | minimum gap and consent, and (8D) Admin-set per-client caps and quiet periods (no default number), the ledger, and `projects.can_contact_now(client, channel, purpose, contact)` asking consent, quiet periods, caps and the 8A category rules (V8D, R8D). Cadence per message category and channel/language preferences are NOT built: no document fixes them (manual action M-2) |
| 11 | No response is not proof of dissatisfaction | EXISTS | engagement recorded; health did not move in V |
| 12 | P8-SEC-001 organization scoping | EXISTS | RLS, parent-org triggers, freeze triggers, cross-tenant negatives (V) |
| 12 | P8-SEC-002 least privilege | EXISTS | service-only and person-only doors proved by grants (V, T-found) |
| 12 | P8-SEC-003 approvals for exceptions/discounts | PARTIAL | discounts stay in the existing decision engine; waivers are owner-only |
| 12 | P8-SEC-004 audit of transitions | PARTIAL | actor, states, note, evidence on ticket events and audit rows; no correlation id on ticket events |
| 12 | P8-SEC-005 client output free of internals | EXISTS | client function returns status labels only; PM messages leak-checked (T-pm) |
| 12 | P8-SEC-006 retention/deletion | MISSING | no delete surface exists; no retention policy built |
| 13 | Unit / DB / API-contract tests | EXISTS | T-found, T-wf, T-pm, V |
| 13 | Integration, reliability, performance, compatibility, UI | PARTIAL / MISSING | duplicate delivery proved in V; no load, no browser, no device run: the panel is typechecked and linted only |
| 13 | Manual/UAT | MANUAL_EXTERNAL | M-1 to M-8 |
| 14 | E2E-01 completion to handoff, initialized once | PARTIAL | exactly-once proved; the source is the completion record, not Phase 7's snapshot |
| 14 | E2E-02 warranty defect to close | EXISTS | V (the Developer's fix is represented by the verified defect it links) |
| 14 | E2E-03 how-to answered, no false bug | EXISTS | V |
| 14 | E2E-04, 05, 09 | MISSING | other part |
| 14 | E2E-06 out-of-scope becomes a change request/opportunity | EXISTS | V |
| 14 | E2E-07 renewal | PARTIAL | flag, review, expiry; proposal and payment: other part |
| 14 | E2E-08 at risk to recovery | EXISTS | V |
| 14 | E2E-10 repeated need to separate change request/new project | PARTIAL | detected, qualified, handed to Sales, accepted as a separate change request; the quote step is the existing sales doors, not driven here |
| 14 | E2E-11 opt-out | EXISTS | commercial and relationship held, operational continues (V); nothing sends |
| 14 | E2E-12 duplicate events | EXISTS | for tickets, opportunities, check-ins, events, sweeps |
| 14 | E2E-13 cross-tenant | PARTIAL | denied (V); the denial itself is not audited |
| 14 | E2E-14 metrics reconcile | PARTIAL | overview and per-project health come from the same functions (V); no metric reconciliation suite |
| 14 | E2E-15 worker/provider failure | PARTIAL | agent workflows fail honestly and never write on a bad answer (T-wf); the runner owns retry/DLQ |
| 15 | P8-IMP-001..026 | see rows above | 003, 005, 006, 011, 012, 014, 015, 021 EXISTS; 002, 004, 010, 016, 017, 018, 019, 020, 022 PARTIAL; 007, 008, 009, 013 MISSING (other part); 023, 024, 025 MANUAL_EXTERNAL; 026 MISSING: Phase 8 is NOT claimed complete |
| 16 | Evidence package | PARTIAL | this matrix, the log, the verifier and harness; no deploy/smoke evidence |
| 17 | P8-DOD-001..015 | PARTIAL | 001 PARTIAL, 002 PARTIAL (the maintenance/change-request/new-project split is enforced; maintenance plans are the other part), 005 EXISTS, 006 PARTIAL (recovery yes, cancellation other part), 007 EXISTS, 008 PARTIAL, 009 PARTIAL, 010 PARTIAL, 011 PARTIAL, 013 EXISTS (nothing fakes a provider, payment, client or admin success), 003/004/012/014/015 not satisfied |
| 18 | Completion verdict | MISSING | not claimed: verdict is PARTIAL |

## 3. Customer Success agent spec

| Section | Requirement | Status | Evidence / reason |
|---|---|---|---|
| 1 | Mission, no unauthorized commercial commitment | EXISTS | no door the agent can run quotes, discounts or sends |
| 2 | Activation points | PARTIAL | check-ins, renewal, at-risk signal, handoff exist as records/events; client feedback and major-release triggers MISSING |
| 3 | Required context | PARTIAL | client, project, scope, warranty, plans, tickets, invoices (health reads overdue count), consent, health history; "language" preference not recorded anywhere |
| 4 | CUS-AUD-001..005 | PARTIAL | the survey in the log; the registry already defined the agent |
| 5 | Consume the handoff once | EXISTS | V |
| 5 | Customer 360 and next-action queue | PARTIAL | panel + overview + (8D) the single-client Customer 360 page; no "next action" queue object |
| 5 | Check-ins on a configurable cadence | PARTIAL | first check-in and renewal check-ins automatic; adoption/major-release/post-incident are created by a person; cadence settings: first check-in days and minimum gap |
| 5 | Explainable health | EXISTS | V, R |
| 5 | Warranty/support vs maintenance, not treating new functionality as a bug | EXISTS | V |
| 5 | Maintenance eligibility, usage, renewal timing | PARTIAL | renewal timing; eligibility and usage other part |
| 5 | Recovery plans and re-evaluation | EXISTS | V |
| 5 | Expansion signals to Upsell/Sales | EXISTS | V |
| 5 | Record outcomes and feedback | PARTIAL | check-in outcome/engagement; feedback and client goals: MISSING |
| 5 | Escalate ambiguity to Admin | EXISTS | disputed tickets escalate automatically (V) |
| 6 | Decision rules (how-to, warranty, maintenance, change request, new project, at risk) | EXISTS | V |
| 7 | Structured handoff contract and events | PARTIAL | project/client scope, ids, evidence, state in door arguments and event payloads; "retry history" and "policy refs" not carried |
| 8 | Authoritative records, no fabricated state | EXISTS | derived health; decisions carry actor, time, reason, evidence |
| 9 | Forbidden: fabricate satisfaction, usage, VIP; promise discounts; mark complete without outcome | EXISTS | no VIP column, no score; CHECK on check-in completion; agent cannot complete one (grants, V) |
| 10 | Failure/retry/escalation | PARTIAL | workflow fails honestly, door idempotent; escalation to the Orchestrator is the existing runner |
| 11 | CUS-TST-001 idempotent handoff | EXISTS | V |
| 11 | CUS-TST-002 explainable health with history | EXISTS | V |
| 11 | CUS-TST-003 at risk, recovery, re-evaluation | EXISTS | V |
| 11 | CUS-TST-004 eligibility with an open critical issue and preferences | EXISTS | V (consent only; no other preference exists) |
| 11 | CUS-TST-005 renewal without silently renewing | EXISTS | V, R |
| 11 | CUS-TST-006 opportunity only from evidence | EXISTS | V, T-wf |
| 11 | CUS-TST-007 role/tenant isolation on Customer 360 | EXISTS | V |
| 11 | CUS-TST-008 duplicate event/retry | EXISTS | V |
| 12 | CUS-IMP-001 registry | EXISTS | the agent was already defined; unchanged (see the log) |
| 12 | CUS-IMP-002 schemas | EXISTS | strict Zod, T-wf |
| 12 | CUS-IMP-003 context loading | EXISTS | org-scoped reads, T-wf |
| 12 | CUS-IMP-004 policy check before governed action | PARTIAL | the doors are the policy; the Admin Approval engine is not consulted (no governed action here) |
| 12 | CUS-IMP-005..008 rules, events, idempotency, retry | EXISTS / PARTIAL | as above |
| 12 | CUS-IMP-009 observability | PARTIAL | the runner records runs; (8D) `/projects/customer-success/observability` counts and ages the Phase 8 records; no alerting and no metrics export |
| 12 | CUS-IMP-010 RBAC/secrets | EXISTS | V, T-wf (secret refusal) |
| 12 | CUS-IMP-011 admin visibility | EXISTS | panel + overview |
| 12 | CUS-IMP-012..015 regression, E2E, manual guide, DoD | PARTIAL | full suite run recorded in the log; manual guide in `phase-8a-manual-actions.md`; DoD not claimed |
| 13 | CUS-DOD-001..010 | PARTIAL | 002, 006, 008 satisfied for the built part; 007 needs independent QA; 010 downstream acceptance is the other part |
| 14 | Manual configuration | MANUAL_EXTERNAL | M-1, M-2, M-4 |
| 15 | Example journeys | EXISTS | V drives both |

## 4. Support agent spec

| Section | Requirement | Status | Evidence / reason |
|---|---|---|---|
| 1 | Safe routine support, classify against scope/warranty/maintenance, no internal information to clients | EXISTS | V; client function exposes status labels only |
| 2 | Activation: client request, CS escalation, monitoring alert, client reply | PARTIAL | the open-ticket door takes portal, email, WhatsApp, phone, monitoring, customer-success and internal sources; an inbound client support message in a project conversation now calls it (Phase 7c). A monitoring alert and a post-project account thread are not wired |
| 3 | Required context | PARTIAL | project, scope window, warranty, plans, recent tickets; approved knowledge base MISSING (none exists); language/channel preference not recorded |
| 4 | SUP-AUD-001..005 | PARTIAL | log |
| 5 | Normalize request; determine the six classes | EXISTS | proposal workflow + classify door (V, T-wf) |
| 5 | Compare expected vs actual against scope/version | PARTIAL | the agent sees the warranty window and plans; scope item comparison MISSING |
| 5 | Ticket with severity/priority, coverage, evidence | EXISTS | V |
| 5 | Answer known questions only from approved knowledge | PARTIAL | a how-to closes only with the knowledge reference recorded; no knowledge base to read from |
| 5 | Escalate to Developer/QA/CS/Sales/Admin | PARTIAL | escalation to a person and root-cause links (defect, change request, maintenance item, opportunity); no automatic Developer task is raised |
| 5 | Client-safe status updates | EXISTS | `projects.client_support_tickets` (V) |
| 5 | QA/release/client confirmation before close | EXISTS | V, R (both the door and the CHECK) |
| 6 | Decision rules | EXISTS | V |
| 7 | Events: SupportTicketCreated/Classified, DeveloperTaskRequested, QAVerificationRequested | PARTIAL | created and escalated emitted; classified is an event row on the ticket, not an outbox event; Developer/QA requests are not emitted |
| 8 | Evidence and memory | EXISTS | ticket events are append-only history |
| 9 | Forbidden: label a bug as paid, hide coverage, expose internals, close before QA, invent root cause | EXISTS | CHECKs and doors (V, R); root cause must be a linked record |
| 10 | Failure/retry | PARTIAL | as above |
| 11 | SUP-TST-001 classification matrix | EXISTS | V |
| 11 | SUP-TST-002 scope/version and coverage | PARTIAL | warranty window and plan version dates; scope-item comparison MISSING |
| 11 | SUP-TST-003 duplicate-message idempotency | EXISTS | V, R |
| 11 | SUP-TST-004 severity/priority/SLA | EXISTS | V, R |
| 11 | SUP-TST-005 known-answer vs escalation | PARTIAL | how-to needs a knowledge reference; disputed escalates |
| 11 | SUP-TST-006 Developer/QA handoff payload | PARTIAL | root-cause link, no Developer task payload |
| 11 | SUP-TST-007 client-safe redaction | EXISTS | client function; reply drafts refuse price/commitment/secret (T-wf) |
| 11 | SUP-TST-008 tenant isolation | EXISTS | V |
| 12-13 | SUP-IMP / SUP-DOD | PARTIAL | as the Customer Success rows |

## 5. Upsell agent spec

| Section | Requirement | Status | Evidence / reason |
|---|---|---|---|
| 1 | Legitimate opportunities from real data, no pressure or fake urgency | EXISTS | evidence rules; no urgency field the agent can invent beyond low/normal/high, and the prompt forbids manufacture |
| 2 | Activation signals | PARTIAL | the workflow reads out-of-scope tickets, check-ins and upsell signals; usage/performance/compliance signals MISSING (no data source) |
| 3 | Required context | PARTIAL | project history, tickets, check-ins, health; service catalog and pricing boundaries MISSING (no catalog exists by decision ADM-22) |
| 4 | UPS-AUD-001..005 | PARTIAL | log |
| 5 | Evidence only; not already included; structured opportunity; qualify; suppress during recovery; client-safe offer components; track outcomes | EXISTS / PARTIAL | all but "approved offer components from the service catalog" (no catalog) |
| 6 | Decision rules | EXISTS | V |
| 7 | Events | PARTIAL | UpsellOpportunityCreated, SalesHandoffCreated, OpportunitySuppressedForRecovery emitted; OpportunityQualified/Closed are audit rows |
| 9 | Forbidden: invent a problem, degrade service, call a bug a paid feature, hide maintenance, pressure, promise price/discount | EXISTS | no price column, trigger and CHECKs, already-included refusal (V, R) |
| 11 | UPS-TST-001 evidence requirement | EXISTS | V |
| 11 | UPS-TST-002 included-scope suppression | EXISTS | V, R |
| 11 | UPS-TST-003 health-state suppression | EXISTS | V, R |
| 11 | UPS-TST-004 duplicate signal | EXISTS | V |
| 11 | UPS-TST-005 structured Sales handoff validation | PARTIAL | the CRM deal is opened in discovery with no value; the structured payload is the opportunity row |
| 11 | UPS-TST-006 service-catalog/policy boundary | PARTIAL | policy boundary (no price) proved; no catalog |
| 11 | UPS-TST-007 communication preference / anti-spam | PARTIAL | consent, gap and (8D) caps and quiet periods in `can_contact_now`; the agent contacts nobody; channel/language preferences are not recorded |
| 11 | UPS-TST-008 outcome tracking | EXISTS | accepted (naming the change request or project), lost, no action (V) |

## 6. Sales agent spec (post-launch)

| Section | Requirement | Status | Evidence / reason |
|---|---|---|---|
| 1-2 | Receive structured Phase 8 opportunities | EXISTS | `sales.hand_off_phase_eight_opportunity` opens a discovery deal through the existing `sales.open_renewal` |
| 5 | Focused discovery reusing Customer 360 context | PARTIAL | the opportunity carries the context; no Sales workflow |
| 5 | Versioned quote from commercial rules; negotiation inside authority | PARTIAL | existing quotation, proposal and discount doors (migration 20261030100000) apply from the deal onward; Phase 8A writes none of them (V asserts no door touches them) |
| 5 | Acceptance against the exact quote/scope version | PARTIAL | existing proposal acceptance; accepted is recorded here only with the separate change request or project named |
| 5 | Route accepted work to Finance, create the change request/new project | PARTIAL | Finance routing and creation are existing doors; 8A records the link |
| 5 | LOST/no-action reason, return to Customer Success | EXISTS | V |
| 6 | Decision rules (already included, change request, new project, discount outside authority, ambiguous) | PARTIAL | already included refused (V); discount authority is the existing engine; ambiguous acceptance is never inferred because only a person records an outcome |
| 9 | Forbidden: invent price, quote covered work, approve own discount | EXISTS | no Phase 8A agent holds a pricing door (T-found, T-wf) |
| 11 | SAL-TST-001 handoff completeness | PARTIAL | V |
| 11 | SAL-TST-002 discovery reuse | MISSING | no Sales workflow |
| 11 | SAL-TST-003, 004 quote versioning, discount approval | NOT_APPLICABLE | the existing doors and their own verifiers own these |
| 11 | SAL-TST-005 explicit acceptance evidence | PARTIAL | a person records the outcome with a named record |
| 11 | SAL-TST-006 change request vs new project | EXISTS | V |
| 11 | SAL-TST-007 Finance handoff | MISSING | existing finance doors |
| 11 | SAL-TST-008 lost/no-action and CS return | EXISTS | V |

## 19. Phase 8D: what closed the open gaps (this section only adds; no earlier row was weakened)

Evidence: `V8D` (180+ checks through the real doors, rolls back), `R8D` (every control red-proved: see `phase-8d-implementation-log.md`), `tests/phase-eight-d-foundation.test.ts`, `tests/phase-eight-d-actions.test.ts`,
`tests/customer-360-queries.test.ts`, `tests/phase-eight-observability.test.ts`, `tests/value-report.test.ts`.

| Gap | Status | Evidence / reason |
|---|---|---|
| Handoff edges the specs imply: Support to Customer Success and Sales; Customer Success to Support and Finance; Sales back to Customer Success | EXISTS | literal arrays in `src/modules/agents/registry.ts`, mirrored by migration `20261110000000`; `npm run check:record` section 16 counts both; V8D, R8D (one case per edge), T-found |
| Customer 360: a single-client page across projects | EXISTS (not rendered in a browser) | `app/(internal)/clients/[clientId]/customer-360/page.tsx`, `src/modules/projects/customer-360-queries.ts`; finance only where `invoice.read`; every read refuses on failure |
| Communication caps and quiet periods as Admin-set data | EXISTS | `projects.client_communication_caps`, `projects.client_quiet_periods`, doors `set/clear_client_communication_cap` and `add/cancel_client_quiet_period` (Admin only); no default number; V8D, R8D |
| Communication ledger (what a person sent, what an agent drafted), append-only, with a door to record a send | EXISTS | `projects.client_communication_ledger`, `record_client_communication` (a person), `record_agent_communication_draft` (service role; a draft counts toward nothing); V8D, R8D |
| Deterministic eligibility `can_contact_now` respecting consent, quiet periods and caps | EXISTS | `projects.can_contact_now`; consent is the existing `crm.communication_consent` (WhatsApp only); email and portal have no consent record so are refused (ADM-81); V8D, R8D |
| Delivery and reply tracking by a person, or joined from the outbound message log | EXISTS (person-recorded) | `client_communication_events`, `client_communication_history`; the message log is joined read-only; no provider callback writes it (MISSING) |
| Value reports as drafts of cited facts, versioned templates, a person approves | EXISTS | `projects.value_report_facts`, `value_report_drafts`, store/edit/approve/discard doors, `src/modules/projects/value-report.ts` (template version 1, fingerprint pinned). Facts: tickets resolved, changes released, hours logged, production release checks. There is NO uptime fact because none is measured |
| Phase 8 observability: counts and ages | EXISTS (tables, not charts) | `projects.phase_eight_observability`, `/projects/customer-success/observability` (the 8A overview did not already show distributions) |
| Nothing in 8D sends, quotes, prices or discounts | EXISTS | T-found: no migration inserts into crm, finance or sales, calls the network or emits an event; V8D structure checks; an agent draft that names a price is refused at the door and by the CHECK |

Still open after 8D, not claimed: automatic delivery state from the provider, cadence per message category, channel and language preferences, feedback capture, VIP, a next-action queue, charts, and everything the other
Phase 8 part owns. Phase 8 is NOT claimed complete.

## Closed by Phase 8 part C (the maintenance plan lifecycle)

Rows above marked "other part" for the maintenance plan lifecycle are now built (see `docs/phase-8c-implementation-log.md`): plan CRUD/Admin UI (catalog, open plan, acceptance), usage ledger and overage draft, renewal proposal/payment (`MaintenanceActivationRequested` is the plan's `draft` with a recorded acceptance; nothing is auto-requested), cancellation with a required reason (churn reasons are queryable), Finance for maintenance through `finance.maintenance_financial_gate`, ClientMaintenanceSubscription as `projects.maintenance_plan_lifecycle`, and the 8A renewal sweep is now called from the cron tick (closing M-3 for renewals). Support SLA, health snapshots and check-ins are still not scheduled by this change.
