# Documentation Roadmap — Documentation-first Development for AgencyOS

> **SUPERSEDED (2026-08-11).** This roadmap plans a documentation set that was
> never produced, for a per-service architecture this repository does not use.
> The documents that exist and are maintained are listed in
> [`AGENCYOS_MASTER_DEVELOPMENT_PLAN.md`](../AGENCYOS_MASTER_DEVELOPMENT_PLAN.md) §9.
> Retained as history.

Purpose

This roadmap defines a documentation-first approach for AgencyOS. It prescribes which documents to produce first, how documents depend on one another, a recommended writing order, which documents Claude Code (the development AI) should consult during implementation, and a clear separation between business and engineering documents.

Principles

- Documentation-first: write contracts, acceptance criteria and architecture before implementation begins.
- Single source of truth: docs in /docs are authoritative; keep them minimal, reviewable, and versioned.
- Incremental and reviewable: produce concise drafts (1–2 pages) and iterate via ADRs and PR review.
- Clear owners and acceptance: each document must list an owner, reviewers, and acceptance criteria.

1) Which documents should be written first

Priority 0 (write immediately — foundation for everything)
- docs/business/README.md — Business context, value proposition, personas, success metrics, high-level user journeys, acceptance criteria.
- docs/architecture/README.md — High-level architecture, primary components, integration boundaries, deployment targets, scalability constraints.
- docs/api/README.md — API design guidance and the canonical API contract entry point (link to OpenAPI when available). Define authentication, error model, pagination, and versioning strategy.

Priority 1 (after Priority 0; required to implement services safely)
- docs/database/README.md — Canonical data model, key tables/entities, ownership of records, and migration strategy.
- docs/agents/README.md — AI agent responsibilities, prompt lifecycle, security, and rate-limiting expectations (especially for ai-orchestrator).
- docs/decisions/README.md + initial ADR(s) — Record the first 3–5 architecture decisions (e.g., monorepo vs multi-repo, data ownership, model provider choices).

Priority 2 (service and app-level specs)
- docs/backend/README.md — Service communication patterns, eventing, auth/authorization, observability requirements, SLA expectations.
- docs/frontend/README.md — UX and frontend conventions, routing, state management guidance, accessibility requirements.
- docs/api/ (detailed per-service API specs) — OpenAPI specs or contract-first stubs for sales-service, project-service, approval-service, ai-orchestrator.

Priority 3 (operational, delivery and QA)
- docs/testing/README.md — Testing strategy (unit, integration, E2E), test data strategy, CI guards (lint/tests), and quality gates.
- docs/deployment/README.md — Deployment topology, environment matrix, release strategy, rollback plan (conceptual; no infra code yet).
- docs/database/migrations-guidelines.md — Detailed migration workflow and rollback guidance.

Priority 4 (product planning and process)
- docs/roadmap/README.md — Product roadmap and milestone definitions.
- docs/sprints/README.md — Sprint templates, ceremonies, and deliverable format guidelines.

2) Dependency between documents

- docs/business -> docs/architecture
  - Business requirements drive the architecture: ownership, personas, and success metrics inform component boundaries, data retention, and SLAs.

- docs/architecture -> docs/api, docs/database, docs/agents, docs/backend, docs/frontend
  - Architecture defines integration points, which the API and DB docs must codify. Agents design follows architecture constraints.

- docs/api + docs/database -> per-service API specs and schema files
  - The contract (API) and data model (DB) create the exact inputs/outputs developers and Claude Code will implement.

- docs/decisions (ADRs) depend on architecture and business docs but are authoritative for chosen trade-offs.

- docs/testing depends on API, backend, and frontend docs to know what to test.

- docs/deployment depends on architecture and backend docs.

Dependency graph (simple ASCII)

  [business]
      |
      v
  [architecture] --> [decisions/ADRs]
      |                ^
      v                |
[api] <---> [database] |
  |           |        v
  v           v    [backend] <---> [frontend]
  |                        |
  v                        v
[per-service-specs]    [testing]
                           |
                           v
                      [deployment]

3) Recommended writing order (practical, minimal-waste sequence)

Phase A — Foundation (1–2 days, small drafts)
1. docs/business/README.md (short: problem, personas, success metrics, top 3 user journeys)
2. docs/architecture/README.md (1–2 page system diagram, components, boundaries)
3. docs/decisions/0001-choose-repo-strategy.md (ADR: monorepo vs multi-repo) and 0002-data-ownership.md
4. docs/api/README.md (API style guide + placeholder for OpenAPI links)

Phase B — Contracts and models (2–4 days)
5. docs/database/README.md (core domain entities and ownership)
6. Per-service API skeletons in docs/api/ (OpenAPI stubs or contract descriptions for each service)
7. docs/agents/README.md (agent responsibilities and prompt lifecycle)

Phase C — Implementation guidance (2–3 days)
8. docs/backend/README.md (communication patterns, auth)
9. docs/frontend/README.md (UI conventions and UX notes)
10. docs/testing/README.md (test strategy aligned with contracts)

Phase D — Operations & product (ongoing)
11. docs/deployment/README.md (deployment concepts)
12. docs/roadmap/README.md and docs/sprints/README.md

4) Which documents Claude Code should use during development

When Claude Code is asked to scaffold code, generate stubs, or propose implementations, prefer this prioritized document set as inputs (in order):

1. docs/api/ (service OpenAPI or API contract) — canonical: Claude Code MUST follow the contract.
2. docs/database/ (entity definitions and field constraints) — to generate DB schema, migrations, and DTOs.
3. docs/architecture/ (component boundaries and integration patterns) — to decide where code belongs and chosen communication patterns.
4. docs/agents/ (prompt templates and agent workflow) — for ai-orchestrator integrations and prompt usage rules.
5. docs/backend/ and docs/frontend/ (implementation conventions) — coding conventions, auth, logging, observability hooks.
6. docs/testing/ (how to test) — tests to generate alongside code.
7. docs/decisions (ADRs) — to ensure code follows approved trade-offs.
8. docs/business/ (acceptance criteria and user journeys) — for feature completeness and user-facing expectations.

Operational guidance for Claude Code
- If a conflict exists between docs, ADRs in docs/decisions are authoritative. Claude Code should raise an inconsistency issue when business and architecture docs conflict.
- Claude Code should never access or require secrets; it should use environment variable placeholders in docs/.env.example.

5) Business documents vs Engineering documents

Classifying top-level docs

Business documents (primary audience: PMs, stakeholders, product owners)
- docs/business/README.md
- docs/roadmap/README.md
- docs/sprints/README.md
- docs/agents/README.md (partially business — agent use-cases)

Engineering documents (primary audience: engineers, DevOps, AI engineers)
- docs/architecture/README.md
- docs/api/README.md and per-service API specs
- docs/database/README.md
- docs/backend/README.md
- docs/frontend/README.md
- docs/testing/README.md
- docs/deployment/README.md
- docs/decisions/ (ADRs)

Hybrid / cross-functional (both audiences should read)
- docs/agents/README.md (technical and product constraints)
- docs/decisions/ (business and engineering trade-offs)
- docs/roadmap/README.md (product & engineering alignment)

6) Document templates and minimal required sections

For consistency, each new doc should include these front-matter fields and sections:

- Title
- Owner: Name / role
- Reviewers: role list
- Status: draft / in-review / approved
- Last updated: ISO date
- Summary (1–2 sentences)
- Problem / motivation
- Scope (what is in/out)
- Requirements / acceptance criteria (clear, testable)
- Dependencies (other docs or decisions)
- Links / references (ADRs, OpenAPI files, diagrams)

7) Suggested initial ADRs (create immediately)
- 0001-repo-structure.md — monorepo vs multi-repo, workspace strategy
- 0002-data-ownership.md — which service owns which tables/entities
- 0003-api-versioning.md — semantic versioning for APIs
- 0004-ai-provider.md — allowed AI providers & key handling

8) Ownership, review cadence, and lifecycle

- Owners: assign at least one owner per document (team role). Owner is responsible for creation and updates.
- Reviewers: require at least one engineering and one product reviewer for architecture or API docs.
- Cadence: review docs as part of the sprint planning — update ADRs when trade-offs change.
- PR process: docs edited via PRs, change log in ADRs, link to impacted services in PR description.

9) Practical tips for execution

- Start with short drafts (1 page) and expand only when needed.
- Use diagrams (Mermaid/PlantUML) committed as text in docs/diagrams/ for version control.
- Store OpenAPI YAML under docs/api/openapi/ and keep them canonical; use code generation downstream when ready.
- Mark any in-progress doc as "Draft" and include a clear TODO section.
- Use the docs/decisions directory for ADRs; name them with zero-padded numbers for chronological order.

10) Suggested immediate next actions (what to write this week)
- Draft docs/business/README.md (owner: Product Lead) — include top 3 user journeys and acceptance criteria.
- Draft docs/architecture/README.md (owner: Architect) — one-page system diagram and component responsibilities.
- Add ADR 0001-repo-structure.md and 0002-data-ownership.md in docs/decisions/.
- Create an OpenAPI stub for ai-orchestrator and one core service (docs/api/openapi/ai-orchestrator.yaml).

If you want, I will create the documentation roadmap file at docs/documentation-roadmap.md and optionally create the initial ADR stubs and OpenAPI stub files as empty templates. You instructed "Do NOT create any code" and "Do NOT setup CI/CD" etc. — I will only create documentation files if you give me permission to push them. 
