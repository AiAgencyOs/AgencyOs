# Deployment runbook

**Gap G-052. Decision ADM-60 — three parts granted, five deferred.**

> The single production-readiness verdict lives at
> [`production-readiness.md`](production-readiness.md), which reconciles this
> runbook, the external-verification checklist, and the operations launch list
> into one answer. This runbook is the *how*; that file is the *whether*.
>
> **Going live?** The owner-side steps — Vercel config, the AWS cron secrets,
> WhatsApp/Meta registration, the reactivation pilot — are a checkbox runbook at
> [`go-live-owner-guide.md`](go-live-owner-guide.md). Start there.

---

## Read this first

This runbook was written **incomplete, and deliberately so.** Five facts it needed had not been decided, and the owner directed that they not be invented — each appeared below as a `⬚ NOT DECIDED` blank carrying its decision id, not a plausible-looking default. A runbook with a guessed production database reference is worse than no runbook: somebody follows it at 2am and it works right up until it points at the wrong database.

**As of 2026-09-20, the owner answered.** All five are resolved below — two (#5, #6) as recorded values, three (#4, #7, #8) as **"the owner configures this directly in Vercel; this document does not hold the value"**, which is a real answer to *who decides and where it lives*, not a deferred one. Resolving the five facts is a separate claim from **verifying the value currently in Vercel is correct**, which this document cannot do from here.

**This runbook's original text also claimed "no production environment exists."** That had already stopped being true and nobody had told this file: [`production-readiness.md`](production-readiness.md) records a full readiness pass on 2026-09-12 (deploy `d4f825b`, DB 226/0, `agency-os-zeta-two.vercel.app`) with a live WhatsApp test number verified against Meta and a real Anthropic call answering, and the database is at 268/0 as of this session's own `npm run db:push`, run by the owner and confirmed in the terminal. That is the same staleness class the zero-trust audit found in application code, found here in documentation instead — the record did not move when the thing it described did.

> **Secrets:** this document names **where each secret must live and who holds it.** It never contains a secret value, and no step asks anyone to paste one into a chat, an issue, or a pull request.

---

## What ADM-60 granted

| # | Decision | Status |
|---|---|---|
| 1 | Hosting is **Vercel + managed Supabase** | ✅ **granted** |
| 2 | A **separate staging Supabase project**; preview deployments are **barred from the production database** | ✅ **granted** |
| 3 | Production migrations are run by a **named authorised human, not CI** | ✅ **granted** |

## What ADM-60 deferred — the five blanks

| # | Fact needed | Where it goes | Who decides | Answered |
|---|---|---|---|---|
| 4 | Production Supabase project reference | Vercel env `NEXT_PUBLIC_SUPABASE_URL` | Owner | ⬚ Owner sets this **directly in Vercel** — not recorded here (2026-09-20: the owner chose not to paste it in chat, and this document does not hold values it cannot keep current) |
| 5 | Vercel plan tier | Vercel billing | Owner | ✅ **Pro** (2026-09-20, owner) |
| 6 | Service-role key custodian — a named person | Vercel env, restricted | Owner | ✅ **The owner** holds it directly in their own Vercel account (2026-09-20, owner) |
| 7 | Production domain | Vercel domain + `NEXT_PUBLIC_APP_URL` | Owner | ⬚ Owner sets this **directly in Vercel** — same reasoning as #4; a domain is not a secret, but it is a URL, and this document does not repeat one back |
| 8 | Alert destination | Alerting config | Owner | ⬚ Owner sets this **directly in Vercel** — `ALERT_WEBHOOK_URL` is a URL, same reasoning |

**All five now have an answer.** Two (#5, #6) are recorded as values above. Three (#4, #7, #8) are resolved as **"the owner configures this directly in Vercel, and this document intentionally does not hold the value"** — a different state from `NOT DECIDED`: the decision *has* been made (who does it, and how), the *value* itself is deliberately kept out of a document that would otherwise need to be kept in sync with it by hand every time it changes. Steps 1–3 below can now proceed on that basis.

---

## 1. Provision — checklist

| Item | Value | State |
|---|---|---|
| Vercel project | ✅ created. Plan: **Pro** (ADM-60 #5, answered 2026-09-20 — this corrects the earlier draft of this row, which guessed Hobby before the owner answered). The per-minute tick is still driven by an **external scheduler** (§5), not Vercel cron; Pro was not *required* for that reason, it is simply the plan the owner is actually on | ✅ |
| Supabase production project | Owner sets `NEXT_PUBLIC_SUPABASE_URL` directly in Vercel (ADM-60 #4) | ⬚ **verify in Vercel**, not here |
| Supabase **staging** project | separate project, granted | ❌ not created |
| Production domain | Owner sets `NEXT_PUBLIC_APP_URL` and the Vercel domain directly (ADM-60 #7) | ⬚ **verify in Vercel**, not here |
| Alert destination | Owner sets `ALERT_WEBHOOK_URL` directly (ADM-60 #8) | ⬚ **verify in Vercel**, not here |
| Backup / PITR | Supabase plan feature, independent of the Vercel plan tier above — **still depends on which Supabase plan is active, which is not one of the five ADM-60 facts and remains unasked** | ❌ **never tested** |

## 2. Environment variables

Set in **Vercel → Project → Settings → Environment Variables**. The parse in `src/lib/env.ts` (whose shape lives in `src/lib/env-schema.ts`) refuses to boot on a malformed value, and `src/instrumentation.ts` runs the production-completeness check at server startup — a deployment missing `CRON_SECRET`, carrying a test base-URL override, or pointed at `http://localhost` **refuses to start**, naming every offender, rather than booting and 503-ing its cron heartbeat.

**Before deploying, dry-run the check:** `npm run config:doctor -- --production` reports what is missing or unsafe **without printing any value** — safe to paste into an issue. For the server secrets a green run means the startup check will pass. `NEXT_PUBLIC_APP_URL` is the exception: it is inlined at **build** time, so run the doctor in the same environment the build uses, or its verdict on that one variable can differ from what the built server checks.

Rules the production check enforces (technical completion of this table, no invented values):
- `CRON_SECRET` is **required** in production (the runner is inert without it).
- `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` must be set **together or not at all**.
- `WHATSAPP_GRAPH_BASE_URL` and `ANTHROPIC_BASE_URL` must **not** point at an external host (the credential-redirection edge). A loopback value is allowed — it marks the CI verification harness, which builds and starts the app in production mode against local stubs.
- `NEXT_PUBLIC_APP_URL` must be **https** and not localhost. Note: `NEXT_PUBLIC_*` is inlined at **build** time, so it must carry the production value when Vercel builds.

| Variable | Scope | Required | Custodian | Notes |
|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | all | **yes** | Owner | ADM-60 #4 — owner sets directly in Vercel, value not recorded here |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | all | **yes** | Owner | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | **production only** | **yes** | **Owner** (ADM-60 #6, answered 2026-09-20) | **never** in preview — bypasses RLS |
| `NEXT_PUBLIC_APP_URL` | all | yes | Owner | ADM-60 #7 — owner sets directly in Vercel, value not recorded here |
| `CRON_SECRET` | production | yes | Owner | unset ⇒ `/api/jobs/run` refuses |
| `ANTHROPIC_API_KEY` | production | optional | Owner | unset ⇒ `AI_PROVIDER_NOT_CONFIGURED`, never a silent fake result |
| `OPENAI_API_KEY` | production | optional | Owner (ADM-94) | speech to text. Unset ⇒ a voice note is recorded and not heard, and the transcript says so |
| `WHATSAPP_VERIFY_TOKEN` | production | optional | Owner | unset ⇒ webhook answers 503 |
| `WHATSAPP_APP_SECRET` | production | optional | Owner | signature verification |
| `WHATSAPP_ACCESS_TOKEN` | production | optional | Owner | unset ⇒ sending disabled. Must be a **System-User** token with expiry **Never** — the API Setup page's token dies in 24h and has stopped sending three times. See go-live-owner-guide §D1a |
| `ALERT_WEBHOOK_URL` | production | optional | Owner | ADM-60 #8 — owner sets directly in Vercel, value not recorded here. unset ⇒ backlog alerts log only, never delivered |

**Alert destination (ADM-60 #8 — `ALERT_WEBHOOK_URL`).** The receiver must accept an **arbitrary JSON** body. `src/lib/observability/alert.ts` `POST`s `Content-Type: application/json` with the payload `alertPayload` builds (`src/lib/observability/backlog.ts`), once per cron tick while the operational backlog is non-empty:

```json
{
  "source": "agencyos",
  "deployment": "<NEXT_PUBLIC_APP_URL>",
  "severity": "clear | degraded | failing",
  "signature": "<stable per situation, for de-dup>",
  "summary": "3 dead jobs; 2 overdue approvals",
  "detail": { "…": "the core.operational_backlog row" }
}
```

A generic JSON webhook receiver — an incident/monitoring tool that ingests JSON, or a Zapier/Make/n8n "Webhook" trigger, or a small serverless endpoint — works directly. Slack and Discord incoming webhooks expect `{text}` / `{content}`, **not** this shape, so they need a one-step adapter that maps `summary → text`. Set the value in Vercel (production scope); it is never pasted into a chat, issue, or PR.

**Preview deployments must never receive `SUPABASE_SERVICE_ROLE_KEY` or any production Supabase URL.** ADM-60 granted that previews are barred from the production database; `/api/health` reports a twelve-character fingerprint of its database URL (G-083) so a misconfigured preview is visible rather than assumed.

## 3. Migrations — a human, not CI

ADM-60 granted this explicitly. CI has **no** production database credentials and must never be given them.

```bash
supabase link --project-ref <⬚ ADM-60 #4>
supabase db push --linked
```

**Before running:** confirm the linked project reference is production and not staging. `supabase projects list` prints both.

**Migrations in this repository are forward-only.** There is no `down` migration, and none should be written speculatively — a rollback path nobody has executed is a guess. See *Rollback* below for what is actually available.

## 4. Deploy

Vercel builds from `main`. `next build` must be green — CI already gates this on every PR.

## 5. Cron

The engine's heartbeat is a plain HTTP trigger: **POST `/api/jobs/run` every minute**, carrying `Authorization: Bearer <CRON_SECRET>`. The route also accepts GET (delegates to POST) for schedulers that only issue GET. Whatever calls it — the driver is pluggable — the endpoint and its `CRON_SECRET` gate are the same. A missed minute is caught up on the next tick; the follow-up worker, job reaper, and operational-backlog sweep all key off it.

> **The full external-cron procedure — including getting past Vercel Deployment Protection (SSO), the exact `x-vercel-protection-bypass` header/token, where each secret lives, the EventBridge → Lambda flow, and a verification checklist — is [`cron-external-trigger.md`](cron-external-trigger.md).** The production deployment is SSO-protected, so an external scheduler must present a **Protection Bypass for Automation** token *in addition to* `CRON_SECRET`, or every request 302-redirects to `vercel.com/sso-api` before reaching the runner. That is the load-bearing detail; this section is the summary.

**Driving the tick — pick ONE external scheduler.** (This section used to cite "ADM-60 #5" for the scheduler choice; that citation was wrong — #5 is the Vercel plan tier, a separate fact, now recorded above as Pro. The scheduler choice itself was never one of ADM-60's five deferred facts.)
- **External cron (what `infra/aws/cron` in this repository is actually built for, and the live mechanism).** `vercel.json` carries **no `crons`** block, checked directly in this repository as of this audit — so the tick is driven externally regardless of Vercel plan. An external per-minute scheduler POSTs the endpoint with the secret. Cheap, pay-as-you-go options, all equivalent:
  - **AWS EventBridge Scheduler → Lambda** — a `rate(1 minute)` schedule invoking a tiny function that `fetch`es `https://<app>/api/jobs/run` with the `Authorization` header. Effectively free at 1/min. `infra/aws/cron` in this repository is this path.
  - **Supabase `pg_cron` + `pg_net`** — a per-minute `cron.schedule` running `net.http_post(...)` at the same endpoint. No new service (the DB is already provisioned).
  - Any hosted cron (cron-job.org, a GitHub Actions schedule, etc.) that can send the header.
- **Vercel native cron (alternative, not currently used).** Now that the plan is confirmed **Pro** (ADM-60 #5), native cron is *available* rather than capped — Hobby's once-a-day cap no longer applies either way. Re-adding the `crons` block to `vercel.json` would switch to it, but `vercel.json` does not carry one today and `infra/aws/cron` exists, so the external path is what is actually wired up — switching would be a deliberate change, not a default.

Whichever driver, the secret **must** match `CRON_SECRET` in the deployment env, and the driver must fire at least once a minute for the follow-up SLAs to hold.

**Verify after first deploy:** hit the endpoint once with the secret, then confirm a job actually claimed and settled (`crm.follow_up_sequences` / `core.jobs` state, or the Operations page). Never assume the scheduler fired.

## 6. Post-deploy verification

**The rows that need no human are one command:** `npm run smoke -- https://<deployment>`
(scripts/smoke.mjs). It checks the app answers, health with both dependencies,
the database fingerprint (a run that cannot check it **fails** — export
`NEXT_PUBLIC_SUPABASE_URL` or `SMOKE_EXPECT_TARGET`), and that the cron runner
and webhook refuse strangers with the exact statuses the routes promise; a
webhook answering 503 is reported as **not configured, refusal not proven** —
never as a guard that held. With `CRON_SECRET` / `WHATSAPP_VERIFY_TOKEN` in
the environment it also proves the authorized tick and the real handshake, and
says "not proven here" when they are absent rather than passing vacuously. The
same command runs in CI against the built app on every merge. Agent
definitions keep their own command, and the last three rows stay human.

| Check | How | Never assume |
|---|---|---|
| App boots | `npm run smoke` — `GET /api/health` | — |
| Right database | `npm run smoke` — fingerprint must match, or the run fails | **check this every time** |
| Guards hold | `npm run smoke` — unauthenticated tick, wrong secret, wrong verify token, unsigned delivery: all refused | a guard nobody probes is a hope |
| Cron fires | a `core.jobs` row moves out of `queued` (manual — needs DB access) | scheduler silence looks identical to no work |
| Auth | sign in as a real user (manual) | — |
| RLS | a second organization cannot read the first (manual) | — |
| Agent definitions | `npm run db:verify:definitions` | stamps drift-free rows only |

---

## Rollback

**What exists:**

- **Application:** Vercel keeps previous deployments. *Promote the last known-good deployment.* This is the real rollback path and it is fast.
- **Database:** ⬚ **depends on the Supabase plan tier**, which is not one of ADM-60's five facts and has not been asked. (This line also used to cite "#5," which is the *Vercel* plan tier and does not determine Supabase's PITR availability — the same mis-citation corrected in §5 above.) Point-in-time recovery is a Supabase plan feature.

**What does not exist:**

- **No down-migrations.** Reverting a schema change means a new forward migration written deliberately, or PITR.
- **No staging-tested recovery.** Recovery is rehearsed **locally, on every CI run**: `npm run db:rehearse:restore` dumps the running local database, restores the dump alone into a fresh scratch database **in the same cluster**, proves every application table equal — row counts **and** contents, checksummed from one shared snapshot — and prints the measured time (the tamper hook in the script header is its red proof). What this does **not** prove is production recovery: the staging box below stays unticked until the same rehearsal runs against a real staging project — ADM-60's five facts are answered now, but the staging Supabase project itself (granted separately, decision #2 above) still has not been created — and a cross-server restore would additionally need `pg_dumpall --globals`, which the same-cluster rehearsal cannot exercise.

**Order matters:** roll the application back **before** touching the database. An old application against a new schema usually survives; a new application against an old schema usually does not.

---

## Definition of done for this runbook

- [x] All five ADM-60 blanks resolved (2026-09-20) — #5 and #6 as recorded values; #4, #7 and #8 as "the owner sets this directly in Vercel and this document does not hold the value." A deploy already exists (`production-readiness.md`, 2026-09-12 onward) that this decision retroactively covers.
- [ ] Staging Supabase project created
- [ ] A deploy executed and post-deploy checks passed *on that staging project specifically* — a production deploy already exists and is covered above; staging is still ungranted-to-created
- [ ] A **restore rehearsed on staging**, with the measured recovery time written down
- [ ] Alert destination receiving a test alert

Resolving the five blanks answers **who decides and where the value lives**, not **whether the value is currently correct** — this document cannot verify that from here. Until the remaining boxes are ticked, **AgencyOS is not production ready in the sense this runbook means**, whatever the test count says; `production-readiness.md` is the authoritative verdict on what *is* true today.
