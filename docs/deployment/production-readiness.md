# Production readiness — the one gate

The single authoritative answer to "is AgencyOS production ready?". Every other
document (the runbook, the external-verification checklist, the operations
launch list) feeds this one; where they disagree, this is the reconciliation.

**The rule this enforces, and the reason it exists:**

> **CODE COMPLETE ≠ PRODUCTION CONFIGURED ≠ EXTERNAL PROVIDER VERIFIED ≠ PRODUCTION READY.**
>
> A passing test proves the code does what the test says. It proves nothing
> about whether a production environment exists, whether a real Meta account
> ever sent a message, or whether an owner has supplied a fact only they hold.

**Current verdict: 🔴 NOT PRODUCTION READY.** The code is substantially
complete and every credential-free control is built and proven; nothing below
in **CONFIGURATION**, **EXTERNAL PROVIDER**, or **BUSINESS DECISIONS** can be
ticked until an owner supplies facts and an external account exists. A row is
ticked only with evidence named in-line; a row that depends on something
outside this repository stays unticked and says what it waits for.

Legend: ✅ done, with evidence (GREEN) · ⬚ built here but only an external step
can confirm it (YELLOW) · 🔴 blocked, on the named fact (RED).

> **Re-verified 2026-08-16 at `cd7aad1`** — a full readiness pass (Phases 0–9)
> re-ran every repository-side prerequisite: gates green (typecheck, lint,
> secrets, 1,724 tests, 42 live DB checks, restore rehearsal), 119 migrations
> apply in order, `config:doctor --production` validates the whole variable set,
> and the CONFIGURATION / EXTERNAL / BUSINESS blanks below are unchanged — every
> one is an owner fact, an external account, an owner decision, or a real-world
> send. No repository-side prerequisite remains, and no credential-free defect
> was found. The single highest-value next action is **ADM-60**: naming the
> production environment (below) unblocks all of CONFIGURATION and RECOVERY.

---

## CODE — does the software do what it claims

| # | Item | State | Evidence |
|---|---|---|---|
| C1 | Lead → qualification → proposal → project → delivery → billing path | ✅ | `npm run db:verify:*` (42 live scripts against a real Postgres) |
| C2 | Consent enforced at the send chokepoint | ✅ | `crm.send_outbound_message` refuses without a granted row; `db:verify:consent`, `db:verify:authority` |
| C3 | Follow-up scheduler (G-012) — observe/decide/claim/send/record | ✅ | `db:verify:worker` (59), `db:verify:delivery` (43); at-most-one logical send per (sequence, attempt) |
| C4 | At-most-one logical outbound send | ✅ | unique `(sequence, attempt)` + derived `external_ref`; the double-submit window after a crash is **measured**, not hidden |
| C5 | Inbound webhook: signature, replay-idempotent, group-aware | ✅ | `db:verify:webhook`, `db:verify:groupin`; group ingest idempotent under real concurrency |
| C6 | Message-integrity on retry (announcer + follow-up) | ✅ | already_sent returns delivery state; `db:verify:delivery`, `db:verify:announce` |
| C6b | A failed outbound send is visible in the transcript, not silent | ✅ | `deliveryOf` (tested) + the lead-page delivery badge; renders the local pending/sent/failed |
| C7 | Job queue: claim, reap, retry, dead-park; outbox dead-park | ✅ | `db:verify:claims`, `db:verify:reaper`, `tests/outbox-discipline.test.ts` |
| C8 | Agent foundation (registry, ceilings, handoff, verification) **defined** | ✅ | `db:verify:definitions`, `db:verify:ceilings`, `db:verify:authority` |
| C9 | Agents **activated** and running (L1/L2) | 🔴 | Phase 5, gated by ADM-82's layer rules — a definition is not an activation |
| C10 | Meta delivery-status callbacks (delivered/read at the recipient) recorded | 🔴 | not built (tracked follow-up); a second state axis, real value needs a real Meta account (see P-rows). The local send state (C6b) is rendered; delivered/read are not |

**C3 caveat — escalation honesty (blocked on P7).** The follow-up worker decides
escalation at *claim* time (`recordSent`), before the delivery job runs, and
escalation/exhaustion advance on attempt count, not on confirmed delivery. So a
sequence whose sends never reach the recipient — a token outage, or a plain-text
follow-up refused outside WhatsApp's 24-hour window — can still advance to an
"unanswered" escalation, reporting a client who ignored a message never
delivered. Stopping the sequence on a permanent send failure was prototyped and
rejected: `sendWhatsAppText` classes every 4xx-not-429 as permanent, so it
cannot tell a bad recipient from a fixable deployment/window/auth fault without
Meta error-code facts (**P7**), and stopping on that signal would terminally kill
live sequences across tenants during a token outage, with no un-stop path. The
honest fix — escalate only on delivered-and-unanswered attempts, and stop only on
a genuinely terminal-per-recipient refusal — is blocked on **P7** and belongs in
the worker's escalation timing, not the delivery handler. Until then the
pre-existing behaviour stands: a permanent send failure parks the delivery job
and the sequence is unchanged. (The whole path is moot in production until
**B4/G-137** supplies a timezone; nothing sends before that.)

---

## CONFIGURATION — is the environment set, and set safely

| # | Item | State | Evidence / blocker |
|---|---|---|---|
| K1 | Env shape validated, boots-or-refuses | ✅ | `src/lib/env-schema.ts` + `src/instrumentation.ts`; a misconfigured production start **refuses**, naming offenders |
| K2 | Pre-deploy config check, credential-free | ✅ | `npm run config:doctor -- --production` — reports missing/unsafe without printing values |
| K3 | Production Supabase project ref | 🔴 | **ADM-60 #4** — owner |
| K4 | Vercel plan tier + cron capability | 🔴 | **ADM-60 #5** — owner (cron ≤ 1/min must be supported) |
| K5 | Service-role key custodian | 🔴 | **ADM-60 #6** — owner; never in preview |
| K6 | Production domain (`NEXT_PUBLIC_APP_URL`, https, non-localhost) | 🔴 | **ADM-60 #7** — owner; inlined at build, so the build env must carry it |
| K7 | `CRON_SECRET`, WhatsApp pair, AI key set in production | 🔴 | owner; validated by K1/K2 once supplied |
| K8 | Migration authority (a named human, not CI) | ✅ | runbook §3; ADM-60 granted the principle, the person is owner's to name |

---

## SECURITY — can authority be manufactured or bypassed

| # | Item | State | Evidence |
|---|---|---|---|
| S1 | Consent cannot be erased (no-delete + identity-freeze + no-truncate) | ✅ | `db:verify:authority` (18 checks, red-proofed) |
| S2 | Completion cannot be forged (handoff status machine, verifier mirror, frozen verdict) | ✅ | `db:verify:authority` |
| S3 | Webhook: HMAC-signed, unauthenticated body bounded (256 KiB, streamed), replay-idempotent | ✅ | `db:verify:webhook` |
| S4 | RLS on every app-schema table; tenancy resolved from payload only in sanctioned sites | ✅ | `db:verify` (schema), `db:verify:tenancy`; 4 service-role sites listed in `src/lib/db/admin.ts` |
| S5 | Audit log append-only (no update, no delete), inserts scoped to caller's own org+actor | ✅ | `audit_log_no_update`/`no_delete` triggers, `audit_log_insert` RLS with_check |
| S6 | Secret scan in CI; no secret in the repo | ✅ | `npm run scan:secrets` |
| S7 | Cross-tenant graft: a child's org matches its parent's, both directions | ✅ | `core.enforce_parent_org` on all **62** org-scoped FKs + `core.freeze_organization_id` (immutable org) on all **43** org-scoped tables; `db:verify:tenancyguards` (graft refused on INSERT/UPDATE/parent-re-tenant across 4 schemas, cascade passes, both completeness functions empty) |
| S8 | Agent tool-argument validation, prompt-injection defenses at runtime | 🔴 | Phase 5 — no runtime tool invocation exists yet |

---

## DATA — is state correct and recoverable in shape

| # | Item | State | Evidence |
|---|---|---|---|
| D1 | Migrations forward-only, apply from scratch in CI | ✅ | `supabase db reset` in `.github/workflows/verify.yml` |
| D2 | Money is two numbers: recorded vs verified; nothing advances on an unconfirmed claim | ✅ | `db:verify:billing`, `db:verify:overdue` |
| D3 | Undeletable authority rows (approvals) do not make their org undeletable in tests | ✅ | learned and fixed; org-scoped cleanup across verify scripts |

---

## RECOVERY — can it be restored, and is that proven

| # | Item | State | Evidence / blocker |
|---|---|---|---|
| R1 | Application rollback (promote last-good Vercel deploy) | ⬚ | runbook §Rollback; the mechanism is Vercel's, provable only on a real deploy |
| R2 | Restore rehearsed **locally**, row-for-row + checksums, in CI | ✅ | `npm run db:rehearse:restore`; runs every merge, red-proofed |
| R3 | Restore rehearsed on **staging**, recovery time written down | 🔴 | needs a staging project (**ADM-60**); the local rehearsal does not tick this |

---

## OBSERVABILITY — will a failure be noticed

| # | Item | State | Evidence / blocker |
|---|---|---|---|
| O1 | Operational backlog: dead/stalled/stuck jobs, unpublished + dead events, overdue approvals | ✅ | `core.operational_backlog`, `db:verify:backlog` |
| O2 | Alerting that does not lie: claim/release CAS, clear-only-failing, failed-send retry | ✅ | `db:verify:backlog` (41 checks) |
| O3 | Dead jobs and dead outbox events named in structured logs | ✅ | `scope:'jobs/dead'`, `scope:'outbox/dead'` |
| O4 | Cron heartbeat surfaced (a silent scheduler is distinguishable from a quiet one) | ✅ | `core.cron_heartbeat` stamped each authorized tick; `/api/health` reports its age (for an external monitor), `/operations` shows it; `npm run smoke` proves stale→fresh |
| O5 | Alert destination receiving a test alert | 🔴 | **ADM-60 #8** — owner supplies `ALERT_WEBHOOK_URL` |
| O6 | Smoke tests against a deployment | ✅ built | `npm run smoke -- <url>`; runs in CI against the built app |

---

## EXTERNAL PROVIDER — has anything real happened

**Nothing on this axis is verified. No WhatsApp message has ever been sent or
received by this system, and no WhatsApp Business Account has been onboarded.**
`docs/deployment/external-verification.md` holds the full checklist; every row
there is ❌.

| # | Item | State | Blocker |
|---|---|---|---|
| P1 | Meta Business portfolio + business verification | 🔴 | owner — external |
| P2 | WhatsApp Business Account + phone number | 🔴 | owner — external |
| P3 | App Review → Advanced Access (can be **refused**) | 🔴 | Meta — a review outcome, not a form |
| P4 | Tech Provider vs Solution Partner decided | 🔴 | owner — G-091's design cannot be fixed until settled |
| P5 | Outbound send, inbound receive, group behaviour verified against Meta | ⬚ | code exists (`WHATSAPP_GRAPH_BASE_URL` stubs it in tests); only a real account confirms it |
| P6 | Second AI provider + whose account | 🔴 | **ADM-85** — owner, external |
| P7 | Follow-up delivery-error classification — which refusals are terminal-per-recipient vs. fixable (expired token → 401, plain-text past the 24h window → 400) | 🔴 | Meta error-code semantics (same gate as P5). Until known, a failed follow-up delivery parks the job and does **not** stop or re-escalate the sequence — see the C3 caveat |

---

## BUSINESS DECISIONS — facts only the owner can supply

| # | Decision / gap | State | What it blocks |
|---|---|---|---|
| B1 | **ADM-60** ×5 production facts | 🔴 | all of CONFIGURATION, R3, O5 |
| B2 | **ADM-85** which AI provider, whose account | 🔴 | P6, G-129 |
| B3 | **ADM-86 / G-136** may a project group be messaged on membership alone | 🔴 | project-group sends stay unmodelled (deliberately) |
| B4 | **G-137** the agency timezone value | 🔴 | follow-ups do not send until it is set (by design) |
| B5 | **G-138** two ADM-69 situations have no distinguishing fact | 🔴 | those two situations stay unscheduled |
| B6 | **G-139** post-project has no legal conversation to send on | 🔴 | situation 8 stops honestly, undelivered |

---

## What "ready" would require

A production-ready claim needs a ✅ or an explicit, accepted ⬚ in **every**
category. Today the blockers are exactly three kinds, and none is code:

1. **An owner supplies ADM-60's five facts and the G-137 timezone**, and sets
   the production secrets. Then CONFIGURATION, R3, and O5 can be ticked, and
   `config:doctor --production` turns green against the real environment.
2. **A Meta Business account is created and passes App Review**, and a real
   send/receive is verified. Then EXTERNAL PROVIDER can move off ❌.
3. **The owner answers ADM-85/86 and G-136/137/138/139.**

The remaining in-repo gaps (C9/S8 agent activation, C10 delivery-status) are
tracked and do not require an owner fact — but agent activation is itself
gated by ADM-82's layer rules. The cross-tenant graft (S7) is closed
structurally, and the cron heartbeat (O4) is exposed for an external monitor
(the monitor destination itself is O5, ADM-60 #8). **The only detector of a
dead scheduler is external** — the app cannot alert on its own stopped cron;
`/api/health` gives that external watcher what it needs.

_Maintained alongside the code. When a row's evidence changes, this file
changes in the same PR._
