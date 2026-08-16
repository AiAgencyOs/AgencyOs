# Checkpoint — adversarial audit run, 2026-08-16

A working document, in the same spirit as the 2026-08-14 checkpoint (now
superseded by this one): a context boundary is not a project boundary. Anyone
picking this up — including me, in a fresh context — should be able to continue
from the *Next task* line without re-deriving anything.

---

## HEAD

`4eb577b` — an invoice is voided, not deleted (#200). This session fixed four
money bugs (invoice bypass #191; payment verification #193; refund flow #194;
refund scope #195), turned the INVOKER/RLS class into a **permanent
self-detecting check** (#197) which caught a fifth instance
(`crm.mark_outbound_delivery`), swept five more authenticated-path classes — fixing
the two holes found (#198 caller-supplied tenant; #200 financial-record DELETE).
**Continued past #201:** the deferred DELETE surface on the five sales/delivery
records is now closed for all of them (migration `20260815370000`, shared
`core.reject_end_user_delete()`) — see the residual note below. **A further depth
audit** of the follow-up worker and agent platform then found a genuine
cross-tenant isolation defect — `ai.agents` (the global registry) was writable by
any tenant's owner via a role-only RLS policy — closed in `20260815380000` and
made self-detecting by `core.audit_untenanted_write_policies()` (`20260815390000`,
`db:verify:untenanted`). See the findings note below.

Working tree clean · CI on main green.

| Gate | Result |
|---|---|
| typecheck / lint / secrets / build | 0 / 0 / 0 / 0 |
| tests | **1,719 passing**, 377 suites, 0 failing |
| migrations | **116**, all apply in order on a fresh `db reset` |
| restore rehearsal | green (local) |
| check-record | 0 — §10 covers all merges |

**Recorded residual technical items** (not owner/external blockers, but not rushed):
- **DELETE surface on `sales.proposals` / `projects.deliverables` / `projects.handovers`** — ~~the same shape #200 fixed for invoices; deferred pending the CASCADE-parent semantics.~~ **Resolved (this change, migration `20260815370000`).** The cascade question is settled: the only edges that cascade-delete into the five records are `core.organizations` (identity-less teardown, exempt) and the intra-set `projects→{deliverables,handovers}` / `opportunities→proposals` (whose parents are now guarded too); the parents that *do* grant end-user DELETE — `crm.leads`, `core.client_accounts` — reach the five only by `SET NULL`/`RESTRICT`, never cascade-delete, so no legitimate end-user cascade breaks. All five closed with a shared `core.reject_end_user_delete()` `BEFORE DELETE` guard (the #200 shape), red-proofed authenticated (refused) and positively (service-role + full org-teardown cascade), pinned by `tests/records-are-closed-not-deleted.test.ts` and live in `db:verify:deliverables`/`handover`/`quotations`. `finance.payments`/`refunds`, `crm.conversation_messages`, `audit.audit_log` already have no end-user DELETE policy.
- **Two known CI flakes**, both pre-existing and recovered by re-run: `verify-requirement-proposal` §Q (concurrent extraction — a runner momentarily leaves a job `running` and misses the raced-report under CI timing; the reaper recovers it in production) and `verify-milestone-invoicing` §7 (the definer-helper naming, ~"three failures in five resets" per its own note). Both are timing-sensitive live-server concurrency assertions that need the app-block to reproduce and pin deterministically. **Root-caused (next PR):** both are HARNESS bugs, not product races — §Q's runner is diverted out of extraction by a stray cross-script `milestone.unlock` job because `core.claim_jobs` is org-agnostic and the probe's `isolateQueue` parks only `requirement.extract`; §7e computes its expected blocking invoice from an *unordered* PostgREST read while the helper deterministically returns `min(number)`. Fixable without weakening either assertion (isolate the probe's queue; mirror the helper's `order by number`).

**Agent-platform / follow-up depth audit** (fresh, this run):
- **`ai.agents` writable cross-tenant by any owner** — **Resolved (this change, `20260815380000`).** The global registry's write policy was role-only (`is_owner()`), so one tenant's owner could disable/misconfigure/delete agents for every tenant. Dropped the end-user write; made the class self-detecting via `core.audit_untenanted_write_policies()` (`20260815390000`, `db:verify:untenanted`); a full enumeration confirmed it was the only untenanted end-user write policy in the schema set.
- **Follow-up `follow_up_sends.outcome='sent'` set at claim time** (MED, **recorded not changed**) — the *sequence* advances and escalates on exhaustion before the separate `deliverFollowUp` job runs, so a lead whose number is invalid can escalate over undelivered messages. The wire-level delivery claim itself is correctly provider-gated (`send.ts` only marks `sent` on a real Graph `providerRef`), and `follow_up_sends` has no UI/report reader — this is the already-documented C3/P7 caveat, gated on an **owner** escalation-policy decision (ADM-11 territory: does escalation wait for delivery confirmation?), so it is surfaced, not silently redefined.
- **`MAX_EXTRACTION_MESSAGES` vs the SQL literal `1000`** (LOW) — the request-time (TS) and ingest-time (SQL) dedupe caps are decoupled; if the constant ever changes they diverge above the cap. Correctness-latent, not currently wrong; a candidate for a cheap pin (a test asserting the SQL literal equals the constant).

**Four more authenticated-path classes swept** (beyond the INVOKER/RLS one, now
self-detecting in CI):
- **Caller-supplied tenant** — every DEFINER function granted to end-users that
  takes an `organization_id` param and writes it. One hole:
  `install_default_onboarding_baseline` was PUBLIC-granted and unvalidated (a
  cross-tenant re-seed) — **fixed #198**; the other four validate the org or carry
  the caller-scoping clause.
- **DEFINER writers' in-body authz** — the two with no authz refs are trigger
  functions (not RPC-callable); the rest (`decide_approval`, `cancel_request`,
  `request_approval`, `requeue_job`, `bootstrap_first_owner`) validate role/tenant.
- **Client-writable tables** — none: no table's write policy admits a client role,
  matching the capability matrix (clients are read-only).
- **Wrong-scoped write policies** — money tables + `outbox_events` verified; the
  one mismatch (refunds) fixed #195.

**The class is now self-detecting.** `core.audit_invoker_writes_without_policy()`
(#197) enumerates any app-callable INVOKER writer of an RLS table lacking the
policy that write needs; `scripts/verify-invoker-rls.mjs` asserts it is empty and
CI runs it. On first run it caught `crm.mark_outbound_delivery` (the fifth
instance of the class, fixed in the same PR), so the class cannot silently return.

## A new bug class, swept: INVOKER writer without the RLS policy it needs

The payments (#193) and refunds (#194) bugs are the same shape, and it is NOT a
forgery — it is a **silent breakage** the forgery-focused sweeps could not see: a
`SECURITY INVOKER` finance function the app calls with the *user's* session,
writing a table whose RLS lacks the policy that write needs. The function runs as
the authenticated user, RLS blocks the write (a raised error on INSERT, a silent
zero-row on UPDATE), and the feature is dead in the app — while **every verify
script drives the same RPC through the service role, which bypasses RLS and stays
green**. Two real, money-critical features (manual payment verification; the
entire refund flow) were broken this way in production and invisible to CI.

Swept mechanically for the whole class — every INVOKER function × the table/op it
writes × whether an RLS policy exists for that op on an RLS-enabled table:

| Writer | Table / op | Verdict |
|---|---|---|
| `verify_payment` | `finance.payments` UPDATE | **broken (fixed #193)** — app-called, no UPDATE policy |
| `request_refund` / `record_refund` | `finance.refunds` INSERT/UPDATE | **broken (fixed #194)** — app-called, no write policy |
| `claim_alert` / `clear_alert` | `core.alert_state` INSERT/DELETE | fine — called only by the service role (alert cron) |
| `expire_overdue` | `approvals.approval_requests` INSERT | fine — called only by the service role (approval cron) |
| `request_approval` | `approvals.approval_requests` INSERT | fine — `SECURITY DEFINER`, bypasses RLS by design |

So the **missing-policy** class is now exhausted: the only two INVOKER writers
that are app-reachable *and* had no policy for their write are fixed; the rest are
service-role/cron (RLS-bypassed) or DEFINER. The fix pattern in both cases is the
same as the invoice engine: the write policy RLS needs, plus a sanctioned-write
guard so the opened policy cannot be abused for a direct Data-API forgery.
`check-record` and `tests/finance-sanctioned-write.test.ts` pin the guards and the
capability lines.

**The wrong-scoped variant was then swept too** (a policy that exists but is
narrower than a legitimate caller's role). Every app-called INVOKER writer of an
RLS table with a role-restricted write policy was cross-checked against the role
its capability actually grants:
- **`finance.refunds`** — #194 opened it to owner **and** ops_admin, but
  `refund.issue` is owner-only. Fixed in **#195** (narrowed to owner), red-proofed
  that an ops_admin's `request_refund` is now RLS-refused.
- **`core.outbox_events`** (`outbox_insert` = owner/ops_admin) via `emit_event` —
  clean: every INVOKER function that emits an event (the five finance writers,
  `send_proposal`, `record_proposal_response`) is itself gated to owner/ops_admin,
  and broader-role actions (a delivery_lead submitting work) emit through
  `request_approval`, which is `SECURITY DEFINER` (runs as the owner, RLS
  bypassed). No mismatch.
- The rest are the invoice/payment writers, whose policies (owner/ops_admin) match
  `invoice.issue` exactly.

So both variants of the class — missing policy and wrong-scoped policy — are now
swept and closed.

**128 gaps — 115 closed, 13 open. 81 of 84 decisions granted.** The single
production-readiness verdict remains 🔴 **NOT PRODUCTION READY** at
`docs/deployment/production-readiness.md`; every blocker is an owner fact, an
external account, or an owner decision — none is code.

---

## What this run was

The 2026-08-14 run closed the "runway sweep" (#164–#171) and said the
credential-free runway was *nearly* empty. This run reopened it with **three
rounds of adversarial security audit plus a fourth, money-focused pass** and
found it was not. Twenty PRs (#172–#191) merged, each adversarially reviewed and
closed with a **red proof** (the fix proven by toggling the old code back and
watching the test fail), main green throughout.

The fourth pass closed the item the checkpoint had flagged as the sharpest
remaining one — the `finance.invoices` bypass (#191) — and then an **11-agent
adversarial workflow** verified that fix from every angle and swept the rest of
the status-bearing tables. Its verdict: the invoice fix HOLDS on all five attack
angles, and **the remaining unguarded status tables contain zero newly-
exploitable credential-free forgeries** (see *The remaining status tables* below,
now updated from that sweep).

The through-line of the audit rounds was a single **systemic vulnerability
class**, described in its own section below.

| PR | What | Class |
|---|---|---|
| #173 | **A child belongs to its parent's tenant, both directions** — org-consistency guards across the org-scoped child→parent FKs (the tenancy-graft sweep the prior run deferred) | tenancy |
| #174 | **The scheduler has a pulse** — cron heartbeat | observability |
| #175 | The permanent-delivery escalation is provider-blocked, not a status-code stop *(recorded, not shipped — a net-negative fix backed out)* | honesty |
| #176 | **A wedged follow-up is visible, by reason** | observability |
| #177 | **Confirming a payment is idempotent under the lock** — the verify_payment double-verify race (HIGH, money) | correctness |
| #178 | **Two cross-tenant holes** — deliverFollowUp conversation injection + resolve_policy caller-scope leak | tenancy |
| #179 | **Requeuing a dead job actually requeues it** — the RLS-broken operator feature (HIGH) | correctness |
| #180 | **A follow-up created before the timezone was set is no longer lost forever** | correctness |
| #181 | **A deliverable is approved only through the engine; sign-off only by the role that may** | state-machine guard |
| #182 | **Cancelling an approval takes authority, not just the right tenant** | authz |
| #183 | **Requirement extraction is bounded** — max_rows truncation → permanent wedge | correctness |
| #184 | **A portal user sees the people on its own account, not every client's** — cross-client PII enumeration (HIGH) | tenancy |
| #185 | **A handover is delivered and accepted only through the engine** | state-machine guard |
| #186 | **A proposal is approved and sent only through the engine** | state-machine guard |
| #187 | **A deliverable is not born approved** — the INSERT vector #181's UPDATE-only guard left open | state-machine guard |
| #188 | **A converted lead does not walk back into the pipeline** | state-machine guard |
| #189–#190 | The adversarial-audit run, checkpointed + invoices triage | docs |
| #191 | **An invoice moves only through its engine, not by a direct write** — the G-100 / payment-engine bypass, closed by a capability-path guard; adversarially verified on all angles | capability-path guard |

---

## The systemic finding: status machines held only in the application

Most state-bearing tables in this system carry a `status` column, a set of legal
transitions, and application code (a service action or a `SECURITY DEFINER` RPC)
that enforces those transitions. But the tables themselves are exposed through
PostgREST, and their write RLS admits a real role (`is_admin()`,
`can_manage_delivery()`, `is_internal()`). Wherever the transition graph lived
**only** in the application, a caller with that role could `PATCH` (or `INSERT`)
the row straight over the Data API and forge a state the engine would never have
produced — bypassing an approval, a QA gate, a client's decision, or a terminal
state.

**The canonical fix** (first written for `projects.deliverables`, then
`qa.defects`, and applied this run to handovers, proposals, deliverables-INSERT
and leads) is a `BEFORE INSERT OR UPDATE` guard trigger that:

1. forces the initial status on INSERT (a row is born in its start state);
2. keeps terminal states terminal;
3. enforces the forward transition graph;
4. requires the engine-mediated states to carry an `approval_request_id`
   pointing at *this row's own* approval request in the matching state
   (`pending` for submitted, `approved` for settled).

(4) is what makes the sanctioned RPCs the *only* way in: a direct write cannot
forge the linkage, because — the **linchpin, verified this run** —
`approvals.approval_requests` grants `authenticated` only `SELECT` and has no
write policy, so a forged `approved` approval request cannot be created over the
Data API in the first place. Every guard that trusts `approval_request.state`
rests on that fact.

**The INSERT-vs-UPDATE lesson (#187).** A guard trigger scoped `BEFORE UPDATE`
closes the `PATCH` vector and leaves the `INSERT` vector open: the same forgery
is reachable by inserting the row already in the illegal state. `deliverables_guard`
was UPDATE-only and a `delivery_lead` could `INSERT` a deliverable already
`approved` — unlocking `production_readiness.build_approved` and the G-100
invoice gate. #187 gave it the INSERT branch. **Every transition guard must
consider both verbs.** Current coverage:

| Guard | INSERT | UPDATE |
|---|---|---|
| `projects.deliverables_guard` | ✅ (#187) | ✅ |
| `projects.handovers_guard` | ✅ | ✅ |
| `sales.proposals_guard` | ✅ (#186) | ✅ |
| `projects.tasks` (tasks_module_guard) | ✅ | ✅ |
| `ai.handoffs` | ✅ | ✅ |
| `crm.leads_guard` | — *(by design — see below)* | ✅ (#188) |
| `crm.requirement_versions` | — | ✅ |
| `qa.defects` | — | ✅ |
| `approvals.approval_requests` | *(n/a — no authenticated write path)* | ✅ |

`crm.leads_guard` is deliberately UPDATE-only: a lead legitimately *starts* in
more than one state (import/manual entry create qualifying/qualified leads), and
a lead born `converted` unlocks nothing — nothing reads `lead.status` to grant
money or access. The reversal of an *existing* converted lead was the whole
risk, and it lives on the UPDATE path.

---

## The remaining status tables — an honest map, and why they are a separate pass

A `status` column plus a write grant is not a vulnerability; a *permissive write
**policy*** plus *no guard* plus a *load-bearing* status is. The full
enumeration, with the decisive third column being the RLS **policy** (not the
grant):

**Already closed or structurally safe:**
- Guarded (above): deliverables, handovers, proposals, leads, defects,
  requirement_versions, tasks, ai.handoffs, ai.agent_runs (INSERT-guard).
- **`finance.invoices` — closed (#191)** by a *different* pattern, below.
- **RLS-write-safe** — grant exists but no write *policy*, so `authenticated`
  cannot write over the Data API: **`finance.refunds`**, **`approvals.approval_requests`**.
  These need no guard; the absence of a policy is the control.

### `finance.invoices` — the capability-path pattern (#191)

The transition-graph guard doesn't fit invoices: `draft→issued` is a *legal*
transition, so a graph guard would still let a forger take it (bypassing G-100),
and the money columns are maintained by the payment engine across many writers.
And its five user-callable writers are **`SECURITY INVOKER`**, so a raw PATCH has
the *same* privileges — the gate inside `issue_invoice` was advisory, not a
boundary. Proven live: an ops_admin PATCHed `draft→issued` and `→paid`+`paid_minor`.

Closed by a **capability-path** guard, not a transition guard: each sanctioned
writer sets a transaction-scoped `finance.sanctioned_write` flag as its first
statement, and a `BEFORE INSERT OR UPDATE` trigger refuses any invoice write that
does not carry it (consuming it on the one write each writer makes, so it can't
be inherited later in the same transaction). `SECURITY DEFINER` was rejected —
the functions rely on RLS for tenant isolation, so running them as owner would
open a cross-tenant hole. Identity-less callers (service role, cron) are
exempt — trusted infrastructure, not the Data-API surface. **This is the pattern
to reach for when the sanctioned writers are INVOKER functions whose gate would
otherwise be advisory.** Adversarially verified (11-agent sweep) to HOLD on
backward/terminal forgery, cross-tenant, capability-flag forgery, exemption
soundness, and verbatim-reproduction fidelity.

### The rest — swept, and none is exploitable

The 11-agent workflow (2026-08-16) also swept every remaining unguarded status
table for a *genuinely-exploitable, credential-free, non-self-healing* forgery of
a *load-bearing* state. **It found none.** Each is either RLS-safe, gated to a
trusted role, self-healing, or pure data-integrity:

| Table | Write policy | Sweep verdict |
|---|---|---|
| `finance.payments` | owner/ops_admin manual-insert | **LOW / owner-decision.** A manual payment can be inserted `verified_at`-stamped, which `net_verified_minor` counts — but by the money-trusted role, and whether manual verification is a *separate* control is the owner question below. UPDATE has no policy (can't be PATCHed). |
| `finance.refunds` | — (no write policy) | **NONE** — RLS-safe. |
| `projects.milestones`, `projects.projects` | can_manage_delivery | **LOW** — nothing reads their `status` as a DB-level money/access gate (`create_milestone_invoice` doesn't gate on milestone status; `production_ready` is a role-checked separate column). Data-integrity. |
| `projects.features`/`modules`/`maintenance_items`/`onboarding_items` | delivery managers | **NONE** — data-integrity, no money/access gate. |
| `crm.follow_up_sequences` | is_internal (contractor) | **NONE** — the worker *revalidates* stop conditions before every send, so a forged status is self-healing. |
| `crm.conversations`, `crm.communication_consent` | internal / is_admin | **NONE** — consent is writable only by is_admin (a trusted role); conversation status gates only internal announcements. |
| `core.memberships`/`client_users`/`client_accounts`/`jobs`, `sales.upsell_signals` | owner / internal | **NONE** — the access tables (`memberships`, `client_users`) are owner-gated, so **a client cannot self-grant a role or portal access**; `jobs` is runner-managed with only one insertable kind; `upsell_signals` is an internal note with no client-visible or money path. |

So the credential-free state-machine-forgery surface is now **closed to the
extent the sweep can reach**: the guarded tables are enforced, the RLS-safe ones
need nothing, `finance.invoices` is closed by the capability pattern, and the
remainder carry no exploitable, load-bearing forgery. Adding transition guards to
the data-integrity tables (milestones, projects, follow_up_sequences, …) is
**optional hardening**, not a security requirement — and each still needs the
per-table legitimate-writer diligence the leads guard proved the cost of skipping.

---

## Blocked on an owner decision — do not invent

- **`finance.payments` — may a manual payment be *inserted* already verified?**
  Investigating this decision (#193) found and fixed a separate, real bug first:
  `verify_payment` (SECURITY INVOKER, called by the app with the user's session)
  could not set `verified_at` because payments had **no UPDATE policy**, so manual
  verification silently no-op'd in the app (the service-role verify scripts hid
  it). #193 added an UPDATE policy + a sanctioned-update guard: `verify_payment`
  now works for the app, and a direct Data-API payment PATCH can neither tamper
  with a recorded payment nor confirm one out-of-band. **That fix is
  interpretation-neutral** — it governs the UPDATE path only.

  The **INSERT** path is what remains open, and it is a genuine owner decision.
  `payments_manual_insert` lets an owner/ops_admin `INSERT` a `provider='manual'`
  payment, and the policy does not restrict `verified_at`, so an owner *can* record
  a payment already `verified_at`-stamped (which `net_verified_minor` counts as
  confirmed money) — collapsing recording and verifying into one insert. The
  sanctioned flow is two-step: `record_manual_payment` inserts `captured` with
  `verified_at` null, and `verify_payment` confirms it separately. **ADM-04**
  established the model — *"recording money and believing it are two acts"* — but
  did not rule on whether the same owner may do both at once. The code implies the
  two-act flow (the RPCs, the `unverified_idx`, the `verified_together` CHECK) but
  does not enforce it on the direct INSERT, and payments carry no `created_by`, so
  a producer≠verifier separation is not even expressible. So:
  - **Option A — verification is a separate control.** Tighten
    `payments_manual_insert`'s WITH CHECK to force `verified_at IS NULL` (and
    `verified_by IS NULL`) on INSERT, so *every* confirmation goes through
    `verify_payment`. Choose this if the agency's process requires that money be
    recorded first and confirmed as a distinct, separately-timestamped act (e.g.
    only once a bank statement is seen), even by the same person.
  - **Option B — verified-on-insert is owner self-attestation.** Leave the policy
    as is. Choose this if an owner entering a payment they have already confirmed
    may mark it verified in one step; the `verified_together` CHECK already forces
    them to name themselves as `verified_by`.

  **Not credential-free-exploitable either way** — the actor is the money-trusted
  owner/ops_admin acting on their own org (no cross-tenant, no client harm, no
  privilege escalation: an owner can verify through the RPC regardless). This is a
  financial-control/workflow decision, **recorded, not decided**, and NOT
  implemented — per the standing rule against inventing a business rule.

---

## Discipline rules, reaffirmed and extended

The two rules from the last checkpoint still hold (**§10: two edits per PR, run
`check-record` before pushing**; **a verify script restores the shared state it
touches**). This run added a third, learned from #188's CI failure:

> **When a guard constrains a table, grep for *every* writer of that column —
> including ones hidden behind helper wrappers.** The leads guard passed every
> lead-touching script I ran locally, then failed CI on `verify-whatsapp-ingest`,
> which walked one lead `converted → disqualified` through a `setLeadStatus()`
> helper my literal `PATCH … status:'…'` grep never matched. The fix (a fresh
> lead for the disqualified case) was trivial; finding it cost a CI cycle. Grep
> the wrapper name too, and read what each call actually transitions *from*.

Also reaffirmed, from #175: **a fix that is net-negative is not shipped.** The
permanent-delivery-failure escalation was prototyped and *backed out* — stopping
a sequence on any 4xx-not-429 would mass-stop live sequences across every tenant
during a fixable token/window outage, with no un-stop path. Recorded as
provider-fact-blocked instead of shipped.

---

## Next task

Every confirmed, clearly-exploitable, credential-free state-machine forgery is
now **closed** (proposals, handovers, deliverables ×2, leads, `finance.invoices`,
plus the round-1/2 correctness and tenancy fixes), and an 11-agent adversarial
sweep found **no exploitable forgery** left in the remaining status tables. The
credential-free security surface this run set out to close is, to the extent an
adversarial pass can reach, **exhausted** — not by assertion, but because the
sweep looked and found nothing.

What remains is no longer security-critical:

1. **One owner decision to surface, precisely, without building either branch:**
   `finance.payments` — is manual-payment verification a *separate* control
   (guard `verified_at` on INSERT, route through `verify_payment`) or owner
   self-attestation (no change)? The only remaining money-adjacent item, and it
   hinges on a business fact, not code. (The parallel G-100-in-DB question is now
   moot — #191 enforced the invoice engine as the boundary.)
2. **Optional data-integrity hardening** (NOT a security requirement): transition
   guards on `projects.milestones`/`projects`, the delivery sub-entities, and the
   CRM state tables. Each still needs the per-table legitimate-writer diligence
   the leads guard proved the cost of skipping; `crm.follow_up_sequences` is
   lowest (self-healing via the worker's revalidate step). Do these only if the
   owner-fact backlog stays blocked and there is spare, low-risk runway.
3. Then: **wait for owner facts, keep main green**, maintain the readiness gate.

Everything now gates on the same three non-code blockers: owner facts (ADM-60 ×5,
G-137), an external Meta account, and owner decisions (ADM-85/86, G-136/138/139,
and the payments-verification question). When any arrives,
`docs/deployment/production-readiness.md` says which category turns green. **CI
being green is not production-readiness** — the verdict stays 🔴 until those
external prerequisites are actually met.
