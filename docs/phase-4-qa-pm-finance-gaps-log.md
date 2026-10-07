# Phase 4 QA / PM / Finance / Orchestrator gap log (2026-11-26)

Scope: the buildable PARTIAL and MISSING rows of the QA Prototype Validation, PM, Finance and Orchestrator clusters of `docs/phase-4-implementation-traceability.md`. Rows closed there carry `Closed 2026-11-26` and the evidence; this file is the build record, what stays open and why, and the exact wiring still needed in shared files.

## What was built

| Migration (all on a scratch Postgres 16, applied after the 2026-11-24 set) | Live verifier | Red-proofs |
|---|---|---|
| `20261126000000_prototype_qa_is_a_recorded_run_of_named_checks_with_its_own_blockers_and_fix_retest_links.sql` | `scripts/verify-p4q-prototype-qa.sql` | 9 |
| `20261126100000_the_pm_classifies_prototype_feedback_records_exact_shares_and_escalates_in_one_durable_row.sql` | `scripts/verify-p4q-pm.sql` | 8 |
| `20261126200000_the_m2_invoice_keeps_its_baseline_and_instructions_and_a_payment_is_matched_before_a_person_verifies_it.sql` | `scripts/verify-p4q-finance.sql` | 7 |
| `20261126300000_a_phase_four_hop_has_a_persisted_envelope_a_classed_failure_and_one_trace.sql` | `scripts/verify-p4q-orchestrator.sql` | 6 |

Shared by the verifiers: `scripts/p4q-verify-prelude.sql` (`\ir`). Every red-proof mutates the LIVE function definition inside a sub-block that is rolled back, runs a probe that must now fail, and raises if the mutation changed nothing (`RED-PROOF DID NOT RUN`).

New TypeScript, all new files: `src/modules/p4q/{door,qa-handler,feedback-handler,designer-gate,envelope,pm4-templates,queries,actions}.ts`, the page `app/(internal)/projects/[projectId]/p4q/page.tsx`, and `tests/p4q-handlers.test.ts` (29 tests: handler outcome mapping with a fake client, the stub-model feedback proof, the Designer gate, the envelope/failure policy, PM4 template hygiene, catalog drift, house rules).

### QA (prototype validation)
A prototype's QA is now a recorded **run** of named **checks**: smoke, coverage (critical vs other screens, extra screens, blank/placeholder), navigation (broken, unreachable, reviewer trap), interactions (decorative controls, forms without a submit), states, data safety on every string (credential shapes, real-looking contacts, another project's ids), overflow risk, and limitation accuracy. `p4q_run_prototype_qa` records the run, the checks, the defects and the verdict in one transaction, delegating the verdict write to the existing `record_prototype_qa_verdict` (self-review, tenancy and idempotency stay where they were). INVALID_INTAKE and BLOCKED_EXTERNAL are runs + blockers with an owner and a resume condition, never a pass. FIX_READY is a claim tied to an exact fix build; the retest is a QA run of that build; because `qa.defects` refuses `verified` without a named person, an agent run records `retest pass` and leaves the defect at FIX_READY, and a different person verifies it (`p4q_verify_retested_defect`). A verified defect that reappears is raised as a regression. An Admin cannot approve a build QA has not passed (trigger on `deliverable_details.admin_status`).

### PM
Prototype client feedback is classified against the exact build and routed (rebuild only for CORRECTION / INCLUDED_REVISION; clarification, change request, or an escalation otherwise; no active scope opens an escalation instead of vanishing). The Designer redraft is gated on the PM's classification and records its activation reason. Exact UI versions / QA-passed, Admin-approved builds shared with the client are recorded with channel, instructions and delivery state (including `unknown`, and never `sent` without evidence). Agent-raised clarifications are relayed one at a time in client wording and the answer returns to the asking agent. `p4q_escalations` is the single durable escalation row. `p4q_revision_records` is the derived RevisionRequest read.

### Finance
Milestones and invoices keep their commercial baseline; missing baseline or billing data opens a finance clarification instead of a guess. Issued invoices keep a masked payment-instruction snapshot (drift is visible). `p4q_match_payment_submission` persists a deterministic match result and a MATCH/REVIEW/REJECT/EXCEPTION recommendation and **verifies nothing** (live-checked: the submission stays `pending_verification`, nothing is paid). Receipts have a document read and an independent delivery record. Reminders have stages and a schedule; escalation opens an overdue exception. The M2 overview and the consumer-side "no M2 invoice before Phase 4 completes" guard exist.

### Orchestrator
A persisted ExecutionEnvelope (exact references only, "latest" and foreign ids refused; retry budget; idempotency; policy version), classed failures with bounded retry, uncertain side effects reconciled not retried, escalation on exhaustion / permanent / no capable agent, a disabled specialist escalated instead of silently failing, the task taxonomy as data (drift-tested against the event catalog), capability profiles per agent, and one joined trace plus a failure queue.

## What stays open, and why

> **Status 2026-12-02 (round 4, `docs/phase-4-qa-pm-finance-round4-log.md`):** closed since this table was written: P4-QAP-004 (traceability read), 019 (QA_RETEST and DEFERRED), 043 (uploaded evidence), 046 (subscribers: blocked-QA announcement, QA_RETEST), P4-PM-036 (unknown delivery state), P4-FIN-042 / 057 (receipt page with delivery state), P4-FIN-079 (renderers read the issued snapshot, wired 2026-11-30), P4-ORCH-026 (fallback considered and recorded) and P4-ORCH-T11 (agent logs masked). P4-FIN-020 stays PARTIAL on an owner decision (the snapshot is masked by design). The rows below that name these ids are historical.

| Row(s) | Why it stays open |
|---|---|
| P4-QAP-010, 011, 078 | Visual fidelity and rendered layout need a headless browser run or a funded vision model. They are recorded `not_verifiable` (never a pass): MANUAL_EXTERNAL / environment_missing. A structural overflow proxy exists. |
| P4-QAP-012 | The prototype build vocabulary has no role variants; needs a schema extension first. Recorded `not_verifiable`. |
| P4-QAP-004 | CLOSED 2026-12-02: the matrix is read from the upstream records that do exist (scope items, features, screens, designed states). |
| P4-QAP-023 (render smoke) | Needs the app running. 019, 043 and 046 were CLOSED 2026-12-02 (QAStarted is deliberately not an event). |
| P4-PM-010 / ORCH real classification | A model-backed classifier needs a funded model: `handleP4qClassifyPrototypeFeedback` fails as `environment_missing` with no classifier; the keyword stub is only the stub-model proof. |
| P4-PM-005 direct client send | WhatsApp credentials and an owner decision: MANUAL_EXTERNAL. |
| P4-PM-036 | CLOSED 2026-12-02: `crm.conversation_messages` has an `unknown` delivery state. |
| P4-FIN-019 (tax rate constant), 021 (credit notes), 049 (gateway), 072 (credentials) | Owner decisions / provider accounts. |
| P4-FIN-020 / 079 | 079 CLOSED (renderers read the issued snapshot, W-F3). 020 stays PARTIAL: the snapshot is masked, so the exact unmasked instructions at issue are not reproducible; storing them is an owner decision. |
| P4-FIN-042 / 057 | CLOSED 2026-12-02: `/finance/receipts/[receiptId]` renders the document and the delivery state. |
| P4-ORCH-026 | CLOSED 2026-12-02: the fallback for a disabled specialist is considered and recorded (never run) through `p4s_record_agent_fallback`. |
| P4-ORCH-T11 | CLOSED 2026-12-02: `ai.agent_runs` / `ai.agent_steps` are masked by trigger, per string leaf. |
| P4-ORCH-047 | A PostgREST + Next + stub-model E2E needs infrastructure this change did not stand up. |

## Wiring still needed (shared files this change was told not to edit)

> **Status 2026-11-30:** W-Q1, W-P1, W-P2, W-P3, W-P4, W-U1, W-O1, W-O2, W-O3 and W-F1 to W-F6 are wired (W-F3 as a drift-visible reader, not a renderer swap; W-Q2 is optional and not done). Proofs: `tests/p4q-revision-wiring.test.ts`, `p4q-escalation-and-clarification-wiring.test.ts`, `p4q-hop-wiring.test.ts`, `p4q-capability-profile-wiring.test.ts`, `p4q-finance-wiring.test.ts`. W-F3: the PDF, the WhatsApp message and the delivery job print the accounts the invoice was issued with that are still active (the snapshot is masked, so their CURRENT details are printed, and an account closed since issue is never printed; with no snapshot, or none of its accounts still active, the active accounts print as before: `src/modules/finance/p4q-snapshot-accounts.ts`). The invoice page also shows what the client was told at issue, with drift flagged. The email path renders the same PDF.

Everything below is a one-line (or small) edit in a file owned by another builder. Until it is made, the door/handler exists and is proven, but nothing in production calls it. Rows depending on it are tagged `[wiring pending: W-..]`.

- **W-Q1** `app/api/jobs/run/route.ts` ~line 826: `import { handleP4qReviewPrototypeBuild } from '@/modules/p4q/qa-handler';` and pass it instead of `handleReviewPrototypeBuild` to `runEventJobs(admin, PROTOTYPE_QA_JOB_KIND, handleP4qReviewPrototypeBuild, 'runPrototypeQaJobs')`. The job kind (`prototype.qa_review`), event and catalog stay unchanged. INVALID_INTAKE is then automatic; BLOCKED_EXTERNAL needs a caller that knows an external dependency is missing (pass `{ reason, owner, resumeCondition }` as the third argument).
- **W-Q2** (wired 2026-12-02 for `project.p4q_prototype_qa_blocked` and `project.p4q_prototype_fix_ready`; `defect_verified` has no subscriber because nothing reacts to it) `src/lib/events/catalog.ts`: optional subscribers for `project.p4q_prototype_qa_blocked`, `project.p4q_prototype_fix_ready`, `project.p4q_prototype_defect_verified` (the PM announcement for a blocked build).
- **W-P1** `src/lib/events/catalog.ts`: add `'project_manager:classifyPrototypeFeedback'` to `HANDLERS`, `'project_manager:classifyPrototypeFeedback': 'prototype.feedback_classify'` to `HANDLER_JOB_KIND`, and append it to `SUBSCRIPTIONS['project.deliverable_decided']`. `app/api/jobs/run/route.ts`: a `runEventJobs` block calling `handleP4qClassifyPrototypeFeedback(admin, job, classifier)` (classifier = the model-backed one; `keywordFeedbackClassifier` only in a stub environment). `app/api/jobs/run/workflows.ts` `PROTOTYPE_BUILD_REVISE`, deliverable_decided branch (~line 2345): before the model call, `select projects.p4q_prototype_revision_allowed(deliverableId, approval_request_id)` and settle `not_mine` with the routed outcome when false.
- **W-P2** `src/modules/crm/schema.ts`: `...PM4_TEMPLATES,` inside `PM_TEMPLATES` (import from `@/modules/p4q/pm4-templates`); the existing `crm.pm_message_log` writer then records PM4 versions.
- **W-P3** `src/lib/events/catalog.ts`: subscribe a handler to `project.p4q_clarification_answered` that re-runs the work item of the agent named in `payload.raisedBy`; Phase 4 agents call `projects.p4q_raise_clarification` instead of inserting `clarification_requests`.
- **W-P4** `start_phase_four` refusal path (`src/modules/projects`): call `projects.p4q_open_escalation(projectId, 'blocked_requirement', <missing item>)`.
- **W-U1** `app/(internal)/projects/[projectId]/project-subnav.tsx`: a link to `/projects/${projectId}/p4q`; optionally mount the existing `PhaseFourPmState` above the page content.
- **W-O1** `workflows.ts` `ui_designer:reviseUIVersion` (the `project.ui_version_client_decided` path): `const gate = await gateDesignerRevision(admin, { decisionId: <ui_version_client_decisions.id>, priorStatus: <version status> })`; when `!gate.allowed` settle the job (`waiting` -> leave it retryable; otherwise `not_mine` with `gate.reason`) before the model call.
- **W-O2** `app/api/jobs/run/route.ts` / `workflows.ts`: wrap the Phase 4 hops in `runWithEnvelope(admin, { projectId, taskType, exactRefs, idempotencyKey: job.id }, () => <existing handler>)`; task types are in `projects.p4q_task_types`.
- **W-O3** `src/lib/ai/route-plan.ts`: read `projects.p4q_agent_capability_profiles.required_model_capabilities` per agent in `planRoute`.
- **W-F1** after `installLockedPaymentStructure`: `finance.p4q_bind_commercial_baseline(projectId)`.
- **W-F2** where `billingReadiness` returns CONFLICT: `finance.p4q_open_billing_clarification(projectId, missingFields)`.
- **W-F3** `src/modules/finance/pdf-service.ts`, `invoice-delivery.ts`, `whatsapp-send-service.ts`: render from `finance.p4q_invoice_payment_snapshot` instead of the current active accounts.
- **W-F4** on `payment.submitted`: `finance.p4q_match_payment_submission(submissionId)`; show `recommendation` / `reasons` in `verification-packet.tsx`.
- **W-F5** the payment acknowledgement (`projects:updateClientOnPayment`): `finance.p4q_record_receipt_delivery(receiptId, channel, state, evidence)`.
- **W-F6** `reminder-worker.ts`: `finance.p4q_schedule_reminders()` then `finance.p4q_mark_reminder` after each send.

## Honest limits of the evidence

- Verified on a scratch Postgres 16 (not Supabase/PostgREST): the migrations apply, and all four live verifiers pass with their red-proofs. The scratch role is a superuser; the verifiers use `set local session_replication_role` for fixtures exactly like the existing Phase 4 verifiers, and no migration function sets it.
- `scripts/verify-discount-and-payment-structure-local.sql` fails at a `discount_decisions_no_autonomous_agent` check in this scratch database; it does not touch anything these migrations changed, and was not investigated further.
- The page and server actions are typechecked, linted and covered by the static house-rule tests; they were not opened in a browser.
- The deterministic structured-build checks are only as good as the build vocabulary (heading, text, button, link, input, image placeholder, list). State and overflow checks are heuristics by naming and length, documented as such.
- No funded model, WhatsApp provider or Figma access was used or faked.
