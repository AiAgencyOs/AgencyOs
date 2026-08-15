# Deployment runbook

**Gap G-052. Decision ADM-60 — three parts granted, five deferred.**

> The single production-readiness verdict lives at
> [`production-readiness.md`](production-readiness.md), which reconciles this
> runbook, the external-verification checklist, and the operations launch list
> into one answer. This runbook is the *how*; that file is the *whether*.

---

## Read this first

This runbook is **incomplete, and deliberately so.** Five facts it needs have not been decided, and the owner directed that they not be invented. Every one of them appears below as a **`⬚ NOT DECIDED`** blank with its decision id, not as a plausible-looking default.

A runbook with a guessed production database reference is worse than no runbook: somebody follows it at 2am and it works right up until it points at the wrong database.

**Nothing here has ever been executed.** No production environment exists. This is the procedure to follow once ADM-60 is answered — not a record of a deployment that happened.

> **Secrets:** this document names **where each secret must live and who holds it.** It never contains a secret value, and no step asks anyone to paste one into a chat, an issue, or a pull request.

---

## What ADM-60 granted

| # | Decision | Status |
|---|---|---|
| 1 | Hosting is **Vercel + managed Supabase** | ✅ **granted** |
| 2 | A **separate staging Supabase project**; preview deployments are **barred from the production database** | ✅ **granted** |
| 3 | Production migrations are run by a **named authorised human, not CI** | ✅ **granted** |

## What ADM-60 deferred — the five blanks

| # | Fact needed | Where it goes | Who decides |
|---|---|---|---|
| 4 | **⬚ Production Supabase project reference** | Vercel env `NEXT_PUBLIC_SUPABASE_URL` | Owner |
| 5 | **⬚ Vercel plan tier** | Vercel billing | Owner |
| 6 | **⬚ Service-role key custodian** — a named person | Vercel env, restricted | Owner |
| 7 | **⬚ Production domain** | Vercel domain + `NEXT_PUBLIC_APP_URL` | Owner |
| 8 | **⬚ Alert destination** | Alerting config | Owner |

**Until all five are supplied, do not deploy to production.** Steps 1–3 below cannot be completed without them, and steps 4 onward assume they were.

---

## 1. Provision — checklist

| Item | Value | State |
|---|---|---|
| Vercel project | ⬚ NOT DECIDED (ADM-60 #5 — tier) | ❌ |
| Supabase production project | ⬚ NOT DECIDED (ADM-60 #4) | ❌ |
| Supabase **staging** project | separate project, granted | ❌ not created |
| Production domain | ⬚ NOT DECIDED (ADM-60 #7) | ❌ |
| Alert destination | ⬚ NOT DECIDED (ADM-60 #8) | ❌ |
| Backup / PITR | Supabase plan feature — depends on #5 | ❌ **never tested** |

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
| `NEXT_PUBLIC_SUPABASE_URL` | all | **yes** | Owner | ⬚ ADM-60 #4 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | all | **yes** | Owner | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | **production only** | **yes** | ⬚ ADM-60 #6 | **never** in preview — bypasses RLS |
| `NEXT_PUBLIC_APP_URL` | all | yes | Owner | ⬚ ADM-60 #7 |
| `CRON_SECRET` | production | yes | Owner | unset ⇒ `/api/jobs/run` refuses |
| `ANTHROPIC_API_KEY` | production | optional | Owner | unset ⇒ `AI_PROVIDER_NOT_CONFIGURED`, never a silent fake result |
| `WHATSAPP_VERIFY_TOKEN` | production | optional | Owner | unset ⇒ webhook answers 503 |
| `WHATSAPP_APP_SECRET` | production | optional | Owner | signature verification |
| `WHATSAPP_ACCESS_TOKEN` | production | optional | Owner | unset ⇒ sending disabled |

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

`vercel.json` schedules `/api/jobs/run` every minute. Vercel issues cron invocations as **GET**; the route's GET export delegates to POST. `CRON_SECRET` gates it.

**Verify after first deploy:** a job actually claimed and settled. Never assume the scheduler fired.

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
- **Database:** ⬚ **depends on ADM-60 #5** — point-in-time recovery is a Supabase plan feature.

**What does not exist:**

- **No down-migrations.** Reverting a schema change means a new forward migration written deliberately, or PITR.
- **No staging-tested recovery.** Recovery is rehearsed **locally, on every CI run**: `npm run db:rehearse:restore` dumps the running local database, restores the dump alone into a fresh scratch database **in the same cluster**, proves every application table equal — row counts **and** contents, checksummed from one shared snapshot — and prints the measured time (the tamper hook in the script header is its red proof). What this does **not** prove is production recovery: the staging box below stays unticked until the same rehearsal runs against a real staging project (ADM-60's blanks first), and a cross-server restore would additionally need `pg_dumpall --globals`, which the same-cluster rehearsal cannot exercise.

**Order matters:** roll the application back **before** touching the database. An old application against a new schema usually survives; a new application against an old schema usually does not.

---

## Definition of done for this runbook

- [ ] All five ADM-60 blanks filled
- [ ] Staging Supabase project created
- [ ] A deploy executed and post-deploy checks passed
- [ ] A **restore rehearsed on staging**, with the measured recovery time written down
- [ ] Alert destination receiving a test alert

Until every box is ticked, **AgencyOS is not production ready**, whatever the test count says.
