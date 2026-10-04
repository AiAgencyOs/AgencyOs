# Lead Generation & Acquisition — gap matrix and build backlog

Source specification: `lead gen/AgencyOS_Lead_Generation_Acquisition_Implementation_Specification.pdf`
(five engines: Meta/Facebook Ads, Email, Social, Google Ads + landing page, B2B).
Audit date: 2026-10-04, against `origin/main` at `72c23803` (#564). Three read-only audits fed this; each
verdict cites the file or migration it rests on. Status words: **COMPLETE / PARTIAL / MISSING** (nothing was
found BROKEN or MOCKED in the acquisition paths; the existing outreach code is real and tested against a fake
mailbox and a real database).

**This document is a plan and a record of evidence, not a claim that the module works.** Section 4 says what
has been built and verified so far; everything else is a gap.

## 1. Existing foundations (reuse, do not rebuild)

| Need | Status | Evidence |
|---|---|---|
| Contacts, leads, opportunities, conversations, messages | COMPLETE | `crm.contacts/leads/conversations/conversation_messages`, `sales.opportunities` (20260807120004, 20260807120005, 20260808120001) |
| Lead statuses NURTURE, DISQUALIFIED | PARTIAL | `leads_status_check` (20260904170000); nurture needs a reason + date. **No lead-level LOST**; `converted` is the lead-level WON; WON/LOST live on `sales.opportunities.stage` |
| Attribution | PARTIAL | first-touch Click-to-WhatsApp ad only (`campaign_source_*`, 20260904180000). **No last-touch, no touch history, no UTM** |
| Phone normalisation + dedupe | COMPLETE | `src/lib/import/phone.ts`, `crm.ingest_whatsapp_message`, `crm.commit_import_record` |
| Email / social / company / domain identity resolution | MISSING | only the manual SCR-014 check and import "probable" classes |
| `DUPLICATE_REVIEW` queue | MISSING | `crm.merge_leads` is manual, same-contact only |
| Primary conversation owner | MISSING | `leads.assigned_to` / `opportunities.owner_id` are people, not agents-per-channel |
| Qualification scoring | PARTIAL | `src/modules/crm/lead-score.ts` is deterministic and stored with reasons, but **weights are code constants** (only budget bands are Admin-owned) |
| Scheduler | PARTIAL | human-driven (`src/lib/scheduler`, `crm.meetings`); no agent-callable service, no structured handoff in |
| Quotation Master | PARTIAL | versioned, approval-bound, immutable after submit (`sales.proposals`, 20260813120019, 20260815260000); callable only by the sales agent (`sales.draftProposal`). Registry `moneyAuthority` has no `decides` (ADM-22): a "Quotation Master that creates quotations from configured pricing" must stay inside that rule |
| WhatsApp inbound/outbound/consent/window | COMPLETE | `app/api/webhooks/whatsapp`, `crm.ingest_whatsapp_message`, `crm.send_outbound_message` |
| Tracked WhatsApp handoff (opaque token) | MISSING | nothing but the unsubscribe token pattern |
| WON → Phase 2 | COMPLETE, idempotent | `sales.hand_off_on_a_win` → `sales.record_won_handoff`, unique `handoffs_won_handoff_key`, packet `sales.won_handoff_packet` |
| Web-form / Facebook Lead Ads inbound | MISSING | only `app/api/webhooks/whatsapp` exists |
| Inbound email | COMPLETE for replies/bounces/unsubscribes | #564, `src/lib/email/imap.ts`, `crm.ingest_inbound_email` |
| Email outreach (governed) | PARTIAL | `crm.outreach_*`, `email_*` (20261012300000/310000); **no agent**: no discovery, research, personalisation, nurture, meeting/quote handoff |
| WhatsApp reactivation + governed campaign | COMPLETE | 20260815440000, 20260930140000 |

## 2. Governance foundations the engines must plug into

There is **no single policy decision API** (`AUTO_APPROVE/ADMIN_APPROVAL_REQUIRED/BLOCK/ESCALATE`). Governance is
five separate mechanisms; a lead-gen module composes them:

| Mechanism | Where | Note |
|---|---|---|
| Approvals | `approvals.*`, `src/modules/approvals` | states pending/approved/rejected/changes_requested/expired/cancelled; **no EXECUTED/VERIFIED**, no content hash (binding = row id + immutability + payload snapshot); subject types are a closed list in 5 places |
| Agent policy | `src/lib/ai/policy-decision.ts`, `autonomy.ts` | `client_facing`, `money`, `delivery_approval` work classes are "must ask" |
| Kill switches | `core.kill_switches` | was 3; **now 4** (see §4) |
| Jobs/outbox | `core.jobs`, `core.outbox_events`, `app/api/jobs/run` | one monolithic runner; handler registration is manual in `catalog.ts` + route + `workflows.ts` |
| Secrets | `src/lib/secrets`, vault | **per-deployment, not per-tenant** (no `organization_id`); `SecretVerifier` only github/whatsapp |
| RBAC | `src/lib/authz/permissions.ts` | static; SQL re-checks with `core.is_admin()` etc. |
| Audit | `core.record_audit` (SQL, reliable) vs TS `recordAudit` (best-effort) | use the SQL one for governance events |
| Integrations registry | `src/lib/admin/integrations-eval.ts` | **hard-coded list**; no data-driven registry |
| Feature flags | none | org settings default-off are the substitute |

Design decisions this implies (recorded here so they are made once):

1. **No new parallel approval system for new engines.** New governed artifacts (social content, B2B proposals,
   campaigns) go through `approvals.*` with new subject types, plus a *version-binding* column (content hash) on
   the subject row. Email outreach keeps its existing bespoke four-eyes path (it predates this and is tested);
   whether to migrate it into the Approval Center is an **owner decision**, not made here.
2. **Per-tenant provider credentials need a new tenant-scoped store.** The existing vault is per-deployment.
   Engine connectors (Meta, Google, LinkedIn, Hostinger, marketplaces) must not be built on it unchanged.
3. **A thin policy-decision function** (`crm.acquisition_decide(...)` returning the four canonical decisions) will
   compose pause + limits + approval policy, rather than inventing a fifth mechanism.
4. **Quotation Master and Scheduler stay services invoked by a structured handoff**, not autonomous pricers.

## 3. Backlog (dependency order)

| # | Slice | Depends on | Status |
|---|---|---|---|
| 1 | Admin config (target services, versioned ICP, per-channel settings), global + per-channel pause, Lead Generation shell + overview, capabilities | — | **BUILT, see §4** |
| 2 | Unified identity: normalised identity keys, `DUPLICATE_REVIEW` queue, touchpoints (first/last/multi), canonical outcome (derived), primary conversation owner | 1 | **BUILT, see §4** (contact consolidation after `confirmed_same` is NOT built) |
| 3 | Tracked WhatsApp handoff: opaque token (hash stored), expiry, replay/tenant protection, context package, ownership transfer to Sales | 2 | **BUILT** (engines that create handoffs arrive with 6-10) |
| 4 | Connector registry (tenant-scoped credentials, capability model, health, Test Connection), policy-decision function, approval subject types + content-hash binding | 1 | **BUILT** (no provider adapter exists yet) |
| 5 | Scheduler + Quotation Master structured handoffs (agent-callable, return to channel owner) | 2, 3 | **BUILT** (the Scheduler/Quotation Master LLM agents themselves are not) |
| 6 | Email engine: prospect discovery → research → qualification → drafting → nurture → meeting/quote → handoff; follow-up engine state checks | 2–5 | **PARTLY BUILT**: qualification, grounded-draft validation, reply adoption, follow-up recheck, funnel. NOT built: discovery, AI research, AI drafting (need a source and a funded model) |
| 7 | Social: audit, strategy (3/6/9 mo), content versioning + exact-version approval + publish idempotency, analytics, then prospecting/outreach | 4, 5 | **CONTENT PIPELINE BUILT** (no provider publisher exists; social prospecting/outreach NOT built) |
| 8 | Meta Ads: audit, campaign (policy/approval/budget limits), monitoring, WhatsApp attribution | 3, 4 | not started |
| 9 | Google Ads + landing-page engine + Hostinger deployment + verification | 3, 4 | not started |
| 10 | B2B: platform registry, opportunity discovery/scoring, proposals (versioned/approved), submission or `ASSISTED_ACTION_REQUIRED`, reconciliation, Clutch/GoodFirms/Fiverr workflows | 4, 5 | not started |
| 11 | Analytics + attribution read models, optimisation loops, failure dashboard | 2, 6–10 | not started |
| 12 | Independent QA, E2E per engine, security review, docs, human-dependency report | all | not started |

## 4. What has been built and verified (slice 1)

* Migration `20261015100000_lead_generation_is_configured_not_coded.sql`: `crm.target_services`,
  `crm.icp_versions` (append-only), `crm.acquisition_channels`; five Admin-only doors; the fourth kill switch
  `acquisition_paused`; `crm.acquisition_blocked` (one question every engine asks, fails closed, tenant-guarded).
* Migration `20261015110000_a_paused_channel_sends_nothing.sql`: the email send chokepoint
  `crm.claim_outreach_sends` honours the global and email-channel stops (carried forward from its live definition
  with one marked edit).
* `src/modules/acquisition/*`, `app/(internal)/lead-generation/*` (overview, five channel tabs, settings), nav module,
  capabilities `acquisition.read` / `acquisition.manage` (owner + ops_admin).
* Verified: all 419 migrations apply on a scratch Postgres 16; `scripts/verify-acquisition-foundation.sql`
  (66 checks) and `scripts/verify-acquisition-email-pause.sql` (11 checks) drive the doors as the real request
  roles; both were **red-proved** (each control removed → the verifier fails → restored → green). Wired into CI
  as `npm run db:verify:acquisition`. `npm run check` (typecheck, lint, tests, secret scan) is green apart from
  the record numbers updated in the same change.
* **Not verified:** the new pages have not been rendered in a browser against a live app in this session; the CI step
  has not run yet (CI is the first run on the Supabase image).
* **Honest limits:** only email is partly built; the other four tabs say "not built yet" in words. Pause is enforced
  by the email chokepoint only, because no other engine exists. The global stop is owner-only; per-channel pause is
  owner or ops admin.

### Slice 2 (identity layer) - built and verified

* Migration `20261015200000_one_person_one_identity_across_channels.sql`: normalisers (`norm_email/phone/domain/social`),
  `crm.identity_keys` (strong keys, one person each), `crm.duplicate_reviews`, append-only `crm.lead_touchpoints` with
  derived first/last touch (`crm.lead_attribution`), `crm.lead_conversation_owner` + append-only transfer history with
  compare-and-set `crm.transfer_conversation_owner`, derived `crm.lead_outcome`, `crm.resolve_identity` (engines' door),
  AFTER triggers keying every contact and touching every lead, and `contacts.reachable_via` (extends the Phase 1
  "reachable" rule so a LinkedIn- or marketplace-only prospect can be an identity).
* `src/modules/acquisition/identity.ts` (engine wrappers), `/lead-generation/identity` (review queue + counts).
* Verified: `scripts/verify-acquisition-identity.sql` drives the mandatory Email -> LinkedIn -> real WhatsApp ingest
  scenario (one contact, three keys, no review), uncertain-match review, first-touch survival, owner races, tenant
  isolation, audit. Red-proved six ways; it also caught one real bug and one design flaw (see the change log).
* **Not built, stated plainly:** (a) consolidating two contacts judged the same (eleven tables point at `crm.contacts`);
  (b) automatically assigning a conversation owner at lead creation - the email and social engines will do it when
  they convert a prospect (slices 6-7); (c) `lead_outcome` has no lead-level LOST of its own: it reads the opportunity;
  (d) Lead 360 / activity timeline UI (spec §126-127) - only counts and the review queue exist; (e) events
  (`LeadMatched`, `LeadDuplicateReviewRequired`) - audit rows exist, outbox events arrive with their consumers.

### Slice 3 (tracked WhatsApp handoff) - built and verified

* Migration `20261015300000_a_prospect_who_moves_to_whatsapp_stays_one_lead.sql`: `crm.channel_handoffs` (state machine,
  frozen context, one live per lead), `crm.whatsapp_handoff_settings`, and the doors `create / open / bind_handoff_from_message /
  consume / cancel / expire`. The existing ingest function is NOT re-emitted: the bind makes it continue the original lead.
* `src/modules/acquisition/handoff-code.ts` (HMAC-derived 80-bit reference), `handoff.ts` (create, sweep), `handoff-bind.ts`
  (called by ingest, never throws), public route `app/api/handoff/[code]`, settings + list/cancel on the Lead Generation screens.
* `scripts/verify-acquisition-handoff.sql`: one lead through the real ingest; replay, tamper, cross-tenant, expiry,
  cancel, closed lead, number held by another contact; privilege audit. Red-proved.
* **Not built:** consolidating the two leads a `linked_for_review` handoff leaves; any engine creating handoffs;
  the Sales agent reading the review-path context; a rate limiter on the public link.
* **Cross-cutting finding fixed in all three migrations:** platform default privileges granted anon/authenticated broad
  table rights; every acquisition table now revokes them first.

### Slice 4 (connectors, policy, exact-version approvals) - built and verified

* Migration `20261016100000_connectors_policy_and_exact_version_approval.sql`: `crm.acquisition_integrations` (lifecycle vs verification,
  guarded by a trigger), `crm.connector_credentials` (per-tenant, AAD-bound ciphertext), `crm.acquisition_policies / _usage / _decisions`,
  `crm.approval_bindings`, `crm.governed_executions`, and the doors `register / sync_adapter / store_secret / set_state /
  record_integration_check / set_acquisition_policy / acquisition_decide / bind_approval / approval_check / begin|finish|verify_governed_execution`.
* `src/lib/secrets/tenant-vault.ts`, `providers.ts` (catalogue, adapter contract, error classification, backoff), `adapters.ts`
  (EMPTY on purpose), `governance.ts` (typed wrappers an engine uses), `integrations.ts`, Connections page, policy table.
* `scripts/verify-acquisition-governance.sql`: 150 checks through the real approval engine; red-proved eleven ways.
* **Not built:** any provider adapter; scheduled health/expiry checks; the engines that call these doors.
* **Design decision recorded:** email outreach keeps its own four-eyes approval path (it predates this and is tested); moving it into
  the Approval Center remains the owner's call.

### Slice 5 (Scheduler and Quotation subtasks) - built and verified

* Migration `20261017100000_a_subtask_returns_to_the_conversation_owner.sql`: `crm.subtask_requests` (frozen request, state machine,
  idempotency, one open per kind per lead), doors `request / accept / link_proposal / cancel / fail`, AFTER triggers that carry the
  real meeting and proposal lifecycles back (reschedule follows the new row), and `_json_has_key` (no price at any depth).
* `src/modules/acquisition/subtasks.ts` (typed doors; no price field exists), a requests card on the Identity screen.
* `scripts/verify-acquisition-subtasks.sql`: driven through the real meeting doors; red-proved eleven ways.
* **Not built:** an LLM Scheduler / Quotation Master agent; calendar availability; a no-show outcome (the existing door lacks one).

### Slice 6 (the Email engine's decisions) - built and verified

* Migrations `20261018100000_the_email_engine_qualifies_adopts_and_stays_in_its_lane.sql` (weights, block list, facts, qualifications, draft validator,
  reply adoption, follow-up blockers, funnel) and `20261018110000_a_follow_up_is_rechecked_when_it_is_sent.sql` (the send chokepoint, one marked edit).
* `src/modules/acquisition/email-engine.ts` (typed doors; a missing answer is a failure), `qualification-vocabulary.ts`, funnel / weights / blocks on the Email tab.
* `scripts/verify-acquisition-email-engine.sql`: through the real chokepoint and the real inbound function; red-proved eleven ways.
* **Not built:** prospect discovery, an AI research agent, an AI drafting agent, nurture beyond lead nurture, an automatic meeting/quote request on a positive reply.
* **Human dependencies surfaced:** a funded model key (drafting, research, scoring agents) and a prospect discovery source - neither requested yet.

### Slice 7 (Social content pipeline) - built and verified

* Migration `20261019100000_social_content_is_approved_as_exactly_what_is_published.sql`: audits, versioned strategies, references, assets, items, immutable
  versions (derived hash), publications (one per version), metrics; doors for review / submit / schedule / cancel / publish / record; derived status; due-content sweep.
* `src/modules/acquisition/social.ts` (publisher worker, `runSocialPublishing` in the cron tick), `social-vocabulary.ts`, the Social tab queue and forms.
* `scripts/verify-acquisition-social.sql`: the four mandatory cases through the real approval engine; red-proved thirteen ways.
* **Not built:** a LinkedIn / Instagram / Facebook publisher (a due post alerts a person), account analytics, AI planning and writing, media generation, social prospecting and outreach.

### Slice 8 (Ad campaign engine: Meta and Google) - built and verified

* Migration `20261020100000_an_ad_campaign_launches_as_exactly_what_was_approved.sql`: campaigns, immutable versions (derived hash and derived kind of change: launch, budget increase or decrease, targeting change, creative change), provider objects, applications, metrics, provider statuses, health records; the pure plan rules (`ad_plan_problems`); doors for create / add version / check / submit / apply / pause-resume-end / confirm; the emergency stop made to reach live campaigns; spend counted once; results read from the CRM by first touch; health findings; advisory recommendations. `ad_budget_increase` and `ad_targeting_change` join the never-automatic actions (constraint, door and TypeScript).
* `src/modules/acquisition/ads.ts` (`applyAdVersion`, `runAdOperations` in the cron tick), `ad-vocabulary.ts`, the Meta and Google tab sections and forms. `AD_PROVIDERS` is empty by design: an approved launch with no connector alerts a person to apply it by hand.
* `scripts/verify-acquisition-ads.sql`: the spec's mandatory ad tests through the real approval engine and governed door; red-proved seventeen ways (two initial proofs were found GREEN - a mangle that hit the wrong occurrence, and an untested pause path - and fixed before being counted).
* **Not built:** the Meta and Google connectors (nothing is pushed to or read from a platform), pulling the platform's metrics (a worker would call `record_ad_metrics`), landing pages and Hostinger deployment (slice 9; a Google plan references a landing page version id that cannot be produced yet and is not verified to exist), creative generation, A/B testing, and the AI that plans and optimises.
* **Human dependencies surfaced:** Meta Business/ad account and OAuth, Google Ads developer token - neither requested.

### Slice 9 (Landing pages and the Google gate) - built and verified

* Migration `20261021100000_a_landing_page_is_deployed_as_exactly_what_was_approved.sql`: landing pages, immutable versions (derived hash over slug, content, WhatsApp number, public address, tracking), deployments, verifications; content rules that fail a page and never approve one (no testimonials, proof only from the agency's own active portfolio items, no urgency, claims or unsourced statistics); governed deploy; verification as a separate record of what was fetched; `record_landing_arrival`; `check_ad_version` and `begin_ad_apply` carried forward so a Google ad launches only to a VERIFIED page, read at execution time.
* `src/modules/acquisition/landing-render.ts` (deterministic, escaped, one outbound destination), `landing.ts` (`deployLandingVersion`, `verifyLandingVersion`, `runLandingOperations` in the cron tick), `landing-arrival.ts` (called by WhatsApp ingest), Google tab section and forms. `LANDING_DEPLOYER` is undefined by design: an approved page alerts a person to upload it by hand and is never shown as live.
* `scripts/verify-acquisition-landing.sql`: red-proved thirteen ways; the TypeScript is red-proved seven ways, one of which found the in-browser tag script untested (now run against a stub browser).
* **Not built:** the Hostinger deployer, DNS/SSL steps, a visual page builder, A/B testing, one-click rollback (redeploying an older version is a new governed execution), and server-side click tracking (the tag is a claim about where a visit came from, never authority).
* **Human dependencies surfaced:** a Hostinger deployment token or SSH scope and the domain/DNS for the public address - neither requested.

### Slice 10 (B2B marketplaces) - built and verified

* Migration `20261022100000_a_marketplace_rule_decides_whether_a_conversation_may_leave_it.sql`: per-marketplace rules (contact off the platform: forbidden / after award / allowed; automation: manual / assisted / automated - restrictive by default, loosened only by the owner), the Admin's thresholds, opportunities as frozen facts with an explainable fit score, immutable proposal versions (derived hash; a price only on a version a person wrote), profile versions, governed submission once, connects budget, results by marketplace; `create_channel_handoff` carried forward so a B2B handoff needs the marketplace's permission.
* `src/modules/acquisition/b2b.ts` (`sendB2bProposal`, `runB2bOperations` in the cron tick), `b2b-vocabulary.ts`, the B2B tab. `B2B_CONNECTORS` is empty by design: an approved proposal waits for a person to send it on the platform and record it.
* `scripts/verify-acquisition-b2b.sql` red-proved twenty-six ways (one proof first ran against a table the re-applied migration could not change, and was redone by dropping the constraint); TypeScript red-proved six ways. The slice-3 handoff verifier gained the rule it now needs.
* **Not built:** any marketplace connector (nothing is read from or sent to a platform), automated discovery, the AI that finds and writes proposals, creating a lead from a won client (a person links one), Clutch/GoodFirms review management.
* **Human dependencies surfaced:** marketplace accounts and, where terms permit, API access - none requested. The owner must confirm each marketplace's terms before loosening a rule.

## 5. Human dependencies (known now; asked for only when the engine reaches them)

| Provider | Needed for | When |
|---|---|---|
| Meta (Business/Ad account, WhatsApp-linked ads, OAuth) | Meta Ads engine | slice 8 |
| Google Ads (developer token, OAuth, customer ID) | Google Ads engine | slice 9 |
| Hostinger (deployment token/SSH scope) + DNS | landing pages | slice 9 |
| LinkedIn / Instagram / Facebook pages (OAuth, app review) | Social engine | slice 7 |
| Marketplace accounts (Upwork, Freelancer, PeoplePerHour, Guru, Contra, Fiverr; Clutch/GoodFirms profiles) | B2B engine | slice 10 |
| info@ mailbox keys, sender name, postal address | Email (already built) | owner steps from #556/#564 |
| A funded model key | any agent doing real work | before agent slices are run live |

No provider has been contacted and no credential has been requested or stored.
