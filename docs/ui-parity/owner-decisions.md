# Owner decisions on the reference gaps (2026-10-03)

Answered one by one by the owner. Each row is the decision, not a recommendation.

| # | Question | Decision |
|---|---|---|
| 1 | What is a sprint? | Per project, fixed length. A task can be placed in one sprint of its project. No capacity tracking. |
| 2 | Member department / Online? | Department only, from a fixed list. No Online indicator; the Team tab keeps "last active". |
| 3 | Communication tab name | Rename to **Discussion** (route may stay). |
| 4 | Project type, technology, tags | Type from a fixed list; technology and tags are free-text chips. |
| 5 | Requirement Priority and Assignee | Both, editable even after the scope is frozen (the frozen wording never changes). |
| 6 | Requirement attachments | Yes, by linking existing project files. |
| 7 | Files: New Folder and Grid/List | Both. Folders become real records; Grid/List toggle. |
| 8 | Thread classification | Client and Internal only. No Team tab. |
| 9 | QA phase | Yes, derived from QA runs (In QA = an open test run and no release). No manual status. |
| 10 | Contracts | Simple record linked to a won deal: title, file link, signer name, signed date, status draft/sent/signed. No e-signature. |
| 11 | Lead files | Yes, as links; they carry over to the project when the deal is won. |
| 12 | Add Agent | No. Agents stay in code. |
| 13 | Quotation Share before approval | No. Only after the owner approves. |
| 14 | Hot lead / No response | Hot = stage Qualified or beyond AND the lead replied in the last 7 days (no numeric score). No Response = 3 or more days of silence. |

## Build status, stream R2 (migration 20261005200000)

| # | Status | Where |
|---|---|---|
| 9 | Built | `src/lib/admin/qa-stage.ts` (pure, tested), Command Center pipeline "In QA" stage, "In QA" chip and `?status=in_qa` filter on Projects; lifecycle phase QA now means an open run |
| 10 | Built | `sales.contracts` + doors; `/contracts` (SCR-072, Sales & CRM tab); list on Lead 360 (won deal) and Client 360 Quotations tab |
| 11 | Built | `crm.lead_files` + doors; Lead 360 Files tab; carried once to the project from `convertToProject` via claim door |
| 12 | Nothing to build | No Add Agent control exists; agents stay in code |
| 13 | Nothing to build | Quotation Share is only offered after approval (internal link) |
| 14 | Built | Hot Leads / No Response in Leads rail Quick Filters (`src/modules/crm/lead-quick-filters.ts`); No Response counts silence from last inbound message or creation, only for new/qualifying/qualified leads |

## Round 2 — answers to the questions the PDF build left open (2026-10-01)

| # | Question | Decision |
|---|---|---|
| 1 | Lead numeric score | No number: show a Hot / Warm / Cold label from reasons (stage, recent reply, budget recorded). Matches ADM-88. |
| 2 | Payment schedule | Free plan stays; 30/20/30/20 tied to Phases 2, 4, 5, 6 is the pre-filled default when a quotation starts. |
| 3 | Group-name pattern | Fixed (four parts + one trailing word as today). |
| 4 | Blocker kinds | Confirmed: client answer, payment, dependency, decision, access, outside service, other. |
| 5 | Invoice proof / expense receipts | Upload allowed, under the project file rules and credentials guard; links still allowed. |
| 6 | Expense categories | Owner-editable list, starting from infrastructure, ai, tooling, vendor, contractor, other. Old expenses keep theirs. |
| 7 | Finance role and client names | Finance sees the client's name only (no contacts or other client data). |
| 8 | Client-facing PDF "Paid / Balance due" | Verified payments only. |
| 9 | GST setup | Regular taxpayer, monthly filing (GSTR-1 and GSTR-3B), period = calendar month. |
| 10 | Automation workflows | Stay in code. |
| 11 | Audit log | Keep forever; owner and ops admin may export; every export is itself logged. |
| 12 | Plan activation | Requires internal approval, enforced in the database. |
| 13 | Contract and migration checks | A GitHub workflow dispatched from the panel; the result is recorded. |
| 14 | AI / semantic search | Yes, over everything searchable. |

## Round 3 — answers to the line-by-line PDF trace's open questions (2026-10-01)

Binding. Source questions: `docs/pdf-gap/TRACE-{A,B,C,D}.md`.

| Id | Decision |
|---|---|
| Q-NAV | Keep the reference screenshots' module names (Communications, Approvals, Analytics & Costs, Security & Audit, Organization). Owner: "whichever you think best". |
| Q-PH56 | Completing Phase 5 raises the M3 invoice and the PM Task 3 message; completing Phase 6 raises M4 and PM Task 4, exactly as Phase 4 does for M2. |
| Q-BAND | Budget bands are owner-editable (a setting); a lead's budget shows in its band. The figure and "Not recorded" stay. |
| Q-OVERRIDE | A person may override the Hot/Warm/Cold label with a reason; the computed label is kept and the override is audited. |
| Q-CHIPS | Client chips come from projects: Active = at least one running project; Pending = only unstarted/signed projects; Completed = every project complete; On hold = a project on hold. No overlap. |
| Q-B1 | A task reaches Completed only from In review. |
| Q-B2 | Project roles are enforced: Observer read-only, Contributor own tasks only on that project. |
| Q-B3 | Project roles are changed by owner, ops admin and delivery lead (as today, `project.write`). No change. |
| Q-B4 | A project has default assignees per project role. |
| Q-B5/B6 | Screen navigation paths and actions stay free text. No change. |
| Q-B7 | "Map requirement" on a finalized baseline drafts the next baseline. |
| Q-C1 | "Upload build" also accepts a build file (apk/ipa/zip) under the project-file limits and credentials guard. |
| Q-C2 | No per-asset visibility flag now. No change. |
| Q-C3 | Start Task is gated by a requirement check (task linked to a requirement/scope item) and a dependency check (its dependencies complete). |
| Q-C4 | Commits map to tasks automatically by the `task/<id8>-` branch or message convention; manual mapping stays. |
| Q-C5 | Defect verification stays with `project.write`, as today. No change. |
| Q-C6 | Test-run and bug evidence may be uploaded files under the project-file rules. |
| Q-D1 | The Google Calendar id becomes an organization setting editable in the panel, read before the environment value. |
| Q-D2 | "Generate period report" stores a dated snapshot that "Export history" lists. |
| Q-D3 | Meeting-note upload also accepts recordings, images, PDF and Word under the project-file rules. |

## Round 3b — answers to the round-3 build's follow-up questions (2026-10-01)

Binding.

| Id | Decision |
|---|---|
| R1-1 | A client with one project on hold and one running shows On hold. No change. |
| R1-2 | A client with a finished project beside an unstarted one shows Pending (was "Mixed"). |
| R1-3 | Completing Phase 5 requires the M2 invoice to be verified paid. |
| R1-4 | The Hot Leads filter and its count follow the manual override, so they agree with the badge. |
| R2-1 | Dependencies are per task (a task-level dependency table), replacing the plan-level check in Start Task. |
| R2-2 | Project-role enforcement extends to task comments, time logs and checklists. |
| R2-3 | The database exemption for roster managers uses the role union, like the service. |
| R3-1 | File caps stay at 5 per build and 20 per run or bug. |
| R3-2 | The period report snapshot also holds payments received and the profit-and-loss figures. |

## Round 3c — answers to the round-3b build's follow-up questions (2026-10-01)

Binding.

| Id | Decision |
|---|---|
| S1-1 | A project with no M2 milestone/invoice cannot complete Phase 5 (as built). No exemption. |
| S1-2 | Period-report revenue stays cash-basis (verified receipts net of refunds) and payments are counted by verified date. No change. |
| S1-3 | Payment milestones by phase: Phase 1 none, Phase 2 M1, Phase 3 none, Phase 4 M2, Phase 5 M3, Phase 6 M4. Phase 5 completions already recorded stay valid. |
| S2-1 | Task attachments (links on a task) are bound by project role like comments, time logs and checklists. |
| S2-2 | The project roster and default-assignee doors use the role union (primary or secondary), like the task rules. |
| S2-3 | A dependency on a cancelled or archived task counts as satisfied, as well as done. A dependency across projects stays refused. |

## Round 3d — answers to the round-3c build's follow-up questions (2026-10-01)

Binding.

| Id | Decision |
|---|---|
| T1-1 | Tasks gain a real `cancelled` status and an `archived_at` column. A cancelled or archived task counts as satisfied for dependencies; progress, health and KPIs do not count a cancelled task as outstanding work. |
| T1-2 | Project roster writes (`project_members`) go through an audited security-definer door (add, remove, change role), like the default assignees. |

## Round 3e — answers to the round-3d build's follow-up questions (2026-10-01)

Binding.

| Id | Decision |
|---|---|
| U1-1 | An archived task is read-only: status, edit, comment, time, checklist, attachment and dependency changes are refused until it is unarchived (unarchive by roster managers only). |
| U1-2 | Cancelling a task requires a reason (kept in the audit row and shown on the task) and notifies the assignee. |
| U1-3 | A roster change made through a door writes one audit row (the door's); the table trigger's row is kept only for writes that do not come through a door (service role). |

## Round 3f — answers to the round-3e build's follow-up questions (2026-10-01)

Binding.

| Id | Decision |
|---|---|
| V1-1 | Adding a subtask under an archived task is refused (the archived task is wholly read-only). |
| V1-2 | A cancel always carries a reason, for every writer; a system-initiated cancel supplies its own default reason (for example "Project cancelled"). The DB rule stays as built (service role included). |
| V1-3 | The cancel notification goes to the assignee only. No change. |
