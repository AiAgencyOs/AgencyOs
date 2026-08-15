# Checkpoint — autonomous run, 2026-08-14

A working document, rewritten as the run proceeds. It exists so that a context
boundary is not a project boundary: anyone picking this up — including me, in a
fresh context — should be able to continue from the *next task* line without
re-deriving anything.

---

## HEAD

`baf0c8f` — the restore rehearsal: an untested backup stops being a hypothesis, locally (#160)

Working tree clean · 0 open PRs · CI on main green.

| Gate | Result |
|---|---|
| typecheck / lint / secrets / build | 0 / 0 / 0 / 0 |
| tests | **1,665 passing**, 370 suites, 0 failing |
| check-record | 0 |

**128 gaps — 115 closed, 13 open. 81 of 84 decisions granted.**

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
| #157 | G-012 | **Closed.** Delivery through the real dispatcher/jobs/provider boundary; sent is terminal; 7 review findings and 2 CI-found defects fixed |
| #159 | G-013 | Blocker narrowed — its two claims had gone false (ADM-82 granted, consent gate built). What remains: activation, authority, content |
| #160 | G-052 | **Restore rehearsal** — dump alone rebuilds a scratch db, counts+checksums from one snapshot, in CI every merge; 11 review findings fixed pre-PR |

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

## Open gaps (13)

**Delegatable — no external fact needed:**

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

## A verify script leaves shared state as it found it

Three identical CI failures, none reproducible locally, taught this run's
second discipline rule. The delivery script runs the **real dispatcher**, and
the real dispatcher dispatches the **whole outbox** — so a foreign unpublished
event (verify-refunds', awaiting verify-whatsapp-groups' global sweep, which
runs *later*) was fossilized into a job nothing drained, and the app block's
zero-jobs check found the corpse.

> **A verify script that exercises shared machinery snapshots the shared state
> it can touch, and its cleanup restores that state exactly — not just the rows
> it created.**

Two subtler lessons underneath: a green local replay is only evidence if the
**whole chain** ran (the offender and the sweep were both scripts this session
never replayed); and a diagnostic that prints *identities* rather than counts
turns one CI cycle into an answer instead of a guess.

---

## Next task

**G-012 — CLOSED and merged at `8200be4` (#157).**

Every closure criterion carries execution evidence: **102 live checks** across
the worker (59) and delivery (43) scripts, five genuine red proofs, situations
1/4/5/7 end to end, 8 honestly stopped (G-139), 2/3 never scheduled (G-138),
payment deferred.

The delivery pass found three defects: the pending-only settle guard that made
a successful retry read `failed` forever (now: **sent is terminal, nothing else
is**); the internal-approval rhythm that **never ran** because nothing resolved
the internal group; and a dedupe check that its own red proof exposed as
decorative (`published_at` guarded the ordinary path — the key protects the
crash window, and the check now simulates it). Adversarial review added seven
findings, CI added two more — the approval fixture that leaked undeletable
organizations, and the fossilized-outbox failure recorded above.

**Boundaries, so nobody over-reads the closure:**
- At-most-one **logical** send per (sequence, attempt). The double-submission
  window after a crash between provider-accept and local-record was *measured*;
  external delivery stays provider-dependent.
- Nothing sends in production until the owner supplies the **G-137** timezone.
- The message body is one neutral placeholder sentence until a Phase 5 agent
  writes real text.

**G-013 was measured and is honestly not buildable here** (#159): §5.3's only
sender is AgencyOS, the sales agent sits unactivated behind ADM-82's layer
gates, no ADM authorizes a human-triggered send, and the list's content is an
external fact only the Admin can supply. The stale record claiming otherwise
was the deliverable.

**The delegatable backlog is now nearly empty.** Every remaining open gap
needs either an owner decision (G-136/137/138/139, ADM-85/86), an external
account (Meta: G-091/122/123; provider: G-129), a production deployment
(G-052's five ADM-60 blanks, G-110/116 verification), or Phase-5 activation
(G-101, G-013 part 3).

**Next task:** the remaining credential-free preparation the documents
themselves name. OPERATIONS' unticked "Smoke tests defined" is the strongest
candidate — the runbook's post-deploy check table is half of it, and
`verify-target.mjs` already knows how to point at a deployment. After that,
the honest state is: wait for owner facts, and keep main green.
