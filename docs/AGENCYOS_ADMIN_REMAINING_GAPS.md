# AgencyOS Admin Panel — what the PDF still asks for (as of 2026-09-29, after gap pass 8)

Source: `AgencyOS_Enterprise_Admin_Panel_Complete_Screen_Architecture.pdf`
§6 per-screen requirements, walked element by element against the code
(gap matrix, forty feasible items ranked; passes 1–8 closed the finance,
projects, sales, requirements, governance and operations rows). Every
reference image has a built counterpart (`AGENCYOS_UI_SOURCE_AUDIT.md` §4a);
what follows is the *element-level* remainder, per screen, in three
buckets:

- **A — feasible now** (data exists; UI or a governed door is missing).
- **B — needs new schema** (a table or column the product does not have;
  a product decision, then a migration, then a door).
- **C — declined on record** (the reason is in the inventory / traceability).

Legend: SCR ids are the permanent ones in
`AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md`.

## Global Control

| SCR | A — feasible now | B — needs new schema | C — declined |
|---|---|---|---|
| 001 Command Center | Global date-range selector (every reader is a fixed 30/90-day window); "Generate report" export | Widget layout preferences | — |
| 002 Global Search | Type and date filters; copy reference/ID; a `/search` results page (palette only today); quick-preview drawer | Recent / saved searches | — |
| 003 Notifications | "Escalate to owner" link per row | Snooze, resolve, assign, batch mark-read, action history (no notification-state table) | — |
| 004 Quick Create | Manual "Create project" (only the won-deal conversion exists); "Create invoice" from an eligible milestone in the palette; "Schedule meeting" as a form rather than a jump | — | — |

## Sales & CRM

| SCR | A | B | C |
|---|---|---|---|
| 005 Sales funnel | Source / owner filters on the funnel (window is done) | Deal-value forecasting, discount impact, lead-source ROI (nothing records enough to average) | — |
| 006 Leads list | Bulk actions (multi-select assign / status / tag); service, budget and date filters | — | — |
| 007 Lead 360 | Qualification-coverage view (`crm.qualification_coverage` is read only by onboarding); disqualification-reason history from `lead_activities` | — | Numeric lead score (ADM-88) |
| 009 Requirements discovery | Open-questions and client-confirmed-vs-proposed KPIs; edit a draft version; source-transcript references per version | — | — |
| 010 Meetings | Month calendar view (list only) | — | — |
| 011 Quotations list | Version-history drawer; client filter | — | — |
| 012 Composer | Project type / duration fields; sales owner (`opportunities.owner_id`); GST vs non-GST toggle wired to the project's confirmed mode | — | — |
| 013 Follow-ups | Channel / owner filters; sequence detail drawer (drafted body, situation, escalation); template ↔ situation mapping view; link to the reactivation cohort | Cancel a sequence (stop/resume exist; "cancel" would need a distinct terminal state) | — |

## Clients

| SCR | A | B | C |
|---|---|---|---|
| 014 Client management | Preview drawer (pending invoices, recent communication, next follow-up) | Tags and relationship owner (`client_accounts` has neither column) | — |
| 015 Client 360 | Tabbed layout (single scroll today); next-follow-up KPI; Create project / quote / invoice buttons | — | — |
| 016 Commercials | Commercial timeline; "generate invoice from approved milestone" from the client page (button lives on the project) | — | — |
| 017 Communication & files | Unread-client-replies KPI; meeting notes / decisions per client; send a permitted message from the client page; attach a meeting summary to project memory (`ai.memory_records`) | Announcements (no table); file upload / download (link model) | — |

## Projects

| SCR | A | B | C |
|---|---|---|---|
| 018 All projects | Client / owner filter | Pause / resume / cancel *reason* (no column; `ProjectStatusForm` has no reason field) | — |
| 020 Board | Task counts per assignee / module on the board itself | Comments, subtasks, checklists, attachments, blocker fields, time logs | — |
| 021 My tasks | Waiting-for-review / blocked / due-today KPIs; list and calendar modes; task drawer; reassign | Checklist items | — |
| 022 Calendar | Week / day / list modes; type toggles; create task / milestone / meeting from a day | — | — |
| 023 Milestones | Explicit "mark work milestone complete" (today only via gate / deliverable); "trigger finance milestone" from the plan page | — | — |
| 024 Files | Preview drawer | Upload, versions, trash, internal share, secure handover links (no storage tables) | — |
| 025 Team | Assign / remove members and set project role through `group_team_defaults` on this page (forms exist on Settings › Team); recent team activity; permission summary | "Active now" presence | — |
| 026 Reports | Completion trend (`tasks.completed_at`); date range; PDF/CSV export | — | — |
| 027 Settings & activity | Default assignees; phase notifications; activity-count KPI; audit events per project | — | Project templates / clone (traceability row 27) |

## Requirements & Scope

| SCR | A | B | C |
|---|---|---|---|
| 028 Requirements dashboard | Projects-with-open-questions and awaiting-client-confirmation KPIs; scope-drift alerts | — | — |
| 029 Requirement set | Coverage percentage (scope items ↔ screens ↔ test-plan items); objectives / business rules / NFR sections; questions list; edit draft; links to quotation / design / task | — | — |
| 030 Scope versions | Freeze checklist; revision allowance on the page; linked quote version; drift detection; unfreeze override | — | — |
| 031 Change requests | Payment-gate view (proposal → invoice status); linked tasks via the resulting scope version; "send quotation from CR" | — | — |

## Design & Prototype

| SCR | A | B | C |
|---|---|---|---|
| 032 Design dashboard | Add screen by hand; upload design (link); submit for review from the overview | — | — |
| 034 Screen inventory | Add / merge / split screen; mark design state; export inventory | — | — |
| 035 Screen detail | Attach Figma frame; add state; map requirement; submit for QA (actions) | — | — |
| 036 Design review | Queue across projects with awaiting-internal / admin / client KPIs; before/after preview of a revision | Comment threads (single-text reviews) | — |
| 037 Prototype | Admin confirm / edit inline (decision is on `/approvals`) | — | — |
| 038 Assets & brand kit | Asset folders with approved-vs-draft; link asset to screen / version; export handoff package | Upload / replace asset versions | — |

## Development

| SCR | A | B | C |
|---|---|---|---|
| 039 Development dashboard | Dependencies / blockers panel; escalate blocker to PM; "start QA handoff" | — | Recent commits (link model) |
| 040 Implementation plan | Create modules / features / tasks from the plan in one click; coverage-of-approved-scope KPI; plan versions list | Acceptance criteria / Definition of Done per deliverable | — |
| 041 Task execution | Task detail surface (scope, acceptance, dependencies, evidence); request clarification from a task | Checklists, implementation notes, test evidence, artifacts, comments | — |
| 042 Repository | — | Branch detail, commit history, PR review, merge approval | Live Git integration (owner-confirmed link model) |
| 043 Builds & environments | Latest build / env readiness / dependency-blocker KPIs; mark dependency supplied | Environment matrix, API contracts, DB migrations, contract checks | — |

## QA & Release

| SCR | A | B | C |
|---|---|---|---|
| 044 QA dashboard | Coverage matrix (category × project); retest queue (`fixed` awaiting verify); assign retest / block release / QA evidence summary actions | — | — |
| 045 Test plan & cases | Planned / executed / pass / fail per category; plan versions per baseline; import cases | Approve plan (no status column); preconditions / steps / expected result per case | — |
| 046 Test runs | Tester and timing on the row; create defect from a run; rerun failed / close run | Per-case results, screenshots, retest history | — |
| 047 Defects | Awaiting-developer / awaiting-retest / reopened KPIs; linked task; fix / retest history from audit | — | — |
| 048 Regression & performance | Regression pass-rate KPI | Compatibility matrix, performance budgets, stability incidents, scheduled suites | — |
| 049 Release candidate | (Release gate page is built) rollback / smoke checklist display | Rollback plan and smoke checklist records | — |

## Finance

| SCR | A | B | C |
|---|---|---|---|
| 050 Finance overview | Collection-rate tile; date / client / project filters; record a payment submission from here; report export | — | — |
| 051 Invoices | Client / project filters; create from an eligible milestone here | Invoice PDF (a renderer, like the quotation's); send / reminder records | — |
| 053 Payments | Submitted / pending / verified / rejected KPIs; payment drawer with proof; reconciliation UI | Reconciliation service over the existing `finance.reconciliations` tables (tables exist, no code) | — |
| 054 Verification | Pending KPI; evidence preview; decision history (settled claims) | — | — |
| 055 Expenses | AI / tooling cost join; trend; export | Attach receipt (no column) | Margin / budget-vs-actual (accounting decision, row 55) |
| 056 GST & tax | — | Lock a reporting period; export history; GST return (portal integration) | — |

## Communication

| SCR | A | B | C |
|---|---|---|---|
| 057 Communication center | Templates panel here; retry an eligible delivery; assign handoff; internal escalation queue | Announcements | — |
| 058 WhatsApp | 24-hour window indicator in the thread header; agent / human state chip; project-group conversation in the same pane | — | Template picker in the composer (a person-initiated template send is a governed act with no door yet — pass 8) |
| 059 Templates | Categories / languages KPI; template version history (`whatsapp_template_versions` exists) | Broadcast (row 59) | — |
| 060 Delivery failures | Failed-by-code KPI; retry history per message; meetings-awaiting-notes KPI; extracted decisions / actions / open questions | — | Outbox row list (only the dispatcher may read `core.outbox_events` — D17; counts are shown) |

## AI Workforce

| SCR | A | B | C |
|---|---|---|---|
| 061 AI dashboard | Average task time; model-usage breakdown; automation panel; usage export | — | — |
| 062 Registry | Autonomy / caps columns in the table; "validate configuration" action; capability summary | Validation evidence | Enable / disable (ADM-82) |
| 063 Agent detail | Failures list; config / prompt version; guardrails text | Tool permissions, project assignments, override records | Adjust caps (`ai.agents` not tenant-writable, 20260815380000) |
| 064 Routing & providers | Provider vault status list; `ai.models` registry page; routing matrix by agent; revoke key; model budgets | — | — |
| 065 Runs & automations | Retry / dead-letter linkage by correlation id | — | — |

## Operations, Governance, Integrations, Settings

| SCR | A | B | C |
|---|---|---|---|
| 066 Operations | Workflow runs by correlation; inspect an event chain; cancel a workflow | — | Outbox list (D17) |
| 067 System health | One "run verification" button per integration on `/integrations` | Acknowledge alert (`core.alert_state` is the alerter's dedupe record; what an ack silences is a product decision) | — |
| 068 Approvals | Filters by type / required role; policy-ladder visual; escalation | Override records | — |
| 069 Security & audit | Users / roles / audit count KPIs; recent privileged changes; rendered permission matrix | Security incident history | — |
| 070 Integrations | Lifecycle-state KPIs; detail drawer; verify from this page; non-secret identifiers here; vault link | — | — |
| 071 Settings | — | — | — (complete: six tabs) |

## Reading the remainder

- **Bucket A** is UI and governed doors over data the schema already holds
  — about seventy elements across 45 screens, none of them a whole screen.
  The largest coherent pieces are: client 360 tabs, my-tasks modes and
  drawer, the QA retest queue and per-run defect creation, the design
  review queue, the `ai.models` / vault status page, and a `/search`
  results page.
- **Bucket B** needs a product decision and a migration before any UI
  would be honest: task collaboration (comments, checklists,
  attachments), file storage, notification state, invoice PDF and
  reminders, reconciliation, per-case test results, announcements,
  agent tool permissions.
- **Bucket C** is settled and should not be reopened without the owner:
  lead scoring (ADM-88), agent enable / caps (ADM-82, not tenant-writable),
  project templates, live Git, the outbox list (D17), template sends from
  the composer, margin arithmetic.
