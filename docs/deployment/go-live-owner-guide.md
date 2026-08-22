# Go-live — the owner's manual runbook

Every step here needs **your** accounts, credentials, or decisions — they are the
things the system deliberately will not do for you. The repository and
infrastructure side is already done: the app is deployed on `agency-os5/agency-os`,
the production database is migration-current, the AWS cron stack is deployed
**inert**, and every in-product setter below already exists. What remains is
configuration and a few genuine decisions.

Work top to bottom. The order matters — each part depends on the ones above it.

> **Secret hygiene, without exception.** Never paste a secret value into a chat,
> an issue, a pull request, or a shell whose history is logged. Type secrets
> directly into the Vercel UI, or into a terminal command you run yourself. This
> document contains only `<placeholders>`.

**Companion references:** [`runbook.md`](runbook.md) (the how) ·
[`production-readiness.md`](production-readiness.md) (the whether) ·
[`cron-external-trigger.md`](cron-external-trigger.md) (the cron contract) ·
[`../../infra/aws/cron/README.md`](../../infra/aws/cron/README.md) (the AWS stack).

---

## Part A — Vercel production configuration

The master unblock. Until this is done the app is deployed but sealed behind
Vercel's SSO wall with no runtime config.

### A1. Set the five Production environment variables
- [ ] Open **vercel.com → team `agency-os5` → project `agency-os` → Settings → Environment Variables**.
- [ ] Add each with **Environment = Production**:

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://hodwqdfzxwakuahxzjiw.supabase.co` | your production Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → **anon** key | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → API → **service_role** key | **Production only — never Preview** |
| `CRON_SECRET` | a long random string you generate (`openssl rand -hex 32`) | reused verbatim in Part B |
| `NEXT_PUBLIC_APP_URL` | `https://<your-production-domain>` | https, not localhost |

- [ ] **Save**, then redeploy (**Deployments → ⋯ latest → Redeploy**) — `NEXT_PUBLIC_*` are inlined at build time.

> Set these on `agency-os5/agency-os`, **not** the `buss-enhancer/agencyos` project
> created earlier by mistake — that one is an orphan; ignore or delete it.

### A2. Enable Protection Bypass for Automation
- [ ] Same project → **Settings → Deployment Protection**.
- [ ] Find **Protection Bypass for Automation** → **Enable**.
- [ ] Vercel injects it as `VERCEL_AUTOMATION_BYPASS_SECRET`. **Reveal once and copy it** into a password manager — you need it in Part B and for smoke tests.

### A3. Verify (from your terminal)
- [ ] Before A2, the health check is walled: `curl -s -o /dev/null -w '%{http_code}\n' https://<prod-domain>/api/health` → `302`.
- [ ] After A2, with the bypass header it reaches the app:
  ```bash
  curl -s -w '\n%{http_code}\n' https://<prod-domain>/api/health \
    -H "x-vercel-protection-bypass: <VERCEL_AUTOMATION_BYPASS_SECRET>"
  ```
  Expect `200` and `{"status":"ok",...}`. Confirm the database fingerprint in the body is your production Supabase.

---

## Part B — Start the engine's heartbeat (AWS cron)

The stack is **already deployed inert** in AWS account **`138035228508`**, region
**`ap-south-1`**: Lambda `agencyos-cron-tick`, schedule `agencyos-cron-tick`
(**DISABLED**), secret `agencyos-cron-config` (**empty placeholders**), a
dead-letter queue and an error alarm. Two steps make it live.

### B1. Populate the secret
- [ ] In your own terminal (with AWS creds for that account) — the only place all three secrets meet:
  ```bash
  aws secretsmanager put-secret-value --region ap-south-1 \
    --secret-id agencyos-cron-config \
    --secret-string '{"PROD_URL":"https://<prod-domain>","CRON_SECRET":"<same value as A1>","VERCEL_AUTOMATION_BYPASS_SECRET":"<token from A2>"}'
  ```
  - `CRON_SECRET` **must exactly match** the Vercel value from A1.

### B2. Enable the schedule
- [ ] ```bash
  aws scheduler update-schedule --region ap-south-1 --name agencyos-cron-tick \
    --state ENABLED --schedule-expression 'rate(1 minute)' \
    --flexible-time-window '{"Mode":"OFF"}' \
    --target "$(aws scheduler get-schedule --region ap-south-1 --name agencyos-cron-tick --query Target --output json)"
  ```

### B3. Verify the chain
- [ ] Reached the runner but unauthenticated → **401** (not 302, not 503):
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<prod-domain>/api/jobs/run \
    -H "x-vercel-protection-bypass: <token>"
  ```
- [ ] Wrong secret past the wall → **401**:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<prod-domain>/api/jobs/run \
    -H "x-vercel-protection-bypass: <token>" -H "Authorization: Bearer wrong"
  ```
- [ ] Both correct → **200** + JSON:
  ```bash
  curl -s -w '\n%{http_code}\n' -X POST https://<prod-domain>/api/jobs/run \
    -H "x-vercel-protection-bypass: <token>" -H "Authorization: Bearer <CRON_SECRET>"
  ```
- [ ] Wait ~2 minutes → **AWS Console → Lambda → `agencyos-cron-tick` → Monitor**: invocations climbing, errors flat; the `agencyos-cron-tick-errors` alarm stays OK.

> **Pause anytime:** `aws scheduler update-schedule … --state DISABLED`.
> **Remove entirely:** `aws cloudformation delete-stack --stack-name agencyos-cron --region ap-south-1`.

---

## Part C — Agency timezone (before anything sends)

Nothing follows up until this is set — the worker refuses with `timezone_unavailable`.

- [ ] Sign in (owner) → **/settings → Agency timezone** → type your real IANA zone (e.g. `Asia/Kolkata`; `UTC` works too) → **Set timezone**. It is validated against Postgres's IANA list and audited.

---

## Part D — WhatsApp / Meta

Owning the number is **not** the same as Meta authorizing your app. Order matters.

### D1. WhatsApp secrets in Vercel (A1's screen, Production)
- [ ] `WHATSAPP_VERIFY_TOKEN` — a random string you invent (paste the same into Meta in D3).
- [ ] `WHATSAPP_APP_SECRET` — Meta App → **App Settings → Basic → App Secret**.
- [ ] `WHATSAPP_ACCESS_TOKEN` — a **System-User** token that never expires. **Not** the one on the API Setup page: that is a temporary token, it dies in **24 hours**, and it has now killed sending three times. Steps in D1a.
- [ ] Set `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` **together** (the app refuses one-without-the-other). Redeploy.

### D1a. The token that does not expire

Written out because *"a permanent System-User token"* was one line here for weeks
and the deployment ran on a temporary one anyway — the API Setup page offers a
token in one click, it works immediately, and it is dead by tomorrow. Each time
it died, sending stopped and a client's message went unanswered until somebody
noticed.

Meta renames things in this area often. The labels below are what they are
called today; if one has moved, the shape of the task has not.

1. **business.facebook.com** → your business → **Settings** (gear, bottom-left).
2. **Users → System users → Add**. Name it for what it is — `agencyos-whatsapp`
   — and give it the **Admin** role.
3. Select it → **Assign assets** → **Apps** → your Meta app → **Full control**.
4. **Assign assets** again → **WhatsApp accounts** → your WABA → **Full control**.
   **This step is the one that gets skipped**, and skipping it produces a token
   that generates successfully and then answers `401` on every call — which
   looks exactly like an expired token and is not one.
5. **Generate new token** → choose the same app → **Token expiration: Never** →
   tick **`whatsapp_business_messaging`** and **`whatsapp_business_management`**
   → **Generate**.
6. **Copy it now.** It is shown once and never again.
7. Vercel → the project → **Settings → Environment Variables** →
   `WHATSAPP_ACCESS_TOKEN` → **Edit** → paste → scope **Production** → **Save**.
8. **Redeploy.** An environment variable is read at boot, so an existing
   deployment keeps using the dead one until it restarts.
9. Confirm on **/settings → Configuration → WhatsApp**: `WHATSAPP_ACCESS_TOKEN`
   reads **configured**. That page reports presence and never a value.

**Never paste the token into a chat, an issue, a pull request, or a terminal
whose history is kept.** Type it into Vercel and nowhere else. Nothing in
AgencyOS accepts a secret through a form (ADM-84 §9 — the key vault waits for
ADM-60), which is why this is a Vercel step rather than an in-product one.

A system-user token survives a password change and a session logout, which is
the whole reason to use one. It still dies if the system user is deleted, if
its asset assignment is removed, or if the app is disabled — so if sending
stops again, check step 4 before assuming expiry.

### D2. Phone number id, in-product
- [ ] **/settings → WhatsApp → Phone number id** → paste the numeric `phone_number_id` from Meta → **Set number id**.

### D3. Register the webhook in the Meta App dashboard
- [ ] Meta App → **WhatsApp → Configuration → Webhook → Edit**.
- [ ] **Callback URL:** `https://<prod-domain>/api/webhooks/whatsapp`
- [ ] **Verify token:** the exact `WHATSAPP_VERIFY_TOKEN` from D1.
- [ ] **Verify and save** (Meta calls your endpoint; it must echo the challenge).
- [ ] **Subscribe to the `messages` field** — this delivers inbound messages **and** the delivered/read/failed receipts.

### D4. Message templates
- [ ] Business-initiated / out-of-session messages (which reactivation is) need **approved templates** — Meta → **WhatsApp Manager → Message Templates**. Create, submit, await approval. A Meta approval gated on your content — a business step, not code.

### D5. Verify configuration without messaging anyone
- [ ] **/settings → WhatsApp → "Verify configuration"** — a read-only Meta lookup (name, number, quality). **Sends nothing.**

### D6. Internal test recipient, then one controlled test
- [ ] **/settings → WhatsApp → Test recipient** → your own number (`+<countrycode><number>`) → **Set test number**.
- [ ] Once D1–D4 are green, do your **first real send to that number only** (never a customer) and confirm you receive it and that a delivered/read receipt appears against the message.

---

## Part E — AI provider

- [ ] Decide the provider and whose account (the ADM-85 decision — the system won't choose).
- [ ] Set `ANTHROPIC_API_KEY` in Vercel (Production). Unset ⇒ agents return `AI_PROVIDER_NOT_CONFIGURED`, never a fake answer.
- [ ] *Optional:* set `OPENAI_API_KEY` in Vercel (Production) so a client's voice note is transcribed — **ADM-94**. Unset ⇒ the recording is recorded and not heard, the transcript says `[voice note — not transcribed]`, and the client is still answered.
- [ ] Do **not** enable agents just because a key exists — activation is the deliberate governance step in Part F (ADM-82).

---

## Part F — Reactivating the 1,200+ leads (last, and slowly)

Only after A–E are green.

### F1. Decide and record the consent basis ⚠️
- [ ] Decide **on what lawful basis these historical contacts may be messaged on WhatsApp.** The system will **never invent consent**; a past conversation is *not* consent. Settle this before enrolling anyone. Everything below enforces "no consent = no send" at the database level.

### F2. Export the data from WhatsApp
- [ ] In WhatsApp, per chat/group: **⋯ → More → Export chat → Without media**. Extract the `_chat.txt` from the `.zip` (the importer wants the `.txt`).

### F3. Import & review (creates no consent, sends nothing)
- [ ] App → **/import → Upload & stage** → upload a `_chat.txt`. It parses, classifies (phone decides identity, never the name), and stages a batch.
- [ ] Review, then **Commit** the rows you trust — idempotent, de-dupes by phone, creates contacts/leads only. **No consent, no message.**

### F4. Record consent only where you legitimately have it
- [ ] Only contacts with a **granted** consent record can ever be messaged. (If you want an in-product per-contact consent-capture flow, ask — it was deliberately **not** built autonomously, because "what counts as valid consent" is your legal call.)

### F5. Turn the pilot on, enrol a *tiny* cohort first
- [ ] **/settings → Reactivation pilot → Enable** (default OFF — this is your explicit "go").
- [ ] On individual lead pages, **enrol** 5–10 consented, high-priority leads (ranked by fact-tiers: previously-quoted > previously-replied > has-conversation > cold). Only enrolled **and** consented leads nurture.
- [ ] Watch the first sends land; confirm delivery/read receipts; confirm a reply stops the sequence and opt-outs are honored. **Then** grow the cohort gradually.

> **Emergency stop:** **/settings → Reactivation pilot → Disable** halts all reactivation sends immediately.

---

## Part G — Final go-live verification

- [ ] From your terminal, with the two secrets in the environment:
  ```bash
  VERCEL_AUTOMATION_BYPASS_SECRET=<token> CRON_SECRET=<CRON_SECRET> \
    npm run smoke -- https://<prod-domain>
  ```
  Checks the app answers, `/api/health` with the right database fingerprint, the cron endpoint refuses strangers and accepts the authorized tick, and the webhook guards hold. Anything red names the step to revisit.

---

## What the system enforces for you

You do not have to remember these — they hold at the database level:

- **No consent → no send** — the outbound chokepoint refuses a contact without a granted row.
- **Pilot off by default**, per-lead enrolment, and a one-switch emergency stop.
- An agent **cannot invent pricing, approve its own quotation, or declare its own work verified.**
- Every configuration change is **audited**; tenants are **isolated**; secrets never reach the browser.

## The honest bottom line

Nothing is production-ready until **A2 + B** make the deployment externally
reachable and **D6** proves one real WhatsApp round-trip. Until then this is a
correct, well-guarded system waiting on the facts only you can supply.
