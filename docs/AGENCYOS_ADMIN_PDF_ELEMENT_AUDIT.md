# AgencyOS Admin Panel — element-level audit against the PDF

Date: 2026-09-30. Source: `AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`
(83 pages, 71 screens), section 6 "Detailed Screen-by-Screen Breakdown"
and sections 1–4 (governance principles, shared components, screen rules).
Method: four independent read-only auditors each took a slice of the
PDF and, for every bullet under "Header / Summary / KPI area", "Main
content and sub-screens" and "Primary actions", looked for the rendered
control or data in `app/(internal)/**` and the door behind it in
`src/modules/**`. BUILT means found on the screen (or on the host screen
the inventory names for a GROUPED row). DECLINED means an owner decision
is on record. Everything else is PARTIAL or MISSING with a one-line
reason. SCR-017 and SCR-061 were checked by the orchestrator.

This document corrects the sentence the gaps doc carried until today
("nothing from the PDF remains unbuilt"). At screen level every numbered
screen exists; at element level it does not hold.

## Totals

| Slice | Elements | BUILT | PARTIAL | MISSING | DECLINED |
|---|---|---|---|---|---|
| Global Control, Sales & CRM, Clients (001–016) | 228 | 158 | 55 | 15 | 0 |
| Clients (017) | 14 | 12 | 1 | 1 | 0 |
| Projects, Requirements, Design, Development (018–043) | 350 | 241 | 73 | 33 | 3 |
| QA & Release, Finance, Communication (044–060) | 225 | 170 | 42 | 12 | 1 |
| Communication (061) | 14 | 13 | 1 | 0 | 0 |
| AI Workforce, Operations, Governance, Integrations, Settings (062–071) | 148 | 113 | 27 | 8 | 0 |
| **All screens** | **979** | **707** | **199** | **69** | **4** |
| Shared rules (sections 1–4) | 38 | 12 shared + 12 per-screen | 10 | 4 | — |

## Global Control (001–004)

| SCR | Element (PDF wording) | Status | What is missing |
|---|---|---|---|
| 001 | Global date range and organization selector | BUILT | `app/(internal)/organization-switcher.tsx` in `app/(internal)/layout.tsx` — shown to a person with more than one active membership; switching is audited (`core.switch_organization`, `organization.switched`) |
| 001 | Today: meetings, due items, reminders, payment verifications | BUILT | `app/(internal)/dashboard/page.tsx` Today card — follow-up reminders from `src/lib/admin/dashboard-reminders.ts` |
| 001 | Project health table | BUILT | `app/(internal)/dashboard/page.tsx` Health column, the projects list's own rule in `src/lib/admin/project-health.ts` |
| 001 | Finance gate queue | BUILT | `app/(internal)/dashboard/page.tsx` "Finance gate queue" card — unpaid milestone invoices (`src/lib/admin/finance-gate.ts`) and pending claims |
| 001 | Quick actions: Add lead, Create project, Create invoice, Open approval | BUILT | `app/(internal)/dashboard/quick-actions-row.tsx` — the header's own create forms through `openQuickCreate`, and the queue |
| 001 | KPI click opens the corresponding filtered list | BUILT | `app/(internal)/dashboard/page.tsx` — every tile's href carries its filter (`?createdFrom=`, `?issuedFrom=`, `?status=open`, `?status=on_hold`, `#dead-letters` …); pinned by `tests/a-kpi-opens-its-own-list.test.ts` |
| 001 | Acknowledge/escalate an operational item | BUILT | `app/(internal)/notifications/escalate-form.tsx` on the dashboard feed — recorded through `core.escalate` / `core.acknowledge_escalation` (`src/lib/admin/escalations.ts`) |
| 002 | Result sections grouped by entity type | BUILT | `app/(internal)/search/page.tsx` — one section per type; quotations, meetings and tasks join `src/lib/admin/global-search-page.ts` and `global-search.ts` |
| 002 | Quick preview drawer | BUILT | `app/(internal)/preview-drawer.tsx` (shared by /search and the palette) over `src/lib/admin/entity-preview.ts` |
| 002 | Advanced filter builder | BUILT | `app/(internal)/search/advanced-filters.tsx` — type, owner, status, date |
| 003 | Severity chips: critical, action required, warning, information | BUILT | `app/(internal)/notifications/page.tsx` chips over the severity derived in `app/(internal)/notifications/action-items.ts` (no column) |
| 003 | Notification detail drawer | BUILT | `app/(internal)/notifications/notification-list.tsx` (`NotificationDrawer`) |
| 003 | Escalation destination / Escalate to owner or ops admin | BUILT | `app/(internal)/notifications/escalate-form.tsx` — role, reason and state recorded in `core.escalations`, audited |
| 004 | Create task / Create quotation / Schedule meeting | BUILT | `app/(internal)/palette-forms.tsx` in `command-palette.tsx` — the existing doors (`createTaskAction`, `draftProposalAction`, `requestMeetingAction`) |
| 004 | Create change request | BUILT | `app/(internal)/palette-forms.tsx` (`CreateChangeRequestForm`) through `submitChangeRequestAction` |
| 004 | Context-aware create drawer / Pre-fill client or project | BUILT | `app/(internal)/command-palette.tsx` reads the route's project, lead or client and pre-fills every form (`quick-create-forms.tsx`, `palette-forms.tsx`) |
| 004 | Recent commands | BUILT | `app/(internal)/command-palette.tsx` over `core.recent_commands` (`src/lib/admin/palette-memory.ts`) |
| 004 | Save draft when creation is interrupted | BUILT | `app/(internal)/command-palette.tsx` saves the form's fields on close to `core.create_drafts` and restores them on open (`src/lib/admin/palette-memory.ts`) |

## Sales & CRM (005–013)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 005 | Pipeline value chart | BUILT | `app/(internal)/sales-funnel/page.tsx` (BarChart by stage, one hue, table beneath) |
| 005 | Today tasks / Upcoming meetings / Recent sales activity | BUILT ×3 | `app/(internal)/today-card.tsx` (shared with the dashboard), `src/lib/admin/sales-activity.ts`, `app/(internal)/sales-funnel/page.tsx` |
| 005 | Open lead or quotation from card | BUILT | `app/(internal)/sales-funnel/page.tsx` — cards open the lead; quotations open from the lead's Quotations card (`#quotations`), which the composer's success state also links |
| 005 | Add lead, meeting, follow-up | BUILT | `app/(internal)/sales-funnel/sales-actions.tsx` (quick-create lead; the Lead 360's meeting-request and follow-up forms on a picked lead) |
| 005 | Export filtered pipeline | BUILT | `app/api/sales/pipeline/export/route.ts` (`?source=&owner=`), linked from `sales-funnel/page.tsx` |
| 006 | Search by name, phone, email, company | BUILT | `app/(internal)/leads/page.tsx` (contact email joined in `src/modules/crm/queries.ts` TABLE_SELECT) |
| 006 | Lead preview drawer | BUILT | `app/(internal)/leads/preview-drawer.tsx` + `preview-actions.ts` |
| 006 | Assign owner, update stage, set next follow-up, add tag (bulk) | BUILT | `app/(internal)/leads/bulk-actions-bar.tsx`, `src/modules/crm/bulk-schema.ts` / `bulk-service.ts` (`follow_up` kind → `setLeadFollowUp`) |
| 007 | Current deal stage/value | BUILT | `app/(internal)/leads/[leadId]/page.tsx` (header facts: Deal, Deal value) |
| 007 | Last contact and next follow-up | BUILT | `app/(internal)/leads/[leadId]/page.tsx` (last message on the thread, last client reply; next follow-up in the header figure) |
| 007 | Follow-ups sub-screen | BUILT | `app/(internal)/leads/[leadId]/page.tsx` sequences card, `src/modules/crm/lead-sequence-queries.ts`, shared `follow-ups/sequence-controls.tsx` |
| 007 | Create quotation after requirements are accepted | BUILT | `app/(internal)/leads/[leadId]/page.tsx` (first draft waits for an accepted version and cites it; `quotation-panel.tsx` posts `requirementVersionId`) |
| 008 | AI suggestion vs human decision | BUILT | `app/(internal)/leads/[leadId]/page.tsx` (Computed vs Human decision), `src/modules/crm/lead-score-override-queries.ts` |
| 008 | Approve/override score with reason | BUILT | `crm.override_lead_score` (20261001110000), `src/modules/crm/lead-score-override-service.ts`, `leads/[leadId]/score-panel.tsx` |
| 008 | Return to discovery when evidence is incomplete | BUILT | `crm.leads_guard` + `LEAD_TRANSITIONS.qualified` gain `qualifying` (20261001110000, `src/modules/crm/schema.ts`) |
| 009 | Source transcript references | BUILT | `app/(internal)/leads/[leadId]/page.tsx` (per-message anchors; "read N messages — up to…" and the confirmation message link to them) |
| 009 | User roles / Platforms / Integrations / Timeline-budget notes | BUILT ×4 | `requirementPayloadSchema` (`src/modules/crm/schema.ts`), `leads/[leadId]/requirement-set-panel.tsx`, `requirement-revise-form.tsx` |
| 010 | Link meeting to lead/client/project | BUILT | `crm.meetings.project_id` (20261001110000), `src/modules/crm/meeting-project-*.ts`, `meetings/[meetingId]/project-link-form.tsx`, list badge in `meetings/page.tsx` |
| 011 | Quote count and total value | BUILT | `app/(internal)/quotations/page.tsx` (Total value tile, live value beside) |
| 011 | Status filters / Client-project-service filters / Validity-expiry filters | BUILT ×3 | `app/(internal)/quotations/page.tsx` (superseded chip; `?project=`, `?service=`; `?expired=1`), `src/modules/sales/quotation-project-queries.ts` |
| 011 | Delivery status | BUILT | `src/modules/sales/delivery-status-queries.ts` (derived from the outbound message's receipts), column in `quotations/page.tsx` |
| 012 | Quotation number/date/validity | BUILT | `app/(internal)/quotations/new/composer.tsx` (number derived on save, G-170; date; validity), returned by `composeQuotationAction`, Number column on the list |
| 012 | Terms & conditions | BUILT | `composer.tsx` terms editor → `src/modules/sales/terms-service.ts` (`document.commercialTerms`), printed by `quotation-standards.ts` |
| 012 | Preview PDF | BUILT | `app/api/quotations/preview/route.ts` + `src/modules/sales/preview-service.ts` (same renderer, nothing saved) |
| 013 | Due today, overdue, upcoming, paused, failed | BUILT | `app/(internal)/follow-ups/page.tsx` (five tiles, each opening `?due=`/`?status=`) |
| 013 | Lead/client/project context | BUILT | `src/modules/crm/follow-up-context-queries.ts`, column in `follow-ups/page.tsx` |
| 013 | Reactivation cohort | PARTIAL | Link to Import only — the cohort is the Import desk's own screen; not moved in F-B |
| 013 | Schedule, reschedule, complete, pause, cancel | BUILT | `crm.decide_follow_up_sequence` (20261001110000), `src/modules/crm/follow-up-decision-*.ts`, `follow-ups/sequence-controls.tsx` (schedule = the lead's follow-up form, also on the Sales dashboard) |

## Clients (014–017)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 014 | Total, active, completed, pending, total revenue | BUILT | `app/(internal)/clients/page.tsx` (completed/pending from `src/lib/admin/client-projects.ts`; revenue = paid) |
| 014 | Add/edit client | BUILT | `core.update_client_account` (20261001110000), `src/lib/admin/client-edit.ts`, `clients/client-edit-form.tsx` (list drawer + Settings tab) |
| 015 | Settings tab | BUILT | `app/(internal)/clients/[clientId]/page.tsx` `?tab=settings` (owner, tags, billing edit, assigned team) |
| 015 | Create project | BUILT | `clients/[clientId]/client-360-forms.tsx` `ClientCreateProjectButton` → `CreateProjectForm` (manual door) with the client pre-filled |
| 015 | Schedule meeting | BUILT | `clients/[clientId]/client-360-forms.tsx` `ClientMeetingForm` (the Lead 360's meeting-request form on a client lead) |
| 015 | Upload file | BUILT | `clients/[clientId]/client-360-forms.tsx` `ClientUploadForm` → bucket-E `UploadFileForm` on a project of the client |
| 015 | Edit billing details | BUILT | `clients/client-edit-form.tsx` on the Settings tab (legal name, GSTIN with checksum, PAN, billing address) |
| 015 | Manage assigned team | BUILT | `core.client_account_members` + `core.set_client_account_team` (20261001110000), `src/lib/admin/client-team.ts`, `clients/[clientId]/settings-forms.tsx` |
| 016 | Projects by status / Milestone schedule / Change-request charges | BUILT ×3 | `clients/[clientId]/page.tsx` Projects tab (per-status tiles, dated milestone schedule, `src/lib/admin/client-change-requests.ts` with amounts) |
| 016 | Create new service/project | BUILT | `clients/[clientId]/client-360-forms.tsx` (manual project door, pre-filled) |
| 016 | Start renewal/upsell flow | BUILT | `sales.open_renewal` (20261001110000), `src/modules/sales/renewal-*.ts`, `RenewalForm` on the Projects tab |
| 017 | Recent uploads | BUILT | `src/lib/admin/client-uploads.ts`, Communication tab and Files card in `clients/[clientId]/page.tsx` |
| 017 | Upload/download file | BUILT | `ClientUploadForm` (upload) and the signed download route linked per upload (`/api/projects/[projectId]/files/[fileId]/download`) |

## Projects (018–027)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 018 | Total/active/blocked/completed | BUILT | `app/(internal)/projects/page.tsx` — Blocked tile from `readProjectLifecycles` (blocked task / unmet dependency), opens `?health=blocked` |
| 018 | Phase distribution / Phase filter / Health filter | BUILT ×3 | `app/(internal)/projects/page.tsx` — lifecycle phase tiles (`lifecyclePhaseOf`), `?phase=` and `?health=` filters |
| 018 | Archive completed project | BUILT | `app/(internal)/projects/archive-button.tsx` → `projects.archive_project` (completed only, audited); `?archived=1` shows them |
| 019 | Project links | BUILT | `app/(internal)/projects/[projectId]/links-panel.tsx` — `projects.project_links` |
| 019 | Upcoming events | BUILT | `app/(internal)/projects/[projectId]/page.tsx` — milestones and the deal's meetings, dated ahead |
| 019 | Send project update | BUILT | `app/(internal)/projects/[projectId]/project-update-form.tsx` → `sendProjectUpdate` through `sendClientMessage` (client) or recorded (internal) |
| 019 | Create task/meeting/file | BUILT | `app/(internal)/projects/[projectId]/create-in-place.tsx` (task), `ProposeMeetingOnDayForm`, `AddProjectFileForm` on the overview |
| 020 | Phase/priority/assignee filters | BUILT | `app/(internal)/projects/[projectId]/board/board-client.tsx` — phase = payment milestone filter; assignees from `project_members` with roster fallback |
| 020 | Link evidence | BUILT | `app/(internal)/task-collab-panel.tsx` — `task_attachments.kind` (screenshot, log, url, file) |
| 022 | Create task/milestone/meeting from a day | BUILT | `app/(internal)/projects/[projectId]/calendar/add-milestone-form.tsx` → `projects.add_unpriced_milestone` |
| 022 | Sync supported calendars | BUILT | `app/(internal)/projects/[projectId]/calendar/calendar-feed-panel.tsx` + `app/api/projects/[projectId]/calendar.ics/route.ts` (signed ICS feed) |
| 023 | Total/completed/in-progress/pending | BUILT | `app/(internal)/projects/[projectId]/plan/page.tsx` — Pending tile beside Late |
| 023 | Milestone detail panel / Milestone tasks | BUILT ×2 | `app/(internal)/projects/[projectId]/plan/page.tsx` — `?milestone=` picker, detail panel with its task list (`listTasksByMilestone`) |
| 023 | Open tasks | BUILT | `app/(internal)/projects/[projectId]/plan/page.tsx` — "Open tasks on the Board" → `/board?milestone=` |
| 024 | Total files/storage | BUILT | `app/(internal)/projects/[projectId]/files/page.tsx` — storage used = sum of stored versions' sizes |
| 024 | Folder tree | BUILT | `app/(internal)/projects/[projectId]/files/page.tsx` — `project_files.folder` tree per category |
| 024 | Preview drawer | BUILT | `app/(internal)/projects/[projectId]/files/file-preview-drawer.tsx` — images and PDFs via the signed download route |
| 024 | Rename/move stored files, share internally | BUILT | `app/(internal)/projects/[projectId]/files-panel.tsx` (rename/move with folder, stored files too); internal share list beside the public links in `files/page.tsx` |
| 025 | Active now | BUILT | `app/(internal)/projects/[projectId]/team/page.tsx` — "Active today" and "last active" from the audit log (`readLastActive`); no "online" is claimed |
| 025 | Invite/assign, assign/remove member, set project role, project defaults | BUILT ×4 | `app/(internal)/projects/[projectId]/team/members-panel.tsx` — `projects.project_members` doors; defaults on Settings |
| 026 | Project health | BUILT | `app/(internal)/projects/[projectId]/reports/page.tsx` — `projectHealth` panel, each reason linked |
| 026 | Export PDF | BUILT | `app/api/projects/[projectId]/report/pdf/route.ts` via `src/lib/pdf/project-report.ts` |
| 026 | Open underlying risk/task/event | BUILT | `app/(internal)/projects/[projectId]/reports/page.tsx` — open defects and overdue tasks each link to their row |
| 027 | Template selection on project settings | BUILT | `app/(internal)/projects/[projectId]/settings/template-select-panel.tsx` → `projects.set_project_template` |
| 027 | Project template detail | BUILT | `app/(internal)/projects/[projectId]/settings/page.tsx` — the followed template's modules, milestones, scope, onboarding, tasks |

## Requirements & Scope (028–031)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 028 | Recent requirement changes | BUILT | `app/(internal)/requirements/page.tsx` — `readRecentRequirementChanges` (change requests raised/decided, baselines frozen, plan questions) |
| 028 | Request clarification / Create change request from the dashboard | BUILT ×2 | `app/(internal)/requirements/requirements-doors.tsx` — the Plan/Scope pages' own doors with a project picker |
| 028 | Export scope summary | BUILT | `app/api/requirements/scope-summary/route.ts` (org-wide CSV) and `app/api/projects/[projectId]/scope/export/route.ts` (per project) |
| 029 | Objectives | BUILT | `app/(internal)/leads/[leadId]/requirement-set-panel.tsx` — every objective as a section with its count (`requirementPayloadSchema.objectives`; the revise form and the collector fill it) |
| 029 | User roles / Platforms / Integrations | BUILT ×3 | `app/(internal)/leads/[leadId]/requirement-set-panel.tsx` — three sections from the payload (`userRoles`, `platforms`, `integrations`), each with its count, "none recorded in v<n>" when empty |
| 029 | Business rules / Non-functional requirements | BUILT ×2 | `app/(internal)/leads/[leadId]/requirement-set-panel.tsx` — `businessRules` and `nonFunctionalRequirements` sections; an older version's `constraints` shown under Business rules with the note "recorded as constraints in v<n>" |
| 029 | Request client clarification | BUILT | `app/(internal)/leads/[leadId]/requirement-question-form.tsx` per open question → `crm.send_requirement_question` (through `crm.send_outbound_message`; `crm.requirement_question_sends`; audited `requirement.question_sent`); the whole-version send stays |
| 029 | Link to quotation/design/development task | BUILT | `app/(internal)/leads/[leadId]/requirement-link-form.tsx` → `crm.link_requirement` (`crm.requirement_links`, one row per version and target, audited `requirement.linked`); "Linked to" list beside the derived "Cited by" |
| 030 | Approval evidence | BUILT | `app/(internal)/projects/[projectId]/scope/approval-form.tsx` → `projects.record_scope_approval_evidence` (approved_by/at, evidence url, note) |
| 031 | Paid / in-progress counts | BUILT | `app/(internal)/projects/[projectId]/change-request-panel.tsx` — Paid / In progress / Awaiting payment tiles |
| 031 | Payment gate | BUILT | `app/(internal)/projects/[projectId]/change-request-panel.tsx` — the request's OWN invoice (`change_requests.invoice_id`) |
| 031 | Send quotation | BUILT | `app/(internal)/projects/[projectId]/change-request-panel.tsx` — `sendProposalAction` on the project's client thread |
| 031 | Trigger finance | BUILT | `src/modules/finance/change-request-invoice-service.ts` → `finance.create_change_request_invoice` (milestone-less invoice through `create_milestone_invoice`) |
| 031 | Implement after payment where required | BUILT | `projects.apply_change_request` refuses `not_invoiced` / `unpaid` for a paid change; the Apply button says so first |

## Design & Prototype (032–038)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 032 | Approved count / Design versions list / Prototype links / Upload design / Submit for review | BUILT ×5 | `app/(internal)/projects/[projectId]/design/page.tsx` (tiles; versions with submit; prototype links; `design-asset-panels.tsx` upload into storage) |
| 032 | Recent activity | BUILT | `app/(internal)/projects/[projectId]/design/page.tsx` — ActivityFeed over `projects.read_design_activity` (`src/modules/projects/design-activity-queries.ts`) |
| 033 | Color combinations KPI / Reference uploads | BUILT ×2 | `app/(internal)/projects/[projectId]/design/colors/page.tsx` (StatGrid; reference uploads via `design-asset-panels.tsx`) |
| 033 | Generate/record 2-3 theme directions and 2-3 color variants | BUILT | `app/(internal)/projects/[projectId]/design/colors/direction-panels.tsx` — record doors `projects.record_theme_direction` / `record_color_variant` under the agent's ceiling; generation stays the agent's (no person door), the panel says so |
| 034 | Approved/missing counts / Category grouping / Requirement links | BUILT ×3 | `app/(internal)/projects/[projectId]/design/screens/page.tsx` (tiles; `?group=role`; requirement-link column from `screen-inventory-queries.ts`) |
| 034 | Role/device filters / Responsive coverage | BUILT ×2 | `app/(internal)/projects/[projectId]/design/screens/page.tsx` — GET filters `role`/`device`/`status`, coverage column from `device_targets` × `responsive_coverage` |
| 035 | Device targets / Component list / Design preview / Add state | BUILT ×4 | `app/(internal)/projects/[projectId]/design/screens/[screenId]/page.tsx` + `screen-states-panel.tsx` (`projects.set_screen_states`) |
| 037 | Platform/type / Submit to QA | BUILT ×2 | `app/(internal)/projects/[projectId]/prototype/prototype-panels.tsx` (`projects.set_prototype_platform`, `submit_prototype_to_qa`) |
| 037 | Revision count / QA evidence / Client feedback | BUILT ×3 | `app/(internal)/projects/[projectId]/prototype/page.tsx` over `src/modules/projects/prototype-queries.ts` |
| 038 | Approved vs draft assets / Upload-replace asset version / Mark approved | BUILT ×3 | `app/(internal)/projects/[projectId]/design/page.tsx` + `design-asset-panels.tsx` (`design_assets.status/version/parent_asset_id`, `record_uploaded_design_asset`, `mark_design_asset_approved`) |

## Development (039–043)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 039 | Recent commits/builds | BUILT | `app/(internal)/development/page.tsx` — `projects.commit_links` + `projects.git_actions` (`src/modules/projects/git-queries.ts`) |
| 039 | Escalate blocker to PM / Start QA handoff | BUILT ×2 | `app/(internal)/development-events-panels.tsx` on the dashboard and the project tab — `projects.escalate_blocker`, `start_qa_handoff` (gated on no blocked / unfinished task), recorded in `development_events` |
| 040 | Client dependencies outstanding / Modules-features / Definition of Done | BUILT ×3 | `app/(internal)/projects/[projectId]/plan/page.tsx` (client register rows; module/feature summary; DoD per deliverable from readiness + evidence + layers) |
| 040 | Frontend/backend/database/APIs/integrations/auth/business-logic breakdown | BUILT | `app/(internal)/projects/[projectId]/plan/plan-layers-panel.tsx` — `projects.plan_layers` via `set_plan_layers` |
| 040 | Execution order | BUILT | `app/(internal)/projects/[projectId]/plan/page.tsx` — `plan_layers.execution_order`, deliverables sorted by it |
| 041 | Evidence status / Implementation notes / Test evidence / Handoff status | BUILT ×4 | `app/(internal)/projects/[projectId]/development/tasks/[taskId]/page.tsx` over `task-evidence-queries.ts` (`projects.task_evidence`, `tasks.ready_for_qa_at`) |
| 041 | Start task / Mark ready for QA / Submit evidence / Reopen after QA failure | BUILT ×4 | `app/(internal)/projects/[projectId]/development/tasks/[taskId]/task-doors-panel.tsx` — `projects.start_task`, `mark_task_ready_for_qa`, `submit_task_evidence`, `reopen_task_from_defect` |
| 042 | Failed checks / Code-review findings / Link commit | BUILT ×3 | `app/(internal)/projects/[projectId]/repository/github-panel.tsx` — `readGithubChecks` / `readGithubReviewFindings` (`src/lib/git/github.ts`), `projects.link_commit` |
| 042 | Branch detail / Pull-merge review | BUILT ×2 | `app/(internal)/projects/[projectId]/repository/github-panel.tsx` — `readGithubBranches`; review and merge doors below the PR list |
| 042 | Create task branch / Submit review / Approve-reject merge | BUILT ×3 | Decision: reversed by the owner on 2026-09-30 — `src/lib/git/github-write.ts` behind `src/modules/projects/git-write-service.ts` (`projects.record_git_action`, audited `git.*`); `app/(internal)/projects/[projectId]/repository/git-write-panels.tsx` |
| 043 | Environment readiness / Environment matrix / Trigger build | BUILT ×3 | `app/(internal)/projects/[projectId]/builds/page.tsx` (matrix over `environments.readiness`; trigger = `git_actions` record + GitHub Actions `workflow_dispatch` when `repository_links.workflow_file` is set) |
| 043 | Migration/API compatibility status / API contracts / DB migrations / External service configuration / Promote build after gates / Run contract-migration checks | BUILT ×6 | `app/(internal)/projects/[projectId]/builds/environment-readiness-panels.tsx` — `projects.record_environment_check` (the three checks), `promote_build` gated on the checks and `qa.release_gates()` |

## QA & Release (044–049)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 044 | Recent runs / Bug trend | BUILT ×2 | `app/(internal)/qa/page.tsx` (recent runs table; bug trend `TrendChart` from `src/modules/qa/bug-trend.ts`) |
| 044 | Release candidate / Open run-bug-build / Assign retest / Block release / Generate QA evidence summary | BUILT ×5 | `app/(internal)/qa/page.tsx` (RC column, run/bug/build links, evidence summary) + `app/(internal)/qa/qa-forms.tsx` (assign retest via `qa.assign_retest`, block release via the Release tab's `HoldReleaseForm`) |
| 045 | Linked task / Import test case | PARTIAL ×2 | Scope link only; no import |
| 046 | Pass/fail/blocked counts / Start-end time / Defects created / Retest history | BUILT ×4 | `app/(internal)/projects/[projectId]/qa/page.tsx` (run lifecycle card: blocked, started/ended, defects per run via `qa.defects.run_id`, retest assignments `qa.retest_assignments`) |
| 046 | Rerun failed cases / Close run when complete | BUILT ×2 | `app/(internal)/projects/[projectId]/qa/run-lifecycle-panel.tsx` (`qa.open_test_run` / `qa.close_test_run` / `qa.rerun_test_run`, 20261001140000) |
| 047 | Bug detail / Evidence / Linked task-build | PARTIAL ×3 | Inline rows; evidence only in CSV; build not shown |
| 048 | Performance budgets / Stability incidents / Schedule suite / Compare baseline | BUILT ×4 | `app/(internal)/projects/[projectId]/qa/page.tsx` (`qa.performance_budgets`, `qa.stability_incidents`, `qa.suite_schedules` fired by the tick via `src/modules/qa/schedule-worker.ts`, `src/modules/qa/baseline.ts`) |
| 048 | Attach metrics | BUILT | `app/(internal)/projects/[projectId]/qa/run-lifecycle-panel.tsx` (`MetricForm` → `qa.metric_results`) |
| 049 | Security/performance/QA summary | BUILT | `app/(internal)/projects/[projectId]/release/page.tsx` (`readSecuritySummary`, `readPerformanceSummary` in `src/modules/qa/summary-queries.ts`) |
| 049 | Deployment dependencies | BUILT | `app/(internal)/projects/[projectId]/release/deployment-deps-panel.tsx` (`projects.handovers.deployment_dependencies`, `projects.set_deployment_dependency`) |
| 049 | Final payment verified before launch (guardrail) | BUILT | Decision F1: `projects.mark_production_ready` refuses `payment_unverified` (`projects.final_payment_state`); owner override `projects.override_release_payment` → `app/(internal)/projects/[projectId]/release/release-payment-panel.tsx` |

## Finance (050–056)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 050 | Create invoice | BUILT | `app/(internal)/finance/page.tsx` (`CreateFromMilestoneForm`, the Invoices page's own door) |
| 051 | Draft/issued counts / GST filters / Milestone filter / Linked milestone column / Reminder history / Send by email | BUILT ×6 | `app/(internal)/invoices/page.tsx` (tiles, `?gst=`, `?milestone=`, milestone column, `reminder-history-drawer.tsx`); `app/(internal)/invoices/[invoiceId]/email-send-panel.tsx` → `src/lib/email/transport.ts` (Resend / SMTP, honest not-configured) |
| 052 | Attach client proof on the invoice | BUILT | `app/(internal)/invoices/[invoiceId]/page.tsx` (`RecordClaimForm`, the shared door) |
| 053 | Unmatched KPI / Record payment proof / Reject with reason | BUILT ×3 | `app/(internal)/finance/payments/page.tsx` (Unmatched tile; `RecordClaimForm` / `VerifyClaimForm` mounted on Payments) |
| 055 | Project margin / Project profitability / Vendor-tool costs | BUILT ×3 | `app/(internal)/finance/expenses/page.tsx` (margin column on Budget vs actual; `src/modules/finance/vendor-rollup.ts`) |
| 055 | Budget vs actual | BUILT | Decision F5 (reopened): `src/modules/finance/budget-variance.ts` (`computeBudgetVariance`) on `app/(internal)/projects/[projectId]/reports/page.tsx` and `app/(internal)/finance/expenses/page.tsx` |
| 056 | GST configuration / Configure tax profile / Export PDF | PARTIAL ×2, BUILT ×1 | GST configuration and tax profile stay on Settings; Export PDF: `app/api/finance/tax/pdf/route.ts` → `src/lib/pdf/tax-report.ts` |
| 056 | Export history | BUILT | `app/(internal)/finance/tax/page.tsx` (`finance.gst_exports`, written by `app/api/finance/gst/gstr-export.ts`) |

## Communication (057–061)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 057 | Unread count / Announcements due / Create announcement | BUILT ×3 | `app/(internal)/communication/page.tsx` (`listUnansweredConversations`, due tile, `AnnouncementsPanel` mounted with the schedule form) |
| 059 | Scheduled announcements | BUILT | `crm.announcements.scheduled_for` + `crm.schedule_announcement`; published by the tick (`src/modules/crm/announcement-worker.ts`) |
| 059 | Template detail / Audience-project selection / Send preview / Schedule-send | BUILT ×4 | `app/(internal)/communication/templates/[templateId]/page.tsx`; `new-campaign-form.tsx` (project audience, send-from time); `campaigns/[campaignId]/page.tsx` (send preview via `src/modules/crm/campaign-preview-queries.ts`) |
| 060 | Retry count / Requeue with reason | BUILT ×2 | `app/(internal)/communication/page.tsx` (Retries tile); `app/(internal)/operations/requeue-form.tsx` → `core.requeue_job_with_reason` |
| 060 | Escalate to Admin | BUILT | `app/(internal)/operations/page.tsx` and `app/(internal)/communication/page.tsx` mount F-A's `EscalateControl` (`core.escalations`, subject_type `delivery`) |
| 061 | Open model/tool detail | BUILT | `app/(internal)/agents/models/[modelId]/page.tsx` (registry row, added by/at, routes, period runs/tokens/cost/latency, last 20 runs) and `app/(internal)/agents/tools/[toolName]/page.tsx` (definition, bound agents, per-agent permissions, calls and failure rate, last 20 calls); linked from the dashboard's Model usage and Tools list, the routing registry and the agent page's tool list |

## AI Workforce, Operations, Governance, Integrations, Settings (062–071)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 062 | Disabled reason / Capability summary in the registry | BUILT | `app/(internal)/agents/page.tsx` (Disabled reason and Capabilities columns: bound tools · allowed work) |
| 063 | Current provider | BUILT | `app/(internal)/agents/[agentKey]/page.tsx`, `src/lib/ai/model-provider.ts` |
| 063 | Allowed work classes | BUILT | `app/(internal)/agents/[agentKey]/work-classes-form.tsx` (`ai.set_agent_work_classes`, honoured by `app/api/jobs/run/route.ts`) |
| 064 | Model availability-registry / Fallback policy-chain / Tool permissions matrix / Model budget | BUILT | `app/(internal)/agents/routing/model-registry-panel.tsx` (add/retire, chain per work class, provider budget; ADM-84 reversed 2026-09-30) |
| 065 | Latency KPI / Project-provider filters / Tool calls / Replay / Cancel running / Export cost ledger | BUILT | `app/(internal)/usage/page.tsx` (latency tiles, `/api/usage/ledger`), `app/(internal)/usage/runs/page.tsx` (project, provider), `app/(internal)/usage/runs/[runId]/page.tsx` (arguments/results, replay, stop) |
| 066 | Cancel workflow | BUILT | `app/(internal)/operations/cancel-running-form.tsx` (`core.cancel_running_job`, honoured by the runner between steps) |
| 066 | Escalate operational failure | BUILT | `app/(internal)/operations/dead-letters-list.tsx` (F-A's `EscalateControl`, subject `job`) |
| 067 | Last live checks / Alert destination / Incident banner | BUILT | `app/(internal)/incident-banner.tsx` (cross-app), `app/(internal)/operations/alerts-panel.tsx` (first/last seen, in-app destination beside the webhook) |
| 067 | Acknowledge alert | BUILT | `app/(internal)/operations/alerts-panel.tsx` (`core.acknowledge_alert`, audited) |
| 068 | Override center / Emergency controls | BUILT | `app/(internal)/governance/overrides/page.tsx` (`core.overrides`, `core.kill_switches`) |
| 068 | Record exception/override with reason | BUILT | `app/(internal)/governance/overrides/manual-override-form.tsx` (`core.record_manual_override`; domain overrides mirrored by trigger) |
| 069 | Role assignment / Grant-revoke role | BUILT | `src/lib/authz/permissions.ts`, `src/lib/auth/session.ts` (`can(context, …)` reads the union; `core.holds_role` in the database) |
| 069 | Incident/security exception history | BUILT | `app/(internal)/security/incidents/page.tsx` (`security.incidents`) |
| 069 | Review access / Investigate security event | BUILT | `app/(internal)/security/users/access-review-panel.tsx` (`security.access_reviews`), `app/(internal)/security/page.tsx` (Investigate → incident with the entry as evidence) |
| 070 | Update non-secret identifiers | PARTIAL | Edited on Settings › Communication |
| 071 | Security/integrations shortcuts / Preview impact before saving high-risk settings | BUILT | `app/(internal)/settings/page.tsx` (shortcuts card), `app/(internal)/settings/high-risk-forms.tsx` (preview step from `src/lib/admin/settings-impact.ts`) |
| 071 | Provider vault references / Current value-effective date-history | BUILT | `app/(internal)/settings/page.tsx` (vault link), `app/(internal)/settings/setting-history.tsx` (per-setting history from `src/lib/admin/settings-history.ts`) |

## Shared rules (sections 1–4)

Shared implementation (12): sectioned navigation, dark rail + light workspace + cards + compact tables, ⌘K search, Quick Create, notification bell with live count, user/role/org menu, entity header with status, sticky table headers, right drawer primitive, error boundary with reference, permission-denied component, status chips.

| Rule | Status | Gap |
|---|---|---|
| Empty states explain why and offer a next step | BUILT | Every `EmptyState` on a list page passes an `action` — pinned by `tests/the-shell-explains-itself.test.ts` |
| Responsive | BUILT | `app/(internal)/agents/routing/page.tsx` — the three tables (model registry, routing matrix, agents × categories) are `DataTable`s |
| Help/status in header | BUILT | `app/(internal)/system-status.tsx` in the layout, fed by the readiness evaluator (`system-status-actions.ts`) |
| Breadcrumb | BUILT | `app/(internal)/nav.tsx` `HeaderTrail` — module › page › record (`TrailLabel`), shown from the tablet width |
| Primary + overflow actions | BUILT | `src/ui/primitives/row-actions.tsx` (`RowActionsMenu`) |
| Search within domain | BUILT | `src/ui/primitives/domain-search.tsx` (`DomainSearch` GET form + `SearchSummary` "N results for 'q'"), escaping in `src/lib/db/search.ts`, server-side `or=ilike` in each reader — on projects, follow-ups, meetings, payments, expenses, approvals, notifications (composed items, filtered on the server), team, project templates, campaigns, agent runs, QA open bugs, audit trail; leads, clients, quotations, invoices and search keep their own boxes |
| Loading skeleton | BUILT | `app/(internal)/profile/loading.tsx`, `search/loading.tsx`, `help/loading.tsx` |
| Integration unavailable/degraded state | BUILT | `src/ui/primitives/integration-state.tsx`, used by `/integrations` and `/production-readiness` |
| Stale-data warning | BUILT | `src/lib/realtime/live-refresh.tsx` renders `StaleDataWarning` on every `LiveRefresh` page once the channel is not live and the page has not re-read |
| Clear all filters | BUILT | `src/ui/primitives/filter-bar.tsx` `clearHref` — leads, invoices, projects, approvals, notifications, search |
| Per-row overflow actions | BUILT | `src/ui/primitives/table.tsx` `rowActions` slot, used on `/leads` and `/invoices` |
| Approval actions in a drawer | BUILT | `app/(internal)/approvals/decide-drawer.tsx` over the same `ApprovalDecisionForm` |
| Not-found state | BUILT | `app/(internal)/not-found.tsx` (inside the shell) and `app/global-error.tsx` (the last boundary, with the reference) |

## Copy that contradicted the code (fixed 2026-09-30)

Project settings said templates were not built; the agents registry said enabling was a database decision; the approvals page said policies are configured in the database; Client 360 said broadcast was declined. All four now describe what exists.
