# AgencyOS Phase 2 — requirement traceability and gap matrix

> **Sources, in precedence order.** The four locked Phase 2 PDFs in `phase 2 documents/`:
> the Master Flow Implementation Plan & Checklist, and the PM, Finance and Project Planning
> Agent responsibility specifications. Where an older general specification disagrees with a
> locked Phase 2 decision, the Phase 2 decision is the baseline and the conflict is recorded
> in §4 rather than resolved silently.
>
> This file is the P2-01 deliverable the Master Flow asks for: *"Create requirement-to-code
> matrix: EXISTS / PARTIAL / MISSING / CONFLICT / MANUAL."* It is written from reading the
> repository, not from reading the Phase 1 record — a distinction that has already cost this
> project once (G-248: four Scheduler units were built on a chain whose first link did not
> exist, and the record said the work was done).

Read with [BLOCKERS.md](../phase1/BLOCKERS.md) and `docs/roadmap/roadmap.json`, which remain
the live record. Phase 2 gaps are numbered in the same sequence as Phase 1's.

---

## 1. What Phase 2 is

One sentence from the Master Flow: Phase 2 converts a legitimately WON client into an
operationally ready project, PM-led, with Finance and Project Planning working behind the PM
and **two mandatory human gates** — a person creates the WhatsApp group, and a person
verifies the payment.

The locked flow:

```
PHASE 1 WON → PHASE 2 START → PM + CONTEXT → WORKSPACE → MISSING INFO →
WHATSAPP MANUAL ACTION → ADMIN CREATES/MAPS GROUP → GST/NON-GST → FINANCE M1 30% →
EMAIL + WHATSAPP → PAYMENT → PENDING_VERIFICATION → ADMIN VERIFIED →
PROJECT PLANNING → PRE-KICKOFF GATE → PM OFFICIAL KICKOFF → PHASE 2 COMPLETE → PHASE 3 READY
```

---

## 2. The matrix

Status is about the REPOSITORY, not about the plan. `PARTIAL` means a real implementation
exists and does not yet meet the locked requirement; `MISSING` means nothing does it.

### A. Entry — Phase 1 → Phase 2 handoff

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Structured WON handoff packet | Master §5.1, PM §6 PM-01 | **EXISTS** | `ai.handoffs`, written by an AFTER trigger on the WON transition (`20260911180000`) | — |
| `Phase1WonHandoffReady` event | Master §10 | **EXISTS**, named `opportunity.handed_off` | declared in `core.event_types`, emitted at the win | Name differs; the event is the thing |
| A consumer that starts Phase 2 | Master §5.1, PM §6 | **EXISTS** (G-250) | `project.handoff_bound` → `projects.start_phase_two`, drained by the job runner | Phase 2 starts at the BINDING, not the win |
| Idempotent start, no duplicate project | Master §5.1, PM §2 | **EXISTS** (G-250) | `projects.phase_two.project_id` is UNIQUE, and the door takes the project lock before it decides | — |
| Block an invalid handoff rather than invent | Master §13, PM §6 | **EXISTS** (G-250) | `start_phase_two` answers `no_handoff` rather than starting with no inherited context | The handler treats it as permanent: retrying cannot make a packet appear |

### B. PM Agent — onboarding

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| PM agent exists and is enabled | PM §2 | **EXISTS** | `ai.agents` `project_manager`, L2, enabled by the owner's activation answer (2026-09-13) | Its only workflow today is `plan.breakdown` |
| Project / onboarding workspace | Master §5.3 | **EXISTS** | `projects.projects`, `projects.onboarding_items`, `projects.onboarding_baseline` (versioned, frozen per project) | Not created from a handoff |
| Onboarding checklist | Master §5.4, PM §4.3 | **EXISTS** (G-261) | `projects.onboarding_items` — `requirement` and `status` as two axes, all six §5.4 values | Which items are REQUIRED is **ADM-108**, unanswered; until then none are, and the checklist blocks nothing (ADM-06) |
| Context-first: never re-ask what Phase 1 confirmed | PM §4.1, Master §1 | **EXISTS** (G-252) | `src/modules/projects/onboarding-context.ts`, `resolveProjectContext` | Built as a JOIN over `ai.handoffs.unresolved` and `crm.qualification_coverage`, both of which already answered part of it. Reconfirmation raised as **ADM-107** |
| Staged client requests + follow-up | PM §4.2, §6 PM-05 | **PARTIAL** | The follow-up engine (nine situations, rhythms, consent, window) is built and running | No onboarding situation; no PM request/response ingestion |
| Sensitive credentials to secure storage | PM §4.3 | **MISSING** | — | Named in the spec; no store chosen (the same G-229 question the evidence store has) |
| PM state model | PM §11 | **EXISTS** (G-250) | `projects.phase_two.state` — all ten of §11's states | Deliberately not `projects.status`, which is a different fact |

### C. WhatsApp project group — the first human gate

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| A project group is a real thing | Master §5.5 | **EXISTS** | `crm.conversations` with `kind = 'project_group'` and `project_id`; one live group per project by partial index (G-015) | — |
| Group id belongs to one conversation deployment-wide | security | **EXISTS** | unique on the WhatsApp group id | — |
| Manual-action task for Admin | Master §5.5, §6, PM §4.4 | **EXISTS** (G-253, G-254) | `projects.group_setups`, raised at Phase 2 start; the card on the project page and the list on `/operations` | — |
| Default internal team members, configurable | Master §6, PM §8 | **EXISTS** (G-253) | `projects.group_team_defaults` | Active members preselected onto every card |
| Project-level member overrides + snapshot | PM §8 | **EXISTS** (G-253) | `group_setups.members`, editable while pending and frozen at confirmation | One column doing both jobs |
| `PENDING_MANUAL_ACTION → CREATED → MAPPED → VERIFIED` | Master §9 | **EXISTS** (G-253) | `group_setups.state`, one door per transition | Each records who and when |
| No false claim of automatic group creation | Master §6, PM §7 | **EXISTS** (G-254) | ADM-95; the Settings page, and now the card itself | A test forbids a create-group control in the rendered card |

### D. Finance — billing mode, M1, payment

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Invoices, items, numbering | Finance §14 | **EXISTS** | `finance.invoices`, `invoice_items`, `blocking_invoice_number` | — |
| Milestone invoice generation | Finance §4.4 | **EXISTS** | `finance.create_milestone_invoice` (invoice + lines + audit + event in ONE statement, G-078) | Not driven from Phase 2 |
| Issue gated on approval | Finance §4.4 | **EXISTS** | `finance.issue_invoice`, refuses `deliverable_not_approved` (G-100) | — |
| Payment evidence with proof | Finance §4.6 | **EXISTS** | `finance.payment_submissions` — proof_url, reference, payer, method, amount | — |
| **Proof never auto-verifies** | Finance §4.6, §6, Master §5.8 | **EXISTS** | G-007 split `paid_minor` (recorded) from `verified_minor` (confirmed); only the second moves status and emits `invoice.paid` | This is the locked rule, already enforced |
| Admin verification gate | Finance §4.7, Master §5.8 | **EXISTS** | `finance.verify_payment_submission`, `verify_payment`; records verifier, moment, evidence | Decision vocabulary is confirm/reject; **MISMATCH is missing** |
| Cumulative verified percentage | Finance §12 | **PARTIAL** | `finance.net_verified_minor`, `projects.milestones.payment_percent` | No project-level gate object |
| **Billing mode GST / NON_GST** | Finance §4.1–§4.3, Master §5.6 | **EXISTS** (G-255) | `finance.billing_profiles`, `confirm_billing_mode`, `record_billing_details`, `src/modules/finance/gstin.ts` | **This row was wrong when written** — see the correction below |
| Versioned billing snapshot per invoice | Finance §4.2, §15 | **EXISTS** (G-260) | `finance.invoices.billing_profile_id` → the frozen profile version | A reference, not a copy: the version it points at cannot change |
| Invoice delivery by email | Finance §4.5, Master §5.7 | **MISSING** | — | **No email channel exists in this deployment at all** — WhatsApp is the only outbound channel (`outboundChannels: 1`) |
| Invoice delivery to the project WhatsApp group | Finance §4.5 | **PARTIAL** | The group is a conversation and `send_outbound_message` can post into it; quotations already dispatch as a document | No invoice delivery path |
| Delivery evidence per channel | Finance §14 | **PARTIAL** | Messages carry delivery status; quotation dispatch records it | No `InvoiceDelivery` record — waits on a channel (**BLK-003 / BLK-007**) |
| M2/M3/M4 bound to Phase 4/5/6 completion | Finance §2, §8 | **MISSING** | — | Phases 4–6 do not exist yet; the binding is the point, not the phases |
| Phase 7 100% gate | Finance §7 | **MISSING** | — | Architecture must not make it impossible later |
| ₹0 free-maintenance invoice, no verification | Finance §9 | **MISSING** | — | `projects.maintenance_plans` exists; no entitlement or ₹0 path |

### E. Project Planning Agent

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Approved scope to plan from | Planning §3 | **EXISTS** | `projects.scope_versions`, `scope_items`, `deliverables`, `features`, `modules`, `screens` | — |
| Deliverables register (plan-owned) | Planning §8 | **EXISTS** (G-256) | `projects.plan_deliverables` — every §8 field, with `scope_item_id`/`proposal_item_id` enforced | `projects.deliverables` left alone as the QA artifact it is |
| `ProjectPlan` versioned artifact | Planning §15 | **EXISTS** (G-256) | `projects.project_plans` | One active, one draft, a reason required from v2 |
| Dependency register (6 types, owner, needed-by) | Planning §9 | **EXISTS** (G-256) | `projects.plan_dependencies` | A dated window needs a stated basis |
| Operational milestone map | Planning §15 | **EXISTS** (G-262) | `projects.plan_milestones` — §7's three maps as one register | A `finance_gate` REFERENCES `projects.milestones`; it carries no money of its own |
| Timeline shell + assumptions | Planning §11 | **EXISTS** (G-256, G-262) | Milestone and dependency windows, each with a required `timing_basis`; assumptions in `plan_notes` | The shell is the milestone sequence; nothing derives lateness from a clock |
| Risk / blocker register | Planning §4.7 | **EXISTS** (G-256) | `projects.plan_notes`, kind `risk` or `assumption` | Owner nullable — §4.7 says *where known* |
| Clarification loop through PM | Planning §10 | **EXISTS** (G-257) | `projects.plan_clarifications`, five doors | Two honest endings; a plan cannot activate with one open |
| Validation before `ProjectPlanReady` | Planning §18 | **PARTIAL** (G-256, G-257) | Activation refuses a plan with no deliverables or an open clarification | No full §18 coverage/role-boundary validator |
| **No development planning** | Planning §5, §6 | **N/A yet** | — | The boundary must be enforced in the prompt AND asserted in a test |

### F. Kickoff, completion, Phase 3

| Requirement | Source | Status | Where it lives | Gap |
| --- | --- | --- | --- | --- |
| Project start gated on real conditions | Master §5.10 | **EXISTS, and already stricter than Phase 2 asks** | `projects.start_project` (G-026, ADM-13): advance **verified**, a requirement approved, the WhatsApp group linked — each an `exists` against the owning table, refusal names which is missing, override needs a recorded reason | Phase 2 adds: plan ready |
| Readiness evaluator | Master §5.10, PM §6 PM-10 | **EXISTS** (G-258) | `projects.pre_kickoff_readiness` — onboarding, group, payment, plan | Returns the gaps, not a bare no |
| Official kickoff message + evidence | Master §5.11, PM §6 PM-11 | **PARTIAL** (G-258) | `record_kickoff` requires an evidence reference and closes the phase | It RECORDS; it does not SEND — **BLK-003 / BLK-007** |
| `Phase2Completed` / `Phase3Ready` | Master §5.11 | **EXISTS** (G-258) | Both emitted by `projects.record_kickoff` | `Phase3Ready` has no subscriber — the next phase does not exist |

### G. Cross-cutting — already built, reuse rather than rebuild

| Requirement | Status | Where |
| --- | --- | --- |
| Events, outbox, dispatcher, subscriptions | **EXISTS** | `core.event_types`, `core.outbox_events`, `src/lib/events/` — one dispatcher, asserted by test |
| Jobs, retry, backoff, dead-letter, requeue | **EXISTS** | `core.jobs`, `core.claim_agent_job`, `core.requeue_job` (G-099) |
| Idempotency | **EXISTS** | job dedupe keys, `evt:<id>:<handler>`, unique constraints |
| Approval / policy engine | **EXISTS** | `approvals.*`, policy ladder by amount and subject |
| Audit | **EXISTS** | `audit.audit_log`, `core.record_audit`, append-only, by trigger and in-transaction |
| RLS, tenancy guards, role capabilities | **EXISTS** | every table has RLS; `enforce_parent_org`, `freeze_organization_id`; `core.can_write()` |
| Agent runs, budgets, autonomy gate | **EXISTS** | `ai.agent_runs`, `mayAgentRun`, `ai.agent_runs_autonomy_guard` |
| Admin surfaces | **EXISTS** | 18 internal pages including `projects`, `invoices`, `handoffs`, `operations` |
| Observability | **EXISTS** | Operations page: dead jobs, wedged follow-ups, backlog |

---

## 3. What this means for sequencing

The Phase 2 spec assumes less exists than does. The three biggest *genuine* absences are:

1. **Nothing consumes the handoff.** Everything else in Phase 2 hangs off a Phase 2 that
   never starts. This is the first unit.
2. **Billing mode (GST / Non-GST) does not exist at all** — no profile, no GSTIN, no snapshot.
   Every invoice this system has issued has been Non-GST by silence rather than by decision.
3. **The operational plan has no domain.** `projects.deliverables` is a QA artifact and
   `projects.milestones` is a payment artifact; neither is the blueprint.

And one absence that is not Phase 2's to fix: **there is no email channel in this
deployment.** Finance §4.5 requires invoice delivery to the client's email. WhatsApp is the
only outbound channel that exists. Recorded as a blocker rather than faked.

---

## 4. Conflicts with locked Phase 1 decisions

The Master Flow §3 says the latest locked Phase 2 decision is the baseline and older
specifications are supporting architecture *unless they conflict*. Two do.

### C-1 — The milestone percentages disagree, and it is about money

**Phase 2 Finance §2** locks **M1 30% · M2 20% · M3 30% · M4 20%**, "compulsory for the
standard project payment structure", triggered by Phase 2 and by the completion of Phases 4,
5 and 6.

**What this repository does today** (`src/modules/sales/quotation-standards.ts`, Part G of the
quotation corpus): a quotation's schedule is **40/30/30 below ₹1,00,000** and
**30/30/25/15 from ₹1,00,000**, triggered by *demo events rather than dates* — or an
owner-configured structure, **frozen onto the quotation at drafting** so that changing the
terms in March cannot change a quotation a client accepted in January.

They disagree on the percentages, on the number of milestones, and on what triggers them.

**Why this cannot be resolved by preferring the newer document alone:** the Phase 2 Finance
spec *also* says Finance "must not change quotation amount or milestone percentages without
authorized commercial revision" (§11) and must "read accepted project amount from the
approved quotation" (§4.4). For a quotation already accepted at 40/30/30, invoicing 30% as M1
would contradict the accepted quotation — so the spec conflicts with itself at the boundary,
and the conflict lands on real money already agreed with real clients.

**ANSWERED — ADM-105 granted 2026-09-16**, in the owner's own words: *30% / 20% / 30% /
20%*. The locked Phase 2 structure governs a **project**, installed as four milestones at
Phase 2 start (G-251, `src/modules/projects/payment-structure.ts`).

What the answer settled, and what it did not:

- A project's payment plan is 30/20/30/20, all four installed together — §2 calls them
  mandatory and §21 forbids making the post-Phase-4/5/6 triggers optional.
- The quotation corpus families are **not** deleted. A quotation still shows what its own
  frozen terms say, because rewriting what a client already accepted is what §11 forbids.
- So the boundary the spec contradicts itself at **still exists**: a client who accepted
  40/30/30 will be billed 30% first. `structureDiffersFromQuotation` returns that comparison
  as a value a surface renders, so a person sees it before the invoice goes out rather than
  after the client asks.
- An existing hand-configured plan is never overwritten, and a project with no budget gets no
  plan of four zeroes.
- Still true: **no invoice is issued from Phase 2 code by this unit.** G-251 installs the
  plan; M1 is its own unit and runs through Admin verification.

### C-2 — "Onboarding Agent" and "Communication Agent"

Phase 2 says not to create them. ADM-82's roster never had them. **No conflict** — recorded
so a later reader does not add one.

---

## 5. Blockers this phase inherits or raises

| id | What | Owner |
| --- | --- | --- |
| **BLK-003** | Meta production number. Phase 2 needs invoice delivery to the project group; the deployment is still on Meta's test number | owner |
| **BLK-007** (new) | **No email channel exists.** Finance §4.5 requires invoice delivery by email. Nothing in this deployment sends email | owner — choose a provider |
| ~~**ADM-105**~~ | C-1 above: which milestone percentages govern | **granted 2026-09-16 — 30/20/30/20** (G-251) |
| **ADM-106** (new) | Secure storage for client credentials (PM §4.3) — the same unanswered question as the evidence store (G-229) | owner |
| **ADM-107** (new) | Which fields must be re-confirmed even when Phase 1 recorded them, and whether any answer should expire by time rather than by supersession (G-252) | owner — blocks nothing |
| **ADM-108** (new) | Which checklist items are REQUIRED before kickoff — and whether **ADM-06**'s *"the checklist blocks nothing"* still stands now §5.10 gates on it (G-261) | owner — blocks nothing |

---

## 6. Unit order

Each is a gap in `docs/roadmap/roadmap.json`, with tests and a §10 row, like every Phase 1
unit.

1. **Phase 2 starts from the handoff** — consume `opportunity.handed_off`, create the
   workspace idempotently, assign the PM, record inherited context. *(no credential needed)*
2. ~~**Known, missing, conflicting**~~ — **done (G-252)**. Eleven client-facing fields, the
   packet's own verdicts read verbatim, staleness by supersession only, reconfirmation
   raised as ADM-107.
3. ~~**The group is a manual action**~~ — **done (G-253, G-254)**: the Admin task, the
   roster, the overrides, the snapshot, the four states, and the surface to do it on.
4. ~~**Billing mode is confirmed, not assumed**~~ — **done (G-255)**: the mode, the
   versioned profile, the GSTIN checksum, and §16's blocking readiness.
5. **M1** — the plan is installed (**G-251**) and the invoice now carries the right tax
   and is blocked without a confirmed billing mode (**G-259**). What remains is **delivery**:
   BLK-007 (email) or BLK-003 (the group). *(owner)*
6. ~~**The operational blueprint**~~ — **done (G-256)**: the plan domain, the deliverables
   and dependency registers, risks and assumptions, versioning and the freeze.
7. ~~**The clarification loop**~~ — **done (G-257)**: two honest endings, and a plan that
   cannot go live carrying an open question.
8. ~~**Readiness and kickoff**~~ — **done (G-258)**: the pre-kickoff gate, the kickoff
   record, `Phase2Completed` / `Phase3Ready`. It records the kickoff; it does not send it.

Units 1, 2, 3, 4, 6 and 7 are done — **G-250, G-252, G-253, G-255, G-256, G-257**. The
payment structure unit 1 installs is **G-251**; unit 3's Admin surface is **G-254**, done.

**Seven of the eight units are built** — G-250, G-252, G-253, G-255, G-256, G-257, G-258,
plus G-251 (the payment structure) and G-254 (the Admin surface).

**All eight units are now built.** Unit 5's remaining piece is **delivery**, and it is not
a build: Finance §4.5 wants email (**BLK-007**, no provider chosen) and Master §5.8 wants
the project WhatsApp group (**BLK-003**, still on Meta's test number). Both are the owner's
to answer.

Until one is, the invoice and the kickoff have the same honest shape: a person does the
sending, and AgencyOS records that they did — with the evidence required rather than
assumed.

---

## 7. Corrections to this document

A matrix is read to decide what to build next, so an entry that was wrong is corrected
here rather than quietly overwritten.

**The status column went stale across sixteen rows — corrected 2026-09-17.**
Rows written during the initial sweep still read `MISSING` for things built since:
the Phase 2 consumer, its idempotency and its refusal (G-250), the PM state model
(G-250), the plan-owned deliverables register and the risk register (G-256), the
clarification loop (G-257), the readiness evaluator and both handoff events (G-258),
and the versioned billing snapshot (G-260).

That matters more than a tidy document: **this matrix is what decides what gets built
next**, and a row saying `MISSING` for something that exists is an invitation to build
it twice. Corrected in place, with three rows moved *down* rather than up because the
honest status was worse than the first sweep recorded:

- **Operational milestone map** — was `PARTIAL`, is `MISSING`. G-256 built deliverables
  and dependencies; it did **not** build an operational milestone object, and calling
  that partial credit would hide a real gap.
- **Timeline shell** — `PARTIAL`, not done: dependency windows carry a required basis,
  but there is no project-level timeline object.
- **Validation before `ProjectPlanReady`** — `PARTIAL`: activation refuses an empty plan
  and an open question, which is not §18's full coverage and role-boundary validator.

**"Nothing in the repository mentions GST" (§D, billing mode) — wrong, 2026-09-17.**
Written during the initial sweep, and contradicted by two things that were already
there. `src/modules/sales/quotation-standards.ts` Part G prints *"All amounts are
exclusive of GST; 18% GST extra"* on **every** quotation, and
`finance.invoice_items.tax_rate_bp` has existed since the first finance migration.

The absence was real but differently shaped, and worse than the row described: the
quotation **commits the agency to adding GST in writing**, the invoice default adds
none, and nothing recorded which should win. That is not a gap in a feature — it is a
disagreement the system has been shipping. Closed as **G-255**, classified `D`
(incorrect) rather than `C` (missing), for that reason.
