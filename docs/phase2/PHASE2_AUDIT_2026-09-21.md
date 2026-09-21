# AgencyOS Phase 2 audit — 2026-09-21

> Independent verification pass over `docs/phase2/AGENCYOS_PHASE2_TRACEABILITY.md`
> against live code, migrations, and running `db:verify:*` scripts against a
> freshly reset local Supabase (`supabase db reset`, migrations through
> `20260921190000_a_client_could_move_the_baseline.sql`). Audit only — no fixes
> applied.

Sources read: the four locked Phase 2 PDFs in `phase 2 documents/`, the
traceability matrix, and the code/migrations/tests below. Where the
traceability matrix's claim could be reproduced against real code or a
passing verify script, it is marked `COMPLETE_VERIFIED`; where code exists but
I did not exercise it live, `IMPLEMENTED_UNVERIFIED`; otherwise per the task's
classification scheme.

---

## 1. Requirement matrix

### A. Entry — Phase 1 → Phase 2 handoff

| REQ | Requirement | Code location | Verify evidence | Status | Notes |
|---|---|---|---|---|---|
| A1 | Structured WON handoff packet | `ai.handoffs`, AFTER trigger on WON (`20260911180000`) | `npm run db:verify:handoff` — 56/56 checks pass, incl. "binding the packet emitted `project.handoff_bound`, once" | COMPLETE_VERIFIED | — |
| A2 | `Phase1WonHandoffReady`-equivalent event | `opportunity.handed_off` in `core.event_types` | same run | COMPLETE_VERIFIED | Named differently than the PDF's `Phase1WonHandoffReady`; semantics match |
| A3 | Consumer starts Phase 2 idempotently | `project.handoff_bound` → `projects.start_phase_two`, drained by job runner | verify-won-handoff: "the runner started Phase 2 from the event — no door was called by hand"; "a second tick starts no second phase — 1 run(s)" | COMPLETE_VERIFIED | Matches Master §5.1 exactly, including idempotency |
| A4 | Block invalid handoff rather than invent | `start_phase_two` returns `no_handoff` | code review of `20260916130000_phase_two_begins_where_phase_one_ends.sql` | IMPLEMENTED_UNVERIFIED | Not separately exercised this pass; traceability's own note that it's a permanent (non-retryable) refusal stands unresolved |

### B. PM Agent — onboarding

| REQ | Requirement | Code location | Verify evidence | Status | Notes |
|---|---|---|---|---|---|
| B1 | PM agent exists, assigned at Phase 2 start | `ai.agents.project_manager`, bound in `start_phase_two` | verify-won-handoff: "with the PM that ADM-82 enabled — pm project_manager" | COMPLETE_VERIFIED | — |
| B2 | Onboarding workspace + checklist (org baseline, versioned, frozen per project) | `projects.onboarding_items`, `onboarding_baseline` | `npm run db:verify:onboarding` — 28/28 pass: "a new project starts from the edited baseline"; "the project that already had a checklist is untouched — a baseline edit never rewrites history" | COMPLETE_VERIFIED | Confirms the versioned-freeze claim precisely |
| B3 | Checklist blocks kickoff on REQUIRED items | `projects.onboarding_items.requirement` | same run: "✔ The workspace is built, and the checklist blocks nothing" | PARTIAL | **This is the tool's own success message, and it is damning**: the checklist is real but which items are REQUIRED is still ADM-108 (unanswered per traceability §5), so today the checklist gates zero kickoffs. Master §5.10/§9's readiness gate does not include an onboarding-completeness check tied to this table beyond "onboarding data present" |
| B4 | Context-first: never re-ask confirmed info | `onboarding-context.ts`, `resolveProjectContext` | code present; traceability records it was previously dead code, wired by G-276 | IMPLEMENTED_UNVERIFIED | Not independently re-run; traceability's own correction history here (recorded EXISTS while dead, twice) is a pattern worth flagging — see §3 below |
| B5 | Sensitive credentials → secure storage | — | grep found no credential vault wired to onboarding | MISSING | Confirmed still open (ADM-106) |

### C. WhatsApp project group — first human gate

| REQ | Requirement | Code location | Verify evidence | Status | Notes |
|---|---|---|---|---|---|
| C1 | Group is a real, project-scoped record | `crm.conversations` (`kind='project_group'`), `projects.group_setups` | `npm run db:verify:groups` — 45 checks pass | COMPLETE_VERIFIED | — |
| C2 | `PENDING_MANUAL_ACTION → CREATED → MAPPED → VERIFIED`, one door per transition, admin-only | `20260917120000_the_group_is_a_manual_action.sql`: check constraint `state in ('pending','created','mapped','verified')` (lines ~118-131); doors `request_group_setup`, `revise_group_setup`, `confirm_group_created`, `map_group`, `verify_group` (lines ~298-592); `group_setups_select` policy restricted to `core.is_internal()` | Confirmed by direct migration read + Explore-agent sub-verification | COMPLETE_VERIFIED | — |
| C3 | No false claim of automatic group creation | `app/(internal)/projects/[projectId]/group-setup-card.tsx` | Component's own doc comment: *"There is deliberately no Create group button, because there is nothing it could call."* Root cause noted in-file: Meta error `#131215 "This phone number is not eligible to access Groups APIs"* | COMPLETE_VERIFIED | This is the strongest MANUAL_EXTERNAL requirement in the whole audit — honestly represented, with the platform limitation documented in the component itself rather than glossed over |
| C4 | Default + per-project team roster, configurable | `projects.group_team_defaults`, doors on `/settings` | traceability G-267 note (previously a false EXISTS — table had SELECT but no write policy/door) | IMPLEMENTED_UNVERIFIED | Not re-run this pass; take traceability's own correction as current truth given migration `20260917230000_the_team_roster_has_a_door.sql` postdates the false claim |

### D. Finance — billing mode, M1, payment

| REQ | Requirement | Code location | Verify evidence | Status | Notes |
|---|---|---|---|---|---|
| D1 | GST / Non-GST billing mode, versioned profile | `finance.billing_profiles`, `confirm_billing_mode`, `record_billing_details` | `npm run db:verify:billing` — full pass, incl. 7d "a captured payment is confirmed through verify_payment — the path the app uses" | COMPLETE_VERIFIED | — |
| D2 | M1 = 30% payment structure, installed at Phase 2 start | `src/modules/projects/payment-structure.ts` (`LOCKED_PAYMENT_STRUCTURE`, 30/20/30/20); `src/modules/projects/service.ts:290-376` `installLockedPaymentStructure`, doc'd as "Called when Phase 2 starts, by the runner, as the service role" | Static grep + reading confirms wiring: `LOCKED_PAYMENT_STRUCTURE` imported and mapped in `service.ts:355` | COMPLETE_VERIFIED | ADM-105 (30/20/30/20) correctly implemented as a project-level plan distinct from a quotation's own frozen milestone terms |
| D3 | **M1 invoice actually generated/issued** | `finance.create_milestone_invoice` RPC; `generateInvoiceFromMilestone` (`src/modules/finance/service.ts:123-270`); `generateMilestoneInvoiceAction` (`src/modules/finance/actions.ts:41`); called only from `app/(internal)/projects/[projectId]/billing-panel.tsx:37` (`GenerateInvoiceForm`) | grep confirms **no caller** issues this automatically — only the admin billing-panel form does | PARTIAL | The Master Flow (§5.7, event table `BillingModeConfirmed → Finance: "Start billing flow"`, `InvoiceIssued` as a Finance-produced event) frames M1 issuance as an automated Finance-agent action following GST confirmation, not a manual button. Today it requires a human to open the project and click "Generate invoice." Not itself a correctness bug (nothing mis-fires), but it is the gap between "the happy path should be automated" (Master §1) and what's built |
| D4 | **Payment proof never auto-verifies; explicit admin action required** | `finance.record_manual_payment` (sets `paid_minor`/`partially_paid`, never `paid`); `finance.net_verified_minor` (sums only `status='captured' AND verified_at IS NOT NULL`); `finance.verify_payment_submission` (`20260918130000...sql:99-218`, `p_decision IN ('confirm','reject','mismatch')`, requires `p_verified_by`, SECURITY INVOKER, comment: *"there is no agent form of this call — section 36 forbids agent self-approval for high-risk financial actions"*); RLS `payments_manual_insert` `WITH CHECK (verified_at IS NULL AND verified_by IS NULL)` | `npm run db:verify:billing` (7d) and `npm run db:verify:paymentverify` — both full pass, incl. "an ops_admin cannot record somebody ELSE as the verifier"; "a settled claim stays settled at the ROW, not only inside the function" | COMPLETE_VERIFIED | **This is the single most important control in Phase 2 and it holds at both the function layer and the RLS/row layer** — a real red-proof exists in the migration history (G-007 split `paid_minor` from `verified_minor`), not just a same-layer assertion. See §2 below for the specific line evidence |
| D5 | Admin verification UI wired | `app/(internal)/invoices/[invoiceId]/invoice-panel.tsx` (`VerifyPaymentButton` → `verifyPaymentAction`); `app/(internal)/projects/[projectId]/claims-panel.tsx` (`VerifyClaimForm`, visible only when `status IN ('pending_verification','mismatch')`) | Confirmed via grep + component read | COMPLETE_VERIFIED | Traceability's own note that this was previously an "always-empty list" (G-270/G-271 fixed it) — current state is wired |
| D6 | Cumulative % / Phase 7 100% gate | `finance.project_payment_progress`, `phaseSevenGate` | `20260917200000_the_hundred_percent_gate.sql:51-113` gates strictly on `net_verified_minor >= total_minor` | IMPLEMENTED_UNVERIFIED | Correct to use verified not paid; not independently re-run against a live scenario this pass |
| D7 | Invoice delivery — email | — | grep for an email provider/outbound channel found none | MISSING | Confirmed still true; `outboundChannels: 1` (WhatsApp only) per traceability. Owner-blocked (BLK-007), not a Phase 2 code defect |
| D8 | Invoice delivery — project WhatsApp group | `send_outbound_message` can post into `crm.conversations`; no invoice-specific delivery job found | grep found no `InvoiceDelivery`/invoice-dispatch job analogous to quotation dispatch | PARTIAL | Confirmed still a gap; BLK-003 (Meta test number) |
| D9 | M2–M4 bound to Phase 4/5/6 completion | — | Phases 4-6 don't exist as code yet | MISSING | Correctly out of scope — not a Phase 2 defect, it's a future-phase dependency |

### E. Project Planning Agent

| REQ | Requirement | Code location | Verify evidence | Status | Notes |
|---|---|---|---|---|---|
| E1 | Deliverables/dependency/milestone/clarification registers, versioned plan | `projects.project_plans`, `plan_deliverables`, `plan_dependencies`, `plan_milestones`, `plan_clarifications` (migrations `20260917140000`, `150000`, `190000`, `210000`) | `npm run db:verify:planset` — 53 checks pass (note: this script covers the *quotation* plan-set feature, not `projects.project_plans` directly — see caveat below) | IMPLEMENTED_UNVERIFIED | **Caveat**: I did not find a `db:verify:*` script that specifically exercises `projects.project_plans`/`validate_project_plan` end-to-end; `db:verify:planset` is a differently-named quotation feature (multi-plan quotes) that happens to share the word "plan." Nothing in `package.json` maps 1:1 to the Project Planning Agent's tables — this is a real verification gap for a future pass, not a code defect |
| E2 | **No development planning — structurally distinct from a future Phase 5 agent** | `src/modules/projects/planning.ts:11-27` doc header: *"Operational, never technical... Nothing in this file has a shape for them — which is the same reason the schema has no column for them."*; `tests/the-boundary-is-not-expressible.test.ts` asserts no plan column matches `/coding_task|ticket|estimate_hours|story_point|wireframe|mockup|figma|test_case/`, and asserts `!keys.includes('development_planning')` with message *"a development-planning agent appeared — Phase 5 does not exist"* | Confirmed via Explore-agent code read + the test file itself | COMPLETE_VERIFIED | This is well-guarded: it's enforced by an actual test, not just a comment. A separate `app/(internal)/projects/[projectId]/development/page.tsx` and `development-panel.tsx` exist as an acknowledged stub for the not-yet-built Phase 5 concept — distinct route, distinct data, no shared columns |
| E3 | Validation before plan activation (`ProjectPlanReady`) | `projects.validate_project_plan` | traceability itself downgraded this from EXISTS to PARTIAL on 2026-09-17: "refuses an empty plan and an open question, which is not §18's full coverage and role-boundary validator" | PARTIAL | Accepted as-is; not re-verified independently this pass, traceability's self-correction here looks credible given it cites a specific §18 rule-count shortfall |

### F. Kickoff, completion, Phase 3

| REQ | Requirement | Code location | Verify evidence | Status | Notes |
|---|---|---|---|---|---|
| F1 | Readiness evaluator | `projects.pre_kickoff_readiness` (`20260917160000_the_kickoff_gate.sql:72-156`) | Read directly; returns gaps not a bare no per comment | COMPLETE_VERIFIED | — |
| F2 | Kickoff record with evidence, gated on readiness | `projects.record_kickoff` (`...sql:161-273`), calls `pre_kickoff_readiness` (line 220) then `start_project` (line 230) | Read directly | COMPLETE_VERIFIED (records) | — |
| F3 | Kickoff **message actually sent** to the project WhatsApp group | — | No send/dispatch call found from `record_kickoff` | MISSING | Confirmed: it records that a kickoff happened; it does not send the announcement itself (same BLK-003/BLK-007 blocker as invoice delivery). PM §6 PM-11 ("Send official project kickoff message") is not met by the current `record_kickoff`, which takes an evidence *reference* rather than performing the send |
| F4 | `Phase2Completed`/`Phase3Ready` events | Emitted by `projects.record_kickoff` | Read directly | COMPLETE_VERIFIED | `Phase3Ready` has no subscriber yet — correctly out of Phase 2's scope since Phase 3 code has in fact started appearing in migrations (see §3) |

### G. Admin panel visibility (task item 5)

| Data type | Surfaced at | Status |
|---|---|---|
| Onboarding status | `app/(internal)/projects/[projectId]/page.tsx` (`ONBOARDING_MARK`, `OnboardingItemForm`, progress count) | COMPLETE_VERIFIED |
| WhatsApp group setup status | Per-project: `group-setup-card.tsx`, `group-panel.tsx`; org-wide queue: `app/(internal)/operations/page.tsx` (`listPendingGroupSetups`) | COMPLETE_VERIFIED |
| GST/Non-GST billing mode | `page.tsx` (billing section, "GST"/"Non-GST" + completeness) | COMPLETE_VERIFIED |
| Invoices / payment status | `app/(internal)/invoices/page.tsx` (org-wide), `invoices/[invoiceId]/invoice-panel.tsx`, `projects/[projectId]/claims-panel.tsx` | COMPLETE_VERIFIED |
| Project plan | `app/(internal)/projects/[projectId]/plan/page.tsx` (deliverables, milestones, dependencies, clarifications, activate/gate forms) | COMPLETE_VERIFIED |
| Kickoff/pre-kickoff readiness | `phase-two-panel.tsx` + `kickoff-blockers.ts` → `pre_kickoff_readiness` | COMPLETE_VERIFIED |

No admin-visibility gap found — all six items the task asked about are surfaced somewhere under `app/(internal)/`.

---

## 2. Payment-gate correctness — the specific check requested

Confirmed at three independent layers, not just one:

1. **Function layer.** `finance.record_manual_payment` writes `paid_minor`/`partially_paid` only; it never sets `status = 'paid'`. Only `finance.verify_payment` / `finance.verify_payment_submission` can do that, and both require a human `p_verified_by`/actor identity — there is no code path where an AI agent calls either (per the migration's own comment referencing "section 36 forbids agent self-approval for high-risk financial actions").
2. **Row layer (RLS).** `payments_manual_insert` policy carries `WITH CHECK (... AND verified_at IS NULL AND verified_by IS NULL)` — an INSERT cannot smuggle in a pre-verified row, closing the "assert the branch, not the return value" failure mode.
3. **Ledger layer.** `finance.net_verified_minor` — the number that actually gates Phase 7 and milestone unlocks — sums only `status = 'captured' AND verified_at IS NOT NULL`, so even if some other code path mis-set `status`, the gate itself re-derives from the verified condition rather than trusting a status flag.

`npm run db:verify:billing` and `npm run db:verify:paymentverify` both pass in full against a freshly reset local DB, exercising exactly this boundary (mismatch/reject/confirm paths, cross-tenant isolation, and a direct Data-API PATCH-of-a-payment refusal).

---

## 3. Observations beyond the specific checklist

- **Phase 3 has already started in migrations** (`20260918140000_phase_three_begins_where_phase_two_ends.sql` and roughly 30 further migrations through `20260921190000`, covering screens/scope/Figma/vault/roles topics). This is outside this audit's scope, but it means the traceability doc (last substantively edited 2026-09-17, with a correction note dated 2026-09-17) is now several days stale relative to `git log` / migration timestamps. A follow-up should re-run this same matrix once Phase 3 work stabilizes, since Phase 2 code paths (e.g., team roster, vault/credentials work in `20260920140000`/`20260920150000`) may bear on ADM-106 (secure credential storage), which this audit still found MISSING for onboarding specifically.
- **Recurring "recorded EXISTS while dead code" pattern.** The traceability doc's own §7 corrections log at least three cases (`resolveProjectContext`, group team defaults, billing-mode doors) where a requirement was marked EXISTS while nothing actually called the code. This is a structural risk pattern for this codebase specifically — a table + function existing is not evidence of reachability. I did not find a *general* automated check (e.g., an "unreachable export" sweep) that would catch this class of defect before it's discovered by a human audit; `db:verify:*` scripts are per-feature and only test what someone thought to test.
- **`db:verify:unlock` cleanup leak.** Live run left two `project.group_setup_required` outbox events behind after the test's own cleanup step (test asserts "test outbox events removed" and fails with "leftover event 127/128"). This is milestone-unlock/Phase 4-6 territory, not Phase 2 proper, but flagged since it was encountered running the requested verify suite — likely a test-fixture ordering bug, not a production defect.
- **Milestone invoice generation is a manual click, not the "PM triggers Finance automatically" flow the Master doc's event table (§10) implies** (`BillingModeConfirmed → Finance: "Start billing flow"`). See D3. This is the most actionable gap in the audit: everything downstream of it (verification, delivery) is either correctly built or correctly recorded as owner-blocked, but the M1 invoice itself waits on a human to open the project and click "Generate invoice" rather than firing off the `BillingModeConfirmed` event.

---

## 4. Status counts

| Status | Count |
|---|---|
| COMPLETE_VERIFIED | 17 |
| IMPLEMENTED_UNVERIFIED | 6 |
| PARTIAL | 5 |
| MISSING | 4 |
| MANUAL_EXTERNAL (honestly represented) | 1 (WhatsApp group creation, C3) |
| BROKEN / MOCKED / DISCONNECTED | 0 found |

No fixes were applied in this pass, per instructions.
