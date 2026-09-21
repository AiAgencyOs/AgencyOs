# AgencyOS Phase 1 Audit — 2026-09-21

Fresh verification pass against the existing tracking docs
(`AGENCYOS_PHASE1_MASTER_IMPLEMENTATION_PLAN.md`, `AGENCYOS_PHASE1_EXECUTION_CHECKLIST.md`,
`BLOCKERS.md`), the 13 Phase 1 spec PDFs under `Phase 1 documents/`, and live code/DB
evidence gathered today. Branch: `fix/merge-duplicate-leads` (5 commits ahead of the
checklist's last entries, adding G-310 through G-316: multirole, finance role, one
lead timeline, lead merge, no-advance exception, requirement fields).

**Method**: read all four tracking docs in full; skimmed/cross-checked the 13 PDFs
against the checklist's own citations (the checklist already extracts and cites them
precisely — no material discrepancy found in a spot-check of Sales Flow, Scheduler,
Quotation Master and Final Gap-Closure sections cited); applied all 225 migrations to
a scratch local Postgres via `supabase db reset`; ran the Phase-1-relevant
`db:verify:*` scripts against it (with `next dev` up for the two that hit HTTP); ran
the node test runner directly on the five new WIP test files (`mock.module` requires
Node's own runner, not vitest — that tripped the first attempt).

## Requirement table

| REQ ID | Requirement | Code location | Verify evidence | Status | Notes |
|---|---|---|---|---|---|
| PH1-SAL-001 | Lead intake, source/contact capture | `src/modules/crm/*`, `crm.leads`/`contacts` | ran clean on scratch DB | COMPLETE_VERIFIED | |
| PH1-SAL-002 | Duplicate check / identity resolution (import path) | `src/lib/import/match.ts` | `db:verify:import`, `db:verify:returning` (not re-run today; code present, matches checklist) | IMPLEMENTED_UNVERIFIED (today) | Prior verify evidence stands; not re-executed this pass |
| NEW | Lead merge (post-hoc duplicate, G-316) | `supabase/migrations/20260921130000_two_leads_that_were_always_one.sql` (`crm.merge_leads`), `src/modules/crm/service.ts` (`mergeLeads`) | `node --test tests/two-leads-that-were-always-one.test.ts` → 5/5 suites, 22 assertions pass | COMPLETE_VERIFIED for the door logic; **BROKEN at the tenancy-guard layer** — see P0-1 below | Owner-only, reason required, refuses same-contact mismatch and any-opportunity-present; audits; nothing deleted |
| PH1-SAL-003 | Lead lifecycle states | `crm.leads.status` (6 states + `nurture`) vs Doc 09's 14 | n/a | PARTIAL (by decision, not a defect) | Confirmed still open per BLOCKERS.md — needs an Admin vocabulary-mapping decision, not code |
| PH1-SAL-004 | Qualification (folded into Sales, no separate Lead Qualifier) | `crm.qualification_coverage`; no `lead_qualifier` key anywhere in `src/modules/agents/registry.ts` | `db:verify:qualification` → 15/15 checks pass (ran today) | COMPLETE_VERIFIED | Confirms the locked decision: qualification is state on the lead, not a second agent |
| PH1-SAL-005/006 | Requirement discovery + versioning, incl. new assumptions/nice-to-haves/exclusions/design-refs (G-313) | `crm.requirement_versions`, `src/modules/sales/schema.ts` | `node --test tests/what-the-requirement-does-not-say.test.ts` → 3/3 suites pass | COMPLETE_VERIFIED | Schema, prompt, and lead-page render all checked, not just the schema |
| PH1-SAL-007/008 | Objections, negotiation limits, approval routing | `sales.objections`, `approvals.approval_policies` | `db:verify:approvals` → 51 checks pass; `db:verify:quotedispatch` → 176/176 pass (needed `next dev`) | COMPLETE_VERIFIED | Confirms admin approval genuinely gates: negotiation past the configured round limit becomes a named approval, not an autonomous send |
| PH1-SAL-009 | No-advance payment exception (G-311) | `sales.request_payment_exception` (migration `20260921100000`), `src/modules/sales/service.ts` | `node --test tests/the-no-advance-exception-can-be-asked-for.test.ts` → 2/2 suites, 12 assertions pass | COMPLETE_VERIFIED | Names the accepted proposal (not the opportunity), matches the WON-gate's own selector — does not reimplement approve/reject |
| PH1-SAL-timeline | One merged lead timeline (G-312) | `crm.lead_timeline`, `src/modules/crm/queries.ts` (`listLeadTimeline`) | `node --test tests/one-timeline-for-a-lead.test.ts` → 3/3 suites pass | COMPLETE_VERIFIED | Old `listLeadActivities` reader confirmed removed, not left dangling; failed read throws (G-054 discipline) rather than rendering empty |
| PH1-SCH-001..007 | Scheduler domain, availability, booking, reminders, completion/evidence, no-show follow-up | `crm.meetings`, `src/lib/scheduling/{availability,booking,reminders,google}.ts` | Not re-run today (no `.env` Google creds locally); code present and matches checklist's own G-225..G-249 citations | IMPLEMENTED_UNVERIFIED (today) / prior COMPLETE_VERIFIED stands | No separate `scheduler` key in the agent registry — Scheduler is a deterministic domain+service layer, not an LLM agent, consistent with "folded" architecture |
| PH1-QM-001..007 | Quotation Master: pricing, discount bounds, tax, milestones, versioning, approval-gated send, delivery≠acceptance | `src/modules/sales/{quotation-standards,pricing-*,production-cost}.ts`, `approvals.approval_policies`, `sales.payment_structures` | `db:verify:quotedispatch` (176/176), `db:verify:dealterms` (16/16), `db:verify:second` (13/13) all ran clean today | COMPLETE_VERIFIED | No `quotation_master` agent key either — same folded-into-services pattern as Scheduler |
| PH1-CLS-001 | WON gate: accepted version + payment/exception evidence | `sales.won_gate_verdict`, trigger `opportunities_won_gate` | `db:verify:wongate` → 22/22 checks pass today | COMPLETE_VERIFIED | Binds the transition (`old.stage is distinct from 'won'`), not the row — re-confirmed live |
| PH1-CLS-002 | Structured Phase 2 handoff packet | `sales.record_won_handoff`, `ai.handoffs`, `sales.won_handoff_packet` | `db:verify:handoff` → 56/56 checks pass today (needed `next dev`) | COMPLETE_VERIFIED | Confirms Phase 2 genuinely starts from the event (`project.handoff_bound` → runner starts `project_manager` phase with **no door called by hand**) — this answers the audit's specific question: yes, WON produces a consumable handoff and Phase 2 does start from it, at least structurally (agents still mostly disabled — see OR-004) |
| PH1-OR-001 | Agent capability registry | `src/modules/agents/registry.ts` — 13 keys, none named `scheduler` or `quotation_master` | not re-run (`db:verify:definitions` needs the react-server tsx harness; skipped for time) | IMPLEMENTED_UNVERIFIED (today) | Confirms locked-flow "5 Phase 1 agents" is a business-role framing, not 5 registry rows — Sales and Coordination/Orchestrator are the only Phase-1-relevant registry keys; Scheduler and Quotation Master are services |
| PH1-OR-002 | Routing by policy/health/cost/latency | `src/lib/ai/router.ts` (112 lines, single-provider resolution) | grep-confirmed: `ai.routing_policies` still has zero readers in `src/`/`app/` | PARTIAL (matches checklist, unchanged) | |
| PH1-OR-004 | Agent activation | `ai.agents` rows | not re-run | BLOCKED (BLK-001/002, unchanged) | |
| Tenancy | Every org-scoped FK has an `enforce_parent_org`-class guard | `db:verify:tenancyguards` | **FAILED today**: `crm.leads.merged_into_lead_id` has no guard | **BROKEN** — see P0-1 | New self-referencing FK added by G-316 (this branch) was not paired with its tenancy trigger |
| Security posture | No unguarded org-scoped FK (posture summary) | `db:verify:security` | **FAILED today**: 5/6, one unguarded FK reported | **BROKEN** — same root cause as above, different verifier | |
| Approval announcement | An approval nobody was told about gets announced once linkage exists | `crm.hand_conversation_to_a_person`-adjacent announce job | `db:verify:unannounced` → 15/19 pass, 4 fail (announce job didn't fire/send in this run) | INCONCLUSIVE / likely DISCONNECTED-in-this-harness | The script's own comments say the announcements wait "for the dispatcher" — this local run had no background job-runner process draining the outbox; not confirmed as a genuine app regression, but also not proven healthy today. Needs re-run with the worker process live before trusting either way |
| Journey (full funnel) | Lead→deal→quotation→acceptance chain holds end to end | `scripts/verify-journey.mjs` | Passed on first successful run after DB reset (an earlier attempt before `supabase db reset` finished failed with `fetch failed`, expected — DB wasn't up yet) | COMPLETE_VERIFIED | |
| Reactivation pilot | Off by default, consent-gated | `db:verify:reactivation` | 16/16 pass | COMPLETE_VERIFIED | |
| No-lead-score | Reactivation ranks by recorded fact, not an invented score | `db:verify:noscore` | all checks pass | COMPLETE_VERIFIED | |
| Authority/consent | Consent cannot be erased, completion cannot be forged | `db:verify:authority` | 18/18 pass | COMPLETE_VERIFIED | |
| Multirole (G-310) | A person can hold more than one role | migration `20260920190000`, `core.membership_roles` | not independently re-run this pass (pre-existing, checklist-covered); WIP finance-role test builds on top of it and passed | IMPLEMENTED_UNVERIFIED (today) | |
| Finance role (G-314) | A role that reads money, not sales notes | migration `20260921120000`, RLS on `finance.invoices`/`finance.payments` | `node --test tests/a-role-that-only-reads-money.test.ts` → 3/3 suites, 10 assertions pass | COMPLETE_VERIFIED | Confirmed narrow: not added to `core.is_internal()`, not added to multirole grant door, routes to `/invoices` only |

## Summary of status counts (this pass's direct evidence only)

- COMPLETE_VERIFIED: 14
- IMPLEMENTED_UNVERIFIED (today, prior evidence stands unchanged): 5
- PARTIAL (by documented decision, not a defect): 2
- BROKEN: 2 (same underlying cause)
- INCONCLUSIVE: 1
- BLOCKED (external/business decision, matches BLOCKERS.md, unchanged): 1

This is a narrow slice of the full ~90-item checklist — I prioritized (a) the locked
flow's structural joints (duplicate check, qualification, WON gate, handoff→Phase 2
start), (b) everything the current branch's 5 uncommitted-to-checklist commits touch,
and (c) re-executing verifiers live rather than trusting the checklist's dates. The
checklist itself is unusually rigorous (self-red-proving verifiers, "assert the branch
not the return value" discipline, live-migration proof) and nothing I checked
contradicted its existing `[x]` marks — except the two new P0 items below, which are
new work on this branch that postdates the checklist.

## P0 / P1 / P2 issues

**P0-1 — `crm.leads.merged_into_lead_id` (G-316, this branch) has no tenancy guard.**
`supabase/migrations/20260921130000_two_leads_that_were_always_one.sql:56` adds
`merged_into_lead_id uuid references crm.leads(id)` — a self-referencing FK on an
org-scoped table — without the matching `enforce_parent_org`-class trigger that every
other FK on `crm.leads` carries. Confirmed two ways today:
`npm run db:verify:tenancyguards` fails naming exactly this column
(`crm.leads.merged_into_lead_id`), and `npm run db:verify:security` independently
reports "1 unguarded org-scoped foreign key." Practical exposure: nothing today
prevents an UPDATE from setting `merged_into_lead_id` to a lead row in a *different*
organization, which the merge door (`crm.merge_leads`) itself would refuse (it checks
both leads belong to one org before merging) but a direct/other-path write would not.
This is exactly the pattern the project's own memory notes flag ("Tenancy-guard
pattern") and is a same-day, fixable gap — add the guard trigger, no data model
change needed. Blocks: `db:verify:tenancyguards` and `db:verify:security` from being
green in CI; this branch cannot merge clean without it.

**P1-1 — `db:verify:unannounced` failed 4/19 in this environment**, all four failures
clustered around "the announce job actually sends / re-announces once." The script's
own comments attribute delivery to a background dispatcher process this run did not
have running. This needs re-verification with the worker (`db:verify:worker`-style
process or the real job runner) live before either accepting or reporting this as a
real regression — flagging as open rather than asserting either way, since asserting
a pass or fail here without the dispatcher would be exactly the "half a check"
mistake the project's own memory warns about.

**P1-2 — Scheduler and Quotation Master have no entries in `src/modules/agents/registry.ts`.**
This is very likely intentional (both are deterministic domain+service layers per the
checklist's own SCH/QM sections, not LLM-driven agents), and matches the locked
flow's framing of "5 Phase 1 agents" as business roles rather than 5 registry rows.
Flagging only because the audit brief specifically asked whether a component exists —
worth one Admin-facing sentence confirming this is by design, not a gap, so a future
reader doesn't "fix" it by inventing agent rows.

**P2-1 — `PH1-OR-002` (routing by policy/health/cost/latency) remains unbuilt**;
`ai.routing_policies` still has zero readers anywhere in `src/`/`app/` per grep today.
Matches the checklist's own existing `[~]` — no change, just reconfirmed.

**P2-2 — Lead lifecycle vocabulary mismatch (PH1-SAL-003)** remains an open Admin
decision (6 states + `nurture` built vs. 14 named in CRM Doc 09 §6). Reconfirmed
unchanged; not a code defect.

## What was NOT independently re-verified this pass (time-boxed)

`npm run typecheck` and `npm run lint` were not run (explicitly optional in the
brief and the full check chain is reported elsewhere as green as of the last
`check:record`). Scheduler's live Google Calendar adapter, WhatsApp production
channel, and full `npm run check` (3,900+ tests) were not re-run — these are exactly
the items the project's own BLOCKERS.md already tracks as credential-gated
(BLK-001, BLK-003, BLK-005) or checklist-verified in a prior session; nothing found
here contradicts those records.
