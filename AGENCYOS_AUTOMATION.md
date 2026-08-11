# AGENCYOS_AUTOMATION.md

What AgencyOS does without being asked — and, just as importantly, what it
deliberately will not do.

**Baseline:** commit `2881caa`, 2026-08-11.

---

## 1. The complete inventory of automation

Everything automated in this codebase, in full. It is a short list, and that is
the honest state of the system.

| # | Trigger | Action | Trust level | Client-visible |
| --- | --- | --- | --- | --- |
| 1 | Meta webhook delivers a message | Lead + conversation + message created or matched | GREEN | No |
| 2 | A message lands | `requirement.extract` job queued | GREEN | No |
| 3 | Cron, every minute | Stalled jobs reaped | GREEN | No |
| 4 | Cron, every minute | Outbox events dispatched to jobs | GREEN | No |
| 5 | An extraction job is claimed | Claude call → validated requirement version, status `proposed` | GREEN (proposes only) | No |
| 6 | Invoice fully paid | `invoice.paid` event | GREEN | No |
| 7 | `invoice.paid` job runs | Next milestone moved to `in_progress` | GREEN | Indirectly |

**Nothing on this list contacts a client.** There is no outbound message, email,
notification or provider call anywhere in the codebase. The WhatsApp integration
is inbound only, and `tests/whatsapp-webhook.test.ts` asserts the route sends
nothing.

---

## 2. Inbound WhatsApp

```
Meta → POST /api/webhooks/whatsapp
  1. read body as text (once)
  2. verify HMAC-SHA256 over the raw bytes    ← before parsing anything
  3. parse the envelope; ignore what is not a text message
  4. crm.ingest_whatsapp_message(...)          ← one call; the route holds no business logic
  5. 200
```

Design points worth keeping:

- **Signature before parse.** An unverified body is never interpreted.
- **A malformed message is a 200, not a retry.** Redelivery cannot make an
  invalid payload valid; a 500 would produce an infinite retry loop. It is
  counted and logged as `rejected` — never silently dropped (finding C5).
- **The body is never logged.** The content is the thing being protected.
- **Idempotent on the provider message id.** A replay inserts nothing.
- **A settled lead does not restart extraction** (finding C6).

`crm.ingest_whatsapp_message()` does all of it in one function: match or create
the contact by phone, match or create the lead by `source_ref`, match or create
the conversation by `external_ref`, and allocate the message `seq` **under a
lock**.

---

## 3. The one AI agent

**`requirement_collector`**, autonomy **L1** — it proposes, a human decides.

```
job claimed
  → registry consulted (enabled? model? effort?)   ← kill switch is data
  → conversation loaded, scoped by organization
  → already produced for this job?      → settle, no model call
  → already extracted this transcript?  → settle, no model call
  → agent_run opened
  → Claude called with a JSON schema
  → agent_step written (whatever the outcome, before validation)
  → Zod validates                        ← the provider's claim proves nothing
  → crm.insert_requirement_version(status = 'proposed')
  → owner or ops_admin accepts or rejects — enforced in RLS
```

Two pre-flight checks exist purely so a retry does not cost a model call twice.
A genuine race can still produce two calls, because both runners check before
either writes; holding a lock across a network call would be the wrong trade.

**Constraints the agent operates under:**

- Prompt: *use only what the transcript supports; do not infer budget or pricing;
  unclear things go to `openQuestions` rather than being guessed.*
- Output is a proposal until a human with `core.is_admin()` accepts it.
- Every proposal carries provenance: run id, job id, transcript length.
- Cost and step ceilings are registry columns.
- Failure is recorded honestly — a permanently failed extraction writes a
  `failed` version where the owner is already looking, rather than vanishing into
  the queue (finding C4).

---

## 4. Trust levels

Directive §28 defines GREEN / YELLOW / RED. The mapping below is **descriptive of
today**, not an approved policy. The policy itself is decision ADM-08 + ADM-09,
and the enforcement mechanism is gap G-041.

### GREEN — automated, no approval

Everything in §1. All of it is internal bookkeeping: creating a lead from a
message, queueing a job, reaping, dispatching, drafting a proposal for a human,
moving a milestone the client already paid for.

### YELLOW — client-facing, policy-controlled

**Nothing today. The capability does not exist.** Follow-ups, payment reminders,
delivery notifications and review reminders all require the outbound channel of
gap G-014.

### RED — Admin approval required

| Action | Enforced today? |
| --- | --- |
| Accepting a requirement version | **Yes** — `core.is_admin()` in the RLS update policy |
| Issuing an invoice | Capability `invoice.issue` — owner + ops_admin |
| Recording a payment | Capability `invoice.issue` |
| Voiding an invoice | Capability `invoice.issue` |
| Refunds | Capability exists, **no implementation** |
| Pricing, discounts, payment terms | No mechanism |
| Production deployment | No pipeline |
| Contract or legal commitments | No mechanism |
| Final handover | No mechanism |
| Upsell offers | No mechanism |

Capability checks are role gates, not approval workflows. **AgencyOS has no
approval engine** (G-040): the requirement gate is bespoke, and every other RED
row above is either a role check or nothing at all.

---

## 5. The rules AI operates under

From directive §6, §37 and §46. Stated here because the automation surface will
grow and these are what keep it safe.

**AI may:** summarise, extract structure, classify, draft, recommend from an
approved catalog, and flag.

**AI may never invent:** pricing, discounts, payment terms, guarantees, delivery
promises, legal commitments, unsupported features, or portfolio claims.

**Every AI output is a proposal** until the business rule that makes it
authoritative has run. In this codebase that rule is: an admin accepted it, and
the database enforced that only an admin could.

**Every AI output carries provenance:** source input, model, structured output,
validation result, version, approval, resulting action. The chain
`conversation → job → agent_run → agent_step → requirement_version` is complete
today and should stay complete for every agent added later.

**Absence of a response is never approval.**

---

## 6. What automation needs before it can grow

In dependency order. Each is a gap in the master plan.

1. **The approval engine** (G-040) — YELLOW cannot exist without a policy
   mechanism. Everything else waits on this.
2. **An outbound channel** (G-014) — with the approval gate in front of it, not
   behind it.
3. **Trust-level enforcement** (G-041) — derive behaviour from
   `ai.agents.autonomy_level` rather than hard-coding it per call site.
4. **Follow-up detection** (G-012) — the triggers are a business decision
   (ADM-11).
5. **An approved catalog** (G-035) — AI may only recommend from one, so the
   catalog must exist before the recommender does.

---

## 7. Operational safety properties

Worth preserving as automation grows:

| Property | Mechanism |
| --- | --- |
| Redelivery is free | `dedupe_key` unique; provider ids unique |
| A dead invocation loses nothing | Reaper releases stranded rows |
| A failed job is visible | `last_error` persisted; `dead` after `max_attempts` |
| A failed AI extraction is visible **to the business** | `failed` requirement version, not just a queue row |
| Cost is bounded | `max_cost_minor`, `max_steps`, `ai.cost_ledger` |
| An agent can be stopped without a deploy | `ai.agents.enabled = false` |
| Automation cannot reach another tenant | Service-role queries scope by hand, from the job |

The one that is missing: **dead-letter jobs are invisible** (G-058). They are
recorded correctly and nothing surfaces them.
