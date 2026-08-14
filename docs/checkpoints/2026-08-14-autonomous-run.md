# Checkpoint — autonomous run, 2026-08-14

A working document, rewritten as the run proceeds. It exists so that a context
boundary is not a project boundary: anyone picking this up — including me, in a
fresh context — should be able to continue from the *next task* line without
re-deriving anything.

---

## HEAD

`d3024c2` — feat(projects): work that comes after handover (G-034) (#138), plus G-037 in flight

Working tree clean · 0 open PRs · CI on main green.

| Gate | Result |
|---|---|
| typecheck / lint / secrets / build | 0 / 0 / 0 / 0 |
| tests | **1,589 passing**, 346 suites, 0 failing |
| check-record | 0 |

**125 gaps — 113 closed, 12 open. 80 of 83 decisions granted.**

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
| — | G-037 | Client relationship **facts**, not a valuation; found a client-visible view |

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

Each is recorded with its reasoning in `docs/roadmap/roadmap.json`.

---

## Open gaps (15)

**Delegatable — no external fact needed:**

- **G-012** Follow-up scheduler — *no longer blocked by a decision*; consent model now exists
- **G-013** Portfolio/AI sales assistance — Admin management capability
- **G-113** Onboarding baseline (ADM-80)
- **G-101** L2 caller — closes only when an L2 agent runs (Phase 5)

**Needs a business decision nobody has taken:**

- **G-136** Consent for a project group is unmodelled *(raised this run)*

**External — cannot be done here:**

- **G-052** deployment (ADM-60 ×5) · **G-091**, **G-122**, **G-123** (Meta)
- **G-110**, **G-116** (external verification) · **G-129** (ADM-85)

---

## Open decisions (3)

| | |
|---|---|
| **ADM-60** | 5 production facts — external |
| **ADM-80** | Onboarding baseline shape — **delegatable** |
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

**ADM-80 / G-113 — the Admin-configurable onboarding baseline.**

ADM-73 granted the principle and withheld implementation until the shape is
reviewed. The repository already established that `project_type` is **not** the
right axis. Preserve the existing 17 onboarding items, `not_applicable`, and
existing project history; decide conservatively whether template changes affect
existing projects (they should not — a change to a template must not rewrite
what a project already recorded).

After that: **G-012**'s follow-up scheduler, which the consent model in #136
unblocked, and then **G-013**'s Admin portfolio management.
