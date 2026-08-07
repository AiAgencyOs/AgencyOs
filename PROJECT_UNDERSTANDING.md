# PROJECT_UNDERSTANDING.md — AgencyOS

**Status:** Draft for approval
**Author:** Claude Code
**Date:** 2026-08-07
**Based on:** Full read of the repository at commit `57a3c68` (every file outside `.git`)

> **Reading note.** This document separates three things and labels them explicitly:
> - **[DOCUMENTED]** — stated in a repository file.
> - **[INFERRED]** — my reasonable deduction from names, env vars, or backlog items. Not written down anywhere.
> - **[PROPOSED]** — my recommendation. Nothing in the repo says this yet.
>
> This distinction matters because **the repository currently contains no product decisions** — only their placeholders. Sections 6 and 7 are proposals awaiting your approval, not descriptions of an existing plan.

---

## 0. What Is Actually In This Repository Today

A complete inventory, so we agree on the starting point:

| Category | Count | State |
|---|---|---|
| Source files (any language) | **0** | — |
| `package.json` / `pubspec.yaml` / lockfiles | **0** | — |
| CI/CD workflow files | **0** | `automation/` holds only a README |
| Folder README stubs | 24 | 1–3 sentences each, purpose-only |
| Business OS documents | 10 | **All are empty templates** — `Purpose`, `Scope` and `Owner` are blank/`<TBD>` in every one |
| Planning documents | 2 | `documentation-roadmap.md` (182 lines), `implementation-backlog.md` (403 lines) |
| ADRs | **0** | Roadmap prescribes 4; none written |
| OpenAPI specs | **0** | Roadmap prescribes stubs; none written |
| Diagrams | **0** | — |
| Env var placeholders | 10 | `.env.example` |
| GitHub templates | 3 | bug report, feature request, PR |
| License | MIT | © 2026 **AiAgencyOs** |

**The single most important fact:** AgencyOS is a *scaffolding* repository. The folder tree encodes an intended architecture, and the two planning docs encode an intended process, but **no business rule, data model, API contract, or agent behaviour has been decided**. Every business-os file lists the sections it *will* contain and stops there.

The five real signals of intent in the repository are:
1. The **folder tree** (4 apps, 4 services, 3 packages) — an architecture asserted by directory layout.
2. The **`.env.example` integrations** — Supabase, OpenAI, Anthropic, WhatsApp Business, Razorpay, Google OAuth.
3. The **business-os table of contents** — the ten domains the business intends to codify.
4. The **implementation backlog** — 42 tasks across 9 epics revealing the intended functional surface.
5. The **root README's claim** of "modular, **multi-tenant** agency operating system."

---

## 1. Project Vision

### 1.1 The stated vision **[DOCUMENTED]**

From `README.md`:

> "AgencyOS is an enterprise-grade foundation repository for building a modular, multi-tenant agency operating system… a composable platform for agencies to manage clients, projects, sales, approvals, and AI-assisted operations."
>
> "To provide a robust, extensible, and maintainable platform that enables agencies to operate with automation, AI orchestration, and modular microservices while promoting strong developer experience and clear delivery pipelines."

### 1.2 What that vision actually implies **[INFERRED]**

Reading the folder tree, the business-os TOC and the backlog together, AgencyOS is not a project-management tool with AI bolted on. It is an attempt to **encode the operating procedure of a digital agency as executable software, then hand large parts of that procedure to AI agents under human approval.**

The evidence for that stronger reading:

- The business documents are called a **"Company Constitution"** and **"Business Rules"**, not "requirements." A constitution is meant to *govern* runtime behaviour, not merely describe it.
- `08-ai-agent-responsibilities.md` sits *inside* the business-os set, alongside the constitution — AI agents are treated as **organizational actors with a job description**, not as a feature.
- `approval-service` is a **first-class service**, peer to sales and projects. In a normal agency tool, approvals are a field on a record. Here they are infrastructure — which is exactly what you need if non-human actors are proposing actions that require human sign-off.
- The backlog's `07-approval-rules.md` dependency chain runs from business rules → approval rules → approval-service, i.e. **the business document is intended to be the specification the service enforces.**

So the working thesis: **AgencyOS = a Business Operating System where written company policy is the source of truth, AI agents execute the routine work, and an approval layer is the control plane between them.**

### 1.3 The likely target customer **[INFERRED]**

The integration choices are specific and revealing:

- **Razorpay** (India-first payment gateway) + **WhatsApp Business API** → the primary market is almost certainly **India / South Asia**, where WhatsApp is the default client-communication channel, not email.
- **Supabase** rather than self-managed Postgres → a small team optimizing for speed and managed infrastructure over control.
- **Four separate frontends** (owner, admin, client, mobile) → a productized offering with distinct personas, not an internal tool.
- **"Multi-tenant"** in the README → the intent is likely **AgencyOS-as-a-SaaS sold to many agencies**, not a single agency's internal system.

⚠️ **This last point is the largest unresolved ambiguity in the entire repository, and it is Question 1 in Section 9.** "Multi-tenant" appears exactly once, in the README, and is never designed for anywhere. Whether tenant = *agency* (SaaS) or tenant = *client of one agency* (internal tool) changes the data model, the auth model, the pricing model, and roughly half of the roadmap. Nothing else can be safely built until it is answered.

### 1.4 Success, restated as a testable outcome **[PROPOSED]**

The repo defines no success metrics. I propose the vision be considered achieved when:

> An agency can run a client engagement end-to-end — inbound lead → qualification → proposal → contract → project plan → delivery → milestone approval → invoice → payment → retrospective — inside AgencyOS, with AI agents drafting every artifact along the way, and a human doing nothing but **approving or editing** at defined checkpoints.

That sentence is the acceptance criterion I would build the roadmap against, and it is Question 3 in Section 9.

---

## 2. Business Workflow

### 2.1 State of the business documentation

`docs/business-os/` contains ten numbered documents. **All ten are structurally identical empty templates.** Each has a blank `Purpose`, a blank `Scope`, `Owner: <TBD>`, a list of section headings "to be completed", acceptance criteria, and related documents.

**Zero business rules have been written.** The value in these files today is the *table of contents* — it tells us which domains the business considers load-bearing.

| # | Document | Sections it will define **[DOCUMENTED]** | Why it matters to engineering **[INFERRED]** |
|---|---|---|---|
| 01 | Company Constitution | Mission, values, **governance model**, org structure, **decision-making authority**, legal | Source of the **role/permission taxonomy**. "Decision-making authority" is literally the RBAC spec. |
| 02 | Business Rules | Pricing & billing, contracting, **client data handling**, **security & access control**, escalation, change mgmt | The **policy engine's rule set**. Pricing rules → quote calculation. Data handling → RLS + retention. |
| 03 | Sales Workflow | Lead capture & qualification, opportunity mgmt, **proposal & quotation**, negotiation, **onboarding handoff**, KPIs | The `sales-service` state machine. Defines lead → opportunity → won transitions. |
| 04 | Client Lifecycle | Onboarding, **communication cadence**, **deliverable acceptance loop**, upsell, offboarding, CSAT | Drives `client-portal` + the WhatsApp/notification engine. "Cadence" implies scheduled automation. |
| 05 | Project Lifecycle | Initiation, scoping, **planning & milestones**, delivery, QA, **change control**, closure | The `project-service` state machine. "Change control" is a scope-creep→approval→re-quote path. |
| 06 | Payment Milestones | Terms, **milestone definitions & acceptance criteria**, invoicing, late payment, refunds, Razorpay | The **money layer**. Explicitly binds project milestones to invoices. |
| 07 | Approval Rules | Approval **types and levels**, workflows, **SLAs & escalations**, **audit logging**, RBAC permissions | The direct specification for `approval-service`. The most implementation-ready doc in the set. |
| 08 | AI Agent Responsibilities | Agent types, **allowed/prohibited actions**, data access constraints, **human-in-the-loop policy**, monitoring, **prompt versioning**, failure modes | The **AI safety and authority charter**. Nothing in `ai-orchestrator` should be built before this exists. |
| 09 | SOP Index | Client onboarding, project kickoff, release mgmt, incident response, **AI agent incident escalation**, finance, offboarding | The library of **runbooks that become automations**. Each SOP is a candidate workflow definition. |
| 10 | Glossary | Terms A–Z, acronyms, **role definitions**, external systems | The **ubiquitous language**. Should drive entity and enum naming across all code. |

### 2.2 The end-to-end workflow, reconstructed **[INFERRED]**

The documents never draw the whole flow. Stitching document dependencies (03 → 04 → 05 → 06, with 07 cross-cutting) against the backlog epics (CRM → SAI → PM → DSN → DEV → QA → FIN), the intended business process is:

```
┌─────────── SALES (03) ────────────┐
│ Lead capture                       │  ← WhatsApp / web form / manual
│   ↓ AI qualification + scoring     │  ← SAI-003 score/reasons/tags schema
│ Lead → Opportunity conversion      │  ← CRM-004 checklist + approvals
│   ↓ AI-drafted proposal & quote    │  ← pricing rules from 02
│ Negotiation → Contract signed      │  ← human approval gate (07)
└────────────────┬───────────────────┘
                 │ onboarding handoff (03 §5)
┌────────────────▼── CLIENT (04) ────┐
│ Client onboarding + portal access  │
│ Communication cadence established  │  ← scheduled, likely WhatsApp
└────────────────┬───────────────────┘
                 │ project initiation
┌────────────────▼── PROJECT (05) ───┐
│ Scoping → Plan → Milestones        │  ← PM-001/002, AI-drafted plan
│ Delivery (tasks, assignees)        │
│   ↕ Change control → re-approval   │  ← 05 §6 + 07
│ QA (QA epic) → Deliverable ready   │
│   ↓                                │
│ Client reviews in portal           │  ← 04 §3 acceptance loop
│ Client APPROVES deliverable  ──────┼──► triggers ──┐
└────────────────────────────────────┘               │
┌──────────── FINANCE (06) ◄──────────────────────────┘
│ Milestone acceptance → Invoice     │  ← PM-003 mapping, FIN-001 schema
│ Razorpay payment link → Payment    │
│ Webhook → Reconciliation           │  ← FIN-002
│ (Refunds / disputes)               │  ← FIN-004, needs approval (07)
└────────────────┬───────────────────┘
                 │ project closure + retrospective (05 §7)
                 ▼
        Offboarding OR Upsell loop (04 §4/§5)

╔═══════════════════════════════════════════════════════╗
║ CROSS-CUTTING: APPROVAL (07) — gates every ║ marked   ║
║ transition. AUDIT LOG on all of them.                 ║
║ AI AGENTS (08) — propose at every ↓, never commit     ║
║ a gated transition without human sign-off.            ║
╚═══════════════════════════════════════════════════════╝
```

**The critical insight this diagram surfaces:** the **client's approval of a deliverable is the event that produces revenue.** `deliverable accepted → milestone met → invoice issued → payment collected` is the money path, and it runs through `approval-service`, `project-service`, `client-portal` and `sales-service` at once. It is simultaneously the highest-value and highest-risk flow in the system, and it should be the **first vertical slice built end-to-end** (see Section 7).

### 2.3 Business workflow gaps **[INFERRED]**

Reading the TOCs against a real agency operation, these processes are **not covered anywhere**:

- **Resource management / capacity planning** — who is available, who is overallocated. No document, no service, no backlog epic. This is a daily operational need for any agency.
- **Time tracking** — mentioned once, in passing, in `services/project-service/README.md` ("time tracking hooks"). Never specified. If billing is hourly rather than milestone-based, this is a missing revenue path.
- **Vendor / subcontractor / freelancer management** — agencies routinely subcontract. No coverage.
- **Proposal → contract → e-signature** — `03 §4` says "Negotiation and Contracting" but no e-signature integration appears in `.env.example`. How does a contract get signed?
- **Marketing / lead generation** — the funnel starts at "lead capture." Where leads *come from* is out of scope, which may be intentional.
- **Internal HR / staffing** — out of scope, presumably intentional.

---

## 3. AI Agents Overview

### 3.1 What is documented **[DOCUMENTED]**

Remarkably little, given AI is in the project's name and license holder (`AiAgencyOs`):

- `services/ai-orchestrator/README.md`: "manages AI prompts, orchestration, and model interactions… should encapsulate **all** AI provider integrations… **Centralize API key usage and rate-limiting to reduce blast radius.**"
- `prompts/README.md`: central storage for prompt templates, referenced by `ai-orchestrator`.
- `docs/agents/README.md`: "agent responsibilities, safety, and rate-limiting considerations."
- `docs/business-os/08-ai-agent-responsibilities.md`: an **empty template** listing the seven things it will one day define.
- `.env.example`: both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`.
- Backlog epic **SAI** (Sales AI): prompt retrieval endpoint (SAI-001), prompt validation rules (SAI-002), lead-scoring output schema (SAI-003), agent-to-service auth (SAI-004), telemetry events (SAI-005).

**There is no list of agents anywhere in this repository.** Not a single agent is named. The only agent capability concretely specified anywhere is **lead scoring** (SAI-003: `score`, `reasons`, `tags`).

### 3.2 The architectural principles that *are* established **[DOCUMENTED]**

Three real constraints, and they are good ones:

1. **Single choke point.** All provider integration lives in `ai-orchestrator`. No other service calls OpenAI or Anthropic directly. Blast radius, key handling, cost accounting and rate limiting all collapse to one place.
2. **Prompts are versioned artifacts, not string literals.** `prompts/` is a top-level directory; SAI-001 specifies retrieval *by key and version*; SAI-002 specifies validation before use. Prompts are treated as a **release-managed asset**.
3. **Agents authenticate as constrained principals.** SAI-004 calls for short-lived, scoped tokens. Agents are not superusers — they are subjects of the same authorization system as humans.

### 3.3 Proposed agent roster **[PROPOSED]**

Since no roster exists, here is one derived from the business-os domains and backlog epics. **Every entry is a proposal, not a documented decision.** Each maps to the business doc that would govern it.

| Agent | Governing doc | Responsibility | Authority level **[PROPOSED]** |
|---|---|---|---|
| **Lead Qualifier** | 03 Sales | Enrich inbound leads, score 0–100 with reasons + tags, deduplicate, route | **Autonomous** — writes only to lead records, no client contact |
| **Proposal Drafter** | 03 Sales + 02 Rules (pricing) | Draft scope, timeline and priced quote from a qualified lead | **Propose-only** — human must approve before it reaches a client |
| **Client Comms Agent** | 04 Client Lifecycle | Draft/send status updates, reminders, cadence messages over WhatsApp & email | **Propose-only initially**, autonomous for templated status updates once trusted |
| **Project Planner** | 05 Project Lifecycle | Turn an accepted scope into milestones, tasks, estimates, assignees | **Propose-only** — plan requires PM approval |
| **Delivery Monitor** | 05 Project Lifecycle | Watch for slipping tasks, blocked work, at-risk milestones; raise flags | **Autonomous** — read + alert only, never mutates |
| **QA Reviewer** | QA epic + 05 §5 | Check deliverables against acceptance criteria before client review | **Advisory** — attaches a verdict, never blocks or passes unilaterally |
| **Finance Agent** | 06 Payments + FIN epic | Generate invoices on milestone acceptance, chase late payment, reconcile Razorpay events | **Propose-only for anything that moves money.** Autonomous for reconciliation *matching* |
| **Approval Router** | 07 Approval Rules | Determine required approvers/levels for a request, enforce SLA, escalate | **Autonomous routing, zero approval authority** — it may never approve anything |
| **Ops/Insight Agent** | 01 Constitution | Owner-dashboard summaries, pipeline health, margin and utilization reporting | **Autonomous** — read-only |

### 3.4 The single most important unwritten rule **[PROPOSED]**

I recommend this be the first line written into `08-ai-agent-responsibilities.md`, before any agent code exists:

> **No AI agent may commit a state transition that (a) moves money, (b) creates a legal obligation, (c) sends communication to a client, or (d) alters an approved scope — without a recorded human approval. Agents propose; humans dispose. Every proposal and every disposition is written to an immutable audit log.**

The architecture in Section 6 is designed to make this rule **structurally enforceable** rather than merely aspirational — agents get scoped tokens that lack the permissions to do these things at all, so the rule is enforced by the authorization layer, not by prompt discipline.

### 3.5 Concerns with the current AI posture **[INFERRED]**

- **Two providers, no stated reason.** Both OpenAI and Anthropic keys are present. Dual-provider support doubles evaluation cost, prompt-tuning cost and failure modes. It is justified *only* if you need failover or per-task model routing. Decide deliberately (Question 8).
- **No evaluation strategy.** `prompts/README.md` mentions "evaluation notes," but there is no eval harness, golden dataset, or regression concept anywhere. **Prompt changes are silent behaviour changes in production.** This is the AI equivalent of shipping without tests.
- **No cost model.** Agents running per-lead and per-project have unbounded token cost. No budget, no per-tenant quota, no cost telemetry. SAI-005 lists telemetry events but omits token counts and spend.
- **No human-in-the-loop UX defined.** The approval *service* is planned; the approval *experience* (how an owner reviews 40 agent proposals a day without it becoming a full-time job) is not designed anywhere. This is a product risk, not a technical one.

---

## 4. Folder Structure Explanation

```
AgencyOS/
├── README.md                    Vision, module list, suggested stack. Only real product statement in the repo.
├── LICENSE                      MIT © 2026 AiAgencyOs
├── .env.example                 10 vars — the de-facto integration decision record
├── .gitignore                   Node/Next.js + Flutter — confirms the intended stack
├── .github/                     bug_report, feature_request, PULL_REQUEST_TEMPLATE. No workflows.
│
├── apps/                        FRONTENDS — 4 personas, all README-only
│   ├── owner-dashboard/         Agency owner: accounts, billing, high-level reporting
│   ├── admin-dashboard/         Internal ops: user mgmt, RBAC, audit logging, monitoring
│   ├── client-portal/           External client: view projects, APPROVE DELIVERABLES, communicate
│   └── mobile/                  Flutter, cross-platform. Explicitly presentation + cache only.
│
├── services/                    BACKEND — 4 domain services, all README-only
│   ├── sales-service/           Leads, pipeline, quotes, invoices. Authoritative store: Supabase Postgres.
│   ├── project-service/         Projects, tasks, schedules, assignments, "time tracking hooks"
│   ├── approval-service/        Versioned approvals, audit logs, notification hooks. CONTROL PLANE.
│   └── ai-orchestrator/         Sole owner of AI provider keys, prompts, pipelines, rate limits
│
├── packages/                    SHARED CODE — 3 packages, all README-only
│   ├── ui/                      Design system, React components, tokens. Storybook recommended.
│   ├── config/                  Centralized config, env typings, runtime validators
│   └── shared/                  Framework-agnostic domain types, DTOs, utils. "Keep small."
│
├── docs/
│   ├── documentation-roadmap.md ★ THE PROCESS SPEC — doc priorities, dependency graph, writing order
│   ├── implementation-backlog.md ★ THE WORK SPEC — 42 tasks, 9 epics
│   ├── business-os/             ★ 10 numbered business docs — ALL EMPTY TEMPLATES
│   └── {business, architecture, api, database, agents, backend, frontend,
│         testing, deployment, decisions, roadmap, sprints}/   12 README stubs
│
├── automation/                  CI/CD templates. Empty (README only).
├── prompts/                     Prompt template store, consumed by ai-orchestrator. Empty.
└── scripts/                     Setup, dev, migrations, maintenance. "Keep idempotent." Empty.
```

### 4.1 What the structure tells us

- **Monorepo, decided implicitly.** `apps/ + services/ + packages/` with shared code is the canonical monorepo shape. `documentation-roadmap.md §7` still lists ADR `0001-repo-structure.md` (monorepo vs multi-repo) as "to create immediately" — so the tree has **pre-empted a decision the process says is still open**. Worth ratifying formally, but the tree is right.
- **Contradiction on service granularity.** `services/README.md` says "Each service should be a standalone repository **or** a local package depending on delivery choice" — that choice is unmade, and it is significant (see Section 6.2).
- **`packages/config` implies runtime env validation** ("runtime validators") — a good instinct; it should be built first and used by everything else.
- **Correct dependency direction.** `apps/README.md` and `apps/mobile/README.md` both push business logic down into `services/` and `packages/`. Frontends stay thin. This is stated and should be enforced by lint rules.
- **Discipline is explicitly requested.** `apps/README.md`: *"Do not add application code here until the architecture is finalized."* The repository is deliberately withholding code until the docs land — which is exactly why this document exists before any implementation.

### 4.2 Broken references found while reading **[DOCUMENTED — these are real defects]**

Six of the ten business-os files contain links to paths that **do not exist**:

| File | Broken reference | Correct path |
|---|---|---|
| `05-project-lifecycle.md` | `docs/business/architecture/README.md` | `docs/architecture/README.md` |
| `05-project-lifecycle.md` | `docs/docs/roadmap/README.md` | `docs/roadmap/README.md` |
| `07-approval-rules.md` | `docs/business/agents/README.md` | `docs/agents/README.md` |
| `07-approval-rules.md` | `docs/services/approval-service/README.md` | `services/approval-service/README.md` |
| `08-ai-agent-responsibilities.md` | `docs/business/agents/README.md` | `docs/agents/README.md` |
| `08-ai-agent-responsibilities.md` | `docs/services/ai-orchestrator/README.md`, `docs/prompts/README.md` | `services/ai-orchestrator/`, `prompts/` |

Additionally, **five files list themselves in their own "Related Documents"** (02→02, 05→05, 07→07, 09→09, 10→10) — a copy-paste artifact from templating.

These are trivial to fix and I'd suggest doing so as the first commit after approval.

---

## 5. Missing Components

Grouped by whether the gap **blocks** work or merely needs scheduling.

### 5.1 🔴 Blocking — nothing meaningful can be built until these exist

| Missing | Why it blocks |
|---|---|
| **Multi-tenancy decision** | Determines whether every table needs `tenant_id`, whether auth is per-agency, and whether this is SaaS or internal. Retrofitting tenancy is a rewrite. **Question 1.** |
| **Any content in the 10 business-os docs** | The entire premise is that business policy drives the software. Ten empty templates = zero policy. Building now means inventing the business rules in code, where they can't be reviewed by Legal/Finance/Ops. |
| **Data model / ER design** | `docs/database/README.md` is a 3-line stub. No entity has been defined — not lead, client, project, milestone, invoice, approval, or user. Backlog CRM-001/PM-001/PM-002 are *tasks to define them*, still undone. |
| **API contracts / OpenAPI** | Roadmap makes `docs/api/` the **canonical input Claude Code MUST follow**. It contains one 3-line stub. There is no contract to follow. |
| **The 4 prescribed ADRs** | `0001-repo-structure`, `0002-data-ownership`, `0003-api-versioning`, `0004-ai-provider`. Roadmap §7: "create immediately." None exist. ADRs are declared authoritative in conflicts — there are none to appeal to. |
| **Auth & identity model** | No service owns users, sessions, roles or permissions. `GOOGLE_CLIENT_ID` exists with no `GOOGLE_CLIENT_SECRET`; Supabase Auth is implied but never stated. Four frontends and four services with no answer to "who is this and what may they do." |
| **AI agent authority charter** (`08`) | Building agents that touch money and client comms without written limits is the project's top risk (Section 8). |

### 5.2 🟠 Missing services / capabilities not represented anywhere

The four services do not cover the surface the workflow requires:

| Missing capability | Evidence it's needed | Where it should live **[PROPOSED]** |
|---|---|---|
| **Identity / Auth / RBAC** | 01 §6 "Decision-making Authority", 07 §5 "Role-based Approval Permissions", admin-dashboard RBAC | Supabase Auth + an `identity` module owning roles/permissions |
| **Notification / Messaging** | WhatsApp env vars, 04 §2 "Communication Cadence", approval-service "notification hooks" | New `notification-service` — WhatsApp, email, in-app, with template + delivery tracking |
| **File / Document storage** | 05 §8 "Project Artifacts and Storage", deliverables must be reviewable in client-portal | Supabase Storage + a document module (versioning, access control, previews) |
| **Billing / Invoicing** | Entire FIN epic + doc 06. Currently smuggled into `sales-service` ("leads, quotes, **invoices**") | Split into `finance-service`. Money should not share a service with lead management. |
| **Scheduler / Job runner** | CRM-003 batch classification, cadence messaging, invoice reminders, reconciliation | A worker + queue (see 6.6) |
| **Audit log** | 07 §4 "Audit Logging and Record Retention", admin-dashboard "audit logging" | Append-only store, written by every service, readable by admin-dashboard |
| **Search** | Any real CRM needs it across leads/projects/documents | Postgres FTS initially; `pgvector` for semantic/agent retrieval later |
| **Analytics / reporting** | owner-dashboard "high-level reporting", 03 §6 Sales KPIs, 04 §6 CSAT | Read models / materialized views, not ad-hoc queries against OLTP |

### 5.3 🟡 Missing engineering foundation (no blocker, but day-one work)

- **No workspace tooling** — no root `package.json`, no `pnpm-workspace.yaml`/Turborepo/Nx. The monorepo is a folder tree, not a workspace.
- **No TypeScript config** — DEV-001 proposes it; not done.
- **No linting/formatting** — no ESLint, Prettier, or commit hooks.
- **No CI** — `.github/workflows/` does not exist. `automation/` is empty. No PR gate exists despite the PR template's "I have run linting and unit tests" checkbox.
- **No test infrastructure** — no framework, no fixtures, no E2E harness. QA epic is all planning.
- **`CODEOWNERS` and `CONTRIBUTING.md`** — backlog FND-001/FND-002 are **P0 and still undone.**
- **No `docs/diagrams/`** — roadmap §9 asks for committed Mermaid/PlantUML.
- **No error/logging/pagination/health specs** — DEV-003/004/005, DEP-003 all pending.
- **No local dev environment** — no `docker-compose.yml`, no seed data, no `scripts/` content. A new contributor cannot start.
- **`.env.example` is incomplete** — missing `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `RAZORPAY_WEBHOOK_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `JWT_SECRET`, and any per-service base URLs.

### 5.4 ⚠️ A structural observation about the backlog

The backlog presents itself as an **implementation** backlog and is described as "implementation-ready for an AI developer." Reading all 42 tasks: **roughly 38 produce a document, schema, checklist or spec. Perhaps 4 produce anything executable** — and even those hedge (CRM-002: *"note: this is a planning task; actual code task would implement"*).

This is not a criticism of the tasks — they are the right *specifications*. But the backlog is a **specification backlog**, and treating it as the build plan would mean completing all 42 items and still having zero running software. The roadmap in Section 7 therefore proposes converting specs into vertical slices rather than executing the backlog top-to-bottom.

---

## 6. Technical Architecture Proposal

> **Everything in this section is [PROPOSED].** It respects the constraints the repository already establishes (monorepo shape, Supabase, Next.js/Flutter, centralized AI, approval-as-service) and makes concrete the decisions the repo leaves open. Each proposal should become an ADR.

### 6.1 Guiding principles

1. **Policy is data, not code.** Business rules from `business-os` become versioned configuration a policy engine evaluates — so Ops changes an approval threshold without a deploy.
2. **Agents propose, humans dispose.** Enforced by the authorization layer, not by prompts (Section 3.4).
3. **Everything gated is audited.** Every gated transition writes an immutable audit record.
4. **One database, clear ownership.** One Postgres, one schema per domain, strictly no cross-schema writes. Preserves service boundaries without distributed-transaction pain.
5. **Contract-first.** OpenAPI before handlers; types generated, never hand-written twice.
6. **Boring by default.** Choose the smallest thing that works; earn complexity.

### 6.2 ⭐ The most important recommendation: **modular monolith first, microservices later**

The README says "modular microservices" and `services/README.md` leaves standalone-repo-vs-local-package open. **I recommend explicitly choosing: one deployable API composed of four (soon seven) strictly-bounded modules, in the existing folder layout.**

Why:
- **Four services × (deploy + monitor + auth + versioning + tracing) is a full-time platform job.** The team implied by this repo does not have that capacity, and every hour spent on it is an hour not spent on the product.
- **The domain boundaries are not yet known.** Every entity is undefined. Freezing service boundaries into network boundaries *before* modelling the data is how you end up with distributed spaghetti and cross-service transactions.
- **The workflow is transactionally coupled.** `deliverable accepted → milestone met → invoice issued` spans three "services." In one process this is a database transaction. Across four it's a saga with compensations — a large tax paid for scale you don't have yet.
- **The folder tree already gives you the discipline.** Keep `services/*` as separate packages with enforced import boundaries (ESLint `no-restricted-imports` / Nx tags). Each communicates through explicit interfaces. When one genuinely needs independent scaling, extract it — the seams are already cut.

**`ai-orchestrator` is the one exception: deploy it separately from day one.** Its README already justifies this ("centralize API key usage… reduce blast radius"), its workload profile is different (long-running, bursty, expensive), and it must be independently rate-limited and cost-capped.

```
┌────────────── CLIENTS ──────────────────────────────────┐
│ owner-dashboard   admin-dashboard   client-portal       │
│    (Next.js)         (Next.js)        (Next.js)         │
│                  mobile (Flutter)                       │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS / JSON, OpenAPI-typed
              ┌──────────▼──────────┐
              │   API Gateway /     │  auth, rate limit, tenant
              │   BFF layer         │  resolution, tracing
              └──────────┬──────────┘
      ┌──────────────────┴───────────────────┐
      │        AgencyOS API (modular)        │
      │  ┌────────┬────────┬────────┬─────┐  │
      │  │ sales  │project │approval│ fin │  │
      │  ├────────┼────────┼────────┼─────┤  │
      │  │identity│ notify │document│audit│  │
      │  └────────┴────────┴────────┴─────┘  │
      │   ── policy engine (business rules) ──│
      └───┬─────────────────┬─────────────┬──┘
          │                 │             │
   ┌──────▼──────┐   ┌──────▼──────┐  ┌──▼────────────┐
   │  Supabase   │   │ Job queue   │  │ ai-orchestrator│ ← separate deploy
   │  Postgres   │   │ + workers   │  │  (sole key     │
   │  + Storage  │   │ (pg-boss)   │  │   holder)      │
   │  + Auth+RLS │   └──────┬──────┘  └──┬────────────┘
   └─────────────┘          │            │
                     ┌──────▼────────────▼──────┐
                     │ Razorpay │ WhatsApp │ LLM│
                     └──────────────────────────┘
```

### 6.3 Stack **[PROPOSED]**

| Layer | Choice | Rationale |
|---|---|---|
| Language | **TypeScript, strict** | Already implied by `.gitignore` + `packages/config` "env typings". One language across web + API + shared types. |
| Monorepo | **pnpm workspaces + Turborepo** | Matches the existing tree; Turbo's caching keeps CI fast. |
| Web | **Next.js 15, App Router** | Stated in READMEs. Server Components suit data-heavy dashboards. |
| Mobile | **Flutter** | Stated. Presentation-only per `apps/mobile/README.md`. |
| API | **NestJS** | README lists it. Its module system enforces the modular-monolith boundaries structurally, and it extracts to microservices cleanly if needed. |
| DB | **Supabase Postgres**, schema per domain | Stated. RLS is the multi-tenancy enforcement layer. |
| Auth | **Supabase Auth** (Google OAuth + email) + app-level RBAC | `GOOGLE_CLIENT_ID` present. RBAC beyond Supabase's model lives in the `identity` module. |
| Jobs | **pg-boss** (Postgres-backed) | Avoids a Redis dependency at this scale. Swap for BullMQ/Redis when volume demands. |
| Events | **Transactional outbox** → dispatcher | Reliable event publication without a broker. Enables later extraction. |
| Files | **Supabase Storage** | Same platform, RLS-aware. |
| AI | **Anthropic Claude as primary** (see 6.7) | Repo carries both keys; pick one primary and justify the second. |
| Payments | **Razorpay** + signed webhooks | Stated. |
| Messaging | **WhatsApp Business Cloud API** + email fallback | Stated. |
| Observability | **OpenTelemetry** + structured logs (DEV-004) | Traces matter most for agent flows spanning many hops. |
| Testing | **Vitest** (unit), **Supertest** (contract), **Playwright** (E2E) | QA-001's onboarding flow is a natural first Playwright suite. |

### 6.4 Multi-tenancy **[PROPOSED — pending Question 1]**

Assuming tenant = **agency** (the SaaS reading):

- Every business table carries a non-null `tenant_id`.
- **Postgres RLS on every table**, keyed to a JWT claim. RLS is the enforcement boundary — application code is the second line of defence, not the first.
- Tenant context resolved once at the gateway, injected into the DB session, never taken from a request body.
- **Clients of an agency are `contacts`/`client_accounts` *within* a tenant, not tenants themselves.** `client-portal` users are scoped to their own client account by an additional RLS predicate.
- Cross-tenant queries exist only for platform admins, through an explicitly separate, audited path.

### 6.5 Approval as the control plane **[PROPOSED]**

`approval-service` should be a **generic, polymorphic workflow engine**, not a table of booleans:

```
approval_request
  id, tenant_id
  subject_type    -- 'proposal' | 'deliverable' | 'invoice' | 'refund'
                  -- | 'scope_change' | 'agent_action'
  subject_id
  requested_by    -- user_id OR agent_id  ← agents are first-class requesters
  policy_id       -- which rule from business-os/07 applied
  state           -- pending | approved | rejected | expired | escalated
  sla_due_at, decided_at, decided_by, decision_reason
approval_step     -- multi-level chains (01 §6 "decision-making authority")
approval_audit    -- append-only, immutable
```

This one abstraction serves proposals, deliverable sign-off, invoices, refunds, scope changes **and every AI agent action** — which is precisely why doc `07` and doc `08` both point at it. Get this right and the AI safety story is largely solved by construction.

### 6.6 The revenue path, concretely **[PROPOSED]**

```
client clicks Approve in client-portal
  → approval_request(deliverable).state = approved   [audited]
  → outbox event: deliverable.accepted
  → project module: milestone.state = met
  → finance module: create invoice from milestone→payment mapping (PM-003, FIN-001)
  → Razorpay payment link created; WhatsApp + email notification sent
  → Razorpay webhook (signature-verified, idempotent by event id)
  → payment recorded, reconciled against invoice (FIN-002)
  → project + owner dashboards update
```

Idempotency at every external boundary. Every step audited. This is the first slice I would build (Section 7, Phase 2).

### 6.7 AI orchestration **[PROPOSED]**

- **One provider primary: Anthropic Claude.** Strong tool-use and structured-output reliability, which is what an agent that must return `{score, reasons, tags}` needs. Keep OpenAI configured only if you have a stated failover or per-task-routing requirement — otherwise drop the second key and halve the eval surface (**Question 8**).
- **Prompt registry**: git is the source of truth (`prompts/`); prompts are content-hashed and immutable once released; SAI-001 retrieval is by `(key, version)`; SAI-002 validation runs in CI, not at request time.
- **Every agent call is a job, not a request** — queued, retried, cancellable, cost-capped. Never block an HTTP request on an LLM.
- **Structured output enforced by schema**, with validation-failure retry. SAI-003's schema is the template for all of them.
- **Agent identity**: each agent is a principal with a scoped, short-lived token (SAI-004) whose permissions *cannot* express the four forbidden actions from Section 3.4.
- **Full trace capture**: prompt version, model, tokens in/out, cost, latency, tool calls, outcome — per SAI-005, plus the cost fields it omits.
- **Eval harness before agent #2.** Golden dataset per agent, run in CI on prompt change. Without this, prompt edits are untested production changes.

### 6.8 Data ownership (ADR 0002) **[PROPOSED]**

| Module | Owns | Reads via API/events only |
|---|---|---|
| identity | users, roles, permissions, tenants | — |
| sales | leads, opportunities, proposals, quotes | client_accounts |
| project | projects, tasks, milestones, assignments | client_accounts, users |
| finance | invoices, payments, refunds, ledger | milestones, client_accounts |
| approval | approval_requests, steps, audit | subjects by reference only |
| notification | messages, templates, delivery status | users, contacts |
| document | files, versions, access grants | projects, deliverables |
| ai-orchestrator | prompts, runs, traces, costs | everything read-only, scoped |

Rule: **no module writes another module's tables.** Enforced by schema-level grants, not convention.

---

## 7. Development Roadmap

> **[PROPOSED].** The organizing principle: **stop writing specs in isolation; write the spec for one vertical slice, build that slice end-to-end, then repeat.** The backlog's 42 items get pulled into whichever phase needs them rather than executed in sequence.

### Phase 0 — Decide (Week 1) — *no code*

Unblocks everything. Output is decisions, not documents-about-documents.

1. Answer the questions in Section 9 — especially **multi-tenancy** and **who the customer is**.
2. Write the **4 ADRs** the roadmap already prescribes: repo strategy, data ownership, API versioning, AI provider. Add a 5th: **modular monolith vs microservices** (Section 6.2).
3. Fill the **two business documents that block engineering**: `02-business-rules.md` (pricing, data handling, access control) and `07-approval-rules.md` (types, levels, SLAs, escalation). The other eight can follow.
4. Write `08-ai-agent-responsibilities.md` — at minimum the allowed/prohibited action matrix and the rule in Section 3.4.
5. Fix the broken doc references from Section 4.2.

**Exit:** ADRs merged; 3 business docs approved; tenancy decided.

### Phase 1 — Foundation (Weeks 2–3)

Make the repo buildable. Backlog: FND-001…006, DEV-001/003/004/005, DEP-003.

- pnpm workspaces + Turborepo; root `package.json`; strict `tsconfig` base.
- `packages/config` (env schema + runtime validation), `packages/shared` (first domain types).
- CI: lint → typecheck → test → build on every PR. `CODEOWNERS`, `CONTRIBUTING.md`.
- Supabase project; first migration: `tenants`, `users`, `roles`, RLS policies, audit table.
- NestJS API skeleton: health endpoint, error schema, pagination, structured logging, OpenAPI generation.
- `docker-compose` + seed script so a contributor can run the stack in one command.

**Exit:** `pnpm dev` runs the API and one Next.js app; CI green; a real user can log in.

### Phase 2 — Vertical slice #1: **the revenue path** (Weeks 4–7)

The highest-value, highest-risk flow (Section 6.6). Build it thin but complete — **no AI yet.**

- Data model: `client_account`, `project`, `milestone`, `deliverable`, `invoice`, `payment`, `approval_request`.
- `client-portal`: log in, view project, view deliverable, **approve/reject**.
- `approval-service`: generic engine + audit log.
- `finance`: milestone→invoice mapping (PM-003), invoice schema (FIN-001), Razorpay link + webhook + reconciliation (FIN-002).
- `owner-dashboard`: project + invoice status.
- Playwright E2E over the whole path (QA-001 extended).

**Exit:** A real client can approve a deliverable and pay an invoice. **The product now makes money.**

### Phase 3 — Vertical slice #2: **the sales path** (Weeks 8–11)

Backlog: CRM-001…005, PM-001/002/005.

- `lead`, `opportunity`, `proposal`, `quote` entities and pipeline states.
- Lead capture (web form + WhatsApp inbound), CRM UI in admin-dashboard.
- Lead→opportunity conversion with the CRM-004 checklist.
- Proposal/quote generation using pricing rules from `02-business-rules.md`.
- Won-deal → project creation handoff (03 §5).

**Exit:** A lead can travel from capture to a live project without leaving AgencyOS.

### Phase 4 — First AI agent, narrow and safe (Weeks 12–14)

Backlog: SAI-001…005.

- `ai-orchestrator` deployed standalone: prompt registry, scoped agent tokens, queued runs, cost + trace telemetry, eval harness.
- **Ship exactly one agent: the Lead Qualifier.** Lowest blast radius — writes only to lead records, never contacts a client, never touches money.
- Human review UI for agent output; measure agreement rate over 4 weeks before granting further autonomy.

**Exit:** One agent in production, measured, cost-capped, auditable. The pattern for every subsequent agent is proven.

### Phase 5 — Agent expansion + communication (Weeks 15–20)

- `notification-service`: WhatsApp templates (allow lead time for Meta template approval), email, in-app, delivery tracking.
- Agents 2–4 behind approval gates: Proposal Drafter, Project Planner, Client Comms.
- Client cadence automation (04 §2).
- `document` module for deliverable storage and versioning.

### Phase 6 — Scale and polish (Weeks 21+)

- Mobile app (Flutter) once web flows are stable.
- Remaining agents: QA Reviewer, Finance, Delivery Monitor, Ops Insight.
- Analytics/reporting read models; owner KPI dashboards.
- Remaining business-os docs; SOP index → automated workflows.
- Extract any module to a real microservice **only if** measurement says it needs to be.

### Sequencing rationale

| Decision | Why |
|---|---|
| Revenue path before sales path | Getting paid is the hardest, most audited, most integration-heavy flow. Do it while the codebase is small. |
| No AI until Phase 4 | Agents need entities to act on, an approval layer to gate them, and an audit log to record them. All three ship in Phases 1–2. Building agents first means building them twice. |
| One agent, then measure | The safe path to autonomy is earning it with evidence, not asserting it in a prompt. |
| Mobile last | `apps/mobile/README.md` already says mobile is presentation-only. It cannot be built before the APIs it presents. |

---

## 8. Risks

Ordered by expected damage.

### 🔴 R1 — Building on unwritten business rules
**Risk:** All ten business-os docs are empty. Engineering will invent pricing, approval thresholds, data-retention and escalation rules in code, where Finance, Legal and Ops cannot review them.
**Impact:** Rework across services; incorrect invoicing; approval flows that don't match how the business actually operates.
**Mitigation:** Phase 0 gates on `02`, `07` and `08` being written. Encode rules as **configuration** (Section 6.1) so the business can change them without a deploy.

### 🔴 R2 — AI agents acting beyond their authority
**Risk:** `08-ai-agent-responsibilities.md` is empty. Agents that draft proposals, message clients and generate invoices could send a wrong quote to a client, message the wrong person, or issue a bad invoice — at machine speed and volume.
**Impact:** Financial loss, legal exposure, client trust destroyed by a single incident.
**Mitigation:** Write the authority charter before agent code. Enforce it in the **authorization layer** (scoped tokens that cannot express forbidden actions), not in prompts. Every agent action through `approval-service`. Kill switch per agent. Phase 4 ships exactly one low-risk agent.

### 🔴 R3 — Multi-tenancy retrofitted
**Risk:** "Multi-tenant" is asserted once in the README and designed nowhere. Building single-tenant and adding tenancy later means touching every table, query, policy and endpoint.
**Impact:** Effectively a rewrite; worst case a cross-tenant data leak in production.
**Mitigation:** Decide in Phase 0 (**Question 1**). If multi-tenant: `tenant_id` + RLS from the first migration, plus a CI test that asserts cross-tenant reads fail.

### 🟠 R4 — Premature microservices
**Risk:** Four network-separated services with no platform team and an undefined data model.
**Impact:** Distributed transactions across the revenue path; 4× operational overhead; boundaries frozen before the domain is understood.
**Mitigation:** Modular monolith with enforced import boundaries (Section 6.2). Extract on evidence.

### 🟠 R5 — Specification paralysis
**Risk:** The repo is 5 commits of documentation with zero code, and the backlog's 42 items are themselves mostly documents. It is possible to complete the entire backlog and have nothing running.
**Impact:** Months elapse, no validated learning, momentum lost.
**Mitigation:** Phase 0 is capped at one week and produces *decisions*. From Phase 1, every phase ends in working software. Write specs for the slice you are about to build, not for slices you aren't.

### 🟠 R6 — Unbounded AI cost
**Risk:** No budget, quota, or cost telemetry anywhere. SAI-005's telemetry list omits tokens and spend.
**Impact:** Unit economics silently inverted — an agency plan costing more in inference than it charges.
**Mitigation:** Per-tenant and per-agent token budgets enforced in `ai-orchestrator`. Cost per lead / per project as a tracked metric from day one. Alert on anomalies.

### 🟠 R7 — Silent prompt regressions
**Risk:** No eval harness. A prompt edit changes production behaviour with no test to catch it.
**Impact:** Lead scoring quality degrades unnoticed; agent output drifts.
**Mitigation:** Golden datasets per agent; evals in CI on prompt change; prompts immutable once released and versioned by content hash.

### 🟡 R8 — External integration fragility
**Risk:** Razorpay, WhatsApp and LLM providers all have rate limits, outages and approval processes. **WhatsApp message templates require Meta approval with real lead time** and enforce a 24-hour customer-service window — cadence automation cannot ignore this.
**Mitigation:** All external calls through queued, retrying, idempotent workers. Circuit breakers. Start WhatsApp template approval early in Phase 4. Email fallback for every WhatsApp path.

### 🟡 R9 — Data protection and compliance
**Risk:** The system stores client PII, contracts and payment data. India's **DPDP Act** applies if the market is India (as the integrations suggest); GDPR if EU clients are served. `02 §4` (client data handling) is empty.
**Mitigation:** Decide jurisdiction in Phase 0. Data classification, retention and deletion rules in `02`. RLS + encryption at rest. Never send PII to an LLM without an explicit, documented rule (this belongs in `08`).

### 🟡 R10 — Four frontends, one team
**Risk:** owner, admin, client and mobile is a large surface. Divergence and duplicated effort are likely.
**Mitigation:** `packages/ui` built properly and early. Consider merging owner + admin behind role-based routing until the personas demonstrably diverge. Mobile deferred to Phase 6.

### 🟡 R11 — No named owners
**Risk:** Every business-os doc says `Owner: <TBD>`. The roadmap makes owners mandatory. Unowned documents don't get written.
**Mitigation:** Assign a named owner per document in Phase 0. `CODEOWNERS` (FND-001) for code.

### 🟡 R12 — Human approval becomes the bottleneck
**Risk:** If agents generate proposals faster than humans can review them, the approval queue becomes the constraint the automation was meant to remove.
**Mitigation:** Design the approval **experience**, not just the service — batching, confidence-based auto-approval thresholds, progressive autonomy as measured agreement rates rise. Track *time-in-approval-queue* as a product metric.

---

## 9. Questions Before Development

Grouped, with the highest-leverage first. **Q1–Q4 block Phase 0.**

### A. Product & market — *blocking*

1. **Is AgencyOS a SaaS product sold to many agencies, or the internal system for one agency (yours)?** This determines multi-tenancy, auth, pricing and roughly half the roadmap. The README says "multi-tenant" but nothing else in the repo reflects it.
2. **If multi-tenant: is a tenant an *agency*, or a *client of an agency*?** These produce very different data models.
3. **What is the single outcome that makes v1 a success?** Is my Section 1.4 definition right, or is the real goal narrower (e.g. "AI qualifies leads so the owner stops doing it")?
4. **Which geography and legal jurisdiction?** Razorpay + WhatsApp strongly imply India — confirm, because it drives DPDP compliance, currency, tax/GST on invoices, and payment options.

### B. Business rules — *needed for Phase 0/1*

5. **Who writes the ten business-os documents, and by when?** Engineering can draft strawmen for review, but Finance/Legal/Ops must own the content. Should I draft `02`, `07` and `08` for your review?
6. **Is billing milestone-based, hourly, retainer, or a mix?** Doc 06 implies milestones; `project-service` mentions "time tracking hooks." Hourly billing adds a whole timesheet subsystem currently absent everywhere.
7. **What approval levels actually exist today?** Who signs off a proposal, a deliverable, an invoice, a refund, a scope change? This is the direct input to `approval-service`.

### C. AI scope & safety — *needed before Phase 4*

8. **Why two AI providers?** Is Anthropic + OpenAI a deliberate failover/routing strategy, or leftover optionality? I recommend one primary (Claude) unless there's a stated reason.
9. **Which agent should ship first?** I recommend Lead Qualifier (lowest blast radius). Do you have a different priority — e.g. Client Comms, because WhatsApp response time is the real pain?
10. **What may an agent do without a human?** Concretely: may it send a WhatsApp message to a client? Generate an invoice? Change a project deadline? My default is "none of these," and I'd like that confirmed or amended.
11. **What is the monthly AI budget per tenant?** Needed to set quotas and validate unit economics before scale.

### D. Technical decisions — *needed for Phase 1*

12. **Do you accept the modular-monolith-first recommendation (Section 6.2), keeping `services/*` as bounded modules in one deployable, with `ai-orchestrator` separate?** This contradicts the README's "microservices" wording, so I want it explicitly agreed before writing structure.
13. **Is Supabase confirmed as the platform** (Postgres + Auth + Storage + RLS), or is it a placeholder? RLS-based tenancy assumes yes.
14. **Is TypeScript/NestJS/Next.js confirmed?** The READMEs say "suggested" and "intentionally stack-agnostic."
15. **Is Flutter mobile actually in v1 scope,** or can it be deferred to Phase 6 as I've proposed?

### E. Team & process

16. **How many engineers, and what is the target v1 date?** My roadmap assumes a small team (2–4) over ~5 months. Very different plans follow from "solo founder" vs "team of eight."
17. **Should the backlog be restructured** from its current spec-oriented form into vertical-slice delivery tasks (Section 5.4 / Section 7)?
18. **Is `main`-with-PRs the workflow,** and do you want branch protection + CI as a Phase 1 deliverable (FND-003 currently defers it)?

---

## 10. Summary

AgencyOS is a well-organized, deliberately code-free scaffold for an ambitious idea: **encode an agency's operating procedure as software, then let AI agents run the routine work under human approval.** The folder structure is sound, the documentation-first instinct is right, and the three architectural principles already established around AI — single choke point, versioned prompts, scoped agent tokens — are genuinely good.

The gap is that **the scaffold contains no decisions.** Ten business documents are empty templates; zero ADRs exist despite four being prescribed; no entity, contract, or agent has been defined; and the "implementation backlog" is, on inspection, a specification backlog that could be completed in full while producing nothing that runs.

My recommendation is to spend one week converting open questions into decisions (Phase 0), then abandon the write-all-specs-first approach in favour of **vertical slices**: build the revenue path end-to-end, then the sales path, then introduce exactly one AI agent with full telemetry and approval gating — and expand agent autonomy only on measured evidence.

Two decisions block everything else: **the multi-tenancy question (Q1/Q2)** and **the AI agent authority charter**. Neither is a large amount of writing. Both are extremely expensive to get wrong later.

**No code has been written. Awaiting your approval and your answers to Section 9 before proceeding.**
