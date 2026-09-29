# AgencyOS Admin Panel — Implementation Matrix vs. the 71-Screen Blueprint

Stage 2 discovery deliverable. Maps the PDF's 71-screen baseline
(`admin panel ui single truth/AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`)
to the current repo implementation under `app/(internal)/**`. Read-only
analysis; no application code was modified.

## How to read this matrix

Two independent things are being judged and can disagree:

1. **Backend/functional completeness** — does a route exist, is it wired to
   a real Supabase reader/writer, does the data match what the screen is
   supposed to show. This repo already has its own detailed, evidence-based
   audit of this dimension: `docs/admin-panel-screen-traceability.md`
   (dated 2026-09-22, methodology: routes + server actions + lib functions
   checked directly, corrected twice after an initial route-only pass
   missed non-route implementations). Its headline result: **69 of 71
   screens EXISTS, 2 PARTIAL, 0 MISSING** at the backend/route level. That
   finding is corroborated independently in this audit (a fresh repo sweep
   for this task reached the same route list and the same two PARTIAL
   screens).

2. **Visual/design-system completeness against the new source of truth** —
   does the screen's UI use the dark-sidebar, KPI-card, chip/table/Kanban
   visual language established by the 43 reference screenshots (see
   `docs/AGENCYOS_UI_SOURCE_AUDIT.md`). **On this dimension, the answer is
   uniformly no.** The current UI runs a different, custom-built design
   system (`src/ui/*` — `Button`, `Card`, `Badge`/`StatusBadge`,
   `DataTable`, `PageHeader`, `Stat`/`StatGrid`, `Drawer`, `EmptyState`,
   `FilterBar`) with its own token/color model (`src/ui/tokens.ts`,
   CSS variables in `app/globals.css`). It does not have a dark sidebar
   shell, does not have a Kanban-board primitive, does not have a donut/line
   chart primitive, and its status-color mapping is not necessarily the
   same as the screenshots' green/amber/red/blue vocabulary. **No screen in
   the repo currently matches the visual source of truth.**

Given that, this matrix uses **NEEDS_REDESIGN** as the dominant
classification for every screen that is functionally implemented but has
not been reskinned to the new visual language — this is expected at Stage 2
of a redesign program and is not itself a defect. The other classifications
(COMPLETE, PARTIAL, BROKEN, MOCKED, OUTDATED, MISSING) are reserved for
functional/data-completeness findings layered underneath that redesign
need, per the evidence in `admin-panel-screen-traceability.md` and this
task's own repo sweep.

**MOCKED — explicit negative finding:** a targeted grep of all admin code
for `mock|fake|dummy|hardcod|placeholder` found no hardcoded/mock data
arrays feeding any admin screen; every page reads through a typed module
query function against Supabase. Several page-level doc comments state an
explicit anti-mock policy (e.g. dashboard: "a signal that could not be READ
shows DATA UNAVAILABLE, never 0"). **No screen in this matrix is classified
MOCKED.**

**BROKEN — no evidence found.** This audit did not execute the app or run
tests, so BROKEN is not asserted for any screen; a runtime QA pass would be
needed to confirm or rule it out.

---

## Global Control (001-004) — `app/(internal)/dashboard`, `notifications`, `command-palette.tsx`

| Screen | Classification | Evidence |
|---|---|---|
| 001 Command Center | NEEDS_REDESIGN | `app/(internal)/dashboard/page.tsx` — functioning overview built from `getOverview()`/`agencyClock()`; custom `src/ui` components, no dark-sidebar/KPI-chip visual match |
| 002 Global Search | NEEDS_REDESIGN | `src/lib/admin/global-search.ts` + `command-palette.tsx` — functional, not a dedicated route; visual style not evaluated against source (embedded in shared shell) |
| 003 Notifications & Action Center | NEEDS_REDESIGN | `app/(internal)/notifications/page.tsx` — aggregates 6 live sources; deliberately no unread badge in nav per its own doc comment |
| 004 Quick Create / Command Palette | NEEDS_REDESIGN | `command-palette.tsx` — ⌘K nav + New lead/New client forms |

## Sales & CRM (005-013) — `app/(internal)/{leads,sales-funnel,quotations,meetings,follow-ups,requirements}`

| Screen | Classification | Evidence |
|---|---|---|
| 005 Sales Overview & Pipeline | NEEDS_REDESIGN | `sales-funnel/page.tsx` — stage/drop-off funnel + open-pipeline grouping; no drag-drop Kanban (a stated, deliberate scope decision, not a gap) |
| 006 Leads List | NEEDS_REDESIGN | `leads/page.tsx` |
| 007 Lead 360 | NEEDS_REDESIGN | `leads/[leadId]/page.tsx` (+ sales-panel, quotation-panel, plan-set-panel, meeting-request-form, message-form, requirement-decision-form) |
| 008 Qualification & Scoring | NEEDS_REDESIGN | `leads/[leadId]/sales-panel.tsx` — no numeric cross-lead score rollup (deliberate, per `crm.qualification_coverage` migration comment) |
| 009 Requirements Discovery | NEEDS_REDESIGN | same surface as #028 (per-lead `requirement-decision-form.tsx`) |
| 010 Meetings | NEEDS_REDESIGN | `meetings/page.tsx`, `[meetingId]/controls.tsx` |
| 011 Quotations List | NEEDS_REDESIGN | `quotations/page.tsx` + `listProposals()` |
| 012 Create / Edit Quotation | NEEDS_REDESIGN | `leads/[leadId]/quotation-panel.tsx` (per-lead only — a standalone editor is structurally impossible since `sales.proposals.opportunity_id` is NOT NULL; not a gap) |
| 013 Follow-ups & Nurture | NEEDS_REDESIGN | `follow-ups/page.tsx` + `listFollowUpSequences()` |

## Clients (014-017) — `app/(internal)/clients`

| Screen | Classification | Evidence |
|---|---|---|
| 014 Client Management | NEEDS_REDESIGN | `clients/page.tsx` |
| 015 Client 360 | NEEDS_REDESIGN | `clients/[clientId]/page.tsx` |
| 016 Client Projects & Commercials | NEEDS_REDESIGN | `clients/[clientId]/page.tsx` — projects/invoices/financial stats |
| 017 Client Communication, Files & Notes | PARTIAL | Files and Communication both roll up correctly (`getClient()`, `crm.conversations` project_group); **Notes has no backing column/table on `core.client_accounts` at all** — a real data-model gap, not a UI gap |

## Projects (018-027) — `app/(internal)/projects`

| Screen | Classification | Evidence |
|---|---|---|
| 018 All Projects | NEEDS_REDESIGN | `projects/page.tsx` |
| 019 Project Overview | NEEDS_REDESIGN | `projects/[projectId]/page.tsx` |
| 020 Project Board | NEEDS_REDESIGN | `projects/[projectId]/board/page.tsx` — read-only status board (no drag-drop Kanban primitive in `src/ui` yet; screenshots' Kanban style is the target) |
| 021 My Tasks | NEEDS_REDESIGN | `my-tasks/page.tsx` |
| 022 Project Calendar | NEEDS_REDESIGN | `projects/[projectId]/calendar` |
| 023 Project Milestones / Gantt | NEEDS_REDESIGN | `projects.milestones` + calendar list view — no Gantt bar chart (deliberate: schema has only a single `due_on` date per task/milestone, no `starts_on`, so a Gantt bar has nothing to draw from) |
| 024 Project Files | NEEDS_REDESIGN | `projects/[projectId]/files` + `projects.project_files` — link-based (URLs), not a Supabase Storage/blob upload flow like the screenshots show |
| 025 Project Team | NEEDS_REDESIGN | `projects/[projectId]/team` + `listProjectTeam()` (derived from task assignees, not a dedicated membership table) |
| 026 Project Reports | NEEDS_REDESIGN | `(internal)/reports` (global) + per-project invoice/defect data already on Overview |
| 027 Project Settings, Activity & Templates | NEEDS_REDESIGN | `projects/[projectId]/activity`, `/settings` — no template management (deliberate: nothing left to template that isn't already schema/quotation-derived) |

## Requirements & Scope (028-031) — `app/(internal)/requirements`, `projects/[projectId]/scope`

| Screen | Classification | Evidence |
|---|---|---|
| 028 Requirements Dashboard | NEEDS_REDESIGN | `requirements/page.tsx` — cross-lead pending-decision queue |
| 029 Requirement Set / Detail | NEEDS_REDESIGN | rendered inline on `leads/[leadId]/page.tsx`, not a separate route |
| 030 Scope Versions & Freeze | NEEDS_REDESIGN | `projects/[projectId]/scope` + `listScopeVersionHistory()` |
| 031 Change Requests & Traceability | NEEDS_REDESIGN | `projects.change_requests` + classify/decide/apply screen |

## Design & Prototype (032-038) — `projects/[projectId]/design/**`

| Screen | Classification | Evidence |
|---|---|---|
| 032 Design Dashboard | NEEDS_REDESIGN | `projects/[projectId]/design/page.tsx` |
| 033 UI Theme Finalization | NEEDS_REDESIGN | `design/themes`, `.color_options` |
| 034 Screen Inventory | NEEDS_REDESIGN | `readDesignTrail` / `projects.screen_baselines` |
| 035 Screen Detail / Coverage Matrix | NEEDS_REDESIGN | `readSampleScreens` / `projects.representative_screens` |
| 036 Design Review & Approval | NEEDS_REDESIGN | `design/final/page.tsx` — no client-facing send channel exists (a stated integration limitation, not a UI gap) |
| 037 Prototype Builds & Review | NEEDS_REDESIGN | `projects/[projectId]/prototype` — filters existing `deliverables` reader |
| 038 Assets, Brand Kit & Feedback History | NEEDS_REDESIGN | split across `design/themes` (brand kit) and `design/final` (feedback/revision history) rather than one page — intentional IA split |

## Development (039-043) — `projects/[projectId]/{development,plan,repository,builds}`

| Screen | Classification | Evidence |
|---|---|---|
| 039 Development Dashboard | NEEDS_REDESIGN | `projects/[projectId]/development` |
| 040 Implementation Plan | NEEDS_REDESIGN | `projects/[projectId]/plan` — covers 6 of the PDF's 18 registers; rest are stated as derived/Phase-3-owned |
| 041 Development Task Execution | NEEDS_REDESIGN | `development/page.tsx` — real module→feature→task board on `projects.modules/.features/.tasks` |
| 042 Repository, Branch & Code Review | NEEDS_REDESIGN | `projects/[projectId]/repository` + `projects.repositories` — link-based, no live Git integration |
| 043 Builds, Environments & Dependencies | NEEDS_REDESIGN | `projects/[projectId]/builds` + `projects.environments`/`.dependencies` — link-based |

## QA & Release (044-049) — `app/(internal)/qa`, `projects/[projectId]/qa`, `production-readiness`

| Screen | Classification | Evidence |
|---|---|---|
| 044 QA Dashboard | NEEDS_REDESIGN | `(internal)/qa/page.tsx` (org-wide) + per-project `qa-panel.tsx` |
| 045 Test Plan & Cases | NEEDS_REDESIGN | `qa.test_plans`/`.test_plan_items`, real reader+writer |
| 046 Test Runs | NEEDS_REDESIGN | `qa.test_runs`, real reader+writer |
| 047 Bugs & Defects | NEEDS_REDESIGN | `qa.defects`, aggregated org-wide |
| 048 Regression, Compatibility & Performance | NEEDS_REDESIGN | `readSuiteCoverage()` — 30-day run/pass/fail by suite |
| 049 Production Readiness & Release Candidate | NEEDS_REDESIGN | `(internal)/production-readiness/page.tsx` — evidence-based checklist |

## Finance (050-056) — `app/(internal)/finance`, `invoices`

| Screen | Classification | Evidence |
|---|---|---|
| 050 Finance Overview | NEEDS_REDESIGN | `finance/page.tsx` |
| 051 Invoices | NEEDS_REDESIGN | `invoices/page.tsx` |
| 052 Invoice Detail / Create | NEEDS_REDESIGN | `invoices/[invoiceId]/invoice-panel.tsx` |
| 053 Payments | NEEDS_REDESIGN | `finance/payments` + `listPayments()` |
| 054 Payment Verification | NEEDS_REDESIGN | `invoices/verify` |
| 055 Expenses & Profitability | PARTIAL | `finance/expenses/page.tsx` shows a real "by project" invoiced/paid/expense comparison; **`expense-form.tsx` (new-expense entry) has no backing schema/table** per its own code comment — margin/profitability computation is deliberately not attempted (real accounting-policy decision deferred, not an oversight) |
| 056 GST, Tax & Financial Reports | PARTIAL | `finance/tax/page.tsx` — invoice register + tax totals exist; no GST filing/return generation (explicit, stated scope boundary requiring a real GST-portal integration this deployment doesn't have) |

## Communication (057-060) — `app/(internal)/communication`, `operations`

| Screen | Classification | Evidence |
|---|---|---|
| 057 Communication Center | NEEDS_REDESIGN | `communication/page.tsx` |
| 058 WhatsApp / Conversations | NEEDS_REDESIGN | conversation list links to `leads/[leadId]`'s full chat-bubble thread (`listMessages()`) — one hop away, not a standalone thread view |
| 059 Templates & Announcements | NEEDS_REDESIGN | `crm.whatsapp_templates` (metadata registry only — Meta owns approved wording); no broadcast/bulletin feature (deliberately declined — no consent-category basis in any business doc) |
| 060 Delivery Failures, Outbox & Meeting Notes | NEEDS_REDESIGN | `(internal)/operations` (`listFailedDeliveries`, `listDeferredSends`) + `crm.meeting_evidence` (kind='notes') on `meetings/[meetingId]/page.tsx` |

## AI Workforce (061-065) — `app/(internal)/agents`, `usage`

| Screen | Classification | Evidence |
|---|---|---|
| 061 AI Workforce Dashboard | NEEDS_REDESIGN | `agents/page.tsx` |
| 062 Agent Registry | NEEDS_REDESIGN | `agents/page.tsx` (read-only; activation is a DB-only owner decision per ADM-82) |
| 063 Agent Detail & Permissions | NEEDS_REDESIGN | `agents/[agentKey]/page.tsx` |
| 064 Model Routing, Providers & Tools | NEEDS_REDESIGN | `agents/routing/routing-form.tsx` |
| 065 Agent Runs, Usage, Cost & Automations | NEEDS_REDESIGN | `agents/automations`, `(internal)/usage/page.tsx` |

## Operations (066-067) — `app/(internal)/operations`, `production-readiness`

| Screen | Classification | Evidence |
|---|---|---|
| 066 Operations Dashboard | NEEDS_REDESIGN | `operations/page.tsx` — job backlog, dead-letter queue, requeue action |
| 067 System Health, Production Readiness & Alerts | NEEDS_REDESIGN | `production-readiness` (static checklist) + `operations` (live incident monitoring) — genuinely separate surfaces; no dedicated alerts-config screen (deliberate — thresholds are not meant to be configurable per `src/lib/observability/backlog.ts`) |

## Governance & Security (068-069) — `app/(internal)/approvals`, `security`, `audit`

| Screen | Classification | Evidence |
|---|---|---|
| 068 Approval Center, Policies & Overrides | NEEDS_REDESIGN | `approvals/page.tsx` + `[approvalId]` detail |
| 069 Security, Roles & Audit Log | NEEDS_REDESIGN | `security/page.tsx` (RLS invariant scan), `security/users/page.tsx` (roles), `audit/page.tsx` (audit log) |

## Integrations (070) — `app/(internal)/integrations`, `import`

| Screen | Classification | Evidence |
|---|---|---|
| 070 Integrations Center & Import | NEEDS_REDESIGN | `integrations/page.tsx` (lifecycle registry: VERIFIED/CONFIGURED/DEGRADED/NOT_CONFIGURED/FAILED/DISABLED) + `import/page.tsx` (WhatsApp-export lead-import staging) |

## Organization Settings (071) — `app/(internal)/settings/**`

| Screen | Classification | Evidence |
|---|---|---|
| 071 Organization Settings & Business Rules | NEEDS_REDESIGN | `settings/page.tsx` + sub-tabs (`commercial`, `team`, `communication`, `approvals`) — already tabbed rather than one long page, matching the PDF's own locked rule |

---

## Summary

| Classification | Count | Notes |
|---|---|---|
| NEEDS_REDESIGN | 68 | Backend/route functionally exists (per `admin-panel-screen-traceability.md`, corroborated independently); none use the new dark-sidebar/KPI-card/chip visual language yet |
| PARTIAL | 3 | #017 (no client-notes data model), #055 (expense-entry form has no backing table; profitability calc deliberately unbuilt), #056 (no GST filing/return generation — external-integration gap) |
| COMPLETE | 0 | No screen is both functionally complete *and* redesigned to the new visual source of truth |
| MISSING | 0 | No screen has zero implementation at the route/logic level |
| BROKEN | 0 (unverified) | No runtime/QA pass performed in this audit; would need one to confirm |
| MOCKED | 0 | Explicit anti-mock-data policy found and verified across admin code |
| OUTDATED | 0 (not separately tracked) | Not distinguished from NEEDS_REDESIGN in this pass — see below |

### Update 2026-09-29 — what changed since this matrix was written

The 2026-09-22 … 28 reskin and this pass together move the classification.
The authoritative per-screen status now lives in
`AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md` (52 COMPLETE, 14 GROUPED, 5
PARTIAL, 0 MISSING); this section records only the deltas against the table
above.

| Area | Was | Now |
|---|---|---|
| Visual system | NEEDS_REDESIGN on all 71 | Reskinned (dark rail, indigo, KPI chips, Kanban, charts) on 2026-09-22 … 28; **sectioned into the PDF's fifteen modules with breadcrumb and live bell on 2026-09-29** |
| Realtime | "no realtime infrastructure anywhere" | Supabase Realtime push on 8 screens + the bell; polling primitive deleted — `AGENCYOS_ADMIN_REALTIME_ARCHITECTURE.md` |
| Loading states | 27 top-level `loading.tsx` | + 19 nested/sub-route skeletons, incl. a `SkeletonDetail` shape for every 360 page |
| Sticky headers | attempted, reverted | working (bounded-height scroll box, sticky `<th>`) |
| SCR-017 Notes | PARTIAL (no table) | COMPLETE — `core.client_notes` (20260928120000) |
| SCR-032 / SCR-039 | per-project only | + org-level portfolio indexes `/design`, `/development` |
| Typecheck | (not recorded) | was **failing** on the snapshot (untyped `saved_views`, `client_notes`); fixed |
| Configurability | not audited | `AGENCYOS_ADMIN_CONFIGURABILITY_AUDIT.md`; B-1/B-2 implemented |

Still PARTIAL, each for a stated non-UI reason: 023 (no start date to draw
a Gantt bar), 042 (link-based repositories), 055 (margin formula is an
accounting decision), 056 (GST return needs a portal integration).

**Headline finding (2026-09-22):** the functional/backend layer of the admin panel is
already extremely mature — a prior in-repo audit
(`docs/admin-panel-screen-traceability.md`) independently verified 69/71
screens EXISTS with 0 MISSING, and this task's own repo sweep reached the
same conclusion. The real gap for this redesign program is **100% visual**:
every one of the 71 screens is rendered through a custom, functioning, but
visually different design system (`src/ui/*`) than the one established by
the 43 reference screenshots. This is a reskin project layered on a working
backend, not a rebuild — but it touches all 71 screens, and several new
shared primitives (Kanban board, donut/line charts, dark sidebar shell,
drawer, filter bar — the last two already flagged missing in
`admin-panel-screen-traceability.md`'s own "Gaps confirmed at the
shared-component level" section) will need to be built before any
individual screen can be redesigned to match.

**Second most important risk:** there is **no realtime infrastructure
anywhere in the codebase.** A targeted grep across all admin routes,
`src/modules/**`, and `src/lib/**` for `supabase.channel`, `realtime`,
`websocket`, `EventSource`, `SSE`, and client-side polling/`setInterval`
patterns returned zero matches. Every admin page is a plain server-rendered
(RSC) page that fetches fresh data per navigation/request. If the redesigned
UI is expected to show live-updating dashboards, notification badges, or
collaborative views (implied by some of the screenshot patterns, e.g. live
"Online/Away" team-member presence), that is new infrastructure to build,
not something to reskin.

**Third finding:** Finance's Expenses & Profitability screen (#055) is the
one place a UI element (`expense-form.tsx`) exists with no backing database
table — worth flagging distinctly from the "deliberately deferred" pattern
seen elsewhere, since it's a partially-built form rather than a documented
decision not to build.

### Update 2026-09-29 (evening) — PDF gap passes 5–7

New doors, each schema → service (`requireInternal` + `can`, then RLS) →
action → client form, none optimistic: `createPaymentAccount`,
`setPaymentAccountStatus`, `updateExpense` (finance); `updateProjectFile`,
`setMilestoneDueOn`, `setDeliveryLead` (projects). New readers:
`readInvoiceBillingProfile`, `listInvoicePaymentClaims`,
`listPaymentAccounts`, `listTaxReportInvoices`, `listReceipts` (finance);
`listMilestoneTaskCounts`, `listScopeItemsForVersion` (projects);
`listDecidedApprovals` (approvals); `readAuditLog` now carries both
snapshots plus `auditFacets`. Pure module `src/modules/finance/tax-report.ts`
holds the period, split, P&L and CSV arithmetic (unit-tested). New routes:
`/settings/finance`, `/projects/[id]/reports`, and CSV exports under
`/api/{clients,sales/pipeline,finance/tax,audit}/export`, each behind the
page's own capability.

### Update 2026-09-30 — bucket D (owner decisions)

| Screen | What changed | Files |
|---|---|---|
| Invoice detail | "Send on WhatsApp" (thread picker, honest not-configured state); "Reminders" section (automatic and by hand, delivery state) | `app/(internal)/invoices/[invoiceId]/whatsapp-send-panel.tsx`, `src/modules/finance/whatsapp-send-*.ts`, `reminder-*.ts`, `reminder-worker.ts` |
| Settings › Finance | "Past-due reminders" card: on/off + interval (org columns) | `app/(internal)/settings/finance/reminder-policy-form.tsx` |
| Payments › Reconciliation | Bank statement CSV import, proposed matches, Confirm match / Set aside | `app/(internal)/finance/payments/bank-import-panel.tsx`, `src/modules/finance/bank-csv.ts`, `bank-import-*.ts` |
| Lead 360 composer | Template picker over approved + active templates | `app/(internal)/leads/[leadId]/template-send-form.tsx`, `src/modules/crm/template-send-*.ts` |
| Project › Files | Storage uploads, versions, trash + restore, share links; honest unreachable state | `app/(internal)/projects/[projectId]/files-storage-panel.tsx`, `src/lib/files/storage.ts`, `src/modules/projects/files-storage-*.ts`, `app/api/files/share/[token]/route.ts` |
| Task drawer / task page / project report | Log time, totals, Time card + CSV, margin line | `app/(internal)/time-log-panel.tsx`, `src/modules/projects/time-log-*.ts`, `src/modules/finance/margin*.ts`, `app/api/projects/[projectId]/report/time/route.ts` |
| Project 360 / Create project / Settings › Templates | Save as template, Start from template, template list | `app/(internal)/projects/[projectId]/save-template-button.tsx`, `app/(internal)/settings/templates/*`, `src/modules/projects/project-template-*.ts` |
| Agent detail | Owner status + caps forms; Refusals card; "Enforced by the runner" | `app/(internal)/agents/[agentKey]/controls-form.tsx`, `src/modules/agents/controls-*.ts`, `refusals-queries.ts`, `policy-enforcement.ts`, `src/lib/ai/policy-decision.ts`, `agent-policy.ts` |
| Leads list / Lead 360 | Score column (sortable), Rescore all, Lead score card with reasons and inputs | `app/(internal)/leads/rescore-all-button.tsx`, `app/(internal)/leads/[leadId]/score-panel.tsx`, `src/modules/crm/lead-score*.ts` |
| Project › Repository | Live from GitHub: link form, commits, open PRs, branch count, honest unreachable reason | `app/(internal)/projects/[projectId]/repository/github-panel.tsx`, `github-link-forms.tsx`, `src/lib/git/github.ts`, `src/modules/projects/repository-link-*.ts` |
| Operations | Outbox row list with status filter and pagination (read-only) | `app/(internal)/operations/outbox-list.tsx`, `src/lib/observability/queries.ts` |
| Integrations / Settings | "GitHub (read-only)" row; GitHub and Files config areas | `src/lib/admin/integrations-eval.ts`, `integrations.ts`, `config-status.ts` |
