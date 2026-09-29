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

## 4. Live browser verification

**This pass: none.** The container has no Docker daemon (`supabase start`
cannot run) and no Supabase project credentials, so no internal page can be
rendered past the login redirect. Nothing below is claimed for this pass.

Prior session (real Supabase, real signed-in sessions, Owner unless noted):
Dashboard rendered with dark rail and KPI chips · 375 px viewport: stacked
KPIs, bottom tabs, drawer · Client 360 note added end-to-end · Project Board
card dragged (`setTaskStatusAction`) · Sales Pipeline stage moved · Calendar
grid vs agenda agree after an off-by-one fix · Usage chart rendered after a
server→client callback crash was fixed · `client_admin` confirmed redirected
to `/portal` on every internal URL tried.

## 5. Realtime multi-session E2E (brief tests 1–13)

**Not run — environment.** Requires a live Postgres with the
`supabase_realtime` publication and two browser sessions. Procedure, for the
next environment that has Docker:

```
npm run verify:db:up            # local Supabase, all 309 migrations
npm run dev
# Session A: /leads  ·  Session B: create a lead via ⌘K → New lead
# expect A's list and the dashboard KPI to update without refresh; pill says Live
# Session A: /approvals · B: raise + decide an approval → A updates after the decision commits, never before
# Session A: /invoices/verify · B: submit a payment claim → A shows it; verify in B → A shows PAID after the RPC returns
# Session A: /operations · fail a job → A shows it; requeue → A clears it
# Kill the realtime container → pill says Reconnecting, then Degraded; restart → Live and the list catches up
```

What IS verified without a database: the status machine's promises
(`realtime-connection.test.ts`) and that every subscribed table is published
(`realtime-topics.test.ts`).

## 6. Permissions

Static: `admin-nav-config.test.ts` proves the rail for `owner`, `finance`,
`contractor` and an unknown role; every page re-checks `can()` and RLS is the
final word (unchanged). Live role-matrix click-through: **not done** (no DB).

## 7. Accessibility

Code-level (see design system §Accessibility): landmarks, `aria-current`,
`aria-expanded`, `aria-sort`, `aria-live` status, skip link, reduced motion,
icon labels. **No screen-reader pass, no automated axe/contrast run** — the
pages cannot be rendered here.

## 8. Responsive

Code-level: every list uses `DataTable` (cards under `lg`), the rail hides
under `md`, the two new portfolio pages use the same primitives. **No
viewport screenshot pass this session.**

## 9. Visual QA against the 44 reference screenshots

Screen-by-screen side-by-side: **not done this session** (cannot render).
Token/shell-level correspondence (dark rail, indigo accent, KPI chips,
sectioned modules, breadcrumb, bell with count, status chips) is by
inspection of the code against `AGENCYOS_UI_SOURCE_AUDIT.md` §2's
reference-to-screen map.

## 10. Regression

The full suite's failure set is byte-identical before and after this pass
(diffed by test name), so no existing behaviour regressed at the unit level.
Business flows (Lead-to-Close, onboarding, prototype, QA, finance, handover)
were not driven live — same reason.

## 11. Open items, in priority order

1. Run §5 on an environment with Docker; record the two-session results here.
2. Run the 82 `db:verify:*` scripts against a local Postgres (CI does; this container cannot).
3. Screen-reader + axe pass on the five highest-traffic screens.
4. Screenshot pass at 1440 / 1024 / 768 / 375 for the 71 screens.
5. Confirm `roadmap.json`'s derived test counts against CI's Node 26 run.
