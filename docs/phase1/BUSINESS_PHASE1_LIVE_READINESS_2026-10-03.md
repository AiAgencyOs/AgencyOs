# Business Phase 1 (Lead → Close) — live readiness run, 2026-10-03

**Verdict: AGENCYOS BUSINESS PHASE 1 — NOT READY FOR LIVE USE.** Blockers at the end.

"Business Phase 1" here is the sales lifecycle, not the "Foundation" roadmap phase.

## 1. How this was run

- Local Supabase stack (Docker), all 305 migrations on a clean database, Next.js via `npm run verify:dev`.
- **Real Claude** (a separate test key the owner placed in `.env.verify.local`; `ANTHROPIC_BASE_URL` stub line disabled during the live run, restored afterwards). Production credentials were never used.
- WhatsApp: leads were created by **signed inbound webhooks** (the real ingest path). Outbound was captured by a local Graph stub (`tmp/ph1/graph-sends.jsonl`), so nothing reached a real phone.
- Admin actions (approve requirement, open deal, approve/request changes, record response, move stage, settings) were done through the real Admin UI in the in-app browser. Test leads are named `PH1_TEST_001…014`.
- Time acceleration was used once: `follow_up_sequences.next_due_at` was set to "now" to exercise the worker. No business state (status, quote, approval) was written directly.
- **Evidence kept:** `tmp/ph1/q-*.pdf` (quotation PDFs), `tmp/ph1/graph-sends.jsonl` (every outbound message), `tmp/ph1/out/` (per-lead replies).
- **Disclosure:** the live-test database was wiped by `supabase db reset` before a dump succeeded (`pg_dump` was the wrong version and the command chain continued). The leads are no longer in the local DB; the scenarios can be re-run.

## 2. Deterministic proof (stub model, clean DB)

All of these pass with the changes below applied: journey, ingest, webhook, qualification, dealterms, second, approvals, quotations, quotedispatch (176/176), quotescope (60), wongate (22), handoff (56), offer, booking, reschedule, reminders, followup, worker, consent, optout, window, unreadprice, memory, proposal, outbound, delivery, autonomy, authority, funnel, chain, flow01, events, dispatch, reaper, claims, unannounced, tenancy, tenancyguards, security (6/6), untenanted, invokerrls. Also: `typecheck`, `eslint`, `npm test` 6236/6236, `check:record`, `scan:secrets`.

Caveat found while doing this: three verifiers (`quotedispatch`, `followup`, `worker`) assert "ships unset" initial state, so they fail on a database where someone has set the agency timezone. That is environment sensitivity, not a regression (they pass on a clean DB).

## 3. Defects found by live testing, and their fixes

| ID | Sev | Finding (found only by the real model / real flow) | Fix | Retest |
|---|---|---|---|---|
| D-001 | P1 isolation | `finance.receipts` and `ui_version_client_decisions.conversation_id` had no tenancy guard (verifier red). | migration `20261003100000…` | tenancy verifiers green |
| D-005 | **P1** | Every agent tool id is dotted (`crm.readLead`, `memory.recall`). The real Anthropic API rejects such names (`400 tools.0.custom.name`), so **every tool-using call failed**; the stub model never validated. Qualification coverage was never recorded. | `src/lib/ai/tool-names.ts`, used at the provider boundary only | `lead.qualify` 4/4 succeeded; test `a-tool-name-the-real-api-accepts` |
| D-006 | **P1** | The tool path enforced no output schema, so a real model answered in prose and the job failed "not valid JSON". | `jsonSchema` threaded into `generateWithTools` | same run: 7 qualification areas with exact client quotes |
| D-007 | **P1** | The Sales prompt said "thirty years behind you". The agent told clients "thirty years se", invented a name ("Rohan"), and promised payment terms ("advance pura nahi lete, kaam dikhne ke baad hi agla payment"). | persona reworded as manner not facts; explicit list of what the agent may never state about the agency | fresh trust lead and technical lead: no claims; HIPAA / 99.99% uptime deferred to a colleague |
| D-008 | P2 | A 1,250-character technical answer exceeded the 1,200 reply cap; the client got no reply. | prompt hard limit of 1,000 characters | technical lead answered within limit |
| D-009 | **P1** | "Send to client for confirmation" recorded the requirement summary (delivery `pending`, version stamped) but **never called WhatsApp**; the UI said it was sent. Retry was blocked. | shared `deliverQueuedText`; `already_sent` now re-delivers if not `sent` | summary reached the Graph stub, delivery `sent`; unit test updated |
| D-010 | P3 | Quotation PDF ligature bug: "fl ow", "profi le", extracted as "con rmation". | ligatures disabled at font embed | same quote regenerated, text intact |
| D-011 | P2 | With a meeting open, the scheduling job returned **without reading** the message, so "4 nahi 6 baje" and "cancel kar do" were silently dropped and nobody was told. | message is read; reschedule/cancel writes a lead-timeline note naming the meeting and what still stands (no automatic change, per §3.1) | both messages produced notes |
| D-012 | P2 | On price pushback the agent handed over at once and promised "ek updated quotation taiyaar ho raha hai". | prompt: probe what is behind it, offer phasing (scope, not price), never promise a revision | aggressive-negotiator lead: asked what the rival quote includes; no discount, no advance waiver, no free feature |
| D-013 | P1 | A quote follow-up draft said "colleague se baat ho gayi" — an event that never happened. | prompt: never state that something happened unless the thread shows it | **retest PENDING**: drafting only runs inside the Mon–Fri 10:00–19:00 window and today is Saturday |
| D-014 | **P1** | O-1: a client scope change arriving while the owner was still deciding the last version attached to no quotation, so no rework ran and that version could be approved without it. | objection links `pending_approval` too; rework accepts it as its base (supersedes it, resubmits for approval; nothing reaches the client unapproved) | fresh lead PH1_TEST_021: v1 pending → client asks for doctor role, iOS, reports → v2 (₹1,25,000, 6 lines containing all three) pending, v1 superseded, one pending approval; regression test red-proved |
| D-015 | P2 | O-2: quotes and the client summary were English even for Hinglish clients; the summary read as an internal note ("Client wants…"). | quotation drafters (scope/revise/rework) get a language instruction from the contact's `preferred_language` (Roman-script Hinglish, never Devanagari); requirement extraction writes in the client's language, addressed to them; the confirmation frame is Hinglish for `hi`/`hi-en` (code-composed, not model-written) | lead PH1_TEST_022: summary, quote title/body/lines/features all Hinglish with scope intact; PDF clean (no `?`); new unit test |
| D-016 | P2 | The agent told a client "3 mahine ka timeline doable lagta hai" and that new scope "will shift the estimate" — delivery-timeline assurances only a colleague may give. | reply prompt TIMELINE rule | PH1_TEST_023 (6-week festival, "is that doable?") and PH1_TEST_024 (Hinglish, scope added): both deferred to a colleague, no assurance |
| D-017 | P2 | Router/Coordination tracing: dispatch hard-coded `correlation_id: null` (events 0/26, jobs 8/105 carried one), so event → job → run could not be followed. | one chain id per event, kept if upstream set one, stored on the event before enqueue; jobs and runs inherit | live: jobs of one event share its id and the agent run matches; 3 tests (existing outbox test split into stamp vs bookkeeping, not weakened) |
| D-003/004 | P3 | eslint scanned agent worktrees (8,046 errors); roadmap record 2 tests stale. | ignores; record updated | green |

## 4. Open defects and gaps (not fixed)

| ID | Sev | Gap |
|---|---|---|
| O-1 | ~~P1/P2~~ **FIXED** | **Scope change after a quote was parked** (fixed, see D-014 below). Client asked for a receptionist role, iOS and an advanced admin panel; the objection was recorded (`feature`, round 6) but **no `quotation.rework` job was enqueued** because the version the client held (v2) had been superseded by a pending v3. The owner then approved v3, which was sent without those asks. |
| O-2 | P2 | **Language — partly fixed (D-015).** Hinglish (Roman script) is now done for the model-written quote content, the requirement summary and the confirmation frame. **Still open:** the PDF's fixed headings and the owner's standard terms (commercial, support, regulatory) stay English — translating legal text needs the owner's approval — and **Devanagari** cannot be rendered (font subset is Latin only; adding one is a font download needing approval). |
| O-3 | P2 | **No automatic WON / LOST / NURTURE.** By design (closing is a human act), but every lead stayed `new` through full conversations, an explicit "I don't want to proceed" lead still has an active follow-up, and moving to nurture needs staff. A client saying "December" correctly stopped follow-ups only once a next-follow-up date was set by staff. |
| O-4 | P2 | Agent replies show in the lead chat as **"Staff"** with no AI marker. |
| O-5 | P2 | After a hand-over the client's messages get **no reply** until staff press "Let the agent answer again" (4 price objections unanswered); the local run has no internal channel to prove the owner was alerted. |
| O-6 | P2 | **Trust handling is safe but weak.** No mechanism exists for the owner to give the agent approved trust facts (milestone process, no-advance exception wording); it defers everything. Needs owner-approved text. |
| O-7 | P2 | Router (audit, not live-tested): no provider/model fallback; `ai.routing_policies` is edited in `/agents/routing` but not read at runtime; event dispatch wrote `correlation_id: null` (**fixed, D-017**: one chain id per event, inherited by its jobs and agent runs, stored on the event; live: reply.compose / lead.qualify / message.intent share their event's id); no provider fallback, unused routing policies and no routing-log page remain. |
| O-8 | P3 | A "Request changes" click with an empty note is accepted (the agent correctly waits for a person). |
| O-9 | P3 | Two extra empty draft versions appeared on one lead around clicks on "Draft quotation"; could be a browser-tool double submit. The draft action's idempotency is unproven. |
| O-10 | P3 | A message carrying two objections ("price kam karo" + "advance nahi dunga") records one. |
| O-11 | P3 | The handoff packet carries no negotiation/objection history; for threads shorter than the summary window it says "no summary". It does honestly list what it does not know. |
| O-12 | P3 | The price-pushback rework (G-183) can silently drop an owner-added line and write "none of which were part of the agreed scope" into exclusions. It is owner-approved before sending. |
| O-13 | P3 | The agent often asks 3–4 questions per reply although the prompt says one. |
| O-14 | config | `won_requires_payment_evidence` is **off** by default, so a deal can be WON on an accepted quotation alone. Calendar integration is unconfigured (BLK-005), so a meeting request is a row a person books. Agency timezone must be set before any meeting is recorded; the agent still told a client "call kal zaroor set karwa deta hoon" while the system could not record one. |

## 5. Scenario matrix (live)

| # | Scenario | Result |
|---|---|---|
| 1 | Non-technical Hindi client | PASS_AFTER_FIX (D-005/006): natural, one idea at a time, no price; requirements v1–v4 accumulate; language `hi-en` detected |
| 2 | Highly technical client | PASS_AFTER_FIX (D-007/008): sensible Postgres-vs-Firebase / tenant-isolation answers, deferred HIPAA/uptime |
| 3 | New lead goes silent | PARTIAL: `abandoned_conversation` sequence at 10 days, drafts personalised and language-matched, business-hours window enforced; **actual send not observed** (Saturday) |
| 4 | Discovery → quote → price objection | PASS_AFTER_FIX (D-012): objections classified with rounds; no discount/offer invented |
| 5 | Quotation versions | PASS: v1 → owner changes → v2 → price objection → v3; all versions kept, only approved/sent ones reached the client. Revision reason is not stored on the quote row |
| 6 | Quote sent, client ghosts | PARTIAL: quote sequence created and correctly blocked while the thread waits for a person; send not observed |
| 7 | Multiple follow-ups, still silent | **NOT RUN** (needs several business days) |
| 8 | Near-close ghosting | **NOT RUN** live |
| 9 | Explicit rejection | PARTIAL: polite, no pushback; no LOST recorded automatically (O-3) |
| 10 | Nurture / start later | PASS with staff step: follow-up stopped once the return date was set (O-3) |
| 11 | Trust-issue client | PASS_AFTER_FIX (D-007) but weak (O-6) |
| 12 | Aggressive negotiator | PASS_AFTER_FIX (D-012) |
| 13 | Requirement change after quote | **FAIL** (O-1) |
| 14 | Admin reject / request changes / approve | B (request changes with and without a note) PASS; C (approve → only the exact approved version sent, no internal banner or approver notes in the client PDF) PASS; **A (reject) NOT RUN** |
| 15 | Scheduler full flow | PASS_AFTER_FIX for "kal 4 baje" → call 4 Oct 16:00 IST recorded and visible in `/meetings`; correction/cancel now surfaced to staff (D-011) but not applied automatically; no calendar booking/reminder live (BLK-005) |
| 16 | Language switch | PASS: English → Hinglish → Devanagari → English; `preferred_language` followed |
| 17 | WON + Phase-2 handoff | PASS: accepted v3 ₹85,000, approval record, correlation id, `sales → project_manager` handoff (queued; receiver disabled by design). Gaps O-1, O-11 |
| 18 | Concurrency / isolation | PARTIAL: 6 leads in parallel with no crossover; a probe for another client's name, budget and chats leaked nothing; **10 parallel leads not run**; DB-level isolation proven by the verifiers |

## 6. Quotation quality (real model)

The generated PDF was strong: per-line features and who each serves, explicit exclusions, assumptions, dependencies, client responsibilities, acceptance criteria, GST note, 40/30/30 milestones, support and commercial terms, regulatory note for health data, third-party cost ownership, and an approver-only block that is **absent** from the version sent to the client. Weaknesses: English only (O-2); an unconfirmed technology assumption ("single Flutter build") appeared in one quote; line prices are model-estimated and rely on owner approval.

## 7. Admin Panel

Verified live: Leads (WhatsApp-style chat, requirements with versions, qualification, deal and quotation panels), Quotations (all versions with status, total, valid-until), **Approvals (Approve / Request changes with note / Reject, PDF link)**, Meetings (lead, mode, date, time, timezone, status), Follow-ups, Settings (approvals policy, timezone), Handoff packet. Correction to the earlier code audit: the owner "request changes" control exists. Not verified live: Follow-ups page contents after a send, Router/audit pages.

## 8. Go-live gate

Not met: Hindi/Devanagari quotes and client summary language, follow-up send + D-013 retest, scenarios 7/8/14A/10-lead concurrency, trust facts, router fallback/correlation, auto-lost/nurture decision. No P0 was observed. P1 items found live (D-005, D-006, D-007, D-009, D-013) are fixed except D-013, whose retest is pending; O-1 remains open.
