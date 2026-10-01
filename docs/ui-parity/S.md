# UI parity, stream S

Reference folder: `admin panel ui single truth/`. Image numbers are the sorted order of the 45 JPEGs (PDF excluded). Screenshots taken at 1536x1024 as the owner; phone width (390) re-checked for every changed route (no horizontal overflow).

| Image | Reference file | Screen / route | Result |
|---|---|---|---|
| 45 | WhatsApp Image 2026-09-21 at 12.25.14.jpeg | Command Center `/dashboard` | match-except-data. KPI tiles now carry delta chips (this 30 days against the 30 before, derived from created_at / paid_at / ledger day; `src/lib/admin/period-delta.ts`, `dashboard-deltas.ts`). Owner question: the QA pipeline stage (see below). |
| 3 | (sorted #3) | Sales & CRM `/sales-funnel` | match-except-data. Won and Lost are now read-only columns (cards cannot be dragged, nothing can be dropped on them; a drop says where to record it, the lead's guarded Sales panel). Owner question: Contracts tab. |
| 13 + 43 | (sorted #13, #43) | Leads `/leads` | match-except-data. Merged: status tabs with counts, toolbar, table with Budget and Tags columns back (Source folded under the name and Score under the status so eleven columns fit beside the rail at 1536), persistent right rail with Lead Details (selected row; Show details in the row menu) and Quick Filters, Lead Source Breakdown and Status Funnel below. Rail shows from 1536 up and drops below the table under that. Not built: Hot Leads and No response (3+ days) quick filters (a score threshold and a silence threshold are business decisions; owner question). |
| 42 | (sorted #42) | Lead 360 `/leads/[id]` | match-except-data. Nine-tab strip (Overview, Conversation, Qualification, Requirements, Quote, Follow-ups, Meetings, Activity, Notes; each jumps to the section that owns it), seven-segment strip New / Qualifying / Qualified / Quoted / Negotiation / Converted / Lost built from the real lead status and deal stage (`src/lib/admin/lead-stage-strip.ts`; nurture shows as parked), Tasks card (open tasks of the project the lead's deal became; empty state before that). Owner question: Files tab. |
| 12 | (sorted #12) | Create quotation `/quotations/new` | match-except-data. Header Save as Draft (creates it as a draft), Preview (the existing preview PDF door), Share (copies a link to this form on this deal), Send to Client (prices it and sends it to the owner for approval, the only path to the client); Amount in Words (`src/lib/money/amount-in-words.ts`, INR); template picker (the agency's payment structures, drives the payment schedule); bottom Preview bar. Owner question: Share. |
| 6 | (sorted #6) | Client management `/clients` | match-except-data. KPI delta chips (clients joined per period), phone under email (first contact's number; the account has no phone of its own), Projects list in the rail, bottom row Recent Communication / Upcoming Follow-ups / Pending Invoices (`src/lib/admin/clients-overview.ts`). Total Revenue has no chip (list rows carry no payment dates). |
| 10 | (sorted #10) | Client 360 `/clients/[id]` | match-except-data. Tab icons, Assigned Team and Deal Timeline rail sections (timeline is stored dates: lead created, meetings, quotations, account, next follow-up). |
| 7 | (sorted #7) | Finance overview `/finance` | match-except-data. Date-range pill (options are links, no script) and Financial Documents card (tax report PDF and CSV for this month, invoices CSV, expenses CSV: each a real export door), delta chips on Invoiced, Received, Expenses (fall is good), Net Profit. Outstanding is a balance with no history, so no chip. |
| 8 | (sorted #8) | AI Workforce `/agents` | match-except-data. Failed series on the activity chart (runs record `failed`), delta chips on Tasks, Tokens, Cost. Owner question: Add Agent. |
| 11 + 38 | (sorted #11, #38) | Design dashboard `/projects/[id]/design` | match-except-data. Progress rings on Total Screens and Theme Options, All Screens / Completed / In Progress / Pending tabs with counts (approved / in review / draft or blocked), search, grid or list, Add Screen, Client Review card, bottom row Recent Activity / Design Versions / Prototype Links. The workspace header and tab strip belong to the project stream. |

## Owner questions
1. Dashboard QA stage: projects have no QA status (planning, onboarding, active, on_hold, completed, cancelled). Should a QA phase exist on a project, and what moves a project into it?
2. Sales Contracts tab: there is no contract model or route. Should contracts exist, and what is one (document, signer, link to a won deal)?
3. Lead 360 Files tab: a lead has no file store (files belong to projects). Should a lead be able to hold files? Meetings takes the ninth tab meanwhile.
4. AI Workforce Add Agent: agents are defined in code, so nothing is drawn.
5. Quotation Share: should sharing before owner approval ever be possible? Today Send to Client goes through approval, and Share only copies an internal link.
6. Leads quick filters Hot Leads and No Response (3+ days): what score counts as hot, and how many silent days count as no response?

## Files changed
`app/(internal)/dashboard/page.tsx`, `sales-funnel/page.tsx`, `sales-funnel/pipeline-board.tsx`, `leads/page.tsx`, `leads/bulk-table.tsx`, `leads/[leadId]/page.tsx`, `quotations/new/{page,composer}.tsx`, `clients/page.tsx`, `clients/[clientId]/page.tsx`, `finance/page.tsx`, `agents/page.tsx`, `projects/[projectId]/design/page.tsx`.

## Shared primitives touched (all screens)
`Stat` (icon chip left, sentence-case label, dark bold value), `CardHeader` (bold 16px title, no divider), `PageHeader` (28px bold title, actions stay right on lg), `labelClass` (sentence-case labels, not uppercase), `ViewAll` ("View All"), `PipelineStrip` (taller, dark text), `KanbanBoard` (column subtitle, empty label, column count from columns, white count pill), `DataTable` (dense = borderless; chevron only when no row menu), `ActivityFeed` unchanged except ViewAll, `BarChart`/`DonutChart` (money axis, smaller centre text), new `GroupedBarChart`.

## Tests
Updated pins: `tests/a-kpi-opens-its-own-list.test.ts` (Title Case KPI labels, health beside stage), `tests/phase-three-in-the-admin-panel.test.ts` (heading match case-insensitive). `tests/read-failure-semantics.test.ts` fails identically with and without these changes when run alone (module-mock load error), not caused here.

## Reference comparison, 2026-10-03 (images 45, 3, 13, 43, 42; 1536x1024, owner)

Independent side-by-side after round 3. Fixed: KPI tiles were taller than the reference (the label wrapped and the delta chip fell under the value; a number such as ₹15,00,000 broke mid-figure) — `Stat` now keeps the value on one line from `sm` up, sizes the chip/padding to the reference, and the label fits on one line; the pipeline deal card's "1 day ago" no longer wraps letter by letter; quick-action labels wrap instead of truncating ("Open in Wh…").

Still different (data or a deliberate difference, not a missing element):
- Sidebar: the reference lists 17 modules (Approvals, Analytics & Costs, Security & Audit, Organization as their own items); the app follows the 71-screen PDF's grouping (Governance & Security, Settings). Owner decision if the screenshot's list should win.
- Reference shows photo avatars and mock data; the app shows initials and the real rows.
- Sales pipeline columns are the real stages (Discovery/Proposal/Negotiation/Won/Lost), not the mock's New Leads/Contacted/Proposal Sent/Negotiation/Closed Won.
- Reference period control is a date-range dropdown; the app uses 30d/90d/180d/365d pills.
- Lead 360 conversation pane uses the WhatsApp-style header; the reference uses a plain card header with "View Full History".
