# Checkpoint — autonomous run, 2026-08-14

A working document, rewritten as the run proceeds. It exists so that a context
boundary is not a project boundary: anyone picking this up — including me, in a
fresh context — should be able to continue from the *next task* line without
re-deriving anything.

---

## HEAD

`ead92ea` — feat(crm): a sequence that cannot send twice (#148), plus the observer in flight

Working tree clean · 0 open PRs · CI on main green.

| Gate | Result |
|---|---|
| typecheck / lint / secrets / build | 0 / 0 / 0 / 0 |
| tests | **1,659 passing**, 367 suites, 0 failing |
| check-record | 0 |

**126 gaps — 114 closed, 12 open. 81 of 84 decisions granted.**

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
| #141 | G-012 | ADM-69's scheduling arithmetic, pure and exhaustively tested |
| #142 | G-136 | Investigated; **ADM-86** raised as a precise gate with three options |
| #147 | G-012 | The eight situations traced; ADM-69's ten-step contract |
| #148 | G-012 | Persistence: a sequence that cannot send twice |
| — | G-012 | Observation layer — five situations; **G-138** raised for two |

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
- **G-137** No timezone is stored, and ADM-69's window depends on one
- **G-138** Two ADM-69 situations have no distinguishing fact *(raised this run)*

**External — cannot be done here:**

- **G-052** deployment (ADM-60 ×5) · **G-091**, **G-122**, **G-123** (Meta)
- **G-110**, **G-116** (external verification) · **G-129** (ADM-85)

---

## Open decisions (3)

| | |
|---|---|
| **ADM-60** | 5 production facts — external |
| **ADM-86** | Does project-group membership permit messaging it? Three implementable options; raised, not decided |
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

## The §10 rule, learned the hard way

`main` went red on three consecutive merges, each time for the same reason, and
one of the repairs repeated the fault it was fixing.

> **Every PR makes two edits to §10: backfill the row above it with the
> previous PR's hash, and add a row describing its own change.**

The trap is that §10 permits the **newest merge** to be outstanding — so a PR
that adds no row **passes its own CI** and turns `main` red only when something
merges after it. Run `check-record` *before* pushing, not after merging.

---

## Next task

**G-012 — the job wiring, then the send path.**

Four layers are merged: the arithmetic, the situations and ten-step contract,
the persistence whose constraints make idempotency structural, and the observer
(`crm.observe_follow_up_candidates`, `crm.due_follow_up_sequences`).

**Nothing runs them yet.** What remains:

1. **A worker on the existing job runner.** No second queue. Observe → start
   sequences → for each due sequence, revalidate authoritative state, evaluate
   the contract, then INSERT the attempt as the atomic claim; a uniqueness
   conflict means another worker won, so do nothing.
2. **The send path** through `crm.send_outbound_message`, so consent is
   enforced where G-135 put it. The scheduler decides *due*; the communication
   layer decides *permitted*.
3. **Escalation exactly once**, using the `escalated_at`/status constraint.
4. **Message text** — reuse existing agent infrastructure; the model may not
   price, approve, change scope, or alter rhythm/escalation/stop conditions.

**Two blockers isolated, neither stopping the wiring:** G-137 (no timezone is
stored, so the window cannot be computed for a real send) and G-138 (situations
2 and 3). Both are testable around with an explicit zone and the five
substantiated situations.

After that: **G-013**'s Admin portfolio management, then **G-136**'s decision
gate, then provider-independent routing work under ADM-85.
