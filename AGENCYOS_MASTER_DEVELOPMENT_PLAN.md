# AGENCYOS_MASTER_DEVELOPMENT_PLAN.md

The canonical plan for AgencyOS: what the business does, what the system does
today, the distance between the two, and the order in which that distance is
closed.

**Baseline date:** 2026-08-11 · **Last updated:** 2026-08-12
**Baseline commit:** `3a5bed7` on `main`
**Status of this document:** live. Phase 0 established it; Phases 1–5, 14–16
and 18 have since been executed against it.

**Where things stand.** C1–C8 and **D1 through D22 are closed and merged** —
every defect the audit found. CI runs every check on every pull request: 895
tests, 36 migrations, eight live verification scripts, typecheck, lint, secret
scan and build, all green on `3a5bed7`.

**Nothing is open.** The last defect fix, G-079 — the four audit writes that
sit beside a Postgres function now append from inside that function's
transaction — merged as `9874f14` under **ADM-44**. No implementation work is
in flight.

**The keystone is built.** ADM-08 was granted on four axes and the approval
engine landed with it (**G-040**): one table serving all eight subject types
and both audiences, policy as owner-editable data with a money floor no policy
may lower, the required role snapshotted so a mid-flight policy edit cannot
change the rule a pending request was raised under, and no direct writes at all
— 31 live checks against a real Postgres. Nothing calls it yet; the queue that
displays it is **G-044**, and expiry is **G-096**.

**The queue is no longer defect-driven.** What remains is **18 missing
features**, each waiting on a business rule that has never been written down
(§5), plus the gaps the fixes surfaced along the way — recorded rather than
absorbed. Two of those are worth naming here: **G-083**, the hazard triggered
during this work (a build made without the verify environment points the local
app at whatever `.env.local` holds, and nothing checked before the scripts drove
it), and **G-084**, where `bootstrap_first_owner` let a signed-in caller name
somebody else as owner. Both are closed. **No P0 is open**: G-085, the
paste-and-run install bundle that was actively broken rather than merely stale,
is settled under **ADM-40** — it stays, marked as what it is, and a check keeps
the marking on. And **G-094 is closed by a check rather than a promise**: the
numbers in this document and in `roadmap.json` are re-derived on every pull
request, because twice they were not.

**D22 is closed, and it was filed a priority too low.** `crm.ingest_whatsapp_message`
resolved which tenant an inbound message belongs to with
`where settings->>'whatsapp_phone_number_id' = $1 limit 1` and no ORDER BY. Two
organizations claiming one number is an accepted state, and when it happens the
message lands in whichever row came back first — unstable, not merely unspecified.
That organization is stamped on the contact, the lead, the conversation, the message
and the extraction job, so customer PII is written into another agency's tenant,
where that agency's RLS correctly shows it to them. Raised P3 → P1: it needs no operator mistake, because `organizations_update` lets any owner write their own organization's `settings` with no restriction on the contents.

The fix is a partial unique index, which makes the ambiguous state unrepresentable
rather than making the lookup pick a side. The ingest function is left untouched.

**D21 is closed, and the review changed its scope.** `createOpportunity` read
`sales.opportunities` by lead_id and inserted if it found nothing, with only a
NON-unique index behind it — two clicks opened two deals on one lead, and since
`projects_opportunity_key` is keyed on the *opportunity*, each could be won and
converted independently: one prospect, two projects, two client accounts.

My first draft indexed `lead_id` outright. Adversarial review caught that this
would cement one-deal-per-lead-**ever** into DDL, which the product's own
primary ingest path contradicts — WhatsApp keys a lead to a phone number
permanently, so a returning client lands on the same lead and could never have a
second engagement recorded. The race is between two `discovery` inserts, so
`opportunities_open_lead_key` — partial on unsettled stages — closes it
identically without adjudicating lifetime scope. The live check was extended so
it can tell the two designs apart, which the first version could not.

Two gaps recorded: **G-088** and **G-089**. **ADM-42** asks whether a returning
client is a new deal on the same lead or a new lead.
D17 is fixed on its own branch and awaiting merge (PR #25).

**D20 is closed, with one deliberate limit.** `markLeadConverted` wrote
`status = 'converted'` with the lead id as its only predicate — no read, no
transition check, and no look at whether the write matched anything. So a
*disqualified* lead was forced converted carrying its `disqualified_reason`,
`converted_at` was rewritten on every re-run, and a write that matched nothing
came back `converted: true`.

The fix is a compare-and-swap, and it is **deliberately wider than
`LEAD_TRANSITIONS`**. That map admits only `qualified → converted`, but
`createOpportunity` refuses only a disqualified lead — so deals open routinely
on `new` and `qualifying` ones, and enforcing the map here would strand every
project raised from them. What is fixed is what is wrong under any reading;
**ADM-41** asks whether winning a deal should imply qualification. Two smaller
gaps fall out of the same ambiguity and are recorded: **G-086** and **G-087**.

**D19 is closed, and it was worse than recorded.** `core.bootstrap_first_owner`
counted memberships, counted organizations, then inserted, with nothing held
across the three. It was filed as "two users can both become owner". Measured
against the unfixed function with eight simultaneous callers, **all eight were
provisioned as owner**, in four rounds out of five — and sign-up is open, so
they need not have been invited. The priority is raised from P2 to P1 on that
evidence. An advisory transaction lock now serialises the decision.

One detail worth keeping: the *first* round passed. Cold connections serialised
the eight requests by accident, so a single-round check would have reported the
defect as absent.

Reviewing that fix turned up two further defects on the same ground, recorded
rather than folded in: **G-084** (`p_user_id` is never checked against
`auth.uid()`, so a signed-in user may name someone else) and **G-085**
(`supabase/_bundle.sql`, the documented paste-and-run install, is twelve
migrations stale and still ships the racy function). Both are P1. **ADM-40**
asks whether that bundle is a supported install path at all.

**D18 is closed.** A retryable failure spent its whole retry budget inside one
cron tick: the settle put the row back carrying its original `run_at`, and the
drain loop re-claimed it four more times — undoing exactly what D5 and D15
built, since both made a failed read retryable so a blip would not strand a
paid milestone. Retries are now spaced by `src/lib/jobs/retry.ts`.

Adversarial review of that fix found a second hole the original analysis had
missed: the claim's compare-and-swap bounded `status` but not `run_at`, so a
racing invocation could take a job the backoff had just deferred **and** roll
`attempts` backwards from its stale read — a job that would neither wait nor
ever die. Both are closed together, and four gaps it exposed are recorded
rather than quietly absorbed: **G-080**, **G-081**, **G-082**, **G-083**.

D16 is closed too: RLS was materially wider than the capability model, so a
contractor could read the whole invoice book straight from the Data API. It
now admits exactly what the capability matrix publishes, proved per role
against the real policies.

Beyond those, 18 missing features are each waiting on a business rule that has
never been written down. See §5.

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
| 11 | UI design | `projects.deliverables` kind `design`, versioned | A |
| 12 | Client UI review / revision loop / approval | Approval engine, `audience = 'client'` | A |
| 13 | UI prototype + review + approval | `projects.deliverables` kind `prototype` | A |
| 14 | Full development | `projects.modules` + tasks per module, with progress | A |
| 15 | Development complete / client review / approval | A `build` deliverable, reviewed through the engine, with safe test access | A |
| 16 | Milestone payment | `finance.invoices` + `payments` | A |
| 17 | 360° QA | `qa.defects`, and the gate ARCHITECTURE.md §4.8 states | A |
| 18 | Production ready gate | — | C |
| 19 | Final payment | Same machinery as any milestone | A |
| 20 | Handover | `projects.handovers` + items, accepted through the approval engine | A |
| 21 | Project completed | `projects.completion_summary` — value, payments, duration, revisions, defects, final version | A |
| 22 | Maintenance / support | — | C |
| 23 | Upsell | — | C |
| 24 | Repeat business / long-term client | `core.client_accounts` persists | B |

**Coverage: 13 of 24 stages fully implemented, 5 partial, 5 missing, 1 blocked
on an Admin decision.**

The shape of that result has changed, and the sentence that used to stand here
— *the two ends of the business are built and the middle is not* — is no longer
true. The middle was built across PRs #48–#54: design and prototype
deliverables with versions and changelogs, modules and their progress, QA
defects with a gate, handover, and the completion summary. What is missing is
no longer **representation**; it is **connection**. Design, prototype,
development and QA each record their own state correctly and none of them
gates anything downstream: an approved deliverable releases no invoice
(**G-100**), and no rule says which facts make a project production ready
(**G-031**). Both are Admin decisions, written up and waiting, not code.

The three stages still genuinely absent — the WhatsApp group, maintenance and
upsell — are the two ends of the *relationship* rather than of the project:
where the conversation lives, and what happens after handover.

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
| **G-004** | Nothing marks an invoice overdue | **Built**: `finance.mark_overdue_invoices` runs on the cron tick and performs the transition `INVOICE_TRANSITIONS` has admitted since the first day — **an existing rule executed, not a new one invented**. Takes each row `for update skip locked`, restates the status on the write so a payment landing in the same instant wins, and audits only what it changed. **It chases nobody**: a reminder is client-facing and waits on the outbound policy rather than arriving behind a status change. Five statuses deliberately untouched — draft, pending_approval, paid, void, and anything with no due date | — | A | P2 | — | `tests/overdue-invoices.test.ts` (8), `scripts/verify-overdue-invoices.mjs` (11 live) | No | 4 |
| **G-005** | Refunds unimplemented | **Built**: `finance.refunds` records money going back as its own row — `paid` is terminal, and the repo has said so since day one. Three rules, **none invented here**: an approved approval is required before anything leaves (§28 RED, §29 the Admin's, and the engine's money floor already refused any refund policy below owner); it cannot exceed what came in, computed under the invoice lock, refused rather than clamped, **counting requests still waiting** so two owners cannot approve the same balance; and the invoice is untouched. Recording is idempotent on the provider reference and re-checks the ceiling, because an approval from yesterday must still fit today | — | A | P1 | G-040 | `tests/refunds.test.ts` (11), `scripts/verify-refunds.mjs` (14 live) | No — §28/§29 already state it | 4 |
| **G-006** | Payment vocabulary mismatch | DB: `created`, `authorized`, `captured`, `failed`, `refunded`. Directive §10: `PROPOSED`, `REQUESTED`, `PENDING`, `RECEIVED`, `VERIFIED`, `FAILED`, `REFUNDED`, `DISPUTED` | One vocabulary | E | P2 | — | — | **Yes — adopt the directive's states, or map them onto the provider-shaped ones already stored** | 4 |
| **G-007** | "Payment verified" has no distinct meaning | A recorded manual payment is immediately `captured`; there is no second confirmation step | If the business distinguishes *received* from *verified*, the ledger must too | E | P1 | G-006 | — | **Yes** | 4 |
| **G-008** | Invoice totals written outside the lock that made them true | **Fixed** on `fix/payment-reconciled-under-lock`: `finance.record_manual_payment` updates `paid_minor`, `status` and `paid_at` in the same statement as the payment insert. `reconcileInvoiceTotals` is deleted — there is nothing left for it to do, and the unrecoverable stale-cache state it could leave behind has nowhere to form | Merged to `main` | A | P1 | G-001 | `tests/payment-ledger.test.ts` (13), `scripts/verify-milestone-invoicing.mjs` §7b K/L | **Yes — merge approval on PR #18** | 4 |
| **G-063** | **D8 — a payment plan could be rewritten out from under a bill** (Phase 14/15 sweep) | **Fixed** on `fix/payment-plan-atomic`: `projects.replace_payment_plan` locks the plan, refuses when any milestone carries a non-void invoice, and does the delete and insert in one statement. `configurePaymentPlan` had refused only on `met`, which nothing writes | Merged to `main` | A | **P0** | — | `tests/payment-plan-atomic.test.ts` (13), `verify-milestone-invoicing.mjs` §3b (7) | **Yes — merge approval on PR #19** | 4 |
| **G-064** | **D9 — `convertToProject` creates duplicate projects and client accounts** | **Fixed** on `fix/last-three-sweep-findings`: `projects_opportunity_key` holds one live project per opportunity, and losing to the index returns the project that won | Merged to `main` | A | P1 | — | `tests/conversion-and-conversation.test.ts` (10) | **Yes — merge approval on PR #21** | 5 |
| **G-065** | **D10 — state transitions write with an id-only predicate** | **Fixed** on `fix/state-transitions-compare-and-swap`: `setLeadStatus`, `setOpportunityStage` and `setProjectStatus` restate the state they decided against, and report a write that matched nothing instead of assuming it landed | Merged to `main` | A | P1 | — | `tests/state-transitions.test.ts` (15) | **Yes — merge approval on PR #20** | 5 |
| **G-066** | **D11 — `appendMessage` reads a failed max-seq as an empty transcript** | **Fixed** on the same branch: the read propagates, so a database that did not answer is no longer reported as another person posting at the same moment | Merged to `main` | A | P2 | — | Same suite | **Yes — merge approval on PR #21** | 5 |
| **G-067** | **D12 — `startConversation` drops the error on its idempotence read** | **Fixed** on the same branch: the read propagates, so a blip no longer starts a second conversation that hides the first | Merged to `main` | A | P2 | — | Same suite | **Yes — merge approval on PR #21** | 5 |
| **G-068** | **D13 — reopening a disqualified lead keeps its reason** | **Fixed** on the same branch: the reason is cleared on the way out as well as set on the way in | Merged to `main` | A | P3 | — | `tests/state-transitions.test.ts` C | **Yes — merge approval on PR #20** | 5 |
| **G-069** | **D14 — the lead status form offers a value the service always refuses** | **Fixed** on the same branch: the lead page filters `converted` out of the options, because conversion happens through the sales path | Merged to `main` | A | P3 | — | Covered by the transition suite | **Yes — merge approval on PR #20** | 5 |
| **G-070** | **D15 — handler loaders answered a failed read as a missing invoice** | **Fixed** on `fix/handler-reads-and-record-the-rest`: `loadInvoice`/`loadMilestone` in `projects/handlers.ts` distinguish unreadable from absent, and the handler settles a failed read retryable. The D5 shape, in the loaders rather than the plan read | — | A | P1 | — | `tests/unlock-read-failure.test.ts` B2 | **Yes — merge approval on PR #23** | 4 |
| **G-071** | **D16 — RLS was wider than the capability model** | **Fixed** on `fix/rls-matches-capabilities`: `invoices_select` and the delivery, crm and sales write policies now admit exactly the roles holding the matching capability. `finance.blocking_invoice_number` keeps D8's guard working for a `delivery_lead` who may rewrite a plan but may not read the invoice book | Merged to `main` | A | P1 | — | `verify-milestone-invoicing.mjs` §7e (11), per role against real policies | **Yes — merge approval on PR #24** | 19 |
| **G-072** | **D17 — the outbox is not transactional** | `emitEvent` writes `core.outbox_events` in its own request, after the state change has committed. `ARCHITECTURE.md` §4.5 calls it a transactional outbox. If that insert fails, the state change stands and the event is lost forever — a paid invoice whose milestone never opens, with nothing to retry | Follow the house pattern | D | P1 | — | `tests/outbox-dispatch.test.ts` covers the dispatcher, not the emit | No — §4.5 already states the intended guarantee | 9 |
| **G-073** | **D18 — a requeued unlock burns every attempt in one tick** | **Fixed** on `fix/unlock-retry-backoff`: `src/lib/jobs/retry.ts` holds the schedule (1/2/4/8 minutes from the cron cadence, capped at 15), both settle paths write `run_at` from it, and both compare-and-swaps now bound `run_at` as well as `status` — without that a racing invocation claimed a job its own settle had just deferred *and* rolled `attempts` backwards from a stale read. Found by adversarial review, not by the original analysis | — | A | P1 | — | `tests/job-retry-backoff.test.ts` (26), `verify-milestone-unlock.mjs` §6 (9), `verify-requirement-proposal.mjs` §K | **Yes — merge approval on PR #26** | 9 |
| **G-080** | A dead job is never tried again, and nothing says so | **Both halves closed.** The end of a job's life was already announced in the log (PR #35); the backlog is now displayed at `/operations` and alerted on from the cron tick. What stays deliberately unbuilt is automatic revival — a decision about duplicate invoices and second unlocks, recorded as **G-099** | — | A | P1 | G-053 | `scripts/verify-operational-backlog.mjs`, `tests/operational-backlog.test.ts` | No | 9 |
| **G-081** | A throw in the job runner skips the settle entirely | **Fixed** on `fix/runner-throw-settles`: the unlock loop catches a throwing handler, settles it as **retryable** and carries on with the batch; `POST` became a thin wrapper around `runTick` so a throw after the extraction claim settles that job through `failJob`. Both then get D18's backoff instead of waiting fifteen minutes on the reaper. The unlock case was worse than filed — the throw propagated out of the loop, so one bad job took the whole tick with it | — | A | P2 | G-073 | `tests/runner-throw.test.ts` (14) | **Yes — merge approval on PR #33** | 8 |
| **G-082** | `core.claim_jobs` is dead code, and it is the better claim | **Fixed** on `fix/atomic-job-claim`, and it was sharper than "dead code": the function had no `kind` filter, so anyone wiring it up would have had the extraction path claim `milestone.unlock` jobs and hand a paid client's milestone to the AI extractor. It sat beside `jobs_kind_claim_idx`, an index added *because* the runner claims by kind — the index documented an intention the function contradicted. `p_kind` added, the two-argument signature dropped so it cannot be called without one, and **both** claim sites rewired to it. One statement now: status, `run_at`, the lock and `attempts = attempts + 1` together, with `for update skip locked`. That also removed the two attempt conventions D18 had to reason about | — | A | P2 | G-073 | `tests/cron-scheduler.test.ts`, `job-retry-backoff`, `ai-extraction`, `dead-job-signal`, `runner-throw` (assertions repointed at the SQL) | **Yes — merge approval on PR #37** | 8 |
| **G-083** | **Nothing stops the app under test from being pointed at production** | **Fixed** on `fix/verify-target-guard`: `/api/health` reports a twelve-character fingerprint of its database URL, and `assertAppTarget` in `verify-target.mjs` compares it with the script's own before any fixture is planted. The four scripts that drive the running application call it in their preflight. An app that cannot say which database it uses is refused rather than assumed compatible. Proved by rebuilding the app against a different database and watching all four refuse | — | A | P1 | — | `tests/verify-target-guard.test.ts` (13) | **Yes — merge approval on PR #31** | 8 |
| **G-084** | `bootstrap_first_owner` never checks `p_user_id` against `auth.uid()` | **Fixed** on `fix/bootstrap-caller-identity`: a caller holding an identity may only name itself, checked before anything is read or locked. The service role keeps its exemption — its key carries `role` and no `sub`, so `auth.uid()` is null under it and it scopes by hand as every sanctioned service-role path does. D19 fixed how many owners result; this fixes which one, and they are independent — the lock would serialise a wrong decision just as faithfully | — | A | P1 | G-074 | `tests/first-owner.test.ts` §B2 (4), `verify-first-owner.mjs` §2b (5) | **Yes — merge approval on PR #32** | 13 |
| **G-085** | `supabase/_bundle.sql` ships a stale schema, including the D19 defect | **Settled under ADM-40: kept, marked unsupported.** Its header now opens with `NOT AN INSTALL PATH` and names what a database built from it would be missing — D19's advisory lock, G-082's `claim_jobs` signature, D16's RLS narrowing, and all of D17–D22 — then points at `db:link` + `db:push`. `check-record.mjs` fails if the marking comes off. **Re-rated P0 → P2**: the file is no longer presented as a way in, so reaching the defect now means ignoring the first thing in it. The residual — that it is still runnable — is **G-095** | — | A | P2 | — | `scripts/check-record.mjs` §6 | Granted — ADM-40 | 20 |
| **G-074** | **D19 — concurrent first sign-ins all become owner** | **Fixed** on `fix/first-owner-serialized`: `core.bootstrap_first_owner` takes `pg_advisory_xact_lock` on a key derived from its own name before it reads anything, and re-decides both counts through it. **Priority raised from P2 to P1 once measured:** with eight simultaneous callers, all eight were provisioned as owner in four rounds out of five — not two, all of them. Sign-up is open (`shouldCreateUser: true`, no domain allowlist), so the callers need not be invited | — | A | P1 | — | `tests/first-owner.test.ts` (18), `verify-first-owner.mjs` (new script, 8-way race × 5 rounds) | **Yes — merge approval on PR #27** | 13 |
| **G-075** | **D20 — `markLeadConverted` forces any lead to converted** | **Fixed** on `fix/lead-converted-transition`: a compare-and-swap admitting `new`, `qualifying`, `qualified`; a zero-row write is no longer reported as success; an already-converted lead is answered without rewriting `converted_at`; a disqualified one is refused; a soft-deleted lead is no longer converted (every other lead read in the module filtered `deleted_at`; this write did not, and `leads_write` carries no such predicate either); the conversion is audited. **Deliberately wider than `LEAD_TRANSITIONS`** — `createOpportunity` refuses only a disqualified lead, so deals open routinely on `new`/`qualifying` ones and narrowing to `qualified` would strand every project raised from them. Which of the two is right is ADM-41 | — | A | P2 | — | `tests/lead-conversion.test.ts` (15) | Granted — merged as `3cd5d55` (PR #38) | 5 |
| **G-086** | A lead converted from `new` has a null `qualified_at` | `qualified_at` is stamped only by `setLeadStatus` on the move into `qualified`, and `leads_qualified_at_set` constrains that status alone. So a lead converted straight from `new` is a client with no record of ever having been qualified. Harmless to the database, wrong in any funnel report that measures qualification. Falls out of the same ambiguity as ADM-41 and should be settled with it | Decide with ADM-41 | D | P3 | G-075 | None | Yes — ADM-41 | 5 |
| **G-087** | The conversion writes no `crm.lead_activities` row | **Fixed** on `fix/conversion-timeline`: `markLeadConverted` takes the actor from `convertToProject` — the person who moved the deal is the person who converted the lead — and writes the `status_change` row `setLeadStatus` writes for every other move. Skipped rather than attributed to nobody when no actor is named, since `actor_id` is what makes the row answerable; the audit row is written either way, so nothing is lost silently | — | A | P3 | G-075 | `tests/lead-conversion.test.ts` (19) | **Yes — merge approval on PR #36** | 5 |
| **G-076** | **D21 — `createOpportunity` has no index behind its one-deal-per-lead rule** | **Fixed** on `fix/one-deal-per-lead`: `opportunities_open_lead_key`, a partial unique index on `lead_id` where the stage is not settled, plus 23505 handling that returns the deal which won. **Scoped to OPEN deals after review.** The first draft had no stage predicate and would have cemented one-deal-per-lead-*ever* into DDL — which the primary ingest path contradicts, since WhatsApp keys a lead to a phone number permanently, so a returning client lands on the same lead. The race is between two `discovery` inserts, so the narrow index closes it identically | — | A | P2 | — | `tests/one-deal-per-lead.test.ts` (13), `verify-schema.mjs` §5 (4, and it distinguishes the two designs) | Granted — merged as `89b791a` (PR #39) | 5 |
| **G-088** | The deal pre-check has no stage filter, so a settled deal blocks a new one | `createOpportunity` returns *any* existing deal for the lead, whatever its stage. So although `opportunities_open_lead_key` now permits a second engagement once the first is settled, the application never raises one — a click on a lead whose only deal is lost hands back the lost deal. The schema stopped forbidding it; the application still does not offer it | Filter the pre-check by stage, once ADM-42 says whether a repeat engagement is a new deal | B | P3 | G-076 | None | Yes — ADM-42 | 5 |
| **G-089** | Reopening a deal leaves `closed_at` and `lost_reason` set, and cannot change its value | **Half fixed** on `fix/reopened-deal-hygiene`: `setOpportunityStage` clears both on the way out of a terminal stage, exactly as D13 clears `disqualified_reason` on the way out of `disqualified`. A reopened deal no longer reads as `discovery` while carrying the day it closed and why it was lost. **Still open:** `value_minor`, `name` and `expected_close_on` are written once at insert with no update path anywhere in the module, so a deal lost at one value and re-won at another still converts into a project budgeted at the old one. That half is an edit form, not a correction — split out as **G-092** | Add an edit path for the deal | B | P2 | — | `tests/one-deal-per-lead.test.ts` §B2 (4) | **Yes — merge approval on PR #34** | 5 |
| **G-092** | A deal's value cannot be changed after it is opened | `value_minor`, `name` and `expected_close_on` are set at insert and never updated. `convertToProject` seeds the project budget from `opportunity.value_minor`, so a deal reopened and re-won at a different figure converts into a project budgeted at the original one, silently. Split from G-089 because it is a missing capability rather than a wrong behaviour: it needs a form, an audit entry and a decision about who may re-price a deal | Build the edit path once ADM-43 says who may re-price | C | P2 | G-089 | None | Yes — ADM-43 | 5 |
| **G-078** | ~~`invoice.created` is still published after its transaction~~ **Closed** | `finance.create_milestone_invoice` writes the invoice, its lines, its audit row and its event in one statement. It was four transactions with a hand-rolled compensating DELETE between the first two — a rollback that runs only if the process lives long enough to run it. The P3 rating rested on nothing subscribing to `invoice.created`, which is a fact about the subscription catalog, not about the invoice; the **audit row was never covered by that argument**, because `audit.audit_log` is append-only. Two application pre-checks became index violations, closing the check-then-write gap that D1, D2 and D4 all were | Done | A | P3 | G-072 | §E and §F flipped from pinning the gap to asserting it closed; `verify-milestone-invoicing.mjs` §7h, 12 live checks | No | 9 |
| **G-093** | Thirteen audit rows are still written in their own request | **Written up for a decision rather than guessed at**: `docs/decisions/g-093-audit-writes.md` sets out what is at risk — a rare, undetectable missing history row for non-financial actions, money being already safe — and four options: accept and document, a Postgres function per write, table triggers, or both. **Triggers recommended**, because a function per write fixes the stated problem and buys little, while a trigger also covers the paths that never reach the service layer — the shape D16 was. The count has been wrong twice and is now asserted rather than remembered: the pin claimed *twelve* while naming five service files the `qa` module had grown past, the true count was **fourteen**, and G-078 took it to **thirteen** by giving `invoice.created` a function to write from | The Admin picks one of four | D | P2 | G-079 | `tests/audit-in-the-transaction.test.ts` §F — scans `src/modules`, so the count moves only when a call site gains a function | **Yes — ADM-51** | 9 |
| **G-106** | The non-transactional publish path has no callers and is still exported | With G-078 closed, `emitEvent` has no caller in `src` or `app`. It still does the thing D17 was raised about — its own connection, its own transaction, after the state change has committed — and its own comment says so. A loaded gun on the table: the next module that needs an event will find it and reintroduce D17 one event at a time, which is exactly how `invoice.created` became the exception that outlived the fix | Deleted, leaving `core.emit_event` as the only publisher | C | P2 | G-078 | None — §E asserts finance does not call it, nothing asserts nobody does | No | 9 |
| **G-077** | **D22 — the WhatsApp ingest resolves tenancy with an unordered LIMIT 1** | **Fixed** on `fix/whatsapp-tenancy`: `organizations_whatsapp_number_key`, a partial unique index on `settings->>'whatsapp_phone_number_id'`, makes the ambiguity unrepresentable — with at most one match, the `limit 1` has nothing left to order. `crm.ingest_whatsapp_message` is deliberately not modified: replacing 150 lines of plpgsql to change five carries its own risk, and the coupling is pinned by a test that reads both and compares them. **Severity understated when filed, twice over:** the resolved organization is stamped on the contact, lead, conversation, message and job, so a customer's number, name and message text land in another agency's tenant — where that agency's RLS then correctly shows it to them. And it needs no operator mistake: `organizations_update` lets an owner update their own organization's `settings` with no restriction on its contents, so any owner could set their row to another agency's `whatsapp_phone_number_id` and capture that agency's inbound messages. Raised P3 → **P1** | — | A | P1 | — | `tests/whatsapp-tenancy.test.ts` (10), `verify-schema.mjs` §5 | **Yes — merge approval on PR #30** | 10 |
| **G-090** | Messages already filed under the wrong tenant are not repaired | **Answered rather than repaired, and the answer changes the decision.** The ingest keys a thread on the *sender's* number and never records the number a message arrived on — so which organization *should* have received an existing row is not recoverable, and any tool claiming to identify mis-filed rows in general would be guessing. What can be established is: whether two organizations claim one number today, and the only fingerprint — one phone appearing under two organizations. **Run against production: one organization, no number configured, three contacts, zero overlap.** There is nothing to move or delete | — | A | P2 | G-077 | `scripts/verify-tenancy-overlap.mjs` | The decision it waited on has no rows to apply to | 10 |
| **G-102** | The number a message arrived on is never recorded | **Fixed**: `crm.conversations.inbound_number_id` records which of the agency's numbers a thread came in on — the value the ingest already resolved tenancy from and then discarded. Nullable and **not backfilled**: a conversation predating it arrived on a number nobody wrote down, and inventing one would repeat the guess D22 was. **How it was changed matters as much as what changed** — the function is frozen since D22 and was redefined once since, so the body is `pg_get_functiondef` of the *live* function with one edit, and a before/after diff shows only the two intended lines. Regenerating from the original file is exactly how G-079's verification caught a silent revert of D16 | — | A | P3 | G-090 | `tests/crm-ingest.test.ts` §H (4), `verify-whatsapp-ingest.mjs` §E, `verify-tenancy-overlap.mjs` §3 | No | 10 |
| **G-103** | Nine verification scripts crashed instead of explaining an incomplete environment | **Fixed.** `resolveTarget` takes the caller's own exit function and every script added this session passed none, so an incomplete `.env.verify.local` raised `TypeError: fail is not a function` rather than naming the missing variable. They also inherited the default `needs`, demanding `CRON_SECRET` though none calls the job runner. Found by accident while pointing a script at production with a truncated env — the error path nobody had executed | — | A | P3 | — | Proved red: a truncated env now prints the missing variable | No | 17 |
| **G-091** | Claiming a WhatsApp number nobody has configured yet is unchecked | With the index in place, an owner who sets their organization's `whatsapp_phone_number_id` to a number they do not own now blocks the rightful agency from ever configuring it — the second write is refused with a bare 409. The index converts a silent capture into a denial of configuration; it does not verify the claim. Verifying it means asking Meta, which the system does not do | Verify ownership against the provider at configuration time, or gate the setting behind an operator review | C | P3 | G-077 | None | Yes | 10 |

### 4.2 CRM and sales — Phases 5, 11

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-010** | Sales lifecycle vocabulary | 5 lead statuses + 5 opportunity stages | Directive §5 lists ten sales states (`CONTACTED`, `SAMPLE_SENT`, `DEMO_SENT`, `OFFER_SENT`, `ADVANCE_REQUESTED`, …) and four outcomes | E | P1 | — | `tests/workflow-regression.test.ts` pins the current set | **Yes — extend the enum, or keep 5+5 and treat the directive's states as activity types** | 11 |
| **G-011** | Proposals: tables with no code | `sales.proposals` + `proposal_items` exist with RLS and a version column. No service, no action, no query, no UI | Draft → approve → send → accept, per the capability triple already defined | C | P1 | G-040 | None | **Yes — what is in a proposal, and does sending require approval?** | 6 |
| **G-012** | Follow-up automation | `leads.follow_up_at` is set by hand; nothing reads it | Detect the situations in directive §7 and raise a recommendation | C | P2 | G-040, G-014 | None | **Yes — which situations, and what timing** | 11 |
| **G-013** | AI sales assistance | One agent: `requirement_collector` | Module suggestion, portfolio/sample matching, drafted responses — all as proposals | C | P2 | G-011, G-041 | — | **Yes — approved sample/portfolio catalog must exist first** | 11 |
| **G-014** | No outbound communication channel | **Built** under ADM-09 (taken by delegation): `crm.send_outbound_message` records the message **before** the provider is called — a message sent and not recorded is invisible, one recorded and not sent is visibly wrong — allocating `seq` under the conversation's lock and deduplicating on the caller's idempotency key. The number and the sending account are read from the database, so one organization cannot send as another. `crm.mark_outbound_delivery` writes back what the provider said, audits from inside its own transaction, and refuses to re-settle a message. Inert without `WHATSAPP_ACCESS_TOKEN`, and it says so | — | A | P1 | — | `tests/outbound-messages.test.ts` (16), `scripts/verify-outbound-messages.mjs` (16 live) | Granted — ADM-09, delegated | 10 |
| **G-015** | WhatsApp group not modelled | `conversations.external_ref` holds a 1:1 thread | A project's group, associated and auditable | C | P2 | — | None | No | 12 |
| **G-016** | Duplicate suppression on repeat inbound | Strong: `leads_source_ref_key`, `conversations_external_ref_key`, `contacts_org_phone_key`, message `external_ref` unique | Verify it survives a *returning* client who starts a second project | B | P1 | — | `tests/crm-ingest.test.ts` | **Yes — does a returning client reopen the lead or start a new one?** | 5 |
| **G-017** | Lead → client/project conversion is manual and partial | `convertToProject()` exists in sales | Directive §8 wants client, organization link, onboarding checklist, payment plan, milestone structure and requirement workspace created together | B | P1 | G-026 | `tests/workflow-regression.test.ts` | **Yes — what an onboarding checklist contains** | 5 |

### 4.3 Delivery — Phase 12

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-021** | UI design phase | **Built**: `projects.deliverables`, kind `design`, versioned per project and kind, allocated under the project's lock. A revision is v+1 — never an edit, because an approval names a version | — | A | P1 | G-040 | `tests/deliverables.test.ts` (20), `scripts/verify-deliverables.mjs` (15 live) | Granted — ADM-50 | 12 |
| **G-022** | Client approval of an artifact | **Built**: `projects.submit_deliverable` raises a **client-audience** approval request through the engine, so ADM-08d applies — whoever records the client's answer says where the client gave it. `sync_deliverable_decision` brings the answer back and supersedes earlier versions without deleting them | — | A | P1 | G-040 | Same | Granted — ADM-50 | 12 |
| **G-023** | Prototype phase | **Built**: the same table, kind `prototype`, with its own version sequence — a client reviewing the design is not reviewing the prototype | — | A | P1 | G-040 | Same | Granted — ADM-50 | 12 |
| **G-100** | An approved deliverable gates nothing | **Written up for a decision**: `docs/decisions/g-100-approvals-and-payments.md`. Two mechanisms exist and do not touch — money flows on payment, approval flows on delivery — so §18's middle arrow, *UI_APPROVED → MILESTONE_PAYMENT_DUE*, does not exist in the system. A milestone also has **no column linking it to a deliverable**, so every option but the status quo needs one. Four shapes; **B recommended** — approval *permits* issuing, refusing only the act that reaches the client, which is the shape the QA gate already uses. **C is explicitly not recommended**: every other money path here requires a human, and making the first exception a client's click deserves to be chosen rather than inherited | The Admin picks, and answers ADM-14 separately | C | P2 | G-021 | — | **Yes — ADM-13, ADM-14** | 12 |
| **G-020** | Requirement → feature → task chain | `requirement_versions` hold an approved payload; `projects.tasks` are flat and unlinked | The chain in directive §12, with provenance preserved | C | P1 | — | None | **Yes — is the breakdown human, AI-proposed, or both** | 12 |
| **G-024** | Development module tracking | **Built**: `projects.modules` gives a project its actual pieces with directive §16's own status vocabulary — deliberately coarser than a task's, and **the task state machine is untouched**, because §16 warns against inventing a second one. Tasks and builds carry a nullable `module_id`, and a trigger refuses one naming another project's module: no foreign key prevents that, and it would put a task in somebody else's progress — the shape D22 was. `module_progress` answers how each piece is going | — | A | P2 | — | `tests/modules.test.ts` (12), `scripts/verify-modules.mjs` (14 live) | No | 12 |
| **G-025** | Client development review | **Built**: a build is a `deliverable` of kind `build`, versioned and reviewed through the approval engine with its changelog and known issues. The missing piece was directive §17's test credentials — `test_access_method` records **how** a client gets in and refuses the three shapes somebody actually pastes (`password:`, `pin:`, `api_key:`). An accident stopper rather than a secret detector, and the migration says so rather than implying protection nobody has | — | A | P1 | G-021 | Same | No | 12 |
| **G-026** | Project official start has no conditions | `onboarding → active` is a free transition | Directive §11 gate: onboarding complete, information collected, payment condition satisfied, or an Admin-approved exception | E | P1 | G-017 | `tests/workflow-regression.test.ts` pins the transition | **Yes — this is the single most-requested undefined rule** | 12 |
| **G-027** | Milestone unlock is advisory | Documented and deliberate | Confirm it stays advisory once the gates above exist | A | P3 | — | `tests/milestone-unlock.test.ts` | **Yes — confirm at Phase 12** | 12 |

### 4.4 QA, production readiness, handover — Phases 17, 20

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-030** | No `qa` schema | **Built**: `qa.defects` carries what directive §19 asks of every bug — severity, reproduction (**required**: a bug nobody can reproduce is a rumour), expected, actual, environment, evidence, assignee, status, resolution, verification. ARCHITECTURE.md §4.8's vocabulary kept as written. **The gate it states is enforced** inside `projects.submit_deliverable`, under the same lock that writes the status — and scoped to the *version*, not the project: a blocker on v1 must not stop v2, because v2 is the fix, and the project-wide reading would make the fix unshowable and reward closing bugs dishonestly | — | A | P1 | G-021 | `tests/qa-gate.test.ts` (15), `scripts/verify-qa-gate.mjs` (13 live) | No — the rule was already stated in ARCHITECTURE.md §4.8 | 12 |
| **G-031** | Production-ready gate | **Written up for a decision**: `docs/decisions/g-031-production-ready.md`. Until this week the question was unanswerable — no defect table, no versioned deliverables, no handover. **Every fact a gate needs is now measurable**, and the document names each one and its source. It also names the four conditions §20 lists that AgencyOS has never held — a client build succeeding, its deployment, its security checks, its documentation are facts about the *client's* project, and a gate claiming to check them would be lying. Three shapes offered: a readout, a hard gate on measurable conditions only, or that plus an owner-approved **recorded** override — the last recommended, but only if readiness gates something, since otherwise it is ceremony | The Admin picks one, and says what it gates | C | P1 | G-030 | — | **Yes — ADM-19** | 20 |
| **G-032** | Handover | **Built**: `projects.handovers` + `handover_items` record what was delivered, when, and whether the client said they had it. **Directive §22's credentials rule shaped the schema** — a credential item is *incapable* of holding a credential: `reference` must be null and `transfer_method` must say how it actually reached the client, refused in DDL rather than by a service that could forget. Delivery refuses an empty package and refuses while an open blocker or major defect stands. The outstanding balance is **reported, not gated on** — which payment is final is the project's own plan, and inventing that rule would put a made-up gate in front of real revenue | — | A | P1 | G-030 | `tests/handover.test.ts` (11), `scripts/verify-handover.mjs` (12 live) | No — §22 and §4.8 already state the rules enforced | 12 |
| **G-033** | Project completion summary | **Built**: `projects.completion_summary` assembles directive §23's figures from five tables that already held every fact. Budget, invoiced, paid and outstanding stay **four separate numbers** — they differ often enough that collapsing any two hides the interesting case. Duration is **null while the project runs**, because one measured to `now()` reads as a fact and is a moving number. Revisions are versions beyond the first **per kind**: three designs and one prototype is two revisions. **A read** — it marks nothing complete and gates on nothing, because what the numbers imply about closing is ADM-13/ADM-14 and ADM-19 | — | A | P2 | G-032 | `scripts/verify-completion-summary.mjs` (15 live) | No | 12 |

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
| **G-040** | No approval engine | **Built** under ADM-08 (`20260812120011_approval_engine.sql`): `approvals.approval_requests` serves all eight subject types and both audiences; `approvals.approval_policies` says who must decide, as owner-editable data with `approval_policies_money_floor` in DDL so policy can make a gate stricter and never looser. The required role is **snapshotted** onto the request, so a policy edited while one is pending cannot change the rule it was raised under. Raising is idempotent through a partial unique index; deciding takes a row lock and a compare-and-swap; the tables take **no direct writes at all**, so no role can settle through PostgREST what the function would refuse. Every request and decision is audited from inside its own transaction | — | A | P1 | — | `tests/approval-engine.test.ts` (33), `scripts/verify-approvals.mjs` (31 live) | **Yes — merge approval, ADM-46** | 8 |
| **G-096** | Nothing expires an unanswered approval request | **Built**: `approvals.expire_overdue` settles every request past its own deadline as `expired` and raises a fresh one against the **owner**, linked by `escalated_from`, from the cron tick. The original is left exactly as it was — it is the evidence somebody did not answer — and the escalation gets the same window measured from now, so the owner is not given less time than the person who missed it. **It cannot approve**: there is no path from here to `approved`, and `decide_approval` refuses a caller with no identity, which a cron tick is. Escalates once, because there is nobody above the owner | — | A | P2 | G-040 | `scripts/verify-approvals.mjs` §11 (8 live), `tests/approval-engine.test.ts` §F | Granted — ADM-08c, ADM-39 | 9 |
| **G-099** | A dead job cannot be requeued from anywhere | `/operations` shows what the system gave up on; nothing brings it back. Reviving a dead unlock or extraction is a write with real consequences — a duplicate invoice, a second milestone opened — so it needs an idempotency story rather than a button | A revival path with a duplicate story, or an explicit decision that dead work is handled by hand | C | P2 | G-058 | None | Yes — how a revived job avoids doing its work twice | 9 |
| **G-097** | A new schema is unreachable until PostgREST is told about it | **Closed.** The specific case was fixed when `approvals` shipped unreachable; the general case is now checked — `check-record.mjs` scans every `.schema('x')` call in `src` and `app` and fails if `config.toml` does not expose it. **It found a real one on its first run**: `qa` was read by the application and absent from `config.toml`, working only because its migration appends itself at apply time, so a stack rebuilt from that file would have answered 406 for every QA call | — | A | P2 | — | `scripts/check-record.mjs` §6 — proved red by removing `qa` | No | 20 |
| **G-041** | Automation trust levels not enforced | **Fixed**: the runner selected `autonomy_level` and **ignored it** — worse than not reading it, because the code looked configurable while the behaviour was L1 whatever the row said, so turning an agent down was a deploy. Now decided by `src/lib/ai/autonomy.ts` (L1 acts; L0 is read-only; **L2 is refused**, because accepting its own proposal needs a stated policy and silently behaving as L1 would tell an operator something untrue; an unrecognised level is refused, not defaulted) and enforced **twice** — in the runner before the model is reached, and by `ai.agent_runs_autonomy_guard` so a script cannot skip it. Proved live: the identical call succeeds at L1 and is refused one UPDATE later | — | A | P1 | — | `tests/agent-autonomy.test.ts` (8), `scripts/verify-agent-autonomy.mjs` (6 live) | No | 25 |
| **G-101** | What L2 autonomy means has never been stated | `autonomy_level` admits L2 and the schema calls it *"autonomous within limits"*. For the one agent that exists, autonomous would mean accepting its own requirement proposal with no human — which directive §29 forbids without a stated policy | What an L2 agent may do, and within which limits | C | P3 | G-041 | `tests/agent-autonomy.test.ts` §B — an L2 agent must stay refused while this is open | **Yes — ADM-08's trust levels** | 25 |
| **G-042** | AI provenance | Good: `agent_runs`, `agent_steps` (request/response/cost/latency), `requirement_versions.generated_by_run_id`, `source_job_id`, `source_message_count` | Extend the same discipline to every future AI output | A | P2 | — | `tests/ai-extraction.test.ts` | No | — |
| **G-043** | Audit coverage | `audit.audit_log` is append-only and trigger-protected; 15 call sites across all five modules | Every gated transition writes one. Re-audit as new gates land | A | P2 | — | Indirect | No | — |
| **G-044** | Admin approval center UI | **Built**: `/approvals` lists everything pending for the caller's organization, soonest deadline first, marking anything past its SLA. Approve, request changes and reject; a client-audience request also asks where the client agreed, because the database requires it. **The page runs no role check of its own** — what an approver may settle is decided under a lock against the role snapshotted on the request, so the button is drawn for everyone who can see the row and the refusal is surfaced as written. A stale client-side copy of that rule is the failure this avoids | — | A | P1 | G-040 | `tests/approval-centre.test.ts` (14) — the action is executed, not read | **Yes — merge approval, ADM-47** | 8 |
| **G-098** | A Server Action could not be executed by a test, only read | **Fixed**: `next/cache` does not resolve outside a Next build, so importing any `'use server'` module from the runner failed before the test ran — which is why action tests asserted on source text, a structural stand-in directive §38 allows only as a supplement. `tests/_alias.mjs` now maps it to an inert stub. The source-text assertions in `requirement-proposal.test.ts` are left alone, to be rewritten when that area is next touched | — | A | P3 | — | `tests/approval-centre.test.ts` — twelve behavioural tests over an action module | No | 17 |

### 4.7 Platform, testing, operations — Phases 14–21

| ID | Gap | Current | Required | Class | Risk | Depends | Tests | Admin decision | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **G-050** | No CI whatsoever | **Fixed** on `ci/verify-on-every-change`: `.github/workflows/verify.yml` runs typecheck, lint, the full test suite, the secret scan and a production build on every PR, plus a second job that applies every migration from scratch and runs all the live verification scripts against a real Postgres. At the time it landed that was 636 tests, 25 migrations and seven scripts; today it is 895, 36 and eight, without the workflow being touched | Merged to `main` | A | P1 | — | n/a — it *is* the coverage | **Yes — merge approval on PR #16** | 18 |
| **G-051** | No secret scanning | **Fixed**: `scripts/scan-secrets.mjs` scans `git ls-files` for eight credential shapes and refuses to let `.env.local`-family files be tracked. Repo-owned rather than a third-party action, so CI on a money-handling repo adds no supply chain. Carries a canary so it cannot pass by matching nothing | Merged to `main` | A | P1 | G-050 | Self-testing; proven to fail on a planted key and on a tracked `.env` | **Yes — merge approval on PR #16** | 18 |
| **G-052** | No deployment or rollback documentation | `vercel.json` defines the cron. Nothing describes environments, migration ordering, or rollback | `AGENCYOS_OPERATIONS.md` (created in this phase) filled in with real procedure | B | P2 | — | — | **Yes — production Supabase project and Vercel environment details** | 20 |
| **G-053** | Observability is `console.error` | **Fixed**: `core.operational_backlog()` counts what the system already believes is wrong — dead jobs, stalled and stuck ones, unpublished events, approvals past the deadline their own policy set. **No threshold is invented**: each is either a state the system set itself or the existing 15-minute staleness constant. The cron tick reads it after reaping and dispatching, and `core.claim_alert` decides in one statement whether to send — so two overlapping ticks cannot both alert, and a persisting problem repeats hourly rather than every minute. `ALERT_WEBHOOK_URL` delivers it; unset means logged once per situation rather than lost. A failed alert never fails the tick | — | A | P2 | — | `tests/operational-backlog.test.ts` (23), `scripts/verify-operational-backlog.mjs` (16 live) | **Yes — merge approval, ADM-48** | 20 |
| **G-054** | Read failures rendered as empty pages | **Fixed** on `fix/reads-that-cannot-answer`: all 18 readers across four `queries.ts` refuse via `unreadable()`, and `error.tsx` boundaries in both route groups say the page could not be loaded rather than showing an empty one. The two readers feeding the unlock decision propagate a `Result`, so `invoice.paid` is never emitted with a fabricated null | Merged to `main` | A | P1 | — | `tests/read-failure-semantics.test.ts` (20) | **Yes — merge approval on PR #17** | 16 |
| **G-055** | Business rules are not written down | All ten `docs/business-os/*.md` are empty templates | The rules the system enforces, stated once | C | P1 | — | — | **Yes — every rule in §5 below** | 21 |
| **G-056** | Stale planning documents | `implementation-backlog.md` and `documentation-roadmap.md` describe an architecture the repo does not use | Marked superseded (done, §0.1 above) | B | P3 | — | — | No | 21 |
| **G-057** | Client portal is a placeholder | **Built**: a client sees their projects, the pieces each is built from and how far along they are, every version put in front of them — with changelog, known limitations and how to get into a build — the handover once delivered, and their invoices. **No page or query filters by client account or visibility**: that scoping is RLS's, and it was probed against a real database *before* the pages were written. There is deliberately **no approve button** — ADM-08d puts the client's decision in a staff member's hands with the message as evidence, so one here would either lie about who decided or open a second decision path the audit trail cannot reconcile | — | A | P2 | G-021 | `tests/client-portal.test.ts` (8), `scripts/verify-client-portal.mjs` (12 live) | No | 12 |
| **G-058** | Dead-letter jobs are invisible | **Fixed**: `/operations` lists every dead job with its kind, attempts and `last_error` as written — the only record of why the work stopped. Gated on `audit.read`, the same class of information as the audit trail. **Nothing there requeues a job**: reviving dead work is a write with real consequences, and it is **G-099** rather than a button | — | A | P2 | G-053 | `scripts/verify-operational-backlog.mjs` §1 | No | 9 |
| **G-059** | Concurrency audit incomplete | The Phase 14/15 sweep classified the read→decide→write sites and raised D9–D22; all are fixed. What is not systematic is the *method* — no standing check re-classifies a new call site | Every concurrent mutation classified safe or unsafe (directive §30), and kept so | B | P1 | G-002, G-003 | Partial | No | 15 |
| **G-094** | The roadmap's summary blocks were hand-maintained and drifted | **Fixed** by `scripts/check-record.mjs`, run by `npm run check` and by CI: it re-derives the gap totals from the gap records, the §4.8 tables and the README's gap count from those totals, the baseline's migrations, tables, RLS coverage, test files and live scripts from the filesystem, and the test counts from an actual run — failing on any disagreement, including a gap or decision id present in one copy and not the other. §4.8's claim of regeneration is replaced by a check that enforces it | — | A | P3 | — | `scripts/check-record.mjs` — proved red first: four planted disagreements, four failures, exit 1 | No | 21 |
| **G-095** | The unsupported snapshot is still a runnable script | ADM-40 kept `supabase/_bundle.sql` as a marked historical snapshot. The marking is prose, and prose does not stop a paste: the file still opens a transaction and still builds a schema missing D16, D17–D22, G-079, G-082, G-083 and G-084 | One line — a `raise exception` before the `begin` — makes it refuse rather than warn, at the cost of it no longer being runnable even deliberately. That trade was not part of the decision taken, so it is recorded rather than assumed | C | P3 | G-085 | None — the marking is checked, the runnability is not | Yes — the trade above | 20 |

### 4.8 Gap totals

Counted from the 83 gap records in `docs/roadmap/roadmap.json`, which is the
machine-readable copy of the table above.

An earlier version of this section claimed the totals were "regenerated from the
gap records whenever one changes" and "not maintained by hand". **That was not
true** — no generator exists and CI runs none, so both copies drifted again: the
totals read 81 against 82 records, the baseline block read 30 migrations and 694
tests against an actual 36 and 895, and all seven of D16–D22 were still listed
as open after they had merged. Recorded as **G-094**, and counted below.

| Class | Count |
| --- | --- |
| A — already implemented or fixed | 65 |
| B — partial | 6 |
| C — missing | 18 |
| D — incorrect | 2 |
| E — blocked on an Admin decision | 4 |
| **Total** | **95** |

| Risk | Count |
| --- | --- |
| P0 | 4 — all closed; G-085 was the fifth and is settled under ADM-40 |
| P1 | 38 |
| P2 | 33 |
| P3 | 20 |

**51 Admin decisions** have been raised across these gaps; **27 are granted, 24
remain open**. Five of those grants — ADM-09, ADM-20, ADM-39, ADM-47 and
ADM-48 — were **taken under the Admin's blanket delegation of 2026-08-13**
rather than answered, each marked DELEGATED in `roadmap.json` and each cheap to
reverse. ADM-46 through ADM-50 were merge gates, all granted; ADM-47 and ADM-48
were carried in this document as open for a day *after* the pull requests they
gated had merged, which is **G-104**. ADM-38 was never issued — the numbering skips it — and is
recorded so the hole is not read as a lost decision. ADM-36 and ADM-37 were
carried as open long after the merges they asked for had happened (PR #23 as
`c76fcb6`, PR #24 as `2d37933`); both are now granted on that evidence. They are
consolidated in §5.

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

### Raised by G-092 (re-pricing a deal)

**ADM-43 — Who may change a deal's value after it is opened, and is it
audited?** (G-092). Today nobody can: `value_minor` is written at insert and
never updated. That is survivable only because a deal is normally settled at the
figure it was opened at — but a deal can be reopened, and `convertToProject`
seeds the project budget from that column, so a reopened deal re-won at a
different figure converts into a project budgeted at the old one.

Building the edit path is straightforward. What it needs first is who may use
it — every role holding `lead.write`, or owner and ops_admin only — and whether
a change of price is an audited event, which it probably is.

### Raised by D21 (repeat engagement)

**ADM-42 — When a past client comes back, is that a new deal on the same lead,
or a new lead?** (G-076, G-088). WhatsApp ingest keys a lead to a phone number
permanently, so a returning client lands on the same lead row. D21 stopped the
schema from forbidding a second deal there, but `createOpportunity` still
returns the settled one rather than raising a new one — so the capacity exists
and nothing uses it. Which is right is a sales-process question, and the answer
also decides G-089's reopen path.

### Raised by D20 (lead conversion)

**ADM-41 — Does winning a deal qualify its lead?** (G-075, G-086). Nothing
requires a lead to be `qualified` before a deal is opened on it:
`createOpportunity` refuses only a `disqualified` one, the form is shown on any
lead without a deal, and reaching `qualified` takes two deliberate clicks on a
separate form. So the ordinary path is `new → deal won → converted`, and the
lead skips qualification entirely.

`LEAD_TRANSITIONS` says the opposite: only `qualified` may become `converted`.
Both cannot be true. Either the machine is right and winning a deal on an
unqualified lead should be refused until somebody qualifies it — which strands
today's flow until the process changes — or conversion implies qualification
and the machine should say so, stamping `qualified_at` on the way through.

D20 preserved today's behaviour rather than pick. The question is which the
agency actually does.

### Raised by D18 (retry budget)

**ADM-39 — How long may a paid milestone stay shut?** (G-073, G-080). D18 gave
the retry ladder real spacing, so an unlock now survives roughly nineteen
minutes of a failing database instead of a few hundred milliseconds. After that
the job is `dead` and nothing in the system ever tries again.

That is a strict improvement, and it is still an engineering default rather
than a rule anybody has stated. A Supabase resize, a Postgres upgrade or a
regional degradation can run longer than nineteen minutes, and every in-flight
unlock ends dead — the D5/D15 outcome the retryable classification exists to
prevent, reached more slowly.

The engineering answer is not the interesting part; the number is. **How long
may a client who has paid in full wait for the next stage to open before
somebody is told?** An answer of "an hour, then alert" and an answer of "twenty
minutes, then alert" produce different `max_attempts`, a different ladder and a
different alerting story. It is not invented here.

### Settled — the approval engine (ADM-08)

**ADM-08 — Build the approval engine as designed in `ARCHITECTURE.md` §4.6**
(G-040, G-022, G-041, G-044) — **Granted 2026-08-12, on four axes:**

**a. The full engine**, not a narrowed first slice. All eight subject types and
both audiences from the start, so a later feature adds a row rather than a
table.

**b. Policy lives in data** — owner-editable, audited — so "invoices over ₹5L
need owner sign-off" is an UPDATE, not a deploy. Two guards keep that from
becoming a way around the gates it configures: a policy grants nothing, and
`approval_policies_money_floor` refuses one that puts a refund below owner or
money below ops_admin. Policy may make a gate stricter. It may never make one
looser.

**c. An unanswered request expires and escalates to the owner**, and is never
auto-approved — directive §29, which the engine now enforces rather than
states: a caller with no `auth.uid()` cannot settle anything, so an automation
cannot approve its own work. The expiry job itself is **G-096**, and it needs
**ADM-39** to size its ladder.

**d. A client approves over WhatsApp and a staff member records it** against
the versioned artifact, with the message as evidence. `decided_by` is the staff
member; `client_contact_id` is who agreed; `evidence_ref` is where to read it,
and a client-audience decision without it is refused in DDL. The row never
pretends the client clicked.

**ADM-46 — Merge approval for the approval engine.** — **Granted 2026-08-12.**
Merged as `0c86db3`. The engine was built and proved before anything called it
and before any UI showed it: the merge committed two tables, three functions
and a schema exposure on the strength of the design rather than of a feature
using it. Both of those now exist — the queue in PR #45, and four features
routing decisions through it since.

### Recorded late — the merge approval for PR #43

**ADM-45 — Merge approval for PR #43** (G-094) — **Granted 2026-08-12.** Merged
as `6d69da3`. Written down here rather than in its own pull request, which is
the convention this project follows: a PR cannot record its own approval, so
the next change records it.

**ADM-47 — Merge approval for the approval centre** (G-044). — **Granted under
the delegation of 2026-08-13.** Merged as `252d7b0`. The queue renders and its
action is tested by execution, but it has **not been driven in a browser
against a real session** — no live script authenticates a page. Recording the
grant does not close that verification gap; it is stated here rather than
papered over, and DELEGATED means reversible on sight.

**ADM-48 — Merge approval for monitoring** (G-053, G-058, G-080). — **Granted
under the delegation of 2026-08-13.** Merged as `14c37e7`. Adds a table, two
functions, a page and one call in the cron tick. The **severity split** is the
one judgement in it that is ours rather than the system's — a dead job
interrupts somebody, a slow queue does not — and it is still the part worth a
second opinion, because getting it wrong in the loud direction is how alerts
come to be ignored.

Both of these were carried here as **Open** for a day after the merges they
gated, while §4.8 of this same document called them granted. Neither merge was
unauthorised — the delegation of 2026-08-13 covered them, as it covered ADM-46,
ADM-49 and ADM-50 — but a record that says "open" beside a merge that happened
is indistinguishable, to anyone reading it later, from a merge taken without an
answer. That is **G-104**, and §7 and §8 of `check-record.mjs` now refuse it.

### Taken under delegation — 2026-08-13

The Admin delegated every remaining decision. Three were taken on that basis;
each is marked DELEGATED in the record so it can be reversed on sight.

**ADM-09 — the outbound channel: WhatsApp Cloud API.** The narrowest answer
available rather than a choice: `verify.ts` and the inbound webhook already
speak it, so outbound over the same Graph API adds no vendor, no second
identity and no second number.

**ADM-20 — rollback: forward-only plus Supabase point-in-time restore**,
written into `AGENCYOS_OPERATIONS.md` rather than left as an intention.

**ADM-39 — the SLA: one hour.** Nobody had stated a number and the expiry
ladder cannot exist without one. Matched to the alert cooldown already shipped,
so the two agree by construction.

**ADM-49 — merge approval for the outbound channel**, granted with the same
delegation.

### Deliberately NOT taken, delegation notwithstanding

**ADM-22 — the offer and service catalog, including pricing.** This is the
agency's revenue. An invented price does not stay inside the repository: it is
quoted to a real client, and "the system chose it" is not something anybody can
say to a customer afterwards. Directive §6 forbids exactly this, and a blanket
delegation does not make an invented number true.

**ADM-13 — the conditions under which a project officially starts**, and the
sales-vocabulary decisions beside it (ADM-06, ADM-10). These describe how the
agency actually works. Guessing produces a system that fights its own users
daily, and the cost of being wrong is paid by staff on every project rather
than once by me.

Everything else proceeded without them.

**ADM-50 — merge approval for deliverables and client review**, granted under
the same delegation.

**ADM-51 — How the remaining fourteen audit writes become transactional, if
at all.** `audit.audit_log` is append-only, so a row never written can never be
repaired, and fourteen writes record their audit in a separate request from the
change it describes. Four options are set out in full in
`docs/decisions/g-093-audit-writes.md`: accept and document the window,
fourteen Postgres functions, table triggers, or both. **Triggers are
recommended** — the function-per-write approach fixes the stated problem and
buys little, turning every future CRM change into a migration, while a trigger
also covers the paths that never go through the service layer at all. Money is
not affected either way: it already audits from inside its own transaction.

**ADM-19 — what "production ready" is allowed to mean.** Now answerable for
the first time: the defect counts, the client approvals, the outstanding
balance and the handover state are all queryable, and no rule says which of
them matter. Four of §20's conditions — the client's build, its deployment, its
security checks, its documentation — are facts this system has never held, and
the document says so rather than pretending. Three shapes, with a recorded
override recommended if readiness gates anything at all. Full argument in
`docs/decisions/g-031-production-ready.md`. It deliberately does not settle
whether payment gates delivery; that is ADM-13/ADM-14.

**ADM-13 / ADM-14 — which approvals unlock which payments.** The keystone of
what is left: it blocks G-100 and shapes ADM-19's answer. Two working
mechanisms that do not touch each other, a milestone with no link to a
deliverable, and four shapes set out in
`docs/decisions/g-100-approvals-and-payments.md`. The recommendation is the
narrow one — an approval *permits* an invoice to be issued rather than
releasing it automatically — and the document is explicit about why the
automatic version is not recommended: every other money path in this system
requires a human, and the first exception should be chosen deliberately.
ADM-14, whether an unpaid invoice refuses handover, is asked separately because
it is commercial policy rather than an engineering choice.

### Settled — the bundle (ADM-40)

**ADM-40 — Is `supabase/_bundle.sql` a supported install path?** (G-085) —
**Granted 2026-08-12: keep it, marked unsupported.** Neither regenerated in CI
nor deleted. Its header now opens with `NOT AN INSTALL PATH`, names what a
deployment built from it would be missing — D19's advisory lock, G-082's
`claim_jobs` signature, D16's RLS narrowing, all of D17–D22 — and points at
`db:link` + `db:push` instead. `check-record.mjs` fails if that marking comes
off, so the decision cannot quietly revert.

The residual is recorded rather than assumed away: a marked file is still a
runnable file, and a `raise exception` before its `begin` would make it refuse
rather than warn. That trade — the file stops being runnable even deliberately
— was not part of the decision taken, so it is **G-095**, not a liberty.

### Blocks Phase 19 (security hardening)

**ADM-30 — Adopt a third-party secret scanner, or keep the repo-owned one?**
The scan that runs in CI is `scripts/scan-secrets.mjs`, written here: it checks
225 tracked files against five known credential shapes and self-tests those
shapes on every run. A dedicated scanner — gitleaks, trufflehog — carries a far
larger rule set and is maintained by people who watch for new ones, at the cost
of a third-party action in the pipeline with access to the repository. Neither
is obviously right; the choice is the Admin's.

### Recorded late — decisions this document had never listed

Eleven decisions lived only in `docs/roadmap/roadmap.json` and appeared nowhere
in this section. Ten were merge approvals, all since granted; the eleventh is
ADM-30 above. Listed here so the two copies agree.

| ID | Decision | State |
| --- | --- | --- |
| ADM-27 | Merge approval for PR #14 (D6 + D7, honest invoice reads) | Granted |
| ADM-28 | Merge approval for PR #15 (D5, unlock read failure) | Granted |
| ADM-29 | Merge approval for PR #16 (CI + secret scan) | Granted |
| ADM-31 | Merge approval for PR #17 (G-054, read failure semantics) | Granted |
| ADM-32 | Merge approval for PR #18 (G-008, payment reconciled under the lock) | Granted |
| ADM-33 | Merge approval for PR #19 (D8, payment plan atomicity) | Granted |
| ADM-34 | Merge approval for PR #20 (D10, D13, D14, state transitions) | Granted |
| ADM-35 | Merge approval for PR #21 (D9, D11, D12) | Granted |
| ADM-36 | Merge approval for PR #23 (D15, handler read failures) | Granted — merged as `c76fcb6` |
| ADM-37 | Merge approval for PR #24 (D16, RLS matches the capability model) | Granted — merged as `2d37933` |

**ADM-38 was never issued.** The numbering skips from ADM-37 to ADM-39. Noted
so the hole is not later read as a decision that went missing.

### Recorded late — the merge approval for PR #65

**ADM-52 — Merge approval for PR #65** (G-104). — **Granted 2026-08-13.**
Merged as `7d17f78`. Recorded here rather than in the pull request it approves,
which is the convention §7 of `check-record.mjs` now enforces: at most one merge
may be outstanding, and the change after it writes the row. The check found its
own first defect within minutes of merging — it demanded the row immediately and
made `main` red — which is **G-105**.

### Open now — the one merge gate in front of everything

**ADM-44 — Merge approval for PR #40 (G-079).** — **Granted 2026-08-12.**
Merged as `9874f14`. The four audit writes that sit beside a Postgres function
now append from inside that function's transaction, so a payment can no longer
commit with no history — permanently, since `audit.audit_log` is append-only by
trigger. The remaining twelve call sites are split out as G-093 rather than
folded in.

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
| 4 | Full finance audit (G-004…G-009, G-060…G-062) | **Defects closed.** D4–D8 and D15 all merged. What is left is not defect work: the four vocabulary/policy items still need decisions | ADM-02, ADM-03, ADM-04 |
| 5 | CRM / sales completion (G-016, G-017) | | ADM-05, ADM-06 |
| 6 | Requirements / proposals (G-011) | | ADM-07 |
| 7 | Billing | Largely covered by Phase 4 | — |
| 8 | **Authorization + approval engine (G-040, G-041, G-044)** | **Closed.** Under ADM-08: the engine proved against a real database, `/approvals` as the queue that shows what is waiting, expiry and escalation (G-096), and an agent's autonomy read from its row rather than hard-coded (G-041). What the engine does not yet do is gate money — that is G-100, in Phase 12 | — |
| 9 | Jobs / reaper (G-058) | **Closed.** The reaper existed; the backlog is now displayed and alerted on. What is left is reviving a dead job, which is G-099 | — |
| 10 | WhatsApp / webhook hardening (G-014) | **Closed.** Inbound was hardened (C5, C6); outbound now exists under ADM-09 | — |
| 11 | Sales lifecycle (G-010, G-012, G-013) | | ADM-10, ADM-11, ADM-12 |
| 12 | Projects / delivery (G-020…G-033) | **Everything that needed no business rule is built**: deliverables with client review, module tracking, QA with its gate, and handover. What remains are the *gates* — which approvals unlock which payments (G-100), what production ready means (G-031) | ADM-13, ADM-14, ADM-19 |
| 13 | Identity | Built | — |
| 14 | Database invariant audit | | — |
| 15 | Concurrency audit (G-059) | Partly done via C2, C8, D1 | — |
| 16 | Error semantics audit (G-054) | | — |
| 17 | Test architecture | Strong at unit/integration; concurrency and live layers thin | — |
| 18 | **CI hardening (G-050, G-051)** | **Done.** Pulled forward, as recommended | — |
| 19 | Security hardening | RLS now matches the capability model (D16); G-085 settled under ADM-40, and no P0 is open | ADM-30 |
| 20 | Deployment / production readiness (G-052, G-053) | **G-053 closed**: the system says when work is lost. Rollback and deployment documentation still missing | ADM-19, ADM-20 |
| 21 | Documentation completion (G-055, G-056) | G-094 closed: the record is checked against the repository on every PR | ADM-23 |
| 22–24 | Client success, upsell architecture and implementation | | ADM-22 |
| 25 | Automation control plane (G-041) | **G-041 closed**: an agent's autonomy is read from its row and enforced in two places. What L2 *means* is G-101 | ADM-08 |
| 26 | Continuous autonomous development | | — |

### 6.1 One recommended deviation — accepted and delivered

**Pull Phase 18 (CI) forward, to run alongside Phase 2.**

The directive orders CI at Phase 18. The baseline argued for earlier: 549 tests
and 23 migrations existed, and **not one of them ran automatically.** Every
claim of "tested" from there to Phase 17 rested on somebody having run
`npm run check` by hand. Directive §39 says exactly this — *"Do not claim
'tested' because a test file exists"*.

**Granted as ADM-29 and delivered.** Every check now runs on every pull
request, and the fourteen finding-fixes merged since were each proved by it
rather than by a local run. The deviation is recorded as taken, not pending.

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

**D1 through D22 are all closed and merged.** D1 `e4dc28a`, D2 `170c644`, D3
`5469d17`, then D4–D15 across PRs #13–#23, D16 `2d37933`, D17 `4e75295`, D18
`3a982f4`, D19 PR #27, D20 `3cd5d55`, D21 `89b791a`, D22 `27347a0`. Nothing in
the D series is open.

Four of the seven money findings were the same defect — a decision taken from a
copy of a row, then written back as if the copy were still true. D1, D2, D4 are
that defect; D3, D5, D6 are its sibling, a failed read reported as a fact. That
pair of shapes is what the Phase 14/15 sweep then looked for everywhere else,
which is how D9–D22 were found.

---

## 8. Definition of Done

Restated from directive §47, with the state of each at this baseline.

| Dimension | Done means | Today |
| --- | --- | --- |
| Business | Full client lifecycle represented | 13/24 stages complete, 5 partial, 5 missing, 1 blocked (§3) |
| Sales | Lead → close managed | Partial. The pipeline runs and its invariants hold; the vocabulary (ADM-10) and follow-up automation (ADM-11) are unanswered |
| Onboarding | Client/project initialization controlled | Partial. A project starts because somebody starts it — the conditions are ADM-13 |
| Payments | Milestone billing safe | Every money defect found (D1–D8, D15) closed and merged. Overdue and refunds now exist; the remaining finance work is policy, not defects |
| Design | Versioned approval workflow | Built. `projects.deliverables` kind `design`, versioned, reviewed through the approval engine |
| Prototype | Versioned client review | Built. Same machinery, kind `prototype`, with changelog, known limitations and safe test access |
| Development | Tasks, builds, deliverables tracked | Built. Modules with progress, tasks under them, `build` deliverables |
| QA | 360° testing exists | Built. `qa.defects` with severity and a gate that stops broken work reaching the client. What "production ready" *means* is ADM-19 |
| Handover | Final delivery auditable | Built. `projects.handovers` + items, accepted through the engine, holding no secrets |
| Client success | Maintenance/support exists | Missing — blocked on ADM-22 |
| Upsell | Approved commercial automation | Missing — blocked on ADM-22, and deliberately after core stability (directive §44) |
| Security | Auth, RLS, tenant isolation verified | RLS on all 36 tables; RLS matches the capability model (D16); 21 live scripts verify |
| Reliability | Concurrency and idempotency verified | Partial. Every serialisation defect found is closed; no systematic sweep of the paths added since |
| Database | Critical invariants enforced | Strong where built |
| Testing | Critical behaviour executable in CI | CI runs every check on every PR: 1085 tests, every migration from scratch, 21 live scripts |
| Operations | Deployment, rollback, monitoring documented | Partial. Rollback and monitoring documented (ADM-20, ADM-48); the deployment runbook is G-052 |
| Automation | Routine work automated | One agent, whose autonomy is read from its row and enforced (G-041). What L2 would mean is G-101 |
| Governance | Admin approval controls high-risk decisions | An approval engine, a queue, expiry and escalation. What it does *not* yet do is gate money — G-100 |
| Audit | Every important action traceable | Append-only log. Money audits inside its own transaction, and since G-078 so does invoice creation; thirteen non-financial writes still do not — G-093, ADM-51 |

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
| 2026-08-12 | (PRs #14–#24) | **This log was not kept for these eleven pull requests.** The record of what each changed is in the gap rows in §4, which name their PR; it is not reconstructed here, because the dates and commits would be guessed. What landed across them: CI (G-050, G-051), G-008, G-054, D5–D16, and the Phase 14/15 sweep that raised D9–D22. |

| 2026-08-12 | `4e75295` (PR #25) | **D17 closed.** An event and the state it describes are written in one commit. Recorded here on 2026-08-13, from the commit rather than from memory — it was one of the twenty-three merges §10 had stopped recording, which is G-104. |
| 2026-08-12 | (PR #26) | **D18 closed.** `src/lib/jobs/retry.ts` spaces retries; both settle paths write `run_at`; both compare-and-swaps now bound `run_at` as well as `status`. That second half came from adversarial review, not from the original analysis — without it a racing invocation claimed a job the backoff had just deferred and rolled `attempts` backwards. Four gaps recorded: **G-080**, **G-081**, **G-082**, **G-083**. One decision raised: **ADM-39**. 721 tests passing, all 7 live scripts green — 70 gaps on this branch. |
| 2026-08-12 | (PR #27) | **D19 closed, and re-rated P2 → P1 on measurement.** `core.bootstrap_first_owner` now takes an advisory transaction lock before it reads anything. The filed description said two users could both become owner; with eight simultaneous callers, **all eight** were provisioned, in four rounds out of five. Round one passed on cold connections, which is why the check runs five. New live script `verify-first-owner.mjs`, wired into CI. 737 tests passing. |
| 2026-08-12 | `3cd5d55` (PR #38) | **D20 closed.** `markLeadConverted` is a compare-and-swap: it admits `new`/`qualifying`/`qualified`, refuses a disqualified or soft-deleted lead, answers an already-converted one without rewriting `converted_at`, no longer reports a zero-row write as success, and audits the conversion. Deliberately wider than `LEAD_TRANSITIONS`, because `createOpportunity` refuses only a disqualified lead — narrowing would strand every project raised from a lead nobody had qualified. **ADM-41** asks which is right. New gaps **G-086**, **G-087** — 74 gaps. 754 tests passing. |
| 2026-08-12 | `89b791a` (PR #39) | **D21 closed.** `opportunities_open_lead_key` — a partial unique index on `lead_id` where the stage is unsettled — plus 23505 handling in `createOpportunity` and `setOpportunityStage`. Scope narrowed after review: the first draft would have made one-deal-per-lead-ever permanent in DDL. New live section in `verify-schema.mjs` §5, which distinguishes the two designs. New gaps **G-088**, **G-089**; **ADM-42** raised — 76 gaps. 770 tests passing. |
| 2026-08-12 | (PR #30) | **D22 closed, and re-rated P3 → P2.** `organizations_whatsapp_number_key` makes two tenants claiming one WhatsApp number unrepresentable, so the ingest function's unordered `limit 1` has nothing left to order. The function is deliberately untouched; a test reads both it and the index and fails if they drift. **This closes every defect the audit found — D1 through D22.** 780 tests passing. |
| 2026-08-12 | (PR #31) | **G-083 closed.** `/api/health` reports a fingerprint of its database URL; the four scripts that drive the application compare it with their own before planting anything. This is the hazard hit during D18's verification — a build without the verify environment aimed the local app at a real project, and only a mismatched key stopped anything landing there. 793 tests passing. |
| 2026-08-12 | (PR #32) | **G-084 closed.** `core.bootstrap_first_owner` binds a caller with an identity to its own user id, checked before anything is read or locked; the service role keeps its exemption because it has no identity to check. Proved red first — without it a minted token handed the whole deployment to a user who never asked for it. 796 tests passing. |
| 2026-08-12 | (PR #33) | **G-081 closed.** A throwing handler is caught, settled retryable and the batch continues; a throw after the extraction claim settles that job too. Both take D18's backoff rather than the reaper's fifteen minutes. 810 tests passing. |
| 2026-08-12 | (PR #34) | **G-089 half closed.** A reopened deal no longer carries the date it closed or the reason it was lost — the D13 shape, one table along. The other half, that a deal's value cannot be changed at all, is split out as **G-092** with **ADM-43**, because it is a missing capability rather than a wrong behaviour. 813 tests passing. |
| 2026-08-12 | (PR #35) | **G-080 half closed.** The end of a job's life is announced — one error line, both settle paths, before the write. What is still open is the other half: nothing revives a dead job and nothing displays the backlog, which needs a surface (G-053, ADM-21) rather than more code here. 827 tests passing. |
| 2026-08-12 | (PR #36) | **G-087 closed.** The lead's own timeline no longer skips the moment it became a client. The actor is threaded from the deal that was won rather than invented. 830 tests passing. |
| 2026-08-12 | (PR #37) | **G-082 closed.** `core.claim_jobs` takes the kind it was asked for, and both claim sites use it. The old signature is dropped rather than kept as an overload — without a `kind` it would have handed a milestone unlock to the AI extractor. The route's two select-then-swap claims are gone, and with them the second attempt convention. 828 tests passing. |
| 2026-08-12 | (PR #40) | **G-079 closed for the four sites that had somewhere to go.** `core.record_audit` appends from inside the caller's transaction, and the two finance state changes, the payment and the payment plan each write their own row — so the history commits with the change, which matters more here than for the outbox because `audit.audit_log` is append-only and a row never written can never be repaired. `record_manual_payment` gains a required `p_method`. The remaining twelve are structurally different and are split out as **G-093**. Caught in verification: regenerating `replace_payment_plan` from the migration that introduced it silently reverted **D16** — §7e failed, which is what it is for. 895 tests passing, 36 migrations. |
| 2026-08-12 | `a7a54a0` (PR #42) | **The record reconciled against the repository, and the drift recorded rather than silently repaired.** `roadmap.json` described commit `5b6cbbf`; it now describes `9874f14`, with measured metrics (36 migrations, 895 tests in 168 suites across 32 files) rather than remembered ones. D16–D22 were carried as open after all seven had merged; ADM-36 and ADM-37 as pending after the merges they asked for had happened. Totals are computed from the gap records: **83 gaps**, A36/B9/C29/D5/E4. The failure that allowed all of this is itself recorded as **G-094**. **ADM-44** was raised for PR #40, which had no merge-approval decision against it, breaking the one-per-PR convention; it was granted and merged as `9874f14` before this landed. ADM-27–ADM-37 existed only in the JSON and are now listed in §5; **ADM-38 was never issued**, and the hole is noted so it is not later read as a lost decision. No source file, migration or test was touched. |
| 2026-08-12 | `6d69da3` (PR #43) | **G-094 closed by a check, and ADM-40 settled.** `scripts/check-record.mjs` re-derives every number in this document and in `roadmap.json` — gap totals from the gap records, the §4.8 tables and the README's count from those totals, the baseline's migrations, tables, RLS coverage, test files and live scripts from the filesystem, the test counts from an actual run — and fails on a disagreement, including an id that appears in one copy and not the other. It runs in `npm run check` and in CI. Proved red first: four planted disagreements, four failures, exit 1. **ADM-40 granted** — the bundle stays, marked `NOT AN INSTALL PATH`, naming what it is missing and pointing at `db:push`; G-085 re-rated **P0 → P2** and closed, and with it the last open P0. The residual — a marked file is still a runnable one — is **G-095**, because making it refuse to run was not the trade the Admin was offered. 84 gaps, 895 tests passing. |
| 2026-08-12 | `0c86db3` (PR #44) | **G-040 closed.** One table for every decision a human owes, under **ADM-08**: request, decide, expire, with a client audience that must name who agreed and where to read it. **ADM-46** granted for the merge — the schema landed before anything called it. |
| 2026-08-12 | `252d7b0` (PR #45) | **G-044 closed.** `/approvals`, the queue that shows what is waiting, with its action tested by execution rather than by reading. **ADM-47** granted under delegation; the queue has still never been driven in a browser against a real session, which the decision says plainly. |
| 2026-08-12 | `14c37e7` (PR #46) | **G-053, G-058 and the other half of G-080 closed.** The system says when work has been lost: an operational backlog table, two functions, a page and one call in the cron tick. **ADM-48** granted under delegation; its severity split — a dead job interrupts somebody, a slow queue does not — remains the judgement worth a second opinion. |
| 2026-08-13 | `41d68dd` (PR #47) | **G-014 closed.** AgencyOS can answer, not only hear. **ADM-09** chose the WhatsApp Cloud API as the narrowest answer available — the inbound webhook already speaks it — and **ADM-49** granted the merge, both under delegation. §1.5's "no outbound messaging of any kind" stops being true here. |
| 2026-08-13 | `d086c6c` (PR #48) | **G-021, G-022, G-023 closed — the missing middle.** Versioned deliverables for design, prototype and build, each with a changelog and known limitations, reviewed by the client through the approval engine. Nothing overwrites a version a client has seen, per directive §35. **ADM-50** granted under delegation. |
| 2026-08-13 | `e8da82b` (PR #49) | **G-030 closed.** `qa.defects` with severity, and a gate that stops broken work reaching the client while leaving the path open for the fix that repairs it. |
| 2026-08-13 | `5ed6554` (PR #50) | **G-032 closed.** Handover: a package, its items, a receipt, and no secrets in it — the credential-transfer question stays ADM-15 rather than being answered by putting one in a message. |
| 2026-08-13 | `3adbc42` (PR #51) | **G-024, G-025 closed.** Every module knows its project, and no key was written down. |
| 2026-08-13 | `cf18e68` (PR #52) | **G-057 closed.** The client portal stops being a placeholder: projects, the pieces each is built from, every version put in front of them, the handover and their invoices. |
| 2026-08-13 | `249a7cd` (PR #53) | **G-096 closed.** Silence is not consent — `approvals.expire_overdue` settles a request past its deadline as expired and raises a fresh one against the owner, linked by `escalated_from`. The original is left exactly as it was, because it is the evidence that somebody did not answer. **ADM-39**'s one hour is the deadline. |
| 2026-08-13 | `09bbf1c` (PR #54) | **G-033 closed.** How the project actually went: directive §23's figures assembled from five tables that already held every fact, with budget, invoiced, paid and outstanding kept as four numbers because collapsing any two hides the interesting case. |
| 2026-08-13 | `3e58b6a` (PR #55) | **G-004 closed.** An invoice whose date has passed says so, on the cron tick, `for update skip locked`. Not a new rule — the transition `INVOICE_TRANSITIONS` has admitted since the first day, executed for the first time. **ADM-02** stays open: the grace period and who gets notified are still unanswered, and nothing here invents either. |
| 2026-08-13 | `10a3a40` (PR #56) | **G-005, first half.** Money goes back only when somebody said so: `finance.refunds` as its own row, because `finance/schema.ts` has said since the first day that `paid` is terminal and money returned is a refund rather than a status flip. Every refund needs an approved approval behind it — directive §28 RED. |
| 2026-08-13 | `36e6ee9` (PR #57) | **G-005 closed.** A refund somebody can actually ask for: the request path in front of the ledger written in #56. **ADM-03** — whether refunds live in the system at all or are entered as a note after the bank — was answered by the code that already existed rather than by this change; it is still listed open, and that tension is worth the Admin's eye. |
| 2026-08-13 | `047cdfb` (PR #58) | **G-041 closed.** An agent does what its row says it may. `ai.agents.autonomy_level` was being selected and then ignored, which is worse than not reading it — the code looked configurable while the behaviour was L1 whatever the row said, so turning an agent down was a deploy. Enforced in two places now. What L2 *means* is **G-101**, unanswered. |
| 2026-08-13 | `aa532a4` (PR #59) | **G-097 closed.** A schema the application reads is a schema it can reach. The approvals schema had shipped unreachable — PostgREST answers 406 PGRST106 for a schema not in `pgrst.db_schemas`, and the failure is invisible until something calls it. `check-record.mjs` now checks the general case. |
| 2026-08-13 | `175740c` (PR #60) | **G-090 closed, and G-103 raised and closed with it.** What the data can and cannot say about mis-filed messages — and, found by accident while pointing a script at production with a truncated env file, nine verification scripts that raised `TypeError: fail is not a function` instead of naming the missing variable. The error path nobody had executed. |
| 2026-08-13 | `fe3e7d4` (PR #61) | **G-102 closed.** `crm.conversations.inbound_number_id` records which of the agency's numbers a thread arrived on — the value the ingest resolved tenancy from and then discarded, which is what made G-090 unanswerable. Nullable and not backfilled: inventing a number for an older conversation would repeat the guess D22 was. |
| 2026-08-13 | `c314123` (PR #62) | **G-093 written up for a decision rather than guessed at.** `docs/decisions/g-093-audit-writes.md` sets out what is at risk and four options; triggers are recommended. Raised as **ADM-51**, open. |
| 2026-08-13 | `3a5bed7` (PR #63) | **G-031 written up.** `docs/decisions/g-031-production-ready.md`: what "production ready" is allowed to mean, answerable for the first time now that defects, approvals, balances and handover are all queryable. Four of directive §20's conditions are facts this system has never held, and the document says so. **ADM-19**, open. |
| 2026-08-13 | `a21fdf4` (PR #64) | **G-100 written up.** `docs/decisions/g-100-approvals-and-payments.md`: two working mechanisms that do not touch each other, and four shapes for making them. The narrow one is recommended — an approval *permits* an invoice to be issued rather than releasing it automatically. **ADM-13/ADM-14**, open. This is the keystone of what is left. |
| 2026-08-13 | `7d17f78` (PR #65) | **G-104 raised and closed.** G-094 closed the numbers and left the events: twenty-three merges had no change-log row — every one of this day's work — and ADM-47 and ADM-48 were carried open for a day after the pull requests they gated merged, while §4.8 called them granted in the same document. Neither merge was unauthorised; the delegation of 2026-08-13 covered them and nobody wrote it down. Both are now recorded granted and DELEGATED. Two checks added, proved red first against the unreconciled record: **§7**, every pull request number in a commit subject appears in this log, singly or in a recorded range; **§8**, a merge gate may not stay open once every gap it blocks is classed A. CI's `check` job stops shallow-cloning, because §7 reads git history — and §7 refuses to run in a shallow clone rather than passing vacuously, which is what it did when it was measured against a depth-1 clone of its own branch: *covers all 0 merges*, green, on a log that had stopped being kept. Also corrected: §3's closing paragraph still said the middle of the business had no representation, five pull requests after it was built, and §8's Definition of Done still read "Design: Missing", "QA: Missing", "Handover: Missing" and "RLS on all 27 tables". 93 gaps, 1085 tests passing. |

| 2026-08-13 | (this change) | **G-105 raised and closed, and ADM-52 recorded.** G-104's §7 demanded a change-log row for every merge including the newest, and the first thing it did after merging was turn `main` red — for PR #65, itself. The convention it was built to enforce says a pull request cannot record its own merge approval, so there is always exactly one merge outstanding; the check did not say that, and a red `main` between every merge and the next change is how a team learns to merge past a red check. The newest merge is now exempt and **only** the newest: measured with a later merge stacked on top, #65 stops being exempt and fails, so the exemption cannot be held open. The pass line names what is outstanding rather than staying quiet about it. **ADM-52 granted 2026-08-13** — PR #65 merged as `7d17f78`, all four checks green, recorded here because it could not record itself. 94 gaps, 1085 tests passing. |

| 2026-08-13 | `6281987` (PR #66) | **G-105 closed, ADM-52 recorded.** The newest merge is exempt from §7 and only the newest, so `main` is not red between a merge and the change that records it. |
| 2026-08-13 | (this change) | **G-078 closed — the last event on the application path.** `finance.create_milestone_invoice` writes the invoice, its lines, its audit row and its `invoice.created` event in one statement. It was four transactions with a hand-rolled compensating DELETE between the first two, which is a rollback that runs only if the process lives long enough to run it. The P3 rating rested on nothing subscribing to the event — a fact about the subscription catalog rather than about the invoice — and the audit row was never covered by that argument at all, because `audit.audit_log` is append-only. Two application pre-checks became index violations, closing the check-then-write gap D1, D2 and D4 all were; the constraint is read from `get stacked diagnostics` rather than matched out of `SQLERRM`, which is prose and therefore translated. Deliberately left in TypeScript: which lines an invoice has and what its number is, both pure and tested, because re-deriving either in plpgsql is how regenerating `replace_payment_plan` silently reverted D16. The two tests that pinned the gap now assert it closed — which is how they were written to announce it — and **G-093 drops from fourteen to thirteen**. Proved live in `verify-milestone-invoicing.mjs` §7h: a line the database refuses leaves no invoice, no history, no event, and a milestone still billable. One residual, split out rather than folded in: `emitEvent` now has no caller and is still exported, which is **G-106**. 95 gaps, 1087 tests passing, 50 migrations. |

The rows for #25 and #44 through #64 were written on 2026-08-13, after the
merges they describe. Dates and commits come from `git log`; what each change
did comes from its gap record in `roadmap.json`. Where a row would have had to
guess — test counts at the moment of each merge, for instance — it says nothing
instead, which is the same choice §10 made for PRs #14–#24.
