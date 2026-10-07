# Phase 1: Orchestrator, Coordination, Quotation Master, Scheduler (and credit notes) gap closure

Date: 2026-11-27. Branch worktree of `fix/p0-ai-cost-fixes` at `1c8fff11`. Rows are in `docs/phase-1-3-implementation-traceability.md` (70 rows edited) and `docs/phase-4-implementation-traceability.md` (P4-FIN-021). Every new database object is named `p1o_` so it cannot collide with another builder's tables or functions.

Source documents re-read (as text) for the thin rows: Orchestrator/Router, Quotation Master, Coordination, Scheduler responsibilities, and the Admin Panel Blueprint (A16/A17).

## What was built

| Slice | Migration | Verifier (live Postgres, red-proofs) | Application |
|---|---|---|---|
| Handoff task contract, prerequisites, bounded retry, escalation, capability registry, workflow task board | `20261127000000_p1o_a_handoff_is_a_task_with_a_contract_a_board_and_a_way_out.sql` | `scripts/verify-p1o-handoffs.sql` (75 checks, 5 red-proofs) | `src/modules/orchestrator/p1o-envelope.ts`, `p1o-coordination.ts`, `p1o-handoff-create.ts`, `p1o-coordination-sweep.ts`; pages `app/(internal)/operations/task-board` and `.../[handoffId]` |
| Scheduling policy, working hours, offer expiry, contact timezone, flags for a person, scheduler metrics | `20261127100000_p1o_scheduling_has_a_policy_flags_for_a_person_and_numbers_to_read.sql` | `scripts/verify-p1o-scheduling.sql` (52 checks, 3 red-proofs) | `src/lib/scheduling/p1o-policy.ts`, `p1o-booking-policy.ts` (read by `booking.ts`), `src/modules/crm/p1o-scheduling-service.ts`, `p1o-meeting-intent.ts`, `p1o-message-handlers.ts`; pages `app/(internal)/meetings/attention`, `.../policy` |
| Quotation policy version, tax from configuration, acceptance as evidence, cancel, typed client responses, negotiation reads, the escalated-approval fix | `20261127200000_p1o_a_quotation_records_its_policy_its_acceptance_its_cancellation_and_its_negotiation.sql` | `scripts/verify-p1o-quotation.sql` (79 checks, 5 red-proofs) | `src/modules/sales/p1o-quotation-service.ts`, `p1o-quote-reply.ts`; pages `app/(internal)/quotations/negotiation/[opportunityId]`, `.../policy` |
| Credit notes | `20261127300000_p1o_an_issued_invoice_is_corrected_by_a_credit_note_the_owner_approved.sql` | `scripts/verify-p1o-credit-notes.sql` (41 checks, 3 red-proofs) | `src/modules/finance/p1o-credit-notes.ts`; page `app/(internal)/invoices/credit-notes` |

Edits to existing files (all small): `src/lib/scheduling/booking.ts` now reads the organisation's scheduling policy instead of constants (an organisation with nothing saved runs on the old 60/15/30-45-60 values, and the existing source-pinning tests still pass); `src/modules/crm/scheduling-request.ts` gains the `date_disagrees` drop (the deterministic date cross-check, see P1-SCHED-013); `tests/a-client-asking-for-a-call-is-noticed.test.ts` had two fixtures whose evidence text contradicted the date they asserted ("kal" with a start of today, "kal" with a start in the past), corrected to evidence that agrees, plus a case that reaches the new drop.

Tests (no database): `tests/p1o-envelope-and-routing.test.ts`, `p1o-scheduling-policy.test.ts`, `p1o-scheduling-cross-check.test.ts`, `p1o-meeting-intent-and-quote-reply.test.ts` (a stub model replaces the keyword classifier through the same port), `p1o-message-handlers.test.ts`, `p1o-coordination-sweep.test.ts`, `p1o-handoff-dispatch.test.ts`, `p1o-migration-discipline.test.ts`.

## Rows closed (EXISTS) and why each is true

Coordination: P1-COORD-003, 004, 014, 018, 021, 023, 025, 026, 027, 028.
Orchestrator: P1-ORCH-003, 004, 005, 006, 009, 010, 018, 019, 023.
Handoff: P1-HANDOFF-005, 006, 008, 024, 028, 043, 046. Admin blueprint: P1-BLUEPRINT-022.
Quotation Master: P1-QUOTE-012, 018, 023, 025, 031, 034, 039, 042, 052, 053, 054, 056, 078, 080, 083, 084.
Scheduler: P1-SCHED-006, 013, 018, 020, 026.
Finance: P2-FIN-038, P4-FIN-021 (credit notes).

Rows that moved but stay open (evidence updated, status unchanged except SCHED-069, MISSING to PARTIAL): P1-COORD-017, P1-ORCH-016, 021, P1-HANDOFF-027, 040, P1-QUOTE-014, 019, 024, 036, 040, 059, 069, 070, 081, 086, P1-SCHED-011, 014, 015, 036, 041, 069.

### A real defect found and fixed (P1-QUOTE-042)

The audit suspected, from reading, that an owner approving an **escalated** approval left the quotation in review for ever. It was reproduced first: `approvals.expire_overdue` raises a new request (`escalated_from`) but `sales.proposals.approval_request_id` kept pointing at the expired one and `sales.sync_proposal_decision` read only that row. The fix makes the sync follow the chain and re-point the quote; the red-proof removes that one step and the quote stays in review again (`scripts/verify-p1o-quotation.sql`, section 1 and its red-proof).

### Human gates, kept

- Approval, the send and payment verification are untouched. A quotation still needs the owner's approval to be sent.
- An acceptance is recorded only by a signed-in administrator (`sales.p1o_record_acceptance` refuses the service role, red-proofed by a test). An agent can only classify a reply (`sales.p1o_record_quote_response` refuses the class "accepted") or raise a clarification (`sales.p1o_raise_acceptance_clarification`).
- A credit note needs the owner's approval (the policy must name the owner) and is issued by a person; the service role is refused. Nothing refunds money or files tax.
- Pause, resume, reassign, retry, reconcile and resolve are administrator doors with a required reason and an audit row.
- The service-role payment-verify exemption and the quarantine rule (renewals Admin-only, max 2) were not touched.

## What stays open, and why

- **Needs a funded model (honest MANUAL_EXTERNAL):** the model-backed run of the scheduling-intent and quote-reply classifiers (both default to deterministic keyword rules, proven with a stub model; a real model plugs into the same port), real meeting analysis, real quote drafting. Nothing here claims a real model ran.
- **Needs credentials or accounts:** every live WhatsApp send (production number, BLK-003), email delivery of a quotation (P1-QUOTE-048) and of scheduling messages (P1-SCHED-058), Google Calendar behaviour (BLK-005), Zoom/Teams adapters (P1-SCHED-057), GST-portal filing.
- **Owner decisions (not built, not guessed):** data classification vocabulary (P1-HANDOFF-010); per-owner calendars and resources (P1-SCHED-017/021); allowed price range, tiers and client-specific pricing (P1-QUOTE-016/017); the value-add offer and its cap (P1-QUOTE-061); maximum deferral, escalation threshold and free-scope cap (P1-QUOTE-059); the shape of invoice corrections (P9-M010: credit notes are built in one reasonable shape, the entity is small to change); whether the five-agent framing is binding (P1-COORD-001, ADM-82); the working hours and dayparts themselves (the page is built, the values are the owner's).
- **Buildable and still open:** the 14-state task machine (P1-COORD-017, a design divergence the documents call "recommended"); the unified result envelope (P1-HANDOFF-012); stamping the policy version on every agent run (P1-ORCH-021); timeout and permission-conflict escalations raised automatically (the causes exist, nothing raises them); a provider-to-AgencyOS reconcile job (P1-SCHED-041) and overlapping-meeting prevention (P1-SCHED-036); scheduling messages composed and sent (P1-SCHED-024/025/027/029); the client-facing clarification message (P1-SCHED-011); reminder-send metrics (needs the delivery receipts of reminders); the timeline-objection recalculation (P1-QUOTE-057); Delivered/Viewed quotation events (P1-QUOTE-069); per-line discount and catalogue references (P1-QUOTE-014/070); a direct proposal column on invoices (P1-QUOTE-036); the printed "18% GST alag se" sentence in `quotation-standards.ts` is still literal text (P1-QUOTE-024).
- **Limits of what was built:** the tax rate is not guessed: with no configuration the quote is flagged and cannot go for approval until an administrator resolves the flag. `daypartWindow` and `p1o_meeting_timezone` exist but the booking path does not call them yet. A negotiation limit that is breached is recorded for the approver, not refused (the owner decides every quote, ADM-07). The new pages were type-checked and linted, not rendered in a browser. `src/lib/db/types.ts` is stale for the new functions and columns; the callers use the loose `p1o-rpc.ts` helper, and `npm run db:types` needs Docker.

## Wiring the lead must add (shared files this change did not edit)

> **Status 2026-11-30:** W-P1O-1 (navigation, negotiation link), W-P1O-2 (runner and events) and W-P1O-3 (staff acceptance) are wired, and `daypartWindow` / `p1o_meeting_timezone` are now called by the booking path under a saved policy. Proof: `tests/p1o-wiring.test.ts`. Not done: the model-backed scheduling classifier still needs a funded model.

**W-P1O-1 navigation** (`app/(internal)/nav-config.ts`, add under the existing groups):

- operations: `{ href: '/operations/task-board', label: 'Workflow task board', capability: 'audit.read', screens: ['A16', 'A17'] }`
- meetings: `{ href: '/meetings/attention', label: 'Meetings needing a person', capability: 'lead.read' }` and `{ href: '/meetings/policy', label: 'Scheduling policy', capability: 'lead.read' }`
- quotations: `{ href: '/quotations/policy', label: 'Quotation policy', capability: 'lead.read' }`; and link each deal's quotations to `/quotations/negotiation/<opportunityId>` from the quotations list row or the version drawer
- invoices: `{ href: '/invoices/credit-notes', label: 'Credit notes', capability: 'invoice.read' }`

**W-P1O-2 runner and events**

- `src/lib/events/catalog.ts`: `HANDLERS` add `'crm:routeSchedulingMessage'` and `'sales:reviewQuoteReply'`; `HANDLER_JOB_KIND`: `'crm:routeSchedulingMessage': 'scheduling_message.route'`, `'sales:reviewQuoteReply': 'quote_reply.review'`; `SUBSCRIPTIONS['message.received']` add both names to the existing array.
- `app/api/jobs/run/route.ts`: `import { routeSchedulingMessage, reviewQuoteReplyMessage } from '@/modules/crm/p1o-message-handlers';` and `import { sweepCoordinationAllOrganizations } from '@/modules/orchestrator/p1o-coordination-sweep';`; drain the two job kinds the way the meeting announcements are drained: `runEventJobs(admin, HANDLER_JOB_KIND['crm:routeSchedulingMessage'], routeSchedulingMessage, 'runSchedulingMessageRoutingJobs')` and `runEventJobs(admin, HANDLER_JOB_KIND['sales:reviewQuoteReply'], reviewQuoteReplyMessage, 'runQuoteReplyReviewJobs')`; and on the idle tick: `const coordination = idleTick ? await sweepCoordinationAllOrganizations(admin) : null;` (it withdraws handoffs tied to an obsolete quotation and expires lapsed meeting offers, per organisation, best effort).
- `app/api/jobs/run/workflows.ts` needs nothing: these are event jobs, not model workflows.

**W-P1O-3 staff acceptance screen**: wherever the staff quotation screen calls `recordProposalResponse(... 'accepted')` (`src/modules/sales/service.ts`, used by the quotation row actions), route an acceptance through `recordEvidencedAcceptance` (`src/modules/sales/p1o-quotation-service.ts`) or send staff to `/quotations/negotiation/<opportunityId>`, which already has the form. Until then the older door still accepts without evidence (it does now snapshot the terms and label the channel `staff_recorded`).

**Also for the lead**

- `package.json` verifier chain (`db:verify:phase4` or its sibling), and `.github/workflows` if the chain is listed there: `-f scripts/verify-p1o-handoffs.sql -f scripts/verify-p1o-scheduling.sql -f scripts/verify-p1o-quotation.sql -f scripts/verify-p1o-credit-notes.sql`. Each rolls back and raises on any failed check.
- `docs/roadmap/roadmap.json` and the master-plan change log (section 10) are not touched. The summary counts at the top of the traceability matrix are not recomputed (other builders edit the same file).
- Two migrations alter shared constraints by reading the live definition and extending it, so a later migration that rewrites the same list from a hard-coded copy would silently drop the addition: `approvals.approval_requests` and `approvals.approval_policies` `subject_type` (adds `credit_note`; migration `20261127300000`), and `sales.proposals_guard()` (adds the `cancelled` branch, patched in place with two anchors that fail loudly if missing; migration `20261127200000`). Re-run the four verifiers after merging any migration that touches those.
- `sales.proposals.status` gains `cancelled`. The generated status union in `types.ts` and any screen that enumerates quotation statuses will not know it until regenerated.

## Verification evidence

On a scratch Postgres 16.14 built from all migrations (port 55453, `KEEP=1`, `psql -v ON_ERROR_STOP=1`), each verifier runs as the postgres role, uses no `session_replication_role`, scopes every count to its own organisation, and rolls back:

- `scripts/verify-p1o-handoffs.sql`: all checks passed, including 5 red-proofs.
- `scripts/verify-p1o-scheduling.sql`: all checks passed, including 3 red-proofs.
- `scripts/verify-p1o-quotation.sql`: all checks passed, including 5 red-proofs.
- `scripts/verify-p1o-credit-notes.sql`: all checks passed, including 3 red-proofs.

A red-proof mutates the LIVE function definition with `pg_get_functiondef` and `replace`, and a mutation that changes nothing raises (`RED-PROOF MUTATION CHANGED NOTHING`). Each control was shown to fail when removed: the prerequisite gate, the uncertain-effect gate, the cycle check, the admin-only rule, the retry bound, working-hours enforcement, offer expiry, the escalation chain step, the cancel-door flag, the evidence rule, the ambiguity rule, the tax-flag gate, the approval check, the credit ceiling and the person check.

Repository gates run in the worktree: `npm run typecheck`, `npm run lint`, `npm test`, `npm run scan:secrets` (results in the final report).
