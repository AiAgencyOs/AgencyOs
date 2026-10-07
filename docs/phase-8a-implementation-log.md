# Phase 8A implementation log: Customer Success, Support, Upsell, post-launch Sales

Branch base: `fix/p0-ai-cost-fixes` (7b44f724). Scope and statuses: `phase-8a-implementation-traceability.md`. What needs a person: `phase-8a-manual-actions.md`.

## What was built

Deterministic database doors, gates and records; an Admin panel and an overview page; five internal-channel announcements; and three stand-in-proven agent workflows. Nothing sends to a client, quotes, prices, discounts or approves.

### Migrations (`supabase/migrations/`, range 20261105000000 to 20261105499999, all additive)

| File | Contents |
|---|---|
| `20261105000000_phase_eight_opens_from_a_completed_project_through_an_intake.sql` | shared wiring helpers; `phase_eight_settings` (+ `p8_setting` defaults, `set_phase_eight_setting`); `phase_eight_intake` (P8-GATE-001..008), `phase_eight_gate_waivers` (owner-only, append-only), `phase_eight` workspace; `p8_build_intake`, `fill_phase_eight_intake` (service role), `waive_phase_eight_gate`, `start_phase_eight`, `set_phase_eight_state` |
| `20261105100000_a_support_ticket_is_classified_covered_clocked_and_closed_by_evidence.sql` | `support_tickets` (CHECKs make new scope uncoverable, a how-to defect-free, a technical close confirmation-bound), `support_ticket_events` (append-only), `support_reply_drafts`; doors to open (idempotent by source message), classify, assign, link root cause, advance, record client confirmation, escalate, acknowledge, draft/send-record/discard replies; `record_support_proposal` (service, agent); SLA state + `sweep_support_sla` (injectable clock, stamped once); `client_support_tickets` (client-safe) |
| `20261105200000_customer_health_is_derived_check_ins_are_outcomes_and_renewal_is_never_silent.sql` | `customer_health` / `customer_health_status` (derived, signals shown, no score), `customer_health_snapshots` (append-only history, written only on change), `recovery_plans`, `cs_check_ins`; snapshot, recovery, check-in doors; `check_in_eligibility`; `sweep_maintenance_renewals`; `support_queue` read; a trigger so the workspace opens with a first check-in and a first health read |
| `20261105300000_an_expansion_opportunity_has_evidence_a_person_qualifies_it_and_nobody_quotes_here.sql` | `sales.phase_eight_opportunities` (no price column, a price trigger), `record_phase_eight_opportunity` (agent detects, person records), `qualify`, `hand_off` (via the existing `sales.open_renewal`, value 0), `close`; the recovery-first hold; `customer_success_overview` (organization-wide, health derived on read); drops the DDL helpers |

Ten event types are declared: `project.phase_eight_started`, `support.ticket_created`, `support.ticket_escalated`, `support.sla_breached`, `customer.health_changed`, `customer.retention_recovery_required`, `maintenance.renewal_due`, `sales.upsell_opportunity_created`, `sales.opportunity_suppressed_for_recovery`, `sales.phase_eight_handoff_created`.

### TypeScript

- `src/modules/projects/phase-eight-queries.ts`, `phase-eight-actions.ts` (one action over a whitelist of doors; one service-role door, the intake refresh, behind an explicit permission check), `phase-eight-proposals.ts` (strict Zod, price/commitment/secret lint, JSON schemas, prompts).
- `app/(internal)/projects/[projectId]/phase-eight-panel.tsx`, `phase-eight-forms.tsx`; `app/(internal)/projects/customer-success/page.tsx` (nested under `/projects` so the nav-reachability test holds).
- `app/api/jobs/run/phase-eight-cs-workflows.ts` exporting `PHASE_EIGHT_CS_WORKFLOWS` (`support.propose_ticket_handling`, `customer_success.draft_check_in_agenda`, `upsell.propose_opportunity`); not spread into `workflows.ts` (the parent appends it).
- Announcers: events in `src/lib/events/catalog.ts` (appended), five handlers in `src/modules/crm/handlers.ts`, templates PM8-M01, PM8-A01, PM8-A02, PM8-RECOVERY, PM8-RENEWAL-DUE in `PM_TEMPLATES` (`src/modules/crm/schema.ts`), the `runEventJobs` block in `app/api/jobs/run/route.ts`.
- `tests/pm-depth.test.ts`: five renderings appended to `RENDERED` (its own "a template was added without a rendering" guard counts `PM_TEMPLATES`). The other Phase 7/8B/9 agents will add entries too: whoever merges adds their renderings to the same object.

## What existed and was reused (survey)

`projects.maintenance_items` and `projects.maintenance_plans` (versioned plan, renewal states vocabulary; migration 20260821260000), `sales.upsell_signals`, `crm.check_in_briefs`, `projects.completion_records`, `projects.handovers`, `projects.release_verifications`, `qa.release_candidates` (Phase 6), `qa.defects`, `projects.change_requests`, `crm.communication_consent`, `finance.invoices`, `sales.open_renewal` (opens a discovery deal from a completed project), the quotation/proposal/discount doors (migration 20261030100000, whose CHECK `discount_decisions_no_autonomous_agent` refuses an agent-decided discount: `scripts/verify-discount-and-payment-structure-local.sql` ends on that expected error), `core.event_types`/`emit_event`/`record_audit`, the PM announcer plumbing. The `support`, `customer_success`, `upsell` and `sales` agents were already defined in the registry and the roster, so the registry was NOT edited and no agent was added.

Findings for the parent: the roster's handoff graph lacks edges the specs imply: Support to Customer Success and Sales; Customer Success to Support and Finance; Sales to Customer Success (the return handoff). They are addable only by editing existing registry definitions and the roster migration together, which was out of this task's allowance. `support` and `customer_success` are enabled at L1 in the roster; `upsell` is disabled by an owner answer.

## Decisions that differ from, or narrow, the spec (each stated in the code too)

- **No stored health, no score, no weights.** Health is derived on read from tickets, SLA stamps, invoices, defects and plans; status is the worst level present (critical, at risk, watch, stable when anything is open, otherwise healthy). Thresholds are owner-confirmable settings with documented defaults. The snapshot table is a dated copy written only by the door and only when the status changes.
- **Cancelled tickets do not count as SLA breaches** in the health read (a ticket raised in error is not a service failure). A breach stamped on a ticket that is later closed still counts for 90 days.
- **Intake gates are waivable only by the owner, with a reason**, except completion (P8-GATE-001) and warranty (P8-GATE-006, decided at start). A waiver shows as WAIVED, not as passed.
- **Escalation is a field and an event on the ticket**, not a row in `core.escalations`: that door is security invoker and forced-RLS, so a service-role SLA breach could not use it.
- **A person records that a reply was sent.** The system never infers a send; the response clock stops only on that record.
- **SLA hours are calendar hours**; no business hours exist in the model.
- **The completion-record read stands in for Phase 7's handoff**; swapping it touches one function (manual action M-6).
- **Opportunity kinds are `change_request` and `new_project` only.** Small defined maintenance is maintenance, not an opportunity (spec rule). The agent records `detected` (or `suppressed` while recovery is due); only a person qualifies, hands off and closes.

## Verification

Run on a scratch Postgres 16 (`KEEP=1` copy of `scripts/apply-migrations-locally.sh` on its own port; only this agent's directory was removed afterwards): all 516 migrations apply (512 plus the four new), the sanity block reports 0 invoker writes without a policy, `core.unguarded_org_fks()` and `core.unfrozen_org_tables()` return 0.

- `scripts/verify-phase-eight-a.sql`: 275 checks, ends `verified OK`, rolls back.
- `scripts/redproof/phase-eight-a.py`: 44 of 44 controls red-proved. Each removes one control from the LIVE definition (a function body via `pg_get_functiondef`, or a constraint, index, trigger or policy) inside the verifier's own transaction; a no-op mutation raises. Controls with two layers are proved in both (the door and the CHECK for client confirmation, duplicate source message, agent price in a reply, opportunity price; the grant and the in-function role check for the service-only sweeps, the intake and the agent doors).
- Every other `scripts/verify-*.sql` was re-run against the same database with the new migrations applied: all still pass (the discount script ends on its documented expected error).
- `tests/phase-eight-a-foundation.test.ts`, `tests/phase-eight-cs-workflows.test.ts` (69 tests, stand-in model and stand-in database), `tests/phase-eight-pm-templates.test.ts` (31 tests).
- `npm run typecheck`, `npm run lint`, `npm test` (whole suite), `npm run scan:secrets`: results in the final report. With `...PHASE_EIGHT_CS_WORKFLOWS` spread into `workflows.ts`, the project page panel and the nav entry applied (each tried then reverted), typecheck, lint and the whole suite also pass.

Not run: a browser. The panel and the overview page are typechecked and linted, not rendered. No load or performance test. No provider, no real model.

## Wiring for the parent

1. `app/(internal)/projects/[projectId]/page.tsx`: `import { PhaseEightPanel } from './phase-eight-panel';` beside the other panel imports, and `<PhaseEightPanel projectId={projectId} />` after `<PhaseSixPanel view={phaseSix} projectId={projectId} />` (the panel renders nothing for a project that is neither completed nor in Phase 8).
2. `app/api/jobs/run/workflows.ts`: `import { PHASE_EIGHT_CS_WORKFLOWS } from './phase-eight-cs-workflows';` and `...PHASE_EIGHT_CS_WORKFLOWS` appended to `RUNNABLE_WORKFLOWS`.
3. `app/(internal)/nav-config.ts`: `{ href: '/projects/customer-success', label: 'Customer Success', capability: 'project.read' },` after the `/projects/escalations` item. The page works without it (it is nested under `/projects`).
4. Schedule the sweeps and call the intake door from Phase 7's completion event (manual actions M-3, M-5, M-6).
5. Merge the `tests/pm-depth.test.ts` `RENDERED` additions with the other phases'.

## Limits worth knowing

- The panel shows invoices only as a health signal (overdue count), not a payment list; there is no single-client page across projects.
- An internal user with write permission can use every Phase 8A door except the owner/admin ones; there is no separate Support, Sales or Developer view.
- A denied cross-tenant attempt is refused but not audited; ticket events carry no correlation id.
- Independent review (the kind that finds what self-review cannot) has not been run on this work; it is the next step before anything is enabled.
