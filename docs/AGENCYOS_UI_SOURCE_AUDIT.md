# AgencyOS Admin Panel UI — Source-of-Truth Audit

Stage 1 discovery deliverable for the planned admin panel redesign. Read-only
analysis of the design source folder; no application code was touched.

**Source folder:** `admin panel ui single truth/` (repository-relative; 46 files)

**Files audited:**
- 1 PDF — `AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf` (83 pages, 123,799 characters of extracted text, read in full — twice: by the 2026-09-22 session and again on 2026-09-29)
- **45** JPEG screenshots — `WhatsApp Image 2026-09-21 at 12.24.56 … 12.25.14.jpeg`, each 1536×1024 (the first audit counted 43; a recount on 2026-09-29 of the committed folder finds 45, all reviewed — see §4 for the per-image map)
- 0 other assets (no logo, icon or font files; the wordmark and "Run. Grow. Scale." tagline are taken from the screenshots)

**Related sources outside the folder, also read in full on 2026-09-29:**
`Phase 1 documents/AgencyOS_Phase1_Admin_Panel_Screen_by_Screen_Blueprint.pdf`
(A01–A34, the OBSERVE + UNDERSTAND + AUTHORIZE + CONTROL + RECOVER + AUDIT
framing; mapped onto the 71 SCR IDs in the master inventory §3) and
`AgencyOS Documentation/AgencyOS_06_Admin_Panel_Admin_Control_Center_Specification.pdf`,
`…07_Admin_Approval_Policy_Engine.pdf`, `…19_Security_Permissions_Audit_Data_Governance.pdf`
(backend authority, permissions, audit — the C tier of the source hierarchy).

---

## 1. The PDF: 71-screen information architecture

Structure of the document: p.1 cover, p.2 "Locked UX and Governance
Principles", p.3 the 71-screen baseline table (by module), p.4
Phase-to-Admin-Panel visibility matrix, p.5 shared components/screen rules,
pp.7-8 full 71-screen inventory table, pp.9-80 one page per screen (Purpose /
Header-Summary-KPI area / Main content & sub-screens / Primary actions /
Guardrails-status-rules-and-traceability / Implementation checklist),
p.81-82 §7 "Admin Manageability Matrix — What Must Be Configurable", p.83 §8
"UI Implementation and QA Checklist" + "Definition of UI architecture
complete."

### Full 71-screen inventory (module + screen + primary lifecycle phase)

**Global Control (001-004)**
| # | Screen | Phase |
|---|---|---|
| 001 | Command Center | cross-phase |
| 002 | Global Search | cross-phase |
| 003 | Notifications & Action Center | cross-phase |
| 004 | Quick Create / Command Palette | cross-phase |

**Sales & CRM (005-013)**
| # | Screen | Phase |
|---|---|---|
| 005 | Sales Overview & Pipeline | Phase 1-2 |
| 006 | Leads List | Phase 1-2 |
| 007 | Lead 360 | Phase 1-2 |
| 008 | Qualification & Scoring | Phase 1-2 |
| 009 | Requirements Discovery | Phase 1-2 |
| 010 | Meetings | Phase 1-2 |
| 011 | Quotations List | Phase 1-2 |
| 012 | Create / Edit Quotation | Phase 1-2 |
| 013 | Follow-ups & Nurture | Phase 1-2 |

**Clients (014-017)**
| # | Screen | Phase |
|---|---|---|
| 014 | Client Management | Phase 2-8 |
| 015 | Client 360 | Phase 2-8 |
| 016 | Client Projects & Commercials | Phase 2-8 |
| 017 | Client Communication, Files & Notes | Phase 2-8 |

**Projects (018-027)**
| # | Screen | Phase |
|---|---|---|
| 018 | All Projects | Phase 2-8 |
| 019 | Project Overview | Phase 2-8 |
| 020 | Project Board | Phase 2-8 |
| 021 | My Tasks | Phase 2-8 |
| 022 | Project Calendar | Phase 2-8 |
| 023 | Project Milestones / Gantt | Phase 2-8 |
| 024 | Project Files | Phase 2-8 |
| 025 | Project Team | Phase 2-8 |
| 026 | Project Reports | Phase 2-8 |
| 027 | Project Settings, Activity & Templates | Phase 2-8 |

**Requirements & Scope (028-031)**
| # | Screen | Phase |
|---|---|---|
| 028 | Requirements Dashboard | Phase 2-3 |
| 029 | Requirement Set / Detail | Phase 2-3 |
| 030 | Scope Versions & Freeze | Phase 2-3 |
| 031 | Change Requests & Traceability | cross-phase |

**Design & Prototype (032-038)**
| # | Screen | Phase |
|---|---|---|
| 032 | Design Dashboard | Phase 3-4 |
| 033 | UI Theme Finalization | Phase 3 |
| 034 | Screen Inventory | Phase 3-4 |
| 035 | Screen Detail / Coverage Matrix | Phase 4 |
| 036 | Design Review & Approval | Phase 3-4 |
| 037 | Prototype Builds & Review | Phase 4 |
| 038 | Assets, Brand Kit & Feedback History | Phase 3-5 |

**Development (039-043)**
| # | Screen | Phase |
|---|---|---|
| 039 | Development Dashboard | Phase 5 |
| 040 | Implementation Plan | Phase 5 |
| 041 | Development Task Execution | Phase 5 |
| 042 | Repository, Branch & Code Review | Phase 5 |
| 043 | Builds, Environments & Dependencies | Phase 5-7 |

**QA & Release (044-049)**
| # | Screen | Phase |
|---|---|---|
| 044 | QA Dashboard | Phase 4-7 |
| 045 | Test Plan & Cases | Phase 4-6 |
| 046 | Test Runs | Phase 4-7 |
| 047 | Bugs & Defects | Phase 4-8 |
| 048 | Regression, Compatibility & Performance | Phase 5-7 |
| 049 | Production Readiness & Release Candidate | Phase 6-7 |

**Finance (050-056)**
| # | Screen | Phase |
|---|---|---|
| 050 | Finance Overview | Phase 2-8 |
| 051 | Invoices | Phase 2-8 |
| 052 | Invoice Detail / Create | Phase 2-8 |
| 053 | Payments | Phase 2-8 |
| 054 | Payment Verification | Phase 2-8 |
| 055 | Expenses & Profitability | cross-phase internal |
| 056 | GST, Tax & Financial Reports | cross-phase internal |

**Communication (057-060)**
| # | Screen | Phase |
|---|---|---|
| 057 | Communication Center | cross-phase |
| 058 | WhatsApp / Conversations | Phase 1-8 |
| 059 | Templates & Announcements | cross-phase |
| 060 | Delivery Failures, Outbox & Meeting Notes | cross-phase |

**AI Workforce (061-065)**
| # | Screen | Phase |
|---|---|---|
| 061 | AI Workforce Dashboard | internal cross-phase |
| 062 | Agent Registry | internal cross-phase |
| 063 | Agent Detail & Permissions | internal cross-phase |
| 064 | Model Routing, Providers & Tools | internal cross-phase |
| 065 | Agent Runs, Usage, Cost & Automations | internal cross-phase |

**Operations (066-067)**
| # | Screen | Phase |
|---|---|---|
| 066 | Operations Dashboard | cross-phase |
| 067 | System Health, Production Readiness & Alerts | cross-phase |

**Governance & Security (068-069)**
| # | Screen | Phase |
|---|---|---|
| 068 | Approval Center, Policies & Overrides | cross-phase |
| 069 | Security, Roles & Audit Log | cross-phase |

**Integrations (070)**
| # | Screen | Phase |
|---|---|---|
| 070 | Integrations Center & Import | cross-phase |

**Organization Settings (071)**
| # | Screen | Phase |
|---|---|---|
| 071 | Organization Settings & Business Rules | cross-phase |

### Section 7 — Admin Manageability Matrix (what must be configurable)
Organized under: Organization & Identity, Commercial Rules, Project
Defaults, Communication, AI Workforce, Finance, Governance & Security. This
is the checklist the redesigned Organization Settings screen (SCR-071) must
satisfy — see p.81-82 for the full itemized list.

### Section 8 — UI Implementation and QA Checklist / Definition of Complete
Key locked rules for the redesign (p.83):
- Implement left navigation exactly as the organized modules — do not
  recreate a single overloaded Settings page.
- Build reusable primitives: page header, KPI card, data table, filter bar,
  drawer, empty state, error state, approval banner, activity timeline.
- Every phase-specific output must be traceable: who did what, which
  version, which approval, which client response, which evidence.
- Map every screen action to a backend capability/permission/event *before*
  calling the screen complete.
- Add RLS/tenant-isolation and resource-level permission tests for all
  CRUD/approval actions.
- Test loading/empty/error/permission/stale/integration-failure states for
  all 71 screens and key sub-screens.
- Desktop is the primary operating mode; tablet/mobile must preserve
  critical actions without horizontal chaos.
- **Definition of complete:** all 71 numbered screens/sub-screens have an
  implemented route or intentionally grouped tab/drawer, every locked phase
  artifact is visible, every critical action is permissioned and auditable,
  and no business-critical configuration/workflow is hidden in an
  unstructured page.

---

## 2. The 43 screenshots: visual design language

All 43 images depict what is overwhelmingly the **same consistent design
system** — a dark-sidebar SaaS project-management/CRM tool for a fictional
sample project ("GanxTV (OTT App)", client "Mehta Enterprises"), used
throughout as illustrative content, with owner user "Sonu Shah."

**Recurring visual patterns (present across nearly all 43 images):**

- **Sidebar (left, ~240px, dark navy/near-black, e.g. `#0F1115`-ish):**
  AgencyOS logo + tagline "Run. Grow. Scale." at top; icon+label nav items
  grouped by module (Command Center, Sales & CRM, Clients, Projects,
  Requirements, Design & Prototype, Development, QA & Release, Finance,
  Communication, AI Workforce, Reports/Analytics & Costs, Integrations,
  Security & Audit, Organization/Settings); expandable accordion sub-items;
  active item highlighted with a filled indigo/blue pill; user card pinned
  at the bottom (avatar, name, role).
- **Top bar:** global search input with a visible "⌘K"-style affordance,
  placeholder text scoped to the page ("Search projects, clients, tasks,
  files…"); "+ Create" split-button; notification bell with a red count
  badge; help icon; user avatar + name + role + chevron.
- **Breadcrumbs** directly under the top bar (e.g. `Projects > GanxTV (OTT
  App) > Milestones`).
- **Page header:** large title + one-line description, right-aligned action
  buttons (secondary "Edit"/"Share" outline buttons + one filled
  indigo/blue primary CTA, often with a "More ▾" overflow).
- **KPI/stat card row:** small rounded-square colored icon chip (pastel
  background, saturated icon), a large number, a label, and a small
  delta/trend badge (up/down arrow + percentage, green for positive/red for
  negative).
- **Tab strip** for entity sub-navigation (Overview / Tasks / Milestones /
  Files / Team / Activity / Settings, etc.) — underline-style active tab in
  indigo/blue.
- **Data tables:** light/white background, muted-gray header row, avatar +
  name compound cells, right-aligned numeric/currency columns, pill-shaped
  **status chips** with a consistent color vocabulary — green (Won/Active/
  Completed/Approved/Paid/Verified/Healthy), amber/orange (Pending/In
  Progress/Contacted/Overdue-warning), red (Overdue/Blocked/Failed/Lost),
  blue (In Progress/New/Negotiation), purple/gray (Low priority/Draft/Idle).
- **Kanban boards:** column-per-status (To Do / In Progress / Review /
  Completed / Blocked), card-based tasks with colored tag chips
  (feature/bug/priority), due-date + avatar footer.
- **Charts:** donut/pie charts for distribution (leads by source, task
  distribution, agent status), line/area charts for trends (pipeline value,
  income vs. expenses, agent activity), horizontal progress bars for
  workload/budget.
- **Right-hand contextual panel:** entity detail card (Project Details,
  Client Details, Task Details, Milestone Details) with an "Edit" link,
  related-items lists, and a grid of icon+label "Quick Actions" buttons.
- **Calendar (month grid)** and **Gantt/timeline chart** views also appear
  as dedicated tab views on Projects.
- **Color system:** primary action color is an indigo/blue (~`#4F46E5`
  range); page background is a very light blue-gray (~`#F5F7FB`); cards are
  white with a soft border/shadow; status/category chips use a broader
  pastel palette (green/amber/red/blue/purple) on near-white fills.
- **Typography:** clean sans-serif (Inter-like), bold page/card titles,
  medium-weight table headers, muted-gray secondary/meta text; currency
  throughout is ₹ (INR); dates as `DD Mon YYYY`.
- **Density:** information-dense dashboards (5-6 KPI tiles + 2-3 supporting
  panels per screen is typical), consistent 3-column right-rail pattern on
  detail pages.

This is a coherent, implementable design language: dark sidebar shell +
light content canvas + card/table/chip vocabulary + a single indigo/blue
accent, generalizable to the full 71-screen IA.

---

## 3. Conflicts and ambiguities

1. **Screenshots are a generic PM/CRM SaaS template, not a literal render of
   the governed 71-screen spec.** The PDF is heavily governance-oriented —
   guardrails, audit trails, approval gates, "evidence not a self-reported
   score," payment-gated milestone progression, RBAC/tenant isolation. None
   of that vocabulary appears in the screenshots, which read as a
   friendly, conventional project-management dashboard (more
   Asana/ClickUp/Monday-styled) with upward-trending percentages and warm
   activity feeds. **Conclusion: treat the screenshots as a source for
   visual language (colors, typography, card/table/chip/nav conventions)
   only — not as a literal screen-content or IA source.** The PDF remains
   the sole source of truth for what each of the 71 screens must contain.

2. **Screenshot IA is flatter than the PDF's 71-screen granularity.** The
   screenshots show one generic "Development" Kanban tab per project, one
   "QA & Testing" tab, one "Communication" tab, etc., where the PDF spec
   splits, e.g., Development into 5 distinct screens (Dashboard,
   Implementation Plan, Task Execution, Repository/Code Review,
   Builds/Environments/Dependencies) and QA & Release into 6. The redesign
   will need to fit the PDF's finer-grained screen set into the
   screenshots' visual shell (e.g. as sub-tabs or drawers within a module),
   which the PDF's own p.83 checklist explicitly anticipates ("intentionally
   grouped tab/drawer" satisfies "screen implemented").

3. **One screenshot is a different product, not the AgencyOS admin panel.**
   `WhatsApp Image 2026-09-21 at 12.25.05 (1).jpeg` shows a distinct,
   white-sidebar "AgencyOS [GanxTV Admin Dashboard]" — actually the sample
   OTT app's *own end-customer-facing admin panel* (Content, Users, Plans &
   Subscriptions, Banners, Ads Management, Categories, Publishers), i.e. a
   nested "product admin panel that AgencyOS would build for a client,"
   not AgencyOS's own agency admin panel. It uses a different visual system
   (light sidebar, different icon set, different nav labels) than the other
   42 images. **This single image should be excluded as a design source for
   the AgencyOS admin panel redesign** — it illustrates a different
   deliverable (a client-project output) that happens to sit in the same
   screenshot batch.

4. **A third, currently-live visual reality exists in the codebase and
   disagrees with both.** `app/(internal)/**` already runs on a custom,
   functioning, in-house design system (`src/ui/*` — see the implementation
   matrix doc) with its own token/color/component vocabulary. It does not
   currently look like the dark-sidebar screenshots (no dark sidebar shell,
   different status-color mapping, different component set — no Kanban
   board or donut-chart primitives yet). The redesign is therefore a true
   **reskin over a functionally complete backend**, not a greenfield build:
   the 71 screens' *data and actions* mostly already exist and work; what's
   missing is this specific dark-sidebar/card/chip visual layer plus a few
   new primitives (drawer, filter bar already partially missing per the
   existing `docs/admin-panel-screen-traceability.md` audit).

5. **Sample data throughout the screenshots (GanxTV OTT App, Mehta
   Enterprises, Sonu Shah) is placeholder/demo content**, not real AgencyOS
   production data — expected and fine for a design reference, but should
   not be mistaken for a data-model source.


---

## 4. Per-image map: reference screenshot → screen ID (2026-09-29 recount)

Numbering is the folder's sorted order. `#23` is the one image the first
audit excluded (the sample OTT app's own product admin — a client
deliverable, not the AgencyOS admin) and it stays excluded.

| # | Shows | SCR |
|---|---|---|
| 1 | Project › Milestones (Gantt + milestone detail rail) | 023 |
| 2 | Project › Board (Kanban + timeline rail) | 020 |
| 3 | Sales & CRM pipeline with KPI row, leads-by-source donut | 005 |
| 4, 14, 17, 30, 44 | Project overview (KPI row, phase timeline, recent tasks, details rail) | 019 |
| 5, 21, 25, 31, 32 | Project task board variants (incl. Blocked column, task rail) | 020 |
| 6 | Client management list + client detail rail | 014 |
| 7 | Finance overview (income vs expenses, payment status donut) | 050 |
| 8 | AI Workforce dashboard (agent activity, status donut, model usage) | 061 |
| 9, 40 | My Tasks / task list with filters | 021 |
| 10 | Client 360 (tabs, KPI row, projects, quotations, invoices, notes, timeline) | 015 |
| 11, 38 | Design dashboard (screen gallery, versions, prototype links) | 032 / 034 |
| 12 | Create quotation (client, items, payment schedule, terms) | 012 |
| 13, 43 | Leads list (KPI row, table, funnel, lead detail rail / filters rail) | 006 |
| 15 | Project team (roster, role donut, invite) | 025 |
| 16, 20 | Project calendar (month grid, upcoming, filters) | 022 |
| 18, 24 | Project files (folders, list/grid, preview rail) | 024 |
| 19 | Project reports (completion trend, distribution, health) | 026 |
| 22, 27, 34 | Milestones / Gantt timeline views | 023 |
| 23 | **excluded** — client product admin (Content, Users, Plans, Banners, Ads) | — |
| 26, 28 | Task detail (description, acceptance criteria, subtasks, comments) | 041 |
| 29, 41 | Requirements list + requirement detail rail | 029 |
| 33, 35, 36 | Project communication / inbox / group chat | 057 / 058 / 017 |
| 37 | QA & testing (test runs, device matrix, open bugs) | 044 / 046 |
| 39 | Project finance (milestones, invoices, payment progress) | 016 / 050 |
| 42 | Lead 360 (stage stepper, conversation, quick actions, tasks) | 007 |
| 45 | Command Center (greeting, KPI row, pipeline, tasks & approvals, system status, usage) | 001 |

**What the shell takes from them, verbatim:** dark navy rail (~#0F1115)
with grouped, expandable modules and an indigo active pill; wordmark +
"Run. Grow. Scale."; top bar with scoped search and ⌘K, "+ Create",
bell with a red count, help, user chip; breadcrumbs under the bar; page
header with title, one-line description and right-aligned actions; KPI
tiles with pastel icon chips and delta badges; underline tabs; light tables
with pill status chips (green/amber/red/blue/purple); right-hand detail
rails with Quick Actions; ₹ and `DD Mon YYYY`.

### 4a. Same-to-same parity status (2026-09-29, second pass)

Built to the reference's own layout — not just its tokens — on the same
authoritative readers each page already had, and checked in a real browser
at 1440 and 390 (`scripts/local-qa/`, screenshots in the test matrix §9):

| Reference image(s) | Screen | What now matches |
|---|---|---|
| 45 | Command Center | greeting + date, five KPI tiles with icon chips and captions, chevron pipeline strip, Recent leads (avatar, phone, source, status), Active projects with progress bars, Tasks & Approvals rail with count, System Status list, Usage & Cost |
| 4, 14, 17, 30, 44 | Project 360 | logo tile + name + status chip, subtitle, icon fact row (client, code, start, due, budget), Board / Edit project actions, "% Overall progress" figure, icon underline tab strip, six KPIs, milestone timeline, Recent tasks table with assignee avatars and priority chips, Project details / Team / Recent files / Recent activity rail |
| 2, 5, 21, 25, 31, 32 | Project Board | filter toolbar (search, assignee, module, priority), tinted column headers with count and "+", cards with module + priority chips, assignee avatar and calendar due date, "+ Add task" per column (drawer → `createTaskAction`), Recent activity + Task summary donut |
| 13, 43 | Leads list | avatar + company name cells, six linked KPI tiles, Import / Add lead actions |
| 42 | Lead 360 | avatar header with phone · source · added, next-follow-up figure, stage stepper, three panes — Lead information + Tags + Recent activity, the WhatsApp conversation, Quick actions over the deal panels |
| 10 | Client 360 | header with facts, six KPIs incl. client health, projects and invoices tables with paid bars, notes + files, Client details rail, timeline |
| 7 | Finance overview | five KPIs, income vs expenses trend, payment-status donut, top project revenue bars, recent invoices / payments, expense breakdown, upcoming payments, quick actions |
| 8 | AI Workforce | six KPIs, agent activity trend, status donut, top agents by usage, registry table with model/status/runs, recent agent activity feed, quick actions |
| shell (all) | Global header + rail | scoped search field, dark "+ Create" (opens quick create), bell with count, help menu, user chip with avatar · name · role and menu, organisation tile in the rail foot, breadcrumb naming the open record |

Still token-level only (layout not rebuilt): Gantt/milestone views (1, 22,
27, 34), task detail (26, 28), calendar (16, 20), files (18, 24), reports
(19), design gallery (11, 38), requirements (29, 41), inbox (33, 35, 36),
QA (37), My Tasks (9, 40), quotation composer (12), team (15), clients
list (6). The canvas moved to the reference's cool grey (`#f5f7fb`) with
`#0f172a` ink.

## 5. Conflicts resolved on 2026-09-29

6. **Nav IA.** The screenshots' sidebar (Command Center; Sales & CRM;
   Clients; Projects; Requirements; Design & Prototype; Development; QA &
   Release; Finance; Communication; AI Workforce; Reports/Analytics &
   Costs; Integrations; Security & Audit; Organization) and the PDF's §2
   list differ in two places: the screenshots show *Reports* and
   *Analytics & Costs* as modules, the PDF folds reports into Projects
   (SCR-026) and costs into AI Workforce (SCR-065) and adds *Operations* and
   *Governance & Security*. **The PDF wins** (it is the functional
   authority); `/reports` sits under Projects and `/usage` under AI
   Workforce. Recorded in `nav-config.ts`'s docblock.
7. **Module screens with no org-level page.** Design & Prototype and
   Development had only per-project tabs, so the rail had nothing to point
   at. Two portfolio index pages (`/design`, `/development`) were added —
   aggregations of existing tables, no new business rule — so the module
   has a front door that is a real screen.
8. **Notifications count.** The 2026-09-22 traceability declined a badge
   to keep the layout free of database reads; §4 of the PDF locks
   "Notifications with unread count". Both are now true: the bell counts
   after paint through a server action and stays current over the live
   channel; the layout still reads nothing.
