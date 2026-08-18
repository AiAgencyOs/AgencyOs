# AgencyOS external cron — AWS EventBridge Scheduler → Lambda

This is the **AWS half** of the engine's heartbeat. The app's job runner is a plain
external trigger — `POST /api/jobs/run` every minute — and this stack is one way to drive
it. The full contract, the two auth doors, and the verification checklist live in
[`docs/deployment/cron-external-trigger.md`](../../../docs/deployment/cron-external-trigger.md);
this directory is the deployable implementation of the AWS driver it describes.

```
EventBridge Scheduler  ──rate(1 minute)──▶  Lambda (handler.mjs)
                                              │  reads PROD_URL / CRON_SECRET /
                                              │  VERCEL_AUTOMATION_BYPASS_SECRET
                                              │  from Secrets Manager at runtime
                                              ▼
   POST https://<prod-domain>/api/jobs/run
     Authorization:              Bearer <CRON_SECRET>              ← app auth (door 2)
     x-vercel-protection-bypass: <VERCEL_AUTOMATION_BYPASS_SECRET> ← edge bypass (door 1)
                                              ▼
   existing AgencyOS job runner ──▶ existing outbox / worker system
```

**It is only a clock.** It creates no queue, no state, no second runner — all claiming,
retrying, idempotency and ordering already live in `/api/jobs/run` and the `core.jobs` /
`core.outbox_events` tables. A missed minute is caught up by the next tick.

## Files

| File | What it is |
|---|---|
| `handler.mjs` | The Lambda. `buildTickRequest` is pure and unit-tested (`tests/cron-lambda-handler.test.ts`); the handler reads the secret at runtime and POSTs. |
| `template.yaml` | CloudFormation: the Lambda, its least-privilege role, the Secrets Manager secret, the **disabled** `rate(1 minute)` schedule, a dead-letter queue, and an error alarm. |
| `deploy.sh` | `aws cloudformation deploy` + installs `handler.mjs` into the function (so the deployed code is exactly the reviewed file). |

## Safety model — ships inert

Deploying changes **nothing** about production:

- The **schedule is `DISABLED`**. It never invokes the Lambda until someone enables it.
- The **secret holds placeholders** (`{"PROD_URL":"","CRON_SECRET":"","VERCEL_AUTOMATION_BYPASS_SECRET":""}`).
  With an empty `PROD_URL`/`CRON_SECRET` the handler throws rather than POSTing anywhere.

So there is no window in which this fires against a wrong or missing endpoint.

## Deploy (repository-side, no secrets)

```bash
AWS_REGION=ap-south-1 infra/aws/cron/deploy.sh
```

This stands the stack up in the current AWS account. Secret **values** are never passed
here — they go in as a separate owner step below.

## Owner steps to go live (needs the three secret values)

These require values only the owner holds — the production domain, the deployment's
`CRON_SECRET`, and the Vercel **Protection Bypass for Automation** token
(Vercel → the `agency-os/agency-os` project → Settings → Deployment Protection).

1. **Populate the secret** (do this where the shell history is not logged):
   ```bash
   aws secretsmanager put-secret-value --region ap-south-1 \
     --secret-id agencyos-cron-config \
     --secret-string '{"PROD_URL":"https://<prod-domain>","CRON_SECRET":"<value>","VERCEL_AUTOMATION_BYPASS_SECRET":"<token>"}'
   ```
2. **Enable the schedule** (see `deploy.sh`'s printed command, or the console).

## Verification checklist (the AWS-side of Phase 3)

Runs against the real deployment, so it needs the values above. Full curl forms are in
[`cron-external-trigger.md`](../../../docs/deployment/cron-external-trigger.md#verification-checklist--prove-the-chain-do-not-assume-it).

- [ ] **Unauthorized rejected** — `POST /api/jobs/run` with the bypass header but no bearer → **401** (reached the runner, refused).
- [ ] **SSO-bypass accepted** — the same with a *wrong* bearer still → **401** (not `302`: the bypass got it past the edge).
- [ ] **CRON_SECRET required + accepted** — with both correct → **200**.
- [ ] **One tick executes** — a `core.jobs` row leaves `queued`, or `core.cron_heartbeat` freshens (`/operations`).
- [ ] **Idempotent** — two ticks close together do not double-run a job (the runner claims at most one per tick under a row lock; `db:verify:claims` / `db:verify:reaper` prove the property).
- [ ] **Failures observable** — force a failure (disable the bypass); the `agencyos-cron-tick-errors` CloudWatch alarm trips and messages land on `agencyos-cron-dlq`.

Until the owner completes the two steps, the end-to-end tick **cannot** be proved from
here — the endpoint is behind Vercel Deployment Protection and this stack has no real
secret. That is the honest boundary, not a gap in the driver.

## Cost

Effectively free: one 128 MB Lambda for a few ms/min, one Secrets Manager `GetSecretValue`/min,
one schedule. All within or near the free tier; a handful of cents a month at most.

## Remove

```bash
aws cloudformation delete-stack --region ap-south-1 --stack-name agencyos-cron
```
