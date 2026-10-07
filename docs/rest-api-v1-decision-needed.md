# REST `/api/v1` surface: the decision needed before it can be built

Rows: P1-MP3-027, P1-API-001, P1-API-003, P1-API-008, P1-API-009, P1-API-010, P1-API-026 (and the "published API contract" half of P1-GAP-079).
Source: Technical / API / Data Contract Specification, sections 4, 5, 9, 17, 25, 26 and 27. Read in full on 2026-12-04.

**Status: not built, on purpose.** Section 9 names thirteen endpoints and their purpose, and sections 4 and 5 list the fields of a request and response envelope. That is a list of paths. It does not say who calls them, how the caller proves who it is, what an HTTP caller may do that an in-process agent may not, or how the spec's fourteen task states map onto the ten the database holds. Building the surface now would mean inventing those answers in code, which would make them the architecture. This note records what the owner (or the architect) has to decide. Once those are answered, the build is mechanical and the second table says how.

The spec itself labels section 9 "Recommended" and titles it "Phase 1 **Internal** API Surface". The checklist (PH1-FND-004) marks the REST layer `[-]` (not required for Phase 1 acceptance). Nothing in the product is blocked on it today: every operation the endpoints name already has a governed door (second table).

## The decisions

**D1. Who is the caller, and how does it authenticate?** Section 26 says "authenticate API caller" and does not choose a scheme. Today the product has exactly two kinds of principal: a signed-in person (a session cookie; every page, server action and database door assumes it, and RLS keys on the person's organization and role) and the service role (the job runner and webhooks, with no person). A REST endpoint called from a script or another service has neither. The options are:
 a. Session cookie only: the API is a typed facade for the web app itself. No new credential. Not callable from outside a browser session.
 b. Per-organization API keys (a new credential type): needs a table, hashing, rotation, scope, an audit trail and a revoke path, and a way to turn a key into a person-or-role so RLS and the capability checks still apply.
 c. Signed service tokens for agent-to-agent calls: needs a trust decision (D2).
Nothing in the spec chooses between these. The choice sets the security model of the whole surface.

**D2. May a caller over HTTP submit an agent result, dispatch a task, or publish an event?** `POST /agent-tasks/{id}/result`, `/dispatch` and `POST /events` let a caller outside the runner write into the workflow. The spec's own invariants say agent output is untrusted until validated, state changes only after validation, and a result received is not an acceptance. Today a result can only arrive from the in-process runner, which holds the envelope, the schema and the idempotency key. An HTTP door is a second way in, and it is the one place a forged result, a replayed dispatch or an injected event could cross the trust boundary. Decide whether these three are in scope at all (a read-only and `retry`/`cancel` surface would not need this), and if they are, who may call them and what is re-verified server-side.

**D3. Task state vocabulary.** Section 8 recommends fourteen states (CREATED ... CLOSED, plus six exceptions). The database holds ten handoff statuses (`queued, accepted, running, needs_input, awaiting_approval, rejected, failed_retryable, failed_permanent, completed, cancelled`) and the task board derives nine display states from them (`ai.p1o_workflow_task_board`). The response of `GET /agent-tasks/{id}` has to name a state. Decide whether the API exposes the stored statuses, the nine board states, or the spec's fourteen (which would need a derived mapping and a decision on states the product has no event for: `VALIDATING`, `DISPATCHED`, `ACKNOWLEDGED`, `HANDOFF_READY`, `HANDED_OFF`, `VERIFIED`).

**D4. Is the surface a public contract or an internal one?** Section 25 asks for explicit versions, compatibility periods and documented deprecations. A public `/api/v1` makes every field a promise. Decide the audience (the web app's own use, partner systems, or the agent runner), because that decides the deprecation policy, the changelog and whether a contract test (spec section 30) is a release gate.

**D5. Rate limits and quotas on the API.** Section 27 asks for per-organization throttling and recording of throttled calls. The existing limiter (`core.rate_limit_windows`, `src/lib/security/rate-limit.ts`) is built for four public routes. Decide the budget per caller and per organization for authenticated API traffic.

**D6. The `/webhooks/{provider}` shape.** Section 17 names one generic route. The product has three provider-specific routes (WhatsApp, email, Facebook leads), each with its own signature scheme and all three now writing to the webhook ledger (`core.p13_webhook_events`). Decide whether to keep the specific routes and add a generic alias, or move providers behind the generic one. (Moving them touches the live inbound paths, so it is not a cosmetic change.)

## Endpoint by endpoint: what exists today, and what the build would be

| Spec endpoint | What does it today | If D1-D6 are answered |
|---|---|---|
| `POST /agent-tasks` | `ai.p1o_create_handoff` (admin or runner; contract fields: acceptance criteria, required output schema, idempotency key, priority, dependencies) | thin route calling the same door; needs D1, D3 |
| `GET /agent-tasks/{id}` | `ai.p1o_handoff_packet(handoff_id)` (internal read; masked) | thin read; needs D1, D3 |
| `POST .../dispatch` | the runner claims queued work; there is no separate dispatch step | needs D2: nothing to expose until a "validated, not yet dispatched" state exists (D3) |
| `POST .../result` | the runner records the result after schema validation (`ai.agent_validations`) and the verified completion verdict | needs D2 first; do not build without it |
| `POST .../retry` | `ai.p1o_retry_handoff` (admin; reason required; refused while an effect is uncertain) | thin route; needs D1 |
| `POST .../cancel` | cancel doors for jobs and workflows (`core.cancel_*`); handoff cancel is a status the runner sets | needs a handoff cancel door (small, additive) and D1 |
| `GET .../trace` | `ai.p1o_handoff_packet` plus `/usage/runs/[runId]` and the audit correlation view | thin read; needs D1 |
| `POST /events` | `core.emit_event` (database-side; not callable by a client) | needs D2: publishing an event is a write into the workflow |
| `POST /webhooks/{provider}` | `app/api/webhooks/{whatsapp,email,facebook-leads}` | D6 |
| `GET /quotes/{id}` | `sales.p1o_*` reads and the quotation pages | thin read; D1 |
| `POST /quotes` | `sales.draft_proposal` through the governed workflow (a quote is an approved record, never created by a caller outside it) | D1; the draft door only |
| `POST /approvals` | `approvals.request_approval` (exact-action request) | D1; the caller must not be able to name the approver |
| `POST /approvals/{id}/decision` | `approvals.decide_approval` (a signed-in person with the role the policy names; the owner for payment) | **do not build over HTTP for a non-session caller**: a decision is a human act (D1 option a only) |

Envelope fields (sections 4 and 5): `request_id` and `api_version` do not exist anywhere yet; `correlation_id`, `organization_id`, actor and `idempotency_key` do. Adding `request_id` and `api_version` is trivial once the surface exists and pointless before it.

## What I would recommend, for the decider

This is advice, not a decision. A read-only first slice (`GET /agent-tasks/{id}`, `/trace`, `GET /quotes/{id}`) with session authentication (D1 option a), the stored statuses plus the nine board states (D3), and a version header would give the spec's read side without opening a new trust boundary and without any new credential. `POST /approvals/.../decision` and `/result` should stay off the HTTP surface; both are acts that the product deliberately keeps behind a person or the runner. Everything else follows D1.

## Where this is recorded

The traceability rows above say "decision needed: see docs/rest-api-v1-decision-needed.md". The gaps log for this round lists it under "left open, with the reason".
