# WhatsApp Embedded Signup — what Meta's documentation says

**Gap G-123. Decision ADM-57 granted Embedded Signup as the binding mechanism; this file records what that mechanism actually requires.**

---

## What this file is, and what it is not

Every fact below was **read from Meta's public documentation on 2026-08-14** and is recorded with the page it came from. That is the whole purpose: G-123 exists because ADM-57 chose Embedded Signup while nothing in this repository established what it needs, and the owner directed that **provider API capabilities are not to be invented**.

**This file is not verification that AgencyOS can use any of it.** Nothing here was tested against a Meta account, no app has been submitted for App Review, and no WhatsApp Business Account has ever been onboarded by this system. Reading a requirement is not meeting it. The section *[What remains unverified](#what-remains-unverified)* is the honest half of this document and is longer than it looks.

Meta's documentation moves. Two version markers are recorded throughout so a reader can tell at a glance whether this file has aged: **Embedded Signup v4** and **Graph API v25.0**. If either has moved on, treat everything here as suspect and re-read the source.

> **The changelog could not be retrieved.** Both paths tried returned HTTP 500 and 404 on 2026-08-14. So this file **cannot claim** that none of the facts below has been superseded by a change Meta has already announced. That is a known hole, not an oversight.

---

## The four things G-123 said were unknown

| # | Unknown | Answered? |
|---|---|---|
| 1 | Which permissions the flow needs | **Yes** — from documentation |
| 2 | Whether business verification is a prerequisite | **Yes, with a nuance that matters** |
| 3 | What the current integration flow actually is | **Yes** — from documentation |
| 4 | That the agency is *eligible* for it | **No. Account-specific. Still external.** |

---

## 1. Permissions

Two, and both are needed for what AgencyOS does:

- **`whatsapp_business_management`** — needed for "access to onboarded customer WhatsApp Business account settings and message templates".
- **`whatsapp_business_messaging`** — needed for "access to onboarded customer business phone number settings, or if your app will be used by customers to send and receive messages".

**The gating requirement is Advanced Access, not the permission itself:**

> "You will not be able to onboard business customers until your app has been approved for **advanced access** for each of the permissions it requires."

That is an **App Review outcome**, which no amount of work in this repository can produce.

The app must also be a **Business-type app**.

---

## 2. Business verification — the nuance

It is easy to read "business verification required" as a hard gate before anything works. **That is not what the documentation says**, and the difference changes what can be built before it is done.

- Onboarding works **without** completing verification, up to **10 new business customers in a rolling 7-day window**. Only *newly onboarded* customers count against the limit.
- Completing **Business Verification, App Review and Access Verification** raises the limit to **200 new business customers in a rolling 7-day window**.
- Becoming a **Tech Provider** does require verifying the business with Meta — business name, address, phone number, email and website.

**So the ceiling is the gate, not the door.** An unverified integration can onboard, and stops at ten per week.

---

## 3. The flow

### What the customer sees

1. Authenticates with Facebook/Meta credentials
2. Accepts terms of service for multiple platforms
3. Selects WhatsApp APIs and grants app access
4. Selects or creates a business portfolio and WABA
5. Enters and verifies a business phone number
6. An exchangeable token code is returned for server-side processing

### What the integration does

**Front end.** A Facebook Login for Business *configuration* in the App Dashboard — the "WhatsApp Embedded Signup Configuration With 60 Expiration Token" template, or a custom one selecting only the needed assets and permissions. The Facebook JS SDK is loaded from `https://connect.facebook.net/en_US/sdk.js`, initialised with the app id and Graph API version, and a `window.addEventListener('message', …)` listener captures the session info — which carries **`phone_number_id`** and **`waba_id`**.

**The 30-second fact.** The exchangeable code has a **time-to-live of 30 seconds**:

> "make sure you are able to exchange it for the customer's business token before the code expires."

This is the single most design-relevant sentence on the page. A flow that hands the code to a background job, a retry queue, or anything that might be delayed past half a minute is a flow that fails. The exchange has to happen inline, server-side, immediately.

**Back end — three calls, all server-to-server.** The documentation is explicit: *"Do not use client-side requests."*

| # | Call | Token used |
|---|---|---|
| 1 | `GET /oauth/access_token` with `client_id`, `client_secret`, `code` | none — client credentials |
| 2 | `POST /<WABA_ID>/subscribed_apps` | the business token from #1 |
| 3 | `POST /<BUSINESS_CUSTOMER_PHONE_NUMBER_ID>/register` with `messaging_product: "whatsapp"` and a 6-digit `pin` | the business token from #1 |

**Webhook.** The app must subscribe to the **`account_update`** webhook, which fires when a customer completes the flow and carries the business information the integration needs.

Meta notes that Solution Partners and Tech Providers have different procedures; the calls above are the **Tech Provider** path.

---

## 4. Credentials this needs

Recorded here because the flow cannot be built without naming them, and naming them is not the same as having them.

| Credential | Where it must live | Custodian | Status |
|---|---|---|---|
| Meta App ID | Server environment; also sent to the browser for `FB.init()` | Agency owner | **Not provisioned** |
| Meta App Secret | Server environment only — **never** the browser, never a repository | Agency owner | **Not provisioned** |
| Webhook verify token | Server environment | Agency owner | **Not provisioned** |
| Six-digit registration PIN | Per onboarded number; chosen at registration | Agency owner | n/a until onboarding |

The app secret is a production secret. It must never be printed, committed, logged, placed in a prompt, or pasted into a chat. When these exist, they belong in the deployment environment's secret store and are read by the server at runtime — **the integration mechanism can be configured without anyone seeing the values.**

---

## What remains unverified

**All of it, in the sense that matters.** The list below is not hedging; each line is something that could turn out to block AgencyOS entirely.

1. **Whether the agency is eligible.** Account-specific. Requires the agency's own Meta Business account and its verification standing.
2. **Whether App Review grants Advanced Access** for both permissions. This is a review outcome — it can be refused.
3. **Whether business verification succeeds** for this agency's details.
4. **Whether Tech Provider status is appropriate** for AgencyOS's shape, versus Solution Partner. The two have different onboarding procedures and different billing requirements, and nothing here establishes which applies.
5. **Every runtime behaviour above.** No call in this file has ever been made. The 30-second TTL, the token exchange, the subscribe and register calls, and the `account_update` webhook payload are all *documented* behaviour, not *observed* behaviour.
6. **Whether anything here is already superseded** — the changelog could not be retrieved.

**No WhatsApp message has ever been sent by this system, and no WhatsApp Business Account has ever been onboarded by it.** That remains true after this document, which is why G-123 narrows rather than closes.

---

## Sources

Read 2026-08-14. Meta has moved these pages from `/docs/whatsapp/…` to `/documentation/business-messaging/whatsapp/…`; the older paths still resolved.

- [Embedded Signup — overview](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/)
- [Embedded Signup — implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Onboarding business customers as a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
- [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
