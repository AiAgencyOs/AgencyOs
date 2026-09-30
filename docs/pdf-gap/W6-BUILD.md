# W6 build report: AI workforce, operations, governance, integrations, settings, shared components

Rows come from `docs/pdf-gap/D.md` (SCR-061 to SCR-071, section 7, section 8). Migration prefix `20261006600000_`.
Status words: BUILT (where, how verified), OWNER-QUESTION (the question), NOT-BUILDABLE (why), ALREADY-THERE (the audit
saw it missing, the source already had it).

Verification that applies to every BUILT row unless a row says otherwise: `tsc` clean on the changed files, `eslint
--max-warnings=0` clean, the new tests `tests/w6-audit-and-operations-helpers.test.ts` and
`tests/w6-settings-and-integrations-helpers.test.ts` pass, the related existing tests pass (listed at the end), and the
screen was rendered at 1536x1024 and 390 wide as the owner. Storage and every external service (Meta, Figma, Google, the
alert webhook, the AI provider) are unreachable locally, so what they answer is proven through pure evaluators and the
existing fakes, not the browser; the rows say so.

## SCR-061 AI Workforce Dashboard

| row | result |
|---|---|
| Open agent/model/tool/run detail: "Task Runs" tab 404 | BUILT. Tab now opens `/usage/runs` (the real run list). `app/(internal)/agents/page.tsx`. Rendered. |
| "Tools & Integrations" tab 404 | BUILT. New index page `app/(internal)/agents/tools/page.tsx`: one row per tool of the registry with action class, bound agents, allowed/denied counts, 30-day calls, failure rate, average latency; each row opens the existing tool page; links to Integrations. Rendered. |
| Model Usage row links to `/agents/models/<unregistered model>` (404) | BUILT. The link is drawn only for a model the registry (`ai.models`) holds; otherwise plain text with a "Not in the model registry" title. |
| Automation workflows (definitions, triggers, runs) | OWNER-QUESTION. "Should automation workflows be owner-defined records (steps and triggers stored in the database) or stay defined in code like the agents themselves (decision #12)? Today only the agent-to-agent handoff list exists." |

## SCR-062 Agent Registry, SCR-063 Agent Detail

All rows were PRESENT in the audit. No change.

## SCR-064 Model Routing, Providers & Tools

| row | result |
|---|---|
| Header KPI row (provider status, verified runtime, model availability, routing rules, fallback policy) | BUILT. Five tiles at the top of `/agents/routing`, each from stored rows (vault, settings, `ai.models`, routing policies, fallback chains) and each linking to its section. Rendered. |
| Tool permissions on this screen | BUILT. "Tool Permissions" card: every tool with allowed / denied / bound counts, each opening the tool page; link to `/agents/tools`. |
| Verify provider on this screen | BUILT. "Verify Provider" card mounts the same form and door (`verifyAiProviderAction`) as `/agents`; shows the last answered moment and model. The real call cannot be exercised locally (no provider key answers). |
| Set model budget/cap | BUILT. Migration `20261006600000_a_model_has_a_monthly_budget_of_its_own.sql`: `ai.model_budgets` (RLS by organization, no write grant to authenticated), `ai.model_spend_this_month`, door `ai.set_model_budget` (owner only, must be a registry model, audited `model_budget.set` / `.cleared`), view `ai.model_budget_status`, refusal kind `model_budget_exceeded`. The runner (`src/lib/ai/run-gates.ts`, `app/api/jobs/run/agent-run.ts`) asks the model cap before the provider cap, fails closed on an unreadable cap, records the refusal and raises a critical alert. UI: "Model Budgets" card (`ModelBudgetsPanel`). Live verifier `scripts/verify-model-budget.mjs` (`npm run db:verify:modelbudget`, step in `verify.yml`) passes: owner sets/changes/clears, admin and member refused, unknown model refused, bad caps refused, direct write refused, audit names the owner. The runner's refusal path is read-verified (the existing test pins the gate order) but no model call ran locally. |

## SCR-065 Agent Runs, Usage, Cost & Automations

| row | result |
|---|---|
| Cancel long-running work | ALREADY-THERE. `CancelRunningJobForm` is on the run detail for a running job (`core.cancel_running_job`, 20261001150000). Added: workflow-level cancel (see SCR-066). |
| Tool calls inside the run | ALREADY-THERE. The step trace renders `tool_call` steps with the tool name; the local ledger holds only `model_call` steps, so a populated trace could not be rendered. |
| Automation workflows | OWNER-QUESTION (same as SCR-061). |

## SCR-066 Operations Dashboard

| row | result |
|---|---|
| Cancel workflow | BUILT. "Cancel workflow" in the event-chain drawer: one reason, applied to every unsettled job of the correlation id through the existing audited doors (`core.cancel_job` for queued or failed work, `core.cancel_running_job` for running work, which settles at the next step). Files: `src/lib/observability/cancel-workflow(-plan).ts`, `app/(internal)/operations/cancel-workflow-{actions,form}`. The plan and the sentence are a pure function, tested. No migration: each job stop is its own audit row. |
| Escalate operational failure | BUILT. Escalate (the shared `core.escalations` control) was on dead jobs and failed deliveries; it is now also on dead outbox events, each wedged-follow-up group (the stalled-work list) and each failed workflow. |

## SCR-067 System Health, Production Readiness & Alerts

| row | result |
|---|---|
| Run verification | BUILT. "Live Checks" card with a "Run verification" button: Meta, AI provider, Google Calendar and Figma in turn, each through the same door its own page uses, one report line per check (Answered / Failed / Skipped with its own reason, never a pass for something unconfigured). `app/(internal)/production-readiness/actions.ts`. The external answers cannot be exercised locally; the report shape and skip rule were rendered with nothing configured. |
| Last live checks | BUILT. The card states the most recent recorded answer and each check's own last moment. |
| Alert destination test | BUILT. "Test alert destination" posts one labelled test (`test: true`, severity info) to `ALERT_WEBHOOK_URL`, reports the answer, and audits `alert_destination.tested`; the card shows when it last ran and whether it answered. The webhook itself is external; the unset case was rendered ("never tested"). |
| Send controlled test message, Acknowledge alert, Incident banner | UNVERIFIED in the audit (need a recipient or an open alert). Unchanged; the forms exist. |

## SCR-068 Approval Center, Policies & Overrides

| row | result |
|---|---|
| Approval type / required role, approve / reject / request change, decision detail | UNVERIFIED in the audit (empty queue). Unchanged. The approval's own page now wears the new `ApprovalBanner` (state, who must decide, due and overdue, decision moment and note). |

## SCR-069 Security, Roles & Audit Log

| row | result |
|---|---|
| Actor, time, before/after and reason on privileged changes | BUILT. `/security` "Recent privileged changes" now lists only real privilege changes (status change, role added, role removed; department edits are noise and are excluded), names the member and the actor, shows the change ("active to suspended", "role added: finance"), and shows the reason. The three membership doors take no reason, so the actions in front of them now REQUIRE one (an input on Suspend/Reactivate, Grant and Revoke) and append it to the audit trail as `membership.change_reason` right after the door succeeds (`recordPrivilegeReason`). `src/lib/audit/privileged.ts` pairs each change with its reason (same author, same member, same kind, recorded after it and before the next change); a change with none reads "No reason recorded". Limitation said plainly: the pairing is by author, member and order, not by a foreign key, because an audit row cannot be amended. |
| Audit log: real actor names | BUILT. Actors resolve through `core.users`; an id fragment appears only as "(account removed)" when the account no longer exists (several local actors were deleted by earlier verifiers). |
| Audit log: links to record or version | BUILT. `src/lib/audit/links.ts` maps a subject (lead, client, project, invoice, approval, meeting, membership, contract, quotation, import batch, and project files/versions through the project id the entry recorded) to its page; a subject with no page shows no link. Tested. |
| Audit log: paging and search over all entries | BUILT. The fixed "100 most recent" is replaced by paging (50 a page, true total, "Showing 1-50 of 2,776") with `?page=`; search, action, subject, actor and date filters apply across all pages; a stale page lands on the last real page; Export CSV now walks every matching page (bounded at 10,000 rows) and honours the search. |
| Grant/revoke role (UNVERIFIED) | Unchanged; the revoke control now also asks for a reason. |
| Audit access (section 7) | BUILT as a stated decision. `/audit` now says who may read it (`audit.read`, owner and ops admin) is set in the code-owned permission matrix, not a setting. |

## SCR-070 Integrations Center & Import

| row | result |
|---|---|
| Figma in the lifecycle | BUILT. A first-class "Figma" row: NOT CONFIGURED without a token; CONFIGURED with a token; VERIFIED only when a design reference was actually checked against Figma (`projects.theme_options.figma_verified_at`). Count of references recorded, last checked. "Verify Figma" (`verifyFigmaAction`) asks Figma for the most recent recorded reference and re-records it as checked through the existing link door, carrying its preview and page so nothing is erased; with no reference recorded it says there is nothing to check the token against. Figma itself is external: rendered with no token (NOT CONFIGURED, "2 references recorded unchecked"). |
| Calendar in the registry and counts | BUILT. Google Calendar is a row of the registry and counted in the summary (NOT CONFIGURED / CONFIGURED / VERIFIED by a real free/busy read), with its own verify form and identifier rows; the loose paragraph under the list is gone. |
| Last verified time | BUILT. Every row states its last recorded check ("No verification recorded" otherwise); the page states the aggregate (the most recent person-run check; the database and scheduler are excluded because they are read live on every load and would always say "now"). |
| Update non-secret identifiers | NOT-BUILDABLE for the rest. Only WhatsApp has identifiers the settings door may write (`core.set_organization_setting` whitelists its keys); the others are environment values the panel cannot write by design. The drawer says so per integration. |
| Stage/review/commit import (UNVERIFIED) | Unchanged. |

## SCR-071 Organization Settings & Business Rules

| row | result |
|---|---|
| Seven area summaries | BUILT. A status tile per area above the tabs (General, Commercial, Team, Communication, Approvals, Finance, Project Defaults), each from stored facts ("2 of 3 set", "Pricing model not set, payment terms set"), each linking to its tab; an unconfigured area reads as not set up. `src/lib/admin/settings-summary(-eval).ts`. Tested. |
| Project defaults tab | BUILT by W2, recorded here. W2 created `/settings/project-defaults` and its tab while this stream ran (default phase notifications and standard folders through `projects.set_project_defaults`); my duplicate page and tab were removed and the summary tile links to theirs. The group-name identifier, default team and design reviewer stay on Team (their tests pin them there). |
| Preview impact beyond name and timezone | BUILT. A reusable `ImpactGate` (`app/(internal)/settings/impact-gate.tsx`) puts a confirm step in front of any single-form setting without adding a write path: the first submit shows what the change touches (counts read from real rows) and "Confirm and save" submits the same form to the same door. Applied to the pricing model, payment terms, quotation validity, negotiation limits, approved offer, outreach limits, sending window and reactivation cap. `readSettingImpact` gained quotation and outreach counts; the sentences are a pure tested function. The interaction (native submit intercepted, then `requestSubmit`) was type- and lint-checked and the pages rendered; a click-through of the confirm button was not automated. |
| Project group naming pattern | OWNER-QUESTION. "G-188 fixes four of the five parts as facts and lets you add a word at the end. Do you want the whole pattern editable, knowing a change renames groups people already belong to?" |

## Section 7 (manageability matrix), this stream's rows

| row | result |
|---|---|
| Governance: Audit access | BUILT as a stated decision (see SCR-069). |
| Governance: Retention/export rules | OWNER-QUESTION. "How long must audit entries be kept, and who may export them? No spec states a retention rule; export exists (CSV) and the log is append-only." |
| Project Defaults rows (group pattern, phase notifications, standard folders) | Phase notifications and standard folders: BUILT by W2 (see above). Group pattern: OWNER-QUESTION above. |
| Communication: Announcement templates; all Finance rows | Not this stream's theme (communication and finance streams). |

## Section 8 (UI and QA checklist)

| row | result |
|---|---|
| Reusable approval banner | BUILT. `src/ui/primitives/approval-banner.tsx`, exported from `@/ui`, used on `/approvals/[requestId]` for every state. |
| Reusable error state | BUILT. `src/ui/primitives/error-state.tsx`, exported from `@/ui`; the internal error boundary (`app/(internal)/error.tsx`) now renders it with its Try again button, same copy. |
| Loading state for `/governance/overrides` | BUILT. `app/(internal)/governance/overrides/loading.tsx`. A scan of every `page.tsx` under `app/(internal)` shows no other route without a `loading.tsx` of its own or an ancestor's. |
| Per-screen error states with retry | Covered by the root internal boundary (Try again re-renders the segment); no per-screen wording was specified, so none was invented. |
| Audit: who did what, which version | BUILT (names and links, see SCR-069). |
| Deep links from audit to exact record | BUILT. |
| Cross-module consistency (client totals equal finance) | Finance stream. |
| Full visual pass | The screens this stream changed were rendered and read. The rest is not part of this stream. |
| Docs: `AGENCYOS_ADMIN_REMAINING_GAPS.md` "link-based by decision" | BUILT. The stale row is replaced with the truth: files moved to Supabase Storage by the owner's decision of 2026-09-29 (versions, trash, share links, migration `20260930110000`); only browser verification and emptying the trash remain. `AGENCYOS_ADMIN_CONFIGURABILITY_AUDIT.md` line 103 (standard folders "parked") is stale too and belongs to W2. |

## Files

Migration: `supabase/migrations/20261006600000_a_model_has_a_monthly_budget_of_its_own.sql` (applied twice locally, PostgREST reloaded).
Verifier: `scripts/verify-model-budget.mjs`, `package.json` `db:verify:modelbudget`, `.github/workflows/verify.yml` step.
Tests: `tests/w6-audit-and-operations-helpers.test.ts`, `tests/w6-settings-and-integrations-helpers.test.ts` (behavioural, pure helpers with real inputs; no source-text pins). One existing pin updated, keeping its intent: `tests/search-lives-in-every-domain.test.ts` (the audit reader is now `readAuditPage`).
Shared primitives touched (additive): `src/ui/primitives/approval-banner.tsx`, `error-state.tsx`, `src/ui/index.ts`; `app/(internal)/error.tsx` uses `ErrorState`.
`src/lib/db/types.ts`: targeted additions (`model_budgets`, `model_budget_status`, `set_model_budget`, `model_spend_this_month`).
