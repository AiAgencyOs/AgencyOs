# AGENCYOS_APPROVAL_POLICY.md

Who decides what, and where that decision is enforced.

**Baseline:** commit `2881caa`, 2026-08-11.

Two things are kept strictly apart in this document: **what is enforced today**
(§2–§4), and **what the master directive requires** (§5–§7). The second is not
policy until an Admin approves it.

---

## 1. The authority model

From directive §29.

| The system may | The Admin decides |
| --- | --- |
| Investigate | Approve |
| Implement | Merge |
| Test | Deploy |
| Verify | Price |
| Prepare | Refund |
| Report | Commit commercial policy |
| | Change product rules |
| | Perform destructive operations |

**Absence of a response is never approval.**

Applied to AI specifically: an agent may propose. A human holding the relevant
capability decides. Today the database enforces that for the one gate that
exists.

---

## 2. What is actually gated today

Three mechanisms, in descending order of strength.

### 2.1 Database-enforced approval — one gate

**Accepting or rejecting a requirement version.**

```sql
create policy requirement_versions_update on crm.requirement_versions
  for update using (... and core.is_admin()) ...
```

`core.is_admin()` resolves to `owner` or `ops_admin`. This is the only approval
in AgencyOS that a compromised or careless application path cannot bypass — the
row itself refuses.

Supporting invariants: at most one `accepted` version per conversation
(`requirement_versions_one_accepted_key`), accepting supersedes the rest
(`requirement_versions_supersede()`), and illegal status moves are refused by
`requirement_versions_guard()`.

### 2.2 Capability gates — role checks, not workflows

Checked in the service layer before the mutation, and backed by RLS write
policies:

| Action | Capability | Roles |
| --- | --- | --- |
| Create a lead, edit qualification, set follow-up | `lead.write` | owner, ops_admin |
| Create an invoice from a milestone | `invoice.create` | owner, ops_admin |
| Issue an invoice | `invoice.issue` | owner, ops_admin |
| Record a payment | `invoice.issue` | owner, ops_admin |
| Void an invoice | `invoice.issue` | owner, ops_admin |
| Configure a payment plan | `milestone.write` | owner, ops_admin, delivery_lead |
| Change project status | `project.write` | owner, ops_admin, delivery_lead |
| Approve a proposal | `proposal.approve` | owner — **no implementation** |
| Issue a refund | `refund.issue` | owner — **no implementation** |

**A capability check is not an approval workflow.** It says who may act. It does
not record a request, a reviewer, a decision, a reason or an SLA.

### 2.3 Database invariants — refusals no role can override

Not approvals, but they belong here: they are decisions the database makes
regardless of who is asking.

| Invariant | Refuses |
| --- | --- |
| `invoices_paid_not_over_total` | Recording more money than the invoice is for |
| `record_manual_payment` overpayment branch | The same thing, under concurrency |
| `invoices_milestone_live_key` | A second live invoice for one milestone |
| `assert_payment_plan_totals` | A payment plan that does not total 100% |
| `voidInvoice` paid check | Voiding an invoice with money against it — **currently racy, G-002** |
| `audit.reject_mutation` | Editing or deleting an audit row |

---

## 3. What is not gated — and should be

| Action | Today | Should be |
| --- | --- | --- |
| Sending anything to a client | Impossible — no outbound channel | YELLOW, policy-controlled |
| Pricing and discounts | No mechanism | RED |
| Custom payment terms | Any 100%-total plan, by `milestone.write` | RED, per directive §10 |
| Starting a project | Free `onboarding → active` transition | Conditions, per directive §11 — ADM-13 |
| Approving a design or prototype | Nothing exists | Client approval, versioned |
| Declaring production readiness | Nothing exists | RED, condition-checked |
| Handover | Nothing exists | RED |
| Refunds | Capability only, no implementation | RED |
| Deployment | No pipeline | RED |
| Upsell offers | Nothing exists | RED, from an approved catalog |

---

## 4. Development approval — in force now

This one is fully in force and applies to every change made to this repository.

| Gate | Rule |
| --- | --- |
| Missing product rule | **Stop and ask.** Never invent a business rule. |
| Merge | **Admin approval required on every PR.** |
| Deploy | Admin. |
| Destructive operations | Admin. |
| Reopening closed work (C1–C8) | Not permitted; a genuine regression becomes a new finding. |
| Ordinary development steps | Proceed without asking. Do not stop between shell commands. |

Currently open: **PR #9** (D1, finance concurrency) — awaiting Admin merge
approval, decision ADM-01.

---

## 5. The engine that does not exist

`ARCHITECTURE.md` §4.6 designs `approvals.approval_requests` and
`approvals.approval_policies`: one polymorphic table serving proposals,
deliverables, invoices, refunds, scope changes, prototypes, agent actions and
ticket plans; `audience` (`internal` | `client`) making owner approval and client
approval the same mechanism; `approval_policies` mapping
`(subject_type, condition) → required role + SLA` so a rule like "invoices over
₹5L need owner sign-off" changes without a deploy; and agents as first-class
requesters (`requested_by_type = 'agent'`).

**No such table exists.** This is gap G-040 and decision **ADM-08**.

It is the highest-leverage decision in the plan: nine other gaps depend on it,
and both the delivery phase (client approvals of designs, prototypes, builds) and
the upsell phase (commercial approvals) are blocked behind it. Building bespoke
gates for each of those instead would produce a different approval mechanism per
feature, with no single place to see what is waiting.

---

## 6. Trust levels — proposed, not approved

Directive §28. **Descriptive of intent; not policy until an Admin approves it,
and not enforceable until G-041 exists.**

**GREEN — automated.** Internal notifications, task creation, calculations,
reminders, reports, status aggregation, non-destructive bookkeeping.
*Everything AgencyOS automates today is GREEN.*

**YELLOW — client-facing, policy-controlled.** Follow-ups, payment reminders,
delivery notifications, review reminders, routine client communication.
*Nothing today; there is no outbound channel.*

**RED — Admin approval required.** Pricing, discounts, payment terms, refunds,
production deployment, destructive changes, contractual or legal commitments,
final handover, major upsell offers, entitlement changes.
*Enforced today only as role checks, and only for the finance subset.*

`ai.agents.autonomy_level` (L0 read-only · L1 propose · L2 autonomous) is the
column this maps onto. Today only L1 is exercised, and the behaviour is written
into the code path rather than derived from the column — which means changing an
agent's autonomy is a deploy, not an UPDATE. That is the substance of gap G-041.

---

## 7. What the approval center should show

Directive §27, for when G-044 is built. Each pending item needs:

- what is being proposed
- why
- the evidence behind it
- the affected client and project
- the risk
- the AI recommendation, where one exists
- the proposed action
- approve / reject / edit-where-supported

And the categories it should cover: sales, payment terms, project start, client
messages, UI delivery, prototype delivery, development delivery, production,
handover, refunds, commercial terms, upsell, and workflow exceptions.

Of those thirteen, **one exists today** (requirement acceptance, which is not
even on the list — it predates it).

---

## 8. Decisions this document is waiting on

| ID | Decision | Blocks |
| --- | --- | --- |
| **ADM-01** | Merge PR #9 (D1) | Phase 1 closure |
| **ADM-08** | Build the approval engine as designed in `ARCHITECTURE.md` §4.6 | G-011, G-012, G-014, G-021, G-022, G-023, G-025, G-036, G-041, G-044 |
| **ADM-09** | Outbound channel and per-message-type trust level | YELLOW existing at all |
| **ADM-13** | Project start conditions | G-026 |
| **ADM-19** | Production-ready conditions | G-031 |
| **ADM-22** | Approved service and offer catalog | All upsell work |

Full list in `AGENCYOS_MASTER_DEVELOPMENT_PLAN.md` §5.
