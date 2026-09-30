# PDF gap audit, slice B: SCR-019 to SCR-036 (PDF pages 28-45)

Method: rendered, owner session (owner@local.test), 1536x1024 for content and 390x844 for overflow. Every route below was opened, its
`main` text and control list dumped, and tabs, drawers, dialogs and filters opened where they exist. Read-only: no write was submitted,
so anything that only appears after a write is UNVERIFIED rather than guessed. Source was read only to explain what a rendered page
does, never to upgrade a verdict. Local seed data limits what can be seen, and each screen notes where.

Seed-data limits that cause UNVERIFIED items:
- Supabase Storage is unreachable in this stack. `/files` shows "Storage is not reachable (bucket project-files)", so upload, download, versions, preview drawer and share links cannot be exercised.
- `crm.requirement_versions` and `projects.ui_versions` are empty, so SCR-029's nine sections and the UI-version detail page cannot render.
- Only one project has a frozen baseline with a finalized Phase 3 (zztest-g299 `4b7f18c6-...`) and none has a Phase 4 UI version.
- Only the owner role was used. Role-gated variants are UNVERIFIED.

Projects used: Northwind `41f1a273-...` (overview, board, calendar, milestones, plan, files, team, reports, settings, activity, tasks);
`5fc5a2ea-...` (frozen scope v2, requirements list); `b5115cb4-...` (draft scope); `f2fa1163-...` and `3a000bb4-...` (submitted change requests);
`4b7f18c6-...` (Phase 3 complete: design, themes, colors, final, screens, screen detail); `3269356a-...` (design deliverables in review).

## Summary

| SCR | Screen | Elements | PRESENT | PARTIAL | MISSING | UNVERIFIED | DECIDED |
|---|---|---|---|---|---|---|---|
| 019 | Project Overview | 25 | 21 | 4 | 0 | 0 | 0 |
| 020 | Project Board | 21 | 17 | 3 | 1 | 0 | 0 |
| 021 | My Tasks | 20 | 18 | 1 | 0 | 1 | 0 |
| 022 | Project Calendar | 17 | 13 | 3 | 0 | 1 | 0 |
| 023 | Milestones / Gantt | 21 | 16 | 4 | 1 | 0 | 0 |
| 024 | Project Files | 23 | 13 | 2 | 1 | 7 | 0 |
| 025 | Project Team | 21 | 11 | 6 | 1 | 2 | 1 |
| 026 | Project Reports | 21 | 18 | 1 | 0 | 2 | 0 |
| 027 | Settings, Activity, Templates | 23 | 18 | 4 | 1 | 0 | 0 |
| 028 | Requirements Dashboard | 19 | 15 | 2 | 1 | 1 | 0 |
| 029 | Requirement Set / Detail | 25 | 7 | 1 | 0 | 17 | 0 |
| 030 | Scope Versions & Freeze | 21 | 20 | 1 | 0 | 0 | 0 |
| 031 | Change Requests | 22 | 16 | 2 | 1 | 3 | 0 |
| 032 | Design Dashboard | 22 | 18 | 3 | 0 | 1 | 0 |
| 033 | UI Theme Finalization | 23 | 20 | 2 | 0 | 1 | 0 |
| 034 | Screen Inventory | 19 | 16 | 3 | 0 | 0 | 0 |
| 035 | Screen Detail / Coverage | 19 | 15 | 3 | 0 | 1 | 0 |
| 036 | Design Review & Approval | 21 | 17 | 4 | 0 | 0 | 0 |
| | **Total** | **383** | **289** | **49** | **7** | **37** | **1** |

Each screen's element count is Purpose (1) + header items + main/sub-screen items + primary-action items + guardrail items + the 5 generic implementation-checklist lines. The checklist lines are judged as: server-side permission (every page calls `can()` and renders PermissionDenied, read in source), audit trail, search/filter, drawers, and tablet/mobile. Mobile: all 18 routes at 390px have zero horizontal overflow (measured). Error and retry states were never triggered and are UNVERIFIED everywhere (see cross-cutting).

---

## SCR-019 Project Overview (p.28)
Route: `/projects/41f1a273-...` (full page). PRESENT: 21.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Health" | PARTIAL | Tile says "On track - No blockers, nothing overdue" while the same project has 1 Blocked task (board) and Reports says "Blocked - 1 task is blocked". The PDF forbids "a generic green badge" (p.35). Header "Overall progress" shows 0% while the board header shows 17%. | Derive the Overview health from the same evidence as Reports (blocked tasks, overdue, defects). One progress figure everywhere. |
| Main "Phase progress" | PARTIAL | Four tiles (Phase 3 Design, 5 Plan, 6 QA, 7 Handover) plus text "Task 2 (Phase 4) has not started". No Phase 1, Phase 2 or Phase 4 tile on this project. | A tile per phase 1-8 showing state. |
| Primary action "Create task/meeting/file" | PARTIAL | "+ Task" and "Link a file" work. The calendar shortcut is "Propose a meeting on <date>", a request, not a created meeting. | Create-meeting action, or document that a meeting is requested. |
| Guardrail "Admin must see every phase output: onboarding, UI choices, plans, QA evidence, payment gates, deployment and handover" | PARTIAL | Seen: design trail, plan, QA, handover tiles and the payment ladder. Missing on this project: onboarding result (Phase 2 block only appears on some projects), a Phase 4 UI-choices/prototype tile, and deployment. | One evidence tile each for onboarding, UI choices (Phase 4) and deployment. |

Observations (data, not counted): two milestones are both named "M1 - Advance" (13 Oct), which shows twice in the timeline, upcoming events and payment plan.

## SCR-020 Project Board (p.29)
Route: `/projects/41f1a273-.../board`. Task drawer opened on the Blocked task. Board/List/Calendar toggle, filters, sort, group-by exercised. PRESENT: 17.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Move task only through valid state transitions" | PARTIAL | Drawer status select offers all five states. The guarded hand-off (Mark ready for QA, needs evidence, never while blocked) exists only on `/development/tasks/[id]`, with no link from the drawer. Whether the board refuses an illegal drag is UNVERIFIED (no writes made). | Show only legal next states in the drawer, or route hand-off to the evidence-gated door. |
| "Link evidence" | PARTIAL | Drawer "Attachments": kind screenshot/log/url/file, title, link. Everything is a link. The real test-evidence form (test/implementation/review/other) is only on the task page. | Evidence form in the drawer, or a link to the task page. |
| "Blocked state must capture blocker type, owner and next action" | PARTIAL | Status Blocked shows one free-text "Reason" (Save). No blocker type, owner or next action field. | Structured blocker type, owner, next action. |
| "Agent-generated work is not complete until required verification passes" | MISSING | No marker on cards or drawer showing a task was agent-generated, and no verification state or gate in the board or drawer. | Origin badge plus a verification gate before Completed. |

## SCR-021 My Tasks (p.30)
Routes: `/my-tasks`, `?view=list`, `?view=calendar`; task drawer on the Blocked task. PRESENT: 18. KPI tiles (Assigned, Due today, Overdue, Waiting for review, Blocked) all present.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Submit for review" | PARTIAL | Only the drawer status select ("In review"). No evidence prompt or distinct submit action. | A submit-for-review action that asks for evidence. |
| "Task scope and permissions inherit from project role" | UNVERIFIED | Only the owner role was used. | Check as a member or contractor. |

## SCR-022 Project Calendar (p.31)
Route: `/projects/41f1a273-.../calendar` (month), plus the week, day and list links. PRESENT: 13. No project meetings exist, so meeting rows never rendered.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Task/milestone/meeting/deadline filters" | PARTIAL | Toggles for Task, Milestone, Meeting only (plus Overdue/Today legend). No separate "deadline" type. | Deadline filter, or confirm deadlines equal task due dates. |
| "Create task/milestone/meeting" | PARTIAL | "+ task", "+ milestone" per day. The third control is "Propose a meeting on <day>". | Create meeting, not only propose. |
| "Open source record" | PARTIAL | A task row links to `/board` (the list, not the task). A milestone links to `/plan` (no milestone selected). | Deep link to the exact task or milestone. |
| "Changes must preserve history and notify affected owners" | UNVERIFIED | No reschedule control on the calendar. Edits happen on task or milestone. Notification not exercised (no writes). | Verify on an edit. |

"Sync supported calendars": a private ICS feed ("Create my feed URL", subscribe from Google/Apple/Outlook) is present (not clicked, so generation is UNVERIFIED). It is one-way only.

## SCR-023 Project Milestones / Gantt (p.32)
Routes: `/projects/41f1a273-.../milestones` (detail panel, "Mark as Completed", "Edit milestone") and `/plan` (List/Gantt/Calendar, payment milestones). PRESENT: 16.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Dependency list" | MISSING | No dependency view on Milestones or Plan. `plan_milestone_dependencies` is read in `queries.ts` but no page renders it. The plan's own dependencies need an active plan (this project has none) and are UNVERIFIED. | A milestone dependency list in the detail panel. |
| Header "Final delivery date" | PARTIAL | Milestones page: "15 Nov 2026, 76 days left" (76 days is to the 15 Dec project due date). Plan page: "Final delivery -". The two pages disagree. | One definition of final delivery. |
| Main "Gantt" | PARTIAL | Bars are derived windows (previous due date to due date), labelled as such. Two milestones are undated and listed under "Undated". No stored start date (inventory says so). | Start dates on milestones, or keep as labelled. |
| Guardrail "Locked financial triggers: Phase 2 30%, Phase 4 complete 20%, Phase 5 complete 30%, Phase 6 complete 20%" | PARTIAL | Shares are a free plan ("Any split totalling 100% works - 30/20/30/20, 5/10/30/20/35, or whatever"), editable via "Configure payment plan" (up to 5 rows). Milestones are M1 Advance, M2 Design sign-off, M3 Build, M4 Go-live, not tied to Phase 2/4/5/6 completion. "No verified payment means no paid progression" is present: verified % ladder and "final phase stays shut". | Bind the four locked triggers to phase completion, or record an owner decision. No decision on record in `owner-decisions.md`, `CONFIGURABILITY_AUDIT` or `REMAINING_GAPS`. |

Also seen: "Milestone tasks" panel says "No task is filed under this milestone" for M1. Completing a milestone (gate rules) and "Generate draft" invoice were not clicked.

## SCR-024 Project Files (p.33)
Route: `/projects/41f1a273-.../files` (Grid/List, New Folder dialog, `?view=trash`). PRESENT: 13. Storage is unreachable, so storage-backed features cannot be verified.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Folder tree" | PARTIAL | A flat list of 10 category folders with counts (01_Requirements ... 10_Other). Nested folders are a path field in New Folder/Rename ("mockups/mobile"). No expandable tree was seen (no nested folders exist). | Expandable tree for nested folders. |
| Main "Preview drawer" | UNVERIFIED | Source has a preview drawer for stored images/PDFs. Only a link file exists here (opens Drive externally). | Verify with storage up. |
| Main "Version history" | UNVERIFIED | Says "expand a row for its versions". No stored file to expand. | Same. |
| Actions "Upload", "download", "version", "share internally" | UNVERIFIED | Upload form says "Storage is not reachable, so uploads are refused". | Same. |
| "Generate secure handover link only when permitted" | UNVERIFIED | "public share links" is mentioned in copy. No stored file, so no control rendered. | Same. |
| Guardrail "Suggested standard folders: Requirements, Designs, Development, QA, Deployment, Documents, Meetings, Assets, Builds" | PARTIAL | Folders are Requirements, Design, Development, QA, Deployment, Marketing, Documents, Assets, Builds, Other. No "Meetings". "Marketing" and "Other" are extra. | Add a Meetings folder. |
| Guardrail "Secrets/credentials must never be stored in normal shared project files" | MISSING | No warning on the Upload or Link form, no secret detection. | Warning text, or a scan or block. |

Decision note: `AGENCYOS_ADMIN_REMAINING_GAPS.md` line 197 still says the file model is "link-based by decision", which is stale (the page has stored objects and versions).

## SCR-025 Project Team (p.34)
Route: `/projects/41f1a273-.../team`. PRESENT: 11. "Project Members (3)" lists Sonu Shah, probe and member with department, project role and Remove.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Purpose "visible internal AI agent assignments where authorized" | PARTIAL | Agents appear only on the Overview ("Assigned agents (0)"), not on Team. | Agents section on Team. |
| Header "Total members by role" | PARTIAL | KPI "Total members 1 - Everyone with a task". The page lists 3 project members. Two rosters with different counts. | Count project members by project role. |
| Header "Active now" | DECIDED | "Active today - wrote an audit row today". Owner decision #2 (2026-10-03): no Online indicator, keep "last active". | None. |
| Header "Project manager" | PARTIAL | Only a separate "Delivery Lead" card below. A "Project manager" project role exists in the select. | PM shown in the header. |
| Header "Specialists" | MISSING | No specialists count. | Add. |
| Main "Role distribution" | PARTIAL | "1 Member, Owner 1 (100%)": computed from task holders, not project roles. | Compute from project roles. |
| Main "Permission summary" | PARTIAL | A column of raw keys ("project.write, milestone.write, +4 more") for task holders only. No per-role summary. | Per-role permission summary. |
| Action "View workload" | PARTIAL | Only "Tasks done 0/5" and the Reports "Resource usage" hours. No workload view. Capacity tracking was declined for sprints (decision #1) but not for workload. | Open-task load per member. |
| "Client-facing communication shows team roles, not AI provider/model internals" | UNVERIFIED | Client portal is outside this slice. | Check. |
| "Role changes are owner/admin controlled and audited" | UNVERIFIED | Role select present. No write made. | Verify audit row. |

"Manage project-specific defaults" is PRESENT via Settings "Default assignee". The team page's "Default team" is agency-wide.

## SCR-026 Project Reports (p.35)
Route: `/projects/41f1a273-.../reports`. PRESENT: 18. Date range, Export CSV and Export PDF links, tiles, completion trend, distribution, phase progress, deadlines, risks, health, time and money all render.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Open underlying risk/task/event" | PARTIAL | Risks link to QA and tasks to Board. "Recent Activity" rows are not links. | Link events to their records. |
| "Export PDF/CSV" | UNVERIFIED | Links exist (`/api/projects/.../report` and `/pdf`). Files not downloaded or inspected. | Download and check. |
| "Financial and AI cost data may be restricted to internal roles" | UNVERIFIED | Owner only. | Check as a restricted role. |

## SCR-027 Project Settings, Activity & Templates (p.36)
Routes: `/projects/41f1a273-.../settings`, `/activity`, `/settings/templates`, Overview "Save as template" dialog. PRESENT: 18.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Activity count" | PARTIAL | "Activity events 0 (tasks, milestones, change requests)" next to "Audit rows 14". | Count the real activity. |
| Main "Activity timeline" | PARTIAL | `/activity` says "Nothing yet". It is composed only from completed tasks, met milestones and change requests. Status changes, file links, deliverables and the 14 audit events do not appear. Those live on the Overview "Recent activity" (2 items) and the Settings audit list. The PDF wants an immutable history. | One timeline built from audit plus domain events. |
| Main "Project template detail" | PARTIAL | `/settings/templates` shows one summary line ("1 module, 0 features, 5 milestones ..."). No detail view. | Template detail page. |
| Main "Clone template" | MISSING | Only "Delete". No clone, rename or edit. | Clone action. |
| Main "Pause/cancel controls" | PARTIAL | On the Overview ("Move project", reason required), not on Settings. The Settings page says so. | Link or control in Settings. |

"Create template from project" (Overview header) and "Configure phase notifications" (Settings watcher table) are PRESENT. A project-level default assignee is one person, not several.

## SCR-028 Requirements Dashboard (p.37)
Route: `/requirements`. PRESENT: 15. KPIs, Requirement sets by project (21 rows), Scope drift (8), Recent changes, Queue Health, Quick Actions, Create change request and Export scope summary (CSV link) render.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Action "Open requirement set" | PARTIAL | Every row links to the project's Scope tab, not to a requirement set or the lead's versions. | Link to the requirement set. |
| Action "Request clarification" | PARTIAL | Raises a plan question only. Every project in the select reads "no plan yet". It is not a client clarification on a requirement. | Client clarification on a requirement. |
| Main "Open-question queue" | UNVERIFIED | Only counts ("Open clarifications 0", "Projects with open questions 0"). No list rendered (empty). | Check with open questions. |
| Checklist "search/filtering where list size can grow" | MISSING | The 21-row project table has no search, filter, sort or pagination. | Add filters. |

Note: "Frozen scopes 25" is labelled "scope versions past draft" and counts versions (20 projects), not projects.

## SCR-029 Requirement Set / Detail (p.38)
Routes: lead `/leads/00000000-...0301` (Requirements tab; empty state), `/projects/5fc5a2ea-.../requirements` (REQ-001 to REQ-004, detail panel), `/projects/41f1a273-.../requirements` (empty). No requirement versions exist in the local DB, so the PDF's sections cannot render. PRESENT: 7 (purpose, stable identity/version on REQ-00n and "Scope v2", checklist rows).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header: Version/status, Source records, Coverage percentage, Open questions | UNVERIFIED | The lead Requirements tab shows "No conversation yet". Source has version badges, transcript anchors, a coverage meter and open-question count. | Seed a requirement version and re-check. |
| Main: Objectives, User roles, Features, Platforms, Integrations, Business rules, Non-functional requirements, Excluded items, Questions (9) | UNVERIFIED | Source `requirement-set-panel.tsx` has all nine by name. Not rendered here. | Same. |
| Actions: Edit draft, Request client clarification, Approve/freeze | UNVERIFIED | Decision/revise forms exist in source. Freeze is on the Scope tab (PRESENT there, SCR-030). | Same. |
| Action "Link to quotation/design/development task" | PARTIAL | Project REQ detail shows "Related Items: Design Screens -, Test Cases 0, Plan Deliverables -". No quotation or development-task link. | Quotation and task links. |
| Guardrail "Source transcript or manual origin must be retained" | UNVERIFIED | Transcript anchors are in source. | Same. |

Structural: the requirement set is split across the lead tab (extracted versions) and the project list (scope items REQ-00n). `/requirements` never links to either, only to Scope.

## SCR-030 Scope Versions & Freeze (p.39)
Routes: `/projects/5fc5a2ea-.../scope` (frozen v2, `?compare=`), `/projects/b5115cb4-.../scope` (draft with freeze checklist). PRESENT: 20. Current version, included/excluded counts, linked quotation field, version comparison, freeze checklist ("Before freezing"), included vs excluded, approval evidence, Freeze, new draft, and "Unfreeze (owner override)" all render.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Revision allowance" | PARTIAL | Three tiles show "-" ("client rounds used of the Phase 3 limit", "of the Phase 4 limit") when no phase is open. No allowance number is shown. The Phase 3 Final tab does show "2 of 2 rounds used". | Show the allowance and usage on the scope page. |

Comparison matches on title only (stated on the page), so a renamed item shows as removed plus added.

## SCR-031 Change Requests & Traceability (p.40)
Routes: same Scope tab, change-request section on `5fc5a2ea-...` (implemented paid change, Payment gate card), `f2fa1163-...` and `3a000bb4-...` (submitted, Classify form). PRESENT: 16. All seven classifications are in the select (In scope, Free change, Paid change, New project, Clarification, Duplicate, Rejected).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Open/awaiting approval/paid/in progress/completed/rejected counts" | PARTIAL | Tiles: Open, Approved not applied, Applied ("0 rejected" as a caption), Paid, In progress, Awaiting payment. No tile labelled awaiting approval or rejected. | Tiles for each PDF state. |
| Header "Revision allowance usage" | PARTIAL | Same dash tiles as SCR-030. | As SCR-030. |
| Main "Linked tasks" | UNVERIFIED | No change request with linked tasks exists. The one implemented request shows no tasks section. | Verify with linked tasks. |
| Actions "approve/reject" and "send quotation" | UNVERIFIED | No request in classified or pending_approval state. "Trigger finance" appears only as instruction text. | Verify in those states. |
| Checklist "search/filtering" | MISSING | Change-request list has no filter. | Filter by status/classification. |

## SCR-032 Design Dashboard (p.41)
Routes: `/design` (portfolio with realtime header), `/projects/4b7f18c6-.../design` (full), `3269356a-.../design` (Phase 3 not started), `/prototype`. PRESENT: 18.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Design versions" and "Prototype builds" | PARTIAL | The KPI tiles are Total Screens, Approved Screens, Approved Assets, Theme Options, Pending Review and Phase Status. Versions and prototype builds are sections below with counts, not KPIs. | KPI tiles. |
| Action "Open Figma reference" | PARTIAL | "Figma node NODE-1 - recorded, not checked" is plain text on the option, and there is no Figma link on the Overview. Screen detail has a "Save link" field (nothing attached). | A clickable Figma link. |
| Action "Upload design" | UNVERIFIED | Form present, storage unreachable. | Verify. |

## SCR-033 UI Theme Finalization (p.42)
Routes: `/projects/4b7f18c6-.../design/themes`, `/colors`, `/final`. PRESENT: 20.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header KPIs (screen-list readiness, theme options, colour combinations, reviewer, decision status) | PARTIAL | The Themes tab has no KPI strip. The numbers sit on the Colors tab (combinations 1, directions 2) and the Overview (baseline 100%, design reviewer). Decision status is per-option badges. | KPI strip on the Themes tab. |
| Action "Send approved options to client" | PARTIAL | Final tab says "AgencyOS cannot send this - there is no channel configured. Send it yourself, then record what you sent" (copy-paste text and a record form). May be environment-dependent. | Send through a configured channel. |
| Main "Reference uploads" | UNVERIFIED | Upload form present, storage unreachable. | Verify. |

Generate/record 2-3 directions, internal Pass/Ask-for-changes, Admin confirm/edit, client selection and lock to Phase 4 are PRESENT.

## SCR-034 Screen Inventory (p.43)
Route: `/projects/4b7f18c6-.../design/screens` (finalized baseline) and `41f1a273-.../design/screens` (Add screen, Merge selected forms). PRESENT: 16. Role, device, status filters, state columns, requirement column, CSV export link, detail links and the design-state select render.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Total planned/designed/approved/missing screens" | PARTIAL | Tiles: Screens, Approved, Missing states, Drawn or reviewed, Responsive coverage, Submitted for QA. No "planned" or "missing screens". | Add planned/missing screen counts. |
| Main "Category/user-role grouping" | PARTIAL | Group options are "No grouping" and "By role" only. No category grouping. | Group by category. |
| Guardrail "Missing states block design completeness" | PARTIAL | Both screens are Approved while "Missing states 2". The Overview lists the state gap as non-blocking (only three flags are "refused by the database"). | Block approval or completion on missing states. |

"Every screen must link back to accepted requirements": PRESENT as an "unmapped" flag. Both seed screens are still Approved while unmapped, though the Overview labels that flag "refused by the database". "Split" is in source only (not rendered).

## SCR-035 Screen Detail / Coverage Matrix (p.44)
Route: `/projects/4b7f18c6-.../design/screens/ceeaa8a1-...`. PRESENT: 15. Definition, states checkboxes, device targets, components, responsive coverage, design preview, Figma link, Submit for QA and a Record panel all render.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Navigation paths" | PARTIAL | Free-text "Entry point"/"Exit action" plus a Dependencies list ("Not recorded"). No navigation graph or links to other screens. | Linked navigation paths. |
| Main "Buttons/actions" | PARTIAL | A single free-text "Actions" field. | Structured action list. |
| Action "Map requirement" | UNVERIFIED | The map form is shown only while the baseline is open. Here the baseline is finalized and the screen is unmapped with no control. | Check on a draft baseline. |
| Guardrail "QA must confirm all required sections/buttons/components/navigation before design approval" | PARTIAL | Status Approved with QA "Not submitted" and "Required sections (0)". No QA confirmation gates approval. | Gate approval on QA confirmation. |

The inventory maps SCR-035 to `/projects/[id]/ui-versions/[uiVersionId]`. No UI versions exist, so that page was not rendered (a nonexistent id returns not found).

## SCR-036 Design Review & Approval (p.45)
Routes: `/projects/4b7f18c6-.../design/final`, `/design` (queue and KPIs), `/projects/4b7f18c6-.../design/themes`. PRESENT: 17. Before/after preview, revision history, decision log (internal review plus Admin decisions), client decisions, "Open a revision round", "Record what they said" and assets uploaded as Draft (no approval on upload) are present.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Awaiting internal review / Admin / client, Revision count" | PARTIAL | KPIs are on the `/design` portfolio (0/0/0) and "2 of 2 rounds" on the project. The Final tab has no KPI strip. | KPI strip on the review screen. |
| Main "Review queue" | PARTIAL | `/design` shows "Artifacts in review 2" but "Review queue (0)" lists only theme options at a gate. The two design deliverables in review (project 3269356a) are in no queue, and that project's design page says "Phase 3 has not started". | One queue that includes deliverables. |
| Main "Comments" | PARTIAL | Only reviewer result/comments in the Internal review and Admin decision logs. No comment thread on an option. | Comment thread. |
| Action "PM send to client after Admin approval" | PARTIAL | A manual "Record what was sent". No PM-specific step or gate. | PM send step gated on Admin approval. |

---

## Cross-cutting
- **Filters and search:** present on Board, My Tasks, Files, Screens, Requirements list, Reports (date range). Absent on the `/requirements` dashboard table and the change-request list.
- **Saved views, bulk actions, pagination:** none on any of these screens (the PDF does not name them for these pages).
- **Empty states:** good and specific everywhere seen (board column "No tasks", "Nothing yet", "No requirements yet", etc.).
- **Loading, error and retry:** never triggered, so UNVERIFIED everywhere. The PDF asks for "concise empty/error states and retry paths".
- **Permission-denied:** every page calls `can()` and renders PermissionDenied (source). Only the owner role was rendered, so role-gated variants are UNVERIFIED.
- **Audit trail links:** Settings has "Audit events for this project" and "Full audit log" (`/audit?subject=project`). Board edits are audited (inventory). The Activity tab is not an audit view (see SCR-027).
- **Drawers:** task drawers (Board, My Tasks) and milestone detail panel present. File preview drawer UNVERIFIED (storage).
- **Realtime indicator:** `/design` shows "Connecting / Updated just now / Refresh". Other pages have none.
- **Responsive:** 390x844, zero horizontal overflow on all 18 routes.
- **Consistency defects seen (affect several screens):** three different progress figures (0% Overview, 17% Board, 0% Reports), final-delivery date and days-left disagree between Milestones and Plan, and the Overview Health tile contradicts the Reports Health tile.
- **Storage unreachable:** blocks verification of upload, versions, preview and share links (SCR-024, 032, 033).
