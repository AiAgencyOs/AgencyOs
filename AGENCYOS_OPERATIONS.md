# AGENCYOS_OPERATIONS.md

How AgencyOS is run, verified and deployed.

**Baseline:** commit `2881caa`, 2026-08-11.

Sections marked **UNDECIDED** are blocked on an Admin decision and are recorded
as such rather than filled with a plausible guess.

---

## 1. Environments

| Environment | Status |
| --- | --- |
| Local | Supabase CLI (Docker) + `next dev`. Working. |
| Verification | A separate local database, isolated from the developer's own — `.env.verify.local`, `npm run verify:dev`. Working. |
| Preview | Vercel preview deployments. Not configured. |
| Production | Vercel + hosted Supabase. **UNDECIDED — ADM-20.** |

The verification/local split exists because of finding #1 (PR #1): verification
scripts were capable of running against whichever database happened to be
configured. `scripts/verify-target.mjs` now makes each script run against the
database it names, and refuses otherwise.

---

## 2. Local setup

```bash
npm install
```

```bash
npm run verify:db:up
```

`supabase start && supabase db reset` — starts Docker services and applies all 26
migrations plus `seed.sql` from scratch.

```bash
npm run verify:dev
```

Loads `.env.verify.local` and starts Next against the verification database.

Stop with `npm run verify:db:down`.

---

## 3. Checks

### 3.1 The local gate

```bash
npm run check
```

`typecheck && lint && test`. At the baseline commit: **549 tests, 94 suites, 0
failures**, roughly 2.8 seconds.

**Nothing runs this automatically. There is no CI** (gap G-050). Every claim that
something is tested currently rests on a human having run this command.

### 3.2 Live verification against a real database

Unit and integration tests exercise decisions. These exercise the database.

| Command | Verifies |
| --- | --- |
| `npm run db:verify` | Schema, RLS, policies present as expected |
| `npm run db:verify:billing` | Milestone → invoice → payment, including concurrency |
| `npm run db:verify:unlock` | `invoice.paid` → next milestone |
| `npm run db:verify:reaper` | Stalled jobs recovered |
| `npm run db:verify:ingest` | WhatsApp ingest, idempotency, seq allocation |
| `npm run db:verify:webhook` | Signature verification and route behaviour |
| `npm run db:verify:proposal` | Requirement proposal lifecycle and uniqueness |

Each refuses to run against a database it was not pointed at.

### 3.3 Database types

```bash
npm run db:types
```

Regenerates `src/lib/db/types.ts` from the linked project. Run after every
migration that changes a table.

---

## 4. Migrations

Named `YYYYMMDDHHmmss_description.sql`, applied in filename order, forward-only.

Conventions the existing 26 follow:

- A header comment stating **what business rule** the migration encodes and
  **why**, not what the SQL does.
- `create ... if not exists` and `drop ... if exists` so re-application is safe.
- `set search_path = ''` on every function.
- RLS enabled and policies written in the same migration as the table.
- A migration that changes no schema says so explicitly (see
  `20260811120003_manual_payment_serialized.sql`).

```bash
npm run db:push
```

**There is no rollback procedure.** UNDECIDED — ADM-20. Forward-only migrations
plus a restore plan is the usual answer; the restore plan does not exist yet.

---

## 5. Scheduled work

`vercel.json` defines one cron:

```json
{ "path": "/api/jobs/run", "schedule": "* * * * *" }
```

Vercel issues cron invocations as **GET**; the route exports a GET that forwards
verbatim to POST, so there is exactly one implementation and the same
`Authorization: Bearer <CRON_SECRET>` check applies to both.

With `CRON_SECRET` unset the route answers **503 — disabled**, not 200. A
deployment that has not configured the runner is inert rather than open.

Each tick: reap → dispatch outbox → drain up to 10 milestone unlocks → claim one
extraction job. See `AGENCYOS_AUTOMATION.md` §4 for why that order.

---

## 6. Deployment

**UNDECIDED — ADM-20.** The intended shape, from directive §41, is:

```
code → test → PR → CI → preview → Admin approval → merge
     → migration → production → smoke test → live verification → close
```

Of that chain, `code`, `test` (manually), `PR`, `merge` and `migration` exist.
CI, preview, smoke tests and the production environment itself do not.

Required before a first production deployment:

- [ ] Production Supabase project (ADM-20)
- [ ] Vercel project and environment variables (ADM-20)
- [ ] `CRON_SECRET`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, AI provider key set
- [ ] CI green on every check (G-050)
- [ ] Secret scan in CI (G-051)
- [ ] Rollback/restore procedure written
- [ ] Smoke tests defined
- [ ] Monitoring and alerting (G-053, ADM-21)

---

## 7. Observability

**Today:** structured JSON to stdout via `console.error`, with a `scope` field
and the underlying message. Vercel captures it. Nothing aggregates, queries or
alerts on it.

**Missing** (G-053, ADM-21): error aggregation, alerting, job-queue health
metrics, AI cost monitoring against `ai.cost_ledger`, and dead-letter visibility.

### Dead letters

A job that exhausts `max_attempts` parks as `status = 'dead'` with `last_error`
recorded. That is correct behaviour and it is invisible — nothing surfaces it
(G-058). Until an operational view exists, the manual check is:

```sql
select kind, count(*), max(updated_at) from core.jobs where status = 'dead' group by kind;
```

---

## 8. Runbooks

### 8.1 A payment was recorded but the invoice looks wrong

1. `finance.payments` is the ledger; `invoices.paid_minor` is a cached sum. Trust
   the rows.
2. Sum captured payments for the invoice and compare with `paid_minor`.
3. If they disagree, the reconcile after the payment failed. The payment itself
   is safe — reconciliation recomputes from the rows rather than incrementing, so
   re-running it lands on the same number.
4. **Known cause:** G-003. A failed ledger read is currently treated as zero, so
   a transient database error can write `paid_minor = 0`. Check the logs for
   `scope: "capturedTotal"`.

### 8.2 An invoice is void but has payments against it

This should no longer be reachable. `finance.void_invoice()` sums the captured
payments under a lock on the invoice and refuses when it finds any, so a void
cannot commit over a receipt and a receipt cannot commit under a void
(`record_manual_payment` refuses a void invoice as `not_payable`).

If you find one anyway, it predates that fix or arrived by a path that does not
go through either function — a hand-written PATCH, or a future gateway writing
`finance.payments` directly. Do not repair the row by hand without recording what
happened: the payment row is the evidence, and the invoice is the thing that is
wrong. Check first whether the milestone was billed a second time —
`invoices_milestone_live_key` excludes void rows, so the slot was freed.

### 8.3 A requirement extraction is not producing a proposal

1. `core.jobs` where `kind = 'requirement.extract'` — is it `queued`, `running`,
   `dead`? Read `last_error`.
2. `ai.agent_runs` for the conversation — `status` and `error`.
3. `ai.agents` — is `requirement_collector` `enabled`, and is a provider
   configured? An unconfigured provider fails honestly rather than producing an
   empty result.
4. `crm.requirement_versions` — a `failed` version means the attempts are spent
   and the failure is permanent.

### 8.4 Jobs are stuck in `running`

The reaper releases them on the next tick, threshold in `src/lib/jobs/staleness.ts`.
If they are not being released, cron is not running: check the Vercel cron log
and that `CRON_SECRET` is set (an unset secret makes the route answer 503).

### 8.5 The webhook is rejecting deliveries

- `401` — signature mismatch. `WHATSAPP_APP_SECRET` is wrong.
- `403` — subscription handshake. `WHATSAPP_VERIFY_TOKEN` is wrong.
- `503` — nothing is configured.
- `200` with a `rejected` count — the message arrived and was refused by
  validation. The reason is logged with the failing fields; **the body is never
  logged.**

---

## 9. Working agreement

From directive §48. The lifecycle for every finding:

```
discover → investigate → reproduce → establish the business rule
  → Admin decision if the rule is missing → implement the smallest correct change
  → behavioural test → regression test → live verification → security scan
  → diff audit → PR → Admin merge approval → merge → deploy
  → post-merge verification → close
```

**Stop at approval gates. Do not stop between ordinary steps.**

The gates are: a missing product rule, and merge. Everything between is ordinary
authorized development.

### Branch and PR conventions

One finding per branch, `fix/<slug>` or `feat/<slug>`. Commit subjects are
`type(scope): imperative summary`. A PR states the finding, the reproduction, the
rule applied, what changed, and how it was verified.

**A PR is not merged without explicit Admin approval.** Absence of a response is
never approval.
