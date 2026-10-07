# Phase 8D implementation log: the open gaps of Phase 8A

Branch base: `fix/p0-ai-cost-fixes` (d84f282b). Scope and statuses: `phase-8a-implementation-traceability.md` (section 19 records what closed). What needs a person: `phase-8a-manual-actions.md` (M-2, M-9 to M-11).

## What was built

Deterministic records, doors and reads, two internal pages, a versioned report template. **Nothing sends to a client, quotes, prices, discounts or approves on anyone's behalf**, and nothing records an event it did not see.

### Migrations (`supabase/migrations/`, range 20261110000000 to 20261110999999, all additive)

| File | Contents |
|---|---|
| `20261110000000_support_customer_success_and_sales_hand_work_to_each_other.sql` | the five roster edges: support to customer_success and sales, customer_success to support and finance, sales to customer_success; mirror of the literal `handoffTargets` arrays in `src/modules/agents/registry.ts` (`insert ... on conflict do nothing`) |
| `20261110100000_client_communication_is_governed_as_data_and_nothing_here_sends.sql` | `client_communication_caps`, `client_quiet_periods` (Admin-set; no default number), `client_communication_ledger` and `client_communication_events` (append-only); `can_contact_now`, `client_communication_history`; doors `set/clear_client_communication_cap`, `add/cancel_client_quiet_period` (Admin), `record_client_communication`, `record_client_communication_event` (a person), `record_agent_communication_draft` (service role) |
| `20261110200000_a_value_report_is_a_draft_of_cited_facts_a_person_approves.sql` | `value_report_drafts` (facts frozen, cited, with a digest), `value_report_facts` read, doors `store_value_report_draft`, `store_value_report_draft_as_agent`, `edit/approve/discard_value_report_draft` |
| `20261110300000_phase_eight_is_observable_as_counts_and_ages.sql` | `phase_eight_observability(now)`: counts and the oldest timestamp per bucket, read-only |

Every new table: row security on, internal-only organization-scoped read policy, no write grant to `authenticated`, `core.enforce_parent_org` per tenant-scoped foreign key (`client_account_id` included), `core.freeze_organization_id`, append-only triggers on the two history tables, the 8A `p8_guard_updates` on the mutable ones. The migration's own wiring helpers are dropped at the end (as 8A's were), so the wiring is not reusable by accident.

### TypeScript

- `src/modules/projects/value-report.ts`: pure; the sentence template is versioned (`VALUE_REPORT_TEMPLATES`, version 1, fingerprint pinned by `tests/value-report.test.ts`); a title that mentions a price is withheld from the sentence; the same price pattern as the database.
- `src/modules/projects/customer-360-queries.ts`: every read guarded (`unreadable`); finance only when the viewer may read it (the section is `null` otherwise, not empty).
- `src/modules/projects/phase-eight-d-actions.ts`: one server action over a whitelist of nine doors plus the report build; only async exports.
- `src/modules/projects/phase-eight-observability-queries.ts`.
- `app/(internal)/clients/[clientId]/customer-360/page.tsx` and `customer-360-forms.tsx` (new files; the existing client page is untouched), `app/(internal)/projects/customer-success/observability/page.tsx`, and one link from the 8A overview page to it.

## Decisions that narrow or differ from the specs

- **No cap number, window or quiet interval has a default.** A client has none until an Admin sets one (ADM-22 refuses invented numbers). Caps count only what a PERSON recorded as sent; an agent's draft is never a contact.
- **Consent is the table that exists.** `crm.communication_consent` records WhatsApp only. `email` and `portal` have no consent record, so eligibility refuses them (ADM-81: no exception). `call` and `meeting` are a person's act: consent does not apply, quiet periods and caps still do.
- **The ledger never refuses a true statement.** A person who really sent something is recorded even when the read said no; the answer at that moment is stored beside the entry (`eligible_at_record`, `eligibility_reasons`) so a breach is visible.
- **Delivery is recorded by a person or joined from the existing outbound-message log (`crm.conversation_messages.metadata.delivery`); absent both it reads `unknown`, never `delivered`.** No provider callback writes these tables.
- **There is no uptime fact in a value report.** AgencyOS measures none. The nearest evidence is a person's dated production release check, which the report says is not a measure of availability.
- **A value report body is rendered from the facts in TypeScript and the database refuses a body built from facts that have since changed** (digest mismatch). Facts, period, client and template version are frozen on the draft; approved and discarded drafts are final. Approving marks wording a person stands behind: it sends nothing.
- **A report that names a price or discount is refused at the door and by a CHECK.** A title that does is withheld from the sentence and stays in the cited facts.
- **Observability is a database function, not a TypeScript aggregate**, so the counts come from the same derived reads (health, support SLA) the rest of Phase 8 uses.
- **History references users with RESTRICT**, not SET NULL: an append-only row cannot be updated by a cascade.

## Verification

Scratch Postgres 16 (`KEEP=1` copy of `scripts/apply-migrations-locally.sh` on its own port): every migration applies.

- `scripts/verify-phase-eight-d.sql`: 186 checks, through the real doors, role switching to `authenticated` with a member, an ops admin, a portal client (`client_member` with `app_metadata.client_account_id`) and another organization's staff; rolls back; ends `verified OK`. Fixtures disable triggers only with `alter table ... disable trigger user` (CI runs on a non-superuser). Every count is scoped to this verifier's own rows.
- `scripts/redproof/phase-eight-d.py`: 124 of 124 controls red-proved. Each removes one control from the LIVE definition (a function body through `pg_get_functiondef`, or a constraint, index, trigger, policy, grant or seeded row) inside the verifier's own transaction; a no-op mutation raises. Rules held by two layers (door and CHECK) have a case and a verifier check for each layer.
- The legacy verifiers (`verify-phase-eight-a.sql`, `verify-phase-eight-b.sql`, `verify-phase-nine.sql`, `verify-phase-seven.sql`, `verify-phase-four-e2e.sql`) were re-run against the same database with the new migrations applied and still pass.
- `tests/phase-eight-d-foundation.test.ts`, `tests/phase-eight-d-actions.test.ts`, `tests/customer-360-queries.test.ts`, `tests/phase-eight-observability.test.ts`, `tests/value-report.test.ts`.

Not run: a browser. The two pages are typechecked and linted, not rendered. No load or performance run. No provider, no real model.

## Wiring for the parent

1. `src/modules/agents/registry.ts`: three literal `handoffTargets` arrays gained entries (sales, support, customer_success); the roster migration mirrors them. `npm run check:record` section 16 counts both.
2. Add a link to `/clients/<id>/customer-360` from the existing client detail page (not edited here: it was out of bounds). The page is reachable by URL only until then.
3. `app/(internal)/nav-config.ts` has no `/projects/customer-success` item; both new pages are nested under existing routes, so the navigation test holds. Add the nav item if wanted.
4. `npm run db:push` after review: the migrations are additive.

## Not built

Automatic delivery state from the provider, cadence per message category, channel and language preferences, feedback capture, VIP, a next-action queue, charts, alerting, a retention policy, an uptime measurement, a value report sent to a client (a person sends it, outside AgencyOS), and everything the other Phase 8 part owns.
