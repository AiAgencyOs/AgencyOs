# G-031 — what "production ready" is allowed to mean

**Status:** open, awaiting an Admin decision (**ADM-19**)
**Written:** 2026-08-13

---

## Why this is being asked now and not before

Until this week the question was unanswerable. There was no defect table, so
"zero blocking bugs" had nothing to count; no versioned deliverables, so
"client approvals complete" had nothing to check; no handover, so "delivered"
was a feeling.

All of that now exists. **Every fact a production-ready gate would need is
already measurable — and no rule says which facts matter.** That is the whole
of this decision.

## What can be measured today, exactly

| Condition (directive §20) | Available now | Where |
| --- | --- | --- |
| Blocking defects = 0 | **Yes** | `qa.project_quality(project)` → `open_blockers`, `open_majors` |
| Fixed-but-unverified = 0 | **Yes** | same → `unverified` |
| Client approvals complete | **Yes** | `projects.deliverables` where `status = 'approved'`, per kind |
| Nothing awaiting a decision | **Yes** | `approvals.approval_requests` where `state = 'pending'` |
| Payment condition satisfied | **Yes, as a number** | `projects.completion_summary` → `outstanding_minor` |
| Handover delivered / accepted | **Yes** | `projects.handovers.status` |
| Build successful | **No** | Vercel knows; AgencyOS does not |
| Deployment successful | **No** | same |
| Security checks pass | **Partly** | CI proves it for *this repository*, not for a client's build |
| Documentation complete | **No** | nothing models it |

The last four are worth reading twice. Three of them are facts about a *client's
project*, and this system has never held them — a build of the customer app
succeeding is not something AgencyOS observes. A gate that claims to check them
would be lying, and a gate that quietly drops them is narrower than §20 reads.

## The four questions

### 1. Which conditions are hard gates, and which are advisory?

A hard gate refuses. An advisory shows red and lets a human proceed.

The distinction matters most for money. "No outstanding balance" as a **hard**
gate means a project cannot be marked ready while an invoice is unpaid — which
is sometimes exactly right, and sometimes means an agency cannot deliver work
the client has already accepted because an invoice is three days late.

### 2. Who may override, and is an override recorded?

If anything is advisory, somebody clicks past it. The approval engine already
exists and already records who decided what, with evidence, under a policy —
an override could be an `approval_request` rather than a checkbox, which is
what would make it auditable rather than a shrug.

### 3. Is it per project or per organization?

A fixed-price website and a year-long platform build plausibly do not deserve
the same bar. Policy rows already support per-subject-type thresholds; the same
shape would work here.

### 4. Does "production ready" gate anything, or is it a label?

Today nothing consumes it. It could gate handover (which already refuses on
open blockers), gate the final invoice, or simply be a status that reads true.
**A label nobody acts on is a comment**, and worth deciding deliberately rather
than discovering later.

## Three shapes

### A. A label with no teeth

`production_ready` becomes a computed readout: the facts above, shown together,
with no refusal anywhere.

- **For:** honest, cheap, impossible to get wrong, and immediately useful.
- **Against:** it changes nothing. The team that ships with four open blockers
  today will ship with four open blockers and a red panel.

### B. Hard gate on what the system actually knows

Refuse to mark a project ready while: open blockers or majors exist, fixed
defects are unverified, or any deliverable is still awaiting a client decision.
The four unmeasurable conditions are simply not claimed.

- **For:** every condition is one the database can prove. Nothing is asserted
  that AgencyOS cannot see.
- **Against:** narrower than §20 reads, and somebody will eventually want to
  ship with a known major. That want is what question 2 is for.

### C. Gate plus a recorded override

B, and an override is an `approval_request` of subject type `production_ready`
requiring the owner — so shipping with a known blocker is possible, and leaves
a row saying who decided it and why.

- **For:** matches how the rest of this system already works. Nothing is
  forbidden; the exception is evidence rather than a bypass.
- **Against:** one more approval subject type, and a policy row somebody must
  create before the first project can be marked ready.

## What I would choose, and the honest caveat

**C**, because it is the shape the rest of the system already uses and because
the alternative to a recorded override is not "no override" — it is somebody
editing a status directly and nobody knowing.

The caveat: C is only worth building if the answer to question 4 is that
readiness gates *something*. If it stays a label, A is the right amount of
work, and B and C are ceremony.

## What is not being asked

Whether the payment condition gates delivery. That is **ADM-13/ADM-14**
(G-100), still open, and this decision should not quietly settle it — which is
why "no outstanding balance" appears above as a question rather than a
recommendation.

## The decision

**ADM-19.** One of:

- **A** — a readout, gating nothing
- **B** — a hard gate on measurable conditions only
- **C** — B plus an owner-approved, recorded override *(recommended, if
  readiness gates anything at all)*

Plus, in every case: **does it gate handover, the final invoice, both, or
nothing?**

Until it is answered, `projects.status` has no `production_ready` value and
nothing computes one. The facts are all queryable today; only the rule is
missing.
