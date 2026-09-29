# AgencyOS Admin Panel — Test Matrix

What was actually run, with real results, and what was not. Two sessions
are recorded: the reskin (2026-09-22 … 28) and this pass (2026-09-29).
Every "✓" has a command and an output behind it.

## 1. Definition of done for a screen

A screen is COMPLETE in `AGENCYOS_ADMIN_MASTER_SCREEN_INVENTORY.md` only when:
route exists · correct capability guard · design source mapped · real
backend data (no mock) · loading / empty / error / permission-denied states ·
filters, search, pagination where needed · actions call backend commands ·
canonical state displayed · live update where applicable · responsive
(table → cards) · accessible landmarks and labels · no runtime error in the
production build · tests where meaningful.

## 2. Automated — this pass (2026-09-29)

| Check | Result | Notes |
|---|---|---|
| `tsc --noEmit` | ✓ clean | The snapshot branch **failed** typecheck on arrival (7 errors: `core.saved_views` and `core.client_notes` missing from `src/lib/db/types.ts`). Fixed by adding both table types from their migrations. |
| `eslint app src tests` | ✓ clean | Module boundaries (ARCHITECTURE.md §3.2) hold: `src/lib/realtime` imports nothing from `modules/`; the Action Center aggregator lives in `app/` for that reason. |
| `npm test` (node:test, **Node 22.22**) | 5,750 / 5,802 pass, **52 fail — identical set to the baseline run on the untouched snapshot** | The 52 are all `mock.module` semantics (`does not provide an export named 'createClient'`, `sendWhatsAppText is not a function`) under Node 22; CI runs **Node 26** (`.github/workflows`, `node-version: 26`), where the prior session recorded 6,240/6,240. This container has Node 20 and 22 only. |
| New tests | ✓ 40 / 40 | `admin-nav-config` (12: fifteen modules in the locked order, every href has a page, every capability real, no orphan top-level page, role visibility, longest-prefix current item, trail), `realtime-connection` (12: LIVE is earned, catch-up on rejoin, degrade after 3, poll rates, words not colour), `realtime-topics` (7: every topic table is published and created, heartbeat excluded, audit isolated, dedupe, stable channel name), `two-more-settings-the-owner-can-set` (9: defaults, ranges, half-set window falls back, clause text, worker passes the window, migration whitelist + validation from the latest body). |
| Existing tests touched | ✓ | `what-is-blocked-across-every-project` now reads `nav-config.ts`; `the-quotation-grows-its-document`'s render-door pin widened to accept the `validityDays` option while still pinning `document` + `renderItems`. |
| `next build` (placeholder public env) | ✓ exit 0 | All routes compile; internal routes are dynamic (cookies). |
| `node scripts/scan-secrets.mjs` | ✓ | — |
| `node scripts/check-record.mjs` | 4 pre-existing disagreements fixed (roadmap.json migrations/tables/test-file counts were stale on the snapshot); 2 remain **environmental**: the test summary is unreadable under Node 22's TAP reporter, and the clone is shallow (`fetch-depth: 0` is CI's job). | `tests`/`suites` in `roadmap.json` are derived (6,235 + 40 new, 1,351 + 12) and will be confirmed by CI's Node 26 run. |

## 3. Automated — prior session (2026-09-22 … 28), for the record

`tsc` ✓ · `eslint` ✓ · `npm test` 6,240/6,240 (Node 26) ·
`verify-tenancy-guards.mjs` 15/15 against a live local Postgres (found and
fixed two pre-existing tenancy gaps).

## 4. Live browser verification — this pass (2026-09-29, second round)

Done after all — without Docker. `scripts/local-qa/` (new) stands the real
application on a scratch Postgres 16 (`apply-migrations-locally.sh`, all
**309** migrations applied, seed applied, 129/129 tables with RLS), a real
PostgREST 13.0.4, and a fake GoTrue whose tokens are stamped by the repo's
own `core.custom_access_token_hook`. Chromium (Playwright) then drove the
real pages. Everything below is from `qa-report.json` and `e2e.mjs` output.

| Check | Result |
|---|---|
| Sign-in through `/auth/callback` → `verifyOtp` → `bootstrap_first_owner` | ✓ the first user became `owner` through the real RPC, exactly as on a fresh install |
| 61 owner routes at 1440×900 (every rail item, every project tab, Lead 360, Client 360, agent detail, all 5 Settings tabs) | **61/61 HTTP 200, 0 server errors, 0 console errors** (via `localhost`; via `127.0.0.1` Next's dev server adds 14 cross-origin 403s per page — a dev-server artifact) |
| 8 routes at 390×844 (phone) | 8/8 200, stacked KPI cards, card lists, bottom tabs, drawer |
| Role matrix: `finance`, `contractor`, `member`, `client_admin` | finance: `/invoices` ✓, `/invoices/verify` **denied**, `/leads` denied, `/settings` denied, `/audit` denied · contractor: `/projects` ✓, `/leads`/`/settings`/`/agents` denied · member: `/leads`/`/projects` ✓, `/finance`/`/settings` denied · client_admin: every internal URL → `/portal`. All as the capability matrix says. |
| B-1 quotation validity form | `0` → "Validity must be a whole number of days between 1 and 90." · `30` → saved sentence, value persisted after reload, `audit.audit_log` row `organization.setting_set` with old/new value |
| B-2 outreach window form | `18→9` → "A window from 18:00 to 9:00 has no hours in it…" · `9→18` → saved, both keys set, two audit rows |
| Header bell | `aria-label="Notifications — 1 item need attention"`, badge `1`, count fetched after paint (layout makes no DB read) |
| Sidebar | Finance module auto-expands on `/finance/payments`, exactly that item is `aria-current`, breadcrumb reads *Finance › Payments* |
| Skip link | first Tab stop is "Skip to content"; Enter focuses `#main` |
| Sticky table header | `/leads` with 18 rows: 7 sticky `<th>` inside a bounded scroll box; short tables unchanged |
| Live pill with no realtime server | *Connecting* → *Reconnecting* after the 10 s join timeout (observed at 32 s), polling safety net active; never claims Live |
| Kanban board | rendered 5 columns from real `projects.tasks`; **a React hydration mismatch was found** (dnd-kit's module-counter `aria-describedby` ids) **and fixed** (`useId` on `DndContext`); re-verified clean |
| Dashboard | **Recent-leads table clipped its columns at half width — found and fixed** (phone moved under the title, grid 1.35:1); KPI chips, health strip, needs-attention/today panels render from real reads |
| Settings | **forms were bare full-width inputs — fixed** (each section is a card, content column bounded, h2 scale) |

Not driven live: drag-and-drop on the board (pointer choreography), the
Google/WhatsApp/AI integrations (no credentials — the screens correctly say
"not configured"), PDF rendering.

## 5. Realtime multi-session E2E (brief tests 1–13)

**Push path: not run** — the local stack has no Realtime server. What was
verified live instead: the publication holds exactly the 39 tables the
topics name (`pg_publication_tables`, re-applying the migration is a no-op),
and the client's honest fallback (*Reconnecting*, then polling) in a real
browser. The status machine and topic↔publication correspondence are unit
tested. On an environment with Docker, `npm run verify:db:up` gives a
Realtime server and the procedure is:

```
# Session A: /leads  ·  Session B: ⌘K → New lead → A's list and the dashboard KPI update; pill says Live
# Session A: /approvals · B: raise + decide → A updates after the decision commits, never before
# Session A: /invoices/verify · B: submit a claim → A shows it; verify in B → A shows PAID after the RPC returns
# Session A: /operations · fail a job → A shows it; requeue → A clears it
# Stop the realtime container → Reconnecting, then Degraded; start it → Live and the list catches up
```

## 6. Permissions

Static (`admin-nav-config.test.ts`) **and live** (§4 role matrix): four
roles signed in through the real hook, every probe landed where the
capability matrix says. RLS is the final word and was on throughout.

## 7. Accessibility

Live: skip link, landmarks, `aria-current`, `aria-expanded`, the bell's
label, the live pill's `role="status"` — all confirmed in the DOM. Not yet:
a screen-reader pass and an axe/contrast run (the harness can host one).

## 8. Responsive

Live at 390×844 on 8 screens: no horizontal overflow, tables as cards,
bottom tabs reachable. Tablet widths (768/1024) not captured.

## 9. Visual QA against the 44 reference screenshots

Live at 1440 on 61 screens against the reference-to-screen map in the
source audit §4: shell (dark sectioned rail, wordmark + tagline, search + ⌘K,
bell with count, breadcrumb), KPI tiles with pastel chips, chip statuses,
Kanban, entity headers with stage stepper (Lead 360), cards with right-rail
panels — correspond. Two drifts found and fixed this round (dashboard table,
settings forms). Charts render only where data exists (usage trend was
empty on the seed).

## 10. Regression

Unit: the failure set is byte-identical before and after (Node 22, 52
`mock.module` failures in both). Live: the business flows that the seed can
reach — sign-in and bootstrap, lead list/360, project 360 and every tab,
client 360 with a note form, settings writes with audit — all exercised;
lead-to-close, onboarding, prototype, QA runs, finance and handover
transitions need their own seeded fixtures and were not driven.

## 11. Open items, in priority order

1. Run §5 (push realtime, two sessions) on an environment with Docker.
2. Point `.env.verify.local` at the local gateway and run the 82 `db:verify:*` scripts (CI does this; not tried here).
3. axe + screen-reader pass through the harness on the five highest-traffic screens.
4. Tablet captures (768 / 1024) and a drag-and-drop run on the board.
5. Confirm `roadmap.json`'s derived test counts against CI's Node 26 run.
