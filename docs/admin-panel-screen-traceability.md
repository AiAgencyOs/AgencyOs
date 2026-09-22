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
| 5 | Sales Overview & Pipeline | `(internal)/sales-funnel` | PARTIAL |
| 6 | Leads List | `(internal)/leads` | EXISTS |
| 7 | Lead 360 | `(internal)/leads/[leadId]` | EXISTS |
| 8 | Qualification & Scoring | `crm.qualification_coverage` (no dedicated screen) | PARTIAL |
| 9 | Requirements Discovery | `(internal)/requirements` (Phase 1 discovery vs. Phase 1-5 Reqs&Scope module not yet split) | PARTIAL |
| 10 | Meetings | `(internal)/meetings`, `[meetingId]` | EXISTS |
| 11 | Quotations List | `(internal)/quotations` + `listProposals()` (`src/modules/sales/queries.ts`), added 2026-09-22 | EXISTS |
| 12 | Create / Edit Quotation | `(internal)/leads/[leadId]/quotation-panel.tsx` (per-lead panel; confirmed no standalone editor) | PARTIAL — editor exists, scoped to a lead |
| 13 | Follow-ups & Nurture | `(internal)/follow-ups` + `listFollowUpSequences()` (`src/modules/crm/queries.ts`), added 2026-09-22 | EXISTS |
| 14 | Client Management | `(internal)/clients` | EXISTS |
| 15 | Client 360 | `(internal)/clients/[clientId]` | EXISTS |
| 16 | Client Projects & Commercials | part of client detail | PARTIAL |
| 17 | Client Communication, Files & Notes | `(internal)/communication` | PARTIAL |
| 18 | All Projects | `(internal)/projects` | EXISTS |
| 19 | Project Overview | `(internal)/projects/[projectId]` | EXISTS |
| 20 | Project Board | `projects/[projectId]/board`, added 2026-09-22 — tasks grouped by status, read-only (editing stays on `/development`) | EXISTS |
| 21 | My Tasks | `(internal)/my-tasks` | EXISTS |
| 22 | Project Calendar | `projects/[projectId]/calendar` | EXISTS |
| 23 | Project Milestones / Gantt | `projects.milestones` (no Gantt view) | PARTIAL |
| 24 | Project Files | `projects/[projectId]/files` + `projects.project_files` (new migration `20260922100000`), added 2026-09-22 — link-based, matching `projects.deliverables`' own "never a blob" precedent, not Supabase Storage | EXISTS |
| 25 | Project Team | `projects/[projectId]/team` + `listProjectTeam()`, added 2026-09-22 — derived from task `assignee_id`, not a new membership table | EXISTS |
| 26 | Project Reports | `(internal)/reports` (global, not per-project) | PARTIAL |
| 27 | Project Settings, Activity & Templates | `projects/[projectId]/activity` (tasks completed/milestones met/change requests, composed from existing readers — not the audit log), added 2026-09-22; still no Settings tab, no template management | PARTIAL |
| 28 | Requirements Dashboard | `(internal)/requirements` | PARTIAL |
| 29 | Requirement Set / Detail | `crm.requirement_versions` | PARTIAL |
| 30 | Scope Versions & Freeze | `projects/[projectId]/scope`, `.scope_items/versions` | PARTIAL |
| 31 | Change Requests & Traceability | `projects.change_requests` + recent SCR-031 classify/decide/apply screen | EXISTS |
| 32 | Design Dashboard | `projects/[projectId]/design` | PARTIAL |
| 33 | UI Theme Finalization | `projects/[projectId]/design/themes`, `.color_options` | EXISTS |
| 34 | Screen Inventory | `readDesignTrail` reads `projects.screen_baselines`, rendered in `projects/[projectId]/design/page.tsx` | EXISTS |
| 35 | Screen Detail / Coverage Matrix | `readSampleScreens` reads `projects.representative_screens`/`.screens`, rendered in `design/themes/page.tsx` | EXISTS |
| 36 | Design Review & Approval | `design/final`, `.design_reviews` | PARTIAL |
| 37 | Prototype Builds & Review | `projects/[projectId]/prototype`, added 2026-09-22 — filters the existing `deliverables` reader to `kind='prototype'`, no new backend | EXISTS |
| 38 | Assets, Brand Kit & Feedback History | `readTokenSets` (brand kit) + `readDesignTrail` already reads `client_design_decisions`/`design_reviews`/`design_revisions` in full, rendered on `design/page.tsx` — corrected 2026-09-22, this was more complete than the earlier pass recorded | PARTIAL (content exists; not broken out as a labeled "Feedback History" section) |
| 39 | Development Dashboard | `projects/[projectId]/development` | EXISTS |
| 40 | Implementation Plan | `projects/[projectId]/plan`, `.plan_*` | PARTIAL |
| 41 | Development Task Execution | `projects.tasks` | PARTIAL |
| 42 | Repository, Branch & Code Review | `projects/[projectId]/repository` + `projects.repositories` (new migration `20260922110000`), added 2026-09-22 — link-based, confirmed with the owner before building | EXISTS |
| 43 | Builds, Environments & Dependencies | `projects/[projectId]/builds`, added 2026-09-22 — Builds half only (filters `deliverables` to `kind='build'`); Environments/Dependencies explicitly flagged unbuilt on the page itself, nothing in the schema tracks either | PARTIAL |
| 44 | QA Dashboard | `(internal)/qa`, `projects/[projectId]/qa` | PARTIAL |
| 45 | Test Plan & Cases | `qa.test_plans`, `.test_plan_items` | PARTIAL |
| 46 | Test Runs | `qa.test_runs` | PARTIAL |
| 47 | Bugs & Defects | `qa.defects` | PARTIAL |
| 48 | Regression, Compatibility & Performance | `qa.schema.ts` defines these as defect/test-plan categories; folded into the generic defect register, no dedicated view | PARTIAL |
| 49 | Production Readiness & Release Candidate | `(internal)/production-readiness` | EXISTS |
| 50 | Finance Overview | `(internal)/finance` | EXISTS |
| 51 | Invoices | `(internal)/invoices` | EXISTS |
| 52 | Invoice Detail / Create | `invoices/[invoiceId]` | EXISTS |
| 53 | Payments | `finance.payments`, `.payment_submissions` | PARTIAL |
| 54 | Payment Verification | `invoices/verify` | EXISTS |
| 55 | Expenses & Profitability | `finance/expenses` | PARTIAL |
| 56 | GST, Tax & Financial Reports | `finance/tax` | PARTIAL |
| 57 | Communication Center | `(internal)/communication` | EXISTS |
| 58 | WhatsApp / Conversations | part of communication | PARTIAL |
| 59 | Templates & Announcements | `settings/communication/page.tsx` shows `whatsapp_template_performance` stats (a performance dashboard, not template CRUD); no announcements feature/table found | PARTIAL |
| 60 | Delivery Failures, Outbox & Meeting Notes | `core.outbox_events`, `crm.deferred_sends` | PARTIAL |
| 61 | AI Workforce Dashboard | `(internal)/agents` | EXISTS |
| 62 | Agent Registry | `agents` | EXISTS |
| 63 | Agent Detail & Permissions | `agents/[agentKey]` | EXISTS |
| 64 | Model Routing, Providers & Tools | `agents/routing` | EXISTS |
| 65 | Agent Runs, Usage, Cost & Automations | `agents/automations`, `(internal)/usage` | EXISTS |
| 66 | Operations Dashboard | `(internal)/operations` | EXISTS |
| 67 | System Health, Production Readiness & Alerts | overlaps #49 | PARTIAL |
| 68 | Approval Center, Policies & Overrides | `(internal)/approvals` | EXISTS |
| 69 | Security, Roles & Audit Log | `(internal)/security`, `/audit` | EXISTS |
| 70 | Integrations Center & Import | `(internal)/integrations`, `/import` | EXISTS |
| 71 | Organization Settings & Business Rules | `(internal)/settings/*` | EXISTS |

## Summary

- **EXISTS (unverified against spec detail):** 38
- **PARTIAL (related route/logic exists, scope/UX mismatch):** 33
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
