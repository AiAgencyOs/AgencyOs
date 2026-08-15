# Checkpoint — autonomous run, 2026-08-14

A working document, rewritten as the run proceeds. It exists so that a context
boundary is not a project boundary: anyone picking this up — including me, in a
fresh context — should be able to continue from the *next task* line without
re-deriving anything.

---

## HEAD

`(in flight)` — G-012 closes: the delivery pass (#157)

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
| #149 | G-012 | Observation layer — five situations; **G-138** raised for two |
| #150 | G-012 | The worker: observe, revalidate, claim, send, record. **G-137 narrowed** |
| #152 | G-012 | The worker **executed** against real rows — found the catch-up flood |
| #154 | G-012 | Delivery path: `followup.queued` → job runner → provider; the follow-up was never actually being sent |
| #155 | G-012 | Exhaustion through the worker; the wedge fixed; **G-139** raised |

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
- **G-138** Two ADM-69 situations have no distinguishing fact
- **G-139** Post-project has no legal conversation to send on *(raised this run)*

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

**G-012 — CLOSED, with its boundaries stated.**

Every closure criterion carries execution evidence: 92 live checks across the
worker and delivery scripts, five genuine red proofs, situations 1/4/5/7 end to
end, 8 honestly stopped (G-139), 2/3 never scheduled (G-138), payment deferred.

The delivery pass found three defects: the pending-only settle guard that made
a successful retry read `failed` forever (now: **sent is terminal, nothing else
is**); the internal-approval rhythm that **never ran** because nothing resolved
the internal group; and a dedupe check that its own red proof exposed as
decorative (`published_at` guarded the ordinary path — the key protects the
crash window, and the check now simulates it).

**Boundaries, so nobody over-reads the closure:**
- At-most-one **logical** send per (sequence, attempt). The double-submission
  window after a crash between provider-accept and local-record was *measured*;
  external delivery stays provider-dependent.
- Nothing sends in production until the owner supplies the **G-137** timezone.
- The message body is one neutral placeholder sentence until a Phase 5 agent
  writes real text.

**Next task:** re-measure, rebuild the graph, pick the highest-value actionable
item. Candidates in rank order: G-013 Admin portfolio management (P2, decisions
granted, boundary set by §5.3) · the remaining production-preparation tooling
under ADM-60 that needs no credentials · G-101/Phase-5 groundwork only if ADM-82
is revisited by the owner.

After that: **G-013**'s Admin portfolio management, then **G-136**'s decision
gate, then provider-independent routing work under ADM-85.
