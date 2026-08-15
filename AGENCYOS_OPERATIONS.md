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
| Preview | Vercel preview deployments. **Configured** — the GitHub integration builds and comments on every PR. |
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

`supabase start && supabase db reset` — starts Docker services and applies every
migration plus `seed.sql` from scratch.

```bash
npm run verify:dev
```

Loads `.env.verify.local` and starts Next against the verification database.

Stop with `npm run verify:db:down`.

### 2.4 Exposed schemas — the step a migration cannot always take

A schema is reachable through the API only if it is named in
`pgrst.db_schemas` on the `authenticator` role. That list is what the dashboard
writes under **Project Settings → API → Exposed schemas**, and what
`supabase/config.toml` seeds locally. **Creating a schema in a migration does
not add it**, and the failure mode is silent until something calls it:

```
{"code":"PGRST106","message":"Invalid schema: approvals"}
```

Every call, 406, with the tables sitting there correctly built. This was found
by running `npm run db:verify:approvals`, not by reading the migration.

`20260812120011_approval_engine.sql` therefore appends itself to that list —
additively, so it can never drop a schema somebody else added, and idempotently,
so re-running changes nothing. If the deploying role lacks the grant it raises a
warning and continues rather than failing the deploy, and then **the dashboard
toggle is the fix**: add the schema there and the next request picks it up.

After changing that setting by hand, PostgREST needs to reload:

```sql
notify pgrst, 'reload config';
```

Locally the setting lives in the database, so it survives `db reset` and even
`supabase stop` with a backup. Restarting the containers does **not** re-read
`config.toml` into it — only a fresh volume does, or the migration above.

What is still open is the general case: nothing checks that every schema a
module reads is actually exposed, so the next new schema hits this again. That
is **G-097**.

---

## 3. Checks

### 3.1 The local gate

```bash
npm run check
```

`typecheck && lint && test && scan:secrets`. **895 tests, 0 failures**, a few
seconds.

**CI runs all of it on every pull request** — `.github/workflows/verify.yml`.
Two jobs: `check` (typecheck, lint, tests, secret scan, production build) and
`database` (starts Postgres, applies all 36 migrations from scratch, runs all
eight live verification scripts against it, four of them through a running
production build of the app).

`npm run check` is the same gate minus the database half, and is what to run
before pushing.

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

Conventions the existing 25 follow:

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

### Rollback — ADM-20, taken by delegation 2026-08-13

**Migrations are forward-only. There is no `down`, and there will not be one.**
A reverse migration is written when nothing is wrong and run when everything
is, against data the original author never saw — which is how a bad afternoon
becomes a lost week.

What to do instead, in order:

1. **Fix forward.** A new migration that corrects the last one is the normal
   answer, and it is the only one that is tested by CI before it runs.
2. **If data is already wrong**, use Supabase point-in-time restore (Dashboard
   → Database → Backups). Note the timestamp *before* the bad migration ran —
   `supabase migration list --linked` gives it — and restore to a moment
   before it.
3. **If the deployment is wrong rather than the data**, roll the Vercel
   deployment back. The application and the schema are versioned separately on
   purpose: the app tolerates a schema ahead of it far better than behind it,
   which is why migrations are pushed before the app that needs them.

**The gap this leaves, stated rather than hidden:** point-in-time restore is a
whole-database operation. It cannot restore one table without also rewinding
every other write in that window, so between a bad migration and its discovery
there is a real trade between losing the damage and losing the good work
beside it. The smaller the window, the smaller the trade — which is the real
argument for pushing migrations promptly rather than in batches of twenty-two.

Taken under delegation, and reversible: if the agency wants reverse migrations,
this section is where that decision lands.

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

Of that chain, `code`, `test`, `PR`, `CI`, `preview` and `merge` exist. Smoke
tests and the production environment itself do not.

**The test suite needs Node 26; the app does not.** On Node 22 the suite's
`mock.module` calls fail with *"does not provide an export named
createClient"* and six test files do not load. CI pins 26 for that reason.
`engines.node` stays at `>=20`, because it describes the *runtime* — Vercel
builds against it, and the app has always run there. Conflating the two broke
a deployment once; the two constraints are separate and are recorded
separately.

Required before a first production deployment (the authoritative,
evidence-cited version of this list is [`docs/deployment/production-readiness.md`](docs/deployment/production-readiness.md)):

- [ ] Production Supabase project (ADM-20)
- [ ] Vercel project and environment variables (ADM-20)
- [ ] `CRON_SECRET`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, AI provider key set — **validated by** `npm run config:doctor -- --production` (reports missing/unsafe values by name, never printing them) and re-checked at server startup by `src/instrumentation.ts`, which refuses to boot an incomplete production configuration
- [x] CI green on every check (G-050)
- [x] Secret scan in CI (G-051)
- [x] Rollback/restore procedure written — runbook *Rollback* section; the local rehearsal is scripted (`npm run db:rehearse:restore`) and runs in CI. The runbook's **staging** rehearsal box stays unticked (needs ADM-60)
- [x] Smoke tests defined — `npm run smoke [-- <url>]` (scripts/smoke.mjs) executes the post-deploy rows that need no human against any deployment, fails rather than assume the database fingerprint, and runs in CI against the built app; the manual rows (real-user sign-in, cross-org RLS, a job leaving `queued`) and `db:verify:definitions` stay in the runbook
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

This should no longer be reachable. Since G-008 the invoice's `paid_minor`,
`status` and `paid_at` are written by the same statement that inserts the
payment, under the same lock — so the cache cannot lag the ledger, and there is
no second write that can fail after the money has landed.

If you find a disagreement anyway, `finance.payments` is the ledger and
`invoices.paid_minor` is a cached sum of it: trust the rows. A mismatch means
something wrote the invoice outside `finance.record_manual_payment` — a
hand-written UPDATE, or a future gateway writing payments directly. Record what
you find and why before changing anything.

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
