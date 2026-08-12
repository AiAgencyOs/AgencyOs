# AGENCYOS_ARCHITECTURE.md

The architecture **as built**, and its delta against the V1 design in
`ARCHITECTURE.md`.

**Baseline:** commit `2881caa`, 2026-08-11.

`ARCHITECTURE.md` remains the design document and the reasoning behind most
decisions here. It is not a description of the codebase: roughly half of what it
specifies is built, and the other half is not. This document says which is which,
so nobody implements against a table that does not exist.

---

## 1. Shape

A **modular monolith** — one Next.js 16 application, one Postgres database,
several modules with enforced boundaries.

```
┌─────────────────────────────────────────────────────────────┐
│ Next.js 16 App Router (Vercel)                              │
│                                                             │
│  app/(auth)      login, magic link, OAuth callback          │
│  app/(internal)  dashboard, leads, projects, invoices       │
│  app/(client)    portal            ← placeholder, 19 lines  │
│  app/api/        health · jobs/run · webhooks/whatsapp      │
│                                                             │
│  src/modules/    crm · sales · projects · finance · identity│
│  src/lib/        auth · authz · db · events · jobs · ai     │
└─────────────────────────────────────────────────────────────┘
                            │
┌─────────────────────────────────────────────────────────────┐
│ Supabase Postgres — 7 schemas, 27 tables, RLS on all        │
│ core · audit · crm · sales · projects · finance · ai        │
└─────────────────────────────────────────────────────────────┘
                            ▲
                Vercel Cron ─┘  every minute → /api/jobs/run
```

There are no microservices, no `apps/` or `services/` directories, no message
broker and no separate worker process. The serverless constraint is what shapes
this: a Vercel function has a wall clock, so anything that cannot finish inside
one is a job row rather than a long-running process.

---

## 2. Module boundaries

Every module has the same six files, and the boundary between them is enforced
by ESLint rather than convention:

| File | Responsibility |
| --- | --- |
| `schema.ts` | Zod input validation, state machines, pure arithmetic. No I/O. |
| `service.ts` | The only public write surface. Auth, capability, rule, mutation, audit, event. |
| `queries.ts` | Reads for rendering. |
| `actions.ts` | `'use server'` wrappers. Thin — parse the form, call the service, revalidate. |
| `types.ts` | Shapes crossing the boundary. |
| `handlers.ts` | Event consumers, where the module has any. |

**Modules never import each other's tables.** `finance` reaches delivery through
exactly one function — `projects/service.ts#getBillableMilestone` — and tells the
rest of the system what happened by emitting an event, never by calling anybody.

That constraint is why `src/lib/events/catalog.ts` is worth reading first: it is
the only file where modules couple, and it currently holds exactly one
subscription.

---

## 3. The four API surfaces

| Surface | Used for | Auth |
| --- | --- | --- |
| Server Components | Reads that render | Session cookie → RLS |
| Server Actions | User-initiated mutations | Session cookie → capability check → RLS |
| Route Handlers | Machine callers | Shared secret or HMAC |
| Postgres functions | Anything that must be atomic | `SECURITY INVOKER` under the caller's policies |

The fourth surface is the one that matters most. Every invariant that could be
broken by two concurrent callers lives there, not in TypeScript.

### 3.1 The mutation pipeline

Every service write runs the same sequence:

```
validate (Zod) → authenticate → authorize (capability) → load → check rule
  → mutate → audit → emit event → return Result
```

`Result<T>` is the uniform return: `{ ok: true, data }` or
`{ ok: false, error: { code, message, details? } }` with codes `VALIDATION`,
`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL`. No service throws for a
business outcome.

---

## 4. Background work

### 4.1 The queue

`core.jobs` with `kind`, `status`, `payload`, `attempts`, `max_attempts`,
`run_at`, `priority`, `locked_at`, `locked_by`, `last_error`, and a globally
unique `dedupe_key`.

Claiming is a two-step with the status in the predicate:

```sql
SELECT … WHERE kind = $1 AND status = 'queued' AND run_at <= now() LIMIT 1;
UPDATE core.jobs SET status='running', … WHERE id = $1 AND status = 'queued';
```

The second statement matching zero rows *is* the lock: a losing runner backs off
rather than double-processing.

`core.reap_stalled_jobs()` releases rows stranded in `running` by a killed
invocation. The threshold is longer than any invocation can live, so it is a
no-op unless something genuinely died. It runs first on every tick, so a
recovered job is picked up on that tick rather than the next.

### 4.2 The transactional outbox

A service writes its state change and an `core.outbox_events` row. The dispatcher
turns unpublished events into jobs — one per subscribed handler — keyed
`evt:<eventId>:<handler>`. Because `dedupe_key` is globally unique, a dispatcher
that crashes after enqueuing but before marking the event published re-enqueues
on the next pass and inserts nothing.

An event with no subscribers plans no jobs and is still marked published:
"nobody was listening" is a complete outcome, not a failure.

**"In the same transaction" was aspirational until D17.** `emitEvent` opened its
own connection and inserted after the state change had already committed, so a
failure there left the state written and the event gone — not delayed, gone,
because an INSERT that failed leaves no row to replay. For `invoice.paid`, the
only subscribed event, that is a client who has paid in full and a milestone
that never opens, with nothing queued and nothing to reconcile from.

Every event a Postgres function can publish now goes through `core.emit_event`
from inside that function's transaction:

| Event | Published by |
| --- | --- |
| `invoice.issued` | `finance.issue_invoice` |
| `invoice.voided` | `finance.void_invoice` |
| `payment.recorded`, `invoice.paid` | `finance.record_manual_payment` |
| `invoice.created` | still `emitEvent`, from the application — **gap G-078** |

`invoice.created` is the exception because `generateInvoiceFromMilestone` has no
function behind it: it inserts the invoice, inserts the items, and hand-rolls a
compensating DELETE when the second fails. Nothing subscribes to it, so losing
one loses a notification rather than work — which is why the gap is survivable,
not why it is acceptable.

`recordAudit` has the same shape and is still a separate request (**G-079**).

### 4.3 What one tick does

`/api/jobs/run`, every minute, in this order:

1. **Reap** stalled jobs.
2. **Dispatch** the outbox → jobs.
3. **Drain** up to 10 `milestone.unlock` jobs — pure database work, milliseconds.
4. **Claim one** `requirement.extract` job — the AI path, bounded to one because
   it makes a network call.

Unlocks go first deliberately: holding the revenue path behind an AI job would
be the wrong priority.

---

## 5. AI integration

Providers sit behind a port (`src/lib/ai/`) with one method that matters:
`generateStructured`. The registry (`ai.agents`) supplies the model, effort,
step and cost ceilings, and the kill switch — as data, so demoting a misbehaving
agent is an UPDATE.

Two rules the code enforces without exception:

1. **Structured output is never trusted.** The provider's claim of schema
   conformance means nothing; the payload is re-validated with Zod before it can
   become a business fact.
2. **The run record opens before the work starts.** A model call that dies
   halfway leaves a trace, and a queued extraction that could not run is recorded
   as failed rather than as an empty result.

Autonomy is a column (`L0`/`L1`/`L2`). Today only L1 is exercised, and the
behaviour is implemented in the code path rather than derived from the column —
gap G-041.

---

## 6. Delta against `ARCHITECTURE.md`

### 6.1 Built as designed

§3 module shape · §4.3 core tables · §4.4 job queue · §4.5 outbox · §4.9 finance ·
§4.10 AI observability · §4.11 RLS · §5 API surfaces and Result shape · §6.2/6.3/6.6
agent registry, run lifecycle, structured output · §7 auth and service-role call
sites · §8 capability matrix · §9 event flow.

### 6.2 Designed, not built

| § | Subject | Consequence |
| --- | --- | --- |
| §4.6 | `approvals` — polymorphic approval engine | Every approval today is bespoke. Gap G-040, decision ADM-08. |
| §4.7 | `build.screen_spec`, brand kits, trusted renderer | No design phase exists. G-021. |
| §4.8 | `build.dev_tickets`, `qa.*` | No development tracking or QA. G-024, G-030. |
| §6.8 | Approval inbox as a product surface | No `/approvals` route. G-044. |
| §10.2 | CI pipeline | **Built** — `.github/workflows/verify.yml`, plus Vercel preview deployments on every PR. |
| §10.4 | Observability | `console.error` only. G-053. |

### 6.3 Built differently from the design

| | Design | Built | Why |
| --- | --- | --- | --- |
| Middleware | `middleware.ts` | `proxy.ts` | Next 16 convention |
| Payments | Razorpay integration | Manual receipts only, no gateway client | A gateway is a business decision that has not been made. `tests/no-payment-gateway.test.ts` asserts the absence stays true. |
| Event catalog | A fuller subscription list | One subscription | Listing handlers that do not exist would enqueue jobs nothing consumes |

### 6.4 Not in the design, present in the code

The WhatsApp inbound path (`crm.ingest_whatsapp_message`, webhook HMAC
verification, lead capture) was built after `ARCHITECTURE.md` was written. It is
described in `AGENCYOS_AUTOMATION.md` §2.

---

## 7. Architectural rules to preserve

Derived from what the codebase already does consistently. A change that breaks
one of these should be challenged in review.

1. **Concurrency invariants live in Postgres.** If two callers racing could break
   it, a TypeScript check cannot enforce it.
2. **Refuse, do not clamp.** An amount that does not fit is a conversation, not a
   rounding decision.
3. **The ledger is the rows; cached sums are derived.** Recompute, never
   increment.
4. **Errors are never empty results.** Holds throughout now. The money path
   propagates a `Result`; the render paths throw into an `error.tsx` boundary.
   D3, D5, D6 and G-054 were each one instance of it.
5. **Modules couple only through the event catalog.**
6. **Service-role code scopes tenancy by hand, from the job — never from input.**
7. **AI proposes; a human with a capability decides.**
8. **Client-visible artifacts are versioned, never overwritten.**
9. **Every gated transition writes an audit row in the same breath.**
10. **No secrets in source, tests, migrations, PR descriptions, logs or messages.**
