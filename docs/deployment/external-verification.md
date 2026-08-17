# External verification checklist

**Gaps G-110, G-116, G-123, G-091, G-122. Decisions ADM-57, ADM-74, ADM-75 — all granted.**

---

## Why this file exists

Some things cannot be proven by any amount of work in this repository. A passing test proves the code does what the test says; it proves nothing about what Meta's servers do. This checklist separates the two so that neither gets mistaken for the other.

**The rule this enforces:**

> **CODE VERIFIED** — a test or live-database check passes.
> **META VERIFIED** — a real Official Business Account actually did it.
>
> The second never follows from the first.

**Current state: nothing on this page is META VERIFIED.** No WhatsApp message has ever been sent or received by this system, and no WhatsApp Business Account has ever been onboarded by it. That is not a gap in the checklist — it is the finding.

---

## Prerequisites — none of which exist yet

| # | Item | State | Who |
|---|---|---|---|
| P1 | Meta Business portfolio | ❌ | Owner |
| P2 | **Business verification** submitted and passed | ❌ | Owner |
| P3 | Business-type Meta app created | ❌ | Owner |
| P4 | WhatsApp Business Account (WABA) | ❌ | Owner |
| P5 | A phone number registered to it | ❌ | Owner |
| P6 | **App Review → Advanced Access** for `whatsapp_business_management` **and** `whatsapp_business_messaging` | ❌ | Owner |
| P7 | Tech Provider **or** Solution Partner status decided | ❌ | Owner |

> **P6 can be refused.** Advanced Access is a review outcome, not a form. Until it is granted, no business customer can be onboarded at all.
>
> **P7 is not a formality.** Meta documents *different onboarding procedures* for the two, so G-091's design cannot be fixed until it is settled. This is why G-091 is not merely "not built" but "not designable".

---

## The eight capabilities

| # | Capability | CODE VERIFIED | META VERIFIED | Evidence required |
|---|---|---|---|---|
| 1 | Outbound 1:1 message | ✅ | ❌ | A real message received on a real handset |
| 2 | Inbound 1:1 webhook | ✅ | ❌ | A real reply arriving at `/api/webhooks/whatsapp` |
| 3 | Outbound **group** message | ✅ | ❌ | A message visible in a real WhatsApp group |
| 4 | Inbound **group** message | ✅ | ❌ | A real group reply filed to its group, opening **no** lead — see below |
| 5 | Sender identity | ❌ **not built** | ❌ | — see below |
| 6 | Group identification | ✅ | ❌ | `external_ref` matching the real group id |
| 7 | Webhook authenticity | ✅ | ❌ | A genuine Meta signature accepted; a forged one rejected |
| 8 | Failure behaviour | ✅ | ❌ | A real send failure parking as permanent, not looping |

### On #4 — built (G-115, closed), and #5 — deliberately absent

**Inbound group (#4) is built and CI-verified.** The webhook now branches on the parsed `groupId`: a group message routes to `crm.ingest_group_message` (`app/api/webhooks/whatsapp/route.ts`, `src/modules/crm/ingest.ts`), which records the message against its group and creates **no** contact, lead, or extraction job — so an internal-group reply is no longer filed as a new lead for the staff member who sent it. It is idempotent on `(organization_id, external_ref)`, and a group this system does not track is a success carrying `unknown_group`, not an error. `npm run db:verify:groupin` exercises this against real Postgres on every CI run; gap **G-115** is closed.

**What is not yet META VERIFIED for #4** is the real payload shape. The ingest assumes the webhook carries a `group_id`; only a captured real inbound-group webhook confirms that assumption and answers the sender-number question — gap **G-116**. So the CODE column is ✅ (the path is built and tested against the assumed shape) while META stays ❌ until a real group message is observed.

**Sender identity (#5) is blocked by design, not by effort.** `decide_approval` requires a signed-in human, a WhatsApp sender is an unverified and spoofable phone number, and `core.users` has no phone column at all. ADM-74 settled this: **the reply is advisory and settles nothing.** The announcement wording says so.

---

## Procedure, once P1–P7 exist

Run in order. **Record the actual observed result, not the expected one.**

| Step | Action | Passes when |
|---|---|---|
| 1 | Set `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN` in production | app boots; webhook stops answering 503 |
| 2 | Complete Meta's webhook verification handshake | Meta reports the callback verified |
| 3 | Send one outbound 1:1 | **a human confirms receipt on a handset** |
| 4 | Reply to it | a `crm.conversation_messages` row appears |
| 5 | Forge a webhook with a bad signature | **rejected** |
| 6 | Raise an internal-audience approval | announcement appears in the real internal group |
| 7 | Reply to that announcement | approval stays **pending** — ADM-74's rule, observed |
| 8 | Send to an invalid number | job parks **permanent**, does not retry forever |
| 9 | Observe an inbound group message | it lands in its group and opens **no** lead (G-115, built); capture the real payload to confirm the assumed `group_id` shape — G-116 |

**Step 7 is the one most likely to be reported wrongly.** A reply that appears to do nothing looks identical to a broken integration. The correct result is *the approval remains pending and the announcement invited no reply* — verify the message text says "Decide it in AgencyOS", not "Reply quoting".

---

## Sign-off

Nobody may mark a row META VERIFIED without naming what was observed, by whom, and when.

| # | Capability | Observed by | Date | Result |
|---|---|---|---|---|
| 1 | Outbound 1:1 | | | |
| 2 | Inbound 1:1 | | | |
| 3 | Outbound group | | | |
| 4 | Inbound group | | | |
| 6 | Group identification | | | |
| 7 | Webhook authenticity | | | |
| 8 | Failure behaviour | | | |

**Until this table has entries, no statement anywhere in this project may claim that WhatsApp works.**
