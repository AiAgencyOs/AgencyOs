# Checkpoint — autonomous run, 2026-08-14

A working document, rewritten as the run proceeds. It exists so that a context
boundary is not a project boundary: anyone picking this up — including me, in a
fresh context — should be able to continue from the *next task* line without
re-deriving anything.

---

## HEAD

`1d6e011` — feat(projects): a list the Admin can change (G-113, ADM-80) (#140), plus G-012 arithmetic in flight

Working tree clean · 0 open PRs · CI on main green.

| Gate | Result |
|---|---|
| typecheck / lint / secrets / build | 0 / 0 / 0 / 0 |
| tests | **1,631 passing**, 359 suites, 0 failing |
| check-record | 0 |

**126 gaps — 114 closed, 12 open. 81 of 83 decisions granted.**

---

## Completed this run

| PR | Gap | What |
|---|---|---|
| #133 | G-133, G-134 | Agent step/cost ceilings and handoff depth actually enforced |
| #134 | G-111 | `lapsed` quotation state; ADM-77/78/79 delegated |
| #135 | G-095 | The historical snapshot refuses to run; ADM-58 delegated |
| #136 | G-135 | Consent before sending; **ADM-81 delegated** |
| #137 | G-036 | Upsell opportunities, internal only — trigger taken from §2.7 |
| #138 | G-034 | Minimum maintenance model — post-handover work, no product invented |
| #139 | G-037 | Client relationship **facts**, not a valuation; found a client-visible view |
| #140 | G-113 | Admin-configurable onboarding baseline — **ADM-80 delegated** |
| — | G-012 | ADM-69's scheduling arithmetic, pure and exhaustively tested |

Earlier in the session: G-126, G-130, G-131, G-132, §17 of `check-record`, the
deployment runbook and the external-verification checklist.

---

## Delegated decisions taken

| Decision | Taken as |
|---|---|
| **ADM-58** | The snapshot refuses to run |
| **ADM-77** | A lapsed quotation may still be **declined** |
| **ADM-78** | `lapsed` is terminal; exits are `→rejected` and `→superseded` only |
| **ADM-79** | Nobody is notified on lapse; no notification machinery |
| **ADM-81** | **No transactional exception** — every client-facing send needs recorded consent |
| **ADM-80** | Baseline is Admin-configurable per org; edits affect **future projects only** |

Each is recorded with its reasoning in `docs/roadmap/roadmap.json`.

---

## Open gaps (15)

**Delegatable — no external fact needed:**

- **G-012** Follow-up scheduler — *no longer blocked by a decision*; consent model now exists
- **G-013** Portfolio/AI sales assistance — Admin management capability
- **G-101** L2 caller — closes only when an L2 agent runs (Phase 5)

**Needs a business decision nobody has taken:**

- **G-136** Consent for a project group is unmodelled *(raised this run)*
- **G-137** No timezone is stored, and ADM-69's window depends on one *(raised this run)*

**External — cannot be done here:**

- **G-052** deployment (ADM-60 ×5) · **G-091**, **G-122**, **G-123** (Meta)
- **G-110**, **G-116** (external verification) · **G-129** (ADM-85)

---

## Open decisions (3)

| | |
|---|---|
| **ADM-60** | 5 production facts — external |
| **ADM-85** | Which provider, whose account — external fact, must not be invented |

---

## External blockers

1. Production Supabase project ref, Vercel plan tier, service-role key custodian, production domain, alert destination
2. A Meta Business account: business verification, App Review → Advanced Access, Tech Provider vs Solution Partner
3. A restore rehearsal — no backup has ever been restored
4. The second AI provider and whose account it sits on

`docs/deployment/external-verification.md` holds the checklist; its sign-off
table is deliberately empty.

---

## Next task

**G-012 — wire the scheduler to triggers, jobs and the send path.**

The arithmetic is done and merged: `src/modules/crm/follow-up-rhythms.ts`
holds ADM-69's four rhythms, business-day and window handling, and SLA
precedence, as pure functions with 25 tests over three zones and two daylight-
saving transitions. **Nothing calls it yet.**

What remains, in order:

1. **Trace each of the eight situations to a real database fact** — which
   column or event starts each rhythm. Do not invent a trigger; if a situation
   has no observable fact behind it, record that rather than inventing one.
2. Wire to the **existing** outbox, job runner and `claim_jobs`. Do not build a
   second job subsystem.
3. Idempotency per (subject, rhythm, attempt) so a retry or a second worker
   cannot double-send.
4. Stop conditions, cancellation, owner override, escalation.
5. Re-check state between scheduling and sending — a lead that converted, a
   quotation that lapsed, or consent withdrawn in the interim must not be
   messaged.

**Blocked on G-137 for the last mile only:** the window needs a timezone and
none is stored. Everything above can be built and tested against an explicit
zone; only the final production send needs the real value.

After that: **G-013**'s Admin portfolio management, then **G-136**'s decision
gate, then provider-independent routing work under ADM-85.
