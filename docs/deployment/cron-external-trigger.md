# The engine's heartbeat — an external cron behind Vercel Deployment Protection

> This is the *how* for runbook [§5 (Cron)](runbook.md#5-cron). The engine's
> heartbeat is a plain HTTP trigger — **POST `/api/jobs/run` every minute** —
> and this document is the one place the whole path is written down: how an
> external scheduler reaches that endpoint through Vercel's protection wall,
> which secret authenticates it, where each secret lives, and how to prove the
> whole chain works before trusting it.

**Nothing here contains a secret value, and no step asks anyone to paste one
into a chat, an issue, or a pull request.** Where an owner-only value is
genuinely required it appears as a `<PLACEHOLDER>`, never invented.

---

## Why this exists — the two facts that make it necessary

1. **The app deploys on Vercel Hobby, and Hobby caps native cron at once per
   day.** The per-minute tick that drives follow-ups, reactivation, the outbox
   and backlog alerts cannot be a Vercel cron on this plan. So `vercel.json`
   carries **no `crons` block** (PR #243) and the tick is driven by an
   **external scheduler** instead. This does not weaken anything: `/api/jobs/run`
   has always been a plain external trigger; Vercel Cron was only ever one
   possible caller.

2. **The production deployment is behind Vercel Deployment Protection (SSO).**
   Every route — including `/api/health` and `/api/jobs/run` — answers an
   unauthenticated request with **`302 → https://vercel.com/sso-api`**. An
   external scheduler that just POSTs the endpoint gets the redirect and the
   job never runs. The scheduler must therefore present a **Protection Bypass
   for Automation** token to get past the wall, *in addition to* the app's own
   `CRON_SECRET`.

These are two independent doors, and a request must pass **both**:

| Door | What it guards | What opens it | Who enforces it |
|---|---|---|---|
| Vercel Deployment Protection | the whole deployment (edge) | header `x-vercel-protection-bypass: <VERCEL_AUTOMATION_BYPASS_SECRET>` | Vercel, before the function runs |
| The job runner's own auth | `/api/jobs/run` (app) | header `Authorization: Bearer <CRON_SECRET>` | `authorizeCronRequest` in the route |

The bypass token **only opens the edge door**. It authenticates nothing inside
the app: the runner still refuses anything without the correct `CRON_SECRET`
bearer. Sending the bypass token is not a downgrade of the runner's security.

---

## The final flow

```
┌────────────────────────┐   rate(1 minute)
│  EventBridge Scheduler  │ ───────────────┐
└────────────────────────┘                │  invoke
                                           ▼
                                 ┌───────────────────┐
                                 │       Lambda       │  builds one HTTPS POST
                                 └───────────────────┘
                                           │
     POST https://<PROD_DOMAIN>/api/jobs/run
     headers:
       Authorization:              Bearer <CRON_SECRET>            ← app auth (door 2)
       x-vercel-protection-bypass: <VERCEL_AUTOMATION_BYPASS_SECRET> ← edge bypass (door 1)
                                           │
                                           ▼
             ┌──────────────────────────────────────────────┐
             │  Vercel edge — Deployment Protection          │
             │  bypass header valid?  → pass to the function │
             └──────────────────────────────────────────────┘
                                           │
                                           ▼
             ┌──────────────────────────────────────────────┐
             │  /api/jobs/run  (app/api/jobs/run/route.ts)   │
             │  authorizeCronRequest():                      │
             │    Bearer matches CRON_SECRET? → 200, run one │
             │    tick   ·   else 401   ·   unset → 503      │
             └──────────────────────────────────────────────┘
                                           │
                                           ▼
             ┌──────────────────────────────────────────────┐
             │  the EXISTING job/cron runner (unchanged):    │
             │  claim one job under a row lock → dispatch     │
             │  outbox → reap stalled → follow-ups → expire   │
             │  approvals → lapse proposals → overdue → alert │
             └──────────────────────────────────────────────┘
                                           │
                                           ▼
             ┌──────────────────────────────────────────────┐
             │  the EXISTING outbox / worker system          │
             │  (core.jobs, core.outbox_events, follow-up    │
             │  sequences) — no new tables, no new queue      │
             └──────────────────────────────────────────────┘
```

**There is exactly one scheduler and exactly one job system.** EventBridge is a
*clock*, not a queue: it does one thing — fire an HTTP request every minute. All
the work, claiming, ret/reaping, idempotency and ordering already live in
`/api/jobs/run` and the `core.jobs` / `core.outbox_events` tables. **Do not add a
second queue, a second runner, a per-job Lambda, or any state in AWS.** If the
tick is ever missed, the next minute's tick catches up — the runner is designed
for that.

---

## The endpoint contract (what the runner actually answers)

From `app/api/jobs/run/route.ts` and `src/lib/cron-auth.ts` — this is the real
behaviour the scheduler must satisfy, not a sketch:

- **Method:** `POST`. `GET` is accepted and forwards to `POST` verbatim (same
  auth, same work) for schedulers that only issue GET.
- **Auth:** `Authorization: Bearer <CRON_SECRET>`, compared against the whole
  header value in constant time. A bare secret, a wrong scheme, or a
  differently-cased prefix all fail closed.
- **Responses:**
  - `200` — authenticated; the tick ran. Body is JSON reporting what happened
    this tick (`{ "claimed": 0, ... }` when the queue was empty, or
    `{ "claimed": 1, "status": "...", ... }` for the one job it took).
  - `401` — missing or wrong bearer. The body is the constant `unauthorized`.
  - `503` — **`CRON_SECRET` is not set on the deployment.** The runner is
    *disabled*, not *forbidden* — a broken deployment, because the scheduler is
    the engine's heartbeat. Treat a 503 here as a deploy-config failure.
  - `500` — the tick threw; the claimed job (if any) is settled with the normal
    retry backoff so it is not stuck.
- **Idempotency:** one tick claims **at most one** job, under a row lock, and a
  dead job is retried a bounded number of times by the reaper. Two ticks landing
  close together cannot double-run a job; a duplicate minute is safe.

---

## Owner-side setup — the exact steps

Everything below is done **by the owner, on the owner's Vercel and AWS
accounts**. Claude has no access to either the `agency-os5` Vercel team or the
production `CRON_SECRET`, and must not.

### 1. Enable Protection Bypass for Automation (Vercel)

1. Open the Vercel dashboard → the **`agency-os`** project (team `agency-os5`).
2. **Settings → Deployment Protection.**
3. Find **Protection Bypass for Automation** and **enable** it.
4. Vercel generates a secret and injects it into every deployment as the
   environment variable **`VERCEL_AUTOMATION_BYPASS_SECRET`**. Reveal it once,
   copy it, and store it as described under *Where the secrets live* below.
5. Redeploy is **not** required for the variable to exist in new deployments,
   but confirm it is present: Settings → Environment Variables should list
   `VERCEL_AUTOMATION_BYPASS_SECRET` (managed by Vercel).

> Alternative, less safe: disabling Deployment Protection entirely on
> production removes door 1 for *everyone*, exposing the whole app publicly.
> Prefer the bypass token — it opens the door only for a caller that holds it.

### 2. Confirm the app's own secrets are set on the owner's project

On the **same** `agency-os5/agency-os` project (Settings → Environment
Variables, **Production** scope), confirm — do not assume — that these are set.
Report each only as **SET / MISSING**, never its value:

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | inlined at build; must be the production ref |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | production only — never in preview |
| `CRON_SECRET` | yes | unset ⇒ `/api/jobs/run` answers 503 |
| `NEXT_PUBLIC_APP_URL` | yes | https, non-localhost; inlined at build |

> The five env vars set during CLI provisioning went to a **different** Vercel
> project (`buss-enhancer/agencyos`, an orphan). They do **not** count for the
> owner's `agency-os5/agency-os` deployment. Set them on the owner's project.

### 3. Create the scheduler → Lambda (AWS)

Owner's AWS account and region; both are `<PLACEHOLDER>` here on purpose.

The Lambda does one thing — POST the endpoint with both headers. It reads the
two secrets and the domain from its **own environment**, never from code:

```js
// handler.mjs — the entire function. No queue, no state, no job logic here.
export const handler = async () => {
  const res = await fetch(`${process.env.PROD_URL}/api/jobs/run`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    },
  });
  // A tick that could not even reach the runner must be loud, not swallowed.
  if (!res.ok) throw new Error(`tick failed: ${res.status}`);
  return { status: res.status };
};
```

Lambda environment variables (set from the owner's secret store — see below):

| Lambda env var | Source |
|---|---|
| `PROD_URL` | `https://<PROD_DOMAIN>` |
| `CRON_SECRET` | the same value as the Vercel `CRON_SECRET` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | the token from step 1 |

Wire the clock (illustrative CLI — `<AWS_ACCOUNT>`, `<AWS_REGION>`,
`<LAMBDA_ARN>`, `<ROLE_ARN>` are the owner's):

```bash
# One per-minute schedule that invokes the Lambda. This is the ONLY scheduler.
aws scheduler create-schedule \
  --name agencyos-cron-tick \
  --region <AWS_REGION> \
  --schedule-expression 'rate(1 minute)' \
  --flexible-time-window '{"Mode":"OFF"}' \
  --target '{"Arn":"<LAMBDA_ARN>","RoleArn":"<ROLE_ARN>"}'
```

> A failed invocation should be observable: give the schedule a dead-letter
> target or rely on the Lambda's error metric + a CloudWatch alarm, so a clock
> that stops firing is noticed. The engine already surfaces a *stale heartbeat*
> from the app side (`core.cron_heartbeat`, shown on `/operations` and in
> `/api/health`); the AWS-side alarm covers the case where the clock itself
> dies.

---

## Where the secrets live — and the rules

Three secrets are involved. **None** of them belongs in this repository, in a
commit, in a log line, in source code, or in a chat/issue/PR:

| Secret | Lives in | Also needed by |
|---|---|---|
| `CRON_SECRET` | Vercel Production env (owner's project) **and** the owner's AWS secret store (for the Lambda) | the Lambda, to authenticate the tick |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | injected by Vercel into the deployment; copied into the owner's AWS secret store | the Lambda, to pass Deployment Protection |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel Production env only | the app runtime only — **never** the Lambda |

Rules, without exception:

- **Never commit it.** `.gitignore` ignores `.env*`; the secret scan
  (`npm run scan:secrets`, CI-gated) fails the build if a known secret shape is
  committed.
- **Never print it.** Not in a Lambda log, not in a smoke line, not in a PR
  description. The route, `cron-auth.ts`, and the smoke script all treat these
  as opaque and echo none of them.
- **Never put it in source code.** The Lambda reads them from its environment;
  the app reads them from `serverEnv()`. A literal in code is a leak.
- **Store it only as a secret.** In AWS, that means Secrets Manager or SSM
  Parameter Store (SecureString) wired into the Lambda's environment — not a
  plaintext env value typed into a console field that ends up in a template.

---

## Verification checklist — prove the chain, do not assume it

Run top to bottom **after** the owner completes setup. Each step is a single
`curl` or command; none needs a secret printed. `<PROD_DOMAIN>`, `<TOKEN>`
(the bypass token) and `<CRON_SECRET>` are the owner's; substitute at the shell,
do not paste them into anything durable.

- [ ] **Vercel Protection Bypass enabled.** Without the token, the wall is up:
      ```bash
      curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<PROD_DOMAIN>/api/health
      ```
      Expect `302 …vercel.com/sso-api…` — proof the deployment *is* protected.

- [ ] **Cron endpoint reachable by the automation (bypass works).** With the
      bypass token but no app auth, the request reaches the *app*, which then
      refuses it on its own terms:
      ```bash
      curl -s -o /dev/null -w '%{http_code}\n' \
        -X POST https://<PROD_DOMAIN>/api/jobs/run \
        -H 'x-vercel-protection-bypass: <TOKEN>'
      ```
      Expect **`401`** (reached the runner, refused for lack of a bearer) — **not**
      `302` (still walled) and **not** `503` (`CRON_SECRET` unset on the deploy).

- [ ] **Unauthorized request rejected.** A wrong bearer, past the wall, is still
      refused:
      ```bash
      curl -s -o /dev/null -w '%{http_code}\n' \
        -X POST https://<PROD_DOMAIN>/api/jobs/run \
        -H 'x-vercel-protection-bypass: <TOKEN>' \
        -H 'Authorization: Bearer wrong-secret'
      ```
      Expect **`401`**.

- [ ] **Authorized automation request accepted.** Both doors, correct:
      ```bash
      curl -s -w '\n%{http_code}\n' \
        -X POST https://<PROD_DOMAIN>/api/jobs/run \
        -H 'x-vercel-protection-bypass: <TOKEN>' \
        -H 'Authorization: Bearer <CRON_SECRET>'
      ```
      Expect **`200`** and a JSON body (`{"claimed":0,...}` on an empty queue).

- [ ] **The existing job runner executes.** Prove work actually moves, not just
      that the endpoint answers: with a job queued, a `core.jobs` row leaves
      `queued`, or `core.cron_heartbeat` advances to a fresh stamp
      (`/operations` shows it; `/api/health` reports its age). Or run the
      automated rows in one command, past the wall:
      ```bash
      VERCEL_AUTOMATION_BYPASS_SECRET=<TOKEN> CRON_SECRET=<CRON_SECRET> \
        npm run smoke -- https://<PROD_DOMAIN>
      ```
      (smoke now sends the bypass header when the token is in the environment,
      and fails loudly if the wall is still up.)

- [ ] **Duplicate cron ticks remain idempotent.** Fire the authorized POST twice
      in quick succession; the second must not double-run a job. The runner
      claims at most one job per tick under a row lock — `db:verify:claims` and
      `db:verify:reaper` prove this property against a real Postgres; the live
      double-POST is the production confirmation.

- [ ] **Failures are observable.** Confirm the AWS-side alarm (Lambda error /
      DLQ) fires when the clock cannot reach the runner, **and** that a stale
      heartbeat surfaces app-side on `/operations`. A silent scheduler must be
      distinguishable from a quiet one.

---

## What is still owner-blocked (the smallest exact asks)

Claude has completed every repository-side part of this. The remaining steps
need values or actions only the owner holds:

1. **Enable Protection Bypass for Automation** on `agency-os5/agency-os` and
   capture `VERCEL_AUTOMATION_BYPASS_SECRET` (step 1).
2. **Confirm the five Production env vars** are set on that project, not the
   orphan (step 2).
3. **Provide, at minimum, the production domain** so the scheduler and the
   verification checklist have a target — and stand up the EventBridge → Lambda
   clock (step 3) with the owner's AWS account/region and the two secrets.

Until step 1 exists, no external cron — and no external `/api/health` check —
can reach the app; every request 302s at the wall.
