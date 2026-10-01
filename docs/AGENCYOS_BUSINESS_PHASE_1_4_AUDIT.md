# AgencyOS Business Phase 1-4 forensic audit (re-derived 2026-10-01 on main 72d2ccc)

MODE A: audit only. Nothing here was implemented. This replaces the 2026-09-28 audit (aa9d59a); its claims were re-checked row by row and the corrections are in each part below. 112 rows (107 steps + exit/gate rows). Machine-readable rows: `AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json`.

Method: a step counts as COMPLETE only with a traced code path plus runtime or behavioural test evidence. Static-regex tests (they read source text) are not counted as proof. Production readiness is 0 everywhere because no phase has had manual testing and no provider-enabled end-to-end run exists.

## Percentages

| Phase | Rows | Actual complete | Tested (PASSED) | Production-ready |
|---|---|---|---|---|
| 1 Lead-to-Close | 44 | 6.8% (3) | 2.3% (1) | 0.0% (0) |
| 2 Client Onboarding + M1 + Kick-off | 24 | 12.5% (3) | 41.7% (10) | 0.0% (0) |
| 3 UI Theme / Colour / UX Direction | 16 | 6.3% (1) | 6.3% (1) | 0.0% (0) |
| 4 Full UI + Figma + Prototype + M2 | 28 | 7.1% (2) | 3.6% (1) | 0.0% (0) |

By status:

| Phase | COMPLETE | PARTIAL | BROKEN | MISSING |
|---|---|---|---|---|
| 1 | 3 | 40 | 0 | 1 |
| 2 | 3 | 17 | 2 | 2 |
| 3 | 1 | 13 | 1 | 1 |
| 4 | 2 | 22 | 2 | 2 |

## Cross-phase critical findings

1. **Milestone ladder off by one (Phase 2 + 4).** `projects.replace_payment_plan` writes positions 0-based; finance (`service.ts:361`, `:583`), `crm/handlers.ts:2128`, `m2_verified_paid` and `phase_five_gate_status` read 1-based. M1 bills the 20% row, M2 bills the 30% row, the 30% advance is never auto-invoiced, and the start gate accepts any paid milestone. Reproduced by the Phase 2 agent. 8,048 unit tests pass because none runs that lookup. The round-3 Phase 5 gate (M2 verified paid) sits on the same ladder and must be re-checked.
2. **Phase 4 can complete without UI approval (4.24).**
3. **Design-revision loop is dead (3.13)** and a not-ready Phase 3 lock is a permanent dead end (3.15).
4. **Reply guard holes (1.x):** amounts in words, date promises, scarcity, guarantees pass.
5. **No provider-enabled end-to-end run exists** (0 of 1,475 local agent runs succeeded; key rejected locally).
6. **Fresh org cannot send a quote** until an approval policy exists; no seed creates one.
7. **Only direct WhatsApp is a real lead source**; dedupe is exact phone only; lead routing is MISSING.
8. **No secure client-credential path (2.17); no kickoff package (2.22); no dev handoff package (4.27); prototype is a wireframe, no APK pipeline.**

## Row summary

| Step | Name | Impl | Verified | Test | Prod |
|---|---|---|---|---|---|
| 1.1 | Lead arrives | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.2 | Normalize + deduplicate | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.3 | Assign Sales Agent | MISSING | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.4 | Language + communication style | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.5 | First response | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.6 | Relationship building | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.7 | Lead intent identification | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.8 | Initial qualification | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.9 | Qualification score / priority | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.10 | Deep requirement discovery | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.11 | Requirement classification | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.12 | Requirement summary + versioning | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.13 | Trust signal detection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.14 | Trust building | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.15 | Commercial strategy before quote | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.16 | Quotation request to Quotation Master | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.17 | Quotation Master | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.18 | Quote policy check | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.19 | Admin commercial approval | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.20 | Quote delivery | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.21 | Post-quote follow-up | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.22 | Objection diagnosis | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.23 | Price objection handling | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.24 | Value negotiation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.25 | Scope-based negotiation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.26 | Approved extra value | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.27 | Discount | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.28 | Payment structure negotiation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.29 | Feature objection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.30 | Timeline objection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.31 | Trust objection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.32 | Negotiation loop | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.33 | Quote revision | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.34 | Lead ghosts | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.35 | Follow-up engine | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.36 | Nurture | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.37 | Lost | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.38 | Lost-lead win-back | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.39 | Closing signal detection | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.40 | Structured acceptance | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.41 | Won | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 1.42 | Sales handoff package | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.EXIT | Exit routes A WON->Phase 2, B FOLLOW_UP, C NURTURE, D LOST + win-back | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 1.GATE | Phase 1 production-ready gate | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.1 | Receive sales handoff | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.2 | Client identity validation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.3 | Onboarding record | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.4 | Commercial baseline validation | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.5 | M1 finance trigger | BROKEN | VERIFIED | FAILED | NOT_PRODUCTION_READY |
| 2.6 | GST / non-GST context | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.7 | M1 invoice | BROKEN | VERIFIED | FAILED | NOT_PRODUCTION_READY |
| 2.8 | Invoice communication | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.9 | Client payment submission | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.10 | Payment verification | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.11 | Project start gate | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.12 | Project record / workspace | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.13 | Project manager assignment | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.14 | Specialist agent assignment | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.15 | WhatsApp project group | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.16 | Asset collection | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.17 | Secure access / credential collection | MISSING | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.18 | Requirements import | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.19 | Initial scope baseline | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.20 | Timeline / milestones | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.21 | Onboarding checklist | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 2.22 | Kickoff package | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY |
| 2.23 | Official kickoff | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 2.GATE | Phase 2 exit / production-ready gate | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.1 | UI input package | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.2 | Screen inventory | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.3 | Screen content definition | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.4 | User flow map | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY |
| 3.5 | UI/UX direction analysis | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.6 | Theme options | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.7 | Color options | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.8 | Design tokens preview | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.9 | Internal design review | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.10 | Admin review | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 3.11 | Client presentation | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.12 | Client feedback classification | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.13 | Revision | BROKEN | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.14 | Client selection | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.15 | Final UI direction lock | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 3.GATE | Phase 3 exit gate | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.1 | Load locked baseline | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.2 | Figma-first rule | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.3 | Design system | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.4 | Full screen design | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.5 | Screen states | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.6 | Responsive design | PARTIAL | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY |
| 4.7 | Accessibility | PARTIAL | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY |
| 4.8 | Feature coverage matrix | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY |
| 4.9 | Internal UI QA | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.10 | PM / Admin approval of exact UI version | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.11 | Client UI review | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.12 | Client feedback classification | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.13 | UI revision loop | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.14 | Client UI approval | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.15 | Prototype task | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.16 | Prototype generation | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.17 | Prototype interactions | PARTIAL | NOT_VERIFIED | NOT_RUN | NOT_PRODUCTION_READY |
| 4.18 | Prototype version | BROKEN | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.19 | Prototype QA | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.20 | Admin approval of exact prototype build before client release | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.21 | Client prototype review | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.22 | Client prototype feedback classification | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY |
| 4.23 | Prototype revision | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.24 | Client prototype approval | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.25 | M2 finance trigger | BROKEN | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.26 | M2 payment verification and financial gate | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY |
| 4.27 | Development handoff package | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY |
| 4.GATE | Phase 4 production-ready / exit gate | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY |

---
# Detail by part


<!-- Phase 1, steps 1.1-1.21 -->
## P1A audit - Business Phase 1 (Lead-to-Close), steps 1.1 - 1.21

Mode A (audit only). Repo `/home/user/AgencyOs` current main (HEAD 23d8665). Date of audit run: 2026-10-01. Local DB `agencyos_local` (read-only SELECTs), dev server http://127.0.0.1:3000 (owner session), unit tests under Node 26, live verifiers through `flock /tmp/verify.lock`.

**Rows: 21.** Implementation status: MISSING 1, PARTIAL 20. Verification: every row NOT_VERIFIED except 1.3 (VERIFIED as MISSING - code path and DB traced). Production readiness: every row NOT_PRODUCTION_READY.

**Headline.** The WhatsApp ingest, consent/opt-out chokepoint, requirement versioning, quotation arithmetic/approval/dispatch records and follow-up contract are real, enforced in SQL and live-verified. The agent behaviour on top (first response, language, intent, qualification, objections, quote drafting, follow-up wording) is wired to the job runner but has **never produced a successful run in this environment** (1,475 `ai.agent_runs`, 0 succeeded) and the end-to-end verifiers fail here for an environmental reason (shared dev server points at the real Anthropic endpoint, not the verifier stub). Spec features with no implementation: non-WhatsApp lead sources, identity resolution with five outcomes, lead routing, intent-based routing, structured client confirmation, commercial-strategy record, policy verdict object, adaptive follow-up. Row data: `P1A.json` (21 objects, spec schema).

### TABLE

| step_id | step | implementation | verification | test | production | blocker / key note |
|---|---|---|---|---|---|---|
| 1.1 | Lead arrives (source, campaign, contact, message captured; appears in Admin Leads queue; agent does not blind-pitch) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Business sources other than direct WhatsApp (FB/IG lead form, website, referral) are not implemented; needs owner decision on which sources are in scope and on a generic signed lead-intake endpoint. |
| 1.2 | Normalize + deduplicate (NEW_IDENTITY / EXISTING_LEAD / EXISTING_CLIENT / REACTIVATED_LEAD / POSSIBLE_DUPLICATE_REVIEW) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No identity-resolution service with the five outcomes; business must define 'existing client' and 'reactivated lead' semantics (ADM-05 says one lead per person forever and a returning client gets a new deal on the same lead). |
| 1.3 | Assign Sales Agent (routing; Sales Agent becomes primary Phase 1 owner) | MISSING | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Business has not defined lead routing rules (NEEDS_BUSINESS_CLARIFICATION); Orchestrator intentionally OFF by owner decision (ADM-82/BLK-002). |
| 1.4 | Language + communication style (Hindi/English/Hinglish/other; natural, not robotic; name used naturally) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Needs a real provider key to exercise; style quality is untestable by static tests. |
| 1.5 | First response (relationship first, not a package; greet, acknowledge, understand; one question at a time) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Needs real provider + WhatsApp to observe an actual first response; no intent gate (spec says route non-sales correctly). |
| 1.6 | Relationship building (respectful, patient, warm, non-pushy; no false friendship) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Behaviour cannot be proven without a provider; owner must rule on persona wording. |
| 1.7 | Lead intent identification (service/price/requirement/comparison/trust/existing project/repeat/support/spam; route non-sales correctly) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No routing consumer for intent. |
| 1.8 | Initial qualification (what/why/who/platform/stage/timeline/urgency/decision-maker/budget/...; do not re-ask known answers) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Provider required to observe extraction; owner to confirm the 'why/problem/stage/experience' areas. |
| 1.9 | Qualification score / priority (for prioritisation only) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | NEEDS_BUSINESS_CLARIFICATION: which of the numeric score and the label is the sanctioned prioritisation, and whether weights must be admin-configurable. |
| 1.10 | Deep requirement discovery (goal, problem, roles, features, platform, integrations, admin needs, design refs, existing system, constraints, delivery expectation, optional, future; stored structured) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Provider needed to observe real extraction. |
| 1.11 | Requirement classification (CONFIRMED, ASSUMPTION, UNANSWERED, OPTIONAL, NICE_TO_HAVE, EXCLUDED, REFERENCE, TECHNICAL_CONSTRAINT) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | None technical; NEEDS_BUSINESS_CLARIFICATION on whether OPTIONAL and NICE_TO_HAVE must be separate. |
| 1.12 | Requirement summary + versioning (client can say YES/CORRECT/ADD/REMOVE; confirmed version; quotation references exact version) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | NEEDS_BUSINESS_CLARIFICATION: is a staff click acceptable as 'confirmed requirements', or must the client's explicit reply be captured as evidence? |
| 1.13 | Trust signal detection (record the exact concern) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Provider needed to observe. |
| 1.14 | Trust building (approved portfolio/case study/demo/process/milestones/approvals/payment gate/prototype structure/support; no unsupported guarantees) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Owner must supply approved portfolio/case studies and process copy. |
| 1.15 | Commercial strategy before quote (budget range, ideal timeline, must-have vs optional, flexibility, sensitivity) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | NEEDS_BUSINESS_CLARIFICATION: should a structured commercial-strategy record exist before quoting? |
| 1.16 | Quotation request to Quotation Master (structured handoff: lead/client, requirement_version, type, must-haves, optional, platforms, integrations, timeline, pricing context, budget, trust, payment preferences) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | NEEDS_BUSINESS_CLARIFICATION: keep ADM-82 single-agent design, or add a distinct Quotation Master with a recorded handoff. |
| 1.17 | Quotation Master (versioned quote with client, summary, scope, deliverables, timeline, price, tax, payment milestones, validity, terms, next step) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Provider needed for a real draft; NEEDS_BUSINESS_CLARIFICATION on tax configuration (GST on/off per org) and single-agent vs Quotation Master. |
| 1.18 | Quote policy check (price range, margin, discount, offer, payment structure, minimum advance, timeline promises, exceptions: AUTO_APPROVED | ADMIN_APPROVAL_REQUIRED | BLOCKED) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No default approval policy for a fresh org (quotes stall in draft); spec's Policy Engine outcomes not modelled. |
| 1.19 | Admin commercial approval (client, project, requirements, quote version, price, discount, payment plan, exception, reason, risk; APPROVE/REJECT/REQUEST_CHANGE on the exact version) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Structured approval context not shown; verification of approve->dispatch needs WhatsApp + provider. |
| 1.20 | Quote delivery (Sales Agent explains value/timeline/payment/next step, not just a PDF; sent time, channel, delivery, read) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Real WhatsApp/Meta templates + provider cannot be exercised locally. |
| 1.21 | Post-quote follow-up (contextual, not 'any update?'; clarification, feature explanation, concern; real offer expiry; respect opt-out; stop after response) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | External cron not verified; adaptive/contextual scheduling not built. |

### AGENT HIERARCHY INVENTORY (whole project, 15 capabilities)

Evidence base: `SELECT * FROM ai.agents / ai.agent_handoff_targets / ai.agent_tool_permissions / ai.agent_runs` on the local DB (read-only), `src/modules/agents/registry.ts`, `src/modules/agents/tools.ts` + `tool-dispatch.ts`, `src/lib/events/catalog.ts`, `app/api/jobs/run/route.ts` + `workflows.ts`. Prompts live inside `app/api/jobs/run/workflows.ts` (not under `prompts/`, which holds only a README).

Four facts that govern every row below (all verified):

1. **ai.agents has 16 rows**: enabled = sales, requirement_collector, handover, project_manager, quality_assurance, support, ui_designer, ui_prototype; disabled = finance and orchestrator ("OFF by the owner's activation answer 2026-09-13, ADM-82 / BLK-002"), customer_success ("Paused while the prompt is reviewed" - this reason is not in the repo, i.e. changed through the UI/DB), developer, upsell, lead_qualifier + proposal_drafter ("Folded into the sales agent by ADM-82"), semantic_indexer (ledger key, "not an agent").
2. **The `enabled` flag is a kill switch for model-run workflows ONLY.** `app/api/jobs/run/route.ts:1159-1175` reads `ai.agents.enabled` for `AGENT_WORKFLOWS`; the deterministic "event handlers" that carry agent-looking names in `src/lib/events/catalog.ts` (`orchestrator:routeTask2Design`, `quality_assurance:reviewUIVersion`, `quality_assurance:reviewPrototypeBuild`, `orchestrator:requestUIVersionAdminReview`, `finance:generateM1..M4Invoice`, `projects:*`) are claimed by `runEventJobs` without consulting `ai.agents`. So a "disabled" Orchestrator/Finance row does not stop those code paths, and an "enabled" QA row is not what performs the design/prototype verdicts.
3. **Agents act through hard-wired workflows, not through tools.** `registry.ts` binds 38 tool slots; `tool-dispatch.ts` dispatches only 4 read-only tools (`crm.readLead`, `crm.readConversation`, `memory.recall`, `projects.readScope`); the 10 write tools (including `crm.sendClientMessage`, `approvals.requestApproval`, `finance.generateInvoice`, `sales.draftProposal`) are bound and authorizable but have NO dispatch handler (tools.ts docblock). `ai.agent_tool_permissions` is deny-by-default and holds ONE row locally (handover / crm.readLead), so even `memory.recall` offered to `sales` in `lead.qualify` would be refused here unless the tenant records a permission row.
4. **Zero agent runs have ever succeeded in this DB**: `SELECT agent_key,count(*) FROM ai.agent_runs` = 1,475 rows, all `failed` (sales 1183 [1050 "The configured Anthropic API key was rejected", 106 "WhatsApp media reading is not configured", 27 "No AI provider is configured"], requirement_collector 187, ui_designer 34, quality_assurance 34, handover 12, project_manager 12, support 12, customer_success 1). Every agent claim below is therefore "traced in code + unit/static tests", never "observed producing a real model output".

| # | Capability | ai.agents row (enabled / autonomy) | Prompt(s) | Tool(s) | Module / files | Runtime path & wiring verdict |
|---|---|---|---|---|---|---|
| 1 | **Sales Agent** | `sales` (enabled, L1, claude-sonnet-5, 16 steps, cost cap 2000) | INTENT_PROMPT `workflows.ts:2459`, QUALIFY_PROMPT `:3498`, SUMMARY_PROMPT `:3765`, OBJECTION_PROMPT `:3990`, FOLLOW_UP_PROMPT `:4181`, REPLY_PROMPT `:4424`, IMAGE_PROMPT `:5530`, QUOTATION_PROMPT `:5953`, REVISION_PROMPT `:7135`, REWORK_PROMPT `:7784` | bound: crm.readLead, crm.readConversation, memory.recall, memory.remember, crm.addLeadNote, crm.recordSalesActivity, sales.draftProposal, approvals.requestApproval, crm.sendClientMessage; dispatchable: only the 3 reads + memory.recall, and only `memory.recall` is offered (lead.qualify); permission row required | `src/modules/agents/registry.ts:364-394`, `app/api/jobs/run/workflows.ts` (message.intent, meeting.request_read, lead.qualify, conversation.summarise, objection.read, followup.compose, reply.compose, message.describe, quotation.scope/revise/rework), `src/modules/crm/*`, `src/modules/sales/*` | WIRED to the job runner: webhook -> `crm.ingest_whatsapp_message` -> triggers emit `message.received` / `reply.due` -> `planJobsForEvent` (catalog.ts:321, :392) -> `core.jobs` -> `POST /api/jobs/run` -> `AGENT_WORKFLOWS`. It is ONE multi-job agent (ADM-82 folded qualifier + drafter + negotiator into it). Not an FAQ bot by prompt; behaviour not observed (0/1183 runs succeeded). Registry docblock (`registry.ts:355-363`, "may never state a price") contradicts the same row's purpose and ADM-96 - stale comment. |
| 2 | **Quotation Master** | NONE. `proposal_drafter` exists but is disabled ("Folded into the sales agent by ADM-82") | QUOTATION_PROMPT / REVISION_PROMPT / REWORK_PROMPT under `sales` | same as sales | `sales.draftProposal` tool is bound but not dispatchable; real drafting = workflow `quotation.scope` writing `sales.draft_proposal` / `add_proposal_item` RPCs; policy sections by CODE `src/modules/sales/quotation-standards.ts`; pricing bands `pricing-knowledge.ts`/`pricing-reference.ts` | Capability exists as a **job kind of the sales agent**, not as a separate agent. Triggered by `requirement.accepted` (catalog.ts:237). No recorded sales -> quotation handoff (sales' only handoff targets are project_manager, quality_assurance). |
| 3 | **Orchestrator** | `orchestrator` (**disabled**, L2) | none (no model prompt) | none (`tools: []`, `handoffTargets: []` in registry; DB agent_handoff_targets has no orchestrator rows) | `src/modules/orchestrator/route.ts` (`decideAgentForTask`, pure registry resolver), `handlers.ts` (`handleRouteTask2Design`, `requestUIVersionAdminReview`) | **Only a Phase-4 code path.** `decideAgentForTask` has one caller (Phase-4 Task-2 UI routing); nothing routes a Phase-1 lead or message. Inbound routing is the static event catalog. Because handlers bypass `ai.agents.enabled`, the disabled row does not disable this code. Spec principle "Orchestrator routes" is NOT true for Phase 1. |
| 4 | **Policy Engine** | none (deterministic) | none | none | spread across: `approvals.resolve_policy` / `request_approval` / `decide_approval` + `approval_policies` ladder (money floor: proposals need owner), `sales.submit_proposal`, `sales.apply_approved_offer` (cost floor, minimum price, autonomous ceiling, one offer per deal), `src/lib/ai/autonomy.ts` (`mayAgentRun` L0/L1/L2 x work class), `policy-decision.ts` + `agent-policy.ts` (tool/project deny-by-default), DB guards `crm.refuse_unread_price` / `crm.states_a_price`, `crm.send_outbound_message` consent chokepoint, `follow-up-contract.ts` | Real, enforced in SQL/code and live-verified (db:verify:approvals, autonomy, unreadprice, consent, optout pass). But it is **not one engine**: no single verdict object (AUTO_APPROVED / ADMIN_APPROVAL_REQUIRED / BLOCKED), no trust/scope/revision policy component, and no seeded default proposal policy (fresh org -> `no_policy`). |
| 5 | **Admin** | none (human authority) | none | none | `app/(internal)/*` (approvals, leads, quotations, follow-ups, settings/commercial, agents), roles owner / ops_admin / delivery_lead, `approvals.decide_approval`, `crm.merge_leads` (owner only), `override_lead_heat` | Real and rendered (owner session: /leads, /quotations, /approvals, /follow-ups, /agents, /portfolio, /meetings, /sales-funnel all HTTP 200). The sidebar 'Pipeline' entry is `/sales-funnel` (200). Governed-exception handling exists for quotes (approve / request changes / reject) but not as a general exception object. |
| 6 | **WhatsApp / Communication** | none (infrastructure) | none (language/intent reading is the sales agent's `message.intent` job) | none (the `crm.sendClientMessage` tool is not dispatchable) | `app/api/webhooks/whatsapp/route.ts`, `src/lib/whatsapp/{payload,verify,send,media,template-vocabulary}.ts`, `src/modules/crm/{ingest,outbound-window,template-send-service,delivery-retry-service,follow-up-worker,handlers}.ts`, SQL `crm.ingest_whatsapp_message`, `ingest_group_message`, `send_outbound_message`, `record_delivery_receipt`, `defer_send`, consent triggers | The most mature layer and live-verified (db:verify:ingest, webhook, groupin, consent, optout, returning pass): HMAC, replay-safe ingest, tenancy by phone_number_id, consent + opt-out chokepoint, 24h window + template + deferral, delivery receipts. Missing vs spec: identity/dedupe beyond exact phone, language/intent not used for routing, no non-WhatsApp channels. Real Meta not tested. |
| 7 | **Finance Agent** | `finance` (**disabled**, L1) - "money stays human (ADM-07)" | none | `finance.generateInvoice`, `approvals.requestApproval` bound; NOT dispatchable | `src/modules/finance/handlers.ts` (`handleBillingModeConfirmed` -> M1 invoice), `finance:generateM2/M3/M4Invoice` catalog handlers, `src/modules/finance/*` (invoices, payments, GST, reconciliation, claims) | Invoice generation is **deterministic code**, not the agent; it runs from events regardless of the disabled row. The agent row has no workflow in `AGENT_WORKFLOWS` at all. Payment verification is a human act (`finance` verify claims UI). (Detail belongs to the Phase 2 audit.) |
| 8 | **PM Agent** | `project_manager` (enabled, L2) | BREAKDOWN_PROMPT `workflows.ts:661`, CLASSIFY_CLIENT_FEEDBACK_PROMPT `:1521` | bound: projects.readScope, memory.*, projects.submitChangeRequest, approvals.requestApproval, crm.sendClientMessage; only the reads dispatchable | `registry.ts:402-427`, workflows `plan.breakdown`, `ui_version.classify_client_feedback`; `src/modules/projects/*` handlers (`projects:startPhaseTwo/Three/Four`, deterministic) | Partly wired: 2 model workflows; phase starts and the sales->PM handoff are code (`sales.hand_off_on_a_win` trigger + `sales.record_won_handoff` write `ai.handoffs` from=sales to=project_manager; event `project.handoff_bound` -> `projects:startPhaseTwo`). Not a Phase-1 actor. |
| 9 | **Requirements / Scope** | `requirement_collector` (enabled, L1) | REQUIREMENT_PROMPT `workflows.ts:246` | none (`tools: []`) | workflows `requirement.extract` (queued DIRECTLY by `crm.ingest_whatsapp_message`, not via the catalog) and `meeting.analysis`; `src/modules/crm/requirement-*`, `schema.ts` requirementPayloadSchema; scope side: `projects.scope_versions`, `ui_designer:screenInventory` | Wired and the only agent seeded from day one; produces PROPOSED versions only (human accepts). Scope baseline is a projects-module concept (Phase 2/3). Extraction failed 187/187 locally (provider). |
| 10 | **UI Designer** | `ui_designer` (enabled, L2) | INVENTORY_PROMPT `:848`, UI_VERSION_DRAFT_PROMPT `:1061`, UI_VERSION_REVISE_PROMPT `:1278`, DIRECTIONS_PROMPT `:2179` | projects.readScope, memory.recall, projects.addDeliverable (only the first two dispatchable) | `registry.ts:431-449`, workflows `ui.inventory`, `ui.version_draft`, `ui.version_revise`, `design.directions` | Wired to the runner via catalog (`scope.frozen`, `project.screen_list_finalized`, `project.ui_version_*`). 34 runs, 0 succeeded locally. (Phases 3-4 audits own the detail.) |
| 11 | **UI / Design QA** | `quality_assurance` (enabled, L2) | TEST_PLAN_PROMPT `:2922` (qa.plan only) | none | `src/modules/qa/handlers.ts` `handleReviewUIVersion` via `quality_assurance:reviewUIVersion` | The design verdict is **deterministic code** ("pure database work, no model call", route.ts:560-600), not an agent run; `ai.agents.quality_assurance` governs only the AI `qa.plan` workflow. |
| 12 | **Prototype Agent** | `ui_prototype` (enabled, L2, claude-opus-5) | PROTOTYPE_BUILD_PROMPT `:1731`, PROTOTYPE_BUILD_REVISE_PROMPT `:1937` | projects.readScope, memory.recall, projects.addDeliverable | `registry.ts:454-472`, workflows `prototype.build`, `prototype.build_revise`, `src/modules/projects/prototype-service.ts` | Wired to the runner (`project.ui_version_locked` -> `ui_prototype:build`). No model run has succeeded locally. |
| 13 | **Prototype QA** | `quality_assurance` | none | none | `src/modules/qa/handlers.ts` `handleReviewPrototypeBuild` via `quality_assurance:reviewPrototypeBuild` | Deterministic coverage verdict (route.ts:589-615), not an agent run; same caveat as #11. |
| 14 | **Automation / Job system** | none (infrastructure; `core.jobs`) | none | none | `app/api/jobs/run/route.ts` (one tick: dispatch events -> reaper -> alerts -> expire approvals -> lapse quotes -> upsell -> follow-ups -> invoice reminders -> campaigns -> overdue -> handlers -> agent batch), `src/lib/events/{catalog,dispatch}.ts`, `src/lib/jobs/{reaper,retry,staleness,nudge,runner-address}.ts`, `src/modules/crm/follow-up-worker.ts`, `core.jobs` (status queued/running/succeeded/failed/dead/cancelled, attempts, dedupe_key, `core.claim_agent_job ... for update skip locked`), `infra/aws/cron/*` | Real retry/backoff/reaper/dead-letter (`status='dead'`) and idempotent claim, live-verified by db:verify:reaper/claims in the repo (not re-run by me). **Needs an external 1-minute POST**: `vercel.json` has no crons; `infra/aws/cron/template.yaml` ships the EventBridge schedule DISABLED. Local jobs table: reply.compose 1 queued/1 succeeded, lead.qualify 2 queued, message.intent 2 queued, proposal.dispatch 2 queued/1 succeeded (stalled for lack of a provider). |
| 15 | **Memory / Context** | none (no agent row; tool slots on sales/PM/CS/etc.) | none | `memory.recall` (dispatchable), `memory.remember` (not dispatchable) | `ai.memory_records` (177 rows locally: client 37, organization 101, lead 39) + `ai.recall` RPC called directly by workflows (`workflows.ts:4290, 5060, 5088, 6942, 6977`), `crm.conversation_summaries` rolling summary (`conversation.summarise` job), `crm.qualification_coverage`, `sales.record_won_handoff` -> `ai.handoffs`, `src/modules/projects/onboarding-context.ts` | Memory is real and written by deterministic "learn" handlers (`sales:learnFromDecision`, `sales:learnFromRevision`) and the intent job's durable-fact field; **recalled** by the reply and quote workflows. Sales knowledge survives into Phase 2 through the won-handoff packet (`ai.handoffs`) and the onboarding-context resolver. Agent-initiated `memory.remember` is not a live tool. |

Summary: 1 multi-job agent (sales) carries the whole of Phase 1; qualifier, drafter and a separate quotation agent were deliberately folded away (ADM-82). Orchestrator, Finance and Customer Success are disabled by owner decision; the orchestrator and finance behaviours that do run are plain code. There is no agent-to-agent message passing at runtime in Phase 1 (handoffs are database rows written by SQL, and the `ai.handoffs` writer for Phase 1 is the won-deal trigger).

### UNIT TESTS RUN (Node 26, `--conditions=react-server`, via `tests/_alias.mjs`) AND CLASSIFICATION

All 39 files below were run on current main and all passed (0 fail, 0 skipped). "Classification" is by reading the file's imports/structure: **[behavioral]** imports and executes repository code (pure functions or services with a mocked Supabase client); **[static-regex]** `readFileSync`s a migration/source file and asserts text patterns - it proves the text exists, not that it behaves. Counts are node:test `# pass`.

| Test file | pass | Classification |
|---|---|---|
| crm-ingest | 50 | [static-regex] (migration + ingest source text); a few [behavioral] zod parses of the inbound schema |
| group-ingest | 16 | [static-regex] (migration/route text) + [behavioral] `parseDelivery` |
| whatsapp-webhook | 57 | [behavioral] HMAC verify + `parseDelivery`; route behaviour itself [static-regex] |
| whatsapp-tenancy | 10 | [static-regex] |
| communication-consent | 16 | [static-regex] |
| lead-conversion | 18 | [behavioral, mocked Supabase] `markLeadConverted` + [static-regex] |
| one-deal-per-lead | 25 | [behavioral, mocked] `createOpportunity/setOpportunityStage` + [static-regex] |
| one-timeline-for-a-lead | 13 | [static-regex] + light mock |
| two-leads-that-were-always-one | 16 | [behavioral, mocked] `mergeLeads` + [static-regex] on SQL |
| a-lead-is-hot-or-silent-by-what-was-said | 12 | [behavioral] pure functions |
| a-lead-is-hot-warm-or-cold | 12 | [behavioral] pure functions |
| a-score-has-two-authors | 15 | [static-regex] + schema parse |
| no-invented-lead-score | 16 | [behavioral] `scoreLead` pure + [static-regex] |
| a-lead-that-is-not-ready-yet | 14 | [static-regex] + constants |
| follow-up-contract | 31 | [behavioral] pure `evaluate()` + 1 [static-regex] |
| follow-up-rhythms | 26 | [behavioral] pure |
| quotations | 61 | [behavioral, mocked Supabase] sales service + [static-regex] migrations |
| the-sales-agent-under-pressure | 58 | [static-regex] on prompt/runner/SQL text + [behavioral] `clientReplySchema` |
| the-agent-does-everything-but-decide | 25 | [static-regex] |
| the-agent-explains-the-quotation | 20 | [static-regex] |
| requirement-chain | 19 | [static-regex] |
| requirement-decision | 14 | [behavioral, mocked] `decideRequirementVersion` |
| requirement-proposal | 80 | [static-regex] on runner source + capability matrix unit |
| a-requirement-has-nine-sections | 25 | [behavioral] schema parse + [static-regex] |
| what-the-requirement-does-not-say | 6 | [behavioral] schema + [static-regex] |
| a-price-objection-turns-the-loop | 11 | [static-regex] + [behavioral] `planJobsForEvent` |
| the-client-asks-and-the-agent-redrafts | 16 | [static-regex] |
| the-owner-reads-the-quotation | 33 | [static-regex] |
| the-quotation-offers-a-choice | 43 | [static-regex] |
| the-offer-is-a-choice | 21 | [static-regex] |
| an-offer-the-owner-made-in-advance | 37 | [static-regex] |
| approval-engine | 30 | [behavioral, mocked] approvals service + [static-regex] |
| approval-centre | 27 | [behavioral, mocked] + [static-regex] |
| agent-registry | 27 | [static-regex] + registry data checks |
| agent-handoffs | 15 | [static-regex] |
| agent-dispatch | 76 | [static-regex] on runner source |
| the-agent-answers-without-waiting-for-a-clock | 22 | [static-regex] + `runnerUrl` unit |
| which-template-and-in-whose-language | 15 | [static-regex] |
| where-the-leads-are-lost | 28 | [static-regex] |
| sales-activities | 19 | [static-regex] |

Reading: roughly two thirds of Phase-1 unit tests are static text assertions. The behavioural ones cover pure scoring/heat/follow-up logic and mocked service flows; **no unit test executes a model, the reply workflow, the quotation workflow or the objection loop.**

### LIVE VERIFIERS RUN (each through `flock /tmp/verify.lock npm run -s db:verify:<name>`, target 127.0.0.1:54321)

| Verifier | rc | Result | Note |
|---|---|---|---|
| ingest | 0 | All checks passed | [live-db] atomic ingest, replay, concurrency, tenancy |
| webhook | 0 | All checks passed | [live-db] over real HTTP to the dev route: bad signature refused, ingest, replay, non-JSON 400 |
| groupin | 0 | pass | group message creates no lead |
| returning | 0 | pass (16 checks) | returning client = same lead, marked, no status rewrite |
| consent | 0 | pass | no consent -> no send |
| optout | 0 | pass | inbound STOP honoured, final |
| followup | 0 | pass | a sequence cannot send twice / cross tenants |
| qualification | 0 | pass | qualified_at stamped on conversion |
| noscore | 0 | pass | score stored only with reasons/inputs |
| journey | 0 | pass | inbound -> lead -> deal -> quote -> project -> invoice -> deliverable; **drives SQL, not the TS services or any model** |
| quotations | 0 | pass | staff draft -> owner approves -> sent |
| approvals | 0 | pass | approval engine |
| wongate / handoff / dealterms / second | 0 | pass | (Won steps, other slice) |
| import / reactivation / funnel / memory | 0 | pass | |
| definitions / autonomy / chain / unreadprice | 0 | pass | agent definitions validated at a0647c07735c; autonomy; requirement chain; unread price refused |
| **flow01** | **1** | FAILED locally | env: dev server's ANTHROPIC_BASE_URL is the real https endpoint (key rejected) not the verifier's stub (127.0.0.1:54399); A-I passed, J-N failed |
| **quotescope** | **1** | FAILED locally | same cause (no model draft) |
| **quotedispatch** | **1** | FAILED locally | DB-side seams passed (submit, approve, covering note first, authored by approver, learned once, no double dispatch); wire send + model redraft not produced (same cause) |
| **proposal** | **1** | FAILED locally | 'The configured Anthropic API key was rejected' - extraction produced no version |
| **dispatch** | **1** | 2 checks failed | customer_success not dispatched: DB row `customer_success` is disabled with a reason that exists nowhere in the repo (local drift) |

(Results for media, extractionretry, events, receipts, clauses, planset, announce, unannounced, booking are listed in the final section "Late verifier results" below if they completed.)

#### Late verifier results
| Verifier | rc | Result |
|---|---|---|
| media | 1 | 31/68 checks passed - image/voice reading needs the Graph + model stubs ("WhatsApp media reading is not configured on this deployment") |
| extractionretry | 0 | All checks passed |
| events | 0 | All checks passed (event vocabulary) |
| receipts | 0 | 34 checks passed (delivery receipts monotonic) |
| clauses | 0 | All checks passed |
| planset | 0 | Two or three plans, approved once, client picks one |
| reaper | 0 | All checks passed (stalled jobs recovered / parked dead) |
| claims | 0 | A claim of one takes one, and one job has one owner |
| announce / unannounced / booking | - | queued behind other agents' verifier runs; not completed when this report was finalised (NOT_RUN) |


### FINDINGS (Business Phase 1, steps 1.1 - 1.21)

Every item cites a file:line or a command result. "Not observed" means the code path was traced and the unit tests read, but no model/Meta call could be made in this environment.

#### Critical blockers
- **C1. Phase 1 has never been observed working end to end by any run in this DB.** `SELECT agent_key,count(*),count(*) filter (where status='succeeded') FROM ai.agent_runs GROUP BY 1` -> 1,475 runs, 0 succeeded (sales 1183). The app-driven verifiers that would prove the lead -> answer -> requirement -> quote -> dispatch chain failed in this container: `db:verify:flow01` (J-N failed), `db:verify:quotescope`, `db:verify:quotedispatch` (wire + redraft), `db:verify:proposal`, all with "The configured Anthropic API key was rejected" because the shared dev server (pid 490) runs with `ANTHROPIC_BASE_URL=https://...` while the verifiers bind a stub at 127.0.0.1:54399 (`scripts/verify-flow-01.mjs:10`). This is environmental (CI starts the app against the stubs, `.github/workflows/verify.yml:808-815`), so CI status is unknown to me; but nothing here proves the real chain, so every Phase-1 agent step is NOT_VERIFIED / NOT_PRODUCTION_READY.
- **C2. No lead source other than direct WhatsApp is implemented** (1.1). `crm.leads.source` CHECK = manual|whatsapp|web_form|email|referral|import (`supabase/migrations/20260807120004_crm.sql:47`); the only code that inserts is `crm.ingest_whatsapp_message` (whatsapp), `crm.commit_import_record` (import) and `createLead` (hard-coded 'manual', `src/modules/crm/service.ts:~1350`). The 16 `web_form` and 1 `referral` leads in the DB are seed rows (grep finds no writer). Facebook/Instagram lead forms, website forms, referral and existing-client intake have no endpoint.
- **C3. Every inbound client message is answered by the sales persona regardless of intent or who the sender is** (1.5, 1.7). `crm.emit_reply_due` checks only author_type, media-read, pause and the org switch; the `reply.compose` workflow (`workflows.ts:4829-5700`) never reads `message.intent` (0 hits for intent/spam/support in that range). Spam, support complaints, project messages on a lead thread and a returning WON client all get a sales reply when `agent_answers_clients` is on (Demo Agency: TRUE).
- **C4. A fresh organisation cannot get a quote out of draft**: `sales.submit_proposal` returns `no_policy` unless `approvals.approval_policies` has an active `proposal` rung, and no migration or seed creates one (only `scripts/verify-*.mjs` insert rungs; the single Demo Agency rung is a leftover `zztest-dispatch` verifier row) (1.18).
- **C5. The runner has no scheduler in the repo that is ON**: `vercel.json` has no crons; `infra/aws/cron/template.yaml` declares the `rate(1 minute)` schedule DISABLED. Replies, follow-ups, quote dispatch and every agent job depend on an operator enabling an external POST to `/api/jobs/run` (1.5, 1.20, 1.21). Cannot verify the production schedule.

#### Major missing flows
- **M1. Identity resolver with the five outcomes** (1.2): only exact normalised-phone identity for inbound; no email/name normalisation or match, no existing-client detection, no lost/disqualified-lead reactivation outcome, no "possible duplicate" at inbound time (exists only as a same-contact list heuristic `lead-indicators-queries.ts:15-73` and as probable/conflict in the bulk importer).
- **M2. Lead routing / owner assignment to an agent** (1.3): nothing assigns or records a primary Phase-1 agent; `leads.assigned_to` is a human. `decideAgentForTask` has a single Phase-4 caller (`src/modules/orchestrator/handlers.ts:96`).
- **M3. Intent -> routing** (1.7): intent is a label with no routing consumer (only `emit_objection_raised` and UI read it).
- **M4. Structured client confirmation of requirements** (1.12): "YES / CORRECT / ADD / REMOVE" is not parsed; a staff click on `decideRequirementVersion` (`service.ts:988`) is the acceptance. No client-reply evidence is linked to the version.
- **M5. Commercial-strategy record** (1.15) and **trust sub-types / approved trust-content library** (1.13, 1.14): none exist as structures.
- **M6. Quotation Master as a distinct agent with a recorded handoff** (1.16): single-agent by ADM-82; no handoff row for the quote request.
- **M7. Structured Policy verdict (AUTO_APPROVED / ADMIN_APPROVAL_REQUIRED / BLOCKED)** (1.18): not modelled as such; see C4 and the doc conflict below.
- **M8. Adaptive, context-keyed follow-up incl. real offer-expiry reminders** (1.21): fixed business-day rhythms only (`follow-up-rhythms.ts`: sales_active days 2,5,8,11,14,17,20).
- **M9. Admin approval card with client / requirement version / discount / payment plan / exception / risk** (1.19): `/approvals/[requestId]` shows amount, summary, role, SLA, note + PDF link only (`page.tsx:60-149`).

#### Broken flows (found by reading code; not executed unless stated)
- **B1. Manual lead creation can fail or silently duplicate** (1.2): `createLead` looks up the contact with `email.eq.<raw>` / `phone.eq.<raw>` (`service.ts:~1300-1310`), but `contacts_org_email_key` is on `lower(email)` and WhatsApp stores phone as `+<digits>`. Same email in another case -> insert violates the unique index and the user gets "Could not create the contact"; a phone typed as `98765 43210` never matches the later `+9198765...` WhatsApp contact -> two contacts/two leads with no duplicate flag.
- **B2. Numeric lead score is a dead path** (1.9): `rescoreLead`/`rescoreAllLeads` are imported by no page or action (grep), so the 20 stored scores (all stamped within one second on 2026-09-29) never refresh; `lead-heat.ts` says the stored score "is never read here or shown anywhere".
- **B3. Score/area count mismatch** (1.8/1.9): `QUALIFICATION_AREAS` has 16 entries (`schema.ts:958-975`) but `COVERAGE_AREA_COUNT = 15` (`lead-score.ts:41`), so full coverage points are awarded at 15 of 16 areas and the reason text says "of 15".
- **B4. `crm.merge_leads` refuses if EITHER lead has any opportunity** (live function body: `has_opportunity`), so a duplicate that has progressed can never be merged by the governed door (1.2).

#### Mock-only / stub-only flows
- No production mocks were found in the Phase-1 path. The E2E verifiers (flow01, quotescope, quotedispatch, proposal, media, analysis) depend on a model stub and a Graph stub by design; they are the only way the agent path is exercised and they could not run against stubs here.
- Agent behaviour (tone, one-question-at-a-time, no-fabrication, language matching) is **prompt-only**: `REPLY_PROMPT` (`workflows.ts:4424-4560`). Hard guards that are NOT prompt-only: `clientReplySchema` regexes (no currency/amount/discount, <=1 emoji, <=1200 chars), DB triggers `crm.refuse_unread_price`/`crm.states_a_price`, consent chokepoint, 24h window, `follow_up_sequences_agent_draft_is_plain` CHECK (no digits), portfolio refs resolved from the table.

#### Untested flows (no test executes them, or only static text tests)
- A real model reply to a first contact, language matching, hand-to-human (1.4-1.6): only static prompt-text tests (`the-sales-agent-under-pressure`, `which-template-and-in-whose-language`).
- Intent, qualification coverage, objection reading, trust detection (1.7, 1.8, 1.13): jobs are queued locally (`message.intent` 2, `lead.qualify` 2) but never settle; 0 coverage rows, 0 objections, all 56 client messages have NULL intent and NULL language.
- Quote drafting by the model, redraft on "changes requested", standing-offer application (1.17-1.19): DB-level seams pass (`db:verify:quotations`, `approvals`), model/wire seams fail locally.
- Quote delivery over WhatsApp, template fallback, deferral and wake (1.20): not run end to end.
- Follow-up composition (1.21): `db:verify:followup`, `optout`, `consent` pass; the model composer never ran.

#### Security risks
- **S1 (low)** `createLead` builds a PostgREST `.or()` filter by interpolating raw `contactEmail`/`contactPhone` (`service.ts` ~1305): commas/parentheses in the input change the filter. Caller is an authenticated internal user with `lead.write`, so impact is limited to mis-matching a contact within the caller's own org (RLS still applies).
- **S2 (medium, design)** Client text is fed to the model in every Phase-1 job. Controls are structural (schema regex, DB triggers, tool boundary: only 4 read-only tools dispatchable, deny-by-default permission rows, `agent_paused_at`) which is good; but no automated prompt-injection test runs a model.
- **S3 (note)** Webhook is fail-closed and constant-time (`verify.ts`), body bounded to 256 KiB streaming (`route.ts:72-104`), tenancy resolved from `phone_number_id`; unsigned POST -> 401 and wrong verify token -> 403 observed live. No finding.
- **S4 (ethics/compliance)** `REPLY_PROMPT` opens "You are a salesperson ... with thirty years behind you", while a later clause requires truthful disclosure only if asked whether it is an AI. Needs an owner ruling on persona wording (spec: no fake claims).

#### Data risks
- Duplicate contacts/leads across channels and phone formats (B1, M1).
- `sales.proposals.requirement_version_id` is `ON DELETE SET NULL` (`proposals_requirement_version_id_fkey`): a hard delete of a version (service role only) would orphan the quote's exact-version reference (1.12).
- The extractor runs a model call and writes a new PROPOSED version per inbound text message, each superseding the previous proposed one (`requirement_versions_supersede`): version churn and cost, though history is kept.
- Stale batch scores in `crm.leads.score` (B2).

#### Agent gaps
- One multi-job sales agent; no Quotation Master, no routing orchestrator, no dedicated qualifier (all by ADM-82); Orchestrator/Finance/Customer Success disabled; write-tools bound but not dispatchable; `ai.agent_tool_permissions` deny-by-default with one row; the `enabled` kill switch does not govern deterministic handlers carrying agent names. See the inventory section.
- `db:verify:dispatch` fails 2 checks locally because the DB row `customer_success` was disabled ("Paused while the prompt is reviewed") with a reason that is not in the repo - the local DB has drifted from the seeded registry.

#### Admin gaps
- Lead queue works (HTTP 200, 27 leads) but gets no "new lead" event/notification (no `lead.created` event exists).
- No UI to trigger or view the numeric score; heat label only.
- Approval page lacks structured commercial context (M9); owner-only for proposals by DB CHECK `approval_policies_money_floor` (no delegate).
- No approval-policy default; no Admin view of a recorded policy verdict.

#### WhatsApp gaps
- Real Meta delivery, templates, receipts and media reading are untested here (`WhatsApp media reading is not configured on this deployment` x106 in agent_runs).
- Only the WhatsApp channel is ingested; no Instagram/Facebook DM or lead-form webhooks.
- Closed-window replies are discarded as failed rather than queued as a template (`reply.compose`, window check) - the quote path does plan template/defer, the chat reply path does not.

#### Finance gaps (as they touch Phase 1)
- Quote GST wording is a hard-coded constant "All amounts are exclusive of GST; 18% GST extra." (`quotation-standards.ts:191,542`) unless a person types a tax amount; it does not consult the finance billing mode (`finance.confirm_billing_mode`) that later decides GST vs non-GST at M1. A non-GST client can be quoted "18% GST extra".
- Payment schedule is chosen from `sales.payment_structures` by amount band or the two built-in families (A 40/30/30 < 1L, B 30/30/25/15 >= 1L) (`quotation-standards.ts`); the default M1 percentage therefore depends on the quote's structure, not on one locked 30% rule (cross-check in the Phase 2 audit).

#### UI / prototype gaps
- None for steps 1.1-1.21 (not in scope); see Phases 3-4.

#### NEEDS_BUSINESS_CLARIFICATION
1. Which lead sources are in scope (FB/IG lead forms, website, referral, existing client) and the intake contract (1.1).
2. ADM-05 "one lead per person forever" vs spec outcomes REACTIVATED_LEAD / EXISTING_CLIENT (1.2).
3. Lead routing rules and whether the Orchestrator should route Phase-1 leads (1.3; Orchestrator is OFF by owner decision ADM-82/BLK-002).
4. Numeric score vs Hot/Warm/Cold label as the sanctioned prioritisation, and whether weights must be admin-configurable (1.9).
5. Is a staff click acceptable as "confirmed requirements", or must the client's own reply be captured as evidence (1.12)?
6. Keep the single-agent design (ADM-82) or add a distinct Quotation Master with a recorded handoff (1.16)?
7. Persona wording ("thirty years behind you") and AI-disclosure policy (1.4, 1.6).
8. Tax configuration on quotes (GST on/off per org) (1.17).

#### Doc-vs-code conflicts
- `src/modules/crm/ingest.ts:28-31` and the route docblock say the ingest path "never sends ... a reply is a later, human-gated step"; since ADM-91 `reply.due -> sales:answerClient` answers unread (route.ts:33-44 already corrects itself; ingest.ts does not).
- `src/modules/agents/registry.ts:355-363` ("it may never state a price ... no pricing tool") vs the same row's purpose, `QUOTATION_PROMPT` and ADM-96 (the agent proposes per-line prices; owner decides). Stale comment.
- `src/modules/orchestrator/route.ts` docblock presents a routing capability; it is a registry resolver with one Phase-4 caller. `src/lib/events/catalog.ts` header says "only handlers that actually exist are listed" - true, but several handlers named after disabled agents run without the agent being enabled.
- `crm.mark_returning_client` comment: "Nothing subscribes to `lead.returned` yet" - still true (`catalog.ts` has no such key; `tests/event-vocabulary.test.ts:219` lists it as a legacy name).
- `lead-score.ts` header ("Doc 09 §9's fifteen areas") vs 16 areas in the schema/CHECK.
- `lead-heat.ts` ("stored score is never read or shown") vs `lead-score.ts` being the owner-reversed ADM-88 model whose output nothing displays.
- `crm.leads.score` comment in older docs says "always null"; 20 of 32 rows are scored.

#### Stale / incorrect claims in the 2026-09-28 audit (`docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json`), re-checked on current main
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




<!-- Phase 1, steps 1.22-1.42 + gate -->
## P1B audit: Business Phase 1, steps 1.22 to 1.42 + 1.EXIT + 1.GATE (MODE A, audit only)

Repo: /home/user/AgencyOs, main at 23d8665. Audited 2026-10-01. Rows: 23 (`P1B.json`). No product code, migration or commit was touched; only `docs/audit-parts/` was written.

How evidence was gathered: read the live function bodies in the local Postgres (psql, `agencyos_local`), traced the workflows in `app/api/jobs/run/workflows.ts`, ran 32 unit test files and 22 live verifiers (every one through `flock /tmp/verify.lock`), and probed `clientReplySchema` and `crm.states_a_price` with adversarial sentences. Real AI providers and WhatsApp are not configured locally, so every model-dependent step is traced in code only and is NOT_VERIFIED.

Test classification used below: [behavioral] calls real code with inputs and asserts outputs; [static-regex] reads source/migration text and matches regexes (proves the text exists, not behavior); [live-db] runs against Postgres. Almost every `tests/*.test.ts` file cited here is static-regex, with a few behavioral sections (named in each row).

### A. Step table

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

### B. Sales Agent quality checklist

How the agent actually runs: `sales` (L1, enabled) runs single-shot, schema-constrained workflows (`message.intent`, `lead.qualify`, `conversation.summarise`, `objection.read`, `reply.compose`, `followup.compose`, `quotation.scope/revise/rework`). The tool loop (`callModelWithTools`) is used only by `lead.qualify` and is limited to the four read tools (`DISPATCHABLE` in `src/modules/agents/tool-dispatch.ts`); the registry's write tools (`crm.sendClientMessage`, `finance.generateInvoice`, `memory.remember`...) are refused as `not_dispatched`. There is no pricing tool for any agent (`src/modules/agents/tools.ts:108-120`). So the MUST-NOTs are enforced mostly by (a) absence of capability, (b) output schemas, (c) DB triggers on the message row, and only the remainder by prompt prose. Switches that gate the whole client-facing behavior default OFF: `core.organizations.agent_answers_clients=false`, `agent_writes_follow_ups=false`, `reactivation_pilot_enabled=false` (psql).

#### B1. Capabilities

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

#### B2. MUST-NOT enforcement (probe = `clientReplySchema.safeParse` run through node; DB = psql `crm.states_a_price`)

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

#### B3. Conversation memory (structured facts with source evidence)

- Store: `ai.memory_records` (scope lead/client, kind, fact <=300 chars, confidence, source_kind/source_id, authored_by_agent). DB CHECKs: an agent can never write `verified`; `explicit` or `verified` must carry source_kind+source_id (psql constraints `memory_agent_cannot_verify`, `memory_claimed_provenance_is_recorded`); `db:verify:memory` passed. The intent job writes one `explicit` fact per client message pointing at the message id (workflows.ts:2620-2650). 147 memory rows locally, 30 agent-authored.
- Limits: one fact per message; `kind` is a free `^[a-z][a-z0-9_]{2,40}$` string, not a controlled vocabulary of the spec list; recall is capped at 8.
- The spec's fact list is spread over tables rather than held as one memory object: name (`crm.contacts`), project/needs/budget/timeline/decision-maker/payment-preference/trust concerns (`crm.leads.qualification`: 15 areas, each with the client's quote), requirements (`crm.requirement_versions`), objections (`sales.objections`), quote versions/offers/discount (`sales.proposals`), follow-up date (`crm.leads.next_follow_up_at`). Absent as named fields: pain points, goals, **next best action**.
- Doc-vs-code: none material. Source evidence is real for memory rows and qualification quotes; agent output for `reply` carries no evidence pointers.

#### B4. Reasoning-output hygiene

- Every sales workflow demands a strict zod/JSON schema (`.strict()`, decoder-safe JSON schema); none has a free "reasoning/analysis" field. The only free text that reaches a client is `reply`/`body`; `handToHuman` is internal.
- Provider adapters keep only `text` and `tool_use` blocks (`src/lib/ai/claude.ts:151-216`), so Anthropic thinking blocks are dropped.
- Stored: `ai.agent_runs` output = the validated structured object; `ai.agent_steps.response` keeps the raw pre-validation JSON and the system prompt (no transcript copy) behind RLS to internal members only (psql policy `agent_steps_select`). So internal reasoning is not exposed to clients, and no chain-of-thought is requested or stored.
- Spec structured outcomes vs reality: lead_stage (`leads.status`, human-moved), intent (`message.intent`), qualification (coverage), requirements, objection_type (`sales.objections.kind`), trust_signal (only as objection kind `trust`), follow_up_at (system-scheduled, not agent-set), quote_version (`objections.proposal_id`), approved_offer (`proposals.applied_offer_id`). **Missing: next_best_action and an explicit approval_needed flag** (only a `handToHuman` reason string).

#### B5. Follow-up intelligence

| property | status | evidence |
|---|---|---|
| State-aware | MET | Worker re-reads the subject each tick and stops on reply, quotation accepted/rejected/lapsed/superseded, deal won/lost, lead converted/disqualified (follow-up-worker.ts:203-260, 630-700). Nurture status does NOT stop a lead-level sequence. |
| Opt-out | MET | consent `withdrawn` -> stop; STOP heard from inbound (verified live). |
| Frequency | MET per sequence | Fixed rhythms (sales_active 2,5,8..20; sales_nurture 7..49); one sequence per subject; no cross-situation cap. |
| Business hours | MET | 10:00-19:00 window (owner-configurable), business days only; org timezone required or send is blocked (no invented default). |
| Stops after configured attempts | PARTIAL | Max 7/7/2/3/2 then escalate to a person and pause the thread; attempts are code constants, not owner settings. |
| Context-sensitive content | PARTIAL | Agent draft uses the last 8 messages + memory but only when `agent_writes_follow_ups` is on; default body is generic English placeholder. |
| Spec situation variety | PARTIAL | No offer-expiry, decision-check, trust-evidence, budget-alternative or timeline-availability situations. |

#### B6. Handoff quality fields (spec list vs `ai.handoffs` / `record_won_handoff`)

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

### C. FINDINGS

#### Critical blockers
1. Reply guard has real holes on the one path where a message reaches a client unread. Spelled-out/Hinglish amounts, delivery date/duration promises, "free" work, fake scarcity, guarantees and invented client names all PASS `clientReplySchema` and `crm.states_a_price` (probe output; psql). The schema docblock (crm/schema.ts:1085-1099) says "no date, no commitment" but only money numerals and "N% off" are checked. Mitigant: `agent_answers_clients` defaults false.
2. No provider-enabled E2E exists for negotiation. `db:verify:quotescope` and `db:verify:quotedispatch` fail locally (runner has no model stub), so rework, standing-offer apply, and revision loops are NOT live-verified in this run.

#### Major missing flows
- Objection taxonomy: 7 of 11 spec categories absent (row 1.22).
- Win-back of lost deals by reason (row 1.38): reactivation pool is `status in (new,qualifying,qualified)` only (`crm.reactivation_priority`, `observe_follow_up_candidates`).
- Automated nurture outreach: nothing reads `next_follow_up_at` except the Today reminder (psql scan of all crm/sales/core functions; grep).
- Closing-signal consumer (row 1.39); next_best_action field.
- Per-client alternative payment structures (lower advance, prototype-first, deferral) (row 1.28).
- Extras catalog beyond one discount offer (row 1.26).
- Follow-up situations: offer expiry, decision check, trust evidence, budget alternative, timeline availability.

#### Broken flows
- None found as outright broken in code read. Candidate logic defect (code-traced, not reproduced): `price_inquiry` is a trigger intent for `objection.raised` and the reader has no "none" option, so a plain price question after a quote becomes a price objection, increments `round`, and (with a sent quote) enters `quotation.rework` and possibly the standing offer (workflows.ts:4004-4160, 8012-8050; `crm.emit_objection_raised`).

#### Mock-only flows
- None found in the production path. Model-dependent steps depend on a real provider that is absent locally.

#### Untested flows
- Round-cap hand-over, standing-offer apply under a real quote, rework with a model, follow-up draft with a model, reply compose end-to-end, WhatsApp delivery: no behavioral or live run here.
- All cited `tests/*.test.ts` except follow-up-contract, follow-up-rhythms, state-transitions, one-deal-per-lead (and parts of quotations, the-sales-agent-under-pressure, the-payment-terms-the-owner-chooses, the-thread-remembers-its-beginning, the-handoff-has-a-face) are static-regex.

#### Security risks
- Reply-path content guard gaps (Critical 1).
- `negotiation_max_discount_pct` etc. do not bind a human-typed discount (row 1.27); owner approval is the only control.
- Acceptance has no evidence requirement (row 1.40).

#### Data risks
- `opportunities_lost_says_why` is declared NOT VALID (legacy rows unguaranteed). Parallel loss records (`opportunities.lost_category` vs `leads.disqualified_reason`).
- Round counter inflated by misclassified price questions.
- `ai.handoffs` packet carries ids not content; payment plan terms only inside `proposals.document`.
- One `abandoned_conversation` sequence per lead ever.

#### Agent gaps
- No next_best_action / approval_needed outputs; no vulnerability or scarcity policy; contact name not given to reply composer; memory `kind` is free-form; one fact per message.

#### Admin gaps
- Where an owner records objection response/outcome/next action was not audited in this slice (RLS allows internal update; UI not inspected). Offer/limits settings exist at `/settings/commercial`; there is no Admin view of a negotiation round with discount/offer/payment term in one row.

#### WhatsApp gaps
- Real WhatsApp delivery, 24h window handling and STOP in live traffic not tested here (window verifiers see appendix). STOP matcher is a regex list (English, Hinglish, Devanagari only).

#### Finance gaps
- `won_requires_payment_evidence` default OFF: a deal can be won with no payment evidence or exception unless the owner switches it on. This matches "WON != payment verified" but should be a conscious default.

#### UI / prototype gaps
- None in this slice.

#### NEEDS_BUSINESS_CLARIFICATION
1. Which objection categories and which alternative payment structures are "approved" (rows 1.22, 1.28).
2. Should human-typed discounts be capped/require a reason (row 1.27)?
3. Win-back policy per lost reason: wait time, approver, wording (row 1.38).
4. Required acceptance evidence (row 1.40).
5. Feasibility/expedite definition for timeline objections (row 1.30).
6. Catalog of non-monetary extras (row 1.26).

#### Doc-vs-code conflicts
- `src/modules/crm/service.ts:1146-1149` says `next_follow_up_at` "is what the follow-up engine already reads": it is not read by any engine function (psql scan).
- `src/modules/sales/handoff-view.ts:75` banner says the handoff "waits at queued with no receiver: the PM agent is disabled (BLK-002)"; but `project.handoff_bound -> projects:startPhaseTwo` consumes it and flips status to accepted (`projects.start_phase_two`).
- `crm/schema.ts` docblock for `clientReplySchema` says nothing in the reply can commit a date; the schema does not check dates.
- `REPLY_PROMPT` and `salesFileFor` say the agent may not offer a payment structure; correct, and consistent with the code.

#### Stale / incorrect claims in the 2026-09-28 audit (re-checked on current main)
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

### D. Appendix: commands run and results

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



<!-- Phase 2 -->
## Business Phase 2 audit (P2) - Client onboarding + M1 payment + official kickoff

Scope: steps 2.1-2.23 and 2.GATE (24 rows). Repo: /home/user/AgencyOs, current `main` (HEAD 23d8665 + docs). Audit only: no product code was changed, nothing committed. Machine-readable rows: `docs/audit-parts/P2.json`.

Implementation status counts: BROKEN 2, COMPLETE 3, MISSING 2, PARTIAL 17 (total 24).

How verification was done: live DB verifiers through `flock /tmp/verify.lock` (db:verify:handoff, onboarding, paymentverify, finance-w1, w2-projects, groups, groupin, scope, chain, requirementplan, planset, phase3, vault, wongate, contracts, dealterms: all exit 0; db:verify:billing and db:verify:unlock exit 1 at fixture setup on the dirty local DB; db:verify:reconciliation 11 failures, not investigated); my own probes: SQL transactions as real roles (`SET ROLE authenticated` + JWT claims for owner/ops_admin/finance/member/contractor), the real `generateFirstMilestoneInvoice` service function executed with node against the local DB, and the real job runner chain (`/api/jobs/run`) for billing_mode_confirmed -> invoice.generate_m1; HTTP smoke of project pages as owner. Full unit suite (`npm test`): 8048 tests, 1669 suites, 8048 pass, 0 fail (exit 0) - and the M1 position bug is live regardless.

Test classes used below: [behavioral] calls code and asserts results; [static-regex] reads source/migration text and matches regex (proves text exists, not behavior); [live-db] runs against Postgres. Where a file mixes them the row says so.

### 1. Step table

| step | name | implementation | verification | test | production | blocker / key note |
|---|---|---|---|---|---|---|
| 2.1 | Receive sales handoff | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | PM 'agent' does not consume the packet: ai.agents.project_manager is enabled with tools (readScope, memory, sendClientMessage...) but the only project_manager job workflows are plan.breakdown and ui_version.classify_client_feedback (app/api/jobs/run/workflo... |
| 2.2 | Client identity validation | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No active dedupe at conversion; contact is not linked to the new account; 'client_identity_confirmed' is a manual tick. Duplicate-merge exists only for leads (G-316). |
| 2.3 | Onboarding record | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | No single onboarding record: data is spread across projects.projects, phase_two, onboarding_items, billing_profiles, group_setups; no PM or specialist-agent field on it; ADM-108 still open (nothing marked required, so the checklist is decoration). |
| 2.4 | Commercial baseline validation | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Validation is advisory (named unresolved flag); nothing blocks invoicing if the project's proposal differs from the packet's or the quote's discount/schedule differs from the plan. Discount/offer/exception are not re-validated at Phase 2. |
| 2.5 | M1 finance trigger | BROKEN | VERIFIED | FAILED | NOT_PRODUCTION_READY | M1 is under-billed by one third (20% vs 30%) on every project using the locked structure; Advance milestone (position 0) is skipped and never invoiced by the handler. Nothing flags the wrong amount. A person can still raise M1 manually from the milestone (g... |
| 2.6 | GST / non-GST context | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY | Production readiness withheld only because the M1 step that consumes this context is BROKEN (2.5) and the real E2E (client -> confirmation -> invoice) passes only for the wrong milestone. |
| 2.7 | M1 invoice | BROKEN | VERIFIED | FAILED | NOT_PRODUCTION_READY | Wrong amount invoiced automatically; test suite gives false green (no test executes the milestone lookup). |
| 2.8 | Invoice communication | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No automatic send on issue; a human must press send. Real WhatsApp/email channels not configured (BLK-003/BLK-007) so delivery state could not be verified. |
| 2.9 | Client payment submission | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | No client or WhatsApp-originated submission: only staff can transcribe a claim; no payment gateway (tests/no-payment-gateway.test.ts pins that). Two parallel records exist (claim vs ledger payment) and nothing links a verified claim to a payment (payment_id... |
| 2.10 | Payment verification | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | Two unlinked verification surfaces (claim vs ledger): confirming a claim does not pay the invoice; confirming a ledger payment does not touch the claim. Finance (human) role cannot verify at all - only owner/ops_admin, though the spec says 'Admin/authorised... |
| 2.11 | Project start gate | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No linkage between an approved payment exception and the Phase 2 gate; override is free-text by owner (not an approval record). DB-level bypass: direct status update by owner/ops_admin/delivery_lead. |
| 2.12 | Project record / workspace | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY | Project creation from a WON deal is a human click; agents are not linked to the workspace by default (2.14); project-level requirements link is indirect. |
| 2.13 | Project manager assignment | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | PM 'owns the client' only by convention: no mechanism sets the primary client-facing owner or stops Sales from continuing ordinary project communication (the sales agent's reply workflow is keyed to the lead conversation, not to the project). |
| 2.14 | Specialist agent assignment | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No assignment happens during onboarding (not part of the 17-item flow beyond a manual tick 'specialist_agents_assigned'); only the owner can write assignments; no runtime proof of refusal; allowed_work_classes is empty so work-class limits are not populated. |
| 2.15 | WhatsApp project group | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | Group creation is manual and attested by a person (external constraint); PM ownership of the group is not recorded; inbound sender authorisation missing. |
| 2.16 | Asset collection | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No per-asset register (logo, colours, domain, hosting, API access each as own row with state MISSING/REQUESTED/RECEIVED/VALIDATED); no automated follow-up for unanswered asset requests; ADM-109 (cadence/channel) and ADM-108 (which items are required) open. |
| 2.17 | Secure access / credential collection | MISSING | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No secure mechanism exists to collect or store client/project credentials; technical_access_identified is a manual tick. Clients' secrets will end up in WhatsApp text or notes. |
| 2.18 | Requirements import | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Import is not wired into Phase 2 start; the version reference is not recorded on the scope baseline; the AI path needs a real provider (untested). |
| 2.19 | Initial scope baseline | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | Kickoff can complete with no scope baseline; no import from the accepted requirement version. |
| 2.20 | Timeline / milestones | COMPLETE | VERIFIED | PASSED | NOT_PRODUCTION_READY | Plans are authored by a human; no agent drafts the initial timeline (timeline_assumptions_recorded is a manual tick). Production readiness withheld because the payment-milestone side is BROKEN (2.5). |
| 2.21 | Onboarding checklist | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | No auto-derivation from real state; no required items configured and no Settings screen to configure them. |
| 2.22 | Kickoff package | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY | No structured kickoff package; the PM composes the message by hand outside the system. |
| 2.23 | Official kickoff | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | The kickoff is recorded, not sent: the panel says no channel exists although the same codebase sends invoices through crm.sendClientMessage/sendClientDocument (consent, window, provider). Real WhatsApp/email not configured (BLK-003/BLK-007) so delivery was ... |
| 2.GATE | Phase 2 exit / production-ready gate | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | 1) M1 amount defect (financial correctness). 2) No secure client-credential path. 3) No real client communication (kickoff/invoice send manual; channels unconfigured). 4) PM/specialist agents not runtime participants of Phase 2; agent assignment is permissi... |

### 2. Findings

#### 2.1 Critical blockers
1. **M1 invoice bills the wrong milestone (2.5, 2.7), still true on current main.** `src/modules/finance/service.ts:361` filters `.eq('position', 1)`; `projects.replace_payment_plan` stores `position = ordinality - 1` (0-based), so the 30% Advance row is position 0 and position 1 is the 20% row. Reproduced two ways: (a) node call of the real `generateFirstMilestoneInvoice` on a fixture plan returned `created` INV-2026-0003 with subtotal 2,000,000 minor (budget 10,000,000) bound to "On UI prototype approval (20%)"; (b) real chain through the runner: `finance.confirm_billing_mode` -> event `project.billing_mode_confirmed` -> `core.jobs` kind `invoice.generate_m1` status `succeeded` -> INV-2026-0005 subtotal 2,000,000 tax 360,000 total 2,360,000 (correct would be 3,000,000 / 3,540,000). The job reports success. The 8,048-test unit suite passes with 0 failures while this is live (no test executes the milestone lookup: grep of tests for the position filter finds nothing). Sibling: `generateM2Invoice` (service.ts:583) reads position 2 (the 30% row).
2. **Start/kickoff gate opens on ANY paid milestone invoice (2.11).** `projects.start_readiness.advance_verified` = EXISTS(invoice with status 'paid' on any milestone of the project). Run: only the 20% row (what finding 1 bills) paid, the 30% M1 invoice still draft -> `advance_verified = t`.
3. **No secure path for client credentials (2.17).** The vault (`core.secret_credentials`, `src/lib/secrets/registry.ts:77-116`) holds the agency's own provider keys in fixed global slots; it cannot hold a client's hosting/domain/app-store access. The file guard (`file-secrets-guard.ts`) refuses obvious secrets and then points users at that same vault.

#### 2.2 Major missing flows
- Structured kickoff package (2.22): no renderer, no table; `record_kickoff` takes a free-text evidence reference.
- Automatic hand-off to Phase 2: a WON deal reaches Phase 2 only after a person clicks convert (`app/(internal)/leads/[leadId]/sales-panel.tsx:493`); `opportunity.handed_off` has no subscriber (catalog grep) and there is no backlog item for won-but-unconverted deals.
- Requirement import into the project (2.18): `plan.breakdown` fires only on `requirement.accepted` and settles `succeeded` with "no project for this requirement yet" when the project does not exist (workflows.ts:716-745); nothing replays it at conversion or `project.handoff_bound`. Scope baseline is hand-built; `openScopeVersion` passes no requirement version.
- Per-asset register with REQUIRED/REQUESTED/RECEIVED/VALIDATED/MISSING (2.16).
- Single primary PM / client-facing ownership (2.13).

#### 2.3 Broken flows
- 2.5 / 2.7 (above). Everything downstream of the M1 row (receipt, gate, M2 chain) is correct only if a person raises M1 by hand from the milestone.
- Start-gate inconsistency (2.11): owner override (`start_project` with reason) sets status `active` with nothing paid, but `pre_kickoff_readiness` still returns `advance_not_verified`, so the override can never complete Phase 2 (run: override started, kickoff gate `{advance_not_verified, no_active_plan}`).
- `pre_kickoff_readiness.group_ready` defaults true when no setup card exists, but `start_project` then refuses `no_whatsapp_group` (observed in the kickoff run).

#### 2.4 Mock-only / non-agent flows
- There is no PM or Finance AI runtime in Phase 2. `ai.agents.project_manager` is enabled with six tools but its only workflows are `plan.breakdown` and `ui_version.classify_client_feedback` (workflows.ts AGENT_WORKFLOWS); `finance` and `orchestrator` are disabled in the live DB. Phase 2 = deterministic doors + human clicks. No real AI provider/WhatsApp locally, so every agent path is "real integration not tested".

#### 2.5 Untested flows
- No automated test covers won -> convert -> phase_two -> billing -> M1 amount -> pay -> verify -> kickoff end to end with amount assertions. The only live proof of record_kickoff success was my own SQL run (rolled back). `verify-onboarding.mjs` / `verify-whatsapp-groups.mjs` do not call `record_kickoff`.
- Runner enforcement of agent project assignment (2.14) is pinned structurally plus a pure decision test, never driven.
- Client conversion dedupe (2.2) not executed (code trace).

#### 2.6 Security risks
- DB bypass of the start gate: `projects_write` policy = `can_manage_delivery()` (owner, ops_admin, delivery_lead); a direct `UPDATE projects.projects SET status='active'` succeeded for owner and ops_admin and was refused (0 rows) for member/contractor. The gate lives in `start_project`/`setProjectStatus` only.
- `projects.start_project(...override reason)` has no role check in SQL: ops_admin succeeded at DB level; the TS layer requires `organization.settings` (owner). Direct RPC bypasses it.
- No four-eyes on money: the same ops_admin recorded and verified a payment (psql).
- Agent assignment is default-open (2.14): an agent with zero assignments may work on all projects (agent-policy.ts:21).
- Inbound WhatsApp group messages are authored `client` with no authorised-participant check (`crm.ingest_group_message`, own comment cites G-116/ADM-74) (2.15). Inbound text is stored unredacted.
- Finance role (human) can read money but cannot record, verify or request evidence (RLS/`forbidden`), as designed; spec text says "Admin/authorised Finance".

#### 2.7 Data risks
- Under-billing (finding 1); `start_readiness` accepts the wrong milestone (finding 2).
- `projects.phase_two.state` only ever holds `context_loading` or `completed` (writers: `record_kickoff` only); eight advertised states and `context_loaded_at` are never written, so Admin cannot see waiting_client/waiting_finance (2.3).
- `convertToProject` creates a new `core.client_accounts` per won deal without the identity dedupe `createClientAccount` runs, and does not link the contact (2.2).
- `project.billing_mode_confirmed` is emitted at confirm time, before billing details exist (2.6).
- Claim layer vs ledger: a verified `payment_submissions` row does not create or touch a payment (payment_id stays null; invoice stayed `issued`); two records to reconcile by hand (2.9/2.10).
- DB accepts a GSTIN with a bad checksum (shape-only CHECK); only TS `checkGstin` validates it.

#### 2.8 Agent gaps
- PM does not consume the handoff or ask the client; the rendered "missing info" message is for a person to copy (migration 20260920180000). No specialist agent assignment at onboarding; checklist items `project_manager_assigned` / `specialist_agents_assigned` are manual ticks. Agent roster cannot contain AI agents (`add_project_member` -> `not_internal`).

#### 2.9 Admin gaps
- No Settings screen to edit `onboarding_baseline` or mark items required (ADM-108): grep of `src/` and `app/` finds no reference; the checklist gates nothing (`onboarding_settled` = true on an empty checklist).
- No won-but-unconverted backlog; no invoice-issued-but-unsent backlog; no PM/agent assignment step in the Admin flow.

#### 2.10 WhatsApp gaps
- Group creation is manual by necessity (Meta Groups API refused, ADM-95); state machine pending -> created -> mapped -> verified is real and gated, but mapping is a human attestation and participants are not stored/enforced.
- Invoice send is a human button (WhatsApp or email) through the governed door; no automatic send on issue; email transport unconfigured locally.
- Kickoff: the Phase 2 panel states "AgencyOS cannot send the kickoff message - there is no channel configured", yet invoices already go out through `crm.sendClientMessage/sendClientDocument`. The wire is missing, not the mechanism. No provider was configured, so no delivery was exercised.

#### 2.11 Finance gaps
- Outcome vocabulary on current main: VERIFIED and REJECTED (claim + ledger), MISMATCH (claim, with note), NEEDS_MORE_INFO = `evidence_requested` (`finance.request_payment_evidence`), PARTIAL = ledger-level `partially_paid` (record 1,000,000 then verify -> status partially_paid, receipt issued; remainder 2,000,000 -> paid, 2 receipts, gate flips only at full), DUPLICATE = insert-time unique index `payment_submissions_reference_key` (case-insensitive) and `record_manual_payment` outcome `duplicate`; no verifier decision sets `duplicate`, and `partially_verified` exists in the CHECK but nothing writes it.
- Confirm-payment door works for an authenticated admin (see section 4 item 1).
- GST handling: non-GST -> tax 0, GST -> 1800 bp (invoice_items), no mode -> refused; rate hard-coded 18%; default 30/20/30/20 hard-coded (`LOCKED_PAYMENT_STRUCTURE`) not an org setting.
- Approved payment exception: Phase 1's `sales.request_payment_exception` applies to the WON gate only; Phase 2 has only the owner override with free text. `structureDiffersFromQuotation` has no caller.
- Due date: milestone `due_on` is NULL in the locked structure; due date only if supplied at `issue_invoice`.

#### 2.12 UI / prototype gaps
- Not in scope for Phase 2 except: the Phase 2 panel works (HTTP 200 for /projects/<id>, /team, /scope, /requirements, /finance, /communication, /files, /milestones) and shows real state ("Phase 2 - onboarding to kickoff: context loading", "billing not confirmed - no invoice can be raised"). No screenshot-level QA was done.

#### 2.13 NEEDS_BUSINESS_CLARIFICATION
1. Should a WON deal convert to a project automatically (and who is alerted if not)?
2. What is an "exact approved payment exception" at Phase 2: reuse the Phase 1 approval, or a new approval referenced by the gate? Should an override start also be allowed to complete kickoff?
3. Segregation of duties: may the person who records a payment also verify it? May the (human) Finance role verify?
4. Is the PM an AI agent (registry) or a human (roster only accepts human users)? Exactly one PM per project?
5. Client credential policy: in-product encrypted per-project collection or an external password manager?
6. Which onboarding items are REQUIRED (ADM-108) and what is the follow-up cadence/channel for unanswered requests (ADM-109)?
7. Scope categories: is "future" required in addition to included/excluded/optional?
8. Should the locked 30/20/30/20 structure override the payment schedule the client accepted in the quotation (ADM-105), and should the difference be shown?

#### 2.14 Doc-vs-code conflicts
- `src/modules/finance/service.ts` comment and `src/lib/events/catalog.ts:117-124` say `project.billing_mode_confirmed` fires "once the profile is complete"; run shows it fires at confirm with no details.
- `phase-two-panel.tsx:27,140` says there is no channel to send a kickoff; `whatsapp-send-service.ts` sends invoices over the governed channel.
- Test comments (`the-first-invoice.test.ts`) describe M1 as `position: 0` for the pure helper, while the handler reads position 1.
- `phase_two` table comment lists an 11-state ladder; code reaches two.
- Phase 2 handler comment says it contacts nobody (true) while docs/Master Flow describe a PM that asks the client (not built).

#### 2.15 Stale or incorrect claims in the 2026-09-28 audit (re-checked on current main)
| claim (2026-09-28) | status now | evidence |
|---|---|---|
| 2.7 M1/M2 generators read wrong row; fix only in PR #530 | STILL TRUE for M1 and M2; #530 not on main | reproduced, finding 1; git log shows no fix |
| 2.10 `finance.new_receipt_reference()` granted to service_role only, so every admin Confirm Payment fails | FALSE now | migration 20260929120000 grants authenticated; psql `has_function_privilege('authenticated', ...)` = true; ops_admin verify_payment -> verified + receipt |
| 2.10 NEEDS_MORE_INFO and PARTIAL do not exist at all | FALSE | evidence_requested door; partially_paid ledger state (run) |
| 2.10 DUPLICATE only an insert-time constraint error | TRUE | unique index 23505; no decision sets it |
| 2.8 MISSING, nothing pushes invoice to client | PARTLY FALSE | manual WhatsApp/email send with history and overdue reminders exist (20260929160000, 20260930100000); still no auto send, channels unconfigured |
| 2.13 MISSING, no PM column/table | FALSE for a human roster | `projects.project_members` + `add_project_member` doors + default assignees (20261009*); still no primary-owner semantics |
| 2.14 MISSING, no specialist agent assignment | FALSE | `ai.agent_project_assignments` + owner UI + runner enforcement (20260929/20260930); default open, not an onboarding step, 0 rows |
| 2.17 UNKNOWN (vault maybe wired) | RESOLVED: not wired | vault is global agency slots only |
| project_manager disabled / tools:[] | FALSE | enabled=true, 6 tools (registry.ts:403-420); but no onboarding workflow |
| 2.18 COMPLETE | OVERSTATED | breakdown no-ops before project exists |
| 2.15 COMPLETE | OVERSTATED | card + state machine only; no creation, no participant authorisation |
| 2.1/2.2 no active dedup, no caller turns toAsk into a client question | STILL TRUE | convertToProject path; rendered text is copy-only |
| 2.11 may not honour an approved exception | CONFIRMED: it does not | pre_kickoff has no override |
| 2.22 MISSING | STILL TRUE | pg_proc listing |
| 2.23 sending blocked by BLK-003/007 | PARTLY: also a missing wire | see 2.10 |

### 3. Cited tests: classification and results
All run this session with `node --conditions=react-server --import ./tests/_alias.mjs --experimental-test-module-mocks --test tests/<file>`; all passed (counts in the rows). Behavioral (call code): known-missing-conflicting, the-handoff-has-a-face, milestone-invoicing, the-payment-structure-is-locked, the-timeline-is-a-promise-not-a-formula, the-vault-the-owner-asked-for; behavioral with mocks plus static: onboarding, payment-verified, project-start, payment-plan-atomic, whatsapp-groups, group-ingest; pure helpers plus static: the-first-invoice, billing-mode-is-confirmed-not-assumed, an-invoice-is-chased-on-whatsapp, finance-w1-presentation, an-agent-is-held-to-its-permissions; static-regex only: phase-two-begins-where-phase-one-ends, agent-handoffs, returning-client, a-returning-client-is-remembered, onboarding-baseline, payment-verification, a-claim-is-not-a-payment, a-payment-that-does-not-match, a-payment-gets-its-own-receipt, an-invoice-remembers-how-it-was-billed, no-ai-route-verifies-payment, the-kickoff-gate, the-kickoff-has-a-surface, scope-baseline, a-plan-that-validates-itself, the-plan-has-no-way-in, phase-three-begins-where-phase-two-ends, the-group-is-a-manual-action, the-admin-can-do-the-group-step, the-project-groups-name, an-asset-has-a-state. None of the static tests proves behavior and none covers the M1 position read.

### 4. Direct answers to the focus questions
1. **Does the admin "confirm payment" door work for an authenticated admin?** Yes. As ops_admin (SET ROLE authenticated + JWT claims): issue -> record_manual_payment (invoice partially_paid, verified_minor 0) -> `finance.verify_payment` -> `verified`, invoice `paid`, receipt `RCPT-...`, next milestone id returned, idempotent on repeat. Finance role and member get `not_found` (RLS) and move nothing. Grant history: `20260928130000` granted `new_receipt_reference` to service_role only; `20260929120000` added authenticated. The real browser click was not driven.
2. **Which row does the M1 generator read?** `position = 1`, which is the 20% milestone; M1 is position 0. Amount is therefore 20%, not 30%. GST mode is handled correctly (non-GST tax 0, GST 1800 bp, none -> refused).
3. **Sales handoff -> onboarding -> project chain:** real and proven by db:verify:handoff (56 checks) up to `projects.phase_two`; project creation is a manual click.
4. **Start gate:** unmet readiness blocks `start_project` and `record_kickoff`; exception = owner override (free text), which does not carry through the kickoff gate.
5. **PM / agent assignment:** human PM roster doors exist and are audited; agent-project assignment table exists and is runner-enforced but default-open; neither is part of onboarding.
6. **WhatsApp group:** card + state machine proven (db:verify:groups 45 checks, own run); real group creation impossible by provider limit.
7. **Credentials:** no secure client path.
8. **Kickoff:** gate/state/events proven; package missing; sending manual.

### 5. Could not verify, and why
- Real WhatsApp/email delivery, AI provider output (PM/Finance agents), real browser clicks and a PostgREST HTTP call for verify_payment (role-switched SQL used instead; db:verify:finance-w1/paymentverify do use the Data API).
- db:verify:billing and db:verify:unlock (fixture fails on the dirty local DB with a tenancy error), so the repo's own M1 verifier could not be used either way.
- Runner refusal for an unassigned agent (needs a model job); client conversion dedupe (needs a UI session).
- Production data: whether any real invoices were already billed at 20% is unknown (no production access).
- Probe residue (left, not deleted, per rules): committed fixtures named `zztest-p2-m1 ...`, `zztest-p2-chain`, `zztest-p2-noprofile` (client accounts, projects, 3 draft invoices INV-2026-0003..0005, one billing profile set) in the local DB.




<!-- Phase 3 -->
## Business Phase 3 audit (steps 3.1-3.15 + 3.GATE) - UI theme / colour / screen direction

Repo: /home/user/AgencyOs, current `main` (HEAD 23d8665). Audit date 2026-10-01. Mode A: audit only, nothing outside docs/audit-parts/ changed (the one DB experiment was a rolled-back transaction). Rows: `P3.json` (16 rows, one per step + 3.GATE); `P3.rows.jsonl` is the same data one row per line.

### A. Table

| step_id | step | implementation | verification | test | production | blocker / key note |
|---|---|---|---|---|---|---|
| 3.1 | UI input package (scope, requirements, platform, roles, flows, brand assets, references, constraints, accessibility, devices, timeline; missing info = BLOCKER) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Missing-input BLOCKER is not implemented: nothing ever sets phase_three.state='blocked_requirement' (grep: zero writers). A project with no brand assets/platform/roles proceeds straight to theme generation using only the screen list. The agent's prompt says 'd |
| 3.2 | Screen inventory (screen id, name, role, purpose, requirements, entry, exit, data, actions) | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Real model (ui.inventory) never run locally: no AI provider configured. Inventory quality with a real model is untested. |
| 3.3 | Screen content definition (what each screen must contain before UI) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Nothing enforces content before lock: finalize_screen_baseline checks only scope coverage, so a baseline can be finalized and used as Phase 3/4 input with screens that have no contents. Live DB demonstrates this (finalized baseline, zero content). |
| 3.4 | User flow map (primary, alternate, edge cases, permissions, navigation, success, failure) | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY | No user flow map exists anywhere. The only flow-like data is free-text entry_point/exit_action/dependencies per screen, which is optional and unchecked (live DB: all 18 screens have NULL there). |
| 3.5 | UI/UX direction analysis (industry, audience, platform, brand, personality, references) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | UI/UX direction analysis is not a distinct step and has no stored brief: industry, audience, platform, brand personality and references never reach the model or any record (only screen names/roles/purposes do). |
| 3.6 | Theme options (2-3 genuinely useful directions, all with the SAME functional scope) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | The agent path (design.directions) is wired (catalog.ts:268 -> job kind -> DESIGN_DIRECTIONS) but never executed against a model: AI_PROVIDER_NOT_CONFIGURED locally. Directions are generated without a brand/audience brief (see 3.1, 3.5). |
| 3.7 | Color options (2-3 combinations tied to directions; accessibility/contrast checked) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Agent writes exactly one palette per direction (p_option_index:1). 2026-09-28 claim 'no code path (AI or manual) creates a 2nd/3rd alternative' is OUTDATED: a manual door (record_color_variant + form in direction-panels.tsx) now exists, but no minimum is enfor |
| 3.8 | Design tokens preview (colors, typography, spacing, radius, shadow, icons, buttons, inputs, cards, navigation per direction) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Lock can complete without a finalized token set (locked_not_ready): see 3.15 dead-end. |
| 3.9 | Internal design review (UI QA/PM: scope mapping, screen completeness, consistency, brand fit, practicality, accessibility direction) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | The review is a binary verdict + free text: no structured record of the six named dimensions (scope mapping, screen completeness, consistency, brand fit, practicality, accessibility); representative_coverage() is an advisory read (only caller src/modules/proje |
| 3.10 | Admin review (exact options/version; APPROVE_FOR_CLIENT / REQUEST_CHANGE / REJECT) | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | No reject decision; no way to retire a direction short of leaving it unshared. Decision is on a private table, not the central approvals inbox (approvals.approval_requests has no design subject_type per docs/phase3 traceability). |
| 3.11 | Client presentation (PM presents; UI agent does not overwhelm the client) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | No client-facing presentation surface and no automated send: a WhatsApp message is not a structured state change here, so the PM must send by hand and paste an evidence reference. Share role check is delivery-role capability, not PM-only; a share of a single o |
| 3.12 | Client feedback classification (visual preference, color, layout direction, clarification, new scope, requirement correction; new functionality does not silently enter UI scope) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Feedback is classified by the person recording it; a mis-classified scope request as design_change_request is accepted (no content check) and enters a revision round. client_design_decisions.evidence_ref is optional and the client's identity is only 'recorded_ |
| 3.13 | Revision (next design-direction version; preserve old options/history) | BROKEN | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | The revision loop cannot complete: a client change request becomes a counted, open round and then nothing produces V2. After the limit is hit the phase is stopped with no door to resume (no function leaves revision_limit_escalation / scope_escalation except by |
| 3.14 | Client selection (exact theme, color, direction, version, client identity, timestamp/evidence) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Evidence is optional: a final_confirmed 'client yes' can be recorded by any can_write role (owner, ops_admin, delivery_lead, member) with only typed words and no evidence reference (live row has evidence_ref NULL). The client identity is not recorded (only rec |
| 3.15 | Final UI direction lock (CLIENT_APPROVED_UI_DIRECTION or equivalent; becomes Phase 4 input) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Phase 4 consumption is real in code (start_phase_four reads the ready handoff row; orchestrator + ui_designer subscribers exist) but never exercised end-to-end live: the ready path is unverified and the live handoff is not ready, so no phase_four row exists. T |
| 3.GATE | Phase 3 exit gate (screen inventory; screen contents; user flows; theme; color; design-system direction; admin review; client selection; exact version; audit) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Gate criteria status: screen inventory PARTIAL/OK; screen contents NOT enforced; user flows MISSING; theme PARTIAL; colour PARTIAL (1 palette/direction, no computed contrast); design-system direction PARTIAL (tokens manual, optional); admin review PARTIAL (no  |

Counts: PARTIAL 13, MISSING 1 (3.4), BROKEN 1 (3.13), COMPLETE 1 (3.2); 0 mocked. Verification: 15 VERIFIED, 1 NOT_VERIFIED (3.GATE). Production readiness: all 16 NOT_PRODUCTION_READY.

Tests run: `node --test` over 15 Phase-3 test files = 347 pass, all [static-regex] (read SQL/TS text; a few import the event catalog or a schema). Live [live-db]: `flock /tmp/verify.lock npm run -s db:verify:phase3` exit 0 (31 checks); `db:verify:w4` exit 0; `db:verify:dispatch` exit 1 (2 failures in customer-success check-in dispatch, outside this slice; the ui_designer dispatch checks pass). Real AI provider and WhatsApp: not available (Anthropic key rejected locally), so no model-backed or client-channel behaviour was observed.

### B. FINDINGS

#### Critical blockers
1. **The design-revision loop cannot deliver a next version (3.13).** `project.design_revision_opened` has no subscriber (src/lib/events/catalog.ts has no entry; only the type insert and emit in supabase/migrations/20260919160000_the_limit_is_a_stop.sql:247,438). Beyond the missing subscriber, nothing writes `theme_options.revision_of/version/origin` or `design_revisions.to_theme_option_id`/status (grep over migrations, src, app). `design.directions` refuses to re-run (workflows.ts ~2255, context version is not revision-aware). Rolled-back psql txn as service_role: `record_theme_option(...,1,...)` -> already_recorded; index 3 -> recorded but version 1 / origin initial / revision_of NULL; index 4 -> limit_reached. Live rows: 2 design_revisions rounds status open, to_theme_option_id NULL.
2. **A lock that is "not ready" is a permanent dead end (3.15).** `freeze_phase_three_handoff` raises on any update, `lock_phase_three_direction` answers already_locked on a second call, and it is the only function that inserts a handoff (psql pg_proc scan). Live: handoff c7ac8bd6 phase_four_ready=false, projects.phase_four has 0 rows.
3. **Missing-input BLOCKER does not exist (3.1).** Nothing writes `phase_three.state='blocked_requirement'` (zero writers). The designer sees only the screen list.

#### Major missing flows
- 3.4 User flow map: absent (no table, route, agent output). Only optional free-text entry_point/exit_action/dependencies per screen (all NULL for the 18 live screens).
- 3.5 Direction brief (industry/audience/platform/brand/personality/references): absent; `projects.brand_rules` is never read by any workflow.
- 3.8 Tokens are manual-only and not part of what the client is shown (share snapshot has primary hex only).
- 3.10 No REJECT decision (admin_design_decisions CHECK: confirm|edit).
- Resume from `scope_escalation` / `revision_limit_escalation`: no function leaves those states (pg_proc scan); lock returns 'blocked'. Phase-4 escalations have a read-only list at /projects/escalations; Phase 3 has none.

#### Broken flows
- 3.13 (above). Also Admin edit and internal changes_required never open a design_revisions row (UI form hardcodes origin client_revision, design-forms.tsx:377), so the edit path has no producer either.

#### Mock-only flows
- None mocked as such, but the agent paths (`ui.inventory`, `design.directions`) have only ever executed against a failing provider: ai.agent_runs ui_designer = 33 runs, all failed (32 key rejected, 1 no provider), all ui.inventory; **zero** design.directions runs.

#### Untested flows
- design.directions end to end (no fake-provider test); the ready lock -> `project.phase_four_ready` -> start_phase_four path (scripts/verify-phase-three.mjs header item 12 says it is covered, the script implements only the not-ready lock: lines 495-575); record_theme_direction / record_color_variant (new, grep over tests/ and scripts/ = none); token set record/finalize; handlePhaseThreeReady event->door hop (verifier inserts the phase_three row directly, ~line 212).

#### Security risks
- `record_client_design_decision` and `lock_phase_three_direction` use `core.can_write()` = owner, ops_admin, delivery_lead, **member**. A member can type the client's "yes" and lock the direction; evidence_ref is optional (live final_confirmed row has evidence_ref NULL). No client identity field.
- `record_design_share` is delivery-role (can_manage_delivery), not PM-only; accepts a single option.
- Table grants to service_role allow in-place UPDATE of theme_options, design_reviews, admin_design_decisions (only org-id freeze triggers); the doors themselves are SECURITY DEFINER with forced RLS (SELECT-only policies).

#### Data-integrity risks
- Lock succeeds with open revision rounds (live: Calm locked with 2 open rounds, still v1).
- Finalize baseline needs only scope coverage: live finalized baseline has 2 screens with no purpose/sections/entry/exit/actions/data (3.3).
- Colour contrast is free text; never computed (no luminance code in repo).
- 3.7: only 1 palette per direction by default; locked direction in live DB has one palette.

#### Agent gaps
- UI Designer exists and is wired for inventory (ScopeFrozen -> job; db:verify:dispatch passes the dispatch checks), directions (`project.screen_list_finalized` -> `ui_designer:designDirections` -> job design.directions, catalog.ts:268,595) and Phase-4 draft. Registry tools (projects.readScope, memory.recall, projects.addDeliverable) are not used by these workflows; prompts are inline constants (workflows.ts), not versioned prompt files.
- The Phase-4 draft prompt says it receives "the approved theme direction and design tokens" (workflows.ts:1063) but the code passes only screens + tokens; the locked palette and theme summary (`payload.colors`, `payload.theme`) are never given to the model.
- UI/Design QA agent plays no role in Phase 3 (internal reviewer is a named human).
- No agent classifies client feedback.

#### Admin gaps
- No admin surface to resume a stopped Phase 3; no Phase-3 entry in the central approvals inbox (private tables).

#### WhatsApp gaps
- Nothing is sent to the client in Phase 3. `record_design_share` only logs that a person already sent it (evidence_ref required). No portal design page (app/(client)/portal/[projectId]/page.tsx has no design/theme content). Event `project.design_options_shared` has no subscriber.

#### Finance gaps
- None in this slice (Phase 3 has no payment gate).

#### UI / prototype gaps
- No client-facing preview; Figma is manual (`link_theme_figma`), by design (CASE C in docs/phase3), and a lock without a Figma node is not Phase-4 ready.

#### NEEDS_BUSINESS_CLARIFICATION
- 3.7: "2-3 colour combinations tied to directions" = 2-3 palettes within each direction, or one per direction (current default)?
- 3.9: should a QA agent review Phase 3 directions, or is a named human reviewer the intended design?
- 3.10: is REJECT required, or is "edit" the intended only negative path?
- Whether a share must contain 2-3 options (currently >= 1).

#### Doc-vs-code conflicts
- scripts/verify-phase-three.mjs header (lines 12 and 35) promises a "locks ready" step; body has none.
- docs/phase3/AGENCYOS_PHASE3_TRACEABILITY.md marks Phase 3 requirements EXISTS where this audit finds: no input-package gate, no flow map, revision loop without producer, colours not forwarded to Phase 4.
- Prompt in workflows.ts:1063 claims the model receives the approved theme direction; code does not pass it.
- `clarification_required` decisions emit `project.client_design_change_requested` (record_client_design_decision CASE else-branch).

#### Stale / incorrect claims in the 2026-09-28 audit (docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json, aa9d59a)
- 3.3 "BROKEN: nothing writes required_sections/dependencies except SQL" - OUTDATED: a form and door now write them (screen-forms.tsx:82,91 -> screen-actions.ts:43 -> add_screen). Real gap now: finalize does not enforce content.
- 3.7 "no code path (AI or manual) creates a 2nd/3rd palette" - OUTDATED: `record_color_variant` + form exist (migration 20261001130000). Still untested; no minimum; contrast not computed.
- 3.13 "BROKEN, zero subscribers" - CONFIRMED on current main and understated: no door can write the next version at all.
- 3.1, 3.4, 3.5, 3.9, 3.11 - CONFIRMED.
- 3.2, 3.6, 3.8, 3.10, 3.12, 3.14, 3.15 "COMPLETE / NOT_VERIFIED" - too green: 3.6 agent never executed, 3.8 tokens manual/unshown, 3.10 no reject, 3.12 manual classification, 3.14 weak evidence/identity, 3.15 dead-end + colours not forwarded. Only 3.2 stays COMPLETE (door path live-verified).
- New since 2026-09-28 (PR #535 / 6a9f995 / 34d5e73): manual theme/colour doors, design review comment thread, screen QA/approval gate (verified by db:verify:w4), design activity feed, scope-escalation handler (G-310, present earlier).



<!-- Phase 4 -->
## Business Phase 4 audit (steps 4.1-4.27 + 4.GATE)

Rows written: 28/28

| step | name | impl | verif | test | prod | blocker / key note |
|---|---|---|---|---|---|---|
| 4.1 | Load locked baseline | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | none for the load itself; a handoff with no Figma node or no token set stays phase_four_ready=false and Phase 4 never starts (correct, honest) |
| 4.2 | Figma-first rule (Figma / approved design artifact is source of truth) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | EXTERNAL/OWNER: real Figma production is manual (MANUAL_FIGMA_REQUIRED); no Figma write capability exists by design |
| 4.3 | Design system (tokens, typography, spacing, components, states) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Design system = 12 descriptive token fields (mostly free-text style labels like "rounded") + colour palette roles + brand rules; no component library (inputs, forms, tables, modals, feedback states) is modelled. The UI Designer proposes keyComponents as free s |
| 4.4 | Full screen design (every scoped screen) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | EXTERNAL: AI provider credentials not configured here; real design output unverified |
| 4.5 | Screen states (default/hover/focus/disabled/loading/empty/error/success/permission/offline/overflow) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Only 5 of the 12 required states can be expressed (no hover/focus, pressed, disabled, validation error, permission denied, offline, overflow). QA requires only the states the Phase 3 baseline declared (4 booleans); if the baseline declared none, any draft pass |
| 4.6 | Responsive design (desktop/tablet/mobile) | PARTIAL | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY | Responsive is now MODELLED (not prose-only) on the Phase 3 screen inventory record, edited by a person; it is not part of the Phase 4 UI version spec (uiVersionDraftSchema has no device/responsive field), not checked by Design QA, Prototype QA or either approv |
| 4.7 | Accessibility (contrast, labels, focus, keyboard, touch targets, hierarchy, reduced motion) | PARTIAL | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY | Accessibility is prose-only: two free-text columns, no contrast computation, no keyboard/focus/touch-target/reduced-motion/screen-reader model, no enforcement. Migration 20260918160000 header states Phase 3 deliberately excluded it; Phase 4 never added it. |
| 4.8 | Feature coverage matrix (requirement -> feature -> screen -> interaction -> state -> prototype) | PARTIAL | VERIFIED | PASSED | NOT_PRODUCTION_READY | The scope->screen coverage block (refuse_uncovered_design) fires only on deliverables.kind=design status in_review. The Phase 4 flow submits ui_versions (own table), never a design deliverable, so this block is not on the Phase 4 path; Phase 4 coverage is base |
| 4.9 | Internal UI QA (coverage, consistency, tokens, naming, assets, visual defects) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | QA checks only (a) every baseline screen is drafted and (b) declared states addressed. No consistency, token-usage, naming/versioning, asset, placeholder, responsive or accessibility check (named scope boundary in migration 20260923120000). The DB door record_ |
| 4.10 | PM / Admin approval of exact UI version | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | MANUAL SETUP: owner must create ui_version and deliverable approval policies (not seeded) |
| 4.11 | Client UI review (PM sends exact UI version) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | The system only RECORDS that the PM shared a version (free-text evidence_ref, unverified). It sends nothing and gives the client no screen to view the UI version; the client sees the version through whatever the PM did outside AgencyOS. Revision rounds and old |
| 4.12 | Client feedback classification | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | EXTERNAL: AI provider |
| 4.13 | UI revision loop (next version, history, revision usage, repeat QA) | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | EXTERNAL: AI provider for the real redraft |
| 4.14 | Client UI approval (exact UI_VERSION_X_APPROVED with client, timestamp, evidence) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | (1) The approval is a staff-recorded free-text quote + free-text evidence_ref; no client contact/identity is stored on the decision (the table has no client_contact_id, unlike approval_requests) and evidence_ref is not validated against a real message. Owner r |
| 4.15 | Prototype task (PM hands Prototype Agent: approved UI version, scope, critical flows, platform, expectations) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | There is no PM-to-Prototype task: the build is triggered by an event and the Prototype Agent is given only the locked screen specs. No platform (web vs APK) or critical-flow list is captured before build; platform is set by a person afterwards (set_prototype_p |
| 4.16 | Prototype generation (functional WEB and/or APK per project type) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | EXTERNAL: a real functional web/APK prototype needs a human/dev toolchain; APK additionally needs Android SDK build, signing keystore/credentials and a distribution channel (Play internal track / hosted link) that the owner must supply - none exist in repo. Ma |
| 4.17 | Prototype interactions (navigation, forms, buttons, back, main journey, responsive) | PARTIAL | NOT_VERIFIED | NOT_RUN | NOT_PRODUCTION_READY | Forms/inputs are explicitly non-functional; no "back" behaviour; main journey is not defined or tested; responsive = default flex wrapping only. XSS-safe by construction (closed vocabulary, text children). |
| 4.18 | Prototype version (immutable/traceable PROTOTYPE_VX linked to UI_VERSION_X) | BROKEN | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | BUG: once a prototype has been revised, getPrototypeArtifactByUiVersion and readClientPrototypeArtifact (maybeSingle on ui_version_id) hit two rows and error, so the staff preview page and the client portal prototype page throw for any revised UI version (infe |
| 4.19 | Prototype QA (smoke, navigation, flows, routes, coverage, visual, responsive, runtime; fix and retest) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | QA is a structural diff (screens present, targets resolve, no secrets). The human path record_prototype_qa_check lets ANY can_write user record "passed" and that satisfies the send gate (prototype_send_gate falls back to deliverable_details.qa_status), so QA i |
| 4.20 | Admin approval of exact prototype build before client release | COMPLETE | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | MANUAL SETUP: deliverable approval policy |
| 4.21 | Client prototype review (exact APK / web preview / approved access) | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | EXTERNAL: client portal account provisioning and real WhatsApp delivery not tested |
| 4.22 | Client prototype feedback classification | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY | Prototype feedback is never classified: new features, backend/product scope, design-direction changes and clarifications are all handled as "change the build" and consume a prototype revision round; nothing opens a change request or asks a question. The agent  |
| 4.23 | Prototype revision (update UI if required, prototype, version, QA; preserve history) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | EXTERNAL: AI provider |
| 4.24 | Client prototype approval (exact PROTOTYPE_VERSION_X_APPROVED with client, evidence, timestamp) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | MANUAL SETUP: deliverable approval policy |
| 4.25 | M2 finance trigger (20% after UI/prototype milestone; PM confirms; Finance invoices from baseline) | BROKEN | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | CRITICAL BLOCKER: wrong milestone billed; fix (position 0-based or look up by trigger/percent key, not by position) required before any production use. Fix exists only as unmerged PR #530 per the earlier audit (not verified here). |
| 4.26 | M2 payment verification and financial gate (prototype approval != payment) | PARTIAL | VERIFIED | PARTIAL | NOT_PRODUCTION_READY | Inherited CRITICAL from 4.25 (position); NEEDS_BUSINESS_CLARIFICATION: should Phase 5 START (not only completion) require M2 verified paid? Owner round-3b answer R1-3 says completion only; the Phase 4 brief says the M2 financial gate precedes dev handoff. |
| 4.27 | Development handoff package | MISSING | VERIFIED | NOT_RUN | NOT_PRODUCTION_READY | none for other steps, but 4.GATE cannot pass without it |
| 4.GATE | Phase 4 production-ready / exit gate | PARTIAL | NOT_VERIFIED | PARTIAL | NOT_PRODUCTION_READY | CRITICAL: M2 position shift (4.25/4.26). MAJOR: no dev handoff (4.27); completion can bypass UI approval (4.24); no APK/functional prototype (4.16); prototype revision breaks preview (4.18); approval policies not seeded (4.10); AI provider + Figma + WhatsApp n |

### Method and honesty notes

Audit of `main` at 23d8665 (HEAD, 2026-10-01). No product code, migration or commit was changed. Evidence types used:
- code and migration reading with file:line;
- **rolled-back Postgres transactions** on `agencyos_local` (psql, owner JWT claims for human doors, `service_role` for system doors, always ended with ROLLBACK; `projects.phase_four` count was 0 before and after; the Phase 3 handoff freeze trigger was disabled only inside the transaction and verified re-enabled afterwards);
- read-only SELECTs and the exact PostgREST filters the finance generators issue;
- unit tests (`node --test`, Node 26) and live verifiers through `flock /tmp/verify.lock`.

Unit tests cited (all pass, all classified by reading them): `m2-and-the-gate-it-actually-needs` 16, `pm-m2-payment-verified` 7, `pm-prototype-communication` 9, `prototype-artifacts-status` 5, `qa-cannot-pass-its-own-design` 15, `the-designer-proposes` 29, `the-prototype-gets-its-revision-loop-too` 18, `the-prototype-reuses-the-deliverable` 31, `the-ui-version-designs-the-locked-screens` 24, `the-ui-version-gets-its-own-detail-page` 10, `ui-version-state-machine` 5, `ui-coverage` 7, `client-ui-review-gets-a-form` 12, `qa-gate` 15, `the-payment-structure-is-locked` 18, `a-reference-is-not-the-design` 10, `the-handoff-has-a-face` 12, `task-2-routes-to-a-designer` 16, `payment-verification` 8, `no-ai-route-verifies-payment` 6, `milestone-invoicing` 65, `a-handoff-bundle-is-a-real-zip-and-the-dashboard-filter-is-exact` 10, `a-claim-is-not-a-payment` 20, `project-manager-classify-feedback` 13, `pm-task-2-communication` 13, `the-revision-loop-client-change-asked-for` 17, `admin-edit-redrafts-too` 10, `the-escalation-reuses-the-announcement` 9. Almost all of them are **[static-regex]** (they `readFileSync` a migration/handler and regex it); the genuinely **[behavioral]** parts are the zod schema checks (`uiVersionDraftSchema`, `prototypeBuildSchema`, classification schema), `payment-structure.ts` constants, `milestone-invoicing` pure finance functions, `prototypeSendBlockers`, the ZIP writer and `orchestrator/route.ts`. None of them drives a Phase 4 door, a job or the TypeScript M2 generator against a database.

Live verifiers: `db:verify:uicoverage` PASSED; `db:verify:paymentverify` PASSED; `db:verify:gates` PASSED; `db:verify:unlock` 49 pass / 1 fail (cleanup of leftover outbox events); `db:verify:billing` 149 pass / **22 FAIL** (payment-recording / verify_payment sections; cause not isolated, looks like collisions with the dirty shared DB but unproven). There is **no live verifier or E2E for the Phase 4 doors, the AI jobs, or M2** (no `scripts/verify-*phase-four*`).

Not exercisable here: real AI provider (the UI Designer, Prototype, classification and revision workflows), Figma API token, WhatsApp/provider delivery, a real client portal login, browser rendering of the prototype pages (no prototype row exists in the local DB). Everything that depends on them is marked NOT_VERIFIED or PARTIAL ("real integration not tested").

Status counts (28 rows): PARTIAL 22 (4.1-4.12, 4.14-4.17, 4.19, 4.21, 4.23, 4.24, 4.26, 4.GATE), COMPLETE 2 (4.13 door-level revision loop, 4.20 admin prototype gate), BROKEN 2 (4.18 revised-prototype readers, 4.25 M2 position shift), MISSING 2 (4.22 prototype feedback classification, 4.27 development handoff), MOCKED 0, OUTDATED 0. verification_status VERIFIED is used only where I traced the code AND saw runtime evidence (txn/live verifier/live data); production_readiness is NOT_PRODUCTION_READY on every row.

### Critical blockers

1. **M2 (and M1/M3/M4) bill the wrong milestone on a standard installed plan.** `projects.replace_payment_plan` writes `position = ordinality - 1` (0-based) (`supabase/migrations/20260812120001_payment_plan_replaced_atomically.sql:145-160`; psql on the live function shows `(item.ordinality - 1)::int`), and `installLockedPaymentStructure` (`src/modules/projects/service.ts:440-470`) goes through it. Live rows on project `06052c2b-7b0e-4954-a309-3408f6806df2` (and two other locked-structure projects): 0 Advance 30%, 1 UI prototype 20%, 2 Development 30%, 3 Testing 20%. The generators filter 1-based: M1 `.eq('position', 1)` (`src/modules/finance/service.ts:361`), M2 `.eq('position', 2)` (`:583`), M3/M4 positions 3/4 (`:906,914`), plus `projects.m2_verified_paid` and `projects.phase_five_gate_status` (`m.position = 2`, migrations `20261009400000:47`, `20260923160000:317`) and the PM announcer (`src/modules/crm/handlers.ts:2128`). Running the same filters through PostgREST returned: position 1 -> the 20% row, 2 -> the 30% row, 3 -> the 20% row, 4 -> `[]`. So M1 would bill 20%, "M2" 30%, "M3" 20%, "M4" nothing, and the 30% Advance is never auto-invoiced. **The 2026-09-28 audit's M2 BROKEN claim is confirmed and understated** (it said only M2/M3 were off; the shift affects all four). The earlier-cited fix (PR #530) is not on main. Tests do not catch it: `the-payment-structure-is-locked.test.ts:36` pins `LOCKED_PAYMENT_STRUCTURE` positions to `[1,2,3,4]` (a TS constant the installer never writes), `pm-m2-payment-verified.test.ts:39` regexes `position !== 2`, and the live billing verifiers build their own fixtures.

### Major missing flows

- **4.27 Development handoff package: MISSING.** No table/RPC/event/page; only a Phase-3-flavoured design asset/brand ZIP exists (`src/modules/projects/design-export-queries.ts:115-190`, `design-handoff-bundle.ts`) with no UI version, prototype, approvals, scope/requirement versions, revision history or M2 status.
- **4.22 Prototype feedback classification: MISSING.** `client_feedback_classifications.decision_id` is an FK to `ui_version_client_decisions` only (psql), and no workflow classifies deliverable decisions; `ui_prototype:reviseBuild` rebuilds on any `changes_requested`.
- **No PM-to-Prototype task (4.15), no PM milestone confirmation (4.25).** M2 fires automatically on `project.phase_four_completed`.
- **No functional web/APK prototype (4.16).** See UI/prototype gaps.
- **No automated client-facing message in Phase 4.** All Phase 4 announcements go to the internal channel (`src/modules/crm/handlers.ts:1773`); sharing a UI version only records evidence text (`share_ui_version_with_client`).

### Broken flows

- **4.25 M2 position shift** (above).
- **4.18 revised prototypes break the preview pages.** After a client `changes_requested` + `revise_prototype_build`, two `prototype_artifacts` rows share one `ui_version_id` and one `artifact_url` (txn output: `v1 changes_requested|v2 draft`, count 2). `getPrototypeArtifactByUiVersion` (`src/modules/projects/queries.ts:2325-2335`) and `readClientPrototypeArtifact` (`src/modules/portal/queries.ts:171-181`) call `.eq('ui_version_id').maybeSingle()`; PostgREST answers a single-object request over several rows with 406 PGRST116 (shown by curl on a 4-row table), and `unreadable()` throws (`src/lib/result.ts:52`). The page route itself was not exercised (committing two artifact rows to the shared DB was out of bounds), so this is a strong inference, not an observed 500.
- **4.24 Phase 4 can complete without any UI approval.** Txn: with zero `ui_versions`, a manually added prototype deliverable (external link) + one human QA check + admin approve + client approval + `complete_phase_four` => `completed` and `project.phase_four_completed` emitted, which triggers M2.

### Mock-only / spec-only flows

- UI "design" (4.4) is an LLM-written paragraph + component names per screen; prototype (4.16/4.17) is an LLM-listed set of elements drawn by a generic renderer; neither is a Figma frame or a working app. The renderer's inputs are disabled ("Mock data - not a working form", `src/ui/prototype-screen-view.tsx`) and use AgencyOS' own tokens, not the client's.
- Prototype QA passes `{kind:'build', passed:true}` to the verdict function unconditionally (`src/modules/qa/handlers.ts:239`): the "build evidence" is hard-coded.

### Untested flows

No test or verifier runs: the UI/prototype AI workflows, the classification job, the Phase 4 job chain through `app/api/jobs/run`, the TypeScript M2 generator against an installed locked plan, client-portal prototype browsing, the full chain end to end. All unit tests are source-text assertions (see above). I ran the chain only as SQL doors in rolled-back transactions (works when approval policies exist).

### Security risks

- `projects.record_ui_version_qa_verdict` and `record_prototype_qa_check` accept any `can_write` user; producer != verifier is enforced only in the TypeScript handler (`verdictFor`) and a person-recorded QA "passed" satisfies `prototype_send_gate` (migration `20261006400200:259-300`).
- A single owner can approve admin review, record the client's decision and the client approval (no separation of duties); the client decision records no client contact (`ui_version_client_decisions` has no `client_contact_id`) and `evidence_ref` is unvalidated free text (approval engine does store `client_contact_id` for prototype approvals).
- Tenancy and write protection are otherwise sound: RLS enabled+forced, SELECT-only policies on `ui_versions`, `prototype_artifacts`, `phase_four`, `ui_version_client_decisions`; every door is security definer with org/role re-checks; `verify_payment_submission` requires `invoice.issue` (owner/ops_admin) and the row policies are owner/ops_admin only; `finance.new_receipt_reference()` now grants `authenticated` (fixed by `20260929120000`).

### Data risks

- `ui_versions.screens` is only frozen once `locked`; between draft and `client_approved` a privileged UPDATE succeeded in the txn (screens rewritten with status `client_review`), and a locked row could be DELETEd by a privileged role. Doors never do this and RLS has no write policy, but "exact approved version" immutability is by convention before the lock.
- `prototype_artifacts.screens` has no freeze trigger (only a status transition trigger).
- `projects.phase_four.state` is not advanced by the doors: after drafting it stays `ui_design`; after lock the txn still read `ui_design` (`ui_review`, `ui_locked`, `prototype_build` (except on revision), `prototype_review`, `prototype_locked` are declared but never written). Any dashboard or gate reading it is stale.
- `complete_phase_four` checks neither UI version nor artifact state.
- M2 invoice is created `draft` (finance.create_milestone_invoice inserts `'draft'`), while migration `20260923160000` header says generateM2Invoice "only ever reaches issued".
- A billing profile that is incomplete at Phase 4 completion fails the M2 job permanently (CONFLICT is non-INTERNAL, `finance/handlers.ts:106`), not retried when the profile is completed (manual raise remains).

### Agent gaps

- `ai.agents` locally: `ui_designer`, `ui_prototype`, `project_manager`, `quality_assurance` enabled; `orchestrator` disabled (its Phase 4 handlers are plain job handlers and run regardless). No AI provider locally, so none of the agent workflows were exercised.
- The Prototype Agent receives only the locked screen layout/components/states: no platform, critical flows, scope, tokens (4.15).
- The Designer prompt receives screens + 12 token fields but not scope items/requirement text; QA checks only screen/state coverage (4.4/4.9).
- Classification (PM agent) is advisory: the Designer redraft subscribes to the same event and runs regardless (4.12; asserted by `project-manager-classify-feedback.test.ts`).
- No dedicated "Prototype QA" capability for visual/responsive/runtime checks; no Finance-agent confirmation before M2.

### Admin gaps

- No default `ui_version` or `deliverable` approval policy is seeded; local DB has only `proposal` policies. Without them `request_ui_version_admin_review` answers `no_policy` and the flow sits at `qa_pass` silently; `submit_deliverable` answers `no_policy` for the prototype client step.
- `sync_ui_version_decision` is invoked from the approvals page action, not by an event.
- No Admin view of PM-to-prototype task, platform expectations, or development handoff.

### WhatsApp gaps

- No Phase 4 message reaches the client automatically; all announcements are internal (`announceToInternalChannel`). Client "yes" is recorded by staff as free text (`client_words`, `evidence_ref`, optional `conversation_id`) - it is evidence, not a verified structured message link.
- Real WhatsApp delivery not tested locally.

### Finance gaps

- M2 trigger (position shift, no PM confirm) and gate (position 2 read, only completes Phase 5, does not block start) - rows 4.25/4.26.
- Prototype approval does not mark payment (good, verified); payment verification is owner/ops_admin only; "authorised Finance" role is read-only by policy.
- Receipt-reference grant defect from the earlier audit is fixed; the position defect is not.

### UI / prototype gaps

- Figma-first is enforced only at the Phase 3 handoff (needs a Figma node); `ui_versions` carries no Figma/design-artifact reference (4.2). Real Figma production remains manual (`MANUAL_FIGMA_REQUIRED` boundary in `src/modules/projects/schema.ts:740-750`).
- States: 5 of 12 expressible; QA requires only what the baseline declared (local baseline declares none). Responsive: modelled (`screens.device_targets`, `responsive_coverage`) but human-edited, empty in all 20 local screens, not in the UI version spec, not checked by any gate. Accessibility: two free-text columns only, no computation or enforcement (the UI literally says "not a WCAG claim").
- Feature coverage: scope->screen coverage is a DB trigger only on `deliverables.kind='design'` (live verifier passes) and is not on the ui_version path; no requirement->feature->screen->interaction->state->prototype chain view; no "interaction" entity.
- APK: no build, signing, hosting or distribution code. External blockers the owner must supply: Android toolchain/CI, signing keystore and credentials, a distribution channel, and (for web) hosting. A human can attach an externally built `.apk/.ipa/.zip` (<=50MB) or link to a prototype deliverable; that path has no UI-version link and still triggers Phase 4 completion/M2 when approved.

### NEEDS_BUSINESS_CLARIFICATION

1. Should a PM explicitly confirm the Phase 4 operational milestone before the M2 invoice is created (brief says yes; code fires on prototype approval)? (4.25)
2. Should Phase 5 start (not only completion) be blocked until M2 is verified paid? Owner round-3b answer R1-3 gates completion only; the Phase 4 brief implies the gate precedes development handoff. (4.26/4.27)
3. What counts as the "functional prototype" - interactive wireframe (as built) or a real web/APK app; who supplies build/signing infrastructure? (4.16)
4. Is a manually uploaded prototype deliverable an acceptable alternative route to complete Phase 4 without a locked UI version? (4.24)
5. Should the client's formal approval be a client-authenticated action rather than a staff-recorded quote? (4.14/4.24)

### Doc-vs-code conflicts

- `src/modules/projects/payment-structure.ts:55-90` and `the-payment-structure-is-locked.test.ts` say positions 1..4; the DB installer writes 0..3 (see critical blocker).
- Migration `20260923160000` header: M2 "only ever reaches `issued`"; code creates `draft`.
- `docs/phase-4-gap-analysis.md` (2026-09-26) says nothing in Phase 4 is built, and `docs/phase-4-implementation-traceability.md` rows mark things "Implemented ... PARTIAL"; the code now has the full door chain (UI draft -> QA -> admin -> client -> lock -> prototype -> QA -> admin -> client -> complete -> M2), so the gap analysis is stale; the traceability doc's "live-verified end-to-end on scratch Postgres" has no corresponding checked-in verifier.
- `20260923110000` comments say "one draft per workspace, revision loop not built"; superseded by `20260924100000` (unique (phase_four_id, version)).
- `20260923140000` header says the revision loop is "not built here"; it is built in later migrations.
- `phase_four.state` vocabulary (ui_review, ui_locked, prototype_review, prototype_locked) is documented as the macro-stage machine but is never written (4.14).

### Stale / incorrect claims in the 2026-09-28 audit (docs/AGENCYOS_BUSINESS_PHASE_1_4_AUDIT.json)

| step | prior claim | current finding |
|---|---|---|
| 4.1 | COMPLETE | PARTIAL: direction inherited, but no scope/requirement version refs |
| 4.6 | MISSING | PARTIAL: modelled on `projects.screens` (SCR-034/035), unenforced and unused |
| 4.7 | MISSING | still effectively missing (prose columns only) |
| 4.11 | COMPLETE | PARTIAL: records "shared" with free-text evidence; sends nothing, no client view |
| 4.12 | COMPLETE | PARTIAL: classifier is advisory, redraft runs regardless |
| 4.13 | COMPLETE | COMPLETE at door level (re-verified by txn); AI redraft untested |
| 4.14 | COMPLETE | PARTIAL: no client identity, free-text evidence, screens not frozen before lock |
| 4.15 | COMPLETE | PARTIAL: event trigger only, no task content |
| 4.18 | COMPLETE ("one of the strongest-evidenced") | BROKEN for revised builds (preview readers hit multiple rows) |
| 4.21 | COMPLETE (web only) | PARTIAL, NOT_VERIFIED end to end |
| 4.22 | PARTIAL | MISSING |
| 4.23 | COMPLETE | PARTIAL (breaks preview, no UI path) |
| 4.25 | BROKEN only M2 off by one (M3 row) | BROKEN and worse: whole ladder shifted, M1 also affected; fix #530 not on main |
| 4.26 | BROKEN (gate position + receipt-reference grant) | grant fixed; position bug remains; gate only guards Phase 5 completion |
| 4.27 | MISSING | MISSING (confirmed) |
| 4.16 | PARTIAL (APK missing) | confirmed: wireframe only, APK missing, external blockers listed |

