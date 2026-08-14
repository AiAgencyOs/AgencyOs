# Deployment runbook

**Gap G-052. Decision ADM-60 — three parts granted, five deferred.**

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

Set in **Vercel → Project → Settings → Environment Variables**. The validator in `src/lib/env.ts` refuses to boot on a malformed value rather than failing later at the first request.

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

| Check | How | Never assume |
|---|---|---|
| App boots | `GET /api/health` | — |
| Right database | health fingerprint matches production | **check this every time** |
| Cron fires | a `core.jobs` row moves out of `queued` | scheduler silence looks identical to no work |
| Auth | sign in as a real user | — |
| RLS | a second organization cannot read the first | — |
| Agent definitions | `npm run db:verify:definitions` | stamps drift-free rows only |

---

## Rollback

**What exists:**

- **Application:** Vercel keeps previous deployments. *Promote the last known-good deployment.* This is the real rollback path and it is fast.
- **Database:** ⬚ **depends on ADM-60 #5** — point-in-time recovery is a Supabase plan feature.

**What does not exist:**

- **No down-migrations.** Reverting a schema change means a new forward migration written deliberately, or PITR.
- **No tested recovery.** *No backup has ever been restored.* Until a restore is rehearsed on the staging project, recovery time is unknown — an untested backup is a hypothesis.

**Order matters:** roll the application back **before** touching the database. An old application against a new schema usually survives; a new application against an old schema usually does not.

---

## Definition of done for this runbook

- [ ] All five ADM-60 blanks filled
- [ ] Staging Supabase project created
- [ ] A deploy executed and post-deploy checks passed
- [ ] A **restore rehearsed on staging**, with the measured recovery time written down
- [ ] Alert destination receiving a test alert

Until every box is ticked, **AgencyOS is not production ready**, whatever the test count says.
