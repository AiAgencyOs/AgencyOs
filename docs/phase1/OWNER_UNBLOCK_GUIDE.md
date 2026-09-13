# Owner unblock guide — what only the owner can do, step by step

Written 2026-09-13, the day the Scheduler's credential-free work finished (G-244). Every
unit left in Phase 1 waits on one of the five items below. Each section says what to do,
where, what to give AgencyOS, and what happens the moment it is done. **No key, token or
password is ever pasted into a chat or a document — only into Vercel's Environment
Variables.**

---

## 1. Google Calendar + Meet (BLK-005, ADM-102)

**What AgencyOS needs:** a Google *service account* that is allowed to act as one Workspace
user (the "meetings mailbox") on that user's calendar.

1. **Pick the mailbox.** A Workspace user the agency books against, e.g. `meetings@<your-domain>`
   (create it in admin.google.com → Directory → Users if it does not exist). Its primary
   calendar is the calendar. Meet links are created as this user, so it must be a real user,
   not a group or a shared calendar id.
2. **Google Cloud project.** console.cloud.google.com → create/select a project (e.g.
   `agencyos-scheduler`) → *APIs & Services → Library* → enable **Google Calendar API**.
3. **Service account.** *IAM & Admin → Service Accounts → Create service account* (name
   `agencyos-scheduler`; no roles needed) → open it → *Keys → Add key → Create new key → JSON*.
   A file downloads. It contains `client_email`, `private_key` and `client_id`.
4. **Domain-wide delegation.** admin.google.com → *Security → Access and data control → API
   controls → Manage Domain Wide Delegation → Add new*: Client ID = the JSON's `client_id`;
   OAuth scope = `https://www.googleapis.com/auth/calendar` → Authorize.
5. **Vercel.** vercel.com → team `agency-os5` → project `agency-os` → *Settings → Environment
   Variables* → add, Environment **Production**:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` = the JSON's `client_email`
   - `GOOGLE_SERVICE_ACCOUNT_KEY` = the JSON's `private_key` value, exactly as it is in the
     file (`-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----\n`, with the `\n`) —
     mark **Sensitive**
   - `GOOGLE_CALENDAR_ID` = the mailbox address (e.g. `meetings@<your-domain>`)
   - `GOOGLE_IMPERSONATE` = the same mailbox address
6. **Redeploy** (*Deployments → ⋯ on the latest → Redeploy*): environment changes reach the
   app only with a new deployment.
7. **Verify.** In the app: *Meetings → Verify calendar*. Green records the moment and the
   calendar. Then on any requested meeting: *Propose a time* → *Book*. The event and Meet
   link appear on the mailbox's calendar.

If *Verify calendar* says "Google rejected the service-account credential": the delegation
(step 4) is missing or the client ID/scope was typed wrong, or `GOOGLE_IMPERSONATE` is not
a Workspace user.

---

## 2. What follows a no-show (ADM-103)

**What AgencyOS needs:** one sentence. The follow-up engine already carries eight
situations, each with its own WhatsApp template registered at Meta; a missed meeting is not
one of them, and inventing the cadence is a business fact.

Answer in this shape (edit the numbers and wording):

> **missed_meeting**: first nudge **2 hours** after the agreed start, second **1 day** later,
> **maximum 2**, then hand the thread to a person. Template wording: *"Hi {name}, we missed
> you at today's call. Shall we pick another time?"* in Hindi and English.

What happens next: a `missed_meeting` situation is added to the engine, `crm.record_no_show`
queues it, the two templates are submitted at Meta (see §4) and registered on the Settings
page under "Messages outside the 24-hour window".

---

## 3. Agent activation (ADM-82, BLK-002)

**What AgencyOS needs:** for each agent, *enabled or not*, and at which level:

- **L0** read-only (never runs)
- **L1** propose — the agent drafts; a person accepts (everything today runs here)
- **L2** autonomous within limits — ADM-61's four things alone (read, draft, internal plan,
  breakdown); anything client-facing or touching money still goes to the internal group

The thirteen agents, with what each does today and a recommendation for Phase 1:

| key | does | recommend |
| --- | --- | --- |
| `requirement_collector` | requirements from a thread and from a meeting (G-239) | **on, L1** (already) |
| `sales` | reads intent, qualification, objections; drafts follow-ups; answers clients; summarises threads | **on, L1** — the client-facing loop stays proposed until you have watched it |
| `quality_assurance` | drafts a test plan for an agreed scope | on, L2 (already) |
| `project_manager` | breaks approved requirements into internal work | on, L2 (already) |
| `ui_designer` | screen inventory from the agreed scope | on, L2 (already) |
| `ui_prototype` | prototype notes | on, L2 |
| `customer_success` | check-in briefs on a finished project | on, L1 |
| `support` | triages a maintenance ticket | on, L1 |
| `handover` | drafts the handover package | on, L1 |
| `orchestrator` | routes between agents | off until the loop above is trusted |
| `developer` | implements approved scope in controlled tasks | off in Phase 1 |
| `finance` | invoices from approved milestones | off — money stays human (ADM-07) |
| `upsell` | proposes follow-on work | off in Phase 1 |

Answer as a list: `sales: on L1; orchestrator: off; …`. What happens next: the rows in
`ai.agents` are set by a migration (an audited decision, not a button), the Sales agent's
client-facing proposal and confirmation messages (Scheduler §6.1, §6.4) are built, and the
`meeting.analysed` event gets its consumer.

---

## 4. Meta WhatsApp production number (BLK-003)

Today Meta answers with its **Test Number** (+1 555-204-8026): only pre-listed numbers can
receive from it. Production needs your own number on a verified business.

1. **Business verification.** business.facebook.com → *Business settings → Security Centre →
   Start verification*: legal name, address, phone, website/domain, and a document (GST
   registration, certificate of incorporation, or a utility bill matching the address).
   Takes 1–5 business days; Meta may ask for more.
2. **The number.** A phone number that is **not** registered on the WhatsApp app (or delete
   it from the app first) and can receive an SMS or voice call.
3. **Add it.** developers.facebook.com → your app → *WhatsApp → API Setup → Add phone number*:
   display name (your agency's public name), category, the number → verify by OTP.
   Set a **two-step verification PIN** when asked and keep it.
4. **Display-name review** runs automatically; it must match your business.
5. **A permanent token.** *Business settings → Users → System users → Add* (name
   `agencyos`, role Admin) → *Add assets*: the app (full control) and the WhatsApp account
   → *Generate new token*: app = yours, expiry = never, permissions
   `whatsapp_business_messaging` and `whatsapp_business_management`. Copy it once.
6. **Vercel.** Replace `WHATSAPP_ACCESS_TOKEN` with the new token (Sensitive, Production);
   `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` stay. Redeploy.
7. **In the app.** *Settings → WhatsApp → Phone number id* = the new number's id from
   API Setup → Update. *Verify configuration* should now answer your number, not "Test
   Number". *Send test message* to the internal recipient.
8. **Webhook.** In the app's *WhatsApp → Configuration*: callback URL
   `https://agency-os-zeta-two.vercel.app/api/webhooks/whatsapp`, verify token = your
   `WHATSAPP_VERIFY_TOKEN`; subscribe to `messages`.
9. **Templates.** *Business settings → WhatsApp Manager → Message templates → Create*: one
   per follow-up situation the Settings page lists (eight today; nine with ADM-103), in
   English and Hindi, category *Marketing* or *Utility* as Meta's rules require. Submit;
   approval takes minutes to a day. Then register each on the Settings page under
   "Messages outside the 24-hour window", with its variables in order.
10. **Scale.** Standard access allows messaging with your own number; *Advanced Access*
    (App Review) is needed only past Meta's conversation limits. The limits rise as the
    number's quality stays green.

---

## 5. More AI provider keys (ADM-85) — optional

Each key registers one adapter; nothing else changes. All Production, all Sensitive; redeploy
after adding.

- Google Gemini: aistudio.google.com/apikey → `GEMINI_API_KEY`
- xAI Grok: console.x.ai → API keys → `XAI_API_KEY`
- OpenRouter: openrouter.ai/keys → `OPENROUTER_API_KEY`

Then *Agents → Verify provider*: each registered provider is probed with its own small model
and the answer recorded.

---

## In what order

1. **§1 Google** — 30 minutes, no waiting on anyone; the Scheduler is live the same hour.
2. **§2 ADM-103** — one sentence; a day of work follows.
3. **§3 ADM-82** — the list; the biggest unblock.
4. **§4 Meta** — start business verification today; the rest waits on it.
5. **§5 keys** — whenever.
