# PDF gap audit, slice C: SCR-037 to SCR-054 (PDF pages 46-63)

Method: rendered app as owner@local.test at 1536x1024 (Playwright dump of `main` text + every control, plus screenshots), on the local stack, read-only. Role spot checks as member@local.test and contractor@local.test. Sub-views visited: prototype, design overview / themes / final (project with Phase 3 completed and Northwind), development portfolio + project development + task page (blocked and in-progress task), plan, repository, builds, /qa, project QA (Northwind, a project with an empty test plan, a project with runs), bug page, release tab, /production-readiness, /finance, /invoices (row menu, reminder drawer), invoice detail (draft, overdue/issued, partially paid), /finance/payments, /invoices/verify.

Status meanings: PRESENT = visible and usable; PARTIAL = something exists but differs from the PDF; MISSING = no control/data/sub-view; DECIDED = owner decision declines it; UNVERIFIED = I could not reach the populated state in the running app, so I read the source only (only listed where the source shows the element exists; I do not count it as proven).

Why so many UNVERIFIED: the seeded local DB has 0 prototype artifacts, 0 UI versions, 0 design assets, 0 project plans, 0 payment claims, 0 git actions, no test-plan items, no environments, and the only linked GitHub repo (vercel/next.js) answers 401 to the configured token. I did not write to the DB. Rows marked UNVERIFIED therefore cannot be confirmed from the screen.

## Summary

| SCR | Screen | Elements checked | PRESENT | PARTIAL | MISSING | DECIDED | UNVERIFIED |
|---|---|---|---|---|---|---|---|
| 037 | Prototype Builds & Review | 25 | 12 | 6 | 4 | 0 | 3 |
| 038 | Assets, Brand Kit & Feedback History | 20 | 7 | 6 | 2 | 0 | 5 |
| 039 | Development Dashboard | 20 | 14 | 3 | 1 | 0 | 2 |
| 040 | Implementation Plan | 22 | 5 | 6 | 1 | 0 | 10 |
| 041 | Development Task Execution | 24 | 18 | 4 | 0 | 0 | 2 |
| 042 | Repository, Branch & Code Review | 21 | 8 | 3 | 1 | 0 | 9 |
| 043 | Builds, Environments & Dependencies | 22 | 11 | 2 | 2 | 0 | 7 |
| 044 | QA Dashboard | 22 | 20 | 2 | 0 | 0 | 0 |
| 045 | Test Plan & Cases | 19 | 12 | 3 | 1 | 0 | 3 |
| 046 | Test Runs | 21 | 13 | 5 | 1 | 0 | 2 |
| 047 | Bugs & Defects | 23 | 20 | 1 | 0 | 0 | 2 |
| 048 | Regression, Compatibility & Performance | 20 | 17 | 2 | 1 | 0 | 0 |
| 049 | Production Readiness & Release Candidate | 20 | 14 | 5 | 0 | 1 | 0 |
| 050 | Finance Overview | 22 | 19 | 3 | 0 | 0 | 0 |
| 051 | Invoices | 21 | 14 | 5 | 2 | 0 | 0 |
| 052 | Invoice Detail / Create | 26 | 16 | 8 | 2 | 0 | 0 |
| 053 | Payments | 23 | 17 | 3 | 2 | 0 | 1 |
| 054 | Payment Verification | 19 | 9 | 3 | 1 | 0 | 6 |
| | **Total** | **390** | **246** | **70** | **21** | **1** | **52** |

Elements = Purpose + every header/KPI bullet + every main-content bullet + every primary action + every guardrail + the 5 generic checklist lines, counted per screen. The generic checklist lines (server-side permission check, audit event, empty/error states, desktop-first) are counted PRESENT unless a row below says otherwise; I confirmed permission-denied pages on the UI (member/contractor on /finance, /invoices/:id, /production-readiness, /invoices/verify) but did not exercise server-side action guards or audit writes (read-only audit).

---

## SCR-037 Prototype Builds & Review (PDF p46)
Routes: `/projects/41f1a273…/prototype`, `/design` (portfolio counts). PRESENT: 12 (build table with version/client decision/QA/approval/added, 4 KPI tiles, artifact link, "Send for client review", "Add build", pending-approval decide form in source, permission-denied and empty states).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Platform/type" (p46) | PARTIAL | No platform column or tile. Platform exists only as a picker on the "Prototype builds (n)" artifact cards, which are empty here ("None yet"). | Platform/type column and tile on the main build table. |
| Header "Admin status" (p46) | PARTIAL | "Approval" column shows the approval request state ("none raised"); no admin-status field. | An explicit Admin status per build. |
| Header "Revision count" (p46) | PARTIAL | Badge "n revisions" only on the (empty) artifact cards; not in table or KPIs. | Revision column in the table. |
| Main "Build detail" (p46) | MISSING | Rows are not clickable; there is no detail page, drawer or route per build. | Build detail drawer/page. |
| Main "QA evidence" (p46) | UNVERIFIED | Artifact card has a QA evidence block (coverage verdict, latest run, submitted-to-QA) in source; no artifact exists to render it. | Seed/record a Prototype Agent build to confirm. |
| Main "Client feedback" (p46) | UNVERIFIED | Artifact card reads client feedback per UI version in source; not renderable. | As above. |
| Action "Upload build" (p46) | PARTIAL | "Add build" takes Version title + artifact link + changelog. No file upload, no platform/type field. | File/upload or platform/type capture. |
| Action "Submit to QA" (p46) | UNVERIFIED | Button exists in source on artifact cards not yet submitted; none rendered. | Confirm with a real artifact. |
| Action "Admin confirm/edit" (p46) | PARTIAL | Only a decide form when an approval request is pending (none here); no way to edit a build. | Edit + explicit Admin confirm control. |
| Action "Record client approval/change" (p46) | MISSING | Client feedback is read-only on this page. No control to record a client approval or change request against a build. | Record-client-decision form on the build. |
| Guardrail "Only QA-passed + Admin-approved build is sent to client on the normal path" (p46) | PARTIAL | Draft build v1 shows QA "no run" and approval "none raised" yet "Send for client review" is offered, with no stated precondition. | Hide/disable with reason until QA-passed and Admin-approved (and an explicit override path). |
| Checklist "search/filtering" (p46) | MISSING | No search or filter on the build list. | Search/filter by status, platform, QA. |
| Checklist "contextual drawers for quick inspection" (p46) | MISSING | No drawer on this screen. | Build-inspection drawer. |

## SCR-038 Assets, Brand Kit & Feedback History (PDF p47)
Routes: `/projects/4b7f18c6…/design` (Phase 3 completed), `/design/themes`, `/design/final`; Northwind `/design*` (all tabs show only "Phase 3 has not started"). PRESENT: 7 (Approved vs draft KPI, Upload design form with kinds, feedback history on Final selection, design activity, signed-link previews in source, asset handoff JSON link, permission-denied).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Lifecycle "Phase 3-5" (p47) | PARTIAL | Northwind has a prototype deliverable (Phase 4) but its whole Design area, including the asset library, is replaced by "Phase 3 has not started. … Open the plan." Assets are unreachable outside Phase 3 started/completed projects. | Asset library reachable through Phase 4-5. |
| Header "Asset categories" (p47) | PARTIAL | One KPI "Approved Assets 0 / 0 draft · 0 uploaded"; no per-category counts. | Category counts. |
| Header "Recent feedback" (p47) | PARTIAL | Client Review card shows only the latest feedback line; the full list is on Final selection. | Recent-feedback list on the asset screen. |
| Main "Brand kit" (p47) | MISSING | No brand-kit sub-view. Asset kinds are illustration, reference, texture, mood board, visual asset; there is no logo, font reference, icon or brand-rule kind. Themes page shows "Design primitives — none yet" per theme only. | Brand kit section (logos, font references, icons, brand rules). |
| Main "Asset folders" (p47) | UNVERIFIED | Source renders one collapsible folder per kind; "No design asset has been uploaded" so none rendered. Folders are fixed by kind, not user folders. | Upload one asset to confirm. |
| Main "Version links" (p47) | UNVERIFIED | Source lists versions per asset family and links to screens/UI versions; none rendered. | As above. |
| Action "Upload/replace asset version" (p47) | UNVERIFIED | Upload rendered; replace (compact upload with parent asset) only in source. | Confirm replace. |
| Action "Mark approved" (p47) | UNVERIFIED | ApproveAssetButton in source only. | Confirm. |
| Action "Link asset to screen/version" (p47) | UNVERIFIED | Link forms in source only. | Confirm. |
| Action "Export handoff package" (p47) | PARTIAL | "Handoff package (JSON)" link: a JSON manifest, not a package of files. | Bundle (zip) or explicit acceptance of manifest. |
| Guardrail "Do not expose licensed/private assets outside project permissions" (p47) | PARTIAL | Previews use 5-minute signed links (source). Upload form has Kind/Title/File only; no licence/rights field. | Licence/rights capture and visibility flag. |
| Guardrail "Feedback must link to the exact design/prototype version" (p47) | PARTIAL | Feedback links to theme option + round (e.g. "Calm", "round two"); no link to a UI version or prototype build. | Version reference on each feedback row. |
| Checklist "search/filtering" (p47) | MISSING | No search on assets or feedback (Search exists only for the screen grid). | Asset/feedback search. |

## SCR-039 Development Dashboard (PDF p48)
Routes: `/development`, `/projects/41f1a273…/development`. PRESENT: 14 (5 KPI tiles incl. without-plan and without-test-plan, blockers table, per-project table with modules/tasks done/in progress/in review/blocked/plan/QA handoff/latest build, workstream (module) progress with bar, Escalate to the PM form, Start QA handoff with gate text, realtime "Connecting/Updated" + Refresh, empty states).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Active developer tasks" (p48) | PARTIAL | Project page lists every task per module with inline status; no active-only view, no assignee on rows, nothing cross-project on the portfolio. | Active/mine task list. |
| Main "Recent commits/builds" (p48) | PARTIAL | Panel is commits + GitHub actions only ("0"); builds appear only as the "Latest build" table column. | Include build events. |
| Main "Upcoming dependency needs" (p48) | UNVERIFIED | Source lists unmet plan dependencies and open technical dependencies; KPI shows "no plan yet". | Needs a project with a plan. |
| Action "Open plan/task/repository/build" (p48) | PARTIAL | Project page links Plan (via Open questions), tasks and Repository; no link to the build; portfolio rows link only to the project page. | Direct links to plan and builds. |
| Guardrail "PM does not split technical work" (p48) | UNVERIFIED | "Add module / feature / task" forms are on the project Development page; which roles may use them was not exercised. | Verify role restriction. |
| Checklist "search/filtering" (p48) | MISSING | 21-row project table has no search/filter or pagination. | Search/status filter. |

## SCR-040 Implementation Plan (PDF p49)
Route: `/projects/41f1a273…/plan` (and a second project). No project has a plan, so the populated plan board could not be rendered; only the Phase 2 shell and "No plan yet" + "Start the operational plan" form are visible. PRESENT: 5.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Purpose "Extremely detailed Development Planning Agent output" (p49) | PARTIAL | The rendered page is the Phase 2 operational blueprint (timeline, payment milestones). It states "Operational, never technical. Tables, APIs, coding tasks and UI belong to the Phase 5 Development Planning Agent, and there is nowhere here to put them" while the source puts the technical layers on this same page. | Separate Phase 5 plan view, or fix the contradictory copy. |
| Header "Plan version/status" (p49) | UNVERIFIED | Source shows "Version n" + status badge and "Plan versions" tile; not rendered. | Needs a plan. |
| Header "Coverage of approved scope" (p49) | UNVERIFIED | Source tile "Approved scope covered n%". | Needs a plan. |
| Header "Client dependencies outstanding" (p49) | PARTIAL | Source has a section below, not a header tile. | KPI tile. |
| Header "Risk count" (p49) | PARTIAL | Header tiles are coverage/deliverables/versions/open questions; risks are a list further down (source). | Risk tile. |
| Main "Modules/features" (p49) | UNVERIFIED | Source has module→feature breakdown. | Needs a plan. |
| Main "Frontend/backend/database/APIs/integrations/auth/business logic" (p49) | UNVERIFIED | Source: seven layer badges per deliverable + layer panel. | Needs a plan. |
| Main "Dependencies" (p49) | UNVERIFIED | Source: plan dependencies register. | Needs a plan. |
| Main "Execution order" (p49) | UNVERIFIED | Source: "#n" badge per deliverable. | Needs a plan. |
| Main "Acceptance criteria" (p49) | PARTIAL | Source shows "Ready when" readiness criteria and "Evidence" per deliverable; acceptance criteria live on scope items (task page "Scope it delivers"). | Acceptance criteria per feature in the plan. |
| Main "Definition of Done" (p49) | UNVERIFIED | Source: a derived sentence per deliverable. | Needs a plan. |
| Action "Approve plan internally" (p49) | PARTIAL | Only "Activate" (draft to active); no internal approver or approval record. | Internal approval step. |
| Action "Create development tasks from plan" (p49) | UNVERIFIED | Source: PlanBreakdownForm for active plans. | Needs a plan. |
| Action "Request missing client dependency through PM" (p49) | PARTIAL | Clarification form in source; routing to PM not shown. On the task page it dead-ends: "There is no plan to raise it on. Draft one." | PM routing. |
| Action "Version plan when accepted scope changes" (p49) | UNVERIFIED | Source: "Open the next version" on active plans. | Needs a plan. |
| Guardrail "No guessed requirement may enter the plan" (p49) | UNVERIFIED | Source flags "Not linked to approved scope — validation will flag it" and an ambiguity note. | Needs a plan. |
| Checklist "search/filtering" (p49) | MISSING | None. | Filter deliverables/dependencies. |

## SCR-041 Development Task Execution (PDF p50)
Route: `/projects/41f1a273…/development/tasks/{5e6e394d (blocked), 7a5758f9 (in progress)}`. PRESENT: 18 (status/priority/module header, checklist, evidence submit, artifacts/attachments, comments, handoff status, evidence status, dependencies panel, defects, time log, sprint, labels, "Mark ready for QA — needs evidence first", no self-accept path).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Purpose "requirement check, dependency check, implementation, test, verify, fix, retest" (p50) | PARTIAL | No explicit requirement-check step; dependency panel reads "project has no plan, so nothing is recorded". | Requirement-check gate. |
| Header "Acceptance criteria" (p50) | PARTIAL | Only via task feature → scope items; both tasks have no feature ("nothing in the scope baseline points at it"). Checklist is free-form. | Acceptance criteria on the task. |
| Main "Implementation notes" (p50) | PARTIAL | No dedicated section; generic description (empty) and comments. | Notes section. |
| Action "Start task" (p50) | UNVERIFIED | Blocked task shows no Start (text says unblock first); In-progress task shows only Mark ready for QA. A to-do task was not visited. | Visit a to-do task. |
| Action "Request clarification" (p50) | PARTIAL | Panel is dead ("There is no plan to raise it on. Draft one."). | Allow clarification without a plan. |
| Action "Reopen after QA failure" (p50) | UNVERIFIED | Appears only with an open defect (source text); not rendered. | Needs a failed-QA task. |

## SCR-042 Repository, Branch & Code Review (PDF p51)
Route: `/projects/41f1a273…/repository`. PRESENT: 8 (repo list with platform, link/unlink, branch to read, typed links form, workflow file, audit log section "What the panel wrote to GitHub (0)", link commit on task page, empty state). The live GitHub panel shows "Not reachable: GitHub refused the token (401/403)".

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Branch status" (p51) | UNVERIFIED | Source: branch + checks badges; GitHub unreachable here. | Reachable repo. |
| Header "Open reviews" (p51) | UNVERIFIED | As above. | As above. |
| Header "Failed checks" (p51) | UNVERIFIED | Source: "n failed checks" badge. | As above. |
| Main "Branch detail" (p51) | UNVERIFIED | Source: Branches list. | As above. |
| Main "Commit history" (p51) | UNVERIFIED | Source: commits read live. | As above. |
| Main "Pull/merge review" (p51) | UNVERIFIED | Source: pull requests. | As above. |
| Main "Code-review findings" (p51) | UNVERIFIED | Source: readGithubReviewFindings. | As above. |
| Action "Create task branch" (p51) | UNVERIFIED | Panel in source; not shown when unreachable. | As above. |
| Action "submit review" (p51) | UNVERIFIED | SubmitReviewPanel in source. | As above. |
| Action "approve/reject merge based on policy" (p51) | PARTIAL | Source has Submit review and Merge (danger button) panels; no policy setting (who may merge, required checks). | Merge policy. |
| Guardrail "Least privilege for repo access" (p51) | PARTIAL | One org-wide GITHUB_TOKEN; banner says "scopes unknown". No per-repo permission UI. | Scope/permission display. |
| Guardrail "Every code artifact should map to project/task and review evidence" (p51) | PARTIAL | Commit-to-task links are typed by hand; typed repository rows say branch/review state "is whatever was typed in". | Auto-mapping. |
| Checklist "search/filtering" (p51) | MISSING | None on repos, branches or commits. | Filter/search. |

## SCR-043 Builds, Environments & Dependencies (PDF p52)
Route: `/projects/41f1a273…/builds` (no builds, no environments, no dependencies). PRESENT: 11 (6 KPI tiles, release-gate list of 11, trigger-build form (records only), add build, add environment, add dependency, dependency blockers tile, empty states).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Migration/API compatibility status" (p52) | PARTIAL | No tile; folded into "Environments ready — none linked yet". | Dedicated tile. |
| Main "Build history" (p52) | UNVERIFIED | "No builds yet"; list in source. | Add a build. |
| Main "Environment matrix" (p52) | UNVERIFIED | "No environment linked yet"; matrix in source. | Link an environment. |
| Main "API contracts" (p52) | UNVERIFIED | Per-environment check, recorded by a person with evidence. | As above. |
| Main "DB migrations" (p52) | UNVERIFIED | As above. | As above. |
| Main "External service configuration" (p52) | UNVERIFIED | As above. | As above. |
| Action "Promote build after gates" (p52) | UNVERIFIED | PromoteBuildPanel appears per environment. | As above. |
| Action "Mark dependency supplied" (p52) | UNVERIFIED | Button in source when a dependency exists. | Add a dependency. |
| Action "Run contract/migration checks" (p52) | PARTIAL | Checks are recorded by a person; nothing runs them. | Runner integration or accept as recorded. |
| Guardrail "Build reproducibility and rollback information must be retained" (p52) | MISSING | Add build has title/link/changelog only: no commit/ref, build number or rollback target. Rollback plan is on the release handover, not per build. | Commit ref and rollback target per build. |
| Checklist "search/filtering" (p52) | MISSING | None. | Filter builds/dependencies. |

## SCR-044 QA Dashboard (PDF p53)
Route: `/qa`. PRESENT: 20 (runs/pass/fail/blockers/defects KPIs, test runs, device testing, device x browser matrix, suites, open bugs with search, bug trend chart, retest queue, performance notes, QA progress, evidence summary, scheduled suites, Block a release form, most severe open, realtime + refresh).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Coverage matrix" (p53) | PARTIAL | Description says "per category" but columns are Project / Total / RC / Retest / Blocking / Ready; no category breakdown, all totals 0. | Category columns. |
| Action "Assign retest" (p53) | PARTIAL | Retest queue (empty) says "Verify on the project's Quality section"; no assign control on the dashboard. | Assign-retest action. |

## SCR-045 Test Plan & Cases (PDF p54)
Route: project QA page on three projects (Northwind: "No frozen scope baseline yet"; "zztest-events": "No test plan yet / Draft a test plan"; "zztest-dispatch": draft plan v1 with 0 items). PRESENT: 12 (plan versions, per-suite planned/executed/pass/fail table, add-to-plan form with category/why/preconditions/steps/expected/critical path, CSV/JSON import, scope-item link, baseline gate).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Test case list" (p54) | UNVERIFIED | "Nothing planned yet"; list with Remove in source. | Add a case. |
| Main "Preconditions / Steps / Expected result" (p54) | UNVERIFIED | Fields exist on the add form; case display (CaseDetails) in source only. | Add a case. |
| Main "Linked requirement/task" (p54) | PARTIAL | Scope-item (requirement) link only; no task link. | Task link. |
| Action "Assign suite" (p54) | PARTIAL | A category per case; no suite assignment to an owner or run. | Suite-level assignment. |
| Action "Approve plan" (p54) | UNVERIFIED | Button appears only when the plan has at least 1 item and the user may approve (source). | Plan with items. |
| Guardrail "Every accepted requirement should have coverage or explicit rationale" (p54) | PARTIAL | "Why this category applies" field exists; no list of accepted requirements without a case. | Uncovered-requirement view. |
| Checklist "search/filtering" and "create/update/delete" (p54) | MISSING | No search/filter of cases; only add and Remove, no edit. | Edit and filter. |

## SCR-046 Test Runs (PDF p55)
Route: project QA page (runs on "zztest-events de47cb04": 7 closed runs). PRESENT: 13 (run rows with suite/build/counts/start-end, device/browser/OS, Record run, Rerun failed cases, Raise a defect from this run, "0 defects from this run", Attach metric, run lifecycle).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Build/environment" (p55) | PARTIAL | Build (v1) and device/browser/OS shown; no deployment environment (staging/production, linked to Builds tab). | Environment on the run. |
| Header "Tester" (p55) | PARTIAL | Every run reads "tester not recorded"; Record run and Open a run forms have no tester field. | Tester field. |
| Main "Case results" (p55) | UNVERIFIED | Per-case grid exists in source only when a plan has items. | Plan with items. |
| Main "Screenshots/logs" (p55) | PARTIAL | One optional "Evidence link". | Per-run/case attachments. |
| Main "Retest history" (p55) | PARTIAL | Rerun creates a new run pointing back; no chain/history view. | Retest history. |
| Action "Close run when complete" (p55) | UNVERIFIED | No open run in the data to show the close form. | Open run. |
| Guardrail "evidence must identify build/version and environment" (p55) | PARTIAL | Build yes, environment no (see header). | As above. |
| Checklist "search/filtering / drawers" (p55) | MISSING | No run search or filter; no run detail page (rows anchor to `#run-id`). | Filter and run drawer. |

## SCR-047 Bugs & Defects (PDF p56)
Routes: `/qa` (open bugs), project QA defect register, `/projects/41f1a273…/qa/bugs/4c81f22a…`. PRESENT: 20 (KPI tiles with links, severity and status filters, bug detail, reproduction, evidence, linked task, fix/retest history, assign developer, severity change with reason, triage, move to fixed/wontfix, search).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Evidence" (p56) | PARTIAL | Kind select is link or note only; no screenshot or file upload. | Upload. |
| Action "QA verify/reopen/close" (p56) | UNVERIFIED | Bug is Open, so the move list shows only fixed/wontfix. | A fixed bug. |
| Guardrail "Only QA can mark verified resolution" (p56) | UNVERIFIED | Not exercised; UI hides verified for an open bug. | Test as non-QA role. |

## SCR-048 Regression, Compatibility & Performance (PDF p57)
Routes: `/qa` (Test suites, Device x Browser, Performance notes) and project QA (budgets, incidents, schedules). No dedicated screen; it is cards. PRESENT: 17.

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Regression runs" (p57) | PARTIAL | Only a suite tile ("No runs recorded") and the generic run list; no regression-runs list or filter. | Filter by suite. |
| Main "Performance results" (p57) | PARTIAL | "Performance notes" text plus budgets/metric attach; no results table or trend; none recorded. | Results view. |
| Guardrail "Unsupported devices/configurations must be explicitly recorded" (p57) | MISSING | Untested cells show "—"; "Add Device" just links to /projects. No way to mark a configuration unsupported. | Unsupported record with reason. |

## SCR-049 Production Readiness & Release Candidate (PDF p58)
Routes: `/projects/41f1a273…/release` (per-project gate) and `/production-readiness` (platform deployment readiness, a different subject). PRESENT: 14 (10-line hard-gate checklist with gate flags, "Would refuse" decision, sign-off button, release hold and lift, security summary, performance summary, open blockers, RC tile, payment-verified tile).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Rollback readiness" (p58) | PARTIAL | No tile; line "Rollback plan recorded: Unknown". | Tile. |
| Main "Deployment dependencies" (p58) | PARTIAL | "No handover has been prepared, so there is nowhere to record them yet." | Not dependent on a handover. |
| Main "Rollback plan" (p58) | PARTIAL | Same dead end. | Same. |
| Main "Post-deploy smoke checklist" (p58) | PARTIAL | Same dead end; "a report, not a gate". | Same. |
| Action "Record post-deploy verification" (p58) | PARTIAL | Only ticking a smoke checklist on a handover; no dated verification record. | Verification record. |
| Guardrail "Phase 7 also requires final 20% payment verified before launch" (p58) | DECIDED | Gate fails ("M4 — Go-live has no live invoice") but an "Override the payment gate" form lets the owner record a reason (Decision F1, docs/AGENCYOS_ADMIN_BUCKET_F_PLAN.md row F1). | None if accepted. |

## SCR-050 Finance Overview (PDF p59)
Route: `/finance`. PRESENT: 19 (5 KPI tiles, collection rate, period/client/project filters, income vs expenses chart, payment status, recent invoices and payments, expense breakdown, upcoming payments, quick actions, report downloads, verification queue link, create invoice, record claim).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Date filter" (p59) | PARTIAL | Presets only (all time, 30/90/365 days); no custom range. | Custom range. |
| Main "Top project revenue" (p59) | PARTIAL | Northwind shows ₹0 while Total Received is ₹21,000 and invoices exist. | Fix the source of the figure. |
| Guardrail "Financial totals use verified records" (p59) | PARTIAL | Total Received ₹21,000 comes from invoices' paid amount (source: sum of `paid_minor`). Payments page shows ₹9,999.99 captured, of which ₹7,499.99 verified; Payment Status card says Paid ₹7,000. Three different "received" figures. | Base totals on verified payments. |

## SCR-051 Invoices (PDF p60)
Route: `/invoices` (row menu, reminder drawer, filters tried). PRESENT: 14 (status tiles/chips, client/project/GST/milestone filters, search, saved views, sortable columns, last sent, reminder drawer, linked milestone, create from milestone, PDF link, 30/20/30/20 ladder on the plan page).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Purpose "milestone, change request, maintenance renewal, new service, zero-amount invoices" (p60) | PARTIAL | No type column or filter; creation here is only "from a milestone". | Invoice type column/filter and creation paths. |
| Main "PDF preview" (p60) | PARTIAL | "Open PDF" link only; no inline preview or drawer. | Preview. |
| Action "Send by email + official project WhatsApp" (p60) | PARTIAL | Row menu has Open invoice/PDF/project/client only. Detail: "Send on WhatsApp is not available", "Email is not configured"; sending is record-only. | Send action and configured channels. |
| Action "Issue reminder" (p60) | PARTIAL | No manual reminder action; automatic reminders plus "record that a reminder was sent". | Send-reminder control. |
| Action "Void through permissioned flow" (p60) | PARTIAL | Not in the list; present on invoice detail only. | List-level void. |
| Checklist "bulk actions" (p60) | MISSING | No row selection. | Bulk select. |
| Checklist "export" (p60) | MISSING | No export on this registry (CSV is on /finance). | Export button. |

## SCR-052 Invoice Detail / Create (PDF p61)
Route: `/invoices/{1d6052a4 (draft), 436ac54e (issued, GST), e79d1ab0 (partially paid)}`. PRESENT: 16 (number/status, billed-to profile, billing mode, linked milestone, line items, subtotal/GST/total, pay-into account, send history, reminders, payment claims, refunds, record payment, issue and share, void, PDF link).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Purpose "composition … tax mode, billing profile, line items" (p61) | PARTIAL | No create/compose page. A draft comes from a milestone; only Due date and Issue are editable. | Composer. |
| Header "Issue/due dates" (p61) | PARTIAL | Header shows only DUE; issue date not on the detail page. | Issue date. |
| Main "Tax calculation" (p61) | PARTIAL | One "GST @ 18%" line or "Tax ₹0.00"; no CGST/SGST/IGST split, no reason for zero tax. | Tax breakdown. |
| Main "PDF preview" (p61) | PARTIAL | Link only. | Inline preview. |
| Action "Generate" (p61) | PARTIAL | Created from the list; no generate step here. | Generate control. |
| Action "review" (p61) | MISSING | No review step (draft goes to issue); "Pending approval (0)" chip exists on the list only. | Review step. |
| Action "resend" (p61) | PARTIAL | "Record that it was sent" only; real send blocked (no WhatsApp token, no EMAIL_FROM). | Real resend. |
| Action "attach client proof" (p61) | PARTIAL | Proof is a URL field, no upload. | File upload. |
| Action "Update billing details only through controlled profile change" (p61) | MISSING | Billing block has no edit or link to a profile change flow ("Manage" goes to payment accounts). | Link/flow to change the profile. |
| Guardrail "Never expose secret payment/account credentials beyond intended display fields" (p61) | PARTIAL | Full account number and IFSC are shown unmasked in the admin UI. | Confirm intent or mask. |

## SCR-053 Payments (PDF p62)
Route: `/finance/payments`. PRESENT: 17 (5 KPI tiles, payment list with status/method/captured/verified, search and status chips, saved view, reconciliation with findings, bank CSV import, close period, claims section, invoice link, captured vs verified separation).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Main "Payment detail" (p62) | MISSING | Row links to the invoice; no payment detail page or drawer. | Payment detail. |
| Main "Proof/evidence" (p62) | PARTIAL | Only claims carry a proof link; ledger rows show none. | Evidence on the payment. |
| Action "Send to verification" (p62) | PARTIAL | No explicit action; claims enter the queue on creation. | Explicit step or accept. |
| Action "Reject with reason" (p62) | UNVERIFIED | Decision panel appears only when a claim exists (0 here). | Claim data. |
| Checklist "filters" (p62) | PARTIAL | Search and status only; no method, date or client filter. | More filters. |
| Checklist "export" (p62) | MISSING | No export. | Export. |

## SCR-054 Payment Verification (PDF p63)
Route: `/invoices/verify` (queue empty: "Nothing awaiting a decision"). PRESENT: 9 (pending count, oldest waiting, verified/rejected counters, queue empty state, decision history card, refresh and realtime, permission gate, human-only decide form in source).

| item | status | what the app shows instead | what would be needed |
|---|---|---|---|
| Header "Amount/client/project/invoice" (p63) | UNVERIFIED | Claim card in source shows all four with links; not rendered. | A claim. |
| Header "Submitted proof" (p63) | UNVERIFIED | "Open proof" link plus image preview for image URLs only (source). | A claim. |
| Header "Bank/gateway reference" (p63) | UNVERIFIED | Shows the payer-typed "Reference"; no cross-check against bank statement lines. | Cross-check. |
| Main "Evidence preview" (p63) | UNVERIFIED | Image extensions only; PDFs are link-only. | A claim. |
| Main "Invoice/project context" (p63) | UNVERIFIED | Links only; no inline invoice total or outstanding. | Inline context. |
| Action "PAYMENT VERIFIED" (p63) | PARTIAL | No such button: a Decision select (confirm/mismatch/reject) plus "Answer the claim". | Dedicated button. |
| Action "REJECT / NEED MORE EVIDENCE" (p63) | PARTIAL | Reject and mismatch exist; no "need more evidence" request to the client. | Request-evidence action. |
| Action "Add verification note" (p63) | PARTIAL | "What you checked" and "Why" fields stand in; no free note. | Note field. |
| Guardrail "actor, timestamp, evidence reference are immutable audit data" (p63) | UNVERIFIED | Decision history shows "verified by X · time" and "Checked: …" in source; none to render. | A decided claim. |
| Checklist "search/filtering" (p63) | MISSING | No search or filter on the queue or history. | Filters. |

---

## Cross-cutting (slice C)

- Data-gated views: the local seed cannot show most of Phase 4-5 populated states (prototype builds, design assets, implementation plans, repository live data, environments, claims). Re-run this audit after seeding one project through each flow; the 52 UNVERIFIED rows turn into PRESENT or PARTIAL then.
- Search/filter: present on /qa bugs, /invoices, /finance, /finance/payments; absent on prototype builds, development portfolio, plan, repository, builds, test cases, test runs, payment verification queue.
- Bulk actions and export: none on /invoices or /finance/payments; /finance has CSV downloads.
- Drawers: reminder history drawer on invoices is the only contextual drawer found in this slice. No drawer for builds, runs, payments or claims.
- Realtime: "Connecting / Updated just now / Refresh" present on /development, /qa, /design, /invoices/verify.
- Permission-denied: "You don't have access to this" shown for member on /finance, /invoices/:id, /production-readiness. `/invoices/verify` for member redirects silently to /dashboard (inconsistent). /qa, release and repository are readable by member.
- Dead-end copy that depends on earlier steps: plan-less "request clarification", handover-less rollback/smoke/deployment dependencies, baseline-less test plan.
- Data integrity seen in the seed (may be test artefacts): invoice e79d1ab0 shows Paid ₹2,999.96 with "Payments (0)"; six invoices carry a paid amount without matching verified payments.
- Screens grouped rather than standalone: SCR-038 (inside Design overview), SCR-048 (cards on /qa and project QA), SCR-046 and SCR-045 (same project QA page), SCR-049 split between project Release tab and an unrelated platform /production-readiness page.
- Not checked: mobile/tablet layout and keyboard/a11y for these screens; server-side enforcement of actions.
