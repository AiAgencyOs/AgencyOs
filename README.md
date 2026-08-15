# AgencyOS

An AI-native operating system for a software agency: leads, sales, approvals,
projects, UI and prototype generation, development and QA workflow, finance, and
a client portal — in one application.

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS · Supabase (Postgres, Auth,
Storage, RLS) · Claude API · OpenAI (embeddings) · Vercel · GitHub

## Documentation

| Document | What it covers |
| --- | --- |
| [AGENCYOS_MASTER_DEVELOPMENT_PLAN.md](./AGENCYOS_MASTER_DEVELOPMENT_PLAN.md) | **Start here.** Baseline, gap matrix, decisions pending, phase order |
| [AGENCYOS_ARCHITECTURE.md](./AGENCYOS_ARCHITECTURE.md) | The architecture as built, and its delta against the V1 design |
| [AGENCYOS_DOMAIN_MODEL.md](./AGENCYOS_DOMAIN_MODEL.md) | Entities, state machines, invariants, and where each is enforced |
| [AGENCYOS_AUTOMATION.md](./AGENCYOS_AUTOMATION.md) | Jobs, events, agents, trust levels |
| [AGENCYOS_SECURITY.md](./AGENCYOS_SECURITY.md) | Auth, RLS, tenancy, service-role call sites, secrets |
| [AGENCYOS_OPERATIONS.md](./AGENCYOS_OPERATIONS.md) | Environments, checks, migrations, runbooks |
| [AGENCYOS_APPROVAL_POLICY.md](./AGENCYOS_APPROVAL_POLICY.md) | What requires approval, and where it is enforced |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | The original V1 design. Roughly half of it is built — see the delta document above |
| [docs/roadmap/roadmap.json](./docs/roadmap/roadmap.json) | The same gap matrix and roadmap, machine-readable |

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill in your Supabase values
npm run dev
```

Open <http://localhost:3000>, and check <http://localhost:3000/api/health> to
confirm the app can reach Postgres and Auth. It returns `200 ok` when both are
healthy and `503 degraded` otherwise, with a per-dependency breakdown.

You'll need a Supabase project (region `ap-south-1`). The three values to copy
from **Project Settings → API** are documented inline in `.env.example`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run check` | Typecheck + lint + tests + secret scan + record check (run before committing) |
| `npm run verify:db:up` | Start Supabase locally and apply every migration from scratch |
| `npm run db:verify*` | Live verification against a real database — see [AGENCYOS_OPERATIONS.md](./AGENCYOS_OPERATIONS.md) §3.2 |
| `npm run db:link` | Link the repo to a Supabase project |
| `npm run db:push` | Apply migrations to the linked project — **the only supported way to build the schema.** `supabase/_bundle.sql` is a marked historical snapshot, not an install path (ADM-40) |
| `npm run db:types` | Regenerate `src/lib/db/types.ts` from the live schema |

## Layout

```
app/                Next.js routes — thin: auth, params, render
src/modules/        Business logic. One folder per bounded module.
src/lib/            Platform: db, env, errors, jobs, events, ai
supabase/migrations Forward-only SQL migrations
tests/              node:test suites
scripts/            Live verification against a real database
docs/               Reference and history
```

Module boundaries are enforced by ESLint, not convention — `npm run lint` fails
on a cross-module import that bypasses a module's public surface.

## Build status

Working end to end: authentication and route guards · inbound WhatsApp capture →
lead → AI requirement extraction → human approval · payment plans → milestone
invoicing → manual payment → next milestone unlocked.

Not built yet: design and prototype phases, development and QA tracking,
handover, and client success. The approval engine exists as of ADM-08 — one
table for every decision a human owes, internal or client — but nothing calls
it yet and no queue displays it. CI now runs every check on every pull
request — typecheck, lint, the full suite, a secret scan, a production build,
every migration applied from scratch, and eight live verification scripts against
a real Postgres.

The complete picture — 127 gaps, what each blocks, and what needs an Admin
decision — is in
[AGENCYOS_MASTER_DEVELOPMENT_PLAN.md](./AGENCYOS_MASTER_DEVELOPMENT_PLAN.md).
