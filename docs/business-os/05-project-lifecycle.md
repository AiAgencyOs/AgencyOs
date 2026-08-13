# Project Lifecycle

**Answered by the Admin on 2026-08-13.** The rules themselves live in
[`02-business-rules.md`](02-business-rules.md), deliberately in one place: this
session closed three separate defects caused by the same fact being written
twice and drifting. This file names which rules apply here and points at them.

---

## The path

```
planning → onboarding → active → completed
```

with `on_hold` and `cancelled` available throughout. Inside `active`, delivery
runs through versioned deliverables: design → prototype → build, each reviewed
by the client through the approval engine.

## Rules that apply

| Rule | Where |
| --- | --- |
| A version a client has seen is never overwritten | 02 §4.1 |
| Milestone payment is advisory — it warns, it does not block work | 02 §4.2 |
| Defect severity: Blocker / Major / Minor / Trivial | 02 §4.3 |
| Production ready = zero Blocker + zero Major + client approved the build | 02 §4.4 |
| Handover is refused while the final invoice is unpaid, owner may override | 02 §4.5 |
| AgencyOS never stores client credentials | 02 §4.5 |
| Task breakdown from approved requirements is automatic | 02 §6 |


Owner: the Admin. Reviewed: 2026-08-13.
