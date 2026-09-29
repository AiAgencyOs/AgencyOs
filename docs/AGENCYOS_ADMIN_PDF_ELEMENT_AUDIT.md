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
| 018 | Total/active/blocked/completed | PARTIAL | No blocked count |
| 018 | Phase distribution / Phase filter / Health filter | PARTIAL ×3 | Status, not lifecycle phase; "At risk" chip only |
| 018 | Archive completed project | MISSING | No archive state |
| 019 | Project links | MISSING | No links panel on the overview |
| 019 | Upcoming events | PARTIAL | Milestones only, no meetings |
| 019 | Send project update | MISSING | No control |
| 019 | Create task/meeting/file | PARTIAL | Add task link only |
| 020 | Phase/priority/assignee filters | PARTIAL | No phase filter |
| 020 | Link evidence | PARTIAL | Generic URL attachment |
| 022 | Create task/milestone/meeting from a day | PARTIAL | Milestone is a link to Plan |
| 022 | Sync supported calendars | MISSING | Not built |
| 023 | Total/completed/in-progress/pending | PARTIAL | "Late" instead of pending |
| 023 | Milestone detail panel / Milestone tasks | PARTIAL ×2 | Next milestone only; counts, no task list |
| 023 | Open tasks | MISSING | No link from milestone to tasks |
| 024 | Total files/storage | PARTIAL | No storage size |
| 024 | Folder tree | PARTIAL | Flat category grid |
| 024 | Preview drawer | MISSING | No preview |
| 024 | Rename/move stored files, share internally | PARTIAL | Rename only for links; share is a public signed link |
| 025 | Active now | MISSING | Presence not drawn |
| 025 | Invite/assign, assign/remove member, set project role, project defaults | PARTIAL ×4 | Agency-wide default team only |
| 026 | Project health | MISSING | No health panel on the report |
| 026 | Export PDF | PARTIAL | CSV only |
| 026 | Open underlying risk/task/event | PARTIAL | Card-level links only |
| 027 | Template selection on project settings | PARTIAL | Only in ⌘K Create project |
| 027 | Project template detail | PARTIAL | List with counts, no detail |

## Requirements & Scope (028–031)

| SCR | Element | Status | What is missing |
|---|---|---|---|
| 028 | Recent requirement changes | PARTIAL | Awaiting-decision queue only |
| 028 | Request clarification / Create change request from the dashboard | PARTIAL ×2 | Exist on Plan/Scope pages only |
| 028 | Export scope summary | MISSING | No route |
| 029 | Objectives | PARTIAL | Summary only |
| 029 | User roles / Platforms / Integrations | MISSING ×3 | Not in the requirement payload |
| 029 | Business rules / Non-functional requirements | PARTIAL ×2 | Merged into "Constraints and rules" |
| 029 | Request client clarification | PARTIAL | Whole-version send only |
| 029 | Link to quotation/design/development task | PARTIAL | Read-only "Cited by" |
| 030 | Approval evidence | PARTIAL | Frozen date only |
| 031 | Paid / in-progress counts | PARTIAL | Not counted |
| 031 | Payment gate | PARTIAL | Project-wide invoice counts, not the CR's invoice |
| 031 | Send quotation | PARTIAL | Link to draft on the lead |
| 031 | Trigger finance | MISSING | No invoice from a change request |
| 031 | Implement after payment where required | PARTIAL | Apply is not payment-gated |

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
| Empty states explain why and offer a next step | BUILT | Every `EmptyState` on a list page passes an `action` — pinned by `tests/the-shell-explains-itself.test.ts` |
| Responsive | BUILT | `app/(internal)/agents/routing/page.tsx` — the three tables (model registry, routing matrix, agents × categories) are `DataTable`s |
| Help/status in header | BUILT | `app/(internal)/system-status.tsx` in the layout, fed by the readiness evaluator (`system-status-actions.ts`) |
| Breadcrumb | BUILT | `app/(internal)/nav.tsx` `HeaderTrail` — module › page › record (`TrailLabel`), shown from the tablet width |
| Primary + overflow actions | BUILT | `src/ui/primitives/row-actions.tsx` (`RowActionsMenu`) |
| Search within domain | PARTIAL | Only on leads, clients, quotations, invoices, search |
| Loading skeleton | BUILT | `app/(internal)/profile/loading.tsx`, `search/loading.tsx`, `help/loading.tsx` |
| Integration unavailable/degraded state | BUILT | `src/ui/primitives/integration-state.tsx`, used by `/integrations` and `/production-readiness` |
| Stale-data warning | BUILT | `src/lib/realtime/live-refresh.tsx` renders `StaleDataWarning` on every `LiveRefresh` page once the channel is not live and the page has not re-read |
| Clear all filters | BUILT | `src/ui/primitives/filter-bar.tsx` `clearHref` — leads, invoices, projects, approvals, notifications, search |
| Per-row overflow actions | BUILT | `src/ui/primitives/table.tsx` `rowActions` slot, used on `/leads` and `/invoices` |
| Approval actions in a drawer | BUILT | `app/(internal)/approvals/decide-drawer.tsx` over the same `ApprovalDecisionForm` |
| Not-found state | BUILT | `app/(internal)/not-found.tsx` (inside the shell) and `app/global-error.tsx` (the last boundary, with the reference) |

## Copy that contradicted the code (fixed 2026-09-30)

Project settings said templates were not built; the agents registry said enabling was a database decision; the approvals page said policies are configured in the database; Client 360 said broadcast was declined. All four now describe what exists.
