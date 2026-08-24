# AI Agent Responsibilities

**Answered by the Admin on 2026-08-13 (ADM-61, ADM-16, ADM-11).** The rules
live in [`02-business-rules.md`](02-business-rules.md) §6; this file is the
contract an agent is held to, and the place to look when deciding what a new
agent may be trusted with.

---

## 1. The two levels

`ai.agents.autonomy_level` is read from the row and enforced in two places
(G-041). It is not a comment.

| Level | Meaning |
| --- | --- |
| **L1** | Proposes. A human decides. Nothing the agent produces takes effect on its own. |
| **L2** | Acts alone on **internal** work. Asks before anything client-facing or touching money. |

Nothing above L2 exists. If one is ever added, it needs its own decision — this
document is the reason that will be noticed.

---

## 2. What an L2 agent may do alone

- Break approved requirements into modules, features and tasks. **The breakdown
  is automatic** (ADM-16) — it is not proposed for review.
- Plan, schedule, re-order and update internal work.
- Draft anything at all: messages, proposals, summaries, plans.
- Read anything its organization can read.

## 3. What it must bring to the internal group

- Anything that reaches a client — **except** the follow-ups below.
- Anything touching money: a price, an invoice, a refund, a payment
  confirmation.
- Delivery approvals: UI designs, prototypes, builds, QA and production-ready
  sign-off.
- Starting a project whose conditions are not met.

## 4. The one exception — follow-ups

Follow-up messages are **sent to clients automatically, with nobody reading
them first** (ADM-11), including messages that may carry a price, a discount or
a delivery promise.

The Admin was told the risk twice and chose this twice. It is recorded in
[`02-business-rules.md`](02-business-rules.md) §5.2 with the reasoning, and it
is the only path in AgencyOS where something reaches a client unread.

---

## 5. What no agent may ever do, at any level

1. **State a price to a client that no human has decided.** Since ADM-96 the
   agent may *propose* prices on an internal draft — grounded in the agency's
   own quotation corpus, never invented — and every one of them passes through
   the owner's decision before a client sees it. There is still no catalog to
   quote from (ADM-22); the human act moved from typing the number to
   approving it, and it did not get smaller. Discounts remain entirely the
   owner's.
2. **Promise a delivery date** it was not given.
3. **Claim work exists** that does not — no invented portfolio, no invented
   feature.
4. **Write a client credential** anywhere: not to the database, not to the audit
   log, not to a message (ADM-15).
5. **Treat a client's word as a fact.** "I paid" is a claim that raises a
   verification request; it is never the verification.

These are absolute. They do not become permissible at a higher autonomy level,
and an agent that needs one of them is an agent that needs a human.

---

## 6. Provenance

Every AI-produced business fact carries where it came from: the source input,
the model, the structured output, whether it validated, and which human
accepted it. An AI-generated statement is a **proposal** until a rule makes it
authoritative.

---

Owner: the Admin. Reviewed: 2026-08-13.
