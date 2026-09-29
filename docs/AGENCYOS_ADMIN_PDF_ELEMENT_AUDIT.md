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
| 001 | Global date range and organization selector | PARTIAL | Date-range chips exist; no organization selector (the shell shows the org name only) |
| 001 | Today: meetings, due items, reminders, payment verifications | PARTIAL | Follow-up reminders are not in the Today card |
| 001 | Project health table | PARTIAL | Stage, milestone progress and due date only; no health/risk indicator |
| 001 | Finance gate queue | PARTIAL | A "Payments to verify" tile only; no finance-gate queue |
| 001 | Quick actions: Add lead, Create project, Create invoice, Open approval | PARTIAL | Only via the header Create/⌘K; no "Open approval" quick action on the dashboard |
| 001 | KPI click opens the corresponding filtered list | PARTIAL | Several tiles open unfiltered lists (leads created, projects on hold, invoices issued) |
| 001 | Acknowledge/escalate an operational item | PARTIAL | Feed links to Notifications; escalate there is a link, not a recorded action |
| 002 | Result sections grouped by entity type | PARTIAL | Flat table with a Type column; only lead, client, project, invoice are searched |
| 002 | Quick preview drawer | MISSING | No drawer on the search page or palette |
| 002 | Advanced filter builder | PARTIAL | Type chip and fixed day windows only |
| 003 | Severity chips: critical, action required, warning, information | PARTIAL | Urgent / Normal only |
| 003 | Notification detail drawer | MISSING | Rows link straight to the source record |
| 003 | Escalation destination / Escalate to owner or ops admin | PARTIAL | A link to Approvals; nothing recorded |
| 004 | Create task / Create quotation / Schedule meeting | PARTIAL | Palette entries navigate to the page; no in-place form |
| 004 | Create change request | MISSING | No palette entry |
| 004 | Context-aware create drawer / Pre-fill client or project | PARTIAL | Project and invoice forms do not pick up the current client or project |
| 004 | Recent commands | MISSING | Only recent searches |
| 004 | Save draft when creation is interrupted | MISSING | Palette state resets on open |

## Sales & CRM (005–013)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 005 | Pipeline value chart | PARTIAL | Stat tile, no chart |
| 005 | Today tasks / Upcoming meetings / Recent sales activity | MISSING ×3 | Not on the page |
| 005 | Open lead or quotation from card | PARTIAL | Cards link to the lead only |
| 005 | Add lead, meeting, follow-up | PARTIAL | No buttons on the page |
| 005 | Export filtered pipeline | PARTIAL | Export ignores the filters |
| 006 | Search by name, phone, email, company | PARTIAL | Email is not matched |
| 006 | Lead preview drawer | MISSING | Rows link to Lead 360 |
| 006 | Assign owner, update stage, set next follow-up, add tag (bulk) | PARTIAL | Next follow-up not in the bulk bar |
| 007 | Current deal stage/value | PARTIAL | Value only inside the edit form |
| 007 | Last contact and next follow-up | PARTIAL | "Last activity" is the row's updated time, not last contact |
| 007 | Follow-ups sub-screen | PARTIAL | Sequences not shown on the lead |
| 007 | Create quotation after requirements are accepted | PARTIAL | Drafting is not gated on an accepted requirement |
| 008 | AI suggestion vs human decision | MISSING | Score is deterministic; no AI-vs-human view |
| 008 | Approve/override score with reason | MISSING | No override door |
| 008 | Return to discovery when evidence is incomplete | PARTIAL | qualified → qualifying only via nurture |
| 009 | Source transcript references | PARTIAL | Counts and ids; no links to the transcript |
| 009 | User roles / Platforms / Integrations / Timeline-budget notes | PARTIAL ×4 | Coverage quotes or qualification form, not part of the versioned requirement |
| 010 | Link meeting to lead/client/project | PARTIAL | Meetings belong to a lead; project link only via memory attach |
| 011 | Quote count and total value | PARTIAL | No overall total |
| 011 | Status filters / Client-project-service filters / Validity-expiry filters | PARTIAL ×3 | No superseded/expired, no project/service, no expired filter |
| 011 | Delivery status | PARTIAL | Sent date only; no delivered/read/failed |
| 012 | Quotation number/date/validity | PARTIAL | No quotation number in the composer |
| 012 | Terms & conditions | PARTIAL | Only in the PDF, not editable in the composer |
| 012 | Preview PDF | PARTIAL | No preview before saving |
| 013 | Due today, overdue, upcoming, paused, failed | PARTIAL | No overdue/upcoming split, no failed count |
| 013 | Lead/client/project context | PARTIAL | Rows link to the lead only |
| 013 | Reactivation cohort | PARTIAL | Link to Import only |
| 013 | Schedule, reschedule, complete, pause, cancel | PARTIAL | Stop and Resume only |

## Clients (014–017)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 014 | Total, active, completed, pending, total revenue | PARTIAL | No completed/pending; invoiced is not revenue |
| 014 | Add/edit client | PARTIAL | No client edit door |
| 015 | Settings tab | PARTIAL | Owner and tags in the side panel; no tab |
| 015 | Create project | PARTIAL | Links to the lead; does not use the manual project door |
| 015 | Schedule meeting | MISSING | "View all" only |
| 015 | Upload file | MISSING | Files tab is a read-only roll-up |
| 015 | Edit billing details | MISSING | No billing/GST/PAN edit form on the client |
| 015 | Manage assigned team | PARTIAL | Single relationship owner only |
| 016 | Projects by status / Milestone schedule / Change-request charges | PARTIAL ×3 | Counts and badges only; no breakdown, schedule or amounts |
| 016 | Create new service/project | PARTIAL | Link only |
| 016 | Start renewal/upsell flow | MISSING | Not built |
| 017 | Recent uploads | PARTIAL | Linked files only |
| 017 | Upload/download file | MISSING | No upload on the client |

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
| 029 | Objectives | PARTIAL | Summary only |
| 029 | User roles / Platforms / Integrations | MISSING ×3 | Not in the requirement payload |
| 029 | Business rules / Non-functional requirements | PARTIAL ×2 | Merged into "Constraints and rules" |
| 029 | Request client clarification | PARTIAL | Whole-version send only |
| 029 | Link to quotation/design/development task | PARTIAL | Read-only "Cited by" |
| 030 | Approval evidence | BUILT | `app/(internal)/projects/[projectId]/scope/approval-form.tsx` → `projects.record_scope_approval_evidence` (approved_by/at, evidence url, note) |
| 031 | Paid / in-progress counts | BUILT | `app/(internal)/projects/[projectId]/change-request-panel.tsx` — Paid / In progress / Awaiting payment tiles |
| 031 | Payment gate | BUILT | `app/(internal)/projects/[projectId]/change-request-panel.tsx` — the request's OWN invoice (`change_requests.invoice_id`) |
| 031 | Send quotation | BUILT | `app/(internal)/projects/[projectId]/change-request-panel.tsx` — `sendProposalAction` on the project's client thread |
| 031 | Trigger finance | BUILT | `src/modules/finance/change-request-invoice-service.ts` → `finance.create_change_request_invoice` (milestone-less invoice through `create_milestone_invoice`) |
| 031 | Implement after payment where required | BUILT | `projects.apply_change_request` refuses `not_invoiced` / `unpaid` for a paid change; the Apply button says so first |

## Design & Prototype (032–038)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 032 | Approved count / Design versions list / Prototype links / Upload design / Submit for review | PARTIAL ×5 | Total only; badge only; via tab; link form only; per-screen only |
| 032 | Recent activity | MISSING | None on design pages |
| 033 | Color combinations KPI / Reference uploads | PARTIAL ×2 | Listed not counted; AI imagery only |
| 033 | Generate/record 2-3 theme directions and 2-3 color variants | MISSING | Display only |
| 034 | Approved/missing counts / Category grouping / Requirement links | PARTIAL ×3 | Counts absent; role column; detail page only |
| 034 | Role/device filters / Responsive coverage | MISSING ×2 | Not built |
| 035 | Device targets / Component list / Design preview / Add state | PARTIAL ×4 | Free text; text; links; only at creation |
| 037 | Platform/type / Submit to QA | MISSING ×2 | Not on prototype page |
| 037 | Revision count / QA evidence / Client feedback | PARTIAL ×3 | Elsewhere or count/badge only |
| 038 | Approved vs draft assets / Upload-replace asset version / Mark approved | MISSING ×3 | `design_assets` has no status or versions |

## Development (039–043)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 039 | Recent commits/builds | PARTIAL | Latest build only on the dashboard |
| 039 | Escalate blocker to PM / Start QA handoff | PARTIAL ×2 | Links; no record, no gate |
| 040 | Client dependencies outstanding / Modules-features / Definition of Done | PARTIAL ×3 | Header count; on Development; "Evidence required" only |
| 040 | Frontend/backend/database/APIs/integrations/auth/business-logic breakdown | MISSING | Not built |
| 040 | Execution order | MISSING | No sequencing |
| 041 | Evidence status / Implementation notes / Test evidence / Handoff status | PARTIAL ×4 | Module-level or stand-ins |
| 041 | Start task / Mark ready for QA / Submit evidence / Reopen after QA failure | PARTIAL ×4 | Not on the task page or generic |
| 042 | Failed checks / Code-review findings / Link commit | MISSING ×3 | Not read from GitHub, no commit-task link |
| 042 | Branch detail / Pull-merge review | PARTIAL ×2 | Count; read-only PR list |
| 042 | Create task branch / Submit review / Approve-reject merge | DECLINED ×3 | Owner decision 6e: Git is read-only |
| 043 | Environment readiness / Environment matrix / Trigger build | PARTIAL ×3 | Count; cards; record only |
| 043 | Migration/API compatibility status / API contracts / DB migrations / External service configuration / Promote build after gates / Run contract-migration checks | MISSING ×6 | Not built |

## QA & Release (044–049)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 044 | Recent runs / Bug trend | MISSING ×2 | Not on `/qa` |
| 044 | Release candidate / Open run-bug-build / Assign retest / Block release / Generate QA evidence summary | PARTIAL ×5 | Per project only or badge only |
| 045 | Linked task / Import test case | PARTIAL ×2 | Scope link only; no import |
| 046 | Pass/fail/blocked counts / Start-end time / Defects created / Retest history | PARTIAL ×4 | No blocked, no start/end, no run-defect link, per-defect history |
| 046 | Rerun failed cases / Close run when complete | MISSING ×2 | No rerun, no run lifecycle |
| 047 | Bug detail / Evidence / Linked task-build | PARTIAL ×3 | Inline rows; evidence only in CSV; build not shown |
| 048 | Performance budgets / Stability incidents / Schedule suite / Compare baseline | MISSING ×4 | Not built, no decision on record |
| 048 | Attach metrics | PARTIAL | Free text |
| 049 | Security/performance/QA summary | PARTIAL | QA only |
| 049 | Deployment dependencies | MISSING | Not on release or readiness |
| 049 | Final payment verified before launch (guardrail) | PARTIAL | Release door explicitly does not gate on payment |

## Finance (050–056)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 050 | Create invoice | PARTIAL | Links to Projects |
| 051 | Draft/issued counts / GST filters / Milestone filter / Linked milestone column / Reminder history / Send by email | PARTIAL ×6 | Missing tiles/filters; email is record-only |
| 052 | Attach client proof on the invoice | PARTIAL | Only on Finance and the project page |
| 053 | Unmatched KPI / Record payment proof / Reject with reason | PARTIAL ×3 | Elsewhere |
| 055 | Project margin / Project profitability / Vendor-tool costs | PARTIAL ×3 | On the project report only; no vendor rollup |
| 055 | Budget vs actual | DECLINED | Gaps doc row 55 |
| 056 | GST configuration / Configure tax profile / Export PDF | PARTIAL ×3 | On Settings; no PDF |
| 056 | Export history | MISSING | Exports audited, not listed |

## Communication (057–061)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 057 | Unread count / Announcements due / Create announcement | PARTIAL ×3 | No unread; no due; Manage link only |
| 059 | Scheduled announcements | MISSING | No scheduling |
| 059 | Template detail / Audience-project selection / Send preview / Schedule-send | PARTIAL ×4 | Row only; no project audience; count only; no schedule time |
| 060 | Retry count / Requeue with reason | PARTIAL ×2 | No retry tile; bare Requeue |
| 060 | Escalate to Admin | MISSING | Not built |
| 061 | Open model/tool detail | PARTIAL | Agent and run drill-down only |

## AI Workforce, Operations, Governance, Integrations, Settings (062–071)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 062 | Disabled reason / Capability summary in the registry | PARTIAL ×2 | Badge only; description only |
| 063 | Current provider | PARTIAL | Model shown, provider not |
| 063 | Allowed work classes | MISSING | `work_class` exists, not rendered |
| 064 | Model availability-registry / Fallback policy-chain / Tool permissions matrix / Model budget | PARTIAL ×6 | Registry empty by design (ADM-84) with no UI to add; preferred-models text only; per agent only |
| 065 | Latency KPI / Project-provider filters / Tool calls / Replay / Cancel running / Export cost ledger | PARTIAL ×6 | Per run only; agent-status-model filters; name only; none; queued only; aggregate CSV |
| 066 | Cancel workflow | PARTIAL | Single queued job only |
| 066 | Escalate operational failure | MISSING | No control |
| 067 | Last live checks / Alert destination / Incident banner | PARTIAL ×3 | No timestamps; env var only; page-local |
| 067 | Acknowledge alert | MISSING | Bucket B item never built |
| 068 | Override center / Emergency controls | MISSING ×2 | Not built |
| 068 | Record exception/override with reason | PARTIAL | Domain-specific only |
| 069 | Role assignment / Grant-revoke role | PARTIAL ×2 | Secondary roles only, not honoured by `can()` |
| 069 | Incident/security exception history | MISSING | Bucket B item never built |
| 069 | Review access / Investigate security event | PARTIAL ×2 | Roster only; audit trail only |
| 070 | Update non-secret identifiers | PARTIAL | Edited on Settings › Communication |
| 071 | Security/integrations shortcuts / Preview impact before saving high-risk settings | MISSING ×2 | No links; no preview |
| 071 | Provider vault references / Current value-effective date-history | PARTIAL ×2 | Vault only on Agents; no per-setting history |

## Shared rules (sections 1–4)

Shared implementation (12): sectioned navigation, dark rail + light workspace + cards + compact tables, ⌘K search, Quick Create, notification bell with live count, user/role/org menu, entity header with status, sticky table headers, right drawer primitive, error boundary with reference, permission-denied component, status chips.

| Rule | Status | Gap |
|---|---|---|
| Empty states explain why and offer a next step | PARTIAL | `EmptyState` is shared but only 2 usages pass an action; many ad hoc empties |
| Responsive | PARTIAL | Hand-rolled tables on `/agents/routing` and the model registry scroll sideways |
| Help/status in header | PARTIAL | Help link only; no system-status indicator |
| Breadcrumb | PARTIAL | Module › page only, desktop only, no entity level |
| Primary + overflow actions | PARTIAL | No overflow-menu primitive |
| Search within domain | PARTIAL | Only on leads, clients, quotations, invoices, search |
| Loading skeleton | PARTIAL | `/profile`, `/search`, `/help` have no loading boundary |
| Integration unavailable/degraded state | PARTIAL | No shared component |
| Stale-data warning | PARTIAL | Shared component used on `/operations` only |
| Clear all filters | ABSENT | No shared control |
| Per-row overflow actions | ABSENT | DataTable has no row-actions slot |
| Approval actions in a drawer | ABSENT | Inline only |
| Not-found state | ABSENT | No `not-found.tsx`; Next's default 404 |

## Copy that contradicted the code (fixed 2026-09-30)

Project settings said templates were not built; the agents registry said enabling was a database decision; the approvals page said policies are configured in the database; Client 360 said broadcast was declined. All four now describe what exists.
