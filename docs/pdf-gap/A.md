# PDF gap audit, slice A: front matter (pp. 1-9) and SCR-001 to SCR-018 (pp. 10-27)

Method: independent, rendered audit as `owner@local.test` (plus `contractor` and `finance` for denied states, and a 390px-wide pass) against the running stack on :3000, using Playwright to dump `main.innerText` and the control list per route, clicking tabs, drawers, row menus and bulk bars. Screenshots and dumps are in `/tmp/pg/auditA/`. The earlier "979/979 BUILT" audit was not relied on. Decisions cited come from `docs/ui-parity/owner-decisions.md` and `docs/AGENCYOS_ADMIN_REMAINING_GAPS.md`. Note that the REMAINING_GAPS file is dated 2026-09-29 and is stale: many of its "missing" items are now built (search page, bulk actions, drawers, tabs), and I judged only what is rendered.

Legend: PRESENT = usable on screen; PARTIAL = something exists but differs from the PDF; MISSING = not reachable in the app; DECIDED = an owner decision declines it; UNVERIFIED = I could not reach it in this environment.

## Summary

Element counts are the PDF bullets under Purpose, Header/KPI, Main content, Primary actions and Guardrails for each screen. The five generic "Implementation checklist" lines repeated on every page are judged once, in the cross-cutting section.

| Screen | Elements | PRESENT | PARTIAL | MISSING | DECIDED | UNVERIFIED |
|---|---|---|---|---|---|---|
| SCR-001 Command Center | 18 | 10 | 6 | 2 | 0 | 0 |
| SCR-002 Global Search | 15 | 8 | 4 | 3 | 0 | 0 |
| SCR-003 Notifications | 15 | 9 | 4 | 2 | 0 | 0 |
| SCR-004 Quick Create | 17 | 15 | 1 | 1 | 0 | 0 |
| SCR-005 Sales Overview | 17 | 11 | 5 | 1 | 0 | 0 |
| SCR-006 Leads List | 15 | 9 | 4 | 2 | 0 | 0 |
| SCR-007 Lead 360 | 21 | 16 | 4 | 0 | 0 | 1 |
| SCR-008 Qualification | 16 | 10 | 4 | 2 | 0 | 0 |
| SCR-009 Requirements Discovery | 20 | 5 | 1 | 0 | 0 | 14 |
| SCR-010 Meetings | 15 | 8 | 1 | 0 | 0 | 6 |
| SCR-011 Quotations List | 17 | 10 | 5 | 2 | 0 | 0 |
| SCR-012 Quotation Composer | 21 | 16 | 4 | 1 | 0 | 0 |
| SCR-013 Follow-ups | 14 | 10 | 3 | 1 | 0 | 0 |
| SCR-014 Client Management | 16 | 11 | 4 | 1 | 0 | 0 |
| SCR-015 Client 360 | 23 | 19 | 2 | 0 | 0 | 2 |
| SCR-016 Client Commercials | 16 | 12 | 3 | 1 | 0 | 0 |
| SCR-017 Client Comms/Files/Notes | 17 | 11 | 3 | 1 | 0 | 2 |
| SCR-018 All Projects | 16 | 11 | 4 | 1 | 0 | 0 |
| Total | 309 | about 201 | about 62 | about 19 | 0 | about 25 |

Front matter (pp. 1-9): about 50 further items (9 principles, 15 nav modules, 9 lifecycle rows, 6 shared-component groups). Results are in "Front matter" below: 3 PARTIAL, 2 MISSING, the rest PRESENT.

No owner decision in `owner-decisions.md` declines anything in this slice. The only decision that touches it is #13 (quotation Share only after approval), which the composer still contradicts. See SCR-012.

## Front matter (pp. 1-9)

| item (PDF page) | status | what the app shows instead | what would be needed |
|---|---|---|---|
| p3 nav: "Command Center; Sales & CRM; Clients; Projects; Requirements; Design & Prototype; Development; QA & Release; Finance; Communication; AI Workforce; Operations; Governance & Security; Integrations; Settings" | PARTIAL (nav-config.ts records that the owner chose the reference screenshots' list, 2026-10-03) | Rendered sidebar is: Command Center, Notifications, My tasks, Sales & CRM, Clients, Projects, Requirements & Scope, Design & Prototype, Development, QA & Release, Finance, Communications, AI Workforce, Approvals, Operations, Analytics & Costs, Integrations, Security & Audit, Organization. "Governance & Security" is split into Approvals and Security & Audit, and Settings is called Organization. | Nothing if the 2026-10-03 choice stands. It is not in owner-decisions.md, so it is recorded in a code comment only. |
| p2 "Every screen must support loading, empty, error, permission-denied and stale-data states" | PARTIAL | Loading: `loading.tsx` exists for the routes I checked. Empty states explain why (Meetings, Follow-ups, Notifications). Permission-denied: contractor and finance get "You don't have access to this" on /leads, /quotations, /clients. A stale/degraded indicator exists ("Reconnecting / Updated just now / Refresh"). I did not force an error state (read-only audit), so the error-with-retry-and-reference state is UNVERIFIED. | Confirm the error state shows a reference id and a retry control. |
| p5 Filtering: "Saved views for frequent workflows; Clear all filters" | PARTIAL | "Save this view" exists on Leads, Clients, Projects, Quotations, Follow-ups and Meetings. A dedicated "Clear all filters" control was not seen on Leads, Clients, Projects or Quotations (the pills and selects just reset via "All"). | A visible "Clear all" when any filter is active. |
| p5 Tables: "Sticky column headers on long lists" | UNVERIFIED (Leads and Projects have long tables; I did not scroll-test sticky positioning) | - | Check. |
| p5 States: "Integration unavailable/degraded" | PRESENT | Meetings shows a callout "No calendar credential is configured"; dashboard shows "WhatsApp (Meta): Not configured". | - |
| p1 "Document version / locked status" | n/a | - | - |

The remaining front-matter items are PRESENT: sidebar order and sectioning, dark sidebar with light workspace, status chips, right drawers, Global Header (search with ⌘K, Create, status, notifications with unread count, help, user/role). Organisation is shown as the sidebar chip "Demo Agency", and a switcher appears only with more than one membership. The Phase-to-Admin visibility rows for phases 1 and 2 are visible through the screens below; phases 3-8 belong to other slices.

## SCR-001 Command Center

Routes visited: `/dashboard` (owner, contractor, finance, 390px). PRESENT: 10 (KPI strip of 5, global date-range links 30/90/180/365 days, today panel, finance gate queue, system strip, quick actions Add lead / Create project / Create invoice / Open approval, control-plane tiles that link to filtered lists, real-data empty states, contractor/finance role variants, no horizontal overflow at 390px).

| item (PDF page) | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Needs Action, Pending Approvals, Payment Verification, Blocked Projects, Failed Deliveries" KPIs (p10) | PARTIAL | The top KPI row is Total Leads, Active Projects, Revenue, AI Agent Runs, Messages Sent. The five named counters exist only in the lower "Control plane" tiles (Blocked projects, Failed deliveries, Pending approvals, Payments to verify). There is no "Needs Action" total. | Promote these five to the header KPI row and add a Needs Action total. |
| "Active projects and phase distribution" (p10) | PARTIAL | The "Project Pipeline" strip mixes leads and projects (Leads, Qualified, Quoted, Onboarding, In Progress, In QA, Launched). It is not a delivery-phase distribution (Onboarding/Planning/Design/Development/QA/Release). | A phase-distribution chart across projects. |
| "Project health table" (p10) | PARTIAL | The "Active Projects" table has Stage, Progress and Due Date but no health or blocked column. Every row reads "No plan yet". | Add a health chip or blocked reason. |
| "Acknowledge/escalate an operational item" (p10) | PARTIAL | Only "Escalate" is on each row of Tasks & Approvals. There is no Acknowledge. | Acknowledge action, or link each row to Notifications' mark-read and resolve. |
| "System health: app, database, scheduler, AI provider, WhatsApp, alerting" (p10) | PARTIAL | Shows Database, AI Provider, WhatsApp, Scheduler and "Operational Alerts: 5 failed". No "app" row. | Add an app or web-tier check. |
| "Global date range and organization selector" (p10) | PARTIAL | The date range is a set of four fixed links. The organisation selector shows only for multi-membership users, so a single-org owner sees a static chip. | None if acceptable. Not verified with a multi-org user (UNVERIFIED for the switcher itself). |
| "Today: meetings, due items, reminders, payment verifications" (p10) | MISSING (as itemised) | "Today" is one sentence, "Nothing on the calendar, no follow-up due...". There are no separate meetings, due-items, reminders or verifications sub-lists. Not verifiable with data, since the window is empty. | Confirm the panel itemises when data exists. |
| Empty-state rule (p10) | MISSING | The top "Failing - action required / work has been lost and nothing will retry it" banner and the "Reconnecting" badge give no next action or link. | A next-step action on the banner. |

## SCR-002 Global Search

Routes: `/search`, `/search?q=north`, ⌘K palette, Preview drawer. PRESENT: 8 (search box with ⌘K, type filters, date filters, recent and saved searches, grouped sections, Copy ID, Preview drawer, tenant isolation as enforced server-side).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "across leads, clients, projects, tasks, requirements, quotations, invoices, files, meetings, agents and audit events" (p11) | PARTIAL | Type chips are Leads, Clients, Projects, Invoices, Quotations, Meetings, Tasks only. | Add Requirements, Files, Agents and Audit events. |
| "Advanced filter builder" (p11) | PARTIAL | A fixed filter row (Owner select, free-text Status, date chips). It is not a builder with stackable conditions. | Stackable field/operator/value conditions. |
| "Saved search manager" (p11) | PARTIAL | A "Saved searches" list with Remove only. There is no rename or edit. | Manage actions. |
| "Open result in the correct 360 page" (p11) | PRESENT, but note: "Copy ID" shows an 8-character reference and the row also has Preview | - | - |
| "AI-assisted semantic search" (p11) | MISSING | No semantic or AI search anywhere. | Feature, or record an owner decision. |
| "Recent searches" (p11) | MISSING in practice | Panel says "Nothing run yet" after a search was run. Saved search "Northwind everything" existed. Whether Recent updates was not re-tested (UNVERIFIED). | Check that recents record on submit. |

## SCR-003 Notifications & Action Center

Routes: `/notifications` (owner 6 items, contractor 0 items), details drawer. PRESENT: 9 (unread and needs-attention count, severity chips, category tabs, Mark read, Snooze, Resolve, Assign, Escalate, bulk select, History, Open the record deep-link, Read/snoozed/resolved tab).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Categories "approvals, blockers, payment verification requests, client responses, QA failures, failed deliveries, system alerts" (p12) | PARTIAL | Only two categories exist: Deliveries and Phase changes. No approval, payment, QA-failure or client-reply items appeared (none seeded; the feed may not emit them). | Feed those sources into the inbox. |
| "Notification detail drawer: Action history" (p12) | PARTIAL | The drawer shows State, Escalation and the source reference, but no per-notification history. History is one list at the bottom of the page. | Per-item history in the drawer. |
| "No duplicate alert storms; repeated events grouped" (p12) | MISSING | Four separate "Failed client delivery" rows are listed individually. | Group repeats with a count. |
| "Escalation destination" (p12) | PARTIAL | An "Escalate" button with no visible destination (owner vs ops admin). | Show and choose the destination. |
| Severity "critical / action required / warning / information" (p12) | PRESENT | Chips present, all counts zero except warning and information. | - |
| "Every notification must point to an auditable source event" (p12) | PRESENT | Reference such as `delivery-2026-09-29T19:13...` and "Open the record". | - |

## SCR-004 Quick Create / Command Palette

Routes: header Create menu, ⌘K. PRESENT: 15. The palette shows New lead, client, quotation, task, Request a meeting, New project, Invoice from milestone and New change request, plus page navigation grouped by module. Source shows recent commands and drafts. The Create menu opened a real New lead form.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Recent commands", "Save draft when creation is interrupted" (p13) | PARTIAL (UNVERIFIED on screen) | Implemented in `command-palette.tsx` (recent_commands, create_drafts). No recents were visible on the fresh palette and I did not interrupt a form, so not observed. | Observe both. |
| "Schedule meeting" as a create form (p13) | PARTIAL | Palette entry is "Request a meeting", which records a request, not a booking (calendar is unconfigured). | Fine once the calendar is configured. |
| "Pre-fill client/project from contextual page" (p13) | MISSING to verify | Not exercised. | Verify by launching from Client 360. |

## SCR-005 Sales Overview & Pipeline

Routes: `/sales-funnel`, and `/dashboard` links. PRESENT: 11 (KPIs, 30/90/180/365 window, source/owner filters, board with drag guidance, lead-source breakdown, pipeline value chart plus table, Today, upcoming meetings, recent activities, funnel analytics with drop-off, Export CSV, Add lead/meeting/follow-up).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| KPI "qualified leads, proposals sent, deals closed, closed revenue" (p14) | PARTIAL | The top row has Total Leads, Open Deals, Pipeline Value, Deals Won, Win Rate. Qualified, proposals sent and closed revenue appear only in sub-lines or the funnel. | Expose them as KPIs. |
| "Use Phase 1 statuses from New through Won/Lost/Nurture" (p14) | PARTIAL | The board columns are Discovery, Proposal, Negotiation, Won, Lost (deal stages). Lead statuses New, Qualifying, Qualified and Nurture are not columns. | Show lead stages or a toggle. |
| "Date/source/owner filters" (p14) | PRESENT | Source and owner on the board; window on the page. | - |
| "Drag/move only when stage rules allow" (p14) | UNVERIFIED | Text "Drag a card to move it to the next stage". I did not perform a drag (read-only). | - |
| "A stage move must create a CRM activity event and preserve previous status" (p14) | UNVERIFIED | Lead 360 activity shows status events. Drag path not exercised. | - |
| "Export filtered pipeline" (p14) | PARTIAL | "Export CSV" exists. Whether it honours the current source/owner filters was not checked. | - |

## SCR-006 Leads List

Routes: `/leads`, row menu, bulk bar, Add lead dialog, preview drawer. PRESENT: 9 (status counts, search, source/status/assigned filters, table, bulk Assign owner / Set status / Add tag / Set next follow-up, preview drawer, Import leads entry, row menu, Save this view).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Filters "service, budget, date" (p15) | MISSING | Only Source, Status, Assigned (and search). | Add service, budget and created-date filters. |
| "Needs reply / human handoff flags" (p15) | PARTIAL | A "Who needs you first" panel lists "Never answered" leads. Table rows carry no reply or handoff flag. | A column or flag per row. |
| "Show source and consent state" (p15) | PARTIAL | Source is shown. Consent state is not in the table or the preview. | Consent chip per lead. |
| "Open conversation and Lead 360" (p15) | PARTIAL | Row menu has Preview, Show details, Open lead, Request a meeting, Quotations, but no direct "Open conversation". | Conversation deep link. |
| "Merge duplicates through governed flow", "deduplication indicators" (p15) | PARTIAL | Merge exists only inside Lead 360 ("Merge into this lead" by pasting a lead ID). There is no duplicate indicator in the list. | Dupe badge plus list-level merge entry. |
| Filter "Save this view" and "Hot / No response" quick filters | PRESENT (extra) | - | - |

## SCR-007 Lead 360

Routes: `/leads/<301>`, `<302>` (has quotes) and the Transcript Co lead (has a conversation). The page is one scrolling workspace, and the nine "tabs" (Overview, Conversation, Qualification, Requirements, Quote, Follow-ups, Files, Activity, Notes) are scroll anchors, not separate views. Tabs whose section is absent do nothing: on lead 301, Quote, Files and Activity did not move and showed the same page. The PDF names 8 sub-screens. PRESENT: 16 (identity and source, deal stage/value, stage strip, next follow-up, last contact, reply-waiting banner, pause/resume agent, client message composer with 24h-window and template rules, internal note separation, create quotation, guarded Move/Lost reasons, merge, meetings, files, activity).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Eight sub-screens as tabs (p16) | PARTIAL | One long page with scroll-to tabs. Sections appear only when data exists (Quotations only with a deal, Requirements only with a conversation). Activity and Notes are combined in the right-hand rail. | True tab panes, or always show every section with an empty state. |
| "Requirement version status" in header (p16) | PARTIAL | The header shows no requirement status. It appears only in the Extracted requirements card. | Header chip. |
| "Mark Won through guarded transition" (p16) | PARTIAL | "Move deal" offers proposal/lost with a lost reason. Won was not seen as an option on an open deal (only via the quote-acceptance path). | Verify the Won path. |
| Populated Requirements and Quote panes (p16) | UNVERIFIED | No seed lead has a requirement version. Only the empty state "Extract requirements" was viewed. | Seed data. |
| "Client-visible messages and internal notes clearly separated" | PRESENT | "Messages ... reach the customer on WhatsApp. Notes added to the transcript stay here." | - |

## SCR-008 Qualification & Scoring

Route: Lead 360 (Lead score card, Qualification disclosure, Override dialog). PRESENT: 10 (computed score with itemised reasons, human-decision slot, override with mandatory reason, original preserved as "Computed (model)", qualification form with budget/timeline/decision maker/fit notes, coverage count, disqualify only with reason, disqualification history in source).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Separate Qualification screen (p17) | PARTIAL | No dedicated screen or tab pane. It is a collapsed disclosure inside the right rail. | Promote to its own pane. |
| "Risk/objection tags" (p17) | PARTIAL | Objections exist in source (`listOpenObjectionsForLead`) and a generic Tags field. Not seen rendered on the lead I visited. | Verify and surface as tags. |
| "Budget band", "Fit criteria" (p17) | PARTIAL | The form takes budget in paise and free-text fit notes. There is no band and no structured criteria. | Band selector and criteria. |
| "Return to discovery when evidence is incomplete" (p17) | MISSING | No such action. Move offers qualifying/qualified/nurture/disqualified only. | Add action. |
| "Disqualification reason history" (p17) | UNVERIFIED | Present in source; no disqualified lead opened. | - |
| Numeric score | PARTIAL | `owner-decisions.md` #14 says "no numeric lead score" for hot leads and the REMAINING_GAPS file lists ADM-88 as declining a numeric score, yet the UI shows "10/100". | Reconcile with the owner. |

## SCR-009 Requirements Discovery

Route: Lead 360 "Extracted requirements" card; `/requirements` belongs to another slice. The seed has no extracted version, so only the empty state rendered ("None yet... Extract requirements"). From source, the card is structured with User roles, Features, Platforms, Integrations, Business rules and the timeline/budget notes, plus proposed/client-confirmed chips, open questions and revise/decision/link forms. PRESENT: 5 (Extract requirements action, empty state, permission gating, version chips in source, separation of client-confirmed vs proposed). PARTIAL: 1 (Requirement summary and version history exist but are not visible without data). UNVERIFIED: 14 (feature list, roles, platforms, integrations, timeline/budget notes, open questions, version history, send summary to client, approve/reject, supersede, edit draft, source transcript references, no-silent-replacement, exact accepted version cited on quotation). Needs seeded requirement versions to verify rendering.

## SCR-010 Meetings

Routes: `/meetings` list and calendar (`?view=calendar`), `/meetings/[id]` not reachable (zero meetings). PRESENT: 8 (verified calendar status callout, count tiles for Requested/Booked/Completed/Cancelled/No show, list and month calendar views, window/owner/status/mode filters, no invented availability, "Record the request" on Lead 360).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Upcoming" count (p19) | PARTIAL | Shows "In this window" and "Next 7 days" but no separate Upcoming tile. | - |
| Meeting detail, Propose time, Book/rebook/cancel, live availability, Google Calendar event, attach notes/transcript, link to project (p19) | UNVERIFIED | No meeting rows exist and no calendar credential is configured, so none of these could be reached. Source has `[meetingId]` page with controls, attach-memory and project-link forms. Reschedule and cancel are documented in page.tsx as BLOCKED. | Needs a configured calendar and a seeded meeting. |
| "Calendar view" (p19) | PARTIAL | Month only, no week/day. | - |

## SCR-011 Quotations List

Routes: `/quotations`, version drawer. PRESENT: 10 (count and value tiles, status filters incl. Superseded, validity/expiry filters, search, sortable columns, version-history drawer, approval status link, delivery status column, PDF link, Save this view).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Client/project/service filters" (p20) | PARTIAL | Only a search box and a free-text Service field. No client or project select. | Client and project pickers. |
| "Submit for approval", "Send approved quote to client", "Mark accepted/rejected from evidence", "Create new version" (p20) | PARTIAL | None of these is on the list or its drawer. The drawer has only "Open the lead". Accepted/Rejected and the draft-new-version form exist on Lead 360's Quotations card. | List row actions, or a link that lands on the right control. |
| "PDF preview" (p20) | PARTIAL | "PDF" is a link to `/api/quotations/<id>/pdf`. There is no in-page preview. | Inline preview. |
| Delivery status | PRESENT | "Not sent" and similar, derived from messages. | - |
| Totals sanity: "Total value ₹3,30,400" counts three superseded versions of one deal | MISSING guard | The headline value sums superseded versions (₹82,600 ×4), which overstates. The sub-line "₹0 live" is honest, but the headline is misleading. | Sum only the live version. |

## SCR-012 Create / Edit Quotation

Routes: `/quotations/new` (owner). PRESENT: 16 (client information, deal, number/date/validity, project type, duration, sales owner, services/items add/remove, scope note, third-party charges from admin records, payment schedule preview, terms pre-filled, notes to owner, summary with amount in words, Save draft, Preview, Submit path, approval gate).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "GST vs Non-GST" (p21) | PARTIAL | A Tax line ("GST 18%... no confirmed billing mode on this deal yet; manual"). There is no GST / Non-GST toggle. | A tax-mode switch tied to the client. |
| "Payment terms must total 100%" and "Default milestones follow locked AgencyOS rules" (p21) | PARTIAL | The schedule shown is "Standard 30/40/30": Advance, Design sign-off, Go-live (three tranches). The PDF's locked plan is four milestones (M1-M4) and the Client 360 shows five milestones (M0-M4 style). The template totals 100%, but no editor for custom terms was seen. | Reconcile the template with the locked M1-M4 split. |
| "Send only after approval" (p21), owner decision #13 | PARTIAL | The composer top has "Share" and "Send to Client" buttons beside Save as Draft. Text says a quote reaches the client only after owner approval, but the decision #13 says no Share before approval. Not clicked. | Confirm Share is hidden or disabled before approval. |
| "Preview PDF" (p21) | PARTIAL | "Preview Quotation" renders the on-screen preview, not the PDF. | - |
| Totals with no items | MISSING | Pristine form shows "₹0 ... Zero Indian Rupees Only"; an empty quote can be attempted (validation not exercised). | - |

## SCR-013 Follow-ups & Nurture

Routes: `/follow-ups`, sequence detail drawer. PRESENT: 10 (Due today/Overdue/Upcoming/Paused/Failed tiles, channel/owner/status/time filters, queue with Details/Stop/Reschedule/Complete/Cancel, Resume on stopped, reactivation cohort panel with pilot-off explanation, situation-to-template mapping, consent and window text, central rules).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Pause/resume controls" (p22) | PARTIAL | The control is labelled "Stop" (and "Resume" once stopped), not Pause. | Naming only. |
| "Enroll eligible lead with consent" (p22) | PARTIAL | The cohort list exists but shows zero candidates. Enrolment is gated by the pilot being off, and the control could not be seen. | Seed a consented lead. |
| "Schedule" a follow-up (p22) | MISSING on this page | No "Schedule follow-up" button on the queue page. Scheduling is done from Lead 360 or Sales Overview. | Add button. |
| Drawer text inconsistency | PARTIAL | Drawer says "cancelling one would need a terminal state the table does not have", but the table offers Cancel and a Cancelled filter. The copy is stale. | Fix text. |
| "Client/project" column | PARTIAL | All 24 rows show "—" for client and project. | - |

## SCR-014 Client Management

Routes: `/clients`, row menu, preview drawer, Add Client dialog. PRESENT: 11 (KPIs incl. revenue, lifecycle pills, search, tag and owner filters, table, preview drawer, recent communication, upcoming follow-ups, pending invoices panels, Add/Edit client, Open client, Export, Import, Save this view).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Preview drawer data scoping (p23) | PARTIAL (defect) | With the first row (zztest-reqcomment client) selected, "Pending Invoices" listed Northwind Retail invoices (INV-2026-0001 and others). This is not that client's data. | Scope panels to the selected client. |
| "Assign relationship owner", "Add tags" (p23) | PARTIAL | Only reachable through Edit or Client 360 Settings; no list-level bulk or inline action. The table has no checkboxes (0 found). | - |
| "Client identity must deduplicate against lead/contact" (p23) | PARTIAL | Ten rows named "zztest-scope client" sit side by side with no duplicate flag. | Dedup indicator. |
| "Total revenue derived from verified payments" | PRESENT | ₹21,000 paid vs ₹5,73,000 invoiced. | - |
| Status semantic | MISSING | "Active clients: 23" equals Total (all clients active), and "Pending: 20" counts clients with an unfinished project, so the lifecycle chips overlap. | - |

## SCR-015 Client 360

Routes: `/clients/<101>` and tab URLs (`?tab=` overview, projects, quotations, invoices, communication, files, notes, activity, settings). All nine tabs are real (URL-driven). PRESENT: 19 (identity, total projects, invoiced/paid/outstanding, client health, next follow-up, every tab, Create project/quote/invoice, Schedule meeting, Add note, edit billing details with GSTIN/PAN checks, assigned team form, unread replies).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "GST/PAN and billing data require restricted permissions" (p24) | PARTIAL | In source, the Client details rail shows GSTIN and PAN to anyone with `project.read` (only money figures use `invoice.read`). Finance is blocked from the page; I did not confirm with a contractor on a client that has a GSTIN, because the seed client has none. | Gate GSTIN/PAN, or confirm. |
| "Upload file" (p24) | UNVERIFIED | The form exists, but the page prints "Storage is not reachable ... unhandled POST /storage/v1/object/list/project-files", so upload and download could not be exercised. | Storage available. |
| Tab content shown on every tab | PARTIAL | Every tab repeats the work tiles strip and a right-hand rail, so tabs are not very distinct. | - |

## SCR-016 Client Projects & Commercials

Route: Client 360 (projects and invoices tabs); there is no separate route. PRESENT: 12 (project list, commercial timeline, milestone schedule, invoice/payment table, change-request charges card, renewal/upsell form, maintenance status, paid vs outstanding, payment verification remains human).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Projects by status", "Accepted quote value" (p25) | PARTIAL | A single project row. Commercials shows "Accepted quote: none cited". No status breakdown KPI. | KPI. |
| "Generate invoice from approved milestone" (p25) | PARTIAL | The Invoices tab offers "Create invoice" and "Next to invoice: 0 milestones clear to bill". Whether the generate path works was not exercised. | - |
| "Start renewal/upsell flow" (p25) | PARTIAL | The form is there, but disabled with "none is completed yet". Not exercised. | - |
| "Open project finance" (p25) | MISSING | No link from the client page to the project's finance view; only to the project. | Deep link. |

## SCR-017 Client Communication, Files & Notes

Route: Client 360 Communication, Files and Notes tabs. PRESENT: 11 (unread replies with thread, Announcements panel, recent uploads panel, meeting notes and decisions, conversation per project group, internal notes marked "never shown to the client", Attach-to-project-memory explanation, file list, activity).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Send permitted message" (p26) | PARTIAL | "No lead thread to write to", because the client has none. The composer was not exercised. | - |
| "Upload/download file" (p26) | UNVERIFIED | Storage not reachable (see SCR-015). | - |
| "Last announcement" KPI (p26) | PARTIAL | Announcements panel: "No announcement has been published". No announcements can be created here (it says a campaign does it). | - |
| "Meeting decisions/open questions" (p26) | PARTIAL | A notes card exists but no open-questions rollup. | - |
| "Activity" sub-tab | MISSING | No Activity scoped to communication; the Activity tab is the commercial timeline. | - |

## SCR-018 All Projects

Routes: `/projects`. PRESENT: 11 (KPIs incl. payment-to-verify and at-risk, phase tiles, status pills, client/owner/phase/health filters, search, saved views, Archive on completed, show archived, open project, move with "Why on hold" reason on the project page, health chip).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Project table/cards" (p27) | PARTIAL | Table only, no cards. | - |
| "Payment gate", "owner" columns (p27) | PARTIAL | Columns are Project, Client, Stage, Phase, Health, Progress, Due, Budget, Created. There is no owner or payment-gate column (only the KPI). | Add both. |
| "Create project only through allowed conversion/manual path" (p27) | PARTIAL | No create control on the page. Creation is via the header Create menu. | - |
| "Pause/resume with reason" (p27) | PARTIAL | Not on the list. It is on the project's Settings ("Move project / Why on hold"). | Row action. |
| Health rule consistency | PARTIAL | List row for Northwind loyalty app shows Health "Blocked" (KPI Blocked: 1), but its Project Overview shows "Project health: On track - No blockers, nothing overdue". Two different health rules. | Reconcile. |

## Cross-cutting

- Responsive: at 390px the dashboard, leads, quotations, clients, search and notifications all had zero horizontal page overflow. PRESENT.
- Permission-denied: contractor and finance get a clear "You don't have access to this" page on /leads, /quotations and /clients. PRESENT. Contractor sees the dashboard and clients.
- Audit trail links: present on notifications (History, "Resolutions are also in the audit log"), follow-ups (correlation id), quotations (approval link). Not seen on the leads and clients lists.
- Bulk actions: present on Leads only. Clients, Quotations and Projects have none (the PDF says "only where safe").
- Sticky headers, column sorting and pagination: sort links exist on Quotations (Total, Valid until, Raised). Pagination or long-list behaviour was not exercised (UNVERIFIED). Leads shows all 20 with no pager.
- Realtime indicators: "Connecting / Reconnecting / Updated just now / Refresh" appear on Dashboard, Leads and Notifications. The dashboard "Reconnecting" stayed on during the session. PRESENT, with a question about whether the socket connects in this environment.
- Keyboard/a11y: ⌘K search and header shortcut present. I did not run a full a11y pass.
- Stale copy: Follow-ups drawer text contradicts the Cancel button.
- Tab patterns are inconsistent: Client 360 uses URL tabs, Lead 360 uses scroll anchors that do nothing when the section is absent, and Project uses a route per tab.
- Environment limits that hid content: calendar credential missing (Meetings), storage unreachable (Client files), no requirement versions and no booked meetings in the seed, and no populated quote on an approved state. These are the UNVERIFIED items above.
