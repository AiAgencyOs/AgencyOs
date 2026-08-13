# Payment Milestones

**Answered by the Admin on 2026-08-13.** The rules themselves live in
[`02-business-rules.md`](02-business-rules.md), deliberately in one place: this
session closed three separate defects caused by the same fact being written
twice and drifting. This file names which rules apply here and points at them.

---

## The plan

**Any split totalling 100%.** 30/20/30/20 is a common shape, not a rule — a 5%
trust advance, a 10% advance, or no advance at all are all valid (02 §2.1).

The percentage is resolved into exact minor units when the plan is saved, so a
plan of 33.33/33.33/33.34 carries no rounding error afterwards.

## The path a milestone's money takes

```
milestone → draft invoice → issued → payment recorded → payment VERIFIED
  → next milestone opens (advisory)
```

## Rules that apply

| Rule | Where |
| --- | --- |
| Client approval makes the milestone invoice raisable — it does not send it | 02 §2.2 |
| `received` and `verified` are different; only verified unlocks | 02 §2.3 |
| Verification is the owner's or an ops admin's, against the bank | 02 §2.3 |
| Overdue after 3 days' grace; team notified; client auto-reminded | 02 §2.4 |
| Refunds are recorded in-system and need an approval | 02 §2.5 |
| Money is integer minor units. There is no float arithmetic on money, anywhere | — |
| There is no payment gateway. Every payment is a human recording money they have seen | — |


Owner: the Admin. Reviewed: 2026-08-13.
