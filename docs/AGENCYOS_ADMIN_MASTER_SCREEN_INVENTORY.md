# AgencyOS Admin Panel — Master Screen Inventory

The one authoritative list of admin screens, with permanent IDs. A screen
does not exist in this product until it has a row here; a row here names the
route that serves it, the capability that guards it, the data it reads, the
live topics it listens to, and its status against the definition of done.

**Source of truth for the list:** `admin panel ui single truth/AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`
(v1.0, 71 screens, §5 inventory + §6 per-screen requirements). The Phase 1
blueprint (`Phase 1 documents/AgencyOS_Phase1_Admin_Panel_Screen_by_Screen_Blueprint.pdf`,
A01–A34) is the older, Phase-1-only inventory; every A-screen maps onto an
SCR row below (mapping in §3) and no A-screen survives as a separate ID.

**Navigation:** the fifteen modules are the sidebar, in this order —
`app/(internal)/nav-config.ts`, tested by `tests/admin-nav-config.test.ts`.

**Status vocabulary** (per the definition of done in
`AGENCYOS_ADMIN_TEST_MATRIX.md` §1):

- `COMPLETE` — route, guard, real data, all five states, live where applicable, tests.
- `PARTIAL` — functional but a named requirement is missing; the gap is stated.
- `GROUPED` — served as a tab/drawer/section of another screen, as §8 of the PDF permits ("intentionally grouped tab/drawer").
- `DECLINED` — deliberately not built, with the reason recorded in `admin-panel-screen-traceability.md`.

`Live` names the realtime topics (`src/lib/realtime/topics.ts`) the screen
subscribes to through `LiveRefresh`; `—` means the screen refreshes on its
own writes (`revalidatePath`) and on navigation, which is right for a form or
a record that only its editor changes.

## 1. Inventory

### Global Control

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-001 | Command Center | `/dashboard` | `project.read` | `getOverview`, `getRecentLeads`, `getActiveProjectsSummary`, `getRevenueThisMonth`, `getAgentUsage`, `getSalesFunnel`, `getProjectCountsByStatus`, `listActionItems` | approvals, finance, jobs, leads, projects, agents | COMPLETE |
| SCR-002 | Global Search | ⌘K palette (every page) | rail-filtered | `globalSearch` (lead/client/project/invoice, RLS-scoped) | — | GROUPED (in shell) |
| SCR-003 | Notifications & Action Center | `/notifications` + header bell | internal | `listActionItems` (6 sources) | approvals, finance, jobs, qa, tasks, conversations | COMPLETE |
| SCR-004 | Quick Create / Command Palette | ⌘K palette → New lead / New client | `lead.write` / `project.write` | `createLeadAction`, `createClientAccountAction` | — | GROUPED (in shell) |

### Sales & CRM

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-005 | Sales Overview & Pipeline | `/sales-funnel` | `lead.read` | `salesFunnel`, `listOpportunities` (Kanban, 3 open stages) | — | COMPLETE |
| SCR-006 | Leads List | `/leads` | `lead.read` | `listLeadsForTable` (avatar + company cells), `listLeadsNeedingAttention`, saved views | — | COMPLETE |
| SCR-007 | Lead 360 | `/leads/[leadId]` | `lead.read` | lead + `getLeadFacts`, conversation, requirements, quotations, meetings, follow-ups, timeline (three panes: information · chat · deal) | — | COMPLETE |
| SCR-008 | Qualification & Scoring | `/leads/[leadId]` › Sales panel | `lead.read` | `crm.qualification_coverage` | — | GROUPED (ADM-88: no numeric score by decision) |
| SCR-009 | Requirements Discovery | `/leads/[leadId]` › requirement decision | `lead.read` | `crm.requirement_versions` | — | GROUPED |
| SCR-010 | Meetings | `/meetings`, `/meetings/[meetingId]` | `lead.read` | meetings, evidence, calendar verification | — | COMPLETE |
| SCR-011 | Quotations List | `/quotations` | `lead.read` | `listProposals`, saved views | — | COMPLETE |
| SCR-012 | Create / Edit Quotation | `/quotations/new` + Lead 360 panels | `proposal.draft` | `composeQuotationAction` → draftProposal, addProposalItem, setProposalPricing, submitProposal | — | COMPLETE |
| SCR-013 | Follow-ups & Nurture | `/follow-ups` | `lead.read` | `listFollowUpSequences` | — | COMPLETE |

### Clients

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-014 | Client Management | `/clients` | `project.read` | `listClients`, name/email search, CSV export (`/api/clients/export`) | — | COMPLETE |
| SCR-015 | Client 360 | `/clients/[clientId]` | `project.read` | `getClient` (projects, invoices, communication, files, notes) | — | COMPLETE |
| SCR-016 | Client Projects & Commercials | `/clients/[clientId]` › projects/invoices | `project.read` | same | — | GROUPED |
| SCR-017 | Client Communication, Files & Notes | `/clients/[clientId]` › communication/files/notes | `project.read` | `crm.conversations` (project_group), `project_files`, `core.client_notes` (20260928120000) | — | COMPLETE (notes gap closed) |

### Projects

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-018 | All Projects | `/projects` | `project.read` | `listProjectsForTable` (client, milestone progress, stage filter), saved views | — | COMPLETE |
| SCR-019 | Project Overview (Project 360) | `/projects/[projectId]` | `project.read` | project, plan, billing ladder, phases 2–4, QA, approvals, deliverables | — | COMPLETE |
| SCR-020 | Project Board | `/projects/[projectId]/board` | `task.write` to drag | `projects.tasks` (Kanban, validated transitions; audited since 20260929130000) | — | COMPLETE |
| SCR-021 | My Tasks | `/my-tasks` | internal | `listMyTasks` | — | COMPLETE |
| SCR-022 | Project Calendar | `/projects/[projectId]/calendar` | `project.read` | tasks + milestones + meetings by date (`MonthGrid`) | — | COMPLETE |
| SCR-023 | Project Milestones / Gantt | `/projects/[projectId]/plan` (Gantt) + `/calendar` | `project.read` | `listPaymentPlan` (`projects.milestones`), plan milestones | — | COMPLETE — bars are the planned windows between due dates (derived, labelled as such); the schema holds no start date, and the page says so |
| SCR-024 | Project Files | `/projects/[projectId]/files` | `project.write` to add/edit | `projects.project_files` (link-based; rename/refile through `updateProjectFile`) | — | COMPLETE |
| SCR-025 | Project Team | `/projects/[projectId]/team` | `project.read` (`project.write` to set the lead) | `listProjectTeam`, `listInternalRoster`, `projects.delivery_lead_id` through `setDeliveryLead` | — | COMPLETE |
| SCR-026 | Project Reports | `/projects/[projectId]/reports` (+ `/reports` org-wide) | `project.read` | plan, board, defects, invoices, expenses, agent spend — the tabs' own readers, no stored trend | — | COMPLETE |
| SCR-027 | Project Settings, Activity & Templates | `/projects/[projectId]/settings`, `/activity` | `project.write` | visibility, activity timeline | — | COMPLETE (templates DECLINED — traceability row 27) |

### Requirements & Scope

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-028 | Requirements Dashboard | `/requirements` | `lead.read` | pending requirement decisions across leads | — | COMPLETE |
| SCR-029 | Requirement Set / Detail | `/leads/[leadId]` › versions | `lead.read` | `crm.requirement_versions` in full | — | GROUPED |
| SCR-030 | Scope Versions & Freeze | `/projects/[projectId]/scope` | `project.write` | `readScopeBaseline`, `listScopeVersionHistory`, `listScopeItemsForVersion` (title-matched compare with the current baseline), change-request KPI row | — | COMPLETE |
| SCR-031 | Change Requests & Traceability | `/projects/[projectId]/scope` › change requests | `project.write` | `projects.change_requests` (classify / decide / apply) | — | COMPLETE |

### Design & Prototype

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-032 | Design Dashboard | `/design` (portfolio) → `/projects/[projectId]/design` | `project.read` | `readDesignPortfolio` (3 reads, grouped); per-project `readDesignTrail` | deliverables, projects | COMPLETE (portfolio index added 2026-09-29) |
| SCR-033 | UI Theme Finalization | `/projects/[projectId]/design/themes` | `project.read` | theme options, color options, token sets | — | COMPLETE |
| SCR-034 | Screen Inventory | `/projects/[projectId]/design` › gallery | `project.read` | `projects.screen_baselines`, `readSampleScreens` (`representative_screens`) | — | COMPLETE — gallery of representative screens with stored previews; Figma stays canonical |
| SCR-035 | Screen Detail / Coverage Matrix | `/projects/[projectId]/ui-versions/[uiVersionId]` | `project.read` | UI version detail, coverage | — | COMPLETE |
| SCR-036 | Design Review & Approval | `/projects/[projectId]/design/final` | `project.read` | client decisions, revision history, lock | — | COMPLETE |
| SCR-037 | Prototype Builds & Review | `/projects/[projectId]/prototype`, `/prototype/preview/[uiVersionId]` | `project.read` | prototype artifacts, build table with client decision · latest QA run · approval state | — | COMPLETE |
| SCR-038 | Assets, Brand Kit & Feedback History | `/design/themes` (brand kit) + `/design/final` (feedback) | `project.read` | token sets, design assets, decisions | — | GROUPED |

### Development

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-039 | Development Dashboard | `/development` (portfolio) → `/projects/[projectId]/development` | `project.read` | `readDevelopmentPortfolio` (4 reads, grouped) | tasks, deliverables, projects | COMPLETE (portfolio index added 2026-09-29) |
| SCR-040 | Implementation Plan | `/projects/[projectId]/plan` | `project.write` | `readPlanBoard` (6 of 18 registers; rest derived — traceability row 40) | — | COMPLETE |
| SCR-041 | Development Task Execution | `/projects/[projectId]/development` | `task.write` | modules → features → tasks | — | COMPLETE |
| SCR-042 | Repository, Branch & Code Review | `/projects/[projectId]/repository` | `project.write` | `projects.repositories` (link-based) | — | PARTIAL — no live Git integration (owner-confirmed link model) |
| SCR-043 | Builds, Environments & Dependencies | `/projects/[projectId]/builds` | `project.write` | builds (deliverables), `environments`, `dependencies` | — | COMPLETE |

### QA & Release

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-044 | QA Dashboard | `/qa` | `project.read` | `listOpenDefects`, `readOrgTestCoverage`, `readSuiteCoverage` | qa, deliverables | COMPLETE |
| SCR-045 | Test Plan & Cases | `/projects/[projectId]/qa` | `project.write` | `qa.test_plans`, `test_plan_items` | — | COMPLETE |
| SCR-046 | Test Runs | `/projects/[projectId]/qa` | `project.write` | `qa.test_runs` | — | COMPLETE |
| SCR-047 | Bugs & Defects | `/qa` + per project | `project.read` | `qa.defects` | qa | COMPLETE |
| SCR-048 | Regression, Compatibility & Performance | `/qa` › suites | `project.read` | `readSuiteCoverage` | qa | GROUPED |
| SCR-049 | Production Readiness & Release Candidate | `/production-readiness` | `organization.settings` | evidence-based checklist, release gates | — | COMPLETE |

### Finance

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-050 | Finance Overview | `/finance` | `invoice.read` | `listInvoices`, `listPayments`, `listExpenses`, pending claims (income vs expenses, payment status, top revenue, upcoming) | — | COMPLETE |
| SCR-051 | Invoices | `/invoices` | `invoice.read` | `listInvoices`, saved views | — | COMPLETE |
| SCR-052 | Invoice Detail / Create | `/invoices/[invoiceId]` | `invoice.issue` to act | invoice, items, billing profile (mode · GSTIN · address, `readInvoiceBillingProfile`), GST line, linked milestone, payments, payment claims (`listInvoicePaymentClaims`), receipts, refunds, receiving accounts | — | COMPLETE |
| SCR-053 | Payments | `/finance/payments` | `invoice.read` | `listPayments` | — | COMPLETE |
| SCR-054 | Payment Verification | `/invoices/verify` | `invoice.issue` | `listPendingPaymentClaims` (human-only gate) | — | COMPLETE |
| SCR-055 | Expenses & Profitability | `/finance` (net profit, margin, expense breakdown) + `/finance/expenses` | `invoice.read` (`invoice.issue` to record/edit) | `listExpenses`, `listPayments`, `listInvoices`; `recordExpense`, `updateExpense` | — | COMPLETE — net = payments received − expenses recorded, margin over received; stated on the tile, not an accounting P&L |
| SCR-056 | GST, Tax & Financial Reports | `/finance/tax` (+ `/api/finance/tax/export`) | `invoice.read` | `listTaxReportInvoices` split by the CONFIRMED billing mode (GST / non-GST / unconfirmed), period selector (month, quarter, Indian FY), receipts (`listReceipts`), cash-basis P&L against expenses, CSV | — | COMPLETE — no GST return generation (needs GST-portal integration, stated on the page) |

### Communication

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-057 | Communication Center | `/communication` | `lead.read` | conversations, rollups | — | COMPLETE |
| SCR-058 | WhatsApp / Conversations | `/leads/[leadId]` › thread | `lead.read` | `listMessages` (chat view, 24-hour window state) | — | GROUPED |
| SCR-059 | Templates & Announcements | `/settings/communication` | `organization.settings` | `crm.whatsapp_templates` registry, outreach limits, sending window | — | COMPLETE (broadcast DECLINED — traceability row 59) |
| SCR-060 | Delivery Failures, Outbox & Meeting Notes | `/operations` + `/meetings/[meetingId]` | `audit.read` | failed deliveries, deferred sends, meeting evidence | jobs, conversations, followUps | COMPLETE |

### AI Workforce

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-061 | AI Workforce Dashboard | `/agents` | `audit.read` | agent registry, runnability, usage | — | COMPLETE |
| SCR-062 | Agent Registry | `/agents` | `audit.read` | `ai.agents` (activation is an owner DB decision — ADM-82) | — | COMPLETE |
| SCR-063 | Agent Detail & Permissions | `/agents/[agentKey]` | `audit.read` | definition, ceilings, recent runs, failures | — | COMPLETE |
| SCR-064 | Model Routing, Providers & Tools | `/agents/routing` | `organization.settings` | routing policies, provider vault status | — | COMPLETE |
| SCR-065 | Agent Runs, Usage, Cost & Automations | `/agents/automations`, `/usage` | `audit.read` | runs, cost ledger, automations | — | COMPLETE |

### Operations

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-066 | Operations Dashboard | `/operations` | `audit.read` (`job.requeue` to act) | `operational_backlog`, dead jobs, requeue | jobs, conversations, followUps | COMPLETE |
| SCR-067 | System Health, Production Readiness & Alerts | `/operations` + `/production-readiness` + `/integrations` | `audit.read` / `organization.settings` | cron age, failed deliveries, integration lifecycle | jobs | GROUPED |

### Governance & Security

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-068 | Approval Center, Policies & Overrides | `/approvals`, `/approvals/[requestId]`, `/settings/approvals` | internal (per-request lock decides) | `listPendingApprovals`, `listDecidedApprovals` (KPI row, recent decisions), policies | approvals | COMPLETE |
| SCR-069 | Security, Roles & Audit Log | `/security`, `/security/users`, `/audit` (+ `/api/audit/export`) | `audit.read` | invariant scan, roles, `audit.audit_log` with subject/actor/date filters and per-entry before/after diff | audit (audit page) | COMPLETE |

### Integrations

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-070 | Integrations Center & Import | `/integrations`, `/import`, `/import/[batchId]` | `organization.settings` | lifecycle registry, import staging | jobs | COMPLETE |

### Organization Settings

| ID | Screen | Route | Guard | Reads | Live | Status |
|---|---|---|---|---|---|---|
| SCR-071 | Organization Settings & Business Rules | `/settings` (General, Commercial, Team, Communication, Approvals, Finance) | `organization.settings` | `core.organizations.settings` through `set_organization_setting` (whitelist + audit); `finance.payment_accounts` (Doc 15 §9) through `createPaymentAccount` / `setPaymentAccountStatus` | — | COMPLETE |

## 2. Totals

| Status | Count | Screens |
|---|---|---|
| COMPLETE | 56 | — |
| GROUPED | 12 | 002, 004, 008, 009, 016, 026, 029, 038, 048, 058, 067 + 003's bell |
| PARTIAL | 2 | 042 (link-based repo — no VCS integration), 056 (GST return — register only, no filing) |
| DECLINED (sub-features) | 3 | 027 templates, 059 broadcast, 008 numeric score |
| MISSING | 0 | — |

Every PARTIAL names a real schema or integration gap rather than UI work
left undone; each is recorded with its reasoning in
`docs/admin-panel-screen-traceability.md`.

## 3. Phase 1 blueprint (A01–A34) → SCR mapping

| A | Blueprint screen | SCR |
|---|---|---|
| A01 | Admin Overview Dashboard | SCR-001 |
| A02 | Global Search | SCR-002 |
| A03 | Lead List | SCR-006 |
| A04 | Lead Detail / 360 | SCR-007 |
| A05 | WhatsApp Conversation | SCR-058 |
| A06 | Requirements Workspace | SCR-009 / SCR-029 |
| A07 | Requirement Version Compare | SCR-029 (versions listed in full; no side-by-side diff — see traceability) |
| A08 | Scheduler Calendar | SCR-010 |
| A09 | Meeting Detail | SCR-010 |
| A10 | Quotation List | SCR-011 |
| A11 | Quotation Detail | SCR-012 |
| A12 | Quotation Version Compare | SCR-011 (superseded versions retained; per-version approval shown) |
| A13 | Approval Center | SCR-068 |
| A14 | Approval Detail | SCR-068 (`/approvals/[requestId]`) |
| A15 | Negotiation Workspace | SCR-007 (objections, rounds, limits on the Lead 360 sales panel) |
| A16 | Workflow Task Board | SCR-066 |
| A17 | Task Detail / Execution Trace | SCR-065 |
| A18 | Dependency / Blocker View | SCR-066 + `/projects/escalations` |
| A19 | AI Workforce Dashboard | SCR-061 |
| A20 | Agent Detail | SCR-063 |
| A21 | Routing / Model Trace | SCR-064 |
| A22 | Integrations Hub | SCR-070 |
| A23 | Integration Detail / Health | SCR-070 |
| A24 | Policies & Controls | SCR-068 / SCR-071 |
| A25 | Pricing / Discount Rules | SCR-071 (Commercial tab) |
| A26 | Notification Rules | SCR-071 (Communication tab) |
| A27 | Audit Timeline | SCR-069 |
| A28 | System Health / Jobs | SCR-066 |
| A29 | Incidents / Recovery Queue | SCR-066 |
| A30 | Users / Roles / Access | SCR-069 (`/security/users`) |
| A31 | Organization Settings | SCR-071 |
| A32 | Profile / Preferences | not built — P2 in the blueprint; no requirement in the 71-screen architecture |
| A33 | Readiness / Release View | SCR-049 |
| A34 | Help / System Documentation | not built — P2 in the blueprint; no requirement in the 71-screen architecture |

## 4. Rules for changing this file

- A new admin page gets the next free `SCR-` number **and** a row in
  `nav-config.ts` (or a tab under a row that has one). The nav test fails
  for a top-level page that is not reachable from the rail.
- A status moves to COMPLETE only against the definition of done in the
  test matrix — not because a page renders.
- A DECLINED sub-feature keeps its reasoning in the traceability doc; this
  file only points at it.
