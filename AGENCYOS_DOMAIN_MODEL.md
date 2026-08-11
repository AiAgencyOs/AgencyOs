# AGENCYOS_DOMAIN_MODEL.md

The entities AgencyOS stores, the states they move through, and where each rule
is actually enforced.

**Baseline:** commit `2881caa`, 2026-08-11.
**Scope:** what exists. Designed-but-unbuilt entities are listed in §7 and
marked as such, never mixed into the tables above them.

---

## 1. Tenancy

Every business row carries `organization_id`. That column is the tenancy
boundary, and it is enforced in three places at once:

1. **RLS** — every policy filters on `core.current_organization_id()`, read from
   the JWT.
2. **The JWT** — `core.custom_access_token_hook` stamps `organization_id`,
   `role`, and for client users `client_account_id` into the token at sign-in.
3. **By hand** — service-role code bypasses RLS entirely, so every query in
   `/api/jobs/run` and the webhook path applies `organization_id` explicitly,
   taken from the job or the resolved conversation, never from request input.

```
core.organizations
  ├── core.users ── core.memberships (role, status)
  ├── core.client_accounts ── core.client_users (portal access)
  ├── core.jobs           (queue)
  └── core.outbox_events  (transactional outbox)
```

**Roles:** `owner`, `ops_admin`, `delivery_lead`, `member`, `contractor` —
internal; `client_admin`, `client_member` — external. Capabilities per role live
in `src/lib/authz/permissions.ts` and are summarised in
`AGENCYOS_SECURITY.md` §3.

---

## 2. CRM — inbound capture through to approved requirements

```
crm.contacts ──┐
               ├── crm.leads ── crm.lead_activities
crm.conversations ── crm.conversation_messages
        └── crm.requirement_versions
```

### 2.1 Lead

| Field group | Notes |
| --- | --- |
| Identity | `organization_id`, `contact_id`, `source`, `source_ref` |
| Pipeline | `status`, `assigned_to`, `score`, `tags`, `follow_up_at` |
| Qualification | budget in minor units, timeline note, decision-maker flag, notes |

**States:** `new` → `qualifying` → `qualified` → `converted`;
`disqualified` reachable from any pre-terminal state and reopening to
`qualifying`.

`converted` is terminal — a lead that became a project does not re-enter the
pipeline. `disqualified` is deliberately not terminal: deals come back.

**Uniqueness:** `leads_source_ref_key` — one lead per `(organization, source,
source_ref)`. This is what makes a replayed WhatsApp delivery create no second
lead.

### 2.2 Conversation and messages

A conversation is a thread; `external_ref` is the provider's thread identity and
is unique per organization. Messages carry a monotonic `seq` allocated **under a
lock** inside `crm.ingest_whatsapp_message()` — reading the maximum and then
inserting would let two concurrent deliveries collide.

`conversation_messages.external_ref` is unique, which is the webhook's
idempotency key: Meta redelivering a message inserts nothing and is answered
`200`.

### 2.3 Requirement version — the versioned artifact that works

The one place the directive's §35 versioning rule is fully realised today.

| Field | Purpose |
| --- | --- |
| `version` | Allocated under a conversation lock by `crm.insert_requirement_version()` |
| `status` | `proposed` · `accepted` · `rejected` · `failed` · `superseded` |
| `source` | `agent` or `human` |
| `payload` | The structured requirement, Zod-validated before it lands |
| `generated_by_run_id` | → `ai.agent_runs` — full provenance |
| `source_job_id` | Unique per organization: one version per job, ever |
| `source_message_count` | Transcript size, so two jobs reading the same transcript produce one proposal |

**Invariants, all enforced in the database:**

- `requirement_versions_source_job_key` — one version per source job.
- `requirement_versions_transcript_state_key` — one version per `(organization,
  conversation, transcript length)`.
- `requirement_versions_one_accepted_key` — **at most one accepted version per
  conversation.**
- `crm.requirement_versions_guard()` — refuses illegal status moves.
- `crm.requirement_versions_supersede()` — accepting one supersedes the rest.
- The `requirement_versions_update` policy admits the accept/reject decision
  only to `core.is_admin()` — the approval gate is in RLS, not only in the UI.

---

## 3. Sales

```
sales.opportunities ── sales.proposals ── sales.proposal_items
```

**Opportunity states:** `discovery` → `proposal` → `negotiation` → `won`;
`lost` from any, reopening to `discovery`. `won` is terminal — the deal becomes
a project from there. A CHECK constraint requires `closed_at` whenever the stage
is `won` or `lost`.

**`sales.proposals` and `proposal_items` have tables, RLS and a `version` column
— and no code.** No service, action, query or UI touches them. This is gap
G-011; it is the oldest unused structure in the schema.

---

## 4. Projects — delivery

```
projects.projects ── projects.milestones ── projects.tasks
```

### 4.1 Project

**States:** `planning` → `onboarding` → `active` → `completed`; `on_hold`
between; `cancelled` from any non-terminal state. `completed` and `cancelled`
are terminal — reopening finished work is a new project.

`onboarding → active` is the "project officially started" transition of directive
§11, and **it currently carries no conditions.** That is gap G-026 / decision
ADM-13.

`projects_org_code_key` gives each project a unique human-facing code within its
organization.

### 4.2 Milestone — where delivery meets money

| Field | Meaning |
| --- | --- |
| `position` | Plan order — what "next milestone" means |
| `payment_percent` | `numeric(5,2)`, this milestone's share of the budget. Null = a delivery checkpoint with no payment |
| `amount_minor` | The resolved money, computed once when the plan is saved |
| `status` | `pending` · `in_progress` · `submitted` · `met` · `rejected` |
| `visibility` | `internal` or `client` |

**The payment-plan invariant.** `projects.assert_payment_plan_totals()` is a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger: if any milestone on a project
carries a `payment_percent`, they must total exactly 100 at COMMIT. Deferral is
the point — a plan is several rows written in one transaction and is only
meaningful once all of them are in.

This is what makes the directive's §10 requirement true in practice: **30/20/30/20
is a default, not a rule.** 5/10/30/20/35, 33.33/33.33/33.34 and any other split
totalling 100% are equally legal, with no code change. What the database refuses
is a plan that does not add up — a billing error waiting to happen.

Both percent and money are stored, deliberately: the percentage is what was
negotiated, `amount_minor` is what will be invoiced, and keeping both lets a
budget change be re-applied without guessing the original split.

### 4.3 Task

`projects.tasks` carry status, assignee, milestone and dates. They are flat:
no modules, no dependencies, no build or QA state. Directive §16 wants all of
those — gap G-024.

---

## 5. Finance — the money model

```
finance.invoices ── finance.invoice_items
        └── finance.payments   (the ledger)
```

### 5.1 Money representation

`bigint` minor units and `char(3)` currency, everywhere, with no exception.
There is no floating-point money arithmetic in this codebase. Percentages are
`numeric`, and are resolved into minor units exactly once — when the payment plan
is saved — so nothing downstream re-multiplies and re-rounds.

### 5.2 Invoice

**States:** `draft` → `issued` → `partially_paid` → `paid`; plus
`pending_approval`, `overdue`, `void`. `paid` and `void` are terminal.

`partially_paid` and `paid` are never chosen by a human. They are derived from
recorded payments, because an invoice's paid state must agree with the payments
behind it.

**Invariants in the database:**

| Constraint | Rule |
| --- | --- |
| `invoices_paid_not_over_total` | `paid_minor <= total_minor` — the ceiling |
| `invoices_paid_at_set` | Status `paid` requires `paid_at`: "paid" is a moment, not a flag |
| `invoices_issued_at_set` | Anything past draft/pending_approval requires `issued_at` |
| `invoices_milestone_live_key` | Partial unique index: **one non-void invoice per milestone** |
| `invoices_milestone_implies_project` | A milestone invoice must name its project |

`invoices_milestone_live_key` is what makes invoice generation idempotent under
concurrency: ten parallel calls produce one invoice and ten identical results.
Excluding `void` rows is what lets a withdrawn invoice be replaced.

### 5.3 Payment — the ledger

`finance.payments` rows **are** the ledger; `invoices.paid_minor` is a cached sum
of them. Reconciliation always recomputes from the rows rather than incrementing,
so a retry after a failed update lands on the same number instead of adding to it.

`unique (provider, provider_payment_id)` is the idempotency key. For manual
receipts the key is derived from the invoice and the human-entered bank
reference, so the same receipt cannot be recorded twice.

**Statuses:** `created`, `authorized`, `captured`, `failed`, `refunded`. Only
`captured` counts toward the paid total. Only `captured` is ever written today —
`refunded` has no code path (gap G-005), and the vocabulary itself is unresolved
against the directive's (gap G-006 / ADM-04).

### 5.4 The concurrency rule for money

Directive §31 forbids two concurrent legitimate requests from both breaching the
invoice ceiling. `finance.record_manual_payment()` is the answer, and its shape
is the pattern every future money operation should copy:

```
1. SELECT … FROM finance.invoices WHERE id = $1 FOR UPDATE   ← lock first
2. re-check status and amount under the lock
3. SUM(captured payments) read through the lock                ← never the cache
4. refuse if sum + amount > total                              ← refuse, never clamp
5. INSERT the payment; unique_violation → 'duplicate'
```

Locking before summing is the whole mechanism. A single `INSERT … SELECT` with
the sum in its `WHERE` would not work — both statements would evaluate the
subquery against a snapshot taken before either committed.

The same shape appears in `finance.void_invoice` (the void, §5.5),
`crm.ingest_whatsapp_message` (seq allocation) and
`crm.insert_requirement_version` (version allocation). **Four instances of one
pattern; treat it as the house rule for allocation and ceilings alike.**

**Overpayment is refused, never clamped.** Money arriving that nobody expected is
a conversation with the client, not a rounding decision.

### 5.5 Withdrawing an invoice

`finance.void_invoice()` is the same mechanism pointed the other way, and it
exists for the same reason: the check and the write used to be two statements
with a gap.

```
1. SELECT status, notes FROM finance.invoices WHERE id = $1 FOR UPDATE
2. already void?      → 'already_void'  (asking twice is an answer, not an error)
3. status voidable?   → the five INVOICE_TRANSITIONS admit; 'paid' is not one
4. SUM(captured payments) through the lock       ← never invoices.paid_minor
5. any money at all?  → 'has_payments', and nothing is written
6. UPDATE … SET status = 'void', notes = <locked notes> || reason
```

Step 4 is the part worth naming. `paid_minor` is a cache, and D3 is a live way
for it to go stale at zero while captured rows say otherwise. A void decided
from the cache is a void decided from a number that may be wrong; a void decided
from the rows cannot be.

Step 6 reads its `notes` from the locked row rather than from the caller's
earlier copy, so a note written concurrently is appended to rather than
discarded.

The consequence of getting this wrong was not just a mislabelled invoice.
`invoices_milestone_live_key` excludes void rows, so a milestone whose invoice
was wrongly voided becomes billable again — the client is invoiced twice for
work they have already paid for.

### 5.6 Known-incorrect areas

| | |
| --- | --- |
| **G-003 (D3)** | `capturedTotal()` returns `0` when the ledger read fails, and `reconcileInvoiceTotals()` then writes `paid_minor = 0`. A database that did not answer is treated as a database that answered "no money". Open; scheduled as Phase 3. |
| **G-008** | `reconcileInvoiceTotals()` runs as a separate statement after `record_manual_payment` has released its lock. It can no longer resurrect a voided invoice — a void cannot commit under a payment now — but it is still a read-decide-write outside the serialised unit. Scheduled as Phase 4. |

---

## 6. AI — provenance as a first-class concern

```
ai.agents ── ai.agent_runs ── ai.agent_steps
                    └── ai.cost_ledger
```

`ai.agents` is **configuration as data**: `autonomy_level` (L0 read-only · L1
propose · L2 autonomous), `enabled` (a per-agent kill switch), `default_model`,
`default_effort`, `max_steps`, `max_cost_minor`. Demoting or killing a
misbehaving agent is an UPDATE, not a deploy.

One agent is registered: `requirement_collector`, at L1.

`ai.agent_runs` has **no INSERT policy for authenticated users, by design** — an
agent trace nobody can forge is the point. Only the job runner, behind the
service role, writes them.

`ai.agent_steps` records the request shape (model, effort, schema, message count,
system prompt), the raw response *before* Zod validation, tokens, cost and
latency. Recording pre-validation output is deliberate: when validation rejects a
payload there is no requirement version to inspect, and this row is the only
place the malformed output survives.

**The provenance chain is complete and unbroken:**

```
conversation → job → agent_run → agent_step → requirement_version
                                    (generated_by_run_id, source_job_id,
                                     source_message_count)
```

Every AI-produced business fact can be traced to the transcript it came from,
the model call that produced it, and the human who accepted it.

---

## 7. Designed but not built

Listed so nobody looks for them: **none of these tables exist.**

| Entity | Designed in | Directive § | Gap |
| --- | --- | --- | --- |
| `approvals.approval_requests`, `approval_policies` | `ARCHITECTURE.md` §4.6 | §14, §27 | G-040 |
| `build.screens`, `screen_spec`, `brand_kits` | §4.7 | §13 | G-021 |
| `build.dev_tickets`, `repo_links` | §4.8 | §16 | G-024 |
| `qa.test_cases`, `test_runs`, `defects` | §4.8 | §19 | G-030 |
| `projects.deliverables` | §4.8 (referenced) | §15, §17 | G-023, G-025 |
| Handover package | — | §22 | G-032 |
| Offer catalog, upsell | — | §24–25 | G-035, G-036 |

---

## 8. Where each kind of rule is enforced

A quick reference for reviewing any new rule.

| Rule kind | Enforce in | Example |
| --- | --- | --- |
| Tenancy | RLS + explicit predicates under the service role | every policy |
| Uniqueness / idempotency | Unique index | `invoices_milestone_live_key` |
| Ceilings under concurrency | `SELECT … FOR UPDATE` inside a function | `record_manual_payment` |
| Allocation (seq, version, number) | Lock, then allocate, in one function | `insert_requirement_version` |
| Cross-row totals | Deferred constraint trigger | `assert_payment_plan_totals` |
| Legal state transitions | CHECK for the vocabulary, TS map for the moves, trigger where it must not be bypassable | `INVOICE_TRANSITIONS` + `requirement_versions_guard` |
| Who may act | Capability check in the service, plus RLS where the row must refuse | `can(role, 'invoice.issue')` + `invoices_write` |
| Immutability | Trigger | `audit.reject_mutation` |

**The rule of thumb this codebase already follows:** if two callers racing could
break it, an application check cannot enforce it.
