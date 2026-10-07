# Phase 8A gaps log 1

Closes the buildable rows of the FIRST HALF of `docs/phase-8a-implementation-traceability.md` (everything above the E2E-13 row) that needed no external credential, and builds the records and reads the Customer Success, Support, Upsell and post-launch Sales specs name that no table held. Everything is deterministic: no model key, no provider, no network, nothing sent to a client, nothing priced. Human gates are untouched: no agent can approve, confirm, settle, qualify or designate anything.

Evidence key used by the traceability rows: `VG1` = `scripts/verify-phase-eight-a-gaps-1.sql` (304 checks through the real doors on a scratch Postgres 16, rolls back), `RG1` = `scripts/redproof/phase-eight-a-gaps-1.py` (170 controls, each removed from the LIVE definition inside the verifier's own transaction; 170/170 turned it red; a mutation that matched nothing raises NO-OP).

## What was built

| Item | Where | Proof |
|---|---|---|
| Ticket events carry a correlation id (P8-SEC-004) | `support_ticket_events.correlation_id`, `projects.p8g_correlation()`, a BEFORE INSERT trigger (migration `20261120000000`). One id per request (transaction); older rows keep NULL, nothing is back-filled | VG1 §1, RG1 |
| Denied reads are audited (P8-10, E2E-13 detail) | `projects.phase_eight_access_denials` (append-only, Admin-read), `projects.guard_phase_eight_project(project, surface)`: records a denial in the CALLER's organization, answers `denied` identically for a missing and a foreign project, suppresses a one-minute repeat; `src/modules/projects/phase-eight-access.ts`; used by the portal feedback page | VG1 §2, RG1 |
| Retention visibility (P8-SEC-006) | `projects.phase_eight_retention_status()`, `/projects/customer-success/governance`: per data set the Admin-set Phase 7 retention class that covers it, policy version, rows held, oldest. Deletes nothing | VG1 §3, RG1 |
| Client feedback and goals (CUS outcomes/feedback, P8-ADM-003) | `client_feedback` + `client_feedback_acknowledgements` (append-only), doors `record_client_feedback` (person), `submit_client_feedback` (client portal), `acknowledge_client_feedback`, client read `client_feedback_for_client`. The service role has no door | VG1 §4, RG1 |
| Strategic / VIP designation (P8-ADM-003, CustomerSuccessAccount) | `client_strategic_designations`, Admin-only doors `set_client_designation` / `end_client_designation`; criteria and reason required; changes no health, priority or price | VG1 §5, RG1 |
| Contact preferences (language, channel) | `client_contact_preferences`, doors `set_client_contact_preferences` (person), `set_my_contact_preferences` (client), `my_contact_preferences` | VG1 §6, RG1 |
| Cadence per message category (spec section 11) | `communication_cadence_rules` (Admin-set, no default), `set/clear_communication_cadence_rule`, `projects.can_contact_now_with_preferences` (8D eligibility + cadence gap + avoided channel as a reason + preferred channel/language as advice) | VG1 §7, RG1 |
| Approved knowledge base (Support) | `support_knowledge_articles` (versioned; only a DIFFERENT Admin approves; an approved body is never edited; no price or secret), `ticket_knowledge_citations` (only an approved article), agent door for the support agent to PROPOSE a draft, client read of approved client-safe articles | VG1 §8, RG1 |
| Scope-item comparison (SUP-TST-002) | `ticket_scope_references` against the APPROVED scope version the workspace started from; the support agent proposes, a person confirms; reads `ticket_scope_comparison`; never reclassifies | VG1 §9, RG1 |
| Developer / QA requests (SUP-TST-006) | `support_handoff_requests`: payload built from the TICKET ROW, idempotent, only along roster handoff edges, a person acknowledges and settles. Creates no task | VG1 §10, RG1 |
| Customer Success next-action queue | `projects.cs_next_actions` (derived, fixed rank by kind, stores nothing) and `/projects/customer-success/next-actions` | VG1 §11, RG1 |
| Post-launch Sales discovery brief (SAL-TST-002) | `projects.sales_discovery_briefs` + service-role door `record_discovery_brief_draft` (only for an opportunity a PERSON qualified; must cite real tickets/check-ins of that project; no price) + person door `review_discovery_brief`; workflow `sales.draft_discovery_brief` (`app/api/jobs/run/phase-eight-sales-workflows.ts`) | VG1 §12, RG1, `tests/phase-eight-sales-workflow.test.ts` (27 cases, stand-in model) |
| Metric reconciliation (E2E-14 detail) | overview vs observability vs the next-action queue agree on open tickets, recovery plans, due check-ins, live workspaces, qualified opportunities | VG1 §13 |
| Staff pages and panels | `next-actions`, `governance`, `knowledge` pages, `relationship-panel.tsx` (feedback, designation, preferences, cadence, eligibility), portal `feedback/page.tsx` (feedback, preferences, help articles); one generic form `src/modules/projects/phase-eight-g1-form.tsx` over a whitelist action `phase-eight-g1-actions.ts` | typechecked, linted, `tests/phase-eight-g1-actions.test.ts` (action behaviour against a stand-in database), `tests/phase-eight-g1-structure.test.ts`. NOT rendered in a browser |

## Rows closed in the traceability (first half)

P8-ADM-003 (feedback, VIP) EXISTS; CustomerSuccessAccount (strategic/VIP metadata) EXISTS; P8-SEC-004 EXISTS; Anti-spam cadence/channel/language preferences EXISTS; P8-SEC-006 MISSING to PARTIAL; P8-10 and P8-ADM-005 stay PARTIAL with narrower gaps stated.

## Rows in the SECOND half that this build also satisfies (not edited here: that half belongs to another builder)

- Customer Success spec: "Customer 360 and next-action queue" (next-action queue now EXISTS), "Record outcomes and feedback" (feedback and goals EXISTS), "Required context" language preference (recorded), CUS-TST-004 (preferences exist), activation points (client feedback is recorded; a major-release trigger is still not built).
- Support spec: required context knowledge base (EXISTS), "Compare expected vs actual against scope/version" and SUP-TST-002 (record, propose, confirm EXISTS; no Support workflow calls the proposal door yet), "Answer known questions only from approved knowledge" and SUP-TST-005 (knowledge base and citations EXISTS; the how-to CLOSE door still accepts free-text evidence, unchanged), "Escalate to Developer/QA" and SUP-TST-006 (request records with ticket-row payload EXISTS; no outbox event `DeveloperTaskRequested` / `QAVerificationRequested`, no task is created by design), SUP-TST-007.
- Upsell: UPS-TST-007 (preferences and cadence now exist; the agent still contacts nobody).
- Sales spec: "Focused discovery reusing Customer 360 context" and SAL-TST-002 (door, table, verifier EXISTS; the workflow is proven against a stand-in model only; a live run needs a funded model key: MANUAL_EXTERNAL).
- Master plan E2E-13 (denial now audited once a page calls the guard) and E2E-14 (reconciliation in VG1 section 13).

## What stays open, and why

| Open | Why |
|---|---|
| Live runs of the Sales discovery workflow (and any agent workflow here) | needs a funded model key and an enqueue decision; without a key it fails honestly with `AI_PROVIDER_NOT_CONFIGURED` (tested). MANUAL_EXTERNAL |
| The guard is called by one page only | the project page, Customer 360 page and ticket pages are shared files; the lead adds the one-line call (see the report) |
| The how-to close door still accepts free-text knowledge evidence | `advance_support_ticket` belongs to the 8A verifier; tightening it would change a door the existing verifier pins. A citation can be recorded but is not yet required |
| Preferences are not in the handoff package (P8-GATE-008) | `p8_build_intake` is the Phase 7 reader; not touched |
| No outbox events for the new records | `src/lib/events/catalog.ts` is shared; every new door writes audit rows (with the correlation id) instead |
| Automatic delivery state from the provider (P8 communication) | needs provider credentials and a callback; person-recorded and message-log join remain |
| Retention classes for the communication ledger, feedback, value reports, opportunities | an Admin decision whether to widen the Phase 7 class list; widening it would make every existing archive demand a new policy. The governance page says "No class covers this" |
| Charts on the dashboard, major-release trigger, health weights | out of scope or deliberately refused earlier |
| Nothing was rendered in a browser | all pages and panels are typechecked and linted only |

## Verification

- Scratch Postgres 16 (superuser locally; no `set_config('session_replication_role')` is used inside any function): all 4 new migrations apply after the existing ones; `psql -v ON_ERROR_STOP=1 -f scripts/verify-phase-eight-a-gaps-1.sql` prints "verified OK" (304 checks) and rolls back; `python3 scripts/redproof/phase-eight-a-gaps-1.py` 170/170 red-proved.
- `npm run typecheck`, `npm run lint`, `npm run scan:secrets` clean; full `npm test`: 10536 tests, 0 failures (2169 suites).
- `npm run check:record` disagrees only on derived counts in `docs/roadmap/roadmap.json` (a shared file the lead owns): migrations 556 (file says 552), test files 513 (510), tables 450 (439), tests 10536 and suites 2169 (10473, 2162).
- CI replay was NOT run on a non-superuser server; the verifier avoids superuser-only operations (it disables triggers on tables it owns, which an owner may do).
