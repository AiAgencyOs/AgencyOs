## FINDINGS (Business Phase 1, steps 1.1 - 1.21)

Every item cites a file:line or a command result. "Not observed" means the code path was traced and the unit tests read, but no model/Meta call could be made in this environment.

### Critical blockers
- **C1. Phase 1 has never been observed working end to end by any run in this DB.** `SELECT agent_key,count(*),count(*) filter (where status='succeeded') FROM ai.agent_runs GROUP BY 1` -> 1,475 runs, 0 succeeded (sales 1183). The app-driven verifiers that would prove the lead -> answer -> requirement -> quote -> dispatch chain failed in this container: `db:verify:flow01` (J-N failed), `db:verify:quotescope`, `db:verify:quotedispatch` (wire + redraft), `db:verify:proposal`, all with "The configured Anthropic API key was rejected" because the shared dev server (pid 490) runs with `ANTHROPIC_BASE_URL=https://...` while the verifiers bind a stub at 127.0.0.1:54399 (`scripts/verify-flow-01.mjs:10`). This is environmental (CI starts the app against the stubs, `.github/workflows/verify.yml:808-815`), so CI status is unknown to me; but nothing here proves the real chain, so every Phase-1 agent step is NOT_VERIFIED / NOT_PRODUCTION_READY.
- **C2. No lead source other than direct WhatsApp is implemented** (1.1). `crm.leads.source` CHECK = manual|whatsapp|web_form|email|referral|import (`supabase/migrations/20260807120004_crm.sql:47`); the only code that inserts is `crm.ingest_whatsapp_message` (whatsapp), `crm.commit_import_record` (import) and `createLead` (hard-coded 'manual', `src/modules/crm/service.ts:~1350`). The 16 `web_form` and 1 `referral` leads in the DB are seed rows (grep finds no writer). Facebook/Instagram lead forms, website forms, referral and existing-client intake have no endpoint.
- **C3. Every inbound client message is answered by the sales persona regardless of intent or who the sender is** (1.5, 1.7). `crm.emit_reply_due` checks only author_type, media-read, pause and the org switch; the `reply.compose` workflow (`workflows.ts:4829-5700`) never reads `message.intent` (0 hits for intent/spam/support in that range). Spam, support complaints, project messages on a lead thread and a returning WON client all get a sales reply when `agent_answers_clients` is on (Demo Agency: TRUE).
- **C4. A fresh organisation cannot get a quote out of draft**: `sales.submit_proposal` returns `no_policy` unless `approvals.approval_policies` has an active `proposal` rung, and no migration or seed creates one (only `scripts/verify-*.mjs` insert rungs; the single Demo Agency rung is a leftover `zztest-dispatch` verifier row) (1.18).
- **C5. The runner has no scheduler in the repo that is ON**: `vercel.json` has no crons; `infra/aws/cron/template.yaml` declares the `rate(1 minute)` schedule DISABLED. Replies, follow-ups, quote dispatch and every agent job depend on an operator enabling an external POST to `/api/jobs/run` (1.5, 1.20, 1.21). Cannot verify the production schedule.

### Major missing flows
- **M1. Identity resolver with the five outcomes** (1.2): only exact normalised-phone identity for inbound; no email/name normalisation or match, no existing-client detection, no lost/disqualified-lead reactivation outcome, no "possible duplicate" at inbound time (exists only as a same-contact list heuristic `lead-indicators-queries.ts:15-73` and as probable/conflict in the bulk importer).
- **M2. Lead routing / owner assignment to an agent** (1.3): nothing assigns or records a primary Phase-1 agent; `leads.assigned_to` is a human. `decideAgentForTask` has a single Phase-4 caller (`src/modules/orchestrator/handlers.ts:96`).
- **M3. Intent -> routing** (1.7): intent is a label with no routing consumer (only `emit_objection_raised` and UI read it).
- **M4. Structured client confirmation of requirements** (1.12): "YES / CORRECT / ADD / REMOVE" is not parsed; a staff click on `decideRequirementVersion` (`service.ts:988`) is the acceptance. No client-reply evidence is linked to the version.
- **M5. Commercial-strategy record** (1.15) and **trust sub-types / approved trust-content library** (1.13, 1.14): none exist as structures.
- **M6. Quotation Master as a distinct agent with a recorded handoff** (1.16): single-agent by ADM-82; no handoff row for the quote request.
- **M7. Structured Policy verdict (AUTO_APPROVED / ADMIN_APPROVAL_REQUIRED / BLOCKED)** (1.18): not modelled as such; see C4 and the doc conflict below.
- **M8. Adaptive, context-keyed follow-up incl. real offer-expiry reminders** (1.21): fixed business-day rhythms only (`follow-up-rhythms.ts`: sales_active days 2,5,8,11,14,17,20).
- **M9. Admin approval card with client / requirement version / discount / payment plan / exception / risk** (1.19): `/approvals/[requestId]` shows amount, summary, role, SLA, note + PDF link only (`page.tsx:60-149`).

### Broken flows (found by reading code; not executed unless stated)
- **B1. Manual lead creation can fail or silently duplicate** (1.2): `createLead` looks up the contact with `email.eq.<raw>` / `phone.eq.<raw>` (`service.ts:~1300-1310`), but `contacts_org_email_key` is on `lower(email)` and WhatsApp stores phone as `+<digits>`. Same email in another case -> insert violates the unique index and the user gets "Could not create the contact"; a phone typed as `98765 43210` never matches the later `+9198765...` WhatsApp contact -> two contacts/two leads with no duplicate flag.
- **B2. Numeric lead score is a dead path** (1.9): `rescoreLead`/`rescoreAllLeads` are imported by no page or action (grep), so the 20 stored scores (all stamped within one second on 2026-09-29) never refresh; `lead-heat.ts` says the stored score "is never read here or shown anywhere".
- **B3. Score/area count mismatch** (1.8/1.9): `QUALIFICATION_AREAS` has 16 entries (`schema.ts:958-975`) but `COVERAGE_AREA_COUNT = 15` (`lead-score.ts:41`), so full coverage points are awarded at 15 of 16 areas and the reason text says "of 15".
- **B4. `crm.merge_leads` refuses if EITHER lead has any opportunity** (live function body: `has_opportunity`), so a duplicate that has progressed can never be merged by the governed door (1.2).

### Mock-only / stub-only flows
- No production mocks were found in the Phase-1 path. The E2E verifiers (flow01, quotescope, quotedispatch, proposal, media, analysis) depend on a model stub and a Graph stub by design; they are the only way the agent path is exercised and they could not run against stubs here.
- Agent behaviour (tone, one-question-at-a-time, no-fabrication, language matching) is **prompt-only**: `REPLY_PROMPT` (`workflows.ts:4424-4560`). Hard guards that are NOT prompt-only: `clientReplySchema` regexes (no currency/amount/discount, <=1 emoji, <=1200 chars), DB triggers `crm.refuse_unread_price`/`crm.states_a_price`, consent chokepoint, 24h window, `follow_up_sequences_agent_draft_is_plain` CHECK (no digits), portfolio refs resolved from the table.

### Untested flows (no test executes them, or only static text tests)
- A real model reply to a first contact, language matching, hand-to-human (1.4-1.6): only static prompt-text tests (`the-sales-agent-under-pressure`, `which-template-and-in-whose-language`).
- Intent, qualification coverage, objection reading, trust detection (1.7, 1.8, 1.13): jobs are queued locally (`message.intent` 2, `lead.qualify` 2) but never settle; 0 coverage rows, 0 objections, all 56 client messages have NULL intent and NULL language.
- Quote drafting by the model, redraft on "changes requested", standing-offer application (1.17-1.19): DB-level seams pass (`db:verify:quotations`, `approvals`), model/wire seams fail locally.
- Quote delivery over WhatsApp, template fallback, deferral and wake (1.20): not run end to end.
- Follow-up composition (1.21): `db:verify:followup`, `optout`, `consent` pass; the model composer never ran.

### Security risks
- **S1 (low)** `createLead` builds a PostgREST `.or()` filter by interpolating raw `contactEmail`/`contactPhone` (`service.ts` ~1305): commas/parentheses in the input change the filter. Caller is an authenticated internal user with `lead.write`, so impact is limited to mis-matching a contact within the caller's own org (RLS still applies).
- **S2 (medium, design)** Client text is fed to the model in every Phase-1 job. Controls are structural (schema regex, DB triggers, tool boundary: only 4 read-only tools dispatchable, deny-by-default permission rows, `agent_paused_at`) which is good; but no automated prompt-injection test runs a model.
- **S3 (note)** Webhook is fail-closed and constant-time (`verify.ts`), body bounded to 256 KiB streaming (`route.ts:72-104`), tenancy resolved from `phone_number_id`; unsigned POST -> 401 and wrong verify token -> 403 observed live. No finding.
- **S4 (ethics/compliance)** `REPLY_PROMPT` opens "You are a salesperson ... with thirty years behind you", while a later clause requires truthful disclosure only if asked whether it is an AI. Needs an owner ruling on persona wording (spec: no fake claims).

### Data risks
- Duplicate contacts/leads across channels and phone formats (B1, M1).
- `sales.proposals.requirement_version_id` is `ON DELETE SET NULL` (`proposals_requirement_version_id_fkey`): a hard delete of a version (service role only) would orphan the quote's exact-version reference (1.12).
- The extractor runs a model call and writes a new PROPOSED version per inbound text message, each superseding the previous proposed one (`requirement_versions_supersede`): version churn and cost, though history is kept.
- Stale batch scores in `crm.leads.score` (B2).

### Agent gaps
- One multi-job sales agent; no Quotation Master, no routing orchestrator, no dedicated qualifier (all by ADM-82); Orchestrator/Finance/Customer Success disabled; write-tools bound but not dispatchable; `ai.agent_tool_permissions` deny-by-default with one row; the `enabled` kill switch does not govern deterministic handlers carrying agent names. See the inventory section.
- `db:verify:dispatch` fails 2 checks locally because the DB row `customer_success` was disabled ("Paused while the prompt is reviewed") with a reason that is not in the repo - the local DB has drifted from the seeded registry.

### Admin gaps
- Lead queue works (HTTP 200, 27 leads) but gets no "new lead" event/notification (no `lead.created` event exists).
- No UI to trigger or view the numeric score; heat label only.
- Approval page lacks structured commercial context (M9); owner-only for proposals by DB CHECK `approval_policies_money_floor` (no delegate).
- No approval-policy default; no Admin view of a recorded policy verdict.

### WhatsApp gaps
- Real Meta delivery, templates, receipts and media reading are untested here (`WhatsApp media reading is not configured on this deployment` x106 in agent_runs).
- Only the WhatsApp channel is ingested; no Instagram/Facebook DM or lead-form webhooks.
- Closed-window replies are discarded as failed rather than queued as a template (`reply.compose`, window check) - the quote path does plan template/defer, the chat reply path does not.

### Finance gaps (as they touch Phase 1)
- Quote GST wording is a hard-coded constant "All amounts are exclusive of GST; 18% GST extra." (`quotation-standards.ts:191,542`) unless a person types a tax amount; it does not consult the finance billing mode (`finance.confirm_billing_mode`) that later decides GST vs non-GST at M1. A non-GST client can be quoted "18% GST extra".
- Payment schedule is chosen from `sales.payment_structures` by amount band or the two built-in families (A 40/30/30 < 1L, B 30/30/25/15 >= 1L) (`quotation-standards.ts`); the default M1 percentage therefore depends on the quote's structure, not on one locked 30% rule (cross-check in the Phase 2 audit).

### UI / prototype gaps
- None for steps 1.1-1.21 (not in scope); see Phases 3-4.

### NEEDS_BUSINESS_CLARIFICATION
1. Which lead sources are in scope (FB/IG lead forms, website, referral, existing client) and the intake contract (1.1).
2. ADM-05 "one lead per person forever" vs spec outcomes REACTIVATED_LEAD / EXISTING_CLIENT (1.2).
3. Lead routing rules and whether the Orchestrator should route Phase-1 leads (1.3; Orchestrator is OFF by owner decision ADM-82/BLK-002).
4. Numeric score vs Hot/Warm/Cold label as the sanctioned prioritisation, and whether weights must be admin-configurable (1.9).
5. Is a staff click acceptable as "confirmed requirements", or must the client's own reply be captured as evidence (1.12)?
6. Keep the single-agent design (ADM-82) or add a distinct Quotation Master with a recorded handoff (1.16)?
7. Persona wording ("thirty years behind you") and AI-disclosure policy (1.4, 1.6).
8. Tax configuration on quotes (GST on/off per org) (1.17).

### Doc-vs-code conflicts
- `src/modules/crm/ingest.ts:28-31` and the route docblock say the ingest path "never sends ... a reply is a later, human-gated step"; since ADM-91 `reply.due -> sales:answerClient` answers unread (route.ts:33-44 already corrects itself; ingest.ts does not).
- `src/modules/agents/registry.ts:355-363` ("it may never state a price ... no pricing tool") vs the same row's purpose, `QUOTATION_PROMPT` and ADM-96 (the agent proposes per-line prices; owner decides). Stale comment.
- `src/modules/orchestrator/route.ts` docblock presents a routing capability; it is a registry resolver with one Phase-4 caller. `src/lib/events/catalog.ts` header says "only handlers that actually exist are listed" - true, but several handlers named after disabled agents run without the agent being enabled.
- `crm.mark_returning_client` comment: "Nothing subscribes to `lead.returned` yet" - still true (`catalog.ts` has no such key; `tests/event-vocabulary.test.ts:219` lists it as a legacy name).
- `lead-score.ts` header ("Doc 09 §9's fifteen areas") vs 16 areas in the schema/CHECK.
- `lead-heat.ts` ("stored score is never read or shown") vs `lead-score.ts` being the owner-reversed ADM-88 model whose output nothing displays.
- `crm.leads.score` comment in older docs says "always null"; 20 of 32 rows are scored.

### Stale / incorrect claims in the 2026-09-28 audit (`docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json`), re-checked on current main
| Step | 2026-09-28 claim | Current finding |
|---|---|---|
| 1.1 | PARTIAL, manual admin creation works | CONFIRMED; WhatsApp inbound now live-verified; web_form/referral rows are seed-only |
| 1.2 | PARTIAL, manual same-contact merge only | CONFIRMED |
| 1.3 | MISSING | CONFIRMED |
| 1.4 | COMPLETE | OVERSTATED: mechanism real, runtime unverified -> PARTIAL / NOT_VERIFIED |
| 1.5 | PARTIAL, tone not line-by-line confirmed | Now confirmed in `REPLY_PROMPT`; outcome unverified |
| 1.6 | UNKNOWN | Located (`workflows.ts:4424-4560`); PARTIAL |
| 1.7 | PARTIAL | CONFIRMED (+ no routing consumer) |
| 1.8 | "15 topics" | OUTDATED: 16 areas |
| 1.9 | MISSING, score "permanently unused" | INCORRECT now: score computed and stored (ADM-88 reversal), plus a Hot/Warm/Cold label; but unwired |
| 1.10 | flat model, no roles/platform/integrations | OUTDATED: userRoles, platforms, integrations, objectives, businessRules, nonFunctionalRequirements, designReferences exist (migration 20261001180000) |
| 1.11 | no UNANSWERED/OPTIONAL/REFERENCE/TECHNICAL_CONSTRAINT | OUTDATED: openQuestions, designReferences, constraints/nonFunctional exist; OPTIONAL merged with NICE_TO_HAVE |
| 1.12 | COMPLETE | Versioning CONFIRMED in live triggers; PARTIAL for missing structured client confirmation |
| 1.13 | PARTIAL | CONFIRMED |
| 1.14 | PARTIAL | CONFIRMED |
| 1.15 | PARTIAL | CONFIRMED |
| 1.16 | PARTIAL (single agent) | CONFIRMED |
| 1.17 | PARTIAL (stale registry comment) | CONFIRMED |
| 1.18 | COMPLETE ("functionally equivalent") | OVERSTATED: owner forced for proposals; AUTO/BLOCKED exist only in the standing-offer sub-path; no seeded policy |
| 1.19 | COMPLETE | PARTIAL: mechanics real, admin view lacks structured context |
| 1.20 | PARTIAL | CONFIRMED |
| 1.21 | COMPLETE | PARTIAL: opt-out/idempotency verified; contextual/adaptive/offer-expiry not built; cron disabled by default |

