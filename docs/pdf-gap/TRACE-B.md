# Trace B: line-by-line proof for PDF pages 28-45 (SCR-019 to SCR-036)

Source: `scratchpad/pdf/screen_architecture_fresh.txt`, pages 28-45, every line. One row per bullet or text line (soft-wrapped lines merged). Method: each row was placed by reading the source file named in the last column; where cheap it was also rendered (owner session, 1536 and 390 wide). Earlier evidence: docs/pdf-gap/B.md (rendered audit), W2-BUILD.md, W4-BUILD.md, X1-X3, docs/ui-parity/owner-decisions.md.

Statuses: BUILT, DECIDED (owner decision), QUESTION (open, exact question in the table and listed below), NOT-BUILDABLE, NARRATIVE (heading or label stating no requirement). No GAP row remains: every gap found was built in this trace (marked "[built in this trace]") or turned into a QUESTION.

## Row counts

| status | rows |
|---|---|
| BUILT | 365 |
| DECIDED | 2 |
| QUESTION | 6 |
| NOT-BUILDABLE | 1 |
| NARRATIVE | 198 |
| **total** | **572** |

Per page (BUILT / DECIDED / QUESTION / NOT-BUILDABLE / NARRATIVE): p28 25/0/0/0/11; p29 21/0/0/0/11; p30 19/0/1/0/11; p31 17/0/0/0/11; p32 20/1/0/0/11; p33 18/0/0/0/11; p34 19/1/1/0/11; p35 21/0/0/0/11; p36 22/0/1/0/11; p37 19/0/0/0/11; p38 25/0/0/0/11; p39 21/0/0/0/11; p40 17/0/0/0/11; p41 22/0/0/0/11; p42 22/0/0/1/11; p43 19/0/0/0/11; p44 17/0/3/0/11; p45 21/0/0/0/11

## Gaps found by the trace and built

Migration `supabase/migrations/20261008120000_a_review_needs_a_hand_off_and_a_changed_date_is_remembered_and_told.sql` (applied twice locally, idempotent). Verifier `scripts/verify-trace-b.mjs` (`npm run db:verify:trace-b`, step in `.github/workflows/verify.yml`, 37 live checks, green). Test `tests/trace-b-a-moved-date-and-a-review-are-governed.test.ts` (5 behavioural tests).

| gap (rows) | what was built |
|---|---|
| SCR-020/021 "Move task only through valid state transitions", "Submit for review": the rule lived only in the Board UI; the plain status door, My Tasks selects, the Development panel and "+ Add task in Review" could put a task in Review with no evidence | DB trigger `projects.refuse_review_without_hand_off` (Review only from In progress and only with evidence, any writer); `src/modules/projects/task-transitions.ts` (rule + `selectableStatuses`); `setTaskStatus` answers in words; My Tasks row/drawer and Development selects stop offering Review; Review column no longer offers "+ Add task" |
| SCR-022 "Changes must preserve history and notify affected owners", SCR-023 audit: a milestone due-date change was an unaudited UPDATE and nobody was told of any date change | trigger `projects.audit_milestone_due_change` (`milestone.due_changed`, old and new date, actor); read door `projects.schedule_changes` (task, milestone, project due dates that really moved; `p_mine` = what concerns the caller and was done by someone else); Notifications inbox category "Schedule changes" (`app/(internal)/notifications/action-items.ts`); "Schedule Changes" card on the project calendar; `src/modules/projects/schedule-changes-queries.ts` |
| SCR-019 header: no "Milestone payment status" and no phase beside the status | two header facts on the Overview: Phase, and Milestone payments (verified share and milestones paid) |
| SCR-019/SCR-032 broken link: the Phase 4 tile linked to `/projects/[id]/ui-versions`, a route that does not exist | now `/ui-versions/[id]` (latest UI version) or `/prototype` |
| SCR-023 sub-screens List/Gantt/Calendar and search of a list that can grow | view switch on Milestones (Calendar = `/calendar?types=milestone`) and a milestone search |
| SCR-028 header KPIs were only rows in a side card | header tiles "Projects with open questions" and "Awaiting client confirmation"; "AI extracted" moved to Queue Health |
| SCR-032 header: "designed" count and "UI status" absent on the design dashboard | tiles "Designed Screens" and "UI Status" |
| SCR-027 activity timeline unbounded, no search or filter; /design portfolio no search | Activity: search + kind chips (`filterActivity`, `activityTypeChips`, unit-tested); /design: project/queue search |

## Open questions (QUESTION rows)

1. **Q-B1** (SCR-020): a task may move from To do or In progress straight to Completed today (only agent work is gated). Should Completed be reachable only from In review?
2. **Q-B2** (SCR-021): should a project role limit task work on that project (Observer read-only, Contributor own tasks only)? Today it is only a label; permissions come from the agency role.
3. **Q-B3** (SCR-025): may the delivery lead (PM) change project roles, or only owner and ops admin? (Enforced today as `project.write`.)
4. **Q-B4** (SCR-027): should a project have several default assignees (for example one per project role) instead of one?
5. **Q-B5** (SCR-035): navigation paths as structured links between screens (new table) instead of free text?
6. **Q-B6** (SCR-035): buttons/actions as a structured list per screen (new table) instead of one free-text field?
7. **Q-B7** (SCR-035): should "Map requirement" be offered on a finalized baseline as "draft the next baseline"?

(Q-B1 is not a row status of its own: its row, "Move task only through valid state transitions", is BUILT for the Review rule and carries the question.)

## Not buildable here

- Real file upload, preview, version and share link execution (SCR-024, 032, 033, 038-style uploads): Supabase Storage is unreachable in this stack; the logic is covered by source, fakes and unit tests, not exercised in a browser.
- Sending theme options to the client (SCR-033): no client channel configured (recorded decisions); the door records what a person sent.
- Two-way calendar sync (SCR-022): needs a provider credential; the private ICS feed is the supported sync.

## What could not be verified

- Role-gated variants were rendered as owner only; permission rows rest on reading `can()` checks and the DB doors (the verifier does exercise finance and member tokens for the new door and trigger).
- Requirement Set sections (SCR-029): `crm.requirement_versions` is empty locally; the nine sections are verified in `requirement-set-panel.tsx`, not rendered.
- Change-request states approve/reject/send quotation/linked tasks: no request in those states locally; doors read, not exercised.
- tsc reports errors in files outside this slice (other agents are editing clients/operations); none in the files changed here.
- The audit rows from local test moves (two `milestone.due_changed` rows for a deleted temporary milestone) stay in the append-only audit log.

## The trace

| page | the PDF's text | status | where |
|---|---|---|---|
| 28 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 28 | SCR-019 - Project Overview | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 28 | Primary lifecycle: Phase 2 onward \| Screen baseline number: 19 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 28 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 28 | Executive 360-degree project page summarizing progress, milestones, finance, team, files, risks and phase history. | BUILT | Purpose: app/(internal)/projects/[projectId]/page.tsx (/projects/[projectId]): 360 page with timeline, phase tiles, finance ladder, team, files, risks (Quality), phase history. |
| 28 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 28 | Project status/phase | BUILT | Header status badge (EntityHeader) + "Phase" fact from readProjectLifecycles [built in this trace] in app/(internal)/projects/[projectId]/page.tsx |
| 28 | Progress | BUILT | Header HeaderFigure "Overall progress" (one rule overallProgress, src/modules/projects/project-health.ts) |
| 28 | Days remaining | BUILT | Stat "Days left" (links to calendar), same file |
| 28 | Tasks | BUILT | Stats "Total tasks / In progress / Pending / Overdue" same file |
| 28 | Milestone payment status | BUILT | Header fact "Milestone payments: N% verified · x of y paid" [built in this trace] (from readPaymentLadder); full ladder + plan table in the "How this project is billed"/Payment plan sections |
| 28 | Health | BUILT | Stat "Project health" from healthOfProject (one evidence-based rule shared with list and Reports) |
| 28 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 28 | Progress timeline | BUILT | Card "Project timeline" + "Progress overview" chart, same file |
| 28 | Phase progress | BUILT | Eight phase tiles Phase 1..8 (lead, onboarding, design, UI/prototype, development, QA, handover, customer success), same file |
| 28 | Recent tasks | BUILT | Card "Recent tasks" (+ Task quick form), same file |
| 28 | Recent activity | BUILT | ActivityFeed "Recent activity" -> /projects/[id]/activity |
| 28 | Team | BUILT | Card "Team members (n)" -> /team |
| 28 | Files | BUILT | Card "Recent files" -> /files |
| 28 | Project links | BUILT | Card "Project links (n)" (ProjectLinksPanel, project.write to edit) |
| 28 | Upcoming events | BUILT | Card "Upcoming events" (open milestones + meetings booked on the deal) -> /calendar |
| 28 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 28 | Open any module in context | BUILT | ProjectSubNav tabs (Overview..Settings, More: Plan, Scope, Requirements, Design, Prototype, Development, Repository, Builds, QA, Release...) + links from every tile: app/(internal)/projects/[projectId]/project-subnav.tsx |
| 28 | Edit project metadata within permissions | BUILT | "Edit project" -> /settings (ProjectDetailsForm, ProjectClassificationForm, visibility), shown only with project.write; service updateProject re-checks project.write (src/modules/projects/service.ts) |
| 28 | Send project update | BUILT | Card "Project updates" (ProjectUpdatePanel: to the client thread through the chokepoint, or an internal note): app/(internal)/projects/[projectId]/project-update-form.tsx |
| 28 | Create task/meeting/file | BUILT | "+ Task" (QuickTaskForm, task.write), "Propose a meeting" (ProposeMeetingOnDayForm, lead.write; real booking needs the calendar credential, so it is a request), "Upload file"/"Link a file" quick actions |
| 28 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 28 | Admin must see every phase output: onboarding, UI choices, plans, QA evidence, payment gates, deployment and handover | BUILT | Evidence tiles per phase: onboarding (Phase 2 tile), UI choices (Phase 3 design trail + Phase 4 UI version, link repaired in this trace: /ui-versions/[id] or /prototype, was a 404), plans (Phase 5), QA evidence (Phase 6), payment gates (ladder), deployment/handover (Phase 7) |
| 28 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 28 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page: can(context,'project.read') else PermissionDenied (line 145); writes: updateProject project.write, createTask task.write, links/updates re-check can(); DB doors and RLS decide again |
| 28 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | tasks, projects, files, members, links, updates have audit triggers (audit_row_change); milestone due changes now too [built in this trace] (migration 20261008120000) |
| 28 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | No unbounded list on this page (recent items are capped at 5-6; each card links to its own searchable page). Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 28 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Contextual drawers: task rows open the task page; creation is in-place (QuickTaskForm); complex flows live on their own tabs. |
| 28 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]); earlier audit B.md measured the same for all 18 routes. |
| 28 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 28 | Confidential \| Page 28 of 83 | NARRATIVE | Page footer; no requirement. |
| 29 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 29 | SCR-020 - Project Board | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 29 | Primary lifecycle: Phase 2 onward \| Screen baseline number: 20 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 29 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 29 | Kanban execution view for project tasks grouped by status, phase, assignee or workstream. | BUILT | Purpose: app/(internal)/projects/[projectId]/board/page.tsx + board-client.tsx: kanban of tasks grouped by status, with group-by assignee/priority/module. |
| 29 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 29 | Task counts by status | BUILT | Column headers carry per-status counts (KanbanBoard count) plus tiles Total/In progress/In review/Pending and Task status donut |
| 29 | Search/filter | BUILT | Search tasks input (board-client.tsx) |
| 29 | Phase/priority/assignee filters | BUILT | Selects: Filter by phase (milestone), priority, assignee, module, sprint; sort; group-by |
| 29 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 29 | To Do | BUILT | Column "To do" (COLUMNS in board/page.tsx) |
| 29 | In Progress | BUILT | Column "In progress" |
| 29 | Review | BUILT | Column "Review" (id in_review) |
| 29 | Completed | BUILT | Column "Completed" |
| 29 | Blocked | BUILT | Column "Blocked" |
| 29 | Task detail drawer | BUILT | Task drawer ("Show details of ..." opens Drawer with TaskCollabPanel), board-client.tsx |
| 29 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 29 | Create/edit/assign task | BUILT | Create (Add task drawer per column), edit (updateTaskAction), assign (Assignee select in the drawer)  |
| 29 | Move task only through valid state transitions | BUILT | Review is entered only through the evidence hand-off: drawer/drag refuse it in the UI, and now the service (setTaskStatus) and a database trigger refuse it too [built in this trace] (src/modules/projects/task-transitions.ts; trigger projects.refuse_review_without_hand_off; verifier db:verify:trace-b). OPEN: whether Completed may be reached from To do/In progress, see QUESTION Q-B1 |
| 29 | Add comment/attachment/checklist | BUILT | TaskCollabPanel: CommentsSection, AttachmentsSection, ChecklistSection (app/(internal)/task-collab-panel.tsx) |
| 29 | Link evidence | BUILT | Evidence: SubmitEvidencePanel inside ReviewSection (kind test/implementation/review/other) + attachment links |
| 29 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 29 | Agent-generated work is not complete until required verification passes | BUILT | Trigger projects.refuse_unverified_agent_done (migration 20261006200000) refuses Done for an unverified agent task; origin badge on cards, AgentWorkSection verifies |
| 29 | Blocked state must capture blocker type, owner and next action | BUILT | BlockerFields: blocker type (decision Round 2 #4 vocabulary), owner, next action, required by setTaskStatus (blockerProblem) and constraints on projects.tasks |
| 29 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 29 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; setTaskStatus/updateTask/createTask re-check task.write; tasks_write RLS = core.can_write() |
| 29 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | projects.tasks has audit_row_change (task.added / task.<status> / task.assigned); evidence and agent verification are audited doors; comments/checklist rows are authored, timestamped records |
| 29 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search, five filters, sort, group-by on the board. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 29 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Task detail drawer (Board and My Tasks). |
| 29 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/board); earlier audit B.md measured the same for all 18 routes. |
| 29 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 29 | Confidential \| Page 29 of 83 | NARRATIVE | Page footer; no requirement. |
| 30 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 30 | SCR-021 - My Tasks | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 30 | Primary lifecycle: Cross-phase internal \| Screen baseline number: 21 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 30 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 30 | Personal work queue for the signed-in admin/team member across all projects. | BUILT | Purpose: app/(internal)/my-tasks/page.tsx, listMyTasksDetailed for the signed-in user across projects |
| 30 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 30 | Assigned to me | BUILT | Stat "Assigned to me" ("Open tasks", caption Assigned to me) |
| 30 | Due today/overdue | BUILT | Stats "Due today" and "Overdue" |
| 30 | Waiting for review | BUILT | Stat "Waiting for review" |
| 30 | Blocked | BUILT | Stat "Blocked" |
| 30 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 30 | Board | BUILT | View "Board" (columns) - ?view=columns (default) |
| 30 | List | BUILT | View "List" ?view=list |
| 30 | Calendar | BUILT | View "Calendar" ?view=calendar (MonthGrid) |
| 30 | Task drawer | BUILT | Task drawer app/(internal)/my-tasks/task-drawer.tsx (TaskCollabPanel, edit form) |
| 30 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 30 | Complete checklist item | BUILT | ChecklistSection in the drawer (setChecklistItemDone) |
| 30 | Submit for review | BUILT | ReviewSection "Submit for review" asks for evidence then marks ready for QA (task-collab-panel.tsx); My Tasks status selects no longer offer Review [built in this trace] (selectableStatuses) and the service refuses it |
| 30 | Reassign if authorized | BUILT | Assignee select in the drawer = updateTask with another assignee (task.write); copy says reassigning removes it from your list |
| 30 | Add note/evidence | BUILT | CommentsSection (note) + SubmitEvidencePanel / attachments (evidence) |
| 30 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 30 | Task scope and permissions inherit from project role | QUESTION | Q-B2: today the project role (Team page) is only a label; a person's task permissions come from the agency role (permissions.ts) and RLS (tasks_write = core.can_write()). Question: should a project role limit task work on that project (e.g. Observer read-only, Contributor own tasks only)? The Team page copy states the current rule. |
| 30 | Completion evidence remains attached to the task | BUILT | Evidence rows (projects.task_evidence) and attachments stay on the task; completion keeps them (rows cascade only with the task) |
| 30 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 30 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page requireInternal; status/edit/evidence doors re-check task.write; RLS |
| 30 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | same task audit trigger as the Board; schedule moves audited (task.schedule_set) |
| 30 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search q, project/priority/status filters, three views, Reset. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 30 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Task drawer. |
| 30 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/my-tasks); earlier audit B.md measured the same for all 18 routes. |
| 30 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 30 | Confidential \| Page 30 of 83 | NARRATIVE | Page footer; no requirement. |
| 31 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 31 | SCR-022 - Project Calendar | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 31 | Primary lifecycle: Cross-phase \| Screen baseline number: 22 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 31 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 31 | Calendar of project tasks, milestones, deadlines, client calls and release dates. | BUILT | Purpose: app/(internal)/projects/[projectId]/calendar/page.tsx: tasks (due dates), milestones, project deadline, meetings |
| 31 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 31 | Month/week/day/list modes | BUILT | View switch Month / Week / Day / List (?view=) |
| 31 | Task/milestone/meeting/deadline filters | BUILT | "Calendar Filters" toggles Task, Milestone, Meeting, Deadline (KINDS; deadline = project due date) |
| 31 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 31 | Main calendar | BUILT | MonthGrid main calendar |
| 31 | Upcoming events | BUILT | Card "Upcoming Events" |
| 31 | Milestones on calendar | BUILT | Card "Milestones on Calendar" |
| 31 | Quick actions | BUILT | QuickActions card |
| 31 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 31 | Create task/milestone/meeting | BUILT | Per-day forms: AddTaskOnDayForm (task.write), AddMilestoneOnDayForm (milestone.write, unpriced), ProposeMeetingOnDayForm (lead.write; a request, because real booking needs the calendar credential) |
| 31 | Open source record | BUILT | Every entry links to its record: task page, /milestones?milestone=, meeting page |
| 31 | Sync supported calendars | BUILT | Card "Sync to your calendar": private ICS feed (calendar-feed-service, token hashed, audited) for Google/Apple/Outlook subscription. Two-way sync with a provider account needs a credential that cannot exist locally; the feed is the supported sync |
| 31 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 31 | Dates are not invented; they come from project plan/tasks/meetings | BUILT | Entries are read from tasks.due_on, milestones.due_on, projects.ends_on, crm.meetings; nothing is invented |
| 31 | Changes must preserve history and notify affected owners | BUILT | History: task and project date moves are audited, milestone date moves are audited [built in this trace] (trigger audit_milestone_due_change); new card "Schedule Changes" lists them with old and new date and actor on the calendar page; affected owners (assignee, delivery lead, project members) are told in /notifications "Schedule changes" (door projects.schedule_changes, action-items.ts). Rendered and verified (37 checks, verifier db:verify:trace-b) |
| 31 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 31 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; create forms re-check task.write / milestone.write / lead.write in their services |
| 31 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | task, milestone (new), project and feed-token changes are audited |
| 31 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Kind filters, view modes, month/week/day navigation. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 31 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | The calendar links to each record rather than a drawer: a day is a list, a record is a page (rule: dedicated page for the complex flow). |
| 31 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/calendar); earlier audit B.md measured the same for all 18 routes. |
| 31 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 31 | Confidential \| Page 31 of 83 | NARRATIVE | Page footer; no requirement. |
| 32 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 32 | SCR-023 - Project Milestones / Gantt | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 32 | Primary lifecycle: Phase 2 onward \| Screen baseline number: 23 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 32 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 32 | Timeline view for project business milestones and dependencies, including the locked payment milestone gates. | BUILT | Purpose: app/(internal)/projects/[projectId]/milestones/page.tsx (list, Gantt, detail panel) + plan/page.tsx (payment milestones) |
| 32 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 32 | Total/completed/in-progress/pending milestones | BUILT | Stats Total / Completed / In progress / Pending milestones |
| 32 | Final delivery date | BUILT | Stat "Final delivery" (finalDelivery, shared with Plan) |
| 32 | Overall progress | BUILT | HeaderFigure "Milestones met" progress |
| 32 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 32 | List | BUILT | List: milestone cards (#milestone-list) [built in this trace] with a view switch |
| 32 | Gantt | BUILT | Gantt card "Project milestone timeline" (derived windows, labelled as such: no stored start date exists) |
| 32 | Calendar | BUILT | Calendar view link [built in this trace] (/calendar?types=milestone) in the same switch; Plan has the same List/Gantt/Calendar |
| 32 | Milestone detail panel | BUILT | Aside "Milestone details" |
| 32 | Dependency list | BUILT | Detail panel "Dependency list" (readMilestoneDependencies: earlier open milestones, plan gates, blocked tasks) |
| 32 | Milestone tasks | BUILT | Card "Milestone tasks (name)" |
| 32 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 32 | Edit dates/scope within permission | BUILT | Edit dates: plan/page.tsx MilestoneDueForm (setMilestoneDueOn, milestone.write) and "Edit milestone" link; dates now audited [built in this trace]  |
| 32 | Open tasks | BUILT | "View tasks" link to /tasks?phase=id |
| 32 | Mark work milestone complete only when gate rules permit | BUILT | "Mark as Completed" (markMilestoneMet, milestone.write, status gate: in_progress/submitted only, and the unlock handler needs verified payment) |
| 32 | Trigger finance milestone when defined | BUILT | TriggerFinanceMilestoneForm on the plan page (finance door, invoice.create) |
| 32 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 32 | Locked financial triggers: Phase 2 30%, Phase 4 complete 20%, Phase 5 complete 30%, Phase 6 complete 20% | DECIDED | docs/ui-parity/owner-decisions.md Round 2 #2: the free plan stays; 30/20/30/20 on Phases 2,4,5,6 is the pre-filled default (sales.seed_default_payment_structure, migration 20261007200000). The ladder 30/50/80/100 is cumulativeLadder() (ADM-105) |
| 32 | No verified payment means no paid milestone progression | BUILT | No verified payment, no progression: milestone unlock handler (milestone.unlock) runs only on verified payment; ladder gate "final phase stays shut" (src/modules/finance/ladder.ts); markMilestoneMet refuses pending |
| 32 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 32 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; markMilestoneMet/setMilestoneDueOn re-check milestone.write; milestones_write RLS = can_manage_delivery() |
| 32 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | milestone due date moves audited (milestone.due_changed) [built in this trace] ; met/payment steps audited by their doors |
| 32 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search over milestones [built in this trace] (DomainSearch q) because a milestone can be added from the calendar; Plan page searches deliverables. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 32 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Milestone detail aside panel (selected via ?milestone=). |
| 32 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/milestones); earlier audit B.md measured the same for all 18 routes. |
| 32 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 32 | Confidential \| Page 32 of 83 | NARRATIVE | Page footer; no requirement. |
| 33 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 33 | SCR-024 - Project Files | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 33 | Primary lifecycle: Cross-phase \| Screen baseline number: 24 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 33 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 33 | Versioned project file manager for requirements, designs, builds, QA evidence, deployment and handover assets. | BUILT | Purpose: app/(internal)/projects/[projectId]/files/page.tsx + files-storage-panel.tsx: link files and stored objects with versions (verified by source; Storage is unreachable locally so uploads cannot be exercised in the browser) |
| 33 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 33 | Total files/storage | BUILT | Storage Usage donut + "n files · m live share links"; total = sum of stored version sizes |
| 33 | Type breakdown | BUILT | Donut by category (storage by folder)  |
| 33 | Recent files | BUILT | Card "Recent Files" (default view, newest first) and Recent Activity |
| 33 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 33 | Folder tree | BUILT | Nav "Folder tree" (categories and nested folders; folder records) |
| 33 | File list/grid | BUILT | Grid/List toggle (?layout=) and list rows |
| 33 | Preview drawer | BUILT | FilePreviewButton -> file-preview-drawer.tsx (images/PDF through the signed download route) |
| 33 | Version history | BUILT | Expandable row "versions" (StoredFileRow), next upload of the same file becomes the next version |
| 33 | Trash | BUILT | ?view=trash, TrashList with restore door |
| 33 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 33 | Upload, download, rename, move, version, share internally | BUILT | Upload (UploadFileForm), download (signed route), rename/move (FileIntoFolderForm, rename form), new version, internal share (internalShare block). Execution against real storage NOT exercised (storage unreachable); logic covered by files-storage tests |
| 33 | Generate secure handover link only when permitted | BUILT | createFileShareLink: stored live file only, expiry, project.write, revocable (files-storage-service.ts) |
| 33 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 33 | Suggested standard folders: Requirements, Designs, Development, QA, Deployment, Documents, Meetings, Assets, Builds | BUILT | PROJECT_FILE_CATEGORIES = requirements, design, development, qa, deployment, marketing, documents, meetings, assets, builds, other (src/modules/projects/schema.ts) |
| 33 | Secrets/credentials must never be stored in normal shared project files | BUILT | file-secrets-guard.ts (fileCredentialProblem) on link add, upload (name and text content) and task attachments, warning on both forms; says it is not exhaustive |
| 33 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 33 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; every file door re-checks project.write; project_files RLS |
| 33 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | projects.project_files and project_file_shares have audit_row_change; trash/restore are doors |
| 33 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search "files and folders", category and folder filter, sort, trash. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 33 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Preview drawer for stored files; versions expand in place. |
| 33 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/files); earlier audit B.md measured the same for all 18 routes. |
| 33 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 33 | Confidential \| Page 33 of 83 | NARRATIVE | Page footer; no requirement. |
| 34 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 34 | SCR-025 - Project Team | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 34 | Primary lifecycle: Phase 2 onward \| Screen baseline number: 25 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 34 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 34 | Project-specific workforce assignment page for human roles plus visible internal AI agent assignments where authorized. | BUILT | Purpose: app/(internal)/projects/[projectId]/team/page.tsx: roster (members + task holders, one roster teamSummary), AI Agents card (listAssignedAgents, internal only) |
| 34 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 34 | Total members by role | BUILT | Stat "Total members" (one roster, caption on-roster vs task holders) + Team Role Distribution by project role |
| 34 | Active now | DECIDED | owner-decisions.md #2: department only, no Online indicator, keep last active. Built: Stat "Active today" + "Last active" column from the audit log |
| 34 | Project manager | BUILT | Stat "Project manager" (names) |
| 34 | Specialists | BUILT | Stat "Specialists" (designers, developers, QA) |
| 34 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 34 | Team roster | BUILT | Card "Project Members (n)" roster (ProjectMembersPanel) + "Task Holders" |
| 34 | Role distribution | BUILT | Card "Team Role Distribution" (donut by project role) |
| 34 | Recent team activity | BUILT | Card "Recent Team Activity" |
| 34 | Invite/assign form | BUILT | "Invite Member" (add form in ProjectMembersPanel; addProjectMember) |
| 34 | Permission summary | BUILT | Card "Permission Summary" per role from the capability matrix (permissions.ts) |
| 34 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 34 | Assign/remove team member | BUILT | Add/remove member: addProjectMember/removeProjectMember (project.write); project_members audited |
| 34 | Set project role | BUILT | Set project role select (setProjectMemberRole) |
| 34 | Manage project-specific defaults | BUILT | Settings "Default assignee" + "Phase notifications" per project; Team "Default team (agency-wide)" card |
| 34 | View workload | BUILT | Card "Workload": open, overdue, blocked, estimated hours per person |
| 34 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 34 | Client-facing communication shows assigned project team roles, not AI provider/model internals | BUILT | app/(client)/portal has no agent/provider/model reference (grepped); client surfaces show team roles only; agents card is internal |
| 34 | Role changes are owner/admin controlled and audited | QUESTION | Q-B3: role changes are enforced as project.write, which owner, ops admin and delivery lead hold (PM). The PDF says "owner/admin controlled". Question: may the delivery lead (PM) change project roles, or only owner and ops admin? Audited either way (project_members audit trigger). |
| 34 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 34 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; member doors re-check project.write; project_members_write RLS = can_manage_delivery() |
| 34 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | projects.project_members audit trigger (insert/update/delete) - role changes audited |
| 34 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search team members (?q=). Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 34 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Members expand in place; workload and permission cards are inline. |
| 34 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/team); earlier audit B.md measured the same for all 18 routes. |
| 34 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 34 | Confidential \| Page 34 of 83 | NARRATIVE | Page footer; no requirement. |
| 35 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 35 | SCR-026 - Project Reports | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 35 | Primary lifecycle: Cross-phase \| Screen baseline number: 26 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 35 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 35 | Project analytics for progress, workload, deadlines, risks, cost and completion evidence. | BUILT | Purpose: app/(internal)/projects/[projectId]/reports/page.tsx |
| 35 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 35 | Tasks/completion/in-progress/review | BUILT | Stats Completion, Tasks (done/total, overdue) ; in-progress/review counts in Task Distribution donut and Overview |
| 35 | Phase progress | BUILT | Card "Phase Progress" |
| 35 | Team activity | BUILT | Card "Team Activity" |
| 35 | Resource usage | BUILT | Card "Resource Usage" (hours per person) |
| 35 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 35 | Completion trend | BUILT | Card "Task Completion Trend" (weekly, over ?from&to) |
| 35 | Task distribution | BUILT | Card "Task Distribution" (status donut + priority bars) |
| 35 | Deadlines | BUILT | Card "Upcoming Deadlines" |
| 35 | Risks/issues | BUILT | Card "Risks & Issues" (QA defects, blockers) |
| 35 | Project health | BUILT | Card "Project Health" (projectHealth, evidence-based reasons) |
| 35 | Export report | BUILT | Export CSV and Export PDF links -> app/api/projects/[projectId]/report(/pdf) |
| 35 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 35 | Change date range | BUILT | Date range form ?from= &to= (default last 12 weeks) |
| 35 | Export PDF/CSV | BUILT | Export routes: /report (CSV) and /report/pdf; links in the Export section |
| 35 | Open underlying risk/task/event | BUILT | Risks link to QA, tasks to Board, "Recent Activity" rows link to their records (W2 build) |
| 35 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 35 | Health must be evidence-based, not a generic green badge | BUILT | projectHealth lists reasons from blocked tasks, overdue, defects, dependencies; not a generic badge (src/modules/projects/project-health.ts) |
| 35 | Financial and AI cost data may be restricted to internal roles | BUILT | Money, margin and CSV money lines only with invoice.read (page mayReadMoney, both export routes); AI cost is shown to internal readers of the project only (all of this app's project screens are internal) |
| 35 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 35 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page and both export routes check project.read; money behind invoice.read |
| 35 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | read-only screen; export is a GET of what the reader may already see |
| 35 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Date range filter; links to the underlying lists. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 35 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | No drawer: cards link to the underlying pages (Board, QA, Team). |
| 35 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/reports); earlier audit B.md measured the same for all 18 routes. |
| 35 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 35 | Confidential \| Page 35 of 83 | NARRATIVE | Page footer; no requirement. |
| 36 | PROJECTS | NARRATIVE | Module label (sidebar group); no requirement. |
| 36 | SCR-027 - Project Settings, Activity & Templates | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 36 | Primary lifecycle: Cross-phase \| Screen baseline number: 27 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 36 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 36 | Administrative project configuration plus immutable activity history and reusable project templates. | BUILT | Purpose: app/(internal)/projects/[projectId]/settings/page.tsx, activity/page.tsx, app/(internal)/settings/templates (+ [templateId]) |
| 36 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 36 | Project metadata | BUILT | Settings "Project details" form (name, description, dates, budget) + "Type, technology and tags" + visibility |
| 36 | Defaults | BUILT | Settings "Default assignee" (projects.default_assignee_id) and "Phase notifications" (watchers) |
| 36 | Notification settings | BUILT | Settings "Phase notifications" WatchersPanel (project_watchers; org defaults at /settings/project-defaults) |
| 36 | Template selection | BUILT | Settings "Project template" selection (TemplateSelectForm) |
| 36 | Activity count | BUILT | Stat "Activity events" = same feed as the Activity page |
| 36 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 36 | Settings | BUILT | Settings page (all of the above) |
| 36 | Activity timeline | BUILT | /activity timeline from the audit trail via projects.project_activity + record events; now searchable and filterable by kind [built in this trace]  |
| 36 | Project template detail | BUILT | /settings/templates/[templateId] detail (counts of modules, features, milestones, scope items, tasks, onboarding) |
| 36 | Clone template | BUILT | clone_project_template door ("Clone" on the template page) |
| 36 | Pause/cancel controls | BUILT | ProjectStatusForm in Settings (pause/cancel) |
| 36 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 36 | Edit permitted metadata | BUILT | ProjectDetailsForm / ProjectClassificationForm gated project.write |
| 36 | Set default assignees | QUESTION | Q-B4: "Set default assignees" is plural; a project has ONE default assignee today (projects.default_assignee_id; the Settings form picks one member). Question: should a project have several defaults (for example one per project role)? |
| 36 | Configure phase notifications | BUILT | WatchersPanel: choose phases; others only with project.sign_off |
| 36 | Create template from project | BUILT | SaveTemplateButton on the Overview ("Save as template", project.write) |
| 36 | Pause/cancel with reason | BUILT | ProjectStatusForm: a move to on hold/cancelled requires a reason (setProjectStatus), recorded and audited |
| 36 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 36 | No setting may bypass hard approval/payment/security gates | BUILT | All settings are doors over their own gates; none writes payment/approval/security state (no such field exists on these forms); the pause door keeps the project transition table PROJECT_TRANSITIONS |
| 36 | Every critical configuration change creates an audit event | BUILT | projects, project_members, project_links, project_templates audited by trigger; defaults/watchers through audited doors; Settings lists "Audit events for this project" |
| 36 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 36 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; each form's service re-checks project.write (or project.sign_off for others' watches, organization.settings for org defaults) |
| 36 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | see previous row: critical changes (status, details, template, members) audited |
| 36 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Activity page: search + kind chips [built in this trace] ; templates list. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 36 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Forms in place; template detail is its own page. |
| 36 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/settings); earlier audit B.md measured the same for all 18 routes. |
| 36 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 36 | Confidential \| Page 36 of 83 | NARRATIVE | Page footer; no requirement. |
| 37 | REQUIREMENTS & SCOPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 37 | SCR-028 - Requirements Dashboard | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 37 | Primary lifecycle: Phase 1-5 \| Screen baseline number: 28 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 37 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 37 | Portfolio of requirement sets, clarification status, scope freeze state and change-request pressure. | BUILT | Purpose: app/(internal)/requirements/page.tsx (/requirements): requirement versions awaiting decision, scope per project, queues, drift |
| 37 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 37 | Projects with open questions | BUILT | Stat "Projects with open questions" [built in this trace] (was a Queue Health row; now a header tile) |
| 37 | Awaiting client confirmation | BUILT | Stat "Awaiting client confirmation" [built in this trace] (dashboard.awaitingClientConfirmation) |
| 37 | Frozen scopes | BUILT | Stat "Frozen scopes" (projects with a frozen baseline) |
| 37 | Open change requests | BUILT | Stat "Open change requests" (+ awaiting approval caption) |
| 37 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 37 | Requirement sets by project | BUILT | Card "Requirement sets by project" (scope version, open items; rows open /projects/[id]/requirements) |
| 37 | Open-question queue | BUILT | Card "Open-question queue" (requirement clarifications, oldest first) |
| 37 | Scope drift alerts | BUILT | Card "Scope drift" (unsettled change requests -> /scope) |
| 37 | Recent requirement changes | BUILT | Card "Recent requirement changes" |
| 37 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 37 | Open requirement set | BUILT | Row links to /projects/[id]/requirements; "Requirements List" card opens the lead for the extracted version |
| 37 | Request clarification | BUILT | RequirementsDoors "Request clarification" (raise_requirement_clarification door, task.write): app/(internal)/requirements/requirements-doors.tsx |
| 37 | Create change request | BUILT | "Create change request" form in the same doors component (milestone.write) |
| 37 | Export scope summary | BUILT | "Export scope summary (CSV)" -> /api/requirements/scope-summary |
| 37 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 37 | A requirement is never silently edited after approval; changes create a new version or change request | BUILT | crm.requirement_versions is append-only except status (migration 20260808120001 guard); edits are new versions (revise door); a frozen scope version and its items are immutable (migration 20260821180000: "a frozen scope version is immutable"), changes go through change requests / a new draft |
| 37 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 37 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page can(lead.read); doors re-check milestone.write / task.write |
| 37 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | requirement_versions, scope_items, projects audit triggers; clarification doors audited |
| 37 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | DomainSearch over projects, scope-state and open-item chips, paging. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 37 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | No drawer: rows open the project requirements page (dedicated page for the workflow). |
| 37 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/requirements); earlier audit B.md measured the same for all 18 routes. |
| 37 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 37 | Confidential \| Page 37 of 83 | NARRATIVE | Page footer; no requirement. |
| 38 | REQUIREMENTS & SCOPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 38 | SCR-029 - Requirement Set / Detail | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 38 | Primary lifecycle: Phase 1-5 \| Screen baseline number: 29 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 38 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 38 | Structured project requirements with sources, acceptance status, feature mapping and unresolved questions. | BUILT | Purpose: lead tab RequirementSetPanel app/(internal)/leads/[leadId]/requirement-set-panel.tsx + project list app/(internal)/projects/[projectId]/requirements/page.tsx |
| 38 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 38 | Version/status | BUILT | Header line: version badge, status ("Proposed/Accepted..."), "n% covered", questions, links count (panel head) |
| 38 | Source records | BUILT | Header: "Source records" - transcript anchors and "Questions raised on the project", links cited by quotation/baseline/breakdown |
| 38 | Coverage percentage | BUILT | Coverage meter "% of included items have both a screen and a test-plan item" (coverage) |
| 38 | Open questions | BUILT | Open questions count (panel head + Questions section) |
| 38 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 38 | Objectives | BUILT | Section "Objectives" |
| 38 | User roles | BUILT | Section "User roles" |
| 38 | Features | BUILT | Section "Features" |
| 38 | Platforms | BUILT | Section "Platforms" |
| 38 | Integrations | BUILT | Section "Integrations" |
| 38 | Business rules | BUILT | Section "Business rules" |
| 38 | Non-functional requirements | BUILT | Section "Non-functional requirements" |
| 38 | Excluded items | BUILT | Section "Excluded items" |
| 38 | Questions | BUILT | Section "Questions" |
| 38 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 38 | Edit draft | BUILT | Revise door (requirement-revise-service, creates a new version) on the lead tab and Edit forms on a draft baseline |
| 38 | Request client clarification | BUILT | Per-requirement "Request clarification" (project requirements detail, W4) |
| 38 | Approve/freeze | BUILT | Lead tab Accept/Reject decision and Scope tab freeze (freeze_scope_version, SCR-030) |
| 38 | Link to quotation/design/development task | BUILT | Requirement detail shows quotations priced from the scope, development tasks under the feature and design links; source requirement set card (W4-BUILD) |
| 38 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 38 | Every requirement must have stable identity/version | BUILT | REQ-00n identity + "Scope vN"; requirement_versions numbered per lead and immutable (decision #5 keeps only priority/assignee editable after freeze) |
| 38 | Source transcript or manual origin must be retained for traceability | BUILT | Transcript anchors per extracted item retained on the version (payload source anchors) and a manual origin label; panel renders them |
| 38 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 38 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | lead page requires lead.read, project page project.read; revise/clarify doors re-check their capability |
| 38 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | requirement_versions has audit_row_change; clarification and link doors audited |
| 38 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Requirement list on the project page: search/filter by status; lead tab is per lead. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 38 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Requirement detail panel on the project page (?req=). |
| 38 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/leads/[id] (Requirements tab) and /projects/[id]/requirements); earlier audit B.md measured the same for all 18 routes. |
| 38 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 38 | Confidential \| Page 38 of 83 | NARRATIVE | Page footer; no requirement. |
| 39 | REQUIREMENTS & SCOPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 39 | SCR-030 - Scope Versions & Freeze | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 39 | Primary lifecycle: Phase 1-5 \| Screen baseline number: 30 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 39 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 39 | Formal scope baseline manager used to prevent scope drift and connect quote, design, development and change requests. | BUILT | Purpose: app/(internal)/projects/[projectId]/scope/page.tsx |
| 39 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 39 | Current frozen version | BUILT | Stat "Frozen baseline vN" |
| 39 | Included/excluded counts | BUILT | Same stat caption "n in / n out of scope" (scopeIn/scopeOut) |
| 39 | Revision allowance | BUILT | Stats "Design/UI/Prototype revision rounds" show used / limit, default 0 / DEFAULT_REVISION_LIMIT before a phase opens |
| 39 | Linked quote version | BUILT | Linked quote version (readScopeQuoteLinks) on the baseline card |
| 39 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 39 | Version comparison | BUILT | Version comparison ?compare= (Added/Removed/Changed, matched on title, says so) |
| 39 | Freeze checklist | BUILT | Freeze checklist "Before freezing" (FreezeCheck list on the draft) |
| 39 | Included vs excluded | BUILT | Included vs Excluded lists in ScopeVersionCard |
| 39 | Approval evidence | BUILT | Approval evidence section (readScopeApprovals, approval-form.tsx) |
| 39 | Drift detection | BUILT | Section "Drift from the frozen baseline" (readScopeDrift) |
| 39 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 39 | Freeze scope | BUILT | ScopeVersionCard Freeze button (freeze_scope_version door) |
| 39 | Create new version | BUILT | OpenScopeVersionForm "new draft" |
| 39 | Compare versions | BUILT | Compare versions select |
| 39 | Unfreeze only through governed override if permitted | BUILT | UnfreezeScopeVersionForm: owner override with reason (scope-unfreeze-service.ts, owner only) |
| 39 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 39 | Frozen scope is immutable | BUILT | Frozen scope version and its items are immutable in the database (migration 20260821180000, exceptions "a frozen scope version is immutable" / "its items cannot be changed"); only the owner unfreeze override with a reason (SCR-030) reopens it |
| 39 | Later requests must be classified rather than appended silently | BUILT | Change requests are classified (7 classes) and applied to open the next draft; nothing appended silently |
| 39 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 39 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; freeze/open/unfreeze require milestone.write/owner in the service and DB door |
| 39 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | scope versions, items and change requests are audited (audit triggers + doors) |
| 39 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Change request list filter ?crStatus &crClass; version history compare. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 39 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Inline cards; comparison is a section of the page. |
| 39 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/scope); earlier audit B.md measured the same for all 18 routes. |
| 39 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 39 | Confidential \| Page 39 of 83 | NARRATIVE | Page footer; no requirement. |
| 40 | REQUIREMENTS & SCOPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 40 | SCR-031 - Change Requests & Traceability | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 40 | Primary lifecycle: Phase 4-8 \| Screen baseline number: 31 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 40 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 40 | End-to-end change-request workflow for classification, impact, pricing/payment, approval and implementation traceability. | BUILT | Purpose: change-request section of app/(internal)/projects/[projectId]/scope/page.tsx and app/(internal)/projects/[projectId]/change-request-panel.tsx |
| 40 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 40 | Open/awaiting approval/paid/in progress/completed/rejected counts | BUILT | Stats Open, Awaiting approval, Approved not applied, Applied, Rejected, Captured impact (CR counts); Paid / In progress shown in the request's payment gate card and invoice ledger |
| 40 | Revision allowance usage | BUILT | Revision rounds tiles (same as SCR-030) |
| 40 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 40 | Request detail | BUILT | Request detail card per change request |
| 40 | Classification: in-scope/small-free/paid/new project/clarification/duplicate/rejected | BUILT | Classification select with all seven: in scope, free change, paid change, new project, clarification, duplicate, rejected (ClassifyForm) |
| 40 | Impact analysis | BUILT | Impact notes + effort hours + days in ClassifyForm; "Captured impact" tile |
| 40 | Approval | BUILT | Approve and Reject forms in change-request-panel.tsx |
| 40 | Payment gate | BUILT | "Payment gate" block: quotation, the request's own invoice, verified status |
| 40 | Linked tasks | BUILT | Resulting tasks listed (readChangeRequestContext) |
| 40 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 40 | Classify, estimate, approve/reject, send quotation, trigger finance, implement after payment where required | BUILT | ClassifyForm, estimate fields, Approve/Reject, SendQuotationForm (proposal.send), TriggerFinance (invoice.create), ApplyButton gated on payment |
| 40 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 40 | New scope never bypasses commercial approval | BUILT | Paid change cannot apply before its invoice is verified (applyGate); "Apply" opens the next scope draft |
| 40 | All state changes and client decisions are auditable | BUILT | Every transition is a door writing audit rows (classify, decide, apply); client decisions recorded through the approval engine |
| 40 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 40 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | classify/apply milestone.write; send quotation proposal.send; trigger finance invoice.create, each in its service and DB door |
| 40 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | change_requests state changes audited; client decisions in the approval engine |
| 40 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Status and classification filters on the list. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 40 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Request cards expand inline. |
| 40 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/scope (change requests)); earlier audit B.md measured the same for all 18 routes. |
| 40 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 40 | Confidential \| Page 40 of 83 | NARRATIVE | Page footer; no requirement. |
| 41 | DESIGN & PROTOTYPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 41 | SCR-032 - Design Dashboard | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 41 | Primary lifecycle: Phase 3-4 \| Screen baseline number: 32 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 41 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 41 | Main design workspace showing UI status, screens, versions, prototype builds, reviews and client approval. | BUILT | Purpose: app/(internal)/projects/[projectId]/design/page.tsx (project design workspace) and app/(internal)/design/page.tsx (portfolio) |
| 41 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 41 | Total screens/designed/approved | BUILT | Stats "Total Screens", "Designed Screens" [built in this trace] (design_state drawn or reviewed), "Approved Screens" |
| 41 | Design versions | BUILT | Stat "Design Versions" (design deliverables, in review/approved caption) |
| 41 | Prototype builds | BUILT | Stat "Prototype Builds" |
| 41 | Pending reviews | BUILT | Stat "Pending Review" (internal + admin) |
| 41 | UI status | BUILT | Stat "UI Status" [built in this trace] (latest Phase 4 UI version status) + "Phase Status"; also repaired a 404 link /ui-versions to /ui-versions/[id] or /prototype |
| 41 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 41 | Screen gallery | BUILT | Section "Screens" gallery (grid/list, views All/Completed/In Progress/Pending, search) |
| 41 | Design versions | BUILT | Card "Design Versions" |
| 41 | Recent activity | BUILT | Card "Recent Activity" (readDesignActivity) |
| 41 | Prototype links | BUILT | Card "Prototype Links" |
| 41 | Project design progress | BUILT | Card "Design Progress" |
| 41 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 41 | Add screen | BUILT | Add screen: /design/screens AddScreenForm |
| 41 | Open Figma reference | BUILT | Themes tab "Open Figma reference" link from recorded file key + node |
| 41 | Upload design | BUILT | UploadDesignAssetPanel (stored through the asset door; storage unreachable locally, not exercised) |
| 41 | Submit for review | BUILT | SubmitDesignReviewPanel (submit_deliverable) |
| 41 | Open prototype | BUILT | Prototype Links card -> /prototype and preview pages |
| 41 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 41 | Admin must see which samples were sent, which option client selected and all revision history | BUILT | Final tab "What was sent to the client", decisions, revision history; Themes tab selected option; samples sent per option (readSampleScreens) |
| 41 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 41 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; design doors re-check project.write; delivery roles only for client sharing (record_design_share) |
| 41 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | deliverables, theme options, phase rows, assets audited by doors/triggers; design activity feed reads them |
| 41 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Screens search + status views; portfolio /design now has a project/queue search [built in this trace]  Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 41 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Inline panels; screen detail and builds are their own pages. |
| 41 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/design); earlier audit B.md measured the same for all 18 routes. |
| 41 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 41 | Confidential \| Page 41 of 83 | NARRATIVE | Page footer; no requirement. |
| 42 | DESIGN & PROTOTYPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 42 | SCR-033 - UI Theme Finalization | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 42 | Primary lifecycle: Phase 3 \| Screen baseline number: 33 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 42 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 42 | Controls the locked Phase 3 theme/color selection flow before full screen design begins. | BUILT | Purpose: app/(internal)/projects/[projectId]/design/themes/page.tsx, colors/page.tsx, final/page.tsx (Phase 3 flow) |
| 42 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 42 | Screen-list readiness | BUILT | Stat "Screen list" (baseline Finalized/Open) = screen-list readiness |
| 42 | Theme options count | BUILT | Stat "Theme Options" |
| 42 | Color combinations | BUILT | Stat "Colour Combinations" |
| 42 | Internal reviewer | BUILT | Stat "Design Reviewer" |
| 42 | Admin/client decision status | BUILT | Stat "Decision Status" |
| 42 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 42 | Theme option cards | BUILT | Section "Theme options" cards |
| 42 | Color variants | BUILT | Colors tab: color variants per direction |
| 42 | Reference uploads | BUILT | Colors tab UploadDesignAssetPanel fixedKind reference (storage not exercised locally) |
| 42 | Internal design review | BUILT | Section "Internal review" |
| 42 | Admin review | BUILT | Section "Admin decisions" (confirm / edit with reason) |
| 42 | Client selection | BUILT | Final tab client selection ("What the client said") |
| 42 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 42 | Generate/record 2-3 theme directions and 2-3 color variants each | BUILT | RecordDirectionPanel / RecordVariantPanel record 2-3 directions and 2-3 variants under the database ceiling (theme_option_limit; "two or three, and not one more") |
| 42 | Approve/edit internally | BUILT | Internal Pass / Ask for changes, Admin Confirm/Edit door (submit_admin_design_decision, src/modules/projects/design.ts; forms in design/design-forms.tsx) |
| 42 | Send approved options to client | NOT-BUILDABLE | Sending needs a client channel: none is configured (recorded decisions BLK-003/007). Built instead: "What to send the client" copy + record_design_share records what a person sent, delivery roles only |
| 42 | Record selected theme/color | BUILT | Final tab record of the client choice (record_client_design_decision) selects theme/color |
| 42 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 42 | Initial options must go internal reviewer -> Admin -> PM/client | BUILT | Order gated in the database: internal review passed before Admin, Admin approved before share (migrations 20260919120000 the_order_is_the_control, 20260919130000 only_what_admin_approved) |
| 42 | Client-selected theme/color becomes the locked input to Phase 4 | BUILT | Client choice locks into Phase 4 (finalize + handoff "Final direction and Phase 4 handoff") |
| 42 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 42 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | pages project.read; every decision door checks its role in the service and DB |
| 42 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | phase_three, theme_options, reviews and decisions audited by doors |
| 42 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Few rows by design (2-3 options): no search needed. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 42 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Option cards inline with forms. |
| 42 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/design/themes); earlier audit B.md measured the same for all 18 routes. |
| 42 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 42 | Confidential \| Page 42 of 83 | NARRATIVE | Page footer; no requirement. |
| 43 | DESIGN & PROTOTYPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 43 | SCR-034 - Screen Inventory | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 43 | Primary lifecycle: Phase 3-4 \| Screen baseline number: 34 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 43 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 43 | Complete screen list with state coverage so no required screen, role, empty state or error state is missed. | BUILT | Purpose: app/(internal)/projects/[projectId]/design/screens/page.tsx |
| 43 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 43 | Total planned/designed/approved/missing screens | BUILT | Stats "Planned Screens", "Designed Screens", "Approved", "Missing Screens" (included requirements with no screen) |
| 43 | Role/device filters | BUILT | Role, device and status filters (GET form) |
| 43 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 43 | Screen table/gallery | BUILT | Screens table with role grouping and "By category" (screens.category) |
| 43 | Category/user-role grouping | BUILT | Role/category grouping |
| 43 | State coverage | BUILT | State columns and "Missing states" tile |
| 43 | Responsive coverage | BUILT | "Responsive coverage" tile |
| 43 | Requirement links | BUILT | Requirement column / unmapped flag |
| 43 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 43 | Add/merge/split screen record | BUILT | AddScreenForm, MergeScreensForm, SplitScreenForm (on an open baseline; a finalized baseline refuses by decision, page says so) |
| 43 | Mark design state | BUILT | DesignStateForm per row |
| 43 | Open screen detail | BUILT | Rows link to /design/screens/[screenId] |
| 43 | Export inventory | BUILT | CSV export link of the inventory |
| 43 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 43 | Every screen must link back to accepted requirements | BUILT | Screen detail "Required requirement links" + unmapped counter; approve_screen refuses unmapped? (mapping shown) - links shown per screen |
| 43 | Missing states block design completeness | BUILT | approve_screen refuses a screen with missing states (migration 20261006400100) |
| 43 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 43 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; screen doors gate() with project.write and DB doors |
| 43 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | screens, baselines audited by doors |
| 43 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Filters role/device/status, grouping. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 43 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Screen detail is its own page. |
| 43 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/design/screens); earlier audit B.md measured the same for all 18 routes. |
| 43 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 43 | Confidential \| Page 43 of 83 | NARRATIVE | Page footer; no requirement. |
| 44 | DESIGN & PROTOTYPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 44 | SCR-035 - Screen Detail / Coverage Matrix | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 44 | Primary lifecycle: Phase 4 \| Screen baseline number: 35 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 44 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 44 | Detailed specification for a single screen including components, interactions, states and requirement coverage. | BUILT | Purpose: app/(internal)/projects/[projectId]/design/screens/[screenId]/page.tsx |
| 44 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 44 | Screen name/status/version | BUILT | Header: name, status badge, version/baseline |
| 44 | Device targets | BUILT | Device targets in Definition and States and fields |
| 44 | Requirement references | BUILT | Requirement references (mapped scope items list, MapScopeItemForm) |
| 44 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 44 | Component list | BUILT | ListCard "Required sections"/components (components list from stored fields) |
| 44 | Navigation paths | QUESTION | Q-B5: navigation paths are free text (entry point, exit action, dependencies). Question: should navigation be structured links between screens (a new table) instead? |
| 44 | Buttons/actions | QUESTION | Q-B6: actions are one free-text field. Question: should buttons/actions be a structured list per screen (a new table)? |
| 44 | Loading/empty/error/success states | BUILT | States card (loading/empty/error/success) with add/remove state |
| 44 | Responsive notes | BUILT | Definition card includes responsive coverage per device |
| 44 | Design preview | BUILT | Card "Design preview" (linked asset image or Figma frame) |
| 44 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 44 | Attach Figma frame | BUILT | FigmaUrlForm "Save link" |
| 44 | Add state | BUILT | States and fields: add/remove state |
| 44 | Map requirement | QUESTION | Q-B7: Map requirement is offered while the baseline is open; a finalized baseline refuses it by design. Question: offer "draft the next baseline" there? |
| 44 | Submit screen for QA/review | BUILT | SubmitForQaForm |
| 44 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 44 | QA must confirm all required sections/buttons/components/navigation before design approval | BUILT | Design Approval panel: approve_screen refuses until states are drawn and QA confirmed (confirm_screen_qa, owner/ops admin) |
| 44 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 44 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | page project.read; doors re-check project.write; QA confirm owner/ops admin |
| 44 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | screen doors audited |
| 44 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Single record: no list to search. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 44 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | The page is the detail surface for a screen. |
| 44 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/projects/[id]/design/screens/[screenId]); earlier audit B.md measured the same for all 18 routes. |
| 44 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 44 | Confidential \| Page 44 of 83 | NARRATIVE | Page footer; no requirement. |
| 45 | DESIGN & PROTOTYPE | NARRATIVE | Module label (sidebar group); no requirement. |
| 45 | SCR-036 - Design Review & Approval | NARRATIVE | Screen title; the route is named in the Purpose row. |
| 45 | Primary lifecycle: Phase 3-4 \| Screen baseline number: 36 of 71 | NARRATIVE | Lifecycle metadata for when the screen is used and its number in the 71-screen baseline; no behaviour of its own. |
| 45 | Purpose | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 45 | Internal, Admin and client review queue for UI designs with explicit edit/confirm loops. | BUILT | Purpose: app/(internal)/projects/[projectId]/design/final/page.tsx + app/(internal)/design/page.tsx review queue |
| 45 | Header / Summary / KPI area | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 45 | Awaiting internal review | BUILT | Stat "Awaiting Internal Review" |
| 45 | Awaiting Admin | BUILT | Stat "Awaiting Admin" |
| 45 | Awaiting client | BUILT | Stat "Awaiting the Client" |
| 45 | Revision count | BUILT | Stat "Revision Count" (n of limit) |
| 45 | Main content and sub-screens | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 45 | Review queue | BUILT | /design "Review queue (n)" lists every theme option at a gate and every design/prototype deliverable in review |
| 45 | Before/after preview | BUILT | Final tab preview of what was sent and Themes tab option preview with before/after of revisions (revision history with decisions) |
| 45 | Comments | BUILT | design review comment thread (design-review-comments, migration 20261006400100) |
| 45 | Decision log | BUILT | Decision log (internal review, Admin decisions, client decisions) |
| 45 | Revision history | BUILT | "Revision history" section |
| 45 | Primary actions | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 45 | Internal reviewer approve/request change | BUILT | Internal review Pass/Ask-for-changes forms |
| 45 | Admin confirm/edit | BUILT | Admin confirm/edit forms |
| 45 | PM send to client after Admin approval | BUILT | record_design_share restricted to delivery roles after Admin approval; Final tab shows what each option waits for |
| 45 | Record client confirm/change | BUILT | "Record what they said" client confirm/change; open a revision round |
| 45 | Guardrails, status rules and traceability | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 45 | After initial Admin approval, client revision loop returns through designer/QA/PM as locked | BUILT | Revision round returns the option to designer then internal review; the 2-3 limit stops (migration 20260919160000 the_limit_is_a_stop); locked order in the database |
| 45 | No approval is implied by upload alone | BUILT | Assets/designs uploaded as draft; approval is a person (ApproveAssetButton); submit_deliverable raises review, upload alone approves nothing |
| 45 | Implementation checklist for this screen | NARRATIVE | Section heading; states no requirement (the bullets under it are rows below). |
| 45 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | pages project.read; decisions role-gated in services and doors |
| 45 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | review decisions, shares, client answers audited (approval engine + audit) |
| 45 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Portfolio /design: search [built in this trace] ; queue sorted longest first. Error and retry: app/(internal)/error.tsx (shared "Try again" boundary, G-054); empty states carry an action. |
| 45 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Rows open the decision surface (dedicated page). |
| 45 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390x844 in this trace: no horizontal overflow, status 200 (/design and /projects/[id]/design/final); earlier audit B.md measured the same for all 18 routes. |
| 45 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Page footer; no requirement. |
| 45 | Confidential \| Page 45 of 83 | NARRATIVE | Page footer; no requirement. |
