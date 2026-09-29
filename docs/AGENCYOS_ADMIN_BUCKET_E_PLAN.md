# AgencyOS Admin Panel — Bucket E implementation plan

Written 2026-09-30 after bucket D closed every screen in the 71-screen
PDF. Bucket E is the remaining work: four owner decisions taken on
2026-09-30 and the four open verification items from
`AGENCYOS_ADMIN_TEST_MATRIX.md` §11.

Owner decisions on record (2026-09-30):

| # | Question | Decision |
|---|---|---|
| E1 | WhatsApp broadcast (SCR-059 sub-feature) | **Reopen as a governed campaign** |
| E2 | Cost time on the project margin | **Keep uncosted** — no work |
| E3 | Profile / Preferences (A32) and Help (A34) | **Build both** |
| E4 | Two-session realtime test | **Runnable script + CI job** |
| E5 | GST return | **Add GSTR-1 / GSTR-3B exports** (no filing API) |

Conventions are unchanged from `AGENT_BRIEF*.md`: schema → service
(`requireInternal` + `can(role, cap)` + RLS/RPC, audited) → `'use server'`
action → client form; idempotent migrations with tenancy triggers and
role-named policies; new files per topic; app imports only
`queries|actions|schema`; honest failure states, never a fake success;
no mocks; every door driven in a browser with read-back before it is
called done.

---

## E1. WhatsApp campaign (governed broadcast)

**Rule that makes it governable.** A campaign is not a send. It is a
plan that expands into one per-thread outbound message per recipient,
and each of those goes through the existing chokepoint
(`crm.send_outbound_message` → provider → `crm.mark_outbound_delivery`),
so consent, the 24-hour window, the approved-template rule and the
outreach allowance decide each recipient separately. A recipient the
rules refuse is recorded as refused with the reason; the campaign never
bypasses them.

**Migration `20260930140000_a_campaign_is_a_list_of_governed_sends.sql`**

- `crm.campaigns` (organization_id, name, template_id → `crm.whatsapp_templates`,
  audience jsonb — the filter as typed, status `draft|approved|running|done|cancelled`,
  created_by, approved_by, approved_at, started_at, finished_at, counts
  `recipients|sent|refused|failed`). RLS enable+force; select internal;
  insert/update `lead.write`; approve owner or ops_admin only (a separate
  RPC, not a column policy); tenancy + freeze triggers.
- `crm.campaign_recipients` (campaign_id, lead_id or client_account_id,
  conversation_id nullable, status `pending|sent|refused|failed`, reason,
  message_id → outbound message, decided_at). Unique (campaign_id, lead_id).
- RPCs: `crm.create_campaign`, `crm.approve_campaign` (four-eyes: the
  approver must not be the creator; audits `campaign.approved`),
  `crm.claim_campaign_recipient` (service_role; locks one pending row,
  returns it, so the worker is idempotent), `crm.record_campaign_recipient`
  (service_role; writes outcome + reason; audits `campaign.recipient.sent|refused`),
  `crm.cancel_campaign` (creator or owner; reason required).
- Audit actions: `campaign.created|approved|started|cancelled|done`.

**Code**

- `src/modules/crm/campaign-schema.ts` — zod for the audience filter
  (stage, source, tag, last-activity window, service, owner) reusing the
  Leads list filter shape so what the owner previews is what expands.
- `src/modules/crm/campaign-service.ts` — `createCampaign` (expands the
  audience *at approval*, not at creation, so the preview count and the
  recipient rows agree), `approveCampaign`, `cancelCampaign`.
- `src/modules/crm/campaign-worker.ts` — `runCampaigns(admin)` called
  from the cron tick after `runInvoiceReminders`: claims recipients in
  batches of 25 per tick, bounded by the outreach allowance, sends
  through `sendTemplateMessage`'s internals (extract a shared
  `sendTemplateToConversation` in `template-send-service.ts` rather than
  duplicating), records each outcome. Stops the campaign at `done` when
  no pending rows remain.
- `src/modules/crm/campaign-queries.ts` — list, detail with per-recipient
  outcomes, preview count.
- UI: `/communication/campaigns` (list + New campaign: template picker over
  approved+active templates, audience filter with a live "N recipients"
  preview, Save draft), `/communication/campaigns/[id]` (approve, cancel,
  per-recipient table with reason, progress). Sidebar entry under
  Communication. Templates page gets a `campaign` situation key.
- Tests: `tests/a-campaign-is-many-governed-sends.test.ts` — the worker
  never imports `sendWhatsAppTemplate` directly (chokepoint guard), the
  four-eyes rule in the migration text, audience expansion is pure and
  deterministic, refusal reasons are one of a closed set.

**Verification.** Create → approve as a second owner-role session →
run the tick → read `campaign_recipients` (every row sent or refused with
a reason; on the local stack all refused with "not configured") → audit
rows. Screenshot both routes.

Effort: 1 stream, ~1 migration, ~14 files.

## E3. Profile / Preferences and Help

**Migration `20260930150000_a_person_has_preferences_and_the_panel_explains_itself.sql`**

- `core.user_preferences` (user_id PK → `core.users`, timezone text
  IANA-checked, locale, date_format, notification_email boolean,
  notification_whatsapp boolean, digest `off|daily|weekly`, updated_at).
  RLS: a person reads and writes only their own row; no org column
  because preferences follow the person across tenants. Audited through
  `core.record_audit` as `preferences.updated` in the acting org.
- `core.users` gains nothing: `full_name` and `avatar_url` already exist
  and are what `src/lib/auth/session.ts` reads. A door
  `core.update_own_profile(full_name, avatar_url)` writes them, audited
  `profile.updated`. Avatar upload reuses `src/lib/files/storage.ts`
  (bucket `avatars`, honest when storage is unreachable).

**Code**

- `src/modules/identity/profile-{schema,service,actions,queries}.ts` (new
  module; nothing else imports it).
- `/profile` page: identity card (name, email read-only, avatar), a
  preferences form, "Your sessions" read-only list from auth if the
  gateway exposes it (else omitted, said so), and links to the person's
  own audit trail (`/audit?actor=me`).
- Timezone preference becomes the display timezone everywhere
  `formatDate` is used: add an optional `tz` argument resolved once per
  request in the internal layout, default the organization's timezone.
- `/help`: generated at build time from
  `docs/AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md` by a small script
  (`scripts/build-help.mjs` → `src/lib/help/screens.json`, checked in);
  one entry per SCR row with route, capability, what it reads and a
  "what you can do here" line taken from the inventory; a search box;
  each internal page header gets a "?" link to its entry. A guard test
  fails when the JSON is older than the inventory.
- Sidebar: Profile under the user menu; Help beside the bell (the
  existing `?` icon in the shell becomes the link).

Tests: `tests/a-person-owns-their-preferences.test.ts` (own-row RLS in
the migration text, no org column, timezone validation, help JSON in
sync). Verification: change timezone → a date on the dashboard changes;
toggle a notification preference → row read back; `/help` renders 71
entries.

Effort: 1 stream, 1 migration, ~12 files.

## E4. Two-session realtime test as a script and a CI job

- `tests/e2e/realtime-two-sessions.spec.mjs` (Playwright, `playwright-core`
  already vendored for the QA scripts): signs in two browser contexts as
  owner and ops_admin through the magic-link callback, then runs the five
  scenarios in §5 verbatim: new lead from B appears in A's list and KPI
  with the pill saying Live; approval decided in B appears in A only after
  the RPC returns; payment claim verified in B shows PAID in A; job failed
  and requeued in B shows and clears in A; realtime container stopped →
  A shows Reconnecting then Degraded, started → Live and the list catches
  up. Each assertion also reads the database through PostgREST so a
  passing screen is tied to a committed row.
- `.github/workflows/realtime.yml`: `supabase start && supabase db reset`
  (same pinned CLI as `verify.yml`), seed, `next build && next start`,
  run the spec, upload screenshots and the trace as artifacts. The
  container stop/start step uses `docker stop supabase_realtime_<project>`,
  the name `supabase status` reports.
- `npm run e2e:realtime` runs the same locally on a machine with Docker.
- The test matrix §5 is rewritten from "not run" to the CI run's link and
  result once green. Only then is the completion phrase due.

Effort: 1 stream, no migration, ~4 files. I can watch the first CI run
from here and fix what it finds.

## E5. GSTR-1 and GSTR-3B exports

**Scope.** Period exports from the confirmed GST register (billing mode
`gst` only, the same split `taxRegisterCsv` uses) in the shapes the GST
portal's offline tool accepts. No filing, no portal API, no e-invoice
IRN. Downloads live on Finance › GST & tax beside the CSV.

**Data the shapes need that the schema lacks today**

| Field | Today | Plan |
|---|---|---|
| Supplier GSTIN and state (the agency's own) | not stored | `core.organizations` + `gstin` (same CHECK as billing profiles) and `gst_state_code` (2 digits); Settings › Finance form, owner-only, audited |
| Place of supply per invoice | `billing_profiles.billing_state` (free text) | add `billing_state_code` (2 digits) beside it, backfilled where the text matches a state name, else left null and the export lists the invoice under "needs a state code" rather than guessing |
| Intra vs inter-state tax split (CGST+SGST vs IGST) | one `tax_rate_bp` per line | derived: same state code → CGST+SGST halves, else IGST. Pure, tested |
| HSN/SAC per line | not stored | one org-level default SAC (998314, IT services) on Settings › Finance, overridable per invoice line later; exported as `hsn_sc` |
| B2B vs B2C split | recipient GSTIN present or not | derived |

**Migration `20260930160000_the_agency_states_its_own_gst_identity.sql`**
adds the four columns above, the Settings door
`core.set_gst_identity`, and nothing else.

**Code**

- `src/modules/finance/gstr.ts` (pure): `gstr1(rows, identity, period)` →
  `{ b2b, b2cs, hsn, docs }` and `gstr3b(rows, receipts, period)` →
  `{ '3.1': outward supplies (a) taxable, ..., '4': ITC nil, '5': exempt nil }`.
  Both return an `unresolved` list (invoices missing a state code or a
  GSTIN checksum failure) that the screen shows and the file omits, so
  nothing is invented. JSON shapes follow the GSTN offline-tool
  specification; the version string is a constant with the spec date and
  a test pins the top-level keys.
- Routes `app/api/finance/gst/gstr1/route.ts` and `gstr3b/route.ts`
  (`invoice.read`, period param as the tax page already parses, JSON
  download; audit `gst.exported` with period and counts).
- Tax page: "GSTR-1 (JSON)" and "GSTR-3B (JSON)" buttons, an "Unresolved"
  callout listing what is missing and where to fix it.
- Tests: `tests/finance-gstr.test.ts` — intra/inter split arithmetic in
  paise, B2B/B2C partition, unresolved never exported, 3B totals equal the
  register totals for the period, top-level keys pinned.

Effort: 1 stream, 1 migration, ~9 files. **One caveat to state now:**
the offline-tool JSON schema is versioned by GSTN; I will match the
current published shape and pin it, but a change on their side needs a
constant update, which the test will flag by design.

## E6. Verification items carried from §11

| Item | Plan |
|---|---|
| Eight fixture-dependent verifiers (71/80 on the QA-mutated DB) | Run as part of E4's workflow against the fresh `db reset` database; record 80/80 or the exact failing names in §11 |
| Screen-reader pass | Out of reach from a container. Left as the one manual item; axe 10/10 stands |
| `roadmap.json` counts vs CI Node 26 | `check:record` already runs in `verify.yml`; add its six known disagreements to the roadmap in the E4 commit so CI is the source |

---

## Order and streams

Four worktree streams in parallel, one migration timestamp each, merged
in this order so the shared files touch once:

1. **E4** (no migration) — starts first because its CI run is the long pole.
2. **E5** `20260930160000` — finance only.
3. **E3** `20260930150000` — identity + shell (`?` link, user menu).
4. **E1** `20260930140000` — CRM + cron tick + sidebar.

Then, as with bucket D: apply migrations locally, restart PostgREST,
typecheck, lint, guards, `npm test` (baseline 52), browser drive with
read-back, docs (test matrix §9h, gaps doc, inventory rows for 059,
056, A32, A34, implementation matrix), one commit, push to
`chore/pre-session-working-tree-snapshot`.

## What I do not need from you

Nothing blocks the start. Two things would improve the outcome but are
not required: a real `GITHUB_TOKEN` and WhatsApp provider keys in the CI
environment's secrets would let E4's run exercise the live paths instead
of the honest not-configured states. The completion phrase is emitted
only when E4's CI run is green and every other item above is verified.
