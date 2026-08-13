# Approval Rules

**Answered by the Admin on 2026-08-13.** The rules themselves live in
[`02-business-rules.md`](02-business-rules.md); this file is the operational
view — what needs an answer, who owes it, and where it is asked.

---

## 1. Where an approval is asked

Two surfaces, one engine (`approvals.approval_requests`):

| Surface | Who sees it | What it is for |
| --- | --- | --- |
| `/approvals` | internal staff | The queue of everything waiting, with its deadline |
| **Internal WhatsApp group** | owner + staff + the agent | Where the agent raises it and gets approve / reject / feedback |

The group is a **channel**, not the record. An answer given there is written to
the approval request; the request is the fact.

---

## 2. What needs an approval

| Subject | Who may decide | Notes |
| --- | --- | --- |
| **Payment confirmation** | owner or ops admin | A client's "I paid" raises this. Confirming it is what makes money `verified` |
| **Anything with a price** | owner | Proposals, offers, quotes, re-pricing a deal |
| **Refund** | owner | No money returns without one |
| **Deliverable → client** | ops admin | UI design, prototype, build going out for client review |
| **Client's review of a deliverable** | the client | Recorded with who agreed and where to read it |
| **QA / production ready** | ops admin | Against the two conditions in 02 §4.4 |
| **Handover release** | owner | Required when the final invoice is unpaid (02 §4.5) |
| **Project start against unmet conditions** | owner | The override in 02 §3.4 |

---

## 3. What does *not* need an approval

- Internal task planning, scheduling and breakdown — the AI does this alone
  (02 §6).
- Follow-up messages to clients — **sent automatically, unread** (02 §5.2).
  This is the single exception to everything above, and it was chosen
  deliberately with the risk stated.
- Drafting anything. Only sending and committing need a human.

---

## 4. Deadlines and silence

Every request carries a deadline of **one hour** (ADM-39). Past it the request
is settled `expired` and a fresh one is raised against the **owner**, linked to
the original.

The original is never rewritten. It is the evidence that somebody did not
answer.

**Silence is never consent.** No approval is ever inferred from a lack of reply,
in the queue or in the group.

---

## 5. Money floor

`approvals.approval_policies` carries a money floor in DDL: a request above the
configured amount cannot be decided by a role below the one the policy names.
The floor is data, editable by the owner — not a constant in code.

---

Owner: the Admin. Reviewed: 2026-08-13.
