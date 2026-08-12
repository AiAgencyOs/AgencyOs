# AGENCYOS_MASTER_DEVELOPMENT_PLAN.md

The canonical plan for AgencyOS: what the business does, what the system does
today, the distance between the two, and the order in which that distance is
closed.

**Baseline date:** 2026-08-11
**Baseline commit:** `2881caa` on `fix/manual-payment-serialized` (one commit ahead of `main`)
**Status of this document:** Phase 0 deliverable. No code was written to produce it.

---

## 0. How to read this document

### 0.1 Source-of-truth hierarchy

When two documents disagree, the higher entry wins:

1. **The database** — migrations in `supabase/migrations/`. Constraints, RLS
   policies and functions are the only statements that hold under concurrency.
2. **The code** — `src/modules/*/schema.ts` holds the state machines,
   `src/modules/*/service.ts` holds the rules that guard them.
3. **`ARCHITECTURE.md`** — the V1 design document. Large parts of it describe
   tables and modules that are *designed but not built*; §2 below says exactly
   which.
4. **This document** — reconciles the two above against the AgencyOS master
   directive, and records what is missing.
5. **`PROJECT_UNDERSTANDING.md`** — the original pre-build analysis. Historical.
6. **`docs/implementation-backlog.md`, `docs/documentation-roadmap.md`** —
   **superseded.** They describe a multi-service (`services/`, `apps/`,
   `packages/`) layout that this repository does not use and a documentation set
   that was never produced. Retained as history; do not implement from them.
7. **`docs/business-os/*.md`** — **empty templates.** Ten files, ~40 lines each,
   every substantive section reading `<TBD>`. They are not business rules; they
   are placeholders for business rules that have never been written down. This
   is the single largest source of "requires Admin decision" entries below.

### 0.2 Vocabulary

The master directive uses one vocabulary (`REQUIREMENT_DISCOVERY`,
`PAYMENT_VERIFIED`, `PRODUCTION_READY`). The built system uses another
(`qualifying`, `captured`, no equivalent). **Neither is renamed in this
document.** Where they differ, the gap matrix records it as a mapping decision
for the Admin rather than silently adopting either.

### 0.3 Classification codes

| Code | Meaning |
| --- | --- |
| **A** | Already implemented, verified against code and schema |
| **B** | Partially implemented |
| **C** | Missing |
| **D** | Incorrect — implemented, but wrong under some condition |
| **E** | Ambiguous — requires an Admin/Product decision before it can be built |

---

## 1. Baseline — what exists today

Everything in this section was read out of the repository at commit `2881caa`,
not assumed.

### 1.1 Stack and shape

A **modular monolith** on Next.js 16 (App Router, React 19, TypeScript 6),
deployed to Vercel, with Supabase Postgres as the database and the auth
provider. There are no microservices, no `apps/` or `services/` directories, and
no message broker. Background work runs through a database job queue drained by
a Vercel Cron hit on `/api/jobs/run` every minute.

```
app/            route handlers, server components, server actions (thin)
src/lib/        cross-cutting: auth, authz, db clients, events, jobs, AI ports
src/modules/    crm · sales · projects · finance · identity
supabase/       23 migrations, seed, config
tests/          14 node:test suites
scripts/        8 live-verification scripts against a real database
```

Each module follows the same six-file shape (`schema.ts`, `service.ts`,
`queries.ts`, `actions.ts`, `types.ts`, plus handlers where it consumes events),
enforced by ESLint boundaries: modules reach each other only through a
service-layer function or an event, never by importing tables.

### 1.2 Database — 27 tables across 7 schemas

| Schema | Tables | Purpose |
| --- | --- | --- |
| `core` | `organizations`, `users`, `memberships`, `client_accounts`, `client_users`, `jobs`, `outbox_events` | Tenancy, identity, queue, transactional outbox |
| `audit` | `audit_log` | Append-only; UPDATE and DELETE rejected by trigger |
| `crm` | `contacts`, `leads`, `lead_activities`, `conversations`, `conversation_messages`, `requirement_versions` | Inbound capture through to versioned requirement proposals |
| `sales` | `opportunities`, `proposals`, `proposal_items` | Pipeline; **proposals have tables but no code** |
| `projects` | `projects`, `milestones`, `tasks` | Delivery and the payment plan |
| `finance` | `invoices`, `invoice_items`, `payments` | Milestone billing and the payment ledger |
| `ai` | `agents`, `agent_runs`, `agent_steps`, `cost_ledger` | Agent registry, run traces, cost |

**RLS is enabled on all 27 tables.** Every one carries at least a select policy;
every writable one carries a write policy gated on
`core.current_organization_id()` and `core.can_write()`.

Money is `bigint` minor units throughout. There is no float arithmetic on money
anywhere in the codebase.

### 1.3 The state machines that exist

| Machine | States | Terminal | Enforced where |
| --- | --- | --- | --- |
| Lead | `new` → `qualifying` → `qualified` → `converted`; `disqualified` off any pre-terminal state and back to `qualifying` | `converted` | `crm/schema.ts` + CHECK |
| Opportunity | `discovery` → `proposal` → `negotiation` → `won`; `lost` off any, reopening to `discovery` | `won` | `sales/schema.ts` + CHECK |
| Project | `planning` → `onboarding` → `active` → `completed`; `on_hold`, `cancelled` | `completed`, `cancelled` | `projects/schema.ts` + CHECK |
| Milestone | `pending`, `in_progress`, `submitted`, `met`, `rejected` | — | `projects/schema.ts` + CHECK |
| Invoice | `draft` → `issued` → `partially_paid` → `paid`; `void`, `overdue`, `pending_approval` | `paid`, `void` | `finance/schema.ts` + CHECK |
| Payment | `created`, `authorized`, `captured`, `failed`, `refunded` | — | CHECK only (no TS machine) |
| Requirement version | `proposed` → `accepted` / `rejected`; `failed`; `superseded` | `accepted` | `crm` migrations + trigger |

### 1.4 The one path that works end to end

**Inbound WhatsApp message → structured requirement proposal → human decision.**

```
Meta webhook (HMAC-verified, inbound only)
  → crm.ingest_whatsapp_message()      lead + conversation + message, seq under lock
  → core.jobs 'requirement.extract'    deduped on (conversation, message count)
  → /api/jobs/run                      claims, calls Claude, validates with Zod
  → crm.insert_requirement_version()   version allocated under a conversation lock
  → status 'proposed'                  the agent is L1: it proposes, it does not decide
  → owner/ops_admin accepts or rejects  enforced in the database, not just the UI
```

And its money counterpart:

```
milestone (payment_percent, amount_minor)
  → generateInvoiceFromMilestone()     DRAFT; one live invoice per milestone (partial unique index)
  → issueInvoice()                     leaving draft *is* delivery to the client portal
  → recordManualPayment()              human-entered receipt; no gateway is contacted
  → invoice.paid event → outbox → job → projects:unlockNextMilestone
```

### 1.5 What is deliberately absent

Recorded here so it is not mistaken for an oversight:

- **No payment gateway.** Every payment is a human recording money they have
  seen arrive. `tests/no-payment-gateway.test.ts` asserts this stays true.
- **No outbound messaging of any kind.** The WhatsApp integration is inbound
  only. Nothing in this codebase can send a message to a client.
- **Milestone unlocking is advisory.** Paying an invoice moves the next
  milestone to `in_progress`; it does not gate work that has already started.

### 1.6 Verified baseline health

| Check | Command | Result at `2881caa` |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | pass |
| Lint | `npm run lint` | pass |
| Tests | `npm test` | **549 pass, 0 fail** (94 suites, 14 files) |
| Local database | `supabase status` | running (Docker up, API on 54321) |
| CI | GitHub Actions `verify` | typecheck · lint · tests · secret scan · build · migrations · 7 live scripts |

---

## 2. `ARCHITECTURE.md` — designed vs built

`ARCHITECTURE.md` is 1,400+ lines of V1 design. Roughly half describes systems
that exist; the rest describes systems that do not. Reading it as a description
of the codebase will mislead. The split:

| `ARCHITECTURE.md` § | Subject | Built? |
| --- | --- | --- |
| §3 | Folder architecture, six-file modules | **Yes** |
| §4.3 | Core tables, tenancy | **Yes** |
| §4.4 | Job queue | **Yes** (`core.jobs`, claim + reaper) |
| §4.5 | Transactional outbox | **Yes** (`core.outbox_events`, dispatcher) |
| §4.6 | `approvals` schema — polymorphic approval engine | **No table exists** |
| §4.7 | `build.screen_spec`, brand kits, trusted renderer | **No** |
| §4.8 | `build.dev_tickets`, `qa.test_cases/test_runs/defects` | **No** |
| §4.9 | Finance | **Yes** |
| §4.10 | AI observability (`agent_runs`, `agent_steps`, `cost_ledger`) | **Yes** |
| §4.11 | RLS | **Yes** |
| §5 | Result/error shapes, mutation pipeline | **Yes** |
| §6 | Agent registry, run lifecycle, structured output, autonomy levels | **Partly** — one agent (`requirement_collector`) exists; the L0/L1/L2 column exists and only L1 is exercised |
| §7 | Auth, JWT claims, service-role call sites | **Yes** |
| §8 | Capability matrix | **Yes** (`src/lib/authz/permissions.ts`) |
| §9 | Event flow and catalog | **Yes**, with exactly one subscription: `invoice.paid → projects:unlockNextMilestone` |
| §10 | Deployment pipeline, observability | **Partly** — Vercel + cron yes; CI, monitoring, rollback no |

`approvals`, `build` and `qa` are the three designed schemas with no
corresponding migration. They are also, not coincidentally, where the master
directive's largest requirements land (§13–§20, §27).

---

## 3. Business lifecycle → implementation coverage

The directive's canonical lifecycle (§4), mapped onto what the system actually
records. `—` means no representation exists anywhere in the schema.

| # | Lifecycle stage | Represented as | Class |
| --- | --- | --- | --- |
| 1 | New WhatsApp client | `crm.conversations` + webhook | A |
| 2 | Lead | `crm.leads` | A |
| 3 | Sales / discovery | `leads.status`, `sales.opportunities` | B |
| 4 | Follow-up / negotiation | `leads.follow_up_at` (manual), stage `negotiation` | B |
| 5 | Won | `opportunities.stage = 'won'` | A |
| 6 | Onboarding | `projects.status = 'onboarding'` | B |
| 7 | WhatsApp group | — | C |
| 8 | Advance / payment terms | `projects.milestones.payment_percent`, plan totals 100% | B |
| 9 | Project officially started | `projects.status = 'active'` — **no start conditions** | E |
| 10 | Requirements | `crm.requirement_versions` (versioned, approved) | A |
| 11 | UI design | — | C |
| 12 | Client UI review / revision loop / approval | — | C |
| 13 | UI prototype + review + approval | — | C |
| 14 | Full development | `projects.tasks` (flat) | B |
| 15 | Development complete / client review / approval | — | C |
| 16 | Milestone payment | `finance.invoices` + `payments` | A |
| 17 | 360° QA | — | C |
| 18 | Production ready gate | — | C |
| 19 | Final payment | Same machinery as any milestone | A |
| 20 | Handover | — | C |
| 21 | Project completed | `projects.status = 'completed'` (flag only, no summary) | B |
| 22 | Maintenance / support | — | C |
| 23 | Upsell | — | C |
| 24 | Repeat business / long-term client | `core.client_accounts` persists | B |

**Coverage: 5 of 24 stages fully implemented, 7 partial, 11 missing, 1 blocked
on an Admin decision.**

The shape of that result is worth stating plainly: **the two ends of the
business are built and the middle is not.** Lead capture through requirements is
solid, and billing through payment is solid. Everything between requirement
approval and invoice generation — design, prototype, development tracking,
client review, QA, handover — has no representation in the database at all.

---

## 4. Gap matrix

Columns: **Gap · Current state · Required state · Risk · Depends on · Test
coverage · Admin decision · Phase**.

Risk is the business consequence if the gap is not closed: **P0** money or data
loss, **P1** business state loss or wrong client-facing outcome, **P2**
operational friction, **P3** cosmetic or future-facing.

### 4.1 Finance and money — Phases 1–4

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-001** | D1 — concurrent payment overpayment race | **Fixed and merged** (PR #9, `e4dc28a`): `finance.record_manual_payment()` locks the invoice, re-reads the ledger under the lock, refuses rather than clamps | — | A | P0 | — | `tests/milestone-invoicing.test.ts` §D1, `scripts/verify-milestone-invoicing.mjs` §7b | Closed | 1 |
| **G-002** | D2 — stale invoice void | **Fixed** on `fix/invoice-void-serialized`: `finance.void_invoice()` locks the invoice, sums the payment rows through that lock rather than trusting the cached `paid_minor`, and writes inside the same statement. Audit and event fire only when the invoice was actually withdrawn | Merged to `main` and deployed | A | P0 | G-001 (merged) | `tests/invoice-void.test.ts` (28), `scripts/verify-milestone-invoicing.mjs` §7c (16) | **Yes — merge approval on PR #11** | 2 |
| **G-009** | D4 — stale invoice issue | **Fixed** on `fix/invoice-issue-serialized`: `finance.issue_invoice()` locks the invoice, re-decides through the lock, and probes the line items with `for share` so they cannot be emptied between the check and the write. The unlocked item count — which never read its own error — is gone, as is the pre-lock early success that could report a voided invoice as issued | Merged to `main` and deployed | A | P1 | G-002 | `tests/invoice-issue.test.ts` (29), `scripts/verify-milestone-invoicing.mjs` §7d (16) | **Yes — merge approval on PR #13** | 4 |
| **G-060** | **D5 — a transient read kills a milestone unlock for good** | **Fixed** on `fix/unlock-read-failure`: the plan read reports its failure and the handler settles it `permanent: false`, so the job stays queued | `nextUnlockedMilestoneForProject()` destructures only `data` and never reads `error` (`service.ts:898-915`), falling back to `?? []`. A failed read yields no plan, so `invoicePaidVerdict` refuses with `permanent: true` (`projects/schema.ts:295-304`) and the job runner parks the job as **dead** on the first attempt (`app/api/jobs/run/route.ts`) — a transient error permanently strands a milestone the client has paid for | The read reports failure; a transient one leaves the job retryable | D | P1 | G-003 | None | No — directive §33 already forbids it | 4 |
| **G-061** | **D6 — a read that fails is reported as an invoice that does not exist** | **Fixed** on `fix/honest-invoice-reads`: `loadInvoice()` returns a `Result`, so `NOT_FOUND` means absent and `INTERNAL` means unreadable | `loadInvoice()` logs and returns `null` on a database error (`service.ts`), so all three finance writes answer `NOT_FOUND` — "Invoice not found." — for a database that did not answer. The same distinction D3 restored for the ledger, one function along | The read reports failure; NOT_FOUND means the row is absent, not unreadable | D | P2 | G-003 | None | No — directive §33 already forbids it | 4 |
| **G-062** | **D7 — voiding answers from an unlocked read** | **Fixed** on the same branch: `void` is exempted from the pre-lock gate and answered by `already_void` under the lock | `voidInvoice()` still returns `ok({status:'void'})` from the pre-lock copy when it reads `void`, the twin of the early return D4 removed from `issueInvoice`. Narrow — the answer it gives is the one the lock would give in every case but a concurrent un-void, which no code path performs — but it is the same shape | Answered under the lock, as `already_void` already can | D | P3 | G-002 | None | No | 4 |
| **G-003** | D3 — failed ledger read treated as zero | **Fixed** on `fix/ledger-read-failure`: `capturedTotal()` returns `Result<number>`. `reconcileInvoiceTotals()` writes nothing on an unreadable ledger, and the pre-lock check refuses before the payment RPC commits anything | Merged to `main` and deployed | A | P0 | — | `tests/payment-ledger.test.ts` (14) | **Yes — merge approval on PR #12** | 3 |
| **G-004** | Nothing ever marks an invoice `overdue` | `overdue` is a legal status with legal transitions; no code path or job sets it | A scheduled sweep moves issued/partially-paid invoices past `due_at` to `overdue` | C | P2 | — | None | **Yes — grace period, and whether overdue notifies anyone** | 4 |
| **G-005** | Refunds unimplemented | Capability `refund.issue` exists and is owner-only; `payments.status = 'refunded'` is a legal value; no code writes it | A refund path, or an explicit decision that refunds stay out of band | C | P1 | G-002 | None | **Yes — is a refund in-system or a bank action recorded after the fact?** | 4 |
| **G-006** | Payment vocabulary mismatch | DB: `created`, `authorized`, `captured`, `failed`, `refunded`. Directive §10: `PROPOSED`, `REQUESTED`, `PENDING`, `RECEIVED`, `VERIFIED`, `FAILED`, `REFUNDED`, `DISPUTED` | One vocabulary | E | P2 | — | — | **Yes — adopt the directive's states, or map them onto the provider-shaped ones already stored** | 4 |
| **G-007** | "Payment verified" has no distinct meaning | A recorded manual payment is immediately `captured`; there is no second confirmation step | If the business distinguishes *received* from *verified*, the ledger must too | E | P1 | G-006 | — | **Yes** | 4 |
| **G-008** | Invoice totals written outside the lock that made them true | **Fixed** on `fix/payment-reconciled-under-lock`: `finance.record_manual_payment` updates `paid_minor`, `status` and `paid_at` in the same statement as the payment insert. `reconcileInvoiceTotals` is deleted — there is nothing left for it to do, and the unrecoverable stale-cache state it could leave behind has nowhere to form | Merged to `main` | A | P1 | G-001 | `tests/payment-ledger.test.ts` (13), `scripts/verify-milestone-invoicing.mjs` §7b K/L | **Yes — merge approval on PR #18** | 4 |
| **G-063** | **D8 — a payment plan could be rewritten out from under a bill** (Phase 14/15 sweep) | **Fixed** on `fix/payment-plan-atomic`: `projects.replace_payment_plan` locks the plan, refuses when any milestone carries a non-void invoice, and does the delete and insert in one statement. `configurePaymentPlan` had refused only on `met`, which nothing writes | Merged to `main` | A | **P0** | — | `tests/payment-plan-atomic.test.ts` (13), `verify-milestone-invoicing.mjs` §3b (7) | **Yes — merge approval on PR #19** | 4 |
| **G-064** | **D9 — `convertToProject` creates duplicate projects and client accounts** | Read-decide-write with no lock and no uniqueness on `projects.opportunity_id`. Two clicks on a won deal produce two projects and two client accounts | Serialised, or a unique index on the opportunity | D | P1 | — | None | No — same rule | 5 |
| **G-065** | **D10 — state transitions write with an id-only predicate** | **Fixed** on `fix/state-transitions-compare-and-swap`: `setLeadStatus`, `setOpportunityStage` and `setProjectStatus` restate the state they decided against, and report a write that matched nothing instead of assuming it landed | Merged to `main` | A | P1 | — | `tests/state-transitions.test.ts` (15) | **Yes — merge approval on PR #20** | 5 |
| **G-066** | **D11 — `appendMessage` reads a failed max-seq as an empty transcript** | The max-seq read drops its `error`, so a failed read computes seq 1 and the insert collides, reporting a false CONFLICT to the operator | Propagate, as D3/D6 do | D | P2 | — | None | No — same rule | 5 |
| **G-067** | **D12 — `startConversation` drops the error on its idempotence read** | A failed read of the active conversation inserts a second one, which then hides the first from every later query | Propagate | D | P2 | — | None | No — same rule | 5 |
| **G-068** | **D13 — reopening a disqualified lead keeps its reason** | **Fixed** on the same branch: the reason is cleared on the way out as well as set on the way in | Merged to `main` | A | P3 | — | `tests/state-transitions.test.ts` C | **Yes — merge approval on PR #20** | 5 |
| **G-069** | **D14 — the lead status form offers a value the service always refuses** | **Fixed** on the same branch: the lead page filters `converted` out of the options, because conversion happens through the sales path | Merged to `main` | A | P3 | — | Covered by the transition suite | **Yes — merge approval on PR #20** | 5 |

### 4.2 CRM and sales — Phases 5, 11

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-010** | Sales lifecycle vocabulary | 5 lead statuses + 5 opportunity stages | Directive §5 lists ten sales states (`CONTACTED`, `SAMPLE_SENT`, `DEMO_SENT`, `OFFER_SENT`, `ADVANCE_REQUESTED`, …) and four outcomes | E | P1 | — | `tests/workflow-regression.test.ts` pins the current set | **Yes — extend the enum, or keep 5+5 and treat the directive's states as activity types** | 11 |
| **G-011** | Proposals: tables with no code | `sales.proposals` + `proposal_items` exist with RLS and a version column. No service, no action, no query, no UI | Draft → approve → send → accept, per the capability triple already defined | C | P1 | G-040 | None | **Yes — what is in a proposal, and does sending require approval?** | 6 |
| **G-012** | Follow-up automation | `leads.follow_up_at` is set by hand; nothing reads it | Detect the situations in directive §7 and raise a recommendation | C | P2 | G-040, G-014 | None | **Yes — which situations, and what timing** | 11 |
| **G-013** | AI sales assistance | One agent: `requirement_collector` | Module suggestion, portfolio/sample matching, drafted responses — all as proposals | C | P2 | G-011, G-041 | — | **Yes — approved sample/portfolio catalog must exist first** | 11 |
| **G-014** | No outbound communication | Inbound webhook only | Sending, gated by the automation trust level | C | P1 | G-040, G-041 | `tests/whatsapp-webhook.test.ts` asserts nothing is sent | **Yes — which channel, whose number, what approval** | 10 |
| **G-015** | WhatsApp group not modelled | `conversations.external_ref` holds a 1:1 thread | A project's group, associated and auditable | C | P2 | — | None | No | 12 |
| **G-016** | Duplicate suppression on repeat inbound | Strong: `leads_source_ref_key`, `conversations_external_ref_key`, `contacts_org_phone_key`, message `external_ref` unique | Verify it survives a *returning* client who starts a second project | B | P1 | — | `tests/crm-ingest.test.ts` | **Yes — does a returning client reopen the lead or start a new one?** | 5 |
| **G-017** | Lead → client/project conversion is manual and partial | `convertToProject()` exists in sales | Directive §8 wants client, organization link, onboarding checklist, payment plan, milestone structure and requirement workspace created together | B | P1 | G-026 | `tests/workflow-regression.test.ts` | **Yes — what an onboarding checklist contains** | 5 |

### 4.3 Delivery — Phase 12

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-020** | Requirement → feature → task chain | `requirement_versions` hold an approved payload; `projects.tasks` are flat and unlinked | The chain in directive §12, with provenance preserved | C | P1 | — | None | **Yes — is the breakdown human, AI-proposed, or both** | 12 |
| **G-021** | UI design phase | Nothing | Versioned design artifacts, `DESIGN_PENDING → … → CLIENT_REVIEW` | C | P1 | G-040 | None | **Yes — where artifacts live; Supabase Storage is available but unused** | 12 |
| **G-022** | Client approval of an artifact | Nothing. `approvals` schema is designed in `ARCHITECTURE.md` §4.6 and does not exist | The polymorphic approval engine, `audience = 'client'` | C | P1 | G-040 | None | See G-040 | 12 |
| **G-023** | Prototype phase | Nothing | Versioned builds (APK/web), review loop, approval | C | P1 | G-021, G-022 | None | **Yes — artifact hosting and client access** | 12 |
| **G-024** | Development module tracking | `projects.tasks`: status, assignee, milestone. No modules, dependencies, code review state, QA state, or build version | Directive §16 | B | P2 | G-020 | None | No | 12 |
| **G-025** | Client development review | Nothing | Build + changelog + credentials-by-secure-means + approve/request-changes | C | P1 | G-022, G-023 | None | **Yes — secure credential transfer mechanism** | 12 |
| **G-026** | Project official start has no conditions | `onboarding → active` is a free transition | Directive §11 gate: onboarding complete, information collected, payment condition satisfied, or an Admin-approved exception | E | P1 | G-017 | `tests/workflow-regression.test.ts` pins the transition | **Yes — this is the single most-requested undefined rule** | 12 |
| **G-027** | Milestone unlock is advisory | Documented and deliberate | Confirm it stays advisory once the gates above exist | A | P3 | — | `tests/milestone-unlock.test.ts` | **Yes — confirm at Phase 12** | 12 |

### 4.4 QA, production readiness, handover — Phases 17, 20

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-030** | No `qa` schema | Designed in `ARCHITECTURE.md` §4.8, not built | `test_cases`, `test_runs`, `defects` with P0–P3 severity, reproduction, evidence, verification | C | P1 | G-024 | None | **Yes — severity vocabulary: directive says P0–P3, `ARCHITECTURE.md` says blocker/major/minor/trivial** | 12 |
| **G-031** | Production-ready gate | Nothing | Explicit encoded conditions (directive §20) | C | P1 | G-030 | None | **Yes — the exact condition list** | 20 |
| **G-032** | Handover | Nothing | Auditable package; secrets never in chat | C | P1 | G-031 | None | **Yes — credential transfer mechanism** | 12 |
| **G-033** | Completion summary | `status = 'completed'` only | Value, payments, balance, duration, revisions, bugs, version, handover status | C | P2 | G-032 | None | No | 12 |

### 4.5 Client success and upsell — Phases 22–24

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-034** | Maintenance / support | Nothing | Post-completion service representation | C | P3 | G-033 | None | **Yes — service catalog** | 22 |
| **G-035** | Approved offer catalog | Nothing | Admin-owned catalog; AI may only select from it | C | P3 | G-034 | None | **Yes — blocks all of §24–25** | 23 |
| **G-036** | Upsell engine | Nothing | Signal → eligibility → recommendation → policy → approval → presentation | C | P3 | G-035, G-040 | None | **Yes** | 24 |
| **G-037** | Client lifetime model | `client_accounts` persist; nothing aggregates | Lifetime value, repeat business, long-term client state | C | P3 | G-033 | None | No | 22 |

### 4.6 Governance, approval and automation — Phases 8, 25

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-040** | **No approval engine** | One bespoke gate exists (requirement acceptance, enforced by `core.is_admin()` in RLS). Nothing generic. `ARCHITECTURE.md` §4.6 designs `approvals.approval_requests` + `approval_policies` | The approval center of directive §27: one polymorphic engine, internal and client audiences, policy-driven | C | **P1** | — | `tests/requirement-decision.test.ts` covers the one bespoke gate | **Yes — build §4.6 as designed, or re-decide** | 8 |
| **G-041** | Automation trust levels not enforced | `ai.agents.autonomy_level` (L0/L1/L2) is a column; only L1 behaviour is implemented, and it is implemented in the code path rather than derived from the column | GREEN/YELLOW/RED policy from directive §28, enforced not merely recorded | B | P1 | G-040 | `tests/ai-extraction.test.ts` | **Yes — the GREEN/YELLOW/RED mapping for each action** | 25 |
| **G-042** | AI provenance | Good: `agent_runs`, `agent_steps` (request/response/cost/latency), `requirement_versions.generated_by_run_id`, `source_job_id`, `source_message_count` | Extend the same discipline to every future AI output | A | P2 | — | `tests/ai-extraction.test.ts` | No | — |
| **G-043** | Audit coverage | `audit.audit_log` is append-only and trigger-protected; 15 call sites across all five modules | Every gated transition writes one. Re-audit as new gates land | A | P2 | — | Indirect | No | — |
| **G-044** | Admin approval center UI | No `/approvals` route | The product surface of `ARCHITECTURE.md` §6.8 | C | P1 | G-040 | None | No | 8 |

### 4.7 Platform, testing, operations — Phases 14–21

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-050** | No CI whatsoever | **Fixed** on `ci/verify-on-every-change`: `.github/workflows/verify.yml` runs typecheck, lint, 636 tests, the secret scan and a production build on every PR, plus a second job that applies all 25 migrations from scratch and runs all seven live verification scripts against a real Postgres | Merged to `main` | A | P1 | — | n/a — it *is* the coverage | **Yes — merge approval on PR #16** | 18 |
| **G-051** | No secret scanning | **Fixed**: `scripts/scan-secrets.mjs` scans `git ls-files` for eight credential shapes and refuses to let `.env.local`-family files be tracked. Repo-owned rather than a third-party action, so CI on a money-handling repo adds no supply chain. Carries a canary so it cannot pass by matching nothing | Merged to `main` | A | P1 | G-050 | Self-testing; proven to fail on a planted key and on a tracked `.env` | **Yes — merge approval on PR #16** | 18 |
| **G-052** | No deployment or rollback documentation | `vercel.json` defines the cron. Nothing describes environments, migration ordering, or rollback | `AGENCYOS_OPERATIONS.md` (created in this phase) filled in with real procedure | B | P2 | — | — | **Yes — production Supabase project and Vercel environment details** | 20 |
| **G-053** | Observability is `console.error` | Structured JSON to stdout; no aggregation, no alerting, no dead-letter monitoring | Directive §41 smoke tests and monitoring | C | P2 | G-052 | — | **Yes — tooling choice** | 20 |
| **G-054** | Read failures rendered as empty pages | **Fixed** on `fix/reads-that-cannot-answer`: all 18 readers across four `queries.ts` refuse via `unreadable()`, and `error.tsx` boundaries in both route groups say the page could not be loaded rather than showing an empty one. The two readers feeding the unlock decision propagate a `Result`, so `invoice.paid` is never emitted with a fabricated null | Merged to `main` | A | P1 | — | `tests/read-failure-semantics.test.ts` (20) | **Yes — merge approval on PR #17** | 16 |
| **G-055** | Business rules are not written down | All ten `docs/business-os/*.md` are empty templates | The rules the system enforces, stated once | C | P1 | — | — | **Yes — every rule in §5 below** | 21 |
| **G-056** | Stale planning documents | `implementation-backlog.md` and `documentation-roadmap.md` describe an architecture the repo does not use | Marked superseded (done, §0.1 above) | B | P3 | — | — | No | 21 |
| **G-057** | Client portal is a placeholder | 19 lines, no content | Client-facing invoices, approvals, deliverables | C | P2 | G-022 | None | No | 12 |
| **G-058** | Dead-letter jobs are invisible | Jobs park as `dead` with `last_error`; nothing surfaces them | An operational view or alert | C | P2 | G-053 | `tests/job-reaper.test.ts` | No | 9 |
| **G-059** | Concurrency audit incomplete | D1, D2 and D3 fixed; D5 open. Other read→decide→write sites not yet systematically classified | Every concurrent mutation classified safe or unsafe (directive §30) | B | P1 | G-002, G-003 | Partial | No | 15 |

### 4.8 Gap totals

| Class | Count |
| --- | --- |
| A — already implemented | 7 |
| B — partial | 8 |
| C — missing | 28 |
| D — incorrect | 4 |
| E — blocked on an Admin decision | 4 |
| **Total** | **51** |

| Risk | Count |
| --- | --- |
| P0 | 3 — all closed or pending merge: G-001, G-002 merged; G-003 pending |
| P1 | 27 |
| P2 | 14 |
| P3 | 7 |

**24 distinct Admin decisions** have been raised across these gaps; one
(ADM-01) is granted. They are consolidated in §5.

---

## 5. Decisions required from the Admin

Nothing below is invented, defaulted, or worked around. Each blocks the gap
listed against it. They are ordered by what blocks the nearest phase.

### Immediate — blocks Phase 1 closing

**ADM-01 — Merge approval for PR #9 (D1).** — **Granted 2026-08-11.** Merged
as `e4dc28a`.

**ADM-24 — Merge approval for PR #11 (D2).** — **Granted 2026-08-11.** Merged
as `170c644`.

**ADM-25 — Merge approval for PR #12 (D3).** — **Granted 2026-08-11.** Merged
as `5469d17`.

**ADM-26 — Merge approval for PR #13 (D4).**
`fix(finance): serialise the issue on the invoice being issued`. One migration,
no schema change. 620 tests pass; 14 of the 29 new ones fail without the fix,
and ten mutations of the migration each fail the structural block. This is the
only approval that blocks work already finished.

### Blocks Phases 2–4 (finance)

**ADM-02 — Overdue policy** (G-004). Is there a grace period after `due_at`
before an invoice becomes `overdue`? Does becoming overdue notify anyone?

**ADM-03 — Refunds** (G-005). Does AgencyOS record refunds, or do they happen at
the bank and get entered as a note? `refund.issue` is currently an owner-only
capability with no implementation behind it.

**ADM-04 — Payment vocabulary** (G-006, G-007). The database stores
provider-shaped statuses (`created`/`authorized`/`captured`/`failed`/`refunded`).
The directive names business-shaped ones
(`PROPOSED`/`REQUESTED`/`PENDING`/`RECEIVED`/`VERIFIED`/`FAILED`/`REFUNDED`/`DISPUTED`).
Adopt one. If `VERIFIED` is distinct from `RECEIVED`, say what performs the
verification.

### Blocks Phase 5 (CRM completion)

**ADM-05 — Returning clients** (G-016). A past client messages the same WhatsApp
number about a second project. Does that reopen the existing lead, create a
second lead against the same contact, or create an opportunity directly?

**ADM-06 — Onboarding checklist** (G-017). Directive §8 requires one. What is on
it, and which items block the project from starting?

### Blocks Phase 6 (proposals)

**ADM-07 — Proposal content and approval** (G-011). `sales.proposals` has had
tables since day one and no code. What does a proposal contain, who may send
one, and does sending require approval?

### Blocks Phase 8 (approval engine) — the highest-leverage decision

**ADM-08 — Build the approval engine as designed** (G-040, G-044). Confirm
`ARCHITECTURE.md` §4.6 (`approvals.approval_requests` + `approval_policies`,
polymorphic subject, internal/client audience) is what gets built. Nine other
gaps depend on it. If it is not confirmed, design work must be redone before
Phases 12 and 24 can start.

### Blocks Phase 10 (outbound)

**ADM-09 — Outbound messaging** (G-014). Which channel, from which number or
address, and which of GREEN/YELLOW/RED does each message type fall into?
Currently nothing in this codebase can send anything to a client, and the tests
assert that.

### Blocks Phase 11 (sales lifecycle)

**ADM-10 — Sales state vocabulary** (G-010). Extend `crm.leads.status` /
`sales.opportunities.stage` to the directive's ten states, or keep 5+5 and
record `SAMPLE_SENT`/`DEMO_SENT`/`OFFER_SENT` as `lead_activities`? The second
is cheaper and loses no information; the first makes the pipeline queryable by
state. This needs a business answer, not a technical one.

**ADM-11 — Follow-up triggers** (G-012). Which situations warrant a follow-up,
after how long, and does the draft send automatically or wait for approval?

**ADM-12 — Sample and portfolio catalog** (G-013). AI may not invent portfolio
claims (directive §6). An approved catalog must exist before AI can recommend
from one. Does it exist outside this system today?

### Blocks Phase 12 (delivery)

**ADM-13 — Project start conditions** (G-026). The directive's §11 asks for
explicit conditions; the code has a free `onboarding → active` transition. State
the conditions, including which are waivable and by whom.

**ADM-14 — Artifact storage** (G-021, G-023). Designs, APKs and builds need
somewhere to live. Supabase Storage is provisioned and unused. Confirm, or name
an alternative.

**ADM-15 — Secure credential transfer** (G-025, G-032). Handover involves
credentials. Directive §22 and §40 forbid putting them in chat or logs. What is
the sanctioned mechanism?

**ADM-16 — Requirement breakdown authorship** (G-020). Requirement → feature →
task: human, AI-proposed-human-approved, or both?

**ADM-17 — Defect severity vocabulary** (G-030). The directive says P0–P3;
`ARCHITECTURE.md` §4.8 says blocker/major/minor/trivial. Pick one.

**ADM-18 — Milestone unlock stays advisory?** (G-027). Once real delivery gates
exist, should payment continue to be advisory, or start hard-gating work?

### Blocks Phase 20 (production)

**ADM-19 — Production-ready conditions** (G-031). The exact list. Directive §20
suggests: zero P0/P1 defects, required approvals complete, payment condition
satisfied, build and deploy successful, security checks pass, documentation
complete. Confirm or amend.

**ADM-20 — Production environment** (G-052). Supabase production project,
Vercel project and environment names, who holds the secrets, and who may deploy.

**ADM-21 — Observability tooling** (G-053).

### Blocks Phases 22–24 (client success and upsell)

**ADM-22 — Service and offer catalog** (G-034, G-035, G-036). AI may not invent
pricing or offers. Until an Admin-approved catalog exists, no upsell automation
can be built at all.

### Blocks Phase 21 (documentation)

**ADM-23 — Business rules** (G-055). The ten `docs/business-os` documents are
empty. Most decisions above end up written there. This is the same decision set,
not an additional one.

---

## 6. Execution order

The directive's 26 phases, reconciled against what the baseline actually needs.
Where a phase's work is already done, that is stated rather than repeated.

| Phase | Work | Status | Blocked by |
| --- | --- | --- | --- |
| 0 | Baseline + documentation | **This document. Complete.** | — |
| 1 | D1 finance concurrency | **Closed.** Merged as `e4dc28a` | — |
| 2 | D2 stale invoice void (G-002) | **Closed.** Merged as `170c644` | — |
| 3 | D3 ledger failure semantics (G-003) | **Closed.** Merged as `5469d17` | — |
| 4 | Full finance audit (G-004…G-009, G-060…G-062) | **In progress.** D4 implemented (PR #13); D5, D6, D7 open. The four vocabulary/policy items still need decisions | ADM-02, ADM-03, ADM-04, ADM-26 |
| 5 | CRM / sales completion (G-016, G-017) | | ADM-05, ADM-06 |
| 6 | Requirements / proposals (G-011) | | ADM-07 |
| 7 | Billing | Largely covered by Phase 4 | — |
| 8 | **Authorization + approval engine (G-040, G-044)** | The keystone: nine gaps depend on it | ADM-08 |
| 9 | Jobs / reaper (G-058) | Reaper exists; dead-letter visibility missing | — |
| 10 | WhatsApp / webhook hardening (G-014) | Inbound is hardened (C5, C6 closed) | ADM-09 |
| 11 | Sales lifecycle (G-010, G-012, G-013) | | ADM-10, ADM-11, ADM-12 |
| 12 | Projects / delivery (G-020…G-033) | The largest block of missing work | ADM-13…ADM-18 |
| 13 | Identity | Built | — |
| 14 | Database invariant audit | | — |
| 15 | Concurrency audit (G-059) | Partly done via C2, C8, D1 | — |
| 16 | Error semantics audit (G-054) | | — |
| 17 | Test architecture | Strong at unit/integration; concurrency and live layers thin | — |
| 18 | **CI hardening (G-050, G-051)** | **Done.** Pulled forward, as recommended | — |
| 19 | Security hardening | | — |
| 20 | Deployment / production readiness (G-052, G-053) | | ADM-19, ADM-20, ADM-21 |
| 21 | Documentation completion (G-055, G-056) | | ADM-23 |
| 22–24 | Client success, upsell architecture and implementation | | ADM-22 |
| 25 | Automation control plane (G-041) | | ADM-08 |
| 26 | Continuous autonomous development | | — |

### 6.1 One recommended deviation, for the Admin to accept or reject

**Pull Phase 18 (CI) forward, to run alongside Phase 2.**

The directive orders CI at Phase 18. The baseline argues for earlier: 549 tests
and 23 migrations exist, and **not one of them runs automatically.** Every claim
of "tested" from here to Phase 17 rests on somebody having run `npm run check`
by hand. Directive §39 says exactly this — *"Do not claim 'tested' because a
test file exists"* — and without CI the same hazard applies to tests that exist
and pass locally on one machine.

This is a recommendation, not a change of plan. The order stands unless the
Admin says otherwise.

---

## 7. Closed work — C1 through C8

Merged, deployed and verified. **Closed. Not to be reopened, refactored or
modified.** A genuine regression here becomes a new finding that references the
original, per directive §2.

| ID | Finding | Landed in |
| --- | --- | --- |
| C1 + C3 | One proposal per transcript, one accepted version per conversation | PR #3 |
| C2 | Race-free requirement-version allocation | PR #4 |
| C4 | Honest failure settlement for extraction | PR #4 |
| C5 | Inbound WhatsApp messages no longer discarded silently | PR #6 |
| C6 | No requirement extraction from a settled lead | PR #7 |
| C7 | Requirement approval gate executed by tests, not merely read | PR #8 |
| C8 | Requirement-version lookups scoped by organization | PR #5 |

Findings: **D1** closed (`e4dc28a`). **D2** closed (`170c644`). **D3** closed
(`5469d17`). **D4** implemented, PR #13. Open: **D5** (G-060) a transient read
parks a milestone unlock as dead on the first attempt; **D6** (G-061)
`loadInvoice` reports an unreadable database as a missing invoice; **D7**
(G-062) `voidInvoice` still answers idempotence from an unlocked read.

Four of the seven money findings are the same defect — a decision taken from a
copy of a row, then written back as if the copy were still true. D1, D2, D4 are
that defect; D3, D5, D6 are its sibling, a failed read reported as a fact.

---

## 8. Definition of Done

Restated from directive §47, with the state of each at this baseline.

| Dimension | Done means | Today |
| --- | --- | --- |
| Business | Full client lifecycle represented | 5/24 stages complete |
| Sales | Lead → close managed | Partial |
| Onboarding | Client/project initialization controlled | Partial |
| Payments | Milestone billing safe | D1, D2, D3 closed; D4 pending merge; D5, D6, D7 open |
| Design | Versioned approval workflow | Missing |
| Prototype | Versioned client review | Missing |
| Development | Tasks, builds, deliverables tracked | Tasks only |
| QA | 360° testing exists | Missing |
| Handover | Final delivery auditable | Missing |
| Client success | Maintenance/support exists | Missing |
| Upsell | Approved commercial automation | Missing |
| Security | Auth, RLS, tenant isolation verified | RLS on all 27 tables; scripts verify |
| Reliability | Concurrency and idempotency verified | Partial |
| Database | Critical invariants enforced | Strong where built |
| Testing | Critical behaviour executable in CI | CI runs every check on every PR |
| Operations | Deployment, rollback, monitoring documented | Missing |
| Automation | Routine work automated | One agent, one handler |
| Governance | Admin approval controls high-risk decisions | One bespoke gate |
| Audit | Every important action traceable | Append-only log, 15 call sites |

---

## 9. Companion documents

| Document | Contents |
| --- | --- |
| `AGENCYOS_ARCHITECTURE.md` | As-built architecture and the delta against `ARCHITECTURE.md` |
| `AGENCYOS_DOMAIN_MODEL.md` | Entities, state machines, invariants, where each is enforced |
| `AGENCYOS_AUTOMATION.md` | Jobs, events, agents, trust levels |
| `AGENCYOS_SECURITY.md` | Auth, RLS, tenancy, service-role call sites, secrets |
| `AGENCYOS_OPERATIONS.md` | Environments, deployment, verification, runbooks |
| `AGENCYOS_APPROVAL_POLICY.md` | What requires approval today, and what will |
| `docs/roadmap/roadmap.json` | The same roadmap and gap matrix, machine-readable |

---

## 10. Change log

| Date | Commit | Change |
| --- | --- | --- |
| 2026-08-11 | `2881caa` | Document created. Baseline established: 47 gaps, 23 Admin decisions, 549 tests passing, no CI. |
| 2026-08-11 | `e4dc28a` | Phase 1 closed. D1 merged; ADM-01 granted. |
| 2026-08-11 | `6d6b840` | Baseline documentation merged (PR #10). |
| 2026-08-11 | `170c644` | Phase 2 closed. D2 merged; ADM-24 granted. New finding **D4** (G-009) raised during review — 48 gaps. |
| 2026-08-11 | `5469d17` | Phase 3 closed. D3 merged; ADM-25 granted. All three original finance findings fixed. New finding **D5** (G-060) — 49 gaps. |
| 2026-08-12 | (PR #13) | Phase 4 begun. D4 implemented: G-009 D → A, pending ADM-26. New findings **D6** (G-061) and **D7** (G-062) — 51 gaps. Gap ids for these three were corrected from G-010–G-012, which already belonged to the CRM/sales block. |
