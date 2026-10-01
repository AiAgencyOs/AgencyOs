# Trace C: line-by-line proof for PDF pages 46 to 63 (SCR-037 to SCR-054)

Source: `AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`, page-marked text `scratchpad/pdf/screen_architecture_fresh.txt`. One row per bullet or line; soft-wrapped continuation lines are merged into their bullet. Evidence was found by reading the named files and, for the rows marked NEW, by building them in this trace (migration `20261008130000`, verifier `npm run db:verify:trace-c`, tests `tests/trace-c-line-by-line.test.ts`). Earlier audits: docs/pdf-gap/C.md; earlier builds: W1, W4, W5, X1, X2 BUILD notes; owner decisions: docs/ui-parity/owner-decisions.md.

Status words: BUILT, DECIDED (owner decision), QUESTION (open, exact question below), NOT-BUILDABLE, NARRATIVE (heading/label/metadata).

## Totals

| status | rows |
|---|---|
| BUILT | 357 |
| DECIDED | 3 |
| QUESTION | 5 |
| NOT-BUILDABLE | 0 |
| NARRATIVE | 200 |
| GAP | 0 |
| total | 565 |

## Gaps this trace found and built

| gap (PDF line) | what was built |
|---|---|
| SCR-041 "Developer cannot decide own work is finally accepted"; "Task completion requires evidence and downstream QA where applicable" | Trigger `projects.require_acceptance_to_finish`: a person moves a task to done only as owner/ops admin/delivery lead, with evidence, and with no open or unverified defect against it. Before: the Board, My Tasks and the task page let member/contractor set any task to done directly. Service roles unchanged. Messages in `src/modules/projects/task-acceptance.ts`, mapped in `setTaskStatus`. |
| SCR-040 "Request missing client dependency through PM" | `projects.request_client_dependency` + `development_events.kind = dependency_requested`; "Ask the PM to request it" on outstanding client dependencies (plan page); listed under "Waiting on the PM" (/development) and acknowledged by the PM (`acknowledge_escalation` generalised). |
| SCR-040 "Acceptance criteria" | Plan deliverables cite the criteria of their approved scope item (queries.ts `scopeItems.acceptanceCriteria`, plan/page.tsx). |
| SCR-038 "Recent feedback", "Feedback must link to the exact version", asset search | "Recent Feedback" card (design-feedback.ts, `listUiVersionFeedback`, `shareId` on client decisions); `?assetQ=` asset search. |
| SCR-042 "Every code artifact should map to project/task" | Commits and pull requests show their task or that they have none, with a summary badge (code-task-mapping.ts). |
| SCR-043 "Secrets ... never displayed in normal project UI" | Credential guard on the Builds screen's free text (build-secrets-guard.ts, 6 services). |
| Checklist "contextual drawers for quick inspection" on SCR-037, 043, 044, 046, 047, 051, 053 | Preview drawer groups Build, Test Run, Bug, Payment added to `entity-preview.ts`; Preview buttons on those rows (Invoice group existed). |

## Open questions

- **Q-C1** (SCR-037 Upload build): should "Upload build" also accept a build file (apk/ipa/zip) under the project-file limits and credentials guard, beside the link and commit already captured?
- **Q-C2** (SCR-038 licensed/private assets): is a per-asset visibility flag wanted now, or only if a client-facing surface will ever show design assets (none does today)?
- **Q-C3** (SCR-041 purpose): should a requirement check and a dependency check be gates before Start Task, and what counts as passing the requirement check?
- **Q-C4** (SCR-042): map commits to tasks automatically by a message/branch convention (`task/<id8>-` branches already embed the id), beyond the display added here?
- **Q-C5** (SCR-044/047): who is "QA" for verifying a defect? Today any role with project.write (owner, ops admin, delivery lead) can verify, including whoever marked it fixed. Limit to owner/ops admin (approval rules put QA with the ops admin) and/or project members with role `qa`?
- **Q-C6** (SCR-046/047): may test-run evidence and bug evidence be uploaded files (screenshots, logs) under the project-file rules, as decision 5 allows for invoice proof and receipts?

## Not verifiable here

- Storage-backed flows (asset upload/replace, folders with stored assets, ZIP file entries, claim proof upload): storage unreachable locally; code paths and fakes only.
- Real GitHub (branches, PRs, checks, findings, merge, workflow dispatch) and real email/WhatsApp sends (invoice send, reminders): no credentials; fakes only.
- Populated states with no local data (plan items, environments, open runs, fixed defects): the source was read; some were rendered with seeded rows in W1/W4/W5.
- Rendered by this trace: the design page Recent Feedback card (project 4b7f18c6). The plan, repository, builds, prototype and QA changes are type-checked, linted and covered by tests and the live verifier, but were not re-screenshotted.

## Rows

| page | the PDF's text | status | where |
|---|---|---|---|
| 46 | DESIGN & PROTOTYPE | NARRATIVE | Domain heading (sidebar module group) |
| 46 | SCR-037 - Prototype Builds & Review | NARRATIVE | Screen title: names the screen traced below |
| 46 | Primary lifecycle: Phase 4 \| Screen baseline number: 37 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 46 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 46 | Manages client-testable prototype builds, QA status, Admin review and client confirmation. | BUILT | `app/(internal)/projects/[projectId]/prototype/page.tsx` + builds/[deliverableId]/page.tsx |
| 46 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 46 | Build version | BUILT | Build column "v{n} — title" (prototype/page.tsx) |
| 46 | Platform/type | BUILT | Platform column and filter; `projects.deliverable_details.platform` (W4 migration 20261006400200) |
| 46 | QA status | BUILT | QA column + "QA Passed" tile (prototype/page.tsx) |
| 46 | Admin status | BUILT | Admin column from `deliverable_details.admin_status` |
| 46 | Client status | BUILT | "Client decision" column |
| 46 | Revision count | BUILT | Revisions column and "n revisions" badge (prototype-queries.ts) |
| 46 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 46 | Build list | BUILT | DataTable in prototype/page.tsx |
| 46 | Build detail | BUILT | `app/(internal)/projects/[projectId]/prototype/builds/[deliverableId]/page.tsx` |
| 46 | Download/open link | BUILT | Artifact link on the build row and the "Build" panel of the detail page |
| 46 | QA evidence | BUILT | "QA Evidence" card on the build detail page; QA evidence block on the Prototype Agent build cards |
| 46 | Admin review | BUILT | "Admin Decision" card (PrototypeAdminForm) |
| 46 | Client feedback | BUILT | "Client Decision" card on the detail page; client feedback block on the agent build cards |
| 46 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 46 | Upload build | QUESTION | A build is recorded with title, link, platform, commit (AddPrototypeForm). QUESTION Q-C1: should "Upload build" also accept a build FILE (apk/ipa/zip, 50 MB project-file limit and credentials guard, as owner decision 5 allows for invoice proof)? Not chosen silently; storage is unreachable locally so it could not be verified. |
| 46 | Submit to QA | BUILT | SubmitToQaButton (agent builds, prototype-panels.tsx) + PrototypeQaForm "QA Passed / QA: Changes Required" (build-panels.tsx) |
| 46 | Admin confirm/edit | BUILT | PrototypeAdminForm (Approve as Admin / Ask for Changes) + BuildDetailsForm "Edit Details" |
| 46 | PM send to client | BUILT | SendPrototypeForm "Send for Client Review" (gated; owner override with reason) |
| 46 | Record client approval/change | BUILT | Client Decision form on the build detail page, recorded through the approval engine with evidence (W4) |
| 46 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 46 | Prototype is not full development | BUILT | Prototype kind is separate from `build` kind; the page copy and the Builds tab keep them apart (prototype/page.tsx vs builds/page.tsx) |
| 46 | Only QA-passed + Admin-approved build is sent to client on the normal path | BUILT | `projects.prototype_send_gate` + `submit_deliverable` refuse; `prototypeSendBlockers` shown; owner override audited. Verifier E (verify-requirements-design-build.mjs) |
| 46 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 46 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `projects.send_prototype_for_client_review`, `decide_prototype_admin`, `record_prototype_qa_check`, `set_deliverable_details` re-check `can_manage_delivery`/owner in SQL; services re-check `project.write`/`project.sign_off` (build-details-service.ts). verify-requirements-design-build.mjs (E) proves refusals. |
| 46 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Each door calls core.record_audit (migration 20261006400200); verifier E reads the audit rows. |
| 46 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/projects/[projectId]/prototype/page.tsx: search, Status, Platform and QA filters. |
| 46 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Quick-view drawer: a Preview button on every build row (entity-preview.ts group "Build", added by this trace); complex work on the dedicated page `app/(internal)/projects/[projectId]/prototype/builds/[deliverableId]/page.tsx`. |
| 46 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 46 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 46 | Confidential \| Page 46 of 83 | NARRATIVE | Running page footer |
| 47 | DESIGN & PROTOTYPE | NARRATIVE | Domain heading (sidebar module group) |
| 47 | SCR-038 - Assets, Brand Kit & Feedback History | NARRATIVE | Screen title: names the screen traced below |
| 47 | Primary lifecycle: Phase 3-5 \| Screen baseline number: 38 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 47 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 47 | Project asset library and design-feedback ledger for logos, fonts references, imagery, icons, brand rules and feedback. | BUILT | `app/(internal)/projects/[projectId]/design/page.tsx` "Design assets" card + `/design/brand` |
| 47 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 47 | Asset categories | BUILT | Per-kind badges "kind · n" on the asset card; Brand Kit tiles (Logos / Icons / Fonts) |
| 47 | Approved vs draft assets | BUILT | "Approved Assets" tile (n draft · n uploaded) |
| 47 | Recent feedback | BUILT | NEW (this trace): "Recent Feedback" card on the design page, last 5 answers from both client-decision ledgers (design-feedback.ts `recentFeedback`, listUiVersionFeedback). Rendered on project 4b7f18c6 (5 rows). |
| 47 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 47 | Brand kit | BUILT | `app/(internal)/projects/[projectId]/design/brand/page.tsx` (logos, icons, fonts, brand rules) |
| 47 | Asset folders | BUILT | One collapsible folder per kind (design/page.tsx); populated state needs an uploaded asset: storage unreachable locally, by code path only |
| 47 | Feedback history | BUILT | `app/(internal)/projects/[projectId]/design/final/page.tsx` "What the client said" + Recent Feedback card |
| 47 | Version links | BUILT | Versions list per asset family and `design_asset_links` to a screen or UI version (LinkAssetForm) |
| 47 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 47 | Upload/replace asset version | BUILT | UploadDesignAssetPanel, and the compact replace panel with `parentAssetId` (storage unreachable locally: code path/tests only) |
| 47 | Mark approved | BUILT | ApproveAssetButton -> `mark_design_asset_approved` |
| 47 | Link asset to screen/version | BUILT | LinkAssetForm/UnlinkAssetForm (asset-link-forms.tsx) |
| 47 | Export handoff package | BUILT | "Handoff package (ZIP)" `/api/projects/[id]/design/assets/export?format=zip` (W4; ZIP writer unit-tested) |
| 47 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 47 | Do not expose licensed/private assets outside project permissions | BUILT | Assets are read under project.read RLS and shown with 5-minute signed links; no client-portal surface reads design assets; licence/rights captured on upload and flagged when missing (`/design/brand`). A per-asset visibility flag is not needed while no client surface shows assets; see Q-C2. |
| 47 | Feedback must link to the exact design/prototype version it refers to | BUILT | Both ledgers name the exact version: a Phase 3 answer carries `share_id` -> the share's snapshot of theme options and versions; a Phase 4 answer carries `ui_version_id`. Recent Feedback shows "Theme “Calm” v1 · share 1" / "UI version 3" (describeDesignRef, tested) |
| 47 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 47 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `record_uploaded_design_asset`, `mark_design_asset_approved`, `add_brand_rule` etc. re-check roles in SQL (W4 migration 20261006400100); verifier D. |
| 47 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Each asset/brand door audits (verifier D reads the rows). |
| 47 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/projects/[projectId]/design/page.tsx: asset search (`?assetQ=`, added by this trace; pure `assetMatches` tested) and screen search. |
| 47 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Design assets open in place (folder `details` with preview and links); dedicated pages for brand kit, screens, themes, final. |
| 47 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 47 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 47 | Confidential \| Page 47 of 83 | NARRATIVE | Running page footer |
| 48 | DEVELOPMENT | NARRATIVE | Domain heading (sidebar module group) |
| 48 | SCR-039 - Development Dashboard | NARRATIVE | Screen title: names the screen traced below |
| 48 | Primary lifecycle: Phase 5 \| Screen baseline number: 39 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 48 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 48 | Operational overview for the full product development phase after client-approved prototype. | BUILT | `app/(internal)/development/page.tsx` |
| 48 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 48 | Implementation plan status | BUILT | Plan column and "Without an active plan" tile |
| 48 | Tasks by state | BUILT | Tasks done / in progress / in review / blocked columns |
| 48 | Dependencies/blockers | BUILT | "Blocked tasks" tile + "Dependencies and blockers" card (blockers-queries.ts) |
| 48 | Build status | BUILT | Latest build column and "Builds recorded" tile |
| 48 | QA handoff status | BUILT | QA handoff column; "Without a test plan" tile |
| 48 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 48 | Workstream progress | BUILT | Modules column on the portfolio; module list with progress on `app/(internal)/projects/[projectId]/development/page.tsx` |
| 48 | Active developer tasks | BUILT | "Active Developer Tasks" card (listActiveDeveloperTasks, W4) |
| 48 | Blockers | BUILT | "Dependencies and blockers" card |
| 48 | Recent commits/builds | BUILT | "Recent commits and builds" card (commits, Git actions, builds) |
| 48 | Upcoming dependency needs | BUILT | Unmet plan dependencies and open technical dependencies listed (project development page); populated only with a plan |
| 48 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 48 | Open plan/task/repository/build | BUILT | "Open" column links Plan, Repository, Builds |
| 48 | Escalate blocker to PM | BUILT | EscalateBlockerPanel -> `projects.escalate_blocker`; "Waiting on the PM" list |
| 48 | Start QA handoff when acceptance criteria are met | BUILT | StartQaHandoffPanel -> `projects.start_qa_handoff` (refuses with the blocked/unfinished counts) |
| 48 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 48 | PM does not split technical work; the Development Planning Agent owns the detailed implementation plan | BUILT | Technical plan is owned by the plan page/Development Planning Agent; PM-side work is escalation and acknowledgement only (no PM-split door exists); the project Development forms need project.write/task.write |
| 48 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 48 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `escalate_blocker` (can_write), `acknowledge_escalation` and `start_qa_handoff` (can_manage_delivery) re-check in SQL; services re-check capabilities (development-events-service.ts). |
| 48 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `task.blocker_escalated`, `task.escalation_acknowledged`, `plan.dependency_requested` audited in the same transaction. |
| 48 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/development/page.tsx: project search and In build / Blocked / No active plan filters. |
| 48 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Project and task detail pages (plan, task, repository, builds) are the inspection surface; the "Waiting on the PM" list acts in place. |
| 48 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 48 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 48 | Confidential \| Page 48 of 83 | NARRATIVE | Running page footer |
| 49 | DEVELOPMENT | NARRATIVE | Domain heading (sidebar module group) |
| 49 | SCR-040 - Implementation Plan | NARRATIVE | Screen title: names the screen traced below |
| 49 | Primary lifecycle: Phase 5 \| Screen baseline number: 40 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 49 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 49 | Extremely detailed Development Planning Agent output: modules, dependencies, acceptance criteria, sequencing and completion checklist. | BUILT | `app/(internal)/projects/[projectId]/plan/page.tsx` (deliverables with layers, order, DoD; copy now states the Phase 2/5 boundary, W4) |
| 49 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 49 | Plan version/status | BUILT | "Plan versions" tile "v{n} is {status}" and version list |
| 49 | Coverage of approved scope | BUILT | "Approved scope covered" tile (included scope items cited by a deliverable) |
| 49 | Client dependencies outstanding | BUILT | "Client Dependencies Outstanding" tile + section |
| 49 | Risk count | BUILT | "Risks" tile |
| 49 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 49 | Modules/features | BUILT | "Modules and features" section |
| 49 | Frontend/backend/database/APIs/integrations/auth/business logic | BUILT | Seven layer badges per deliverable + PlanLayersPanel (`plan_layers`, migration 20261001130000) |
| 49 | Dependencies | BUILT | "Dependencies" register + milestone gates |
| 49 | Execution order | BUILT | "#n" badge, deliverables sorted by `executionOrder` |
| 49 | Acceptance criteria | BUILT | NEW (this trace): each deliverable cites the acceptance criteria of the approved scope item it comes from (or says the item records none); never written in the plan, so nothing is guessed. board.scopeItems now carries `acceptanceCriteria`. |
| 49 | Definition of Done | BUILT | "Definition of done: readiness met, evidence attached, n of m layers done…" per deliverable |
| 49 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 49 | Approve plan internally | BUILT | ApprovePlanForm -> `projects.approve_project_plan`; activation refused without it in the database (trigger, X2) |
| 49 | Create development tasks from plan | BUILT | PlanBreakdownForm (active plan, milestone.write + task.write); not exercised in a browser here |
| 49 | Request missing client dependency through PM | BUILT | NEW (this trace): "Ask the PM to request it" on each outstanding client dependency -> `projects.request_client_dependency` (migration 20261008130000); lands in "Waiting on the PM" on /development; the PM acknowledges. "The PM" = `core.can_manage_delivery()` (also what plan_dependencies_client_items_are_pms already assumes). verify-trace-c.mjs B (14 checks). |
| 49 | Version plan when accepted scope changes | BUILT | "Open the next version" (DraftPlanForm) on an active plan |
| 49 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 49 | Do not confuse with Phase 2 project planning; this is technical implementation planning | BUILT | Page copy states the boundary; Phase 2 blueprint vs Phase 5 layers on the one plan board (W4) |
| 49 | No guessed requirement may enter the plan | BUILT | "Not linked to approved scope — validation will flag it"; deliverables cite scope items by foreign key; plan validator |
| 49 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 49 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `approve_project_plan`, `activate_project_plan` (approval enforced by trigger, owner decision 12), `request_client_dependency` re-check roles in SQL. verify-x2.mjs A, verify-trace-c.mjs B. |
| 49 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `plan.approved`, plan activation, `plan.dependency_requested` and `plan.dependency_request_acknowledged` are audited. |
| 49 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/projects/[projectId]/plan/page.tsx: "Filter deliverables…" (DomainSearch). |
| 49 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Deliverables show their layers and order inline; the plan is a dedicated page. |
| 49 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 49 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 49 | Confidential \| Page 49 of 83 | NARRATIVE | Running page footer |
| 50 | DEVELOPMENT | NARRATIVE | Domain heading (sidebar module group) |
| 50 | SCR-041 - Development Task Execution | NARRATIVE | Screen title: names the screen traced below |
| 50 | Primary lifecycle: Phase 5 \| Screen baseline number: 41 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 50 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 50 | One-task-at-a-time execution surface enforcing requirement check, dependency check, implementation, test, verify, fix and retest. | QUESTION | Q-C3: should a requirement check (the task cites an accepted requirement) and a dependency check (no unmet plan dependency) be GATES before Start? Today the task page shows "Scope it delivers" and "Outstanding dependencies" but `projects.start_task` does not refuse. The rule (what passes a requirement check) is not in the specs. |
| 50 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 50 | Task scope | BUILT | "Task description", "Scope it delivers" cards |
| 50 | Acceptance criteria | BUILT | "Scope it delivers" lists each scope item's criteria ("Accept: …" or "No acceptance criteria recorded"); a task with no feature says nothing points at it |
| 50 | Dependencies | BUILT | "Outstanding dependencies" card |
| 50 | Owner | BUILT | "Assignee" in Task details |
| 50 | Evidence status | BUILT | "Evidence" card + handoff label (task-evidence-queries.ts) |
| 50 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 50 | Checklist | BUILT | TaskCollabPanel checklist with progress |
| 50 | Implementation notes | BUILT | "Implementation Notes" card (W4) |
| 50 | Test evidence | BUILT | "Test evidence (n)" card |
| 50 | Artifacts | BUILT | Attachments in TaskCollabPanel; "Commits (n)" card |
| 50 | Comments | BUILT | TaskCollabPanel comments |
| 50 | Handoff status | BUILT | Handoff badge in Task details (ready for QA / reopened / done) |
| 50 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 50 | Start task, submit evidence, request clarification, mark ready for QA | BUILT | StartTaskButton -> `projects.start_task` |
| 50 | Reopen after QA failure | BUILT | ReopenFromDefectPanel (offered with an open defect) |
| 50 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 50 | Developer cannot decide own work is finally accepted | BUILT | NEW (this trace): trigger `tasks_require_acceptance_to_finish`: a person's move to done is refused unless the role manages delivery (owner, ops admin, delivery lead); member/contractor get "the person who does the work does not accept it". Verifier A. The old gap: the Board/My Tasks could set any task to done directly. |
| 50 | Task completion requires evidence and downstream QA where applicable | BUILT | NEW (this trace): same trigger refuses done without a `task_evidence` row and while a defect raised against the task is open or fixed-but-unverified ("downstream QA where applicable" = a defect exists for the task). Messages mapped in task-acceptance.ts (tested). Service roles/system writers unchanged. |
| 50 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 50 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Task doors `start_task`, `mark_task_ready_for_qa`, `submit_task_evidence`, `reopen_task_from_defect` re-check roles in SQL; NEW trigger `projects.require_acceptance_to_finish` makes a move to done a delivery-role act. verify-trace-c.mjs A (14 checks). |
| 50 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Every task door audits (`task.started`, `task.evidence_submitted`, ...); the done move is audited by `audit_row_change`. |
| 50 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Task-level search lives on the Board/Tasks/My Tasks lists; the task page is a single record. |
| 50 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | The task page is the dedicated workflow page; the Board opens a task drawer; quick view of a Task is also in entity-preview ("Task"). |
| 50 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 50 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 50 | Confidential \| Page 50 of 83 | NARRATIVE | Running page footer |
| 51 | DEVELOPMENT | NARRATIVE | Domain heading (sidebar module group) |
| 51 | SCR-042 - Repository, Branch & Code Review | NARRATIVE | Screen title: names the screen traced below |
| 51 | Primary lifecycle: Phase 5 \| Screen baseline number: 42 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 51 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 51 | Repository governance for branches, commits, code review, permissions and traceability to AgencyOS tasks. | BUILT | `app/(internal)/projects/[projectId]/repository/page.tsx` (+ "Access and Merge Policy" card) |
| 51 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 51 | Repository binding | BUILT | "Repository links" + linked GitHub repo card (github-panel.tsx, `repository_links`) |
| 51 | Branch status | BUILT | Branch count badge + "Branches" list (GitHub; unreachable locally: code path only) |
| 51 | Open reviews | BUILT | "n open PRs" badge and "Open pull requests" list |
| 51 | Failed checks | BUILT | "n failed checks" badge, "Checks on branch" |
| 51 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 51 | Repo list | BUILT | "Repository links" list |
| 51 | Branch detail | BUILT | "Branches" list |
| 51 | Commit history | BUILT | "Latest commits on branch" |
| 51 | Pull/merge review | BUILT | "Open pull requests", Submit review, Approve/reject merge panels |
| 51 | Code-review findings | BUILT | "Code-review findings" (readGithubReviewFindings) |
| 51 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 51 | Create task branch, link commit, submit review, approve/reject merge based on policy | BUILT | CreateTaskBranchPanel -> branch `task/<id8>-<slug>` |
| 51 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 51 | Least privilege for repo access | BUILT | Per-repository access level (read only / branches and reviews / full) enforced by every write door; token permissions per level listed (W4). The org token itself cannot be shrunk by the panel. |
| 51 | Every code artifact should map to project/task and review evidence | BUILT | NEW (this trace): each commit shows its linked task or "not linked to a task", each PR its task (via the panel's `task/<id8>` branches) or "branch is not a task branch", and a badge "m/n commits and k/l pull requests map to a task" (code-task-mapping.ts, tested). Auto-mapping by message convention remains Q-C4. |
| 51 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 51 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Git write doors (`git-write-service.ts`) check `project.write` + the per-repository access level (`accessRefusal`) + merge policy; `set_repository_policy` is owner/ops admin. tests/git-is-written-by-a-door.test.ts. |
| 51 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Every Git write is a `projects.git_actions` row and audited; policy changes audited. |
| 51 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/projects/[projectId]/repository/page.tsx: "Search commits, branches and pull requests…". |
| 51 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Live panels expand in place; PR/commit rows link to GitHub; this is a dedicated tab. |
| 51 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 51 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 51 | Confidential \| Page 51 of 83 | NARRATIVE | Running page footer |
| 52 | DEVELOPMENT | NARRATIVE | Domain heading (sidebar module group) |
| 52 | SCR-043 - Builds, Environments & Dependencies | NARRATIVE | Screen title: names the screen traced below |
| 52 | Primary lifecycle: Phase 5-7 \| Screen baseline number: 43 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 52 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 52 | Build pipeline, environment, database migration, API contract and dependency readiness without exposing secrets. | BUILT | `app/(internal)/projects/[projectId]/builds/page.tsx` |
| 52 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 52 | Latest build | BUILT | "Latest build" tile |
| 52 | Environment readiness | BUILT | "Environments ready" tile + "Environment readiness" matrix |
| 52 | Dependency blockers | BUILT | "Dependency blockers" tile |
| 52 | Migration/API compatibility status | BUILT | "Migration and API Compatibility" tile (W4) |
| 52 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 52 | Build history | BUILT | Build cards with changelog, commit, number, rollback |
| 52 | Environment matrix | BUILT | "Environment readiness" table per environment (checks ok/fail/unrecorded); populated state needs an environment: seeded in W4/X2 renders |
| 52 | Dependency list | BUILT | "Dependencies" list with Mark supplied |
| 52 | API contracts | BUILT | `api_contract` readiness check per environment (hand-recorded or workflow-recorded) |
| 52 | DB migrations | BUILT | `migrations` readiness check per environment |
| 52 | External service configuration | BUILT | `external_config` readiness check per environment |
| 52 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 52 | Trigger/record build | BUILT | TriggerBuildPanel (records; dispatches a workflow when the repository names one) + AddBuildForm |
| 52 | Promote build after gates | BUILT | PromoteBuildPanel -> `projects.promote_build` (every check ok, no red release gate) |
| 52 | Mark dependency supplied | BUILT | dependency-status-form.tsx -> `set_dependency_status` |
| 52 | Run contract/migration checks | BUILT | RunChecksPanel dispatches a GitHub workflow and records the result (owner decision 13, X2; fake GitHub in tests/x2-environment-checks.test.ts; real GitHub not reachable locally); hand-recording stays |
| 52 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 52 | Secrets are referenced by secure vault, never displayed in normal project UI | BUILT | NEW (this trace): free text on this screen (build title/changelog/known issues/link, commit ref, build number, rollback note, environment label/address/notes, dependency name/version/reference/notes, check evidence link and note, dependency note, build-trigger note) is refused when it contains a recognisable credential, naming the field and pointing to Settings › Keys & secrets (build-secrets-guard.ts, wired in 6 services, tested). Does not claim to find every secret. |
| 52 | Build reproducibility and rollback information must be retained | BUILT | Commit/ref, build number, rollback target and note per build; warnings when missing (W4 F) |
| 52 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 52 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `record_environment_check`, `promote_build` (gated), `set_dependency_status`, `record_check_dispatch` re-check `can_manage_delivery`; services `project.write`. verify-x2.mjs D, verify-requirements-design-build.mjs F. |
| 52 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `environment.checks_dispatched/result_recorded`, build promotion, dependency status changes audited. |
| 52 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/projects/[projectId]/builds/page.tsx: build and dependency search + status filters. |
| 52 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Quick-view drawer: Preview button on every build card (group "Build"); environments/dependencies are inline panels. |
| 52 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 52 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 52 | Confidential \| Page 52 of 83 | NARRATIVE | Running page footer |
| 53 | QA & RELEASE | NARRATIVE | Domain heading (sidebar module group) |
| 53 | SCR-044 - QA Dashboard | NARRATIVE | Screen title: names the screen traced below |
| 53 | Primary lifecycle: Phase 4-7 \| Screen baseline number: 44 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 53 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 53 | Central Master QA workspace coordinating design/prototype QA, development QA and final Master QA. | BUILT | `app/(internal)/qa/page.tsx` "QA & Testing" |
| 53 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 53 | Test coverage | BUILT | Runs/Passed/Failed tiles and "Coverage matrix" |
| 53 | Open defects by severity | BUILT | "Open defects" tile + "Defects by severity" card |
| 53 | Retest queue | BUILT | "Retest queue (n)" card |
| 53 | Regression status | BUILT | "Test suites" card (regression, compatibility, performance pass rates) |
| 53 | Readiness status | BUILT | Coverage matrix Ready/RC/held columns |
| 53 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 53 | Coverage matrix | BUILT | "Coverage matrix" per project by category (populated only with plan items; local data has 1 plan) |
| 53 | Recent runs | BUILT | "Test Runs" card |
| 53 | Critical blockers | BUILT | "Open blockers" tile + "Most severe open" |
| 53 | Bug trend | BUILT | "Bug trend" chart (12 weeks) |
| 53 | Release candidate | BUILT | RC column in the coverage matrix (`listReleaseCandidates`) |
| 53 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 53 | Open test run/bug/build | BUILT | Run, bug and build links on each row |
| 53 | Assign retest | BUILT | AssignRetestForm on the retest queue -> `qa.assign_retest`; populated state needs a fixed defect |
| 53 | Block release | BUILT | "Block a release" (BlockReleaseFromDashboard) -> release hold |
| 53 | Generate QA evidence summary | BUILT | "QA evidence summary" card; per-project evidence CSV on each project QA page |
| 53 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 53 | A developer fix is not resolved until QA verifies it | BUILT | Defect states open->fixed->verified; "Awaiting retest" counts fixed-not-verified; release gate counts unverified fixes (release/page.tsx). Who counts as QA is Q-C5. |
| 53 | No unresolved critical/major issue at final pass | BUILT | `qa.release_gates` / `mark_production_ready` refuse open blocker/major defects (verify-release-gates.mjs) |
| 53 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 53 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `assign_retest`, `block_release`/hold doors, `record_test_run` re-check roles in SQL (W5 migration 20261006500000); services `project.write`. |
| 53 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Run, defect, hold and retest doors audit; tests/a-bug-has-a-page.test.ts, verify-w5-qa-release-comms.mjs. |
| 53 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/qa/page.tsx: bug search ("Search bug title or environment…"), device filter; runs are filtered on the project page. |
| 53 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Quick-view drawer: Preview on every open bug and recent run ("Bug", "Test Run" groups); full pages for bug and run. |
| 53 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 53 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 53 | Confidential \| Page 53 of 83 | NARRATIVE | Running page footer |
| 54 | QA & RELEASE | NARRATIVE | Domain heading (sidebar module group) |
| 54 | SCR-045 - Test Plan & Cases | NARRATIVE | Screen title: names the screen traced below |
| 54 | Primary lifecycle: Phase 4-6 \| Screen baseline number: 45 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 54 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 54 | Structured QA plan covering UI, functional, API, backend, database, integrations, auth, E2E, negative, compatibility, performance and security. | BUILT | `app/(internal)/projects/[projectId]/qa/page.tsx` test plan section (11 categories) |
| 54 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 54 | Coverage by category | BUILT | Per-suite table planned/executed/pass/fail by category |
| 54 | Planned/executed/pass/fail counts | BUILT | Same table |
| 54 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 54 | Test plan versions | BUILT | "Plan versions" list (qa.test_plans versions) |
| 54 | Test case list | BUILT | Case list with search and category filter, Remove/Edit (case-edit-panel.tsx, W5) |
| 54 | Preconditions | BUILT | Preconditions field on add/edit and shown in CaseDetails |
| 54 | Steps | BUILT | Steps field shown in CaseDetails |
| 54 | Expected result | BUILT | Expected result field shown in CaseDetails |
| 54 | Linked requirement/task | BUILT | Scope-item (requirement) link on every case; LinkTaskForm links a task (`qa.link_test_case_task`) |
| 54 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 54 | Create/import test case | BUILT | Add-to-plan form + CSV/JSON import (test-case-import-panel.tsx) |
| 54 | Assign suite | BUILT | A case's category IS its suite: the 11 plan categories and the run suites share one vocabulary (TEST_RUN_SUITES); changed by the case edit form (`update_test_plan_item`); runs of that suite report its cases (case-results-panel.tsx) |
| 54 | Link requirement | BUILT | Scope-item picker on add; "Requirement coverage" list with waive/restore |
| 54 | Approve plan | BUILT | Approve button when the plan has items (`qa.approve_test_plan`); populated state needs items |
| 54 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 54 | Every accepted requirement should have appropriate test coverage or explicit rationale | BUILT | "Requirement coverage" lists included requirements without a case; waive with written rationale (W5) |
| 54 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 54 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `add_test_plan_item`, `update_test_plan_item`, `approve_test_plan`, `waive_test_coverage` re-check roles; refused on an approved plan (W5). |
| 54 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Plan and case doors audit. |
| 54 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/projects/[projectId]/qa/page.tsx: test-case search + category filter (case-edit-panel.tsx). |
| 54 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Cases expand in place (CaseDetails); the plan is a dedicated page section. |
| 54 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 54 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 54 | Confidential \| Page 54 of 83 | NARRATIVE | Running page footer |
| 55 | QA & RELEASE | NARRATIVE | Domain heading (sidebar module group) |
| 55 | SCR-046 - Test Runs | NARRATIVE | Screen title: names the screen traced below |
| 55 | Primary lifecycle: Phase 4-7 \| Screen baseline number: 46 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 55 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 55 | Execution evidence for manual/automated test runs against a specific build/environment. | BUILT | `app/(internal)/projects/[projectId]/qa/runs/[runId]/page.tsx` |
| 55 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 55 | Build/environment | BUILT | "Where and who" card: Build, Environment (`test_runs.environment`, W5) |
| 55 | Pass/fail/blocked counts | BUILT | "Result" card and run rows |
| 55 | Tester | BUILT | Tester row (`tester_id`, W5) |
| 55 | Start/end time | BUILT | started/ended on run rows and run page |
| 55 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 55 | Run summary | BUILT | "Result" card |
| 55 | Case results | BUILT | "Case results" card (case-results-panel.tsx); needs plan items |
| 55 | Screenshots/logs | QUESTION | Evidence list accepts a link or a note (`qa.test_run_evidence`, append-only). Q-C6: may test-run evidence and bug evidence also be uploaded files (screenshots, logs) under the project-file rules, as decision 5 allows for invoice proof? Not chosen silently; storage unreachable locally. |
| 55 | Defects created | BUILT | "Defects from this run" card |
| 55 | Retest history | BUILT | "Retest history" card (reruns and the run repeated) |
| 55 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 55 | Execute/record result | BUILT | OpenRunForm / CloseRunForm / record_test_run |
| 55 | Create defect | BUILT | "Raise a defect from this run" form |
| 55 | Rerun failed cases | BUILT | RerunButton -> `qa.rerun_test_run` |
| 55 | Close run when complete | BUILT | CloseRunForm (open runs); populated state needs an open run |
| 55 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 55 | Test evidence must identify build/version and environment | BUILT | Run row/page show build version, environment, device; build is mandatory (`refuse_non_build_test_run`) |
| 55 | Failed tests cannot be hidden by aggregate score | BUILT | Counts shown per outcome; failures/blocked never folded into a score (no readiness score; qa-gate.test.ts) |
| 55 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 55 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `open_test_run`, `close_test_run`, `record_test_run`, `rerun_test_run`, `add_run_evidence` re-check roles; closed runs are immutable (`refuse_test_run_rewrite`). |
| 55 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Run doors audit; evidence is append-only. |
| 55 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/projects/[projectId]/qa/page.tsx: run filter chips by status and suite. |
| 55 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Quick-view drawer: Preview on every run (group "Test Run"); dedicated page `app/(internal)/projects/[projectId]/qa/runs/[runId]/page.tsx`. |
| 55 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 55 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 55 | Confidential \| Page 55 of 83 | NARRATIVE | Running page footer |
| 56 | QA & RELEASE | NARRATIVE | Domain heading (sidebar module group) |
| 56 | SCR-047 - Bugs & Defects | NARRATIVE | Screen title: names the screen traced below |
| 56 | Primary lifecycle: Phase 4-8 \| Screen baseline number: 47 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 56 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 56 | Defect lifecycle manager with severity, reproduction, ownership, fix, retest and regression evidence. | BUILT | `app/(internal)/projects/[projectId]/qa/bugs/[defectId]/page.tsx` + qa-insights.tsx |
| 56 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 56 | Open defects by severity | BUILT | Severity tiles/filters (qa-insights.tsx) |
| 56 | Awaiting developer | BUILT | "Awaiting developer" tile (status open) |
| 56 | Awaiting retest | BUILT | "Awaiting retest" tile (status fixed) |
| 56 | Reopened | BUILT | "Reopened" tile (audit `defect.open` after fixed) |
| 56 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 56 | Bug list | BUILT | Defect register with filters |
| 56 | Bug detail | BUILT | Bug page |
| 56 | Reproduction steps | BUILT | "Reproduction" card (steps, expected, actual) |
| 56 | Evidence | QUESTION | Evidence is a link or a note (append-only list). File upload: Q-C6 (same question as run evidence). |
| 56 | Linked task/build | BUILT | "Linked task" and "Linked build" rows (`link_defect_build`) |
| 56 | Fix/retest history | BUILT | "Fix / retest history" timeline |
| 56 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 56 | Assign developer, change severity with reason, submit fix, QA verify/reopen/close | BUILT | DefectTriageForm (assign developer, change severity with a mandatory reason, submit fix) and SettleDefectForm (fixed, verified, reopen, wontfix); who may verify is Q-C5 |
| 56 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 56 | Only QA can mark verified resolution on the governed path | QUESTION | Q-C5: the verify transition needs `project.write` (owner, ops admin, delivery lead); the roles have no QA role and the approval rules put QA with the ops admin. Should verification be limited to owner/ops admin (and/or a project member whose project role is `qa`), and may the person who marked it fixed verify it? Not chosen silently. |
| 56 | Critical/major unresolved defects block final readiness | BUILT | `qa.release_gates` refuse production-ready with open blocker/major; `blocksDelivery` (qa-gate.test.ts) |
| 56 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 56 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `defects_write` RLS (can_manage_delivery), `link_defect_build`, `add_defect_evidence`, triage doors; status moves guarded by `qa.defects_guard`. |
| 56 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Defect doors audit (history trail on the bug page). |
| 56 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/qa/page.tsx bug search; project QA defect list severity/status filters (qa-insights.tsx). |
| 56 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Quick-view drawer: Preview on every bug row (group "Bug"); dedicated page `app/(internal)/projects/[projectId]/qa/bugs/[defectId]/page.tsx`. |
| 56 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 56 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 56 | Confidential \| Page 56 of 83 | NARRATIVE | Running page footer |
| 57 | QA & RELEASE | NARRATIVE | Domain heading (sidebar module group) |
| 57 | SCR-048 - Regression, Compatibility & Performance | NARRATIVE | Screen title: names the screen traced below |
| 57 | Primary lifecycle: Phase 5-7 \| Screen baseline number: 48 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 57 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 57 | Specialized validation for regression suites, responsive/device coverage, browser/OS combinations and performance/stability. | BUILT | `/qa` "Test suites", "Device × Browser", "Performance notes"; project QA budgets/incidents/schedules |
| 57 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 57 | Regression pass rate | BUILT | Per-suite pass-rate bars ("Test suites" card) |
| 57 | Device/browser matrix | BUILT | "Device × Browser" matrix + device tiles (W5) |
| 57 | Performance budgets | BUILT | "Performance budgets" card (BudgetForm, budget-comparison.ts) |
| 57 | Stability incidents | BUILT | "Stability incidents (n open)" card |
| 57 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 57 | Regression runs | BUILT | Run list filtered by suite=regression (project QA) |
| 57 | Compatibility matrix | BUILT | "Device × Browser" matrix |
| 57 | Performance results | BUILT | Performance notes + metrics attached to runs read against budgets |
| 57 | Load/stability notes | BUILT | Run `perf_notes`; stability incidents |
| 57 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 57 | Schedule suite, compare baseline, attach metrics, create defect from regression | BUILT | ScheduleSuiteForm / "Scheduled suites" (cron, worker opens a run) |
| 57 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 57 | Results must be dated and tied to the tested build | BUILT | Every run shows started/ended/recorded times and its build version |
| 57 | Unsupported devices/configurations must be explicitly recorded | BUILT | `qa.device_configurations` with mandatory reason; matrix cells say Unsupported (W5) |
| 57 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 57 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `add_device_configuration`, `set_device_support`, performance/incident/schedule doors re-check roles (W5/F migrations). |
| 57 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Doors audit. |
| 57 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Suite filter chips on runs (project QA); device filter on /qa. |
| 57 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Cards on /qa and project QA expand in place; run detail page for any run. |
| 57 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 57 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 57 | Confidential \| Page 57 of 83 | NARRATIVE | Running page footer |
| 58 | QA & RELEASE | NARRATIVE | Domain heading (sidebar module group) |
| 58 | SCR-049 - Production Readiness & Release Candidate | NARRATIVE | Screen title: names the screen traced below |
| 58 | Primary lifecycle: Phase 6-7 \| Screen baseline number: 49 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 58 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 58 | Final evidence-based release gate before production deployment and post-deployment smoke verification. | BUILT | `app/(internal)/projects/[projectId]/release/page.tsx` ("Decision": what mark_production_ready would answer now) |
| 58 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 58 | Readiness checks | BUILT | "Release checklist" (10 gates) + "Gate" tile |
| 58 | Release candidate version | BUILT | "Release candidate" tile and card (latest client-approved build) |
| 58 | Unresolved blockers | BUILT | "Open blockers" tile |
| 58 | Rollback readiness | BUILT | "Rollback readiness" tile (`projects.release_records`, W5) |
| 58 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 58 | Hard gate checklist | BUILT | "Release checklist" |
| 58 | Security/performance/QA summary | BUILT | "Security summary", "Performance summary", "Tests on RC" tile |
| 58 | Deployment dependencies | BUILT | "Deployment dependencies" (deployment-deps-panel.tsx, on the release record, no handover needed) |
| 58 | Rollback plan | BUILT | "Rollback plan" card |
| 58 | Post-deploy smoke checklist | BUILT | "Smoke checklist (n/m)" card |
| 58 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 58 | Approve release candidate when all hard gates pass | BUILT | Sign-off button (ReleasePanel) enabled by the gate decision |
| 58 | Block deployment | BUILT | "Release hold" panel |
| 58 | Record post-deploy verification | BUILT | "Post-deploy verification" card (`projects.release_verifications`, W5) |
| 58 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 58 | Production readiness is evidence, not a self-reported score | BUILT | Gates read stored rows; no score anywhere (qa-gate.test.ts, no readiness score) |
| 58 | Phase 7 also requires final 20% payment verified before launch | DECIDED | Decision F1 (docs/AGENCYOS_ADMIN_BUCKET_F_PLAN.md): launch gated on the verified final payment, owner override with a reason, audited; "Payment gate" panel (release-payment-panel.tsx) |
| 58 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 58 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `mark_production_ready` (sign_off roles), `hold/lift release`, `override payment gate` (owner only, reason), release record doors re-check roles in SQL. a-release-is-paid-for.test.ts, verify-release-gates.mjs. |
| 58 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `release.payment_overridden`, hold/lift, sign-off, release records audited. |
| 58 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | NARRATIVE | The release checklist is a fixed list of 10 gates (no search needed); post-deploy verifications are a short dated list. |
| 58 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Inline panels; dedicated page `app/(internal)/projects/[projectId]/release/page.tsx`. |
| 58 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 58 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 58 | Confidential \| Page 58 of 83 | NARRATIVE | Running page footer |
| 59 | FINANCE | NARRATIVE | Domain heading (sidebar module group) |
| 59 | SCR-050 - Finance Overview | NARRATIVE | Screen title: names the screen traced below |
| 59 | Primary lifecycle: Phase 2-8 \| Screen baseline number: 50 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 59 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 59 | Cross-project finance command center for invoiced, received, outstanding, expenses and profitability. | BUILT | `app/(internal)/finance/page.tsx` |
| 59 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 59 | Total invoiced/received/outstanding/expenses/net profit | BUILT | Total Invoiced / Total Received / Outstanding / Total Expenses / Net Profit tiles (one verified basis, W1) |
| 59 | Collection rate | BUILT | Caption on Total Received ("n% collected") |
| 59 | Date/client/project filters | BUILT | From/To range + presets, client, project selects (W1) |
| 59 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 59 | Income vs expenses | BUILT | "Income vs Expenses" grouped bar chart |
| 59 | Payment status | BUILT | "Payment Status" card (Paid/Pending/Overdue) |
| 59 | Top project revenue | BUILT | "Top Project Revenue" on the verified basis (unassigned pooled as "No project") |
| 59 | Recent invoices | BUILT | "Recent Invoices" |
| 59 | Recent payments | BUILT | "Recent Payments" |
| 59 | Upcoming payments | BUILT | "Upcoming Payments" |
| 59 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 59 | Create invoice | BUILT | Quick action + "Create invoice" card (from an eligible milestone) + /invoices/new composer |
| 59 | Record payment submission | BUILT | "Record a payment claim" card |
| 59 | Add expense | BUILT | Quick action -> /finance/expenses |
| 59 | Generate report | BUILT | "Generate Report" -> /finance/tax; "Financial Documents" downloads |
| 59 | Open verification queue | BUILT | "Payment Verification" card "Open queue" -> /invoices/verify |
| 59 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 59 | Financial totals use verified records | BUILT | `src/lib/finance/verified-basis.ts`: received = `invoices.verified_minor`; recorded-not-verified shown beside, never inside (W1/X1; tests/finance-verified-basis.test.ts) |
| 59 | Finance Agent generates/tracks; a human Admin verifies payments | BUILT | Only a person verifies: the-verification-gate-has-no-door.test.ts, no-ai-route-verifies-payment.test.ts |
| 59 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 59 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Finance reads need `invoice.read`; `create_composed_invoice`, `verify_payment_claim` re-check roles in SQL; finance sees client names only through `finance.client_names` (decision 7). |
| 59 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Finance doors and report exports are audited (`report_exports`). |
| 59 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/finance/page.tsx: period (all/30/90/365 days and custom From/To), client and project filters. |
| 59 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Summary page; recent rows link to detail pages; invoice/payment quick views via the Preview drawer. |
| 59 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 59 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 59 | Confidential \| Page 59 of 83 | NARRATIVE | Running page footer |
| 60 | FINANCE | NARRATIVE | Domain heading (sidebar module group) |
| 60 | SCR-051 - Invoices | NARRATIVE | Screen title: names the screen traced below |
| 60 | Primary lifecycle: Phase 2-8 \| Screen baseline number: 51 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 60 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 60 | Invoice registry for milestone invoices, change requests, maintenance renewals, new services and zero-amount maintenance invoices. | BUILT | `app/(internal)/invoices/page.tsx` (InvoiceRegistryTable) |
| 60 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 60 | Draft/issued/paid/overdue/void counts | BUILT | Invoices/Draft/Issued/Paid/Unpaid/Overdue tiles; void counted in the Overdue caption |
| 60 | GST/Non-GST filters | BUILT | "GST and non-GST / With GST / Without GST" select |
| 60 | Client/project/milestone filters | BUILT | Client, Project, Milestone selects |
| 60 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 60 | Invoice table | BUILT | DataTable with Type, Status, Milestone, Last sent, Reminders, Total, Verified, Issued, Due |
| 60 | PDF preview | BUILT | Row "Preview PDF" -> inline iframe on the invoice (`#pdf-preview`, W1) |
| 60 | Delivery status | BUILT | "Last sent" column + "needs reminder" badge |
| 60 | Linked milestone | BUILT | Milestone column |
| 60 | Reminder history | BUILT | ReminderHistoryButton drawer |
| 60 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 60 | Create from eligible milestone | BUILT | "Create from a milestone" form + /invoices/new |
| 60 | Send by email + official project WhatsApp | BUILT | Email and WhatsApp send panels on the invoice (email-send-panel.tsx, whatsapp-send-panel.tsx); the row menu links "Send or resend". Live delivery needs RESEND/SMTP and WhatsApp credentials that cannot exist locally: verified against fakes only. |
| 60 | Download PDF | BUILT | Row menu "Download PDF" -> `/api/invoices/[id]/pdf` |
| 60 | Issue reminder | BUILT | Row menu "Issue a reminder" -> reminders section (record, and send when email/WhatsApp are configured); live send not testable locally |
| 60 | Void through permissioned flow | BUILT | Row menu "Void…" (invoice.* roles) -> reason-required void flow (invoice-void.test.ts) |
| 60 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 60 | Phase 2 M1 is 30% | DECIDED | Owner decision round 2 #2: 30/20/30/20 on Phases 2, 4, 5, 6 is the pre-filled default (X2, migration 20261007200200) |
| 60 | Phase 4 complete triggers 20%, Phase 5 complete triggers 30%, Phase 6 complete triggers 20% | DECIDED | Owner decision round 2 #2 (same default structure; milestones released by phase completion) |
| 60 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 60 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `create_composed_invoice`, issue, void and reminder doors re-check `invoice.*` roles in SQL; export route needs the capability. |
| 60 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Invoice send/void/reminder/export audited (`report_exports` for CSV). |
| 60 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/invoices/page.tsx: search, client/project/GST/milestone filters, type and status chips, saved views, sortable columns. |
| 60 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Reminder-history drawer (reminder-history-drawer.tsx) and Preview drawer ("Invoice" group, added to rows by this trace); PDF preview iframe on the invoice page. |
| 60 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 60 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 60 | Confidential \| Page 60 of 83 | NARRATIVE | Running page footer |
| 61 | FINANCE | NARRATIVE | Domain heading (sidebar module group) |
| 61 | SCR-052 - Invoice Detail / Create | NARRATIVE | Screen title: names the screen traced below |
| 61 | Primary lifecycle: Phase 2-8 \| Screen baseline number: 52 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 61 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 61 | Invoice composition and detail surface with tax mode, billing profile, line items, payment instructions and delivery evidence. | BUILT | `app/(internal)/invoices/new/page.tsx` + `[invoiceId]/page.tsx` |
| 61 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 61 | Invoice number/status | BUILT | Header of the invoice page |
| 61 | Billing profile | BUILT | "Billed to" panel (legal name, GSTIN, state, address, confirmed) |
| 61 | GST vs Non-GST | BUILT | "Billing mode" row; composer takes tax mode from the confirmed profile |
| 61 | Issue/due dates | BUILT | Issue date tile (W1) |
| 61 | Linked milestone | BUILT | "Linked milestone" panel |
| 61 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 61 | Line items | BUILT | Line items table; composer lines |
| 61 | Tax calculation | BUILT | CGST/SGST or IGST by place of supply with a stated reason for zero tax (W1, `splitTax`) |
| 61 | Payment account | BUILT | "Pay into" (account number masked, reveal for invoice.issue) |
| 61 | PDF preview | BUILT | "PDF preview of {number}" iframe |
| 61 | Send history | BUILT | Sends/reminders sections |
| 61 | Payment submissions | BUILT | "Payment claims" section |
| 61 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 61 | Generate, review, issue, resend, download, attach client proof | BUILT | Composer (generate), review step (composer-review.tsx), "Review before issuing" checklist, Issue; Download = PDF link; Resend = send panels (live send credentials not available locally); "attach client proof" = payment-claim proof as a link or an uploaded file (owner decision 5, X1; fakes only) |
| 61 | Update billing details only through controlled profile change | BUILT | "Change billing details (a new confirmed version)" link to the project billing section (W1) |
| 61 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 61 | Locked flow assumes configured 18% GST on GST invoices and no 18% GST on Non-GST path unless user changes policy | BUILT | GST rate and mode come from the billing profile and GST setup (X1 `gst_*` settings); 18% default in the composer/tax split; Non-GST path charges none (tax-configures-gst test) |
| 61 | Never expose secret payment/account credentials beyond intended display fields | BUILT | Account number masked with reveal for `invoice.issue`; PDF to client unchanged (W1) |
| 61 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 61 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Composer/issue/void/refund doors re-check `invoice.create`/`invoice.issue`/`refund.issue` in SQL; account number reveal only for `invoice.issue`. |
| 61 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Every invoice door audits; sends are recorded. |
| 61 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | NARRATIVE | Single record; the registry (SCR-051) carries search/filters. |
| 61 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Dedicated page with inline sections (PDF preview, Pay into reveal, Refunds); Preview drawer from the registry. |
| 61 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 61 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 61 | Confidential \| Page 61 of 83 | NARRATIVE | Running page footer |
| 62 | FINANCE | NARRATIVE | Domain heading (sidebar module group) |
| 62 | SCR-053 - Payments | NARRATIVE | Screen title: names the screen traced below |
| 62 | Primary lifecycle: Phase 2-8 \| Screen baseline number: 53 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 62 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 62 | Payment submissions and reconciliation workspace across bank transfer, UPI, Razorpay or other configured methods. | BUILT | `app/(internal)/finance/payments/page.tsx` |
| 62 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 62 | Submitted, pending verification, verified, rejected, unmatched | BUILT | Submitted/Pending/Verified/Rejected/Unmatched tiles |
| 62 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 62 | Payment list | BUILT | Payments DataTable |
| 62 | Payment detail | BUILT | `app/(internal)/finance/payments/[paymentId]/page.tsx` |
| 62 | Proof/evidence | BUILT | "Proof and evidence" on the payment page (claims linked by payment/reference) |
| 62 | Invoice match | BUILT | "Invoice match" panel |
| 62 | Reconciliation notes | BUILT | "Reconciliation notes" + Reconciliation section with bank CSV import |
| 62 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 62 | Record payment proof | BUILT | RecordClaimForm (link or file) |
| 62 | Match to invoice | BUILT | Claim carries the invoice; bank lines matched with ConfirmBankLineMatchForm |
| 62 | Send to verification | BUILT | A claim enters the verification queue on creation (payment page shows "recorded, not verified" with the verify action) |
| 62 | Reject with reason | BUILT | VerifyClaimForm / claim-decision.tsx reject requires a reason; rendered with a seeded claim (W1) |
| 62 | Reconcile | BUILT | Reconciliation panel, close period |
| 62 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 62 | Client proof or Finance detection does not equal verified payment | BUILT | Captured vs verified kept separate everywhere (verified-basis.ts); claims are not payments (a-claim-is-not-a-payment.test.ts) |
| 62 | Only Admin verification opens the progression gate | BUILT | Verification is a human door only (the-verification-gate-has-no-door.test.ts) |
| 62 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 62 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `verify_payment_claim`/`request_payment_evidence`/reconciliation doors re-check roles; finance reads via `invoice.read`. |
| 62 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Verification, rejection and reconciliation audited; verified fields immutable. |
| 62 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/finance/payments/page.tsx: search, status chips, method, verification, client, date filters, CSV export. |
| 62 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Claims drawer (claims-drawer.tsx) and Preview drawer on each payment row (group "Payment", added by this trace); dedicated page /finance/payments/[paymentId]. |
| 62 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 62 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 62 | Confidential \| Page 62 of 83 | NARRATIVE | Running page footer |
| 63 | FINANCE | NARRATIVE | Domain heading (sidebar module group) |
| 63 | SCR-054 - Payment Verification | NARRATIVE | Screen title: names the screen traced below |
| 63 | Primary lifecycle: Phase 2-8 \| Screen baseline number: 54 of 71 | NARRATIVE | Metadata (phase span and baseline number) |
| 63 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 63 | Human-only financial gate queue used to confirm money received before milestone progression. | BUILT | `app/(internal)/invoices/verify/page.tsx` |
| 63 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 63 | Pending verification count | BUILT | "Pending" tile |
| 63 | Amount/client/project/invoice | BUILT | Claim card shows all four with links (W1, seeded claim rendered) |
| 63 | Submitted proof | BUILT | Proof link/image preview or uploaded file via `/api/finance/attachment` |
| 63 | Bank/gateway reference | BUILT | "Reference" + bank-statement cross-check |
| 63 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 63 | Verification queue | BUILT | Claim cards |
| 63 | Evidence preview | BUILT | Inline image preview, links for other types (PDF link-only) |
| 63 | Invoice/project context | BUILT | Invoice totals and still-owed shown inline |
| 63 | Decision history | BUILT | "Decision history" card |
| 63 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 63 | PAYMENT VERIFIED | BUILT | Dedicated "PAYMENT VERIFIED" button (claim-decision.tsx) |
| 63 | REJECT / NEED MORE EVIDENCE | BUILT | Reject, mismatch and "request evidence" (`request_payment_evidence`, status evidence_requested) |
| 63 | Add verification note | BUILT | Labelled note field, meaning per button |
| 63 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 63 | No verified payment = no paid milestone progression | BUILT | Milestone progression reads verified payments only (the-gate tests, verify-payment-verification.mjs) |
| 63 | Verification actor, timestamp and evidence reference are immutable audit data | BUILT | Immutability guard on verified_by/at/evidence/reason once settled; verifier proves an owner cannot rewrite (finance-w1) |
| 63 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 63 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `verify_payment_claim`, `request_payment_evidence` re-check `invoice.issue` roles in SQL; page redirects non-admin roles. |
| 63 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Verification actor/time/evidence frozen by a guard and audited (verify-payment-verification.mjs, finance-w1). |
| 63 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | app/(internal)/invoices/verify/page.tsx: "Client, invoice, reference, amount…" search + status chips. |
| 63 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Each claim card is the inspection surface (amount, client, project, invoice, proof, bank cross-check inline); decision history card. |
| 63 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Shared layout primitives (DataTable collapses to cards at phone width; StatGrid wraps); 390px no horizontal overflow re-checked on the changed routes in earlier streams; desktop-first as the PDF asks. |
| 63 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 63 | Confidential \| Page 63 of 83 | NARRATIVE | Running page footer |
