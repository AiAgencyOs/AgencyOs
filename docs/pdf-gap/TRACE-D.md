# Trace D: line-by-line proof for PDF pages 64 to 83 (SCR-055 to SCR-071, section 7, section 8)

Source: `AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`, page-marked text `scratchpad/pdf/screen_architecture_fresh.txt`, pages 64 to 83. One row per bullet or line of text; the soft-wrapped continuation lines of one bullet are merged into its row. Evidence was found by reading the named files and, where cheap, by rendering the page as the owner (Playwright against the local stack, 1536 and 390 px) and by running the named tests and verifier.

Status words: BUILT, DECIDED (owner decision), QUESTION (open, exact question below), NOT-BUILDABLE, NARRATIVE (heading, label or footer that states no requirement), GAP (none left).

## Totals

| status | rows |
|---|---|
| BUILT | 427 |
| DECIDED | 3 |
| QUESTION | 1 |
| NOT-BUILDABLE | 0 |
| NARRATIVE | 203 |
| GAP | 0 |
| total | 634 |

No row is marked NOT-BUILDABLE because every control is built; the parts that need a service that cannot exist locally (a real Meta send, a real provider call, the alert webhook, Figma and Google answers, Supabase Storage) are BUILT in the panel and flagged inside their rows as not exercisable here. They are listed again under "Not verifiable here".

## Gaps this trace found and built

The first reading of each row turned up lines that were not built or not provable. Each was closed; the rows below now say BUILT.

| gap (PDF line) | what was built |
|---|---|
| SCR-055 checklist "Every significant action writes an activity/audit event" (add or edit an expense) | Recording or correcting an expense wrote no audit row (`audit.audit_log` held category entries only). Trigger `finance.audit_expense_change` (migration `supabase/migrations/20261008140100_an_expense_is_audited_when_it_is_recorded_or_changed.sql`) writes `finance.expense_recorded` / `finance.expense_updated` with the margin-relevant fields before and after, never the receipt link or path, and stays silent on a write that changes nothing. Applied twice locally. Verifier `npm run db:verify:trace-d` section A (step added to `.github/workflows/verify.yml`). |
| SCR-065 "No hidden spend: every AI call should be attributable to project and agent" | 166 of 204 local runs belong to no project and nothing showed that as a group. View `ai.spend_by_project` (migration `20261008140000_ai_spend_is_attributed_to_a_project.sql`, security invoker, owner and ops admin only, keeps the no-project row); reader `src/lib/admin/spend-by-project.ts`; pure `assembleSpend`; "Spend by Project" table on `/usage`; `/usage/runs?project=none` filter. Verifier section B proves the lines add up to every settled run and a member sees none. `src/lib/db/types.ts`: one view added. |
| SCR-060 "Meeting note upload" and "Meeting extraction must preserve the uploaded human source" | A text file (.txt, .md, .vtt, .srt) can be uploaded on the meeting; its text is kept verbatim as evidence with the file name, type, size and uploader (`src/modules/crm/meeting-note-file.ts`, `uploadEvidenceFileAction`, `addMeetingEvidenceFile` in `src/lib/scheduler/meeting-commands.ts`, `EvidenceFileForm` in `meetings/[meetingId]/controls.tsx`), through the existing audited door, no migration. Recordings and images are refused with the reason. The evidence list now keeps line breaks and shows small sizes in bytes. Verifier section D. |
| SCR-061 / SCR-065 "Automation workflows" | Owner decision R2 #10 keeps workflows in code, so the panel lists what the code defines: "Workflow Definitions" on `/agents/automations` (each event, who reacts, the job kind, 30-day runs), from `SUBSCRIPTIONS` in `src/lib/events/catalog.ts` (`src/lib/admin/automation-workflows-eval.ts`, `automation-workflows.ts`); count on the `/agents` card; "Create Automation" renamed "View Automations". |
| SCR-063 "Responsibilities" (separate from "Guardrails") | New "Responsibilities" card on `/agents/<key>`; Guardrails now states ceilings, work classes and that an agent cannot widen its own permissions; "All runs of this agent" link. |
| SCR-062 "Admin and Client are humans ... WhatsApp is a channel" | Stated on the Registry card and proved by a behavioural test over `AGENT_KEYS`. |
| SCR-064 "AgencyOS Orchestrator remains routing authority; OpenRouter may be a gateway" | Callout on `/agents/routing` stating it, grounded in `router.ts` and the provider list; "Store a key" form mounted in the vault card (it was only a link to `/agents`). |
| SCR-067 "Send controlled test message", "Acknowledge alert" | Readiness "Live Checks" card now carries the controlled-test form (or the link to set the recipient) and an Alerts line linking to Acknowledge on Operations. |
| SCR-056 "Do not infer legal compliance beyond configured rules" | Stated in words on the GST configuration card (the behaviour already held: unconfirmed mode is never guessed). |
| Checklist "search/filtering where list size can grow" on SCR-059, SCR-066, SCR-070 | Announcements: server-side search over title and text plus a status filter (`announcements-queries.ts`, `settings/communication/page.tsx`); Operations: one search box over dead letters, queue, failed deliveries, workflow runs (`src/lib/observability/operations-search.ts`; counts never narrowed); Import batches: search over label and note and a newest-50 bound (`src/lib/import/queries.ts`, which also stopped reading every record of every batch). |
| Section 8 "Test Phase 5 implementation traceability: plan -> task -> evidence -> developer test -> QA -> Admin -> client approval" | Verifier section C asserts every hop is a stored reference (ten columns across `projects` and `qa`). |

Files changed or added by this trace: `supabase/migrations/20261008140000_*.sql`, `20261008140100_*.sql`; `scripts/verify-trace-d.mjs`, `package.json` (`db:verify:trace-d`), `.github/workflows/verify.yml` (one step); `tests/trace-d-screens-helpers.test.ts` (14 behavioural tests); `src/lib/admin/{automation-workflows-eval,automation-workflows,spend-by-project-eval,spend-by-project,agent-runs}.ts`, `src/lib/observability/operations-search.ts`, `src/lib/import/queries.ts`, `src/lib/scheduler/meeting-commands.ts`, `src/modules/crm/{meeting-note-file,announcements-queries,meetings-view}.ts`, `src/lib/db/types.ts`; screens `app/(internal)/{agents/page,agents/[agentKey]/page,agents/automations/page,agents/routing/page,usage/page,usage/runs/page,operations/page,production-readiness/page,settings/communication/page,import/page,finance/tax/gst-configuration-card,meetings/[meetingId]/{page,controls,actions}}`.

## Interpretations recorded

- SCR-056 "Generate period report": there is no button with that name. The period selector recomputes every figure for the month, quarter or year and the PDF, CSV and GSTR files are the generated report; "Report Status" turns to exported when one is produced. If the owner expects a named action that stores a report snapshot, that is a new feature (see Q-D2).
- SCR-059 "Schedule/send": an announcement is recorded and published, not broadcast (decision of 2026-09-22, `docs/admin-panel-screen-traceability.md` row 59); sending to many clients is the governed Campaigns flow.
- SCR-063 "Responsibilities": the registry's `description` is the responsibility statement; there is no separate responsibilities field.

## Open questions

- **Q-D1** (SCR-070 "Update non-secret identifiers"): the Google Calendar id is read from the deployment environment and reads "unset - not editable from the panel". Should it become an organization setting editable here and read before the environment value?
- **Q-D2** (SCR-056 "Generate period report"): is the period selector plus the exports enough, or should "Generate" store a dated report snapshot that "Export history" lists and a lock can refer to?
- **Q-D3** (SCR-060 "Meeting note upload"): text files are kept verbatim. Should recordings, images, PDFs and Word files be accepted too, under the project-file rules (needs Supabase Storage and a signed reference), or stay out?
- Carried from earlier streams, still open and touching these pages: X1-Q1 whether "composition" should be offered as a GST registration type at all; X1-Q2 whether quarterly filing should stay selectable or be locked to monthly; X1-Q3 whether a replaced receipt's old object stays forever; X1-Q4 whether the project overview "Summary" (Paid, Amount received) should move to verified money (a database change).

Answered since the audits and now shown as DECIDED or BUILT: group-name pattern fixed (R2 #3), audit log kept forever with owner and ops admin export (R2 #11), automation workflows stay in code (R2 #10), expense categories owner-editable (R2 #6), GST defaults (R2 #9).

## Not verifiable here

- Every external service: a real WhatsApp/Meta send (controlled test message, template send, retry delivery), a real AI provider call (Verify provider, Run verification), the alert webhook, Figma and Google Calendar answers. The buttons, the recorded answers and the "skipped, not configured" reports were rendered; the services were not reached.
- Supabase Storage is not running locally: the expense receipt and payment proof uploads (X1) are proven by `tests/finance-attachments.test.ts` with a fake store, not in a browser. The meeting-note upload needs no storage, but the browser file chooser was not driven; the door, the pure rules and the rendered result were.
- States that need rows the local data lacks: a pending approval (Approve / Request changes / Reject), an open alert and the incident banner, a staged import batch (review and commit), a meeting with an extracted analysis (Decisions, Open questions), a secondary role to revoke, a populated tool-call trace. Their source was read and the doors are covered by the named verifiers; they were not rendered populated.
- "All CRUD and approval actions": there is no generated matrix of every action against every role. The evidence is policy dumps for the tables read here, the three live invariants, and 106 per-door verifier scripts; only `db:verify:trace-d` was run in this trace.
- The full test suite and the e2e spec were not run (as instructed). Run in this trace: `tsc` clean, `eslint` clean on every changed file, `tests/trace-d-screens-helpers.test.ts` (14) and 380 related tests (all pass), `db:verify:trace-d` (green, 4 sections).
- The responsive sweep (390 and 820 px, 32 routes, owner role, no horizontal overflow) is an overflow check, not a visual-quality review; the dev server was compiling other agents' edits while it ran, and the changed routes were re-swept afterwards.

## Rows

| page | the PDF's text | status | where |
|---|---|---|---|
| 64 | FINANCE | NARRATIVE | Domain heading (sidebar module group) |
| 64 | SCR-055 - Expenses & Profitability | NARRATIVE | Screen title: names the screen traced below |
| 64 | Primary lifecycle: Cross-phase internal \| Screen baseline number: 55 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 64 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 64 | Internal cost and margin tracking by project, service, vendor, infrastructure, AI and tooling. | BUILT | `/finance/expenses` (`app/(internal)/finance/expenses/page.tsx`): by project ("Project Profitability"), by vendor ("By vendor / tool"), by category (`finance.expense_categories`, owner-editable, Settings › Finance; the six starting categories are infrastructure, ai, tooling, vendor, contractor, other) and AI cost ("AI / Tooling Costs", by agent). Margin is one definition, `src/modules/finance/project-profitability.ts`. |
| 64 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 64 | Total expenses | BUILT | Stat "Total Expenses" (`expenses/page.tsx`, StatGrid at the top) |
| 64 | Project margin | BUILT | Stat "Project Margin": verified revenue less expenses, AI and time cost (`project-profitability.ts`; same margin as the project report) |
| 64 | Cost categories | BUILT | Stat "Cost Categories": count of categories with spend, largest named in the caption |
| 64 | Budget vs actual | BUILT | Stat "Budget vs Actual": consumed share of project budgets (`budget-variance.ts`), with the "Budget vs actual" table below |
| 64 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 64 | Expense list | BUILT | Expense list: DataTable with search ("Search expenses"), category / project-or-overhead / vendor / date filters, sort, saved views, paging (`filterExpenses` in `project-profitability.ts`) |
| 64 | Project profitability | BUILT | "Project Profitability" card, one margin per project, linked to the project report |
| 64 | Vendor/tool costs | BUILT | "By vendor / tool" card: every vendor per currency with its categories |
| 64 | AI/tooling costs | BUILT | "AI / Tooling Costs" card: runs, tokens and cost by agent from `finance.ai_cost_buckets()` (totals only, no prompt text) |
| 64 | Trend | BUILT | "Monthly trend" chart (recorded expenses per month, one currency) |
| 64 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 64 | Add/edit categorized expense | BUILT | `RecordExpenseForm` (`expenses/expense-form.tsx`) and `EditExpenseForm` (`expenses/expense-edit.tsx`) call `recordExpense` / `updateExpense` (`src/modules/finance/service.ts`, capability `invoice.issue` = owner and ops admin, RLS `expenses_write` = `is_admin`); the category must be an active one (guard `expense_category_guard`). Audit: GAP found by this trace (no audit row existed for an expense), now built, see Gaps. |
| 64 | Allocate to project | BUILT | "Project (optional)" select on both forms, "Overhead — no project" when blank; trigger `org_match_expenses_project` refuses a project of another organization |
| 64 | Attach receipt | BUILT | "Receipt link" or an uploaded file (owner decision R2 #5): `src/modules/finance/attachment.ts`, opened through `/api/finance/attachment/expense-receipt/<id>` (RLS read, signed URL). Storage is unreachable locally, so upload is proven by `tests/finance-attachments.test.ts` (fake storage), not the browser |
| 64 | Export internal report | BUILT | "Export CSV" button, `/api/finance/expenses/export` (`invoice.read`), every export logged (`logReportExport`, `finance.report_exports`) |
| 64 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 64 | Client-facing pricing is separate from internal delivery cost | BUILT | Client-facing money comes from `sales.*` quotations and `finance.invoices`; cost lives only in `finance.expenses` / `ai.*`, whose RLS admits owner, ops admin (and finance for reads) and no client role; the client portal (`app/(client)`) reads neither schema. Verified by policy dump (`finance.expenses_select`: `is_admin() OR is_finance()`). |
| 64 | Sensitive margins/costs are restricted to authorized internal roles | BUILT | Page gate `can(context, "invoice.read")` then `<PermissionDenied/>` (rendered denied for member and contractor in the D.md audit); RLS repeats it; AI cost is exposed to finance only as totals (`finance.ai_cost_buckets`) |
| 64 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 64 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page: `invoice.read`; writes: `invoice.issue` in the service and `is_admin()` in the table policy; categories door `finance.set_expense_category` re-checks owner/ops admin |
| 64 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Expense insert/update: trigger `finance.audit_expense_change` (migration `20261008140100`, built here, verifier `npm run db:verify:trace-d`) writes `finance.expense_recorded` / `finance.expense_updated` with before/after, org-scoped; categories door audits add/rename/retire/restore; exports logged |
| 64 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search, four filters, sort, paging and saved views on the list; `loading.tsx`; failed reads throw through `unreadable()` to the internal error boundary (`app/(internal)/error.tsx`, "Try again") |
| 64 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Every field of an expense is a column on its row (date, category, vendor, description, project, receipt, amount) and the edit form opens inline, so no separate quick-look is needed; project and AI detail open on their own pages |
| 64 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep run for this trace; DataTable collapses to cards at phone width) |
| 64 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 64 | Confidential \| Page 64 of 83 | NARRATIVE | Running page footer |
| 65 | FINANCE | NARRATIVE | Domain heading (sidebar module group) |
| 65 | SCR-056 - GST, Tax & Financial Reports | NARRATIVE | Screen title: names the screen traced below |
| 65 | Primary lifecycle: Cross-phase internal \| Screen baseline number: 56 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 65 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 65 | Tax configuration, GST reporting support, invoice registers and management financial exports. | BUILT | `/finance/tax` (`app/(internal)/finance/tax/page.tsx`): GST configuration card, GST and non-GST registers, tax summary, receipts, P&L, exports (CSV, PDF, GSTR-1/GSTR-3B JSON) and an export history |
| 65 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 65 | GST invoice totals | BUILT | Stat "GST Invoice Totals" |
| 65 | Non-GST totals | BUILT | Stat "Non-GST Totals" (an invoice whose project never confirmed a billing mode is counted on its own "Unconfirmed mode" line, never guessed) |
| 65 | Tax period | BUILT | Stat "Tax Period" + period selector (`period-select.tsx`: month, quarter, financial year; calendar month is the owner-decided basis, R2 #9) |
| 65 | Report status | BUILT | Stat "Report Status" (open / locked / exported) derived from the period lock and the export log |
| 65 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 65 | GST configuration | BUILT | "GST configuration" card (`finance/tax/gst-configuration-card.tsx`: GSTIN, state, SAC, effective since) plus Settings › Finance › "GST setup" (registration type, filing frequency, period basis; `gst-setup-form.tsx`, decision R2 #9) |
| 65 | Invoice register | BUILT | Invoice register: "GST invoices" / "Non-GST invoices" tables with mode filter chips and sort (`TotalsCard` and DataTable in `page.tsx`) |
| 65 | Tax summary | BUILT | Tax summary: "Tax by mode" card and Stats "Taxable value", "Tax collected", "Invoiced total" |
| 65 | Receipts | BUILT | Receipts: Stat "Receipts issued" and the "Receipts" table (links to the invoice) |
| 65 | P&L; style report | BUILT | "Profit & loss (INR, cash basis)" card: invoiced, received from verified payments, expenses, net, expenses by category |
| 65 | Export history | BUILT | "Export history" card: every CSV, PDF and GSTR download with who, when, period, counts and omitted rows (`finance.report_exports`, `src/modules/finance/export-log.ts`) |
| 65 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 65 | Configure tax profile | BUILT | "Configure tax profile" button (anchors to the card); `GstIdentityForm` → `gst-identity-actions.ts` / `gst-identity-service.ts`, owner only, audited with old and new in its own transaction |
| 65 | Generate period report | BUILT | The period selector re-computes every figure for the chosen month, quarter or year, and Export PDF / Export CSV / GSTR files are the generated report for it. There is no separate button named "Generate period report"; the selector plus exports are the generation (interpretation recorded in the last section) |
| 65 | Export CSV/PDF | BUILT | "Export CSV" (`/api/finance/tax/export`), "Export PDF" (`/api/finance/tax/pdf`), "GSTR-1 (JSON)" / "GSTR-3B (JSON)" (shown only when the saved GST setup files that return); `invoice.read`, each logged |
| 65 | Lock finalized reporting period if policy requires | BUILT | "Reporting period lock" card: `LockPeriodForm` / `UnlockPeriodForm` (`period-lock.tsx`, `tax-lock-service.ts`, `invoice.issue`); the finance service refuses to issue or void an invoice dated inside a lock |
| 65 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 65 | Do not infer legal compliance beyond configured rules | BUILT | The tax mode is never inferred (a project without a confirmed mode lands in "Unconfirmed mode"); the GST setup is the owner's recorded rules and the GSTR export refuses a window the setup does not file. The card now says so in words (added by this trace in `gst-configuration-card.tsx`) |
| 65 | Tax/profile changes are owner/admin-only and audited | BUILT | `hasRole(context, "owner")` gates the profile form; the door re-checks the role and the database policy `organizations_update`; the door audits old and new. Settings door `core.set_organization_setting` is audited too |
| 65 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 65 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `invoice.read`; profile `owner` (service + RLS); lock `invoice.issue` (service) with the lock doors re-checking in SQL |
| 65 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Lock and unlock doors write their audit row in the same transaction; GST identity door audits old and new; every export is logged (`finance.report_exports`) |
| 65 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Period selector, mode chips, sort, receipts capped at 50 with the period filter; `loading.tsx`; unreadable reads reach the error boundary with Try again |
| 65 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Rows that need inspection link to the invoice page (dedicated page); the card, lock form and export history are inline |
| 65 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep) |
| 65 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 65 | Confidential \| Page 65 of 83 | NARRATIVE | Running page footer |
| 66 | COMMUNICATION | NARRATIVE | Domain heading (sidebar module group) |
| 66 | SCR-057 - Communication Center | NARRATIVE | Screen title: names the screen traced below |
| 66 | Primary lifecycle: Cross-phase \| Screen baseline number: 57 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 66 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 66 | Unified operational communication dashboard across WhatsApp, email, announcements, client updates and internal handoffs. | BUILT | `/communication` (`app/(internal)/communication/page.tsx`): WhatsApp conversations, the email and client-update lane ("Email and client updates", `communication/email-panel.tsx`, `crm.outbound_emails`, sent through the invoice-email transport), announcements, templates and the "Waiting on a person" handoff queue |
| 66 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 66 | Unread/failed/pending-template messages | BUILT | Stats "Unread", "Failed deliveries", "Waiting on a template" (deferred sends; submitted templates in the caption) and "Active conversations" |
| 66 | Recent conversations | BUILT | "Conversations" card (newest first, unread/waiting filters, search) and "Conversations by Channel" |
| 66 | Announcements due | BUILT | Stat "Announcements due" (scheduled drafts, next time in the caption) |
| 66 | Human handoffs | BUILT | Stat "Waiting on a person" (agent paused) and the "Waiting on a person" card |
| 66 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 66 | Conversation queue | BUILT | "Conversations" card; each row opens the lead (`conversationHref`; a group row opens the project, never `/leads/null`) |
| 66 | Failed delivery queue | BUILT | "Failed deliveries" card: reason, preview, retry history, Retry, Escalate |
| 66 | Templates | BUILT | "Templates" card (registered templates and status; "Manage" opens Settings › Communication) |
| 66 | Announcements | BUILT | "Announcements" card and "Create announcement" composer |
| 66 | Internal escalation | BUILT | "Waiting on a person" card (`id="escalations"`), longest wait first, with the escalation control (`core.escalations`) |
| 66 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 66 | Open conversation | BUILT | Conversation rows link to `/leads/<id>` (`lead.read`) |
| 66 | Retry eligible delivery | BUILT | `RetryDeliveryForm` (`operations/retry-delivery-form.tsx`) → `retryFailedDeliveryAction`; a new send through the same door so consent, the 24-hour window and the outreach allowance decide again; needs `lead.write` |
| 66 | Create announcement | BUILT | Composer on `/communication` → `crm.create_announcement` (audited `announcement.drafted`); needs `organization.settings` |
| 66 | Assign handoff | BUILT | `HandoffForm` (`communication/handoff-form.tsx`, `lead.assign`) on each waiting thread; assigning is audited as `lead.assigned` (row trigger) |
| 66 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 66 | Client communication should remain simple and client-facing; internal AI/provider details must not appear | BUILT | Only the client-visible surfaces matter here: the client portal never reads `ai.*` (RLS admits internal roles only) and client messages are templates or agent drafts a person approves; provider errors appear only on internal screens |
| 66 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 66 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `lead.read`; retry `lead.write`; handoff `lead.assign`; announcements `organization.settings`; each door re-checks the role in SQL |
| 66 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Announcement and template doors audit (`announcement.drafted`, `whatsapp_template.*`), retry-with-reason audits `message.outbound.requeued_with_reason`, email sends record the provider answer |
| 66 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Unread / waiting filters and a text search over conversations (`?q=`); empty states with an action link; unreadable reads reach the error boundary |
| 66 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Failed delivery detail and escalation open inline; the conversation itself is the dedicated lead page |
| 66 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep) |
| 66 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 66 | Confidential \| Page 66 of 83 | NARRATIVE | Running page footer |
| 67 | COMMUNICATION | NARRATIVE | Domain heading (sidebar module group) |
| 67 | SCR-058 - WhatsApp / Conversations | NARRATIVE | Screen title: names the screen traced below |
| 67 | Primary lifecycle: Phase 1-8 \| Screen baseline number: 58 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 67 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 67 | WhatsApp-centric conversation workspace with client messages, staff replies, notes, template rules and human handoff state. | BUILT | `/leads/<id>` (`app/(internal)/leads/[leadId]/page.tsx`): message thread, composer, transcript note, delivery state per message, client context rail, template composer and paused-agent banner |
| 67 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 67 | Conversation identity | BUILT | Lead header (title, contact, channel) and the conversation card header |
| 67 | 24-hour window state | BUILT | Badge "24h window open" / "window closed — template only" / "never wrote — template only" / "group — no window", read from `crm.window_state` (`src/modules/crm/window-queries.ts`), the same function the sender asks |
| 67 | Template requirement | BUILT | The "window closed — template only" badge plus the `SendTemplateForm` (`template-send-form.tsx`), offered only approved and active templates |
| 67 | Agent/human state | BUILT | Badge "agent replying" / "with a person" (`conversation.agent_paused_at`) and the waiting banner (`waiting-banner.tsx`) with the reason |
| 67 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 67 | Message thread | BUILT | Message thread (inbound, outbound, agent, system rows) in `page.tsx` |
| 67 | Composer | BUILT | `SendToClientForm` (`message-form.tsx`), a distinct composer whose placeholder says the message reaches the client's phone |
| 67 | Internal note composer | BUILT | Collapsed grey "transcript note" control in `message-form.tsx` and `LeadNoteForm` (Notes tab); neither reaches the client |
| 67 | Delivery status | BUILT | Per-message delivery state (sent / delivered / read / failed) with `RetryDeliveryForm` and retry history |
| 67 | Client context panel | BUILT | Right rail "Lead information", "Lead Heat", "Tags", "Tasks", "Recent activity" and Quick Actions, plus the tab panels Sales, Quotations, Meetings, Files, Contracts, Follow-up sequences and Extracted requirements (`page.tsx`) |
| 67 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 67 | Send free-form message inside allowed window | BUILT | `SendToClientForm` → `sendClientMessageAction` → `sendClientMessage` (`src/modules/crm/service.ts`, `lead.write`); `planOutbound` refuses outside the 24-hour window unless an approved template carries it (`tests/a-message-outside-the-window.test.ts`) |
| 67 | Use approved template outside window | BUILT | `SendTemplateForm` (approved + active templates only; the door checks again, `template-send-service.ts`, `lead.write`) |
| 67 | Let agent answer / pause agent | BUILT | "Pause agent" (`PauseAgentForm`, `sales-panel.tsx`) and "Let the agent answer again" (`waiting-banner.tsx`) → `src/modules/crm/actions.ts` / `service.ts` |
| 67 | Add internal transcript note | BUILT | Transcript note control in `message-form.tsx` ("What did the customer say?", "Who said this") and the Notes tab `LeadNoteForm` |
| 67 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 67 | Official API limitations are respected | BUILT | The 24-hour window is enforced by the sender and the database (`crm.window_state`, migration `20260906120000`); outside it only an approved template goes; no scraping or unofficial path exists (`tests/a-message-outside-the-window.test.ts`, `whatsapp-webhook.test.ts`) |
| 67 | Project WhatsApp group creation remains a manual Admin step in the locked Phase 2 flow | BUILT | The project group is a manual card (`projects/[projectId]/group-setup-card.tsx`, `group-panel.tsx`) that says AgencyOS cannot add people to a group; `tests/the-group-is-a-manual-action.test.ts`, `the-admin-can-do-the-group-step.test.ts` |
| 67 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 67 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `lead.read`; send, template send, pause and note forms need `lead.write` (`service.ts`, `template-send-service.ts`); the database re-checks (`core.can_write()`) |
| 67 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Row triggers audit lead changes (`audit.record_row_change`); outbound messages are stored with author, delivery and idempotency key; pause/resume write the conversation row and an activity |
| 67 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | A thread is one record, so the list-search rule applies to `/leads` (search, filters, saved views); empty thread says "No conversation yet" with the next step; failed sends show Retry |
| 67 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Retry history and the lead preview drawer (`leads/preview-drawer.tsx`) are quick looks; the conversation is the dedicated workspace |
| 67 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep run for this trace, `/leads/<id>` and `/communication`) |
| 67 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 67 | Confidential \| Page 67 of 83 | NARRATIVE | Running page footer |
| 68 | COMMUNICATION | NARRATIVE | Domain heading (sidebar module group) |
| 68 | SCR-059 - Templates & Announcements | NARRATIVE | Screen title: names the screen traced below |
| 68 | Primary lifecycle: Cross-phase \| Screen baseline number: 59 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 68 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 68 | Manage approved outbound templates, project milestone announcements and reusable client update formats. | BUILT | `/settings/communication` (`app/(internal)/settings/communication/page.tsx`) (registry of approved-template metadata, announcements, announcement templates) and `/communication/templates/<id>`; milestone announcements: `crm.milestone_met_drafts_an_announcement` drafts from the active milestone template; reusable formats: `crm.announcement_templates` (migration `20261006500200`) |
| 68 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 68 | Template categories/languages | BUILT | Stats "Categories" and "Languages" (`settings/communication/page.tsx`) |
| 68 | Approval/provider status | BUILT | Stat "Approved" (active and approved by Meta), per-template status badge and "Record what Meta says" (`TEMPLATE_STATUSES`: draft, submitted, approved, rejected, paused, disabled, archived) |
| 68 | Scheduled announcements | BUILT | Stat "Announcements due" on `/communication` (scheduled drafts) and the "Publish at" control per draft in `announcements-panel.tsx` |
| 68 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 68 | Template registry | BUILT | `WhatsAppTemplatesForm` registry (`settings/forms.tsx`) and the "Templates" card on `/communication` |
| 68 | Template detail | BUILT | `/communication/templates/<id>` (`communication/templates/[templateId]/page.tsx`): sent / delivered / read / replied / failed, campaigns using it, change history |
| 68 | Announcement composer | BUILT | Announcement composer (`announcements-panel.tsx`): title, audience, project or client, body, optional reusable format |
| 68 | Audience/project selection | BUILT | Project / client picker (`announcements.project_id`, `client_account_id`; `listAnnouncementTargets`) |
| 68 | Send preview | BUILT | Preview panel in the composer (aria-label "Preview of the announcement"; records nothing) and the campaign send preview ("first 5 of N") |
| 68 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 68 | Register approved template metadata | BUILT | "Register template" (`setWhatsAppTemplateAction` → `src/lib/admin/settings.ts` `setWhatsAppTemplate`, `organization.settings`, `crm.set_whatsapp_template`, audited `whatsapp_template.set`) |
| 68 | Create announcement | BUILT | Composer → `crm.create_announcement` (audited `announcement.drafted`) |
| 68 | Schedule/send | BUILT | "Publish at" schedule form and Publish button; the scheduler tick publishes a due draft. An announcement is RECORDED, not broadcast (decision 2026-09-22, `docs/admin-panel-screen-traceability.md` row 59); sending to clients is the governed Campaigns flow (`/communication/campaigns`: approved template, second approver) |
| 68 | Archive template | BUILT | Archive: status "archived" through "Record what Meta says" for a WhatsApp template (`whatsapp_template.status`), the "archived" switch on an announcement template, and "Archive" on an announcement |
| 68 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 68 | Template wording must match provider-approved content where required | BUILT | `crm.whatsapp_templates` holds no body text (Meta owns the wording); a send needs `status = approved` AND `active` (`template-send-service.ts`), so a template not provider-approved never sends |
| 68 | Announcements are recorded against project/client timelines | BUILT | `announcements.project_id` / `client_account_id`; the project Activity feed and Client 360 read them (W5, `docs/pdf-gap/W5-BUILD.md`); migration `20261006500200` |
| 68 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 68 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Settings writes need `organization.settings`; doors re-check in SQL |
| 68 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `announcement.drafted`, `announcement_template.created/updated`, `whatsapp_template.set/status/withdrawn`, campaign doors; each carries organization and the project/client it names |
| 68 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Campaigns have search; announcements had a fixed newest-50 list with no filter: GAP found by this trace, built (search over title and body, status filter, server-side) in `settings/communication/page.tsx` + `announcements-queries.ts`; template registry is bounded by situation x language |
| 68 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Template detail and campaign detail are dedicated pages; send preview is inline |
| 68 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/settings/communication`, `/communication`, `/communication/campaigns`) |
| 68 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 68 | Confidential \| Page 68 of 83 | NARRATIVE | Running page footer |
| 69 | COMMUNICATION | NARRATIVE | Domain heading (sidebar module group) |
| 69 | SCR-060 - Delivery Failures, Outbox & Meeting Notes | NARRATIVE | Screen title: names the screen traced below |
| 69 | Primary lifecycle: Cross-phase \| Screen baseline number: 60 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 69 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 69 | Recovery center for failed client deliveries plus structured meeting notes/decision extraction. | BUILT | `/operations` (`app/(internal)/operations/page.tsx`) (failed deliveries, outbox, dead letters) and `/meetings/<id>` (`app/(internal)/meetings/[meetingId]/page.tsx`: evidence, extracted decisions, project memory) |
| 69 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 69 | Failed delivery count by code | BUILT | "Failed · <provider reason>" Stats (failures grouped on the provider's own prefix) in `operations/page.tsx` |
| 69 | Queued/retry/dead-letter | BUILT | Stats "Dead jobs", "Queued > 15m", "Unpublished", "Dead events"; the failed-delivery caption counts retries; "Job queue" and "Dead letters" lists |
| 69 | Meetings awaiting notes | BUILT | Stat "Meetings awaiting notes" (completed, nothing attached; drawn whenever a failure code or a waiting meeting exists) linking to `/meetings?window=past` |
| 69 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 69 | Failed message detail | BUILT | "Failed client deliveries" list: provider reason verbatim, preview, provider ref, author, time |
| 69 | Retry history | BUILT | Retry history under each failed delivery (`readRetryHistory`, "Retried N times", with each reason) |
| 69 | Outbox | BUILT | "Outbox" list with status filter and paging (`outbox-list.tsx`) |
| 69 | Meeting note upload | BUILT | Evidence form on the meeting (`meetings/[meetingId]/controls.tsx`): typed notes or summary, AND (built by this trace) "Upload notes or a transcript" for .txt, .md, .vtt, .srt, kept verbatim (`src/modules/crm/meeting-note-file.ts`, `uploadEvidenceFileAction`). Recordings and images are refused with the reason (no store signs them, G-229). Verified: pure rules tested (`tests/trace-d-screens-helpers.test.ts`), the door keeping text, name, type, size and uploader and auditing it (`npm run db:verify:trace-d` section D), and the form and evidence list rendered on a temporary meeting (since deleted). The browser file chooser itself was not driven |
| 69 | Extracted decisions/actions/open questions | BUILT | "Extracted from the analysis" card with Decisions, next actions and Open questions (`meetings/[meetingId]/page.tsx`), shown only once an analysis exists (needs a completed meeting; rendering not exercised locally: no meeting with an analysis) |
| 69 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 69 | Retry when safe | BUILT | `RetryDeliveryForm` on each failed delivery (`lead.write`); a dead job is requeued only when dead (`core.requeue_job_with_reason`) |
| 69 | Requeue dead delivery with reason | BUILT | Retry and dead-job requeue both take a written reason (`crm.requeue_failed_delivery` audits `message.outbound.requeued_with_reason`; `core.requeue_job_with_reason` audits `job.requeued_with_reason`) |
| 69 | Escalate to Admin | BUILT | `EscalateControl` on failed deliveries, dead jobs, dead outbox events, wedged follow-ups and failed workflows (`core.escalations`) |
| 69 | Attach meeting summary to project memory | BUILT | `AttachMeetingSummaryForm` (`meetings/[meetingId]/attach-memory-form.tsx`, owner or ops admin), listed under "Project memory"; `crm.attach_meeting_summary_to_memory` |
| 69 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 69 | Never endlessly retry permanent failures | BUILT | A permanent failure is never retried by itself: dead jobs are never retried on their own (page text), the runner stops at `max_attempts`, a delivery retry is a person's act each time with the window and consent re-checked (`tests/job-reaper.test.ts`, `job-requeue.test.ts`) |
| 69 | Meeting extraction must preserve the uploaded human source and versioned summary | BUILT | The upload is stored word for word (shown with line breaks kept) with the file name, type, size and uploader in `crm.meeting_evidence`; the analysis is a separate note whose extracted decisions and questions are labelled inference and sit beside, never over, the source (`crm.add_meeting_evidence`; the summary a person files later is its own evidence row, kind `summary`, and the newest wins); `tests/trace-d-screens-helpers.test.ts`, `db:verify:trace-d` section D |
| 69 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 69 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `audit.read`; retry `lead.write`; requeue `job.requeue`; meeting evidence `lead.write` and `core.can_write()` in SQL |
| 69 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `job.requeued_with_reason`, `message.outbound.requeued_with_reason`, `meeting.evidence_added`, escalations; each carries the lead/meeting and organization |
| 69 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Operations gained one search box over dead letters, queue, failed deliveries and workflow runs (GAP found by this trace; `src/lib/observability/operations-search.ts`); outbox has its status filter and paging; `/meetings` has search |
| 69 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | "Inspect chain" drawer for a workflow (`workflow-list.tsx`); a meeting is a dedicated page |
| 69 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/operations`, `/operations?q=window`, `/meetings`) |
| 69 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 69 | Confidential \| Page 69 of 83 | NARRATIVE | Running page footer |
| 70 | AI WORKFORCE | NARRATIVE | Domain heading (sidebar module group) |
| 70 | SCR-061 - AI Workforce Dashboard | NARRATIVE | Screen title: names the screen traced below |
| 70 | Primary lifecycle: Internal cross-phase \| Screen baseline number: 61 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 70 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 70 | Internal control center for active AI agents, task volume, model usage, cost and current operational posture. | BUILT | `/agents` (`app/(internal)/agents/page.tsx`): totals, activity trend, agent status, top agents, recent activity, model usage, automation workflows; gated on `audit.read` (owner, ops admin) |
| 70 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 70 | Total/active agents | BUILT | Stat "Total Agents" (enabled and would-run counts in the caption) |
| 70 | Tasks executed | BUILT | Stat "Total Tasks Executed" with a period delta |
| 70 | Tokens/usage | BUILT | Stat "Total Tokens Used" (input and output in the caption) |
| 70 | AI cost | BUILT | Stat "AI Cost" from the cost ledger |
| 70 | Average task time | BUILT | Stat "Avg. Task Time" (median and sample size in the caption) |
| 70 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 70 | Agent activity trend | BUILT | "Agent Activity" TrendChart (runs and failed per day) |
| 70 | Agent status | BUILT | "Agent Status" card (would run / enabled but blocked / disabled) |
| 70 | Top agents | BUILT | "Top Agents by Usage" card |
| 70 | Recent activity | BUILT | "Recent Agent Activity" card |
| 70 | Model usage | BUILT | "Model Usage" card; a model links to `/agents/models/<id>` only when `ai.models` holds it, otherwise plain text with a title |
| 70 | Automation workflows | BUILT | "Automation Workflows" card: count of workflows defined in code and the latest handoffs; the full "Workflow Definitions" list (event, who reacts, job kind, 30-day runs) is on `/agents/automations`, built by this trace from `SUBSCRIPTIONS` (`src/lib/admin/automation-workflows-eval.ts`). Owner decision R2 #10: workflows stay in code, so there is nothing to create or edit |
| 70 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 70 | Open agent/model/tool/run detail | BUILT | Agent rows open `/agents/<key>`; model `/agents/models/<id>`; tool `/agents/tools/<name>` (index `/agents/tools`); run `/usage/runs/<id>`; the "Task Runs" tab opens `/usage/runs`. The quick action formerly named "Create Automation" is now "View Automations" (nothing to create, R2 #10) |
| 70 | Enable actions only when policy permits | BUILT | Enable/disable and the ceilings sit on the agent page and are owner-only (`AgentStatusForm`, ADM-82 as reversed 2026-09-29); the registry says "would not run — <reason>" until policy, a provider key and a verified runtime allow it |
| 70 | Export usage | BUILT | "Export usage CSV" → `/api/usage/export` (`audit.read`) |
| 70 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 70 | Client never sees provider/model/API internals | BUILT | `ai.agents`, `ai.agent_steps`, `ai.models`, `ai.agent_routing_overrides` have RLS `is_internal()`; `ai.provider_credentials` is admin-only (policy dump); the client portal (`app/(client)`) references no `ai` schema; this page is gated `audit.read` |
| 70 | Dashboard must distinguish configured, verified, enabled and actually runnable | BUILT | Callout "AI provider not configured"; "Configured / Not configured" badge and the verified moment and model (`ai_provider_verified_at`); Stats "Would run now" and "Enabled, blocked"; would-run is derived by `wouldRun` (`src/lib/admin/agent-eval.ts`), the same gate the registry shows |
| 70 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 70 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `audit.read`; agent changes need `organization.settings` + owner role in the service and `is_owner()` in the SQL doors |
| 70 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `agent.disabled` / `agent.caps_set` / `agent.tool_allowed` / `agent.routing_override_set`, provider credential and verify doors audit; usage exports are read-only |
| 70 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | 16 agents and a handful of models are bounded; run search and filters are on `/usage/runs` (agent, status, model, provider, project, text) |
| 70 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Agent, tool and run details are dedicated pages; the activity rows link there |
| 70 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/agents`, `/agents/tools`, `/agents/automations`) |
| 70 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 70 | Confidential \| Page 70 of 83 | NARRATIVE | Running page footer |
| 71 | AI WORKFORCE | NARRATIVE | Domain heading (sidebar module group) |
| 71 | SCR-062 - Agent Registry | NARRATIVE | Screen title: names the screen traced below |
| 71 | Primary lifecycle: Internal cross-phase \| Screen baseline number: 62 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 71 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 71 | Registry of all business agents and backend orchestration roles with responsibilities, autonomy level and activation state. | BUILT | `/agents` (`app/(internal)/agents/page.tsx`) "Agent registry" card (autonomy, ceilings, validation, capabilities, disabled reason) and the compact "AI Agents" table; responsibilities are the registry's `description`; the registry holds the business agents and the backend roles (orchestrator, semantic_indexer) |
| 71 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 71 | Agent name/role | BUILT | Columns "Agent" and "Role" in the registry table |
| 71 | Enabled | BUILT | Column "Status" (Enabled / Disabled) |
| 71 | Would run now | BUILT | Column "Status" carries "would run" or "would not run — <reason>" and Stat "Would run now" |
| 71 | Autonomy level | BUILT | Column "Autonomy" |
| 71 | Model | BUILT | Columns "Model" and "Provider" |
| 71 | Cost/step caps | BUILT | Columns "Max steps" and "Max cost" |
| 71 | Validation status | BUILT | Column "Validated by a person" (when and by whom; `ai.agent_validations`) |
| 71 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 71 | Agent table/cards | BUILT | Registry table (cards at phone width) and the compact "AI Agents" table |
| 71 | Disabled reason | BUILT | Column "Disabled reason" |
| 71 | Capability summary | BUILT | Column "Capabilities" (what the agent may touch, client-facing, money authority) |
| 71 | Validation evidence | BUILT | "Validated by a person" column and the "Configuration validation" card on the agent page (`validation-queries.ts`) |
| 71 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 71 | Open agent detail | BUILT | Row action "Open agent" and row link to `/agents/<key>` |
| 71 | Enable/disable only if owner policy permits | BUILT | `AgentStatusForm` (`agents/[agentKey]/controls-form.tsx`; "Disable agent" needs a reason) → `ai.set_agent_status`, owner only, audited `agent.disabled` / `agent.enabled` |
| 71 | Validate agent configuration | BUILT | `ValidateAgentForm` (`agents/[agentKey]/validate-form.tsx`, `audit.read`) → `ai.agent_validations` |
| 71 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 71 | Admin and Client are humans, not AI agents | BUILT | `AGENT_KEYS` (`src/modules/agents/registry.ts`) and `ai.agents` hold no admin, client or whatsapp key; the Registry card now says so; behavioural test in `tests/trace-d-screens-helpers.test.ts` ("no agent of the registry is Admin, Client or WhatsApp"). Local `ai.agents` keys: customer_success, developer, finance, handover, lead_qualifier, orchestrator, project_manager, proposal_drafter, quality_assurance, requirement_collector, sales, semantic_indexer, support, ui_designer, ui_prototype, upsell |
| 71 | WhatsApp is a channel/tool, not an AI agent | BUILT | Same test and card text: WhatsApp is a channel the agents use as a tool, not a row of the registry |
| 71 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 71 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `audit.read`; enable/disable and caps owner-only in the service and in SQL (`is_owner()`) |
| 71 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `agent.disabled`, `agent.caps_set`, validation rows, tool-permission and assignment doors write audit rows in the same transaction |
| 71 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | 16 registry rows (bounded); filters belong to the run lists (`/usage/runs`); empty states carry an action |
| 71 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | A registry row opens the dedicated agent page; validation evidence is a card there |
| 71 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/agents`) |
| 71 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 71 | Confidential \| Page 71 of 83 | NARRATIVE | Running page footer |
| 72 | AI WORKFORCE | NARRATIVE | Domain heading (sidebar module group) |
| 72 | SCR-063 - Agent Detail & Permissions | NARRATIVE | Screen title: names the screen traced below |
| 72 | Primary lifecycle: Internal cross-phase \| Screen baseline number: 63 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 72 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 72 | Deep inspection of one agent: responsibility, allowed tools, limits, project scope, prompt/config version and recent decisions. | BUILT | `/agents/<key>` (`app/(internal)/agents/[agentKey]/page.tsx`): Responsibilities, Guardrails, Tool permissions, Project assignments, Prompt versions, Failures, Recent runs |
| 72 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 72 | Current model/provider | BUILT | "Configuration" rows "Default model" and "Current provider" |
| 72 | Autonomy | BUILT | Row "Autonomy" |
| 72 | Max steps/cost | BUILT | Rows "Max steps" and "Max cost per run" |
| 72 | Allowed work classes | BUILT | Row "Allowed work classes" and `AgentWorkClassesForm` (owner) |
| 72 | Status | BUILT | Header badge "would run" / "would not run — <reason>", rows "Enabled", "Disabled reason", "Last validated" |
| 72 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 72 | Responsibilities | BUILT | "Responsibilities" card (the registry description; split from Guardrails by this trace) |
| 72 | Guardrails | BUILT | "Guardrails" card (autonomy, ceilings, work classes) and the "Enforced by the runner" callout |
| 72 | Tool permissions | BUILT | "Tool permissions" panel (`policy-panel.tsx`, per tool Allow / Deny) |
| 72 | Project assignments | BUILT | "Project assignments" panel (Assign, Withdraw, Reassign) and "Refusals" |
| 72 | Config/prompt version | BUILT | Row "Configuration version" and the "Prompt versions" card (prompt key and version stamped on runs) |
| 72 | Recent runs | BUILT | "Recent runs" card, with a new "All runs of this agent" link to `/usage/runs?agent=<key>` |
| 72 | Failures | BUILT | "Failures" card (the error as the runtime recorded it) |
| 72 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 72 | Adjust permitted configuration | BUILT | `AgentCapsForm`, `AgentWorkClassesForm`, `AgentStatusForm` (owner; `ai.set_agent_caps`, `ai.set_agent_work_classes`, `ai.set_agent_status`) |
| 72 | Assign/unassign project where allowed | BUILT | `ai.set_agent_project_assignment` through the Project assignments panel (owner, audited) |
| 72 | Run validation | BUILT | `ValidateAgentForm` ("Validate now") |
| 72 | Disable on incident | BUILT | `AgentStatusForm`: "Disable agent" with a mandatory "Reason for disabling" (takes effect on the next run) |
| 72 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 72 | An agent cannot widen its own permissions | BUILT | Agents run with no `auth.uid()` and every policy door (`ai.set_agent_tool_permission`, `set_agent_project_assignment`, caps, status) requires `core.is_owner()` and refuses otherwise (migration `20260929170000`); the runner only reads these rows. The Guardrails card now says an agent has no way to widen its own |
| 72 | Authority changes are owner/admin-controlled and audited | BUILT | Owner-only doors, each writing `core.record_audit` with before and after (`agent.tool_allowed`, `agent.caps_set`, `agent.disabled`); the audit log is the change history |
| 72 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 72 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `audit.read`; edits owner-only (`mayEditPolicy`) and re-checked in each SQL door |
| 72 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Each policy door audits in its own transaction, with organization and project where it names one |
| 72 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Runs and failures are capped lists with a link to the filtered `/usage/runs`; empty states say what to do |
| 72 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Run detail is a dedicated page (`/usage/runs/<id>`); the policy panel is inline |
| 72 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/agents/customer_success`) |
| 72 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 72 | Confidential \| Page 72 of 83 | NARRATIVE | Running page footer |
| 73 | AI WORKFORCE | NARRATIVE | Domain heading (sidebar module group) |
| 73 | SCR-064 - Model Routing, Providers & Tools | NARRATIVE | Screen title: names the screen traced below |
| 73 | Primary lifecycle: Internal cross-phase \| Screen baseline number: 64 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 73 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 73 | Provider/model routing control supporting external APIs today and future hybrid self-hosted models without changing business workflows. | BUILT | `/agents/routing` (`app/(internal)/agents/routing/page.tsx`): routing is by model name through the provider registry (`src/lib/ai/router.ts`: five providers chosen by model id), so a self-hosted model is a new adapter and registry row, with no change to business workflows (the workflow and handoff tables live in `src/lib/events/catalog.ts`, not in a provider) |
| 73 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 73 | Provider status | BUILT | Stat "Provider Status" (providers with a stored or environment key, of five) |
| 73 | Verified runtime | BUILT | Stat "Verified Runtime" (Verified / Never, with model and moment) |
| 73 | Model availability | BUILT | Stat "Model Availability" (available of registered) |
| 73 | Routing rules | BUILT | Stat "Routing Rules" (categories with a set policy) |
| 73 | Fallback policy | BUILT | Stat "Fallback Policy" (work classes with a chain) |
| 73 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 73 | Provider key vault status | BUILT | "Provider vault" card: per provider "stored <when> by <who>" / "no vault key"; never the key |
| 73 | Model registry | BUILT | "Model registry" card with Add model / Retire (owner) |
| 73 | Routing matrix by agent/work class | BUILT | "Routing matrix" and "Routing by agent" (per-agent override grid) |
| 73 | Tool permissions | BUILT | "Tool Permissions" card (every tool with allowed / denied / bound counts, links to the tool page) |
| 73 | Fallback chain | BUILT | "Fallback chain per work class" |
| 73 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 73 | Store/revoke key securely | BUILT | Store: `SetProviderCredentialForm` now mounted in the vault card (owner; moved onto this page by this trace; encrypted, audited, the audit names the slot and never the value); Revoke: `RevokeProviderCredentialForm` per provider (owner) |
| 73 | Verify provider | BUILT | "Verify Provider" card (`verifyAiProviderAction`, one real call, answer recorded). The real call needs a provider key and cannot run locally; the button, the report and the recorded moment are rendered |
| 73 | Change routing policy | BUILT | `RoutingPolicyForm` and `RoutingOverrideForm` (owner; `ai.set_agent_routing_override`, audited `agent.routing_override_set`) |
| 73 | Set model budget/cap | BUILT | "Model Budgets" card (`ai.set_model_budget`, W6, verifier `npm run db:verify:modelbudget`) and "Provider budgets" |
| 73 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 73 | AgencyOS Orchestrator remains routing authority | BUILT | A callout on this page (added by this trace) states it; in code the router (`src/lib/ai/router.ts`, `src/lib/ai/model-choice.ts`) and the routing tables decide the model from the agent and the work class, and the runner enforces ceilings, budgets and the fallback chain |
| 73 | OpenRouter may be a gateway but must not become the business orchestrator | BUILT | OpenRouter is one of `VAULT_PROVIDERS` (anthropic, openai, gemini, xai, openrouter) the router calls by model id (`src/lib/ai/providers.ts`); workflows, handoffs and approvals are in `src/lib/events/catalog.ts` and the agent registry, never in a provider; same callout |
| 73 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 73 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `organization.settings`; routing, vault and budgets owner-only in the service and in SQL |
| 73 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Vault store/revoke, routing override, fallback, model and provider budget doors audit (`model_budget.set/cleared`, `agent.routing_override_set`, provider credential) |
| 73 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Registries are small and bounded; empty states explain; reads throw to the error boundary |
| 73 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Per-tool and per-model detail are dedicated pages; vault rows are inline |
| 73 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/agents/routing`) |
| 73 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 73 | Confidential \| Page 73 of 83 | NARRATIVE | Running page footer |
| 74 | AI WORKFORCE | NARRATIVE | Domain heading (sidebar module group) |
| 74 | SCR-065 - Agent Runs, Usage, Cost & Automations | NARRATIVE | Screen title: names the screen traced below |
| 74 | Primary lifecycle: Internal cross-phase \| Screen baseline number: 65 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 74 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 74 | Trace every AI call/run by project, agent, provider/model, tokens/cost, tool actions, events and automation workflow. | BUILT | `/usage` (`app/(internal)/usage/page.tsx`: totals, daily spend, per-agent and, new, per-project spend), `/usage/runs` (filters), `/usage/runs/<id>` (steps, tool calls, retries, replay, cancel); automation workflows on `/agents/automations` |
| 74 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 74 | Runs, tokens, recorded cost, failures, latency | BUILT | `/usage` Stats "Agent runs", "Input tokens", "Output tokens", "Cost" and latency Stats (average, median, p95, model call); `/usage/runs` Stats "Runs", "Avg steps", "Total cost"; failures are the status chips |
| 74 | Project/agent/provider filters | BUILT | `/usage/runs` filter chips: agent, status, model, provider, project (now with "No project") and a text search |
| 74 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 74 | Run list | BUILT | `/usage/runs` run table |
| 74 | Step trace | BUILT | "Step trace" card on the run page (steps in sequence) |
| 74 | Tool calls | BUILT | `tool_call` steps render with the tool name inside the trace (`usage/runs/[runId]/page.tsx`); the local ledger holds only `model_call` steps, so a populated tool trace could not be rendered here |
| 74 | Cost ledger | BUILT | `/usage` "Daily spend" chart and the per-agent table, `/api/usage/ledger` rows, and the new "Spend by Project" table |
| 74 | Automation workflows | BUILT | `/agents/automations` "Workflow Definitions" (this trace) and handoffs; owner decision R2 #10 |
| 74 | Retry/dead-letter linkage | BUILT | "Retries & dead letters" card on the run page (jobs sharing the correlation id, attempts, sibling runs, link to Operations) |
| 74 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 74 | Inspect run | BUILT | Run rows open `/usage/runs/<id>` (`audit.read`) |
| 74 | Replay only if safe/idempotent | BUILT | `ReplayRunForm` is offered only when `mayReplay(workClass)` (`src/lib/ai/replay-rules.ts`) and the caller holds `job.requeue`; the page states the refusal otherwise |
| 74 | Cancel long-running work | BUILT | `CancelRunningJobForm` on a running job of the run (`core.cancel_running_job`, `job.requeue`); workflow-level cancel is on Operations |
| 74 | Export cost ledger | BUILT | "Export cost ledger (rows)" → `/api/usage/ledger`; "Export usage CSV" on `/agents` |
| 74 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 74 | No hidden spend: every AI call should be attributable to project and agent | BUILT | Every run row names its agent (`agent_key` NOT NULL) and its project when the work belongs to one. Work with no project was invisible as a group: GAP found by this trace, built: view `ai.spend_by_project` (migration `20261008140000`), "Spend by Project" card keeping a "No project" line, and the `/usage/runs?project=none` filter; pure `assembleSpend` tested; verifier `npm run db:verify:trace-d` proves the lines add up to every settled run |
| 74 | Retries and automation events must be idempotent and auditable | BUILT | Retries go through `core.requeue_job_with_reason` and `core.cancel_job` on the same job row (`dedupe_key`, `correlation_id`, payload kept; audited `job.requeued_with_reason`, `job.cancelled`); the event dedupe key `evt:<id>:<handler>` makes redelivery insert nothing (`src/lib/events/catalog.ts`; `tests/outbox-dispatch.test.ts`, `tests/job-requeue.test.ts`) |
| 74 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 74 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Pages `audit.read`; replay and cancel need `job.requeue`; doors re-check in SQL |
| 74 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Requeue, cancel and budget refusals audit; every run carries organization, agent and project |
| 74 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | `/usage/runs` has agent / status / model / provider / project filters, text search and a "Clear filters" empty state; the spend table is bounded by project count |
| 74 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Run detail is the dedicated page; spend rows open the filtered run list |
| 74 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/usage`, `/usage/runs`) |
| 74 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 74 | Confidential \| Page 74 of 83 | NARRATIVE | Running page footer |
| 75 | OPERATIONS | NARRATIVE | Domain heading (sidebar module group) |
| 75 | SCR-066 - Operations Dashboard | NARRATIVE | Screen title: names the screen traced below |
| 75 | Primary lifecycle: Cross-phase \| Screen baseline number: 66 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 75 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 75 | Job, queue, scheduler, outbox, dead-letter and long-running workflow control plane. | BUILT | `/operations` (`app/(internal)/operations/page.tsx`) (jobs, queue, scheduler tick, outbox, dead letters, workflow runs, alerts, emergency controls) |
| 75 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 75 | Dead jobs | BUILT | Stat "Dead jobs" (links to `#dead-letters`) |
| 75 | Stalled | BUILT | Stat "Stalled" |
| 75 | Queued too long | BUILT | Stat "Queued > 15m" |
| 75 | Unpublished events | BUILT | Stat "Unpublished" (events) |
| 75 | Dead events | BUILT | Stat "Dead events" |
| 75 | Late approvals | BUILT | Stat "Approvals late" |
| 75 | Nobody told | BUILT | Stat "Nobody told" (an approval nobody was asked to decide) |
| 75 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 75 | Scheduler status | BUILT | `StaleDataWarning` "Scheduler" (last tick, stale after 15 minutes) and the Scheduler card on `/settings` |
| 75 | Job queues | BUILT | "Job queue (N)" list with status, attempts and Cancel |
| 75 | Dead letters | BUILT | "Dead letters" list |
| 75 | Outbox | BUILT | "Outbox" list (read-only rows, status filter, paging, counts) |
| 75 | Workflow runs | BUILT | "Workflow runs (N)" list grouped by correlation id |
| 75 | Retry/requeue controls | BUILT | Requeue (dead jobs, with a reason), Cancel (queued jobs, with a reason), Retry (deliveries) and Escalate on every kind of stuck row |
| 75 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 75 | Requeue safe job | BUILT | `operations/requeue-form.tsx` → `core.requeue_job_with_reason`: refuses anything not dead ("safe"), capability `job.requeue` |
| 75 | Cancel workflow | BUILT | "Cancel workflow" in the event-chain drawer (`cancel-workflow-form.tsx`, `src/lib/observability/cancel-workflow-plan.ts`): every unsettled job of the correlation id through the audited cancel doors (W6) |
| 75 | Inspect event chain | BUILT | "Inspect chain" drawer per workflow (`workflow-list.tsx`) |
| 75 | Escalate operational failure | BUILT | `EscalateControl` on dead jobs, failed deliveries, dead outbox events, wedged follow-ups and failed workflows (`core.escalate`) |
| 75 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 75 | Exactly-once is treated realistically using idempotency/outbox patterns | BUILT | At-least-once with idempotency: `core.jobs.dedupe_key` is unique, `dedupeKeyFor(event, handler)` makes a redelivered event insert nothing, and the outbox row is written in the business transaction (`src/lib/events/catalog.ts`; `tests/outbox-transactional.test.ts`, `outbox-dispatch.test.ts`); the page says dead jobs never retry on their own |
| 75 | A recovered job keeps original event/job lineage | BUILT | Requeue updates the same `core.jobs` row (`attempts` reset; `payload`, `dedupe_key`, `correlation_id` untouched), so lineage is kept (`core.requeue_job`); `tests/job-requeue.test.ts` |
| 75 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 75 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `audit.read`; requeue and cancel `job.requeue`; retry `lead.write`; each door re-checks the role in SQL |
| 75 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `job.requeued_with_reason`, `job.cancelled`, `alert.acknowledged`, escalations; each names the job and its correlation id |
| 75 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | One search box over the lists (GAP found by this trace, built: `src/lib/observability/operations-search.ts`; counts are never narrowed), outbox status filter and paging, an empty state per list |
| 75 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | The workflow chain opens in a drawer; the lead or run behind a row is a dedicated page |
| 75 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/operations`, `/operations?q=window`) |
| 75 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 75 | Confidential \| Page 75 of 83 | NARRATIVE | Running page footer |
| 76 | OPERATIONS | NARRATIVE | Domain heading (sidebar module group) |
| 76 | SCR-067 - System Health, Production Readiness & Alerts | NARRATIVE | Screen title: names the screen traced below |
| 76 | Primary lifecycle: Cross-phase \| Screen baseline number: 67 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 76 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 76 | Evidence-based environment and integration health covering production config, database, scheduler, WhatsApp, AI provider and alert delivery. | BUILT | `/production-readiness` (`app/(internal)/production-readiness/page.tsx`) (checks with evidence and a fix), `/integrations`, `/operations#alerts`, `/settings/communication` |
| 76 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 76 | Ready/not ready/needs verification | BUILT | Sentence banner and four counters (Not ready, Unavailable, Needs verification, Ready) from `readinessSentence` / `getProductionReadiness` |
| 76 | Integration lifecycle | BUILT | `/integrations` lifecycle counters (verified, configured, degraded, not configured, failed, disabled) |
| 76 | Last live checks | BUILT | "Live Checks" card: "Last live check answered <moment>" and each check's own last answer |
| 76 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 76 | Production readiness checks | BUILT | Check list with "Evidence:" and the fix per check |
| 76 | Integration health | BUILT | `/integrations` list (Database, Scheduler, WhatsApp/Meta, AI provider, speech, image, alerting, GitHub, Figma, Calendar) |
| 76 | Alert destination | BUILT | "Alert destination" row with "Test alert destination" and the last test |
| 76 | External verification evidence | BUILT | "Evidence:" per check, external ones flagged, and an `IntegrationState` callout for each non-green external dependency |
| 76 | Incident banner | BUILT | Global `IncidentBanner` (`app/(internal)/incident-banner.tsx`, under the header of every screen while a critical alert is open); not rendered locally (no open critical alert) |
| 76 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 76 | Run verification | BUILT | "Run verification" (`RunVerificationForm`, `production-readiness/actions.ts`): Meta, AI provider, Calendar and Figma in turn, one report line each; a check that is not configured says "Skipped", never a pass. External answers cannot be exercised locally |
| 76 | Send controlled test message | BUILT | "Controlled test message": `SendWhatsAppTestForm` now mounted on the readiness card (this trace), or a link to set the internal test recipient. The send needs `WHATSAPP_ACCESS_TOKEN` (not available locally: no Meta account), so only the form, the recipient gate and the recorded moment were rendered |
| 76 | Verify provider | BUILT | "Verify provider": inside "Run verification" and on `/agents`, `/agents/routing`, `/integrations` (`verifyAiProviderAction`); the real call needs a provider key |
| 76 | Acknowledge alert | BUILT | "Alerts" row on the readiness card (open count and a link) and `AcknowledgeForm` with a mandatory reason on `/operations#alerts` (`core.acknowledge_alert`, audited `alert.acknowledged`); rendered empty, no open alert locally |
| 76 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 76 | Configured is not the same as verified | BUILT | Lifecycle vocabulary NOT_CONFIGURED / CONFIGURED / VERIFIED (`src/lib/admin/integrations-eval.ts`); the page header says it; WhatsApp and the AI provider stay amber until a recorded real answer |
| 76 | Readiness should rely on real checks and recorded evidence, not presence of a setting alone | BUILT | Every check carries what was observed, an `external` flag and the recorded evidence; unreadable signals are "Unavailable", never green (`production-readiness-eval.ts`) |
| 76 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 76 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Page `organization.settings`; verify actions re-check; acknowledge `job.requeue` plus SQL |
| 76 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Verify actions record the answer in the org settings (audited); the alert test audits `alert_destination.tested`; acknowledge audits `alert.acknowledged` |
| 76 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Bounded list of checks; unavailable evidence is shown as such with the fix; reads throw to the retry boundary |
| 76 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Alert and incident details open on Operations (dedicated); evidence is inline per check |
| 76 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/production-readiness`, `/integrations`) |
| 76 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 76 | Confidential \| Page 76 of 83 | NARRATIVE | Running page footer |
| 77 | GOVERNANCE & SECURITY | NARRATIVE | Domain heading (sidebar module group) |
| 77 | SCR-068 - Approval Center, Policies & Overrides | NARRATIVE | Screen title: names the screen traced below |
| 77 | Primary lifecycle: Cross-phase \| Screen baseline number: 68 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 77 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 77 | Human decision queue for quotations, payments, design reviews, change requests, invoices/refunds and other governed actions. | BUILT | `/approvals` (`app/(internal)/approvals/page.tsx`), `/approvals/<id>`, `/settings/approvals`, `/governance/overrides` |
| 77 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 77 | Pending approvals | BUILT | Stat "Waiting" |
| 77 | Due/late approvals | BUILT | Stat "Past deadline" (SLA breached) and "Median time to decide" |
| 77 | Approval type | BUILT | Type filter chips ("Every type" + each subject type) and the type label on every row |
| 77 | Required role | BUILT | Role filter chips ("Any role", "needs <role>") and "Needs: <role>" on every row and on the detail page |
| 77 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 77 | Approval queue | BUILT | Approval queue (cards, search, filters) |
| 77 | Decision detail | BUILT | `/approvals/<id>` (`ApprovalBanner`, "Needs", "Raised by", "Amount", "Decision note", "Evidence") |
| 77 | Policy ladder | BUILT | `/settings/approvals` "Who must approve what" |
| 77 | Override center | BUILT | `/governance/overrides` "Override record" |
| 77 | Emergency controls | BUILT | "Emergency controls" card on `/governance/overrides` (three switches, `core.set_kill_switch`) and the engaged callout on Operations |
| 77 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 77 | Approve/reject/request change | BUILT | `ApprovalDecisionForm` (`approval-decision-form.tsx`) in `DecideInDrawer`: Approve, Request changes, Reject, with a note; `approvals.decide_approval` re-checks the required role. Needs a pending approval to render (none locally); the door is covered by `scripts/verify-approvals.mjs` |
| 77 | Configure stricter policy if authorized | BUILT | `/settings/approvals` policy form (owner; `approvals.set_policy`); the engine lets a policy make a rule stricter and never looser (`20260812120011_approval_engine.sql`) |
| 77 | Record exception/override with reason | BUILT | "Record an exception" form (owner, reason required, `core.record_manual_override`, audited `override.recorded`) |
| 77 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 77 | Policy defines who must consent, not who may bypass controls | BUILT | Policy rows hold `required_role` and `min_amount`; a decision needs a person with that role, and no policy can lower the baseline (engine comment "Policy may make either stricter. It may not make them looser."); an override is a separate recorded act |
| 77 | No silent override; every exception is explicit and audited | BUILT | Every override and emergency toggle is a door with a mandatory reason, audited with actor, time and reason (`override.recorded`, `kill_switch.engaged` / released); the record page lists them |
| 77 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 77 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Approvals page open to every internal role; a decision needs the approval's required role (SQL); policy and overrides owner-only |
| 77 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `approval.approved` / `approval.rejected` / `approval.changes_requested`, `override.recorded`, kill-switch audits; each approval carries its subject, project and client |
| 77 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Search over summary and subject, type and role filters, "Clear" and an empty state with an action |
| 77 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | A decision opens in a drawer (`decide-drawer.tsx`); the request is a dedicated page |
| 77 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/approvals`, `/governance/overrides`, `/settings/approvals`) |
| 77 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 77 | Confidential \| Page 77 of 83 | NARRATIVE | Running page footer |
| 78 | GOVERNANCE & SECURITY | NARRATIVE | Domain heading (sidebar module group) |
| 78 | SCR-069 - Security, Roles & Audit Log | NARRATIVE | Screen title: names the screen traced below |
| 78 | Primary lifecycle: Cross-phase \| Screen baseline number: 69 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 78 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 78 | RBAC, tenant isolation, secondary roles, permission checks, security evidence and immutable audit history. | BUILT | `/security` (`app/(internal)/security/page.tsx`), `/security/users`, `/security/incidents`, `/audit`: roles, secondary roles, the structural invariant scan, immutable audit history (append-only triggers, no delete, truncate trigger from X2) |
| 78 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 78 | Users/roles | BUILT | Stats "Users" and "Roles held" |
| 78 | Security invariant status | BUILT | Stat "Invariants" (three live structural checks: `tenant-fk-guards`, `org-freeze`, `invoker-writes`; `src/lib/admin/security-eval.ts`) and the all-hold / regressed banner |
| 78 | Recent privileged changes | BUILT | "Recent privileged changes": real privilege changes only, with member, actor, the change, time and the reason given (`src/lib/audit/privileged.ts`, W6) |
| 78 | Audit event count | BUILT | Stat "Audit entries" |
| 78 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 78 | Role assignment | BUILT | `MemberRolesPanel` on `/security/users` and Settings › Team (Grant, Revoke, Suspend / Reactivate) |
| 78 | Permission matrix | BUILT | "Permission matrix" card (capability to role, read-only: a change is a code review) |
| 78 | Security invariants | BUILT | Invariants list with each check and its state |
| 78 | Audit log filters | BUILT | `/audit` filters: search, action, subject type, actor type, from, to, with real paging |
| 78 | Incident/security exception history | BUILT | `/security/incidents` (open, resolved, opened from an audit entry) and `/governance/overrides` (exceptions) |
| 78 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 78 | Grant/revoke role | BUILT | `GrantForm` / `RevokeButton` / suspend toggle (`settings/member-roles-panel.tsx`) → `core.grant_secondary_role`, `core.revoke_secondary_role`, `core.set_membership_status`, each with a mandatory reason recorded as `membership.change_reason` (W6) |
| 78 | Review access | BUILT | `AccessReviewPanel` on `/security/users` (last review per membership, record a review: `security.record_access_review`) |
| 78 | Export audit | BUILT | "Export CSV" on `/audit` → `/api/audit/export` (capability `audit.export`: owner and ops admin; every export logged `audit.exported` via `audit.log_audit_export`, X2) |
| 78 | Investigate security event | BUILT | "Investigate" link on each privileged change (`/security`) opens `/security/incidents?audit=<id>` with the entry as evidence (`security.open_incident`) |
| 78 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 78 | Cross-tenant isolation and RLS are hard requirements | BUILT | Tables carry RLS policies keyed on `core.current_organization_id()` (policy dumps read for `finance.expenses`, `ai.*`, `audit`); `/security` runs three live structural invariants (`tenant-fk-guards`, `org-freeze`, `invoker-writes`, `src/lib/admin/security-eval.ts`); live verifiers (`scripts/verify-invoker-rls.mjs`, `verify-fail-open-guards.mjs` and the per-module `verify-*.mjs`) assert cross-organization and wrong-role refusals; plus `tests/whatsapp-tenancy.test.ts`, `tests/agent-registry-not-tenant-writable.test.ts` |
| 78 | Privileged changes must show actor, time, before/after and reason where applicable | BUILT | The privileged list shows actor name, change and reason (W6); `/audit` rows show actor name, a link to the record and a "Before/after" disclosure; a change with no reason reads "No reason recorded" |
| 78 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 78 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Pages `audit.read` / `organization.settings`; role doors re-check in SQL (`core.is_owner()` for grants) |
| 78 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `membership.*`, `audit.exported`, incident doors; the log is append-only (`audit_log_no_update`, `audit_log_no_delete`, truncate trigger) |
| 78 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | `/audit` search and five filters with paging (50 a page, true total) and an empty state with a clear action |
| 78 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Before/after and incident open in place; incidents and users are dedicated pages |
| 78 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/security`, `/security/users`, `/security/incidents`, `/audit`) |
| 78 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 78 | Confidential \| Page 78 of 83 | NARRATIVE | Running page footer |
| 79 | INTEGRATIONS | NARRATIVE | Domain heading (sidebar module group) |
| 79 | SCR-070 - Integrations Center & Import | NARRATIVE | Screen title: names the screen traced below |
| 79 | Primary lifecycle: Cross-phase \| Screen baseline number: 70 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 79 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 79 | Lifecycle management for database, scheduler, WhatsApp/Meta, AI providers, calendar, Figma, alerting and historical lead import. | BUILT | `/integrations` (`app/(internal)/integrations/page.tsx`): Database, Scheduler, WhatsApp/Meta, AI provider, Speech to text, Image generation, Alerting, GitHub, Figma and Google Calendar as lifecycle rows (Figma and Calendar added by W6), and `/import` for historical lead import |
| 79 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 79 | Verified/configured/degraded/not configured/failed/disabled counts | BUILT | Six counters VERIFIED / CONFIGURED / DEGRADED / NOT CONFIGURED / FAILED / DISABLED (`integrations/page.tsx`) |
| 79 | Last verified time | BUILT | Per-row "last verified" and the aggregate last person-run check (W6) |
| 79 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 79 | Integration list | BUILT | `IntegrationsList` (`integrations/integrations-list.tsx`) |
| 79 | Integration detail | BUILT | Detail drawer per integration with identifiers, vault note and its verify control |
| 79 | Verification controls | BUILT | `VerifyWhatsAppButton`, `VerifyAiProviderForm`, `VerifyFigmaForm`, `VerifyCalendarForm` |
| 79 | Provider vault link | BUILT | "Provider key vault" button (`/agents#vault`) and per-integration "Open secure key storage" links (`/security/keys`) |
| 79 | Historical WhatsApp import staging | BUILT | `/import` upload and staged batches; `/import/<batch>` review and commit |
| 79 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 79 | Verify connection | BUILT | The verify buttons above; each records its answer, and a failed read is shown as unavailable evidence |
| 79 | Update non-secret identifiers | QUESTION | WhatsApp has editable non-secret identifiers (phone number id, internal test recipient: `WhatsAppNumberForm`, `TestRecipientForm`, whitelisted in `core.set_organization_setting`). The other integrations' identifiers are deployment environment values the panel cannot write by design (the Google Calendar id reads "unset - not editable from the panel"). Question for the owner: should the Google Calendar id become an organization setting editable here, read before the environment value? |
| 79 | Open secure key storage | BUILT | Per-row links to `/security/keys` and `/agents#vault`; the panel never shows a key |
| 79 | Stage/review/commit import | BUILT | `UploadForm` stages (`/import`), `/import/<batch>` lists records with classification, and "Commit" creates contact and lead only (`crm.commit_import_batch`); `scripts/verify-lead-import.mjs`, `tests/whatsapp-import-*.test.ts`. Review and commit were not rendered locally (no staged batch) |
| 79 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 79 | A failed health read means unavailable evidence, not automatic proof that the provider is broken | BUILT | Lifecycle `UNKNOWN` / "Unavailable" is its own state: a failed read never turns a row red (`integrations-eval.ts`); the page footnote says the page could not confirm it and to verify from the linked page |
| 79 | Imports remain inert until reviewed/committed and do not grant outreach consent | BUILT | A staged batch writes staging rows only; commit creates identity, sets no consent, sends nothing (`import/page.tsx` text; `reactivationStatus` shows "blocked — no consent"); `scripts/verify-lead-import.mjs`, `tests/whatsapp-import-dryrun.test.ts` |
| 79 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 79 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Pages `organization.settings`; import commit owner or ops admin in SQL |
| 79 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | Verify answers are recorded in settings (audited); import commits are audited (`import.batch_committed`) and the lead trigger records `lead.imported` |
| 79 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | Integrations are a fixed, bounded list; import batches gained search over label and note and a newest-50 bound (GAP found by this trace, built: `src/lib/import/queries.ts`, `import/page.tsx`) |
| 79 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | Integration detail opens in a drawer; a batch is a dedicated page |
| 79 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, `/integrations`, `/import`) |
| 79 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 79 | Confidential \| Page 79 of 83 | NARRATIVE | Running page footer |
| 80 | ORGANIZATION SETTINGS | NARRATIVE | Domain heading (sidebar module group) |
| 80 | SCR-071 - Organization Settings & Business Rules | NARRATIVE | Screen title: names the screen traced below |
| 80 | Primary lifecycle: Cross-phase \| Screen baseline number: 71 of 71 | NARRATIVE | Metadata (lifecycle phase span and baseline number) |
| 80 | Purpose | NARRATIVE | Section label of the PDF layout; states no requirement |
| 80 | Structured settings hub replacing one long mixed page. Everything configurable must be grouped into clear tabs with safe defaults and explicit ownership. | BUILT | `/settings` (`app/(internal)/settings/layout.tsx`; tabs General, Commercial, Team, Communication, Approvals, Finance, Templates, Project defaults); each tab is its own route, with a status tile per area (`src/lib/admin/settings-summary.ts`) |
| 80 | Header / Summary / KPI area | NARRATIVE | Section label of the PDF layout; states no requirement |
| 80 | Organization profile | BUILT | Area tile "General" (`settings/layout.tsx`, `settings-summary-eval.ts`) |
| 80 | Commercial rules | BUILT | Area tile "Commercial" |
| 80 | Project defaults | BUILT | Area tile "Project Defaults" (tab `/settings/project-defaults`, W2) |
| 80 | Communication rules | BUILT | Area tile "Communication" |
| 80 | Finance rules | BUILT | Area tile "Finance" |
| 80 | Team/reviewer defaults | BUILT | Area tile "Team" (default group members, design reviewer named) and the "Approvals" tile |
| 80 | Security/integrations shortcuts | BUILT | "Security, integrations and the key vault" block on `/settings` (links to Keys & secrets, Integrations, Production readiness) |
| 80 | Main content and sub-screens | NARRATIVE | Section label of the PDF layout; states no requirement |
| 80 | General | BUILT | `/settings` General (agency name, scheduler, environment status) |
| 80 | Agency profile/contact | BUILT | "Quotation contact details" (`/settings`) |
| 80 | Pricing model/cost references | BUILT | "What the work costs" (day rate, AI day rate, multiplier band; `settings/commercial/page.tsx`) |
| 80 | Payment terms | BUILT | "When the client pays" (payment structures; 30/20/30/20 default, R2 #2) |
| 80 | Third-party charges | BUILT | "Third-party charges" |
| 80 | Agent limits/offers | BUILT | "Limits on what the agent may do alone" and "An offer the agent may apply" |
| 80 | Project group naming/default team | BUILT | "Project group names" (Team tab: fixed four parts and an owner word, DECIDED R2 #3), `TeamRosterPanel` "Default team members", Project Defaults "Project Group Name" |
| 80 | Design reviewer | BUILT | "Who reviews design work" (Team tab) |
| 80 | Timezone | BUILT | "Agency timezone" (`/settings`, `TimezoneFormWithPreview`) |
| 80 | Internal/announcement channels | BUILT | Communication tab: internal WhatsApp recipient and group, "Announcements", "Announcement templates" |
| 80 | Approval policies | BUILT | `/settings/approvals` "Who must approve what" |
| 80 | WhatsApp templates/outreach caps | BUILT | Communication tab: "Messages outside the 24-hour window" (template registry), "How often AgencyOS starts a conversation" (outreach limits), sending window, reactivation cap and pilot |
| 80 | Provider vault references | BUILT | `/settings` "Security, integrations and the key vault" block: links to `/security/keys` (key presence only) and `/agents#vault` |
| 80 | Primary actions | NARRATIVE | Section label of the PDF layout; states no requirement |
| 80 | Edit only the tab the user is working on | BUILT | Each tab is its own route with its own forms; a form posts one setting through `core.set_organization_setting` (whitelisted keys) or its own door |
| 80 | Preview impact before saving high-risk settings | BUILT | `ImpactGate` (`settings/impact-gate.tsx`) before pricing model, payment terms, quotation validity, negotiation limits, offer, outreach limits, sending window and reactivation cap; name and timezone have `*FormWithPreview`; counts come from real rows (`readSettingImpact`) |
| 80 | Show current value, effective date and audit history | BUILT | `SettingHistory` drawer beside each setting: value, who changed it, when (effective date) and before/after (`settings/setting-history.tsx`, `loadSettingHistory`, read from the audit trail) |
| 80 | Guardrails, status rules and traceability | NARRATIVE | Section label of the PDF layout; states no requirement |
| 80 | Settings can configure behaviour but must not bypass hard business/security gates | BUILT | Settings are whitelisted keys with CHECKs in the door; hard gates (consent, the 24-hour window, owner approval, payment evidence, verified payments) are enforced in SQL and cannot be set away; `tests/a-setting-the-owner-can-set-has-a-history-and-a-default.test.ts` |
| 80 | The admin panel must expose every meaningful AgencyOS configuration in an organized, discoverable way | BUILT | `src/lib/admin/settings-catalogue.ts` lists every settable key; `docs/AGENCYOS_ADMIN_CONFIGURABILITY_AUDIT.md` audited the rest; section 7 below is traced item by item |
| 80 | Implementation checklist for this screen | NARRATIVE | Section label of the PDF layout; states no requirement |
| 80 | All create/update/delete/approve/override actions must be permission-checked server-side, not only hidden in the UI. | BUILT | Pages `organization.settings` (owner); the door re-checks `core.is_owner()` for each setting |
| 80 | Every significant action writes an activity/audit event and preserves organization/project/client context. | BUILT | `core.set_organization_setting` records old and new in `audit.audit_log` (`organization.setting_set`) |
| 80 | Provide search/filtering where list size can grow; show concise empty/error states and retry paths. | BUILT | The template list has search; each setting has its history in a drawer; unreadable reads reach the error boundary with Try again |
| 80 | Use contextual drawers for quick inspection; use dedicated page/tabs for complex workflows. | BUILT | History opens in a drawer; each tab is a dedicated page with anchors |
| 80 | Desktop is the primary admin experience; tablet/mobile must preserve critical actions without horizontal chaos. | BUILT | No horizontal overflow at 390 or 820 px (sweep, all eight settings routes) |
| 80 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 80 | Confidential \| Page 80 of 83 | NARRATIVE | Running page footer |
| 81 | 7. Admin Manageability Matrix - What Must Be Configurable | NARRATIVE | Section title of the PDF; states no requirement |
| 81 | Organization & Identity | NARRATIVE | Matrix group label of section 7; states no requirement (its items follow) |
| 81 | Agency name and quotation contact details | BUILT | `/settings` "Agency name" (`OrganizationNameFormWithPreview`, impact preview) and "Quotation contact details" |
| 81 | Timezone | BUILT | `/settings` "Agency timezone" (`TimezoneFormWithPreview`; follow-ups stay paused until it is set) |
| 81 | Internal announcement recipient/channel | BUILT | Settings › Communication: `InternalRecipientForm` (a person's WhatsApp) and `InternalGroupForm` (the internal group), `settings/forms.tsx` |
| 81 | Team roles and additional roles | BUILT | `MemberRolesPanel` (`settings/member-roles-panel.tsx`) on Settings › Team and `/security/users`: Grant and Revoke secondary roles, Suspend / Reactivate, each with a reason |
| 81 | Default team members for project setup | BUILT | Settings › Team "Default team members" (`TeamRosterPanel`, `settings/team-roster-panel.tsx`) |
| 81 | Commercial Rules | NARRATIVE | Matrix group label of section 7; states no requirement (its items follow) |
| 81 | Internal delivery-cost references | BUILT | Settings › Commercial "What the work costs" (day rate, AI day rate) and per-member cost rates on Team (`settings/cost-rate-cell.tsx`) |
| 81 | Pricing bands/multipliers | BUILT | Settings › Commercial pricing multipliers (`pricing_multiplier_min`, `_target`, `_max`) in the same card, with `ImpactGate` |
| 81 | Minimum price and max autonomous quote policy | BUILT | Settings › Commercial "Limits on what the agent may do alone": `negotiation_min_price_rupees`, `negotiation_max_autonomous_quote_rupees`, max rounds (`NegotiationLimitsForm`) |
| 81 | Maximum discount / authorized offer | BUILT | Same card (`negotiation_max_discount_pct`) and "An offer the agent may apply" (the authorized offer) |
| 81 | Third-party charge references | BUILT | Settings › Commercial "Third-party charges" (`ThirdPartyChargesForm`) |
| 81 | Payment schedule templates | BUILT | Settings › Commercial "When the client pays": payment structures, with the 30/20/30/20 default on Phases 2, 4, 5, 6 (owner decision R2 #2, `sales.seed_default_payment_structure`) |
| 81 | Project Defaults | NARRATIVE | Matrix group label of section 7; states no requirement (its items follow) |
| 81 | Project group naming pattern | DECIDED | Owner decision R2 #3: the pattern is fixed (four parts and one trailing word). Shown at Settings › Project defaults "Project Group Name"; the trailing word is editable at Settings › Team "Project group names". Not an open question any more |
| 81 | Default project team list | BUILT | Settings › Team "Default team members" (the default group and project team roster) |
| 81 | Project templates | BUILT | `/settings/templates` "Project templates" (`settings/templates/page.tsx`, search, detail page per template) |
| 81 | Default phase notifications | BUILT | Settings › Project defaults: default phase notifications (`watchPhases`) through `projects.set_project_defaults` (W2) |
| 81 | Design reviewer assignment | BUILT | Settings › Team "Who reviews design work" (`core.set_default_design_reviewer`) |
| 81 | Standard folder structure | BUILT | Settings › Project defaults: standard folder list copied to new projects (`folderText`, W2) |
| 81 | Communication | NARRATIVE | Matrix group label of section 7; states no requirement (its items follow) |
| 81 | WhatsApp identifiers/status | BUILT | Settings › Communication: WhatsApp phone number id, test recipient, "Verify with Meta" and the recorded verified moment (`WhatsAppNumberForm`, `VerifyWhatsAppButton`) |
| 81 | Approved template mapping by situation/language | BUILT | Settings › Communication "Messages outside the 24-hour window": situation x language to approved template (`WhatsAppTemplatesForm`, `crm.set_whatsapp_template`) |
| 81 | Outreach frequency caps | BUILT | Settings › Communication "How often AgencyOS starts a conversation" (`OutreachLimitsForm`, `ImpactGate`) and the sending window |
| 81 | Reactivation pilot/caps | BUILT | Settings › Communication: reactivation pilot (`PilotToggleForm`) and per-run cap (`ReactivationCapForm`) |
| 81 | Announcement templates | BUILT | Settings › Communication "Announcement templates" (`announcement-templates-panel.tsx`, `crm.announcement_templates`, W5) |
| 81 | Alert webhook destination | BUILT | `/security/keys` slot `ALERT_WEBHOOK_URL` (value never shown), the "Alert destination" row and "Test alert destination" on Production readiness |
| 81 | AI Workforce | NARRATIVE | Matrix group label of section 7; states no requirement (its items follow) |
| 81 | Provider key presence through secure vault | BUILT | `/agents/routing` "Provider vault" (presence only) and `/security/keys` |
| 81 | Model/provider verification | BUILT | "Verify Provider" on `/agents`, `/agents/routing`, `/integrations` |
| 81 | Routing policy | BUILT | `/agents/routing` "Routing matrix" / `RoutingPolicyForm` |
| 81 | Agent enable/disable where permitted | BUILT | `AgentStatusForm` on `/agents/<key>` (owner) |
| 81 | Cost/step limits | BUILT | `AgentCapsForm` on `/agents/<key>`, "Provider budgets" and "Model Budgets" on `/agents/routing` |
| 81 | Tool permissions | BUILT | Tool permissions: `/agents/<key>` panel and `/agents/tools/<tool>` |
| 81 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 81 | Confidential \| Page 81 of 83 | NARRATIVE | Running page footer |
| 82 | Finance | NARRATIVE | Matrix group label of section 7; states no requirement (its items follow) |
| 82 | GST/non-GST billing profile | BUILT | Project billing section ("How this project is billed", `projects/[projectId]/billing-panel.tsx`, confirmed version) and Settings › Finance "GST identity" and "GST setup" |
| 82 | Invoice numbering/terms | BUILT | Settings › Finance "Invoice numbering and terms" (`finance.set_invoice_numbering`, prefix, default terms days, terms note; W1) |
| 82 | Payment accounts displayed to clients | BUILT | Settings › Finance "Receiving accounts" (the accounts shown to clients; masked number, reveal for `invoice.issue`) |
| 82 | Milestone rules where user explicitly changes policy | BUILT | Settings › Commercial "When the client pays" (milestone payment structure) and Settings › Finance "Payment evidence before a deal is won" (`won_requires_payment_evidence`, W1) |
| 82 | Reminder rules | BUILT | Settings › Finance "Past-due reminders" (`InvoiceReminderPolicyForm`) |
| 82 | Expense categories | BUILT | Settings › Finance "Expense categories" (`finance.set_expense_category`, owner decision R2 #6; list with counts, rename, retire/restore, add) |
| 82 | Governance & Security | NARRATIVE | Matrix group label of section 7; states no requirement (its items follow) |
| 82 | Approval policy ladder | BUILT | `/settings/approvals` "Who must approve what" (`approvals.set_policy`, a policy may only be made stricter) |
| 82 | Role assignments | BUILT | `MemberRolesPanel` (`/security/users`, Settings › Team); `/security/users` access review |
| 82 | Audit access | DECIDED | Owner decision R2 #11 (audit log kept forever; owner and ops admin may export; every export logged). Read access is the `audit.read` capability and export is `audit.export` (`src/lib/authz/permissions.ts`), shown in the read-only Permission matrix on `/security`; `/audit` says so. A change is a code review, by design |
| 82 | Override/emergency controls | BUILT | `/governance/overrides` (record an exception, three emergency switches) |
| 82 | Retention/export rules | DECIDED | Owner decision R2 #11: kept forever (no deletion path: `audit_log_no_update`, `audit_log_no_delete`, truncate trigger and revoked privileges, migration `20261007200100`), export for owner and ops admin only, each export itself logged (`audit.exported`, `/api/audit/export`). There is deliberately no retention setting |
| 82 | Integration verification | BUILT | `/integrations` verify controls and `/production-readiness` "Run verification" |
| 82 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 82 | Confidential \| Page 82 of 83 | NARRATIVE | Running page footer |
| 83 | 8. UI Implementation and QA Checklist | NARRATIVE | Section title of the PDF; states no requirement |
| 83 | Implement the left navigation exactly as organized modules; do not recreate a single overloaded Settings page. | BUILT | Left navigation is `app/(internal)/nav-config.ts` (`NAV_MODULES`, every item names its capability and the SCR ids it serves); Settings is eight tabs (`settings/layout.tsx`), not one page. The owner chose the reference screenshots' module list over the PDF's grouping on 2026-10-03 (recorded in the file header), so each of the 71 screens keeps one home |
| 83 | Create reusable page header, KPI card, data table, filter bar, drawer, empty state, error state, approval banner and activity timeline components. | BUILT | `src/ui/primitives`: `page-header`, `stat` (KPI card), `table` (data table), `filter-bar`, `drawer`, `empty-state`, `error-state` and `approval-banner` (W6), `timeline` and `activity-feed` (activity timeline); exported from `@/ui` |
| 83 | Ensure every phase-specific output is visible in Project Overview and the related specialist module. | BUILT | `/projects/<id>` (`projects/[projectId]/page.tsx`) carries a panel per phase (`phase-two-panel`, `phase-four-panel`, `development-panel`, `qa-panel`, `delivery-panel`, `deliverables-panel`, `claims-panel`) and links to each specialist route (design, prototype, development, qa, release, builds, files); the specialist traces A to C covered the per-phase rows. Not re-rendered here for every phase |
| 83 | Ensure Admin can trace: who did what, which version, which approval, which client response, which payment verification and which evidence. | BUILT | Audit rows show actor name, action, a link to the exact record or version (`src/lib/audit/links.ts`), before/after and reason; approvals `/approvals/<id>`; payment verification `/finance/payments/<id>` and `/invoices/verify`; meeting and claim evidence rows name their uploader |
| 83 | Map every screen action to a backend capability/permission/event before calling the screen complete. | BUILT | This trace names a capability or door for every primary action of SCR-055 to SCR-071 above, `nav-config.ts` names the capability of every page, and the Permission matrix on `/security` lists them. The map for screens outside this slice is in the other trace files |
| 83 | Add RLS/tenant isolation and resource-level permission tests for all CRUD and approval actions. | BUILT | Tenant isolation is enforced by RLS policies keyed on `core.current_organization_id()` on the tables (policy dumps read for `finance.expenses`, `ai.*`), by three live structural invariants on `/security` (`tenant-fk-guards`, `org-freeze`, `invoker-writes`, `src/lib/admin/security-eval.ts`), and by 106 live verifier scripts (`scripts/verify-*.mjs`, run as `npm run db:verify:*`) that assert cross-organization and wrong-role refusals per door family, plus `tests/whatsapp-tenancy.test.ts`, `agent-registry-not-tenant-writable.test.ts`. A generated matrix of every CRUD and approval action against every role does not exist; this trace ran only `db:verify:trace-d` |
| 83 | Add loading/empty/error/permission/stale/integration-failure states for all 71 screens and key sub-screens. | BUILT | Each of the 107 `page.tsx` files under `app/(internal)` has a `loading.tsx` of its own or of an ancestor (checked by a scan in this trace); `EmptyState` (with an action), `ErrorState` (`app/(internal)/error.tsx`, Try again), `PermissionDenied`, `StaleDataWarning`, `IntegrationState` |
| 83 | Test desktop, tablet and mobile responsiveness; desktop remains the primary operating mode. | BUILT | Sweep run for this trace as owner: 32 routes of SCR-055 to SCR-071 at 390 and 820 px, no horizontal page overflow on any; desktop is the primary layout (sidebar, KPI rows, tables) |
| 83 | Test deep links from notification -> exact source record and from activity/audit -> exact record/version. | BUILT | Audit rows link to the exact record (`src/lib/audit/links.ts`, `tests/w6-audit-and-operations-helpers.test.ts`); notification rows link to their subject (`notifications/notification-list.tsx`, `app/(internal)/action-bell.tsx`) |
| 83 | Test cross-module consistency: client totals equal finance records; project phase equals gate state; UI approvals reference correct design version; QA defects reference correct build/task. | BUILT | Finance totals use one verified-payment basis (`src/lib/finance/verified-basis.ts`; `tests/finance-verified-basis.test.ts`, `finance-client-pdf-basis.test.ts`; clients, dashboard, tax and PDF agree, X1). A QA defect names its build, task and run (`qa.defects.build_id/task_id/run_id`, checked live by `db:verify:trace-d`). The phase-equals-gate and UI-approval-references-version checks are covered by the design and project traces (`tests/a-project-view-figures-are-derived-from-the-rows.test.ts`, `phase-three-in-the-admin-panel.test.ts`); not independently re-run here |
| 83 | Test payment-gated progression: evidence submitted -> pending verification -> Admin verified -> gate open. | BUILT | `tests/payment-verified.test.ts`, `pm-m2-payment-verified.test.ts`, `release-gates.test.ts`, `a-release-is-paid-for.test.ts`; live `scripts/verify-payment-verification.mjs`, `verify-milestone-unlock.mjs`, `verify-release-gates.mjs` |
| 83 | Test Phase 3/4 UI auditability: all options/samples sent, selected theme/color, design versions, internal/Admin/client decisions and prototype revisions remain visible. | BUILT | `tests/phase-three-in-the-admin-panel.test.ts`, `phase-four-admin-overview.test.ts`, `phase-three-begins-where-phase-two-ends.test.ts`; design versions, options sent, decisions and revisions are listed on the design routes (traces B and C) |
| 83 | Test Phase 5 implementation traceability: plan -> task -> evidence -> developer test -> QA -> Admin -> client approval. | BUILT | Each hop is a stored reference (task evidence, a test naming its task, QA run naming the deliverable, a defect naming build, task and run, deliverable and handover naming the Admin approval), proven live by `npm run db:verify:trace-d` section C (built by this trace); the behaviour at each hop: `tests/qa-gate.test.ts`, `a-test-case-is-imported-and-linked.test.ts`, and the acceptance guard in trace C. There is no single end-to-end test across all seven links |
| 83 | Test Master QA: bug fixed by developer cannot resolve defect until QA retest passes. | BUILT | `tests/qa-gate.test.ts`, `scripts/verify-qa-gate.mjs` (a fixed defect needs a passing QA retest) |
| 83 | Test production readiness: deployment cannot proceed if required final payment or hard release gate is missing. | BUILT | `tests/release-gates.test.ts`, `a-release-is-paid-for.test.ts`, `scripts/verify-release-gates.mjs`; `/production-readiness` states "NOT production ready — N blocking" |
| 83 | Test manual WhatsApp group setup flow: AgencyOS assists Admin but does not falsely claim automatic group creation. | BUILT | `tests/the-group-is-a-manual-action.test.ts`, `the-admin-can-do-the-group-step.test.ts`; the project group card says AgencyOS cannot add people to a WhatsApp group |
| 83 | Keep internal AI provider/model/API and delivery-cost data restricted to authorized internal screens. | BUILT | RLS on `ai.*` and `finance.expenses` admits internal roles only; screens `/agents`, `/usage`, `/integrations`, `/settings` and `/finance/*` answer "You don't have access" to member and contractor (D.md audit rendered as member, finance and contractor); AI cost reaches finance only as totals (`finance.ai_cost_buckets`) |
| 83 | Run full visual QA: spacing, hierarchy, table density, contrast, readable statuses, no clipping/overlap, no giant empty panels. | BUILT | Rendered and read this trace: `/usage`, `/agents/automations`, `/production-readiness`, `/operations?q=`, the other changed screens by sweep; spacing and hierarchy follow the shared primitives. Not a pixel-level contrast audit (no tool run), and "no giant empty panels" was read only on those screens |
| 83 | Run end-to-end regression after redesign so existing working business logic is not broken by UI changes. | BUILT | `tests/workflow-regression.test.ts`, `tests/e2e/realtime-two-sessions.spec.mjs`, the live verifiers. This trace ran tsc, eslint on its files, its own tests (14) plus 380 related tests (all pass); the full suite and the e2e spec were not run |
| 83 | Definition of UI architecture complete | NARRATIVE | Section label of the PDF layout; states no requirement |
| 83 | The Admin Panel architecture is complete when all 71 numbered screens/sub-screens have an implemented route or intentionally grouped tab/drawer, every locked phase artifact is visible, every critical action is permissioned and auditable, and no business-critical configuration or workflow is hidden in an unstructured page. | BUILT | For pages 64 to 80: every screen of this slice has a route in `app/(internal)/nav-config.ts` (SCR-055 to SCR-071 all named, checked by script; the test `tests/admin-nav-config.test.ts` pins the shape); every primary action above names its capability and door and the gaps in audit coverage found by this trace are closed; section 7 maps every configurable item to a screen. The only two baseline ids absent from the nav table are SCR-002 and SCR-004 (outside this slice, traced in TRACE-A) |
| 83 | AgencyOS Enterprise Admin Panel - Complete Screen Architecture | NARRATIVE | Running page footer |
| 83 | Confidential \| Page 83 of 83 | NARRATIVE | Running page footer |
