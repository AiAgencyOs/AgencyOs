# Business Rules

**Answered by the Admin on 2026-08-13.** Every rule below was given, not
inferred. Where a rule carries a risk the Admin was told about it and chose
anyway, that is recorded here in the same words, because a rule whose cost is
only known to the person who implemented it is not a rule anybody can revisit.

This file is the source. `AGENCYOS_MASTER_DEVELOPMENT_PLAN.md` §5 records which
decision id each rule closes; the code records where each is enforced.

---

## 1. High-level principles

1. **AgencyOS is the system of record.** WhatsApp is a channel. A message is
   evidence of something happening, never the fact itself.
2. **A human owns every commitment to a client's money.** AI drafts, proposes,
   plans and executes internal work; it does not decide what a client pays.
3. **Nothing important is unrecorded.** Every approval, payment, delivery and
   exception writes history, and the history commits with the change.

---

## 2. Money

### 2.1 Payment plans

Any milestone split is allowed provided it totals 100%. 30/20/30/20 is a common
shape, **not a rule** — a 5% trust advance, a 10% advance, or no advance at all
are all valid plans.

### 2.2 Approval unlocks the invoice — ADM-13

When a client approves a deliverable (design, prototype or build), the milestone
invoice for that stage becomes **raisable**. It is not sent automatically.

> *Chosen over automatic issue because every other money path in AgencyOS
> requires a human, and the first exception should be deliberate.*

### 2.3 Received is not verified — ADM-04

Two distinct states:

| State | Meaning |
| --- | --- |
| `received` | Somebody recorded that money arrived |
| `verified` | The **owner or an ops admin** confirmed it against the bank/UPI |

**Only verified money unlocks the next milestone.** A client saying "paid" in
WhatsApp is a claim, and the claim is what triggers the verification request —
never the verification itself.

### 2.4 Overdue — ADM-02

- **3 days' grace** after `due_at`, then the invoice is marked overdue.
- The internal team is notified.
- The client is auto-reminded (see §5.2).

### 2.5 Refunds — ADM-03

Refunds are recorded **in the system**, as their own rows. `paid` is terminal;
money returning is a refund, never a status flip. Every refund requires an
approved approval behind it.

### 2.6 Re-pricing a deal — ADM-43

An open deal's value may be changed by the **owner or an ops admin**. Every
change is written to the audit log with the old and new amount.

### 2.7 Offers and pricing — ADM-22

**There is no price catalog.** Every price is quoted per client, by a human.

AgencyOS may identify an opportunity — a completed project, a support pattern, a
feature request — and tell the team. **It must never state a price**, and there
is no list for it to state one from.

---

## 3. The client lifecycle

### 3.1 A returning client — ADM-05, ADM-42

One lead per person, forever. A returning client gets a **new deal on their
existing lead**, so their whole history stays in one place.

### 3.2 Winning qualifies the lead — ADM-41

A won deal implies its lead was qualified. The system fills in the qualification
date rather than leaving a hole in the history.

### 3.3 Onboarding — ADM-06

The onboarding checklist **blocks nothing**. Every item is a reminder.

### 3.4 A project officially starts when — ADM-13

All three:

1. the **advance payment is verified** (§2.3),
2. at least one **requirement version is approved**,
3. the project's **WhatsApp group exists** and is linked.

The owner may start a project without these, and the override is recorded with a
reason.

---

## 4. Delivery

### 4.1 Versioning

Design, prototype and build deliverables are versioned. **A version a client has
seen is never overwritten.**

### 4.2 Milestone payment is advisory — ADM-18

Paying a milestone opens the next one and tells the team. It does **not** block
work already under way. A project working ahead of its payments carries a
visible warning rather than a locked door.

> *Chosen because real projects overlap, and a hard gate would mostly be worked
> around.*

### 4.3 Defect severity — ADM-17

**Blocker / Major / Minor / Trivial.** Blocker and Major stop a release.

### 4.4 Production ready means — ADM-19

Exactly two conditions:

1. **zero Blocker and zero Major defects**, and
2. the **client has approved the final build**.

Payment state and owner sign-off are deliberately **not** conditions.

### 4.5 Handover — ADM-14, ADM-15

Handover is **refused while the final invoice is unpaid**, unless the owner
overrides — and the override records who and why.

**AgencyOS never stores client credentials.** It records *that* credentials were
handed over, by whom, when, and that the client acknowledged. The values
themselves travel by whatever means the agency chooses and never enter the
database, the audit log or a WhatsApp message.

> *Reconsidered once, in full knowledge that storing them is more convenient:
> one database leak would expose every client's hosting and keys at once, and
> that risk cannot be engineered away.*

---

## 5. Communication

### 5.1 Two WhatsApp groups

| Group | Members | Purpose |
| --- | --- | --- |
| **Project group** | client + agency | The client-facing thread for one project |
| **Internal group** | owner + staff + the AgencyOS agent | Where the agent asks for approvals and gets approve / reject / feedback |

The internal group is **an approval channel, not a chat log**. What the agent
brings there: payment confirmations, anything carrying a price or discount,
delivery approvals (UI designs, prototypes, builds), QA and production-ready
sign-off, project starts against unmet conditions, and refunds.

### 5.2 Follow-ups are sent automatically — ADM-11

AgencyOS drafts and **sends follow-up messages to clients on its own**, with no
human reading them first. This includes messages that may carry a price, a
discount or a delivery promise.

> **Risk accepted by the Admin, twice, after being told:** an AI-written message
> can state a commitment the agency did not approve, and the client will see it
> before anybody at the agency does. The narrower option — auto-send reminders,
> route anything about money to the internal group — was offered and declined.
>
> This is the only place in AgencyOS where something reaches a client with no
> human in the loop. It is written here so that reversing it is a one-line
> policy change and not an archaeology exercise.

### 5.3 Portfolio and samples — ADM-12

AgencyOS may send samples, demos and past work **only from a list the Admin
maintains**. The list is empty until the Admin fills it; until then AgencyOS
sends nothing from it.

---

## 6. What the AI may do on its own — ADM-61

**L1** — proposes, a human decides. **L2** — acts alone on internal work; asks
for anything client-facing or touching money.

At L2 an agent may, without asking:

- break approved requirements into modules, features and tasks (**ADM-16** — the
  breakdown is automatic),
- plan, schedule and update internal work,
- draft anything.

It must bring to the internal group:

- anything that reaches a client, **except** the follow-ups of §5.2,
- anything touching money — a price, an invoice, a refund, a payment
  confirmation.

It must **never**, at any level: invent a price, offer a discount, promise a
delivery date it was not given, claim work exists that does not, or write a
client credential anywhere.

---

## 7. Sales process — ADM-10

The pipeline stays four stages: `discovery → proposal → negotiation → won`,
with `lost` off any of them.

Everything else the agency actually does — contacted, sample sent, demo sent,
offer sent, follow-up, advance requested — is recorded as a **timestamped
activity on the lead**, not as a pipeline stage. A deal is in one stage; a lead
has a history.

### 7.1 Proposals — ADM-07

Staff draft. **The owner approves.** Then it is sent. A proposal carries a price,
so it goes through the approval queue before it reaches a client.

---

## 8. Escalation and exceptions

- An approval unanswered past its deadline **expires** and re-raises against the
  owner. Silence is never consent.
- Every override of a rule in this document — a project started early, a
  handover released unpaid — is recorded with the person and the reason.

---

## 9. Still unanswered

| Question | Blocks |
| --- | --- |
| **ADM-57** — verify a WhatsApp number with Meta, or gate it behind an operator review? | G-091 |
| **ADM-58** — may the unsupported SQL snapshot be made to refuse to run? | G-095 |
| **ADM-60** — which Supabase project is production, which Vercel environment, who may migrate it? | G-052 |
| The portfolio list itself (§5.3) | The portfolio feature ships empty |

---

Owner: the Admin. Reviewed: 2026-08-13.
