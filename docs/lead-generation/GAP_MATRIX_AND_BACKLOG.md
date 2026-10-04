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
| 5 | Scheduler + Quotation Master structured handoffs (agent-callable, return to channel owner) | 2, 3 | not started |
| 6 | Email engine: prospect discovery → research → qualification → drafting → nurture → meeting/quote → handoff; follow-up engine state checks | 2–5 | not started |
| 7 | Social: audit, strategy (3/6/9 mo), content versioning + exact-version approval + publish idempotency, analytics, then prospecting/outreach | 4, 5 | not started |
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
