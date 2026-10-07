# Phase 1: Orchestrator, Coordination, Quotation Master and Scheduler, round 4

Date: 2026-12-03. Worktree of `fix/p0-ai-cost-fixes` at `72f13016`. Every new database object is named `p1r_` so it cannot collide with another builder's. Rows are in `docs/phase-1-3-implementation-traceability.md`. This round closes what `docs/phase-1-orchestrator-quotation-gaps-log.md` listed under "Buildable and still open" and finishes gating the outbound senders.

## What was built

| Slice | Migration | Verifier (live Postgres 16, rolls back) | Application |
|---|---|---|---|
| A. The 14-state task machine, the unified result envelope, the policy version on every run, timeout and permission-conflict escalations | `20261203000000_p1r_a_...` | `scripts/verify-p1r-orchestrator.sql` (82 checks, 4 red-proofs) | `src/modules/orchestrator/p1r-task-state.ts`, `p1r-escalation-sweep.ts`; task page `app/(internal)/operations/task-board/[handoffId]` shows the state, its history, the next-step form and the run envelopes |
| B. Overlap guard, provider reconcile, scheduling messages as drafts, reminder metrics | `20261203100000_p1r_b_...` | `scripts/verify-p1r-scheduler.sql` (78 checks, 3 red-proofs) | `src/lib/scheduling/p1r-messages.ts` (pure composer, en/hinglish/hindi), `src/modules/crm/p1r-scheduling-drafts.ts`, `p1r-scheduling-compose.ts`, `p1r-draft-store.ts`, `p1r-provider-reconcile.ts`; pages `/meetings/attention` (drafts, reminder numbers, provider checks) and `/meetings/policy` (overlap switch) |
| C. Per-line discount and source, Delivered/Viewed, invoice proposal column, timeline recalculation, GST sentence from configuration | `20261203200000_p1r_c_...` | `scripts/verify-p1r-quotation.sql` (59 checks, 4 red-proofs) | `src/modules/sales/p1r-quotation-service.ts`, `p1r-timeline-recalc.ts`, `p1r-quote-tax.ts`; page `/quotations/negotiation/<deal>` |
| D. Notification gate on the remaining senders | none (application only) | `tests/p1r-send-gate.test.ts`, `tests/email-outreach.test.ts` | `src/modules/finance/p1r-send-hold.ts`; campaign, outreach and both manual invoice sends |

All three verifiers are added to `db:verify:phase4` in `package.json`.

## Rows closed (EXISTS) and why each is true

- **P1-COORD-017, the 14-state machine.** `ai.handoffs.task_state` holds the 14 states and 6 exceptions. The legacy ten-state status and its guard are untouched and remain the authority for the moves they make; a trigger mirrors those moves into the new column, so no existing writer changed and none can be blocked. A direct write to the column must be the next step on the line (or an exception); the door `ai.p1r_advance_handoff` takes only the next step the legacy status agrees with. VERIFIED and CLOSED refuse the service role. Every move is an append-only row with actor, source and time. A red-proof removes the edge check and a direct write leaps to CLOSED.
- **P1-HANDOFF-012, the result envelope.** One function, `ai.p1r_run_result_envelope`, one zod schema that refuses anything else, shown per run on the task page.
- **P1-ORCH-021, policy version on every run.** Stamped on insert from the active routing, approval and data policies ("none" when there are none), never changed afterwards. Runs before the migration carry null and the envelope warns.
- **P1-ORCH-018, extended.** A sweep on the coordination tick raises `timeout` and `permission_conflict` escalations with a recommendation; the work itself is untouched.
- **P1-SCHED-011, 025, 029.** The clarification question, the proposal of times and the confirmation are composed as drafts. A person reads, edits and sends them from `/meetings/attention` through the ordinary outbound path; the service role is refused the door that records a send, and the table's own constraint is a second layer (shown by a red-proof).
- **P1-SCHED-041.** Provider-to-AgencyOS reconcile job: compare, flag for a person, change nothing on either side, record an unreadable provider as unreadable.
- **P1-QUOTE-014, 024, 036, 057.** Per-line discount and source; the GST sentence from the tax configuration (no rate when nothing is configured); `finance.invoices.proposal_id`; the timeline recalculation.
- **Notification gate (P1-BLUEPRINT-032):** campaign, outreach and manual invoice sends ask the rules; all four are client-facing so unreadable rules HOLD the send. A hold sends nothing and records nothing. Outreach asks before the claim reserves anything; a campaign leaves the recipient pending.

## Rows advanced and left open, and why

- **P1-SCHED-036 overlap (owner decision).** The guard is built and tested, and is OFF until an administrator switches it on. `crm.book_meeting`'s own comment says overlap needs an owner or resource column nothing has decided; per-owner calendars (P1-SCHED-017/021) are the owner's. Defaulting it on would also have broken the live CI scripts (`verify-meeting-analysis.mjs`, `verify-booking.mjs` and others book several meetings at the same instant in one organisation). The switch and the reason are at `/meetings/policy`.
- **P1-SCHED-024** nearest alternatives are not offered automatically (the no-availability message is drafted). **P1-SCHED-027** a reader that proposes the selection from a client's reply (live model EXTERNAL). **P1-SCHED-069** provider failure rate, alternative acceptance and retries per request are not measured; reminder delivery now is.
- **P1-QUOTE-069** Resent and NegotiationStarted are not emitted (Delivered, Viewed and DeliveryFailed are). **P1-QUOTE-070** a separate Acceptance table is absent.
- **Owner decisions, not guessed:** data classification vocabulary, per-owner calendars, price ranges and tiers, the value-add offer cap, maximum deferral and escalation thresholds, working hours. `ai.p1r_sweep_handoff_escalations` only expires a task when the caller passes a deadline; the runner passes none.

## Honest limits

- **Not run live:** the Google event read behind the reconcile (`getEvent` in `src/lib/scheduling/google.ts`) was exercised only against a stand-in calendar. With no calendar configured the job reports `environment_missing` and records nothing. Live WhatsApp sends of any draft need the production number (BLK-003); no model ran anywhere in this round.
- **Not rendered in a browser:** the new sections of the task page, `/meetings/attention`, `/meetings/policy` and `/quotations/negotiation/<deal>` were type-checked, linted and covered by source and behaviour tests, not opened in a browser.
- **Languages:** the Hinglish and Hindi wording of the drafts and of the new GST sentences is machine-composed text the owner has not reviewed (like the existing standards translations, which stay behind `quotation_translate_standards`). The drafts are edited by a person before sending.
- **A quote without a configured tax rate** now prints a sentence that names no rate (it used to print "18%"). That follows the existing rule that the rate is never guessed.
- `src/lib/db/types.ts` is stale for the new objects; callers use the loose RPC helpers (`p1o-rpc.ts`, `p13/loose-client.ts`), as in earlier rounds.

## Wiring done (one connection at a time, each with a test that fails if it is removed)

| Connection | Where | Test |
|---|---|---|
| Escalation sweep and provider reconcile ride the coordination tick | `sweepCoordinationAllOrganizations` in `src/modules/orchestrator/p1o-coordination-sweep.ts` (already called on the idle tick of `app/api/jobs/run/route.ts`, which this round did not edit) | `tests/p1r-task-state.test.ts`, `tests/p1r-scheduling-messages.test.ts` |
| Drafts after propose and book | `SchedulingHooks` injected into `proposeSlots` / `bookProposedSlot` from `app/(internal)/meetings/[meetingId]/actions.ts` (lib may not import modules, so the hooks are passed in) | `tests/p1r-scheduling-messages.test.ts` |
| Clarification draft | `routeSchedulingMessage` in `src/modules/crm/p1o-message-handlers.ts` | `tests/p1r-scheduling-messages.test.ts` |
| Tax configuration into the GST sentence | the four `quotationSectionsFor` call sites (`sales/service.ts` x2, `crm/handlers.ts`, `sales/preview-service.ts`) | `tests/p1r-quotation.test.ts` |
| Notification gate | campaign, outreach, both manual invoice senders | `tests/p1r-send-gate.test.ts` |

`app/api/jobs/run/route.ts`, `workflows.ts` and `src/lib/events/catalog.ts` were not edited. New event types (`proposal.delivered`, `proposal.viewed`, `proposal.delivery_failed`) are registered in `core.event_types` by the migration; no handler subscribes to them yet.

## Changes to existing database objects (re-run the p1o verifiers after merging anything that touches them)

- `sales.proposal_item_amount()` now subtracts `line_discount_minor` (zero by default, so no existing line changes).
- `sales.p1o_check_negotiation_limits(uuid)` is replaced to count line discounts; `sales.p1o_proposals_guard()` is patched in place at one anchor that fails loudly if it is missing (the same method the p1o migration used).
- `crm.conversation_messages` gets an `AFTER UPDATE` trigger (`p1r_quote_receipt`), `finance.invoices` a `BEFORE INSERT/UPDATE` trigger and a column, `ai.agent_runs` and `ai.handoffs` insert triggers, `crm.meetings` a booking-time trigger that does nothing unless the rule is switched on.
- The back-fill of `finance.invoices.proposal_id` disables user triggers on that one table for one statement (derived data, not a decision).

## Verification evidence

On a scratch Postgres 16.14 built from all 590 migrations (port 55473, `KEEP=1`), the WHOLE `db:verify:phase4` chain (110 files, one `psql -v ON_ERROR_STOP=1` session, exit code checked) exits 0 with the three new verifiers in it. Each new verifier runs as the postgres role, uses no `session_replication_role`, scopes every count to its own organisation, uses `p1r_` helper names and rolls back. `core.unguarded_org_fks()` returns 0. A red-proof mutates the live function definition with `pg_get_functiondef` and `replace`; a mutation that changes nothing raises. A defect found on the way: a check that read a row in the same statement that changed it saw the old snapshot (fixed by splitting with `\gset`), and one that ordered rows by `now()` (one transaction, one `now()`) was replaced by a count, both found only by running.

Repository gates (results in the final report): `npm run typecheck`, `npm run lint`, `npm test` (11,352 passing), `npm run scan:secrets`, `npm run check:record`.
