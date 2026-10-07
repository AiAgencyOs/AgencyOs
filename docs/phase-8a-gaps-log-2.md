# Phase 8A, second half of the traceability gaps: log

Scope: the rows of `docs/phase-8a-implementation-traceability.md` from "E2E-13 cross-tenant" to the end (E2E, Customer Success / Support / Upsell spec rows, ops, metrics, charts, cadence, provider callback). The first-half rows belong to another builder (migrations `20261120*`) and were not edited, except that one first-half row (P8-SEC-004) is *also* satisfied by this migration and is recorded in section 20 only.

## What was built

Migration `supabase/migrations/20261121000000_phase_eight_a_second_half_gaps_are_closed_as_records_and_reads.sql` (additive; one CHECK on `support_ticket_events.kind` widened by two kinds):

| Item | What it is |
|---|---|
| `support_ticket_events.correlation_id` | default `projects.p8_correlation_id()`: `projects.correlation_id` if the caller set it, else the transaction id. Old rows stay NULL, not backfilled with a guess |
| `projects.probe_tenant_access` | a lookup naming another tenant's record answers `not_available`, identical to a missing one, and writes `access.cross_tenant_denied` in the CALLER's organization |
| `p8f_contact_preferences` + `set_client_contact_preference` | preferred channel, channels to avoid, language, recorded by a person |
| `communication_category_cadence` + set/clear doors (Admin) | minimum gap per category (operational, relationship, commercial); no default number |
| `projects.can_contact_governed` | `can_contact_now` plus the avoided channels and the category cadence |
| `p8f_client_feedback` (append-only), `client_goals` + record/close doors | what a person heard, what the client stated |
| `projects.request_support_followup` | a person asks for a Developer task or a QA verification: ticket event plus an outbox event; no task is created |
| `projects.customer_success_next_actions` | the queue, DERIVED on read (INVOKER, internal only); nothing is stored |
| `client_communication_provider_events` + `record_provider_delivery_callback` (service role only) | delivery facts from a provider callback, matched to a ledger entry a person recorded; `client_communication_history` reads them |
| `projects.reconcile_phase_eight_metrics` | ten figures counted two ways; every disagreement returned |

New tables carry `enforce_parent_org` (per foreign key) and `freeze_organization_id` triggers, internal-only RLS read, no direct write for `authenticated`.

App layer (new files only):

- `src/modules/projects/phase-eight-gaps2-queries.ts` (every read refuses on failure with `unreadable`)
- `src/modules/projects/phase-eight-gaps2-actions.ts` (one `'use server'` action over a whitelist of seven doors)
- `src/modules/projects/provider-delivery-callback.ts` and `app/api/webhooks/delivery-callback/route.ts`
- pages: `/projects/customer-success/next-actions`, `/projects/customer-success/reconciliation` (with a donut and a bar chart), `/projects/customer-success/records` (+ `gaps2-forms.tsx`)

## Evidence

- `scripts/verify-phase-eight-a-gaps2.sql`: 177 checks, run with `psql -v ON_ERROR_STOP=1` on a scratch Postgres 16.14 (port 55442) after all 553 migrations applied; rolls back.
- `scripts/redproof/phase-eight-a-gaps2.py`: 106/106 controls red-proved (each removed from the live definition, constraint, trigger, policy or grant inside the verifier's own transaction; a pattern that does not match raises NOOP).
- `tests/phase-eight-a-gaps2.test.ts`: 15 tests (action whitelist and refusals, handler signature/configuration/parsing/failure, structure). Red-proved by removing the signature check from the handler: the suite went red (14/15), restored byte-for-byte.
- Whole-suite: `npm test` 10497 pass / 0 fail (before the final lint-only edit to the test file), `npm run typecheck` clean, `npm run lint` clean, `npm run scan:secrets` passed.

## What stays open, and why

| Item | Why |
|---|---|
| A real provider's callback adapter | needs the provider's account, payload shape and signing secret. The handler accepts AgencyOS's own signed body and is disabled (503) until `COMMUNICATION_CALLBACK_SECRET` and `COMMUNICATION_CALLBACK_ORGANIZATION_ID` are set. Nothing fabricates a delivery |
| Retry/DLQ of the runner (E2E-15) | owned by the existing jobs runner; only the handler's 502 (so a provider retries) is added |
| VIP, approved knowledge base, scope-item comparison, major-release trigger | no data source or owner decision (ADM-22) |
| Developer task creation from the follow-up event | a consumer belongs to the Developer agent; the event is the request |
| Retention/deletion policy (P8-SEC-006) | an owner decision; no delete surface exists |
| Agent workflows proven with a stub model for the new surfaces | not added: every new surface is a person-recorded record or a derived read, so no model-backed workflow is needed or claimed |
| Browser rendering of the three pages and the charts | typechecked, linted and structure-tested only |
| Alerting and metrics export | not built |

## Wiring for the lead (shared files this part did not edit)

1. `package.json`, `db:verify:phase4`: append `-f scripts/verify-phase-eight-a-gaps2.sql` after `-f scripts/verify-phase-eight-a.sql`.
2. `docs/roadmap/roadmap.json` counts after this part alone: migrations 552 -> 553, test files 510 -> 511, tables 439 -> 444, tests +15, suites +4. `npm run check:record` reports exactly these six derived disagreements; recompute after the other builder's merge.
3. `app/(internal)/projects/customer-success/page.tsx`: add links to `/projects/customer-success/next-actions`, `/projects/customer-success/reconciliation`, `/projects/customer-success/records`.
4. Environment (optional, owner): `COMMUNICATION_CALLBACK_SECRET`, `COMMUNICATION_CALLBACK_ORGANIZATION_ID` (see `docs/phase-8a-manual-actions.md` M-12).
5. No new event type was added to `src/lib/events/catalog.ts` by this part; `support.developer_task_requested` and `support.qa_verification_requested` are emitted by `request_support_followup`: if the catalog pins event names, add both.
6. Migration `20261121000000` must be applied before the pages work; `db:push` from this branch is safe (additive).
