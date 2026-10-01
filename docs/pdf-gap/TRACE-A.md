# TRACE-A: line-level proof for PDF pages 1-27

Source: `AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`, text file `screen_architecture_fresh.txt`, pages 1 to 27 (front matter, the 71-screen inventory, SCR-001 to SCR-018). Every text line or bullet of those pages is one row below, in reading order, with the PDF's wording verbatim (soft-wrapped lines of one bullet are joined; table rows are shown cell by cell separated by `¦`; the running page footer is one row per page). The table is generated from the text file by a parser that fails if any bullet has no evidence, so no line is skipped.

Statuses: **BUILT** (the route and source file that render or enforce it, read in the source; where cheap also rendered at 1536 px and 390 px as the owner), **DECIDED** (an owner decision in `docs/ui-parity/owner-decisions.md`), **QUESTION** (open, exact question named Q-...), **NOT-BUILDABLE** (needs a credential or service that cannot exist locally), **NARRATIVE** (heading, label or sentence that states no requirement). A line with no evidence would be GAP: there are none left.

## Counts

| Status | Rows |
|---|---|
| BUILT | 528 |
| DECIDED | 6 |
| QUESTION | 5 |
| NOT-BUILDABLE | 3 |
| NARRATIVE | 215 |
| GAP | 0 |
| Total rows | 757 |

Earlier work this proof builds on: `docs/pdf-gap/A.md` (rendered audit), `W1-BUILD.md` to `W6-BUILD.md`, `X1-BUILD.md` to `X3-BUILD.md`, `docs/ui-parity/owner-decisions.md` (both rounds). Several rows that A.md called PARTIAL or UNVERIFIED were re-judged here against the running app and some turned out to be real defects (listed under "Gaps built").

## The table

| page | the PDF's text (verbatim) | status | where (route + file, or decision/question ref) |
|---|---|---|---|
| 1 | AGENCYOS - ENTERPRISE ADMIN PANEL | NARRATIVE | Document title. |
| 1 | Complete Screen Architecture | NARRATIVE | Document title. |
| 1 | 71-screen baseline with sub-screens, UI contents, actions, states, phase traceability and admin-manageability rules. | NARRATIVE | Document subtitle (scope statement); the scope itself is the 71 inventory rows on pp. 7-8 below. |
| 1 | Purpose | NARRATIVE | Section label. |
| 1 | This document is the implementation-grade screen blueprint for the AgencyOS Admin Panel redesign. It consolidates the current locked business phases, the existing Admin Panel/CRM/Project/Finance/QA/Automation/Security specifications, and the new enterprise UI direction discussed during the screen-by-screen redesign. | NARRATIVE | Describes what the document is; states no requirement of its own. |
| 1 | Core rule: every meaningful AgencyOS phase output, decision, approval, payment gate, artifact, agent action and configuration must be visible and manageable from the Admin Panel according to permission. | BUILT | The 71 screens are routed under `app/(internal)/` (inventory rows below); each phase leaves evidence on the project page `app/(internal)/projects/[projectId]/page.tsx` (eight phase tiles, rows 43-51 below); every route is capability-gated by `can()` through `app/(internal)/nav-config.ts`. |
| 1 | Baseline status: UI/UX architecture locked for implementation planning | NARRATIVE | Status line of the document. |
| 1 | Document version: 1.0 \| September 2026 | NARRATIVE | Version line of the document. |
| 2 | 1. Locked UX and Governance Principles | NARRATIVE | Section heading. |
| 2 | Enterprise information architecture: no long mixed Settings page and no unclear "ghoj-puch" placement. Every major domain gets a clear module, tabs and dedicated screens. | BUILT | Sectioned sidebar of modules with their own screens: `app/(internal)/nav-config.ts` + `app/(internal)/nav.tsx`; Settings is tabbed (`app/(internal)/settings/settings-tabs.tsx`), not one long page. |
| 2 | Admin visibility is mandatory across every phase. Example: for UI work the Admin must see theme samples sent, selected theme/color, design versions, review status and client confirmation. The same traceability applies to planning, development, QA, finance, launch and maintenance. | BUILT | Phase evidence per project: `app/(internal)/projects/[projectId]/design/themes`, `design/colors`, `design/final`, `ui-versions/[uiVersionId]`, `prototype`, `plan`, `qa`, `release`, `billing-panel.tsx`; summarised by the eight phase tiles on `app/(internal)/projects/[projectId]/page.tsx`. |
| 2 | The interface uses a consistent pattern: dark navigation sidebar, light workspace, blue primary actions, rounded cards, compact tables, status chips, strong search/filtering and contextual right drawers. | BUILT | Dark sidebar, light workspace, blue primary buttons, rounded cards, compact tables, status chips, right drawers: `src/ui/primitives/*` and tokens, written down in `docs/AGENCYOS_ADMIN_DESIGN_SYSTEM.md`; matched to the reference screenshots in `docs/ui-parity/*.md`. |
| 2 | The five-second rule applies to every screen: the user should quickly know where they are, current status, what is wrong, and the next permitted action. | BUILT | Where you are (breadcrumb, `app/(internal)/nav.tsx`), current status (entity header chip, `src/ui/primitives/entity-header.tsx`), what is wrong (Needs Action, health chips, callouts) and the next action (primary button, empty-state `action`): judged on the rendered pages of every screen in this trace. |
| 2 | Nothing becomes complete only because an AI agent says it is complete. Completion follows the relevant human/QA/payment/approval gates. | BUILT | Agents propose, people decide: `tests/the-agent-does-everything-but-decide.test.ts`, `tests/agent-verification.test.ts`, `tests/qa-gate.test.ts`, `tests/the-verification-gate-has-no-door.test.ts`; payment is verified only by a person (`tests/a-claim-is-not-a-payment.test.ts`). |
| 2 | Client-facing communication never exposes internal AI provider/model/API details. Authorized internal Admin screens may show provider/model/cost for operational control. | BUILT | Client messages cannot name a provider/model/prompt: database guard in `supabase/migrations/20260919200000_the_words_a_client_reads.sql` (PM §10); provider/model/cost appear only on admin pages gated by `audit.read` (`/agents`, `/usage`, `/agents/routing` in `app/(internal)/nav-config.ts`). |
| 2 | Every governed action must be traceable: actor, time, source record, before/after state, evidence and decision reason where applicable. | BUILT | Audit rows with actor, time, subject, before/after: `supabase/migrations/20260813120013_audit_by_trigger.sql` (extended by later migrations) and `core.record_audit` written in the same transaction (`tests/audit-in-the-transaction.test.ts`, `tests/audit-timestamp-is-server-authoritative.test.ts`); reasons are mandatory on guarded moves (e.g. `setLeadStatus` in `src/modules/crm/service.ts`). |
| 2 | Every empty state must explain why it is empty and what the user can do next; avoid giant blank boxes. | BUILT | Every `<EmptyState>` on a page passes an `action`, pinned for all top-level pages by `tests/the-shell-explains-itself.test.ts` section 3. |
| 2 | Every screen must support loading, empty, error, permission-denied and stale-data states in addition to the happy path. | BUILT | Loading: `loading.tsx` beside each route group (33 `loading.tsx` files across the 35 route folders); empty: `EmptyState`; error with reference and retry: `app/(internal)/error.tsx` -> `src/ui/primitives/error-state.tsx` (digest shown); permission denied: `PermissionDenied` (used in 91 files under app/); stale data: `src/ui/primitives/stale-data-warning.tsx` and `LiveRefresh` ("Updated just now"). Reads that fail throw instead of rendering "empty" (`tests/read-failure-semantics.test.ts`). |
| 2 | Responsive behavior: desktop full-width dashboard, tablet compact grids and drawers, mobile stacked cards with priority actions first. | BUILT | Desktop dashboard, compact grids/drawers, stacked phone cards (`src/ui/primitives/table.tsx` phone cards, `desktopOnly` columns). Measured for this trace at 390 px: no horizontal page overflow on 30 routes of these screens (list in the 390 px section of this file). |
| 2 | Source alignment | NARRATIVE | Section label. |
| 2 | The blueprint aligns to the current AgencyOS Master/Admin/CRM/Onboarding/Requirements/UI/Development/QA/Finance/Security/Automation specifications and the locked phase flows discussed in this project. Where multiple functions are closely related, they are grouped as sub-screens/tabs under one numbered screen so the baseline remains 71 unique screens/sub-screens rather than duplicating the same workspace. | NARRATIVE | States where the screens were derived from and that related functions are grouped as tabs; no requirement of its own. (Grouping is visible in `app/(internal)/nav-config.ts` `screens`.) |
| 2 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 2 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 3 | 2. Information Architecture - 71 Screen Baseline | NARRATIVE | Section heading. |
| 3 | The left sidebar should be sectioned. A user should not have to remember which unrelated setting is buried inside one page. | BUILT | The sidebar is sectioned into modules (`app/(internal)/nav-config.ts`, `visibleModulesFor`); test `tests/admin-nav-config.test.ts`. |
| 3 | Table header: Module ¦ Screens ¦ Purpose | NARRATIVE | Table header cells (Module, Screens, Purpose). |
| 3 | Global Control ¦ 001-004 ¦ Cross-system navigation, action queues and universal creation/search. | BUILT | Command Center, Notifications, My tasks lead the sidebar; search/palette/create are in the header (`app/(internal)/layout.tsx`, `command-palette.tsx`). Screens 001-004. |
| 3 | Sales & CRM ¦ 005-013 ¦ Phase 1 lead-to-close: discovery, requirements, quotation, meetings and follow-up. | BUILT | Sidebar group "Sales & CRM": Leads, Pipeline, Quotations, Meetings, Follow-ups (+ Contracts, SCR-072). Screens 005-013 (`app/(internal)/nav-config.ts`). |
| 3 | Clients ¦ 014-017 ¦ Client master records and long-term relationship context. | BUILT | Sidebar group "Clients" (/clients, Client 360 tabs). Screens 014-017. |
| 3 | Projects ¦ 018-027 ¦ Phase 2 onward project control, tasks, files, people, milestones and reports. | BUILT | Sidebar group "Projects" (/projects, /projects/[id]/* tabs, /my-tasks, /reports). Screens 018-027. |
| 3 | Requirements & Scope ¦ 028-031 ¦ Versioned requirements, scope freeze and change control. | BUILT | Sidebar group "Requirements & Scope" (/requirements). Screens 028-031. |
| 3 | Design & Prototype ¦ 032-038 ¦ Phase 3-4 UI finalization, full screen design, QA, approvals and prototype review. | BUILT | Sidebar group "Design & Prototype" (/design and the project design/prototype tabs). Screens 032-038. |
| 3 | Development ¦ 039-043 ¦ Phase 5 implementation planning, task execution, repositories, builds and dependencies. | BUILT | Sidebar group "Development" (/development and project plan/repository/builds). Screens 039-043. |
| 3 | QA & Release ¦ 044-049 ¦ Prototype/development QA through Master QA and production readiness. | BUILT | Sidebar group "QA & Release" (/qa, /production-readiness). Screens 044-049. |
| 3 | Finance ¦ 050-056 ¦ Cross-phase invoicing, payment verification, expenses, tax and profitability. | BUILT | Sidebar group "Finance" (/finance, /invoices, /invoices/verify, /finance/payments, /finance/expenses, /finance/tax). Screens 050-056. |
| 3 | Communication ¦ 057-060 ¦ WhatsApp, templates, announcements, failed deliveries and meeting summaries. | BUILT | Sidebar group "Communications" (/communication, /settings/communication, /communication/campaigns). Screens 057-060. Group name is plural, see QUESTION Q-NAV. |
| 3 | AI Workforce ¦ 061-065 ¦ Internal agent registry, model/provider routing, runs and cost traceability. | BUILT | Sidebar group "AI Workforce" (/agents, /agents/routing, /agents/automations). Screens 061-065. |
| 3 | Operations ¦ 066-067 ¦ Jobs, events, scheduler, dead letters, system health and readiness. | BUILT | Sidebar group "Operations" (/operations). Screens 066-067 (readiness also under QA & Release). |
| 3 | Governance & Security ¦ 068-069 ¦ Approvals, policies, roles, tenant isolation and immutable audit. | BUILT | Governance & Security is split in the sidebar into "Approvals" (/approvals, /governance/overrides) and "Security & Audit" (/security, /audit, /security/users). Screens 068-069. Naming: see QUESTION Q-NAV. |
| 3 | Integrations ¦ 070 ¦ External dependency lifecycle and controlled import. | BUILT | Sidebar group "Integrations" (/integrations, /import). Screen 070. |
| 3 | Organization Settings ¦ 071 ¦ Organized business rules and deployment-wide defaults. | BUILT | Sidebar group "Organization" (/settings). Screen 071 (keys also under Security & Audit). Naming: see QUESTION Q-NAV. |
| 3 | Navigation recommendation: Command Center; Sales & CRM; Clients; Projects; Requirements; Design & Prototype; Development; QA & Release; Finance; Communication; AI Workforce; Operations; Governance & Security; Integrations; Settings. | QUESTION | The sidebar does not use this exact list: it follows the reference screenshots' names (Communications, Approvals, Analytics & Costs, Security & Audit, Organization instead of Communication, Governance & Security, Settings). `app/(internal)/nav-config.ts` records that the owner chose the screenshots' list on 2026-10-03, but that choice is only in a code comment, not in `docs/ui-parity/owner-decisions.md`, and `docs/ui-parity/S.md` still lists it as open. Q-NAV: confirm the screenshot names stay (and record it), or restore the PDF's names. |
| 3 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 3 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 4 | 3. Phase-to-Admin-Panel Visibility Matrix | NARRATIVE | Section heading. |
| 4 | This is a non-negotiable requirement from the redesign discussion: every phase must leave visible, queryable evidence inside the Admin Panel. | BUILT | Statement that every phase must leave visible evidence; met by rows 43-51 below and by the phase tiles on `app/(internal)/projects/[projectId]/page.tsx` (Phase 1 to Phase 8, each linking to its evidence). |
| 4 | Table header: Lifecycle area ¦ What must be visible in Admin Panel | NARRATIVE | Table header cells (Lifecycle area, What must be visible in Admin Panel). |
| 4 | Phase 1 - Lead to Close ¦ Lead thread, qualification, accepted requirement versions, quote versions/approval, meetings, follow-ups, WON/LOST evidence. | BUILT | Lead 360 `app/(internal)/leads/[leadId]/page.tsx`: conversation, qualification (`/leads/[leadId]/qualification`), requirement versions (Extracted requirements card), quotation versions and approval (Quotations card, `/quotations` version drawer), meetings card, follow-up sequences card, WON/LOST: stage strip, lost reasons, handoff packet `/handoffs/[opportunityId]`. Phase 1 tile on the project page. |
| 4 | Phase 2 - Onboarding + Payment + Kickoff ¦ Structured handoff, client/onboarding profile, manual WhatsApp group setup task, GST/Non-GST choice, M1 invoice, Admin payment verification, Project Planning Agent blueprint, kickoff message. | BUILT | Handoff: `app/(internal)/handoffs/[opportunityId]`; onboarding profile: `app/(internal)/projects/[projectId]/onboarding-panel.tsx`; manual WhatsApp group task: `group-setup-card.tsx`; GST/Non-GST choice and M1 invoice: `billing-panel.tsx`, `/invoices`; payment verification: `/invoices/verify`; planning blueprint and kickoff: `plan/page.tsx`, `phase-two-panel.tsx`. Phase 2 tile. |
| 4 | Phase 3 - UI Finalization ¦ Final screen list, screen contents, 2-3 theme directions, color variants, internal reviewer, Admin review, client selection, selected theme/color, PM Task 1 messages. | BUILT | `app/(internal)/projects/[projectId]/design/{page,themes,colors,final,brand,screens}`: final screen list and contents (`design/screens`), 2-3 theme directions and colour variants (`design/colors`, `direction-panels.tsx`), internal reviewer and Admin review (`design-shared.tsx`, `design/final`), client selection and selected theme (`design-forms.tsx`), PM Task 1 messages (`src/modules/projects/queries.ts` task_one_complete panel). Phase 3 tile. |
| 4 | Phase 4 - UI Design + Prototype ¦ Complete Figma screens, QA coverage, Admin review, client feedback/version loops, prototype builds, prototype QA, Admin review, client confirmation, PM Task 2 completion, M2 20% trigger. | BUILT | `app/(internal)/projects/[projectId]/ui-versions/[uiVersionId]`, `prototype/*`, `phase-four-panel.tsx`: Figma links (`links-panel.tsx`, design pages), QA coverage (`design/screens` coverage matrix), Admin review, client feedback/version loops, prototype builds and QA, Task 2 completion and the M2 20% invoice (`src/modules/finance/service.ts` generateM2Invoice, `tests/m2-and-the-gate-it-actually-needs.test.ts`). Phase 4 tile. |
| 4 | Phase 5 - Full Development ¦ Development Planning Agent output, detailed technical checklist, dependencies, one-task execution, developer evidence, QA loop, Admin review, client approval, PM Task 3 completion, M3 30% trigger. | QUESTION | Planning output, checklist and dependencies (`app/(internal)/projects/[projectId]/plan/page.tsx`, `builds/page.tsx`), one-task execution with developer evidence (`development/tasks/[taskId]`), QA loop (`/qa`), Admin review and client approval are built. NOT built: an automatic PM "Task 3 complete" step and an automatic M3 invoice when Phase 5 completes: only M1 and M2 have generators (`src/lib/events/catalog.ts` generateM1Invoice / generateM2Invoice); M3 is a milestone with its trigger named in `src/modules/projects/payment-structure.ts` and is invoiced by a person from "Next to invoice". Q-PH56: should completing Phase 5 (and 6) raise the M3 (M4) invoice and send the PM Task 3 (4) message automatically, as Phase 4 does for M2? |
| 4 | Phase 6 - Master QA ¦ Master QA plan, multi-level coverage, defects, fix/retest/regression evidence, final pass, PM Task 4 completion, M4 20% trigger. | QUESTION | Master QA plan, multi-level coverage, defects, retest/regression evidence and final pass are on `/qa` and `app/(internal)/projects/[projectId]/qa/*` (test plan, runs, bugs, `qa-insights.tsx` regression). The PM Task 4 completion message and the automatic M4 20% invoice are not generated (see Q-PH56 on the Phase 5 row); M4 is invoiced by a person from the client's "Next to invoice". |
| 4 | Phase 7 - Production + Handover ¦ 100% payment gate, deployment readiness, production release, smoke check, rollback info, handover package, secure handover link, client confirmation, project completion. | BUILT | `app/(internal)/projects/[projectId]/release/page.tsx`: 100% payment gate (`release-payment-panel.tsx`, `tests/the-hundred-percent-gate.test.ts`, `tests/a-release-is-paid-for.test.ts`), deployment readiness (`deployment-deps-panel.tsx`, `/production-readiness`), release, smoke check and rollback info (`release-panel.tsx`), handover package, secure handover link and client confirmation (`handover-release-*.ts`, `tests/handover.test.ts`). Phase 7 tile. |
| 4 | Phase 8 - Customer Success ¦ Maintenance period, support tickets, bug vs new-scope classification, renewal invoices, payment verification, retention/upsell opportunities, relationship history. | BUILT | Client 360 (`app/(internal)/clients/[clientId]/page.tsx`): maintenance plan per project (Commercials card and the new "Maintenance and renewal" tile), support/maintenance items (project page Phase 8 tile, `tests/maintenance-items.test.ts`), bug vs new scope (`design-forms.tsx` six classifications, `change-request-panel.tsx`), renewal and upsell (`client-360-forms.tsx`, `src/modules/sales/renewal-actions.ts`), relationship history (Activity tab). Phase 8 tile. |
| 4 | Finance cross-phase ¦ All four milestone invoices, GST/non-GST profile, payment submissions, Admin verification, reminders, change-request payments, maintenance renewal, zero-amount free-maintenance invoice where applicable. | BUILT | `/invoices`, `/invoices/[invoiceId]`, `/invoices/verify`, `/finance/payments`, project `billing-panel.tsx`: four milestone invoices, GST/non-GST profile, payment submissions, Admin verification, reminders (`reminder-history-drawer.tsx`), change-request payments (`change-request-panel.tsx`), maintenance renewal, zero-amount free-maintenance invoice (`tests/a-bill-with-nothing-to-collect.test.ts`). |
| 4 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 4 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 5 | 4. Shared Components and Screen Rules | NARRATIVE | Section heading. |
| 5 | Global Header | NARRATIVE | Group label; the five items below are the rows. |
| 5 | Global search with keyboard shortcut | BUILT | Header search button with keyboard shortcut: `app/(internal)/layout.tsx` + `command-palette.tsx` (Ctrl/Cmd+K opens it; checked by driving the page in a browser). |
| 5 | Quick Create | BUILT | Header "Create" button: `app/(internal)/shell-controls.tsx` (CreateButton), opens the palette forms. |
| 5 | Notifications with unread count | BUILT | Header bell with the same count as the inbox: `app/(internal)/action-bell.tsx` (`countActionItemsAction`). |
| 5 | Help/status | BUILT | Help link `app/(internal)/help-link.tsx`; system status dot `app/(internal)/system-status.tsx` (`SystemStatusDot`). |
| 5 | Signed-in user, role and organization | BUILT | User menu with name, email and role (`UserMenu` in the layout) and the organization chip or switcher in the sidebar (`app/(internal)/layout.tsx`, `organization-switcher.tsx`). |
| 5 | Context Header | NARRATIVE | Group label; items below are the rows. |
| 5 | Breadcrumb | BUILT | Breadcrumb trail: `app/(internal)/nav.tsx` `trailFor`, named by `TrailLabel` on detail pages. |
| 5 | Entity title + primary status | BUILT | Entity header with title and status chip: `src/ui/primitives/entity-header.tsx` (Lead 360, Client 360, project pages). |
| 5 | Client/project/phase metadata | BUILT | Header facts (client, owner, phase, deal, requirements, hand-off): `EntityHeader facts` e.g. Lead 360 and Client 360; project `workspace-header.tsx`. |
| 5 | Primary action and overflow actions | BUILT | Primary action buttons plus an overflow menu: added to Lead 360 and Client 360 headers in this pass (`RowActionsMenu`, "More actions for this lead/client"); tables carry per-row overflow (`src/ui/primitives/row-actions.tsx`). |
| 5 | Filtering | NARRATIVE | Group label; items below are the rows. |
| 5 | Search within current domain | BUILT | Search within the current domain: `DomainSearch` on every list page; pinned for all domains by `tests/search-lives-in-every-domain.test.ts`. |
| 5 | Status/owner/date/source/project filters | BUILT | Status/owner/date/source/project filters: Leads (source/status/owner/budget/date/service), Clients (status/tag/owner), Quotations (status/client/project/service/validity), Follow-ups, Meetings, Projects (status/phase/health/client/owner); `src/ui/primitives/filter-bar.tsx`. |
| 5 | Saved views for frequent workflows | BUILT | Saved views: `app/(internal)/saved-views-bar.tsx` + `saved-views-actions.ts` (`core.saved_views`) on Leads, Clients, Projects, Quotations, Follow-ups, Meetings. |
| 5 | Clear all filters | BUILT | `FilterBar clearHref` shows "Clear all" while a filter is active; pinned by `tests/the-shell-explains-itself.test.ts` section 4; Clients and Quotations gained it in W3. |
| 5 | Tables & Boards | NARRATIVE | Group label; items below are the rows. |
| 5 | Sticky column headers on long lists | BUILT | Tables scroll inside their box with a sticky header above 12 rows: `src/ui/primitives/table.tsx` (`STICKY_FROM_ROWS`, `stickyHeader`). |
| 5 | Bulk selection only where safe | BUILT | Bulk selection only where a safe per-record door exists: Leads (`leads/bulk-actions-bar.tsx`) and Clients (`clients/bulk-bar.tsx`, per-client doors, refusals reported), Notifications (`BatchBar`); none on money or approval lists. |
| 5 | Per-row overflow actions | BUILT | `DataTable rowActions` -> `RowActionsMenu` (`src/ui/primitives/table.tsx`, `row-actions.tsx`). |
| 5 | Column sorting and pagination | BUILT | Sortable headers (`sort` prop, `src/ui/primitives/sort-rows.ts`) and `Pagination` (`pagination.tsx`, `tests/pagination-clamps-a-stale-page.test.ts`). |
| 5 | Context drawer instead of full-page navigation for small edits | BUILT | Preview drawers instead of navigation: `preview-drawer.tsx` (leads, clients, projects, invoices), `quotations/version-drawer.tsx`, `quotations/row-actions.tsx`, `follow-ups/sequence-drawer.tsx`, notification detail drawer, `approvals/decide-drawer.tsx`. |
| 5 | Right-side Drawers | NARRATIVE | Group label; items below are the rows. |
| 5 | Quick details | BUILT | Quick details: `app/(internal)/preview-drawer.tsx` over `src/lib/admin/entity-preview.ts`. |
| 5 | Edit form | BUILT | Edit form in a drawer: Clients (`clients/client-edit-form.tsx`), quotation actions (`quotations/row-actions.tsx`), approvals decision (`approvals/decide-drawer.tsx`). |
| 5 | Evidence/attachments | BUILT | Evidence/attachments in drawers: meeting evidence (`meetings/[meetingId]`), payment proof (`finance/payments/claims-drawer.tsx`), requirement links; file upload itself is not exercised here (storage unreachable locally). |
| 5 | Approval actions | BUILT | Approval actions in a drawer: `app/(internal)/approvals/decide-drawer.tsx`; quotation submit/send/answer in `quotations/row-actions.tsx`. |
| 5 | Activity history | BUILT | Activity history in drawers: notification detail "Action history", `follow-ups/sequence-drawer.tsx`, `reminder-history-drawer.tsx`, quotation `version-drawer.tsx`. |
| 5 | Audit & Evidence | NARRATIVE | Group label; items below are the rows. |
| 5 | Created by/updated by | BUILT | Created by/updated by: recorded on audit rows (`audit.audit_log.actor_id`) and shown on notes, files, evidence ("by Sonu Shah" on `meetings/[meetingId]`), client notes (`createdByEmail`). |
| 5 | Created/updated timestamps | BUILT | Created/updated timestamps on rows and audit entries; "Created on" / "Row last updated" on Lead 360 Overview; audit timestamps are server-authoritative (`tests/audit-timestamp-is-server-authoritative.test.ts`). |
| 5 | Source/reference ID | BUILT | Source/reference ID: "Copy ID" on search results (`search/copy-id-button.tsx`), quotation numbers (`Q-2026-…`), notification source references, `/audit` rows by subject id. |
| 5 | Decision history | BUILT | Decision history: `src/ui/primitives/decision-timeline.tsx` on approvals, quotation approval status link, qualification disqualification history, escalation history. |
| 5 | Linked files/requirements/tasks/events | BUILT | Linked files/requirements/tasks/events: requirement links (`requirement-link-form.tsx`), Lead 360 files and tasks cards, meeting-to-project link (`meetings/[meetingId]/project-link-form.tsx`), audit subject links. |
| 5 | States | NARRATIVE | Group label; items below are the rows. |
| 5 | Loading skeleton | BUILT | `loading.tsx` skeletons (`src/ui/primitives/skeleton.tsx`) beside the route groups of every screen in this trace (dashboard, search, notifications, sales-funnel, leads, quotations, follow-ups, meetings, clients, projects). |
| 5 | Empty with explanation and action | BUILT | `EmptyState` with explanation and `action` everywhere (row 16). |
| 5 | Error with retry and reference | BUILT | `app/(internal)/error.tsx` shows "This page could not be loaded", the digest as the reference, and a "Try again" button. |
| 5 | Permission denied | BUILT | `src/ui/primitives/permission-denied.tsx`; contractor and finance sessions get it on /leads, /quotations, /clients (rendered in the earlier audit A.md). |
| 5 | Integration unavailable/degraded | BUILT | `src/ui/primitives/integration-state.tsx` and callouts: Meetings "No calendar credential is configured", Command Center "WhatsApp (Meta): Not configured" (rendered). |
| 5 | Stale/outdated data warning | BUILT | `src/ui/primitives/stale-data-warning.tsx` (Operations scheduler age) and `LiveRefresh` ("Connecting / Updated just now / Refresh") on Dashboard, Leads, Notifications. |
| 5 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 5 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 6 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 6 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 7 | 5. Complete Screen Inventory | NARRATIVE | Section heading. |
| 7 | Table header: # ¦ Module ¦ Screen ¦ Primary lifecycle | NARRATIVE | Table header cells (#, Module, Screen, Primary lifecycle). |
| 7 | 1 ¦ Global Control ¦ Command Center ¦ Cross-phase | BUILT | `app/(internal)/dashboard/page.tsx` — sidebar item "Command Center"; proof in the SCR-001 rows below. |
| 7 | 2 ¦ Global Control ¦ Global Search ¦ Cross-phase | BUILT | `app/(internal)/search/page.tsx`, `app/(internal)/command-palette.tsx` — header search + `/search`; proof in SCR-002 rows. |
| 7 | 3 ¦ Global Control ¦ Notifications & Action Center ¦ Cross-phase | BUILT | `app/(internal)/notifications/page.tsx` — sidebar "Notifications" + header bell; proof in SCR-003 rows. |
| 7 | 4 ¦ Global Control ¦ Quick Create / Command Palette ¦ Cross-phase | BUILT | `app/(internal)/command-palette.tsx`, `app/(internal)/palette-forms.tsx` — header "Create" + Ctrl/Cmd+K; proof in SCR-004 rows. |
| 7 | 5 ¦ Sales & CRM ¦ Sales Overview & Pipeline ¦ Phase 1 | BUILT | `app/(internal)/sales-funnel/page.tsx` — sidebar "Pipeline"; proof in SCR-005 rows. |
| 7 | 6 ¦ Sales & CRM ¦ Leads List ¦ Phase 1 | BUILT | `app/(internal)/leads/page.tsx` — sidebar "Leads"; proof in SCR-006 rows. |
| 7 | 7 ¦ Sales & CRM ¦ Lead 360 ¦ Phase 1 | BUILT | `app/(internal)/leads/[leadId]/page.tsx` — proof in SCR-007 rows. |
| 7 | 8 ¦ Sales & CRM ¦ Qualification & Scoring ¦ Phase 1 | BUILT | `app/(internal)/leads/[leadId]/qualification/page.tsx` — proof in SCR-008 rows. |
| 7 | 9 ¦ Sales & CRM ¦ Requirements Discovery ¦ Phase 1 | BUILT | `app/(internal)/leads/[leadId]/page.tsx`, `app/(internal)/leads/[leadId]/requirement-set-panel.tsx` — Lead 360 requirements card; proof in SCR-009 rows. |
| 7 | 10 ¦ Sales & CRM ¦ Meetings ¦ Phase 1 + Cross-phase | BUILT | `app/(internal)/meetings/page.tsx`, `app/(internal)/meetings/[meetingId]/page.tsx` — sidebar "Meetings"; proof in SCR-010 rows. |
| 7 | 11 ¦ Sales & CRM ¦ Quotations List ¦ Phase 1 | BUILT | `app/(internal)/quotations/page.tsx` — sidebar "Quotations"; proof in SCR-011 rows. |
| 7 | 12 ¦ Sales & CRM ¦ Create / Edit Quotation ¦ Phase 1 | BUILT | `app/(internal)/quotations/new/page.tsx`, `app/(internal)/quotations/new/composer.tsx` — proof in SCR-012 rows. |
| 7 | 13 ¦ Sales & CRM ¦ Follow-ups & Nurture ¦ Phase 1 + Phase 8 | BUILT | `app/(internal)/follow-ups/page.tsx` — sidebar "Follow-ups"; proof in SCR-013 rows. |
| 7 | 14 ¦ Clients ¦ Client Management ¦ Phase 1 onward | BUILT | `app/(internal)/clients/page.tsx` — sidebar "Clients"; proof in SCR-014 rows. |
| 7 | 15 ¦ Clients ¦ Client 360 ¦ Phase 2 onward | BUILT | `app/(internal)/clients/[clientId]/page.tsx` — proof in SCR-015 rows. |
| 7 | 16 ¦ Clients ¦ Client Projects & Commercials ¦ Phase 2 onward | BUILT | `app/(internal)/clients/[clientId]/page.tsx` — Client 360 Projects/Invoices tabs; proof in SCR-016 rows. |
| 7 | 17 ¦ Clients ¦ Client Communication, Files & Notes ¦ Cross-phase | BUILT | `app/(internal)/clients/[clientId]/page.tsx` — Client 360 Communication/Files/Notes/Activity tabs; proof in SCR-017 rows. |
| 7 | 18 ¦ Projects ¦ All Projects ¦ Phase 2 onward | BUILT | `app/(internal)/projects/page.tsx` — sidebar "All projects"; proof in SCR-018 rows. |
| 7 | 19 ¦ Projects ¦ Project Overview ¦ Phase 2 onward | BUILT | `app/(internal)/projects/[projectId]/page.tsx` — line-level proof belongs to the next trace slice. |
| 7 | 20 ¦ Projects ¦ Project Board ¦ Phase 2 onward | BUILT | `app/(internal)/projects/[projectId]/board/page.tsx` — next trace slice. |
| 7 | 21 ¦ Projects ¦ My Tasks ¦ Cross-phase internal | BUILT | `app/(internal)/my-tasks/page.tsx` — sidebar "My tasks"; next trace slice. |
| 7 | 22 ¦ Projects ¦ Project Calendar ¦ Cross-phase | BUILT | `app/(internal)/projects/[projectId]/calendar/page.tsx` — next trace slice. |
| 7 | 23 ¦ Projects ¦ Project Milestones / Gantt ¦ Phase 2 onward | BUILT | `app/(internal)/projects/[projectId]/milestones/page.tsx`, `app/(internal)/projects/[projectId]/timeline/page.tsx` — next trace slice. |
| 7 | 24 ¦ Projects ¦ Project Files ¦ Cross-phase | BUILT | `app/(internal)/projects/[projectId]/files/page.tsx` — next trace slice. |
| 7 | 25 ¦ Projects ¦ Project Team ¦ Phase 2 onward | BUILT | `app/(internal)/projects/[projectId]/team/page.tsx` — next trace slice. |
| 7 | 26 ¦ Projects ¦ Project Reports ¦ Cross-phase | BUILT | `app/(internal)/reports/page.tsx`, `app/(internal)/projects/[projectId]/reports/page.tsx` — sidebar "Reports"; next trace slice. |
| 7 | 27 ¦ Projects ¦ Project Settings, Activity & Templates ¦ Cross-phase | BUILT | `app/(internal)/projects/[projectId]/settings/page.tsx`, `app/(internal)/projects/[projectId]/activity/page.tsx`, `app/(internal)/settings/templates/page.tsx` — next trace slice. |
| 7 | 28 ¦ Requirements & Scope ¦ Requirements Dashboard ¦ Phase 1-5 | BUILT | `app/(internal)/requirements/page.tsx` — sidebar "Requirements"; next trace slice. |
| 7 | 29 ¦ Requirements & Scope ¦ Requirement Set / Detail ¦ Phase 1-5 | BUILT | `app/(internal)/projects/[projectId]/requirements/page.tsx` — next trace slice. |
| 7 | 30 ¦ Requirements & Scope ¦ Scope Versions & Freeze ¦ Phase 1-5 | BUILT | `app/(internal)/projects/[projectId]/scope/page.tsx` — next trace slice. |
| 7 | 31 ¦ Requirements & Scope ¦ Change Requests & Traceability ¦ Phase 4-8 | BUILT | `app/(internal)/projects/[projectId]/scope/page.tsx`, `app/(internal)/projects/[projectId]/change-request-panel.tsx` — next trace slice. |
| 7 | 32 ¦ Design & Prototype ¦ Design Dashboard ¦ Phase 3-4 | BUILT | `app/(internal)/design/page.tsx` — sidebar "Design dashboard"; next trace slice. |
| 7 | 33 ¦ Design & Prototype ¦ UI Theme Finalization ¦ Phase 3 | BUILT | `app/(internal)/projects/[projectId]/design/themes/page.tsx`, `app/(internal)/projects/[projectId]/design/colors/page.tsx` — next trace slice. |
| 7 | 34 ¦ Design & Prototype ¦ Screen Inventory ¦ Phase 3-4 | BUILT | `app/(internal)/projects/[projectId]/design/screens/page.tsx` — next trace slice. |
| 7 | 35 ¦ Design & Prototype ¦ Screen Detail / Coverage Matrix ¦ Phase 4 | BUILT | `app/(internal)/projects/[projectId]/design/screens/[screenId]/page.tsx` — next trace slice. |
| 7 | 36 ¦ Design & Prototype ¦ Design Review & Approval ¦ Phase 3-4 | BUILT | `app/(internal)/projects/[projectId]/design/final/page.tsx`, `app/(internal)/projects/[projectId]/design/page.tsx` — next trace slice. |
| 7 | 37 ¦ Design & Prototype ¦ Prototype Builds & Review ¦ Phase 4 | BUILT | `app/(internal)/projects/[projectId]/prototype/page.tsx` — next trace slice. |
| 7 | 38 ¦ Design & Prototype ¦ Assets, Brand Kit & Feedback History ¦ Phase 3-5 | BUILT | `app/(internal)/projects/[projectId]/design/brand/page.tsx` — next trace slice. |
| 7 | 39 ¦ Development ¦ Development Dashboard ¦ Phase 5 | BUILT | `app/(internal)/development/page.tsx` — sidebar "Development dashboard"; next trace slice. |
| 7 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 7 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 8 | Table header: # ¦ Module ¦ Screen ¦ Primary lifecycle | NARRATIVE | Table header cells repeated on the continuation page. |
| 8 | 40 ¦ Development ¦ Implementation Plan ¦ Phase 5 | BUILT | `app/(internal)/projects/[projectId]/plan/page.tsx` — next trace slice. |
| 8 | 41 ¦ Development ¦ Development Task Execution ¦ Phase 5 | BUILT | `app/(internal)/projects/[projectId]/development/tasks/[taskId]/page.tsx`, `app/(internal)/projects/[projectId]/development/page.tsx` — next trace slice. |
| 8 | 42 ¦ Development ¦ Repository, Branch & Code Review ¦ Phase 5 | BUILT | `app/(internal)/projects/[projectId]/repository/page.tsx` — next trace slice. |
| 8 | 43 ¦ Development ¦ Builds, Environments & Dependencies ¦ Phase 5-7 | BUILT | `app/(internal)/projects/[projectId]/builds/page.tsx` — next trace slice. |
| 8 | 44 ¦ QA & Release ¦ QA Dashboard ¦ Phase 4-7 | BUILT | `app/(internal)/qa/page.tsx` — sidebar "QA dashboard"; next trace slice. |
| 8 | 45 ¦ QA & Release ¦ Test Plan & Cases ¦ Phase 4-6 | BUILT | `app/(internal)/projects/[projectId]/qa/page.tsx` — next trace slice. |
| 8 | 46 ¦ QA & Release ¦ Test Runs ¦ Phase 4-7 | BUILT | `app/(internal)/projects/[projectId]/qa/runs/[runId]/page.tsx` — next trace slice. |
| 8 | 47 ¦ QA & Release ¦ Bugs & Defects ¦ Phase 4-8 | BUILT | `app/(internal)/projects/[projectId]/qa/bugs/[defectId]/page.tsx` — next trace slice. |
| 8 | 48 ¦ QA & Release ¦ Regression, Compatibility & Performance ¦ Phase 5-7 | BUILT | `app/(internal)/projects/[projectId]/qa/page.tsx`, `app/(internal)/qa/page.tsx` — next trace slice. |
| 8 | 49 ¦ QA & Release ¦ Production Readiness & Release Candidate ¦ Phase 6-7 | BUILT | `app/(internal)/production-readiness/page.tsx`, `app/(internal)/projects/[projectId]/release/page.tsx` — sidebar "Production readiness"; next trace slice. |
| 8 | 50 ¦ Finance ¦ Finance Overview ¦ Phase 2-8 | BUILT | `app/(internal)/finance/page.tsx` — sidebar "Finance overview"; next trace slice. |
| 8 | 51 ¦ Finance ¦ Invoices ¦ Phase 2-8 | BUILT | `app/(internal)/invoices/page.tsx` — sidebar "Invoices"; next trace slice. |
| 8 | 52 ¦ Finance ¦ Invoice Detail / Create ¦ Phase 2-8 | BUILT | `app/(internal)/invoices/[invoiceId]/page.tsx`, `app/(internal)/invoices/new/page.tsx` — next trace slice. |
| 8 | 53 ¦ Finance ¦ Payments ¦ Phase 2-8 | BUILT | `app/(internal)/finance/payments/page.tsx` — sidebar "Payments"; next trace slice. |
| 8 | 54 ¦ Finance ¦ Payment Verification ¦ Phase 2-8 | BUILT | `app/(internal)/invoices/verify/page.tsx` — sidebar "Payment verification"; next trace slice. |
| 8 | 55 ¦ Finance ¦ Expenses & Profitability ¦ Cross-phase internal | BUILT | `app/(internal)/finance/expenses/page.tsx` — sidebar "Expenses"; next trace slice. |
| 8 | 56 ¦ Finance ¦ GST, Tax & Financial Reports ¦ Cross-phase internal | BUILT | `app/(internal)/finance/tax/page.tsx` — sidebar "GST & tax"; next trace slice. |
| 8 | 57 ¦ Communication ¦ Communication Center ¦ Cross-phase | BUILT | `app/(internal)/communication/page.tsx` — sidebar "Conversations"; next trace slice. |
| 8 | 58 ¦ Communication ¦ WhatsApp / Conversations ¦ Phase 1-8 | BUILT | `app/(internal)/communication/page.tsx`, `app/(internal)/projects/[projectId]/communication/page.tsx` — next trace slice. |
| 8 | 59 ¦ Communication ¦ Templates & Announcements ¦ Cross-phase | BUILT | `app/(internal)/settings/communication/page.tsx`, `app/(internal)/communication/campaigns/page.tsx` — sidebar "Templates", "Campaigns"; next trace slice. |
| 8 | 60 ¦ Communication ¦ Delivery Failures, Outbox & Meeting Notes ¦ Cross-phase | BUILT | `app/(internal)/operations/page.tsx` — sidebar "Jobs & system health"; next trace slice. |
| 8 | 61 ¦ AI Workforce ¦ AI Workforce Dashboard ¦ Internal cross-phase | BUILT | `app/(internal)/agents/page.tsx` — sidebar "Agents"; next trace slice. |
| 8 | 62 ¦ AI Workforce ¦ Agent Registry ¦ Internal cross-phase | BUILT | `app/(internal)/agents/page.tsx` — next trace slice. |
| 8 | 63 ¦ AI Workforce ¦ Agent Detail & Permissions ¦ Internal cross-phase | BUILT | `app/(internal)/agents/[agentKey]/page.tsx` — next trace slice. |
| 8 | 64 ¦ AI Workforce ¦ Model Routing, Providers & Tools ¦ Internal cross-phase | BUILT | `app/(internal)/agents/routing/page.tsx` — sidebar "Model routing"; next trace slice. |
| 8 | 65 ¦ AI Workforce ¦ Agent Runs, Usage, Cost & Automations ¦ Internal cross-phase | BUILT | `app/(internal)/agents/automations/page.tsx`, `app/(internal)/usage/page.tsx` — sidebar "Automations", "Usage & costs"; next trace slice. |
| 8 | 66 ¦ Operations ¦ Operations Dashboard ¦ Cross-phase | BUILT | `app/(internal)/operations/page.tsx` — next trace slice. |
| 8 | 67 ¦ Operations ¦ System Health, Production Readiness & Alerts ¦ Cross-phase | BUILT | `app/(internal)/operations/page.tsx`, `app/(internal)/production-readiness/page.tsx` — next trace slice. |
| 8 | 68 ¦ Governance & Security ¦ Approval Center, Policies & Overrides ¦ Cross-phase | BUILT | `app/(internal)/approvals/page.tsx`, `app/(internal)/governance/overrides/page.tsx` — sidebar "Approvals"; next trace slice. |
| 8 | 69 ¦ Governance & Security ¦ Security, Roles & Audit Log ¦ Cross-phase | BUILT | `app/(internal)/security/page.tsx`, `app/(internal)/audit/page.tsx` — sidebar "Security & Audit"; next trace slice. |
| 8 | 70 ¦ Integrations ¦ Integrations Center & Import ¦ Cross-phase | BUILT | `app/(internal)/integrations/page.tsx`, `app/(internal)/import/page.tsx` — sidebar "Integrations", "Import"; next trace slice. |
| 8 | 71 ¦ Organization Settings ¦ Organization Settings & Business Rules ¦ Cross-phase | BUILT | `app/(internal)/settings/page.tsx` — sidebar "Organization"; next trace slice. |
| 8 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 8 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 9 | 6. Detailed Screen-by-Screen Breakdown | NARRATIVE | Section heading. |
| 9 | Each numbered screen below includes the required content, sub-screens/tabs, allowed actions and guardrails. These are implementation requirements, not decorative suggestions. | NARRATIVE | Introduction to the per-screen sections; the requirement it states (implement them as requirements) is covered row by row for SCR-001 to SCR-018 below and by TRACE-B/C/D for the rest. |
| 9 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 9 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 10 | GLOBAL CONTROL | NARRATIVE | Module label. |
| 10 | SCR-001 - Command Center | NARRATIVE | Screen heading; the screen is at /dashboard. |
| 10 | Primary lifecycle: Cross-phase \| Screen baseline number: 1 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 10 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 10 | The owner/admin landing page. It must answer in under five seconds: what needs attention, what is blocked, what is financially gated, and what should happen next. | BUILT | `/dashboard` (`app/(internal)/dashboard/page.tsx`): five named counters, Tasks & Approvals queue, Today, Finance gate queue, System Status; rendered 1536 and 390 px. |
| 10 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 10 | Global date range and organization selector | BUILT | Date range: FilterChips "Last 30/90/180/365 days" (`OVERVIEW_WINDOWS`, `src/lib/admin/dashboard-window.ts`). Organization selector: `app/(internal)/organization-switcher.tsx` is drawn by `layout.tsx` for a person with more than one membership; with one organization the sidebar shows the organization chip (a single-organization owner has nothing to select). Switcher not exercised: the local seed has one membership per user. |
| 10 | Needs Action, Pending Approvals, Payment Verification, Blocked Projects, Failed Deliveries | BUILT | StatGrid of Needs Action, Pending Approvals, Payment Verification, Blocked Projects, Failed Deliveries (`dashboard/page.tsx`, each tile role-gated); Blocked Projects uses the projects-list health rule (`healthOfProject`). |
| 10 | Active projects and phase distribution | BUILT | "Active Projects" tile plus the "Project Phases" card (lifecycle phases with counts, each linking `/projects?phase=`), and the Project Pipeline strip. |
| 10 | Today: meetings, due items, reminders, payment verifications | BUILT | `app/(internal)/today-card.tsx` (shared with Sales): meetings today, follow-up reminders, tasks due, own overdue count, payments to verify; empty sentence when none. |
| 10 | System health: app, database, scheduler, AI provider, WhatsApp, alerting | BUILT | "System Status" card (`systemRows`): Application (new in this pass: configuration problems from the production checks, or "Serving"), Database, AI Provider, WhatsApp (Meta), Scheduler (Cron), Operational Alerts. |
| 10 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 10 | Needs Attention queue | BUILT | "Tasks & Approvals" ActivityFeed: urgent first, every row linking to its source, with Acknowledge and Escalate. |
| 10 | Today panel | BUILT | "Today" card (`today-card.tsx`). |
| 10 | Project health table | BUILT | "Active Projects" DataTable with Stage, Health (`healthOfProject`), Progress, Due Date. |
| 10 | Finance gate queue | BUILT | "Finance gate queue" card: unpaid milestone invoices (each holds a phase) and claims awaiting a decision (`src/lib/admin/finance-gate.ts` readers). |
| 10 | System/integration health strip | BUILT | "System Status" card and the "Control plane" destinations list. |
| 10 | Quick actions: Add lead, Create project, Create invoice, Open approval | BUILT | `app/(internal)/dashboard/quick-actions-row.tsx`: Add lead, Create project, Create invoice, Open approval (count), each shown only to a role that may do it. |
| 10 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 10 | KPI click opens the corresponding filtered list | BUILT | `Stat href` on every counter opens the matching filtered list (`/projects?health=blocked`, `/approvals`, `/invoices/verify`, `/operations#failed-deliveries`); `tests/a-kpi-opens-its-own-list.test.ts`. |
| 10 | Acknowledge/escalate an operational item | BUILT | `app/(internal)/notifications/acknowledge-button.tsx` -> `core.set_notification_state` and `EscalateControl` -> `core.escalate` (recorded, audited). |
| 10 | Open project, client, lead, invoice, approval or failed delivery in context | BUILT | Rows link to the lead, project, invoice, approval (`/approvals/[id]`), claim queue, or Operations (failed delivery); table rows carry "Open lead / Open project". |
| 10 | Never show a giant blank panel; empty states must explain why and what action is available | BUILT | Empty states with an action: Recent Leads, Active Projects, Finance gate "Nothing at the gate", Tasks & Approvals "Nothing needs you". |
| 10 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 10 | All phases visible through project and finance status summaries | BUILT | Pipeline strip, Project Phases, Finance gate queue and phase tiles cover every phase through project and finance status. |
| 10 | All values must be sourced from real records; no fabricated health or completion numbers | BUILT | A failed read shows "DATA UNAVAILABLE" (`Value`/`isAvailable`, `src/lib/admin/overview-eval.ts`), never a zero; `tests/read-failure-semantics.test.ts`, `tests/admin-overview-eval.test.ts`. No health or completion figure is typed. |
| 10 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 10 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Escalate/Acknowledge go through `core.escalate` and `core.set_notification_state` (`src/lib/admin/escalations.ts`, `notification-state.ts`), which re-check the caller in the database; each tile is hidden for a role without the capability (`show('invoice.read')` etc.) and its data is RLS-scoped. Role-union `can()`: `tests/a-role-union-is-honoured.test.ts`. |
| 10 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Escalations and notification state changes are rows with actor, time, from/to state (`notification_state_events`, `core.escalations`); the dashboard records nothing else. |
| 10 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Date range chips; empty states with an action; a failed read shows DATA UNAVAILABLE or `error.tsx` with the digest and "Try again"; `loading.tsx` skeleton. |
| 10 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Opens records in their own pages; the only inline control is the Escalate popover. Complex flows live on the target screens. |
| 10 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no horizontal overflow; StatGrid collapses to 2 columns, tables to cards. |
| 10 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 10 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 11 | GLOBAL CONTROL | NARRATIVE | Module label. |
| 11 | SCR-002 - Global Search | NARRATIVE | Screen heading; the screen is at /search. |
| 11 | Primary lifecycle: Cross-phase \| Screen baseline number: 2 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 11 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 11 | One search experience across leads, clients, projects, tasks, requirements, quotations, invoices, files, meetings, agents and audit events. | BUILT | `/search` (`app/(internal)/search/page.tsx`, `src/lib/admin/global-search-page.ts`): groups Lead, Client, Project, Invoice, Quotation, Meeting, Task, Requirement, File, Agent, Audit (`SEARCH_GROUPS`), rendered as chips "Leads … Audit events". |
| 11 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 11 | Search box with keyboard shortcut | BUILT | Search box on `/search` (`DomainSearch`) and the header search button with Ctrl/Cmd+K (`command-palette.tsx`). |
| 11 | Type filters and date filters | BUILT | Type chips (All types … Audit events) and date chips (Any date, Last 7/30/90 days) in `search/page.tsx`. |
| 11 | Recent searches and saved searches | BUILT | Saved and Recent searches panels (`search/saved-search-controls.tsx`, `src/lib/admin/saved-searches.ts`). Found broken in this pass and fixed: `recordSearch` compared jsonb with `.eq('filters', {})`, which sends `[object Object]`, so no recent search was ever recorded; now `.filter(..., JSON.stringify(...))`; `tests/a-recent-search-is-recorded-and-found-again.test.ts` (fails without the fix), verified live (recent "northwind" appeared). |
| 11 | Result sections grouped by entity type | BUILT | `groupResults` -> one section per entity type with a count. |
| 11 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 11 | Search results page | BUILT | `/search` results page. |
| 11 | Quick preview drawer | BUILT | `PreviewButton` -> `preview-drawer.tsx` on results of the previewable groups (`isPreviewGroup`). |
| 11 | Advanced filter builder | BUILT | `app/(internal)/search/advanced-filters.tsx`: stackable `f=field:op:value` conditions (status, owner, created), parsed by a pure tested parser (`tests/w3-inbox-search-and-client-rules.test.ts`). |
| 11 | Saved search manager | BUILT | "Saved searches" list with Edit (rename and change query, `editSearch`) and Remove (`forgetSearch`). |
| 11 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 11 | Open result in the correct 360-degree page | BUILT | Each result links to the record's own page (Lead -> /leads/id, Client -> /clients/id, Project, Invoice, Quotation, Meeting, Task, Requirement -> project requirements, File -> project files, Agent, Audit -> /audit): `global-search-page.ts`. |
| 11 | Copy reference/ID | BUILT | `search/copy-id-button.tsx` copies the reference. |
| 11 | Apply filters without losing query | BUILT | The `href()` builder in `search/page.tsx` keeps `q` when a type, date, mode or owner changes; Filter builder is a GET form that preserves them. |
| 11 | Respect tenant/role isolation | BUILT | Search reads run under the caller's RLS and `can()` hides groups the role cannot open; the page states "nothing here widens that". |
| 11 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 11 | Search must never leak records across organizations | BUILT | Organization isolation is RLS on every read; the meaning search re-reads every hit through the caller's own RLS (`src/lib/search/semantic-search.ts`) and the SQL function filters by org and role (`supabase/migrations/20261007300000_search_by_meaning.sql`); `scripts/verify-semantic-search.mjs` (finance sees only Invoice, member no Invoice/Audit/Agent). |
| 11 | AI-assisted semantic search may summarize only records the admin is already allowed to read | DECIDED | Owner decision R2 #14 (semantic search over everything searchable): built as the Keyword / Meaning / Both toggle (`semantic-controls.tsx`, `src/lib/search/*`); it returns matching records the caller may already open (no generated summary), so nothing is summarised beyond what the admin may read. `tests/search-by-meaning.test.ts`. A real embedding key is not present locally (the card says "Off"). |
| 11 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 11 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Reads run as the caller under RLS and `can()`; saved/recent searches are the caller's own rows (`core.saved_searches` RLS); backfill and stop are owner-only audited doors (`core.request_semantic_backfill`, `core.stop_semantic_indexing`). |
| 11 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Search itself writes no governed record; backfill/stop are audited by their doors; the saved/recent list is a personal preference, not a governed record. |
| 11 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | This screen is the search/filter: DomainSearch, type/date/owner/status filters; "Type at least two characters" empty state with an action; read failure throws to `error.tsx`. |
| 11 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Quick preview drawer on each result; the full record is its own page. |
| 11 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 11 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 11 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 12 | GLOBAL CONTROL | NARRATIVE | Module label. |
| 12 | SCR-003 - Notifications & Action Center | NARRATIVE | Screen heading; the screen is at /notifications. |
| 12 | Primary lifecycle: Cross-phase \| Screen baseline number: 3 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 12 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 12 | A single inbox for approvals, blockers, payment verification requests, client responses, QA failures, failed deliveries and system alerts. | BUILT | `/notifications` (`app/(internal)/notifications/page.tsx`, `action-items.ts`): Approvals, Payments (claims), Defects (blocker/major, i.e. blockers and QA failures), Jobs, Deliveries, Tasks, Phase changes, Schedule changes, Client responses, System alerts; Blockers (blocked tasks with what they wait on) added in this pass (`src/modules/projects/blocked-tasks-queries.ts`, `tests/a-blocked-work-reaches-the-inbox.test.ts`), rendered "Blockers (1)". |
| 12 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 12 | Unread count | BUILT | Page description "N items need attention, M urgent · K parked"; header bell shows the same count (`action-bell.tsx`). |
| 12 | Severity chips: critical, action required, warning, information | BUILT | Severity chips Critical / Action required / Warning / Information with counts (`SEVERITIES`, `SEVERITY_LABEL`). |
| 12 | Category filters | BUILT | Category chips with counts (`ACTION_CATEGORY_LABEL`). |
| 12 | Snoozed and resolved states | BUILT | Chips "Needs attention", "Read, snoozed & resolved", "Everything"; Snoozed/Resolved badges on rows. |
| 12 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 12 | Notification list | BUILT | `notification-list.tsx` (grouped repeats with a count). |
| 12 | Notification detail drawer | BUILT | Detail drawer in `notification-list.tsx` (state, assigned, snoozed until, "Open the record"). |
| 12 | Action history | BUILT | Per-item "Action history" in the drawer and the page-level History card (`listNotificationHistory`). |
| 12 | Escalation destination | BUILT | `escalate-form.tsx`: "Send to" role (owner or ops admin) shown with who answers it; `core.escalations`. |
| 12 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 12 | Resolve, snooze, assign, open source record | BUILT | Mark read/unread, Snooze, Resolve, Assign, "Open the record": `notification-list.tsx` -> `state-actions.ts` -> `core.set_notification_state`. |
| 12 | Batch mark read | BUILT | `BatchBar` with Mark read and Assign for ticked rows. |
| 12 | Escalate to owner/ops admin | BUILT | `EscalateControl` (row and drawer) -> `core.escalate` to owner or ops admin. |
| 12 | Deep-link to the exact approval/payment/task/message | BUILT | Item `href`s: `/approvals/[id]`, `/invoices/verify`, `/projects/[id]/board`, `/leads/[id]` or project for a client reply, `/operations`. |
| 12 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 12 | Every notification must point to an auditable source event | BUILT | Every item key is derived from a stored source row (approval id, claim id, defect id, job id, delivery time, alert id, task id) and links to it; state changes are audited. |
| 12 | No duplicate alert storms; repeated events should be grouped where practical | BUILT | `groupRepeats` collapses repeated delivery/job/alert streams to one row with a count and an expand (W3; `tests/w3-inbox-search-and-client-rules.test.ts`). |
| 12 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 12 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `core.set_notification_state` and `core.escalate` re-check the caller in the database (`state-actions.ts`, `escalation-actions.ts`); sources are gated by capability (`show('audit.read')`, `invoice.issue`, `project.read`). |
| 12 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | State changes and escalations are rows with actor and time (`notification_state_events`, `core.escalations`) and the history is shown. |
| 12 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | DomainSearch over the composed items, category/severity/state filters, "All clear" / "Nothing in this filter" empty states with an action, `error.tsx` retry. |
| 12 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Detail drawer for inspection; the source record opens on its own page. |
| 12 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 12 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 12 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 13 | GLOBAL CONTROL | NARRATIVE | Module label. |
| 13 | SCR-004 - Quick Create / Command Palette | NARRATIVE | Screen heading; the screen is at header Create + Ctrl/Cmd+K palette. |
| 13 | Primary lifecycle: Cross-phase \| Screen baseline number: 4 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 13 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 13 | Fast creation surface for common records without navigating away from the current context. | BUILT | Header "Create" button and Ctrl/Cmd+K palette (`app/(internal)/command-palette.tsx`, `shell-controls.tsx`): create forms open in the palette without leaving the page. |
| 13 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 13 | Create lead | BUILT | Palette entry "New lead" (`CreateForm` in `command-palette.tsx`, `crm.createLead`). |
| 13 | Create client | BUILT | Entry "New client" (`CreateForm`, `sales.createClientAccount`). |
| 13 | Create project | BUILT | Entry "New project" / "New project for this client" (`CreateProjectForm`). |
| 13 | Create task | BUILT | Entry "New task" / "New task in this project" (`CreateTaskForm`, `palette-forms.tsx`). |
| 13 | Create quotation | BUILT | Entry "New quotation for this lead" (`CreateQuotationForm`, `draftProposalAction`). |
| 13 | Create invoice | BUILT | Entry "Invoice from milestone" (`MilestoneInvoiceForm`, `quick-create-forms.tsx`). |
| 13 | Schedule meeting | BUILT | Entry renamed in this pass from "Request a meeting" to "Schedule a meeting for this lead" (`RequestMeetingForm`, `requestMeetingAction`). It records the meeting wanted; the time is offered and booked from live calendar availability (NOT-BUILDABLE locally: no calendar credential, BLK-005). |
| 13 | Create change request | BUILT | Entry "New change request in this project" (`change_request` kind). |
| 13 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 13 | Command palette | BUILT | `command-palette.tsx` (pages, settings, records, creates; verified by driving it in a browser). |
| 13 | Context-aware create drawer | BUILT | The palette dialog hosts the create forms (`palette-forms.tsx`, `quick-create-forms.tsx`); record results open the shared preview drawer. |
| 13 | Recent commands | BUILT | "Recent command" group from `core.recent_commands` (`palette-memory.ts`); verified: running "Schedule a meeting" showed under Recent command on reopening. Settings entries that share one anchor had duplicate React keys; keys now include the label (fixed this pass). |
| 13 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 13 | Pre-fill client/project when launched from a contextual page | BUILT | `context` from the path: Lead 360 pre-fills the lead ("Pre-filled from the lead you are on"; verified live: draft `leadId` set), project pages pre-fill the project, Client 360 pre-fills the client. |
| 13 | Validate permissions before showing actions | BUILT | Only the creates the role may do are listed (`canCreate*` flags computed in `layout.tsx`); each door re-checks (`palette-actions.ts`). |
| 13 | Save draft when creation is interrupted | BUILT | `core.create_drafts` via `flushDraft`; verified live: typing a purpose, closing, and reopening showed "draft saved" and the row was stored. |
| 13 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 13 | Creation is not approval; governed records still follow approval/payment gates | BUILT | The create doors make drafts/requests only: a quotation is drafted (approval and send stay gated), a meeting is a request, an invoice follows its milestone rule. |
| 13 | All created records receive audit metadata and organization scope | BUILT | Created records go through the owning doors, which write audit rows with the organization scope (trigger audit, row 15 of the front matter). |
| 13 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 13 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `palette-actions.ts` checks `can(context, ...)` per action (`proposal.draft`, `lead.read`, …); the create doors (`createLead`, `draftProposal`, `requestMeeting`) re-check `lead.write` / `project.write` in their services and the database. |
| 13 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Records are created by audited doors; recents and drafts are personal memory (`core.recent_commands`, `core.create_drafts`), not governed records. |
| 13 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Typing filters the palette; empty and failure states are in the dialog (`loadError`, "Loading leads…"). |
| 13 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | The palette is the contextual create drawer; creates that need many fields link to the full page. |
| 13 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Dialog is full width on a phone; no overflow at 390 px. |
| 13 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 13 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 14 | SALES & CRM | NARRATIVE | Module label. |
| 14 | SCR-005 - Sales Overview & Pipeline | NARRATIVE | Screen heading; the screen is at /sales-funnel. |
| 14 | Primary lifecycle: Phase 1 \| Screen baseline number: 5 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 14 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 14 | Executive CRM workspace for lead volume, pipeline value, conversion, meetings, proposals and closed revenue. | BUILT | `/sales-funnel` (`app/(internal)/sales-funnel/page.tsx`): KPIs, board, funnel analytics, Today, upcoming meetings, recent activity; rendered. |
| 14 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 14 | Total leads, qualified leads, proposals sent, deals closed, closed revenue | BUILT | Stat tiles Qualified Leads (caption "N leads in the window"), Proposals Sent, Pipeline Value, Deals Closed, Closed Revenue (rendered). |
| 14 | Date/source/owner filters | BUILT | 30d/90d/180d/365d window buttons, Source and Owner chip filters. |
| 14 | Pipeline columns or stage funnel | BUILT | Deal-stage KanbanBoard (`pipeline-board.tsx`: Discovery, Proposal, Negotiation, Won, Lost) and the "Lead status" board (`?view=leads`: New, Qualifying, Qualified, Nurture) plus "Funnel analytics" stages. |
| 14 | Lead source breakdown | BUILT | "Leads by Source" donut with counts and percentages. |
| 14 | Pipeline value chart | BUILT | "Pipeline Value" bar chart with a table alternative. |
| 14 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 14 | Pipeline board | BUILT | `PipelineBoard` (drag cards) and the lead-status board. |
| 14 | Stage analytics | BUILT | "Funnel analytics" (Leads, Responded, Engaged, Qualified, Requirements accepted, Quoted, Negotiating, … with "% of previous"). |
| 14 | Today tasks | BUILT | `TodayCard` (tasks of the reader due today). |
| 14 | Upcoming meetings | BUILT | "Upcoming Meetings" card. |
| 14 | Recent sales activity | BUILT | "Recent Activities" card (`src/lib/admin/sales-activity.ts`). |
| 14 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 14 | Drag/move only when stage transition rules allow it | BUILT | `OPPORTUNITY_TRANSITIONS` (`src/modules/sales/schema.ts`) decides legal moves; Won/Lost columns are read-only; `setOpportunityStage` refuses won without an accepted quotation and payment evidence where required (`won_gate_verdict`, `src/modules/sales/service.ts`). Drag not exercised in a browser here (it would change the seed deal). |
| 14 | Open lead or quotation from card | BUILT | The card name links to the lead; a "Quotations" link to the lead's quotation tab was added to each card in this pass (`pipeline-board.tsx`). |
| 14 | Add lead, meeting, follow-up | BUILT | `sales-actions.tsx`: "Add lead", "Add meeting", "Add follow-up" (rendered). |
| 14 | Export filtered pipeline | BUILT | "Export CSV (filtered)" -> `app/api/sales/pipeline/export/route.ts` with the same `source` and `owner` parameters. |
| 14 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 14 | Use Phase 1 statuses from New through Won/Lost/Nurture | BUILT | Lead statuses New, Qualifying, Qualified, Nurture on the lead-status board; deal stages Discovery through Won/Lost on the deal board; Lost stays visible. |
| 14 | A stage move must create a CRM activity event and preserve previous status | BUILT | A stage change fires the `opportunities` audit trigger `opportunity.stage_changed` with before and after (`supabase/migrations/20260922120000_two_more_tables_learn_to_speak.sql`), which feeds the lead timeline and "Recent Activities". A reopened deal is a recorded move too. |
| 14 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 14 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `setOpportunityStageAction` -> `setOpportunityStage` re-checks `lead.write`; the page draws the board read-only without it (`canWritePipeline`). |
| 14 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Audit trigger on `sales.opportunities` (before/after) and organization-scoped rows. |
| 14 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Source/owner/window filters; "No open deals right now" with an action; `error.tsx` retry. |
| 14 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Cards open the lead; the lead page carries the complex work. |
| 14 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow; board columns scroll inside their box. |
| 14 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 14 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 15 | SALES & CRM | NARRATIVE | Module label. |
| 15 | SCR-006 - Leads List | NARRATIVE | Screen heading; the screen is at /leads. |
| 15 | Primary lifecycle: Phase 1 \| Screen baseline number: 6 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 15 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 15 | Manage inbound and imported leads with strong filtering, deduplication indicators and next-action visibility. | BUILT | `/leads` (`app/(internal)/leads/page.tsx`, `bulk-table.tsx`): filters, flags column (consent, hand-off, reply, duplicates), next-action chips. |
| 15 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 15 | Lead count by status | BUILT | Chips "All Leads (n)" and one per status with counts; Stat tiles. |
| 15 | Search by name, phone, email, company | BUILT | Search box now matches name, phone, email, company and source (company was in the PDF but the placeholder listed only source; fixed in this pass, `leads/page.tsx`). |
| 15 | Source, status, owner, service, budget, date filters | BUILT | Source, Status, Assigned to selects; behind "Filter": budget at least/at most, created from/to, service (`leads/page.tsx` filters). |
| 15 | Needs reply / human handoff flags | BUILT | Flags column (`lead-flags.tsx`, `lead-indicators-queries.ts`): consent, hand-off, reply, duplicate count; "Who needs you first" panel. |
| 15 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 15 | Lead table | BUILT | Lead table with Heat badge, sortable. |
| 15 | Bulk actions | BUILT | `bulk-actions-bar.tsx`: Assign owner, Set status, Add tag, Set next follow-up. |
| 15 | Lead preview drawer | BUILT | `LeadPreviewButton` -> `preview-drawer.tsx`. |
| 15 | Import leads entry point | BUILT | "Import leads" button -> `/import`. |
| 15 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 15 | Assign owner, update stage, set next follow-up, add tag | BUILT | Bulk bar and the lead page forms; each goes through its own door (`setLeadStatus`, owner/tag/follow-up doors). |
| 15 | Open conversation and Lead 360 | BUILT | Row menu "Open conversation" (`/leads/id?tab=conversation`) and "Open lead". |
| 15 | Disqualify only with reason | BUILT | Status "disqualified" demands a reason in the bulk bar ("Reason (required)") and in `setLeadStatus` ("A disqualified lead needs a reason"). |
| 15 | Merge duplicates through governed flow | BUILT | `merge-duplicate-button.tsx` -> `crm.merge_leads` (owner only); `tests/two-leads-that-were-always-one.test.ts`. |
| 15 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 15 | Show source and consent state | BUILT | Source column and consent chip (Consent given / withdrawn / No consent) in Flags. |
| 15 | Imported historical leads must not become automatically outreach-eligible without consent | BUILT | Outreach needs recorded consent in the database: `supabase/migrations/20260814120008_no_consent_no_send.sql`, `tests/communication-consent.test.ts`, `tests/a-cohort-is-reactivated-with-consent.test.ts`, `scripts/verify-consent.mjs`; an imported lead joins a cohort only once consent is recorded. |
| 15 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 15 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `setLeadStatus` and the bulk doors re-check `lead.write` (`src/modules/crm/service.ts`); owner assignment needs `canAssign`; merge is owner-only. |
| 15 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Status, owner, tag changes are audited rows (`audit_by_trigger`); a lead keeps its organization and activity timeline. |
| 15 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search, filters, saved views, "Clear filters" empty state with an action, `error.tsx` retry. |
| 15 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Preview drawer for inspection; Lead 360 for complex work. |
| 15 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow; the table becomes cards. |
| 15 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 15 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 16 | SALES & CRM | NARRATIVE | Module label. |
| 16 | SCR-007 - Lead 360 | NARRATIVE | Screen heading; the screen is at /leads/[leadId]. |
| 16 | Primary lifecycle: Phase 1 \| Screen baseline number: 7 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 16 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 16 | Complete lead workspace containing conversation, qualification, requirements, quotation versions, meetings, follow-ups and timeline. | BUILT | `/leads/[leadId]` (`app/(internal)/leads/[leadId]/page.tsx`): one workspace with a tab strip. |
| 16 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 16 | Lead identity and source | BUILT | EntityHeader: name, status chip, phone, "via <source>", "Added <time>". |
| 16 | Current deal stage/value | BUILT | Header facts Deal and Deal value, stage strip (`stage-strip.tsx`). |
| 16 | Human-handoff state | BUILT | Header fact "Hand-off": "Agent replying" or "With a person — agent paused" (`handoffHeaderValue`, new in this pass), plus the waiting banner (`waiting-banner.tsx`). `tests/a-lead-header-says-requirements-and-handoff.test.ts`. |
| 16 | Last contact and next follow-up | BUILT | Next follow-up in the header aside; Last contact in the Overview panel ("29 Sept 2026, 8:13 pm · we wrote"). |
| 16 | Requirement version status | BUILT | Header fact "Requirements": "v2 · Proposed, awaiting a decision" (`requirementHeaderValue`, new in this pass; rendered on the seeded thread). |
| 16 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 16 | Overview | BUILT | Tab "Overview" (Lead information, Lead Heat, Tags, Tasks). |
| 16 | Conversation | BUILT | Tab "Conversation" (WhatsApp-style thread and composer). |
| 16 | Qualification | BUILT | Tab "Qualification" (coverage disclosure) and the full screen `/leads/[leadId]/qualification` (SCR-008). |
| 16 | Requirements | BUILT | Tab "Requirements" ("Extracted requirements" card; rendered with seeded versions). |
| 16 | Quotations | BUILT | Quotations card; its tab is labelled "Quote" (the reference screenshot's name, `docs/ui-parity/P1.md`). |
| 16 | Meetings | BUILT | Tab "Meetings" added in this pass (the section existed, its tab did not); `meetings` card with "All meetings". |
| 16 | Follow-ups | BUILT | Tab "Follow-ups" (`sequences` card with sequence controls and reactivation). |
| 16 | Activity | BUILT | Tab "Activity" (lead timeline, `listLeadTimeline`); Files, Notes tabs besides. Tabs with no section on a given lead are hidden (`lead-tabs.tsx`). |
| 16 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 16 | Send client message if WhatsApp rules permit | BUILT | `message-form.tsx` / composer: free text only inside the 24-hour window, otherwise an approved template ("Send an approved template — the window has shut"); `tests/a-message-outside-the-window.test.ts`, `tests/every-outbound-message-asks.test.ts`. Delivery needs the WhatsApp credential (not configured locally); the door is tested with fakes. |
| 16 | Add internal note | BUILT | "Add to transcript — recorded here only, sends nothing" (`message-form.tsx`) and the Notes tab. |
| 16 | Resume/stop agent when policy allows | BUILT | `PauseAgentForm` ("Pause the agent — why") and `WaitingForSomebody` Resume (`resumeAgentRepliesAction` -> `crm.resume_agent_replies`). |
| 16 | Create quotation after requirements are accepted | BUILT | Quotations card: "A quotation is drafted once a requirement version is accepted" (`requirementVersionId` cited on the draft). |
| 16 | Mark Won/Lost through guarded transition | BUILT | Deal stage select offers won from proposal/negotiation through `OPPORTUNITY_TRANSITIONS` and `won_gate_verdict`; lost needs a category and a sentence (`sales-panel.tsx`); lead statuses move only through `setLeadStatus`. |
| 16 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 16 | Client-visible messages and internal notes must be clearly separated | BUILT | Banner "Messages sent from the composer reach the customer on WhatsApp. Notes added to the transcript stay here."; notes carry a different visual lane. |
| 16 | Every generated requirement/quotation version must remain traceable | BUILT | Requirement versions carry source job, messages read and confirmation message (`listRequirementSourceRefs`); proposals cite the exact requirement version; versions are never overwritten (supersede). |
| 16 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 16 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Every action calls a service that checks `lead.write` / `proposal.*` and a database door (`src/modules/crm/service.ts`, `sales/service.ts`); `mayWrite` only decides what is drawn. |
| 16 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Status moves, quotes, notes and messages are audited rows and timeline entries; org/lead/client context is on every row. |
| 16 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Tab strip, timeline, empty cards with explanations; `error.tsx` retry. |
| 16 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Contextual cards and the qualification page; the conversation is a full workspace. |
| 16 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow; two-pane layout becomes a segmented control. |
| 16 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 16 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 17 | SALES & CRM | NARRATIVE | Module label. |
| 17 | SCR-008 - Qualification & Scoring | NARRATIVE | Screen heading; the screen is at /leads/[leadId]/qualification. |
| 17 | Primary lifecycle: Phase 1 \| Screen baseline number: 8 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 17 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 17 | Structured qualification surface for service fit, budget, urgency, authority, timeline and disqualification evidence. | BUILT | `/leads/[leadId]/qualification` (`app/(internal)/leads/[leadId]/qualification/page.tsx`; rendered): fit, budget, urgency, authority, timeline and disqualification evidence. |
| 17 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 17 | Qualification score | DECIDED | Owner decision R2 #1: no number, a Hot/Warm/Cold label from reasons. The page shows the "Lead heat" tile and "Why This Heat" (`src/modules/crm/lead-heat.ts`, `tests/a-lead-is-hot-warm-or-cold.test.ts`, `db:verify:noscore`). |
| 17 | Fit criteria | BUILT | "Fit criteria 0/16 — Areas the conversation answered" and the sixteen discovery areas with their own words (`readQualificationCoverage`). |
| 17 | Budget band | QUESTION | Budget is a figure in paise with a "Not recorded" state; no band exists. Q-BAND: what are the band boundaries (and are they owner-editable)? |
| 17 | Timeline | BUILT | Timeline tile and form field (`qualification.timelineNote`). |
| 17 | Decision-maker status | BUILT | Decision-maker tile (Unknown / Yes / No) and form field. |
| 17 | Risk/objection tags | BUILT | "Risk and objections" list from `listOpenObjectionsForLead` ("No open objection" when none). |
| 17 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 17 | Qualification form | BUILT | "Qualification form" (budget, timeline, decision maker) saved through the Lead 360 door. |
| 17 | Score explanation | DECIDED | "Why This Heat" lists the reasons (stage, last reply, budget recorded) per owner decision R2 #1 instead of a score explanation. |
| 17 | Disqualification reason history | BUILT | "Disqualification history": empty state rendered; populated state rendered with a temporary seeded status change ("Disqualified · from Qualified · <reason>"), then removed. |
| 17 | AI suggestion vs human decision | DECIDED | The system recommends the heat label; the person decides by moving the lead ("The system recommends; a person decides"). The stored AI score columns are not shown (decision R2 #1). |
| 17 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 17 | Approve/override score with reason | QUESTION | Approve/override with a reason was part of the numeric score, which decision R2 #1 replaced; Rescore/Override controls were removed. Q-OVERRIDE: should a person be able to override the Hot/Warm/Cold label with a reason (original label kept and audited)? |
| 17 | Disqualify with mandatory reason | BUILT | "Move the lead" -> disqualified needs a reason (`setLeadStatus`); history above. |
| 17 | Return to discovery when evidence is incomplete | BUILT | "Return to discovery" form (`return-to-discovery-form.tsx`, "What evidence is still missing?"). |
| 17 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 17 | AI may recommend but not invent client facts | BUILT | Extraction proposes, a person accepts (requirement versions are born proposed): `tests/a-client-answer-is-not-a-guess.test.ts`, `tests/the-agent-does-everything-but-decide.test.ts`; the heat reads stored facts only. |
| 17 | Manual override must be audited and the original score preserved | DECIDED | With no number and no override there is nothing to preserve; the `crm.leads.score` columns and their doors are untouched and unread (X2). See Q-OVERRIDE. |
| 17 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 17 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Qualification and moves call `setLeadStatus` / the qualification door, which check `lead.write` and run in the database. |
| 17 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Status moves are audited with reason (`status_change` activity + `audit_by_trigger`). |
| 17 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Single-lead screen: form, coverage, history; empty states explain ("No open objection", "never been disqualified"). |
| 17 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Complex workflow gets its own page; the Lead 360 tab is the disclosure. |
| 17 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 17 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 17 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 18 | SALES & CRM | NARRATIVE | Module label. |
| 18 | SCR-009 - Requirements Discovery | NARRATIVE | Screen heading; the screen is at /leads/[leadId] (requirements card). |
| 18 | Primary lifecycle: Phase 1 \| Screen baseline number: 9 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 18 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 18 | Capture and version structured requirements from WhatsApp, meetings, voice notes and manual inputs before quotation. | BUILT | Lead 360 "Extracted requirements" card (`app/(internal)/leads/[leadId]/page.tsx`, `requirement-set-panel.tsx`): versions from WhatsApp, meetings (`src/modules/crm/meeting-analysis.ts`) and manual revision (`requirement-revise-form.tsx`); rendered with two seeded versions, then removed. |
| 18 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 18 | Latest requirement version | BUILT | "v2 Proposed … v1 Superseded" list newest first; header chip "Requirements: v2 · …". |
| 18 | Open questions count | BUILT | Badge "2 open questions" (`openQuestions`). |
| 18 | Client-confirmed vs proposed | BUILT | Badges "1 proposed", "0 client-confirmed", "0 accepted unconfirmed". |
| 18 | Source transcript references | BUILT | "Source: read 3 messages — up to 1 Jun 2026, 6:30 am" linking to the message anchor (`listRequirementSourceRefs`). |
| 18 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 18 | Requirement summary | BUILT | Summary sentence and scope list on each version. |
| 18 | Feature list | BUILT | "Features" section of "The full set" (rendered: Catalogue — 500 SKUs, Checkout). |
| 18 | User roles | BUILT | "User roles" section (Shopper, Store admin). |
| 18 | Platforms | BUILT | "Platforms" section (Web, Android). |
| 18 | Integrations | BUILT | "Integrations" section (Razorpay, Shiprocket). |
| 18 | Timeline/budget notes | BUILT | "Timeline and budget notes" ("8 weeks, around 6 lakh"). |
| 18 | Open questions | BUILT | "Questions" section with "Request clarification" per question; count badge. |
| 18 | Version history | BUILT | Version history: every version stays listed with status and author (v1 Superseded by human). |
| 18 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 18 | Extract requirements | BUILT | "Extract requirements" button (`requestExtractionAction`, a queued job; `message-form.tsx`). |
| 18 | Edit draft | BUILT | "Edit as new version" (`requirement-revise-form.tsx`, "writes v3 as proposed; v2 becomes superseded"). |
| 18 | Send summary to client for confirmation | BUILT | "Send to client for confirmation" (`requirement-decision-form.tsx` -> `sendRequirementForConfirmationAction`; delivery needs WhatsApp, not configured locally; tested with fakes: `tests/the-client-confirms-the-summary.test.ts`). |
| 18 | Approve/reject proposed version | BUILT | "Approve" and "Reject" on a proposed version (`requirement-decision-form.tsx` -> `decideRequirementVersionAction`, `tests/requirement-decision.test.ts`). |
| 18 | Supersede with new version | BUILT | "Edit as new version" writes the next version as proposed and marks the edited one superseded, keeping it in history (`crm.revise_requirement_version`, `requirement-revise-service.ts`, `tests/a-requirement-has-nine-sections.test.ts`). |
| 18 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 18 | No silent replacement of previous versions | BUILT | Versions are append-only: v1 stays as "Superseded" after v2 (rendered). |
| 18 | Requirement acceptance and quotation must reference the exact accepted version | BUILT | A proposal stores `requirement_version_id` of the accepted version (`sales.proposals.requirement_version_id`, `supabase/migrations/20260813120019_the_quote_the_owner_signs.sql`; the draft form passes `acceptedVersions[0]` in `leads/[leadId]/page.tsx`); `tests/a-requirement-has-nine-sections.test.ts`. |
| 18 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 18 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Extraction, revise, decide and send call services that check `lead.write` and database doors (`src/modules/crm/requirement-*-actions.ts`). |
| 18 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Each version row has author/source/time; decisions are audit rows; context is conversation -> lead -> organization. |
| 18 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Questions, statuses, collapsible full set; "None yet" empty state with the Extract action. |
| 18 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Collapsible "The full set" per version; complex editing in its own form. |
| 18 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 18 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 18 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 19 | SALES & CRM | NARRATIVE | Module label. |
| 19 | SCR-010 - Meetings | NARRATIVE | Screen heading; the screen is at /meetings, /meetings/[meetingId]. |
| 19 | Primary lifecycle: Phase 1 + Cross-phase \| Screen baseline number: 10 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 19 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 19 | Calendar-backed meeting management for lead calls, client reviews, technical discussions and handover meetings. | BUILT | `/meetings` and `/meetings/[meetingId]` (`app/(internal)/meetings/page.tsx`, `[meetingId]/page.tsx`; rendered with seeded requested, booked and completed meetings, then removed). Calendar-backed booking needs a credential, see rows below. |
| 19 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 19 | Verified calendar status | BUILT | Callout "Nothing can be proposed or booked from here yet — No calendar credential is configured (BLK-005)…" or, when configured, "Calendar: google:<id> — verified" with `VerifyCalendarForm`. |
| 19 | Upcoming/requested/booked/completed/no-show/cancelled counts | BUILT | StatGrid: Upcoming (added this pass: booked meetings from today on, whatever the window), Requested, Booked, Completed, Cancelled, No show. |
| 19 | Mode and owner filters | BUILT | Window chips (Today, Next 7 days, Next 30 days, Last 30 days), Lead owner (Anyone/Mine), Status and Mode chips, search. |
| 19 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 19 | Meeting list | BUILT | Day-grouped list (default view). |
| 19 | Calendar view | BUILT | `?view=calendar` MonthGrid (`src/ui/primitives/calendar.tsx`), month navigation. |
| 19 | Meeting detail | BUILT | `/meetings/[meetingId]`: scheduling, completion, controls, evidence, reminders, analysis, history (rendered for three states). |
| 19 | Propose time | NOT-BUILDABLE | A "Propose a time" control is rendered as Blocked with its reason: availability answers unconfigured until a Google Calendar service-account key exists. The offer logic is built and tested (`src/lib/scheduling/availability.ts`, `google.ts`, `tests/a-slot-is-offered-and-taken.test.ts`); it cannot be run locally. |
| 19 | Book/rebook/cancel workflow | BUILT | Cancel ("Cancel meeting"), Reschedule ("cancel this, request a new one", carries `supersedes_id`), Mark completed, Mark no-show are live controls (rendered on a booked meeting). "Book" is rendered Blocked until a calendar credential exists (NOT-BUILDABLE locally; same reason as Propose). |
| 19 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 19 | Check live availability before booking | NOT-BUILDABLE | Live availability is read from Google Calendar (`src/lib/scheduling/google.ts`); there is no credential locally, so the screen says availability is unconfigured instead of inventing slots (`tests/the-calendar-is-read-not-invented.test.ts`, `tests/a-slot-that-was-never-read.test.ts`). |
| 19 | Create Google Calendar event when configured | NOT-BUILDABLE | The Google event with Meet link is created on Book when the adapter is configured (`google.ts`, `tests/a-retry-that-books-twice.test.ts` with a fake provider); not executable locally without the service-account key. |
| 19 | Attach meeting notes/transcript after the meeting | BUILT | "Attach evidence" with typed notes or a structured summary (internal or client-visible) and "Upload notes or a transcript (.txt, .md, .vtt, .srt)" on the meeting page; evidence rows appear with author and time. |
| 19 | Link meeting to lead/client/project | BUILT | Meeting belongs to a lead (header link), "Link" to a project (`project-link-form.tsx`, `attach_meeting_to_project`), and appears on the lead's Meetings card and the client's notes tab through the lead. |
| 19 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 19 | No invented availability | BUILT | No slot is written without a read: `meetings_proposal_was_read` check (a proposed/booked row needs `availability_source` and `availability_read_at`), `tests/the-calendar-is-read-not-invented.test.ts`. |
| 19 | Real-world recording/notes are uploaded by a human; extracted decisions are versioned and auditable | BUILT | Evidence is a human act (typed or uploaded); analysis output is born "PROPOSED" and listed as "inference, not confirmed until a person says so" (rendered), each evidence row kept (`crm.meeting_evidence`, `tests/what-the-meeting-said-is-proposed.test.ts`); audited events `meeting.evidence_added` etc. |
| 19 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 19 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Every control calls `crm.*` meeting doors that re-check the caller (`app/(internal)/meetings/[meetingId]/actions.ts`); the page renders blocked controls instead of hiding them. |
| 19 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | The page names the audited events per row ("Audited on this row: meeting.booked, meeting.cancelled, meeting.completed, meeting.no_show, meeting.evidence_added"); history chain via `supersedes_id`. |
| 19 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search, filters, "No meetings in <window>" empty state with a Clear filters or Open leads action, `error.tsx` retry. |
| 19 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Meeting detail is its own page with the controls; the list links to it. |
| 19 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow on the list and the detail. |
| 19 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 19 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 20 | SALES & CRM | NARRATIVE | Module label. |
| 20 | SCR-011 - Quotations List | NARRATIVE | Screen heading; the screen is at /quotations. |
| 20 | Primary lifecycle: Phase 1 \| Screen baseline number: 11 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 20 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 20 | Versioned proposal/quotation registry showing draft, pending approval, approved, sent, superseded, accepted, rejected and expired states. | BUILT | `/quotations` (`app/(internal)/quotations/page.tsx`): status chips Draft, Pending approval, Approved, Sent, Accepted, Rejected, Superseded and an Expired validity filter (Expired is a validity state of sent/approved quotes past their date, `isExpired`). |
| 20 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 20 | Quote count and total value | BUILT | Stat tiles "Quotations" and "Total value" (excludes superseded: "₹82,600.00 — Excludes 3 superseded"). |
| 20 | Status filters | BUILT | Status chips with counts. |
| 20 | Client/project/service filters | BUILT | Client and Project chips (shown when the quotations carry them), Service field (`?client=&project=&service=`); the seed's deals have no client account so no client chips render locally. |
| 20 | Validity/expiry filters | BUILT | Chips "Any validity / Expiring in 7 days / Expired" and the "Expiring in 7 days" tile. |
| 20 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 20 | Quotation table | BUILT | DataTable: Number, Quotation, Status, Total, Valid until, Approval, Sent, Delivery, Raised, History, PDF; sortable. |
| 20 | Version history drawer | BUILT | "N versions" link opens `version-drawer.tsx`. |
| 20 | Approval status | BUILT | Approval column ("Waiting on owner", links to the approval). |
| 20 | PDF preview | BUILT | The row menu "Submit, send or record an answer" opens a drawer with "Preview the PDF" (inline `iframe` of `/api/quotations/[proposalId]/pdf`, added this pass; opened in a browser) as well as the "PDF" link. |
| 20 | Delivery status | BUILT | Delivery column derived from the messages ("Not sent", …; `delivery-status-queries.ts`). |
| 20 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 20 | Create new version instead of editing an approval-locked version | BUILT | Drawer footer "Open the lead — create a new version"; lines are frozen outside draft by `sales.proposal_items_guard` (`supabase/migrations/20260824120000_the_agent_does_everything_but_decide.sql`) and the next version is opened by the draft door that supersedes the live one (`20260824150000_the_client_asks_and_the_agent_redrafts.sql`). |
| 20 | Open PDF | BUILT | Row menu "Open the PDF" and the PDF column -> `app/api/quotations/[proposalId]/pdf/route.ts` (`application/pdf`, inline; fetched, 52 KB). |
| 20 | Submit for approval | BUILT | `SubmitQuotationForm` in the drawer for a draft. |
| 20 | Send approved quote to client | BUILT | `SendQuotationForm` only for an approved quotation. |
| 20 | Mark accepted/rejected from evidence | BUILT | `QuotationResponseForm` for a sent quotation (accepted/rejected with the evidence). |
| 20 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 20 | Pricing cannot be invented by an agent | BUILT | A quotation is priced by the pricing step from admin-configured rates and reaches a client only after owner approval (`src/modules/sales/pricing-reference.ts`, `tests/the-price-checks-itself-against-the-lane.test.ts`, `tests/the-owner-reads-the-quotation.test.ts`). |
| 20 | Every client-facing quote must reference approved commercial rules and retain all superseded versions | BUILT | Superseded versions are kept and listed in the version drawer; terms are frozen onto the quotation (`tests/a-quotation-keeps-the-clause-it-printed.test.ts`). |
| 20 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 20 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Submit/send/answer re-check `proposal.draft` / `proposal.send` in `src/modules/sales/service.ts`; the owner's approval is a separate door (`/approvals`). |
| 20 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Quotation status changes fire `proposal.*` audit events (`audit_by_trigger`); every version keeps its row. |
| 20 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search, status/validity/client/project/service filters, saved views, "Clear all filters", sorted columns, pagination. |
| 20 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Version history drawer, action drawer with PDF preview; the composer is its own page. |
| 20 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 20 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 20 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 21 | SALES & CRM | NARRATIVE | Module label. |
| 21 | SCR-012 - Create / Edit Quotation | NARRATIVE | Screen heading; the screen is at /quotations/new. |
| 21 | Primary lifecycle: Phase 1 \| Screen baseline number: 12 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 21 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 21 | Controlled quote composer for scope, services, pricing, tax mode, payment schedule and terms. | BUILT | `/quotations/new` (`app/(internal)/quotations/new/composer.tsx`, `page.tsx`): rendered. |
| 21 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 21 | Client information | BUILT | "Client Information" card: Deal select with contact, company and phone. |
| 21 | Quotation number/date/validity | BUILT | "Quotation Details": Quotation number (derived and printed), Date, Valid until (default from Settings), Currency. |
| 21 | Project type/name/duration | BUILT | Project type and Duration (kept as the first lines of the scope note; no column of their own), Title. |
| 21 | GST vs Non-GST | BUILT | GST toggle "GST 18% on the discounted subtotal (untick for Non-GST)", pre-filled from the project's confirmed billing mode (the "(untick for Non-GST)" wording added this pass). |
| 21 | Sales owner | BUILT | Sales owner select (written to `opportunities.owner_id`). |
| 21 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 21 | Services/items | BUILT | "Services / Items" table with Add item and remove (×). |
| 21 | Scope summary | BUILT | "Scope note (optional)". |
| 21 | Third-party charges | BUILT | "Third-party charges (at cost, as the Admin recorded them)" (Apple developer account, Razorpay gateway) with add-to-quote. |
| 21 | Payment schedule | BUILT | "Payment Schedule" preview from the chosen "Quotation template". |
| 21 | Terms & conditions | BUILT | "Terms & Conditions", one clause per line, standard clauses pre-filled. |
| 21 | Notes | BUILT | "Note for the owner (optional)". |
| 21 | Quotation summary | BUILT | "Quotation Summary" with subtotal, discount, tax, total and "Amount in Words" (`src/lib/money/amount-in-words.ts`). |
| 21 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 21 | Add/remove item | BUILT | Item rows add and remove client-side; the saved lines are priced by the pricing step. |
| 21 | Use admin-configured cost/pricing references | BUILT | Third-party charges and the payment structures come from the Admin's records (`src/modules/sales/composer-queries.ts`, Settings › Commercial). |
| 21 | Preview PDF | BUILT | "Preview" / "Preview Quotation" post the form to `app/api/quotations/preview/route.ts`, which renders the real PDF without saving. |
| 21 | Save draft | BUILT | "Save as Draft" (`intent=draft`). |
| 21 | Submit for approval | BUILT | "Send to Client" (`intent=send`, tooltip "Prices it and sends it to the owner for approval; it reaches the client once approved") runs the governed walk and submits for approval. |
| 21 | Send only after approval | BUILT | The client only receives it from the approved row ("Send" appears for status approved only, `quotations/row-actions.tsx`); "A quotation reaches the client only after the owner approves it." Owner decision #13: no Share before approval (`Copy link` only on approved/sent/accepted). |
| 21 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 21 | Payment terms must total 100% | BUILT | Payment milestones must total 100: deferred constraint trigger `payment_milestones_sum` (`supabase/migrations/20261007200200_the_default_payment_structure_is_30_20_30_20.sql` comment; `tests/payment-plan-atomic.test.ts`). |
| 21 | Default project milestones follow locked AgencyOS rules unless an explicitly approved commercial exception exists | DECIDED | Owner decision R2 #2: 30/20/30/20 tied to Phases 2, 4, 5, 6 is the pre-filled default (`sales.seed_default_payment_structure`, `LOCKED_PAYMENT_STRUCTURE` in `src/modules/projects/payment-structure.ts`); an owner-configured structure that matches the amount wins, so the local demo organization's own "Standard 30/40/30" shows here (`tests/x2-audit-export-and-default-schedule.test.ts`). No-advance exception: `tests/the-no-advance-exception-can-be-asked-for.test.ts`. |
| 21 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 21 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `composeQuotationAction` walks draft, items, pricing, submit, each behind `proposal.draft` (`src/modules/sales/actions.ts`); approval is the owner's separate door; the preview route re-checks the session. |
| 21 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Each step is an audited event; the quotation keeps its deal, lead and organization. |
| 21 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Form validation messages; disabled actions without a deal; `error.tsx` retry. |
| 21 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Two-column composer with a summary rail; preview opens in a new tab. |
| 21 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow; the summary stacks under the form. |
| 21 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 21 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 22 | SALES & CRM | NARRATIVE | Module label. |
| 22 | SCR-013 - Follow-ups & Nurture | NARRATIVE | Screen heading; the screen is at /follow-ups. |
| 22 | Primary lifecycle: Phase 1 + Phase 8 \| Screen baseline number: 13 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 22 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 22 | Manage scheduled follow-ups, no-response sequences, nurture cohorts and reactivation without violating communication consent. | BUILT | `/follow-ups` (`app/(internal)/follow-ups/page.tsx`): queue, reactivation cohort, situations and templates; rendered. |
| 22 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 22 | Due today, overdue, upcoming, paused, failed | BUILT | Tiles Due today, Overdue, Upcoming, Paused, Failed, Escalated, Reactivation cohort. |
| 22 | Channel and owner filters | BUILT | Channel chips, Owner chips (Any/Mine), status and time chips. |
| 22 | Lead/client/project context | BUILT | "Client · project" column links to the client and project behind the chase when the lead has them (shows "—" for leads that are not yet clients, as in the seed). |
| 22 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 22 | Follow-up queue | BUILT | Queue table with Details, Pause, Reschedule, Complete, Cancel. |
| 22 | Sequence detail | BUILT | Details opens `sequence-drawer.tsx` (rhythm, attempts, escalates to, escalated). |
| 22 | Template mapping | BUILT | "Situations and their templates" card (`listTemplateSituationMapping`). |
| 22 | Reactivation cohort | BUILT | `reactivation-cohort.tsx` (consent recorded, quiet 30+ days, no open follow-up; pilot state badge). |
| 22 | Pause/resume controls | BUILT | "Pause" and "Resume" (renamed from Stop in W3; `sequence-controls.tsx`, reason required). |
| 22 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 22 | Schedule, reschedule, complete, pause, cancel | BUILT | "Schedule follow-up" (`schedule-follow-up-button.tsx`), Reschedule (new due time + reason), Complete, Pause, Cancel (`crm.decide_follow_up_sequence`). |
| 22 | Enroll eligible lead with consent | BUILT | `EnrolLeadForm` on each cohort row -> `crm.add_lead_to_reactivation_pilot` (the consent guard is that door's); `tests/a-cohort-is-reactivated-with-consent.test.ts`. |
| 22 | Escalate repeated failure to human | BUILT | A sequence that exhausts its attempts escalates to a person (status "Escalated", `tests/an-exhausted-sequence-reaches-a-person.test.ts`). |
| 22 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 22 | WhatsApp messages outside the 24-hour window require approved templates | BUILT | Outside the window only an approved template may go; a blank template column means nudges are suppressed (`tests/a-message-outside-the-window.test.ts`, `tests/which-template-and-in-whose-language.test.ts`). |
| 22 | Frequency caps and opt-out/consent must be enforced centrally | BUILT | Frequency caps, opt-out and consent are enforced in the database, not the page (`tests/how-often-is-too-often.test.ts`, `tests/an-inbound-stop-is-heard.test.ts`, `tests/communication-consent.test.ts`). |
| 22 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 22 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | `decideFollowUpSequenceAction` -> `crm.decide_follow_up_sequence` requires a reason and re-checks the caller; scheduling uses the lead door (`lead.write`). |
| 22 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Each decision records a reason and a correlation id shown in the drawer; sequences keep lead and organization context. |
| 22 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Filters, saved views, "Clear all"; empty state explains and links; `error.tsx` retry. |
| 22 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Sequence drawer for inspection; schedule and enrol are inline forms. |
| 22 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 22 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 22 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 23 | CLIENTS | NARRATIVE | Module label. |
| 23 | SCR-014 - Client Management | NARRATIVE | Screen heading; the screen is at /clients. |
| 23 | Primary lifecycle: Phase 1 onward \| Screen baseline number: 14 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 23 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 23 | Master client registry showing active, pending, completed and on-hold clients with commercial and relationship context. | BUILT | `/clients` (`app/(internal)/clients/page.tsx`): lifecycle chips All, Active, Pending, On hold (added this pass), Completed, Working, Owing, Archived; commercial and relationship context in the table and drawer. |
| 23 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 23 | Total clients, active, completed, pending, total revenue | BUILT | Stat tiles Total Clients, Active Clients, Completed Clients, Pending Clients, Total Revenue (verified payments: "Paid · ₹5,54,000 invoiced", `src/lib/finance/verified-basis.ts`). Each tile states its own definition ("26 with an active project", "With a project not yet completed"). Open question Q-CHIPS: Active counts every client whose status is active (30 of 30 locally) and Pending overlaps Active; which definitions does the owner want? |
| 23 | Search and lifecycle filters | BUILT | Search box and lifecycle chips (`?status=`, now including `on_hold`). |
| 23 | Tags and account owner | BUILT | Tag and Owner selects (`?tag=`, `?owner=`). |
| 23 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 23 | Client table | BUILT | Client table with duplicate badge. |
| 23 | Client preview drawer | BUILT | `clients/preview-drawer.tsx` and the "Client Details" rail for the selected row. |
| 23 | Recent communication | BUILT | "Recent Communication" card scoped to the selected client. |
| 23 | Upcoming follow-ups | BUILT | "Upcoming Follow-ups" card scoped to the selected client. |
| 23 | Pending invoices | BUILT | "Pending Invoices" card scoped to the selected client (`clients-overview.ts`). |
| 23 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 23 | Add/edit client | BUILT | "Add Client" (palette form; checks identity first, see the guardrail) and edit (`clients/client-edit-form.tsx`, `core.update_client_account`; billing identity needs `invoice.read` plus the owner/ops-admin door). |
| 23 | Open Client 360 | BUILT | Row click and row menu open `/clients/[clientId]`. |
| 23 | Export list | BUILT | "Export" -> `app/api/clients/export/route.ts`. |
| 23 | Assign relationship owner | BUILT | `clients/bulk-bar.tsx` "Assign relationship owner" (and per-client forms on the Settings tab). |
| 23 | Add tags | BUILT | `clients/bulk-bar.tsx` "Add tag"; tag chips filter the list. |
| 23 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 23 | Client identity must deduplicate against lead/contact records | BUILT | New in this pass: creating a client first looks for a client with the same name or billing email and for a contact (usually on a lead) with the same email, name or company; a match stops the create, links the record (client or lead) and asks to confirm (`src/modules/sales/client-identity.ts`, `createClientAccount` in `src/modules/sales/service.ts`, palette form; `tests/a-new-client-is-checked-against-who-the-agency-knows.test.ts`; driven in a browser). Existing duplicates are flagged in the list ("Possible duplicate ×2", `duplicate-clients.ts`). |
| 23 | Financial totals must be derived from verified invoice/payment records | BUILT | Revenue, paid and outstanding come from verified payments and live invoices (`src/lib/finance/verified-basis.ts`, `src/lib/admin/clients.ts`; X1 leftovers), equal to Finance. |
| 23 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 23 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Client doors re-check `project.write` (`createClientAccount`, `updateClientAccount`, `setClientOwner`, `addClientTag`); bulk runs one door per client and reports refusals (`clients/bulk-actions.ts`). |
| 23 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Edits are audited (`core.update_client_account` writes an audit row; owner/tag changes by trigger). |
| 23 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search, tag/owner/lifecycle filters, saved views, "Clear all filters", sortable columns, pagination. |
| 23 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Preview drawer and rail for inspection; Client 360 for the rest. |
| 23 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 23 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 23 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 24 | CLIENTS | NARRATIVE | Module label. |
| 24 | SCR-015 - Client 360 | NARRATIVE | Screen heading; the screen is at /clients/[clientId]. |
| 24 | Primary lifecycle: Phase 2 onward \| Screen baseline number: 15 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 24 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 24 | Single source of truth for a client across projects, quotations, invoices, messages, files, notes, meetings and activity. | BUILT | `/clients/[clientId]` (`app/(internal)/clients/[clientId]/page.tsx`): nine URL tabs. |
| 24 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 24 | Client identity/company/contact | BUILT | EntityHeader (name, status, billing email, currency, projects) and the Contacts card on Overview ("Contacts (1)"); company name on the Settings tab. |
| 24 | Total projects | BUILT | Stat "Total projects" with per-status caption. |
| 24 | Total invoiced/paid/outstanding | BUILT | Stats "Total invoiced", "Total paid", "Outstanding" (roles with `invoice.read`). |
| 24 | Client health | BUILT | Stat "Client health" (Good / Attention, from overdue invoices and status). |
| 24 | Next follow-up | BUILT | Stat "Next follow-up" (from sequences and lead dates). |
| 24 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 24 | Overview | BUILT | Tab Overview. |
| 24 | Projects | BUILT | Tab Projects. |
| 24 | Quotations | BUILT | Tab Quotations (with contracts, decision #10). |
| 24 | Invoices | BUILT | Tab Invoices. |
| 24 | Communication | BUILT | Tab Communication. |
| 24 | Files | BUILT | Tab Files. |
| 24 | Notes | BUILT | Tab Notes. |
| 24 | Activity | BUILT | Tab Activity. |
| 24 | Settings | BUILT | Tab Settings. |
| 24 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 24 | Create project/quote/invoice | BUILT | `create-buttons.tsx` "Create project", "Create quote", "Create invoice" in the header. |
| 24 | Schedule meeting | BUILT | "Schedule meeting" (`ClientMeetingForm`, records a request on one of the client's leads). |
| 24 | Upload file | BUILT | Files tab upload form (project, file, category, credential warning). Not exercised: Supabase Storage is unreachable locally and the form says so; the finance upload path is covered with a fake storage client (`tests/finance-attachments.test.ts`). |
| 24 | Add note | BUILT | Header "Add note" and the Notes tab form (`note-form.tsx`). |
| 24 | Edit billing details | BUILT | Settings tab "Billing details" form (`client-edit-form.tsx`; GSTIN checksum, PAN match). |
| 24 | Manage assigned team | BUILT | Settings tab "Assigned team" (`setClientTeam`, `core.set_client_account_team`). |
| 24 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 24 | GST/PAN and billing data require restricted permissions | BUILT | GSTIN, PAN and billing address show "Restricted" without `invoice.read`; in this pass the editable form (which carries the same values) is also drawn only with `invoice.read`, so a delivery lead with `project.write` no longer sees them; the save door is owner/ops admin only (`core.is_admin()`). |
| 24 | Client-visible information must stay separate from internal AI/provider/cost data | BUILT | Client 360 reads no AI provider, model or cost field; those live on `/usage` and `/agents` (`audit.read`). |
| 24 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 24 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Each form calls a `src/lib/admin/client-*.ts` or sales door that checks `project.write` / `lead.write` and the database; tabs' money is `invoice.read`-gated. |
| 24 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Notes, team, owner and billing changes are audited; every row carries the client and organization. |
| 24 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Tabs, per-tab empty states ("No notes yet", "No invoices yet") with explanations, `error.tsx` retry. |
| 24 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Tabs are the dedicated pages; forms are inline, the meeting form is a dialog. |
| 24 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow on any of the nine tabs. |
| 24 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 24 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 25 | CLIENTS | NARRATIVE | Module label. |
| 25 | SCR-016 - Client Projects & Commercials | NARRATIVE | Screen heading; the screen is at /clients/[clientId] (Projects, Invoices tabs). |
| 25 | Primary lifecycle: Phase 2 onward \| Screen baseline number: 16 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 25 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 25 | Focused view of all projects, contracts/quotations, milestone payments and commercial history for one client. | BUILT | Client 360 Projects, Quotations, Invoices and Activity tabs (`app/(internal)/clients/[clientId]/page.tsx`); no separate route, the screen is a set of tabs. |
| 25 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 25 | Projects by status | BUILT | Tiles Planning, Active, On hold, Completed, Cancelled on the Projects tab (links to `/projects?status=&client=`). |
| 25 | Accepted quote value | BUILT | New in this pass: tile "Accepted quote value" (`summariseCommercials`, `src/modules/sales/client-commercial-summary.ts`; only projects that cite an accepted quotation, client currency only); the per-project figure stays in the Commercials card. |
| 25 | Paid vs outstanding | BUILT | New in this pass: tile "Paid vs outstanding" from verified payments (`invoice.read` only), plus Total paid/Outstanding on Overview. |
| 25 | Current maintenance/renewal status | BUILT | New in this pass: tile "Maintenance and renewal" ("No plan", "N plans … renewal due / not accepted yet / next ends <date>") and the per-project Maintenance line in Commercials; `tests/a-client-commercials-header-adds-only-what-rows-hold.test.ts`. |
| 25 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 25 | Project list | BUILT | "Client projects" table. |
| 25 | Commercial timeline | BUILT | Activity tab "Commercial timeline" (`readClientCommercialTimeline`). |
| 25 | Milestone schedule | BUILT | "Milestone schedule" card with dates and amounts. |
| 25 | Invoice/payment table | BUILT | Invoices tab table with Paid bars and "Next to invoice". |
| 25 | Change-request charges | BUILT | "Change-request charges" card with the total charged. |
| 25 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 25 | Open project finance | BUILT | Projects table column "Open finance" -> `/projects/[id]/finance` (`invoice.read`). |
| 25 | Create new service/project | BUILT | Header "Create project". |
| 25 | Generate invoice from approved milestone | BUILT | Invoices tab "Create invoice" and "Next to invoice: N milestones clear to bill" (`listEligibleMilestones`, same rule as the project page). |
| 25 | Start renewal/upsell flow | BUILT | "Renewal / upsell" form (`client-360-forms.tsx`, `src/modules/sales/renewal-actions.ts`); enabled once a project is completed (disabled with the reason in the seed). |
| 25 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 25 | Payment verification remains human-controlled | BUILT | Claims are verified only by a person at `/invoices/verify` (`tests/a-claim-is-not-a-payment.test.ts`); this screen only reads. |
| 25 | New feature/major change must not silently become maintenance work | BUILT | A change is a change request with its own quotation and payment before it is applied (`tests/a-change-request-is-paid-before-it-is-applied.test.ts`); maintenance items are a separate list (`tests/maintenance-coverage.test.ts`). |
| 25 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 25 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Money reads need `invoice.read`; creating invoices/renewals call doors checking `invoice.create` / `project.write`. |
| 25 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Invoices, renewals and charges are audited records; context is client -> project -> milestone. |
| 25 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Empty states with explanations ("No milestone plan on any project yet"), `error.tsx` retry. |
| 25 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Tabs plus the milestone and change-request cards; no drawers needed. |
| 25 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow on the Projects tab. |
| 25 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 25 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 26 | CLIENTS | NARRATIVE | Module label. |
| 26 | SCR-017 - Client Communication, Files & Notes | NARRATIVE | Screen heading; the screen is at /clients/[clientId] (Communication, Notes, Files, Activity tabs). |
| 26 | Primary lifecycle: Cross-phase \| Screen baseline number: 17 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 26 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 26 | Consolidated collaboration record for messages, announcements, meeting summaries, attachments and private internal notes. | BUILT | Client 360 Communication, Notes, Files and Activity tabs (`app/(internal)/clients/[clientId]/page.tsx`). |
| 26 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 26 | Unread client replies | BUILT | Tile "Unread client replies" (top of the Communication tab) and the card listing the threads, from `readClientUnreadReplies`. |
| 26 | Last announcement | BUILT | New in this pass: tile "Last announcement" (`lastAnnouncement`, `src/modules/crm/client-collaboration.ts`) beside the Announcements card. |
| 26 | Recent uploads | BUILT | New in this pass: tile "Recent uploads" plus the Recent uploads card (files stored on the client's projects). |
| 26 | Meeting decisions/open questions | BUILT | New in this pass: tile "Meeting decisions / open questions" counted from the analysis notes of the client's meetings (`meetingSignals`), labelled "proposed … not agreed until a person says so"; the Notes tab lists the notes themselves. |
| 26 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 26 | Conversation | BUILT | Communication tab: unread threads and the send form on a lead thread. |
| 26 | Announcements | BUILT | "Announcements" card (published, per client or agency-wide; a send is a campaign under Communications › Campaigns). |
| 26 | Meeting notes | BUILT | Notes tab "Meeting notes and decisions". |
| 26 | Files | BUILT | Files tab "Client files" (stored uploads first, then linked files; Drive links). |
| 26 | Internal notes | BUILT | Notes tab "Notes — Internal only — never shown to the client." |
| 26 | Activity | BUILT | New in this pass: Activity tab "Collaboration activity" (client replies, announcements, uploads, meeting notes, internal notes) beside the Commercial timeline (`collaborationFeed`, `tests/a-client-collaboration-record-says-who-and-where.test.ts`). |
| 26 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 26 | Send permitted message | BUILT | Composer on a lead thread (24-hour window and template rules apply); a project-group thread is read-only here by design (`tests/a-project-thread-is-read-not-sent.test.ts`); "No lead thread to write to" when the client has none. Delivery needs WhatsApp (not configured locally). |
| 26 | Upload/download file | BUILT | Upload form and signed-link download of uploads (`client-uploads.ts`). Not exercised: Supabase Storage is unreachable locally. |
| 26 | Add internal note | BUILT | Notes tab "Add note" (`note-form.tsx`). |
| 26 | Attach meeting summary to project memory | BUILT | `AttachMeetingSummaryForm` -> `attachMeetingSummaryToMemoryAction` (`src/modules/crm/meeting-memory-actions.ts`; once per project and note; owner or ops admin). |
| 26 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 26 | Internal notes must never be sent to the client | BUILT | Internal notes live in `core.client_notes`, read only by the Client 360 reader (`src/lib/admin/clients.ts`); no send path takes its text from a note (outbound text comes from the composer or templates); the tab says "never shown to the client" and the feed marks them "internal, never sent to the client". |
| 26 | Every file/message retains author, timestamp, source and project/client linkage | BUILT | The new feed shows author, time, source and where each item is filed ("By ravi · Filed on Project Loyalty app"); notes keep `created_by`, files keep uploader and project, messages keep direction and thread. |
| 26 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 26 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Send needs `lead.write`; memory attach is owner/ops admin; notes need `project.write`; downloads are RLS-scoped signed links. |
| 26 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Each record keeps author, timestamp, source and linkage (guardrail row above); memory attach is audited. |
| 26 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Per-tab empty states, "Every client message has been answered", `error.tsx` retry. |
| 26 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Tabs plus per-note forms; no drawer. |
| 26 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow (Communication, Activity). |
| 26 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 26 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |
| 27 | PROJECTS | NARRATIVE | Module label. |
| 27 | SCR-018 - All Projects | NARRATIVE | Screen heading; the screen is at /projects. |
| 27 | Primary lifecycle: Phase 2 onward \| Screen baseline number: 18 of 71 | NARRATIVE | Lifecycle line of the screen heading. |
| 27 | Purpose | NARRATIVE | Section label; its bullets are the rows below. |
| 27 | Portfolio-level project registry with lifecycle, phase, payment gate, health, owner and deadline visibility. | BUILT | `/projects` (`app/(internal)/projects/page.tsx`): table or cards (`?view=cards`) with stage, phase, payment gate, health, owner and deadline. |
| 27 | Header / Summary / KPI area | NARRATIVE | Section label; its bullets are the rows below. |
| 27 | Total/active/blocked/completed projects | BUILT | Tiles Total projects, Active, Blocked, At risk, Completed, Payment to verify (rendered "27 / 4 / 1 / 0 / 1 / 0"). |
| 27 | Phase distribution | BUILT | Phase tiles Onboarding … Completed with counts. |
| 27 | Payment-blocked count | BUILT | Tile "Payment to verify" (claims waiting). |
| 27 | At-risk count | BUILT | Tile "At risk" with escalated and past-due caption; the health rule is `healthOfProject` everywhere. |
| 27 | Main content and sub-screens | NARRATIVE | Section label; its bullets are the rows below. |
| 27 | Project table/cards | BUILT | Table with Project name, Client, Owner, Stage, Phase, Health, Payment gate, Progress, Due date, Budget, Created (rendered) and a Table/Cards toggle. |
| 27 | Phase filter | BUILT | Phase select (Any phase, Onboarding … Archived; `?phase=`) beside the phase tiles. |
| 27 | Health filter | BUILT | Health select (Any health, Healthy, At risk, Blocked; `?health=`). |
| 27 | Client/owner filter | BUILT | Client select and Owner select (rendered). |
| 27 | Saved views | BUILT | `SavedViewsBar` ("Save this view"). |
| 27 | Primary actions | NARRATIVE | Section label; its bullets are the rows below. |
| 27 | Create project only through allowed conversion/manual path | BUILT | No create control on the list by design: projects are made by the header Create menu, a won deal (`convertToProject`) or a template; conversion preserves the sales context. |
| 27 | Open project | BUILT | Row click and "Open project". |
| 27 | Pause/resume with reason | BUILT | `pause-resume-button.tsx` -> `setProjectStatusAction` with a reason. |
| 27 | Archive completed project | BUILT | `archive-button.tsx` on completed projects, "Show archived". |
| 27 | Guardrails, status rules and traceability | NARRATIVE | Section label; its bullets are the rows below. |
| 27 | Won lead to project conversion must preserve sales context | BUILT | Won-to-project conversion carries the handoff, requirement links, files and contact (`convertToProject`, `src/lib/admin/lead-files-carry`; `tests/lead-conversion.test.ts`, `tests/a-deal-that-is-won-says-what-was-won.test.ts`). |
| 27 | Project phase cannot jump across required approval/payment gates | BUILT | Phase gates are database triggers (`tests/phase-three-begins-where-phase-two-ends.test.ts`, `tests/phase-four-begins-where-phase-three-locks.test.ts`, `tests/milestone-unlock.test.ts`). |
| 27 | Implementation checklist for this screen | NARRATIVE | Section label; its bullets are the rows below. |
| 27 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Pause/resume/archive call project doors that check `project.write` (`src/modules/projects/service.ts`); contractors see only their projects by RLS. |
| 27 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Status changes are audited (`project.status_changed`) and require a reason for on-hold. |
| 27 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search, status/phase/health/client/owner filters, saved views, pagination, "Clear all filters". |
| 27 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Rows open the project; pause and archive are inline controls. |
| 27 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | Measured at 390 px: no overflow. |
| 27 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture / Confidential \| Page 27 of 83 | NARRATIVE | Running page footer (document name, "Confidential", page x of 83). |

## Gaps found and built in this pass

No migration, no new SQL door and no new live verifier were needed (every item reads stored rows or goes through an existing door), so no `db:verify:*` script or `verify.yml` step was added. Behavioural tests only; each new test file was run, and where it protects a defect it was also run against the old code to see it fail.

| # | Row(s) | What was wrong or missing | Built (files) | Tests / verification |
|---|---|---|---|---|
| 1 | SCR-002 "Recent searches" | **Defect.** No recent search was ever recorded: `recordSearch` looked the row up with `.eq('filters', {})`, the client writes `filters=eq.[object Object]`, PostgREST refuses it, and the function reported "Could not read recent searches". | `src/lib/admin/saved-searches.ts` (lookup now sends the filters as JSON text) | `tests/a-recent-search-is-recorded-and-found-again.test.ts` (5 tests over the real PostgREST client and a fake wire; all 5 fail on the old line); live: a search for "northwind" now shows under Recent searches |
| 2 | SCR-001 "System health: app" | No application row in System Status | `app/(internal)/dashboard/page.tsx` ("Application": configuration problems from the production checks, else "Serving · configuration clear") | rendered ("1 configuration problem" linking to Production Readiness) |
| 3 | SCR-003 "blockers" | Blocked tasks never reached the inbox (only blocker defects did) | `src/modules/projects/blocked-tasks-queries.ts`, `app/(internal)/notifications/action-items.ts` (category "Blockers": what it waits on, who acts, next action) | `tests/a-blocked-work-reaches-the-inbox.test.ts` (4); rendered "Blockers (1)" |
| 4 | SCR-004 "Schedule meeting" and recents | Entry was named "Request a meeting"; settings entries that share an anchor produced duplicate React keys and collapsed into one "recent command" | `app/(internal)/command-palette.tsx`, `palette-forms.tsx` | driven in a browser: filtered, created a draft, saw "draft saved", Recent command, Recent search, lead pre-fill |
| 5 | SCR-005 "Open lead or quotation from card" | Pipeline card linked only to the lead | `app/(internal)/sales-funnel/pipeline-board.tsx` ("Quotations" link) | tsc, lint |
| 6 | SCR-006 "Search by name, phone, email, company" | Box placeholder promised source, the filter matched company but not source | `app/(internal)/leads/page.tsx` | tsc, lint |
| 7 | SCR-007 header, tabs, overflow | Header had no requirement-version or hand-off fact; no "Meetings" tab (the section existed); no overflow actions on context headers (front matter p5) | `src/modules/crm/requirement-header.ts`, `app/(internal)/leads/[leadId]/page.tsx`, `app/(internal)/clients/[clientId]/page.tsx` (`RowActionsMenu`) | `tests/a-lead-header-says-requirements-and-handoff.test.ts` (6); rendered with seeded versions |
| 8 | SCR-010 "Upcoming" count | No Upcoming tile | `app/(internal)/meetings/page.tsx` | rendered ("Upcoming 1") |
| 9 | SCR-011 "PDF preview" | Only a link to the PDF | `app/(internal)/quotations/row-actions.tsx` (inline preview in the drawer) | opened in a browser: iframe loads `/api/quotations/<id>/pdf` (`application/pdf`, inline) |
| 10 | SCR-012 "GST vs Non-GST" | Only a GST tickbox | `app/(internal)/quotations/new/composer.tsx` ("untick for Non-GST") | tsc, lint |
| 11 | SCR-014 "on-hold clients"; "identity must deduplicate against lead/contact records" | No on-hold lifecycle chip; creating a client never looked at contacts, leads or other clients | `app/(internal)/clients/page.tsx`; `src/modules/sales/client-identity.ts`, `src/modules/sales/service.ts` (`createClientAccount` stops once on a match and names the record), `src/modules/sales/schema.ts` (`confirmDuplicate`), `app/(internal)/command-palette.tsx` | `tests/a-new-client-is-checked-against-who-the-agency-knows.test.ts` (10, the door run over the real PostgREST client); driven in a browser: "Northwind Retail" shows the existing client and the lead's contact, button becomes "Create a separate client anyway" |
| 12 | SCR-015 "GST/PAN and billing data require restricted permissions" | The editable Billing details form (with GSTIN, PAN, address) was drawn for anyone with `project.write` (a delivery lead) while the read-only view said "Restricted" | `app/(internal)/clients/[clientId]/page.tsx` (form only with `invoice.read`) | tsc, lint; not exercised as a delivery lead (see "could not verify") |
| 13 | SCR-016 header figures | Accepted quote value, paid vs outstanding and maintenance/renewal were only per project | `src/modules/sales/client-commercial-summary.ts`, `app/(internal)/clients/[clientId]/page.tsx` | `tests/a-client-commercials-header-adds-only-what-rows-hold.test.ts` (5); rendered |
| 14 | SCR-017 header and Activity | No Last announcement, Recent uploads or meeting decisions/open questions tiles; Activity tab was the commercial timeline only | `src/modules/crm/client-collaboration.ts`, `app/(internal)/clients/[clientId]/page.tsx` | `tests/a-client-collaboration-record-says-who-and-where.test.ts` (8); rendered |
| 15 | Owner decision R2 #1 (no lead number) | The seeded demo activity still read "Lead qualified with a score of 82." and showed on Sales & CRM "Recent Activities" | `supabase/seed.sql` and the local row | rendered |

Also checked, no change needed: the stage move audit (`opportunity.stage_changed` with before and after), the quotation preview PDF in the composer (the audit note that it was only an on-screen preview was stale), requirement version rendering (all nine sections, version history, send/approve/reject/revise), meeting detail for requested, booked and completed meetings, disqualification history (populated), permission-denied for finance and contractor sessions.

## Open QUESTIONs

1. **Q-NAV (p3 "Navigation recommendation").** The sidebar uses the reference screenshots' module names (Communications, Approvals, Analytics & Costs, Security & Audit, Organization) instead of the PDF's (Communication, Governance & Security, Settings). A comment in `app/(internal)/nav-config.ts` says the owner chose that on 2026-10-03, but it is not in `docs/ui-parity/owner-decisions.md` and `docs/ui-parity/S.md` still lists it as open. Confirm and record it, or restore the PDF's names.
2. **Q-PH56 (p4, Phase 5 and Phase 6 rows).** Phase 4 raises the M2 invoice and sends the PM Task 2 message by itself. Nothing does the same for Phase 5 (M3, PM Task 3) or Phase 6 (M4, PM Task 4); M3 and M4 are invoiced by a person from "Next to invoice". Should completing Phase 5 and 6 raise those invoices and messages automatically, and what completes each phase? (This also touches the Development and QA pages in the next slices.)
3. **Q-BAND (SCR-008 "Budget band").** What are the band boundaries, and may the owner edit them? Today budget is a figure or "Not recorded".
4. **Q-OVERRIDE (SCR-008 "Approve/override score with reason").** Owner decision R2 #1 replaced the score with a Hot/Warm/Cold label worked out from reasons, and the override controls were removed. Should a person be able to override the label with a reason (original kept, audited)?
5. **Q-CHIPS (SCR-014 lifecycle).** "Active Clients" equals Total (every client's status is active) and "Pending" overlaps Active. What do Active, Pending, Completed and On hold mean for a client? (On hold was added as "has a project on hold".)

## NOT-BUILDABLE here

- SCR-010 Propose a time, live availability and the Google Calendar event with Meet link need a Google service-account key. The screen says availability is unconfigured instead of inventing slots. The logic is built and tested with fakes (`src/lib/scheduling/*`, `tests/a-slot-is-offered-and-taken.test.ts`, `tests/a-retry-that-books-twice.test.ts`).

## What could not be verified (honest list)

- **WhatsApp delivery** (Lead 360 message, template send, "Send to client for confirmation", follow-up nudges): no credential locally; the doors are tested with fakes only.
- **File upload and download** (Client 360 Files, Communication uploads): Supabase Storage is unreachable locally; the form says so. Not exercised.
- **Organization switcher** with more than one membership: the seed has one membership per user.
- **Role variants beyond owner, finance and contractor:** the delivery-lead branch of the Billing details form was not rendered (the login override did not change the role the page reads). It is a one-condition change read in the source.
- **Pipeline drag and drop** was read in the source but not performed (it would change the seeded deal); the won gate and the audit trigger were read, not driven.
- **Populated meeting/requirement/disqualification states** were rendered with temporary seeded rows tagged `zzbuild-trace-a` and then deleted. Audit rows are append-only, so three `meeting.*` audit entries from those rows remain in the local audit log.
- Rows judged from the front matter and the Phase-to-Admin matrix point at the screens that carry the evidence; the line-level proof of those screens (pages 28 onward) belongs to the other trace slices.
- The 71 inventory rows for screens 19-71 prove only that the route files exist and are in the sidebar; their content is traced by the next slices.

## Measured at 390 px (no horizontal page overflow, owner session)

/dashboard, /search, /notifications, /sales-funnel, /leads, /leads/[id] (with a requirement thread), /leads/[id]/qualification, /quotations, /quotations/new, /follow-ups, /meetings, /meetings/[id], /clients, /clients?status=on_hold, /clients/[id] on all nine tabs, /projects, and the command palette open. Every one reported overflow 0. The same pages were rendered at 1536 px.

## Checks run

`npx tsc --noEmit -p .` clean; `npx eslint` on every changed file with `--max-warnings=0` clean; 803 tests pass in the related set (the six new files plus `the-shell-explains-itself`, `w3-inbox-search-and-client-rules`, `read-failure-semantics` on Node 26, `every-control-has-a-name-a-screen-reader-can-read`, `a-pin-that-cannot-fail`, `admin-nav-config`, the lead, quotation, client and palette tests). The full suite was not run.
