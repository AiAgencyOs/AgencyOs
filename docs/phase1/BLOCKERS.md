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

## BLK-001 — AI provider(s), on whose account (ADM-85 — decided 2026-09-12; keys pending)

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
- **Owner decision 2026-09-12 (ADM-85)** Multiple providers behind the router — Anthropic, OpenAI,
  Gemini, Grok, OpenRouter and others — each on the agency's account. One adapter per provider is a
  unit of work; Anthropic's exists
- **Evidence 2026-09-12** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are present in the Production
  environment of the owner's Vercel project (names seen in the owner's dashboard; values masked).
  For Anthropic the resume condition is met; runtime confirmation on `/production-readiness` pending
- **Runtime 2026-09-12** the production app reports the AI provider *configured, not verified*: the
  last exercise (2026-08-21, two `requirement.extract` jobs) was refused with *the configured
  Anthropic API key was rejected*, and the key was updated the same day; nothing has exercised it
  since. Verify from the Agents page before enabling any agent
- **Resume when** the provider is runtime-verified from the Agents page; the other adapters are work

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
- **Status 2026-09-12** The owner asked for the procedure and it was given: Meta Business
  verification → developer app with the WhatsApp product → WABA + a fresh number → system-user
  permanent token → app secret → webhook at `/api/webhooks/whatsapp` with an owner-chosen verify
  token → app to Live → message templates approved. The four env names and the in-product
  `whatsapp_phone_number_id` are listed there; a Meta test number carries development meanwhile
- **Evidence 2026-09-12** `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`
  are present in Production (owner's dashboard; values masked). Whether the token belongs to a
  verified production number or Meta's test number is not visible from a variable name
- **Runtime 2026-09-12** the production app reports WhatsApp *configured (verify to confirm)*. The
  Operations page holds 7 failed client deliveries and 3 dead `reply.compose` jobs from
  2026-08-20…23, refused by WhatsApp with 401 (token), 403 and 400 — a test burst before the token
  was updated on Aug 22; nothing has been sent since. Run *Verify configuration* on Settings and a
  test send to the configured internal recipient before any real send
- **Verified 2026-09-12 (owner's click, read in their browser)** *Reachable — Meta accepted the token
  and returned the number · +1 555-204-8026 · "Test Number" · quality GREEN.* So the token works and
  the number is **Meta's test number**, not a production number; the blocker stands for exactly that
  reason. G-236 now records this verification so the readiness page can see it
- **Test send 2026-09-12** a controlled send to the internal recipient went through Meta's test
  number (`wamid` recorded 15:42:45Z) once the recipient carried its country code (+91…); the first
  attempt without it was refused with 400. The readiness page reads 8/8 ready on recorded evidence.
  What remains is exactly this blocker: a production number, which is Meta's determination
- **Resume when** the account is verified and a production number is attached

## BLK-004 — Five production environment facts (ADM-60) + Vercel Protection Bypass

- **Category** Deployment configuration
- **Requirement** Master Plan V3 §20; Impl/DoD §27–§28
- **Blocks** External cron, health checks behind the SSO wall, the deployment runbook
  (G-052), and therefore the release/smoke/rollback gate
- **Owner statement 2026-09-12** Set. Verified from outside, read-only: Deployment Protection is ON
  (an unauthenticated `/api/health` answers 302 to Vercel SSO). Which variables are present is
  not visible from outside — the owner confirms it on `/production-readiness` once signed in
- **Evidence 2026-09-12** Four of the five required names seen in the owner's dashboard
  (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`);
  `SUPABASE_SERVICE_ROLE_KEY` and `VERCEL_AUTOMATION_BYPASS_SECRET` were below the fold and are
  unconfirmed. Plan is **Pro**. **Flagged:** the `NEXT_PUBLIC_*` values are scoped to All
  Environments, so previews point at the production Supabase project unless a Preview-scoped value
  exists — against ADM-60's own constraint (3)
- **Runtime 2026-09-12** confirmed: `/dashboard` Config problems **0**; `/production-readiness`
  *Every production-required value is present and safe*; scheduler ticking (last tick 9s). Still
  open on that page: `ALERT_WEBHOOK_URL` unset (failures only log); 5 dead jobs (see BLK-001/003);
  2 approvals overdue since 2026-08-26. Production alias: `agency-os-zeta-two.vercel.app`; no
  custom domain
- **Later, 2026-09-12 17:31–17:33** the owner rejected the two overdue approvals and requeued the
  five dead jobs; Operations reads *Nothing is stuck* and readiness *0 blocking, 3 to verify, 5 ready*.
  No outbound message event since 2026-09-04: the requeued replies had sent nothing, and a
  free-text reply outside the 24-hour window is not carried (G-213/G-214)
- **Resume when** — met for the variables; the page's remaining items are BLK-001, BLK-003 and the
  alert webhook

## BLK-005 — Calendar / meeting provider *(decided 2026-09-12: Google Calendar + Meet — credentials pending)*

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
- **Owner decision 2026-09-12 (ADM-102)** Google Calendar + Google Meet, on the agency's Google
  Workspace account
- **Resume when** the credentials exist in the deployment environment; the Google adapter is then a
  unit of work behind the availability port
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
- **What follows a no-show** (ADM-103, raised by G-237). Scheduler §8 and §14 say a
  no-show creates a Sales follow-up. `crm.record_no_show` records and audits the no-show
  and queues nothing: none of the registered follow-up situations is a missed meeting,
  and choosing one — or a cadence — is a business fact. One enqueue and one template
  situation wait on the answer
- **The Blueprint's role matrix for the Scheduler screens** (PH1-ADM-001 / G-234). The Admin
  Panel Blueprint names A08's users as *Admin/Operations/Sales* and A09's as *Admin/Operations*
  (§4), with a role matrix of *Super Admin / Admin / Sales / Operations / Auditor* (§5) that
  is not the repository's role set (owner, ops_admin, delivery_lead, member, contractor,
  client_admin, client_member). Both pages gate on `lead.read` for now, and RLS admits every
  internal role to the rows — so a narrower page gate would be a hidden control, not
  enforcement (Blueprint §11). Mapping the Blueprint's roles onto the repository's, and
  deciding whether meeting evidence is narrower than the meeting, needs an Admin decision.
- **Payment/exception evidence for WON** (PH1-CLS-001 / G-230). The *gate* is not a
  decision — every source document requires one. But **what counts as satisfying it** is:
  whether a verified payment row is required, or an approved no-advance exception, or
  either. The gate was built with the mandatory half (an accepted quotation version) always on
  and the configurable half (payment or approved exception) as a switch that starts off —
  the owner's decision. Until ADM-72 builds a no-advance exception path, a switched-on gate
  is satisfied only by a captured payment.
