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

