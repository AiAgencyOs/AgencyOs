# AgencyOS Phase 1-4 implementation plan (MODE B, starts only after the owner says PROCEED)

Source: `AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.md` / `.json` (main 72d2ccc). Order: shared foundations, then Phase 1 → validate → Phase 2 → validate → Phase 3 → validate → Phase 4 → validate → full automated Phase 1→4 E2E → manual-test package. No phase is FINAL COMPLETE before manual testing.

Rules for every item: additive idempotent migration (apply twice, `notify pgrst, 'reload schema'`); service → `'use server'` action → form; security-definer doors re-check role and audit; a behavioural or live-DB test (not a static regex) per fix; a `db:verify:*` script plus a `verify.yml` step for each new door; fresh-DB-safe fixtures; no secret-shaped literals in tests.

## 0. Foundations (before Phase 1 work)

| # | Gap | Change | Tests / gate |
|---|---|---|---|
| F1 | **Milestone ladder off by one** (audit 2.5, 2.7, 4.25, 4.26) | Migration normalises `projects.payment_milestones.position` to 1-based (re-number existing rows in one transaction, change `replace_payment_plan` to write `ordinality`), then one shared helper reads M1..M4 by position. Re-check `m2_verified_paid`, `phase_five_gate_status`, `finance/service.ts:361,583`, `crm/handlers.ts:2128`, stale comments `crm/service.ts:1146`, `handoff-view.ts:75`. Risk: existing rows and any invoices already billed at 20%; list them first and ask the owner before touching issued invoices. | Live verifier: install plan on a fresh project, run M1 chain, assert 30% advance invoice; M2 asserts 30% development row. Make `db:verify:billing`/`unlock` pass. |
| F2 | Start/kickoff gate accepts any paid invoice (2.11) | `advance_verified` = the advance (position 1) milestone paid, or an approved exception record; owner override must be able to finish kickoff; `group_ready` default must agree with `start_project`. Direct `UPDATE status='active'` blocked by trigger. | Verifier for gate matrix. |
| F3 | Approval policy seed (1.18) | Default `proposal` rung created at org bootstrap and for existing orgs lacking one. | Fresh-org quote reaches approval. |
| F4 | Provider-enabled E2E harness | Model stub for the runner so quote/negotiation/design verifiers run in CI. | `db:verify:quotescope`, `quotedispatch`, `flow01` green in a stubbed run. |

## Phase 1 (Lead-to-Close), 44 rows, 3 complete

1. Lead intake adapters beyond WhatsApp (1.1): web form, manual, referral, Meta lead form endpoints with HMAC/shared secret; one ingest function; a `lead.created` event. Needs owner scope (Q1).
2. Identity resolver with outcomes NEW / DUPLICATE / REACTIVATED / EXISTING_CLIENT (1.2): normalised phone and lower(email) lookup; fix `createLead` raw lookups (B1); `merge_leads` allowed when an opportunity exists.
3. Lead routing (1.3, MISSING): `lead.assigned_agent` record plus rules table; Orchestrator stays off per ADM-82 unless owner decides otherwise.
4. Intent routing (1.5/1.7): `reply.compose` reads intent; spam/support/existing-client messages do not get a sales pitch.
5. Reply guard hardening (1.x): spelled-out and Hinglish amounts, date/duration promises, "free", scarcity, guarantees, invented client names; behavioural tests with the probe strings from P1B.
6. Score: wire `rescoreLead`, fix 15/16 area mismatch (B2, B3).
7. Structured client confirmation of requirements (1.12) with evidence link; approval card fields (1.19); policy verdict model (1.18).
8. Negotiation: objection taxonomy 4→11 categories, alternative payment structures, extras catalog (1.22, 1.26, 1.28), discount cap and reason (1.27).
9. Follow-up: wire `next_follow_up_at` nurture, offer-expiry reminders, win-back by lost reason, closing-signal consumer (1.21, 1.38, 1.39).
10. Acceptance evidence (1.40) and a real handoff packet (names, scope, payment plan, not just ids) (1.41-1.42).
11. Heartbeat: confirm the external schedule is ON in production and add an Operations alarm when no tick for N minutes.

Gate: Phase 1 live verifier chain lead → reply → requirement → quote → approval → send → acceptance → handoff, stub-driven in CI.

## Phase 2 (Onboarding + M1 + Kickoff), 24 rows, 3 complete

1. After F1/F2: automatic handoff from WON to project creation, with an alert for won-but-unconverted deals (2.1-2.4).
2. Replay `plan.breakdown` at conversion / `project.handoff_bound` (2.18); pass the requirement version into the scope baseline.
3. Client-credential path (2.17) once policy is decided (Q5).
4. Per-asset register REQUIRED/REQUESTED/RECEIVED/VALIDATED/MISSING (2.16).
5. Single primary PM (2.13); agent assignment default-closed.
6. Kickoff package renderer and record (2.22); client-facing kickoff message through the governed channel.
7. Payment verification: duplicate status, optional four-eyes (Q3); group-message authorised-participant check.

Gate: M1 invoice → paid verification → kickoff on a fresh DB, plus the owner-override path.

## Phase 3 (UI direction), 16 rows, 1 complete

1. Subscribe `project.design_revision_opened`; write `revision_of/version/origin` and `to_theme_option_id`; make `design.directions` revision-aware (3.13). Repair the two live open rounds.
2. Add `unlock`/resume out of `scope_escalation`, `revision_limit_escalation`, and a recoverable not-ready lock (3.15).
3. Missing-input BLOCKER state writer (3.1).
4. User-flow map (3.4), direction brief using `projects.brand_rules` (3.5), tokens in the client share (3.8), REJECT decision (3.10, Q), reviewer rule (3.9).
5. Live verifier for the ready-lock into Phase 4.

## Phase 4 (UI + prototype + M2), 28 rows, 2 complete

1. Block Phase 4 completion without a locked, approved UI version (4.24); manual-prototype alternative only if the owner agrees (Q4).
2. Fix two artifact rows sharing one UI version (406 on preview pages, 4.18): unique constraint plus `.maybeSingle()` safe reads.
3. PM-to-Prototype task (4.15) and PM milestone confirmation before M2 (4.25, Q1).
4. Prototype feedback classification (4.22) and revision loop; client-authenticated approval (Q5).
5. Development handoff package (4.27): UI version, prototype link, approvals, scope/requirement versions, revision history, M2 status.
6. Client-facing Phase 4 messages through the governed channel.
7. Functional prototype decision (4.16, Q3): wireframe stays or a real web/APK pipeline; the latter needs build/signing infrastructure and a separate plan.

## Final

Automated Phase 1→4 E2E (stubbed provider) in CI; manual testing package under `docs/testing/` with per-step checklist, test data, expected state transitions, and sign-off table; `npm run check:record` counts updated.

## Owner questions to answer first

Listed per part in the audit (P1A 8, P1B 6, P2 8, P3 4, P4 5). The ones that block order of work: lead sources in scope; automatic WON→project; client-credential policy; PM confirmation before M2; what counts as the functional prototype.
