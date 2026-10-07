# Phase 7c implementation log

Completes the buildable gaps that Phases 7b and 8A left behind: the Phase 8A sweeps nothing called, a client's support message becoming a ticket, and four Phase 7 leftovers (ClientActionRequest, a Failure Queue, an automatic DRAFT handover package, a client financial statement). Everything is deterministic: no credential, no model, no external system, nothing sent to a client.

## What exists

| Item | Where | Proof |
|---|---|---|
| Scheduled Phase 8A sweeps | `projects.sweep_phase_eight_health`, `sweep_checkins_due`, `sweep_message_support_tickets`, `sweep_draft_handover_packages` (`20261112000000`, `20261112200000`); `sweepSupportAndHealth` in `src/modules/orchestrator/sweeps.ts` (also calls the existing `sweep_support_sla`); ONE call in `app/api/jobs/run/route.ts` | verifier §1-2, `tests/phase-seven-c-handlers.test.ts`, `tests/phase-seven-c-structure.test.ts` |
| Check-in due detection | table `projects.cs_check_in_due_notices` (append-only, one per check-in), event `customer.check_in_due`; the notice carries the answer of `check_in_eligibility` (relationship category) | verifier §1b |
| Support ticket from a client message | `projects.open_support_ticket_from_message` (service role) + `message.received` subscriber `projects:openSupportTicketFromMessage` + job kind `support_ticket.open_from_message` + `runEventJobs` block | verifier §2 |
| ClientActionRequest | `20261112100000`: `p7c_client_action_requests`, `p7c_client_action_events`; doors `create_client_action_request`, `resolve_client_action_request`, `settle_client_action_request`; client-safe read `client_action_requests_for_client`; portal page `actions/`; Admin panel | verifier §3 |
| Phase 7 Failure Queue | `projects.p7_failure_queue` (derived, nothing stored); `/operations/phase-seven-failures` and the project panel | verifier §4 |
| Automatic DRAFT handover package | `projects.create_draft_handover_package_for_validated` (service role) + `project.production_validated` subscriber `projects:createDraftHandoverPackage` + job kind `handover.create_draft` + `runEventJobs` block; catch-up `sweep_draft_handover_packages` | verifier §5 |
| Client financial statement | `projects.client_financial_statement`, `_payments`, `_totals` (SECURITY DEFINER, the caller's own account); portal page `statement/` | verifier §6 |

`scripts/verify-phase-seven-c.sql`: 195 live checks on a scratch Postgres (`KEEP=1 scripts/apply-migrations-locally.sh`, then `psql -f`; it rolls back). Phase 7 fixtures are driven through the real doors (the Phase 6 evidence is the only thing seeded, with triggers off). `scripts/redproof/phase-seven-c.py`: 104 controls, each removed from the LIVE definition (or its table/trigger/policy/grant dropped) inside a copy of the verifier, all 104 watched fail (a mutation that matched nothing raises NO-OP and is reported). TypeScript: 16 handler/sweep tests and 41 structure tests.

## Decisions worth knowing

- **A ticket opens only for the label `support_request`, in a PROJECT conversation, in an ACTIVE workspace.** `crm.conversations.kind = 'project_group'` is the project conversation. The post-project account thread (`kind = 'client_account'`) opens nothing: it names no project, and no rule for choosing one was invented. A message with no intent label opens nothing. The intent is written by the Sales agent's reader, which is asynchronous (and may not label project-group messages at all), so a young unlabelled message is `intent_pending` (a success that opened nothing) and the cron sweep opens the ticket if the label arrives within three days. The door re-reads the message row under the job's organization: the event payload is only a subject id.
- **A due check-in is noticed, never actioned.** The sweep writes one notice per check-in and emits one event. It does not complete, skip, reschedule or message. The notice says whether a relationship contact is allowed now and why not (an open P1, a recent check-in, a withdrawn consent), read from the existing eligibility function.
- **The health sweep reuses `record_health_snapshot`.** A snapshot is written only when the derived status changed, a paused or closed workspace is not read, and a replay writes nothing.
- **The draft handover never invents the checklist.** The contractual deliverable list is a person's record: without it the door creates nothing and says `contract_deliverables_missing`; once it exists the catch-up sweep creates the draft. Validation and the M4 gate are re-read at creation, never taken from the event. The package has no creator, is never submitted, reviewed, approved or delivered.
- **A client answer is a claim.** `submitted` is not `confirmed`: a person with delivery rights confirms it by writing what they checked (the same rule as a portal handover request). Sending a claim back clears it (the event row keeps it) and shows the client the person's note; the internal confirmation note is never in the client read.
- **Overdue is derived**, never stored, and nothing chases the client. The Failure Queue lists an overdue open request; a settled one is never overdue.
- **The Failure Queue is a read.** A failed deployment leaves it when a later attempt exists, a failed validation when a later run passed, an incident when closed, an approval when decided. The age for a stale approval is the caller's. A handover review's age is read from its review-requested event (falling back to the package's creation).
- **The statement counts only verified money.** Outstanding is `total - verified`: money a client reported that nobody verified is shown as awaiting verification and is NOT counted as received; a refunded payment is not listed; a void invoice owes nothing; a draft or an invoice awaiting approval does not exist for the client. It changes nothing: no trigger, no write, and the verifier hashes every invoice and payment before and after.
- **The archive's portal policy is honoured.** A read-only portal still shows requests and the statement but takes no answer; an expired portal shows neither (proved by stubbing `p7b_portal_access` inside the verifier's transaction and restoring its live definition).
- **Two-layer rules.** Where a rule is held by a door check AND a table CHECK or trigger (the secret refusal, the kind list, the one-live-request index, the deadline, the settled-request identity guard, the tenancy trigger), the door-layer mutation leaves the lower layer raising, so the verifier fails with that error rather than the nice outcome. The door-layer outcomes are asserted (`contains_secret`, `already_open`, ...) in the green run. Where two door-level guards cover each other (the client check and the account filter), the red-proof removes both and says so in its name.
- **One tick, five doors.** The brief asked for one function and one call line; `sweepSupportAndHealth` also runs the late-label ticket sweep and the draft-handover catch-up, because both would otherwise wait for an event that already passed.

## Existing tests updated

`tests/the-thread-remembers-its-beginning.test.ts` pins the full `message.received` subscriber list; it now lists `projects:openSupportTicketFromMessage` as the ninth.

## Not built, and why

- **Mounting the UI** on the internal project page and the client portal project page (shared files, not edited): P7-M020. Nothing was rendered in a browser (P7-M017 applies).
- **A page for the check-in notices.** They are in `projects.cs_check_in_due_notices` and the event stream; Customer Success has no screen for them yet.
- **Reminders for an overdue client action** and any message to the client: nothing here sends. A person tells the client.
- **Wiring the post-project account thread, and monitoring alerts, to tickets** (see the decision above).
- **A receipt as a downloadable document** (P7-FIN-06 stays PARTIAL for the file).
- **A daily/weekly/monthly cadence.** Every door is idempotent and runs each tick; the tick frequency is the deployment's choice (docs/phase-8a-manual-actions.md M-3).
- **Handover completeness of the auto draft.** The draft's items are pending; a person supplies every artifact and the existing review/delivery doors apply.
- **Enabling any agent, deploying anything, a live run with a real intent label.** Needs credentials and an owner decision.
