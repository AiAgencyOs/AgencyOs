# P1A audit - Business Phase 1 (Lead-to-Close), steps 1.1 - 1.21

Mode A (audit only). Repo `/home/user/AgencyOs` current main (HEAD 23d8665). Date of audit run: 2026-10-01. Local DB `agencyos_local` (read-only SELECTs), dev server http://127.0.0.1:3000 (owner session), unit tests under Node 26, live verifiers through `flock /tmp/verify.lock`.

**Rows: 21.** Implementation status: MISSING 1, PARTIAL 20. Verification: every row NOT_VERIFIED except 1.3 (VERIFIED as MISSING - code path and DB traced). Production readiness: every row NOT_PRODUCTION_READY.

**Headline.** The WhatsApp ingest, consent/opt-out chokepoint, requirement versioning, quotation arithmetic/approval/dispatch records and follow-up contract are real, enforced in SQL and live-verified. The agent behaviour on top (first response, language, intent, qualification, objections, quote drafting, follow-up wording) is wired to the job runner but has **never produced a successful run in this environment** (1,475 `ai.agent_runs`, 0 succeeded) and the end-to-end verifiers fail here for an environmental reason (shared dev server points at the real Anthropic endpoint, not the verifier stub). Spec features with no implementation: non-WhatsApp lead sources, identity resolution with five outcomes, lead routing, intent-based routing, structured client confirmation, commercial-strategy record, policy verdict object, adaptive follow-up. Row data: `P1A.json` (21 objects, spec schema).

## TABLE

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

## AGENT HIERARCHY INVENTORY (whole project, 15 capabilities)

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

## UNIT TESTS RUN (Node 26, `--conditions=react-server`, via `tests/_alias.mjs`) AND CLASSIFICATION

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

## LIVE VERIFIERS RUN (each through `flock /tmp/verify.lock npm run -s db:verify:<name>`, target 127.0.0.1:54321)

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

### Late verifier results
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

