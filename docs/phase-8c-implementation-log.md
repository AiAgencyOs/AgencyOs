# Phase 8 part C: implementation log

Scope: the open gaps of Phase 8 post-launch operations that parts A and B named "other part": the maintenance plan lifecycle, billing rules, event subscribers, scheduling, and the migration safety control. Everything here is deterministic: no credential, model, repository or payment provider ran, and nothing verifies a payment, bills, quotes, discounts, refunds, or sends to a client.

## What was built

| Area | Migration | Doors (all SECURITY DEFINER, empty search_path, explicit grants) |
|---|---|---|
| Catalog (versioned, Admin-set, immutable once published; price lines are data a person enters) | `20261109000000` | `create_maintenance_catalog_version`, `add_maintenance_price_line`, `publish_maintenance_catalog_version` (author cannot publish), `retire_maintenance_catalog_version` |
| Plan enters the lifecycle | `20261109000000` | `open_maintenance_plan` (published version, delivered handover, one live plan per project; no dates until the first cycle is paid) |
| Client acceptance, recorded by staff with a reference | `20261109000000` | `record_maintenance_plan_acceptance` (accepted quote of the same client, or a decline with a reason) |
| Payment gate | `20261109000000` | `activate_maintenance_plan` (an Admin who did not open the plan or record the acceptance; reuses `finance.maintenance_financial_gate` and requires it to be about the first cycle's invoice; table trigger holds the service role too), `reinstate_maintenance_plan`, `sweep_maintenance_plan_payment_gates` (an expired exception on an unpaid plan suspends entitlement: `at_risk`) |
| Usage ledger and overage | `20261109000000` | `record_maintenance_usage`, `reverse_maintenance_usage` (not by the recorder), `maintenance_cycle_usage` (computed), `draft_maintenance_overage` (a draft, priced only from a rate a person entered, otherwise unpriced) |
| Renewal | `20261109000000` | `propose_maintenance_renewal`, `record_maintenance_renewal_decision`, `confirm_maintenance_renewal` (never silent; independent Admin; payment gate on the renewal cycle; a lapsed plan is not revived) |
| Cancellation and churn | `20261109000000` | `request_maintenance_plan_cancellation` (reason code and words required), `decide_maintenance_plan_cancellation` (another Admin; entitlement ends the day it is confirmed; no refund logic), `maintenance_churn_summary` |
| Reads | `20261109000000` | `maintenance_plan_overview` (Admin), `client_maintenance_plans`, `client_maintenance_usage` (a client's own account, plain facts) |
| SLA breach sweep | `20261109100000` | `sweep_maintenance_sla` (service role), `acknowledge_maintenance_sla_breach`, `maintenance_priority` |
| Stall detection | `20261109100000` | `maintenance_work_stall_reasons` (derived), `sweep_maintenance_stalls` (service role), `set_maintenance_stall_policy` |
| Migration / destructive-change safety | `20261109100000` | `record_maintenance_data_safety`; `projects.evaluate_maintenance_gates` gains a `data_safety` gate (eleventh) |

Plans created before the lifecycle (no `maintenance_plan_lifecycle` row) are untouched, and so are work items opened before `projects.maintenance_c_cutover`; the earlier verifiers (8A, 8B) still pass.

TypeScript: eight PM announcers (`PM8-C01..C08`, internal channel only) in `src/modules/crm/{schema,handlers}.ts`, subscribed in `src/lib/events/catalog.ts` and run in `app/api/jobs/run/route.ts`; `sweepMaintenanceLifecycle` in `src/modules/orchestrator/sweeps.ts` (the 8A renewal sweep and the three 8C sweeps); `src/modules/projects/phase-eight-c-{queries,actions,words}.ts`; `app/(internal)/projects/[projectId]/phase-eight-c-{panel,forms}.tsx`; `src/modules/portal/maintenance-queries.ts` and `app/(client)/portal/[projectId]/maintenance/page.tsx`.

## How it was proved

- `scripts/verify-phase-eight-c.sql`: drives every door on a scratch Postgres (roles: owner, ops_admin x2, delivery_lead, member, client_member with `client_account_id`, another organization and another client), rolls back, ends `verify-phase-eight-c: OK`.
- Red-proofs: every control was removed by mutating its LIVE definition (the function text from `pg_get_functiondef`, a policy, a trigger, a grant, a column) in a temp copy of the verifier, with a guard that a no-op mutation raises; 99 mutations, all turned the verifier red (a mutation that left it green exposed a missing test, which was added: e.g. confirm-needs-acceptance, Admin-only reinstate and renewal confirm, churn counts confirmed only, the in-function role check of each sweep, an internal session carrying a client claim). Two-layer rules (the SLA "once per item" filter and its conflict clause) were mutated together.
- TypeScript tests: `tests/phase-eight-c-migrations.test.ts` (shape, grants, creator != approver strings, no price/refund, client functions, priority parity with the router, actions/queries/sweep) and `tests/phase-eight-c-announcers.test.ts` (templates, wiring, payloads). Pinned tests changed because the change legitimately broke them: `tests/phase-eight-pm-templates.test.ts` bounded the 8A announcer block at the new 8C marker (it sliced to end of file), and `tests/pm-depth.test.ts` gained renderings for the eight new templates.

## Owner steps (nothing here does them)

1. Apply `20261109000000` and `20261109100000` with the normal `db:push` (additive: new tables and doors, three triggers on `projects.maintenance_plans` that only affect lifecycle plans, one `create or replace` of `evaluate_maintenance_gates`).
2. Wire the panel and the portal link (see `docs/phase-8b-manual-actions.md` item 12).
3. An Admin drafts a catalog version (entitlement, billing model, any price lines), and a DIFFERENT Admin publishes it. No price is assumed anywhere.
4. Set the SLA policy (8B panel) and, if wanted, the stall threshold (8C panel). With none set, nothing is called late or inactive.
5. For each plan: accept a quote through the sales process, record the client's acceptance with a reference, make the invoice with the existing composer, link it to the cycle, verify the payment through the existing Admin door, then an independent Admin activates the plan.

## Not done, and why

- Real payment verification, invoice creation, quoting of overage, discounts and refunds stay with the existing finance and sales doors (by design).
- No client-facing acceptance, renewal or notification: a client's decision is recorded by staff with a reference; nothing is sent to a client.
- Plan changes of catalog version mid-life (up- or downgrade): a new version means a new plan with its own acceptance; no migration of entitlement between versions.
- The response clock of an SLA (time to first response) is not measured: nothing records a first response. Only the resolution target is swept.
- "Stalled" is a record about a work item, not a new status in its state machine (changing that machine was out of scope and risky for the earlier gates).
- The panel is not wired into `page.tsx` and the portal page is not linked (files the parent owns).
- Node-based live verifiers (`scripts/verify-*.mjs`, which need PostgREST) were not run here; their tables and doors were not changed, and the SQL verifiers 8A and 8B were re-run green.
