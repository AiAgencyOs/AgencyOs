# AgencyOS Phase 1 — Blockers

A blocker is a point where continuing requires a **human decision, a credential, an
external account, or a provider capability** — not a coding decision. Everything else
is work, and work continues.

**None of the blockers below stops the next four Phase 1 units** (G-230, G-225, G-226,
G-227). They are domain, state and idempotency work, verifiable against a local Postgres.

Existing blockers are restated from `docs/roadmap/roadmap.json` and
`docs/deployment/production-readiness.md`, which remain authoritative. BLK-005 is new
and was surfaced by this audit.

---

## BLK-001 — Which AI provider, on whose account (ADM-85)

- **Category** Business decision + credential
- **Requirement** Orchestrator §8 model/provider selection; every agent that calls a model
- **Blocks** PH1-OR-004 (agent activation), the Sales Agent's conversational loop,
  meeting-evidence analysis (PH1-SCH-005)
- **Why** `src/lib/ai/router.ts` registers a provider only when `ANTHROPIC_API_KEY` is
  set. Without it, extraction fails with `AI_PROVIDER_NOT_CONFIGURED` — deliberately,
  so nothing is ever reported as having succeeded without calling a model
- **Already done** Registry, ceilings, cost ledger, autonomy levels, handoff targets and
  the decoder-safe schema layer are all built and tested
- **Required from the owner** The provider choice, the account it bills to, and the key
- **Resume when** ADM-85 is recorded and the key is in the deployment environment

## BLK-002 — Agent activation (ADM-82)

- **Category** Business decision
- **Requirement** Master Plan V3 §7; the five-agent workforce
- **Blocks** PH1-OR-004
- **Why** 15 agent rows are installed, 8 enabled, 13 defined in the registry. Enabling an
  agent is a decision about what may act unwatched, not a code change
- **Depends on** BLK-001
- **Resume when** ADM-82 names which agents are enabled at which autonomy level

## BLK-003 — Meta WhatsApp production access (G-123, G-091, G-122)

- **Category** External account / provider capability
- **Requirement** Master Plan V3 §10; Gap-Closure GC-08
- **Blocks** Live end-to-end verification of the inbound and outbound channel against
  Meta. **Does not block the code** — inbound and outbound are built and verified against
  a local Postgres and a stubbed provider
- **Required** Meta Business verification and agency eligibility, which is an external
  determination this repository cannot make
- **Resume when** the account is verified and a production number is attached

## BLK-004 — Five production environment facts (ADM-60) + Vercel Protection Bypass

- **Category** Deployment configuration
- **Requirement** Master Plan V3 §20; Impl/DoD §27–§28
- **Blocks** External cron, health checks behind the SSO wall, the deployment runbook
  (G-052), and therefore the release/smoke/rollback gate
- **Resume when** the five facts and the bypass token are supplied

## BLK-005 — No calendar / meeting provider has been chosen *(new — this audit)*

- **Category** Business decision + credential
- **Requirement** Scheduler §5 ("query the authoritative configured calendar/availability
  source"), §6.3 (provider event id), §12 (calendar and video-provider integrations)
- **Blocks** The *provider half* of the Scheduler: reading a real calendar, creating a
  real event, obtaining a real meeting link
- **Does NOT block** PH1-SCH-001 (G-225 scheduling domain and state machine),
  PH1-SCH-002's **rule** (G-226 — that a slot may only be offered if it was actually read,
  which is enforceable against an adapter with no provider behind it), or PH1-SCH-003's
  **idempotency** (G-227 — recheck-before-commit and a unique booking key, which is
  exactly the kind of control that must be built and red-proved *before* a provider
  exists, not after)
- **Required from the owner** Which calendar (Google / Microsoft / other), which video
  provider (Meet / Zoom / other), and whose account
- **Resume when** the choice is recorded as an ADM decision and credentials exist
- **Note** The Scheduler PDF is explicit that provider-specific behaviour stays inside an
  adapter (§12, "integration principles"). Building the domain against a provider-neutral
  adapter interface is the specified design, not a workaround — so this blocker delays
  one adapter implementation, not the agent

## BLK-006 — Agent tool dispatch (ADM-99, G-187)

- **Category** Business decision
- **Requirement** Orchestrator §12 tool/permission gate
- **State** Fourteen tools, thirty-eight bindings, zero runtime callers. The boundary
  exists and is tested; whether tools should be dispatched at all is the owner's decision
- **Resume when** ADM-99 is recorded

---

## Decisions this audit needs that are not yet blockers

Recorded so they are not mistaken for code:

- **Lead lifecycle vocabulary** (PH1-SAL-003). Doc 09 §6 names 14 states; the built
  machine has 6 plus `nurture`. Neither vocabulary should be renamed silently. This
  needs an Admin mapping decision before the Phase 1 admin screens can label states
  from the source document.
- **Payment/exception evidence for WON** (PH1-CLS-001 / G-230). The *gate* is not a
  decision — every source document requires one. But **what counts as satisfying it** is:
  whether a verified payment row is required, or an approved no-advance exception, or
  either. The gate was built with the mandatory half (an accepted quotation version) always on
  and the configurable half (payment or approved exception) as a switch that starts off —
  the owner's decision. Until ADM-72 builds a no-advance exception path, a switched-on gate
  is satisfied only by a captured payment.
