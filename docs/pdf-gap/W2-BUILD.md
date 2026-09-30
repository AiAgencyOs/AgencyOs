# W2 build — projects, tasks, plan (migration 20261006200000)

Verifier: `npm run db:verify:w2-projects` (60 checks, live Postgres; CI step added). Test: `tests/a-project-team-is-one-roster.test.ts`.
Storage is unreachable locally: file upload/preview/version/share paths are verified only by source and the pure guard, not in a browser.

| Row | Result | Where / how verified |
|---|---|---|
| SCR-018 payment-gate + owner columns | BUILT | `app/(internal)/projects/page.tsx`; rendered 1536 |
| SCR-018 cards view | BUILT | `?view=cards` toggle, rendered |
| SCR-018 pause/resume with reason on the list | BUILT | `pause-resume-button.tsx` over `setProjectStatusAction` |
| SCR-018 health rule consistency | BUILT | one rule `healthOfProject` (modules/projects/project-health.ts) used by list, Overview, Reports; Overview now "Blocked · 1 task is blocked" (rendered) |
| SCR-018 create control on list | NOT-BUILDABLE | creation is by the header Create menu / won deals by decision; unchanged |
| SCR-019 health + progress % | BUILT | `overallProgress`/`overallProgressLabel`: milestones met else tasks done, same on Overview, Board, Reports, list; header says which |
| SCR-019 phase tiles 1-8, evidence tiles | BUILT | eight tiles (lead, onboarding, design, UI/prototype, development, QA, handover/deployment, customer success) |
| SCR-019 create meeting | BUILT (as request) | calendar door now attaches the meeting to the project (`projects.attach_meeting_to_project`); real booking needs the calendar credential (not local) |
| SCR-020 blocker type/owner/next action | BUILT | columns + `BlockerFields` on every blocked form, card and drawer; verifier A |
| SCR-020 agent marker + verification gate | BUILT | `origin`, verify door, trigger; card badge, drawer section; verifier B |
| SCR-020 valid transitions / link evidence | BUILT (UI) | review only via evidence-gated hand-off in drawer (`ReviewSection`); drawer and drag refuse direct In review. Server `setTaskStatus` still accepts it (other flows use it) |
| SCR-021 submit for review with evidence | BUILT | same section in My Tasks drawer |
| SCR-021 role inheritance | UNVERIFIED | not exercised |
| SCR-022 deadline filter | BUILT | project due date as kind "deadline" |
| SCR-022 record links | BUILT | task, milestone, deadline, upcoming rows |
| SCR-022 reschedule history/notify | NOT-BUILDABLE | no reschedule control exists |
| SCR-023 dependency list | BUILT | Milestones detail panel (earlier unmet milestones, plan gates, blocked tasks) |
| SCR-023 final delivery date | BUILT | `finalDelivery` shared by Milestones and Plan |
| SCR-023 Gantt start dates | NOT-BUILDABLE | no stored start date; windows stay labelled as derived |
| SCR-023 locked 30/20/30/20 triggers | OWNER-QUESTION | see below |
| SCR-024 Meetings folder | BUILT | category `meetings` (db + UI); verifier C |
| SCR-024 folder tree | BUILT | expandable tree of categories and nested folders |
| SCR-024 secrets/credentials guard | BUILT | `file-secrets-guard.ts` on link add, upload (name + text content), task attachments; warning on both forms. Not exhaustive; says so |
| SCR-024 preview/version/upload/share | UNVERIFIED | storage unreachable |
| SCR-025 member count truth | BUILT | `teamSummary` one roster (members + task holders) |
| SCR-025 PM / Specialists KPIs, role distribution | BUILT | tiles + donut by project role |
| SCR-025 permission summary | BUILT | per-role card from capability matrix |
| SCR-025 workload | BUILT | Workload card (open, overdue, blocked, hours) |
| SCR-025 AI agent assignments | BUILT | internal AI Agents card |
| SCR-025 Active now | DECIDED | owner decision 2 |
| SCR-026 open underlying record | BUILT | Recent Activity links |
| SCR-026 export PDF/CSV, restricted roles | UNVERIFIED | not exercised |
| SCR-027 activity count + timeline from audit trail | BUILT | `projects.project_activity` read door (no snapshots), merged with record events, links; Settings count = same feed; verifier F |
| SCR-027 template detail, clone | BUILT | `/settings/templates/[id]`, `clone_project_template`; verifier D |
| SCR-027 pause/cancel in Settings | BUILT | `ProjectStatusForm` in Settings |
| SCR-030 / SCR-031 revision allowance tiles | BUILT | 0 / 3 + "phase has not started" before the phase row exists, used/limit/left after |
| SCR-031 awaiting approval + rejected tiles, list filter | BUILT | scope page, `?crStatus=&crClass=` |
| §7 default phase notifications | BUILT | `projects.project_defaults`, `/settings/project-defaults`, watch uses it when no phases chosen; verifier E |
| §7 standard folder structure | BUILT | same; copied to NEW projects by trigger; verifier E |
| §7 group-name pattern editable | OWNER-QUESTION | shown read-only |

## Owner questions
1. SCR-023: the PDF locks payments at Phase 2 30%, Phase 4 20%, Phase 5 30%, Phase 6 20%, but the app lets the owner set any split totalling 100 (up to 5 rows). Keep the free plan, or lock those four and tie each to its phase completing?
2. §7: the WhatsApp group name is fixed "project // price // start date // client". Should the owner be able to edit the pattern (this renames groups people already belong to)?
3. Blocker kinds (client answer, payment, dependency, decision, access, outside service, other) are my wording — confirm the list.
