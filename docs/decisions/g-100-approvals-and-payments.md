# G-100 — which approvals unlock which payments

**Status:** open, awaiting an Admin decision (**ADM-13 / ADM-14**)
**Written:** 2026-08-13
**Blocks:** G-100, and shapes the answer to ADM-19 (G-031)

---

## The situation, stated plainly

Two mechanisms exist and they do not touch each other.

**Money flows on payment.** An invoice is generated from a milestone, issued,
paid — and `invoice.paid` unlocks the next milestone. That chain is built,
tested, and safe under concurrency.

**Approval flows on delivery.** A design is versioned, submitted, approved by
the client through the engine, and earlier versions are superseded. That chain
is built and tested too.

**Nothing connects them.** A client can approve the design and no invoice
moves. An invoice can be paid for a milestone whose deliverable was never
shown. Directive §18 describes the sequence the agency actually works in:

> UI_APPROVED → MILESTONE_PAYMENT_DUE → PAYMENT_RECEIVED → NEXT_PHASE_UNLOCKED

The middle arrow does not exist in the system.

## What the schema does and does not support today

`projects.milestones` has `name`, `position`, `amount_minor`, `status`
(`pending → in_progress → submitted → met → rejected`) and `due_on`.

**A milestone has no idea a deliverable exists.** There is no column linking
"Design approved" the milestone to `design v3` the deliverable. Any option
below except A needs one, and where it goes is part of the decision.

## The three questions

### 1. Does an approval *release* a payment, or merely *permit* it?

- **Release:** approving design v3 marks the design milestone met and generates
  its invoice. The agency bills automatically when the client says yes.
- **Permit:** the invoice cannot be *issued* until the linked deliverable is
  approved, but issuing stays a human act.

The difference shows up on a bad day. Under *release*, a client approving a
design at 11pm generates an invoice at 11pm — which may be exactly right, or
may be a bill arriving before anyone has checked the numbers.

### 2. Does an unpaid invoice block delivery?

Handover currently **reports** the outstanding balance and refuses nothing.
Making it refuse means a client who is late paying cannot receive work they
have already approved — sometimes correct leverage, sometimes an agency
withholding a deliverable over a three-day-old invoice and damaging a
relationship worth more.

This is ADM-14, and it is genuinely a commercial policy rather than an
engineering choice.

### 3. Is the mapping per project or a template?

The 30/20/30/20 default in the directive implies a shape: advance,
UI/prototype, development, final. But §10 is explicit that it "must not be
hard-coded as an absolute business rule". A per-project mapping is more honest
and more work; a template is faster and will be wrong for some clients.

## Four shapes

### A. Leave them unconnected

Approvals are recorded; billing follows the plan's own schedule. A human bills
when they judge the moment right, informed by the approval they can see.

- **For:** nothing to build, nothing to get wrong, and the agency keeps the
  judgement it already exercises.
- **Against:** §18's sequence stays a description of what people do rather than
  what the system does, and "was this milestone actually delivered before we
  billed for it?" remains unanswerable from the data.

### B. Approval permits issuing *(the narrow gate)*

Add `projects.milestones.requires_deliverable_id` (nullable). `issue_invoice`
refuses while that deliverable is not `approved`. Generating a draft stays
free; sending the bill is what waits.

- **For:** the smallest change that makes §18 true. Refuses only the act that
  reaches the client — and there is precedent: this is exactly the shape of the
  QA gate, which refuses `submit_deliverable` rather than every write.
- **Against:** a milestone with no linked deliverable behaves as today, so the
  guarantee is only as good as the linking somebody remembers to do.

### C. Approval releases the payment

B, plus: approving the deliverable marks its milestone `met` and generates the
invoice automatically.

- **For:** the full §18 chain, hands-off.
- **Against:** money moves on a client's click. Everything else in this system
  that touches money requires a human — `record_manual_payment` asserts what a
  person saw, refunds need an approval, and `decide_approval` refuses a caller
  with no identity. Automatic invoicing would be the first exception, and it
  deserves to be an explicit choice rather than a consequence.

### D. B, and payment gates handover as well

Both directions: approval permits billing, and an outstanding balance refuses
handover.

- **For:** the complete §18/§21 reading.
- **Against:** question 2's answer, with all the commercial weight that carries.
  It should be answered on its own, not acquired by picking a bundle.

## What I would choose

**B**, with the mapping per milestone rather than templated.

It makes §18 true where it matters — a bill cannot reach a client for work the
client never accepted — while leaving the two things that deserve a human: the
decision to send an invoice, and the decision to withhold delivery over money.

I would not choose C. Not because automatic billing is wrong, but because every
other money path in this system requires a person, and making the first
exception a client's click is a bigger change than it looks. If you want C, it
should be because you want it, not because it followed from B.

D I would leave until question 2 is answered on its own terms.

## What this does not decide

**ADM-22** — the offer catalog and pricing. Nothing here sets an amount; the
milestone amounts remain whatever the payment plan says.

## The decision

**ADM-13** — of A, B, C, D. And if B or C: is the mapping per project, or a
template applied at project creation?

**ADM-14** — does an outstanding balance refuse handover? Yes or no, on its own.

Until both are answered, `projects.deliverables` and `finance.invoices` stay
unconnected and G-100 stays open. The record says so rather than a gate
appearing that nobody chose.
