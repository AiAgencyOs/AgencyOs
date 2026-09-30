# AgencyOS Admin Panel — Configurability Audit

**Question asked of every hardcoded value:** *could the agency owner
reasonably want to change this later without deploying new code?*

**Method (2026-09-29):** a scan of `src/modules/**` and `src/lib/**` for
named numeric/text constants (`const NAME = <number|string>`, percentages,
day/hour/minute counts, limits, model names, recipients, template text),
each one read in context and classified. The scan itself:

```
grep -rnE "(const [A-Z_]{4,} = [0-9]|GST|0\.18|MAX_[A-Z_]+ = |_DAYS = |_HOURS = |_MINUTES = |_PCT = |_LIMIT = |THRESHOLD)" src/modules src/lib --include=*.ts
```

plus every `settings->>'…'` key the migrations read, to find what is
**already** admin-managed.

## Classification

| Class | Meaning |
|---|---|
| **A** | Must remain a code constant — implementation detail with no business meaning, or a safety bound that protects the system from configuration. |
| **B** | Should be admin-configurable — a business value an owner would change. |
| **C** | Already admin-configurable — through `/settings` and the audited `core.set_organization_setting` door (or a dedicated table with its own form). |
| **D** | Security-sensitive — belongs in the deployment environment / vault, never in a form. |
| **E** | Requires a business decision before it can be made configurable. |

## Already configurable (C) — what the Settings screens govern today

Every one of these is a whitelisted key in `core.set_organization_setting`
(owner/ops_admin, per-key validation, audit row with old and new value), or
a dedicated table with the same discipline.

| Area | Setting | Where |
|---|---|---|
| Organization | agency name, timezone, quotation contact email/phone/location | General |
| Commercial | pricing model (day rate, AI day rate, multiplier min/target/max), payment terms (up to 8 milestones, must total 100%), third-party charge references, the standing approved offer, negotiation limits (max rounds, min price, max discount %, max autonomous quote) | Commercial |
| Projects | project WhatsApp group identifier, default team members, default design reviewer | Commercial / Team |
| Communication | WhatsApp phone_number_id, test recipient, approved template ↔ situation mapping, outreach limits (per contact/day, per contact/week, per org/day, unanswered-before-cooldown, cooldown days), reactivation pilot switch and per-run cap, wake-runner-on-inbound, internal announcement recipient/group, meeting reminder minutes | Communication |
| Governance | approval policies (subject type → required role, threshold), secondary roles, membership status, WON-requires-payment-evidence switch | Approvals / Team |
| AI | provider credentials (vault-encrypted, masked), routing policies, agent autonomy ceilings (DB-owned per ADM-82) | Agents › Routing, Settings |
| Verification records | whatsapp/AI/calendar verified-at and by-what — written by the verify actions, not by hand | Integrations |

**Finding:** the "admin-manageable operating model" was already largely in
place. The gaps below are the residue.

## Findings

### B — should be configurable (implemented this pass)

| # | Constant | Was | Now | Evidence |
|---|---|---|---|---|
| B-1 | `VALIDITY_DAYS = 15` — `src/modules/sales/quotation-standards.ts`, printed on every quotation PDF as "valid for 15 days" | code constant (the corpus modal) | `quotation_validity_days` (1–90) via Settings › Commercial › *How long a quotation stands*; `commercialTermsFor(days)`; both PDF render doors pass the org's value; unset = 15 | `20260929110000_two_more_settings_the_owner_can_set.sql`, `src/lib/admin/operational-defaults.ts`, `tests/two-more-settings-the-owner-can-set.test.ts` |
| B-2 | `WINDOW_START_HOUR = 10` / `WINDOW_END_HOUR = 19` — `src/modules/crm/follow-up-rhythms.ts` (ADM-69 sending window) | code constants | `outreach_window_start_hour` (0–22) / `outreach_window_end_hour` (1–23) via Settings › Communication › *When AgencyOS may send*; the worker reads the pair per organization and passes it to every due-time computation; an inverted or half-set pair reads as the default so nothing sends at 03:00; unset = 10–19 | same files; `follow-up-worker.ts` `agencyOutreachWindow` |

### B — should be configurable (recorded, not implemented; each needs a small schema or product step)

| # | Constant | Where | Why B | What it needs |
|---|---|---|---|---|
| B-3 | `DEFAULT_HORIZON_DAYS = 7` (how far ahead the scheduler offers meeting slots) | `src/lib/scheduling/booking.ts` | an agency may want 14 | one whitelisted key + a form on Communication; the booking reader takes it as an argument already |
| B-4 | `MIN_LEADS_TO_NAME_A_LEAK = 20` (funnel report refuses to name a leaking stage below this sample) | `src/lib/admin/sales-funnel.ts` | statistical threshold an owner may tune | one key; low priority — it only affects a report's wording |
| B-5 | `RHYTHM_OFFSETS` (the follow-up day schedule per rhythm: sales_active, nurture, customer_success, internal_approval) | `src/modules/crm/follow-up-rhythms.ts` | ADM-69 states the days; an owner may want a gentler cadence | a small `crm.follow_up_rhythms` table (rhythm, offsets[]) with versioning so a running sequence keeps the schedule it started on — a real design step, hence not done blind |
| B-6 | `COMMERCIAL_TERMS` clauses 2–5 (acceptance window "5 working days", cancellation, liability cap, jurisdiction) | `quotation-standards.ts` | legal wording an agency will localise | a versioned `sales.quotation_clauses` table; historical quotations must keep the clause they printed — same shape as B-5 |
| B-7 | `SUPPORT_STANDARD` (free bug-fix months, response targets printed on quotations) | `quotation-standards.ts` | maintenance policy | pairs with the Maintenance module (Phase 8) which has no admin screen yet |

### A — must remain code constants

| Constant | Where | Reason |
|---|---|---|
| `GST_RATE_BP = 1800` | `finance/gstin.ts` | statutory rate; changing it is a tax-law event, not an agency preference. The PDF's SCR-052 wording ("unless user changes policy") is satisfied by the per-project GST/non-GST **mode**, which is configurable (`confirm_billing_mode`). If the rate itself ever changes, it changes for every Indian agency at once — a code release with a dated migration is the correct, auditable vehicle. |
| `MAX_RETRIES`, `RETRY_BASE_SECONDS`, `RETRY_MAX_SECONDS`, `STALE_AFTER_SECONDS`, `MAX_ATTEMPTS = 10` | `lib/ai/budget.ts`, `lib/jobs/*`, `lib/events/dispatch.ts` | scheduler safety bounds; a UI knob here is how a retry storm gets configured by accident |
| `FUNCTION_CEILING_MS`, `REQUEST_TIMEOUT_MS`, `NON_MODEL_RESERVE_MS` | `lib/ai/budget.ts` | derived from the hosting platform's execution limit |
| `MAX_HANDOFF_DEPTH = 8` | `modules/agents/ceilings.ts` | loop guard between agents |
| `MAX_EXTRACTION_MESSAGES`, `MAX_EVIDENCE_CHARS/ROWS`, `DEFAULT_MAX_OUTPUT_TOKENS` | crm, ai | prompt-size bounds; changing them changes cost and failure modes, not business behaviour |
| `MAX_IMAGE_BYTES`, `MAX_AUDIO_BYTES` | `lib/whatsapp/media.ts` | Meta's own limits |
| `BATCH = 50`, `OBSERVE_LIMIT`, `ELIGIBLE_SCAN_CAP`, `CONTACT_SCAN_CAP`, `MAX_LIMIT = 200`, `RESULTS_PER_ENTITY = 5`, `MIN_QUERY_LENGTH = 2` | workers, search, audit | pagination/throughput bounds |
| `PLAN_SET_MIN_PLANS = 2`, `PLAN_SET_MAX_PLANS = 3` | `sales/schema.ts` | locked by the Quotation Master spec ("2–3 plans") |
| `COOLDOWN_HOURS = 1` (alert dedupe) | `lib/observability/alert.ts` | alerting hygiene; and per `backlog.ts`'s own rule, "nothing here invents a threshold" |
| Backlog severities (`15 minutes` stalled/queued-too-long) | `core.operational_backlog()` | declared failures, not tunable thresholds (traceability row 67) |
| `NUMBER_PAD = 4`, `MINOR_PER_MAJOR = 100`, `NUMBER_ATTEMPTS = 5` | finance | formatting/retry mechanics |
| PDF layout (`MARGIN`, `FOOTER_ROOM`, theme colours) | `lib/pdf/quotation.ts` | typesetting |
| `NOTICEABLE = 0.3`, pricing-reference base amounts (`BASE_ONE_SYSTEM` etc.) | `sales/pricing-reference.ts` | a **reference** the approver sees, not a price the system charges; the chargeable model is the configurable pricing model (C). Left as A deliberately: two live pricing inputs would be two places to disagree. |
| Realtime: `REFRESH_DEBOUNCE_MS`, `DEGRADED_AFTER_FAILURES`, poll intervals | `lib/realtime/*` | transport tuning |

### D — security-sensitive (environment / vault only)

`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `ANTHROPIC_API_KEY` and the
other provider keys, `VAULT_ENCRYPTION_KEY`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, Google service-account credentials,
`ALERT_WEBHOOK_URL`. Provider keys an admin enters go through the vault
(`ai.provider_credentials`, AES-256-GCM) and are shown only as
present/absent — Settings › General is explicit that secrets are never
rendered or sent to the browser. Every key with a vault slot can now also be
added under Governance & Security › Keys & secrets; screens that say such a key
is missing name that screen (and link to it) with the environment as the
alternative.

### E — needs a business decision first

| Item | Why it is E |
|---|---|
| Expense categories (PDF §7 "Finance → Expense categories") | `finance.expenses` has no category vocabulary; choosing one is an accounting decision (traceability row 55) |
| Standard project folder structure (PDF §7 "Project Defaults") | `project_files` is link-based with no folder model; adding folders is a data-model decision |
| Lead assignment / scoring rules | ADM-88 refuses a numeric lead score by decision; assignment rules have no shape in any business doc |
| Retention / export rules (PDF §7 "Governance") | no retention policy exists in any spec; inventing one is a compliance decision |
| Maintenance plan pricing, renewal windows, SLA targets (brief §20–21) | Phase 8 has no admin screen and `projects.maintenance_plans` is read-only today |

## Configuration transparency ("no black box")

For every key the door writes, the audit log carries `organization.setting_set`
with the old and new value and the actor (`core.record_audit`), so *current
value / last changed / changed by* is answerable from `/audit` filtered by
action. The Settings tabs show the current value beside each form and say in
prose what unset means. Not yet shown inline: effective date and a per-setting
history link — recorded as follow-up F-1 (a "history" affordance per form
reading `audit.audit_log` for that key).

## Follow-ups

- F-1 per-setting audit history link on each Settings form.
- B-3 … B-7 as above, in that order of value.
- ~~A configuration search~~ — implemented (stream H-3), see below.

### Configuration search (implemented, H-3)

Previously recorded as a follow-up: the ⌘K palette reached only the five
Settings tabs. It now finds individual settings and key slots by name.

| What | Where |
|---|---|
| The catalogue: every organization setting the Settings pages expose (`org-setting`), every settings section with no such key (`section`), and every slot of the key registry (`secret`, generated from `src/lib/secrets/registry.ts`), each with a label, keywords and a `page#anchor` href | `src/lib/admin/settings-catalogue.ts` |
| Stable `id` anchors on each matching section heading (`/settings#quotation-contact`, `/settings/finance#gst-identity`, `/settings/communication#outreach-window` …) and `/security/keys#<SLOT>` | `app/(internal)/settings/**/page.tsx`, `app/(internal)/security/keys/page.tsx` |
| Palette matching on label + section + keywords (`Command.keywords`); catalogue entries are `searchOnly` so an empty palette still lists pages | `src/lib/admin/command-palette-eval.ts` |
| Permission filtering: `catalogueFor(context)` runs `can()` on each entry's capability (`organization.settings`) in the layout, the same filter the nav uses | `app/(internal)/layout.tsx` |
| Guard: hrefs resolve to a real route and a single `id`; `org-setting` keys are on the database whitelist; no duplicate keys; "gst", "reminder", "window", "github", "whatsapp" find what they should | `tests/a-setting-is-found-by-its-name.test.ts` |

Not indexed (no form exposes them): `meeting_reminder_minutes`,
`won_requires_payment_evidence`, and the recorded-by-action verification keys.
