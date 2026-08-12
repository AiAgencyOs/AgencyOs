# ARCHITECTURE.md — AgencyOS V1

**Status:** Draft for approval
**Scope:** V1 only
**Date:** 2026-08-07
**Supersedes:** the microservices framing in `README.md` (see §0.3)
**Companion:** `PROJECT_UNDERSTANDING.md`

---

## 0. Scope, Constraints, and Assumptions

### 0.1 Fixed constraints (given)

| Constraint | Implication |
|---|---|
| **Solo founder** | Every architectural choice optimizes for *one person shipping and operating this*. No component may require ongoing ops attention. |
| **Modular monolith** | One deployable. Module boundaries are enforced by tooling, not by the network. |
| **Next.js + TypeScript + Tailwind** | One language end to end. App Router. No separate API server. |
| **Supabase** | Postgres + Auth + Storage + Realtime + RLS. RLS is the primary data-isolation boundary. |
| **OpenAI + Claude API** | Two providers with a **specific division of labour** (§6.4) — not redundancy. |
| **Vercel** | Serverless. No long-running processes. This is the single most shaping constraint in the document (§0.4). |
| **GitHub** | Source control **and** a product integration for the Development Workflow (§2.7). |
| **No microservices** | Confirmed and designed for. |

### 0.2 What V1 must support

Ten capabilities: Lead CRM · Sales AI Agent · Owner Approval System · Project Management · UI Generation · Prototype Generation · Development Workflow · QA Workflow · Finance & Invoicing · Client Portal.

Read as a single pipeline, these describe **an AI-native software agency**: leads arrive, an AI agent qualifies and proposes, the owner approves, a project is created, AI generates UI and a clickable prototype, the client approves the prototype, work becomes GitHub tickets, QA gates delivery, the client accepts, an invoice is issued and paid. Every section below serves that pipeline.

### 0.3 One thing this document changes

`README.md` says "modular microservices." This architecture is a **modular monolith** — as you instructed, and as `PROJECT_UNDERSTANDING.md §6.2` recommended. The `services/*` folders survive as **modules inside one Next.js app**, not as deployables. `README.md` should be corrected when this is approved.

### 0.4 The constraint that shapes everything: Vercel is serverless

There is no always-on process. No worker daemon, no in-memory queue, no `setInterval`. Vercel functions have a wall-clock ceiling that is **plan-dependent** (minutes, not hours) — confirm the exact limit for your plan before sizing any job.

This has one dominant consequence: **an AI agent run cannot be a single HTTP request.** A UI-generation agent producing eight screens will exceed any request budget. So the core runtime pattern of AgencyOS V1 is:

> **Every agent run is a durable, resumable, multi-step job stored in Postgres, advanced one step per function invocation, driven by Vercel Cron plus immediate self-dispatch.**

Get this right and everything else is ordinary web development. Get it wrong and you will fight timeouts for months. §6.3 specifies it precisely.

### 0.5 Assumptions I am making (flag if wrong)

1. **Tenancy: single-agency now, multi-tenant-ready by construction.** You didn't answer Q1 from `PROJECT_UNDERSTANDING.md`, and V1 for a solo founder does not need SaaS onboarding. So V1 runs **one organization — yours** — but **every table carries `org_id` and every RLS policy is written against it from migration 001**. Going multi-tenant later becomes a signup flow, not a rewrite. Cost today: one extra column and one predicate. Cost of skipping it: a full data-layer rewrite. **This is the single highest-leverage assumption in the document.**
2. **Payments: Razorpay**, inferred from `.env.example`. Your stack list omitted a payment provider, so §5.5 defines a provider-agnostic port with Razorpay as the V1 adapter. Swapping to Stripe touches one file.
3. **Clients are software clients.** UI Generation, Prototype Generation, Development Workflow, and QA Workflow only cohere if you build software for clients. GitHub is therefore both your SCM and a per-client-project integration.
4. **Mobile is out of V1 scope.** Not in your stack list. `apps/mobile/` stays empty.
5. **English + INR primary**, with currency stored in minor units and formatting deferred to the UI.

---

## 1. Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────────┐
│                    ONE NEXT.JS APP ON VERCEL                     │
│                                                                  │
│  ROUTE GROUPS (thin — auth, params, render)                      │
│  ┌────────────┬────────────┬─────────────┬────────────────────┐  │
│  │ (internal) │  (client)  │   (public)  │       /api         │  │
│  │ owner+admin│   portal   │ marketing,  │ webhooks · cron ·  │  │
│  │            │            │ prototypes  │ stream · v1 (ext)  │  │
│  └─────┬──────┴─────┬──────┴──────┬──────┴─────────┬──────────┘  │
│        │            │             │                │             │
│  ══════▼════════════▼═════════════▼════════════════▼═══════════  │
│  MODULES  (src/modules/* — the real code, boundary-enforced)     │
│  ┌──────────┬──────────┬──────────┬──────────┬───────────────┐   │
│  │ identity │   crm    │  sales   │ projects │   approvals   │   │
│  ├──────────┼──────────┼──────────┼──────────┼───────────────┤   │
│  │  build   │    qa    │ finance  │  files   │ notifications │   │
│  ├──────────┴──────────┴──────────┴──────────┴───────────────┤   │
│  │            agents  (AI orchestration — sole key holder)   │   │
│  └───────────────────────────────────────────────────────────┘   │
│  ══════════════════════════════════════════════════════════════  │
│  PLATFORM  (src/lib/* — db · authz · jobs · events · ai · audit)  │
└───────┬──────────────────┬───────────────────┬───────────────────┘
        │                  │                   │
┌───────▼────────┐  ┌──────▼───────┐  ┌────────▼─────────────────┐
│   SUPABASE     │  │ VERCEL CRON  │  │ EXTERNAL                 │
│ Postgres + RLS │  │  every 1 min │  │ Claude · OpenAI          │
│ Auth · Storage │  │ drains jobs  │  │ Razorpay · GitHub App    │
│ Realtime       │  │  + outbox    │  │ Resend · WhatsApp (opt)  │
└────────────────┘  └──────────────┘  └──────────────────────────┘
```

**Four rules that make this work:**

1. **Routes are thin.** A route file authenticates, validates, calls one module service, and renders. No business logic above `src/modules/`.
2. **Modules own their tables.** No module writes another module's schema. Enforced by Postgres `GRANT`s, not convention.
3. **Nothing slow happens in a request.** LLM calls, webhooks out, file processing, GitHub sync — all become jobs.
4. **Nothing important happens without an audit row.** Every gated transition writes to `core.audit_log`.

---

## 2. The Ten Capabilities → Module Map

| # | Capability | Primary module | Owns | Key AI agent |
|---|---|---|---|---|
| 1 | **Lead CRM** | `crm` | leads, contacts, activities, scores, pipeline stages | Lead Qualifier |
| 2 | **Sales AI Agent** | `sales` + `agents` | opportunities, proposals, quotes, line items | Proposal Drafter |
| 3 | **Owner Approval** | `approvals` | approval requests, steps, decisions, policies | *(none — humans only)* |
| 4 | **Project Management** | `projects` | projects, milestones, tasks, deliverables | Project Planner |
| 5 | **UI Generation** | `build` | brand kits, screens, screen specs, generations | UI Generator |
| 6 | **Prototype Generation** | `build` | prototypes, versions, flows, share links, feedback | Prototype Assembler |
| 7 | **Development Workflow** | `build` | dev tickets, repo links, PR/commit mirrors | Dev Planner |
| 8 | **QA Workflow** | `qa` | test cases, runs, results, defects, sign-offs | QA Author |
| 9 | **Finance & Invoicing** | `finance` | invoices, line items, payments, refunds, ledger | Finance Assistant |
| 10 | **Client Portal** | *(route group)* | — reads across modules via `visibility='client'` | *(none)* |

**Client Portal is deliberately not a module.** It is a route group with a hard RLS predicate. Giving it its own module would duplicate every read; giving it a visibility flag on shared tables means one source of truth and one place to get access control right.

**`approvals` has no agent, by design.** It is the control plane over the agents. An agent that could approve its own proposals would defeat the entire safety model.

---

## 3. Folder Architecture

### 3.1 The tree

```
agencyos/
├── app/                                  # Next.js App Router — THIN
│   ├── (public)/                         # marketing, login, prototype viewer
│   │   ├── page.tsx
│   │   └── p/[token]/page.tsx            # public prototype share link (§6.6)
│   ├── (auth)/                           # login, callback, invite accept
│   ├── (internal)/                       # owner + admin + staff
│   │   ├── layout.tsx                    # requires internal role
│   │   ├── dashboard/
│   │   ├── leads/[id]/
│   │   ├── proposals/[id]/
│   │   ├── projects/[id]/
│   │   │   ├── screens/                  # UI generation workspace
│   │   │   ├── prototype/
│   │   │   ├── tickets/
│   │   │   └── qa/
│   │   ├── approvals/                    # THE OWNER INBOX (§6.8)
│   │   ├── invoices/
│   │   └── agents/                       # agent runs, costs, traces, kill switches
│   ├── (client)/                         # client portal
│   │   ├── layout.tsx                    # requires client role + account scope
│   │   ├── projects/[id]/
│   │   ├── review/[deliverableId]/       # ← THE APPROVE BUTTON. Revenue starts here.
│   │   └── invoices/
│   └── api/
│       ├── webhooks/{razorpay,github,resend}/route.ts
│       ├── cron/{jobs,outbox,scheduled}/route.ts
│       ├── jobs/run/route.ts             # self-dispatch target (§6.3)
│       ├── ai/stream/route.ts            # interactive SSE only
│       └── v1/                           # external/public API (versioned)
│
├── src/
│   ├── modules/                          # ★ ALL BUSINESS LOGIC LIVES HERE
│   │   ├── identity/
│   │   ├── crm/
│   │   ├── sales/
│   │   ├── approvals/
│   │   ├── projects/
│   │   ├── build/
│   │   ├── qa/
│   │   ├── finance/
│   │   ├── files/
│   │   ├── notifications/
│   │   └── agents/
│   │
│   ├── lib/                              # platform, not domain
│   │   ├── db/          {client,admin,types}.ts   # generated Supabase types
│   │   ├── auth/        {session,claims,guards}.ts
│   │   ├── authz/       {roles,permissions,policy}.ts
│   │   ├── jobs/        {enqueue,runner,handlers}.ts
│   │   ├── events/      {publish,dispatch,catalog}.ts
│   │   ├── ai/          {claude,openai,router,cost,trace,schema}.ts
│   │   ├── audit/       log.ts
│   │   ├── integrations/{razorpay,github,resend,whatsapp}/
│   │   ├── errors.ts · result.ts · env.ts · action.ts
│   │
│   ├── ui/                               # design system (was packages/ui)
│   │   ├── primitives/                   # Button, Input, Dialog, Table…
│   │   ├── patterns/                     # ApprovalCard, MilestoneTimeline…
│   │   ├── renderer/                     # ★ trusted screen-spec renderer (§6.6)
│   │   └── tokens.ts
│   └── shared/                           # cross-module types + enums only
│
├── supabase/
│   ├── migrations/                       # 001_core.sql, 002_crm.sql, …
│   ├── seed.sql
│   └── config.toml
├── prompts/                              # ★ versioned prompt files (§6.5)
│   └── <agent>/<key>.v<N>.md
├── docs/                                 # existing docs + ADRs
├── scripts/                              # seed, migrate, eval, backfill
└── .github/workflows/                    # ci.yml, migrate.yml
```

### 3.2 Every module has the same six files

Non-negotiable. Consistency is what lets one person navigate eleven modules a year from now.

```
src/modules/<name>/
├── schema.ts      # Zod schemas — the ONLY input validation in the module
├── types.ts       # domain types (derive from Zod + generated DB types)
├── queries.ts     # READS. Pure. RLS-scoped client. Safe in Server Components.
├── service.ts     # WRITES + domain logic. The module's ONLY public surface.
├── actions.ts     # Server Actions — thin wrappers: auth → validate → service
├── events.ts      # events this module emits + handlers it subscribes to
└── policy.ts      # capability checks (the app-level half of §8)
```

**The one import rule, enforced by ESLint:**

```
✅  modules/*  →  lib/*, shared/*, ui/*
✅  modules/a  →  modules/b/service   (and modules/b/types)
❌  modules/a  →  modules/b/queries   (reaching into another module's data)
❌  modules/a  →  modules/b/actions
❌  lib/*      →  modules/*           (platform never depends on domain)
❌  app/*      →  anything but a module's actions/queries/types
```

```jsonc
// .eslintrc — the boundary is real only if a machine checks it
"no-restricted-imports": ["error", { "patterns": [
  { "group": ["@/modules/*/queries", "@/modules/*/actions", "@/modules/*/schema"],
    "message": "Cross-module access goes through service.ts only." },
  { "group": ["@/modules/*"], "message": "lib/ must not depend on modules/." }
]}]
```

### 3.3 What happens to the existing tree

| Existing | V1 fate |
|---|---|
| `apps/{owner,admin}-dashboard/` | → `app/(internal)/` route group. Merged: same users, same shell, role-gated navigation. Splitting them means two shells and two auth layers for one person to maintain. |
| `apps/client-portal/` | → `app/(client)/` route group |
| `apps/mobile/` | Deferred. Folder + README stay as a placeholder. |
| `services/*` | → `src/modules/*` (sales-service → `sales`, project-service → `projects`, approval-service → `approvals`, ai-orchestrator → `agents`) |
| `packages/ui` | → `src/ui/` |
| `packages/config` | → `src/lib/env.ts` (Zod-validated, fail-fast at boot) |
| `packages/shared` | → `src/shared/` |
| `prompts/`, `scripts/`, `docs/`, `automation/` | Stay. `automation/` becomes `.github/workflows/`. |

**No pnpm workspace, no Turborepo in V1.** One `package.json`. A workspace adds config surface with no benefit when there is one deployable and one developer. Revisit only when a second deployable exists (§11).

---

## 4. Database Architecture

### 4.1 Principles

1. **One Postgres.** Supabase-hosted.
2. **One schema per module.** Data ownership is enforced by `GRANT`, not by code review.
3. **`org_id` on every business table.** From migration 001, no exceptions.
4. **RLS on every table.** RLS is the security boundary; application code is defence in depth.
5. **Money in minor units** (`BIGINT` paise/cents) + ISO currency. Never `FLOAT`.
6. **Timestamps are `TIMESTAMPTZ`.** Always.
7. **Soft-delete only where recoverability matters** (leads, projects, documents). Everything else is hard-delete or immutable.

### 4.2 Schemas

| Schema | Owns |
|---|---|
| `core` | organizations, users, memberships, client_accounts, client_users, audit_log, jobs, outbox_events, settings |
| `crm` | leads, lead_activities, lead_scores, contacts |
| `sales` | opportunities, proposals, proposal_versions, quotes, quote_items |
| `approvals` | approval_policies, approval_requests, approval_steps, approval_decisions |
| `projects` | projects, milestones, tasks, deliverables, deliverable_versions, comments |
| `build` | brand_kits, screens, screen_specs, generations, prototypes, prototype_versions, prototype_feedback, dev_tickets, repo_links, ticket_sync |
| `qa` | test_cases, test_runs, test_results, defects |
| `finance` | invoices, invoice_items, payments, payment_events, refunds |
| `files` | documents, document_versions |
| `notify` | messages, templates, deliveries |
| `ai` | agents, agent_runs, agent_steps, tool_calls, prompt_versions, cost_ledger, evals |

**Tradeoff, stated honestly:** schemas cost you `.schema('crm')` on Supabase client calls and slightly more verbose SQL. They buy you per-module `GRANT`s (a real, enforced boundary), a clean extraction path (§11), and instant clarity about ownership. For a modular monolith that must *stay* modular under solo-founder time pressure, the machine-enforced boundary is worth the verbosity. If you'd rather not, the fallback is a single `public` schema with `crm_`/`proj_` table prefixes — same discipline, weaker enforcement.

### 4.3 Core tables

```sql
-- ── core ────────────────────────────────────────────────────────────
create table core.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- mirrors auth.users; RLS-visible profile data
create table core.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext not null,
  full_name text,
  avatar_url text,
  type text not null default 'human' check (type in ('human','agent')),
  created_at timestamptz not null default now()
);

create table core.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  user_id uuid not null references core.users(id) on delete cascade,
  role text not null check (role in
    ('owner','ops_admin','delivery_lead','member','contractor')),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create table core.client_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  name text not null,
  primary_contact_id uuid,
  billing_email citext,
  currency char(3) not null default 'INR',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- external portal users, scoped to one client account
create table core.client_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references core.organizations(id) on delete cascade,
  client_account_id uuid not null references core.client_accounts(id) on delete cascade,
  user_id uuid not null references core.users(id) on delete cascade,
  role text not null default 'client_member'
    check (role in ('client_admin','client_member')),
  unique (client_account_id, user_id)
);

-- append-only. no UPDATE, no DELETE, ever.
create table core.audit_log (
  id bigserial primary key,
  org_id uuid not null,
  actor_type text not null check (actor_type in ('user','agent','system','client')),
  actor_id uuid,
  action text not null,                    -- 'deliverable.approved'
  subject_type text not null,              -- 'deliverable'
  subject_id uuid not null,
  before jsonb, after jsonb,
  correlation_id uuid,
  ip inet, user_agent text,
  created_at timestamptz not null default now()
);
create index on core.audit_log (org_id, subject_type, subject_id, created_at desc);
```

### 4.4 The job queue (the heart of §0.4)

```sql
create table core.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null,                      -- 'agent.step' | 'webhook.deliver' | …
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','cancelled','dead')),
  priority smallint not null default 100,  -- lower runs first
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,                         -- idempotency
  correlation_id uuid,
  created_at timestamptz not null default now()
);
create unique index on core.jobs (dedupe_key) where dedupe_key is not null;
create index on core.jobs (status, run_at, priority) where status = 'queued';
```

**Claiming is atomic** — this is the one piece of SQL that must be exactly right, because it is the only thing preventing two concurrent Vercel invocations from running the same job twice:

```sql
create or replace function core.claim_jobs(
  p_worker_id text, p_kind text, p_batch_size int default 1
)
returns setof core.jobs language sql security definer set search_path = '' as $$
  update core.jobs j set
    status = 'running', locked_at = now(), locked_by = p_worker_id,
    attempts = j.attempts + 1
  where j.id in (
    select id from core.jobs
    where kind = p_kind                -- ← without this, one kind claims another
      and status = 'queued' and run_at <= now()
    order by priority, run_at
    limit p_batch_size
    for update skip locked             -- ← the critical clause
  )
  returning j.*;
$$;
```

`p_kind` was not in the original sketch, and its absence was a live trap until
G-082: the extraction path would have claimed `milestone.unlock` jobs and handed
a paid client's milestone to the AI extractor. The signature without it is
dropped rather than kept as an overload.

A caller must be able to settle every row it claims — hence the default of one,
which both call sites pass. An invocation killed part-way through a larger batch
strands the rest in `running` with their attempts already spent.

A companion reaper releases jobs whose `locked_at` is older than the function timeout (an invocation that died mid-run).

### 4.5 The transactional outbox

Events must publish *if and only if* the state change committed. Writing to a queue after commit loses events on crash; writing before commit publishes phantom events. The outbox pattern solves this by writing the event **in the same transaction** as the state change.

```sql
create table core.outbox_events (
  id bigserial primary key,
  org_id uuid not null,
  type text not null,                       -- 'deliverable.accepted'
  payload jsonb not null,
  subject_type text, subject_id uuid,
  correlation_id uuid,
  published_at timestamptz,                 -- null = not yet dispatched
  attempts int not null default 0,
  created_at timestamptz not null default now()
);
create index on core.outbox_events (published_at, id) where published_at is null;
```

### 4.6 Approvals — one polymorphic engine

This table is why `approvals` is a module and not a boolean column. **One abstraction serves proposals, deliverables, invoices, refunds, scope changes, and every AI agent action.**

```sql
create table approvals.approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  subject_type text not null check (subject_type in
    ('proposal','deliverable','invoice','refund','scope_change',
     'prototype','agent_action','ticket_plan')),
  subject_id uuid not null,
  policy_id uuid references approvals.approval_policies(id),
  requested_by_type text not null check (requested_by_type in ('user','agent','system')),
  requested_by_id uuid,                     -- ← agents are first-class requesters
  audience text not null default 'internal' check (audience in ('internal','client')),
  state text not null default 'pending' check (state in
    ('pending','approved','rejected','changes_requested','expired','cancelled')),
  summary text,
  payload jsonb,                            -- snapshot of what's being approved
  sla_due_at timestamptz,
  decided_at timestamptz, decided_by uuid, decision_note text,
  correlation_id uuid,
  created_at timestamptz not null default now()
);
create index on approvals.approval_requests (org_id, state, sla_due_at);
create index on approvals.approval_requests (subject_type, subject_id);
```

`audience` is what makes owner approval and client approval the same mechanism: `internal` renders in `/approvals`, `client` renders in the portal. `approval_policies` maps `(subject_type, condition)` → required role and SLA, so Ops can change "invoices over ₹5L need owner sign-off" without a deploy.

### 4.7 UI Generation and Prototypes — the security-critical design

**Generated UI is untrusted input. AgencyOS must never execute it.**

An AI agent writing React that your app then renders is arbitrary code execution with extra steps — a prompt-injected or simply hallucinated component could exfiltrate session tokens from any user viewing it. So V1 splits the artifact in two:

1. **`screen_spec` (JSON)** — a constrained, declarative description of a screen: layout nodes, component types drawn from a **whitelist in `src/ui/primitives`**, props, tokens, bindings. This is what the agent produces and what AgencyOS renders, through a **trusted renderer** you wrote (`src/ui/renderer/`). No `eval`, no `dangerouslySetInnerHTML`, no dynamic import. A malformed spec fails schema validation and renders nothing.
2. **`code_artifact` (React + Tailwind source)** — generated *from* the approved spec, stored in Supabase Storage, and handed to the Development Workflow. **AgencyOS never executes it.** It is output, delivered to a repo.

```sql
create table build.brand_kits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid references projects.projects(id) on delete cascade,
  tokens jsonb not null,        -- colors, type scale, spacing, radii
  created_at timestamptz not null default now()
);

create table build.screens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references projects.projects(id) on delete cascade,
  key text not null,            -- 'checkout', 'dashboard'
  name text not null,
  intent text,                  -- brief that drives generation
  status text not null default 'draft'
    check (status in ('draft','generated','approved','superseded')),
  current_spec_id uuid,
  unique (project_id, key)
);

create table build.screen_specs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  screen_id uuid not null references build.screens(id) on delete cascade,
  version int not null,
  spec jsonb not null,          -- ★ validated against the whitelist schema
  generation_id uuid references ai.agent_runs(id),
  code_artifact_path text,      -- Storage path — NEVER executed by AgencyOS
  created_at timestamptz not null default now(),
  unique (screen_id, version)
);

create table build.prototypes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references projects.projects(id) on delete cascade,
  name text not null,
  current_version_id uuid
);

create table build.prototype_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  prototype_id uuid not null references build.prototypes(id) on delete cascade,
  version int not null,
  screen_spec_ids uuid[] not null,
  flow jsonb not null,          -- nav graph: {from, hotspot, to}
  share_token text unique,      -- signed, expiring, revocable
  share_expires_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft','shared','approved','rejected','superseded')),
  unique (prototype_id, version)
);

create table build.prototype_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  prototype_version_id uuid not null references build.prototype_versions(id) on delete cascade,
  screen_id uuid,
  anchor jsonb,                 -- {x, y} pin on the screen
  body text not null,
  author_type text not null check (author_type in ('client','user')),
  author_id uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
```

### 4.8 Development and QA workflow

```sql
create table build.repo_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references projects.projects(id) on delete cascade,
  provider text not null default 'github',
  installation_id text not null,           -- GitHub App installation
  repo_full_name text not null,            -- 'acme/client-portal'
  default_branch text not null default 'main'
);

create table build.dev_tickets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references projects.projects(id) on delete cascade,
  milestone_id uuid references projects.milestones(id),
  screen_id uuid references build.screens(id),
  title text not null,
  body text,
  acceptance_criteria jsonb not null default '[]',
  estimate_hours numeric(5,2),
  status text not null default 'planned' check (status in
    ('planned','ready','in_progress','in_review','qa','done','blocked')),
  assignee_id uuid,
  external_issue_number int,               -- mirrored GitHub issue
  external_pr_number int,
  external_state text,
  synced_at timestamptz
);

create table qa.test_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  project_id uuid not null references projects.projects(id) on delete cascade,
  deliverable_id uuid references projects.deliverables(id),
  ticket_id uuid references build.dev_tickets(id),
  title text not null,
  steps jsonb not null,                    -- [{action, expected}]
  priority text not null default 'p2' check (priority in ('p0','p1','p2')),
  source text not null default 'ai' check (source in ('ai','human')),
  generation_id uuid references ai.agent_runs(id)
);

create table qa.test_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  deliverable_id uuid not null references projects.deliverables(id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  verdict text check (verdict in ('pass','fail','partial'))
);

create table qa.defects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  test_run_id uuid references qa.test_runs(id),
  ticket_id uuid references build.dev_tickets(id),
  severity text not null check (severity in ('blocker','major','minor','trivial')),
  title text not null, body text,
  status text not null default 'open' check (status in ('open','fixed','wontfix','verified'))
);
```

**The QA gate:** `projects.deliverables` cannot transition to `submitted_to_client` while an open `blocker` or `major` defect exists. Enforced in `qa.service.ts` and asserted by a database trigger — belt and braces on the path to client-visible work.

### 4.9 Finance

```sql
create table finance.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_account_id uuid not null references core.client_accounts(id),
  project_id uuid references projects.projects(id),
  milestone_id uuid references projects.milestones(id),  -- ← the money link
  number text not null,                    -- INV-2026-0001, per-org sequence
  status text not null default 'draft' check (status in
    ('draft','pending_approval','issued','partially_paid','paid','void','overdue')),
  currency char(3) not null default 'INR',
  subtotal_minor bigint not null default 0,
  tax_minor bigint not null default 0,     -- GST if India (§0.5)
  total_minor bigint not null default 0,
  paid_minor bigint not null default 0,
  issued_at timestamptz, due_at timestamptz, paid_at timestamptz,
  provider_ref text,
  unique (org_id, number)
);

create table finance.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  invoice_id uuid not null references finance.invoices(id),
  provider text not null default 'razorpay',
  provider_payment_id text not null,
  amount_minor bigint not null,
  currency char(3) not null,
  status text not null check (status in ('created','authorized','captured','failed','refunded')),
  captured_at timestamptz,
  unique (provider, provider_payment_id)   -- ← idempotency for webhook replays
);

-- raw webhook log — the reconciliation source of truth
create table finance.payment_events (
  id bigserial primary key,
  org_id uuid,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  raw jsonb not null,
  signature_verified boolean not null default false,
  processed_at timestamptz,
  unique (provider, provider_event_id)     -- ← replay protection
);
```

### 4.10 AI observability

```sql
create table ai.agents (
  key text primary key,                    -- 'lead_qualifier'
  display_name text not null,
  autonomy_level text not null check (autonomy_level in ('L0','L1','L2')),
  enabled boolean not null default true,   -- ← per-agent kill switch
  default_model text not null,
  max_steps int not null default 12,
  max_cost_minor bigint not null default 5000
);

create table ai.agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  agent_key text not null references ai.agents(key),
  trigger text not null,                   -- 'event:lead.created' | 'user:<id>'
  subject_type text, subject_id uuid,
  status text not null default 'queued' check (status in
    ('queued','running','awaiting_approval','succeeded','failed','cancelled','budget_exceeded')),
  input jsonb, output jsonb,
  prompt_key text, prompt_version text, prompt_hash text,   -- reproducibility
  model text,
  input_tokens int default 0, output_tokens int default 0,
  cache_read_tokens int default 0, cache_write_tokens int default 0,
  cost_minor bigint default 0,
  step_count int default 0,
  error text,
  correlation_id uuid,
  started_at timestamptz, finished_at timestamptz
);

create table ai.agent_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ai.agent_runs(id) on delete cascade,
  seq int not null,
  kind text not null check (kind in ('model_call','tool_call','validation','decision')),
  request jsonb, response jsonb,
  tokens_in int, tokens_out int, cost_minor bigint,
  latency_ms int,
  error text,
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create table ai.cost_ledger (
  id bigserial primary key,
  org_id uuid not null,
  day date not null,
  agent_key text not null,
  model text not null,
  runs int not null default 0,
  input_tokens bigint default 0, output_tokens bigint default 0,
  cost_minor bigint not null default 0,
  unique (org_id, day, agent_key, model)
);
```

### 4.11 Row Level Security

Every table gets RLS. Three predicate shapes cover everything:

```sql
alter table crm.leads enable row level security;

-- 1. INTERNAL: org members see their org's rows
create policy internal_read on crm.leads for select
  using (org_id = (auth.jwt() -> 'app_metadata' ->> 'org_id')::uuid
         and (auth.jwt() -> 'app_metadata' ->> 'role') in
             ('owner','ops_admin','delivery_lead','member'));

-- 2. CLIENT: portal users see only their account's client-visible rows
create policy client_read on projects.deliverables for select
  using (org_id = (auth.jwt() -> 'app_metadata' ->> 'org_id')::uuid
         and client_account_id = (auth.jwt() -> 'app_metadata' ->> 'client_account_id')::uuid
         and visibility = 'client');

-- 3. CONTRACTOR: only projects they're assigned to
create policy contractor_read on build.dev_tickets for select
  using (org_id = (auth.jwt() -> 'app_metadata' ->> 'org_id')::uuid
         and exists (select 1 from projects.project_members pm
                     where pm.project_id = dev_tickets.project_id
                       and pm.user_id = auth.uid()));

-- audit_log is append-only, enforced by the absence of policies
create policy audit_insert on core.audit_log for insert with check (true);
-- (no select policy for clients; no update/delete policy for anyone)
```

**A required CI test:** a suite that authenticates as org A and asserts every cross-org read returns zero rows. Without it, RLS regressions are invisible until they are a breach.

### 4.12 Migrations

Plain SQL in `supabase/migrations/`, numbered, forward-only. Applied by `supabase db push` from GitHub Actions on merge to `main`. Never edit a merged migration. Destructive changes go in two deploys: add-and-backfill, then drop.

---

## 5. API Architecture

### 5.1 Four surfaces, chosen deliberately

Next.js offers several ways to move data. Picking one per job — instead of building REST out of habit — removes an entire layer of code.

| Surface | Use for | Why |
|---|---|---|
| **Server Components** calling `queries.ts` | All internal reads | No API layer at all. Typed end to end. RLS applies via the user's JWT. |
| **Server Actions** calling `service.ts` | All mutations from your own UI | Typed, progressive-enhancement-friendly, no hand-written endpoint. |
| **Route Handlers** (`/api/*`) | Webhooks, cron, SSE, file signing | Things with no session or no browser. |
| **`/api/v1/*`** | External consumers | Versioned REST, API-key auth. Thin: it calls the same `service.ts`. |

**V1 does not build a REST API for its own UI.** That is the largest single reduction in code volume available to you, and it costs nothing — `/api/v1/` exists as the seam for when mobile or a customer integration needs it (§11).

### 5.2 Every mutation runs the same pipeline

```ts
// src/lib/action.ts — one wrapper, used by every Server Action
export function action<I extends z.ZodType, O>(cfg: {
  input: I;
  capability: Capability;            // §8
  handler: (input: z.infer<I>, ctx: Ctx) => Promise<O>;
  audit?: (input: z.infer<I>, out: O) => AuditEntry;
  revalidate?: string[];
}) { /* auth → validate → authorize → execute → audit → revalidate */ }
```

Fixed order, no exceptions:

```
1. authenticate      session or 401
2. validate          Zod parse or 422 with field errors
3. authorize         capability check or 403          ← §8
4. rate limit        per-user + per-org
5. execute           service.ts, inside a transaction
6. audit             core.audit_log (same transaction)
7. outbox            core.outbox_events (same transaction)  ← §9
8. commit
9. revalidate        Next.js cache tags
```

Steps 5–7 share one transaction. That is what makes "the state changed but the event was lost" structurally impossible.

### 5.3 Uniform result and error shapes

```ts
type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

type AppError = {
  code: 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND'
      | 'CONFLICT' | 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'INTERNAL';
  message: string;                    // safe to show a user
  details?: Record<string, string[]>; // field errors
  correlationId: string;              // ← ties UI error to logs and audit
};
```

Services return `Result<T>` and never throw for expected failures. Every response and log line carries `correlationId`, so a client saying "it broke" resolves to one trace.

### 5.4 Pagination and idempotency

- **Cursor pagination everywhere** (`?cursor=&limit=`, max 100), returning `{ items, nextCursor }`. Offset pagination breaks under concurrent inserts, which is exactly what a lead feed does.
- **Idempotency keys required** on every money-moving operation and every inbound webhook. Enforced by unique constraints (`payments.provider_payment_id`, `payment_events.provider_event_id`, `jobs.dedupe_key`) rather than application checks — the database is the only reliable arbiter under concurrency.

### 5.5 Integration ports

Each external service sits behind a narrow interface in `src/lib/integrations/`, so V1's provider choices are reversible.

```ts
interface PaymentProvider {
  createPaymentLink(i: { invoiceId; amountMinor; currency; customer }): Promise<{ url; ref }>;
  verifyWebhook(raw: string, sig: string): boolean;
  parseEvent(raw: unknown): PaymentEvent;
  refund(i: { paymentRef; amountMinor; reason }): Promise<RefundResult>;
}
// V1 adapter: razorpay.ts. Swapping to Stripe = one new file.
```

Same shape for `NotificationProvider` (Resend → email; WhatsApp optional) and `RepoProvider` (GitHub App).

### 5.6 Webhook handling — the one pattern all inbound integrations follow

```
POST /api/webhooks/razorpay
  1. read RAW body (never the parsed body — HMAC is over exact bytes)
  2. verify HMAC signature      → 401 on mismatch
  3. INSERT payment_events (provider, provider_event_id) ON CONFLICT DO NOTHING
       → conflict means replay; return 200 immediately
  4. enqueue job 'payment.process' with dedupe_key = provider_event_id
  5. return 200 in < 1s          ← providers retry on slow responses
```

Nothing is processed inline. The webhook's only job is to durably record and acknowledge; correctness lives in the job.

---

## 6. AI Agent Architecture

### 6.1 The rule everything else enforces

> **No AI agent may commit a state transition that (a) moves money, (b) creates a legal obligation, (c) sends communication to a client, or (d) alters an approved scope — without a recorded human approval.**

This is enforced **structurally**, not by prompt discipline. An agent's database role lacks `INSERT`/`UPDATE` on `finance.invoices`, `notify.messages`, and the approved-scope columns. If the prompt is injected, the model still cannot perform the action — the grant does not exist.

### 6.2 Agent registry

Agents are declarative config, not scattered code.

```ts
// src/modules/agents/registry.ts
export const AGENTS = {
  lead_qualifier: {
    autonomy: 'L2',                                   // §6.7
    model: 'claude-sonnet-5',
    effort: 'medium',
    outputSchema: LeadScoreSchema,                    // Zod → JSON Schema
    tools: ['crm.getLead', 'crm.searchSimilar', 'web.enrich'],
    maxSteps: 6,
    maxCostMinor: 500,                                // ₹5.00 per run
    promptKey: 'lead_qualifier/qualify',
  },
  proposal_drafter: {
    autonomy: 'L1',
    model: 'claude-opus-5',
    effort: 'high',
    outputSchema: ProposalDraftSchema,
    tools: ['crm.getLead','sales.getPricingRules','projects.getTemplates'],
    maxSteps: 12, maxCostMinor: 3000,
    promptKey: 'proposal_drafter/draft',
    requiresApproval: { subjectType: 'proposal', audience: 'internal' },
  },
  ui_generator: {
    autonomy: 'L1',
    model: 'claude-opus-5', effort: 'xhigh',
    outputSchema: ScreenSpecSchema,                   // ← whitelist-constrained
    tools: ['build.getBrandKit','build.listComponents','build.getScreenIntent'],
    maxSteps: 20, maxCostMinor: 8000,
    promptKey: 'ui_generator/screen',
  },
  // prototype_assembler · dev_planner · qa_author · finance_assistant
} as const satisfies Record<string, AgentDef>;
```

### 6.3 Run lifecycle — how agents survive serverless

This is §0.4 made concrete.

```
                enqueue                     ┌── each step is ONE invocation ──┐
event / user ──────────────▶ agent_runs ──▶ │ load run + steps from Postgres  │
                             status=queued  │ call model (streaming, capped)  │
                                            │ validate structured output      │
                                            │ execute at most one tool call   │
                                            │ persist step + tokens + cost    │
                                            │ if done → finalize              │
                                            │ else    → enqueue next step     │
                                            └─────────────────────────────────┘
                                                          │
              ┌───────────────────────────────────────────┤
              ▼                                           ▼
  status = awaiting_approval                       status = succeeded
  → approval_request created                       → outbox event emitted
  → owner/client decides                           → downstream modules react
```

Two drive mechanisms, belt and braces:

- **`GET /api/cron/jobs` every minute** (Vercel Cron) — claims a batch and fans out via `waitUntil` to `/api/jobs/run`. This is the safety net: if anything is stuck, it moves within 60 s.
- **Immediate self-dispatch** — after enqueuing, `after()`/`waitUntil` fires `/api/jobs/run` without blocking the response. This is the fast path: sub-second latency in practice, with cron as the guarantee.

**Every step is idempotent and resumable.** A killed invocation loses at most one step's work; the reaper unlocks the job and the next tick retries from the last persisted step.

**Interactive exception:** for a human watching a chat-style interaction, `POST /api/ai/stream` calls Claude with streaming and returns SSE directly — bounded, user-visible, cancellable. Everything else is a job.

### 6.4 Why both providers — a real division of labour

`.env.example` carries both keys. Here is the justification that makes that non-redundant:

| Provider | Model | Used for | Rationale |
|---|---|---|---|
| **Anthropic** | `claude-opus-5` | UI generation, proposal drafting, dev planning, code artifacts | Strongest on long-horizon agentic and coding work; 1M context; reliable structured output under `output_config.format`. $5/$25 per MTok. |
| **Anthropic** | `claude-sonnet-5` | Lead qualification, QA test authoring, summaries | Near-Opus quality at Sonnet cost. $3/$15 per MTok (intro $2/$10 through 2026-08-31). |
| **Anthropic** | `claude-haiku-4-5` | Classification, tagging, routing, cheap extraction | $1/$5 per MTok. High volume, low judgment. |
| **OpenAI** | `text-embedding-3-small` | Semantic search over leads, docs, past projects; retrieval for agents | **Anthropic has no embeddings endpoint.** This is the honest, non-redundant reason the second key exists. |

**Recommendation:** keep OpenAI **for embeddings only** in V1. Do not maintain parallel generation paths across two providers — it doubles prompt tuning, eval surface, and failure modes for no gain. Vectors live in `pgvector` on the same Postgres.

### 6.5 Prompt management

- Prompts are **files**: `prompts/<agent>/<key>.v<N>.md`, with YAML frontmatter (`model`, `effort`, `outputSchema`, `description`).
- **Git is the source of truth.** Loaded at build time into a typed registry — no database round trip on the hot path.
- Every prompt is **content-hashed**; the hash is written to `agent_runs.prompt_hash`. Any output is reproducible to the exact prompt bytes that produced it.
- **CI validates** every prompt: frontmatter parses, referenced schema exists, placeholders resolve, no secrets, length under budget.
- **Prompts are immutable once released.** Changes create `v{N+1}`. Rollback is a config change.

### 6.6 Structured output — the reliability backbone

Every agent returns validated JSON, never free text:

```ts
const res = await claude.messages.create({
  model: agent.model,
  max_tokens: 16000,
  thinking: { type: 'adaptive' },
  output_config: {
    effort: agent.effort,                                  // low → max
    format: { type: 'json_schema', schema: zodToJsonSchema(agent.outputSchema) },
  },
  system: [{ type: 'text', text: systemPrompt,
             cache_control: { type: 'ephemeral' } }],      // ← §6.9
  messages,
});
```

Then parse with the Zod schema. On failure, retry once with the validation error appended; on second failure, fail the run and surface the trace. **Nothing downstream ever sees unvalidated model output.**

For UI generation the schema is doubly load-bearing: `ScreenSpecSchema` restricts `component` to a **literal union of whitelisted primitives** from `src/ui/primitives`. A spec naming an unknown component fails validation before it reaches storage — which is what makes §4.7's "never execute generated code" guarantee hold end to end.

**Prototype rendering** (`app/(public)/p/[token]`): a signed, expiring, revocable token resolves to a `prototype_version`; the trusted renderer walks the spec; a strict CSP is set on the response. No user-supplied HTML or script ever enters the page.

### 6.7 Autonomy levels

| Level | Meaning | V1 agents |
|---|---|---|
| **L0** | Read-only. Advisory output; writes nothing. | *(escalation target for any misbehaving agent)* |
| **L1** | **Propose.** Writes a draft + an `approval_request`. Nothing takes effect until a human decides. | Proposal Drafter, UI Generator, Prototype Assembler, Dev Planner, Finance Assistant |
| **L2** | **Autonomous within limits.** Writes only to its own module's non-client-visible records. Never money, never client contact. | Lead Qualifier, QA Author |
| **L3** | Full autonomy. | **Not implemented in V1.** Requires ≥ 4 weeks of measured agreement rate to unlock. |

Autonomy is data (`ai.agents.autonomy_level`), so demoting an agent to L0 during an incident is one `UPDATE`, not a deploy. `ai.agents.enabled = false` is the per-agent kill switch.

### 6.8 The approval inbox is a product surface, not a queue

Automation that produces more decisions than a human can make has moved the bottleneck, not removed it. `/approvals` must therefore be designed, not just implemented:

- **Grouped by subject type**, sorted by SLA urgency.
- **Diff-first rendering** — show what changed, not the whole object.
- **One-keystroke approve / reject / request-changes**, with an optional note.
- **Bulk approve** for same-type, below-threshold items.
- **`time_in_queue` tracked as a product metric.** If it climbs, autonomy or thresholds need adjusting.

### 6.9 Cost control

Four layers, all enforced in `src/lib/ai/`:

1. **Per-run cap** — `maxCostMinor` in the registry. Exceeded → run halts with `budget_exceeded`.
2. **Per-org daily cap** — checked before every model call against `ai.cost_ledger`. Exceeded → jobs defer, owner is alerted.
3. **Prompt caching** — system prompts, brand kits, and component catalogs are large and stable, which is exactly the shape caching rewards: cache reads cost ~0.1× input, writes ~1.25×, so anything reused twice pays for itself. Note the minimum cacheable prefix is **512 tokens on Opus 5**, 1024 on Sonnet 5. Put volatile content (timestamps, per-lead data) *after* the last cache breakpoint or the cache silently never hits.
4. **Batch API for non-urgent work** — nightly re-scoring, bulk test-case generation, and backfills run through the Batches API at **50% of standard price**. Anything that can wait an hour should.

Every model call writes tokens and cost to `ai.agent_steps` and rolls up nightly into `ai.cost_ledger`. **Cost per lead and cost per project are first-class dashboard metrics from day one** — without them, unit economics can invert silently.

### 6.10 Evaluation

Before an agent's autonomy is raised, and on every prompt change:

- `evals/<agent>/cases.jsonl` — golden inputs with expected properties.
- `pnpm eval <agent>` runs them and reports pass rate, cost, and latency.
- **CI runs evals when a prompt file changes.** Regression blocks merge.
- Production agreement rate — how often a human approves an L1 proposal unedited — is tracked per agent and is the evidence for autonomy promotion.

---

## 7. Authentication

### 7.1 Two audiences, one system

Supabase Auth for both, distinguished by claims, not by separate infrastructure.

| Audience | Method | Why |
|---|---|---|
| **Internal** (owner, staff, contractors) | Google OAuth (`GOOGLE_CLIENT_ID` is already in `.env.example`) | No password to manage; you likely already use Google Workspace. |
| **Client** (portal users) | Magic link (email OTP) | Clients approve deliverables a handful of times per project. A password is pure friction and a support burden. |
| **Machine** (cron, webhooks, jobs) | Service-role key, server-only paths | Never in a request path that accepts user input without an explicit re-authorization. |
| **Agents** | Short-lived scoped token minted per run | §7.4. |

### 7.2 JWT claims drive RLS

A Supabase **custom access token hook** — a Postgres function run at token issuance — injects the claims RLS depends on:

```sql
create or replace function core.custom_access_token(event jsonb)
returns jsonb language plpgsql as $$
declare m record; c record; claims jsonb;
begin
  claims := event -> 'claims';
  select org_id, role into m from core.memberships
   where user_id = (event ->> 'user_id')::uuid and status = 'active' limit 1;

  if found then
    claims := jsonb_set(claims, '{app_metadata,org_id}', to_jsonb(m.org_id));
    claims := jsonb_set(claims, '{app_metadata,role}',   to_jsonb(m.role));
  else
    select org_id, client_account_id, role into c from core.client_users
     where user_id = (event ->> 'user_id')::uuid limit 1;
    if found then
      claims := jsonb_set(claims, '{app_metadata,org_id}', to_jsonb(c.org_id));
      claims := jsonb_set(claims, '{app_metadata,role}',   to_jsonb(c.role));
      claims := jsonb_set(claims, '{app_metadata,client_account_id}',
                          to_jsonb(c.client_account_id));
    end if;
  end if;
  return jsonb_set(event, '{claims}', claims);
end $$;
```

**Consequence:** `org_id` and `client_account_id` are never read from a request body. They come from a signed token the client cannot forge. This is what makes RLS a real boundary rather than a suggestion.

### 7.3 Session handling

- `middleware.ts` refreshes the Supabase session cookie on every request.
- Server Components and Server Actions build a **per-request** Supabase client carrying the user's JWT, so **RLS applies to your own code**.
- The **service-role client is used in exactly four places**: cron handlers, webhook handlers, the job runner, and migrations. Nowhere else. A lint rule enforces this — the service role bypasses RLS entirely, so its blast radius must stay auditable.

### 7.4 Agent identity

Agents are principals, not superusers:

- Each has a row in `core.users` with `type = 'agent'`.
- The run enqueuer mints a **short-lived JWT** (TTL = run budget) with `role = 'agent:<key>'` and a scope list derived from the registry.
- A Postgres role per agent tier holds only the grants that tier needs. `finance.invoices` grants no `INSERT` to any agent role, which is §6.1(a) enforced by the database.
- Every tool call is written to `ai.agent_steps` with its arguments.

### 7.5 Other credential paths

| Path | Mechanism |
|---|---|
| Razorpay webhook | HMAC over the raw body + `provider_event_id` replay guard |
| GitHub | **GitHub App** (per-repo installation), not a PAT — scoped, revocable, auditable per client project |
| Prototype share link | Signed token, expiring, revocable; grants read access to exactly one `prototype_version` |
| File download | Supabase Storage signed URL, short TTL, generated after an authorization check |
| `/api/v1/*` | Hashed API key with scopes; per-key rate limit |

---

## 8. Roles and Permissions

### 8.1 Two layers, different jobs

| Layer | Answers | Where |
|---|---|---|
| **RLS** (Postgres) | *Which rows may this principal see at all?* | Migrations. The hard boundary. |
| **Capabilities** (app) | *May this principal perform this action?* | `src/lib/authz/`. The UX and business boundary. |

RLS cannot express "an ops_admin may approve invoices under ₹1L." Capabilities cannot be trusted alone, because a bug bypasses them. You need both, and they are not redundant — they answer different questions.

### 8.2 Roles

| Role | Audience | Description |
|---|---|---|
| `owner` | Internal | You. Full authority including money and final approvals. |
| `ops_admin` | Internal | Runs delivery. Everything except owner-reserved financial approvals. |
| `delivery_lead` | Internal | Projects, tickets, QA. No finance. |
| `member` | Internal | Staff. Assigned work only. |
| `contractor` | Internal | External collaborator. Assigned projects only; no CRM, no finance. |
| `client_admin` | Client | Approves deliverables and invoices for their account; manages their users. |
| `client_member` | Client | Views and comments; cannot approve. |
| `agent:<key>` | Machine | Non-human principal, registry-scoped. |

### 8.3 Capability matrix

`—` = no access · `R` = read · `W` = write · `A` = approve

| Capability | owner | ops_admin | delivery_lead | member | contractor | client_admin | client_member |
|---|---|---|---|---|---|---|---|
| `lead.read` / `lead.write` | RW | RW | R | R | — | — | — |
| `proposal.draft` | W | W | — | — | — | — | — |
| `proposal.approve` | **A** | — | — | — | — | — | — |
| `proposal.send_to_client` | **A** | A | — | — | — | — | — |
| `project.create` / `project.manage` | RW | RW | RW | R | R* | R* | R* |
| `screen.generate` / `prototype.build` | W | W | W | — | — | — | — |
| `prototype.share` | A | A | A | — | — | — | — |
| `prototype.approve` | A | A | — | — | — | **A** | — |
| `ticket.manage` | RW | RW | RW | RW | RW* | — | — |
| `qa.run` / `qa.signoff` | RW | RW | RW | R | — | — | — |
| `deliverable.submit_to_client` | A | A | A | — | — | — | — |
| `deliverable.approve` | A | — | — | — | — | **A** | — |
| `invoice.create` | W | W | — | — | — | — | — |
| `invoice.issue` | **A** | A† | — | — | — | — | — |
| `refund.issue` | **A** | — | — | — | — | — | — |
| `agent.run` | W | W | W | — | — | — | — |
| `agent.configure` / `agent.kill` | **W** | — | — | — | — | — | — |
| `audit.read` | R | R | — | — | — | — | — |
| `member.invite` | W | W | — | — | — | W‡ | — |

`*` scoped to assigned projects / own client account · `†` below a policy threshold · `‡` own account's users only

### 8.4 Implementation

```ts
// src/lib/authz/permissions.ts — static, testable, no DB round trip
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  owner: ['*'],
  ops_admin: ['lead.read','lead.write','proposal.draft','project.manage', /* … */],
  client_admin: ['project.read.own','deliverable.approve','invoice.read.own', /* … */],
  // …
};

export function can(ctx: Ctx, cap: Capability, subject?: Subject): boolean {
  if (!hasCapability(ctx.role, cap)) return false;
  if (subject) return scopeCheck(ctx, subject);          // project / account scope
  return true;
}
```

- **Agent capabilities are the intersection** of their registry scope and their autonomy level — never a role's full set.
- The same `can()` powers UI affordances and server enforcement, so a hidden button and a rejected action can never disagree.
- Threshold rules (amounts, SLAs) live in `approvals.approval_policies` as **data**, so Ops changes them without a deploy.

---

## 9. Event Flow

### 9.1 Mechanism

Postgres outbox (§4.5) → cron dispatcher → in-process handlers.

```
service.ts, inside ONE transaction:
  1. mutate module tables
  2. INSERT core.audit_log
  3. INSERT core.outbox_events
  COMMIT                                 ← atomic: state + audit + event

GET /api/cron/outbox (every minute) + immediate waitUntil nudge:
  4. claim unpublished events (FOR UPDATE SKIP LOCKED)
  5. for each, look up subscribers in the event catalog
  6. enqueue one job per (event, handler) with dedupe_key = evt:handler
  7. mark published_at
```

**Delivery is at-least-once, so every handler must be idempotent.** The `dedupe_key` unique index makes duplicate enqueues a no-op, but handlers should still be written to tolerate replay.

### 9.2 Naming and catalog

`<module>.<entity>.<past-tense-verb>` — `lead.qualified`, `deliverable.accepted`, `invoice.paid`.

```ts
// src/lib/events/catalog.ts — the ONLY place modules couple to each other
export const SUBSCRIPTIONS = {
  'lead.created':          ['agents:runLeadQualifier'],
  'lead.qualified':        ['crm:advancePipeline', 'notify:alertOwner'],
  'proposal.approved':     ['notify:sendToClient'],
  'proposal.accepted':     ['projects:createFromProposal', 'finance:scheduleMilestones'],
  'screen.spec.generated': ['approvals:requestInternalReview'],
  'prototype.approved':    ['agents:runDevPlanner', 'projects:unlockBuildPhase'],
  'ticket.created':        ['build:syncToGithub'],
  'github.pr.merged':      ['build:advanceTicket', 'agents:runQaAuthor'],
  'qa.signed_off':         ['projects:markDeliverableReady'],
  'deliverable.submitted': ['notify:notifyClient'],
  'deliverable.accepted':  ['projects:completeMilestone', 'finance:createInvoice'],  // ★
  'invoice.issued':        ['notify:sendInvoice'],
  'payment.captured':      ['finance:reconcile', 'notify:sendReceipt'],
  'milestone.completed':   ['projects:checkProjectCompletion'],
} as const;
```

This file is the complete inter-module coupling graph. If you want to know what happens when a client approves something, you read one file.

### 9.3 The revenue path, end to end

The highest-value flow in the system. Build this first (§12).

```
① client clicks Approve in /client/review/[deliverableId]
   → capability check: client_admin + deliverable.approve
   ┌── TRANSACTION ────────────────────────────────────────────────┐
   │ approval_requests.state       = 'approved'                    │
   │ deliverables.status           = 'accepted'                    │
   │ audit_log      ← 'deliverable.approved' (actor=client)        │
   │ outbox_events  ← 'deliverable.accepted'                       │
   └───────────────────────────────────────────────────────────────┘

② dispatcher → projects:completeMilestone
   milestones.status = 'met'   → outbox 'milestone.completed'

③ dispatcher → finance:createInvoice
   read milestone→payment mapping
   INSERT invoices (status='draft', total from quote_items)
   policy: amount ≥ threshold?  →  approval_request(invoice, internal, owner)
                                 →  else auto-issue

④ owner approves in /approvals
   invoices.status = 'issued'  → outbox 'invoice.issued'

⑤ notify:sendInvoice
   PaymentProvider.createPaymentLink()
   email (+ WhatsApp if enabled) with the link

⑥ client pays → Razorpay → POST /api/webhooks/razorpay
   verify HMAC over raw body
   INSERT payment_events ON CONFLICT DO NOTHING     ← replay-safe
   enqueue 'payment.process'
   return 200 (< 1s)

⑦ job finance:reconcile
   INSERT payments (unique on provider_payment_id) ← idempotent
   invoices.paid_minor += amount
   status = paid | partially_paid
   audit_log + outbox 'payment.captured'

⑧ notify:sendReceipt · dashboards update · project may complete
```

**Every step idempotent. Every transition audited. Every external boundary replay-protected.** This is why the outbox and the unique constraints exist.

### 9.4 The build path, end to end

```
proposal.accepted
  → Project Planner (L1) drafts milestones + screen list
  → owner approves plan
  → UI Generator (L1) per screen → screen_spec (whitelist-validated)
  → internal review → screens.status = 'approved'
  → Prototype Assembler (L1) → prototype_version + flow + share token
  → owner approves → link sent to client
  → client reviews in /p/[token], pins feedback
  → client approves           →  'prototype.approved'
  → Dev Planner (L1) → dev_tickets with acceptance criteria
  → owner approves plan → build:syncToGithub creates issues via GitHub App
  → developers work; GitHub webhooks mirror PR/commit state onto tickets
  → PR merged → 'github.pr.merged'
  → QA Author (L2) generates test cases from acceptance criteria
  → human executes run; defects filed; blockers gate the deliverable
  → qa.signed_off → deliverable ready → submitted to client
  → ...rejoins the revenue path at ①
```

### 9.5 Scheduled work

`GET /api/cron/scheduled` (hourly) enqueues:

- overdue-invoice reminders
- approval SLA escalations
- client communication cadence
- nightly lead re-scoring (**Batch API**, 50% cost)
- daily `ai.cost_ledger` rollup + budget alert
- stale-job reaper, prototype-token expiry

---

## 10. Deployment

### 10.1 Environments

| Env | Branch | Vercel | Supabase | Providers |
|---|---|---|---|---|
| **Local** | any | `next dev` | local or a dev project | all in test mode |
| **Preview** | any PR | auto preview | shared staging project | test mode |
| **Production** | `main` | production | production project | live |

Two Supabase projects (staging, production). Not three — a solo founder does not need a third database to keep in sync.

### 10.2 Pipeline

```
push branch → PR
  CI: typecheck · lint (incl. module boundaries) · unit · RLS isolation tests
      · prompt validation · agent evals (if prompts changed) · build
  → Vercel preview deploy

merge to main
  → GitHub Action: supabase db push (migrations)
  → Vercel production deploy
  → smoke test against production health endpoint
```

Migrations run **before** the app deploys, and must be backward-compatible with the currently running version — the two are briefly live together.

### 10.3 Environment variables

`.env.example` needs these additions (`src/lib/env.ts` validates all of them with Zod at boot and refuses to start if any is missing):

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=          # server-only, 4 call sites (§7.3)
DATABASE_URL=                        # migrations + direct queries

# AI
ANTHROPIC_API_KEY=
OPENAI_API_KEY=                      # embeddings only (§6.4)
AI_DAILY_BUDGET_MINOR=50000          # ₹500/day default cap

# Auth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=                # ← missing today

# Payments
RAZORPAY_KEY_ID=
RAZORPAY_SECRET=
RAZORPAY_WEBHOOK_SECRET=             # ← missing today

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=

# Notifications
RESEND_API_KEY=
WHATSAPP_ACCESS_TOKEN=               # optional in V1
WHATSAPP_PHONE_NUMBER_ID=

# Platform
CRON_SECRET=                         # authenticates Vercel Cron calls
APP_URL=
```

### 10.4 Observability

- **Structured JSON logs** with `correlationId`, `orgId`, `userId`, `module`, `action` on every line.
- **Vercel Analytics + Log Drains**; Sentry for exceptions.
- **In-app dashboards** (`/agents`, `/approvals`) for the numbers that actually matter to you: agent cost/day, agent failure rate, approval queue depth, job queue depth and age, webhook failure rate, invoice aging.
- **Alerts** to email/WhatsApp: AI budget at 80%, jobs dead-lettered, webhook signature failures, approval SLA breached.

---

## 11. Future Scalability

Not "how to handle a million users" — **what breaks first, in what order, and what the escape hatch is.** Each item is a deliberate deferral, not an oversight.

| # | What breaks | Symptom | Escape hatch | Trigger |
|---|---|---|---|---|
| 1 | **Function duration on long agent runs** | Runs die mid-step | Already mitigated by step-jobs (§6.3). Next: move the runner to Inngest/Trigger.dev, or a small always-on worker on Fly/Railway. The job table stays; only the driver changes. | A single step can't fit in the limit |
| 2 | **Cron-driven queue latency** | Jobs wait up to 60 s | Supabase `pgmq`, or QStash for sub-second dispatch. Same table, different trigger. | Users notice the lag |
| 3 | **Postgres connections from serverless** | Connection exhaustion | **Use Supavisor transaction pooling from day one.** Free insurance. | — (do it now) |
| 4 | **Dashboard read load on OLTP** | Slow analytics pages | Materialized views, refreshed by cron; then a read replica. | p95 > 1 s |
| 5 | **Generated-artifact storage growth** | Storage bill | Lifecycle rules; keep last N versions hot, archive the rest. | Cost is visible |
| 6 | **AI cost per project** | Margin compression | Route more steps to Haiku; widen cache breakpoints; move more work to the Batch API; add semantic caching. | Cost/project exceeds target |
| 7 | **One module needs independent scale** | One workload starves others | **Extract it.** Schema `GRANT`s already isolate its data; the event catalog already defines its interface. `agents` is the likely first candidate. | Measured, not assumed |
| 8 | **Multi-tenant SaaS** | You want to sell it | `org_id` and RLS already exist (§0.5). Add signup, billing, and org-scoped onboarding. Weeks, not a rewrite. | You decide to sell |
| 9 | **Mobile / external integrations** | New consumers | `/api/v1/*` is already the seam; it calls the same `service.ts`. | Real demand |
| 10 | **Team grows past ~4 engineers** | Merge friction | Introduce pnpm workspaces + Turborepo, splitting `src/modules/*` into packages. The import boundaries already match package boundaries. | Real friction |

### What V1 deliberately does **not** do

No Kubernetes. No message broker. No GraphQL. No microservices. No separate API server. No monorepo tooling. No event sourcing. No CQRS. No service mesh. No mobile app. No multi-region.

Each of these solves a problem you do not have. Every one of them costs a solo founder weeks. **The correct amount of infrastructure for one person is the least that works.**

---

## 12. V1 Build Order

Vertical slices — each phase ends with something that runs.

| Phase | Weeks | Delivers | Done when |
|---|---|---|---|
| **0 — Foundation** | 1–2 | Next.js + TS + Tailwind, `src/lib/*`, ESLint boundaries, Supabase project, `core` schema + RLS, auth + claims hook, jobs + outbox + cron, CI | You can log in; a test job runs end to end; RLS isolation test passes |
| **1 — Revenue path** | 3–5 | `projects`, `approvals`, `finance`, client portal review screen, Razorpay + webhook + reconciliation | **A real client can approve a deliverable and pay an invoice.** No AI yet. |
| **2 — Sales path** | 6–8 | `crm`, `sales`, lead capture, pipeline UI, proposal + quote, won → project handoff | A lead travels capture → live project inside AgencyOS |
| **3 — First agent** | 9–10 | `agents` module, job-based runs, structured output, cost ledger, traces, kill switch, eval harness. **One agent: Lead Qualifier (L2).** | One agent in production, measured, capped, auditable |
| **4 — UI + Prototype** | 11–14 | `build` module, brand kits, `ScreenSpecSchema` + whitelist, trusted renderer, UI Generator (L1), Prototype Assembler (L1), share links, client feedback + approval | Client approves a generated prototype through a share link |
| **5 — Dev + QA** | 15–17 | Dev Planner (L1), GitHub App, ticket sync, PR mirroring, QA Author (L2), defects, sign-off gate | Approved prototype → GitHub issues → merged PRs → QA gate → deliverable |
| **6 — Harden** | 18–20 | Notifications (email + optional WhatsApp), Finance Assistant, dashboards, evals for all agents, approval-inbox UX, docs | You run a full client engagement in AgencyOS end to end |

**Why revenue before sales:** getting paid is the most integration-heavy, most audited, least forgiving flow. Build it while the codebase is small enough to hold in your head.

**Why no AI until phase 3:** agents need entities to act on (phase 1–2), an approval layer to gate them (phase 1), and an audit log to record them (phase 0). Building agents first means building them twice.

---

## 13. Decisions This Document Makes

Each should become an ADR in `docs/decisions/`.

| ADR | Decision | Rationale |
|---|---|---|
| 0001 | Modular monolith, one Next.js app on Vercel | Solo founder; boundaries enforced by tooling, not network |
| 0002 | Postgres schema per module, `GRANT`-enforced ownership | Machine-enforced modularity; clean extraction path |
| 0003 | `org_id` + RLS from migration 001, single org in V1 | Multi-tenancy becomes a feature, not a rewrite |
| 0004 | Server Components + Server Actions; REST only at `/api/v1` | Removes an entire hand-written API layer |
| 0005 | All agent runs are durable step-jobs in Postgres | The only shape that survives serverless |
| 0006 | Transactional outbox for all inter-module events | State and events commit atomically or not at all |
| 0007 | Claude for generation/agents; OpenAI for embeddings only | Non-redundant division; Anthropic has no embeddings endpoint |
| 0008 | Generated UI is a validated JSON spec, never executed code | Eliminates arbitrary code execution from AI output |
| 0009 | Agent limits enforced by DB grants, not prompts | Prompt injection cannot grant a permission that doesn't exist |
| 0010 | Approvals are one polymorphic engine with an `audience` flag | One mechanism for owner and client approval alike |

---

## 14. Open Questions

Not blocking — I've stated a working assumption for each and can proceed. Flag any you want changed.

1. **Payment provider** — Razorpay assumed from `.env.example`. Stripe if the market isn't India. (§0.5, §5.5)
2. **Tax** — India implies GST on invoices, with HSN/SAC codes. Confirm so `finance.invoices` carries the right fields from the start; retrofitting tax lines onto issued invoices is painful.
3. **WhatsApp in V1?** Meta template approval has real lead time. If yes, start the application during phase 1 rather than phase 6.
4. **Contractors in V1?** If you're solo with no collaborators yet, the `contractor` role and project-scoped RLS can ship in phase 6 instead of phase 0.
5. **Prototype fidelity** — is a whitelist-component spec renderer enough for client sign-off, or do you need pixel-level custom design? This is the one place my security-driven design constrains the product; if fidelity must be higher, we should discuss sandboxed-iframe rendering on a separate origin as the alternative.
6. **Time tracking** — `services/project-service/README.md` mentions "time tracking hooks." If billing is ever hourly rather than milestone-based, that's a whole subsystem currently absent from this design.

---

## 15. Summary

AgencyOS V1 is **one Next.js application on Vercel**, composed of eleven strictly-bounded modules over one Supabase Postgres, where:

- **Serverless is the shaping constraint**, so every slow operation — above all every AI agent run — is a durable, resumable step-job in Postgres, driven by cron plus immediate self-dispatch.
- **RLS with `org_id` from migration 001** makes data isolation a database guarantee and multi-tenancy a later feature rather than a rewrite.
- **One polymorphic approval engine** gates proposals, prototypes, deliverables, invoices, refunds, and every AI agent action through the same auditable mechanism.
- **AI agents propose; humans dispose** — enforced by database grants, not prompt discipline, so the guarantee survives prompt injection.
- **Generated UI is a validated JSON spec rendered by trusted code**, never executed source, which removes arbitrary code execution from the product entirely.
- **Claude does generation and agentic work; OpenAI does embeddings** — a real division of labour rather than redundant providers.
- **The transactional outbox** makes "state changed but the event was lost" structurally impossible.
- **What breaks first is known and has an escape hatch** (§11), so nothing here is a dead end.

No code has been written. Awaiting your approval before implementation.
