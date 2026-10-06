# Phase 7 implementation traceability

Source: the eleven Phase 7 PDFs P701–P711 (extracted text; the PDFs are in `phase 7/`, not committed). Status: EXISTS · PARTIAL · MISSING · MANUAL_EXTERNAL.

- **EXISTS** means built, and proven by `scripts/verify-phase-seven.sql` (268 live checks on a scratch Postgres; the journey is the whole Phase 7 flow below) and/or the unit tests `tests/phase-seven-*.test.ts`.
- **MANUAL_EXTERNAL** means it needs something only the owner or a third party can supply (production credentials, DNS, a store account, a monitoring tool). Those are listed in `docs/phase-7-manual-actions.md`. They are never faked: a door and an honest blocker exist instead.
- Nothing in Phase 7 deploys anything. Every "runner" call in the verifier is the service-role door a real executor would call, made by the script.
- The verifier seeds the upstream Phase 6 evidence (the approved candidate and its gates) with triggers off; Phase 6 itself is proven by `scripts/verify-phase-four-e2e.sql`, which still passes.

Journey proven end to end in the verifier: Phase6Completed with M4 pending (blocked) → M4 verified through the real finance doors → Phase 7 READY once → plan for the exact candidate → readiness by name → Admin approval (creator ≠ approver) → deployment RECORD (runner-only; the not-configured executor records a blocker) → smoke BLOCKED / FAILED → incident → Admin-approved rollback → failed then passed re-smoke → incident closed with a review → config failure → code defect (refused as a retry; new candidate bound only with every Phase 6 gate) → stale-approval refusal → config recovery → ProductionValidated → config-only change re-smoke → handover package (versioned, secrets refused, source/limitations/access gaps block it) → Admin edit request → v2 → client correction → v3 → delivery → informal "looks good" refused, old version refused, formal acceptance of the exact version → financial dispute / waiver / reversal → completion gate → ONE immutable completion record and a frozen Customer Success intake; replay safe.

## P701 Master

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-ENT-01 | 01 §2, §5 | Entry: Phase6Completed + exact Admin-approved candidate + M4 verified + intake | EXISTS | `20261104100000` `projects.open_phase_seven`; verifier §1 (T001: M4 pending blocks; a candidate that is no longer current blocks) |
| P7-ENT-02 | 01 §2 | No unresolved mandatory release blocker | EXISTS | `deployment_gate` gate `no_release_blocker` (S0/S1 product defects) |
| P7-STATE-01 | 01 §6 | The 19 states | EXISTS | `projects.phase_seven.state` CHECK, moved only by the doors (`p7_set_state`); `waiting_phase6`..`phase8_ready` |
| P7-CAND-01 | 01 §5, I04 | Exact candidate resolver; only the exact Phase 6 candidate may be deployed | EXISTS | the plan's commit/artifact are RESOLVED from the workspace (never typed); `p7_plan_guard` refuses any other (T002); `p7_candidate_ok` re-read at approval, request and start |
| P7-PLAN-01 | 01 §3, §13, I05 | Deployment plan: environment, migration, rollback, monitoring | EXISTS | `projects.p7_deployment_plans`; `create_deployment_plan`; an ordered, reversibility-stated migration plan (irreversible needs a backup) |
| P7-READY-01 | 01 §7, I06–I10 | Environment / config / secrets / migration / rollback / monitoring readiness | PARTIAL | recorded by a person with evidence (`p7_readiness_items`, by NAME only; no value column exists) and read by `deployment_gate`. No automatic checker exists: it needs production access (MANUAL_EXTERNAL) |
| P7-APPR-01 | 01 §5, I11 | Admin deployment approval bound to the exact commit; changed candidate voids it | EXISTS | `decide_deployment_plan`; `p7_deployment_approvals` append-only with commit + artifact; `p7_deployment_approved` re-checked at execution (verifier §7) |
| P7-APPR-02 | 04 §4 | Creator ≠ approver; an agent never approves its own deployment | EXISTS | `creator_cannot_approve`; `is_admin()` required; no service-role path |
| P7-DEPLOY-01 | 01 §5, I12 | Deployment execution RECORD | EXISTS (record) / MANUAL_EXTERNAL (execution) | `projects.p7_deployments` + `p7_deployment_events`, written only by `request_deployment`, `record_deployment_blocker`, `record_deployment_progress` (service role; not granted to `authenticated`); raw writes refused. **The executor is not built** (needs production credentials) |
| P7-VALID-01 | 01 §8, I13 | Post-deployment smoke / live validation | EXISTS (record) / MANUAL_EXTERNAL (probes) | `p7_validation_runs` + `p7_validation_checks`, truth states passed / failed / not_tested, evidence on a pass, exact deployment; recorded by an independent person. No automated probe exists (needs the production URL and safe test accounts) |
| P7-VALID-02 | 01 §9, 05 §8 | A failed required check pauses completion; BLOCKED stays incomplete | EXISTS | `finish_validation_run` → failed (incident + pause) / blocked (missing checks named) / passed; T003, P705-T006 |
| P7-INC-01 | 01 §9, I14 | Incident / rollback / recovery workflow | EXISTS | `p7_incidents`, `p7_incident_events`, `p7_rollback_decisions`; `classify_incident`, `decide_rollback`, `close_incident` |
| P7-CHG-01 | 01 §5, I15 | Code change after Phase 6 requires affected revalidation and a new candidate | EXISTS | `record_production_change`, `rebind_phase_seven_candidate` (every Phase 6 hard gate satisfied on the new commit); a code incident cannot be "recovered" by a retry (T005, T006) |
| P7-HAND-01 | 01 §10, I16 | Handover package structured and versioned | EXISTS | `p7_handover_packages` (+ items, access transfers); a version is immutable after draft; an edit is a NEW version; one live version |
| P7-HAND-02 | 01 §10, I17 | Secure access-transfer records | EXISTS | `p7_access_transfers`: method, status, evidence reference, rotation, retained support access (Admin-authorized). No secret column; `p7_has_secret` refuses secret-shaped text in every field (T007) |
| P7-HAND-03 | 01 §10 | Source/repo handover where the contract includes it | EXISTS | `p7_contract_deliverables` + an item per contract line; an excluded one is NOT_REQUIRED with a reason; a required one missing blocks (P707-T001/T002) |
| P7-REV-01 | 01 §5, I18 | Admin handover review | EXISTS | `decide_handover_package` approve / edit_requested; `p7_handover_reviews` append-only (T008) |
| P7-ACC-01 | 01 §5, I19 | Client handover acceptance | EXISTS | `record_client_acceptance` recorded by staff with evidence (signed document, portal confirmation, email reply, call, minutes) for the EXACT version (T009) |
| P7-COMP-01 | 01 §11, I20 | Completion gate and record | EXISTS | `p7_completion_gate` (9 gates), `complete_phase_seven`, `p7_completion_records` (frozen, one per project) (T010, T012) |
| P7-CS-01 | 01 §11, I21 | Customer Success handoff | EXISTS (snapshot) / PARTIAL (Phase 8 workflow) | `projects.phase_seven_handoffs`, frozen, written with the completion record. Phase 8 reads it; the Phase 8 workflow itself is not built here |
| P7-ADMIN-01 | 01 §15, I22 | Admin Panel and audit | PARTIAL | `phase-seven-panel.tsx` with a form for every door; every door writes `core.record_audit`. Typechecked, linted, unit-tested; **not rendered or clicked** |
| P7-EVT-01 | 01 §14, I23 | Idempotent events and jobs | EXISTS | event types declared; `open_phase_seven` once; replay-safe doors (T012); runner handlers `openPhaseSeven`, `runDeployment` |
| P7-E2E-01 | 01 §19, I24 | The mandatory end-to-end scenario | EXISTS (SQL) | `scripts/verify-phase-seven.sql`; the deployment itself is simulated by service-role door calls |
| P7-TEST-01 | 01 §18 | T001–T012 | EXISTS | T001 §1; T002 §2/§7; T003 §4; T004 §7; T005 §6; T006 §5; T007 §8; T008 §8; T009 §9; T010 §4; T011 §9 (classified as a Change Request route; the CR record itself is created through the existing change-request surface); T012 §12 |
| P7-NEG-01 | 01 §20 | Negative / recovery scenarios | PARTIAL | worker crash, duplicate events, migration/secret/monitoring failures, rollback failure paths, duplicate alerts, client-delayed acceptance: covered by idempotent doors and refusal states. Cloud timeouts, provider outages and audit-store failure are runtime conditions with no executor to fail (an audit write is in the same transaction as the change, so its failure rolls the change back) |
| P7-SEC-01 | 01 §16 | Least-privilege, secret-safe, auditable, immutable history, tenant isolation | EXISTS | RLS internal-only on all 24 tables, no write grant to `authenticated`, tenancy-guard + frozen org triggers (`core.unguarded_org_fks()` empty), append-only/frozen history, portal client reads nothing |
| P7-P8-01 | 01 §12 | Phase 8 boundary | EXISTS (routing record) / MISSING (workflows) | `p7_handover_feedback` classifies and routes (change request, support/bug, customer success, client action); Support, Maintenance and Sales workflows are Phase 8/earlier |

## P702 PM

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-PM-01 | 02 §5 | Task 5 start only after the entry gate | EXISTS | `project.phase_seven_ready` (emitted once by `open_phase_seven`) → `announcePhaseSevenReady` (PM7-M01); says nothing has been deployed (P702-T001/T002) |
| P7-PM-02 | 02 §6, §13 | Truthful deployment updates; never "live" before authoritative state | EXISTS | PM7-DEPLOY-APPROVED ("approval is not deployment"), PM7-VALIDATED, PM7-INCIDENT (no cause, no "verified"); `tests/phase-seven-pm7.test.ts` |
| P7-PM-03 | 02 §8, §13 | Handover invitation, exact version | EXISTS | `project.handover_delivered` → PM7-HANDOVER-READY (keyed by the package version; "looks good is not acceptance") |
| P7-PM-04 | 02 §10 | Completion message only after ProjectCompleted | EXISTS | `project.completed` → PM7-COMPLETE; one per project |
| P7-PM-05 | 02 §6 | Client-safe: no secret, stack trace, model/provider detail | EXISTS | message tests; PM messages carry their template version (`PM_TEMPLATES`) |
| P7-PM-06 | 02 §9 | Feedback classification | PARTIAL | the seven classes and their routes are a deterministic table (`p7_feedback_route`) applied by staff; there is no automatic classifier |
| P7-PM-07 | 02 §7, §12 | Client action requests (DNS, store, account) as an entity with a deadline | PARTIAL | a manual external step is a readiness item with exact instruction, owner and evidence; there is no separate ClientActionRequest record or deadline tracking, and the PM does not message the client directly (all PM messages go to the internal channel, as in Phases 5–6) |
| P7-PM-08 | 02 §14 | Admin panel: PM timeline, delivery, client actions | PARTIAL | PM delivery is in the existing PM messages panel; the Phase 7 panel shows state and feedback |

## P703 Orchestrator

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-ORCH-01 | 03 §7 | Dependency graph: deploy waits for approval/readiness, smoke for deployment, handover for ProductionValidated, completion for acceptance | EXISTS | enforced by the doors themselves; `projects.p7_task_graph` shows it derived from the rows (never a stored flag) |
| P7-ORCH-02 | 03 §5, §6, §8 | Task types, execution envelope, tool authorization, elevated production permissions, bounded retries | MISSING | the three Phase 7 agents are defined and disabled with NO tool and handoff only to QA; the Orchestrator's runtime does not route to them and no Phase 7 tool permission exists. Production tools need credentials (MANUAL_EXTERNAL) |
| P7-ORCH-03 | 03 §9 | Failure routing: infra/config → Deployment; code defect → revalidation path | EXISTS (rule) | a code defect is refused as a retry (`incident_path_is_not_config_recovery`) and opens a change record; routing to an agent is not built |
| P7-ORCH-04 | 03 §10 | Idempotency: duplicate Phase7Ready / deploy / smoke / completion | EXISTS | verifier §1, §3, §4, §12 |
| P7-ORCH-05 | 03 §11, §14 | Agent run trace, cost, Failure Queue | PARTIAL | the existing Phase 5/6 audit and cost recording apply to any agent run; there are no Phase 7 runs (agents disabled) |
| P7-ORCH-06 | 03 §13 | Phase 7 events as routable work | PARTIAL | events exist and PM/runner handlers consume them; the Orchestrator does not create agent tasks from them |

## P704 Deployment Agent

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-DEP-01 | 04 §5, §6 | Pre-deployment readiness and planning | EXISTS (gate) / MANUAL_EXTERNAL (checkers) | `deployment_gate` (9 gates read from rows); validators run by a person; no automatic secret/env checker |
| P7-DEP-02 | 04 §7, §11 | Deploy the exact artifact; results SUCCEEDED_PENDING_VALIDATION / FAILED / ROLLED_BACK / RECOVERED_PENDING_VALIDATION | EXISTS (record) | success must name the deployed artifact hash and equal the candidate's byte for byte (P704-T001); success is never "validated" (T008) |
| P7-DEP-03 | 04 §7, I11–I12 | Artifact deploy adapter, migration execution adapter | MANUAL_EXTERNAL | `deployment-executor.ts` is the seam; only "not configured" exists; the job records `executor_not_configured` |
| P7-DEP-04 | 04 §8 | Migration safety | PARTIAL | ordered plan, reversibility, backup requirement, destructive acknowledgement, no blind rollback of an irreversible step; actual execution/lock handling is external |
| P7-DEP-05 | 04 §9 | Rollback/recovery | EXISTS (record) | Admin-approved, named target, once; a recovery is of the SAME artifact |
| P7-DEP-06 | 04 §10 | Manual external operations | EXISTS | `manual_dns/store/signing/account/other` readiness items block the gate until done with evidence (T010) |
| P7-DEP-07 | 04 §15 | No cross-project mix-up, no ad hoc source edit | EXISTS | tenancy guards; the artifact hash must match; no door edits source (P704-T012: no door exists, a source change voids the approval) |
| P7-DEP-08 | 04 §14 | Admin Panel (plan, environment, run log, migrations, rollback, manual steps) | PARTIAL | panel sections; not rendered |

## P705 QA / Release Agent

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-QA-01 | 05 §5–§8 | Smoke, live flow, monitoring checks; PASS / FAIL / BLOCKED decision | EXISTS (record) | ten check keys, eight always required; a pass needs evidence |
| P7-QA-02 | 05 §1 | A deployment claim is not production validation | EXISTS | validation is a person's door (service role denied); validator ≠ deployment actor; `p7_production_validation` is derived from rows |
| P7-QA-03 | 05 §9 | Rollback verification: re-smoke before the incident closes | EXISTS | `post_rollback` run tied to the incident (P705-T009, P706-T008) |
| P7-QA-04 | 05 §10 | Code-change boundary | EXISTS | see P7-CHG-01 |
| P7-QA-05 | 05 §6 | Safe test data; production-specific integrations | MANUAL_EXTERNAL | needs production access and test accounts |
| P7-QA-06 | 05 §12 | ProductionHealthSnapshot (errors, metrics, integrations, DB) | MISSING | needs a monitoring source; checks are recorded by a person |
| P7-QA-07 | 05 §13 | SmokeFailed / SmokePassed / RollbackCompleted events | PARTIAL | `production_validation_failed`, `production_validated`, `deployment_failed`; rollback completion is a deployment event row, not a separate event type |

## P706 Incident / Rollback

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-INC-02 | 06 §5, §6 | Eight incident types, severity, security/data risk = highest, contained at once | EXISTS | CHECK list; `raise_incident` forces sev1 for security / data integrity; sev1 blocks further deploy actions (`p7_deploy_blocker`) |
| P7-INC-03 | 06 §7, §9 | Completion paused; config recovery of the same candidate; code fix new candidate | EXISTS | verifier §5–§7 |
| P7-INC-04 | 06 §8 | Controlled rollback, never blind; unknown target blocks; irreversible migration needs acknowledgement | EXISTS | `decide_rollback`: `target_unknown`, `irreversible_migration_needs_acknowledgement` |
| P7-INC-05 | 06 §10, §11 | Incident closes only after verified recovery; review (root cause, timeline, corrective actions) | EXISTS | `close_incident` (`recovery_not_verified`, `review_required`); a closed incident is never edited (T012) |
| P7-INC-06 | 06 §15 | Duplicate alerts → one canonical incident | EXISTS | partial unique index + dedupe in `p7_open_incident` (T010) |
| P7-INC-07 | 06 §6 | Admin notification by policy; client-safe messaging separate from technical detail | PARTIAL | the PM7-INCIDENT message is client-safe; there is no Admin notification policy engine (the incident is on the Admin panel and the internal channel) |
| P7-INC-08 | 06 §5 | Provider-outage wait/retry/failover | PARTIAL | an incident path `provider` is a recorded decision; no automatic failover |
| P7-INC-09 | 06 §11 | Corrective-action linkage (tasks) | PARTIAL | corrective actions are recorded text; no task is created |

## P707 Handover

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-HO-01 | 07 §5, §7 | Package contents and completeness QA | EXISTS | six standing items + one per contract line; `p7_handover_completeness`: production release current, M4, contract items, limitations disclosed, access transferred, support/warranty/URL/contacts |
| P7-HO-02 | 07 §6 | No password/private key in chat; secure mechanism; rotate/revoke; retain support access only if authorized | EXISTS (record) | an access transfer is a receipt; rotation flag; retained support access needs an Admin. The secure transfer service itself (a vault) is external |
| P7-HO-03 | 07 §8 | Only an Admin-approved package reaches the client; edits create a new version | EXISTS | transition map in `p7_package_guard` + door check, red-proven in combination (T006, T007) |
| P7-HO-04 | 07 §9 | Delivery logged; client questions tracked; corrections versioned | PARTIAL | delivery records the channel and time; **downloads and access are not logged** (no download surface); questions are `p7_handover_feedback` |
| P7-HO-05 | 07 §10 | Handover defect vs change | EXISTS | route table; a missing agreed item is a correction, a bug goes to support, a feature to a change request |
| P7-HO-06 | 07 §11, §15 | Retention/expiry of sensitive artifacts; historical versions preserved | PARTIAL | versions preserved and immutable; no secret is stored so none expires; links/files are references (no file store here) |
| P7-HO-07 | 07 §15 | Client cannot see internal notes; no cross-tenant file access | EXISTS (denial) / MISSING (client view) | portal client reads nothing; there is no client-safe handover view |
| P7-HO-08 | 07 §13 | Draft package created on ProductionValidated | PARTIAL | a person creates it (it needs the contractual list); no automatic creation |

## P708 Client acceptance and completion

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-ACC-02 | 08 §6 | Acceptance references the exact package version; informal is not acceptance; cannot approve a later version | EXISTS | `package_version`/`commit_ref` stored; `informal_is_not_acceptance`; the gate reads the LATEST decision on the current delivered version (T001, T002) |
| P7-ACC-03 | 08 §6 | "Formal record where required" (configurable) | EXISTS | `phase_seven.client_acceptance_required` (Admin-set, with a reason); an Admin completion exception for exactly this package and commit |
| P7-ACC-04 | 08 §5 | Client review portal and questions | MISSING | the client does not log in to accept; staff record the acceptance with evidence (spec allows "recorded by staff") |
| P7-COMP-02 | 08 §7 | Completion gate: scope, final QA, production, payment, handover, acceptance, no blocking issue, CS handoff | EXISTS | nine gate rows; scope and acceptance are exceptionable by an Admin; production, payment, handover, QA are not |
| P7-COMP-03 | 08 §8 | Completion record: project, scope, release, QA, finance, production, handover, acceptance, limitations, support, timestamp/owner | EXISTS | `p7_completion_records.payload` |
| P7-COMP-04 | 08 §9 | Completion exceptions: reason, risk, Admin, exact gate/build/package, audit, no silent AI | EXISTS | `approve_completion_exception` (Admin only); append-only; bound to the delivered package and commit (T009) |
| P7-COMP-05 | 08 §10 | Exception states HANDOVER_BLOCKED, CLIENT_ACTION_REQUIRED, DISPUTED | PARTIAL | `client_action_required` is a state (access issue, dispute); HANDOVER_BLOCKED and DISPUTED are not separate states: a blocked handover shows as `handover_preparing`, a dispute is a decision row |
| P7-COMP-06 | 08 §11 | Historical integrity: completion does not delete, versions immutable, future work separate | EXISTS | completed workspace never returns to production work; completion record and intake frozen; a completed project accepts no change/plan door (T011) |
| P7-COMP-07 | 08 §12 | ProjectArchivePreparation | MISSING | see P711 |

## P709 Customer Success handoff

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-CS-02 | 09 §2, §5 | CS handoff intake: production version, docs, support contacts, warranty window, limitations, open non-blocking issues | EXISTS (snapshot) | `phase_seven_handoffs.payload` |
| P7-CS-03 | 09 §6, §10 | Day 0 / early follow-up schedule | PARTIAL | suggested dates (day 0, week 1, warranty end minus 7 days) are DATA in the intake; no follow-up task is scheduled (Phase 8) |
| P7-CS-04 | 09 §7, §12 | Issue classification, warranty bug / maintenance / change request / opportunity routing | PARTIAL | the handover feedback routes exist; the post-project issue workflow, warranty window model and maintenance entitlement are Phase 8 (`maintenanceEntitlement` is null in the intake: not invented) |
| P7-CS-05 | 09 §9 | Feedback, adoption signals, complaints | MISSING | Phase 8 |
| P7-CS-06 | 09 §13 | ProjectCompleted creates the handoff once | EXISTS | created in the same transaction as the completion record; replay creates nothing |

## P710 Finance

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-FIN-01 | 10 §5 | Financial clearance: final payment verified, receipt, zero balance or authorized exception, refund/dispute/chargeback | EXISTS | `p7_financial_clearance` READ from `finance.invoices`/`receipts`/`refunds` and `p7_financial_exceptions`; never a stored flag (T001–T003) |
| P7-FIN-02 | 10 §8 | Exceptions: partial balance, refund pending, chargeback, adjustment, waiver | EXISTS | `p7_financial_exceptions`; resolve or waive is an Admin decision; a waiver needs evidence (T004) |
| P7-FIN-03 | 10 §9 | Reversal before completion re-evaluates | EXISTS | clearance is computed on every read (T007; verifier §10) |
| P7-FIN-04 | 10 §6 | Finance does not declare completion | EXISTS | the clearance is one gate row; no finance door touches Phase 7 state |
| P7-FIN-05 | 10 §10 | Final financial close record | PARTIAL | the completion record carries `finance: {status: closed, clearance}`; there is no separate close record table, and no client-portal statement view |
| P7-FIN-06 | 10 §7 | Receipt linked to invoice/payment; client-visible per policy | PARTIAL | the existing receipts table is read; client-visible receipts are not changed here |

## P711 Archive, completion record and Phase 8 handoff

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-ARC-01 | 11 §7 | Completion certificate / record, immutable | EXISTS (record) / PARTIAL (document) | `p7_completion_records`; no rendered certificate document |
| P7-ARC-02 | 11 §5, §6 | Archive preparation, COMPLETED → ARCHIVING → ARCHIVED | MISSING | not built: Phase 7 ends at `phase8_ready`; archive/retention is a Phase 8 concern the spec lists here. A decision is needed on where it belongs |
| P7-ARC-03 | 11 §8 | Retention classes, deletion policy, retention jobs | MISSING | no retention engine |
| P7-ARC-04 | 11 §9 | Client portal completed / read-only state | MISSING | no portal state |
| P7-ARC-05 | 11 §10, §11 | Reactivation guard: a completed project cannot silently return to development | PARTIAL | the Phase 7 workspace and project status refuse it; module tables (tasks, deliverables) are not frozen (P711-T003 is not enforced across modules) |
| P7-ARC-06 | 11 §12 | LinkedFutureWork | PARTIAL | feedback routes only |
| P7-ARC-07 | 11 §5 | Remove unnecessary secrets | EXISTS (by construction) | no secret is ever stored; nothing to remove |

## Agents

| REQ | Requirement | Status | Evidence |
|---|---|---|---|
| P7-AG-01 | Agents the spec names that did not exist: Deployment, QA/Release, Incident/Recovery | EXISTS (definitions, disabled) | `20261104400000`; `registry.ts` (three inline definitions); mirror pairs match |
| P7-AG-02 | PM, Orchestrator, Finance, Handover, Customer Success reused | EXISTS | no duplicate created |
| P7-AG-03 | Agents run | MISSING / MANUAL_EXTERNAL | disabled; no tool; needs a funded model key and production access |
