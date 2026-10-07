# Phase 7 implementation traceability

Source: the eleven Phase 7 PDFs P701–P711 (extracted text; the PDFs are in `phase 7/`, not committed). Status: EXISTS · PARTIAL · MISSING · MANUAL_EXTERNAL.

- **EXISTS** means built, and proven by `scripts/verify-phase-seven.sql` (268 live checks on a scratch Postgres; the journey is the whole Phase 7 flow below) and `scripts/verify-phase-seven-b.sql` (440 live checks: the same journey plus the Phase 7b surface, seam, financial gate, routing and archive; every Phase 7b control was removed from the live definition and watched fail, see `docs/phase-7b-implementation-log.md`) and `scripts/verify-phase-seven-c.sql` (the Phase 7c leftovers and the Phase 8A completions below; every control was removed from the live definition and watched fail, see `docs/phase-7c-implementation-log.md`) and/or the unit tests `tests/phase-seven-*.test.ts`.
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
| P7-CS-01 | 01 §11, I21 | Customer Success handoff | EXISTS | `projects.phase_seven_handoffs`, frozen, written with the completion record. **Phase 8 now reads it (Phase 7b):** `projects.p8_build_intake` takes its facts from the handoff (`source = phase_seven_handoff`, the handoff id as `phase_seven_handoff_ref`) and the `project.completed` event runs `projects:fillPhaseEightIntake` (`fill_phase_eight_intake`); a project with no handoff is judged exactly as before. `20261108010000`; verifier 7b-4 |
| P7-ADMIN-01 | 01 §15, I22 | Admin Panel and audit | PARTIAL | `phase-seven-panel.tsx` with a form for every door; every door writes `core.record_audit`. Phase 7b adds `phase-seven-b-panel.tsx` (portal requests, access log, retention policy, archive, routing decisions) and the client page `app/(client)/portal/[projectId]/handover/`. All typechecked, linted, unit-tested; **none rendered or clicked in a browser, and the panel and the portal link are not yet mounted on a page** (docs/phase-7-manual-actions.md P7-M016) |
| P7-EVT-01 | 01 §14, I23 | Idempotent events and jobs | EXISTS | event types declared; `open_phase_seven` once; replay-safe doors (T012); runner handlers `openPhaseSeven`, `runDeployment` |
| P7-E2E-01 | 01 §19, I24 | The mandatory end-to-end scenario | EXISTS (SQL) | `scripts/verify-phase-seven.sql`; the deployment itself is simulated by service-role door calls |
| P7-TEST-01 | 01 §18 | T001–T012 | EXISTS | T001 §1; T002 §2/§7; T003 §4; T004 §7; T005 §6; T006 §5; T007 §8; T008 §8; T009 §9; T010 §4; T011 §9 (classified as a Change Request route; the CR record itself is created through the existing change-request surface); T012 §12 |
| P7-NEG-01 | 01 §20 | Negative / recovery scenarios | PARTIAL | worker crash, duplicate events, migration/secret/monitoring failures, rollback failure paths, duplicate alerts, client-delayed acceptance: covered by idempotent doors and refusal states. Cloud timeouts, provider outages and audit-store failure are runtime conditions with no executor to fail (an audit write is in the same transaction as the change, so its failure rolls the change back) |
| P7-SEC-01 | 01 §16 | Least-privilege, secret-safe, auditable, immutable history, tenant isolation | EXISTS | RLS internal-only on all 24 tables, no write grant to `authenticated`, tenancy-guard + frozen org triggers (`core.unguarded_org_fks()` empty), append-only/frozen history, portal client reads nothing |
| P7-P8-01 | 01 §12 | Phase 8 boundary | EXISTS (routing record) / MISSING (workflows) | `p7_handover_feedback` classifies and routes (change request, support/bug, customer success, client action); the frozen completion handoff is now what Phase 8's intake reads (see P7-CS-01); Support, Maintenance and Sales workflows are Phase 8 |

## P702 PM

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-PM-01 | 02 §5 | Task 5 start only after the entry gate | EXISTS | `project.phase_seven_ready` (emitted once by `open_phase_seven`) → `announcePhaseSevenReady` (PM7-M01); says nothing has been deployed (P702-T001/T002) |
| P7-PM-02 | 02 §6, §13 | Truthful deployment updates; never "live" before authoritative state | EXISTS | PM7-DEPLOY-APPROVED ("approval is not deployment"), PM7-VALIDATED, PM7-INCIDENT (no cause, no "verified"); `tests/phase-seven-pm7.test.ts` |
| P7-PM-03 | 02 §8, §13 | Handover invitation, exact version | EXISTS | `project.handover_delivered` → PM7-HANDOVER-READY (keyed by the package version; "looks good is not acceptance") |
| P7-PM-04 | 02 §10 | Completion message only after ProjectCompleted | EXISTS | `project.completed` → PM7-COMPLETE; one per project |
| P7-PM-05 | 02 §6 | Client-safe: no secret, stack trace, model/provider detail | EXISTS | message tests; PM messages carry their template version (`PM_TEMPLATES`) |
| P7-PM-06 | 02 §9 | Feedback classification | PARTIAL | the seven classes and their routes are a deterministic table (`p7_feedback_route`) applied by staff; there is no automatic classifier |
| P7-PM-07 | 02 §7, §12 | Client action requests (DNS, store, account) as an entity with a deadline | EXISTS (record, door, portal) / PARTIAL (no reminder) | Phase 7c `20261112100000`: `p7c_client_action_requests` + append-only events; staff raise (`create_client_action_request`, a deadline in the future, no secret), the client reads its own through `client_action_requests_for_client` and RESOLVES with a note (`resolve_client_action_request`: a CLAIM, status `submitted`), a person CONFIRMS with their own verification or sends it back (`settle_client_action_request`). Overdue is derived and enters the Failure Queue. Verifier §3 (client of another account reads and answers nothing; a client cannot confirm; confirmation needs a verifier at the door AND the table), UI: portal page `actions/`, Admin panel `phase-seven-c-panel.tsx` (not mounted, not rendered). Nothing is sent or chased: the PM does not message the client directly, and a readiness item (P7-READY-01) stays a separate record |
| P7-PM-08 | 02 §14 | Admin panel: PM timeline, delivery, client actions | PARTIAL | PM delivery is in the existing PM messages panel; the Phase 7 panel shows state and feedback |

## P703 Orchestrator

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-ORCH-01 | 03 §7 | Dependency graph: deploy waits for approval/readiness, smoke for deployment, handover for ProductionValidated, completion for acceptance | EXISTS | enforced by the doors themselves; `projects.p7_task_graph` shows it derived from the rows (never a stored flag) |
| P7-ORCH-02 | 03 §5, §6, §8 | Task types, execution envelope, tool authorization, elevated production permissions, bounded retries | EXISTS (rule, recorded) / MANUAL_EXTERNAL (production tools) | `src/modules/orchestrator/phase-seven-route.ts`: eight task types with one owner each, `buildPhaseSevenEnvelope`/`validatePhaseSevenEnvelope` (rejects, never repairs), `authorizePhaseSevenTool` (the registry binding is the ceiling; a production tool also needs an Admin grant), `phaseSevenRetryPolicy` (a deployment side effect is never blindly retried). Decisions are recorded in `projects.p7b_routing_decisions` through the service-role door `record_phase_seven_routing`, which refuses what the rules forbid. The registry now has the three handoff edges `orchestrator -> deployment_agent / release_qa / incident_recovery`. **All three agents stay disabled and hold no tool, so every agent-bound task is HELD with the reason stated**; production tools need credentials (P7-M001, P7-M008). `20261108030000`; verifier 7b-1; `tests/phase-seven-route.test.ts` |
| P7-ORCH-03 | 03 §9 | Failure routing: infra/config → Deployment; code defect → revalidation path | EXISTS | a code defect is refused as a retry (`incident_path_is_not_config_recovery`) and opens a change record; `routePhaseSevenFailure` routes config/provider to the Deployment agent, a rollback to the Incident agent and a code defect to "a new candidate is required" (never a deploy retry) |
| P7-ORCH-04 | 03 §10 | Idempotency: duplicate Phase7Ready / deploy / smoke / completion | EXISTS | verifier §1, §3, §4, §12 |
| P7-ORCH-05 | 03 §11, §14 | Agent run trace, cost, Failure Queue | EXISTS (Failure Queue) / PARTIAL (runs) | every routing decision is recorded with its candidates, envelope and policy version; the existing Phase 5/6 audit and cost recording apply to any agent run, but there are no Phase 7 runs (agents disabled). Phase 7c `20261112200000` `projects.p7_failure_queue`: a DERIVED read (nothing stored) of a failed deployment not followed by another attempt, a failed validation not followed by a pass, an open incident, a deployment approval or handover review that waited past a stated age, and an overdue client action; internal staff of the organization only (a client, another organization and anon read nothing). Verifier §4; page `app/(internal)/operations/phase-seven-failures/page.tsx` and the project panel (not rendered) |
| P7-ORCH-06 | 03 §13 | Phase 7 events as routable work | EXISTS (recorded decision) | `project.deployment_approved`, `project.deployment_failed` and `project.production_validation_failed` run `projects:routePhaseSevenTask`, which records the Orchestrator's decision (held while the agents are disabled). PM and Finance act through their existing event handlers and doors (`event_handled`) |

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
| P7-HO-04 | 07 §9 | Delivery logged; client questions tracked; corrections versioned | EXISTS | delivery records the channel and time; **downloads and access are now logged** (`p7b_handover_access_log`, append-only, written by `log_handover_access` for a client only, for a delivered item only); questions are `p7_handover_feedback` and a portal change request is a request a person settles. `20261108050000`; verifier 7b-2b |
| P7-HO-05 | 07 §10 | Handover defect vs change | EXISTS | route table; a missing agreed item is a correction, a bug goes to support, a feature to a change request |
| P7-HO-06 | 07 §11, §15 | Retention/expiry of sensitive artifacts; historical versions preserved | EXISTS (policy as data) / MANUAL_EXTERNAL (the periods) | versions preserved and immutable; no secret is stored so none expires; retention periods per record class are an Admin-set, versioned policy (`p7b_retention_policies`) and the sweep only marks a class eligible for review. The periods themselves are the owner's to set (P7-M015) |
| P7-HO-07 | 07 §15 | Client cannot see internal notes; no cross-tenant file access | EXISTS | a portal client reads no Phase 7 table; the client-safe functions `client_handover_overview/items/access_receipts` expose only the current DELIVERED version, its READY items and access receipts with no reference value, and answer nothing for another account or tenant (verifier 7b-2b) |
| P7-HO-08 | 07 §13 | Draft package created on ProductionValidated | EXISTS | Phase 7c: the `project.production_validated` subscriber `projects:createDraftHandoverPackage` calls the runner-only `create_draft_handover_package_for_validated`, which re-reads the validation evidence and the M4 gate, builds a DRAFT version 1 from the contract deliverables checklist (six standing items plus one per deliverable; an exclusion is NOT_REQUIRED with its reason) and moves the workspace to HANDOVER_PREPARING. With no checklist it creates nothing and says so; `sweep_draft_handover_packages` creates the draft once a person has recorded one. It never submits, approves or delivers (created_by is null). Verifier §5 |

## P708 Client acceptance and completion

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-ACC-02 | 08 §6 | Acceptance references the exact package version; informal is not acceptance; cannot approve a later version | EXISTS | `package_version`/`commit_ref` stored; `informal_is_not_acceptance`; the gate reads the LATEST decision on the current delivered version (T001, T002) |
| P7-ACC-03 | 08 §6 | "Formal record where required" (configurable) | EXISTS | `phase_seven.client_acceptance_required` (Admin-set, with a reason); an Admin completion exception for exactly this package and commit |
| P7-ACC-04 | 08 §5 | Client review portal and questions | EXISTS | `app/(client)/portal/[projectId]/handover/`: the client reads the delivered version and asks to accept or to change it. **A portal click is not an acceptance** (ADM-08d: the client decides, a person records): it is a REQUEST row (`p7b_portal_requests`) that a person with delivery rights confirms with their own verification (`settle_portal_handover_request`, which calls the existing `record_client_acceptance` with evidence kind `portal_confirmation`) or declines with a reason. The completion gate reads only `p7_client_acceptances`. Not rendered or clicked in a browser |
| P7-COMP-02 | 08 §7 | Completion gate: scope, final QA, production, payment, handover, acceptance, no blocking issue, CS handoff | EXISTS | nine gate rows; scope and acceptance are exceptionable by an Admin; production, payment, handover, QA are not |
| P7-COMP-03 | 08 §8 | Completion record: project, scope, release, QA, finance, production, handover, acceptance, limitations, support, timestamp/owner | EXISTS | `p7_completion_records.payload` |
| P7-COMP-04 | 08 §9 | Completion exceptions: reason, risk, Admin, exact gate/build/package, audit, no silent AI | EXISTS | `approve_completion_exception` (Admin only); append-only; bound to the delivered package and commit (T009) |
| P7-COMP-05 | 08 §10 | Exception states HANDOVER_BLOCKED, CLIENT_ACTION_REQUIRED, DISPUTED | PARTIAL | `client_action_required` is a state (access issue, dispute); HANDOVER_BLOCKED and DISPUTED are not separate states: a blocked handover shows as `handover_preparing`, a dispute is a decision row |
| P7-COMP-06 | 08 §11 | Historical integrity: completion does not delete, versions immutable, future work separate | EXISTS | completed workspace never returns to production work; completion record and intake frozen; a completed project accepts no change/plan door (T011) |
| P7-COMP-07 | 08 §12 | ProjectArchivePreparation | EXISTS | `start_project_archive` (an Admin; needs the frozen completion record and a retention policy for every class), `finish_project_archive`; see P711 |

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
| P7-FIN-01 | 10 §5 | Financial clearance: final payment verified, receipt, zero balance or authorized exception, refund/dispute/chargeback | EXISTS | `p7_financial_clearance` READ from `finance.invoices`/`receipts`/`refunds` and `p7_financial_exceptions`; never a stored flag (T001–T003). **Phase 7b:** it also consults Phase 9: an open BLOCKING `finance.finance_exceptions` row blocks the `no_open_dispute` row, and a project that has a `project_financial_closes` row must read as `finance.project_is_financially_closed`; a project that never met Phase 9 is judged exactly as before (still five rows). `20261108020000`; verifier 7b-3 |
| P7-FIN-02 | 10 §8 | Exceptions: partial balance, refund pending, chargeback, adjustment, waiver | EXISTS | `p7_financial_exceptions`; resolve or waive is an Admin decision; a waiver needs evidence (T004) |
| P7-FIN-03 | 10 §9 | Reversal before completion re-evaluates | EXISTS | clearance is computed on every read (T007; verifier §10) |
| P7-FIN-04 | 10 §6 | Finance does not declare completion | EXISTS | the clearance is one gate row; no finance door touches Phase 7 state |
| P7-FIN-05 | 10 §10 | Final financial close record | EXISTS (read) / PARTIAL (client view) | the close record is Phase 9's `finance.project_financial_closes` (frozen, one per project); Phase 7 reads it through `project_is_financially_closed` and the completion record carries `finance: {status: closed, clearance}`. Phase 7c adds the client-portal statement view (see P7-FIN-06) |
| P7-FIN-06 | 10 §7 | Receipt linked to invoice/payment; client-visible per policy | EXISTS (statement) / PARTIAL (receipt file) | Phase 7c `client_financial_statement`, `_payments` and `_totals` (SECURITY DEFINER, filtered by the caller's own `client_account_id` claim and organization): invoices (no draft, none awaiting approval), the payments a PERSON verified with their receipt number, and what is outstanding (void owes nothing; money recorded but not verified is shown as awaiting verification and is NOT counted as received). Facts only: no trigger, write or amount change; the verifier hashes every invoice and payment before and after. Portal page `statement/`. A receipt as a downloadable document is not built |

## P711 Archive, completion record and Phase 8 handoff

| REQ | Spec | Requirement | Status | Evidence |
|---|---|---|---|---|
| P7-ARC-01 | 11 §7 | Completion certificate / record, immutable | EXISTS (record) / PARTIAL (document) | `p7_completion_records`; no rendered certificate document |
| P7-ARC-02 | 11 §5, §6 | Archive preparation, COMPLETED → ARCHIVING → ARCHIVED | EXISTS | `projects.phase_seven.archive_state` (ARCHIVING, ARCHIVED) and `projects.p7b_archives`, started and finished by an Admin; replay-safe; the policy versions in force are snapshotted. The state is a separate column so the existing "completed project accepts no work" doors (which test `phase_seven.state`) keep refusing. `20261108040000`; verifier 7b-5 |
| P7-ARC-03 | 11 §8 | Retention classes, deletion policy, retention jobs | EXISTS (marking) / NOT BUILT (disposal) | eight record classes with an Admin-set period or "indefinite" (`set_retention_policy`; no default exists, so no policy means no archive); `sweep_retention_reviews` (service role, called on the cron tick) marks a class ELIGIBLE FOR REVIEW and **deletes nothing**. Disposal is a person's decision and no disposal door exists |
| P7-ARC-04 | 11 §9 | Client portal completed / read-only state | EXISTS | `client_completed_state` returns completed/archived, the accepted handover version and the completion date; the portal is open, read-only or expired by the archive's snapshot of the Admin-set portal policy, and the portal write door refuses once read-only (P711-T006) |
| P7-ARC-05 | 11 §10, §11 | Reactivation guard: a completed project cannot silently return to development | EXISTS | the Phase 7 workspace and project status refuse it; once ARCHIVING starts, tasks, modules, features, deliverables and deliverable details of that project refuse insert, update and delete (a trigger keyed on the archive row: a legacy project, and a completed project that is not archived, are untouched) |
| P7-ARC-06 | 11 §12 | LinkedFutureWork | PARTIAL | feedback routes only |
| P7-ARC-07 | 11 §5 | Remove unnecessary secrets | EXISTS (by construction) | no secret is ever stored; nothing to remove |

## Agents

| REQ | Requirement | Status | Evidence |
|---|---|---|---|
| P7-AG-01 | Agents the spec names that did not exist: Deployment, QA/Release, Incident/Recovery | EXISTS (definitions, disabled) | `20261104400000`; `registry.ts` (three inline definitions); mirror pairs match |
| P7-AG-02 | PM, Orchestrator, Finance, Handover, Customer Success reused | EXISTS | no duplicate created |
| P7-AG-03 | Agents run | MISSING / MANUAL_EXTERNAL | disabled; no tool; needs a funded model key and production access |
