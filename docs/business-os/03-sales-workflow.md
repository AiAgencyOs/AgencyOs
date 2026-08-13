# Sales Workflow

**Answered by the Admin on 2026-08-13.** The rules themselves live in
[`02-business-rules.md`](02-business-rules.md), deliberately in one place: this
session closed three separate defects caused by the same fact being written
twice and drifting. This file names which rules apply here and points at them.

---

## The pipeline

`discovery → proposal → negotiation → won`, with `lost` off any stage.
**Four stages, deliberately** — see 02 §7.

Everything the agency actually does between them — contacted, sample sent, demo
sent, offer sent, follow-up, advance requested — is a **timestamped activity on
the lead**, not a stage. A deal sits in one stage; a lead accumulates a history.

## Rules that apply

| Rule | Where |
| --- | --- |
| One lead per person, forever; a returning client gets a new deal | 02 §3.1 |
| Winning a deal qualifies its lead | 02 §3.2 |
| Proposals: staff draft, owner approves, then send | 02 §7.1 |
| Re-pricing a deal: owner or ops admin, recorded | 02 §2.6 |
| Follow-ups are sent automatically, unread | 02 §5.2 |
| Samples and demos come only from the Admin's list | 02 §5.3 |
| No agent may invent a price | 08 §5 |

## The one open question

**ADM-57** — an owner can claim a WhatsApp number they do not own, which now
denies configuration to the rightful agency. Verify with Meta, or gate behind an
operator review?


Owner: the Admin. Reviewed: 2026-08-13.
