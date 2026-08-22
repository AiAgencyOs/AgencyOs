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

> **Re-verified 2026-08-22 at `aa98807`** — a full readiness pass re-ran every
> repository-side prerequisite green, each executed this pass and not inherited
> from CI: gates (typecheck, lint, secrets, check:record, **2,103 tests**), the
> credential-free build, **161 migrations** applied from scratch in order, the
> local restore rehearsal, and all **62 live DB checks** in CI's own order.
>
> **Five rows were wrong, and every one of them was wrong in the same
> direction — reporting a blocker that had been cleared.** C9 said agents were
> not activated; eight run on production. B3, B4, B5 and B6 each cited a gap
> that has since closed: ADM-86 answered G-136, production carries
> `Asia/Kolkata` for G-137, ADM-89 collapsed G-138's two situations and ADM-90
> gave G-139 a conversation to send on. This is the class PR #262 recorded
> about G-137 itself — *"a claim about the world, which the derived numbers
> cannot see"* — and `check-record` §18 now refuses it: a row marked 🔴 may not
> cite a gap the record calls closed.
>
> The CONFIGURATION / EXTERNAL / BUSINESS blanks that remain are unchanged —
> every one is an owner fact, an external account, an owner decision, or a real
> send. **ADM-60 is still the single highest-value next action**: naming the
> production environment unblocks all of CONFIGURATION and RECOVERY.

> **Remote provisioning pass — 2026-08-18 (owner-authorized).** Access was
> re-verified as genuinely available (correcting the earlier "no access" note):
> the Supabase CLI is authenticated and linked to project **`AgencyOs`**
> (`hodwqdfzxwakuahxzjiw`, `ap-south-1`, `ACTIVE_HEALTHY`, PG 17.6), and the
> Vercel CLI is authenticated (`buss-enhancer`). With explicit owner
> authorization, the **76 pending migrations were pushed to the remote**
> (`supabase db push --linked`) and verified against it — evidence, all
> read-only after the push:
> - **DB schema — ✅ GREEN:** `migration list --linked` → **125 applied, 0
>   pending** (high-water `20260818130000`); feature-detection confirms
>   `crm.import_records`, `crm.import_batches`, and `organizations.timezone`
>   now exist on the remote (HTTP 200).
> - **Security posture — ✅ GREEN (live, on the remote):**
>   `rpc/security_posture` → 0 unguarded org FKs, 0 unfrozen org tables, 0
>   invoker-writes-without-policy. Every structural tenancy/RLS invariant holds
>   on the real database, not just locally.
> - **Deployment — 🟡 corrected 2026-08-18 (later):** the earlier "no AgencyOS
>   project" note reflected *my* CLI account (`buss-enhancer`) only. The **owner
>   already connected the repo to their own Vercel project `agency-os5/agency-os`**,
>   which auto-deploys `main` (a `Vercel` commit-status posts on every push).
>   Externalizing the per-minute cron (PR #243, `2a8e42c`) made that deploy
>   **succeed** — the merge-to-`main` production deploy went `state: success,
>   "Deployment has completed"` — which also **proves the project is Hobby-tier**
>   (a Pro project would not have been blocked by a per-minute cron). So **Pro is
>   not required.** The `buss-enhancer/agencyos` project I created earlier is an
>   **orphan**; its env vars do not count for the owner's deployment.
> - **Live reachability — 🚧 UNKNOWN (SSO-walled), not GREEN:** every route on the
>   deployment 302-redirects to `https://vercel.com/sso-api` — **Vercel Deployment
>   Protection** is enabled — so `/api/health` and `/api/jobs/run` cannot be reached
>   from outside, and neither can any external cron. This is neither RED (the app
>   *does* deploy) nor GREEN (nothing external is proven): it is **UNKNOWN until the
>   owner enables Protection Bypass for Automation.** Full procedure, the exact
>   header/token, and the smallest owner-side asks:
>   [`cron-external-trigger.md`](cron-external-trigger.md).
> - **`config:doctor --production` — 🔴 2 blocking:** `NEXT_PUBLIC_APP_URL` is
>   not https and `ANTHROPIC_BASE_URL` points at an external host — both are
>   artifacts of `.env.local` being a *dev* config; the real values belong in
>   the Vercel **Production** scope, so this can only turn GREEN against the
>   deployment env, not against `.env.local`.
> - **WhatsApp + AI — 🔴 RED:** `ANTHROPIC_API_KEY` and all `WHATSAPP_*` are
>   unset (sending disabled, agents cannot run) — owner-supplied credentials,
>   set in the deployment env, never in the repo.
>
> Net: the **database boundary is production-current and proven**, and the app
> now **deploys on the owner's Hobby project**. What remains is owner-side and
> external: enable the **SSO bypass token** so the external cron and health checks
> can reach the app, set the five Production env vars on the **owner's** project
> (not the orphan), wire the per-minute external scheduler
> ([`cron-external-trigger.md`](cron-external-trigger.md)), and supply the
> WhatsApp/AI credentials. No repository-side prerequisite remains.

> **Operability pass — 2026-08-18 (session 2).** Repository- and infra-side work
> that needed no owner credential:
> - **External cron, deployed inert — 🟡:** `infra/aws/cron/` (CloudFormation +
>   Lambda) is the AWS driver of the external-cron contract. The stack is
>   **deployed to the owner's AWS account** (`138035228508`, `ap-south-1`) with
>   the schedule `DISABLED` and the secret holding placeholders, so it changes
>   nothing until the owner populates the secret (prod domain, `CRON_SECRET`,
>   bypass token) and enables the schedule. GREEN needs those three owner values.
> - **Agency timezone setter — ✅ GREEN (mechanism):** `core.set_agency_timezone`
>   validates against `pg_timezone_names` (so `UTC` is accepted, closing an app/DB
>   mismatch), audits, and a guard refuses a direct write. `db:verify:timezone`.
>   The *value* is still owner-only (G-137) — the setter is correct for when it
>   arrives.
> - **In-product operational settings — ✅ GREEN:** `whatsapp_phone_number_id` and
>   an internal `whatsapp_test_recipient` are now settable on `/settings` through
>   an audited, **whitelisted** setter that refuses any key outside the two (no
>   secret can be smuggled into the settings blob). `db:verify:orgsettings`.
> - **Delivery receipts (C10) — 🟡:** ingested + red-proved (`db:verify:receipts`);
>   a real Meta receipt is the external step to GREEN.
>
> Still owner-only after this pass: the Vercel Production env + Protection Bypass
> token, the timezone *value*, the Meta/WhatsApp credentials + Meta dashboard
> registration + approved templates, the AI provider key + which provider
> (ADM-85), the 1,200-lead export + its consent basis, and agent activation
> (ADM-82). None has a remaining repository-side prerequisite.

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
| C9 | Agents **activated** and running (L1/L2) | ✅ | **Eight of thirteen run on production**, five at L1 and three at L2 — `requirement_collector`, `support`, `project_manager`, `sales`, `customer_success` (L1); `ui_designer`, `quality_assurance`, `handover` (L2). Each run records the ADM-61 work class it was checked against; `verify-agent-dispatch` §D2b–§D2k proves the dispatch, the class and the refusals. The five that stay off are not blocked by this row: `lead_qualifier` and `proposal_drafter` are **folded into sales by ADM-82** and must not be enabled (G-125 condition 11), `developer` and `ui_prototype` need Doc 13 build infrastructure, and `upsell` needs portfolio content (**G-013**) |
| C10 | Meta delivery-status callbacks (delivered/read/failed) recorded | 🟡 | **Built + red-proved (C10).** `crm.record_delivery_receipt` records a monotonic `metadata.wire_status` axis (sent<delivered<read, failed terminal), tenant-scoped and unable to touch an inbound message; the webhook ingests `statuses[]` via the service role. `db:verify:receipts` (34 checks, in CI) proves it live — including the cross-tenant graft refused and the failure audited. **YELLOW not GREEN:** no real Meta account has yet sent a real receipt (P-rows), so the end-to-end wire is unconfirmed. Escalation is unchanged — C3/P7 stays owner-gated |

**C3 — escalation timing DECIDED A (owner, 2026-08-16): escalate after a queued
send, not after confirmed delivery.** This is the current behaviour, so no code
change; the sequence advances on the attempt and escalates on exhaustion. The
caveat below is therefore an *accepted* consequence of decision A, not an open
question — with one distinct piece still external: **P7** (which provider
refusals are terminal-per-recipient) governs only the delivery job's park/retry,
not the now-decided escalation timing.

**C3 caveat — escalation honesty (P7, external).** The follow-up worker decides
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
the worker's escalation timing, not the delivery handler. **C10 now records the
`delivered`/`read`/`failed` fact** (`metadata.wire_status`), so the *data* the honest
fix reads exists; what remains is the owner escalation-policy decision and P7's
terminal-per-recipient classification, not a missing signal. Until then the
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
| K4 | Vercel plan tier + cron capability | 🟡 | **Hobby confirmed sufficient** — the per-minute cron is **externalized** (PR #243), so Pro is not required; the external driver + the SSO **bypass token** are owner-side — [`cron-external-trigger.md`](cron-external-trigger.md) (ADM-60 #5) |
| K5 | Service-role key custodian | 🔴 | **ADM-60 #6** — owner; never in preview |
| K6 | Production domain (`NEXT_PUBLIC_APP_URL`, https, non-localhost) | 🔴 | **ADM-60 #7** — owner; inlined at build, so the build env must carry it |
| K7 | `CRON_SECRET` (required) + WhatsApp pair / AI key (optional) set in production | 🔴 | owner; K1/K2 **require** `CRON_SECRET` in production and shape/pair-validate the WhatsApp pair and AI key when supplied — the optional ones' presence is not enforced |
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
| S7 | Cross-tenant graft: a child's org matches its parent's, both directions | ✅ | `core.enforce_parent_org` on all **63** org-scoped FKs + `core.freeze_organization_id` (immutable org) on all **43** org-scoped tables; `db:verify:tenancyguards` (graft refused on INSERT/UPDATE/parent-re-tenant across 4 schemas, cascade passes, both completeness functions empty) |
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
| B3 | ~~**ADM-86 / G-136** may a project group be messaged on membership alone~~ | ✅ | **Answered: ADM-86 = A.** A project group is messaged on membership; per-contact consent is required only for `direct`. The behaviour was already this — `send_outbound_message` checks consent for `kind = direct` only — and is now decided and pinned by `verify-consent` §6 |
| B4 | ~~**G-137** the agency timezone value~~ | ✅ | **Production carries `Asia/Kolkata`**, read 2026-08-21. The column, the audited owner-only setter and the value all exist; follow-ups schedule |
| B5 | ~~**G-138** two ADM-69 situations have no distinguishing fact~~ | ✅ | **Answered: ADM-89** collapsed them into situation 1. The observer never offered 2 or 3, and the registry marks them non-runnable, so nothing waits on a fact that does not exist |
| B6 | ~~**G-139** post-project has no legal conversation to send on~~ | ✅ | **Answered: ADM-90** adds the `client_account` conversation kind. The worker resolves-or-creates the account's thread for post-project work and sends on it, through the same per-contact consent chokepoint |

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
