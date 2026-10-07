# Phase 8 part B: manual actions and honest blockers

Nothing in this change deploys, writes to GitHub, sends to a client, creates an invoice or verifies a payment. These need a person.

1. **Apply the migrations** `20261105500000` to `20261105530000` with the normal `db:push`. They are additive (new tables, doors, one trigger on `projects.maintenance_plans` that only affects plans with a linked invoice).
2. **Wire the lines the parent owns** (not done here): append `...PHASE_EIGHT_ENG_WORKFLOWS` to the runnable workflow list in `app/api/jobs/run/workflows.ts`, and render `<PhaseEightBPanel>` from `app/(internal)/projects/[projectId]/page.tsx` (query: `readPhaseEightBView(projectId)`).
3. **Set the SLA policy** (Admin, in the panel). No SLA is assumed; until set every SLA reads "unknown".
4. **Enable the agents you want to try** (`bug_fix`, `regression_test`, `finance`, and the development specialists the Orchestrator would route to) in the Admin agent controls. All are installed disabled, and none has run on a real model: needs a funded model key. Until then routing records `held`.
5. **Writing and testing the code** happens outside AgencyOS (no repository access from these agents). A person submits the exact 40-character commit.
6. **Independent QA** is a person other than the commit's author, recording results with evidence for that exact commit. A failing result opens a defect; a defect-linked fix also needs the existing independent retest (`qa.record_retest`).
7. **Release**: after an independent Admin approves the exact commit, a person deploys through the normal process and records the deployment reference and smoke evidence in the panel. No rollback or smoke automation exists; keep the rollback plan the author recorded.
8. **Maintenance invoices**: accept the Finance proposal, then create the invoice with the existing invoice composer (or `create_change_request_invoice`) at the quoted total, then link it to the plan cycle in the panel. Payment is verified only through the existing Admin payment-verification door.
9. **Reminders**: the Finance agent drafts text only. Send it through the existing reminder channel with a person's approval.
10. **Gate exceptions** (billed plan activating before verified payment): an Admin requests, the owner (a different person) approves; it expires within 90 days.
11. **Wired by part C**: PM announcers for the `project.maintenance_*` events and `finance.maintenance_billing_proposed` (internal channel only), and the SLA-breach sweep (see `docs/phase-8c-implementation-log.md` for the owner steps: apply `20261109000000` and `20261109100000`, set the SLA policy and the stall threshold, publish a catalog version).
12. **Part C wiring the parent owns**: render `<PhaseEightCPanel projectId={projectId} view={await readPhaseEightCView(projectId)} />` from `app/(internal)/projects/[projectId]/page.tsx` (imports `./phase-eight-c-panel` and `@/modules/projects/phase-eight-c-queries`), and link the client portal page `/portal/[projectId]/maintenance` from the portal project page.
