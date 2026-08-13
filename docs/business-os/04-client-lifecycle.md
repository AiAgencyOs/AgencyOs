# Client Lifecycle

**Answered by the Admin on 2026-08-13.** The rules themselves live in
[`02-business-rules.md`](02-business-rules.md), deliberately in one place: this
session closed three separate defects caused by the same fact being written
twice and drifting. This file names which rules apply here and points at them.

---

## The path

```
WhatsApp message → lead → qualified → deal → won → project → delivery
  → handover → completed → maintenance → repeat business
```

A completed project does **not** end the relationship. `core.client_accounts`
persists, and a returning client rejoins at "deal" on their existing lead
(02 §3.1).

## Rules that apply

| Rule | Where |
| --- | --- |
| Onboarding blocks nothing — every item is a reminder | 02 §3.3 |
| A project officially starts on three conditions, owner may override | 02 §3.4 |
| Two WhatsApp groups: the client's project group, and the internal approval group | 02 §5.1 |
| AgencyOS is the record; WhatsApp is a channel | 02 §1 |

## Upsell

AgencyOS may **identify** an opportunity and tell the team. It may not price
one: there is no catalog, and every price is quoted per client by a human
(02 §2.7).


Owner: the Admin. Reviewed: 2026-08-13.
