# Checkpoint — autonomous run, 2026-08-14

A working document, rewritten as the run proceeds. It exists so that a context
boundary is not a project boundary: anyone picking this up — including me, in a
fresh context — should be able to continue from the *next task* line without
re-deriving anything.

---

## HEAD

`346b264` — feat(crm): no consent, no send (G-135, ADM-81) (#136)

Working tree clean · 0 open PRs · CI on main green.

| Gate | Result |
|---|---|
| typecheck / lint / secrets / build | 0 / 0 / 0 / 0 |
| tests | **1,555 passing**, 332 suites, 0 failing |
| check-record | 0 |

**125 gaps — 110 closed, 15 open. 80 of 83 decisions granted.**

---

## Completed this run

| PR | Gap | What |
|---|---|---|
| #133 | G-133, G-134 | Agent step/cost ceilings and handoff depth actually enforced |
| #134 | G-111 | `lapsed` quotation state; ADM-77/78/79 delegated |
| #135 | G-095 | The historical snapshot refuses to run; ADM-58 delegated |
| #136 | G-135 | Consent before sending; **ADM-81 delegated** |

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
- **G-034** Maintenance · **G-036** Upsell · **G-037** Client lifetime
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

**G-036 — upsell opportunity detection, internal only.**

The boundary is already absolute and recorded in `docs/business-os/04-client-lifecycle.md`:

> "AgencyOS may **identify** an opportunity and tell the team. It may not price
> one: there is no catalog, and every price is quoted per client by a human."

So: detect from observable repository facts, record internally, never price,
never send to a client. The trigger definition is a delegated conservative
policy, drawn from signals that already exist — scope growth across requirement
versions, modules added after a project starts — not from invented financial
thresholds.

After that, in order: **G-034** (minimum maintenance model), **G-037**
(recorded facts vs derived metrics, kept distinct), **ADM-80/G-113**, then
**G-012**'s scheduler.
