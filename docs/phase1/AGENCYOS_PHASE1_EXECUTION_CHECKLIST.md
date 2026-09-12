# AgencyOS Phase 1 — Execution Checklist

**Live document.** Updated during execution, not after it.

Status: `[ ]` not started · `[~]` in progress · `[x]` verified complete · `[!]` blocked ·
`[?]` needs review · `[-]` not applicable

**Rule:** `[x]` requires evidence — a test name, a verify script, a migration, a
command with its output. Never "the file exists", "it compiles", or "the endpoint
returned 200".

**Status of a tracked gap lives in `docs/roadmap/roadmap.json`, not here.** This file
carries the Phase 1 *requirement* and its repository evidence; where a G-number is
named, the roadmap is authoritative for its state and `npm run check:record` keeps the
two honest.

---

## FND — Foundation

### PH1-FND-001 Baseline audit and traceability gate
- **Source** Master Plan V3 §3 (P0-01..P0-10) · Impl/DoD §5 · Gap-Closure Stage 0
- **Repository** `docs/phase1/AGENCYOS_PHASE1_MASTER_IMPLEMENTATION_PLAN.md` §4–§6
- **Evidence** 13/13 Phase 1 PDFs extracted and read; 86 tables, 218 migrations, 175 test
  files, 84 scripts, 20 internal routes enumerated from the tree, not assumed
- **Status** `[x]` — 2026-09-11

### PH1-FND-002 Baseline health is green, measured by exit code
- **Source** Master Plan V3 §3 P0-10 · Impl/DoD §1 ("skipped critical tests are not passes")
- **Found** RED. `tests/a-pin-that-cannot-fail.test.ts` failed: pin ratio 26.17% vs a 26%
  ceiling, caused by the in-flight G-224 test file being 22/22 source-text pins
- **Change** Rewrote that file to *execute* `commitImportBatch()` and `commitImportRecord()`
  with only the database stubbed, instead of reading their source. `commitImportRecord`
  had had no test of any kind — not an execution, not a pin — despite holding six
  outcome branches and two operator-facing refusals
- **Evidence** `npm run check` → **exit 0**; 3,604 tests / 768 suites / 0 fail; pin ratio
  26.17% → 25.98%. Red-proved three ways: removing the `organization.settings` check
  turned exactly 3 authorization tests red; collapsing the phone-keyed refusal turned its
  test red; collapsing the timezone refusal turned its test red. Source restored and
  `diff`-verified byte-identical
- **Also corrected** `docs/roadmap/roadmap.json` baseline counts (said 3,570/761, which
  did not match the run even before this change)
- **Status** `[x]` — 2026-09-11

### PH1-FND-003 Tenant isolation, RBAC, cross-tenant refusal
- **Source** Master Plan V3 §4.1 · Technical Contract §26 · Gap-Closure GC-02
- **Repository** RLS on 88/88 tables; `core.current_organization_id()`, `core.can_write()`;
  `enforce_parent_org` + `freeze_organization_id` per org-scoped FK
- **Evidence** `db:verify:tenancyguards`, `db:verify:tenancy`, `db:verify:security`,
  `db:verify:invokerrls`, `db:verify:untenanted` — all in CI
- **Status** `[x]`

### PH1-FND-004 IDs, correlation, idempotency, audit
- **Source** Technical Contract §3, §19 · Master Plan V3 §4.2
- **Repository** `core.jobs`, `core.outbox_events`, `ai.handoffs.correlation_id`,
  `audit.audit_log` (UPDATE/DELETE rejected by trigger)
- **Evidence** `db:verify:claims`, `db:verify:reaper`, `tests/outbox-discipline.test.ts`
- **Gap** `request_id` and a universal request envelope (Technical Contract §4) are not
  implemented; the app has no REST surface where they would live
- **Status** `[x]` for the parts that exist · `[-]` request envelope (no REST API layer)

## WA — WhatsApp channel

### PH1-WA-001 Inbound: authenticate, deduplicate, normalize, persist
- **Source** Technical Contract §17 · Master Plan V3 §10.1 · Gap-Closure GC-08
- **Repository** `app/api/webhooks/whatsapp`, `src/lib/whatsapp/verify.ts`, `crm.ingest_whatsapp_message()`
- **Evidence** `db:verify:webhook`, `db:verify:ingest`, `db:verify:groupin`, `db:verify:media`
- **Status** `[x]`

### PH1-WA-002 Outbound: consent, 24-hour window, approved templates, rate limits
- **Source** Sales Flow §25 · Technical Contract §24 · Master Plan V3 §10.1
- **Repository** `crm.send_outbound_message`, `src/modules/crm/outbound-window.ts`,
  `crm.whatsapp_templates`, `crm.outreach_limits`
- **Evidence** G-213/214/215/216/217; `db:verify:window`, `db:verify:consent`, `db:verify:outbound`
- **Status** `[x]`

### PH1-WA-003 Inbound STOP withdraws consent
- **Source** CRM Doc 09 §26 ("stop/opt-out state") · Sales Flow §25
- **Evidence** G-222; `db:verify:optout`
- **Status** `[x]`

## SAL — Sales Agent + CRM

### PH1-SAL-001 Lead intake, normalization, source attribution
- **Source** Sales Flow §2 · CRM Doc 09 §4 · Master Plan V3 SA-01
- **Evidence** `crm.leads`/`contacts`; G-204 (ad referral recorded, first touch, frozen)
- **Status** `[x]`

### PH1-SAL-002 Deduplication and identity resolution
- **Source** CRM Doc 09 §5 · Sales Flow §22 · Master Plan V3 SA-02
- **Evidence** `src/lib/import/match.ts` (exact/new/ambiguous); `db:verify:import`,
  `db:verify:returning`; uncertain matches are held for review, never auto-merged
- **Status** `[x]`

### PH1-SAL-003 Lead lifecycle states
- **Source** CRM Doc 09 §6 (14 states) · Master Plan V3 §9.1
- **Repository** 6 states + `nurture` (G-203)
- **Gap** Doc 09 names NEW, CONTACTED, RESPONDING, QUALIFIED, REQUIREMENTS_PENDING,
  QUOTE_DRAFT, QUOTE_SENT, NEGOTIATION, AWAITING_ACCEPTANCE, PAYMENT_PENDING, WON, LOST,
  NURTURE, DISQUALIFIED. The built machine is coarser. §0.2 of the master plan records
  that neither vocabulary is renamed without an Admin decision
- **Status** `[?]` — needs an Admin mapping decision, not code

### PH1-SAL-004 Qualification as structured state
- **Source** CRM Doc 09 §9 · Master Plan V3 SA-04
- **Evidence** `crm.qualification_coverage`; `db:verify:qualification`
- **Status** `[x]`

### PH1-SAL-005 Requirement discovery: facts vs assumptions vs questions
- **Source** Sales Flow §4 · CRM Doc 09 §11 · Master Plan V3 SA-05
- **Evidence** `crm.requirement_versions`; `db:verify:proposal`, `db:verify:extractionretry`
- **Status** `[x]`

### PH1-SAL-006 Requirement confirmation and versioning
- **Source** Sales Flow §7 · CRM Doc 09 §12
- **Evidence** `db:verify:chain`; G-200 (the client confirms the summary)
- **Status** `[x]`

### PH1-SAL-007 Objections classified and retained
- **Source** Sales Flow §13 · CRM Doc 09 §19
- **Evidence** `sales.objections`; G-192, G-201; `db:verify:funnel`
- **Status** `[x]`

### PH1-SAL-008 Negotiation within policy; out-of-policy becomes an approval
- **Source** Sales Flow §15, §17 · Quotation §11.3 · CRM Doc 09 §21
- **Evidence** G-195 (owner-settable limits), G-207, `approvals.approval_policies` money floor
- **Gap** Doc 09 §21's full list (max rounds, max free scope, max deferral) is partly
  recorded as deliberately-not-built; G-195 closed only the four limits with an
  autonomous act to bind
- **Status** `[~]` — partial by decision, recorded in G-195

### PH1-SAL-009 Ambiguous acceptance never closes
- **Source** Master Matrix §12 · Handoff Spec §15 · Sales Flow §19 · Master Plan V3 §13.2
- **Evidence** `record_proposal_response` names the exact version and refuses after the
  validity date; it deliberately does not move the deal stage
- **Status** `[x]` for acceptance · see PH1-CLS-001 for what happens next

## SCH — Scheduler Agent

> **Was wholly missing; the domain now exists.** G-225–G-229 all closed on 2026-09-11,
> the day the audit opened them — roadmap **Phase 27**. What remains is the provider
> adapter (BLK-005), the analysis model call (BLK-001), and the two admin screens
> (A08, A09). Source: the 21-page Scheduler PDF, Master Plan V3 §11 (SC-01..SC-17),
> Handoff Spec interactions 02/03/04, F-05/F-06, E2E-02, admin screens A08/A09.

### PH1-SCH-001 Scheduling domain: intent, mode, date/time, timezone, meeting row — **G-225**
- **Source** Scheduler §3–§4, §6.2, §8, §9.1 · Master Plan V3 SC-01..SC-05
- **Built** `crm.meetings` — org-scoped, RLS, internal-only reads. Lead required; contact,
  opportunity, conversation and the **source message** linked (§3.1 keeps the request as
  evidence). `requested_mode`/`booked_mode` and `requested_start_at`/`confirmed_start_at`
  kept apart (§4.1). `timezone` is an IANA name, not an offset (§4.4).
  Statuses `requested → proposed → booked → completed | no_show | cancelled`, with
  proposal and confirmation deliberately separate (§6.2) and all three ends terminal.
  `crm.enforce_meeting_transition` holds the machine **at the row**. Six CHECKs,
  including `meetings_completion_is_authorized` — completion needs an actor *and* a
  timestamp, so no clock can conclude a meeting happened (§9.1). Six tenancy guards.
  Provider columns present and empty until BLK-005. Pure TypeScript mirror in
  `src/modules/crm/schema.ts`
- **Evidence** `tests/a-meeting-is-a-thing.test.ts` 26/26 (6 suites); `npm run check`
  exit 0, 3,652 tests, 0 fail; pin ratio 25.98% → 25.71%. **Red-proved both ways** —
  drifting the TypeScript turns 3 tests red, drifting the trigger turns the parity test
  red. §E fails if the migration and the TypeScript mirror ever disagree
- **Not yet run live** — `crm.meetings` has no service surface; that is PH1-SCH-002/003
- **Status** `[x]` — 2026-09-11

### PH1-SCH-002 Availability from an authoritative source — **G-226**
- **Source** Scheduler §5 ("never fabricate availability") · Master Plan V3 SC-06
- **Built** `src/lib/scheduling/availability.ts`. `AvailabilityAnswer` has three members
  and only `read` carries slots, so *you may only offer what you read* lives in the
  **type**. A full calendar, a silent one and no calendar are kept distinct — collapsing
  them is how a system says "nothing is free this week" because a token expired.
  `readAvailability()` answers `unconfigured`, not a stub with plausible slots.
  `filterSlots` can only shorten; `rankSlots` puts the lead's constraint before the
  agency's convenience; `offerableSlots` is the single door. At the row,
  `meetings_proposal_was_read` refuses `proposed`/`booked` without a recorded source and
  moment — which turns the rule from behaviour into **data**
- **Evidence** `tests/a-slot-that-was-never-read.test.ts` 27/27, almost entirely executed,
  including the **subset property** over the whole pipeline. Red-proved twice
- **Status** `[x]` — 2026-09-11

### PH1-SCH-003 Booking: recheck, idempotency, provider event id — **G-227**
- **Source** Scheduler §6.3 · Master Plan V3 SC-09 · F-06 · Handoff Spec §8
- **Built** `meetings_booking_key` (one attempt, one booking), `meetings_provider_event_key`
  (one event, one meeting), `meetings_booked_provider_is_evidenced` (a named provider must
  show its receipt), and `crm.book_meeting` — the row locked first, and the idempotent `booking_key`
  check, the state check and the write all under that lock, §5.1's re-check as a **measurement** against
  `availability_read_at` with a ceiling the caller cannot raise, and both unique
  violations returned as named outcomes
- **Evidence** `tests/a-retry-that-books-twice.test.ts` 22/22 with the freshness clamp
  executed against constants read from the migration; `scripts/verify-booking.mjs` (`db:verify:booking`, in CI) fires **eight
  simultaneous bookings** with one key and asserts one survivor — the assertion a source
  read cannot make. Self-red-proving
- **Not built, recorded** Overlap between two *different* meetings: it needs an owner or
  resource column nothing has decided on, and inventing one would be inventing a business fact
- **Status** `[x]` — 2026-09-11

### PH1-SCH-004 Reminders: timezone-aware, stale-safe — **G-228**
- **Source** Scheduler §7.2 · Sales Flow §6 · Master Plan V3 SC-11
- **Built** Two halves that are not redundancy: `crm.drop_stale_meeting_reminders` deletes
  **queued** jobs when a meeting is cancelled, settled or moved; `reminderVerdict`
  re-reads the row at fire time, which is the only thing that catches a job **already
  claimed** when the meeting moved. The dedupe key carries the meeting and lead time but
  **not the start**, so a moved meeting updates one job instead of accumulating two.
  `meeting_reminder_minutes` defaults to 10 — the end of the range Sales Flow §6 records
  the owner naming
- **Evidence** `tests/a-reminder-for-a-meeting-that-moved.test.ts` 30/30, no source read
  at all. Red-proved twice
- **Status** `[x]` — 2026-09-11

### PH1-SCH-005 Completion, evidence, analysis, Sales reactivation — **G-229**
- **Source** Scheduler §9–§10 · Sales Flow §6 · Master Plan V3 SC-13..SC-16
- **Built** `crm.meeting_evidence` bound to the **exact** meeting, with uploader, moment,
  kind and an internal/client-visible split defaulting to the safe side.
  `crm.request_meeting_analysis` enforces §10.1 — explicitly completed **and** evidence
  present; a no-show is ineligible. The no-evidence refusal is the one that matters: a
  model asked to summarise an empty room will still answer, so the refusal lives before
  the job exists rather than in a prompt
- **Evidence** `tests/what-the-meeting-actually-said.test.ts` 20/20; G-225's completion
  rule re-executed here so a later loosening is caught. Red-proved twice — the second
  only after an absence-only assertion was strengthened, having been walked past by a
  `not in (...)` widening
- **The model call** — built 2026-09-12 as **G-239**: a `meeting.analysis` workflow under
  `requirement_collector` (draft work) reads the meeting's facts and its typed evidence,
  files an INTERNAL summary marked PROPOSED with provenance, proposes a requirement version
  on the thread in the thread's own shape, and audits it. Nothing readable parks the job by
  name; a refused answer is retried by the queue. `db:verify:analysis` drives it through the
  real runner in CI
- **Still named, not built** the Sales-reactivation handler that consumes the result
  (§10.4) — no outbox event, no consumer
- **Status** `[x]` — 2026-09-12 (was `[!]` for the model call)

### PH1-SCH-006 The conclusions: cancel, complete, no-show, evidence — **G-237**
- **Source** Scheduler §8 · §9.1–§9.3 · §13.2
- **Built** `crm.cancel_meeting`, `crm.complete_meeting`, `crm.record_no_show`,
  `crm.add_meeting_evidence` — SECURITY DEFINER doors with the tenancy guard explicit,
  audited in their transactions, answering names. A worker cannot complete or no-show
  (`no_actor`); nothing can be concluded before its agreed start (`not_yet_started`); a
  completion note becomes internal evidence and §9.3's chain runs through
  `crm.request_meeting_analysis` with its answer returned; the note is filed through the
  evidence door. Two rules at the row: the timezone (one case-insensitive predicate) and
  no conclusion before the agreed start; `crm.book_meeting` carried forward with one marked
  edit (`invalid_timezone`, from its handler). Doors demand `core.can_write()` like the row
  policies. A09's BLOCKED controls are forms from one table of doors (`lead.write`); a
  settled meeting still takes evidence and a completed one may ask the analysis gate again
- **Evidence** Driven on a scratch Postgres by psql before the app was written and again
  after review (15 behaviours); `tests/a-meeting-is-concluded-by-a-person.test.ts` 17/17;
  `db:verify:meeting-commands` in CI (70 checks, 7 sections). Review: 10 confirmed
  findings, all fixed before the PR
- **Named, not built** the follow-up §8 asks for after a no-show — which situation carries
  it is **ADM-103**, open; the audit row on every no-show says so
- **Status** `[x]` — 2026-09-12

## QM — Quotation Master

### PH1-QM-001 Deterministic pricing from stored inputs and a policy version
- **Source** Quotation §4.1 · Master Plan V3 QM-01
- **Evidence** `db:verify:quotations`, `db:verify:planset`; G-165, G-174, G-193
- **Status** `[x]`

### PH1-QM-002 Discount bounds; excess routes to approval
- **Source** Quotation §4.2 · CRM Doc 09 §17
- **Evidence** `approvals.approval_policies` money floor; G-195
- **Status** `[x]`

### PH1-QM-003 Tax/GST from configuration, never invented
- **Source** Quotation §5.1 · Master Plan V3 QM-03
- **Evidence** G-174 GST line computed from the frozen total
- **Status** `[x]`

### PH1-QM-004 Payment schedule and milestones
- **Source** Quotation §5.2–§5.3 · Master Plan V3 QM-04
- **Evidence** `sales.payment_structures`, `sales.payment_milestones`; G-196
- **Status** `[x]`

### PH1-QM-005 Material change creates a new immutable version; one live version
- **Source** Quotation §7 · CRM Doc 09 §16 · Master Plan V3 QM-06
- **Evidence** `proposals_live_version_key` re-keyed for plan slots (G-166);
  `db:verify:quotescope`
- **Status** `[x]`

### PH1-QM-006 Approval references the exact version and expires
- **Source** Quotation §8 · Handoff Spec §12 · Master Plan V3 QM-07
- **Evidence** `db:verify:approvals`, `src/lib/approvals/expire.ts`, `db:verify:unannounced`
- **Status** `[x]`

### PH1-QM-007 Delivery ≠ acceptance
- **Source** Quotation §10.1 · Handoff Spec §13
- **Evidence** `db:verify:quotedispatch`
- **Status** `[x]`

## CLS — Close gates

### PH1-CLS-001 WON requires an accepted version and payment/exception evidence — **G-230**
- **Source** Master Matrix §12, §17 · Gap-Closure §8 F-13, §10 · Handoff Spec §16 ·
  Coordination §16 · Impl/DoD §33 · Master Plan V3 §13.3, §25, Appendix A
- **Found** `setOpportunityStage()` moved a deal to `won` on `lead.write` and a legal
  transition alone. `lost` required a reason *and* a countable category, held in code
  **and** at the row. Half the separation was already right — `record_proposal_response`
  declines to move the stage, citing Doc 09 §22; the gate on the other side was missing
- **Built** `sales.won_gate_verdict(uuid)` → `no_accepted_quotation` (always),
  `no_payment_evidence` (only when `won_requires_payment_evidence` is `on`), or null.
  `opportunities_won_gate` refuses on it `before update … when (new.stage = 'won' and
  old.stage is distinct from 'won')` — the **transition**, so deals already won are
  untouched (the choice `opportunities_lost_says_why` made with `NOT VALID`, ADM-76).
  The service asks the same verdict for the operator's sentence and **fails closed**
  when it cannot be read. The payment half is a switch that starts off, per every
  source that calls that half *configured*; it accepts only evidence that exists at the
  WON boundary — an approved approval naming the accepted proposal, or a **captured**
  payment (never a `payment_submission`: G-140 made that a claim, not a payment)
- **Evidence** `tests/a-deal-that-is-won-says-what-was-won.test.ts` 20/20 (5 suites);
  `npm run check` exit 0, 3,983 tests, 0 fail. **Review round**: four defects found and
  fixed — `a.status`→`a.state`, the gate now binds INSERT, the quotation's own approval no
  longer counts as a payment exception, and a non-string verdict fails closed. Proven on a
  local Postgres (G-231), not re-read. **Red-proved twice** — neutering the gate
  turns 7 tests red; removing only the fail-closed branch turns exactly the one that
  names it red. `scripts/verify-won-gate.mjs` (`db:verify:wongate`, wired into CI)
  drives the **row** through raw PostgREST and is self-red-proving: every section
  asserts a refusal, so dropping the trigger turns the run red with no mangling pass
- **Run live** — `scripts/apply-migrations-locally.sh` applied all 223 migrations; the gate was
  driven through psql. The PostgREST verifier (`db:verify:wongate`) runs in CI
- **Status** `[x]` — 2026-09-11

### PH1-CLS-002 Structured Phase 2 handoff packet — **G-232**
- **Source** Master Plan V3 §13.4 · Coordination §16 · CRM Doc 09 §33
- **Dependencies** PH1-CLS-001
- **Built** `supabase/migrations/20260911180000_a_deal_that_is_handed_off.sql` —
  `sales.record_won_handoff` writes the §13.4 packet as references over recorded facts into
  `ai.handoffs` (sales → project_manager, born `queued`, one per deal at the row and under the
  lock), emits `opportunity.handed_off` and audits it under one correlation id;
  `opportunities_won_handoff` fires it **at the transition into won** with no project;
  `convertToProject` binds its project (`project_bound`); `sales.won_handoff_packet` is the
  projection. Absences by name in `unresolved` (ADM-72). Phase 2 is not activated: no
  subscriber, both agents disabled — field 8 exactly
- **Review** a seven-agent read of the close path against §13.4 found three defects in the
  first draft (selector divergence between the gate and conversion; a false `approval`
  absence for plan-set winners; the payment rule recorded instead of the evidence) and the
  firing point at conversion rather than at the win — all fixed and proven live
- **Tested** `tests/a-deal-that-is-handed-off.test.ts` (23; the service half and the
  operator's message executed); `scripts/verify-won-handoff.mjs` (`db:verify:handoff`,
  9 sections, in CI)
- **Run live** `scripts/apply-migrations-locally.sh` applied all 225 migrations; the packet,
  the binding, the switched-on gate with a payment exception, the plan-set approval, the
  named absences, the foreign-owner refusal, the correlation trail and the re-won deal were
  driven through psql as an authenticated owner
- **Not built, recorded** no owner survives the handoff (`projects.delivery_lead_id`); no
  acceptance channel or message reference exists to carry; the captured-payment arm is
  unreachable for a new client at the win
- **Status** `[x]` — 2026-09-12

## CO — Coordination Agent

### PH1-CO-001 Task lifecycle
- **Source** Coordination §17 · Handoff Spec §5 · Technical Contract §8
- **Required** CREATED → VALIDATING → READY → DISPATCHED → ACKNOWLEDGED → IN_PROGRESS →
  WAITING_FOR_RESULT → RESULT_RECEIVED → VALIDATING_RESULT → ACCEPTED → HANDOFF_READY →
  HANDED_OFF → VERIFIED → CLOSED; exceptions BLOCKED, RETRYING, FAILED, EXPIRED,
  CANCELLED, ESCALATED
- **Repository** `ai.handoffs.status` has 10 states (queued, accepted, running,
  needs_input, awaiting_approval, rejected, failed_retryable, failed_permanent,
  completed, cancelled)
- **Gap** The two machines are close but not the same; "result received is not
  acceptance" is representable, dependencies and a blocker registry are not
- **Status** `[~]`

### PH1-CO-002 Dependency graph and blocker registry
- **Source** Coordination §18, §20 · Master Plan V3 CO-03, CO-06
- **Status** `[ ]`

## OR — Orchestrator / Router

### PH1-OR-001 Capability registry
- **Source** Orchestrator §6 · Master Plan V3 OR-01
- **Evidence** `src/modules/agents/registry.ts` (13 definitions); `db:verify:definitions`
  proves definitions and installed rows agree in both directions
- **Status** `[x]`

### PH1-OR-002 Routing by policy, health, cost, latency
- **Source** Orchestrator §8–§9 · Technical Contract §13 · Master Plan V3 OR-03
- **Repository** `src/lib/ai/router.ts` resolves a provider from a model id — 112 lines,
  one provider. `ai.routing_policies` exists as a table and **has no reader anywhere in
  `src/` or `app/`**; the only match outside migrations is the generated `db/types.ts`
- **Gap** The ROUTE_SCORE formula, provider health and cost/latency inputs are unbuilt.
  G-129 records the registry being deliberately empty until a provider is chosen, which
  is a different fact from having no consumer for it
- **Status** `[~]`

### PH1-OR-003 Result schema validation before state change
- **Source** Orchestrator §16 · Technical Contract §14
- **Evidence** Zod validation on extraction; `db:verify:definitions`, decoder-safe schema work
- **Status** `[x]`

### PH1-OR-004 Agent activation
- **Source** Master Plan V3 §7
- **Status** `[!]` — BLK-001/BLK-002

## ADM — Admin Panel

### PH1-ADM-001 P0 screens present and backed by commands
- **Source** Admin Blueprint §4, §7, §14
- **Evidence** 23 internal routes (20 before G-234/G-235); `db:verify:uicoverage`
- **Present** A08 (`/meetings`) and A09 (`/meetings/[meetingId]`) since G-234; since G-237
  A09's cancel, complete, no-show and typed-evidence controls are **commands** calling their
  doors (`lead.write`), while book, propose and reschedule stay BLOCKED naming BLK-005
  (Blueprint §8, §11); A08's views are agency calendar days as a grouped list, not a grid; the WON handoff link (§8) at `/handoffs/[opportunityId]` since G-235
- **Gap** A15, A26, A34 missing; A10–A12 have no standalone quotation list; A16–A18 partial;
  the Blueprint's role matrix (A09 narrower than A08) awaits an Admin mapping to the
  repository's roles (BLOCKERS.md)
- **Status** `[~]` — see plan §9 for the screen-by-screen map

### PH1-ADM-002 No UI-only authority
- **Source** Admin Blueprint §11 · Master Plan V3 §15
- **Evidence** Server actions call service functions which re-check role, tenant and
  state; `db:verify:authority`
- **Status** `[x]`

## QA — Verification

### PH1-QA-001 F-01..F-15 as live verifications
- **Source** Impl/DoD §15 · Gap-Closure §8 · Master Plan V3 §18.2
- **Present** F-01, F-02, F-03, F-04, F-07, F-08, F-09, F-10, F-12 have live verifiers;
  **F-06** (`db:verify:booking`, the eight-way race) and **F-13** (`db:verify:wongate`) were
  added by the Scheduler and WON-gate work and run in CI
- **Present** also **F-14** (`db:verify:handoff`, the handoff packet at the win) since
  PH1-CLS-002
- **Missing** F-05 (meeting intent routes — needs the Sales agent, BLK-001)
- **Status** `[~]`

### PH1-QA-002 Negative / false-success matrix
- **Source** Master Plan V3 §19 · Gap-Closure §7
- **Evidence** Self-red-proving verifiers are already the repository's convention
  (`db:verify:planset`, `db:verify:approvals`); `tests/a-pin-that-cannot-fail.test.ts`
  catches the vacuous-assertion species mechanically
- **Status** `[~]` — rows for stale approval, ambiguous acceptance and accepted-quote
  mutation exist; the WON-gate row now exists (`verify-won-gate.mjs` §1, §2, §7); the
  double-booking row now exists (`verify-booking.mjs` §3)

---

## Next dependency-ready unit

The meeting commands shipped as **G-237** (PH1-SCH-006). Everything in the Scheduler that
remains waits on an owner-side fact: the Google Calendar + Meet adapter (ADM-102 granted;
credentials pending — BLK-005), the analysis model call (BLK-001), and the no-show
follow-up (ADM-103, open). The next credential-free units are outside the Scheduler:

The AI provider adapters shipped as **G-238**: one chat-completions adapter configured for
OpenAI, Gemini, xAI and OpenRouter beside the Anthropic one, five in the router, each
registering when its key is placed in the deployment environment. On production the
Anthropic key is present and runtime-verified, which reopens the unit BLK-001 held:

The meeting-analysis worker shipped as **G-239** (PH1-SCH-005 is now `[x]` in full). What
remains in Phase 1 waits on an owner-side fact or an owner decision: the Google Calendar +
Meet adapter (ADM-102 granted, credentials pending — BLK-005), the no-show follow-up
(ADM-103, open), Meta's production number (BLK-003), agent activation (ADM-82 / BLK-002),
and the Sales agent's conversational loop that would consume §10.4's handoff. The next
credential-free unit is therefore the consumer that closes the loop the analysis opened:

**The Sales handoff after an analysis** — §10.4: a typed event when an analysis completes,
carrying the schedule id, evidence references, the proposed version and the unresolved
questions, and a handler that puts the lead back in front of a person (the lead page's
waiting banner, the internal announcement) rather than in front of the Sales agent, which
is not activated. Emitting is cheap; the honest half is a consumer that exists.

## A note on how this checklist is verified

Until 2026-09-11 nothing on this machine could execute a migration, so every `[x]`
against a SQL change rested on regular expressions over source. **That is no longer
true**: `scripts/apply-migrations-locally.sh` applies the full chain to a scratch
Postgres, and the review round showed why it matters — three critical defects that
failed on first execution had passed every regex written about them. A `[x]` on SQL
from here on means the migration applied and the function was driven.
