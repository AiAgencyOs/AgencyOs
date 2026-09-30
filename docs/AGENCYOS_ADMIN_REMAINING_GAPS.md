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

## Status after the bucket A build (2026-09-29, night)

Bucket A was built in four streams and merged (typecheck, lint and the
guard tests green; 92 of 93 swept routes 200). Every row above marked A
is now on the branch **except** the following, each left for the reason
given — they belong to bucket B or C after inspection:

| SCR | Element | Why it stays open |
|---|---|---|
| 006 | Service filter on the leads list | `crm.leads` has no service column. |
| 009 | Edit a requirement draft | `requirement_versions` has no draft state and a trigger makes rows append-only except `status`. |
| 017 | Attach a meeting summary to project memory | `ai.memory_records` is written only by the sales handoff handlers; no person-facing door. |
| 017 | Send a permitted message from the client page | Sending lives on the lead thread and the project group; a third composer would bypass the window rule's context. |
| 022 | Create a milestone or meeting from a calendar day | A plan must total 100 %; meetings are booked from a lead. |
| 027 | Default assignees, phase notifications | No column or table. |
| 030 | Unfreeze override | The `scope_versions` trigger lets a frozen version only become superseded. |
| 032/034/035 | Add, merge, split screen; mark design state; attach Figma; map requirement; submit for QA | `projects.screens` and `screen_scope_items` are SELECT-only for staff with no RPC door; no Figma URL column; no QA transition. |
| 038 | Link an asset to a screen or version | No join table. |
| 043 | Mark dependency supplied | `projects.dependencies` has no status; `plan_dependencies` refuses writes once the plan is active. |
| 044 | Block release | `release-queries.ts` is read-only; stays a link to production readiness. |
| 047 | Linked task on a defect | `qa.defects` has no task column. |
| 053 | Reconciliation UI | `finance.reconciliations` has no service door. |
| 057 | Retry a failed client delivery | Failures are stamped on the message with no job id to requeue. |
| 060 | Retry history per message | `conversation_messages` carries no correlation or job id. |
| 062 | Validate agent configuration | The only writer of `last_validated_at` is the service-role cron tick. |
| 064 | Revoke a provider key; routing grid by agent | `vault.ts` has no revoke; the schema binds no agent to a category. |
| 066 | Cancel a workflow | No cancel door in observability or the orchestrator. |

Buckets B and C are unchanged: B needs a product decision and a migration
(task collaboration, file storage, notification state, invoice PDF and
reminders, reconciliation service, per-case test results, announcements,
client tags and owner, agent tool permissions, GST period lock, expense
receipts, pause and cancel reasons); C is settled (lead scoring, agent
enable and caps, project templates, live Git, the outbox list, template
sends from the composer, margin arithmetic).

## Status after the bucket B build (2026-09-29, late)

Bucket B was built as four migrations with their doors and screens
(`20260929140000` task collaboration and status reasons, `20260929150000`
notification state, client tags/owner, saved searches, announcements,
`20260929160000` invoice sends, period locks, receipts, reconciliation
doors and the invoice PDF, `20260929170000` test cases and per-case
results, compatibility columns, release rollback/smoke, agent policy
tables). Each applied idempotently on the local database and was driven
in the browser (test matrix §9e).

What still stays open, and why:

| Item | Why |
|---|---|
| File storage, versions, trash, share links | The product's file model is link-based by decision (SCR-024); storage would be a platform choice, not a screen. |
| Invoice reminders that actually send | Recording exists; a WhatsApp document send for invoices is a governed door nobody has specified (the quotation one is agent-driven). |
| Bank import for reconciliation | Statement lines are typed in; no import format was decided. |
| Runner enforcement of agent tool permissions / assignments | The rows are a policy record; the orchestrator does not read them yet — stated on the page. |
| Time logs on tasks | No table; the PDF names it but no rule for what a log is worth. |
| Everything in bucket C | Settled decisions (ADM-82, ADM-88, D17, templates, live Git, composer template sends, margin arithmetic). |

## Status after the element pass (2026-09-29, night, final)

The eighteen elements the bucket A table left open are built, each with
its migration, door and screen (`20260929180000` lead service, revise a
requirement as a new version, attach a meeting summary to project
memory, send from the client page, propose a meeting from a calendar
day, retry a failed delivery with history; `20260929190000` default
assignee and project watchers with phase-change notifications, owner-only
unfreeze with reason, dependency supplied / waived, release hold as a
hard gate the sign-off door honours, defect ↔ task link;
`20260929200000` screens written by a person — add, merge, split, design
state, Figma link, requirement mapping, submit for QA — and asset links
to screens and UI versions; `20260929210000` person-run agent validation
recorded in its own table, provider key revocation, per-agent routing
overrides the runner consults first, cancel a queued job with a reason).

What remains needs an answer from the owner (asked one at a time):

1. Send invoices and reminders over WhatsApp through the governed door.
2. Bank statement import format for reconciliation.
3. Runner enforcement of agent tool permissions and project assignments.
4. Time logs on tasks — what a log is worth.
5. File storage (versions, trash, share links) versus the link model.
6. Reopening any bucket C decision: lead scoring (ADM-88), agent enable
   and cap edits (ADM-82), project templates, live Git, the outbox row
   list (D17), template sends from the composer, margin arithmetic.

## Status after the bucket D build (2026-09-30, owner decisions applied)

The owner answered the six questions above, one at a time, on
2026-09-29; every answer is built, applied to the local database, driven
in the browser with read-back, and audited. Nothing on this list remains
open except the two-session realtime run that needs Docker.

| # | Owner decision | Built as | Migration |
|---|---|---|---|
| 1 | Invoices go over WhatsApp through the governed door; reminders go automatically once past due | `sendInvoiceWhatsApp` (thread picker, text via `sendClientMessage`, PDF via `sendClientDocument`, recorded only after the text went); reminder policy on Settings › Finance (org columns `invoice_reminders_enabled`, `invoice_reminder_interval_days`); the cron tick observes past-due invoices, claims a reminder row (`automatic = true`) and sends through `followup.queued` so the 24-hour window and templates decide; "Reminders" section on the invoice | `20260930100000` |
| 2 | Bank statement as CSV (date, description, amount, reference); the panel proposes matches | `parseBankCsv` + `proposeMatches` (pure, 18 tests); `finance.bank_statement_lines`; Import statement, Confirm match (writes the reconciliation item), Set aside with reason — on the Payments › Reconciliation card | `20260930100000` |
| 3 | The runner enforces tool permissions and project assignments | `decideToolCall` / `decideProjectAction` (pure, deny by default); `dispatchToolUnderPolicy` before every tool; `openRun` refuses an unassigned project; refusals in `ai.agent_policy_refusals` (audited) and a "Refusals" card on the agent page | `20260930120000` |
| 4 | Time logs: manual hours per task with date and note; totals per task, project, person; no billing effect | `projects.time_logs` (own-row RLS), three `security_invoker` total views, "Log time" on the task drawer and task page, "Time" card + CSV on the project report | `20260930110000` |
| 5 | Files in Supabase Storage with versions, trash and signed share links | `project_files` gains object columns and version chains; `project_file_shares` + public `/api/files/share/[token]`; storage probed honestly ("Storage is not reachable" on the local stack, uploads refused) | `20260930110000` |
| 6a | ADM-82 reopened: owner enables/disables an agent and edits its caps from the panel | `ai.set_agent_status` / `ai.set_agent_caps` (SECURITY DEFINER, owner-only, audited); forms on the agent page; non-owners read-only with the reason | `20260930120000` |
| 6b | ADM-88 reopened: numeric lead score | `scoreLead` (pure, weights sum to 100, every score carries reasons and inputs); CHECK `leads_score_carries_its_reasons`; `crm.set_lead_score` door; Score column on Leads, Lead score card with reasons on Lead 360, Rescore / Rescore all; guard test rewritten to assert the new rule | `20260930120000` |
| 6c | Project templates | `createProjectTemplateFromProject` / `createProjectFromTemplate` / `deleteProjectTemplate`; "Save as template" on Project 360, "Start from" in ⌘K Create project, Settings › Templates | `20260930110000` |
| 6d | Margin on the project report | paid − (expenses + AI cost), stated as a cash-basis estimate; time is not costed because no cost rate exists in the schema (said on screen and in the CSV) | — |
| 6e | Live Git (GitHub, read-only) | `projects.repository_links` + `link_repository` / `unlink_repository`; `src/lib/git/github.ts` never throws (not_configured / unauthorized / not_found / rate_limited / timeout); commits, open PRs and branch count on the Repository tab; "GitHub (read-only)" row on Integrations | `20260930130000` |
| 6f | Outbox row list on Operations (D17) | `listOutboxEvents` in `src/lib/observability/queries.ts` — the one reader the rewritten `outbox-transactional` guard allows; status filter and pagination; read-only because no retry RPC exists for outbox rows | — |
| 6g | Template sends from the Lead 360 composer | picker over approved + active templates; `sendTemplateMessage` through `send_outbound_message` → provider → `mark_outbound_delivery`; fails honestly when WhatsApp is not configured | — |

Deviations stated on the screens rather than hidden: `outbox_events` has
no `status`, `last_error` or `next_attempt_at` columns, so status is
derived and the other two are not shown; a reminder whose client has no
WhatsApp thread of its own and whose project has no group is recorded as
withheld with that sentence; rescore-all is a bounded on-demand action
(300 leads, oldest score first), not a cron kind.

## Status after the bucket E build (2026-09-30, second round of owner decisions)

| # | Owner decision | Built as | Migration |
|---|---|---|---|
| E1 | Broadcast reopened as a governed campaign | `crm.campaigns` / `campaign_recipients`; four-eyes approval (approver ≠ creator); audience expanded at approval by the same pure function the preview uses; cron worker claims 25 per tick and sends each recipient through the shared template door, so consent, the 24-hour window and the outreach allowance decide each one; closed set of refusal reasons; `/communication/campaigns` list, new-campaign form with live recipient count, detail with per-recipient outcomes | `20260930140000` |
| E2 | Time costed at a per-person hourly rate | `core.member_cost_rates` (append-only, owner-set, ops_admin may read); `projects.time_log_costs` prices each log at the rate in force on its day; margin = paid − (expenses + AI cost + time cost); uncosted hours reported, never zeroed; cost visible only behind `invoice.read` | `20260930170000` |
| E3 | Profile / Preferences and Help | `core.user_preferences` (own-row RLS, follows the person across tenants), `/profile`, timezone preference drives the display clock; `/help` generated from the inventory (71 entries, guarded), header "?" resolves the route | `20260930150000` |
| E4 | Two-session realtime test as a script and CI job | `tests/e2e/realtime-two-sessions.spec.mjs` + `.github/workflows/realtime.yml` (also runs the eight fixture-dependent verifiers on a fresh database); Leads and Payment verification pages now carry `LiveRefresh` so the push can be observed there | — |
| E5 | GSTR-1 / GSTR-3B exports | pure `gstr.ts` with pinned top-level keys and spec version; agency GST identity (GSTIN, state code, default SAC) set by the owner; per-profile state code derived from the state name, never guessed; unresolved invoices listed on screen and left out of the file | `20260930160000` |

Every screen the PDF numbers exists and every owner decision is built.
That sentence used to continue "nothing from the PDF remains unbuilt";
an element-by-element audit on 2026-09-30 (`AGENCYOS_ADMIN_PDF_ELEMENT_AUDIT.md`)
showed it was not true at the level of individual KPIs, buttons and
sub-panels: of 979 elements the PDF lists, 707 were built, 199 partial,
69 missing, 4 declined. Buckets F and G (2026-09-30) closed every one of
those rows — the audit document now reads 979 built, and the four
declined elements were reopened by owner decisions and built. The
audit document stays as the element-level record beside the inventory's
screen-level statuses.
