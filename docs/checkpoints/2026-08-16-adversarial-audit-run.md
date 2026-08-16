# Checkpoint — adversarial audit run, 2026-08-16

A working document, in the same spirit as the 2026-08-14 checkpoint (now
superseded by this one): a context boundary is not a project boundary. Anyone
picking this up — including me, in a fresh context — should be able to continue
from the *Next task* line without re-deriving anything.

---

## HEAD

`5f1a30a` — a converted lead does not walk back into the pipeline (#188)

Working tree clean · 0 open PRs · CI on main green.

| Gate | Result |
|---|---|
| typecheck / lint / secrets / build | 0 / 0 / 0 / 0 |
| tests | **1,695 passing**, 374 suites, 0 failing |
| migrations | **105**, all apply in order on a fresh `db reset` |
| restore rehearsal | green (local) |
| check-record | 0 — §10 covers all 157 merges |

**128 gaps — 115 closed, 13 open. 81 of 84 decisions granted.** The single
production-readiness verdict remains 🔴 **NOT PRODUCTION READY** at
`docs/deployment/production-readiness.md`; every blocker is an owner fact, an
external account, or an owner decision — none is code.

---

## What this run was

The 2026-08-14 run closed the "runway sweep" (#164–#171) and said the
credential-free runway was *nearly* empty. This run reopened it with **three
rounds of adversarial security audit** and found it was not. Seventeen PRs
(#172–#188) merged, each adversarially reviewed and closed with a **red proof**
(the fix proven by toggling the old code back and watching the test fail), main
green throughout.

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
- **RLS-write-safe** — grant exists but no write *policy*, so `authenticated`
  cannot write over the Data API: **`finance.refunds`**, **`approvals.approval_requests`**.
  These need no guard; the absence of a policy is the control.

**Unguarded and write-reachable — the candidate sweep (all assessed MEDIUM,
data-integrity; none is a clear lesser-role money/access HIGH like the ones
already fixed):**

| Table | Write policy | Load-bearing? |
|---|---|---|
| `finance.invoices` | owner/ops_admin | Invoice `status` is display/derived; the money truth is `net_verified_minor` over **payments**, not invoice status. Forgery by a money-trusted role, low unlock. |
| `projects.milestones` | can_manage_delivery (delivery_lead) | `create_milestone_invoice` does **not** gate on milestone `status` at the DB level (a unique constraint stops double-billing; the "met" gate is app-side). Reporting/data-integrity. |
| `projects.projects` | can_manage_delivery | `production_ready` is a separate column gated by `mark_production_ready` (role-checked, #181). Status forgery is data-integrity. |
| `crm.follow_up_sequences` | is_internal (member/contractor) | Broadest actor. Forging status re-activates a stopped sequence or stops an active one — automation integrity. Many legitimate writers (worker/observer/recordSent/stop conditions) → a guard needs careful transition-mapping. |
| `crm.communication_consent` | is_admin | Consent forgery is a compliance concern, but the actor is already trusted; no-delete is already guarded (PR #164). |
| `crm.conversations`, `projects.features`/`modules`/`maintenance_items`/`onboarding_items`, `core.client_accounts`/`client_users`/`memberships`, `sales.upsell_signals`, `ai.models`, `core.jobs` | various | Data-integrity; per-table assessment needed. `core.jobs` state is runner-managed; forgery risk bounded by what reads it. |

**Why these are a scoped follow-up, not this run's PRs:** each needs the same
careful enumeration of *every legitimate status writer* that the leads guard
required — and the leads guard proved the cost of getting it wrong (a test that
walked a lead `converted → disqualified` as a fixture shortcut broke, correctly,
and had to be rewritten to use a fresh lead). Shipping 15 guards without that
per-table diligence would risk breaking legitimate flows — a net-negative the
mandate explicitly forbids ("the objective is not to make the percentage look
better"). They are real, buildable, credential-free work for a dedicated
`guard-the-remaining-status-tables` pass, one table (or small cluster) per PR.

---

## Blocked on an owner decision — do not invent

- **`finance.payments` — is manual-payment verification a separate control?**
  `payments_manual_insert` lets an owner/ops_admin `INSERT` a `provider='manual'`
  payment, and the policy does not restrict `verified_at`. So an admin can insert
  a payment already `verified_at`-stamped, which `net_verified_minor` counts as
  real money — *bypassing* `verify_payment`. Whether that is a **forgery** (manual
  payments must be entered unverified and confirmed by a second step) or the
  **intended feature** (an owner recording money they received self-attests to it)
  is a business-control question only the owner can answer. If verification is a
  separate control, the fix is a guard forbidding `verified_at` on INSERT and
  routing it through `verify_payment`; if it is self-attestation, no change is
  correct. **Recorded, not decided.** (Contrast: the payments *UPDATE* path is
  already closed — there is no update policy, so `verified_at` cannot be PATCHed
  after the fact; #177 fixed the RPC's own double-verify race.)

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

The confirmed, clearly-exploitable, credential-free state-machine forgeries are
**closed** (proposals, handovers, deliverables ×2, leads, plus the round-1/2
correctness and tenancy fixes). What remains, in priority order:

1. **`guard-the-remaining-status-tables` sweep** — the MEDIUM data-integrity
   table above, one table/cluster per PR, each with the full legitimate-writer
   enumeration and a red proof. Start with `crm.follow_up_sequences` (broadest
   actor, `is_internal`) and `finance.invoices` (money-adjacent).
2. **Surface the `finance.payments` verified-on-INSERT question to the owner** as
   a precise, three-option decision (like ADM-86 was raised) — do not build
   either branch until it is answered.
3. Then: **wait for owner facts, keep main green**, maintain the readiness gate.

Everything still gates on the same three non-code blockers as before: owner
facts (ADM-60 ×5, G-137), an external Meta account, and owner decisions
(ADM-85/86, G-136/138/139, and now the payments-verification question). When any
arrives, `docs/deployment/production-readiness.md` says which category turns
green.
