# Owner unblock guide — what only the owner can do, step by step

Written 2026-09-13, the day the Scheduler's credential-free work finished (G-244). Every
unit left in Phase 1 waits on one of the five items below. Each section says what to do,
where, what to give AgencyOS, and what happens the moment it is done. **No key, token or
password is ever pasted into a chat or a document — only into Vercel's Environment
Variables.**

---

## 1. Google Calendar (BLK-005, ADM-102)

**What AgencyOS needs:** a Google *service account* (a robot identity with its own email)
that may read and write ONE calendar. There are two ways to give it that, and the owner
chose the first (2026-09-13):

| | **Path A — plain Gmail (chosen)** | Path B — Google Workspace |
|---|---|---|
| Costs | nothing | a Workspace seat (~₹136–160 per user per month) |
| How the robot gets in | the owner SHARES their calendar with the robot's email | an admin grants *domain-wide delegation* |
| Reads free/busy, books, cancels | yes | yes |
| Google Meet link created by the app | **no** — Google refuses to create a Meet for a service account acting as itself. A video meeting still books; the confirmation says the person sends their own link | yes |
| `GOOGLE_IMPERSONATE` | leave UNSET | the mailbox address |

### Path A — a plain Gmail calendar shared with the robot

1. **Google Cloud project.** console.cloud.google.com, signed in as the Gmail account the
   agency books against → create/select a project (e.g. `agencyos-scheduler`) → *APIs &
   Services → Library* → enable **Google Calendar API**.
2. **Service account.** *IAM & Admin → Service Accounts → Create service account* (name
   `agencyos-scheduler`; no roles needed) → open it → *Keys → Add key → Create new key → JSON*.
   A file downloads. It contains `client_email` (the robot's address) and `private_key`.
   The file is a secret: never mail it, never paste it in a chat. Keep it OUT of the repository
   folder (the repo ignores files shaped like it, but a key that is not there cannot leak at
   all). If one is ever pasted or shared by accident: delete that key in *Keys* and create a
   new one — it takes a minute, and the old key stops working the moment it is deleted.
3. **Share the calendar.** calendar.google.com → ⚙ *Settings* → left column, under *Settings
   for my calendars*, click the calendar → *Share with specific people or groups → Add people*
   → paste the robot's `client_email` → permission **Make changes to events** → Send.
   (On the same settings page, *Integrate calendar → Calendar ID* is the value for step 4;
   for the primary calendar it is simply the Gmail address.)
4. **Vercel.** vercel.com → team `agency-os5` → project `agency-os` → *Settings → Environment
   Variables* → add, Environment **Production**:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` = the JSON's `client_email`
   - `GOOGLE_SERVICE_ACCOUNT_KEY` = the JSON's `private_key` value, exactly as it is in the
     file (the whole BEGIN…END block, with the `\n` sequences left in) — mark **Sensitive**
   - `GOOGLE_CALENDAR_ID` = the calendar id from step 3 (the Gmail address)
   - do NOT set `GOOGLE_IMPERSONATE`
5. **Redeploy** (*Deployments → ⋯ on the latest → Redeploy*): environment changes reach the
   app only with a new deployment.
6. **Verify.** In the app: *Meetings → Verify calendar*. Green records the moment and the
   calendar. Then on any requested meeting: *Propose a time* → *Book*. The event appears on
   the shared calendar. A video meeting books without a link and says so; the person adds
   their own (a personal Meet link from meet.google.com works, and can be reused).
   **Proved on this deployment 2026-09-13**: verify, propose (three slots from a real read),
   book (a Google event on the shared calendar, created by the robot) and cancel (the event
   taken back) all ran end to end.

If *Verify calendar* says the credential was rejected: the email and key do not match the
same JSON file, or the key was pasted with a character lost. If it says the calendar could
not be read: step 3 was not done for this robot, or `GOOGLE_CALENDAR_ID` names a different
calendar.

### Path B — Google Workspace with domain-wide delegation

1. **Pick the mailbox.** A Workspace user the agency books against, e.g. `meetings@<your-domain>`
   (admin.google.com → Directory → Users). Its primary calendar is the calendar; Meet links
   are created as this user, so it must be a real user, not a group.
2. Steps 1–2 of Path A (project, Calendar API, service account, JSON key). Note the JSON's
   `client_id` as well.
3. **Domain-wide delegation.** admin.google.com → *Security → Access and data control → API
   controls → Manage Domain Wide Delegation → Add new*: Client ID = the JSON's `client_id`;
   OAuth scope = `https://www.googleapis.com/auth/calendar` → Authorize.
4. Vercel as in Path A, plus `GOOGLE_IMPERSONATE` = the mailbox address and
   `GOOGLE_CALENDAR_ID` = the same address. Redeploy, verify. The Meet link is created by the
   app and sent with the confirmation.

If *Verify calendar* says the credential was rejected on this path: the delegation (step 3)
is missing or the client ID/scope was typed wrong, or `GOOGLE_IMPERSONATE` is not a
Workspace user.

---

## 2. What follows a no-show (ADM-103) — **ANSWERED 2026-09-13**

> **missed_meeting**: first nudge **2 hours** after the agreed start, second **1 day** later,
> **maximum 2**, then the thread goes to a person. Wording — first: *"Hi {name}, aaj hum aapse
> call par mil nahi paaye. Koi baat nahi — kya hum koi aur time rakh lein?"*; second: *"Hi
> {name}, kal wali call reschedule karni ho to bata dijiye, main time bhej deta hoon."*
> Stops on: the client replies, the meeting is rescheduled, or a new one is booked.
> The templates wait on §4 (a number of your own); the situation itself does not.

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

## 3. Agent activation (ADM-82, BLK-002) — **ANSWERED 2026-09-13**

> The recommendation below, taken as it stands: the five client-facing agents at **L1**, the
> four internal ones at **L2**, and `orchestrator`, `developer`, `finance`, `upsell` **off**.

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

## 5. More AI provider keys (ADM-85) — **ANSWERED 2026-09-13: add all three**

> Gemini, xAI and OpenRouter, beside the Anthropic and OpenAI keys already verified. Each is
> its own billing relationship, and OpenRouter forwards the prompt to whichever provider
> serves the model — a third party in the path for anything routed through it.

Each key registers one adapter; nothing else changes. All Production, all Sensitive; redeploy
after adding.

- Google Gemini: aistudio.google.com/apikey → `GEMINI_API_KEY`
- xAI Grok: console.x.ai → API keys → `XAI_API_KEY`
- OpenRouter: openrouter.ai/keys → `OPENROUTER_API_KEY`

Then *Agents → Verify provider*: each registered provider is probed with its own small model
and the answer recorded.

---

## In what order

1. **§1 Google** — 30 minutes, no waiting on anyone, no payment on Path A; the Scheduler is live the same hour.
2. **§2 ADM-103** — one sentence; a day of work follows.
3. **§3 ADM-82** — the list; the biggest unblock.
4. **§4 Meta** — start business verification today; the rest waits on it.
5. **§5 keys** — whenever.
