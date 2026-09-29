# AgencyOS Admin Panel — Bucket F implementation plan

Written 2026-09-30 from `AGENCYOS_ADMIN_PDF_ELEMENT_AUDIT.md` (979 PDF
elements: 707 built, 199 partial, 69 missing, 4 declined; 14 shared rules
partial or absent). Bucket F closes every PARTIAL and MISSING row and the
shared-rule gaps, plus five owner decisions taken on 2026-09-30.

> **Delivered 2026-09-30.** All six streams merged on `chore/pre-session-working-tree-snapshot`
> (migrations `20261001100000`–`150002`), verified per §9i of
> `AGENCYOS_ADMIN_TEST_MATRIX.md`. The rows no stream brief covered are
> bucket G (see the test matrix §11).

Owner decisions on record (2026-09-30):

| # | Question | Decision |
|---|---|---|
| F1 | Launch gated on the final payment (SCR-049) | **Gate**: sign-off refuses while the final milestone invoice is unpaid or its claim unverified; owner override with a recorded reason, audited |
| F2 | Secondary roles honoured by permission checks (SCR-069) | **Union everywhere**: `can()` reads primary + secondary roles |
| F3 | Model registry (SCR-064, ADM-84) | **Owner manages models in the panel**: add/retire, fallback chain per work class, per-provider monthly budget |
| F4 | Git writes (SCR-042, reverses 6e) | **Full write**: create task branch, submit review, approve/reject merge — each a governed, audited door |
| F5 | Budget vs actual (SCR-055, row 55) | **Reopen**: budget against expenses + AI cost + time cost, variance, monthly burn |

Conventions are those of every earlier bucket (`AGENT_BRIEF*.md`):
door = schema → service (`requireInternal` + `can` + RLS/RPC, audited) →
server action → form; idempotent migrations with tenancy and freeze
triggers; new files per topic; honest failure states; nothing mocked;
every door driven in a browser with database read-back; docs and the
audit document updated so each row flips to BUILT with a file reference.

Two rules for this bucket, because most rows are PARTIAL:

1. **Where the PDF puts it is where it goes.** A capability that exists
   on a detail page is mounted on the dashboard the PDF names as well,
   through the same door. No second door, no duplicated logic: the panel
   component is shared and takes the context it needs.
2. **A count is a count, not a badge.** Every KPI the PDF lists gets a
   real tile backed by a query, and a click opens the list filtered to
   exactly that KPI.

---

## Stream F-A — Global Control and shell (SCR-001–004, shared rules)

Migration `20261001100000_the_shell_remembers_and_escalates.sql`:
`core.recent_commands` (per user, last 20 palette commands),
`core.create_drafts` (per user, entity kind + jsonb draft, one per kind),
`core.escalations` (subject_type/id, from_user, to_role, reason, state
`open|acknowledged|resolved`, acknowledged_by/at), door
`core.escalate` / `core.acknowledge_escalation` (audited
`escalation.raised|acknowledged`). Notification severity: a derived
`severity` (`critical|action|warning|info`) in the notification-state
reader from the source row (overdue payment → critical, approval due →
action, etc.), no new column.

Code: organization selector in the shell for people with more than one
membership (switches `current_organization_id`, audited); dashboard
Today card gains follow-up reminders; Project health table gains a
health column (the same at-risk rule the projects list uses); Finance
gate queue card (unpaid milestones blocking a phase, claims pending);
quick-actions row (Add lead, Create project, Create invoice, Open
approval); every KPI tile links to its filtered list; acknowledge /
escalate on feed items (door above). Search: results grouped by entity
type, a quick-preview drawer (shared `PreviewDrawer` reading the entity
header), advanced filters (type, owner, status, date), and quotations,
meetings, tasks added to `globalSearch`. Notifications: severity chips,
detail drawer, escalation destination recorded. Palette: in-place forms
for task, quotation and meeting (existing doors), change-request entry,
context pre-fill from the current client/project route, recent commands,
draft saved on close and restored on open.

Shared rules: `FilterBar` gains "Clear all"; `DataTable` gains a
row-actions slot with an overflow menu; approval decisions open in the
drawer on `/approvals`; `app/(internal)/not-found.tsx` and
`global-error.tsx`; `loading.tsx` for `/profile`, `/search`, `/help`;
`EmptyState` action passed on every list page; `StaleDataWarning` wired
to every `LiveRefresh` page; a shared `IntegrationState` callout used by
Integrations, Readiness and every page that reads a provider; breadcrumb
gains the entity level and shows on tablet; header gains a system-status
dot fed by the readiness evaluator; the three hand-rolled tables on
`/agents/routing` and the model registry move to `DataTable`.

Tests: `tests/a-kpi-opens-its-own-list.test.ts` (every Stat tile href
carries the filter its label names), `tests/the-shell-explains-itself.test.ts`
(not-found, global-error, loading boundaries, EmptyState actions).

## Stream F-B — Sales & CRM and Clients (SCR-005–017)

Migration `20261001110000_a_lead_is_scored_by_two_and_a_client_is_edited.sql`:
`crm.leads.score_override` (int), `score_override_reason`,
`score_override_by/at` + door `crm.override_lead_score` (owner/ops_admin,
reason required, audited `lead.score_overridden`); `crm.lead_transitions`
gains qualified → qualifying; requirement payload schema gains
`user_roles[]`, `platforms[]`, `integrations[]`, `timeline_budget_notes`
(jsonb shape only, no DDL); `core.client_accounts` update door
`core.update_client_account` (name, legal name, GSTIN, PAN, billing
address) audited; `crm.meetings.project_id` nullable FK; quotation
`delivery_status` derived from the outbound message's delivery metadata
(reader, no column); follow-up doors `reschedule`, `complete`, `cancel`
on `crm.follow_up_sequences` with reason (audited); renewal/upsell:
`sales.opportunities.kind` gains `renewal|upsell` and a door
`sales.open_renewal(client_account_id, project_id)` that opens a new
opportunity from a completed project (audited).

Code: Sales dashboard gains pipeline value chart (dataviz rules), today
tasks, upcoming meetings, recent activity, add-lead/meeting/follow-up
buttons, filtered export; Leads list gains email search, preview drawer,
bulk next-follow-up; Lead 360 gains deal value in the header, last
contact (from the thread), sequences card, quotation drafting gated on an
accepted requirement version, AI-suggestion vs human-override score view;
Requirements panel renders the four new payload fields and links to the
transcript messages; Meetings gain a project link; Quotations list gains
total value, superseded/expired/project/service filters, delivery status
column; Composer gains quotation number, editable terms, PDF preview
before save; Follow-ups gain overdue/upcoming/failed tiles, client and
project context, the three new doors; Clients list gains completed and
pending counts and revenue (paid, not invoiced) and an edit door; Client
360 gains a Settings tab (owner, tags, billing edit, assigned team as a
multi-select of members), schedule meeting, file upload (storage door
from bucket E scoped to the client), create project through the manual
door with the client pre-filled, per-status project breakdown, milestone
schedule, change-request charges with amounts, renewal/upsell button;
Client communication gains recent uploads.

Tests: `tests/a-score-has-two-authors.test.ts`,
`tests/a-client-is-edited-by-a-door.test.ts`.

## Stream F-C — Projects, Requirements & Scope (SCR-018–031)

Migration `20261001120000_a_project_has_a_phase_a_team_and_an_archive.sql`:
`projects.projects.archived_at/archived_by` + door `archive_project`
(completed only, audited); `projects.project_members` (project_id,
user_id, project_role text, added_by) + doors add/remove/set role
(PM/owner, audited) — the Board's assignee lists read from it;
`projects.project_links` (label, url, kind) + doors; `projects.project_updates`
(body, sent_to `client|internal`, sent_by, message_id) + door
`send_project_update` through the client thread chokepoint;
`projects.milestones.tasks` link is already `tasks.milestone_id` — reader
only; `projects.requirement_clarifications` reuse (bucket C) from the
requirements dashboard; change-request `invoice_id` + door
`invoice_change_request` (raises a milestone-less invoice through the
existing finance door) and `apply` gated on that invoice's payment when
the CR is billable; scope summary export route; `scope_versions.approved_by/approval_evidence_url`.

Code: Projects list gains blocked count, lifecycle-phase distribution and
filter, health filter, archive action; Project 360 gains links panel,
upcoming events (meetings + milestones), send update, create meeting and
file in place; Board gains phase filter and typed evidence links
(`screenshot|log|url|file`); Calendar gains create-milestone in place and
an ICS feed URL per project (the "sync" the PDF can honestly offer without
OAuth: a signed `/api/projects/[id]/calendar.ics`); Plan gains pending
count, a milestone picker with detail panel and its task list, open-tasks
link; Files gain total storage, a folder tree, preview drawer (images,
PDFs via signed URL), rename/move for stored files, internal share
(member list) beside the public link; Team gains presence (last seen from
`auth` sessions if readable, else "last active" from audit), per-project
members and roles; Reports gain a project health panel, PDF export
(existing PDF lib), links from each risk/task/event; Settings gains
template selection and template detail; Requirements dashboard gains
recent changes, clarification and change-request doors, scope export;
Scope gains approval evidence; Change requests gain paid/in-progress
counts, own invoice, send quotation, trigger finance, payment-gated apply.

Tests: `tests/a-project-has-members-and-an-archive.test.ts`,
`tests/a-change-request-is-paid-before-it-is-applied.test.ts`.

## Stream F-D — Design & Prototype, Development (SCR-032–043) + F4

Migration `20261001130000_a_design_has_activity_assets_have_states_and_git_is_written.sql`:
`design.activity` view over audit rows for design subjects;
`design.theme_directions` / `color_variants` recorded by a person (2–3
each, with source `generated|recorded`); `screens.role`, `device_targets[]`,
`components[]`, `responsive_coverage` jsonb, state edits door;
`design_assets.status` (`draft|approved`), `version`, `parent_asset_id`,
doors upload/replace/mark-approved (storage bucket from E);
`prototype_artifacts.platform`, `submit_to_qa` door; `projects.plan_layers`
(frontend, backend, database, apis, integrations, auth, business_logic
per deliverable) and `execution_order`; task doors `start`, `ready_for_qa`,
`submit_evidence`, `reopen_from_defect(defect_id)` on the task page;
`projects.commit_links` (task_id, sha, url); `projects.repository_checks`
(read from GitHub check runs, not stored — reader only); GitHub write
doors: `create_task_branch` (branch `task/<id>-<slug>` from default),
`submit_review` (approve/request changes/comment on a PR),
`merge_pull_request` (owner/PM, squash, refuses on red checks), each
recording a `projects.git_actions` row (audited `git.branch_created`,
`git.review_submitted`, `git.merged`); env `GITHUB_TOKEN` needs `repo`
scope — the Integrations row says which scopes the token has;
`projects.environments` gains `readiness` jsonb (api_contract, migrations,
external_config booleans with evidence url) and doors `record_check`,
`promote_build(environment_id)` gated on release gates.

Code per the audit rows for 032–043: approved counts, versions list,
activity feed, upload design (storage), submit-for-review on the
overview, colour KPI and reference uploads, generate/record directions,
screen filters and grouping and responsive coverage, screen detail
fields, prototype platform/revisions/evidence/feedback/submit-to-QA,
asset lifecycle, development dashboard commits and escalation record and
handoff gate, plan layers and execution order and DoD, task-page doors,
repository failed checks and review findings (read) and the three write
doors, builds page environment matrix, contract/migration checks, trigger
build (record + GitHub Actions dispatch when a workflow is linked),
promote build.

Tests: `tests/git-is-written-by-a-door.test.ts` (every GitHub write goes
through `src/lib/git/github-write.ts`, refuses without token scope, audits),
`tests/an-asset-has-a-state.test.ts`.

## Stream F-E — QA & Release, Finance, Communication (SCR-044–061) + F1, F5

Migration `20261001140000_a_release_is_paid_for_and_a_run_has_a_life.sql`:
`qa.test_runs.status` (`open|closed`), `started_at/ended_at`, `blocked`
count, `rerun_of`, defects gain `run_id`; `qa.retest_assignments`
(defect_id, retester_id); `qa.performance_budgets` (project, metric,
target, unit) and `qa.metric_results` (run_id, metric, value);
`qa.stability_incidents` (project, severity, opened/resolved, summary);
`qa.suite_schedules` (suite, cron, last_run_id) run by the cron tick;
baseline comparison = reader over two runs; release: `deployment_dependencies`
jsonb on the release candidate, security/performance summary readers,
**payment gate** — `projects.sign_off_release` refuses unless the final
milestone invoice is paid or its claim verified, with
`release_payment_overrides` (owner, reason, audited `release.payment_overridden`);
finance: invoice list tiles (draft, issued) and GST/milestone filters,
milestone column, reminder history drawer, email send through a real
transport if `RESEND_API_KEY`/SMTP is configured else honest
not-configured, proof attach on the invoice, unmatched tile, record-proof
and reject on Payments, vendor/tool rollup, **budget vs actual**
(`computeBudgetVariance` pure; monthly burn from expenses + AI cost + time
cost), GST export history table (`finance.gst_exports`), PDF tax report;
communication: unread count, announcements `scheduled_for` + scheduler in
the tick, create announcement on the dashboard, template detail page,
project audience for campaigns, rendered send preview, schedule time for
campaigns, retry-count tile, requeue with reason, escalate a failed
delivery (F-A's escalation door); QA dashboard recent runs, bug trend
(dataviz), RC version, links to run/bug/build, assign retest, block
release from `/qa`, evidence summary org-wide.

Tests: `tests/a-release-is-paid-for.test.ts`,
`tests/a-run-opens-and-closes.test.ts`, `tests/finance-budget-variance.test.ts`.

## Stream F-F — AI Workforce, Operations, Governance, Settings (SCR-062–071) + F2, F3

Migration `20261001150000_a_model_is_managed_a_role_is_honoured_and_an_alert_is_acknowledged.sql`:
`ai.models` write doors `add_model`, `retire_model` (owner, audited),
`ai.fallback_chains` (work_class, ordered model ids), `ai.provider_budgets`
(provider, monthly_cap_minor, spent view) enforced by the runner before a
call; `ai.agents.allowed_work_classes[]` rendered and editable by the
owner; `ai.agent_runs.latency_ms` KPI readers; run replay door
`replay_run` only for `safe` work classes (read-only tools), audited;
cancel a running job (`cancel_running_job` sets a cancel flag the runner
honours between steps); row-level cost ledger export;
`core.alerts` (source, severity, summary, acknowledged_by/at, reason) +
`acknowledge_alert` door + a cross-app incident banner fed by unacknowledged
critical alerts; `core.overrides` (subject, kind, reason, actor, expires)
as the override centre, with the existing domain overrides writing rows
into it; emergency controls: `core.kill_switches` (agents_paused,
outbound_paused, jobs_paused) owner-only with reason, honoured by the
runner and the send chokepoint; `security.incidents` (kind, severity,
opened/resolved, evidence, actor) + doors; access review: `security.access_reviews`
(reviewer, membership, decision, at); **F2**: `can()` becomes
`canEffective(context)` everywhere via one change in `requireInternal`
that loads secondary roles into the context (the union), with the
permissions test asserting no direct primary-only check remains;
settings: security/integrations shortcuts, vault link, per-setting
history drawer from audit rows, preview-impact step for high-risk
settings (shows what the change would affect: counts of affected rows,
computed by the same readers).

Tests: `tests/a-role-union-is-honoured.test.ts`,
`tests/a-model-is-managed-by-the-owner.test.ts`,
`tests/an-alert-is-acknowledged-by-a-person.test.ts`.

---

## Order, streams and verification

Six worktree streams in parallel (F-A … F-F), one migration timestamp
each (`20261001100000` … `150000`), merged in the order F-A, F-F, F-B,
F-C, F-E, F-D so the shell and permission changes land first and the
Git-write stream (largest) last. Each stream flips its rows in
`AGENCYOS_ADMIN_PDF_ELEMENT_AUDIT.md` to BUILT with a file reference as
it goes, so the audit document is the live checklist.

After the merge, as before: apply migrations locally and re-apply for
idempotence, restart PostgREST, typecheck, lint, guards, full suite on
Node 26 (0 failures is the baseline now), browser drive with read-back
for every new door, role sweep (member sees no cost, no owner-only
control), phone sweep, docs (test matrix §9i, gaps doc, inventory, the
audit totals), one commit, push to the PR branch, CI green on both
workflows.

Size: roughly 270 audit rows across six streams, six migrations, about
25 new doors, four new shared primitives. The realtime workflow's
two-session run must stay green throughout; each stream reruns it
locally with Docker where available, CI otherwise.

## What I do not need from you

Nothing. Two environment notes: F4 needs a `GITHUB_TOKEN` with `repo`
scope in production for the write doors (the Integrations row will say
whether the token has it), and the invoice email send needs an email
provider key (`RESEND_API_KEY` or SMTP) or it stays an honest
not-configured state.
