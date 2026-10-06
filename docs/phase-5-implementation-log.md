# Phase 5 implementation log

Every unit proven against a real scratch Postgres (`scripts/apply-migrations-locally.sh`); each control red-proven (mangled, watched fail, restored). Chain: `npm run db:verify:phase4`.

## 2026-10-06
- **Defects** (`20261031140000`): `qa.blocking_defects` counted only `open`, so a FIX_READY blocker lifted the release gate; fixed. `fixed_by` stamped; the fixer cannot verify; nobody verifies in another's name; failed retest reopens and clears the claim; `needs_evidence` / `not_reproduced` added (still blocking). `scripts/verify-phase-five-defects.sql`.
- **Workspace + baseline** (`20261031150000`): `projects.phase_five`, `development_baselines` (frozen), `start_phase_five` (Phase 4 complete, M2 verified in full, locked UI, approved prototype, active scope), `start_task` needs the baseline and stamps `tasks.baseline_id`; `invoice.paid` → `projects:startPhaseFive` handler/job.
- **Builds** (`20261031160000`): no production target, unique build number, frozen lineage, exact commit required, independent QA door, Admin door (needs QA pass), shared with the client only via the same gate (no override); Phase 5 DoD needs a locked baseline + client-approved newest build + no unverified blocker/major; `m3_verified_paid`; `phase_readiness(…,6)` needs M3 and treats FIX_READY as unresolved.
- **Reviews** (`20261031170000`): `code_reviews` append-only; self-review refused; HIGH/critical finding cannot pass; stale on a new commit; reviewer who changed code needs a second reviewer; `submit_deliverable` needs a passed review.
- **Feedback** (`20261031180000`): seven categories; BUG/MISSED/UI_MISMATCH → defect; NEW_FEATURE/POSSIBLE_SCOPE_CHANGE → Change Request, a CHECK forbids a defect on them; classification written once.
- **Specialists** (`20261031190000`, registry): eleven agents defined, installed disabled, verified by QA alone; ADM-113.
- **Truth states** (`20261031200000`): integration health (adapter-only `verified`, mock never, evidence required); `phase_five_agent_state` (NOT_REQUIRED keeps its reason; seeded at start).
- **Intake** (`20261031210000`): frozen `phase_five_handoffs` written with the completion fact; `independent_verification_required` always true.
- **E2E**: `scripts/verify-phase-four-e2e.sql` extended through Phase 5 start, builds, reviews, QA, Admin, client approval, feedback, DoD, completion + intake, M3 invoice/underpayment/verification and the Phase 6 financial gate.
- **PM5 messages** (`20261031220000`, `crm/handlers.ts`): Task 3 start, build shared, feedback received (event carries no client words), final build approved; filtered to `kind = 'build'`; internal channel, as PM4.
- **Admin Panel** (`phase-five-queries.ts`, `phase-five-panel.tsx`): read-only Phase 5 Overview wired into the project page; every read guarded (`unreadable`), never "nothing yet" on a failed read.
- **Planning** (`20261031230000`): versioned plans, `check_development_plan`, Admin-only approval, `start_task` needs an approved plan and refuses unsequenced same-file work.
- **Routing** (`20261031240000`, `development-route.ts`): the Orchestrator gets declared routes to the eleven specialists; an approved plan is routed task by task, HELD with the reason while a specialist is disabled or NOT_REQUIRED; creator ≠ validator helper.
- **Build runs** (`20261031250000`): stages, fingerprint, artifact hash, classified failures, bounded transient retries, no secrets; shared builds need a succeeded run on the same commit.
- **Admin forms** (`phase-five-actions.ts`, `phase-five-forms.tsx`): QA verdict, code review, Admin decision, share, record and classify client feedback.
- **Flaky tests, documents, M3** (`20261031260000`, `20261031280000`): flaky tracking that blocks completion; technical documents that cannot exceed evidence; `M3PaymentVerified` recorded once by the runner.
- **Feedback routed** (`20261031270000`): category-only PM message.
- **Envelope + failure handling** (`development-route.ts`): execution envelope on every handoff; retry/fallback/escalate by failure class.
- **Forms** for plans, task planning, integrations, specialist state, flaky tests and documents.

## Not built (see the traceability matrix)
The AI that drafts a plan; Orchestrator model ranking/envelope/tool gating; any specialist actually running (needs a funded model key + repo/CI binding); the build runner that calls `record_build_run`; flaky-test tracking; AI feedback classifier for builds; PM5 revision/change-request/hand-off messages; Admin forms for planning, integrations and specialist state, and a task-graph screen; Documentation agent (the record and rules exist; the agent that derives documents does not); `M3PaymentVerified` event + Phase 6 workspace (Phase 6).
