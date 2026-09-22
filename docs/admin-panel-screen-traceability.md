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
| 1 | Command Center | `(internal)/dashboard` (Needs Attention queue + Today panel added 2026-09-22) | Verified 2026-09-22: an org selector is not applicable — `core.organizations`' own migration comment states "V1 runs a single organization; the column exists everywhere so multi-tenant is a feature, not a rewrite," so there is exactly one org to select. A date-range selector doesn't fit either — every KPI tile is a live count (dead jobs, failed deliveries, pending approvals right now), not a historical trend a range would filter. Quick actions are the globally-mounted `command-palette.tsx`'s New lead/New client forms, reachable from a visible "Search…" button (not hidden behind the ⌘K shortcut alone) on every page including this one | EXISTS |
| 2 | Global Search | `src/lib/admin/global-search.ts` (server action, records: lead/client/project/invoice), consumed by `(internal)/command-palette.tsx` | EXISTS — corrected 2026-09-22, missed by the route-only Stage 2 pass |
| 3 | Notifications & Action Center | `(internal)/notifications` — aggregates six real sources (overdue/no-deadline approvals, mismatched payment claims, blocker/major defects, dead jobs, failed deliveries, overdue tasks), urgent-sorted, each row linking to the record it traces to; deliberately no snooze/dismiss (docblock: "resolving it there is what removes it from this list") | Decided 2026-09-22: no persistent unread-count badge in the global nav — the only piece this screen was ever missing. `app/(internal)/layout.tsx` currently makes no database read at all; a badge would add one to every internal page's render path for a purely cosmetic affordance, when the full list is already one click away and fully functional. Not worth the cost this repository is otherwise careful about (see the attributed-spend tracking throughout) | EXISTS |
| 4 | Quick Create / Command Palette | `(internal)/command-palette.tsx` (⌘K nav + search + New lead/New client forms, added 2026-09-22 via `crm.createLead`/`sales.createClientAccount`) | Decided 2026-09-22, confirmed structurally rather than by judgment: project (`convertToProject`, a WON opportunity), task (`project_id not null`), invoice (`client_account_id not null`), and meeting (`lead_id not null`) are each schema-required to belong to a specific parent row a global palette cannot supply without asking the same "which one" question a per-record page already answers for free | EXISTS |
| 5 | Sales Overview & Pipeline | `(internal)/sales-funnel` — a funnel/drop-off report (stage counts, conversion %, lost-reason breakdown), deliberately refuses deal-value/discount/lead-source-ROI figures with a stated reason ("nothing records enough of them yet to average"); a new "Open pipeline" section, added 2026-09-22, groups every open deal by stage. Decided 2026-09-22: a drag-and-drop kanban board is a real UI design decision and stays declined; the read-only grouped list is not that decision — it wires up `sales.listOpportunities()`, which had a real reader and a passing test but no caller anywhere in the app until now, the "built and unreachable" pattern this program keeps finding | EXISTS |
| 6 | Leads List | `(internal)/leads` | EXISTS |
| 7 | Lead 360 | `(internal)/leads/[leadId]` | EXISTS |
| 8 | Qualification & Scoring | `crm.qualification_coverage` written/read per-lead via `leads/[leadId]/sales-panel.tsx` (timeline, decision_maker, existing_assets, design_expectations, integrations — Doc 09 §9's areas) | Decided 2026-09-22: no cross-lead rollup either, on top of ADM-88's numeric-score refusal. The table's own migration comment rules it out too: "a coverage row that cannot point at what it read is an assertion, and an assertion is what §9 says not to build a checklist out of" — a cross-lead percentage/count rollup is exactly that checklist shape, even with no number attached, and would let leads be sorted or ranked by something meant to be evidence, not a metric | EXISTS |
| 9 | Requirements Discovery | `(internal)/requirements` is SCR-028 (cross-lead pending-decision queue); actual discovery (asking/answering for one lead) lives on `requirement-decision-form.tsx` on the lead's own page — corrected 2026-09-22, #9 and #28 are the same implemented surface, not a missing feature | EXISTS |
| 10 | Meetings | `(internal)/meetings`, `[meetingId]` | EXISTS |
| 11 | Quotations List | `(internal)/quotations` + `listProposals()` (`src/modules/sales/queries.ts`), added 2026-09-22 | EXISTS |
| 12 | Create / Edit Quotation | `(internal)/leads/[leadId]/quotation-panel.tsx` (per-lead panel) | Decided 2026-09-22: no standalone editor is possible to build, let alone missing — `sales.proposals.opportunity_id` is `not null`, so a quotation is structurally required to belong to a deal (and through it, a lead). A "standalone" editor would need to invent which client and deal it is for, which is not a UI scope choice being deferred | EXISTS |
| 13 | Follow-ups & Nurture | `(internal)/follow-ups` + `listFollowUpSequences()` (`src/modules/crm/queries.ts`), added 2026-09-22 | EXISTS |
| 14 | Client Management | `(internal)/clients` | EXISTS |
| 15 | Client 360 | `(internal)/clients/[clientId]` | EXISTS |
| 16 | Client Projects & Commercials | `clients/[clientId]/page.tsx` — projects list, invoices list, financial stats | EXISTS |
| 17 | Client Communication, Files & Notes | Files (2026-09-22): `getClient()` rolls up `project_files` across every project. Communication (2026-09-22): resolved without the design call the note below expected — `crm.conversations` has a `project_id`-scoped `project_group` kind with no `lead_id` at all (`conversations_kind_shape`), so this is the client's own ongoing channel per project, not a reconstruction through `sales.opportunities`; rendered as a Communication card | PARTIAL — Notes is the one piece left with no existing mechanism to roll up: `core.client_accounts` has no notes column or table anywhere, and inventing one (schema, RLS, audit wiring) is a real data-model decision, not a read to wire up |
| 18 | All Projects | `(internal)/projects` | EXISTS |
| 19 | Project Overview | `(internal)/projects/[projectId]` | EXISTS |
| 20 | Project Board | `projects/[projectId]/board`, added 2026-09-22 — tasks grouped by status, read-only (editing stays on `/development`) | EXISTS |
| 21 | My Tasks | `(internal)/my-tasks` | EXISTS |
| 22 | Project Calendar | `projects/[projectId]/calendar` | EXISTS |
| 23 | Project Milestones / Gantt | `projects.milestones` (no Gantt view) | PARTIAL |
| 24 | Project Files | `projects/[projectId]/files` + `projects.project_files` (new migration `20260922100000`), added 2026-09-22 — link-based, matching `projects.deliverables`' own "never a blob" precedent, not Supabase Storage | EXISTS |
| 25 | Project Team | `projects/[projectId]/team` + `listProjectTeam()`, added 2026-09-22 — derived from task `assignee_id`, not a new membership table | EXISTS |
| 26 | Project Reports | `(internal)/reports` (global) + `projects/[projectId]/page.tsx` already shows this project's invoices (`listProjectInvoices`) and defects (`listDefects(projectId)`, already project-scoped) in depth via milestone billing and QA summary — corrected 2026-09-22, a dedicated "Reports" tab would duplicate Overview, not fill a gap | EXISTS |
| 27 | Project Settings, Activity & Templates | `projects/[projectId]/activity` (added earlier) + `projects/[projectId]/settings`, added 2026-09-22 — client-portal `visibility` toggle (`setProjectVisibility()`). Decided 2026-09-22: no template management to build — the only two things a project template could copy are already handled, neither by a template. Onboarding's checklist (Doc 10 §6) is fixed and auto-seeds via `seed_onboarding()` with no per-project customization to template. Milestones, scope and budget are read exclusively from the client's own accepted quotation (`convertToProject`, Doc 10 §1: "Accepted quotation becomes commercial project context") — the same "every price is a human's, per client" rule ADM-22 already declared for the offer catalog. A generic template for either would either template nothing real (onboarding) or invite pre-filling client-specific money (milestones/scope), which this deployment has refused everywhere else | EXISTS |
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
| 38 | Assets, Brand Kit & Feedback History | Verified 2026-09-22: all three PDF concepts are rendered with clear section labels, split by workflow stage rather than one page — `design/themes` has "Brand kit" (`readTokenSets`); `design/final` has "What the client said" and "Revision history" (`readDesignTrail`'s `clientDecisions`/`revisions`, the same content Feedback History asks for); `design/page.tsx` has "Reference imagery" (Designer §9's optional assets). Splitting by stage rather than by PDF section title is the same deliberate IA choice `ProjectSubNav`/`DesignSubNav` make everywhere else on this phase, not a gap | EXISTS |
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
| 59 | Templates & Announcements | Templates: `crm.whatsapp_templates` deliberately holds no body text — Meta owns the approved wording, so there is nothing local to edit (stated in test comments); Settings only registers/withdraws which approved template answers which situation, by design, corrected 2026-09-22. Decided 2026-09-22: a client-facing broadcast is declined, not deferred — G-135's consent table found that "transactional", "marketing" and "promotional" appear nowhere in any AgencyOS document and refused to invent the distinction ("a 'transactional' category is the exact shape a broad marketing exception takes on its way in"), and any WhatsApp send still needs a Meta-approved template, which a free-text announcement is not. A new internal-only "team notices" bulletin is also declined: it has no shape anywhere in the PDF or the business docs to build against, and this system's existing "announcement" (the internal approval-request notification into the WhatsApp approval group, `crm/handlers.ts`) already covers the one internal-notification need that is actually specified | EXISTS |
| 60 | Delivery Failures, Outbox & Meeting Notes | `(internal)/operations` fully surfaces `core.outbox_events` (`listFailedDeliveries`) and `crm.deferred_sends` (`listDeferredSends`), each with explanatory docblocks. Corrected 2026-09-22: the earlier "no concept, table, or UI anywhere" grep missed the actual name — a meeting note is `crm.meeting_evidence` with `kind = 'notes'` ("the typed-notes path that makes the notes-only workflow possible without a recording," G-229), with its own form (`EvidenceForm`, default "Typed notes") on `meetings/[meetingId]/page.tsx`, plus an inline note field on "Complete meeting" that auto-files as notes evidence. Already answers what a note is (typed text, `internal`/`client_visible`), who logs it (any internal user with `can_write()`) and what it's tied to (the exact meeting + lead) | EXISTS |
| 61 | AI Workforce Dashboard | `(internal)/agents` | EXISTS |
| 62 | Agent Registry | `agents` | EXISTS |
| 63 | Agent Detail & Permissions | `agents/[agentKey]` | EXISTS |
| 64 | Model Routing, Providers & Tools | `agents/routing` | EXISTS |
| 65 | Agent Runs, Usage, Cost & Automations | `agents/automations`, `(internal)/usage` | EXISTS |
| 66 | Operations Dashboard | `(internal)/operations` | EXISTS |
| 67 | System Health, Production Readiness & Alerts | `production-readiness` (static go-live checklist) vs `operations` (live incident monitoring: dead jobs, backlog, failed deliveries, cron staleness, requeue actions) — genuinely different surfaces, not a duplicate, corrected 2026-09-22. Decided 2026-09-22: no dedicated alerts-config screen — `src/lib/observability/backlog.ts`'s own docblock states the rule a config screen would contradict, *"Nothing here invents a threshold. Every count `core.operational_backlog()` returns is already a failure the system declared"*; severity is deliberately never a configurable number, and `ALERT_WEBHOOK_URL` is one webhook for the whole deployment, not per-organization data a settings screen would hold. Already surfaced on `production-readiness`/`integrations` | EXISTS |
| 68 | Approval Center, Policies & Overrides | `(internal)/approvals` | EXISTS |
| 69 | Security, Roles & Audit Log | `(internal)/security`, `/audit` | EXISTS |
| 70 | Integrations Center & Import | `(internal)/integrations`, `/import` | EXISTS |
| 71 | Organization Settings & Business Rules | `(internal)/settings/*` | EXISTS |

## Summary

- **EXISTS (unverified against spec detail):** 65
- **PARTIAL (related route/logic exists, scope/UX mismatch):** 6
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
