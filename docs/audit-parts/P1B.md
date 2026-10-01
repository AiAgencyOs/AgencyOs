# P1B audit: Business Phase 1, steps 1.22 to 1.42 + 1.EXIT + 1.GATE (MODE A, audit only)

Repo: /home/user/AgencyOs, main at 23d8665. Audited 2026-10-01. Rows: 23 (`P1B.json`). No product code, migration or commit was touched; only `docs/audit-parts/` was written.

How evidence was gathered: read the live function bodies in the local Postgres (psql, `agencyos_local`), traced the workflows in `app/api/jobs/run/workflows.ts`, ran 32 unit test files and 22 live verifiers (every one through `flock /tmp/verify.lock`), and probed `clientReplySchema` and `crm.states_a_price` with adversarial sentences. Real AI providers and WhatsApp are not configured locally, so every model-dependent step is traced in code only and is NOT_VERIFIED.

Test classification used below: [behavioral] calls real code with inputs and asserts outputs; [static-regex] reads source/migration text and matches regexes (proves the text exists, not behavior); [live-db] runs against Postgres. Almost every `tests/*.test.ts` file cited here is static-regex, with a few behavioral sections (named in each row).

## A. Step table

| step | name | implementation | verification | test | production | blocker / key note |
|---|---|---|---|---|---|---|
| 1.22 | Objection diagnosis | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | 4 of 11 categories (price, trust, timeline, feature); no "not an objection" option; price_inquiry forced into a price objection, burns a round |
| 1.23 | Price objection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | rework + standing offer exist (new since 09-28); spelled-out amounts pass the reply guard; budget-first only prose |
| 1.24 | Value negotiation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | prompt-only posture, no stored value points, no eval |
| 1.25 | Scope-based negotiation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | plan-set (2-3 options) is human-drafted; agent rework yields one smaller quote; no structured change-set |
| 1.26 | Approved extra value | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | only ONE percentage discount offer per org; no extras catalog; apply path not live-verified here |
| 1.27 | Discount | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | limits bind the standing-offer path only; manual set_proposal_pricing has no cap/reason |
| 1.28 | Payment structure negotiation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | catalogue exists (prior audit said MISSING: stale); no per-client alternatives; agent may not offer one |
| 1.29 | Feature objection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | no confirmed-gap vs new-scope split; requirement version not touched |
| 1.30 | Timeline objection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | no feasibility/capacity data; delivery-date promises not blocked in replies |
| 1.31 | Trust objection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | only portfolio links are structural evidence; fake testimonials/guarantees not blocked |
| 1.32 | Negotiation loop | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | round cap IS enforced in rework (prior audit stale) but unset by default and rework-only |
| 1.33 | Quote revision | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | DB-enforced immutability and V2 supersede verified live; no "what changed" diff |
| 1.34 | Lead ghosts | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | default nudge is the placeholder "Following up on our last message."; one ghost sequence per lead ever |
| 1.35 | Follow-up engine | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | consent/opt-out/window/stop/escalation verified; only 4 client-facing situations, none for offer-expiry/decision-check |
| 1.36 | Nurture | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | reason+date enforced by trigger; NOTHING reads the date (code comment claims the engine does) |
| 1.37 | Lost | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | 10+other categories and reason enforced; CHECK is NOT VALID; parallel lead.disqualified_reason |
| 1.38 | Lost-lead win-back | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | pool excludes lost/disqualified; stale-open-lead reactivation only (consent-gated, off by default) |
| 1.39 | Closing signal | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | `acceptance` intent is a label with no consumer |
| 1.40 | Structured acceptance | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | exact-version rules DB-enforced; staff-recorded, no evidence required or stored |
| 1.41 | Won | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY | won gate + handoff verified live (22 + 56 checks); payment evidence gate default OFF |
| 1.42 | Sales handoff package | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | reference-heavy packet, many spec fields absent; receiver now exists (prior audit stale) |
| 1.EXIT | Exit routes A-D | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | A real; B generic; C date-only; D no win-back of lost |
| 1.GATE | Phase 1 gate (this slice) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | see section C |

Counts: PARTIAL 20, COMPLETE 3 (1.33, 1.37, 1.41). No row is PRODUCTION_READY.

## B. Sales Agent quality checklist

How the agent actually runs: `sales` (L1, enabled) runs single-shot, schema-constrained workflows (`message.intent`, `lead.qualify`, `conversation.summarise`, `objection.read`, `reply.compose`, `followup.compose`, `quotation.scope/revise/rework`). The tool loop (`callModelWithTools`) is used only by `lead.qualify` and is limited to the four read tools (`DISPATCHABLE` in `src/modules/agents/tool-dispatch.ts`); the registry's write tools (`crm.sendClientMessage`, `finance.generateInvoice`, `memory.remember`...) are refused as `not_dispatched`. There is no pricing tool for any agent (`src/modules/agents/tools.ts:108-120`). So the MUST-NOTs are enforced mostly by (a) absence of capability, (b) output schemas, (c) DB triggers on the message row, and only the remainder by prompt prose. Switches that gate the whole client-facing behavior default OFF: `core.organizations.agent_answers_clients=false`, `agent_writes_follow_ups=false`, `reactivation_pilot_enabled=false` (psql).

### B1. Capabilities

| capability | status | evidence |
|---|---|---|
| Remembers context, uses name naturally | PARTIAL | `reply.compose` is fed the thread tail, `crm.conversation_summaries`, `ai.recall` lead + client memory, and a "sales file" (requirement v, objections, quote state, follow-ups, portfolio) (workflows.ts:5028-5200, 4530-4690). The contact name is NOT passed to the reply composer (only `preferred_language`, workflows.ts:5036-5044); `greeting()` uses the first name only in the fixed missed-meeting bodies (follow-up-worker.ts:122). Natural name use depends on the model seeing it in the transcript. |
| Asks intelligent, non-redundant questions | PARTIAL | Qualification coverage (15 areas, each with the client's quote) is fed back as "still unknown" and the prompt says never re-ask the thread (REPLY_PROMPT WHAT TO ASK; `qualificationCoverageSchema`, crm/schema.ts:958-1010). Quality is prompt-driven; no model run here. |
| Adapts to lead type | PARTIAL | Language/Hinglish matching and "returning client" memory (G-199) exist; no lead-type classification drives behavior. |
| Builds trust | PARTIAL | Structural only for portfolio: model emits refs, URLs are attached from active `crm.portfolio_items` (workflows.ts:4690-4730). Everything else is prose. |
| Explains value | PARTIAL (prose) | REPLY_PROMPT WHY NOT ONLY WHAT; no stored value points; cannot quote savings (money is human-only). |
| Discovers requirements and budget | PARTIAL | Qualification areas include budget/timeline/decision_maker/trust_concerns/payment_expectations (as quotes, no amount parsed, no score by design). `budgetSignalFor()` shows the drafter the client's own money words. Requirement versioning is another slice. |
| Detects decision readiness | PARTIAL | Prose ("WHEN THEY ARE READY, STOP DISCOVERING") plus an `acceptance`/`quotation_request` intent label that nothing consumes (row 1.39). |
| Handles objections | PARTIAL | Reads/records 4 kinds, a person answers (DB trigger forbids agent answers). Reply agent acknowledges and defers. |
| Negotiates | PARTIAL, by design | The agent cannot state or move a number; price/feature objections trigger a rework draft that the owner approves. Real negotiation = the owner. |
| Uses approved offers/discounts/payment structures | PARTIAL | One owner offer applied only on price objection (floors/caps/ceiling checked in SQL). Payment structures are an owner catalogue picked by amount band; the agent is told it may NOT offer one. |
| Reshapes scope | PARTIAL | REWORK_PROMPT: smaller honest build, `phase.deferredTo`, "return scope unchanged rather than shave the number". 2-3 plan sets are human-drafted. |
| Follows up intelligently | PARTIAL | Engine is strong (row 1.35); contextual draft only when `agent_writes_follow_ups` is on and a language is recorded; default body is "Following up on our last message." |
| Recovers ghosted leads | PARTIAL | `abandoned_conversation` sequence (7 business days, then weekly to day 49); one per lead ever. |
| Nurtures | PARTIAL | Manual state + reminder date; no automated outreach (row 1.36). |
| Ethical win-back | PARTIAL / MISSING for lost deals | Consent-gated reactivation of stale OPEN leads verified live; lost/disqualified leads are excluded (row 1.38). |
| Knows when to stop | MET structurally (with unset defaults) | STOP/opt-out trigger (`crm.record_inbound_opt_out`), `handToHuman` pauses the thread, paused thread blocks all nudges (follow-up-worker.ts:731), max attempts per rhythm then escalation, SLA outranks reminders, round cap hands over (when configured). Limits: attempts are code constants (RHYTHM_OFFSETS), not org settings; `negotiation_max_rounds` is unset by default. |
| Escalates | MET | `handToHuman` reason on every reply path, `crm.hand_conversation_to_a_person`, `conversation.escalated` announcement; tests pass (static). |

### B2. MUST-NOT enforcement (probe = `clientReplySchema.safeParse` run through node; DB = psql `crm.states_a_price`)

| MUST NOT | enforcement | status | evidence |
|---|---|---|---|
| Lie | prose + partial structure | PROSE-ONLY (mostly) | Honesty rules in REPLY_PROMPT (AI disclosure, "do not claim work exists"). Structural only for portfolio refs and money numerals. |
| Fake scarcity | none | NOT ENFORCED | No prompt rule and no guard. Probe: "Only today: limited slots left, book now or lose this offer!" PASSED the schema. Offer expiry itself is real (`approved_offers.valid_until`, proposal `valid_until`). |
| Fake friendship | prose | PROSE-ONLY | Prompt asks for plain honesty; probe "Hum aapke dost jaise hain, bilkul bharosa karo, 100% guaranteed result" PASSED. |
| Pressure vulnerable leads | none | NOT ENFORCED / not addressed | No rule or signal for vulnerability anywhere in prompts or schema; only "DO NOT ARGUE". |
| Invent testimonials / portfolio | portfolio structural; testimonials prose | PARTIAL | Portfolio: refs resolved against active rows, hallucinated ref dropped and logged. Testimonials/named clients: probe "Our clients like Zomato and Swiggy have trusted us with similar apps." PASSED. |
| Invent discounts | structural for numeric forms | PARTIAL (strong core) | No discount/pricing tool; `clientReplySchema` refuses currency, "N lakh/k/rupees" and "N% off/discount" ("I can give you 20% discount" REFUSED); `crm.refuse_unread_price` row trigger on automated outbound messages (live-verified `db:verify:unreadprice`). GAPS: "Total cost fifty thousand only", "dedh lakh mein ho jayega", "50,000 only" pass both layers (probe + psql). |
| Promise impossible delivery | prose | PROSE-ONLY | Probes "We can deliver this in 2 weeks, guaranteed." and "We will deliver by 15 November." PASSED; the schema docblock claims "nothing here to promise with" but nothing blocks dates/durations. |
| Offer unauthorized free work | prose + owner approval | PARTIAL | Replies: probe "I will add the admin panel for free, no extra cost." PASSED. Quotes: every quote and rework goes to owner approval (`sales.submit_proposal`), rework prompt forbids discounting same scope. |
| Ignore opt-out | structural | MET (verified live) | `crm.reads_as_opt_out` (English, Hinglish, Devanagari) + trigger `record_inbound_opt_out` flips consent to withdrawn; send chokepoint refuses without consent; reactivation requires granted consent. `db:verify:optout`, `db:verify:consent`, `db:verify:reactivation` pass. Not tested: a STOP in a language outside the list. |
| Spam | structural for follow-ups | PARTIAL | Rhythm caps, 10:00-19:00 window, business days, reply stops sequence, one sequence per subject (verified: `db:verify:followup`). No cross-situation frequency cap; replies are one-per-inbound with a duplicate guard. |
| Silently change commercial terms | structural | MET | `sales.proposals_guard` freezes price/discount/document after draft (live: "a submitted version is frozen, terms and lines both"); revisions are new versions needing owner approval; offer applied once per deal and recorded (`applied_offer_id`, audit `offer.applied`, owner notified). Residual: human can type any discount (row 1.27). |

### B3. Conversation memory (structured facts with source evidence)

- Store: `ai.memory_records` (scope lead/client, kind, fact <=300 chars, confidence, source_kind/source_id, authored_by_agent). DB CHECKs: an agent can never write `verified`; `explicit` or `verified` must carry source_kind+source_id (psql constraints `memory_agent_cannot_verify`, `memory_claimed_provenance_is_recorded`); `db:verify:memory` passed. The intent job writes one `explicit` fact per client message pointing at the message id (workflows.ts:2620-2650). 147 memory rows locally, 30 agent-authored.
- Limits: one fact per message; `kind` is a free `^[a-z][a-z0-9_]{2,40}$` string, not a controlled vocabulary of the spec list; recall is capped at 8.
- The spec's fact list is spread over tables rather than held as one memory object: name (`crm.contacts`), project/needs/budget/timeline/decision-maker/payment-preference/trust concerns (`crm.leads.qualification`: 15 areas, each with the client's quote), requirements (`crm.requirement_versions`), objections (`sales.objections`), quote versions/offers/discount (`sales.proposals`), follow-up date (`crm.leads.next_follow_up_at`). Absent as named fields: pain points, goals, **next best action**.
- Doc-vs-code: none material. Source evidence is real for memory rows and qualification quotes; agent output for `reply` carries no evidence pointers.

### B4. Reasoning-output hygiene

- Every sales workflow demands a strict zod/JSON schema (`.strict()`, decoder-safe JSON schema); none has a free "reasoning/analysis" field. The only free text that reaches a client is `reply`/`body`; `handToHuman` is internal.
- Provider adapters keep only `text` and `tool_use` blocks (`src/lib/ai/claude.ts:151-216`), so Anthropic thinking blocks are dropped.
- Stored: `ai.agent_runs` output = the validated structured object; `ai.agent_steps.response` keeps the raw pre-validation JSON and the system prompt (no transcript copy) behind RLS to internal members only (psql policy `agent_steps_select`). So internal reasoning is not exposed to clients, and no chain-of-thought is requested or stored.
- Spec structured outcomes vs reality: lead_stage (`leads.status`, human-moved), intent (`message.intent`), qualification (coverage), requirements, objection_type (`sales.objections.kind`), trust_signal (only as objection kind `trust`), follow_up_at (system-scheduled, not agent-set), quote_version (`objections.proposal_id`), approved_offer (`proposals.applied_offer_id`). **Missing: next_best_action and an explicit approval_needed flag** (only a `handToHuman` reason string).

### B5. Follow-up intelligence

| property | status | evidence |
|---|---|---|
| State-aware | MET | Worker re-reads the subject each tick and stops on reply, quotation accepted/rejected/lapsed/superseded, deal won/lost, lead converted/disqualified (follow-up-worker.ts:203-260, 630-700). Nurture status does NOT stop a lead-level sequence. |
| Opt-out | MET | consent `withdrawn` -> stop; STOP heard from inbound (verified live). |
| Frequency | MET per sequence | Fixed rhythms (sales_active 2,5,8..20; sales_nurture 7..49); one sequence per subject; no cross-situation cap. |
| Business hours | MET | 10:00-19:00 window (owner-configurable), business days only; org timezone required or send is blocked (no invented default). |
| Stops after configured attempts | PARTIAL | Max 7/7/2/3/2 then escalate to a person and pause the thread; attempts are code constants, not owner settings. |
| Context-sensitive content | PARTIAL | Agent draft uses the last 8 messages + memory but only when `agent_writes_follow_ups` is on; default body is generic English placeholder. |
| Spec situation variety | PARTIAL | No offer-expiry, decision-check, trust-evidence, budget-alternative or timeline-availability situations. |

### B6. Handoff quality fields (spec list vs `ai.handoffs` / `record_won_handoff`)

| required | present? |
|---|---|
| task ID | no (`task_id` column exists, not set for the WON handoff) |
| organization | yes |
| client/project | yes (contact, lead, client account, project once bound) |
| source phase | implicit (`from_agent=sales`), no phase field |
| destination agent | yes (`to_agent=project_manager`) |
| exact context | partial: ids + language + consent + conversation id/summary seq (no content) |
| version refs | yes: requirement_version_id, proposal id + version |
| required action | yes but generic: `requested_action='onboard'` |
| permissions | no |
| policy status | partial: payment-gate verdict only |
| known blockers | yes: `unresolved[]` closed vocabulary (10 names) |
| completion evidence | partial: status `queued` -> `accepted` when `projects.start_phase_two` consumes it |
| correlation ID | yes |

## C. FINDINGS

### Critical blockers
1. Reply guard has real holes on the one path where a message reaches a client unread. Spelled-out/Hinglish amounts, delivery date/duration promises, "free" work, fake scarcity, guarantees and invented client names all PASS `clientReplySchema` and `crm.states_a_price` (probe output; psql). The schema docblock (crm/schema.ts:1085-1099) says "no date, no commitment" but only money numerals and "N% off" are checked. Mitigant: `agent_answers_clients` defaults false.
2. No provider-enabled E2E exists for negotiation. `db:verify:quotescope` and `db:verify:quotedispatch` fail locally (runner has no model stub), so rework, standing-offer apply, and revision loops are NOT live-verified in this run.

### Major missing flows
- Objection taxonomy: 7 of 11 spec categories absent (row 1.22).
- Win-back of lost deals by reason (row 1.38): reactivation pool is `status in (new,qualifying,qualified)` only (`crm.reactivation_priority`, `observe_follow_up_candidates`).
- Automated nurture outreach: nothing reads `next_follow_up_at` except the Today reminder (psql scan of all crm/sales/core functions; grep).
- Closing-signal consumer (row 1.39); next_best_action field.
- Per-client alternative payment structures (lower advance, prototype-first, deferral) (row 1.28).
- Extras catalog beyond one discount offer (row 1.26).
- Follow-up situations: offer expiry, decision check, trust evidence, budget alternative, timeline availability.

### Broken flows
- None found as outright broken in code read. Candidate logic defect (code-traced, not reproduced): `price_inquiry` is a trigger intent for `objection.raised` and the reader has no "none" option, so a plain price question after a quote becomes a price objection, increments `round`, and (with a sent quote) enters `quotation.rework` and possibly the standing offer (workflows.ts:4004-4160, 8012-8050; `crm.emit_objection_raised`).

### Mock-only flows
- None found in the production path. Model-dependent steps depend on a real provider that is absent locally.

### Untested flows
- Round-cap hand-over, standing-offer apply under a real quote, rework with a model, follow-up draft with a model, reply compose end-to-end, WhatsApp delivery: no behavioral or live run here.
- All cited `tests/*.test.ts` except follow-up-contract, follow-up-rhythms, state-transitions, one-deal-per-lead (and parts of quotations, the-sales-agent-under-pressure, the-payment-terms-the-owner-chooses, the-thread-remembers-its-beginning, the-handoff-has-a-face) are static-regex.

### Security risks
- Reply-path content guard gaps (Critical 1).
- `negotiation_max_discount_pct` etc. do not bind a human-typed discount (row 1.27); owner approval is the only control.
- Acceptance has no evidence requirement (row 1.40).

### Data risks
- `opportunities_lost_says_why` is declared NOT VALID (legacy rows unguaranteed). Parallel loss records (`opportunities.lost_category` vs `leads.disqualified_reason`).
- Round counter inflated by misclassified price questions.
- `ai.handoffs` packet carries ids not content; payment plan terms only inside `proposals.document`.
- One `abandoned_conversation` sequence per lead ever.

### Agent gaps
- No next_best_action / approval_needed outputs; no vulnerability or scarcity policy; contact name not given to reply composer; memory `kind` is free-form; one fact per message.

### Admin gaps
- Where an owner records objection response/outcome/next action was not audited in this slice (RLS allows internal update; UI not inspected). Offer/limits settings exist at `/settings/commercial`; there is no Admin view of a negotiation round with discount/offer/payment term in one row.

### WhatsApp gaps
- Real WhatsApp delivery, 24h window handling and STOP in live traffic not tested here (window verifiers see appendix). STOP matcher is a regex list (English, Hinglish, Devanagari only).

### Finance gaps
- `won_requires_payment_evidence` default OFF: a deal can be won with no payment evidence or exception unless the owner switches it on. This matches "WON != payment verified" but should be a conscious default.

### UI / prototype gaps
- None in this slice.

### NEEDS_BUSINESS_CLARIFICATION
1. Which objection categories and which alternative payment structures are "approved" (rows 1.22, 1.28).
2. Should human-typed discounts be capped/require a reason (row 1.27)?
3. Win-back policy per lost reason: wait time, approver, wording (row 1.38).
4. Required acceptance evidence (row 1.40).
5. Feasibility/expedite definition for timeline objections (row 1.30).
6. Catalog of non-monetary extras (row 1.26).

### Doc-vs-code conflicts
- `src/modules/crm/service.ts:1146-1149` says `next_follow_up_at` "is what the follow-up engine already reads": it is not read by any engine function (psql scan).
- `src/modules/sales/handoff-view.ts:75` banner says the handoff "waits at queued with no receiver: the PM agent is disabled (BLK-002)"; but `project.handoff_bound -> projects:startPhaseTwo` consumes it and flips status to accepted (`projects.start_phase_two`).
- `crm/schema.ts` docblock for `clientReplySchema` says nothing in the reply can commit a date; the schema does not check dates.
- `REPLY_PROMPT` and `salesFileFor` say the agent may not offer a payment structure; correct, and consistent with the code.

### Stale / incorrect claims in the 2026-09-28 audit (re-checked on current main)
| claim | now |
|---|---|
| 1.27: no discount amount/reason/approver/expiry/final audit row anywhere; `negotiation_max_discount_pct` not wired | STALE. `sales.apply_approved_offer` writes `discount_minor`, `total_minor`, `applied_offer_id`, audit `offer.applied`, approver recorded on the approval; the cap is enforced in `sales.set_approved_offer`; min price/autonomous ceiling enforced in apply. Residual: manual discounts. |
| 1.28: no catalog of approved payment structures (MISSING) | STALE. `sales.payment_structures/payment_milestones` (sum=100 enforced, band default, frozen onto quote). Alternatives per negotiation still absent. |
| 1.32: `negotiation_max_rounds` only stored | STALE. Enforced in `quotation.rework` (workflows.ts:8047) with hand-over. Unset by default; rework only. |
| 1.23: price objection is not engaged by the agent | STALE. Price objections now enter rework (G-183) and the standing offer (G-184). |
| 1.38: COMPLETE | OVERSTATED. Only stale-open-lead reactivation; no lost-deal win-back. |
| 1.36: COMPLETE | OVERSTATED. Reason+date captured; no scheduled outreach. |
| 1.34/1.35: COMPLETE | OVERSTATED vs spec: strong machinery, generic default content, 4 situations, one ghost sequence/lead. |
| 1.42: COMPLETE, "not yet consumed downstream" | Mixed. Receiver exists now (stale half); packet field coverage overstated. |
| 1.22: only 4 of 11 categories | CONFIRMED. |
| 1.33, 1.41: COMPLETE/VERIFIED | CONFIRMED (live verifiers). |
| 1.39: MISSING | CONFIRMED that no consumer exists; rated PARTIAL because label + prompt behavior exist. |

## D. Appendix: commands run and results

Unit tests (node, `--conditions=react-server --import ./tests/_alias.mjs ...`), all pass, 0 skipped: the-sales-agent-under-pressure 58, a-price-objection-turns-the-loop 11, the-limits-the-owner-can-set 19, an-offer-the-owner-made-in-advance 37, the-payment-terms-the-owner-chooses 21, the-limit-is-a-stop 31, an-inbound-stop-is-heard 54, unread-price 10, the-offer-is-a-choice 21, the-quotation-offers-a-choice 43, a-deal-that-is-won-says-what-was-won 20, a-deal-that-is-handed-off 23, a-cohort-is-reactivated-with-consent 15, a-reactivation-tick-has-a-ceiling 15, where-the-leads-are-lost 28, follow-up-contract 31, follow-up-rhythms 26, a-paused-thread-gets-no-nudge 3, a-message-outside-the-window 15, the-thread-remembers-its-beginning 19, memory-records 14, agent-handoffs 15, the-handoff-has-a-face 12, the-agent-explains-the-quotation 20, the-agent-answers-without-waiting-for-a-clock 22, the-escalation-reuses-the-announcement 9, the-client-asks-and-the-agent-redrafts 16, a-quotation-keeps-the-clause-it-printed 27, the-owner-decision-teaches-the-next-quotation 29, quotations 61, one-deal-per-lead 25, state-transitions 17.

Live verifiers (`flock /tmp/verify.lock npm run -s db:verify:<name>`):

- db:verify:quotations: exit 1 (FAIL) ✖ 4 failure(s)
- db:verify:planset: exit 0 (PASS) ✔ Two or three plans, approved once, and the client picks one
- db:verify:quotescope: exit 1 (FAIL) Node.js v26.10.0
- db:verify:wongate: exit 0 (PASS) ✔ 22 checks passed — a deal is won on an accepted quotation, and the row is what says so
- db:verify:handoff: exit 0 (PASS) ✔ 56 checks passed — a won deal hands off as an event that says what was won
- db:verify:optout: exit 0 (PASS) ✔ An inbound STOP is heard — and withdrawal is final
- db:verify:followup: exit 0 (PASS) ✔ A sequence cannot send twice, and cannot cross a tenant
- db:verify:reactivation: exit 0 (PASS) ✔ The reactivation pilot is off by default, consent-gated, and cannot be bypassed
- db:verify:unreadprice: exit 0 (PASS) All checks passed.
- db:verify:dealterms: exit 0 (PASS) ✔ An open deal can be corrected, and a reopened one forgets how it closed
- db:verify:memory: exit 0 (PASS) All checks passed.
- db:verify:consent: exit 0 (PASS) ✔ No consent, no send — and the internal group still gets through
- db:verify:quotedispatch: exit 1 (FAIL) Node.js v26.10.0
- db:verify:funnel: exit 0 (PASS) ✔ 43/43 checks passed
- db:verify:clauses: exit 0 (PASS) All checks passed.
- db:verify:priority: exit 0 (PASS) ✔ Reactivation is prioritised by recorded facts, consent-gated, tenant-safe
- db:verify:worker: exit 1 (FAIL) ✖ 2 failure(s)
- db:verify:window: exit 0 (PASS) ✔ The window is asked before every send
- db:verify:delivery: exit 0 (PASS) ✔ Delivery retries, tells the truth, and stops when told
- db:verify:noscore: exit 0 (PASS) All checks passed.
- db:verify:approvals: exit 0 (PASS) ✔ The approval engine holds
- db:verify:autonomy: exit 0 (PASS) ✔ An agent does what its row says it may

Failures explained: quotations (85/89 checks pass; 4 red in sections 1/4/5 about the approval policy: "an owner policy is accepted - status 409", "first submission raises a request - already_pending" = pre-existing policy rows in the long-lived local DB); quotescope and quotedispatch (the runner at :3000 has no model stub on :54399, so the agent never drafts: "proposal is null"/"v2Features.filter is not a function"); worker (97 checks, 2 red: "the worker keeps recording why" and "once a timezone is set, the stranded sequence is scheduled and moves": the timezone-missing recovery path, cause not isolated, may be dirty-DB state; flagged unresolved, not assumed environmental).

Probe (not a repo test): node + `clientReplySchema.safeParse` on 10 sentences. REFUSED: "I can give you 20% discount", "Price is 1,50,000 rupees". PASSED: delivery in 2 weeks guaranteed; "limited slots left, book now"; "add the admin panel for free"; "100% guaranteed"; "clients like Zomato and Swiggy"; "dedh lakh mein ho jayega"; "fifty thousand only"; "deliver by 15 November". psql `crm.states_a_price`: "1.5 lakh" t, "Rs 5000" t; "fifty thousand", "dedh lakh", "50,000 only", "deliver by 15 November", "free of cost admin panel" all f.
