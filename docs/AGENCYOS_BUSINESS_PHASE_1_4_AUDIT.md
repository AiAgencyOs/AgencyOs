# AgencyOS — Business Phase 1–4 Forensic Audit

**Audit date:** 2026-09-28
**Repo state audited:** `origin/main` @ `aa9d59a`, unless a step explicitly notes it depends on an unmerged PR.
**Companion file:** [`AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json`](AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json) — one row per step, all required fields.
**Method:** four parallel forensic passes (one per Business Phase), each required to cite file:line evidence and distinguish real behavioral tests from static regex-over-source tests. No prior status doc, code comment, or agent claim was trusted without independent verification.

**Explicit phase-numbering note:** "Business Phase 1–4" here means Lead-to-Close / Onboarding+M1 / UI-theme-lock / Full-UI+Prototype+M2 — **not** the separate "Complete Development Roadmap" phase numbers used elsewhere in this repo (tracked in `docs/phase-4-implementation-traceability.md`, with six open, unmerged PRs #524–#530). Where the two overlap (Business Phase 4 ≈ roadmap "Phase 4"), this audit used only what is actually on `main` and flagged every place a finding depends on one of those unmerged PRs.

---

## ⚠️ Correction made during synthesis

The Phase 2 sub-audit was run against an unmerged PR branch by mistake and incorrectly concluded the M1/M2 milestone-position bug was "already fixed on main." The Phase 4 sub-audit independently re-verified against the true `main` tip and found:

1. **The bug is NOT fixed on `main`.** `projects.replace_payment_plan` writes milestone positions 0-indexed, but `generateFirstMilestoneInvoice` reads position `1` (M2's row) and `generateM2Invoice` reads position `2` (M3's row). **M1's own invoice generator reads M2's milestone today.**
2. **A second, more severe bug exists only on `main`:** `finance.new_receipt_reference()` lost its `authenticated` grant when receipt generation was added — **every real admin "Confirm Payment" click fails outright, for any milestone**, not just M2.
3. Both fixes exist only in the unmerged PR **#530**.

This is reflected as `BROKEN` in the JSON for steps 2.7, 2.10, 4.25, 4.26 — not the `COMPLETE` the first pass reported.

---

## 1. Completion, test, and production-readiness percentages

These are weighted estimates (COMPLETE=1.0, PARTIAL=0.5, MISSING/BROKEN/UNKNOWN=0), synthesized from the four sub-audits — not a re-verification of every individual step by this compiling pass. Treat as directional, not exact.

| Business Phase | Steps | Actual Complete % | Tested % (real behavioral tests, not regex) | Production-Ready % |
|---|---|---|---|---|
| **Phase 1** — Lead-to-Close | 42 | **~62%** | **~15%** | **~30%** |
| **Phase 2** — Onboarding + M1 + Kickoff | 23 | **~54%** | **~10%** | **~15%** (two BROKEN finance steps drag this down hard) |
| **Phase 3** — UI Theme/Color Lock | 15 | **~60%** | **~5%** (audit found literally every committed test is static regex-over-source) | **~20%** (revision loop is structurally broken) |
| **Phase 4** — Full UI + Prototype + M2 | 27 | **~57%** | **~10%** (only exists in an unmerged PR branch) | **~15%** (M2 gate BROKEN, no APK pipeline, no accessibility/responsive coverage) |

**Why "tested %" is so low everywhere:** every sub-audit independently found the same systemic pattern — the overwhelming majority of this repo's `tests/*.test.ts` files `readFileSync` a migration or source file and assert `regex`/`string` matches against the raw text. They execute nothing. Comments inside many of these files claim "live-verified on a scratch Postgres" — that describes a **one-off manual developer session at write-time**, not something `npm test` reproduces. A genuine, committed, automated live-Postgres test harness (`tests/support/live-postgres.ts`) exists only in unmerged PR #530, and is what actually caught the M1/M2/payment-verification bugs above.

---

## 2. Critical blockers (production-breaking, not just incomplete)

1. **All payment verification is broken on `main`** (2.10, cross-cutting into 4.26). A missing `GRANT EXECUTE` means no admin can confirm any payment, for any milestone, right now. **Fix: merge PR #530.**
2. **M1 and M2 invoice generators read the wrong milestone row on `main`** (2.7, 4.25). Financial-correctness bug — if any invoices have already been generated in production under this code, they may have billed the wrong amount. **This needs a human to check actual issued invoices; I have not done so and don't have production DB access.**
3. **Phase 3's design revision loop is structurally dead** (3.13). `project.design_revision_opened` has zero event subscribers anywhere. A client-requested design change can be recorded but nothing in the codebase produces the next design direction through any path — automated or manual.
4. **No PM assignment mechanism exists** (2.13) and **no specialist-agent assignment mechanism exists** (2.14) — there is no column, table, or agent recording who owns a project operationally. Combined with `project_manager`/`ui_designer`/etc. mostly being human-operated roles rather than live agents, "PM becomes the client's one owner" is not something the system can currently enforce or even record.
5. **No lead-routing algorithm exists** (1.3) and **no closing-signal detection exists** (1.39, by deliberate design — human judgment only).

## 3. Major missing flows

- Web-form/email/Facebook-lead-form inbound ingestion (1.1) — only WhatsApp is wired.
- Automatic identity-resolution/dedup classification (1.2) — only manual same-contact merge exists.
- Discount audit trail (1.27) and payment-structure catalog (1.28) — neither exists at all.
- Invoice-to-client communication (2.8) — invoices are generated but nothing pushes them to the client; portal is pull-only.
- Kickoff package as a structured artifact (2.22) — only a free-text evidence reference is captured.
- User flow mapping (3.4) and UI/UX direction analysis as a distinct step (3.5) — both entirely absent.
- Responsive-variant tracking (4.6) and accessibility criteria (4.7) — absent at every layer (design, QA, prototype).
- APK/native prototype build pipeline (4.16) — does not exist; also a genuine external blocker (Apple/Google signing credentials).
- Development handoff package as a consolidated artifact (4.27) — does not exist.

## 4. Broken flows (code exists, behavior is wrong)

- **2.7 / 4.25** — M1/M2 invoice generators read the wrong milestone (off-by-one, 0- vs 1-indexed).
- **2.10 / 4.26** — payment verification fails for a missing grant.
- **3.3** — `required_sections`/`dependencies` columns exist with a versioned baseline mechanism, but nothing writes them except direct SQL.
- **3.13** — design revision loop has no subscriber; a revision request goes nowhere.

## 5. Mock-only / deliberately-scoped-down flows (not bugs — named as intentional design decisions in the code itself, but worth re-confirming as business decisions)

- **1.9** — lead qualification score is a permanently-null column by explicit decision (ADM-88).
- **4.5 / (Prototype states)** — only 5 of 12+ required screen states are trackable, by explicit schema docblock decision.
- **4.2** — Figma integration is read-only by design; no write/compose capability, honestly refused rather than faked.
- **1.26** — exactly one active commercial offer per org, by explicit decision (ADM-98), not a richer catalog.

## 6. Untested flows

Nearly everything marked `PARTIAL` or `COMPLETE` with `verification_status: NOT_VERIFIED` in the JSON — the large majority of both phases. The only steps with genuine behavioral test evidence found across all four audits: `tests/crm-ingest.test.ts`, `tests/lead-conversion.test.ts`, part of `tests/the-sales-agent-under-pressure.test.ts` (the schema-execution portion), and the finance/M1/M2 pipeline as exercised by the live-Postgres harness that exists only in unmerged PR #530.

## 7. Security risks

- **1.22** — a DB trigger (`objections_agent_writes_no_answer`) correctly prevents the AI from recording its own objection response as authoritative — a real, structural safeguard worth noting as a positive finding, not a risk.
- **2.13/2.14** — absence of a PM/specialist-agent assignment record means access-scoping to "who should see this project's data" has no onboarding-time anchor; worth a follow-up RLS/permission review once assignment is built.
- No sub-audit found a new injection, auth-bypass, or tenancy-leak vulnerability beyond what's already documented elsewhere in this repo's gap-tracking system — this pass was scoped to workflow completeness, not a full security review.

## 8. Data risks

- **2.7/4.25/4.26** — the financial-correctness bug above is the primary data-integrity risk in this entire audit. Recommend checking real production invoice records before/alongside merging the fix.
- **1.2** — no automated identity resolution means duplicate/fragmented lead records are possible; mitigated by the system never auto-merging (a safe default, but not a solution).

## 9. Agent gaps

The most important cross-cutting finding from the Phase 1 audit: **there is a real, enabled, LLM-driven Sales agent** (not a stub) handling intent-reading, qualification-coverage, objection-reading, follow-up composition, and quotation drafting across eleven distinct job workflows with real multi-provider model calls. But **every agent from Phase 2 onward (`project_manager`, `ui_designer`, `ui_prototype`, `finance`, `quality_assurance`) is either disabled or has an empty tool list** — what runs Phase 2–4 today is deterministic backend code and Postgres functions invoked by human clicks, not autonomous agents, regardless of what the registry *defines*. Any "PM Agent" or "Finance Agent" language elsewhere in this document should be read as "the human operating that role in the Admin Panel," not an LLM loop.

## 10. Admin gaps

- No PM/specialist-agent assignment UI (2.13/2.14).
- No kickoff-package composer (2.22).
- No dedicated screen-content-definition form for Phase 3 (3.3).
- No design-revision trigger control (3.13) — even a manual "regenerate directions" button doesn't exist.
- No development-handoff package view (4.27).

## 11. WhatsApp gaps

- Only inbound WhatsApp is wired for lead capture (1.1); web-form/email/FB-lead-form are unconnected enum values.
- Invoice issuance has no outbound WhatsApp notification (2.8).
- The official kickoff message cannot currently be sent by the system at all — **BLK-003** (no production WhatsApp number) and **BLK-007** (no email channel) are open, real, external blockers, not code gaps (2.23).
- WhatsApp project groups are, by necessity, a fully manual human-attested workflow — Meta's Groups API is unavailable to this deployment (error 131215) — this is correctly modeled as manual, not faked as automated (2.15).

## 12. Finance gaps

- See Critical Blockers #1 and #2 above — these are the dominant finance findings.
- Payment-verification outcome vocabulary is incomplete: only `VERIFIED`/`REJECTED`/`MISMATCH` exist; `NEEDS_MORE_INFO` and `PARTIAL` do not exist at all; `DUPLICATE` exists only as an insert-time constraint error, not a verification-time decision (2.10).
- Discount audit trail and payment-structure catalog are both entirely missing (1.27, 1.28).

## 13. UI/prototype gaps

- Only 5 of 12+ required screen states are modeled (4.5), no responsive variants exist anywhere (4.6), no accessibility criteria exist anywhere (4.7).
- Color-option generation produces exactly one palette per theme direction, not 2–3 alternatives per direction, with no code path to add more (3.7).
- No requirement/feature-to-screen traceability beyond screen×state coverage (4.8).
- No named `UI_VERSION_X_APPROVED` / `PROTOTYPE_VERSION_X_APPROVED` events exist — approval is real but represented by status fields, not first-class named records (4.14, 4.24).
- No APK/native prototype pipeline exists (4.16) — partly a genuine external blocker (signing credentials), partly unbuilt infrastructure.

---

**See also:** [`AGENCYOS_PHASE_1_4_IMPLEMENTATION_PLAN.md`](AGENCYOS_PHASE_1_4_IMPLEMENTATION_PLAN.md) for the dependency-ordered plan to close these gaps.
