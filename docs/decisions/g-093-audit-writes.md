# G-093 — the fourteen audit writes that are not in a transaction

**Status:** open, awaiting an Admin decision (**ADM-51**)
**Raised by:** G-079, which fixed four of eighteen and split the rest out
**Written:** 2026-08-13

---

## The problem, precisely

`audit.audit_log` is append-only by trigger. A row that is never written can
never be written later — there is no repair, no backfill, no reconciliation.
That is deliberate and it is what makes the trail worth having.

Fourteen audit rows are written in a request of their own, after the change
they describe has already committed:

```ts
await supabase.schema('crm').from('leads').update({ status });   // commits
await recordAudit({ action: 'lead.status_changed', ... });        // separate
```

Between those two lines the process can die, the connection can drop, or the
function can time out. The lead is converted and the history says nobody did
it. **The change survives and its record does not.**

G-079 fixed this for the four writes that already had a Postgres function to
sit inside. These fourteen have none: they are ordinary two-statement service
writes, and fixing them the same way means putting each module's writes behind
a database function.

## What is actually at risk

Not much, most days, and that is worth saying plainly rather than
dramatising:

| | |
| --- | --- |
| Window | Milliseconds, between two awaits in the same handler |
| Frequency | Only when a process dies inside that window |
| Consequence | One missing history row; the business state is correct |
| Detectable | No. Nothing compares state changes against audit rows |

The last line is the uncomfortable one. A missing audit row is invisible: there
is no count that should match, no reconciliation that would fail. If it has
already happened, nobody knows.

Against that: the fourteen are the ordinary CRM and sales writes — a lead
status, a follow-up date, a note. The four G-079 moved were the ones that
matter most (money, payment plans), and they are already safe.

## The options

### A. Accept it, and say so

Record the window as understood and leave the code alone. Cost: nothing. Risk:
a rare, undetectable hole in the trail for non-financial actions.

This is defensible **only if written down**. An accepted risk nobody stated is
just a bug with tenure.

### B. Move each write into a Postgres function

The G-079 pattern, fourteen more times. Each becomes
`crm.set_lead_status(...)` and so on, writing the row and its audit in one
transaction.

- **For:** exact, proven, and the audit row commits with the change.
- **Against:** fourteen functions, fourteen migrations' worth of plpgsql, and
  a service layer that becomes a thin RPC caller. Every future change to a
  lead write is a migration. This is the change the gap says "should be argued
  on its own merits", and the argument is not obviously in favour: it trades a
  small, rare risk for a large, permanent shift in where logic lives.

### C. Audit by trigger on the tables themselves

An `after insert or update` trigger on `crm.leads`, `sales.opportunities` and
the rest, writing an audit row from inside the same transaction as any change,
whatever wrote it.

- **For:** one migration, not fourteen. Covers **every** path — including
  writes made directly through PostgREST, a psql session, or a future service
  nobody has written yet, none of which a service-layer call could ever cover.
  `auth.uid()` is available in a trigger, so the actor is still recorded.
- **Against:** a trigger sees rows, not intent. It can say `leads.status`
  changed from `qualified` to `converted`; it cannot say
  `lead.converted` — the vocabulary the current audit actions carry, which is
  what makes the log readable. It would also record every change, including
  ones nobody considered worth auditing, which is a different kind of noise.

### D. Both, split by what each is good at

Triggers for the *record* — who changed which columns, when, in the same
transaction, on every path. The existing `recordAudit` calls kept for the
*meaning*, where a semantic action name says something the column diff does
not (`milestone.unlock_skipped` is not visible in any row).

- **For:** the durable half becomes untuckable, the readable half stays.
- **Against:** two audit mechanisms, and a reader has to know which answers
  which question. That is a real cost in a system whose whole appeal is that
  one table answers "who did what".

## What I would choose, and why

**C, with a narrow scope: the tables whose changes are business-significant,
and nothing else.**

The reasoning is that B fixes the stated problem and buys very little. The
fourteen sites are already the least consequential ones, and moving them turns
every future CRM change into a migration — a permanent tax paid for a rare,
low-severity hole.

C fixes something B cannot: it covers paths that do not go through the service
layer at all. This repository has already found two defects of exactly that
shape — RLS that was wider than the capability model (D16), and a function
whose caller could be bypassed entirely. A trail that depends on everybody
remembering to call `recordAudit` has the same weakness.

The loss of semantic action names is real, and it is why the recommendation is
C rather than D: adding triggers *and* keeping fourteen calls is the worst of
both. If the vocabulary matters more than the coverage, the honest answer is A
— say the window is accepted and move on.

## What is not being asked

This is not a question about money. Payments, invoices, payment plans and the
approval engine already audit from inside their own transactions, and nothing
here changes them.

## The decision

**ADM-51.** One of:

- **A** — accept and document the window
- **B** — fourteen Postgres functions
- **C** — table triggers, replacing the fourteen calls *(recommended)*
- **D** — triggers plus the existing calls

Until it is answered, the fourteen stay as they are and the count is pinned by
`tests/audit-in-the-transaction.test.ts` §F — which now scans `src/modules`
rather than naming files, because the previous version listed five services and
missed two call sites added later in a module it had never heard of.
