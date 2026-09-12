# AgencyOS Phase 1 — Master Implementation Plan

**Generated** 2026-09-11 · **From** the 13 PDFs in `Phase 1 documents/` read in full,
the wider `AgencyOS Documentation/` set, and the repository at `c5959ed`
(+ uncommitted G-224 work).

---

## 0. What this document is, and what it is not

This is the **requirement side** of Phase 1: every requirement the Phase 1 source
PDFs impose, mapped to the code that satisfies it or to the gap that does not.

**It is not a second tracker.** This repository already has one — `docs/roadmap/roadmap.json`,
213 G-numbered gaps, held honest by `npm run check:record`, which fails the build
when the record and the repository disagree. A parallel checklist with its own
statuses would be a second source of truth that goes stale the first time someone
updates only one of them, and §0.1 of `AGENCYOS_MASTER_DEVELOPMENT_PLAN.md` already
ranks the sources.

So the division is:

| Question | Answered by |
| --- | --- |
| What does Phase 1 require? | **This document** + `AGENCYOS_PHASE1_EXECUTION_CHECKLIST.md` |
| What is the status of a gap? | `docs/roadmap/roadmap.json` (the tracker) |
| Is AgencyOS production ready? | `docs/deployment/production-readiness.md` (the single verdict) |
| What changed and when? | §10 change log in `AGENCYOS_MASTER_DEVELOPMENT_PLAN.md` |

New Phase 1 work gets **new G-numbers in the existing roadmap**, continuing from
G-224. That keeps one tracker and subjects Phase 1 work to the same `check:record`
gate as everything else.

---

## 1. Executive objective

A new lead enters through WhatsApp, is identified and deduplicated, qualified by
Sales, has requirements consolidated and versioned, optionally meets, receives a
policy-compliant versioned quotation, passes approval, negotiates through immutable
versions, accepts an exact version, satisfies the payment/exception gate, and reaches
a **governed** WON with a structured Phase 2 handoff packet — with every step
traceable and no false-success path.

Phase 1 ends at the WON boundary. Phase 2 is not activated.

## 2. Locked scope

Five agents: **Sales · Scheduler · Quotation Master · Coordination · Orchestrator/Router**.

The repository's own roadmap uses a different, broader phase numbering (25 business
phases across the whole product). **These are not the same "Phase 1."** Where this
document says Phase 1 it means the PDF scope above; where the roadmap says Phase 8 or
Phase 10 it means a business-lifecycle phase. Nothing is renamed in either direction.

## 3. Source documents

All 13 read in full (extracted with `pdftotext -layout`):

| PDF | Governs |
| --- | --- |
| Agent Responsibility Master Matrix v2 | Ownership matrix, authority boundaries, DoD |
| Sales Lead-to-Close Complete Flow | The 16-stage operating flow, edge-case matrix |
| Phase 1 Agent Interaction & Handoff Spec | Task/result envelopes, 10 interactions, test matrix |
| Technical / API / Data Contract Spec | Identifiers, schemas, webhook/idempotency/error contracts |
| Implementation, Testing & Acceptance / DoD | Build order, F-01..F-15, release gates |
| Final Gap-Closure Specification | GC-01..GC-17 stage gaps, 360 verification, rulebook |
| Phase 1 Admin Panel Blueprint | 34 screens (A01–A34), roles, UI→command contract |
| Phase 1 Master Development Plan V3 | Execution sequence M01–M17, evidence standard |
| Sales / Scheduler / Quotation / Coordination / Orchestrator responsibilities (5) | Per-agent A-to-Z duties and DoD |
| CRM / Sales / Lead Management Spec (Doc 09) | Lead lifecycle, qualification, negotiation, acceptance |

> **Naming collision, recorded deliberately.** The Gap-Closure PDF numbers its stage
> gaps G-01..G-17. The repository numbers its own gaps G-001..G-224. They are unrelated.
> This document writes the PDF's as **GC-01..GC-17** and never as G-0nn.

## 4. Repository architecture (verified, not assumed)

Modular monolith. **Next.js 16** (App Router, React 19, TypeScript 6) on Vercel;
**Supabase Postgres** as database and auth; no microservices, no broker. Background
work is a database job queue drained by cron on `/api/jobs/run`.

```
app/            23 internal route groups, 4 API routes, client portal, auth
src/lib/        auth · authz · db · events · jobs · ai (five provider adapters) · whatsapp · import · pdf · admin · observability · scheduler
src/modules/    crm · sales · projects · finance · identity · approvals · agents · qa · portal
supabase/       227 migrations, 88 tables across 9 schemas, RLS on all 88
tests/          187 files · 828 suites · 4,097 tests (2026-09-12)
scripts/        91 scripts, 77 live verifications wired into CI
```

Module shape is enforced by ESLint boundaries: modules reach each other through a
service function or an event, never by importing tables.

**Schemas:** `core` · `audit` · `crm` · `sales` · `projects` · `finance` · `ai` · `approvals` · `qa`.

Money is `bigint` minor units throughout; no float arithmetic on money anywhere.

### 4.1 Baseline health — measured 2026-09-11

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | **pass** |
| Lint | `npm run lint` | **pass** |
| Tests | `npm test` | **3,604 pass · 0 fail** (768 suites) |
| Secret scan | `npm run scan:secrets` | **pass** |
| Record ↔ repo | `npm run check:record` | **pass** |
| Full chain | `npm run check` | **exit 0** |

Recorded honestly: the baseline was **red** when this audit began — `tests/a-pin-that-cannot-fail.test.ts`
failed because the in-flight G-224 test file was 22/22 source-text pins, taking the
suite-wide pin ratio to 26.17% against a 26% ceiling. Fixed by executing the two
`commit.ts` functions rather than reading them (§7, PH1-FND-002). Exit codes were
captured directly, not through a pipe.

## 5. Implementation state — Phase 1 requirement coverage

> **This table is the snapshot taken when the audit began** (commit `c5959ed`, before any
> Phase 1 work). It is kept as written because it is the evidence the audit's conclusions
> rest on. **What changed since is in §5.1**, directly below, and the roadmap is
> authoritative for any gap's current state.


Classification per the contract: COMPLETE · PARTIAL · MISSING · BROKEN · MOCKED · BLOCKED.

| Phase 1 capability | State | Evidence |
| --- | --- | --- |
| Tenancy, RLS, RBAC, cross-tenant isolation | **COMPLETE** | RLS on 86/86 tables; `db:verify:tenancyguards`, `db:verify:tenancy`, `db:verify:security` |
| Audit log, append-only | **COMPLETE** | `audit.audit_log`, UPDATE/DELETE rejected by trigger |
| IDs / correlation / idempotency | **COMPLETE** | `core.jobs`, `core.outbox_events`, `ai.handoffs.correlation_id` |
| Job engine: claim, retry, reaper, dead-letter | **COMPLETE** | `db:verify:claims`, `db:verify:reaper`, `src/lib/jobs/*` |
| WhatsApp inbound: HMAC, dedupe, normalize, persist | **COMPLETE** | `app/api/webhooks/whatsapp`, `db:verify:webhook`, `db:verify:ingest` |
| WhatsApp outbound: consent, 24h window, templates, limits, STOP | **COMPLETE** | G-213/214/215/216/217/222; `db:verify:consent`, `db:verify:optout`, `db:verify:window` |
| Lead intake, dedupe, identity resolution | **COMPLETE** | `crm.leads`/`contacts`, `src/lib/import/match.ts`, `db:verify:import` |
| Lead lifecycle states | **PARTIAL** | 6 states + nurture vs Doc 09's 14 — mapping never decided |
| Qualification as structured state | **COMPLETE** | `crm.qualification_coverage`, `db:verify:qualification` |
| Requirements: versioned, confirmed, immutable | **COMPLETE** | `crm.requirement_versions`, `db:verify:chain`, `db:verify:proposal` |
| **Scheduler: intent → availability → booking → reminders → completion → evidence → analysis** | **MISSING** | **No table, no module, no route, no agent key, no gap tracked.** §6 below |
| Quotation: deterministic pricing, tax, milestones | **COMPLETE** | `sales.proposals`, `db:verify:quotations`, `db:verify:planset` |
| Quote versioning + immutability | **COMPLETE** | `proposals_live_version_key`, `db:verify:quotescope` |
| Approval: exact version, policy version, expiry | **COMPLETE** | `approvals.*`, `db:verify:approvals`, `db:verify:announce` |
| Quote delivery ≠ acceptance | **COMPLETE** | `db:verify:quotedispatch`; `record_proposal_response` refuses post-validity |
| Negotiation / objections / revision loop | **PARTIAL** | `sales.objections`, G-192/G-201 redraft loop; round limits partial |
| Exact-version acceptance | **COMPLETE** | `record_proposal_response` names the exact version, does not move the stage |
| **Payment / exception gate before WON** | **MISSING** | **`setOpportunityStage(…,'won')` needs only `lead.write`.** §6 below |
| Coordination: task lifecycle, dependencies, blockers | **PARTIAL** | `ai.handoffs` (10 states) vs the spec's 14; no dependency graph, no blocker registry |
| Orchestrator: capability/policy/health/cost routing | **PARTIAL** | `src/lib/ai/router.ts` resolves provider by model id only; **`ai.routing_policies` has no reader in `src/` or `app/`** |
| Agent activation | **BLOCKED** | 8 of 15 installed rows enabled; activation blocked on ADM-82/ADM-85 + `ANTHROPIC_API_KEY` |
| Admin Panel (34 screens) | **PARTIAL** | 20 internal routes exist; §9 maps them |
| Observability / audit trace | **COMPLETE** | `src/lib/observability/*`, `/operations`, `db:verify:backlog` |
| Release gates / smoke / rollback | **PARTIAL** | `db:verify:gates`, `npm run smoke`; rollback blocked on ADM-60 |

### 5.1 What changed after the snapshot — same day

| Snapshot said | Now | Where proven |
| --- | --- | --- |
| Scheduler **MISSING**, no gap tracked | **Built**: G-225 domain + state machine, G-226 availability (read-or-refuse), G-227 idempotent booking, G-228 stale-safe reminders, G-229 evidence + analysis gate — roadmap **Phase 27, complete**. Provider adapter (BLK-005) and the analysis model call (BLK-001) remain | `tests/a-meeting-is-a-thing`, `a-slot-that-was-never-read`, `a-retry-that-books-twice`, `a-reminder-for-a-meeting-that-moved`, `what-the-meeting-actually-said`; `db:verify:booking`, `db:verify:reminders` |
| Payment/exception gate before WON **MISSING** | **Built**: G-230 — `won_gate_verdict` + `opportunities_won_gate` on INSERT and UPDATE; acceptance mandatory, payment configurable and off | `tests/a-deal-that-is-won-says-what-was-won`; `db:verify:wongate` |
| RLS on 86/86 tables | 88/88 | `scripts/apply-migrations-locally.sh` sanity |
| Handoff packet at WON **MISSING** — a project appearing was the note | **Built**: G-232 — `record_won_handoff` writes the §13.4 packet into `ai.handoffs` at the transition into won (`opportunities_won_handoff`), emits `opportunity.handed_off`, names every absence; conversion binds the project. Phase 2 not activated | `tests/a-deal-that-is-handed-off`; `db:verify:handoff` |
| Admin screens A08/A09 **MISSING** | **Built**: G-234 — `/meetings` and `/meetings/[meetingId]`; G-237 — cancel, complete, no-show and typed evidence are commands (`crm.cancel_meeting`, `complete_meeting`, `record_no_show`, `add_meeting_evidence`), booking/reschedule still BLOCKED on BLK-005; G-235 — the handoff packet at `/handoffs/[opportunityId]` | `tests/a-meeting-worth-showing`, `the-handoff-has-a-face` |
| 3,604 tests · 768 suites · 218 migrations · 72 live verifiers | 4,097 · 828 · 227 · 77 (2026-09-12) | `npm run check` |
| (no way to execute a migration locally) | **G-231**: `scripts/apply-migrations-locally.sh` applies the full chain on a scratch Postgres 16 in under a minute | itself |

**And the review round.** An adversarial review of the seven new migrations — 228 agents,
73 findings raised, 40 confirmed — found that three of the functions **could not be
called by anyone** (a wrong column name; two `SECURITY INVOKER` functions writing a
table whose RLS admits no such write; a tenancy check that refused the service role),
plus a booking idempotency check done outside the lock, a gate that bound UPDATE but not
INSERT, a payment exception the quotation's own approval satisfied, fixtures that
inserted rows the guards refuse, and six false record claims. **Every one passed every
regex test.** All are fixed and were then proven on the live local database, including
an eight-way concurrent race. The full account is the 2026-09-11 rows of §10 in
`AGENCYOS_MASTER_DEVELOPMENT_PLAN.md`.

## 6. The two findings that matter most

Everything above is either already built or already tracked. Two Phase 1 requirements
are **neither built nor tracked**, and both are hard gates in the source documents.

### 6.1 The Scheduler Agent does not exist

The Scheduler is one of the five locked agents. It has a 21-page responsibility PDF,
17 implementation units (SC-01..SC-17) in Master Plan V3 §11, three of the ten
interactions in the Handoff Spec (02, 03, 04), two mandatory functional tests (F-05,
F-06), an E2E scenario (E2E-02), and two P0 admin screens (A08, A09).

The repository contains **none of it**: no `meetings`/`appointments`/`availability`
table in any of the 86 tables, no `src/modules/scheduler`, no scheduler route, no
`scheduler` key in the 13-agent registry, and **no gap in the 213-gap roadmap that
tracks its absence**. Every one of the 15 roadmap gaps matching /schedul|meeting|calendar/
is about *job* scheduling or follow-up timing, not meeting scheduling.

This is the largest single Phase 1 gap, and the reason it was invisible is that the
repository's own roadmap was built from the 23-document business set, where scheduling
is implicit, rather than from the Phase 1 five-agent set, where it is one fifth of the
workforce.

Registered as **G-225 … G-229** (§11).

### 6.2 A deal can be WON with no accepted quotation and no payment evidence

`src/modules/sales/service.ts:204` `setOpportunityStage()` moves an opportunity to
`won` when the caller holds `lead.write` and the state transition is legal. It checks:

- ✅ a legal transition (`proposal|negotiation → won`)
- ✅ a compare-and-swap so a concurrent move is not clobbered
- ❌ **no accepted quote version**
- ❌ **no acceptance evidence**
- ❌ **no payment or approved-exception evidence**

By contrast `lost` requires both a reason and a countable category, enforced in code
*and* at the row (`opportunities_lost_says_why`). The losing path is gated; the
winning path is not.

The database already knows this gate is supposed to exist — the comment on
`record_proposal_response` (migration `20260813120019`, line 1088) reads that it
"deliberately does not move the deal stage — §22 puts payment between acceptance and
WON." Acceptance correctly declines to move the stage. Nothing was then built to gate
the stage move, so the separation that comment describes is a gap rather than a control.

Required by: Master Matrix §12 and §17 · Gap-Closure §8 F-13 and §10 · Handoff Spec §16 ·
Coordination §16 · Impl/DoD §33 · Master Plan V3 §13.3, §25 and Appendix A.

Registered as **G-230** (§11).

## 7. Dependency graph

Derived from the repository's actual shape, not the PDF's illustrative one. Everything
above the line exists and is verified; work proceeds downward.

```
[BUILT] tenancy · RLS · RBAC · audit · IDs · job queue · outbox · canonical errors
   └─[BUILT] WhatsApp inbound (HMAC, dedupe) · outbound (consent, window, templates, limits)
        └─[BUILT] leads · contacts · conversations · requirement_versions
             ├─[BUILT] approvals engine (exact version, policy version, expiry)
             │    └─[BUILT] quotations: pricing · tax · milestones · versions · PDF · dispatch
             │         └─[BUILT] exact-version acceptance (does not move stage — correct)
             │              └─[GAP G-230] WON gate: accepted version + payment/exception
             │                   └─[GAP] structured Phase 2 handoff packet
             ├─[GAP G-225..229] SCHEDULER
             │    G-225 scheduling domain (intent · mode · date/time · timezone · meeting row)
             │      └─ G-226 availability from an authoritative source
             │           └─ G-227 booking: recheck + idempotency + provider event id
             │                ├─ G-228 reminders: timezone-aware, stale-safe
             │                └─ G-229 completion → evidence → analysis → Sales reactivation
             ├─[PARTIAL] Coordination task lifecycle (14 states, dependencies, blockers)
             └─[PARTIAL] Orchestrator routing (routing_policies has no reader)
                  └─[BLOCKED ADM-82/85] agent activation
```

**Critical observation on ordering:** G-225..G-227 are buildable *credential-free* as
domain + state + idempotency work with a local Postgres. Only the *provider* half
(a real calendar, a real meeting link) is credential-blocked. That distinction matters
because the roadmap's current `nextAction` states the credential-free runway is worked
down — it is not, because the Scheduler was never counted.

## 8. Implementation stages

| Stage | Content | Exit condition |
| --- | --- | --- |
| **P1-S0** | Baseline gate: audit recorded, chain green | ✅ **done** — `npm run check` exit 0 |
| **P1-S1** | G-230 WON gate | A deal cannot reach `won` without an accepted version + payment/exception; red-proved |
| **P1-S2** | G-225 scheduling domain + state machine | Meeting row, modes, timezone stored, RLS + tenancy guards, transitions refused |
| **P1-S3** | G-226 availability | Availability read from a configured authoritative source; never fabricated |
| **P1-S4** | G-227 booking | Recheck-before-commit, idempotency key, provider event id, no double-book on retry |
| **P1-S5** | G-228 reminders | Timezone-aware, re-checked at fire time, suppressed on cancel/reschedule |
| **P1-S6** | G-229 completion + evidence + analysis | Explicit completion (time passing is not completion), evidence linked, Sales reactivated |
| **P1-S7** | Coordination lifecycle + Orchestrator routing reader | Task states, dependencies, blockers; `ai.routing_policies` actually read |
| **P1-S8** | Admin screens for the above (A08, A09, A16–A18) | Backend-command pattern, all UI states |
| **P1-S9** | F-01..F-15 + negative matrix as live verifications | Every scenario wired into CI |

Stages are sequential where they share state. P1-S1 is independent of P1-S2..S6 and is
was therefore the first dependency-ready unit; the checklist's "Next dependency-ready unit"
section is the live pointer from here on.

## 9. Admin Panel sequence — 34 screens vs 20 routes

| Blueprint | Route | State |
| --- | --- | --- |
| A01 Overview | `/dashboard` | present |
| A02 Global search | `command-palette.tsx` | present |
| A03/A04 Lead list + 360 | `/leads`, `/leads/[leadId]` | present |
| A05 WhatsApp conversation | within `/leads/[leadId]` | partial |
| A06/A07 Requirements + compare | within `/leads/[leadId]` | partial |
| **A08 Scheduler calendar** | `/meetings` | **present, read-only (G-234)** |
| **A09 Meeting detail** | `/meetings/[meetingId]` | **present, read-only (G-234)** |
| A10–A12 Quotation list/detail/compare | `/leads/[leadId]/quotation-panel.tsx` | partial — no standalone list |
| A13/A14 Approval centre + detail | `/approvals` | present |
| A15 Negotiation workspace | — | missing |
| A16–A18 Task board / trace / blockers | `/operations` | partial |
| A19–A21 AI workforce / agent / routing trace | `/agents`, `/usage` | partial |
| A22/A23 Integrations + health | `/integrations` | present |
| A24/A25 Policies + pricing rules | `/settings` | partial |
| A26 Notification rules | — | missing |
| A27 Audit timeline | `/audit` | present |
| A28/A29 System health + incidents | `/operations` | present |
| A30/A31 Users/roles + org settings | `/settings` | partial |
| A33 Readiness | `/production-readiness` | present |
| A34 Help | — | missing |

Also present and outside the blueprint: `/import`, `/portfolio`, `/projects`,
`/invoices`, `/sales-funnel`, `/security`.

## 10. Testing sequence

The repository's convention, which Phase 1 work follows rather than replaces:

- **Unit** (`tests/*.test.ts`, `node:test`) — shape, branches, refusals. Executed, not
  pinned: the pin ratio is a ratchet at 26% and may only go down.
- **Live** (`scripts/verify-*.mjs`, `db:verify:*`) — behaviour against a real Postgres,
  every one wired into `.github/workflows/verify.yml` (checked by `check:record`).
- **Self-red-proving** — a live verifier that drops its own control and asserts the
  refusal flips. Required for any new gate (§6.2's gate especially).

Phase 1 adds F-01..F-15 as live verifications, and the negative matrix from Master Plan
V3 §19 as their refusal twins.

## 11. New gaps registered

Continuing the repository's numbering from G-224. Full records go in `docs/roadmap/roadmap.json`.

| ID | Risk | Gap |
| --- | --- | --- |
| **G-225** | P1 | No scheduling domain exists: the Scheduler is one of five locked Phase 1 agents and has no table, module, route or registry key |
| **G-226** | P1 | Availability has no authoritative source, so any slot offered would be fabricated |
| **G-227** | P0 | Booking has no idempotency or provider-event mapping, so a retry would double-book |
| **G-228** | P2 | Meeting reminders do not exist; stale reminders after reschedule/cancel are unprevented |
| **G-229** | P1 | Meeting completion, evidence and analysis do not exist, so Sales cannot be reactivated from a call |
| **G-230** | **P0** | A deal can be moved to `won` with no accepted quote version and no payment or approved-exception evidence |

## 12. Blockers

See `BLOCKERS.md`. In summary, and unchanged by this audit: agent activation (ADM-82,
ADM-85, `ANTHROPIC_API_KEY`), the calendar provider choice (new — required for the
Scheduler's provider half), Meta production access (G-123), and the five production
environment facts (ADM-60).

**None of them blocks G-230, G-225, G-226 or G-227**, which are domain, state and
idempotency work verifiable against a local Postgres.

## 13. Completion criteria

Phase 1 is complete when every item in `AGENCYOS_PHASE1_EXECUTION_CHECKLIST.md` is `[x]`
with evidence, F-01..F-15 pass as live verifications, the negative matrix passes, and
`docs/deployment/production-readiness.md` — the single authoritative verdict — says so.

It is not complete now, and the largest reasons are §6.1 and §6.2.
