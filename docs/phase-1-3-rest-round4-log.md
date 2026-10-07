# Phase 1-3 rest-gaps log, round 4 (2026-12-04)

Scope: the buildable PARTIAL / MISSING rows of `docs/phase-1-3-implementation-traceability.md` outside the Orchestrator, Quotation Master, Coordination and Scheduler clusters (another builder has those). Everything was built and verified against a scratch Postgres 16 (port 55474, a fresh copy of `scripts/apply-migrations-locally.sh`, all 592 migrations applied); nothing was run against a funded model, a WhatsApp number, an email provider, Figma or a payment gateway, and no page was rendered in a browser.

All new objects are prefixed `p1s_`. Five migrations (`20261204000000` to `20261204400000`), five SQL verifiers added to the `db:verify:phase4` chain, seven new test files.

## Rows closed (EXISTS), rows updated, rows left

| Row | Now | What exists |
|---|---|---|
| P1-BLUEPRINT-010 (A04 Lead 360), P1-BLUEPRINT-021 and P1-MP3-143 (A15), P1-BLUEPRINT-035 (A29) | EXISTS | Lead 360 Negotiation / Tasks / Audit tabs; `/quotations/negotiation` queue with the limits in force; `/operations/incidents` with runbooks (see below) |
| P1-CRM-020 | EXISTS | lead-scoring weights as versioned data, `/settings/lead-scoring`; P1-CRM-019 and P1-CRM-052 updated, still PARTIAL |
| P1-CRM-045, P1-CRM-063 | EXISTS | Commercial results on `/sales-funnel` |
| P1-DOD-061 | EXISTS | every route answers failures through `routeError`; the ratchet fails on a hand-written error body |
| P2-PM-006, P2-FLOW-026 | EXISTS | PM message templates as versions with Admin approval; P2-PM-028 updated, still PARTIAL |
| P2-FLOW-031 | EXISTS | `docs/phase-2-runbook.md` |
| P2-FIN-046, P3-PM-034 | EXISTS | the stale first-audit matrices now open with a "superseded by this matrix" notice |
| P1-BLUEPRINT-031 | PARTIAL, evidence updated | the engine now reads the policy versions; stacking, category rules, price range and offers stay open |
| P1-QUOTE-018 | EXISTS, addendum | the policy version a discount was judged by is recorded; the quote snapshot lists the versions in force |
| P1-BLUEPRINT-022 (A16 reassign / pause / resume) | EXISTS, verified | already built by the Orchestrator round (`task-controls.tsx`); nothing further built, A29 reuses the controls |
| P1-MP3-027, P1-API-001, -003, -008, -009, -010, -026, P1-GAP-079 | left open | six decisions needed before a REST surface can be built: `docs/rest-api-v1-decision-needed.md` |

28 rows changed in the matrix. The summary table at the top of the matrix was already out of date before this change (it says 831 EXISTS; the rows said 880), because earlier rounds updated rows without the table. It is not recomputed here, to avoid a conflict with the other round-4 builders; after this change the rows count: see "Row counts" below.

## What was built

**1. The quoting and discount engine reads the policy version in force** (migration `20261204000000`, `scripts/verify-p1s-policy-versions-in-the-engine.sql`). For three limits (largest discount, lowest price, largest autonomous quote), an ACTIVE policy version that carries the field is the authority; with none, the organization setting that has always applied still does, so an organization that has activated no version sees no change. The four functions that read or report the limit (`record_discount_decision`, `set_approved_offer`, `apply_approved_offer`, `p1o_limit_breaches`) and the quote's policy snapshot were patched from their LIVE definitions (`pg_get_functiondef` plus `regexp_replace`; a patch that changes nothing raises), not rewritten, so the other builder's changes to those functions are not overwritten. A discount decision records the version that bounded it (`policy_version_id`). The agent lane is untouched: an agent-requested discount is never autonomous whatever a version says (asserted).

**2. Lead-scoring weights as data** (`20261204100000`, `verify-p1s-lead-scoring-weights.sql`). Append-only versions, an owner / ops-admin door with a reason, eleven weights, the eight positive maxima must add up to 100. `scoreLead(inputs, weights)` defaults to the old numbers; each stored score carries the weights version that produced it. No weight value was chosen: they are the old constants until the owner sets others.

**3. PM message templates** (`20261204200000`, `verify-p1s-pm-templates.sql`). Draft, pending review, approved, rejected, superseded; immutable after submit; any writer drafts and submits, only an Admin approves or rejects. A body may use only the placeholders its template offers and may not state an amount, promise, discount or deadline, carry a link or name the model, checked at draft, submit and approval in SQL and mirrored in TypeScript. `resolvePmText` is wired into every PM sender (kickoff, welcome, billing, GST request, the four payment messages, the two reminders, the planning question) with the wording in code as the fallback: an organization with no approved version sends exactly what it always sent, and an unreadable template falls back (logged) rather than stopping a message. No wording was written or changed. One existing test (`the-pm-talks-to-the-client`) pinned the old shape of the payment-message expression and was updated to pin the same choice in its new shape.

**4. A15 and A29** (`20261204300000`, `verify-p1s-negotiation-and-incident-queues.sql`). Both are reads of records that exist (no table added). A15: `sales.p1s_negotiation_queue` and the limits panel; each deal opens into the existing per-deal negotiation record, which was not edited. A29: `ai.p1s_incident_queue` unions failed or refused agent tasks (last 14 days), tasks that may have had an effect nobody can see (until reconciled), open security incidents, open escalations, dead jobs (14 days) and open provider circuits; severity, age, owner, a runbook per kind (`src/lib/p1s/incident-runbooks.ts`) and a history link; the controls are the task board's own, for administrators only; closing a security incident stays on its own screen and Admin-only (owner decision 2026-11-30). Two rail entries, a link from `/operations`.

**5. Lead 360 tabs.** Negotiation, Tasks (agent work), Audit (audit.read only), each a read of rows the caller's RLS already shows, each guarded by `unreadable`.

**6. Commercial results** (`20261204400000`, `verify-p1s-commercial-report.sql`). One read function over a window: average deal value, discount impact, trust-offer, repeat-client and nurture conversion, top objections, source to deal, agent performance. A rate is "no deals", never 0%, when nothing closed in the group; the page says a discount winning more often does not show the discount caused it. The funnel page's old sentence ("deal values, discount impact ... not here") was rewritten to say what is true now and still pins its "average of nulls" phrase.

**7. DOD-061 ratchet.** `src/lib/route-errors.ts` (`routeError`: `{ error, code, correlationId }`, the status each route always used, so no status changed and `error` still carries the old sentence). 38 route files in `app/api` converted (including the three webhook routes and the two Figma plugin routes, which go through `replyError` in `figma-route.ts`; the GST exports go through `gstr-export.ts`). The test now scans every route for a hand-written error body. `app/api/jobs/run/route.ts` was NOT converted (three raw bodies; it is the scheduler entry point other builders edit concurrently), and `handoff/[code]` has no error answers by design; both exceptions are checked, and an exception that stops holding fails the test.

**8. Docs.** `docs/phase-2-runbook.md`, `docs/rest-api-v1-decision-needed.md`.

## Wiring done (shared files touched, one connection each, each with a test that fails if it is removed)

- `src/modules/projects/{pm-client-comms,pm-followups,pm-clarifications,kickoff-send}.ts`: `resolvePmText` (`tests/p1s-pm-templates.test.ts` pins every call and that no sender sends a code message directly).
- `app/(internal)/settings/layout.tsx`, `app/(internal)/nav-config.ts`, `app/(internal)/operations/page.tsx`: tabs, rail entries, one link.
- `app/(internal)/leads/[leadId]/page.tsx`, `app/(internal)/sales-funnel/page.tsx`: the new sections.
- Existing functions patched in the database: `sales.record_discount_decision`, `set_approved_offer`, `apply_approved_offer`, `p1o_limit_breaches`, `p1o_policy_snapshot` (see 1; the verifier red-proofs two of them by reverting the read).
- Not touched: `app/api/jobs/run/route.ts`, `workflows.ts`, `src/lib/events/catalog.ts`, the per-deal negotiation page, anything in the Orchestrator, Quotation, Coordination or Scheduler clusters beyond the five functions above.

## What stays open, and why

- **REST `/api/v1`:** six decisions are needed first (caller authentication, whether an HTTP caller may submit a result or publish an event, the task-state vocabulary, public or internal contract, rate budget, the generic webhook route). `docs/rest-api-v1-decision-needed.md` lists them with the existing door behind each endpoint. Not built.
- **Owner decisions, not mine:** the PM wording itself and who may author it; whether the author of a template version may also approve it (today any Admin may); the lead-scoring weight values; the 14-state lead vocabulary; role names; routing weights.
- **Policy versions:** `stacking` is stored and validated but nothing enforces it; category rules and price ranges need a catalogue (ADM-22); offers.
- **Figma / preview rows:** P3-UID-007 (a preview tied to the Figma version it was taken from) needs a render pipeline (Figma images API, credentials) and a change to the share gate; not built. No Figma write was attempted.
- **P2-PM-028:** the template version used is not recorded on the sent message.
- **P2-FLOW-020 (M1 stage read model), P2-PLAN-018 (planning state read model), P2-FLOW-008 (group provisioner interface), P2-PM-014, P3-FLOW-064 (cost threshold alert), P3-FLOW-022 (reviewer checklist):** judged and not built. The two read models need a decision on how the spec's states map onto facts the schema holds in three places; the provisioner interface would be built and unreachable (nothing would call it); the cost alert needs a place in the shared cron route.
- **Needs a funded model or credentials:** unchanged; nothing in this round calls a model, a provider or Figma.
- **Not checked in a browser:** `/settings/lead-scoring`, `/settings/pm-templates`, `/quotations/negotiation`, `/operations/incidents`, the three Lead 360 sections, Commercial results on `/sales-funnel`.
- **`src/lib/db/types.ts` is stale** for every `p1s_` object (needs Docker); the callers use the narrow loose client view and validate what comes back.

## Verification

- **Scratch Postgres 16, port 55474, KEEP=1 copy of the apply script: all 592 migrations apply**; `core.unguarded_org_fks()` returns 0 rows after the new table and column; no `zztest-p1s` organization left committed.
- **The whole `db:verify:phase4` chain (57 files) in ONE psql session with `ON_ERROR_STOP`, exit code 0**, the five new verifiers last. Live checks in the new verifiers: 60 + 35 + 75 + 39 + 23 = 232, each with negatives (a member, a client user, another organization, a service principal with no signed-in user, wrong state) and positive twins. Red-proofs inside the verifiers rewrite the LIVE function definitions (a mutation that changes nothing raises) and assert the control's absence changes the answer: the version read, the discount-cap read, the floor read, the admin check on two doors, the sum rule, the amount rule, the unapproved-version filter, the organization filter on three reads, the closed-stage filter, the 14-day window, the discount-status filter.
- Fixtures that cannot be built through the real path (a won deal, a quotation in `sent`, a handoff between made-up agents, an agent run without a work class) are inserted with `alter table X disable trigger user` around the insert only (no `session_replication_role`). All counts are scoped to the verifier's own organizations; pg_temp helpers are named `p1s_*`.
- **Gates in this worktree:** see the report that accompanies this log for the final `typecheck`, `lint`, `npm test`, `scan:secrets` and `check:record` results.
- **Not verified:** any rendered page; a real WhatsApp, email, model or Figma call; the new verifiers on the CI database (the scratch server is SQL_ASCII; the PM amount rule was found to mis-match Devanagari under a bracket class there and was rewritten as an alternation, so it is correct under UTF-8 too).

## Row counts

Counted from the rows after this change (the summary table is not touched): see the report.
