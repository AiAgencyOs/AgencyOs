# PDF gap audit, slice D: SCR-055 to SCR-071, section 7 (manageability matrix), section 8 (QA checklist)

PDF pages 64-83 of `AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`.
Method: rendered audit on the local stack (Next :3000, local Postgres) with Playwright as owner@local.test. For each route I dumped `main.innerText` plus every button, link, tab, select and input, and looked at screenshots. I also dumped as member, finance and contractor to check role gating, and ran overflow sweeps at 390px and 820px on 28 routes. I did not use the old audits' verdicts. Read-only: nothing was written, no migrations, no source edits.

Counting rule: each content bullet on a screen page counts as one element (Purpose, Header/KPI, Main and sub-screens, Primary actions, Guardrails). The five identical "Implementation checklist" bullets per screen are judged once in the cross-cutting section.

Test data limits (what I could NOT render): the approvals queue is empty, there are no meetings, no import batches, no open alerts, no secondary roles, no campaigns in draft and no agent project assignment. Anything that only appears with such a row is marked UNVERIFIED, with a note on whether the source shows the control.

## Summary

| SCR | Screen | Elements | PRESENT | PARTIAL | MISSING | DECIDED | UNVERIFIED |
|---|---|---|---|---|---|---|---|
| 055 | Expenses & Profitability | 16 | 12 | 4 | 0 | 0 | 0 |
| 056 | GST, Tax & Financial Reports | 17 | 14 | 3 | 0 | 0 | 0 |
| 057 | Communication Center | 15 | 12 | 2 | 0 | 0 | 1 |
| 058 | WhatsApp / Conversations | 16 | 16 | 0 | 0 | 0 | 0 |
| 059 | Templates & Announcements | 15 | 11 | 1 | 3 | 0 | 0 |
| 060 | Delivery Failures, Outbox & Meeting Notes | 15 | 10 | 2 | 0 | 0 | 3 |
| 061 | AI Workforce Dashboard | 17 | 15 | 2 | 0 | 0 | 0 |
| 062 | Agent Registry | 17 | 17 | 0 | 0 | 0 | 0 |
| 063 | Agent Detail & Permissions | 19 | 19 | 0 | 0 | 0 | 0 |
| 064 | Model Routing, Providers & Tools | 17 | 13 | 4 | 0 | 0 | 0 |
| 065 | Agent Runs, Usage, Cost & Automations | 15 | 12 | 2 | 1 | 0 | 0 |
| 066 | Operations Dashboard | 20 | 18 | 1 | 1 | 0 | 0 |
| 067 | System Health, Readiness & Alerts | 15 | 9 | 3 | 0 | 0 | 3 |
| 068 | Approval Center, Policies & Overrides | 15 | 12 | 0 | 0 | 0 | 3 |
| 069 | Security, Roles & Audit Log | 16 | 14 | 1 | 0 | 0 | 1 |
| 070 | Integrations Center & Import | 14 | 9 | 3 | 1 | 0 | 1 |
| 071 | Organization Settings & Business Rules | 26 | 22 | 4 | 0 | 0 | 0 |
| | **Screens total** | **285** | **235** | **32** | **6** | **0** | **12** |
| 7 | Admin Manageability Matrix | 41 | 32 | 4 | 5 | 0 | 0 |
| 8 | UI Implementation & QA Checklist + definition | 20 | 7 | 6 | 1 | 0 | 6 |

No element in this slice is declined by `docs/ui-parity/owner-decisions.md`. Two settled decisions in `AGENCYOS_ADMIN_CONFIGURABILITY_AUDIT.md` section E (expense categories, folder structure) and the retention/export rules are still parked and not declined, so they are MISSING here with the citation.

Two defects turned up that are not PDF bullets:
- `/communication` links a conversation row to `/leads/null` (the "Unknown lead" row, `href` built from a null `leadId`).
- The `/agents` dashboard has two tab links that 404 (`/agents/tools/runs`, `/agents/tools`), and the Model Usage row links to `/agents/models/claude-sonnet-5`, which also 404s because the model is not in `ai.models`.

---

## SCR-055 Expenses & Profitability (p64)
Routes visited: `/finance`, `/finance/expenses` (plus edit disclosure), `/api` links listed. Member and contractor are denied; finance and owner see it. 12 elements PRESENT.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header: "Total expenses / Project margin / Cost categories / Budget vs actual" (p64) | PARTIAL | `/finance/expenses` has one "Total (INR)" tile and no KPI row. Net profit and margin tiles and the expense-category donut live on `/finance`. Budget vs actual is a table further down. | A KPI row on the Expenses screen itself: total, margin, categories, budget consumed. |
| Main: "Project profitability" (p64) | PARTIAL | "By project" table (invoiced, paid, expenses, AI) that says "Not a margin". A margin exists only in "Budget vs actual", and only for projects with a budget. `/finance` says 77% margin, `/finance/tax` shows net 2,700, and Budget vs actual shows -6,600 for the same data (three different nets). | One margin definition, shown per project, reconciled across the three screens. |
| Main: "AI/tooling costs" (p64) | PARTIAL | A single "AI / tooling (recorded runs)" column (₹0.00 · 2 runs). No list or breakdown by agent, model or tool. | A cost list or drill-down from the column into runs. |
| Action: "Attach receipt" (p64) | PARTIAL | "Receipt link (optional)", a pasted URL. No file upload. Upload is out by the link-based file model (REMAINING_GAPS: "file storage ... link-based by decision"). | Upload only if the owner reverses the link-only file model. |

## SCR-056 GST, Tax & Financial Reports (p65)
Routes: `/finance/tax` (owner, finance, member, contractor views). 14 PRESENT.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header: "Report status" (p65) | PARTIAL | No status tile. Lock state shows only in the "Reporting period lock" table, and only after a period is picked. | A status chip in the header (open / locked / exported). |
| Main: "Export history" (p65) | PARTIAL | "No GSTR file has been exported yet" covers GSTR-1 and GSTR-3B only. CSV and PDF downloads are not logged. | Log every export (CSV, PDF, GSTR) with who, when and period. |
| Main: "GST configuration" (p65) | PARTIAL | GSTIN, state, SAC are editable. "Registration type, period basis, filing frequency" reads "Not recorded - the profile carries no such fields". | Add the fields or drop the row. It is stated as not inferred, so low risk. |

Role inconsistency to note: as **finance** the same page shows "0 receipts", all 7 invoices as "Unconfirmed", and a P&L that differs from the owner's (owner: 1 GST + 6 unconfirmed, 3 receipts, Received ₹7,500). The figures change with the role reading them.

## SCR-057 Communication Center (p66)
Routes: `/communication`. Member is allowed, finance and contractor are denied. 12 PRESENT.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Purpose: "across WhatsApp, email, announcements, client updates and internal handoffs" (p66) | PARTIAL | WhatsApp only ("Conversations by Channel: 3 Whatsapp"). Email is not a channel here (invoice email exists on its own). No "client updates" lane. | An email and client-update lane, or a stated decision that the Center is WhatsApp-only. |
| Header: "Unread/failed/pending-template messages" (p66) | PARTIAL | Unread and Failed tiles exist. There is no pending-template count. | A tile for messages waiting on a template. |
| Action: "Assign handoff" (p66) | UNVERIFIED | "Nobody is waiting". The source renders `HandoffForm` for each waiting thread with `lead.assign`, but no paused thread exists to render it. | Not needed; re-check with a paused thread. |
| Defect | bug | The "Unknown lead" conversation row links to `/leads/null`. | Guard null `leadId` (render unlinked or route to the conversation). |

## SCR-058 WhatsApp / Conversations (p67)
Routes: `/leads/<id>` (lead with a thread, tabs Conversation / Deal & requirements). 16 PRESENT, nothing missing. Seen: "window closed - template only" chip, "agent replying" state, Pause agent, per-message delivery state with Retry, internal-note composer, "Send an approved template" composer, client context rail. The project group step is a manual card (`group-setup-card`), so no claim of automatic creation.

## SCR-059 Templates & Announcements (p68)
Routes: `/communication`, `/settings/communication`, `/communication/templates/<id>`, `/communication/campaigns`, campaign detail. 11 PRESENT (registry, detail with send and delivery stats and history, status and language KPIs, archive via status, register template, schedule form, campaign send preview).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main: "Audience/project selection" (p68) | MISSING | Announcement composer has Title, Audience (Internal / Clients) and Body. No project or client picker. `announcements-schema.ts` has `audience` only. | A project or client field on the announcement. |
| Guardrail: "Announcements are recorded against project/client timelines" (p68) | MISSING | Announcements are org-wide rows. Client 360 lists every "clients" announcement, and the project Communication tab only links to `/communication`. Nothing is attached to one project. | Tie each announcement to a project or client and write it to that timeline. |
| Purpose: "project milestone announcements and reusable client update formats" (p68) | MISSING | No milestone-triggered announcement and no reusable announcement format or template (every announcement is typed fresh). | An announcement-template registry, or milestone-driven announcements. |
| Main: "Send preview" (p68) | PARTIAL | Only campaigns have a preview ("Send preview: first 5 of 20"). The announcement composer has Save draft and Schedule, no preview. | A preview step in the announcement composer. |

## SCR-060 Delivery Failures, Outbox & Meeting Notes (p69)
Routes: `/operations`, `/meetings` (empty), meeting detail source only. 10 PRESENT (failed count by reason, retry history "Retried 1 time", outbox list, dead-letter list, meetings-awaiting-notes KPI, Escalate, Retry).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Action: "Requeue dead delivery with reason" (p69) | PARTIAL | Dead-job requeue takes a reason. The failed-delivery "Retry" button has no reason field (only a `messageId` input). | A reason on delivery retry and requeue. |
| Main: "Meeting note upload" (p69) | PARTIAL | Evidence is typed or pasted text (`Typed notes` textarea). No file upload. | A file upload, or keep as recorded. |
| Main: "Extracted decisions/actions/open questions" (p69) | UNVERIFIED | No meeting exists. The source renders Decisions / Open questions sections. | Re-check with a completed meeting. |
| Action: "Attach meeting summary to project memory" (p69) | UNVERIFIED | `AttachMeetingSummaryForm` is in the source, not renderable without a meeting. | Re-check with a meeting. |
| Guardrail: "preserve the uploaded human source and versioned summary" (p69) | UNVERIFIED | Source shows versions and evidence uploader, rendered as `uploaded_by.slice(0,8)` (a raw id fragment, not a name). | Show the name. |

## SCR-061 AI Workforce Dashboard (p70)
Routes: `/agents`. Denied to member, finance and contractor. 15 PRESENT (15 agents, runs, tokens, cost, average time, activity trend, agent status, top agents, recent activity, model usage, Export usage CSV, configured/verified/enabled/would-run shown).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Action: "Open agent/model/tool/run detail" (p70) | PARTIAL | The tab strip links "Task Runs" to `/agents/tools/runs` (404) and "Tools & Integrations" to `/agents/tools` (404). Model Usage row links to `/agents/models/claude-sonnet-5` (404, model not in the registry). Agent and tool detail links work. | Fix the routes or drop the tabs, and hide the model link when the model is not registered. |
| Main: "Automation workflows" (p70) | PARTIAL | Shows the agent-to-agent handoff list (requirement_collector to quality_assurance, "Queued"). No workflow definitions, triggers or runs. `/agents/automations` is the same list. | Workflow definitions and state. |

## SCR-062 Agent Registry (p71)
Routes: `/agents` registry section. All 17 elements PRESENT (enabled, would-run, autonomy, model, caps, validation stamp with person, disabled reason, capability summary, row actions). Admin and Client are not agents, WhatsApp is not an agent: holds (15 agents, none named so).

## SCR-063 Agent Detail & Permissions (p72)
Routes: `/agents/customer_success`. All 19 PRESENT (enable switch, ceilings, allowed work classes, Validate now, per-tool Allow/Deny, project Assign with Withdraw/Reassign, refusals, prompt versions, failures, recent runs). Prompt version shows "unnamed prompt / unversioned" (data, not a gap).

## SCR-064 Model Routing, Providers & Tools (p73)
Routes: `/agents/routing`. Owner only. 13 PRESENT (vault status and Store key, model registry, routing matrix, per-agent override grid, fallback chain per work class).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header: "Provider status / Verified runtime / Model availability / Routing rules / Fallback policy" (p73) | PARTIAL | No KPI row. "0 available" models is in a section sentence; provider status is per-provider lines. | A header KPI row. |
| Main: "Tool permissions" (p73) | PARTIAL | Not on this screen. Per-agent on agent detail and per-tool on `/agents/tools/<tool>`. | A link or panel here. |
| Action: "Verify provider" (p73) | PARTIAL | The Verify provider button is on `/agents` and `/integrations`, not on the routing screen. | Put the control here. |
| Action: "Set model budget/cap" (p73) | PARTIAL | "Provider budgets" caps per provider per month. No per-model cap. | Per-model cap. |

## SCR-065 Agent Runs, Usage, Cost & Automations (p74)
Routes: `/usage`, `/usage/runs`, run detail. 12 PRESENT (run list with agent/status/model/provider/project filters, step trace, cost ledger export, latency, retry/dead-letter link, Replay gate text).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Action: "Cancel long-running work" (p74) | MISSING | No cancel on a run. Only queued-job cancel on `/operations`. | A cancel control on running runs. |
| Main: "Tool calls" (p74) | PARTIAL | Step trace says "No steps recorded". Tool calls appear only on the per-tool page (last 30 days). | Tool calls listed inside the run. |
| Main: "Automation workflows" (p74) | PARTIAL | Same handoff list as SCR-061. | As above. |

## SCR-066 Operations Dashboard (p75)
Routes: `/operations`. Member, finance and contractor are denied. 18 PRESENT (every KPI: dead jobs, stalled, queued over 15m, unpublished, dead events, late approvals, nobody told; scheduler status line, job queue, dead letters, outbox with filter, workflow runs with Inspect chain, requeue with reason).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Action: "Cancel workflow" (p75) | MISSING | Only "Cancel" on a queued job (with reason). Workflow runs have "Inspect chain" only. | Workflow cancel. |
| Action: "Escalate operational failure" (p75) | PARTIAL | "Escalate" exists on failed deliveries only. Not on dead jobs, stalled work or outbox rows. | Escalate on those rows. |

## SCR-067 System Health, Production Readiness & Alerts (p76)
Routes: `/production-readiness`, `/integrations`, `/operations` (alerts), `/settings/communication`. 9 PRESENT (Not ready / Needs verification / Ready counts, integration lifecycle, evidence and "Fix" text per check, configured is not verified).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Action: "Run verification" (p76) | PARTIAL | The readiness page has only "Open integrations" links. Verify buttons live on `/integrations`. | A run-all-checks button. |
| Header: "Last live checks" (p76) | PARTIAL | No aggregate time. Only per-integration text ("never verified with Meta"). | Show last-checked on the readiness page. |
| Main: "Alert destination" (p76) | PARTIAL | Read-only pointer to `ALERT_WEBHOOK_URL` under Keys & secrets. No readiness control to test the destination. | Test-fire control. |
| Action: "Send controlled test message" (p76) | UNVERIFIED | Source has the form, but the page says "Set an internal test recipient to make the controlled first send", so the button is hidden. | Re-check with a recipient set. |
| Action: "Acknowledge alert" (p76) | UNVERIFIED | No open alert ("No alert is waiting on a person"). | Re-check with an alert. |
| Main: "Incident banner" (p76) | UNVERIFIED | Not shown (0 critical open). | Re-check with an alert. |

## SCR-068 Approval Center, Policies & Overrides (p77)
Routes: `/approvals`, `/approvals/<decided id>`, `/settings/approvals`, `/governance/overrides`. 12 PRESENT (Waiting / Past deadline / Decided / Approval rate / Median KPIs, recent decisions, decision detail, policy ladder, configure policy form, override center, record exception with reason, 3 emergency switches).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header: "Approval type, Required role" (p77) | UNVERIFIED | Queue empty. Decided rows show type and the detail shows "Needs: Owner". | Re-check with a pending row. |
| Action: "Approve/reject/request change" (p77) | UNVERIFIED | No pending approval. The source renders Approve / Request changes / Reject with a note. | Re-check with a pending row. |
| Main: "Decision detail" on a pending row (p77) | UNVERIFIED | Only a cancelled row rendered (no decision note or history on it). | Re-check. |

## SCR-069 Security, Roles & Audit Log (p78)
Routes: `/security`, `/security/users`, `/security/incidents`, `/audit`. 14 PRESENT (users and roles KPIs, invariant scan 3/3, permission matrix (read-only), role grant and suspend, access review, incidents open/resolve, audit filters action/subject/actor/date, Before/after, Export CSV).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Guardrail: "Privileged changes must show actor, time, before/after and reason" (p78) | PARTIAL | "Recent privileged changes" lists `membership.department_set` with "by user 9393f17d" (an id fragment), no before/after, no reason, and is filled with department edits. The audit log also names the actor as "user 329c9d4c". | Resolve actor names, show before/after and reason in the privileged list, limit it to real privilege changes. |
| Action: "Grant/revoke role" (p78) | UNVERIFIED | Grant and Suspend render. Revoke of a secondary role is in source (`revokeSecondaryRoleAction`), but no member holds a secondary role to show it. | Re-check with a grant. |

## SCR-070 Integrations Center & Import (p79)
Routes: `/integrations`, `/import` (empty, no batch to open). 9 PRESENT (verified / configured / degraded / not configured / failed / disabled counts, list with Details, Verify configuration, Verify provider, vault link, upload and stage WhatsApp export).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Purpose: "Figma" in the lifecycle (p79) | MISSING | List has Supabase, Cron, WhatsApp, AI provider, Speech to text, Image generation, Alerting, GitHub. Figma has only a `FIGMA_ACCESS_TOKEN` slot on Settings and Keys. | A Figma row with verification. |
| Purpose: "calendar" (p79) | PARTIAL | Google Calendar sits below the list, "not in the lifecycle registry", so it is not in the counts. | Put it in the registry and counts. |
| Header: "Last verified time" (p79) | PARTIAL | No aggregate. Per-row text on WhatsApp only. | A last-verified column or KPI. |
| Action: "Update non-secret identifiers" (p79) | PARTIAL | Only WhatsApp has "Update identifiers". Calendar id says "unset - not editable from the panel". | Identifier forms for the others. |
| Action: "Stage/review/commit import" (p79) | UNVERIFIED | Upload and stage present. Review and commit sit on `/import/<batchId>` and no batch exists. | Re-check with a batch. |

## SCR-071 Organization Settings & Business Rules (p80)
Routes: `/settings`, `/commercial`, `/team`, `/communication`, `/approvals`, `/finance`, `/templates`, `/security/keys`. Owner only, the rest denied. 22 PRESENT (General, agency profile/contact, pricing model, payment terms, third-party charges, limits and offer, group naming, default team, design reviewer, timezone, announcement channels, approval policies, template and outreach caps, vault, history drawers per setting).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header: seven area summaries (p80) | PARTIAL | Seven tabs, General first, no summary tile per area. The page opens on the environment variable list. | A status row per area. |
| Header: "Project defaults" (p80) | PARTIAL | No Project defaults tab. Its items are split across Team (group names, default team, reviewer) and Templates. | A grouped tab. |
| Main: "Project group naming" (p80) | PARTIAL | The pattern "project // price // start date // client" is fixed. You can only add a trailing word. | An editable pattern, or keep as locked. |
| Action: "Preview impact before saving high-risk settings" (p80) | PARTIAL | "Preview impact" is on agency name and timezone only. Pricing, payment terms, limits and outreach caps save without it. | Preview on the other high-risk keys. |

---

## Section 7: Admin Manageability Matrix (pp81-82)
Each configurable item checked for a screen that manages it.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Project Defaults: "Project group naming pattern" (p81) | PARTIAL | Only a trailing word is editable (Settings > Team). | Editable pattern. |
| Project Defaults: "Default phase notifications" (p81) | PARTIAL | "Phase notifications" exist per project (`projects/<id>/settings`). No org-wide default. REMAINING_GAPS row 027 lists "no column or table". | An org default. |
| Project Defaults: "Standard folder structure" (p81) | MISSING | No org-level default. `AGENCYOS_ADMIN_CONFIGURABILITY_AUDIT.md` section E parks it. Per-project folders now exist (owner decision 7). | A default folder set copied to new projects. |
| Communication: "Announcement templates" (p81) | MISSING | No template store for announcements (see SCR-059). | Announcement template registry. |
| Finance: "Invoice numbering/terms" (p82) | MISSING | Number format is a code constant (`INV-2026-0001`). Terms are not configurable, only "Due in (days)" per invoice. Settings > Finance has accounts, reminders and GST only. | Numbering prefix and default terms. |
| Finance: "Milestone rules where user explicitly changes policy" (p82) | PARTIAL | Payment terms are in Commercial. `won_requires_payment_evidence` has no form anywhere (grep: referenced only in a comment), so the won-gate policy cannot be changed from the panel. | A switch for it. |
| Finance: "Expense categories" (p82) | MISSING | Fixed list in code (infrastructure, ai, tooling, vendor, contractor, other). Section E parks it. | Editable categories. |
| Governance: "Audit access" (p82) | PARTIAL | Shown in the permission matrix, which is read-only ("a change is a code review"). | Stated as code-owned, or a control. |
| Governance: "Retention/export rules" (p82) | MISSING | No retention control. Export exists (audit CSV). Section E: no retention policy in any spec. | A retention setting, after a business decision. |

PRESENT (32): agency name and contact, timezone, announcement recipient, team roles and additional roles, default team; all six Commercial items; project templates, design reviewer; WhatsApp identifiers, template mapping, outreach caps, reactivation pilot and caps, alert webhook (Keys & secrets); all six AI Workforce items; GST billing profile, payment accounts, reminder rules; approval ladder, role assignments, override and emergency controls, integration verification.

## Section 8: UI Implementation and QA Checklist (p83)

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| "Implement the left navigation exactly as organized modules" | PRESENT | Grouped sidebar (Sales and CRM, Clients, Projects, Finance, Communications, AI Workforce, Approvals, Operations...). Settings is tabbed, not one page. | - |
| "reusable page header, KPI card, data table, filter bar, drawer, empty state, error state, approval banner and activity timeline" | PARTIAL | `src/ui/primitives` has page-header, stat, table, filter-bar, drawer, empty-state, timeline, stale-data-warning, permission-denied. There is no approval-banner component and no error-state component (one root `error.tsx`). | Add both. |
| "every phase-specific output is visible in Project Overview and the related module" | UNVERIFIED | Outside slice D. | - |
| "Admin can trace: who did what, which version, which approval, which client response, which payment verification and which evidence" | PARTIAL | Audit shows actions with Before/after but the actor is an id fragment and rows link to no record. | Names and links on audit rows. |
| "Map every screen action to a backend capability/permission/event" | UNVERIFIED | Permission matrix lists 26 capabilities. Not tested per action. | - |
| "RLS/tenant isolation and resource-level permission tests" | PRESENT | Tenancy and RLS tests exist in `tests/` (e.g. whatsapp-tenancy, agent-registry-not-tenant-writable). Not run by me. | - |
| "loading/empty/error/permission/stale/integration-failure states for all screens" | PARTIAL | Permission-denied verified as member, finance and contractor. Empty states and degraded-integration states are present. `/governance/overrides` has no `loading.tsx`. Errors are a single root boundary with no per-screen retry. | Loading and error states per screen. |
| "desktop, tablet and mobile responsiveness" | PRESENT | No horizontal page overflow at 390px and 820px on 28 routes of this slice (one route aborted on navigation, `/settings/approvals` at 390px; it passed at 820px). Not a visual-quality review. | - |
| "deep links from notification to source and from activity/audit to exact record/version" | MISSING | Audit rows link nowhere (no anchors inside the rows). Notification rows link out. | Record and version links from audit rows. |
| "cross-module consistency: client totals equal finance records" | PARTIAL | `/finance` Total Received ₹21,000 vs `/finance/payments` Captured ₹9,999.99 vs Payment Status Paid ₹7,000 vs `/finance/tax` Received ₹7,500. Three "net" figures (16,200 / 2,700 / -6,600). | Reconcile the definitions. |
| "payment-gated progression" | UNVERIFIED | Covered by tests (payment-verified, won-gate); not exercised in the UI. | - |
| "Phase 3/4 UI auditability", "Phase 5 traceability", "Master QA defect retest" | UNVERIFIED | Outside slice D (tests `qa-gate`, `release-gates` exist). | - |
| "production readiness: deployment cannot proceed if final payment or hard release gate missing" | PRESENT | Readiness page blocks with "NOT production ready - 5 blocking", release-gate tests exist. | - |
| "manual WhatsApp group setup flow" | PRESENT | Settings and project group card say AgencyOS cannot add people to a WhatsApp group. | - |
| "internal AI provider/model/API and delivery-cost data restricted" | PRESENT | /agents, /usage, /integrations, /settings denied to member, contractor and finance. Expenses and tax limited to finance and owner. | - |
| "full visual QA: spacing, hierarchy, density, contrast, no clipping, no giant empty panels" | PARTIAL | Spot-checked `/finance/expenses` and `/agents` only. The Expenses form has no heading, sits below the tables, and the trend chart is one dot. | Full visual pass. |
| "end-to-end regression after redesign" | PRESENT | `tests/e2e` and `workflow-regression.test.ts` exist. I did not run them. | - |
| Definition of complete: "every critical action is permissioned and auditable, and no business-critical configuration or workflow is hidden in an unstructured page" | PARTIAL | See the section 7 gaps (won-gate switch, invoice numbering, expense categories). | - |

---

## Cross-cutting

- **Filters / saved views / export:** saved views ("Save this view") are present on Expenses, Tax and Payments. The Expenses list has only a text search and two sort links, with no category, project, vendor or date filter. `/approvals` has no search or filter at all.
- **Pagination:** `/audit` shows a fixed "100 most recent" with no paging or older-entries control, though it reports 2,570 entries. `/usage/runs` likewise "latest 100".
- **Audit trail links:** audit rows show actor and subject as id fragments ("user 329c9d4c", "scope_item 299096cc") with no links to the record; the Security "Investigate" link goes to an incident form, not the record.
- **Status chips, drawers, confirmations:** present throughout (Approved/Failed/Disabled chips, Inspect chain drawer, row-actions menus, Before/after disclosures).
- **Realtime indicator:** "Connecting / Updated just now / Refresh" on Communication, Operations, Integrations, Approvals. It read "Connecting" at capture time in all four.
- **Permission-denied:** verified, consistent "You don't have access to this" on every gated route for member, finance and contractor.
- **Loading:** `loading.tsx` inherited by `/settings/*`, `/agents/*` and `/communication/*` from their parent segments. `/governance/overrides` has none.
- **Responsive:** no page-level horizontal overflow on 28 routes at 390 and 820 px.
- **Raw-id leaks:** actor ids in audit and Security, `/leads/null` in Communication, uploader id in meeting evidence.
- **Finance numbers differ by role and by screen** (see SCR-056 and section 8).
