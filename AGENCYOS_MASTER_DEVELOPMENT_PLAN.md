# AGENCYOS_MASTER_DEVELOPMENT_PLAN.md

The canonical plan for AgencyOS: what the business does, what the system does
today, the distance between the two, and the order in which that distance is
closed.

**Baseline date:** 2026-08-11 · **Last updated:** 2026-08-12
**Baseline commit:** `2881caa` on `fix/manual-payment-serialized` (one commit ahead of `main`)
**Status of this document:** live. Phase 0 established it; Phases 1–5, 14–16
and 18 have since been executed against it.

**Where things stand.** C1–C8, D1–D15, G-008 and G-054 are closed, and CI runs
every check on every pull request.

**Every defect found by the audit is now closed.** D1–D22 are fixed; PRs #25–#30
await merge. What remains is 26 missing features, each waiting on a business rule
that has never been written down (§5), and the gaps those fixes surfaced along the
way — recorded rather than absorbed.

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

Beyond those, 26 missing features are each waiting on a business rule that has
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
| **G-080** | A `dead` job is never tried again, and nothing says so | Nothing in the repository moves a row out of `dead`: the reaper matches `running` only, and the outbox cannot re-enqueue because the dedupe key still exists. No page, API, metric or alert reads `core.jobs`, so the end of a retry ladder is silent. D18 buys ~19 minutes; what happens after them is unowned | A dead-letter view plus an alert, or an explicit accepted gap | D | P1 | G-053 | None | Partly — ADM-39 sets the budget, the surfacing is engineering | 8 |
| **G-081** | A throw in the job runner skips the settle entirely | `POST /api/jobs/run` has no `try/catch`, and `runUnlockJobs` calls the handler unguarded. If the Supabase client throws rather than returning an error — an undici socket error, a malformed response — the settle never runs and the row strands in `running` until the reaper releases it fifteen minutes later. A database blip is exactly when a client throws | Wrap the handler call, settle in a `finally` | D | P2 | — | None | No | 8 |
| **G-082** | `core.claim_jobs` is dead code, and it is the better claim | It does the whole claim in one statement — `status`, `run_at`, `attempts = attempts + 1` and `for update skip locked` together — which is what the two-step select-then-swap in the route can only approximate. Nothing calls it. Wiring it up would close the `attempts` regression under concurrency by construction rather than by predicate | Adopt it, or drop it so the schema stops implying it is used | B | P2 | G-073 | None | No | 8 |
| **G-083** | Nothing stops the app under test from being pointed at production | `scripts/verify-target.mjs` refuses to run the scripts against an unnamed database, but the **application** they drive has no equivalent check. `.env.local` in this working copy points at a real Supabase project, and `next build` inlines `NEXT_PUBLIC_SUPABASE_URL` — so a build run without the verify env produces an app aimed at production while the scripts write locally. Hit during D18: every call failed with `Invalid API key` because the key did not match the URL, which is the only reason nothing landed there | The app-driving scripts should assert the app's target matches theirs before running | D | P1 | — | None | No | 8 |
| **G-084** | `bootstrap_first_owner` never checks `p_user_id` against `auth.uid()` | `execute` is granted to `authenticated` and the parameter is unvalidated, so any signed-in user can name **someone else's** user id. With D19 fixed only one owner results, but it need not be the caller — and signup is open (`shouldCreateUser: true`, no domain allowlist, `enable_confirmations = false`), so "any signed-in user" is "anyone". Found while fixing D19; a different defect on the same function, so not folded into it | Compare against `auth.uid()`, or drop the parameter | D | P1 | G-074 | None | No | 13 |
| **G-085** | `supabase/_bundle.sql` ships a stale schema, including the D19 defect | Its own header calls it the SQL Editor install path — paste and run. It carries the pre-fix `bootstrap_first_owner` verbatim and its `schema_migrations` insert stops at `20260809120003`, twelve migrations behind. A deployment created that way is a fresh deployment, which is the exact precondition D19 needs, and it gets the racy function with none of the later fixes | Regenerate it in CI, or delete it and document `db push` as the only install path | D | P1 | — | None | Yes — whether the bundle is a supported install path at all | 20 |
| **G-074** | **D19 — concurrent first sign-ins all become owner** | **Fixed** on `fix/first-owner-serialized`: `core.bootstrap_first_owner` takes `pg_advisory_xact_lock` on a key derived from its own name before it reads anything, and re-decides both counts through it. **Priority raised from P2 to P1 once measured:** with eight simultaneous callers, all eight were provisioned as owner in four rounds out of five — not two, all of them. Sign-up is open (`shouldCreateUser: true`, no domain allowlist), so the callers need not be invited | — | A | P1 | — | `tests/first-owner.test.ts` (18), `verify-first-owner.mjs` (new script, 8-way race × 5 rounds) | **Yes — merge approval on PR #27** | 13 |
| **G-075** | **D20 — `markLeadConverted` forces any lead to converted** | **Fixed** on `fix/lead-converted-transition`: a compare-and-swap admitting `new`, `qualifying`, `qualified`; a zero-row write is no longer reported as success; an already-converted lead is answered without rewriting `converted_at`; a disqualified one is refused; a soft-deleted lead is no longer converted (every other lead read in the module filtered `deleted_at`; this write did not, and `leads_write` carries no such predicate either); the conversion is audited. **Deliberately wider than `LEAD_TRANSITIONS`** — `createOpportunity` refuses only a disqualified lead, so deals open routinely on `new`/`qualifying` ones and narrowing to `qualified` would strand every project raised from them. Which of the two is right is ADM-41 | — | A | P2 | — | `tests/lead-conversion.test.ts` (15) | **Yes — merge approval on PR #28** | 5 |
| **G-086** | A lead converted from `new` has a null `qualified_at` | `qualified_at` is stamped only by `setLeadStatus` on the move into `qualified`, and `leads_qualified_at_set` constrains that status alone. So a lead converted straight from `new` is a client with no record of ever having been qualified. Harmless to the database, wrong in any funnel report that measures qualification. Falls out of the same ambiguity as ADM-41 and should be settled with it | Decide with ADM-41 | D | P3 | G-075 | None | Yes — ADM-41 | 5 |
| **G-087** | The conversion writes no `crm.lead_activities` row | `setLeadStatus` writes both an audit row and a timeline row of kind `status_change` for every move. D20 added the audit row; the timeline one still needs an actor id, which `markLeadConverted` does not receive. So the lead's own visible history skips the moment it became a client | Thread the actor from `convertToProject`, or move the timeline write there | B | P3 | G-075 | None | No | 5 |
| **G-076** | **D21 — `createOpportunity` has no index behind its one-deal-per-lead rule** | **Fixed** on `fix/one-deal-per-lead`: `opportunities_open_lead_key`, a partial unique index on `lead_id` where the stage is not settled, plus 23505 handling that returns the deal which won. **Scoped to OPEN deals after review.** The first draft had no stage predicate and would have cemented one-deal-per-lead-*ever* into DDL — which the primary ingest path contradicts, since WhatsApp keys a lead to a phone number permanently, so a returning client lands on the same lead. The race is between two `discovery` inserts, so the narrow index closes it identically | — | A | P2 | — | `tests/one-deal-per-lead.test.ts` (13), `verify-schema.mjs` §5 (4, and it distinguishes the two designs) | **Yes — merge approval on PR #29** | 5 |
| **G-088** | The deal pre-check has no stage filter, so a settled deal blocks a new one | `createOpportunity` returns *any* existing deal for the lead, whatever its stage. So although `opportunities_open_lead_key` now permits a second engagement once the first is settled, the application never raises one — a click on a lead whose only deal is lost hands back the lost deal. The schema stopped forbidding it; the application still does not offer it | Filter the pre-check by stage, once ADM-42 says whether a repeat engagement is a new deal | B | P3 | G-076 | None | Yes — ADM-42 | 5 |
| **G-089** | Reopening a deal leaves `closed_at` and `lost_reason` set, and cannot change its value | `setOpportunityStage` writes both only when moving *to* a terminal stage and never clears them on `lost → discovery`, so a reopened deal reads as `discovery` with a stale close date and a stale loss reason. And `value_minor`, `name` and `expected_close_on` are written once at insert with no update path anywhere in the module — so a deal lost at one value and re-won at another converts into a project budgeted at the old one | Clear the terminal columns on reopen; add an edit path for the deal value | D | P2 | — | None | No | 5 |
| **G-077** | **D22 — the WhatsApp ingest resolves tenancy with an unordered LIMIT 1** | **Fixed** on `fix/whatsapp-tenancy`: `organizations_whatsapp_number_key`, a partial unique index on `settings->>'whatsapp_phone_number_id'`, makes the ambiguity unrepresentable — with at most one match, the `limit 1` has nothing left to order. `crm.ingest_whatsapp_message` is deliberately not modified: replacing 150 lines of plpgsql to change five carries its own risk, and the coupling is pinned by a test that reads both and compares them. **Severity understated when filed, twice over:** the resolved organization is stamped on the contact, lead, conversation, message and job, so a customer's number, name and message text land in another agency's tenant — where that agency's RLS then correctly shows it to them. And it needs no operator mistake: `organizations_update` lets an owner update their own organization's `settings` with no restriction on its contents, so any owner could set their row to another agency's `whatsapp_phone_number_id` and capture that agency's inbound messages. Raised P3 → **P1** | — | A | P1 | — | `tests/whatsapp-tenancy.test.ts` (10), `verify-schema.mjs` §5 | **Yes — merge approval on PR #30** | 10 |
| **G-090** | Messages already filed under the wrong tenant are not repaired | D22 stops new ones, and the migration refuses to build over an existing collision — but contacts, leads, conversations, messages and jobs already stamped with the wrong organization stay where they are, visible to the wrong agency under that agency's own RLS. Moving them is a decision about customer data belonging to two businesses, not a migration | Identify affected rows, then an Admin decision on whether to move or delete them | C | P2 | G-077 | None | Yes | 10 |
| **G-091** | Claiming a WhatsApp number nobody has configured yet is unchecked | With the index in place, an owner who sets their organization's `whatsapp_phone_number_id` to a number they do not own now blocks the rightful agency from ever configuring it — the second write is refused with a bare 409. The index converts a silent capture into a denial of configuration; it does not verify the claim. Verifying it means asking Meta, which the system does not do | Verify ownership against the provider at configuration time, or gate the setting behind an operator review | C | P3 | G-077 | None | Yes | 10 |

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

Counted from `docs/roadmap/roadmap.json`, which is the machine-readable copy of
the table above — not maintained by hand. This section had drifted to a total
of 51 while the table held 66; it is now regenerated from the gap records
whenever one changes. (PR #25 adds two more gaps on its own branch, so these
numbers move again when it merges.)

| Class | Count |
| --- | --- |
| A — already implemented or fixed | 30 |
| B — partial | 9 |
| C — missing | 28 |
| D — incorrect | 9 |
| E — blocked on an Admin decision | 4 |
| **Total** | **80** |

| Risk | Count |
| --- | --- |
| P0 | 4 — all closed |
| P1 | 39 |
| P2 | 23 |
| P3 | 14 |

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
| 2026-08-12 | (PRs #14–#24) | **This log was not kept for these eleven pull requests.** The record of what each changed is in the gap rows in §4, which name their PR; it is not reconstructed here, because the dates and commits would be guessed. What landed across them: CI (G-050, G-051), G-008, G-054, D5–D16, and the Phase 14/15 sweep that raised D9–D22. |

| 2026-08-12 | (PR #26) | **D18 closed.** `src/lib/jobs/retry.ts` spaces retries; both settle paths write `run_at`; both compare-and-swaps now bound `run_at` as well as `status`. That second half came from adversarial review, not from the original analysis — without it a racing invocation claimed a job the backoff had just deferred and rolled `attempts` backwards. Four gaps recorded: **G-080**, **G-081**, **G-082**, **G-083**. One decision raised: **ADM-39**. 721 tests passing, all 7 live scripts green — 70 gaps on this branch. |
| 2026-08-12 | (PR #27) | **D19 closed, and re-rated P2 → P1 on measurement.** `core.bootstrap_first_owner` now takes an advisory transaction lock before it reads anything. The filed description said two users could both become owner; with eight simultaneous callers, **all eight** were provisioned, in four rounds out of five. Round one passed on cold connections, which is why the check runs five. New live script `verify-first-owner.mjs`, wired into CI. 737 tests passing. |
| 2026-08-12 | (PR #28) | **D20 closed.** `markLeadConverted` is a compare-and-swap: it admits `new`/`qualifying`/`qualified`, refuses a disqualified or soft-deleted lead, answers an already-converted one without rewriting `converted_at`, no longer reports a zero-row write as success, and audits the conversion. Deliberately wider than `LEAD_TRANSITIONS`, because `createOpportunity` refuses only a disqualified lead — narrowing would strand every project raised from a lead nobody had qualified. **ADM-41** asks which is right. New gaps **G-086**, **G-087** — 74 gaps. 754 tests passing. |
| 2026-08-12 | (PR #29) | **D21 closed.** `opportunities_open_lead_key` — a partial unique index on `lead_id` where the stage is unsettled — plus 23505 handling in `createOpportunity` and `setOpportunityStage`. Scope narrowed after review: the first draft would have made one-deal-per-lead-ever permanent in DDL. New live section in `verify-schema.mjs` §5, which distinguishes the two designs. New gaps **G-088**, **G-089**; **ADM-42** raised — 76 gaps. 770 tests passing. |
| 2026-08-12 | (PR #30) | **D22 closed, and re-rated P3 → P2.** `organizations_whatsapp_number_key` makes two tenants claiming one WhatsApp number unrepresentable, so the ingest function's unordered `limit 1` has nothing left to order. The function is deliberately untouched; a test reads both it and the index and fails if they drift. **This closes every defect the audit found — D1 through D22.** 780 tests passing. |
