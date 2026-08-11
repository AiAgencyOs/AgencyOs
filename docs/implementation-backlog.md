# Implementation Backlog — AgencyOS

> **SUPERSEDED (2026-08-11).** This backlog was written before the system was
> built and assumes a multi-service layout (`apps/`, `services/`, `packages/`)
> that this repository does not use. It is retained as history. The current plan
> is [`AGENCYOS_MASTER_DEVELOPMENT_PLAN.md`](../AGENCYOS_MASTER_DEVELOPMENT_PLAN.md);
> do not implement from this file.

This backlog breaks AgencyOS into small implementation tasks (1–3 hours each). Tasks are grouped into Epics and written so they are implementation-ready for an AI developer (Claude Code) or an engineer. No code or architecture files are created by this change — this file is planning-only.

Conventions
- Task ID format: <EPIC_ABBR>-###
- Priority: P0 (highest), P1, P2
- Estimated Time: hours (1–3)
- Dependencies: by Task ID

---

Epic: Foundation (FND)

FND-001
- Title: Add repository CODEOWNERS placeholder
- Description: Create a CODEOWNERS file listing default owners for apps/, services/, packages/, and docs/ as placeholders (no email secrets) so ownership is explicit for PRs.
- Dependencies: none
- Definition of Done: CODEOWNERS file exists at repository root with valid paths and placeholder owner entries.
- Priority: P0
- Estimated Time: 1h

FND-002
- Title: Add CONTRIBUTING.md stub
- Description: Add a one-page CONTRIBUTING.md with PR review flow, branching policy, and commit message conventions as placeholders.
- Dependencies: none
- Definition of Done: CONTRIBUTING.md added at repo root with sections: PR process, commit message style, code owners, issue templates reference.
- Priority: P0
- Estimated Time: 1.5h

FND-003
- Title: Confirm branch protection checklist (task)
- Description: Create a checklist task item documenting branch protection rules required (no enforcement now) to guide future setup.
- Dependencies: FND-001, FND-002
- Definition of Done: A checklist added to docs/implementation-backlog.md (task entry) and linked from README; the checklist lists required protections to request from repo admins.
- Priority: P1
- Estimated Time: 1h

FND-004
- Title: Populate root .env.example with usage notes
- Description: Expand existing .env.example with comments describing each variable usage and expected format (no secrets added).
- Dependencies: none
- Definition of Done: .env.example includes a short comment per variable explaining purpose and expected format.
- Priority: P0
- Estimated Time: 1h

FND-005
- Title: Create issue templates for operational requests
- Description: Add an ISSUE_TEMPLATE for ops/infra requests (changes to infra, secrets rotation) to the .github/ISSUE_TEMPLATE directory.
- Dependencies: none
- Definition of Done: ops_request.md present under .github/ISSUE_TEMPLATE with fields for impact, rollback plan, and required approvals.
- Priority: P1
- Estimated Time: 1h

FND-006
- Title: Inventory third-party integrations list
- Description: Create a small YAML/JSON inventory (as a task artifact) listing external integrations (Supabase, OpenAI, Anthropic, Razorpay, WhatsApp) and required env vars.
- Dependencies: .env.example
- Definition of Done: file at docs/integrations-inventory.yaml with entries and required env variable names.
- Priority: P1
- Estimated Time: 1.5h

---

Epic: CRM (CRM)

CRM-001
- Title: Define lead entity fields (implementation task)
- Description: Create a minimal lead entity definition (field names, types, required flags) suitable for immediate implementation in a database migration.
- Dependencies: FND-006
- Definition of Done: A one-page spec (fields + types + validation rules) is added as a task artifact; ready to be converted into a migration.
- Priority: P0
- Estimated Time: 2h

CRM-002
- Title: Implement leads REST CRUD endpoints (contract-ready)
- Description: Break into small implementation tasks (one per endpoint). This task: implement POST /leads handler stub, request validation, and response schema.
- Dependencies: CRM-001
- Definition of Done: POST /leads contract: request and response JSON schema defined; handler scaffold created (no external libs installed) — note: this is a planning task; actual code task would implement.
- Priority: P0
- Estimated Time: 2.5h

CRM-003
- Title: Implement lead classification job (batch)
- Description: Implement a background job spec to classify leads by score; include input, output, and scheduling placeholder.
- Dependencies: CRM-001
- Definition of Done: Job spec with example payloads, retry policy, and IDempotency notes is written for implementation.
- Priority: P1
- Estimated Time: 1.5h

CRM-004
- Title: Build lead-to-opportunity conversion checklist
- Description: Define exact steps and validations required to promote a lead to an opportunity in CRM when triggered by sales.
- Dependencies: CRM-001
- Definition of Done: Checklist doc entry exists with criteria, data mappings, and required approvals.
- Priority: P1
- Estimated Time: 1h

CRM-005
- Title: Implement contact synchronization contract with client-portal
- Description: Specify the contract (events or API) for syncing contact changes between CRM and client-portal.
- Dependencies: CRM-001
- Definition of Done: Event schema or API spec stub with payload examples and idempotency rules.
- Priority: P2
- Estimated Time: 2h

---

Epic: Sales AI (SAI)

SAI-001
- Title: Prompt retrieval endpoint spec for ai-orchestrator
- Description: Define a minimal endpoint contract for retrieving prompt templates by key and version (input: key, version; output: prompt text, metadata).
- Dependencies: FND-006, CRM-001
- Definition of Done: Endpoint contract (request/response JSON) drafted for implementation.
- Priority: P0
- Estimated Time: 1.5h

SAI-002
- Title: Create prompt validation rules
- Description: Define rules to validate prompt templates (length, placeholders, banned content) before use by agents.
- Dependencies: SAI-001
- Definition of Done: List of validation rules and sample validation failure responses.
- Priority: P0
- Estimated Time: 1h

SAI-003
- Title: Define scoring output schema for lead-scoring model
- Description: Specify the JSON schema for model outputs (score, reasons, tags) to standardize downstream logic.
- Dependencies: CRM-001, SAI-001
- Definition of Done: JSON schema file with examples added to docs/artifacts for implementation.
- Priority: P0
- Estimated Time: 1h

SAI-004
- Title: Implement agent-to-service auth spec
- Description: Define how AI agents authenticate to services (short-lived tokens, scope), without implementing tokens themselves.
- Dependencies: FND-006
- Definition of Done: Auth spec document with token lifecycle, scopes, and rotation recommendations.
- Priority: P1
- Estimated Time: 2h

SAI-005
- Title: Add telemetry events list for Sales AI interactions
- Description: Enumerate events (prompt.sent, response.received, action.taken) and payload fields for observability.
- Dependencies: SAI-001
- Definition of Done: events.yaml file with event names and payload examples.
- Priority: P1
- Estimated Time: 1.5h

---

Epic: Project Management (PM)

PM-001
- Title: Define project entity fields
- Description: Specify minimal project model fields (id, name, client_id, status, start_date, end_date, template_id).
- Dependencies: CRM-001, FND-006
- Definition of Done: project entity spec document ready for migration creation.
- Priority: P0
- Estimated Time: 1.5h

PM-002
- Title: Create task entity field spec
- Description: Define task fields (id, project_id, title, description, assignee_id, status, estimate_hours, due_date).
- Dependencies: PM-001
- Definition of Done: task entity spec with validation and status enum.
- Priority: P0
- Estimated Time: 1h

PM-003
- Title: Milestone to payment mapping spec
- Description: Define how project milestones map to Payment Milestones (IDs, acceptance criteria reference) for finance integration.
- Dependencies: PM-001, FND-006
- Definition of Done: mapping table with example JSON structures.
- Priority: P1
- Estimated Time: 2h

PM-004
- Title: Create a minimal webhook contract for project status changes
- Description: Define payload and security expectations for webhooks sent to client systems on status change.
- Dependencies: PM-001
- Definition of Done: webhook JSON schema and HMAC signing guidance included.
- Priority: P1
- Estimated Time: 2h

PM-005
- Title: Implement sprint template checklist for project kickoff
- Description: Create a checklist document with required artifacts to start a project sprint (backlog, acceptance criteria, owner assignments).
- Dependencies: PM-001
- Definition of Done: checklist added to project artifacts; labeled ready for automation.
- Priority: P2
- Estimated Time: 1h

---

Epic: Design (DSN)

DSN-001
- Title: Create design tokens spec for packages/ui
- Description: Define a minimal set of design tokens (colors, spacing, typography scale) as JSON schema for future consumption.
- Dependencies: none
- Definition of Done: tokens.json schema with sample values in docs/artifacts.
- Priority: P1
- Estimated Time: 2h

DSN-002
- Title: Create component checklist for ProjectCard UI
- Description: Enumerate props, states, and accessibility requirements for a ProjectCard component used across dashboards.
- Dependencies: DSN-001, PM-001
- Definition of Done: checklist with prop definitions, visual states, and ARIA requirements.
- Priority: P1
- Estimated Time: 1.5h

DSN-003
- Title: Create iconography inventory task
- Description: List categories of icons needed (actions, status, payments) and file format recommendations.
- Dependencies: DSN-001
- Definition of Done: icons-inventory.yaml with categories and usage notes.
- Priority: P2
- Estimated Time: 1h

DSN-004
- Title: Define accessibility baseline requirements
- Description: Document baseline accessibility standards (contrast, keyboard nav, aria labeling) that UIs must meet.
- Dependencies: DSN-001
- Definition of Done: accessibility.md with checklist items and acceptance thresholds.
- Priority: P1
- Estimated Time: 2h

---

Epic: Development (DEV)

DEV-001
- Title: Add TypeScript compiler options proposal (task)
- Description: Draft recommended tsconfig options to enforce strict types in services/packages (no file created yet; outline only).
- Dependencies: FND-002
- Definition of Done: tsconfig proposal section with key flags and rationale.
- Priority: P1
- Estimated Time: 1.5h

DEV-002
- Title: Create unit test checklist for service endpoints
- Description: Define required unit test coverage standards, example test cases for CRUD endpoints, and mocking strategy.
- Dependencies: CRM-002, PM-002
- Definition of Done: tests-checklist.md with examples and mocking notes.
- Priority: P0
- Estimated Time: 1.5h

DEV-003
- Title: Implement shared error response schema
- Description: Define a standard error response JSON schema and common error codes to be used by all services.
- Dependencies: DEV-002
- Definition of Done: error-schema.json with code, message, details, and correlation_id fields.
- Priority: P0
- Estimated Time: 1h

DEV-004
- Title: Create logging field spec
- Description: Define structured logging fields (timestamp, level, service, trace_id, user_id, request_id) and sampling guidance.
- Dependencies: FND-006
- Definition of Done: logging-spec.md with field descriptions and examples.
- Priority: P1
- Estimated Time: 1.5h

DEV-005
- Title: Define API pagination and list responses schema
- Description: Create a small spec for paginated responses (cursor-based and page-based examples) that services should follow.
- Dependencies: docs/api/README.md (reference)
- Definition of Done: pagination-spec.md with sample responses and headers.
- Priority: P0
- Estimated Time: 2h

---

Epic: QA (QA)

QA-001
- Title: Define E2E test checklist for onboarding flow
- Description: Enumerate E2E test scenarios for lead -> opportunity -> project onboarding with clear steps and assertions.
- Dependencies: CRM-002, PM-001
- Definition of Done: e2e-onboarding-checklist.md with test cases and expected outcomes.
- Priority: P0
- Estimated Time: 2.5h

QA-002
- Title: Create regression test pack index
- Description: List critical regression scenarios to run before releases (payments, approvals, project status transitions).
- Dependencies: PM-003, 06-payment-milestones.md (business)
- Definition of Done: regression-index.md listing scenarios and priority for test automation.
- Priority: P1
- Estimated Time: 1.5h

QA-003
- Title: Specify test data seeding examples
- Description: Provide example JSON fixtures for common entities (users, leads, projects) used by tests.
- Dependencies: CRM-001, PM-001
- Definition of Done: fixtures/ directory example file set documented in the backlog (no code added).
- Priority: P1
- Estimated Time: 2h

QA-004
- Title: Define acceptance criteria template for feature tests
- Description: Create a small template that maps acceptance criteria to test steps and expected assertions.
- Dependencies: none
- Definition of Done: acceptance-template.md available for authors to use when writing features.
- Priority: P0
- Estimated Time: 1h

---

Epic: Finance (FIN)

FIN-001
- Title: Define invoice schema for Razorpay integration
- Description: Create a minimal invoice JSON schema to be used by services when creating invoices (no implementation).
- Dependencies: FND-006, 06-payment-milestones.md (business)
- Definition of Done: invoice-schema.json with fields: invoice_id, amount, currency, due_date, milestone_id, client_id.
- Priority: P0
- Estimated Time: 1.5h

FIN-002
- Title: Payment reconciliation checklist
- Description: Document reconciliation steps for matching Razorpay events to invoices and handling failures.
- Dependencies: FIN-001
- Definition of Done: reconciliation.md with steps and example payloads to be used by finance engineers.
- Priority: P1
- Estimated Time: 2h

FIN-003
- Title: Define currency and rounding rules
- Description: Specify currency handling rules (smallest unit usage, rounding rules, supported currencies) for services.
- Dependencies: FIN-001
- Definition of Done: currency-rules.md with examples for display vs accounting values.
- Priority: P2
- Estimated Time: 1h

FIN-004
- Title: Refund and dispute handling spec
- Description: Outline the steps for processing refunds and disputes and which service owns the flow.
- Dependencies: FIN-001, 07-approval-rules.md (business)
- Definition of Done: refunds-spec.md with roles, data required, and SLA expectations.
- Priority: P1
- Estimated Time: 2.5h

---

Epic: Deployment (DEP)

DEP-001
- Title: Create container image naming convention document
- Description: Define how container images will be tagged and named (service/name:semver or commit-sha) for CI/CD later.
- Dependencies: none
- Definition of Done: images.md with naming examples and recommended tagging strategy.
- Priority: P2
- Estimated Time: 1h

DEP-002
- Title: Create environment matrix for deployments
- Description: Define required environments (dev, staging, canary, prod) and their differences (secrets, scaling targets).
- Dependencies: none
- Definition of Done: environments.md listing environments, responsibility, and access notes.
- Priority: P1
- Estimated Time: 1.5h

DEP-003
- Title: Define healthcheck contract for services
- Description: Specify a minimal /health endpoint response format and checks (db connectivity, queue connectivity) for each service.
- Dependencies: DEV-003
- Definition of Done: healthcheck-spec.md with JSON example and status codes.
- Priority: P0
- Estimated Time: 1h

DEP-004
- Title: Rollback playbook outline
- Description: Draft a short rollback playbook describing steps to roll back a deployment and key considerations (data migrations, DB rollbacks).
- Dependencies: DEP-002
- Definition of Done: rollback-playbook.md with checklist and stakeholders to notify.
- Priority: P1
- Estimated Time: 2h

DEP-005
- Title: Define service observability signals list
- Description: Enumerate key metrics, logs, and traces each service must emit (errors, latency, saturation metrics) for monitoring.
- Dependencies: DEV-004
- Definition of Done: observability-signals.md listing metrics and example thresholds.
- Priority: P0
- Estimated Time: 2h

---

Notes and Usage
- These tasks are intentionally small (1–3 hours) so Claude Code can pick individual tasks and implement them incrementally.
- Tasks that require documents reference business docs by filename (e.g., docs/business-os/06-payment-milestones.md) but do not create or modify them.
- When implementing, prefer idempotent changes and create PRs that reference the Task ID in the branch name and PR description.

If you want, I can:
- A) Commit this backlog file to docs/implementation-backlog.md (ready to push).
- B) Split a specific Epic into even smaller tasks (for example, break CRM-002 into 3x 1-hour code tasks).
- C) Generate issue/PR templates mapping these Task IDs to GitHub issue templates (planning-only — will not create issues unless asked).

Choose A to commit and push the backlog to the repository, or choose B/C with details.  