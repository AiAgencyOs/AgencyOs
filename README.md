# AgencyOS

An AI-native operating system for a software agency: leads, sales, approvals,
projects, UI and prototype generation, development and QA workflow, finance, and
a client portal — in one application.

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS · Supabase (Postgres, Auth,
Storage, RLS) · Claude API · OpenAI (embeddings) · Vercel · GitHub

Architecture — including module boundaries, database design, agent design, and
the authorization model — is documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

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
| `npm run check` | Typecheck + lint (run before committing) |
| `npm run db:link` | Link the repo to a Supabase project |
| `npm run db:push` | Apply migrations to the linked project |
| `npm run db:types` | Regenerate `src/lib/db/types.ts` from the live schema |

## Layout

```
app/                Next.js routes — thin: auth, params, render
src/modules/        Business logic. One folder per bounded module.
src/lib/            Platform: db, env, errors, jobs, events, ai
src/ui/             Design system
supabase/migrations Forward-only SQL migrations
prompts/            Versioned AI prompt files
docs/               Architecture decisions and reference
```

Module boundaries are enforced by ESLint, not convention — `npm run lint` fails
on a cross-module import that bypasses a module's public surface.

## Build status

Implemented: project foundation and Supabase integration.
Next: database schema, then authentication, Lead CRM, owner dashboard, AI
requirement collection, and WhatsApp integration.
