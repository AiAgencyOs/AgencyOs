# Admin Panel Screen Traceability Matrix

Source: `admin panel ui single truth/AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`
(71-screen baseline, v1.0, Sept 2026).

**Status of this document:** preliminary, route-level pass (Stage 0-2 of the
enterprise admin panel program). It maps each of the 71 spec screens to the
closest existing route/table under `app/(internal)/**` and `supabase/migrations/`,
found via a repo audit on 2026-09-22. It has **not** yet been checked against
the PDF's full per-screen requirements (permissions, audit, tests, states,
guardrails) — that verification happens screen-by-screen as each module is
worked in Stage 6+ and this file is updated in place.

Legend: `EXISTS` (route + backend present, spec conformance unverified),
`PARTIAL` (related route exists but doesn't match the spec screen's scope),
`MISSING` (no route found).

| # | Screen | Existing route / table | Status |
|---|---|---|---|
| 1 | Command Center | `(internal)/dashboard` | PARTIAL (Needs Attention queue + Today panel added 2026-09-22; still missing global date-range/org selector and quick actions) |
| 2 | Global Search | `src/lib/admin/global-search.ts` (server action, records: lead/client/project/invoice), consumed by `(internal)/command-palette.tsx` | EXISTS — corrected 2026-09-22, missed by the route-only Stage 2 pass |
| 3 | Notifications & Action Center | `(internal)/notifications` | PARTIAL |
| 4 | Quick Create / Command Palette | `(internal)/command-palette.tsx` (⌘K nav + search + New lead/New client forms, added 2026-09-22 via `crm.createLead`/`sales.createClientAccount`) | PARTIAL — lead/client create shipped; still no Create project/task/invoice/meeting (all genuinely require a parent context, not a Quick Create gap) |
| 5 | Sales Overview & Pipeline | `(internal)/sales-funnel` — a funnel/drop-off report (stage counts, conversion %, lost-reason breakdown), deliberately refuses deal-value/discount/lead-source-ROI figures with a stated reason ("nothing records enough of them yet to average") | PARTIAL — a kanban-style pipeline board is a different UI than what's built; would need a real design decision, not a quick fill |
| 6 | Leads List | `(internal)/leads` | EXISTS |
| 7 | Lead 360 | `(internal)/leads/[leadId]` | EXISTS |
| 8 | Qualification & Scoring | `crm.qualification_coverage` written/read per-lead via `leads/[leadId]/sales-panel.tsx` (timeline, decision_maker, existing_assets, design_expectations, integrations — Doc 09 §9's areas) | PARTIAL — per-lead coverage exists, no cross-lead rollup screen and no numeric "score" (ADM-88 declined a lead score outright — see `crm.leads` schema comment); a literal "scoring" screen needs a product decision on what score means, not a code gap |
| 9 | Requirements Discovery | `(internal)/requirements` is SCR-028 (cross-lead pending-decision queue); actual discovery (asking/answering for one lead) lives on `requirement-decision-form.tsx` on the lead's own page — corrected 2026-09-22, #9 and #28 are the same implemented surface, not a missing feature | EXISTS |
| 10 | Meetings | `(internal)/meetings`, `[meetingId]` | EXISTS |
| 11 | Quotations List | `(internal)/quotations` + `listProposals()` (`src/modules/sales/queries.ts`), added 2026-09-22 | EXISTS |
| 12 | Create / Edit Quotation | `(internal)/leads/[leadId]/quotation-panel.tsx` (per-lead panel; confirmed no standalone editor) | PARTIAL — editor exists, scoped to a lead |
| 13 | Follow-ups & Nurture | `(internal)/follow-ups` + `listFollowUpSequences()` (`src/modules/crm/queries.ts`), added 2026-09-22 | EXISTS |
| 14 | Client Management | `(internal)/clients` | EXISTS |
| 15 | Client 360 | `(internal)/clients/[clientId]` | EXISTS |
| 16 | Client Projects & Commercials | `clients/[clientId]/page.tsx` — projects list, invoices list, financial stats | EXISTS |
| 17 | Client Communication, Files & Notes | Files half added 2026-09-22: `getClient()` now rolls up `project_files` across every project the client has, rendered as a Files card on `clients/[clientId]/page.tsx` — no new backend | PARTIAL — Files done; Communication/Notes still not rolled up (would need tracing client → `sales.opportunities` → lead, a real design call on whether a WON client's pre-conversion lead history belongs on the client page) |
| 18 | All Projects | `(internal)/projects` | EXISTS |
| 19 | Project Overview | `(internal)/projects/[projectId]` | EXISTS |
| 20 | Project Board | `projects/[projectId]/board`, added 2026-09-22 — tasks grouped by status, read-only (editing stays on `/development`) | EXISTS |
| 21 | My Tasks | `(internal)/my-tasks` | EXISTS |
| 22 | Project Calendar | `projects/[projectId]/calendar` | EXISTS |
| 23 | Project Milestones / Gantt | `projects.milestones` (no Gantt view) | PARTIAL |
| 24 | Project Files | `projects/[projectId]/files` + `projects.project_files` (new migration `20260922100000`), added 2026-09-22 — link-based, matching `projects.deliverables`' own "never a blob" precedent, not Supabase Storage | EXISTS |
| 25 | Project Team | `projects/[projectId]/team` + `listProjectTeam()`, added 2026-09-22 — derived from task `assignee_id`, not a new membership table | EXISTS |
| 26 | Project Reports | `(internal)/reports` (global) + `projects/[projectId]/page.tsx` already shows this project's invoices (`listProjectInvoices`) and defects (`listDefects(projectId)`, already project-scoped) in depth via milestone billing and QA summary — corrected 2026-09-22, a dedicated "Reports" tab would duplicate Overview, not fill a gap | EXISTS |
| 27 | Project Settings, Activity & Templates | `projects/[projectId]/activity` (added earlier) + `projects/[projectId]/settings`, added 2026-09-22 — client-portal `visibility` toggle (`setProjectVisibility()`), the one project-level field with a real standing effect on RLS and no admin control before this | PARTIAL — Activity and Settings (visibility) done; template management stays undone, no project-template concept exists anywhere and defining what one copies is a product decision |
| 28 | Requirements Dashboard | `(internal)/requirements` — cross-lead pending-decision queue, oldest first, links into each lead — exactly SCR-028's ask | EXISTS |
| 29 | Requirement Set / Detail | `leads/[leadId]/page.tsx` already renders every version in full: summary, complete scope-item list, and counts for assumptions/nice-to-haves/exclusions/design-references/open-questions, status and decision — corrected 2026-09-22, not a separate screen but genuinely covered | EXISTS |
| 30 | Scope Versions & Freeze | `projects/[projectId]/scope` (active/draft + freeze action) + `listScopeVersionHistory()`, added 2026-09-22 — a "Version history" section listing every superseded version with item counts, no new backend | EXISTS |
| 31 | Change Requests & Traceability | `projects.change_requests` + recent SCR-031 classify/decide/apply screen | EXISTS |
| 32 | Design Dashboard | `projects/[projectId]/design` — phase status, reviewer assignment, screen baseline, coverage matrix, reference imagery, cost/usage; theme options/review status/client confirmation split onto sibling `themes`/`colors`/`final` routes by deliberate design (800-line-page split), not missing — corrected 2026-09-22 | EXISTS |
| 33 | UI Theme Finalization | `projects/[projectId]/design/themes`, `.color_options` | EXISTS |
| 34 | Screen Inventory | `readDesignTrail` reads `projects.screen_baselines`, rendered in `projects/[projectId]/design/page.tsx` | EXISTS |
| 35 | Screen Detail / Coverage Matrix | `readSampleScreens` reads `projects.representative_screens`/`.screens`, rendered in `design/themes/page.tsx` | EXISTS |
| 36 | Design Review & Approval | `design/final/page.tsx` — full client loop: what was sent, client decisions with verbatim quotes, revision history, lock/handoff to Phase 4 — corrected 2026-09-22. No client-facing send channel exists (every form only records), a stated design limitation and a real integration decision, not a gap to fill unilaterally | EXISTS |
| 37 | Prototype Builds & Review | `projects/[projectId]/prototype`, added 2026-09-22 — filters the existing `deliverables` reader to `kind='prototype'`, no new backend | EXISTS |
| 38 | Assets, Brand Kit & Feedback History | `readTokenSets` (brand kit) + `readDesignTrail` already reads `client_design_decisions`/`design_reviews`/`design_revisions` in full, rendered on `design/page.tsx` — corrected 2026-09-22, this was more complete than the earlier pass recorded | PARTIAL (content exists; not broken out as a labeled "Feedback History" section) |
| 39 | Development Dashboard | `projects/[projectId]/development` | EXISTS |
| 40 | Implementation Plan | `projects/[projectId]/plan` covers 6 of the PDF's 18 registers (deliverables, milestones, dependencies, risks/assumptions, open clarifications, version/status) with real write forms; docblock states the rest are "derived or belong to Phase 3" | PARTIAL — substantially implemented, not a gap beyond #23 (Gantt) |
| 41 | Development Task Execution | `development/page.tsx` reads/writes real `projects.modules/.features/.tasks` — a functioning module→feature→task board, not a stub | EXISTS |
| 42 | Repository, Branch & Code Review | `projects/[projectId]/repository` + `projects.repositories` (new migration `20260922110000`), added 2026-09-22 — link-based, confirmed with the owner before building | EXISTS |
| 43 | Builds, Environments & Dependencies | `projects/[projectId]/builds`, added 2026-09-22 — Builds half only (filters `deliverables` to `kind='build'`); Environments/Dependencies explicitly flagged unbuilt on the page itself, nothing in the schema tracks either | PARTIAL |
| 44 | QA Dashboard | `(internal)/qa` (org-wide defects + `readOrgTestCoverage()`: projects with a plan / total, runs/passed/failed in the last 30 days) + `projects/[projectId]/qa` (`TestPlanCard`, `TestRunsCard`, `DraftTestPlanForm`, wired to real readers/writers) — org-wide plan/run aggregation added 2026-09-22 | EXISTS |
| 45 | Test Plan & Cases | `qa.test_plans`, `.test_plan_items`, real reader+writer on `projects/[projectId]/qa` | EXISTS |
| 46 | Test Runs | `qa.test_runs`, real reader+writer on `projects/[projectId]/qa` | EXISTS |
| 47 | Bugs & Defects | `qa.defects`, aggregated org-wide on `(internal)/qa` | EXISTS |
| 48 | Regression, Compatibility & Performance | `(internal)/qa` — `readSuiteCoverage()`, added 2026-09-22 — cross-project 30-day run/pass/fail breakdown by these three `qa.test_runs.suite` values specifically; already shown per-item on each project's QA panel (category/suite badges) — corrected note: `qa.defects` carries no category at all, only `test_plan_items`/`test_runs` do | EXISTS |
| 49 | Production Readiness & Release Candidate | `(internal)/production-readiness` | EXISTS |
| 50 | Finance Overview | `(internal)/finance` | EXISTS |
| 51 | Invoices | `(internal)/invoices` | EXISTS |
| 52 | Invoice Detail / Create | `invoices/[invoiceId]` | EXISTS |
| 53 | Payments | `finance/payments` + `listPayments()`, added 2026-09-22 — org-wide ledger of `finance.payments` (captured/verified record), distinct from #54's `payment_submissions` verification queue | EXISTS |
| 54 | Payment Verification | `invoices/verify` | EXISTS |
| 55 | Expenses & Profitability | `finance/expenses` | PARTIAL |
| 56 | GST, Tax & Financial Reports | `finance/tax/page.tsx` — invoice register + tax totals by currency; explicit comment: "No GST filing/return generation: that needs a real GST-portal integration this deployment does not have" | PARTIAL — deliberate, stated scope boundary requiring a genuine external-integration decision, corrected 2026-09-22 |
| 57 | Communication Center | `(internal)/communication` | EXISTS |
| 58 | WhatsApp / Conversations | `(internal)/communication` lists conversations, linking each to `/leads/[leadId]`, which already renders the full chat-bubble thread via `listMessages()` — corrected 2026-09-22 (an earlier pass here mis-assessed this as missing a thread viewer; it exists, one hop away) | EXISTS |
| 59 | Templates & Announcements | Templates: `crm.whatsapp_templates` deliberately holds no body text — Meta owns the approved wording, so there is nothing local to edit (stated in test comments); Settings only registers/withdraws which approved template answers which situation, by design, corrected 2026-09-22. Announcements: zero backend anywhere — every "announcement" hit in the codebase is the internal agent→team notification system, unrelated to a client-facing feature | PARTIAL — templates is a deliberate decision; announcements needs a product-scope decision (broadcast to clients? internal only?) before any backend work makes sense |
| 60 | Delivery Failures, Outbox & Meeting Notes | `(internal)/operations` fully surfaces `core.outbox_events` (`listFailedDeliveries`) and `crm.deferred_sends` (`listDeferredSends`), each with explanatory docblocks | PARTIAL — outbox/deferred-sends fully covered; "Meeting Notes" has no concept, table, or UI anywhere in the codebase (confirmed by full grep 2026-09-22) — a real missing feature, not a surfacing gap, needing a product decision on what a meeting note is and who logs it |
| 61 | AI Workforce Dashboard | `(internal)/agents` | EXISTS |
| 62 | Agent Registry | `agents` | EXISTS |
| 63 | Agent Detail & Permissions | `agents/[agentKey]` | EXISTS |
| 64 | Model Routing, Providers & Tools | `agents/routing` | EXISTS |
| 65 | Agent Runs, Usage, Cost & Automations | `agents/automations`, `(internal)/usage` | EXISTS |
| 66 | Operations Dashboard | `(internal)/operations` | EXISTS |
| 67 | System Health, Production Readiness & Alerts | `production-readiness` (static go-live checklist) vs `operations` (live incident monitoring: dead jobs, backlog, failed deliveries, cron staleness, requeue actions) — genuinely different surfaces, not a duplicate, corrected 2026-09-22 | PARTIAL — alerting is functionally covered by Operations' live counts + `ALERT_WEBHOOK_URL`; no dedicated alerts-*config* screen (thresholds, notification routing) exists, which would need a product decision on what's alertable |
| 68 | Approval Center, Policies & Overrides | `(internal)/approvals` | EXISTS |
| 69 | Security, Roles & Audit Log | `(internal)/security`, `/audit` | EXISTS |
| 70 | Integrations Center & Import | `(internal)/integrations`, `/import` | EXISTS |
| 71 | Organization Settings & Business Rules | `(internal)/settings/*` | EXISTS |

## Summary

- **EXISTS (unverified against spec detail):** 54
- **PARTIAL (related route/logic exists, scope/UX mismatch):** 17
- **MISSING:** 0

**Methodology correction (2026-09-22):** the Stage 0-2 audit inventoried
`app/(internal)/**` *routes* only. Screens #2 and #4 turned out to already be
implemented as a server action (`global-search.ts`) plus a client component
(`command-palette.tsx`) wired into the shared layout — neither has its own
route, so the route-only pass missed them entirely, and this file briefly
carried an incorrect MISSING for both (one was overwritten with a duplicate
implementation before the mistake was caught via `git status`/`git checkout`;
no real work was lost). A follow-up sweep re-checked every remaining MISSING
entry against server actions, lib functions, and non-route components (not
just routes) and corrected five more: #34 and #35 were already EXISTS
(`readDesignTrail`/`readSampleScreens`), #38/#48/#59 were PARTIAL rather than
MISSING. Confirmed still genuinely MISSING: #11 (quotations list is per-lead
only), #13 (follow-ups has worker logic but no screen), #24 (no file storage
integration anywhere in the repo), #25 (no per-project team/member model),
#27 (no settings/activity/template UI), #37 (no prototype-build entity), #42
and #43 (no repo/build/environment tracking at all — would need new tables).

## Gaps confirmed at the shared-component level (Section 4 of the spec)

`src/ui/primitives/` currently has: `badge`, `button`, `card`, `empty-state`,
`field`, `page-header`, `stat`, `table`. The spec's global header, right-side
drawer, and filter-bar patterns have **no primitive yet** — these block almost
every module screen and are the Stage 3 foundation work.

## Next steps

Stage 3 (shared components: drawer, filter bar) → Stage 5 (Command Center) →
Stage 6 (Sales & CRM), proceeding module-by-module per the locked implementation
order in Section 36 of the source doc, updating this matrix as each module lands.
